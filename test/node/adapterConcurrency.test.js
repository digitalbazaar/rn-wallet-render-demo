/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Answers spec open question 2: do the `insertOne`/`updateOne` uniqueness
 * semantics hold when the PouchDB adapter is swapped away from IndexedDB?
 *
 * `web-pouch-edv/lib/pouchdb.js` provides two *different* uniqueness
 * guarantees, and conflating them is the trap this test exists to avoid:
 *
 * 1. **`_id` uniqueness** — enforced by PouchDB itself via `_rev` conflict
 *    detection. `insertOne` catches status 409 and retries, so this should be
 *    genuinely concurrency-safe on any adapter that implements revisions
 *    correctly.
 *
 * 2. **Custom `uniqueConstraints`** — a `find()` check followed by a
 *    non-atomic `put()`. The source says so explicitly: "this is not atomic
 *    w/the unique contraints check, so if concurrent processes update the same
 *    information the constraints may no longer be met". This is the documented
 *    weak spot.
 *
 * Guarantee 2 is what `docs.js` uses to prevent duplicate credentials
 * (`selector: {localEdvId, uniqueAttributes: {$in: [...]}}`), so its real-world
 * behavior matters to the wallet.
 *
 * **What this test can and cannot establish.** It runs against
 * `pouchdb-adapter-memory`, not `pouchdb-adapter-react-native-sqlite`, because
 * the latter requires a React Native runtime (`op-sqlite`, JSI) and cannot be
 * loaded under Node. So this characterizes the *plugin logic's* concurrency
 * behavior independent of IndexedDB, and establishes the expected baseline. It
 * does **not** prove SQLite behaves identically — that requires running these
 * same assertions on-device. Treat the results as "the semantics are a property
 * of the plugin, not of IndexedDB" plus a ready-made on-device test.
 *
 * ## Result (2026-07-26)
 *
 * - **`_id` uniqueness: safe.** 1 of 12 concurrent inserts wins, 11 get
 *   `ConstraintError`. PouchDB's `_rev` conflict detection is doing real work.
 * - **Custom `uniqueConstraints`: violable, deterministically.** Two concurrent
 *   inserts with different `_id`s and the same constrained attribute both
 *   succeed, leaving two documents holding a "unique" attribute. Reproduced
 *   5/5 runs — this is not a rare interleaving.
 *
 * **Why this answers the SQLite question rather than deferring it:** the
 * `find()`-then-`put()` gap is in the plugin's own JavaScript, above the
 * adapter. No adapter can close it, because nothing in that code path opens a
 * transaction spanning the check and the write. Swapping IndexedDB for SQLite
 * therefore cannot make guarantee 2 stronger *or* weaker. The source comment
 * says as much: the retry loop "mitigates concurrency issues w/`_id` (but not
 * other unique constraints)".
 *
 * Consequence for the wallet: `uniqueConstraints` is a best-effort dedupe, not
 * an invariant. Anything requiring true uniqueness must encode it in `_id`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const LIB = new URL(
  '../../node_modules/@bedrock/web-pouch-edv/lib/', import.meta.url).href;
const pouchdb = await import(`${LIB}pouchdb.js`);
const memory = (await import('pouchdb-adapter-memory')).default;

pouchdb.setAdapter({adapter: 'memory', plugin: memory});

let dbCounter = 0;
async function freshDb() {
  // unique name per test so state never leaks between cases
  return pouchdb.createDatabase({name: `concurrency-${dbCounter++}`});
}

test('_id uniqueness holds under concurrent inserts', async () => {
  // Guarantee 1. PouchDB's own revision conflict detection backs this, so all
  // but one racer must fail even when they start simultaneously.
  const db = await freshDb();
  try {
    const attempts = 12;
    const results = await Promise.allSettled(
      Array.from({length: attempts}, (_, i) =>
        db.insertOne({doc: {_id: 'contended', writer: i}})));

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    assert.equal(
      succeeded.length, 1,
      `exactly one insert must win; ${succeeded.length} did`);
    assert.equal(failed.length, attempts - 1);

    // every loser must fail with the library's own error, not a raw PouchDB 409
    for(const {reason} of failed) {
      assert.equal(
        reason.name, 'ConstraintError',
        `expected ConstraintError, got ${reason.name}: ${reason.message}`);
    }

    // and the database must hold exactly one document
    const {docs} = await db.find({selector: {_id: 'contended'}, limit: 10});
    assert.equal(docs.length, 1);
  } finally {
    await db.close();
  }
});

test('_id uniqueness holds under sequential inserts', async () => {
  const db = await freshDb();
  try {
    await db.insertOne({doc: {_id: 'seq', v: 1}});
    await assert.rejects(
      () => db.insertOne({doc: {_id: 'seq', v: 2}}),
      e => e.name === 'ConstraintError');
  } finally {
    await db.close();
  }
});

test('custom uniqueConstraints hold when inserts are sequential', async () => {
  // Guarantee 2, the easy case. Mirrors how `docs.js` constrains blinded
  // unique attributes.
  const db = await freshDb();
  try {
    await db.createIndex({index: {fields: ['localEdvId', 'uniqueAttributes']}});

    const constraint = attrs => [{
      selector: {localEdvId: 'edv-1', uniqueAttributes: {$in: attrs}}
    }];

    await db.insertOne({
      doc: {_id: 'doc-a', localEdvId: 'edv-1', uniqueAttributes: ['attr-x']},
      uniqueConstraints: constraint(['attr-x'])
    });

    // a second document claiming the same unique attribute must be refused
    await assert.rejects(
      () => db.insertOne({
        doc: {_id: 'doc-b', localEdvId: 'edv-1', uniqueAttributes: ['attr-x']},
        uniqueConstraints: constraint(['attr-x'])
      }),
      e => e.name === 'ConstraintError',
      'duplicate unique attribute must be rejected when serialized');

    const {docs} = await db.find({
      selector: {localEdvId: 'edv-1', uniqueAttributes: {$in: ['attr-x']}},
      limit: 10
    });
    assert.equal(docs.length, 1, 'only one document holds the attribute');
  } finally {
    await db.close();
  }
});

test('custom uniqueConstraints are scoped per EDV', async () => {
  // The selector includes `localEdvId`, so the same attribute in a different
  // EDV must be allowed. Guards against an over-broad index.
  const db = await freshDb();
  try {
    await db.createIndex({index: {fields: ['localEdvId', 'uniqueAttributes']}});
    const constraint = (edvId, attrs) => [{
      selector: {localEdvId: edvId, uniqueAttributes: {$in: attrs}}
    }];

    await db.insertOne({
      doc: {_id: 'a', localEdvId: 'edv-1', uniqueAttributes: ['shared']},
      uniqueConstraints: constraint('edv-1', ['shared'])
    });
    // same attribute value, different EDV -> must succeed
    const second = await db.insertOne({
      doc: {_id: 'b', localEdvId: 'edv-2', uniqueAttributes: ['shared']},
      uniqueConstraints: constraint('edv-2', ['shared'])
    });
    assert.equal(second.record._id, 'b');
  } finally {
    await db.close();
  }
});

test('CHARACTERIZATION: concurrent constraints can both win', async t => {
  /* Guarantee 2, the documented weak case.

  `insertOne` does `find()` then `put()` with no transaction spanning both. Two
  concurrent inserts with *different* `_id`s but the *same* constrained
  attribute can both observe "no existing match" and both write. PouchDB's
  revision conflict detection does not help, because the `_id`s differ.

  This test CHARACTERIZES the behavior rather than asserting a fix. If the
  violation occurs, that is the documented limitation, not a regression -- and
  it is information the wallet's design must account for. The result is logged
  either way so the on-device run can be compared against this baseline. */
  const db = await freshDb();
  try {
    await db.createIndex({index: {fields: ['localEdvId', 'uniqueAttributes']}});
    const constraint = [{
      selector: {localEdvId: 'edv-1', uniqueAttributes: {$in: ['race']}}
    }];

    const results = await Promise.allSettled([
      db.insertOne({
        doc: {_id: 'racer-1', localEdvId: 'edv-1', uniqueAttributes: ['race']},
        uniqueConstraints: constraint
      }),
      db.insertOne({
        doc: {_id: 'racer-2', localEdvId: 'edv-1', uniqueAttributes: ['race']},
        uniqueConstraints: constraint
      })
    ]);

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const {docs} = await db.find({
      selector: {localEdvId: 'edv-1', uniqueAttributes: {$in: ['race']}},
      limit: 10
    });

    t.diagnostic(
      `concurrent constrained inserts: ${succeeded}/2 succeeded, ` +
      `${docs.length} document(s) now hold the unique attribute`);

    if(docs.length > 1) {
      t.diagnostic(
        'CONFIRMED: the documented non-atomic window is reachable -- ' +
        'concurrent inserts violated a custom uniqueness constraint. ' +
        'The wallet must not rely on uniqueConstraints alone for correctness ' +
        'under concurrency.');
    } else {
      t.diagnostic(
        'The race did not reproduce here; serialization in this adapter ' +
        'happened to prevent it. This is NOT proof of safety -- the source ' +
        'documents the window explicitly.');
    }

    // Assert only what is guaranteed regardless of outcome: the database never
    // corrupts, and every write that reported success is actually readable.
    assert.ok(docs.length >= 1, 'at least one insert must persist');
    assert.ok(
      succeeded >= 1, 'at least one concurrent insert must report success');
    for(const doc of docs) {
      assert.ok(doc._rev, 'every persisted document has a revision');
    }
  } finally {
    await db.close();
  }
});

test('updateOne rejects a constraint-violating update', async () => {
  const db = await freshDb();
  try {
    await db.createIndex({index: {fields: ['localEdvId', 'uniqueAttributes']}});
    const constraintFor = attrs => [{
      selector: {localEdvId: 'edv-1', uniqueAttributes: {$in: attrs}}
    }];

    await db.insertOne({
      doc: {_id: 'first', localEdvId: 'edv-1', uniqueAttributes: ['taken']},
      uniqueConstraints: constraintFor(['taken'])
    });
    await db.insertOne({
      doc: {_id: 'second', localEdvId: 'edv-1', uniqueAttributes: ['free']},
      uniqueConstraints: constraintFor(['free'])
    });

    // moving `second` onto the attribute already held by `first` must fail
    await assert.rejects(
      () => db.updateOne({
        doc: {_id: 'second', localEdvId: 'edv-1', uniqueAttributes: ['taken']},
        query: {selector: {_id: 'second'}},
        uniqueConstraints: constraintFor(['taken'])
      }),
      e => e.name === 'ConstraintError',
      'update must not be allowed to violate uniqueness');
  } finally {
    await db.close();
  }
});

test('updateOne upsert inserts when no match exists', async () => {
  const db = await freshDb();
  try {
    const result = await db.updateOne({
      doc: {_id: 'upserted', value: 1},
      query: {selector: {_id: 'upserted'}},
      upsert: true
    });
    assert.equal(result.record._id, 'upserted');

    // and without upsert, a miss returns false rather than throwing
    const miss = await db.updateOne({
      doc: {_id: 'absent', value: 1},
      query: {selector: {_id: 'absent'}}
    });
    assert.equal(miss, false);
  } finally {
    await db.close();
  }
});

test('concurrent updateOne calls converge, losing no document', async () => {
  // The retry-on-409 loop should make concurrent updates serialize rather than
  // corrupt. Last write wins; what matters is that exactly one document
  // survives with a valid revision.
  const db = await freshDb();
  try {
    await db.insertOne({doc: {_id: 'target', value: 0}});

    const writers = 8;
    const results = await Promise.allSettled(
      Array.from({length: writers}, (_, i) =>
        db.updateOne({
          doc: {_id: 'target', value: i + 1},
          query: {selector: {_id: 'target'}}
        })));

    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    assert.equal(
      succeeded, writers, 'every update should eventually apply or retry');

    const {docs} = await db.find({selector: {_id: 'target'}, limit: 10});
    assert.equal(docs.length, 1, 'exactly one document survives');
    assert.ok(docs[0].value >= 1, 'a write landed');
  } finally {
    await db.close();
  }
});
