/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Persistent credential storage.
 *
 * Wraps `@bedrock/web-vc-store`'s `VerifiableCredentialStore` over a
 * `PouchEdvClient`, so credentials are encrypted at rest in SQLite using the
 * path already verified on device (PBKDF2 → KEK → AES-KW → AES-GCM → SQLite).
 *
 * ## Why this reuses `web-vc-store` but not `CredentialStore`
 *
 * `@bedrock/web-wallet`'s `CredentialStore` needs `{profileId, local, remote}`
 * and is constructed in `state.js`, which pulls in the whole profile stack —
 * KMS, zcaps, meters, remote EDVs. Same wall the exchange handlers hit.
 *
 * `VerifiableCredentialStore` sits one layer lower and needs **only an
 * `edvClient`**. It declares its own indexes (`content.id`, `meta.issuer`,
 * `meta.displayable`, `content.type`, …), which is exactly the query surface a
 * wallet list needs. Its dependencies are light — `lru-memoize`,
 * `canonicalize`, `p-all` — with no profile machinery and no `jsonld`.
 *
 * So the reuse here is genuine, just at a lower layer than the plan assumed.
 * Swapping in `CredentialStore` later means adding profiles, not rewriting
 * this.
 *
 * ## Unlocking
 *
 * An EDV is created with a password and reopened with the same one via
 * `fromLocalSecrets`. The password is **required** — there is deliberately no
 * default, because a hardcoded one would ship the decryption key in the app
 * bundle and make the encryption decorative.
 *
 * `src/wallet/unlock.js` supplies it from a recovery phrase held in the
 * platform keystore, with no user prompt. See that module for the reasoning.
 */

/* A stable EDV id so the same store is reopened across launches. Deriving it
from a constant rather than generating one means no bootstrapping record is
needed to find the store again. */
export const PROTOTYPE_EDV_ID = 'urn:uuid:9f1b0c7e-5a3d-4c21-8e9f-0a1b2c3d4e5f';

/**
 * Opens the credential store, creating the EDV on first run.
 *
 * `createEdv` is idempotent for the secret (`_lazyCreateSecret` reuses an
 * existing one), but calling it when the EDV config already exists fails. So
 * the open path is tried first and creation is the fallback — the reverse would
 * make every launch after the first an error case.
 *
 * @param {object} options - The options.
 * @param {object} options.pouchEdv - The `@bedrock/web-pouch-edv` module.
 * @param {object} options.VerifiableCredentialStore - The store class.
 * @param {string} options.password - The unlock password, from
 *   `getOrCreateUnlockSecret`. Required: there is no default on purpose.
 * @param {string} [options.edvId] - The EDV id to open.
 *
 * @returns {Promise<object>} `{store, edvClient, created}`.
 */
export async function openCredentialStore({
  pouchEdv, VerifiableCredentialStore, password, edvId = PROTOTYPE_EDV_ID
} = {}) {
  if(typeof password !== 'string' || password === '') {
    throw new TypeError(
      '"password" is required. Get one from `getOrCreateUnlockSecret()`; a ' +
      'default would put the decryption key in the app bundle.');
  }
  const {PouchEdvClient} = pouchEdv;
  await pouchEdv.initialize();

  let edvClient;
  let created = false;

  try {
    edvClient = await PouchEdvClient.fromLocalSecrets({edvId, password});
  } catch(e) {
    /* Not found is the expected first-run path; anything else is a real
    failure (a wrong password, corrupt storage) and must not be swallowed into
    "create a fresh store", which would silently orphan existing credentials. */
    if(e.name !== 'NotFoundError') {
      throw e;
    }
  }

  if(!edvClient) {
    ({edvClient} = await PouchEdvClient.createEdv({
      config: {
        id: edvId,
        sequence: 0,
        controller: 'urn:rn-wallet:prototype-holder'
      },
      password
    }));
    created = true;
  }

  if(!edvClient) {
    throw new Error('Could not open or create the credential store.');
  }

  return {
    store: new VerifiableCredentialStore({edvClient}),
    edvClient,
    created
  };
}

/**
 * Saves credentials, skipping ones already present.
 *
 * `upsert` is used rather than `insert` so re-accepting the same offer updates
 * instead of throwing a uniqueness error — `content.id` is a unique index.
 *
 * **`meta.displayable` must be set by the caller.** `VerifiableCredentialStore`
 * indexes it and `find({query: {displayable: true}})` filters on it, but
 * `upsert` never sets it — it only fills `created`, `updated`, `id`, and
 * `issuer`. Omitting it stores the credential successfully and then makes it
 * invisible to the wallet list, which looks exactly like a silent save failure.
 * That cost real debugging time here. `bedrock-web-wallet` does the same thing
 * via `lib/config.js` (`meta: {displayable: true}` for the local store).
 *
 * Each credential is saved independently: one bad credential must not discard
 * the others in the same batch, so failures are collected and returned.
 *
 * @param {object} options - The options.
 * @param {object} options.store - A `VerifiableCredentialStore`.
 * @param {object[]} options.credentials - Credentials to save.
 * @param {boolean} [options.displayable] - Whether the credential should show
 *   in the wallet list.
 *
 * @returns {Promise<object>} `{saved, failures}`.
 */
export async function saveCredentials({
  store, credentials, displayable = true
} = {}) {
  const saved = [];
  const failures = [];

  for(const credential of credentials ?? []) {
    try {
      await store.upsert({credential, meta: {displayable}});
      saved.push(credential);
    } catch(e) {
      failures.push({
        id: credential?.id,
        type: credential?.type?.find(t => t !== 'VerifiableCredential'),
        reason: e.message
      });
    }
  }
  return {saved, failures};
}

/**
 * Loads all displayable credentials.
 *
 * `VerifiableCredentialStore` indexes `meta.displayable` for exactly this, so
 * this is an indexed query rather than a full scan. Returns credentials in the
 * shape the UI already renders, not EDV documents.
 *
 * @param {object} options - The options.
 * @param {object} options.store - A `VerifiableCredentialStore`.
 *
 * @returns {Promise<object[]>} The stored credentials.
 */
export async function loadCredentials({store} = {}) {
  const {documents = []} = await store.find({query: {displayable: true}});
  return documents
    .map(doc => doc?.content)
    .filter(content => content && content.credentialSubject);
}

/**
 * Deletes a credential by its credential id.
 *
 * @param {object} options - The options.
 * @param {object} options.store - A `VerifiableCredentialStore`.
 * @param {string} options.id - The credential's `id`.
 *
 * @returns {Promise<boolean>} `true` if something was deleted.
 */
export async function deleteCredential({store, id} = {}) {
  try {
    return await store.delete({id}) !== false;
  } catch(e) {
    if(e.name === 'NotFoundError') {
      return false;
    }
    throw e;
  }
}
