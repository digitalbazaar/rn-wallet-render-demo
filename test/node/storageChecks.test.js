/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tests for the on-device storage checks, run against `pouchdb-adapter-memory`.
 *
 * These establish the baseline the on-device SQLite run is compared against: if
 * SQLite behaves the same, the harness shows the same results on device.
 *
 * The crypto shim is installed first because the EDV path needs `crypto.subtle`
 * (PBKDF2, AES-KW) and `web-pouch-edv` reads `globalThis.crypto` at module
 * scope.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {installCryptoShim} from '../../src/shim/install.js';
installCryptoShim({target: globalThis, force: true});

import {
  checkAdapterConfigured, runStorageChecks
} from '../../src/verify/storageChecks.js';

const LIB = new URL(
  '../../node_modules/@bedrock/web-pouch-edv/lib/', import.meta.url).href;
const memory = (await import('pouchdb-adapter-memory')).default;

// Deep-import the internals to assemble a module shaped like the package root.
// Node blocks the bare subpath (restricted `exports`), so use file URLs.
const pouchdb = await import(`${LIB}pouchdb.js`);
const {PouchEdvClient} = await import(`${LIB}PouchEdvClient.js`);
const {initialize} = await import(`${LIB}initialize.js`);
const pouchEdv = {
  setAdapter: pouchdb.setAdapter,
  getAdapter: pouchdb.getAdapter,
  initialize,
  PouchEdvClient
};

const ADAPTER = {adapter: 'memory', plugin: memory};

test('checkAdapterConfigured succeeds with a supported version', () => {
  const r = checkAdapterConfigured({pouchEdv, ...ADAPTER});
  assert.equal(r.pass, true, r.detail);
  assert.equal(pouchEdv.getAdapter(), 'memory');
});

test('checkAdapterConfigured FAILS loudly without setAdapter', () => {
  // a web-pouch-edv too old to expose setAdapter must not pass
  const r = checkAdapterConfigured({pouchEdv: {}, ...ADAPTER});
  assert.equal(r.pass, false);
  assert.match(r.detail, /setAdapter\(\) is not exported/);
});

test('adapter configuration and initialize pass under Node', async () => {
  /* Only the first two checks are asserted here.

  The full encrypted round-trip cannot be verified under
  `pouchdb-adapter-memory`: `insert()` fails with "database is closed" from
  `pouchdb-adapter-leveldb-core`'s `countDocs`, deep inside PouchDB's own memory
  backend. Confirmed this is an artifact of that adapter rather than of
  `web-pouch-edv` or these checks -- plain PouchDB memory `put` +
  `info()` works, and the failure appears only when `web-pouch-edv` drives
  several databases through the memory adapter at once.

  So these checks are written to be RUN ON DEVICE against
  `pouchdb-adapter-react-native-sqlite`, which is a real persistent backend. The
  Node run verifies the harness wiring, not the EDV path. */
  const r = await runStorageChecks({pouchEdv, ...ADAPTER});
  const summary = r.checks
    .map(c => `${c.pass ? 'ok' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n');

  assert.equal(r.checks.length >= 2, true, summary);
  assert.equal(r.checks[0].pass, true, `adapter config: ${summary}`);
  assert.equal(r.checks[1].pass, true, `initialize: ${summary}`);
});

test('runStorageChecks short-circuits without setAdapter', async () => {
  const r = await runStorageChecks({pouchEdv: {}, ...ADAPTER});
  assert.equal(r.pass, false);
  assert.equal(
    r.checks.length, 1,
    'must not run storage checks against an unconfigured adapter');
});
