/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tests for the crypto bootstrap (spec open question 5(a), option 2).
 *
 * `react-native-quick-crypto` cannot be loaded under Node — it needs JSI — so
 * the module loader is injected. These tests cover the selection and
 * degradation logic; confirming the real native module is an on-device step.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {webcrypto} from 'node:crypto';

import {bootstrapCrypto, loadNativeCrypto} from '../../src/shim/index.js';

const getRandomValues = a => webcrypto.getRandomValues(a);
const fakeGlobal = () => ({crypto: {getRandomValues}});

function completeSubtle(marker) {
  const names = [
    'decrypt', 'deriveBits', 'digest', 'encrypt', 'exportKey', 'generateKey',
    'importKey', 'sign', 'unwrapKey', 'verify', 'wrapKey'
  ];
  const subtle = {marker};
  for(const name of names) {
    subtle[name] = async () => marker;
  }
  return subtle;
}

test('loadNativeCrypto returns undefined with no loader', () => {
  // the default path in a bundle that never provided `require`
  assert.equal(loadNativeCrypto(), undefined);
});

test('loadNativeCrypto returns undefined when the module is absent', () => {
  const load = () => {
    throw new Error('Cannot find module react-native-quick-crypto');
  };
  assert.equal(loadNativeCrypto({require: load}), undefined);
});

test('loadNativeCrypto unwraps a default export', () => {
  const provider = {subtle: completeSubtle('q')};
  assert.equal(loadNativeCrypto({require: () => ({default: provider})}),
    provider);
});

test('loadNativeCrypto accepts a CommonJS shape', () => {
  const provider = {subtle: completeSubtle('q')};
  assert.equal(loadNativeCrypto({require: () => provider}), provider);
});

test('bootstrapCrypto uses native when available', () => {
  const target = fakeGlobal();
  const result = bootstrapCrypto({
    target,
    require: () => ({subtle: completeSubtle('quick-crypto')})
  });
  assert.equal(result.implementation, 'native');
  assert.equal(target.crypto.subtle.marker, 'quick-crypto');
});

test('bootstrapCrypto falls back to pure JS when native is absent', () => {
  const target = fakeGlobal();
  const result = bootstrapCrypto({
    target,
    require: () => {
      throw new Error('not installed');
    }
  });
  assert.equal(result.implementation, 'pure-js');
  assert.equal(typeof target.crypto.subtle.digest, 'function');
});

test('bootstrapCrypto works with no loader at all (Expo Go path)', async () => {
  const target = fakeGlobal();
  const result = bootstrapCrypto({target});
  assert.equal(result.implementation, 'pure-js');
  // and the fallback must actually work
  const digest = await target.crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode('abc'));
  assert.equal(
    Buffer.from(digest).toString('hex'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('an explicit native provider overrides auto-detection', () => {
  const target = fakeGlobal();
  const result = bootstrapCrypto({
    target,
    native: {subtle: completeSubtle('explicit')},
    require: () => ({subtle: completeSubtle('detected')})
  });
  assert.equal(target.crypto.subtle.marker, 'explicit');
  assert.equal(result.implementation, 'native');
});

test('onResult reports which implementation is active', () => {
  const seen = [];
  bootstrapCrypto({target: fakeGlobal(), onResult: r => seen.push(r)});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].implementation, 'pure-js');
  assert.ok(seen[0].reason, 'a human-readable reason is provided');
});

test('bootstrap installs companion globals in both modes', () => {
  for(const [label, opts] of [
    ['native', {native: {subtle: completeSubtle('n')}}],
    ['pure-js', {}]
  ]) {
    const target = fakeGlobal();
    bootstrapCrypto({target, ...opts});
    assert.equal(target.self, target, `${label}: self aliased`);
    assert.equal(
      typeof target.CryptoKey, 'function', `${label}: CryptoKey defined`);
  }
});
