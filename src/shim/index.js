/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Crypto bootstrap for the React Native app.
 *
 * **This must be the first import in the app entry point**, before any
 * `@bedrock/*` or `@digitalbazaar/*` module. Several of those read
 * `globalThis.crypto` at module scope and throw on import if it is absent (see
 * `ed25519-multikey/lib/ed25519-browser.js`).
 *
 * ```js
 * // index.js -- first line, before everything else
 * import {bootstrapCrypto} from './src/shim/index.js';
 * bootstrapCrypto();
 * ```
 *
 * ## Why a native provider is preferred
 *
 * The pure-JS fallback in `subtleCore.js` is correct (verified against
 * FIPS-197, RFC 3394, RFC 4231, RFC 7914) but its AES is table-driven and
 * therefore **not constant-time**, and its PBKDF2 is ~10x slower than native.
 * `react-native-quick-crypto` provides constant-time native primitives and
 * removes both concerns, at the cost of requiring a dev build (no Expo Go).
 */
import {installCryptoShim} from './install.js';
import {installTextEncoding} from './textEncoding.js';

export {
  checkSubtleCompleteness, createSubtle, installCryptoShim,
  resolveGetRandomValues
} from './install.js';
export {installTextEncoding, Utf8TextDecoder} from './textEncoding.js';

/**
 * Normalizes a module into a crypto provider, tolerating a missing one.
 *
 * **Do not rely on this to auto-detect `react-native-quick-crypto` under
 * Metro.** Metro only bundles modules named by a statically-analyzable
 * specifier, so calling `load('react-native-quick-crypto')` with an injected
 * `require` throws `Requiring unknown module` — the module was never bundled.
 * That silently degrades to the pure-JS fallback, which is a much worse outcome
 * than a build error.
 *
 * The app should therefore import `react-native-quick-crypto` statically and
 * pass it as `bootstrapCrypto({native})`. Optionality lives at the app level:
 * depend on the module or don't.
 *
 * This helper remains for unwrapping the module's shape (`export default` vs.
 * CommonJS) and for tests that inject a loader.
 *
 * @param {object} [options] - The options.
 * @param {Function} [options.require] - Module loader, injected for testing.
 *
 * @returns {object|undefined} The provider, or `undefined` if unavailable.
 */
export function loadNativeCrypto({require: load} = {}) {
  if(typeof load !== 'function') {
    return undefined;
  }
  try {
    const mod = load('react-native-quick-crypto');
    // support both `export default` and CommonJS shapes
    return mod?.default ?? mod;
  } catch {
    // not bundled, not installed, or failed to initialize
    return undefined;
  }
}

/**
 * Installs crypto globals, preferring native and falling back to pure JS.
 *
 * @param {object} [options] - The options.
 * @param {object} [options.target] - The global object to patch.
 * @param {object} [options.native] - An explicit native provider. Pass
 *   `require('react-native-quick-crypto')` from the app, which keeps the
 *   dependency optional here.
 * @param {Function} [options.require] - Module loader used to auto-detect the
 *   native provider when `native` is not supplied.
 * @param {Function} [options.onResult] - Called with the install result, for
 *   logging. Must not log key material.
 *
 * @returns {object} The install result: `{installed, implementation, reason}`.
 */
export function bootstrapCrypto({
  target = globalThis, native, require: load, onResult
} = {}) {
  /* Text-encoding globals go first. Hermes ships `TextEncoder` but NOT
  `TextDecoder`, and provides neither `btoa` nor `atob`. `minimal-cipher`'s
  DecryptTransformer uses `TextDecoder` to read the JWE protected header, inside
  a `try` whose `catch` discards the original error -- so the missing global
  surfaced only as `Invalid JWE "protected" header.` on read-back. */
  const encodingsInstalled = installTextEncoding({target});

  const provider = native ?? loadNativeCrypto({require: load});
  const result = {
    ...installCryptoShim({target, native: provider}),
    encodingsInstalled
  };

  if(typeof onResult === 'function') {
    onResult(result);
  }
  return result;
}
