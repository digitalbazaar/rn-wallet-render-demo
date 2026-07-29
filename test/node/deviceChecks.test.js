/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tests for the on-device verification checks.
 *
 * The checks run on a phone, but their logic must be trustworthy
 * before then: a harness that reports "pass" incorrectly is worse than no
 * harness. So each check is exercised here against both a good and a
 * deliberately broken implementation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {webcrypto} from 'node:crypto';

import {
  checkAesKwInterop, checkImplementation, checkPbkdf2Agreement,
  checkPbkdf2Latency, runDeviceChecks
} from '../../src/verify/deviceChecks.js';
import {createSubtle} from '../../src/shim/install.js';

const getRandomValues = a => webcrypto.getRandomValues(a);
const pureJs = createSubtle({getRandomValues});
// Node's WebCrypto stands in for the native implementation: it is a genuinely
// different, constant-time implementation, which is exactly the comparison the
// on-device run makes against react-native-quick-crypto.
const nativeish = webcrypto.subtle;

test('checkImplementation passes when native is present and expected', () => {
  const r = checkImplementation({
    result: {implementation: 'native', reason: 'installed'},
    expectNative: true
  });
  assert.equal(r.pass, true);
  assert.equal(r.implementation, 'native');
});

test('checkImplementation FAILS when native expected but absent', () => {
  const r = checkImplementation({
    result: {
      implementation: 'pure-js', reason: 'native provider incomplete',
      missing: ['wrapKey']
    },
    expectNative: true
  });
  assert.equal(r.pass, false);
  assert.match(r.detail, /expected native/);
  assert.match(r.detail, /wrapKey/, 'names the missing method');
});

test('checkImplementation tolerates pure-JS when not expecting native', () => {
  const r = checkImplementation({
    result: {implementation: 'pure-js', reason: 'fallback'},
    expectNative: false
  });
  assert.equal(r.pass, true);
});

test('AES-KW interop passes between shim and Node WebCrypto', async () => {
  // the real interop question, using two genuinely different implementations
  const r = await checkAesKwInterop(
    {a: pureJs, b: nativeish, getRandomValues});
  assert.equal(r.pass, true, r.detail);
});

test('AES-KW interop FAILS against a corrupted implementation', async () => {
  // proves the check can actually detect incompatibility
  const broken = {
    ...pureJs,
    async wrapKey(...args) {
      const wrapped = await pureJs.wrapKey(...args);
      const bytes = new Uint8Array(wrapped);
      bytes[0] ^= 0xff;
      return bytes.buffer;
    }
  };
  const r = await checkAesKwInterop(
    {a: broken, b: nativeish, getRandomValues});
  assert.equal(r.pass, false, 'corruption must be detected');
});

test('AES-KW interop detects a one-directional failure', async () => {
  // an implementation that wraps fine but cannot unwrap must still fail,
  // which a single-direction check would miss
  const wrapOnly = {
    ...pureJs,
    async unwrapKey() {
      throw new Error('unwrap not supported');
    }
  };
  const r = await checkAesKwInterop(
    {a: nativeish, b: wrapOnly, getRandomValues});
  assert.equal(r.pass, false);
  assert.match(r.detail, /unwrap not supported/);
});

test('PBKDF2 agreement passes between shim and Node WebCrypto', async () => {
  const r = await checkPbkdf2Agreement({a: pureJs, b: nativeish});
  assert.equal(r.pass, true, r.detail);
});

test('PBKDF2 agreement FAILS on differing output', async () => {
  const wrong = {
    ...pureJs,
    async deriveBits(algorithm, key, length) {
      // simulate a different iteration count being applied
      return pureJs.deriveBits(
        {...algorithm, iterations: algorithm.iterations + 1}, key, length);
    }
  };
  const r = await checkPbkdf2Agreement({a: pureJs, b: wrong});
  assert.equal(r.pass, false);
  assert.match(r.detail, /DIFFER/);
});

test('PBKDF2 latency passes within budget', async () => {
  let t = 0;
  const now = () => (t += 50); // 50ms elapsed
  const r = await checkPbkdf2Latency({
    subtle: pureJs, now, iterations: 100, budgetMs: 1500
  });
  assert.equal(r.pass, true);
  assert.equal(r.elapsedMs, 50);
});

test('PBKDF2 latency FAILS over budget, warns not to cut iters', async () => {
  let t = 0;
  const now = () => (t += 5000);
  const r = await checkPbkdf2Latency({
    subtle: pureJs, now, iterations: 100, budgetMs: 1500
  });
  assert.equal(r.pass, false);
  assert.match(r.detail, /EXCEEDS/);
  assert.match(
    r.detail, /do NOT lower the iteration count/,
    'must steer away from weakening the KDF');
});

test('runDeviceChecks reports all checks and an overall verdict', async () => {
  const r = await runDeviceChecks({
    result: {implementation: 'native', reason: 'installed'},
    active: nativeish, reference: pureJs, expectNative: true,
    getRandomValues, now: () => Date.now()
  });
  assert.equal(r.checks.length, 4);
  assert.equal(r.pass, true, JSON.stringify(r.checks, null, 2));
  assert.equal(r.checks.some(c => c.skipped), false, 'nothing skipped');
});

test('runDeviceChecks skips interop when active IS the reference', async () => {
  // comparing pure-JS against itself proves nothing; it must be reported as
  // skipped rather than as a pass
  const r = await runDeviceChecks({
    result: {implementation: 'pure-js', reason: 'fallback'},
    active: pureJs, reference: pureJs, expectNative: false,
    getRandomValues, now: () => Date.now()
  });
  const skipped = r.checks.filter(c => c.skipped);
  assert.equal(skipped.length, 2);
  for(const c of skipped) {
    assert.match(c.detail, /skipped/);
  }
});

test('runDeviceChecks fails overall when any check fails', async () => {
  const r = await runDeviceChecks({
    result: {implementation: 'pure-js', reason: 'native missing'},
    active: pureJs, reference: pureJs, expectNative: true,
    getRandomValues, now: () => Date.now()
  });
  assert.equal(r.pass, false, 'expectNative unmet must fail the run');
});
