/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Imperative shell for the crypto shim: takes the pure functions in
 * `subtleCore.js` and installs them onto `globalThis` in the shape the DB
 * `browser` crypto variants expect.
 *
 * MUST be imported before any `@bedrock/*` or `@digitalbazaar/*` module,
 * because several of them read `globalThis.crypto` at module scope (see
 * `ed25519-multikey/lib/ed25519-browser.js`, which throws on import if
 * `crypto.getRandomValues` is missing).
 *
 * Usage, as the very first import in the RN entry point:.
 *
 * ```js
 * import './shim/install.js';
 * ```
 */
import * as core from './subtleCore.js';

/**
 * Resolve a `getRandomValues` implementation.
 *
 * Order of preference:
 * 1. A host-provided `crypto.getRandomValues` (Expo / RN 0.76+ provide one).
 * 2. `react-native-get-random-values`, if the app installed it.
 *
 * There is deliberately no `Math.random` fallback: silently substituting a
 * non-CSPRNG would produce guessable key material, which is worse than a hard
 * failure at startup.
 *
 * @param {object} [options] - The options.
 * @param {object} [options.target] - The global object to inspect.
 *
 * @returns {Function} A `getRandomValues(typedArray)` function.
 */
export function resolveGetRandomValues({target = globalThis} = {}) {
  const existing = target.crypto?.getRandomValues;
  if(typeof existing === 'function') {
    return existing.bind(target.crypto);
  }
  throw new Error(
    'No secure random source available. Install ' +
    '"react-native-get-random-values" and import it before this shim, or run ' +
    'on a runtime that provides "crypto.getRandomValues".');
}

/**
 * Build a `SubtleCrypto`-shaped object backed by the pure core.
 *
 * The WebCrypto API takes positional arguments and returns `ArrayBuffer`,
 * while the core uses named arguments and returns `Uint8Array`. This adapter
 * bridges both differences so callers written against WebCrypto work
 * unmodified.
 *
 * @param {object} options - The options.
 * @param {Function} options.getRandomValues - Secure random source.
 *
 * @returns {object} A partial `SubtleCrypto` implementation.
 */
export function createSubtle({getRandomValues}) {
  // WebCrypto callers expect ArrayBuffer, not Uint8Array. Returning the view's
  // buffer directly would leak trailing bytes when the view is a subarray, so
  // slice to the exact range.
  const buf = bytes => bytes.buffer.byteLength === bytes.byteLength ?
    bytes.buffer :
    bytes.slice().buffer;

  return {
    async digest(algorithm, data) {
      return buf(await core.digest({algorithm, data}));
    },
    async importKey(format, keyData, algorithm, extractable, usages) {
      return core.importKey(
        {format, keyData, algorithm, extractable, usages});
    },
    async exportKey(format, key) {
      return buf(await core.exportKey({format, key}));
    },
    async generateKey(algorithm, extractable, usages) {
      return core.generateKey(
        {algorithm, extractable, usages, getRandomValues});
    },
    async deriveBits(algorithm, baseKey, length) {
      return buf(await core.deriveBits({algorithm, baseKey, length}));
    },
    async sign(algorithm, key, data) {
      return buf(await core.sign({algorithm, key, data}));
    },
    async verify(algorithm, key, signature, data) {
      return core.verify({algorithm, key, signature, data});
    },
    async encrypt(algorithm, key, data) {
      return buf(await core.encrypt({algorithm, key, data}));
    },
    async decrypt(algorithm, key, data) {
      return buf(await core.decrypt({algorithm, key, data}));
    },
    // `wrapAlgorithm` is the 4th positional argument per the WebCrypto spec.
    // Only AES-KW is supported, so it carries no information here, but it is
    // accepted and validated so this signature matches a native implementation
    // -- Node's `subtle.wrapKey` throws if it is omitted.
    async wrapKey(format, key, wrappingKey, wrapAlgorithm) {
      if(format !== 'raw') {
        throw new Error(`Unsupported format "${format}"; only "raw".`);
      }
      if(wrapAlgorithm !== undefined) {
        const name = (typeof wrapAlgorithm === 'string' ?
          wrapAlgorithm : wrapAlgorithm?.name ?? '').toUpperCase();
        if(name !== 'AES-KW') {
          throw new Error(`Unsupported wrap algorithm "${name}"; only AES-KW.`);
        }
      }
      const keyData = await core.exportKey({format: 'raw', key});
      return buf(await core.wrapKey({key: wrappingKey, keyData}));
    },
    async unwrapKey(
      format, wrappedKey, unwrappingKey, unwrapAlgorithm,
      unwrappedKeyAlgorithm, extractable, usages) {
      if(format !== 'raw') {
        throw new Error(`Unsupported format "${format}"; only "raw".`);
      }
      const keyData = await core.unwrapKey(
        {key: unwrappingKey, wrappedKey});
      return core.importKey({
        format: 'raw', keyData, algorithm: unwrappedKeyAlgorithm,
        extractable, usages
      });
    }
  };
}

/* The `subtle` operations this wallet actually depends on. A native provider
must implement all of them, or falling back to the pure-JS core is safer than
using a partial implementation that throws mid-unlock. Derived from reading the
call sites in `web-pouch-edv` and `minimal-cipher`. */
const REQUIRED_SUBTLE_METHODS = Object.freeze([
  'decrypt', 'deriveBits', 'digest', 'encrypt', 'exportKey', 'generateKey',
  'importKey', 'sign', 'unwrapKey', 'verify', 'wrapKey'
]);

/**
 * Checks whether a candidate `SubtleCrypto` implements everything needed.
 *
 * @param {object} [subtle] - The candidate implementation.
 *
 * @returns {object} `{complete, missing}` where `missing` lists absent methods.
 */
export function checkSubtleCompleteness(subtle) {
  if(!subtle) {
    return {complete: false, missing: [...REQUIRED_SUBTLE_METHODS]};
  }
  const missing = REQUIRED_SUBTLE_METHODS.filter(
    name => typeof subtle[name] !== 'function');
  return {complete: missing.length === 0, missing};
}

/**
 * Install crypto globals, preferring a native implementation.
 *
 * Resolution order:
 *
 * 1. An explicitly supplied `native` provider (pass
 *    `require('react-native-quick-crypto')` here). Preferred: its AES is
 *    constant-time, unlike the table-driven pure-JS fallback, and its PBKDF2
 *    is roughly an order of magnitude faster.
 * 2. A `crypto.subtle` the host already provides.
 * 3. The pure-JS core in `subtleCore.js`.
 *
 * A native provider that is missing any required method is **rejected rather
 * than partially used** — a half-implemented `subtle` would fail deep inside an
 * unlock, which is far harder to diagnose than falling back cleanly. The
 * returned `reason` and `missing` say what happened, so the app can log or
 * surface it.
 *
 * @param {object} [options] - The options.
 * @param {object} [options.target] - The global object to patch.
 * @param {boolean} [options.force] - Replace an existing `subtle`.
 * @param {object} [options.native] - A native crypto provider to prefer, such
 *   as the `react-native-quick-crypto` module. Either its `.subtle` or the
 *   module itself is accepted.
 *
 * @returns {object} `{installed, implementation, reason, missing}` describing
 *   which implementation is now active.
 */
export function installCryptoShim({
  target = globalThis, force = false, native
} = {}) {
  const getRandomValues = resolveGetRandomValues({target});

  // 1. explicitly supplied native provider wins
  if(native) {
    const candidate = native.subtle ?? native;
    const {complete, missing} = checkSubtleCompleteness(candidate);
    if(complete) {
      _defineCrypto({target, getRandomValues, subtle: candidate});
      _defineCompanions({target});
      return {
        installed: true, implementation: 'native',
        reason: 'native crypto.subtle installed'
      };
    }
    // fall through to the pure-JS core, but report why
    const subtle = createSubtle({getRandomValues});
    _defineCrypto({target, getRandomValues, subtle});
    _defineCompanions({target});
    return {
      installed: true, implementation: 'pure-js', missing,
      reason: 'native provider incomplete; using pure-JS fallback'
    };
  }

  // 2. host-provided implementation
  if(target.crypto?.subtle && !force) {
    return {
      installed: false, implementation: 'host',
      reason: 'native crypto.subtle already present'
    };
  }

  // 3. pure-JS core
  const subtle = createSubtle({getRandomValues});

  _defineCrypto({target, getRandomValues, subtle});
  _defineCompanions({target});

  return {
    installed: true, implementation: 'pure-js',
    reason: 'pure-JS shim installed'
  };
}

// installs `crypto.getRandomValues`, `crypto.subtle`, `crypto.randomUUID`
function _defineCrypto({target, getRandomValues, subtle}) {
  /* `randomUUID` is part of the WebCrypto surface on browsers and Node but is
  ABSENT from React Native's Hermes runtime. `web-pouch-edv/lib/helpers.js`
  calls `globalThis.crypto.randomUUID()` for EDV and document ids, so without it
  the first `createEdv` fails with a bare "undefined is not a function" --
  found on device, several layers from the apparent symptom. Only defined when
  the host lacks it, so a real implementation always wins. */
  const uuidFn = typeof target.crypto?.randomUUID === 'function' ?
    target.crypto.randomUUID.bind(target.crypto) :
    () => core.randomUUID({getRandomValues});

  // Some RN runtimes expose `crypto` as a frozen or non-extensible host
  // object. In that case neither assignment nor `defineProperty` can add
  // `subtle`, so replace the whole `crypto` object with a writable clone that
  // preserves the host's `getRandomValues`.
  if(!target.crypto || !Object.isExtensible(target.crypto)) {
    Object.defineProperty(target, 'crypto', {
      value: {getRandomValues, subtle, randomUUID: uuidFn},
      configurable: true, writable: true
    });
    return;
  }
  Object.defineProperty(target.crypto, 'subtle', {
    value: subtle, configurable: true, writable: true
  });
  if(typeof target.crypto.randomUUID !== 'function') {
    Object.defineProperty(target.crypto, 'randomUUID', {
      value: uuidFn, configurable: true, writable: true
    });
  }
}

// installs the globals DB browser variants read besides `crypto`
function _defineCompanions({target}) {
  // `data-integrity/lib/sha256digest-browser.js` reads `self.crypto`, not
  // `globalThis.crypto`. React Native does not define `self`, so alias it.
  if(target.self === undefined) {
    Object.defineProperty(target, 'self', {
      value: target, configurable: true, writable: true
    });
  }

  if(typeof target.CryptoKey !== 'function') {
    Object.defineProperty(target, 'CryptoKey', {
      value: core.ShimCryptoKey, configurable: true, writable: true
    });
  }
}
