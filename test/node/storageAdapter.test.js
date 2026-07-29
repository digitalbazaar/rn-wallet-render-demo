/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Integration tests for the `@bedrock/web-pouch-edv` adapter configuration.
 *
 * `setAdapter()` is the seam the whole storage path depends on: the wallet
 * needs a non-IndexedDB PouchDB adapter on device, and a silent fall back to
 * `indexeddb` would fail far from the cause.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// Loaded by `file://` URL because the package restricts `exports` to its root,
// and importing the root pulls in `pouchdb-adapter-indexeddb` (browser-only).
const LIB = new URL(
  '../../node_modules/@bedrock/web-pouch-edv/lib/', import.meta.url).href;

const pouchdb = await import(`${LIB}pouchdb.js`);

test('setAdapter/getAdapter are available', () => {
  assert.equal(
    typeof pouchdb.setAdapter, 'function',
    'setAdapter() is missing -- check the installed ' +
    '@bedrock/web-pouch-edv version is >= 8.3.0.');
  assert.equal(typeof pouchdb.getAdapter, 'function');
});

test('the adapter API is exported from the package index', () => {
  // `setAdapter` must be reachable from the package root, since the whole
  // point is calling it once at app startup.
  const index = new URL(
    '../../node_modules/@bedrock/web-pouch-edv/lib/index.js',
    import.meta.url);
  return import(index.href).then(mod => {
    assert.equal(typeof mod.setAdapter, 'function');
    assert.equal(typeof mod.getAdapter, 'function');
  });
});

test('default adapter is unchanged for browser hosts', () => {
  // Browser behavior is unchanged; `indexeddb` stays the default
  // until an app explicitly opts out.
  assert.equal(pouchdb.getAdapter(), 'indexeddb');
});

test('setAdapter validates its input and fails safe', () => {
  const before = pouchdb.getAdapter();

  assert.throws(
    () => pouchdb.setAdapter({}), /"adapter" must be a string/);
  assert.throws(
    () => pouchdb.setAdapter({adapter: 'x', plugin: 'nope'}),
    /"plugin" must be an object or a function/);
  assert.throws(
    () => pouchdb.setAdapter({adapter: 'x', plugin: null}),
    /"plugin" must be an object or a function/);

  assert.equal(
    pouchdb.getAdapter(), before,
    'a rejected setAdapter() call must not change the default');
});

test('setAdapter accepts a function plugin', async () => {
  // Regression test for a real bug in an earlier draft of the upstream change:
  // `assert.object` was used to validate `plugin`, but PouchDB adapter
  // packages (pouchdb-adapter-indexeddb, -memory, -react-native-sqlite) export
  // FUNCTIONS. Validating as object-only made setAdapter() unusable with every
  // real adapter.
  const memory = (await import('pouchdb-adapter-memory')).default;
  assert.equal(
    typeof memory, 'function', 'precondition: adapter plugin is a function');

  pouchdb.setAdapter({adapter: 'memory', plugin: memory});
  assert.equal(pouchdb.getAdapter(), 'memory');
});

test('a non-IndexedDB adapter round-trips via EDV helpers', async () => {
  // Proves the API is not merely present but functional: the plugin
  // uniqueness helpers still work when the adapter is swapped.
  const db = await pouchdb.createDatabase({name: 'adapter-test'});
  try {
    const inserted = await db.insertOne({doc: {_id: 'doc-1', value: 1}});
    assert.equal(inserted.record._id, 'doc-1');
    assert.ok(inserted.record._rev, 'insert returns a revision');

    const updated = await db.updateOne({
      doc: {_id: 'doc-1', value: 42},
      query: {selector: {_id: 'doc-1'}}
    });
    assert.equal(updated.record.value, 42);
  } finally {
    await db.close();
  }
});

test('uniqueness constraints still fire on a swapped adapter', async () => {
  // The `insertOne` plugin documents non-atomic uniqueness semantics reasoned
  // about for IndexedDB. This confirms the constraint at least still triggers
  // on another adapter. It does NOT test the concurrent check-then-write
  // window -- that remains an open question for the upstream maintainers.
  const db = await pouchdb.createDatabase({name: 'adapter-unique'});
  try {
    await db.insertOne({doc: {_id: 'dup', value: 1}});
    await assert.rejects(
      () => db.insertOne({doc: {_id: 'dup', value: 2}}),
      e => e.name === 'ConstraintError');
  } finally {
    await db.close();
  }
});

test('purge() falls back to compact() off IndexedDB', async () => {
  // The stock implementation calls `indexedDB.open()` directly, which would
  // throw in Node and on a device. Upstream routes non-indexeddb adapters
  // through PouchDB's own compact().
  const result = await pouchdb.purge({name: 'adapter-test'});
  assert.deepEqual(
    result, {deleted: 0},
    'compact() reports no count, so the fallback reports 0');
});
