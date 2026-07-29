/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tests for the text-encoding shims Hermes requires.
 *
 * Every case is checked against Node's real `TextDecoder`/`btoa`/`atob`, so
 * "passes" means "agrees with the platform implementation", not "agrees with
 * itself". A hand-written UTF-8 decoder is exactly the kind of code that looks
 * right and silently mangles multi-byte input.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  atobShim, btoaShim, installTextEncoding, Utf8TextDecoder
} from '../../src/shim/textEncoding.js';

const CASES = [
  '',
  'abc',
  '{"enc":"XC20P"}',
  'hello world',
  // multi-byte: 2, 3, and 4-byte sequences
  'café',
  'naïve façade',
  'Ünïcödé',
  '日本語のテキスト',
  'Ελληνικά',
  'емуляция',
  '🔐 emoji and 🎉 surrogates',
  '👨‍👩‍👧‍👦 zwj sequence',
  'mixed: a→é→日→🔐 done'
];

test('Utf8TextDecoder matches Node TextDecoder', async t => {
  for(const input of CASES) {
    await t.test(JSON.stringify(input).slice(0, 40), () => {
      const bytes = new TextEncoder().encode(input);
      const shim = new Utf8TextDecoder().decode(bytes);
      const native = new TextDecoder().decode(bytes);
      assert.equal(shim, native);
      assert.equal(shim, input, 'round-trips the original string');
    });
  }
});

test('Utf8TextDecoder handles the real failing case', () => {
  // the exact value that broke on device
  const bytes = new TextEncoder().encode('{"enc":"XC20P"}');
  const decoded = new Utf8TextDecoder().decode(bytes);
  assert.deepEqual(JSON.parse(decoded), {enc: 'XC20P'});
});

test('Utf8TextDecoder accepts undefined and ArrayBuffer input', () => {
  assert.equal(new Utf8TextDecoder().decode(), '');
  const bytes = new TextEncoder().encode('buffer input');
  assert.equal(
    new Utf8TextDecoder().decode(bytes.buffer), 'buffer input');
});

test('Utf8TextDecoder strips a BOM unless ignoreBOM is set', () => {
  const withBom = Uint8Array.from([
    0xef, 0xbb, 0xbf, ...new TextEncoder().encode('x')
  ]);
  assert.equal(new Utf8TextDecoder().decode(withBom), 'x');
  assert.equal(
    new Utf8TextDecoder('utf-8', {ignoreBOM: true}).decode(withBom).length, 2,
    'ignoreBOM keeps the BOM character');
});

test('Utf8TextDecoder rejects non-UTF-8 encodings', () => {
  assert.throws(() => new Utf8TextDecoder('utf-16'), /Unsupported encoding/);
  // aliases must be accepted
  assert.doesNotThrow(() => new Utf8TextDecoder('UTF8'));
});

test('Utf8TextDecoder replaces invalid bytes, or throws when fatal', () => {
  const invalid = Uint8Array.from([0xff, 0xfe]);
  assert.equal(
    new Utf8TextDecoder().decode(invalid).includes('�'), true,
    'non-fatal mode substitutes U+FFFD');
  assert.throws(
    () => new Utf8TextDecoder('utf-8', {fatal: true}).decode(invalid),
    /Invalid UTF-8/);
});

test('btoaShim and atobShim match Node', async t => {
  for(const input of ['', 'a', 'ab', 'abc', 'abcd', 'binary\x00\x01\xff']) {
    await t.test(JSON.stringify(input), () => {
      const encoded = btoaShim(input);
      assert.equal(encoded, Buffer.from(input, 'binary').toString('base64'));
      assert.equal(atobShim(encoded), input, 'round-trips');
    });
  }
});

test('atobShim rejects invalid base64', () => {
  assert.throws(() => atobShim('!!!!'), /Invalid base64 character/);
});

test('btoaShim rejects out-of-range characters', () => {
  assert.throws(() => btoaShim('日本'), /char codes must be 0-255/);
});

test('installTextEncoding only fills genuine gaps', () => {
  // Hermes lacks TextDecoder but has TextEncoder
  const hermesLike = {TextEncoder};
  const installed = installTextEncoding({target: hermesLike});
  assert.deepEqual(
    [...installed].sort(), ['TextDecoder', 'atob', 'btoa'],
    `unexpected install set: ${installed.join(',')}`);
  assert.equal(typeof hermesLike.TextDecoder, 'function');

  /* A runtime with real implementations must be left alone. Note the shim
  checks for a *function* -- an earlier version of this test used a string
  sentinel, which the shim correctly replaced. */
  const realDecoder = class {};
  const realBtoa = () => 'real';
  const complete = {
    TextDecoder: realDecoder, btoa: realBtoa, atob: realBtoa
  };
  assert.deepEqual(installTextEncoding({target: complete}), []);
  assert.equal(complete.TextDecoder, realDecoder, 'left untouched');
});
