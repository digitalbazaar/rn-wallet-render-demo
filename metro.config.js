/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Metro configuration that makes the DB dependency tree resolve to its
 * `browser` variants.
 *
 * This is the single piece of config the whole reuse strategy depends on. 21+
 * DB packages isolate crypto behind a `browser` conditional export whose
 * variant uses pure-JS `@noble/*` instead of `node:crypto`. Resolving to those
 * variants is what makes the tree portable; the crypto shim then supplies the
 * two globals they expect (`crypto.getRandomValues`, `crypto.subtle`).
 *
 * Two resolution mechanisms are needed because DB packages use both styles:
 *
 * 1. `resolverMainFields` handles the legacy top-level `"browser"` field
 *    (an object map or a string), used by e.g. `@digitalbazaar/minimal-cipher`
 *    and `@bedrock/web-wallet`.
 * 2. `unstable_conditionNames` handles `"exports"` conditional maps, used by
 *    packages that have migrated to the `exports` field.
 *
 * `react-native` is listed before `browser` so that a package shipping an
 * RN-specific variant wins over its browser one.
 */
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const defaultConfig = getDefaultConfig(__dirname);

/** @type {import('metro-config').MetroConfig} */
const config = {
  resolver: {
    // Order matters: first match wins.
    resolverMainFields: ['react-native', 'browser', 'module', 'main'],
    /* Package exports MUST stay disabled. Every DB package that isolates
    crypto/HTTP for the browser uses the legacy top-level `browser` *field*, not
    an `exports` `browser` condition. Enabling exports lets `exports` win and
    the `browser` field is skipped, which resolved `@digitalbazaar/http-client`
    to its Node CJS build and broke the bundle on `node:process`. See the
    `app/metro.config.js` for the full finding. */
    unstable_enablePackageExports: false,
    // Several DB packages are ESM-only and ship `.mjs`.
    sourceExts: [...defaultConfig.resolver.sourceExts, 'mjs', 'cjs']
  }
};

module.exports = mergeConfig(defaultConfig, config);
