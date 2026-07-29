/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Pure-JS implementation of the `crypto.subtle` surface that
 * `@bedrock/web-pouch-edv` and the DB `browser` crypto variants actually use.
 *
 * This is the "functional core": it has no dependency on React Native, on
 * `globalThis.crypto`, or on any host object. Randomness is injected. That
 * makes every algorithm here testable under plain Node with `node --test`.
 *
 * The verified required surface (from reading call sites) is:
 *
 * - PBKDF2 (`importKey`, `deriveBits`) -- `web-pouch-edv/lib/pbkdf2.js`
 * - AES-KW (`importKey`, `wrapKey`, `unwrapKey`, `exportKey`) --
 *   `web-pouch-edv/lib/Kek.js`
 * - HMAC SHA-256 (`generateKey`, `sign`, `verify`) --
 *   `web-pouch-edv/lib/Hmac.js`
 * - SHA-256 (`digest`) -- `data-integrity/lib/sha256digest-browser.js`.
 *
 * AES-GCM is also provided because `minimal-cipher`'s `a256gcm` algorithm
 * needs it for document encryption.
 *
 * Ed25519 and P-256 are deliberately NOT implemented here: the DB `browser`
 * variants already use pure-JS `@noble/*` for those and need only
 * `getRandomValues`.
 */
import {sha384, sha512} from '@noble/hashes/sha512';

import {gcm} from '@noble/ciphers/aes';
import {hmac} from '@noble/hashes/hmac';
import {pbkdf2Async} from '@noble/hashes/pbkdf2';
import {sha256} from '@noble/hashes/sha256';

// AES-KW per RFC 3394. The default IV ("initial value") is fixed by the spec.
const AES_KW_IV = Uint8Array.from([
  0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6
]);

const HASHES = {
  'SHA-256': sha256,
  'SHA-384': sha384,
  'SHA-512': sha512
};

/**
 * Internal key representation. Mirrors just enough of `CryptoKey` for the
 * call sites: they read `.algorithm`, `.type`, `.extractable`, `.usages`.
 */
export class ShimCryptoKey {
  constructor({type, algorithm, extractable, usages, material}) {
    this.type = type;
    this.algorithm = algorithm;
    this.extractable = extractable;
    this.usages = usages;
    // non-enumerable so key bytes do not show up in logs / JSON dumps
    Object.defineProperty(this, '_material', {
      value: material, enumerable: false, writable: false
    });
  }
}

function _normalizeAlgorithm(algorithm) {
  return typeof algorithm === 'string' ? {name: algorithm} : algorithm;
}

function _algName(algorithm) {
  return _normalizeAlgorithm(algorithm).name.toUpperCase();
}

function _hashName(hash) {
  const name = (typeof hash === 'string' ? hash : hash?.name ?? '')
    .toUpperCase();
  const fn = HASHES[name];
  if(!fn) {
    throw new Error(`Unsupported hash "${name}".`);
  }
  return {name, fn};
}

function _toBytes(data) {
  if(data instanceof Uint8Array) {
    return data;
  }
  if(ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if(data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  throw new TypeError('Expected BufferSource.');
}

/* ------------------------------- digest ------------------------------- */

export async function digest({algorithm, data}) {
  const {fn} = _hashName(_algName(algorithm));
  return fn(_toBytes(data));
}

/* ------------------------------ importKey ----------------------------- */

export async function importKey({
  format, keyData, algorithm, extractable = false, usages = []
}) {
  if(format !== 'raw') {
    throw new Error(`Unsupported key format "${format}"; only "raw".`);
  }
  const alg = _normalizeAlgorithm(algorithm);
  const name = _algName(alg);
  const material = _toBytes(keyData).slice();

  if(name === 'PBKDF2') {
    // PBKDF2 base keys are never extractable per WebCrypto.
    return new ShimCryptoKey({
      type: 'secret', algorithm: {name: 'PBKDF2'},
      extractable: false, usages, material
    });
  }
  if(name === 'HMAC') {
    const {name: hashName} = _hashName(alg.hash);
    return new ShimCryptoKey({
      type: 'secret',
      algorithm: {name: 'HMAC', hash: {name: hashName},
        length: material.length * 8},
      extractable, usages, material
    });
  }
  if(name === 'AES-KW' || name === 'AES-GCM') {
    _assertAesKeyLength(material.length);
    return new ShimCryptoKey({
      type: 'secret',
      algorithm: {name, length: material.length * 8},
      extractable, usages, material
    });
  }
  throw new Error(`Unsupported algorithm "${name}" for importKey.`);
}

function _assertAesKeyLength(byteLength) {
  if(![16, 24, 32].includes(byteLength)) {
    throw new Error(
      `Invalid AES key length "${byteLength}"; expected 16, 24, or 32 bytes.`);
  }
}

/* ------------------------------ exportKey ----------------------------- */

export async function exportKey({format, key}) {
  if(format !== 'raw') {
    throw new Error(`Unsupported key format "${format}"; only "raw".`);
  }
  if(!key.extractable) {
    throw new Error('Key is not extractable.');
  }
  return key._material.slice();
}

/* ----------------------------- generateKey ---------------------------- */

export async function generateKey({
  algorithm, extractable = false, usages = [], getRandomValues
}) {
  const alg = _normalizeAlgorithm(algorithm);
  const name = _algName(alg);

  if(name === 'HMAC') {
    const {name: hashName, fn} = _hashName(alg.hash);
    // default HMAC key length is the hash's block size, per WebCrypto
    const length = alg.length ?? fn.blockLen * 8;
    const material = _random({byteLength: length / 8, getRandomValues});
    return new ShimCryptoKey({
      type: 'secret',
      algorithm: {name: 'HMAC', hash: {name: hashName}, length},
      extractable, usages, material
    });
  }
  if(name === 'AES-KW' || name === 'AES-GCM') {
    const length = alg.length ?? 256;
    _assertAesKeyLength(length / 8);
    const material = _random({byteLength: length / 8, getRandomValues});
    return new ShimCryptoKey({
      type: 'secret', algorithm: {name, length},
      extractable, usages, material
    });
  }
  throw new Error(`Unsupported algorithm "${name}" for generateKey.`);
}

function _random({byteLength, getRandomValues}) {
  if(typeof getRandomValues !== 'function') {
    throw new Error('A "getRandomValues" function is required.');
  }
  const bytes = new Uint8Array(byteLength);
  getRandomValues(bytes);
  return bytes;
}

/* --------------------------- randomUUID ------------------------------- */

const HEX = Array.from(
  {length: 256}, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * Generates an RFC 4122 version 4 UUID.
 *
 * `crypto.randomUUID` is part of the WebCrypto surface on browsers and Node
 * but is **absent from React Native's Hermes runtime**. `web-pouch-edv`'s
 * `helpers.js` calls `globalThis.crypto.randomUUID()` directly for EDV and
 * document ids, so without this the wallet fails at the first `createEdv`
 * with a bare "undefined is not a function".
 *
 * @param {object} options - The options.
 * @param {Function} options.getRandomValues - Secure random source.
 *
 * @returns {string} A v4 UUID in canonical 8-4-4-4-12 form.
 */
export function randomUUID({getRandomValues}) {
  const b = _random({byteLength: 16, getRandomValues});
  // version 4: high nibble of byte 6 is 0100
  b[6] = (b[6] & 0x0f) | 0x40;
  // variant 1 (RFC 4122): top two bits of byte 8 are 10
  b[8] = (b[8] & 0x3f) | 0x80;

  return (
    HEX[b[0]] + HEX[b[1]] + HEX[b[2]] + HEX[b[3]] + '-' +
    HEX[b[4]] + HEX[b[5]] + '-' +
    HEX[b[6]] + HEX[b[7]] + '-' +
    HEX[b[8]] + HEX[b[9]] + '-' +
    HEX[b[10]] + HEX[b[11]] + HEX[b[12]] + HEX[b[13]] + HEX[b[14]] +
    HEX[b[15]]
  );
}

/* ----------------------------- deriveBits ----------------------------- */

export async function deriveBits({algorithm, baseKey, length}) {
  const alg = _normalizeAlgorithm(algorithm);
  const name = _algName(alg);
  if(name !== 'PBKDF2') {
    throw new Error(`Unsupported algorithm "${name}" for deriveBits.`);
  }
  if(!Number.isInteger(length) || length <= 0 || length % 8 !== 0) {
    throw new Error('"length" must be a positive multiple of 8.');
  }
  const {fn} = _hashName(alg.hash);
  return pbkdf2Async(fn, baseKey._material, _toBytes(alg.salt), {
    c: alg.iterations,
    dkLen: length / 8
  });
}

/* -------------------------- sign / verify ----------------------------- */

export async function sign({algorithm, key, data}) {
  const name = _algName(algorithm ?? key.algorithm);
  if(name !== 'HMAC') {
    throw new Error(`Unsupported algorithm "${name}" for sign.`);
  }
  const {fn} = _hashName(key.algorithm.hash);
  return hmac(fn, key._material, _toBytes(data));
}

export async function verify({algorithm, key, signature, data}) {
  const expected = await sign({algorithm, key, data});
  const actual = _toBytes(signature);
  if(actual.length !== expected.length) {
    return false;
  }
  // constant-time comparison
  let diff = 0;
  for(let i = 0; i < expected.length; ++i) {
    diff |= expected[i] ^ actual[i];
  }
  return diff === 0;
}

/* --------------------------- encrypt/decrypt -------------------------- */

export async function encrypt({algorithm, key, data}) {
  const alg = _normalizeAlgorithm(algorithm);
  const name = _algName(alg);
  if(name !== 'AES-GCM') {
    throw new Error(`Unsupported algorithm "${name}" for encrypt.`);
  }
  const cipher = gcm(
    key._material, _toBytes(alg.iv),
    alg.additionalData ? _toBytes(alg.additionalData) : undefined);
  return cipher.encrypt(_toBytes(data));
}

export async function decrypt({algorithm, key, data}) {
  const alg = _normalizeAlgorithm(algorithm);
  const name = _algName(alg);
  if(name !== 'AES-GCM') {
    throw new Error(`Unsupported algorithm "${name}" for decrypt.`);
  }
  const cipher = gcm(
    key._material, _toBytes(alg.iv),
    alg.additionalData ? _toBytes(alg.additionalData) : undefined);
  return cipher.decrypt(_toBytes(data));
}

/* -------------------------- AES-KW wrap/unwrap ------------------------ */

/**
 * AES Key Wrap (RFC 3394). Implemented directly because no `@noble` package
 * ships it and it is required by `web-pouch-edv/lib/Kek.js`.
 *
 * @param {object} options - The options.
 * @param {object} options.key - The wrapping key (KEK).
 * @param {Uint8Array} options.keyData - The raw key bytes to wrap.
 *
 * @returns {Promise<Uint8Array>} The wrapped key, 8 bytes longer than input.
 */
export async function wrapKey({key, keyData}) {
  const plaintext = _toBytes(keyData);
  if(plaintext.length % 8 !== 0 || plaintext.length < 16) {
    throw new Error(
      'AES-KW input must be a multiple of 8 bytes and at least 16 bytes.');
  }
  const n = plaintext.length / 8;
  const a = AES_KW_IV.slice();
  // R = array of n 8-byte blocks
  const r = [];
  for(let i = 0; i < n; ++i) {
    r.push(plaintext.slice(i * 8, i * 8 + 8));
  }

  const block = new Uint8Array(16);
  for(let j = 0; j < 6; ++j) {
    for(let i = 0; i < n; ++i) {
      block.set(a, 0);
      block.set(r[i], 8);
      const b = _aesEncryptBlock({key: key._material, block});
      a.set(b.subarray(0, 8));
      // A = MSB(64, B) XOR t where t = (n * j) + i + 1
      const t = n * j + i + 1;
      _xorCounter({a, t});
      r[i] = b.slice(8, 16);
    }
  }

  const out = new Uint8Array((n + 1) * 8);
  out.set(a, 0);
  for(let i = 0; i < n; ++i) {
    out.set(r[i], (i + 1) * 8);
  }
  return out;
}

/**
 * AES Key Unwrap (RFC 3394).
 *
 * @param {object} options - The options.
 * @param {object} options.key - The unwrapping key (KEK).
 * @param {Uint8Array} options.wrappedKey - The wrapped key bytes.
 *
 * @returns {Promise<Uint8Array>} The unwrapped raw key bytes.
 */
export async function unwrapKey({key, wrappedKey}) {
  const ciphertext = _toBytes(wrappedKey);
  if(ciphertext.length % 8 !== 0 || ciphertext.length < 24) {
    throw new Error(
      'AES-KW input must be a multiple of 8 bytes and at least 24 bytes.');
  }
  const n = ciphertext.length / 8 - 1;
  const a = ciphertext.slice(0, 8);
  const r = [];
  for(let i = 0; i < n; ++i) {
    r.push(ciphertext.slice((i + 1) * 8, (i + 2) * 8));
  }

  const block = new Uint8Array(16);
  for(let j = 5; j >= 0; --j) {
    for(let i = n - 1; i >= 0; --i) {
      const t = n * j + i + 1;
      _xorCounter({a, t});
      block.set(a, 0);
      block.set(r[i], 8);
      const b = _aesDecryptBlock({key: key._material, block});
      a.set(b.subarray(0, 8));
      r[i] = b.slice(8, 16);
    }
  }

  // integrity check against the fixed IV; must be constant-time
  let diff = 0;
  for(let i = 0; i < 8; ++i) {
    diff |= a[i] ^ AES_KW_IV[i];
  }
  if(diff !== 0) {
    throw new Error('Key unwrapping failed; integrity check failed.');
  }

  const out = new Uint8Array(n * 8);
  for(let i = 0; i < n; ++i) {
    out.set(r[i], i * 8);
  }
  return out;
}

// A = A XOR t, where t is a 64-bit big-endian counter occupying the low bytes
function _xorCounter({a, t}) {
  // t never exceeds 6 * n, so 32 bits is ample; XOR from the low end
  let v = t;
  for(let i = 7; i >= 0 && v > 0; --i) {
    a[i] ^= v & 0xff;
    v = Math.floor(v / 256);
  }
}

/* ------------------------- raw AES block cipher ----------------------- */

/*
 * AES-KW needs the bare AES block function (ECB on a single 16-byte block),
 * which `@noble/ciphers` does not expose. `gcm` cannot be reused here because
 * GCM is a stream mode over CTR, not the raw permutation. So the block cipher
 * is implemented directly below. It is only ever used on key material.
 */

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const RCON = new Uint8Array([
  0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36
]);

(function _buildTables() {
  // Multiplicative inverse via log/antilog tables over GF(2^8), generator 3.
  // `p[i] = 3^i` and `log[3^i] = i`, so inv(a) = 3^(255 - log(a)).
  const p = new Uint8Array(256);
  const log = new Uint8Array(256);
  let x = 1;
  for(let i = 0; i < 255; ++i) {
    p[i] = x;
    log[x] = i;
    // x = x * 3 = (x * 2) XOR x, reducing mod the AES polynomial.
    const double = ((x << 1) ^ ((x & 0x80) ? 0x11b : 0)) & 0xff;
    x = double ^ x;
  }
  // The exponent must wrap mod 255: log[1] === 0, so inv(1) needs p[0] === 1,
  // but a bare `255 - log[i]` indexes p[255], which the loop above never fills
  // (it writes p[0..254]). That returned 0, making SBOX[1] collide with
  // SBOX[0] at 0x63 -- so SBOX stopped being a permutation, INV_SBOX[0x63]
  // was overwritten to 1 instead of 0, and every decryption corrupted byte 0.
  const inv = i => (i === 0 ? 0 : p[(255 - log[i]) % 255]);
  for(let i = 0; i < 256; ++i) {
    const c = inv(i);
    // affine transform: s = c XOR rot(c,1) XOR rot(c,2) XOR rot(c,3)
    //   XOR rot(c,4) XOR 0x63
    let s = c ^ 0x63;
    for(let j = 0; j < 4; ++j) {
      s ^= ((c << (1 + j)) | (c >>> (7 - j))) & 0xff;
    }
    SBOX[i] = s & 0xff;
  }
  for(let i = 0; i < 256; ++i) {
    INV_SBOX[SBOX[i]] = i;
  }
  // Guard the invariant that the byte-0 bug violated: SBOX must be a
  // permutation of 0..255, or INV_SBOX is not its inverse.
  for(let i = 0; i < 256; ++i) {
    if(INV_SBOX[SBOX[i]] !== i) {
      throw new Error(
        'AES S-box construction failed; table is not a bijection.');
    }
  }
})();

function _xtime(a) {
  return ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
}

function _mul(a, b) {
  let result = 0;
  let x = a;
  let y = b;
  while(y) {
    if(y & 1) {
      result ^= x;
    }
    x = _xtime(x);
    y >>>= 1;
  }
  return result & 0xff;
}

function _expandKey(key) {
  const nk = key.length / 4;
  const nr = nk + 6;
  const w = new Uint8Array(16 * (nr + 1));
  w.set(key, 0);
  for(let i = nk; i < 4 * (nr + 1); ++i) {
    let t0 = w[(i - 1) * 4];
    let t1 = w[(i - 1) * 4 + 1];
    let t2 = w[(i - 1) * 4 + 2];
    let t3 = w[(i - 1) * 4 + 3];
    if(i % nk === 0) {
      // RotWord + SubWord + Rcon
      const tmp = t0;
      t0 = SBOX[t1] ^ RCON[i / nk];
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[tmp];
    } else if(nk > 6 && i % nk === 4) {
      t0 = SBOX[t0];
      t1 = SBOX[t1];
      t2 = SBOX[t2];
      t3 = SBOX[t3];
    }
    const j = (i - nk) * 4;
    w[i * 4] = w[j] ^ t0;
    w[i * 4 + 1] = w[j + 1] ^ t1;
    w[i * 4 + 2] = w[j + 2] ^ t2;
    w[i * 4 + 3] = w[j + 3] ^ t3;
  }
  return {roundKeys: w, rounds: nr};
}

function _addRoundKey({state, roundKeys, round}) {
  const offset = round * 16;
  for(let i = 0; i < 16; ++i) {
    state[i] ^= roundKeys[offset + i];
  }
}

function _aesEncryptBlock({key, block}) {
  const {roundKeys, rounds} = _expandKey(key);
  const s = block.slice();
  _addRoundKey({state: s, roundKeys, round: 0});
  for(let round = 1; round <= rounds; ++round) {
    for(let i = 0; i < 16; ++i) {
      s[i] = SBOX[s[i]];
    }
    _shiftRows(s);
    if(round !== rounds) {
      _mixColumns(s);
    }
    _addRoundKey({state: s, roundKeys, round});
  }
  return s;
}

function _aesDecryptBlock({key, block}) {
  const {roundKeys, rounds} = _expandKey(key);
  const s = block.slice();
  // Inverse of the encrypt path, walked in reverse round order. Encrypt omits
  // MixColumns on its final round, so this omits InvMixColumns on the matching
  // round (the last iteration, round 0).
  _addRoundKey({state: s, roundKeys, round: rounds});
  for(let round = rounds - 1; round >= 0; --round) {
    _invShiftRows(s);
    for(let i = 0; i < 16; ++i) {
      s[i] = INV_SBOX[s[i]];
    }
    _addRoundKey({state: s, roundKeys, round});
    if(round !== 0) {
      _invMixColumns(s);
    }
  }
  return s;
}

// state is column-major: byte index = col * 4 + row
function _shiftRows(s) {
  for(let row = 1; row < 4; ++row) {
    const tmp = [s[row], s[4 + row], s[8 + row], s[12 + row]];
    for(let col = 0; col < 4; ++col) {
      s[col * 4 + row] = tmp[(col + row) % 4];
    }
  }
}

function _invShiftRows(s) {
  for(let row = 1; row < 4; ++row) {
    const tmp = [s[row], s[4 + row], s[8 + row], s[12 + row]];
    for(let col = 0; col < 4; ++col) {
      s[col * 4 + row] = tmp[(col - row + 4) % 4];
    }
  }
}

function _mixColumns(s) {
  for(let col = 0; col < 4; ++col) {
    const o = col * 4;
    const a0 = s[o];
    const a1 = s[o + 1];
    const a2 = s[o + 2];
    const a3 = s[o + 3];
    s[o] = _mul(a0, 2) ^ _mul(a1, 3) ^ a2 ^ a3;
    s[o + 1] = a0 ^ _mul(a1, 2) ^ _mul(a2, 3) ^ a3;
    s[o + 2] = a0 ^ a1 ^ _mul(a2, 2) ^ _mul(a3, 3);
    s[o + 3] = _mul(a0, 3) ^ a1 ^ a2 ^ _mul(a3, 2);
  }
}

function _invMixColumns(s) {
  for(let col = 0; col < 4; ++col) {
    const o = col * 4;
    const a0 = s[o];
    const a1 = s[o + 1];
    const a2 = s[o + 2];
    const a3 = s[o + 3];
    s[o] = _mul(a0, 14) ^ _mul(a1, 11) ^ _mul(a2, 13) ^ _mul(a3, 9);
    s[o + 1] = _mul(a0, 9) ^ _mul(a1, 14) ^ _mul(a2, 11) ^ _mul(a3, 13);
    s[o + 2] = _mul(a0, 13) ^ _mul(a1, 9) ^ _mul(a2, 14) ^ _mul(a3, 11);
    s[o + 3] = _mul(a0, 11) ^ _mul(a1, 13) ^ _mul(a2, 9) ^ _mul(a3, 14);
  }
}

// exported for testing only
export const _internal = {
  _aesEncryptBlock, _aesDecryptBlock, AES_KW_IV
};
