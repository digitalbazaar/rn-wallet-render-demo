/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tests for persistent credential storage.
 *
 * **Scope limit, stated up front:** the real EDV write path cannot run under
 * Node. `pouchdb-adapter-memory` fails EDV inserts with "database is closed"
 * from PouchDB's own LevelDB backend — confirmed again here. So these
 * tests cover the orchestration (open/create fallback, batch failure isolation,
 * shaping) against a fake store, and the real round-trip is verified **on
 * device** by `src/verify/storageChecks.js`.
 *
 * That split is deliberate: what can be tested off-device is, and what cannot
 * is verified where it actually runs rather than mocked into a false pass.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {
  deleteCredential, loadCredentials, openCredentialStore, PROTOTYPE_EDV_ID,
  saveCredentials
} from '../../src/wallet/store.js';

/* Every `openCredentialStore` call needs a password now -- there is no default
on purpose, so a hardcoded key cannot ship in the bundle. */
const PASSWORD = 'deadbeefdeadbeefdeadbeefdeadbeef';

const REAL_CREDENTIAL = JSON.parse(readFileSync(
  new URL('../fixtures/playgroundIssuance.json', import.meta.url), 'utf8'))
  .verifiablePresentation.verifiableCredential[0];

/* A stand-in for VerifiableCredentialStore that records calls. */
function fakeStore({failOn = [], documents = []} = {}) {
  const upserted = [];
  return {
    upserted,
    async upsert({credential, meta}) {
      if(failOn.includes(credential?.id)) {
        throw new Error('simulated storage failure');
      }
      upserted.push({credential, meta});
      return {id: credential.id};
    },
    async find() {
      return {documents};
    },
    async delete({id}) {
      if(failOn.includes(id)) {
        const e = new Error('missing');
        e.name = 'NotFoundError';
        throw e;
      }
      return true;
    }
  };
}

/* --- opening the store --- */

test('openCredentialStore reopens an existing EDV', async () => {
  let createCalled = false;
  const result = await openCredentialStore({
    password: PASSWORD,
    pouchEdv: {
      initialize: async () => {},
      PouchEdvClient: {
        fromLocalSecrets: async () => ({marker: 'existing'}),
        createEdv: async () => {
          createCalled = true;
          return {edvClient: {marker: 'new'}};
        }
      }
    },
    VerifiableCredentialStore: class {
      constructor({edvClient}) {
        this.edvClient = edvClient;
      }
    }
  });
  assert.equal(result.created, false);
  assert.equal(result.edvClient.marker, 'existing');
  assert.equal(createCalled, false, 'must not create when one already exists');
});

test('openCredentialStore creates an EDV on first run', async () => {
  const result = await openCredentialStore({
    password: PASSWORD,
    pouchEdv: {
      initialize: async () => {},
      PouchEdvClient: {
        fromLocalSecrets: async () => {
          const e = new Error('no such EDV');
          e.name = 'NotFoundError';
          throw e;
        },
        createEdv: async ({config, password}) => {
          assert.equal(config.id, PROTOTYPE_EDV_ID);
          assert.ok(password, 'a password is required to create the EDV');
          return {edvClient: {marker: 'new'}};
        }
      }
    },
    VerifiableCredentialStore: class {}
  });
  assert.equal(result.created, true);
});

test('openCredentialStore does NOT swallow a wrong-password failure',
  async () => {
  /* Treating any open failure as "create a fresh store" would silently orphan
  existing credentials -- the user would see an empty wallet and assume data
  loss rather than a bad unlock. */
    await assert.rejects(() => openCredentialStore({
      password: PASSWORD,
      pouchEdv: {
        initialize: async () => {},
        PouchEdvClient: {
          fromLocalSecrets: async () => {
            throw new Error('bad password');
          },
          createEdv: async () => {
            throw new Error('createEdv must not be reached');
          }
        }
      },
      VerifiableCredentialStore: class {}
    }), /bad password/);
  });

test('openCredentialStore REQUIRES a password', async () => {
  /* A default would put the decryption key in the app bundle and make the
  at-rest encryption decorative. */
  await assert.rejects(() => openCredentialStore({
    pouchEdv: {initialize: async () => {}, PouchEdvClient: {}},
    VerifiableCredentialStore: class {}
  }), /"password" is required/);
});

/* --- saving --- */

test('saveCredentials upserts each credential', async () => {
  const store = fakeStore();
  const {saved, failures} = await saveCredentials({
    store, credentials: [REAL_CREDENTIAL]
  });
  assert.equal(saved.length, 1);
  assert.equal(failures.length, 0);
  assert.equal(store.upserted[0].credential.id, REAL_CREDENTIAL.id);
});

test('saveCredentials uses upsert so re-accepting does not throw', async () => {
  // `content.id` is a unique index; `insert` would fail on a repeat
  const store = fakeStore();
  await saveCredentials({store, credentials: [REAL_CREDENTIAL]});
  const second = await saveCredentials({store, credentials: [REAL_CREDENTIAL]});
  assert.equal(second.failures.length, 0, 're-saving must be safe');
  assert.equal(store.upserted.length, 2);
});

test('saveCredentials sets meta.displayable — or nothing is listable',
  async () => {
  /* The bug this catches: `VerifiableCredentialStore.upsert` fills `created`,
  `updated`, `id`, and `issuer` but NOT `displayable`. Since `loadCredentials`
  queries `find({query: {displayable: true}})`, omitting it stores the
  credential successfully and then makes it invisible — indistinguishable from
  a silent save
  failure, which is exactly how it presented on device. */
    const store = fakeStore();
    await saveCredentials({store, credentials: [REAL_CREDENTIAL]});
    assert.equal(
      store.upserted[0].meta?.displayable, true,
      'meta.displayable must be set or the credential will never be listed');
  });

test('saveCredentials can store a non-displayable credential', async () => {
  // bundle contents are stored but not shown; web-wallet uses the same flag
  const store = fakeStore();
  await saveCredentials({
    store, credentials: [REAL_CREDENTIAL], displayable: false
  });
  assert.equal(store.upserted[0].meta.displayable, false);
});

test('saveCredentials isolates a failure to one credential', async () => {
  /* One bad credential must not discard the rest of the batch. */
  const good = {...REAL_CREDENTIAL, id: 'urn:uuid:good'};
  const bad = {...REAL_CREDENTIAL, id: 'urn:uuid:bad'};
  const store = fakeStore({failOn: ['urn:uuid:bad']});

  const {saved, failures} = await saveCredentials({
    store, credentials: [good, bad]
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, 'urn:uuid:good');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, 'urn:uuid:bad');
  assert.match(failures[0].reason, /simulated storage failure/);
});

test('saveCredentials tolerates an empty batch', async () => {
  const {saved, failures} = await saveCredentials({store: fakeStore()});
  assert.deepEqual(saved, []);
  assert.deepEqual(failures, []);
});

/* --- loading --- */

test('loadCredentials returns credentials, not EDV documents', async () => {
  const store = fakeStore({
    documents: [{content: REAL_CREDENTIAL, meta: {displayable: true}}]
  });
  const credentials = await loadCredentials({store});
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].id, REAL_CREDENTIAL.id);
  assert.ok(credentials[0].credentialSubject, 'unwrapped to the credential');
});

test('loadCredentials skips documents with no usable content', async () => {
  const store = fakeStore({
    documents: [
      {content: REAL_CREDENTIAL},
      {content: null},
      {},
      {content: {type: ['VerifiableCredential']}} // no credentialSubject
    ]
  });
  assert.equal((await loadCredentials({store})).length, 1);
});

test('loadCredentials handles an empty store', async () => {
  const store = {async find() {
    return {};
  }};
  assert.deepEqual(await loadCredentials({store}), []);
});

/* --- deleting --- */

test('deleteCredential reports success and absence distinctly', async () => {
  const store = fakeStore({failOn: ['urn:uuid:missing']});
  assert.equal(await deleteCredential({store, id: 'urn:uuid:present'}), true);
  assert.equal(await deleteCredential({store, id: 'urn:uuid:missing'}), false);
});

test('deleteCredential rethrows a real failure', async () => {
  const store = {async delete() {
    throw new Error('disk error');
  }};
  await assert.rejects(
    () => deleteCredential({store, id: 'x'}), /disk error/);
});

/* --- the documented Node limitation --- */

test('LIMITATION: the EDV write path cannot be tested under Node', async () => {
  /* Asserted so the limitation is visible in test output rather than buried in
  a doc. If this ever starts passing, `pouchdb-adapter-memory` gained support
  and these tests can be strengthened to use the real store. */
  const {installCryptoShim} = await import('../../src/shim/install.js');
  const {installTextEncoding} = await import(
    '../../src/shim/textEncoding.js');
  installTextEncoding({target: globalThis});
  installCryptoShim({target: globalThis, force: true});

  const LIB = new URL(
    '../../node_modules/@bedrock/web-pouch-edv/lib/', import.meta.url).href;
  const pouchdb = await import(`${LIB}pouchdb.js`);
  const memory = (await import('pouchdb-adapter-memory')).default;
  pouchdb.setAdapter({adapter: 'memory', plugin: memory});
  const {PouchEdvClient} = await import(`${LIB}PouchEdvClient.js`);
  const {VerifiableCredentialStore} = await import('@bedrock/web-vc-store');

  const edvId = await PouchEdvClient.generateId();
  const {edvClient} = await PouchEdvClient.createEdv({
    config: {id: edvId, sequence: 0, controller: 'did:example:h'},
    password: 'pw'
  });

  // constructing the store DOES work -- only writing fails
  const store = new VerifiableCredentialStore({edvClient});
  assert.equal(typeof store.upsert, 'function');

  await assert.rejects(
    () => store.insert({credential: REAL_CREDENTIAL}),
    /database is closed/,
    'if this no longer throws, the memory adapter improved -- ' +
    'strengthen these tests to use the real store');
});
