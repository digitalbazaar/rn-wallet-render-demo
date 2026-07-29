/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Guards the Metro resolution strategy.
 *
 * The reuse plan hinges on the bundler picking each DB package's `browser`
 * variant, because those variants use pure-JS `@noble/*` crypto instead of
 * `node:crypto`. Metro itself cannot be run here, so these tests assert the
 * facts the Metro config depends on:
 *
 * 1. The packages really do declare `browser` mappings (if a version bump drops
 *    one, the config silently starts resolving Node code into the bundle).
 * 2. The mapped browser files exist on disk.
 * 3. Those browser files contain no `node:` imports.
 *
 * This is a canary: it fails loudly on a dependency upgrade that would break
 * RN, instead of surfacing as a runtime crash inside Metro.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url).pathname;

// Read `package.json` straight off disk. `require.resolve` cannot be used
// because these packages restrict their `exports` map and do not expose
// `./package.json` as a subpath.
function loadPackage(name) {
  const dir = path.join(ROOT, 'node_modules', name);
  return {
    dir,
    json: JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  };
}

// Packages installed here that gate the crypto path.
const GATED = ['@digitalbazaar/minimal-cipher'];

test('crypto packages declare browser variants', async t => {
  for(const name of GATED) {
    await t.test(name, () => {
      const {json} = loadPackage(name);
      const hasBrowser = json.browser !== undefined;
      const hasConditionalExports = typeof json.exports === 'object' &&
        JSON.stringify(json.exports).includes('browser');
      assert.equal(
        hasBrowser || hasConditionalExports, true,
        `${name} must declare a "browser" field or conditional export; ` +
        'without one Metro will bundle the Node crypto path');
    });
  }
});

test('mapped browser files exist and avoid node: imports', async t => {
  for(const name of GATED) {
    const {dir, json} = loadPackage(name);
    if(typeof json.browser !== 'object') {
      continue;
    }
    for(const [from, to] of Object.entries(json.browser)) {
      await t.test(`${name}: ${from} -> ${to}`, () => {
        const target = path.join(dir, to);
        let source;
        try {
          source = readFileSync(target, 'utf8');
        } catch {
          assert.fail(`browser variant missing on disk: ${target}`);
        }
        const nodeImport = /from\s+['"]node:|require\(['"]node:/.exec(source);
        assert.equal(
          nodeImport, null,
          `${to} imports "${nodeImport?.[0]}"; browser variants must not ` +
          'depend on node: builtins');
      });
    }
  }
});

test('minimal-cipher browser crypto uses globalThis, not node:crypto', () => {
  const {dir, json} = loadPackage('@digitalbazaar/minimal-cipher');
  const browserCrypto = json.browser['./lib/crypto.js'];
  assert.equal(
    typeof browserCrypto, 'string',
    'minimal-cipher must map ./lib/crypto.js to a browser variant');

  const source = readFileSync(path.join(dir, browserCrypto), 'utf8');
  assert.match(
    source, /globalThis|self\b/,
    'browser crypto variant should read crypto off the global object');
  assert.doesNotMatch(source, /node:crypto/);
});

test('the Node default variant does use node:crypto', () => {
  // Confirms the two variants genuinely differ -- i.e. that resolving to
  // `browser` is load-bearing and not a no-op.
  const {dir} = loadPackage('@digitalbazaar/minimal-cipher');
  const source = readFileSync(path.join(dir, 'lib/crypto.js'), 'utf8');
  assert.match(
    source, /node:crypto|require\('crypto'\)/,
    'the default variant is the Node one, so browser resolution matters');
});

test('metro.config.js lists react-native ahead of browser', () => {
  // Ordering bug here is silent and costly: a package with an RN-specific
  // variant would get its browser variant instead.
  const source = readFileSync(
    new URL('../../metro.config.js', import.meta.url), 'utf8');
  const fields = /resolverMainFields:\s*\[([^\]]+)\]/.exec(source);
  assert.notEqual(fields, null, 'resolverMainFields must be configured');
  const list = fields[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
  assert.equal(list[0], 'react-native');
  assert.equal(list[1], 'browser');
  assert.equal(
    list.indexOf('main'), list.length - 1, '"main" must be the last resort');

  /* Package exports MUST stay disabled. Every DB package that isolates
  crypto/HTTP for the browser uses the legacy top-level `browser` field, not an
  `exports` `browser` condition, so enabling exports makes `exports` win and the
  `browser` field is never consulted. That resolved `@digitalbazaar/http-client`
  to its Node CJS build and broke the bundle on `node:process`. Verified on
  device, not theorized. */
  assert.match(
    source, /unstable_enablePackageExports:\s*false/,
    'package exports must stay disabled or the browser field is bypassed');
});

test('DB packages rely on the browser field, not exports conditions', () => {
  /* This is the assumption the resolver strategy rests on. If a future version
  of these packages moves to `exports` `browser` conditions, package exports can
  (and should) be re-enabled -- this test is what will notice. */
  const fieldOnly = [];
  for(const name of [
    '@digitalbazaar/http-client', '@digitalbazaar/minimal-cipher',
    '@digitalbazaar/ecdsa-multikey'
  ]) {
    let json;
    try {
      json = loadPackage(name).json;
    } catch {
      continue; // not installed here; covered where it is
    }
    const hasField = json.browser !== undefined;
    const hasCondition = json.exports &&
      JSON.stringify(json.exports).includes('browser');
    if(hasField && !hasCondition) {
      fieldOnly.push(name);
    }
  }
  assert.ok(
    fieldOnly.length > 0,
    'expected at least one DB package to be browser-field-only; if none are, ' +
    'revisit unstable_enablePackageExports in the Metro configs');
});
