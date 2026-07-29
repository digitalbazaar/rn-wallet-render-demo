/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Metro configuration for the verification harness app.
 *
 * Two jobs beyond the defaults:
 *
 * 1. **Watch the parent directory.** The shim and check logic live in
 *    `../src/`, outside this app folder, so Metro must be told to watch and
 *    resolve there. Without `watchFolders`, imports of `../../src/...` fail.
 *
 * 2. **Resolve DB packages to their `browser` variants.** This is the same
 *    resolution strategy as the root `metro.config.js` and is what makes the
 *    reuse plan work at all: the `browser` variants use pure-JS `@noble/*`
 *    crypto instead of `node:crypto`. See the root config for the full
 *    rationale.
 */
const {getDefaultConfig} = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

// 1. let Metro see `../src` and the root `node_modules`
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules')
];

// 2. prefer react-native, then browser, variants. Order matters: a package
// shipping an RN-specific build should win over its browser build.
config.resolver.resolverMainFields = [
  'react-native', 'browser', 'module', 'main'
];
/* Package exports are deliberately DISABLED.

Every DB package that isolates crypto or HTTP for the browser does so with the
legacy top-level `browser` *field*, not an `exports` `browser` condition.
Verified across `@digitalbazaar/`: `http-client`, `minimal-cipher`,
`ecdsa-multikey`, `edv-client`, `x25519-key-agreement-key-2020`, and the
`http-signature-*` packages -- all field-only.

With package exports enabled, `exports` takes precedence and the `browser` field
is never consulted. `@digitalbazaar/http-client` declares
`exports: {require, import}` with no `browser` key, so Metro picked its Node CJS
build and the bundle died on `Unable to resolve module node:process`.

Disabling exports makes Metro fall back to `resolverMainFields`, which does
honor `browser` -- the mechanism the reuse strategy depends on. Re-enable only
once these packages publish `browser` conditions inside `exports`. */
config.resolver.unstable_enablePackageExports = false;

// several DB packages are ESM-only and ship .mjs
config.resolver.sourceExts = [
  ...new Set([...config.resolver.sourceExts, 'mjs', 'cjs'])
];

/* 3. Disabling package exports has a second consequence that must be handled
generically: a package declaring `exports` but **no** `main` becomes
unresolvable, because Metro falls back to `main` and finds nothing.

That is common in this tree — `@bedrock/web-pouch-edv`, `base58-universal`,
`@digitalbazaar/lru-memoize`, `crypto-ld`, `pako` and others are all
exports-only. Hand-aliasing each is unsustainable and would silently miss the
next one, so instead read the package's own `exports` and use the entry it
names. That reproduces correct resolution rather than overriding intent.

`@digitalbazaar/http-client` is the one true override: it *does* have a `main`,
pointing at a Node CJS build that requires `undici`/`node:process`. Its
`browser` field maps only `./lib/agentCompatibility.js` (no top-level entry),
so neither
`resolverMainFields` nor the `browser` field can steer the entry. Resolving to
its ESM entry lets the `browser` field swap in the no-op `agentCompatibility`
variant, which is what drops the Node dependency.

A `"browser": "./lib/index.js"` (or a `browser` condition in `exports`) upstream
would remove the need for this override. Not filed while this is a prototype. */
const OVERRIDES = new Map([
  [
    '@digitalbazaar/http-client',
    path.resolve(
      workspaceRoot, 'node_modules/@digitalbazaar/http-client/lib/index.js')
  ]
]);

// cache: module name -> resolved entry path, or null when not applicable
const exportsOnlyEntries = new Map();

function resolveExportsOnlyEntry(moduleName) {
  if(exportsOnlyEntries.has(moduleName)) {
    return exportsOnlyEntries.get(moduleName);
  }
  let entry = null;
  try {
    const pkgDir = path.resolve(workspaceRoot, 'node_modules', moduleName);
    const pkg = JSON.parse(
      require('node:fs').readFileSync(
        path.join(pkgDir, 'package.json'), 'utf8'));
    // only step in when `main` is genuinely absent
    if(!pkg.main && !pkg['react-native'] && pkg.exports) {
      const {exports: exp} = pkg;
      let target = typeof exp === 'string' ?
        exp :
        // prefer the conditions a bundler should honor, in that order
        exp['react-native'] ?? exp.browser ?? exp.import ??
          exp.default ?? exp['.']?.import ?? exp['.']?.default ?? exp['.'];

      /* CRITICAL: the chosen entry must still pass through the package's own
      `browser` map. Resolving the entry here bypasses Metro's `browser`
      handling, so a package whose `browser` field REPLACES its entry would
      silently get the Node build.

      `base64url-universal` is exactly that shape: exports-only
      (`"exports": "./lib/index.js"`) *and* `browser: {"./lib/index.js":
      "./lib/browser.js"}`. Skipping the map bundled the Node version, which
      uses `Buffer` -- absent in Hermes -- and failed at runtime with
      `Property 'Buffer' doesn't exist`, deep inside document encryption. */
      if(typeof target === 'string' && pkg.browser &&
        typeof pkg.browser === 'object') {
        const normalized = target.startsWith('./') ? target : `./${target}`;
        const swapped = pkg.browser[normalized];
        if(typeof swapped === 'string') {
          target = swapped;
        }
      }

      if(typeof target === 'string') {
        entry = path.resolve(pkgDir, target);
      }
    }
  } catch {
    // not a resolvable package directory; let Metro handle it
  }
  exportsOnlyEntries.set(moduleName, entry);
  return entry;
}

/* 4. Stub Node-only modules that must not reach the bundle.

`@digitalbazaar/http-client` depends on `undici`, which lazily requires
`node:diagnostics_channel`. Metro resolves that lazily rather than failing the
build, so it surfaced as a *runtime* crash at app start
(`Cannot find module 'node:diagnostics_channel'`) even though the bundle built
fine. React Native provides `fetch` natively, so `undici` is dead weight here.

The stub throws if anything actually calls into it, so a real dependency on Node
internals fails loudly instead of silently no-op'ing. */
const EMPTY_STUB = path.resolve(projectRoot, 'shims/empty.js');
const STUBBED = new Set([
  'undici',
  'node:diagnostics_channel',
  'node:process',
  'node:http',
  'node:https',
  'node:zlib',
  'node:stream',
  'node:net',
  'node:tls',
  'node:worker_threads',
  'node:perf_hooks',
  'node:async_hooks'
]);

/* Deliberately NOT stubbed: `node:util`, `node:crypto`, `node:buffer`.

Stubbing those hides real resolution bugs. A DB package reaching for
`node:crypto` or `node:util` means its `browser` variant was not applied, and
the fix is the `browser`-field handling below -- not a stub. With `node:util`
stubbed,
`edv-client`'s Node `util.js` bundled cleanly and then failed at runtime with
`undefined is not a function` from `promisify`, which was far harder to trace
than an honest "unable to resolve node:util". */

/* 5. Apply each package's own `browser` field to relative imports.

This is the piece that makes the reuse strategy actually work at runtime, and it
is subtle: Metro applies a package's `browser` field only when *it* resolves
the module. Because `resolveRequest` is overridden above for entry points,
resolution
inside those packages then happens through paths Metro no longer maps, so
`browser` swaps were silently skipped.

Concretely: `@digitalbazaar/edv-client` maps `./lib/util.js` ->
`./lib/util-browser.js`. Without this, the Node `util.js` was bundled, which
imports `node:crypto` and `node:util`; combined with the stubs above that
produced a runtime `undefined is not a function` from `promisify` — a confusing
symptom several layers from the cause.

So resolve relative imports here and consult the owning package's `browser` map
directly. */
const browserMapCache = new Map();

function loadBrowserMap(pkgDir) {
  if(browserMapCache.has(pkgDir)) {
    return browserMapCache.get(pkgDir);
  }
  let map = null;
  try {
    const pkg = JSON.parse(
      require('node:fs').readFileSync(
        path.join(pkgDir, 'package.json'), 'utf8'));
    if(pkg.browser && typeof pkg.browser === 'object') {
      map = pkg.browser;
    }
  } catch {
    // no package.json here
  }
  browserMapCache.set(pkgDir, map);
  return map;
}

// walk up from a file to its owning package directory
function findPackageDir(startDir) {
  let dir = startDir;
  for(let i = 0; i < 12; ++i) {
    if(require('node:fs').existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if(parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

function applyBrowserField({originDir, moduleName}) {
  const pkgDir = findPackageDir(originDir);
  if(!pkgDir) {
    return null;
  }
  const map = loadBrowserMap(pkgDir);
  if(!map) {
    return null;
  }
  // normalize the target to a package-relative "./lib/x.js" key
  const absolute = path.resolve(originDir, moduleName);
  const relative = './' + path.relative(pkgDir, absolute).split(path.sep)
    .join('/');
  const replacement = map[relative];
  if(typeof replacement === 'string') {
    return path.resolve(pkgDir, replacement);
  }
  return null;
}

const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if(STUBBED.has(moduleName)) {
    return {type: 'sourceFile', filePath: EMPTY_STUB};
  }
  const override = OVERRIDES.get(moduleName);
  if(override) {
    return {type: 'sourceFile', filePath: override};
  }
  // relative import inside a package: honor that package's `browser` map
  if(moduleName.startsWith('.') && context.originModulePath) {
    const mapped = applyBrowserField({
      originDir: path.dirname(context.originModulePath),
      moduleName
    });
    if(mapped) {
      return {type: 'sourceFile', filePath: mapped};
    }
  }
  // bare package specifiers only -- never relative or absolute paths
  if(!moduleName.startsWith('.') && !path.isAbsolute(moduleName)) {
    const entry = resolveExportsOnlyEntry(moduleName);
    if(entry) {
      return {type: 'sourceFile', filePath: entry};
    }
  }
  return originalResolveRequest ?
    originalResolveRequest(context, moduleName, platform) :
    context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
