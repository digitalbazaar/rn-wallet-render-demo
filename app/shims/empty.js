/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Empty stub for Node-only modules that must not reach a React Native bundle.
 *
 * `@digitalbazaar/http-client` depends on `undici`, which pulls in
 * `node:diagnostics_channel` through a lazy require. React Native provides
 * `fetch` natively, so `undici` is never needed at runtime here — but Metro
 * still bundles the dependency edge, and the lazy require then fails at startup
 * with `Cannot find module 'node:diagnostics_channel'`.
 *
 * Anything that actually *calls* into this stub is a bug worth surfacing rather
 * than silently no-op'ing, so the export is a proxy that throws on use.
 */
const message = 'A Node-only module was called in the React Native bundle. ' +
  'This should be unreachable: RN provides fetch natively. If you see this, ' +
  'a code path is genuinely trying to use undici/node builtins.';

export default new Proxy({}, {
  get(target, prop) {
    if(prop === '__esModule') {
      return true;
    }
    throw new Error(`${message} (accessed "${String(prop)}")`);
  }
});
