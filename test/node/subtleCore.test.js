/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Known-answer tests for the pure-JS `subtle` core.
 *
 * Every vector here comes from a published standard so that "it passes" means
 * "it is correct", not "it agrees with itself":
 *
 * - AES block cipher: FIPS-197 Appendix B / C
 * - AES-KW: RFC 3394 section 4
 * - HMAC-SHA256: RFC 4231 section 4
 * - PBKDF2-SHA256: RFC 7914 section 11 / RFC 6070-style.
 *
 * Where a standard vector is unavailable we cross-check against Node's own
 * `webcrypto`, which is the same API the browser variants target.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {webcrypto} from 'node:crypto';

import * as core from '../../src/shim/subtleCore.js';

const hex = s => Uint8Array.from(
  s.replace(/\s/g, '').match(/../g).map(b => parseInt(b, 16)));
const toHex = b => Buffer.from(b).toString('hex');

const getRandomValues = a => webcrypto.getRandomValues(a);

test('AES block cipher matches FIPS-197 vectors', async t => {
  // FIPS-197 Appendix C.1 (AES-128), C.2 (AES-192), C.3 (AES-256)
  const plaintext = hex('00112233445566778899aabbccddeeff');
  const cases = [
    {
      bits: 128,
      key: hex('000102030405060708090a0b0c0d0e0f'),
      ct: '69c4e0d86a7b0430d8cdb78070b4c55a'
    }, {
      bits: 192,
      key: hex('000102030405060708090a0b0c0d0e0f1011121314151617'),
      ct: 'dda97ca4864cdfe06eaf70a0ec0d7191'
    }, {
      bits: 256,
      key: hex(
        '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'),
      ct: '8ea2b7ca516745bfeafc49904b496089'
    }
  ];
  for(const {bits, key, ct} of cases) {
    await t.test(`AES-${bits}`, () => {
      const encrypted = core._internal._aesEncryptBlock(
        {key, block: plaintext});
      assert.equal(toHex(encrypted), ct, 'encrypt');
      const decrypted = core._internal._aesDecryptBlock(
        {key, block: encrypted});
      assert.equal(toHex(decrypted), toHex(plaintext), 'decrypt round-trip');
    });
  }
});

test('AES-KW matches RFC 3394 vectors', async t => {
  // RFC 3394 sections 4.1 - 4.6
  const cases = [
    {
      name: '4.1 128-bit key, 128-bit KEK',
      kek: '000102030405060708090A0B0C0D0E0F',
      data: '00112233445566778899AABBCCDDEEFF',
      wrapped: '1FA68B0A8112B447AEF34BD8FB5A7B829D3E862371D2CFE5'
    }, {
      name: '4.2 128-bit key, 192-bit KEK',
      kek: '000102030405060708090A0B0C0D0E0F1011121314151617',
      data: '00112233445566778899AABBCCDDEEFF',
      wrapped: '96778B25AE6CA435F92B5B97C050AED2468AB8A17AD84E5D'
    }, {
      name: '4.3 128-bit key, 256-bit KEK',
      kek: '000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F',
      data: '00112233445566778899AABBCCDDEEFF',
      wrapped: '64E8C3F9CE0F5BA263E9777905818A2A93C8191E7D6E8AE7'
    }, {
      name: '4.4 192-bit key, 192-bit KEK',
      kek: '000102030405060708090A0B0C0D0E0F1011121314151617',
      data: '00112233445566778899AABBCCDDEEFF0001020304050607',
      wrapped: '031D33264E15D33268F24EC260743EDC' +
        'E1C6C7DDEE725A936BA814915C6762D2'
    }, {
      name: '4.5 192-bit key, 256-bit KEK',
      kek: '000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F',
      data: '00112233445566778899AABBCCDDEEFF0001020304050607',
      wrapped: 'A8F9BC1612C68B3FF6E6F4FBE30E71E4' +
        '769C8B80A32CB8958CD5D17D6B254DA1'
    }, {
      name: '4.6 256-bit key, 256-bit KEK',
      kek: '000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F',
      data: '00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F',
      wrapped: '28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326' +
        'CBC7F0E71A99F43BFB988B9B7A02DD21'
    }
  ];

  for(const {name, kek, data, wrapped} of cases) {
    await t.test(name, async () => {
      const key = await core.importKey({
        format: 'raw', keyData: hex(kek), algorithm: 'AES-KW',
        extractable: true, usages: ['wrapKey', 'unwrapKey']
      });
      const result = await core.wrapKey({key, keyData: hex(data)});
      assert.equal(toHex(result).toUpperCase(), wrapped, 'wrap');

      const unwrapped = await core.unwrapKey({key, wrappedKey: hex(wrapped)});
      assert.equal(toHex(unwrapped).toUpperCase(), data, 'unwrap');
    });
  }
});

test('AES-KW rejects tampered ciphertext', async () => {
  const key = await core.importKey({
    format: 'raw', keyData: hex('000102030405060708090A0B0C0D0E0F'),
    algorithm: 'AES-KW', extractable: true, usages: ['unwrapKey']
  });
  const wrapped = hex('1FA68B0A8112B447AEF34BD8FB5A7B829D3E862371D2CFE5');
  wrapped[0] ^= 0xff;
  await assert.rejects(
    () => core.unwrapKey({key, wrappedKey: wrapped}),
    /integrity check failed/);
});

test('AES-KW interoperates with Node WebCrypto', async () => {
  // wrap with the shim, unwrap with Node -> proves real-world compatibility
  const raw = webcrypto.getRandomValues(new Uint8Array(32));
  const kekBytes = webcrypto.getRandomValues(new Uint8Array(32));

  const shimKek = await core.importKey({
    format: 'raw', keyData: kekBytes, algorithm: 'AES-KW',
    extractable: true, usages: ['wrapKey']
  });
  const wrapped = await core.wrapKey({key: shimKek, keyData: raw});

  const nodeKek = await webcrypto.subtle.importKey(
    'raw', kekBytes, 'AES-KW', false, ['unwrapKey']);
  const unwrapped = await webcrypto.subtle.unwrapKey(
    'raw', wrapped, nodeKek, 'AES-KW', {name: 'HMAC', hash: 'SHA-256'},
    true, ['sign']);
  const exported = await webcrypto.subtle.exportKey('raw', unwrapped);
  assert.equal(toHex(new Uint8Array(exported)), toHex(raw));
});

test('SHA-256 digest matches known vectors', async () => {
  // NIST: SHA-256("abc")
  const result = await core.digest({
    algorithm: 'SHA-256', data: new TextEncoder().encode('abc')});
  assert.equal(
    toHex(result),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('HMAC-SHA256 matches RFC 4231 vectors', async t => {
  const cases = [
    {
      name: 'case 1',
      key: hex('0b'.repeat(20)),
      data: new TextEncoder().encode('Hi There'),
      mac: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
    }, {
      name: 'case 2',
      key: new TextEncoder().encode('Jefe'),
      data: new TextEncoder().encode('what do ya want for nothing?'),
      mac: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843'
    }
  ];
  for(const {name, key: keyData, data, mac} of cases) {
    await t.test(name, async () => {
      const key = await core.importKey({
        format: 'raw', keyData, algorithm: {name: 'HMAC', hash: 'SHA-256'},
        extractable: true, usages: ['sign', 'verify']
      });
      const signature = await core.sign({key, data});
      assert.equal(toHex(signature), mac, 'sign');
      assert.equal(
        await core.verify({key, signature, data}), true, 'verify');
      const bad = signature.slice();
      bad[0] ^= 0xff;
      assert.equal(
        await core.verify({key, signature: bad, data}), false,
        'reject bad signature');
    });
  }
});

test('PBKDF2-SHA256 matches published vector', async () => {
  // RFC 7914 section 11: PBKDF2-HMAC-SHA256,
  // P="passwd", S="salt", c=1, dkLen=64
  const baseKey = await core.importKey({
    format: 'raw', keyData: new TextEncoder().encode('passwd'),
    algorithm: 'PBKDF2', extractable: false, usages: ['deriveBits']
  });
  const bits = await core.deriveBits({
    algorithm: {
      name: 'PBKDF2', hash: 'SHA-256',
      salt: new TextEncoder().encode('salt'), iterations: 1
    },
    baseKey, length: 64 * 8
  });
  assert.equal(
    toHex(bits),
    '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc' +
    '49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783');
});

test('PBKDF2 agrees with Node WebCrypto at realistic iterations', async () => {
  const password = new TextEncoder().encode('correct horse battery staple');
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;

  const shimKey = await core.importKey({
    format: 'raw', keyData: password, algorithm: 'PBKDF2',
    extractable: false, usages: ['deriveBits']
  });
  const shimBits = await core.deriveBits({
    algorithm: {name: 'PBKDF2', hash: 'SHA-256', salt, iterations},
    baseKey: shimKey, length: 256
  });

  const nodeKey = await webcrypto.subtle.importKey(
    'raw', password, 'PBKDF2', false, ['deriveBits']);
  const nodeBits = await webcrypto.subtle.deriveBits(
    {name: 'PBKDF2', hash: 'SHA-256', salt, iterations}, nodeKey, 256);

  assert.equal(toHex(shimBits), toHex(new Uint8Array(nodeBits)));
});

test('AES-GCM round-trips and interoperates with Node', async () => {
  const keyBytes = webcrypto.getRandomValues(new Uint8Array(32));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode('a verifiable credential payload');
  const additionalData = new TextEncoder().encode('aad');

  const shimKey = await core.importKey({
    format: 'raw', keyData: keyBytes, algorithm: 'AES-GCM',
    extractable: true, usages: ['encrypt', 'decrypt']
  });
  const ciphertext = await core.encrypt({
    algorithm: {name: 'AES-GCM', iv, additionalData}, key: shimKey, data});

  // decrypt with Node to prove tag/format compatibility
  const nodeKey = await webcrypto.subtle.importKey(
    'raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const plaintext = await webcrypto.subtle.decrypt(
    {name: 'AES-GCM', iv, additionalData}, nodeKey, ciphertext);
  assert.equal(
    new TextDecoder().decode(plaintext),
    'a verifiable credential payload');

  // and round-trip through the shim itself
  const roundTrip = await core.decrypt({
    algorithm: {name: 'AES-GCM', iv, additionalData},
    key: shimKey, data: ciphertext});
  assert.equal(toHex(roundTrip), toHex(data));
});

test('generateKey produces usable HMAC and AES keys', async () => {
  const hmacKey = await core.generateKey({
    algorithm: {name: 'HMAC', hash: 'SHA-256'},
    extractable: true, usages: ['sign'], getRandomValues
  });
  assert.equal(hmacKey.algorithm.name, 'HMAC');
  // default HMAC key length is the SHA-256 block size (512 bits)
  assert.equal(hmacKey.algorithm.length, 512);
  const sig = await core.sign(
    {key: hmacKey, data: new TextEncoder().encode('x')});
  assert.equal(sig.length, 32);

  const aesKey = await core.generateKey({
    algorithm: {name: 'AES-KW', length: 256},
    extractable: true, usages: ['wrapKey'], getRandomValues
  });
  const exported = await core.exportKey({format: 'raw', key: aesKey});
  assert.equal(exported.length, 32);
});

test('non-extractable keys refuse export', async () => {
  const key = await core.importKey({
    format: 'raw', keyData: new Uint8Array(32), algorithm: 'AES-KW',
    extractable: false, usages: ['wrapKey']
  });
  await assert.rejects(
    () => core.exportKey({format: 'raw', key}), /not extractable/);
});

test('key material is not enumerable', async () => {
  const key = await core.importKey({
    format: 'raw', keyData: new Uint8Array(32), algorithm: 'AES-KW',
    extractable: true, usages: ['wrapKey']
  });
  assert.equal(JSON.stringify(key).includes('_material'), false);
  assert.equal(Object.keys(key).includes('_material'), false);
});

test('rejects unsupported algorithms and formats', async () => {
  await assert.rejects(() => core.importKey({
    format: 'jwk', keyData: new Uint8Array(32), algorithm: 'AES-KW'
  }), /Unsupported key format/);
  await assert.rejects(() => core.importKey({
    format: 'raw', keyData: new Uint8Array(32), algorithm: 'RSA-OAEP'
  }), /Unsupported algorithm/);
  await assert.rejects(() => core.importKey({
    format: 'raw', keyData: new Uint8Array(7), algorithm: 'AES-KW'
  }), /Invalid AES key length/);
});

/* --- randomUUID (absent from React Native's Hermes runtime) --- */

test('randomUUID produces canonical RFC 4122 v4 UUIDs', () => {
  const uuid = core.randomUUID({getRandomValues});
  assert.match(
    uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    `not a canonical v4 UUID: ${uuid}`);
});

test('randomUUID sets the version and variant bits correctly', () => {
  // check across many samples, since the bits are masked from random bytes
  for(let i = 0; i < 200; ++i) {
    const uuid = core.randomUUID({getRandomValues});
    assert.equal(uuid[14], '4', `version nibble wrong in ${uuid}`);
    assert.ok(
      '89ab'.includes(uuid[19]), `variant nibble wrong in ${uuid}`);
  }
});

test('randomUUID matches Node WebCrypto for shape', () => {
  const shim = core.randomUUID({getRandomValues});
  const native = webcrypto.randomUUID();
  assert.equal(shim.length, native.length);
  assert.deepEqual(
    shim.split('-').map(s => s.length),
    native.split('-').map(s => s.length));
});

test('randomUUID does not repeat', () => {
  const seen = new Set();
  for(let i = 0; i < 1000; ++i) {
    seen.add(core.randomUUID({getRandomValues}));
  }
  assert.equal(seen.size, 1000, 'UUIDs must be unique');
});

test('randomUUID requires a secure random source', () => {
  assert.throws(
    () => core.randomUUID({}), /"getRandomValues" function is required/);
});
