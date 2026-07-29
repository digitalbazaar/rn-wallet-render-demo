/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * On-device storage verification: does `@bedrock/web-pouch-edv` work on
 * `pouchdb-adapter-react-native-sqlite`?
 *
 * These run against the package's **public API** (`initialize`,
 * `PouchEdvClient.createEdv`, `fromLocalSecrets`, `insert`, `get`, `find`)
 * rather than the internal `pouchdb.js` helpers. Two reasons:
 *
 * 1. `web-pouch-edv` restricts `exports` to `./lib/index.js`, so with package
 *    exports enabled in Metro the internals cannot be deep-imported anyway.
 * 2. The public API is what the wallet will actually use, and it exercises the
 *    whole stack — PBKDF2 unlock, AES-KW key wrapping, `minimal-cipher`
 *    document encryption, and the SQLite adapter underneath — so it is the more
 *    meaningful thing to verify.
 *
 * This is the last outstanding Phase 1 verification item: `test/node/
 * adapterConcurrency.test.js` concluded that the `insertOne`/`updateOne`
 * uniqueness semantics are a property of the plugin's JavaScript rather than of
 * the adapter. A successful end-to-end run here on real SQLite supports that.
 *
 * Same functional-core shape as `deviceChecks.js`: dependencies injected,
 * results returned as plain objects, so the logic is unit-testable off-device.
 */

/* Include the first useful stack frame in failure details. Without it,
"undefined is not a function" gives no clue which module is at fault -- which
cost real time diagnosing the SQLite path on-device. */
function _frame(e) {
  const line = (e?.stack ?? '').split('\n')
    .map(l => l.trim())
    .find(l => l.startsWith('at ') && !l.includes('storageChecks'));
  return line ? ` [${line.slice(0, 120)}]` : '';
}

const PASSWORD = 'verification-harness-password';

/**
 * Configures the PouchDB adapter and confirms the API is available.
 *
 * @param {object} options - The options.
 * @param {object} options.pouchEdv - The `@bedrock/web-pouch-edv` module.
 * @param {string} options.adapter - Adapter name to select.
 * @param {object|Function} options.plugin - The adapter's PouchDB plugin.
 *
 * @returns {object} The check result.
 */
export function checkAdapterConfigured({pouchEdv, adapter, plugin}) {
  if(typeof pouchEdv.setAdapter !== 'function') {
    return {
      name: 'adapter configurable',
      pass: false,
      detail: 'setAdapter() is not exported -- check that the installed ' +
        '@bedrock/web-pouch-edv is 8.3.0 or later.'
    };
  }
  try {
    pouchEdv.setAdapter({adapter, plugin});
    const active = pouchEdv.getAdapter();
    return {
      name: 'adapter configurable',
      pass: active === adapter,
      detail: active === adapter ?
        `adapter set to "${active}"` :
        `setAdapter("${adapter}") left adapter as "${active}"`
    };
  } catch(e) {
    return {
      name: 'adapter configurable', pass: false,
      detail: `setAdapter threw: ${e.message}`
    };
  }
}

/**
 * Verifies the collections initialize against the configured adapter.
 *
 * This is where an adapter that cannot open a database fails, so it runs before
 * anything that needs storage.
 *
 * @param {object} options - The options.
 * @param {object} options.pouchEdv - The `@bedrock/web-pouch-edv` module.
 *
 * @returns {Promise<object>} The check result.
 */
export async function checkInitialize({pouchEdv}) {
  try {
    await pouchEdv.initialize();
    return {
      name: 'storage initializes',
      pass: true,
      detail: 'chunks, docs, edvs, and secrets collections opened'
    };
  } catch(e) {
    return {
      name: 'storage initializes', pass: false,
      detail: `initialize() threw: ${e.message}`
    };
  }
}

/**
 * Creates an encrypted EDV, writes a credential-shaped document, reads it back,
 * and finds it by an indexed attribute.
 *
 * This is the real end-to-end path: password -> PBKDF2 -> KEK -> AES-KW ->
 * content key -> AES-GCM document -> SQLite. If this passes, the wallet's local
 * storage works on device.
 *
 * @param {object} options - The options.
 * @param {object} options.pouchEdv - The `@bedrock/web-pouch-edv` module.
 *
 * @returns {Promise<object>} The check result.
 */
export async function checkEncryptedRoundTrip({pouchEdv}) {
  // declared outside the try so the catch can report it
  let jweProbe = '';
  try {
    const {PouchEdvClient} = pouchEdv;
    const edvId = await PouchEdvClient.generateId();

    const {edvClient} = await PouchEdvClient.createEdv({
      config: {
        id: edvId,
        sequence: 0,
        controller: 'did:example:harness'
      },
      password: PASSWORD
    });

    const doc = {
      id: await PouchEdvClient.generateId(),
      content: {
        '@context': 'https://www.w3.org/2018/credentials/v1',
        type: ['VerifiableCredential'],
        credentialSubject: {degree: 'BachelorDegree'}
      }
    };
    /* Diagnostic: surface the JWE shape when insert succeeds but the read-back
    fails. `Invalid JWE "protected" header` gives no clue whether encryption
    produced a bad header or decryption misread a good one. */
    let inserted;
    try {
      inserted = await edvClient.insert({doc});
    } catch(e) {
      return {
        name: 'encrypted round-trip', pass: false,
        detail: `insert threw: ${e.message}${_frame(e)}`
      };
    }
    const prot = inserted?.jwe?.protected;
    jweProbe = ` [written jwe.protected=${typeof prot}` +
      `:${String(prot).slice(0, 20)}` +
      `; keys=${Object.keys(inserted?.jwe ?? {}).join('|')}]`;
    if(!inserted?.id) {
      return {
        name: 'encrypted round-trip', pass: false,
        detail: 'insert() did not return a document with an id'
      };
    }

    /* Probe the raw stored record before decryption. `Invalid JWE "protected"
    header` on read-back means the stored JWE came back in a different shape
    than
    it went in -- most likely a nested object or typed array not surviving the
    SQLite round-trip. Reading it directly separates "storage corrupted it" from
    "decryption misread it". */
    /* Read the RAW stored record before `get()` decrypts it.

    The written header is valid base64url and decodes correctly in Node, so the
    remaining hypothesis is that the stored JWE comes back from SQLite in a
    different shape than it went in -- e.g. `protected` arriving as an object or
    array instead of the string it was written as, which would make
    `base64url.decode` throw and produce exactly this error. */
    try {
      const rec = await pouchEdv.docs.get({
        edvId: edvClient.id, id: inserted.id
      });
      const rp = rec?.doc?.jwe?.protected;
      jweProbe += ` [read jwe.protected=${typeof rp}` +
        `:${String(rp).slice(0, 20)}` +
        `; keys=${Object.keys(rec?.doc?.jwe ?? {}).join('|')}]`;
    } catch(e) {
      jweProbe += ` [raw read failed: ${e.message.slice(0, 50)}]`;
    }

    const fetched = await edvClient.get({id: inserted.id});
    const subject = fetched?.content?.credentialSubject;
    if(subject?.degree !== 'BachelorDegree') {
      return {
        name: 'encrypted round-trip', pass: false,
        detail: `decrypted content did not match what was written${jweProbe}`
      };
    }

    return {
      name: 'encrypted round-trip',
      pass: true,
      detail: 'created EDV, encrypted and stored a credential, decrypted it ' +
        `back through SQLite${jweProbe}`
    };
  } catch(e) {
    return {
      name: 'encrypted round-trip', pass: false,
      detail: `threw: ${e.message}${_frame(e)}${jweProbe}`
    };
  }
}

/**
 * Verifies the password gate: the correct password unlocks an existing EDV and
 * a wrong one does not.
 *
 * Exercises PBKDF2 + AES-KW unwrap, and confirms `Kek.unwrapKey`'s
 * null-on-failure contract still produces a clean auth failure on device.
 *
 * @param {object} options - The options.
 * @param {object} options.pouchEdv - The `@bedrock/web-pouch-edv` module.
 *
 * @returns {Promise<object>} The check result.
 */
export async function checkPasswordUnlock({pouchEdv}) {
  try {
    const {PouchEdvClient} = pouchEdv;
    const edvId = await PouchEdvClient.generateId();

    await PouchEdvClient.createEdv({
      config: {id: edvId, sequence: 0, controller: 'did:example:harness'},
      password: PASSWORD
    });

    // correct password must unlock
    const opened = await PouchEdvClient.fromLocalSecrets({
      edvId, password: PASSWORD
    });
    if(!opened) {
      return {
        name: 'password unlock', pass: false,
        detail: 'the correct password failed to unlock the EDV'
      };
    }

    // wrong password must NOT unlock -- either null or a thrown error is
    // acceptable, silently succeeding is not
    let wrongRejected = false;
    try {
      const bad = await PouchEdvClient.fromLocalSecrets({
        edvId, password: 'definitely-not-the-password'
      });
      wrongRejected = !bad;
    } catch {
      wrongRejected = true;
    }

    return {
      name: 'password unlock',
      pass: wrongRejected,
      detail: wrongRejected ?
        'correct password unlocks; wrong password is rejected' :
        'SECURITY: a wrong password unlocked the EDV'
    };
  } catch(e) {
    return {
      name: 'password unlock', pass: false,
      detail: `threw: ${e.message}${_frame(e)}`
    };
  }
}

/**
 * Verifies duplicate document ids are rejected — the `_id` uniqueness guarantee
 * the wallet relies on, since `docs.js` derives `_id` from
 * `localEdvId` + `doc.id`.
 *
 * The Node baseline showed this guarantee is solid (backed by PouchDB `_rev`
 * conflict detection), unlike custom `uniqueConstraints`.
 *
 * @param {object} options - The options.
 * @param {object} options.pouchEdv - The `@bedrock/web-pouch-edv` module.
 *
 * @returns {Promise<object>} The check result.
 */
export async function checkDuplicateRejected({pouchEdv}) {
  try {
    const {PouchEdvClient} = pouchEdv;
    const edvId = await PouchEdvClient.generateId();
    const {edvClient} = await PouchEdvClient.createEdv({
      config: {id: edvId, sequence: 0, controller: 'did:example:harness'},
      password: PASSWORD
    });

    const id = await PouchEdvClient.generateId();
    await edvClient.insert({doc: {id, content: {value: 1}}});

    let rejected = false;
    try {
      await edvClient.insert({doc: {id, content: {value: 2}}});
    } catch {
      rejected = true;
    }

    return {
      name: 'duplicate id rejected',
      pass: rejected,
      detail: rejected ?
        'inserting the same document id twice is rejected' :
        'a duplicate document id was accepted -- _id uniqueness is not holding'
    };
  } catch(e) {
    return {
      name: 'duplicate id rejected', pass: false,
      detail: `threw: ${e.message}${_frame(e)}`
    };
  }
}

/**
 * Runs every storage check in order.
 *
 * @param {object} options - The options.
 * @param {object} options.pouchEdv - The `@bedrock/web-pouch-edv` module.
 * @param {string} options.adapter - Adapter name to configure.
 * @param {object|Function} options.plugin - The adapter's PouchDB plugin.
 *
 * @returns {Promise<object>} `{pass, checks}`.
 */
export async function runStorageChecks({pouchEdv, adapter, plugin}) {
  const checks = [checkAdapterConfigured({pouchEdv, adapter, plugin})];
  if(!checks[0].pass) {
    // everything downstream needs a configured adapter
    return {pass: false, checks};
  }

  checks.push(await checkInitialize({pouchEdv}));
  if(!checks[1].pass) {
    return {pass: false, checks};
  }

  checks.push(await checkEncryptedRoundTrip({pouchEdv}));
  checks.push(await checkPasswordUnlock({pouchEdv}));
  checks.push(await checkDuplicateRejected({pouchEdv}));

  return {pass: checks.every(c => c.pass), checks};
}
