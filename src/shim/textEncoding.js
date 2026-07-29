/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * UTF-8 text encoding globals that React Native's Hermes runtime does not
 * provide.
 *
 * Hermes ships `TextEncoder` but **not `TextDecoder`**, and provides neither
 * `btoa` nor `atob`. That asymmetry is easy to get wrong: code that encodes
 * successfully then fails on the decode side, far from the cause.
 *
 * This was found the hard way. `minimal-cipher`'s `DecryptTransformer` calls
 * `JSON.parse(new TextDecoder().decode(base64url.decode(jwe.protected)))` in
 * a `try` whose `catch` discards the original error and rethrows
 * `Invalid JWE "protected" header.` The real error was
 * `ReferenceError: Property 'TextDecoder' doesn't exist` — invisible until the
 * dependency was temporarily instrumented to preserve it.
 *
 * Pure functions with no host dependencies, so they are unit-testable in Node.
 */

/**
 * Minimal UTF-8 `TextDecoder`.
 *
 * Implements the subset the DB stack uses: `decode(uint8array)` for UTF-8. The
 * `encoding`, `fatal`, and `ignoreBOM` options are accepted for API
 * compatibility; anything other than UTF-8 is rejected rather than silently
 * mis-decoded.
 */
export class Utf8TextDecoder {
  constructor(label = 'utf-8', options = {}) {
    const normalized = String(label).toLowerCase();
    if(!['utf-8', 'utf8', 'unicode-1-1-utf-8'].includes(normalized)) {
      throw new RangeError(
        `Unsupported encoding "${label}"; only UTF-8 is implemented.`);
    }
    this.encoding = 'utf-8';
    this.fatal = options.fatal === true;
    this.ignoreBOM = options.ignoreBOM === true;
  }

  /**
   * Decodes UTF-8 bytes to a string.
   *
   * @param {Uint8Array|ArrayBuffer} [input] - The bytes to decode.
   *
   * @returns {string} The decoded string.
   */
  decode(input) {
    if(input === undefined) {
      return '';
    }
    const bytes = input instanceof Uint8Array ?
      input :
      new Uint8Array(input.buffer ?? input);

    let out = '';
    let i = 0;
    // strip a leading BOM unless explicitly preserved
    if(!this.ignoreBOM && bytes.length >= 3 &&
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      i = 3;
    }

    while(i < bytes.length) {
      const b1 = bytes[i++];
      let codePoint;

      if(b1 < 0x80) {
        codePoint = b1;
      } else if((b1 & 0xe0) === 0xc0) {
        codePoint = ((b1 & 0x1f) << 6) | (bytes[i++] & 0x3f);
      } else if((b1 & 0xf0) === 0xe0) {
        codePoint = ((b1 & 0x0f) << 12) |
          ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      } else if((b1 & 0xf8) === 0xf0) {
        codePoint = ((b1 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) |
          ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      } else if(this.fatal) {
        throw new TypeError('Invalid UTF-8 sequence.');
      } else {
        // U+FFFD REPLACEMENT CHARACTER, matching non-fatal WHATWG behavior
        codePoint = 0xfffd;
      }

      if(codePoint > 0xffff) {
        // encode as a surrogate pair
        const c = codePoint - 0x10000;
        out += String.fromCharCode(
          0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
      } else {
        out += String.fromCharCode(codePoint);
      }
    }
    return out;
  }
}

const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encodes a binary string to base64 (`btoa` equivalent).
 *
 * @param {string} input - A "binary string": each char code must be 0-255.
 *
 * @returns {string} The base64 encoding.
 */
export function btoaShim(input) {
  const str = String(input);
  let out = '';
  for(let i = 0; i < str.length;) {
    const c1 = str.charCodeAt(i++);
    const c2 = str.charCodeAt(i++);
    const c3 = str.charCodeAt(i++);
    if(c1 > 0xff || c2 > 0xff || c3 > 0xff) {
      throw new Error(
        'Invalid character for btoa; char codes must be 0-255.');
    }
    out += B64.charAt(c1 >> 2);
    out += B64.charAt(((c1 & 3) << 4) | (isNaN(c2) ? 0 : c2 >> 4));
    out += isNaN(c2) ?
      '=' : B64.charAt(((c2 & 15) << 2) | (isNaN(c3) ? 0 : c3 >> 6));
    out += isNaN(c3) ? '=' : B64.charAt(c3 & 63);
  }
  return out;
}

/**
 * Decodes base64 to a binary string (`atob` equivalent).
 *
 * @param {string} input - The base64 to decode.
 *
 * @returns {string} The decoded binary string.
 */
export function atobShim(input) {
  const str = String(input).replace(/[=\s]+$/, '');
  let out = '';
  let buffer = 0;
  let bits = 0;
  for(const ch of str) {
    const idx = B64.indexOf(ch);
    if(idx === -1) {
      throw new Error(`Invalid base64 character "${ch}".`);
    }
    buffer = (buffer << 6) | idx;
    bits += 6;
    if(bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * Installs the missing text-encoding globals.
 *
 * Each is defined only when absent, so a runtime that provides a real
 * implementation always wins.
 *
 * @param {object} [options] - The options.
 * @param {object} [options.target] - The global object to patch.
 *
 * @returns {string[]} The names of the globals that were installed.
 */
export function installTextEncoding({target = globalThis} = {}) {
  const installed = [];

  if(typeof target.TextDecoder !== 'function') {
    Object.defineProperty(target, 'TextDecoder', {
      value: Utf8TextDecoder, configurable: true, writable: true
    });
    installed.push('TextDecoder');
  }
  if(typeof target.btoa !== 'function') {
    Object.defineProperty(target, 'btoa', {
      value: btoaShim, configurable: true, writable: true
    });
    installed.push('btoa');
  }
  if(typeof target.atob !== 'function') {
    Object.defineProperty(target, 'atob', {
      value: atobShim, configurable: true, writable: true
    });
    installed.push('atob');
  }
  return installed;
}
