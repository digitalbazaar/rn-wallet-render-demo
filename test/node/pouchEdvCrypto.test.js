/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Phase 0 acceptance test.
 *
 * This is the test that actually decides whether the plan's central thesis
 * holds: it imports the **real, unmodified** `@bedrock/web-pouch-edv` crypto
 * modules and runs them against the pure-JS shim. Those modules read
 * `globalThis.crypto` at module scope, so the shim is installed onto a stub
 * global *before* they are imported via dynamic `import()`.
 *
 * `@bedrock/web-pouch-edv` is a real devDependency (pinned to 8.3.0), so this
 * test works on a fresh clone and a version bump that breaks the shim shows up
 * here rather than at runtime on a device.
 *
 * If these pass, no native crypto module is required for the storage layer.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {webcrypto} from 'node:crypto';

import {installCryptoShim} from '../../src/shim/install.js';

// Install the shim onto the real `globalThis`, replacing Node's native
// `subtle`, so the real modules exercise the shim and not Node's WebCrypto.
// `getRandomValues` is left as Node's.
installCryptoShim({target: globalThis, force: true});

// Individual modules are loaded rather than the package root, because the root
// pulls in `pouchdb-adapter-indexeddb`, which needs a browser. The package
// restricts its `exports` map to the root, so bare subpath specifiers are
// blocked -- resolve to a `file://` URL instead, which bypasses the exports map
// without needing a vendored copy of the source.
const REF = new URL(
  '../../node_modules/@bedrock/web-pouch-edv/lib/', import.meta.url).href;

test('shim is the active subtle implementation', () => {
  // guards against the test silently passing on Node's native implementation
  assert.equal(
    globalThis.crypto.subtle.digest.name, 'digest');
  assert.equal(
    Object.hasOwn(globalThis.crypto.subtle, 'wrapKey'), true,
    'shim exposes its own wrapKey');
});

test('real pbkdf2.js derives bits through the shim', async () => {
  const {deriveBits} = await import(`${REF}pbkdf2.js`);

  const {algorithm, derivedBits} = await deriveBits({
    bitLength: 256, iterations: 10000,
    password: 'correct horse battery staple',
    salt: new Uint8Array(16).fill(7)
  });

  assert.equal(derivedBits.length, 32);
  assert.equal(algorithm.iterations, 10000);
  assert.equal(algorithm.hash, 'SHA-256');

  // cross-check the value against Node's native WebCrypto
  const nodeKey = await webcrypto.subtle.importKey(
    'raw', new TextEncoder().encode('correct horse battery staple'),
    'PBKDF2', false, ['deriveBits']);
  const expected = await webcrypto.subtle.deriveBits(
    {
      name: 'PBKDF2', hash: 'SHA-256',
      salt: new Uint8Array(16).fill(7), iterations: 10000
    }, nodeKey, 256);
  assert.equal(
    Buffer.from(derivedBits).toString('hex'),
    Buffer.from(expected).toString('hex'));
});

test('real pbkdf2.js generates its own salt via getRandomValues', async () => {
  const {deriveBits} = await import(`${REF}pbkdf2.js`);
  const {algorithm, derivedBits} = await deriveBits({
    bitLength: 256, iterations: 1000, password: 'pw', saltSize: 16
  });
  assert.equal(derivedBits.length, 32);
  assert.equal(algorithm.salt.length, 16);
  assert.equal(algorithm.salt.some(b => b !== 0), true, 'salt is random');
});

test('real Kek.js wraps and unwraps a content key', async () => {
  const {Kek} = await import(`${REF}Kek.js`);

  const secret = webcrypto.getRandomValues(new Uint8Array(32));
  const kek = await Kek.import({secret});

  const contentKey = webcrypto.getRandomValues(new Uint8Array(32));
  const wrappedKey = await kek.wrapKey({unwrappedKey: contentKey});

  assert.equal(wrappedKey instanceof Uint8Array, true);
  assert.equal(wrappedKey.length, 40, '32 + 8 bytes AES-KW overhead');

  const unwrapped = await kek.unwrapKey({wrappedKey});
  assert.equal(
    Buffer.from(unwrapped).toString('hex'),
    Buffer.from(contentKey).toString('hex'),
    'round-trips the exact content key');
});

test('real Kek.js returns null on a wrong KEK, per its contract', async () => {
  const {Kek} = await import(`${REF}Kek.js`);

  const right = await Kek.import({
    secret: webcrypto.getRandomValues(new Uint8Array(32))});
  const wrong = await Kek.import({
    secret: webcrypto.getRandomValues(new Uint8Array(32))});

  const contentKey = webcrypto.getRandomValues(new Uint8Array(32));
  const wrappedKey = await right.wrapKey({unwrappedKey: contentKey});

  // Kek.unwrapKey catches and returns null rather than throwing; this is the
  // behavior the password-unlock flow depends on to detect a bad password.
  assert.equal(await wrong.unwrapKey({wrappedKey}), null);
});

test('real Kek.js wrapped key is unwrappable by Node WebCrypto', async () => {
  // proves the shim produces standards-conformant AES-KW output, so data
  // written on RN can be read by the web wallet and vice versa
  const {Kek} = await import(`${REF}Kek.js`);

  const secret = webcrypto.getRandomValues(new Uint8Array(32));
  const contentKey = webcrypto.getRandomValues(new Uint8Array(32));

  const kek = await Kek.import({secret});
  const wrappedKey = await kek.wrapKey({unwrappedKey: contentKey});

  const nodeKek = await webcrypto.subtle.importKey(
    'raw', secret, {name: 'AES-KW', length: 256}, false, ['unwrapKey']);
  const nodeUnwrapped = await webcrypto.subtle.unwrapKey(
    'raw', wrappedKey, nodeKek, 'AES-KW',
    {name: 'HMAC', hash: 'SHA-512'}, true, ['sign']);
  const exported = await webcrypto.subtle.exportKey('raw', nodeUnwrapped);

  assert.equal(
    Buffer.from(exported).toString('hex'),
    Buffer.from(contentKey).toString('hex'));
});

test('real Hmac.js signs and verifies a blinded index', async () => {
  const {Hmac} = await import(`${REF}Hmac.js`);

  const hmac = await Hmac.generate();
  const data = new TextEncoder().encode('credential-index-entry');

  const signature = await hmac.sign({data});
  assert.equal(signature instanceof Uint8Array, true);
  assert.equal(signature.length, 32, 'SHA-256 output');

  assert.equal(await hmac.verify({data, signature}), true);

  const tampered = signature.slice();
  tampered[0] ^= 0xff;
  assert.equal(await hmac.verify({data, signature: tampered}), false);
});

test('real Hmac.js is deterministic for the same key and data', async () => {
  // blinded index lookups depend on this: the same attribute must always
  // hash to the same value or documents become unfindable
  const {Hmac} = await import(`${REF}Hmac.js`);

  const hmac = await Hmac.generate();
  const data = new TextEncoder().encode('content-type=VerifiableCredential');

  const a = await hmac.sign({data});
  const b = await hmac.sign({data});
  assert.equal(
    Buffer.from(a).toString('hex'), Buffer.from(b).toString('hex'));
});
