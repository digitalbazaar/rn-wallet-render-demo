/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tests for the imperative shell. These use a fake global object rather than
 * patching the real `globalThis`, so they cannot leak state between tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {webcrypto} from 'node:crypto';

import {
  checkSubtleCompleteness, createSubtle, installCryptoShim,
  resolveGetRandomValues
} from '../../src/shim/install.js';

const getRandomValues = a => webcrypto.getRandomValues(a);

function fakeGlobal({withSubtle = false, withCrypto = true} = {}) {
  const target = {};
  if(withCrypto) {
    target.crypto = {getRandomValues};
    if(withSubtle) {
      target.crypto.subtle = {marker: 'native'};
    }
  }
  return target;
}

test('resolveGetRandomValues finds a host implementation', () => {
  const fn = resolveGetRandomValues({target: fakeGlobal()});
  const bytes = new Uint8Array(8);
  fn(bytes);
  assert.equal(bytes.some(b => b !== 0), true, 'produced randomness');
});

test('resolveGetRandomValues throws rather than weakening randomness', () => {
  assert.throws(
    () => resolveGetRandomValues({target: fakeGlobal({withCrypto: false})}),
    /No secure random source/);
});

test('installCryptoShim does not clobber native subtle', () => {
  const target = fakeGlobal({withSubtle: true});
  const result = installCryptoShim({target});
  assert.equal(result.installed, false);
  assert.equal(target.crypto.subtle.marker, 'native', 'native left intact');
});

test('installCryptoShim replaces native subtle when forced', () => {
  const target = fakeGlobal({withSubtle: true});
  const result = installCryptoShim({target, force: true});
  assert.equal(result.installed, true);
  assert.equal(target.crypto.subtle.marker, undefined);
  assert.equal(typeof target.crypto.subtle.digest, 'function');
});

test('installCryptoShim aliases `self` for sha256digest-browser', () => {
  // data-integrity/lib/sha256digest-browser.js does `self.crypto` at module
  // scope; RN has no `self`, so the shim must alias it or that import throws.
  const target = fakeGlobal();
  installCryptoShim({target});
  assert.equal(target.self, target);
  assert.equal(typeof target.self.crypto.subtle.digest, 'function');
});

test('installCryptoShim defines CryptoKey for ecdsa-multikey', () => {
  // ecdsa-multikey/lib/crypto-browser.js reads `globalThis.CryptoKey`.
  const target = fakeGlobal();
  installCryptoShim({target});
  assert.equal(typeof target.CryptoKey, 'function');
});

test('installCryptoShim is idempotent', () => {
  const target = fakeGlobal();
  assert.equal(installCryptoShim({target}).installed, true);
  // second call sees its own subtle and declines
  assert.equal(installCryptoShim({target}).installed, false);
});

test('installCryptoShim works when crypto is a frozen host object', () => {
  // Some RN runtimes expose a frozen `crypto`; plain assignment would throw.
  const target = {crypto: Object.freeze({getRandomValues})};
  const result = installCryptoShim({target});
  assert.equal(result.installed, true);
  assert.equal(typeof target.crypto.subtle.digest, 'function');
});

test('subtle adapter returns ArrayBuffer like WebCrypto', async () => {
  const subtle = createSubtle({getRandomValues});
  const digest = await subtle.digest(
    'SHA-256', new TextEncoder().encode('abc'));
  assert.equal(digest instanceof ArrayBuffer, true);
  assert.equal(
    Buffer.from(digest).toString('hex'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('subtle adapter matches Node WebCrypto for HMAC', async () => {
  const subtle = createSubtle({getRandomValues});
  const keyBytes = webcrypto.getRandomValues(new Uint8Array(32));
  const data = new TextEncoder().encode('audit trail entry');
  const algorithm = {name: 'HMAC', hash: 'SHA-256'};

  const shimKey = await subtle.importKey(
    'raw', keyBytes, algorithm, false, ['sign']);
  const shimSig = await subtle.sign('HMAC', shimKey, data);

  const nodeKey = await webcrypto.subtle.importKey(
    'raw', keyBytes, algorithm, false, ['sign']);
  const nodeSig = await webcrypto.subtle.sign('HMAC', nodeKey, data);

  assert.equal(
    Buffer.from(shimSig).toString('hex'),
    Buffer.from(nodeSig).toString('hex'));
});

test('subtle adapter wrapKey/unwrapKey round-trips', async () => {
  const subtle = createSubtle({getRandomValues});
  const kek = await subtle.importKey(
    'raw', webcrypto.getRandomValues(new Uint8Array(32)),
    'AES-KW', false, ['wrapKey', 'unwrapKey']);

  const contentKeyBytes = webcrypto.getRandomValues(new Uint8Array(32));
  const contentKey = await subtle.importKey(
    'raw', contentKeyBytes, 'AES-GCM', true, ['encrypt']);

  const wrapped = await subtle.wrapKey('raw', contentKey, kek);
  assert.equal(wrapped.byteLength, 40, '32 bytes + 8 byte AES-KW overhead');

  const unwrapped = await subtle.unwrapKey(
    'raw', wrapped, kek, 'AES-KW', 'AES-GCM', true, ['encrypt']);
  const exported = await subtle.exportKey('raw', unwrapped);
  assert.equal(
    Buffer.from(exported).toString('hex'),
    Buffer.from(contentKeyBytes).toString('hex'));
});

test('deriveBits through the adapter matches Node', async () => {
  const subtle = createSubtle({getRandomValues});
  const password = new TextEncoder().encode('unlock phrase');
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const params = {name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 10000};

  const shimKey = await subtle.importKey(
    'raw', password, 'PBKDF2', false, ['deriveBits']);
  const shimBits = await subtle.deriveBits(params, shimKey, 256);

  const nodeKey = await webcrypto.subtle.importKey(
    'raw', password, 'PBKDF2', false, ['deriveBits']);
  const nodeBits = await webcrypto.subtle.deriveBits(params, nodeKey, 256);

  assert.equal(
    Buffer.from(shimBits).toString('hex'),
    Buffer.from(nodeBits).toString('hex'));
});

/* --- native provider preference (spec open question 5(a), option 2) --- */

// A complete stand-in for `react-native-quick-crypto`'s `subtle`. The real
// module cannot load under Node (it needs JSI), so these tests verify the
// *selection logic*; on-device verification is a separate step.
function fakeNativeSubtle({marker = 'native', omit = []} = {}) {
  const all = [
    'decrypt', 'deriveBits', 'digest', 'encrypt', 'exportKey', 'generateKey',
    'importKey', 'sign', 'unwrapKey', 'verify', 'wrapKey'
  ];
  const subtle = {marker};
  for(const name of all) {
    if(!omit.includes(name)) {
      subtle[name] = async () => marker;
    }
  }
  return subtle;
}

test('checkSubtleCompleteness accepts a full implementation', () => {
  const {complete, missing} = checkSubtleCompleteness(fakeNativeSubtle());
  assert.equal(complete, true);
  assert.deepEqual(missing, []);
});

test('checkSubtleCompleteness reports exactly what is missing', () => {
  const {complete, missing} = checkSubtleCompleteness(
    fakeNativeSubtle({omit: ['wrapKey', 'deriveBits']}));
  assert.equal(complete, false);
  assert.deepEqual(missing.sort(), ['deriveBits', 'wrapKey']);
});

test('checkSubtleCompleteness handles a missing implementation', () => {
  assert.equal(checkSubtleCompleteness(undefined).complete, false);
  assert.equal(checkSubtleCompleteness(null).complete, false);
});

test('a native provider is preferred over the pure-JS core', () => {
  const target = fakeGlobal();
  const result = installCryptoShim({
    target, native: {subtle: fakeNativeSubtle()}
  });
  assert.equal(result.installed, true);
  assert.equal(result.implementation, 'native');
  assert.equal(
    target.crypto.subtle.marker, 'native',
    'the native implementation must be the active one');
});

test('a native provider exposing methods directly is accepted', () => {
  // quick-crypto may be passed as the module itself rather than `.subtle`
  const target = fakeGlobal();
  const result = installCryptoShim({
    target, native: fakeNativeSubtle({marker: 'direct'})
  });
  assert.equal(result.implementation, 'native');
  assert.equal(target.crypto.subtle.marker, 'direct');
});

test('an INCOMPLETE native provider is rejected, not partially used', () => {
  // This is the important case: a partial `subtle` would throw deep inside an
  // unlock. Falling back cleanly is safer and far easier to diagnose.
  const target = fakeGlobal();
  const result = installCryptoShim({
    target, native: {subtle: fakeNativeSubtle({omit: ['wrapKey']})}
  });
  assert.equal(result.installed, true);
  assert.equal(result.implementation, 'pure-js');
  assert.deepEqual(result.missing, ['wrapKey']);
  assert.notEqual(
    target.crypto.subtle.marker, 'native',
    'the incomplete native implementation must NOT be installed');
  assert.equal(typeof target.crypto.subtle.wrapKey, 'function');
});

test('a rejected native provider still yields working crypto', async () => {
  // the fallback must be fully functional, not a stub
  const target = fakeGlobal();
  installCryptoShim({
    target, native: {subtle: fakeNativeSubtle({omit: ['digest']})}
  });
  const digest = await target.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode('abc'));
  assert.equal(
    Buffer.from(digest).toString('hex'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('native preference still installs the companion globals', () => {
  // `self` and `CryptoKey` are needed regardless of which subtle wins
  const target = fakeGlobal();
  installCryptoShim({target, native: {subtle: fakeNativeSubtle()}});
  assert.equal(target.self, target);
  assert.equal(typeof target.CryptoKey, 'function');
});

test('native provider wins even when a host subtle exists', () => {
  // an explicit native provider is a deliberate choice by the app, so it takes
  // precedence over whatever the runtime happened to supply
  const target = fakeGlobal({withSubtle: true});
  const result = installCryptoShim({
    target, native: {subtle: fakeNativeSubtle({marker: 'quick-crypto'})}
  });
  assert.equal(result.implementation, 'native');
  assert.equal(target.crypto.subtle.marker, 'quick-crypto');
});

test('installCryptoShim provides crypto.randomUUID when absent', () => {
  /* Hermes has no `crypto.randomUUID`, and `web-pouch-edv/lib/helpers.js` calls
  it directly for EDV/document ids. Without this the first `createEdv` fails
  with "undefined is not a function". */
  const target = fakeGlobal();
  installCryptoShim({target});
  assert.equal(typeof target.crypto.randomUUID, 'function');
  assert.match(
    target.crypto.randomUUID(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('installCryptoShim keeps a host randomUUID when present', () => {
  const target = fakeGlobal();
  target.crypto.randomUUID = () => 'host-provided';
  installCryptoShim({target});
  assert.equal(
    target.crypto.randomUUID(), 'host-provided',
    'a real implementation must win over the shim');
});

test('randomUUID is available on a frozen host crypto object', () => {
  const target = {crypto: Object.freeze({getRandomValues})};
  installCryptoShim({target});
  assert.equal(typeof target.crypto.randomUUID, 'function');
});
