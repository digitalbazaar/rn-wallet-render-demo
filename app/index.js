/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * App entry point.
 *
 * IMPORTANT: the crypto bootstrap must run before ANY other import that could
 * pull in a `@bedrock/*` or `@digitalbazaar/*` module. Several of those read
 * `globalThis.crypto` at module scope and throw on import if it is missing
 * (`ed25519-multikey/lib/ed25519-browser.js` is the strictest).
 *
 * `import` statements are hoisted and evaluated before any statement in this
 * file, so the bootstrap CANNOT be an `import` here -- it has to run first, and
 * the app has to be pulled in afterwards with a dynamic `require`. That is why
 * this file looks unusual.
 */
/* eslint-disable sort-imports -- The side-effect import below installs
`crypto.getRandomValues` and MUST be evaluated first, or the shim throws for
lack of a secure random source. `sort-imports` would order the named import
ahead of it, which would break the app, so ordering is deliberately not
satisfied here. */
import 'react-native-get-random-values';
import {bootstrapCrypto} from '../src/shim/index.js';
import QuickCrypto from 'react-native-quick-crypto';
/* eslint-enable sort-imports */

/* The native provider is imported STATICALLY and passed in explicitly.

An earlier version called `loadNativeCrypto({require})` here instead, which does
not work: Metro only bundles modules named by a statically-analyzable
specifier, so a runtime `require(<variable>)` throws `Requiring unknown module`
and the shim silently fell back to pure JS -- the failure this harness
caught. The
optionality that runtime-require was meant to provide belongs at the app level
(depend on the module or don't), not behind a dynamic lookup. */
globalThis.__expectNativeCrypto = QuickCrypto !== undefined;

// Run the bootstrap before the app (and therefore the DB stack) is loaded.
const result = bootstrapCrypto({
  native: QuickCrypto,
  onResult: ({implementation, reason, missing}) => {
    // Implementation identity is safe to log. Key material never is.
    console.log(`[crypto] ${implementation}: ${reason}`);
    if(missing?.length) {
      console.warn(
        `[crypto] native provider incomplete, missing: ${missing.join(', ')}`);
    }
  }
});

if(result.implementation !== 'native') {
  console.warn(
    '[crypto] running on the pure-JS fallback: AES is not constant-time and ' +
    'PBKDF2 is ~10x slower. Expected in Expo Go; NOT expected in a dev build.');
}

/* Record which implementation won so the verification screen can report it.
The screen cannot re-run `bootstrapCrypto()` to find out -- a second call is a
no-op that would hide what actually got installed. Contains no key material. */
globalThis.__cryptoBootstrapResult = result;

// Only now load the app, which transitively loads the DB stack.
require('./src/App.js');
