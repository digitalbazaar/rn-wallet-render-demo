/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tests for the HTML render method core.
 *
 * The core is pure: it turns a credential into a self-contained HTML document
 * string. Nothing here touches React Native, a WebView, or the filesystem, so
 * the interesting logic — render method selection, template decoding,
 * `renderProperty` filtering, and document assembly — is testable directly.
 *
 * The WebView that displays the result is the imperative shell and is not
 * covered here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findHtmlRenderMethod, getLanguagePreference, isRenderAllowed, renderHostPage,
  renderToHtml, setLanguagePreference, setRenderPolicy, supportsHtmlRendering,
  verifyTemplateDigest
} from '../../src/render/htmlRenderMethod.js';
import {
  LIBRARY_HTML_TEMPLATE, MOCK_HTML_CREDENTIAL, MOCK_HTML_CREDENTIALS,
  MOCK_LIBRARY_CREDENTIAL, MOCK_MEMBERSHIP_CREDENTIAL, MOCK_TICKET_CREDENTIAL
} from '../../src/render/mockHtmlCredential.js';
import {readFile} from 'node:fs/promises';

// A minimal HTML template that reads the injected credential, matching how the
// vc-viewer HTML suite expects templates to obtain their data.
const TEMPLATE_HTML = '<div id="card"></div><script>' +
  'const el = document.querySelector(\'script[type="application/vc"]\');' +
  'document.getElementById("card").textContent = JSON.parse(el.textContent)' +
  '.credentialSubject.name;</script>';

const base64 = str => Buffer.from(str, 'utf8').toString('base64');

function makeCredential({renderMethod} = {}) {
  return {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://w3id.org/vc/render-method/v2rc2'
    ],
    id: 'urn:uuid:1a1e9a4a-3d0e-4c4f-9d9e-7a5a2f0d1b33',
    type: ['VerifiableCredential', 'ExampleCredential'],
    issuer: {id: 'did:example:1234', name: 'Example Issuer'},
    validFrom: '2026-01-15T00:00:00Z',
    credentialSubject: {
      type: 'ExamplePerson',
      name: 'Sam Doe',
      // Deliberately not listed in `renderProperty` below; must not leak.
      governmentId: 'SECRET-123'
    },
    ...(renderMethod ? {renderMethod} : {})
  };
}

const HTML_RENDER_METHOD = {
  type: 'TemplateRenderMethod',
  renderSuite: 'html',
  name: 'Card',
  mediaType: 'text/html',
  renderProperty: ['/issuer/name', '/credentialSubject/name'],
  template: `data:text/html;base64,${base64(TEMPLATE_HTML)}`
};

const SVG_RENDER_METHOD = {
  type: 'SvgRenderingTemplate2024',
  mediaType: 'image/svg+xml',
  template: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
};

// ============
// Detection
// ============

test('supportsHtmlRendering is true for an html renderSuite', () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  assert.equal(supportsHtmlRendering({credential}), true);
});

/*
The render policy is module state, so these tests set it explicitly and restore
the app's own policy afterwards. Leaving it set would leak into later tests --
`setRenderPolicy({credentials: []})` is the deny-all reset.
*/

test('nothing renders until a policy is set', () => {
  /* The default must be deny-all. An integration that forgets `setRenderPolicy`
  should render nothing, not execute issuer JavaScript on every credential the
  holder owns. */
  setRenderPolicy({credentials: []});
  assert.equal(
    isRenderAllowed({credential: MOCK_HTML_CREDENTIAL}), false,
    'a credential rendered with no policy set');
});

test('a credential named in the policy is allowed', () => {
  setRenderPolicy({credentials: [MOCK_HTML_CREDENTIAL]});
  assert.equal(isRenderAllowed({credential: MOCK_HTML_CREDENTIAL}), true);
  setRenderPolicy({credentials: []});
});

test('a credential absent from the policy is refused', () => {
  // Same render method, different credential: still must not run.
  setRenderPolicy({credentials: [MOCK_HTML_CREDENTIAL]});
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  assert.equal(isRenderAllowed({credential}), false);
  setRenderPolicy({credentials: []});
});

test('a lookalike id does not get in', () => {
  // The id alone is not enough; a scanned credential could claim it.
  setRenderPolicy({credentials: [MOCK_HTML_CREDENTIAL]});
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  credential.id = MOCK_HTML_CREDENTIAL.id;
  assert.equal(isRenderAllowed({credential}), false);
  setRenderPolicy({credentials: []});
});

test('a structural clone does not get in', () => {
  /* What a scanned credential claiming to be the demo would look like: equal by
  value, different object. */
  setRenderPolicy({credentials: [MOCK_HTML_CREDENTIAL]});
  const clone = JSON.parse(JSON.stringify(MOCK_HTML_CREDENTIAL));
  assert.equal(isRenderAllowed({credential: clone}), false);
  setRenderPolicy({credentials: []});
});

test('isRenderAllowed is false rather than throwing on junk', () => {
  setRenderPolicy({credentials: [MOCK_HTML_CREDENTIAL]});
  assert.equal(isRenderAllowed({credential: null}), false);
  assert.equal(isRenderAllowed({}), false);
  assert.equal(isRenderAllowed(), false);
  setRenderPolicy({credentials: []});
});

test('an undefined policy entry does not admit a missing credential', () => {
  /* `includes` uses SameValueZero, so a policy array holding `undefined` would
  otherwise match `isRenderAllowed({})`. */
  setRenderPolicy({credentials: [undefined]});
  assert.equal(isRenderAllowed({}), false);
  assert.equal(isRenderAllowed({credential: undefined}), false);
  setRenderPolicy({credentials: []});
});

test('mutating the caller array afterwards does not widen the policy', () => {
  // The policy is copied on set, so a later push must not grant access.
  const policy = [MOCK_HTML_CREDENTIAL];
  setRenderPolicy({credentials: policy});
  const other = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  policy.push(other);
  assert.equal(isRenderAllowed({credential: other}), false);
  setRenderPolicy({credentials: []});
});

test('setRenderPolicy refuses a non-array', () => {
  assert.throws(() => setRenderPolicy({credentials: 'all'}), TypeError);
  setRenderPolicy({credentials: []});
});

test('the renderer imports no demo data', async () => {
  /* The point of the policy indirection: `src/render/htmlRenderMethod.js` must
  drop into another application without dragging this repo's sample credentials
  along. A static import would make it non-reusable. */
  const source = await readFile(
    new URL('../../src/render/htmlRenderMethod.js', import.meta.url), 'utf8');
  assert.ok(
    !/from '\.\/mockHtmlCredential\.js'/.test(source),
    'the renderer imports demo credentials');
  assert.ok(
    !/react-native/.test(source.replace(/ReactNativeWebView/g, '')),
    'the renderer imports React Native');
});

test('supportsHtmlRendering is false when only SVG is offered', () => {
  const credential = makeCredential({renderMethod: [SVG_RENDER_METHOD]});
  assert.equal(supportsHtmlRendering({credential}), false);
});

test('supportsHtmlRendering is false with no renderMethod at all', () => {
  assert.equal(supportsHtmlRendering({credential: makeCredential()}), false);
});

test('supportsHtmlRendering is false rather than throwing on junk', () => {
  assert.equal(supportsHtmlRendering({}), false);
  assert.equal(supportsHtmlRendering({credential: null}), false);
  assert.equal(supportsHtmlRendering({credential: 'nope'}), false);
});

test('findHtmlRenderMethod accepts a single object, not just an array', () => {
  const credential = makeCredential({renderMethod: HTML_RENDER_METHOD});
  assert.equal(findHtmlRenderMethod({credential})?.renderSuite, 'html');
});

test('findHtmlRenderMethod picks the html entry out of a mixed array', () => {
  const credential = makeCredential({
    renderMethod: [SVG_RENDER_METHOD, HTML_RENDER_METHOD]
  });
  assert.equal(findHtmlRenderMethod({credential})?.name, 'Card');
});

test('findHtmlRenderMethod ignores an html entry with no template', () => {
  const noTemplate = {...HTML_RENDER_METHOD};
  delete noTemplate.template;
  const credential = makeCredential({renderMethod: [noTemplate]});
  assert.equal(findHtmlRenderMethod({credential}), null);
});

// ==================
// Template decoding
// ==================

test('renderToHtml decodes a base64 data URL template', () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = renderToHtml({credential});
  assert.ok(html.includes('<div id="card"></div>'), html.slice(0, 200));
});

test('renderToHtml decodes a plain (non-base64) data URL template', () => {
  const renderMethod = {
    ...HTML_RENDER_METHOD,
    template: 'data:text/html,<p>plain</p>'
  };
  const credential = makeCredential({renderMethod: [renderMethod]});
  assert.ok(renderToHtml({credential}).html.includes('<p>plain</p>'));
});

test('renderToHtml accepts a raw HTML template with no data URL prefix', () => {
  const renderMethod = {...HTML_RENDER_METHOD, template: '<p>raw</p>'};
  const credential = makeCredential({renderMethod: [renderMethod]});
  assert.ok(renderToHtml({credential}).html.includes('<p>raw</p>'));
});

test('renderToHtml rejects a non-HTML media type in the data URL', () => {
  const renderMethod = {
    ...HTML_RENDER_METHOD,
    template: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
  };
  const credential = makeCredential({renderMethod: [renderMethod]});
  assert.throws(() => renderToHtml({credential}), /media type/i);
});

test('renderToHtml throws when there is no html render method', () => {
  const credential = makeCredential({renderMethod: [SVG_RENDER_METHOD]});
  assert.throws(() => renderToHtml({credential}), /does not support/i);
});

// =========================================
// renderProperty filtering (least privilege)
// =========================================

test('renderToHtml injects the credential for the template to read', () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = renderToHtml({credential});
  assert.ok(html.includes('type="application/vc"'), 'missing payload script');
  assert.ok(html.includes('Sam Doe'), 'selected field absent');
});

test('renderToHtml omits fields not listed in renderProperty', () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = renderToHtml({credential});
  // `governmentId` is real data on the credential but is not pointed at by
  // `renderProperty`, so the issuer-supplied template must never see it.
  assert.ok(!html.includes('SECRET-123'), 'unselected field leaked');
  assert.ok(!html.includes('governmentId'), 'unselected key leaked');
});

test('renderToHtml does not mutate the credential it was given', () => {
  // The core strips `renderMethod` and `proof` before filtering; that must not
  // be visible to the caller, or a second render would behave differently.
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  credential.proof = {type: 'DataIntegrityProof', proofValue: 'zAbc'};
  const before = JSON.stringify(credential);

  renderToHtml({credential});
  renderToHtml({credential});

  assert.equal(JSON.stringify(credential), before, 'credential was mutated');
});

test('renderToHtml never exposes the proof to the template', () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  credential.proof = {type: 'DataIntegrityProof', proofValue: 'zLEAK'};
  assert.ok(!renderToHtml({credential}).html.includes('zLEAK'));
});

test('renderToHtml tolerates a renderProperty pointer that misses', () => {
  // `selectJsonLd` throws on a non-matching pointer. A stale pointer in an
  // issuer's template should degrade, not crash the whole card.
  const renderMethod = {
    ...HTML_RENDER_METHOD,
    renderProperty: ['/credentialSubject/name', '/does/not/exist']
  };
  const credential = makeCredential({renderMethod: [renderMethod]});
  const {html, warnings} = renderToHtml({credential});
  assert.ok(html.includes('Sam Doe'), 'valid pointer should still resolve');
  assert.ok(
    warnings.some(w => /does\/not\/exist/.test(w)),
    `expected a warning naming the bad pointer, got ${JSON.stringify(warnings)}`
  );
});

test('a root renderProperty pointer does not defeat the filter', () => {
  /* An empty JSON pointer selects the whole document, so `renderProperty: ['']`
  would hand the template every field — including ones the issuer did not list —
  while looking like a normal selection. Reject it rather than honor it. */
  const credential = makeCredential({
    renderMethod: [{...HTML_RENDER_METHOD, renderProperty: ['']}]
  });
  const {html, warnings} = renderToHtml({credential});
  assert.ok(!html.includes('SECRET-123'), 'root pointer leaked everything');
  assert.ok(
    warnings.some(w => /whole credential|root/i.test(w)),
    'a rejected root pointer must warn');
});

test('a "/" renderProperty pointer does not defeat the filter', () => {
  const credential = makeCredential({
    renderMethod: [{...HTML_RENDER_METHOD, renderProperty: ['/']}]
  });
  const {html} = renderToHtml({credential});
  assert.ok(!html.includes('SECRET-123'), '"/" pointer leaked everything');
});

test('a string renderProperty is rejected, not iterated', () => {
  /* A bare string has a `length`, so a naive check treats it as a non-empty
  list and then iterates it character by character. `/` is a valid root pointer,
  so one character selects the entire credential. */
  const credential = makeCredential({
    renderMethod: [{
      ...HTML_RENDER_METHOD,
      renderProperty: '/credentialSubject/name'
    }]
  });
  const {html, warnings} = renderToHtml({credential});
  assert.ok(!html.includes('SECRET-123'), 'string renderProperty leaked');
  assert.ok(
    warnings.some(w => /must be an array|list/i.test(w)),
    'a malformed renderProperty must warn');
});

test('a non-string entry in renderProperty is skipped', () => {
  const credential = makeCredential({
    renderMethod: [{
      ...HTML_RENDER_METHOD,
      renderProperty: ['/credentialSubject/name', 42, null]
    }]
  });
  const {html, warnings} = renderToHtml({credential});
  assert.ok(html.includes('Sam Doe'), 'the valid pointer should still resolve');
  assert.ok(!html.includes('SECRET-123'), 'junk entries leaked data');
  assert.equal(warnings.length, 2, 'each junk entry should warn');
});

test('absent renderProperty uses the entire credential', () => {
  /* Spec, stated twice: "If `renderMethod.renderProperty` is not present, the
  entire verifiable credential is used." An earlier revision failed closed and
  sent nothing, which is defensible on data-minimization grounds but is a silent
  divergence — a template written against the spec would render blank. */
  const noPointers = {...HTML_RENDER_METHOD};
  delete noPointers.renderProperty;
  const credential = makeCredential({renderMethod: [noPointers]});
  const {html, warnings} = renderToHtml({credential});
  assert.ok(html.includes('Sam Doe'), 'the credential should be sent whole');
  assert.ok(
    html.includes('SECRET-123'),
    'the issuer selected no subset, so nothing is withheld');
  // The holder should still be told the render method minimized nothing.
  assert.ok(
    warnings.some(w => /entire credential|no "renderProperty"/i.test(w)),
    'sending the whole credential must be surfaced');
});

test('renderMethod and proof are stripped even with no renderProperty', () => {
  // "Entire credential" still means the presentable credential, not the
  // signature over it or the render method's own definition.
  const noPointers = {...HTML_RENDER_METHOD};
  delete noPointers.renderProperty;
  const credential = makeCredential({renderMethod: [noPointers]});
  credential.proof = {type: 'DataIntegrityProof', proofValue: 'zSIG'};
  const {html} = renderToHtml({credential});
  assert.ok(!html.includes('zSIG'), 'proof reached the template');
  assert.ok(!html.includes('TemplateRenderMethod'), 'renderMethod reached it');
});

// =====================
// Document containment
// =====================

test('renderToHtml sets a restrictive content security policy', () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = renderToHtml({credential});
  assert.match(html, /content-security-policy/i);
  // No network egress: an issuer template must not phone home.
  assert.match(html, /default-src\s+data:\s+'unsafe-inline'/);
  // The spec's profile also forbids the template nesting a frame of its own.
  assert.match(html, /frame-src\s+'none'/);
  /* `form-action` and `base-uri` have no `default-src` fallback. Verified in
  Chromium that a form submission escapes to the network under `default-src`
  alone, so both are required for the no-egress claim to hold. */
  assert.match(html, /form-action\s+'none'/);
  assert.match(html, /base-uri\s+'none'/);
});

test('renderToHtml produces one well-formed document', () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = renderToHtml({credential});
  assert.match(html, /^<!doctype html>/i);
  assert.equal(html.match(/<html/gi).length, 1);
  assert.equal(html.match(/<\/html>/gi).length, 1);
});

test('renderToHtml escapes a payload closing its script tag', () => {
  // The payload is injected into a script element, so a `</script>` sequence in
  // the data would otherwise break out and become live markup.
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const attack = 'Sam</script><img src=x onerror=alert(1)>';
  credential.credentialSubject.name = attack;
  const {html} = renderToHtml({credential});
  // The value survives as inert text; what matters is that every `<` in it is
  // escaped, so the script element cannot be closed and no tag can start.
  assert.ok(!/<\/script><img/i.test(html), 'payload broke out of the script');
  assert.ok(!/<img/i.test(html), 'payload produced a live tag');
  assert.ok(html.includes('\\u003c/script>'), 'expected the `<` to be escaped');

  // The payload must still be valid JSON for the template to parse.
  const payload = html.match(
    /type="application\/vc">([\s\S]*?)<\/script>/)[1];
  assert.equal(
    JSON.parse(payload).credentialSubject.name, attack,
    'escaping must round-trip through JSON.parse');
});

test('renderToHtml reports the render method name it used', () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  assert.equal(renderToHtml({credential}).name, 'Card');
});

// ===========================================
// Spec conformance: data model and algorithms
// ===========================================

test('a template map with a data: id is decoded', () => {
  /* Spec: `template` is "an OPTIONAL URL or map". The map form carries `id`,
  `mediaType`, and `digestMultibase`. A `data:` id needs no fetching, so it is
  usable directly. */
  const credential = makeCredential({
    renderMethod: [{
      ...HTML_RENDER_METHOD,
      template: {
        id: `data:text/html;base64,${base64(TEMPLATE_HTML)}`,
        mediaType: 'text/html'
      }
    }]
  });
  const {html} = renderToHtml({credential});
  assert.ok(html.includes('id="card"'), 'template map was not decoded');
});

test('a template map with a remote id is refused, not fetched', () => {
  /* Spec: `frame-src 'none'` "forces the host page code to preload remotely
  referenced template code and check the response against the related
  digestMultibase value". This prototype does no fetching, so a remote template
  is unusable — and must say so rather than render an empty card. */
  const credential = makeCredential({
    renderMethod: [{
      ...HTML_RENDER_METHOD,
      template: {id: 'https://example.test/t.html', mediaType: 'text/html'}
    }]
  });
  assert.throws(() => renderToHtml({credential}), /not supported|remote/i);
});

test('findHtmlRenderMethod accepts the map template form', () => {
  const credential = makeCredential({
    renderMethod: [{
      ...HTML_RENDER_METHOD,
      template: {id: 'data:text/html,<p>x</p>', mediaType: 'text/html'}
    }]
  });
  assert.notEqual(findHtmlRenderMethod({credential}), null);
});

test('a template carrying document tags is reduced to a fragment', () => {
  /* Spec: the template code "MUST NOT include any <html>, <head>, or <body>
  tags, as these will be provided by the wrapper code". A template that includes
  them anyway must not produce a nested document — browsers recover from that
  unpredictably, so strip them and warn. */
  const credential = makeCredential({
    renderMethod: [{
      ...HTML_RENDER_METHOD,
      template:
        '<html><head><title>t</title></head><body><p>x</p></body></html>'
    }]
  });
  const {html, warnings} = renderToHtml({credential});
  assert.equal((html.match(/<html/gi) || []).length, 1, 'nested <html>');
  assert.equal((html.match(/<body/gi) || []).length, 1, 'nested <body>');
  assert.ok(html.includes('<p>x</p>'), 'template content was lost');
  assert.ok(
    warnings.some(w => /fragment|<html>/i.test(w)),
    'a non-fragment template must warn');
});

test('outputPreference style is applied to the frame', async () => {
  /* Spec: `outputPreference.style` carries `width`/`height` "to be set on the
  iframe", and "an implementation SHOULD follow these preferences". */
  const credential = makeCredential({
    renderMethod: [{
      ...HTML_RENDER_METHOD,
      outputPreference: {style: {width: '800px', height: '640px'}}
    }]
  });
  const {html} = await renderHostPage({credential});
  assert.match(html, /width:\s*800px/);
  assert.match(html, /height:\s*640px/);
});

test('outputPreference is optional', async () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = await renderHostPage({credential});
  assert.match(html, /<iframe/, 'frame must render without a preference');
});

test('a malicious outputPreference style cannot inject CSS', async () => {
  /* `outputPreference` comes from the credential, so it is untrusted and lands
  in a `<style>` block on the host page. A value that closes the block would put
  markup outside the sandboxed frame. */
  const credential = makeCredential({
    renderMethod: [{
      ...HTML_RENDER_METHOD,
      outputPreference: {
        style: {
          width: '1px} #render-method-frame {position:fixed;top:0',
          height: '1px</style><script>fetch("https://evil.test")</script>'
        }
      }
    }]
  });
  const {html} = await renderHostPage({credential});
  assert.ok(!html.includes('evil.test'), 'style injected a script');
  assert.ok(!html.includes('position:fixed'), 'style injected a rule');
  // Rejected values fall back to the defaults.
  assert.match(html, /width:\s*100%/);
});

test('a non-visual outputPreference accessMode is reported', () => {
  /* Spec: `accessMode` may be `auditory`, `tactile`, `textual`, or `visual`.
  This renderer is visual only, so a template asking for something else should
  say so rather than silently rendering the wrong modality. */
  const credential = makeCredential({
    renderMethod: [{
      ...HTML_RENDER_METHOD,
      outputPreference: {accessMode: ['auditory']}
    }]
  });
  const {warnings} = renderToHtml({credential});
  assert.ok(
    warnings.some(w => /accessMode|auditory/i.test(w)),
    'an unsupported accessMode must warn');
});

// ==========================
// digestMultibase
// ==========================

/*
The spec: `digestMultibase` is "an OPTIONAL multibase-encoded Multihash of the
template file. The multibase value MUST be `u` (base64url-nopad) and the
multihash value MUST be SHA-2 with 256-bits of output (`0x12`)."

For a `data:` template the bytes travel inside the credential, so the digest
is a consistency check rather than the integrity anchor a remote template has.
A mismatch still means something is wrong -- a template altered after the digest
was computed -- so it must not render.

`_multibaseDigest` mirrors what an issuer would do, so the fixtures below are
real values rather than invented strings.
*/
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Independent base58btc encoder, so the `z` fixtures are genuinely base58
// rather than the implementation's own output fed back to it.
function _toBase58btc({bytes} = {}) {
  // Started empty, not seeded with a zero: a seed would emit an extra '1' for
  // an all-zero input, where each leading zero byte should map to exactly one.
  const digits = [];
  for(const byte of bytes) {
    let carry = byte;
    for(let i = 0; i < digits.length; ++i) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while(carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for(const byte of bytes) {
    if(byte !== 0) {
      break;
    }
    out += '1';
  }
  return out + digits.reverse().map(d => B58[d]).join('');
}

async function _multibaseDigest({content, prefix = 'u'} = {}) {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)));
  // multihash prefix: 0x12 = sha2-256, 0x20 = 32 bytes of output
  const multihash = new Uint8Array(2 + hash.length);
  multihash[0] = 0x12;
  multihash[1] = 0x20;
  multihash.set(hash, 2);
  return prefix === 'z' ?
    `z${_toBase58btc({bytes: multihash})}` :
    prefix + Buffer.from(multihash).toString('base64url');
}

function _withDigest({template, digestMultibase} = {}) {
  return makeCredential({
    renderMethod: [{
      ...HTML_RENDER_METHOD,
      template: {
        id: `data:text/html;base64,${base64(template)}`,
        mediaType: 'text/html',
        digestMultibase
      }
    }]
  });
}

test('a matching digest verifies', async () => {
  const template = '<div id="card">ok</div>';
  const credential = _withDigest({
    template, digestMultibase: await _multibaseDigest({content: template})
  });
  const {verified, reason} = await verifyTemplateDigest({credential});
  assert.equal(verified, true, reason);
});

test('a mismatched digest does not verify', async () => {
  const credential = _withDigest({
    template: '<div>actual</div>',
    digestMultibase: await _multibaseDigest({content: '<div>expected</div>'})
  });
  const {verified, reason} = await verifyTemplateDigest({credential});
  assert.equal(verified, false);
  assert.match(reason, /does not match/i);
});

test('an absent digest is reported as unverified, not failed', async () => {
  // `digestMultibase` is OPTIONAL, so its absence is not an error.
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {verified, reason} = await verifyTemplateDigest({credential});
  assert.equal(verified, null, 'absent digest must not read as a failure');
  assert.match(reason, /no "digestMultibase"/i);
});

test('a base58btc digest verifies, with a note', async () => {
  /* The spec's normative text requires multibase `u`, but every example in the
  spec uses `z` (base58btc) — the `zQm…` values. A credential built by copying
  those examples should still verify, so accept `z` and say it is off-spec. */
  const template = '<div>b58</div>';
  const credential = _withDigest({
    template,
    digestMultibase: await _multibaseDigest({content: template, prefix: 'z'})
  });
  const {verified, reason} = await verifyTemplateDigest({credential});
  assert.equal(verified, true, reason);
  assert.match(reason, /base58|base64url|normative/i);
});

test('an unknown multibase prefix does not verify', async () => {
  const credential = _withDigest({
    template: '<div>x</div>', digestMultibase: 'QQQunknownprefix'
  });
  const {verified, reason} = await verifyTemplateDigest({credential});
  assert.equal(verified, false);
  assert.match(reason, /multibase/i);
});

test('a non-SHA-256 multihash does not verify', async () => {
  // Only sha2-256 (0x12) is allowed; flip the code to sha2-512 (0x13).
  const template = '<div>x</div>';
  const good = await _multibaseDigest({content: template});
  const bytes = Buffer.from(good.slice(1), 'base64url');
  bytes[0] = 0x13;
  const credential = _withDigest({
    template, digestMultibase: `u${bytes.toString('base64url')}`
  });
  const {verified, reason} = await verifyTemplateDigest({credential});
  assert.equal(verified, false);
  assert.match(reason, /sha-?2-?256|multihash/i);
});

test('a string template with no map cannot carry a digest', async () => {
  // The digest lives on the map form only, so a plain string is unverified.
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {verified} = await verifyTemplateDigest({credential});
  assert.equal(verified, null);
});

test('renderHostPage refuses a digest mismatch', async () => {
  const credential = _withDigest({
    template: '<div>actual</div>',
    digestMultibase: await _multibaseDigest({content: '<div>other</div>'})
  });
  await assert.rejects(
    () => renderHostPage({credential}), /does not match/i);
});

test('renderHostPage renders when the digest matches', async () => {
  const template = '<div id="card">verified</div>';
  const credential = _withDigest({
    template, digestMultibase: await _multibaseDigest({content: template})
  });
  const {html} = await renderHostPage({credential});
  assert.match(html, /<iframe/);
});

test('renderHostPage still renders with no digest at all', async () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html, warnings} = await renderHostPage({credential});
  assert.match(html, /<iframe/);
  assert.ok(
    !warnings.some(w => /digest/i.test(w)),
    'an absent optional digest should not warn');
});

// ============================
// Wrapper code: ready / error
// ============================

/*
The spec requires the wrapper code to provide `window.renderMethodReady()` so a
template can report completion or failure. The wrapper is a string emitted by
the core, so it can be run here directly against a simulated host rather than
only matched against.

`_runWrapper` evaluates the emitted wrapper script in a minimal fake window and
returns what the host would have received. It deliberately does not use a real
DOM: the point is the message contract, not the browser.

The wrapper is standards-only -- a transferred `MessagePort` is its sole
transport. It runs inside a sandboxed iframe on every platform, so there is no
React Native code path in here to test.
*/
function _runWrapper({html} = {}) {
  const sent = [];
  const listeners = {};
  const port = {postMessage: message => sent.push(message)};

  const window = {
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    }
  };

  const script = html.match(
    /<script class="render-method-wrapper">([\s\S]*?)<\/script>/)[1];
  new Function('window', script)(window);

  const deliverPort = () => listeners.message?.({ports: [port], data: null});
  return {sent, window, deliverPort};
}

test('the emitted document includes wrapper code', () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = renderToHtml({credential});
  assert.match(html, /<script class="render-method-wrapper">/);
  assert.match(html, /renderMethodReady/);
});

test('wrapper defines renderMethodReady before the template runs', () => {
  // The template's own script may call `renderMethodReady()` synchronously, so
  // the wrapper must appear ahead of the template markup in the document.
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = renderToHtml({credential});
  assert.ok(
    html.indexOf('render-method-wrapper') < html.indexOf('<div id="card">'),
    'wrapper must be defined before the template');
});

test('renderMethodReady with no arguments sends a ready message', () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {sent, window, deliverPort} = _runWrapper(renderToHtml({credential}));
  deliverPort();
  window.renderMethodReady();
  assert.deepEqual(sent, [{type: 'ready'}]);
});

test('renderMethodReady with an Error sends an error message', () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {sent, window, deliverPort} = _runWrapper(renderToHtml({credential}));
  deliverPort();
  window.renderMethodReady(new Error('template blew up'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.match(sent[0].message, /template blew up/);
});

test('a signal sent before the port arrives is not lost', () => {
  // A template that renders synchronously calls `renderMethodReady()` before
  // the host's `onload` handler has transferred a port. Dropping that signal
  // would make a working template look like one that never finished.
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {sent, window, deliverPort} = _runWrapper(renderToHtml({credential}));
  window.renderMethodReady();
  assert.deepEqual(sent, [], 'nothing can be sent before there is a port');
  deliverPort();
  assert.deepEqual(sent, [{type: 'ready'}], 'buffered signal must flush');
});

test('the wrapper has no React Native code path', () => {
  /* The template runs inside a real sandboxed iframe on every platform, so the
  document it sees must be standards-only. A `ReactNativeWebView` reference in
  here would mean the sandboxed environment differs between platforms, which is
  exactly what the nested-iframe structure exists to prevent. */
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = renderToHtml({credential});
  assert.ok(
    !html.includes('ReactNativeWebView'),
    'the sandboxed document must not reference a platform bridge');
});

test('renderMethodReady reports a non-Error argument as an error', () => {
  // Templates are untrusted; one may call this with a string or nothing useful.
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {sent, window, deliverPort} = _runWrapper(renderToHtml({credential}));
  deliverPort();
  window.renderMethodReady('just a string');
  assert.equal(sent[0].type, 'error');
  assert.match(sent[0].message, /just a string/);
});

test('a template cannot signal twice', () => {
  // Rendering completes once. A template that calls repeatedly, or reports an
  // error after reporting ready, must not be able to flip the host's state.
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {sent, window, deliverPort} = _runWrapper(renderToHtml({credential}));
  deliverPort();
  window.renderMethodReady();
  window.renderMethodReady(new Error('too late'));
  window.renderMethodReady();
  assert.deepEqual(sent, [{type: 'ready'}], 'only the first signal counts');
});

test('the wrapper does not leak credential data into its messages', () => {
  // The channel goes to the host, which is outside the sandbox, so it must
  // carry only a status — never a field the template was shown.
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {sent, window, deliverPort} = _runWrapper(renderToHtml({credential}));
  deliverPort();
  window.renderMethodReady(new Error('Sam Doe leaked? SECRET-123'));
  const serialized = JSON.stringify(sent);
  // The template chose the message text, so it can put anything there; what
  // matters is that the wrapper adds no credential data of its own.
  assert.ok(!serialized.includes('did:example'), 'issuer id in message');
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['message', 'type']);
});

// ===================================
// Host page: the nested iframe shim
// ===================================

/*
On React Native the WebView is not the sandbox -- it is the *host page*. It
contains a real `<iframe sandbox="allow-scripts" srcdoc>` holding the wrapper
and template, so the sandboxed environment is a standard browser iframe on
every platform, and the spec's `MessageChannel` is used as written.

The native bridge is only used to relay a status from the host page out to the
React Native application, which is outside the sandbox boundary and carries no
spec-defined semantics.
*/

test('renderHostPage returns a document with a sandboxed iframe', async () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = await renderHostPage({credential});
  assert.match(html, /<iframe/);
  assert.match(html, /sandbox="allow-scripts"/);
  assert.match(html, /srcdoc=/);
});

test('the host page sets up a real MessageChannel', async () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = await renderHostPage({credential});
  assert.match(html, /new MessageChannel\(\)/);
  // port2 is transferred to the iframe, per the spec's Host Page algorithm.
  assert.match(html, /postMessage\([^)]*\[\s*\w+\.port2\s*\]/);
});

test('the host page embeds the sandboxed document in srcdoc', async () => {
  // The inner document must arrive via `srcdoc`, not a URL: nothing is fetched.
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = await renderHostPage({credential});
  assert.ok(!/<iframe[^>]+\ssrc=/.test(html), 'iframe must not use src');
  // The inner document is HTML-escaped into the attribute.
  assert.match(html, /srcdoc="[^"]*&lt;!doctype html&gt;/i);
});

test('the host page relays status to React Native', async () => {
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = await renderHostPage({credential});
  assert.match(html, /ReactNativeWebView/);
});

test('the escaped inner document cannot break out of srcdoc', async () => {
  // A template containing a double quote would otherwise close the attribute
  // and the rest would become markup in the host page, outside the sandbox.
  const credential = makeCredential({
    renderMethod: [{
      ...HTML_RENDER_METHOD,
      template: '<div title="x">" onload="alert(1)</div>'
    }]
  });
  const {html} = await renderHostPage({credential});
  const srcdoc = html.match(/srcdoc="([^"]*)"/)[1];
  assert.ok(!srcdoc.includes('"'), 'a raw quote survived into srcdoc');
  /* The template's markup must survive only in escaped form. `onload=` appears
  in the document as `onload=&quot;`, which is inert text inside the attribute;
  what must never appear is the unescaped `onload="` that would make it a live
  handler on a host-page element. */
  assert.ok(
    !html.includes('onload="'), 'attribute injection into the host page');
  assert.ok(
    srcdoc.includes('&quot; onload=&quot;'),
    'expected the injection attempt to survive as inert escaped text');
});

test('credential data appears only inside the sandboxed frame', async () => {
  /* The payload belongs inside the iframe. If any of it appeared in the host
  page outside `srcdoc`, it would be readable by host-page script — outside the
  sandbox the CSP and the iframe are there to enforce. */
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {html} = await renderHostPage({credential});
  const srcdoc = html.match(/srcdoc="([^"]*)"/)[1];
  const outside = html.replace(srcdoc, '');

  assert.ok(!outside.includes('application/vc'), 'data block outside srcdoc');
  assert.ok(!outside.includes('Sam Doe'), 'credential value outside srcdoc');
  // And the host shim never reads the frame's contents.
  assert.ok(
    !outside.includes('contentDocument'), 'host shim reaches into the frame');
});

test('renderHostPage reports the render method name and warnings', async () => {
  // Same result shape as renderToHtml, so the shell can use either.
  const credential = makeCredential({renderMethod: [HTML_RENDER_METHOD]});
  const {name, warnings} = await renderHostPage({credential});
  assert.equal(name, 'Card');
  assert.deepEqual(warnings, []);
});

test('renderHostPage rejects when there is no html render method', async () => {
  await assert.rejects(
    () => renderHostPage({credential: makeCredential()}),
    /does not support HTML rendering/);
});

// ==========================
// The demo credential
// ==========================

test('the demo credential renders with no warnings', () => {
  const {html, name, warnings} = renderToHtml({
    credential: MOCK_HTML_CREDENTIAL
  });
  assert.deepEqual(warnings, [], 'demo pointers should all resolve');
  assert.equal(name, 'Badge');
  // the issuer-authored markup survived decoding
  assert.ok(html.includes('class="card"'), 'template markup missing');
  assert.ok(html.includes('SAMPLE DATA'), 'sample-data label missing');
  // the selected fields are present for the template to read
  assert.ok(html.includes('Fire Fighter I'), 'jobTitle missing');
  assert.ok(html.includes('UFD-00-0000-0000'), 'badgeNumber missing');
});

test('the demo template signals ready when it finishes', () => {
  // The sample card is the one thing a reviewer will actually look at, so it
  // should exercise the channel rather than fall through to the timeout path.
  const {html} = renderToHtml({credential: MOCK_HTML_CREDENTIAL});
  assert.match(html, /renderMethodReady\(\)/,
    'demo template never signals completion');
});

test('the demo credential template matches its digest', async () => {
  /* The demo's `digestMultibase` is a literal, since that credential is a
  synchronous module constant and hashing is async. Recompute it here so editing
  `DEMO_HTML_TEMPLATE` without updating the digest fails loudly rather than
  turning the demo card into a digest-mismatch error at runtime. */
  const {verified, reason} = await verifyTemplateDigest({
    credential: MOCK_HTML_CREDENTIAL
  });
  assert.equal(
    verified, true,
    `${reason} — recompute the digest in mockHtmlCredential.js`);
});

test('the demo credential does not leak its unselected field', () => {
  const {html} = renderToHtml({credential: MOCK_HTML_CREDENTIAL});
  assert.ok(
    !html.includes('NOT-IN-RENDER-PROPERTY'),
    'unselectedField reached the template');
  assert.ok(
    !html.includes('unselectedField'), 'unselectedField key reached it');
});

// =========================================
// Every bundled credential, not just the first
// =========================================

/*
The wallet lists four demo credentials and declares all four as its render
policy. Testing only the badge would leave the others renderable in the app
but unverified here, so these run the same checks across all of them.
*/

test('every bundled credential is admitted by the app policy', () => {
  setRenderPolicy({credentials: MOCK_HTML_CREDENTIALS});
  for(const credential of MOCK_HTML_CREDENTIALS) {
    assert.equal(
      isRenderAllowed({credential}), true,
      `${credential.id} is listed but not admitted`);
  }
  setRenderPolicy({credentials: []});
});

test('a copy of a bundled credential is still refused', () => {
  /* The gate is object identity, so a structural clone -- which is what a
  scanned credential claiming these fields would be -- must not pass. */
  setRenderPolicy({credentials: MOCK_HTML_CREDENTIALS});
  for(const credential of MOCK_HTML_CREDENTIALS) {
    const clone = JSON.parse(JSON.stringify(credential));
    assert.equal(
      isRenderAllowed({credential: clone}), false,
      `a clone of ${credential.id} reached the render path`);
  }
  setRenderPolicy({credentials: []});
});

test('every bundled credential renders with no warnings', () => {
  for(const credential of MOCK_HTML_CREDENTIALS) {
    const {html, warnings} = renderToHtml({credential});
    assert.deepEqual(
      warnings, [], `${credential.id} produced warnings: ${warnings}`);
    assert.ok(
      html.includes('SAMPLE DATA'),
      `${credential.id} is missing its sample-data label`);
  }
});

test('every bundled credential signals ready', () => {
  for(const credential of MOCK_HTML_CREDENTIALS) {
    const {html} = renderToHtml({credential});
    assert.match(
      html, /renderMethodReady\(\)/,
      `${credential.id} never signals completion`);
  }
});

test('every bundled template matches its digest', async () => {
  /* Each digest is a literal, for the same reason the badge's is. Recomputing
  all three here means editing any template without updating its digest fails
  in the suite rather than as a mismatch error on the device. */
  for(const credential of MOCK_HTML_CREDENTIALS) {
    const {verified, reason} = await verifyTemplateDigest({credential});
    assert.equal(
      verified, true,
      `${credential.id}: ${reason} — recompute the digest in ` +
      'mockHtmlCredential.js');
  }
});

test('no bundled credential leaks an unselected field', () => {
  for(const credential of MOCK_HTML_CREDENTIALS) {
    const {html} = renderToHtml({credential});
    assert.ok(
      !html.includes('NOT-IN-RENDER-PROPERTY'),
      `${credential.id} leaked its unselected field`);
  }
});

test('the bundled credentials are distinct objects with distinct ids', () => {
  // A copy-paste slip that repeated one credential would otherwise pass every
  // loop above while showing the same card three times.
  const ids = MOCK_HTML_CREDENTIALS.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate credential id');
  assert.equal(
    new Set(MOCK_HTML_CREDENTIALS).size, MOCK_HTML_CREDENTIALS.length,
    'the same object is listed twice');
});

test('the bundled credentials render visibly different cards', () => {
  /* The point of four credentials is four layouts. Identical markup would
  mean a template was reused by mistake. */
  const bodies = MOCK_HTML_CREDENTIALS.map(
    credential => renderToHtml({credential}).html);
  assert.equal(
    new Set(bodies).size, bodies.length, 'two credentials rendered the same');
});

test('the ticket card shows its selected fields', () => {
  const {html, name} = renderToHtml({credential: MOCK_TICKET_CREDENTIAL});
  assert.equal(name, 'Pass');
  assert.ok(html.includes('Day Pass'), 'passType missing');
  assert.ok(html.includes('UMT-0000-0000-0000'), 'passNumber missing');
});

test('the membership card shows its selected fields', () => {
  const {html, name} = renderToHtml({credential: MOCK_MEMBERSHIP_CREDENTIAL});
  assert.equal(name, 'Membership');
  assert.ok(html.includes('Sustaining Member'), 'membershipLevel missing');
  assert.ok(html.includes('UAS-000000'), 'memberNumber missing');
});

// =====================
// Language preference
// =====================
//
// The host application, not the device, decides what language a template
// renders in. This is not spec-defined -- see
// `docs/render-method-sandbox-requirements.md` -- but it is implementable
// within the sandbox the spec already requires, which is what these cover.
//
// The escape-path tests below are the interesting ones: an instance-only
// override leaks the real device locale through the prototype getter, and a
// prototype-only override can be shadowed by the template. Both were observed
// in Chromium before this was implemented, so both stay as regressions.

test('setLanguagePreference rejects a non-array', () => {
  assert.throws(
    () => setLanguagePreference({languages: 'en'}), /must be an array/);
});

test('setLanguagePreference rejects an empty array', () => {
  assert.throws(
    () => setLanguagePreference({languages: []}), /at least one/);
});

test('setLanguagePreference rejects a malformed tag', () => {
  assert.throws(
    () => setLanguagePreference({languages: ['en', 'not a tag!']}),
    /BCP 47/);
});

test('setLanguagePreference rejects a non-string entry', () => {
  assert.throws(
    () => setLanguagePreference({languages: ['en', 42]}), /BCP 47/);
});

test('the default language preference is English', () => {
  setLanguagePreference();
  assert.deepEqual(getLanguagePreference(), ['en']);
});

test('the host language reaches the sandboxed document', () => {
  setLanguagePreference({languages: ['fr-CA', 'fr']});
  const {html} = renderToHtml({credential: MOCK_HTML_CREDENTIAL});
  assert.ok(html.includes('fr-CA'), 'the host language is not in the document');
  setLanguagePreference();
});

test('the language override is pinned on both navigator and its prototype',
  () => {
    /* Instance alone leaks the device locale via the prototype getter;
    prototype alone is shadowable by the template. Both are required. */
    setLanguagePreference({languages: ['ja-JP']});
    const {html} = renderToHtml({credential: MOCK_HTML_CREDENTIAL});
    assert.ok(
      /pin\(\s*Navigator\.prototype,\s*'language'/.test(html),
      'the prototype accessor is not redefined; device locale can leak');
    assert.ok(
      /pin\(\s*navigator,\s*'language'/.test(html),
      'the instance property is not pinned; a template can shadow it');
    assert.ok(
      /pin\(\s*Navigator\.prototype,\s*'languages'/.test(html) &&
      /pin\(\s*navigator,\s*'languages'/.test(html),
      '"languages" is not pinned on both targets');
    setLanguagePreference();
  });

test('the language override is non-configurable', () => {
  // A configurable override is one `defineProperty` away from being replaced
  // by the untrusted template.
  setLanguagePreference({languages: ['ja-JP']});
  const {html} = renderToHtml({credential: MOCK_HTML_CREDENTIAL});
  assert.ok(
    /configurable:\s*false/.test(html), 'the override can be redefined');
  setLanguagePreference();
});

test('the language list is frozen against mutation', () => {
  setLanguagePreference({languages: ['fr-CA', 'fr']});
  const {html} = renderToHtml({credential: MOCK_HTML_CREDENTIAL});
  assert.ok(
    /Object\.freeze/.test(html), 'navigator.languages can be mutated in place');
  setLanguagePreference();
});

test('the language preference is copied, not held by reference', () => {
  const languages = ['fr-CA'];
  setLanguagePreference({languages});
  languages.push('zz-ZZ');
  assert.deepEqual(getLanguagePreference(), ['fr-CA']);
  setLanguagePreference();
});

test('getLanguagePreference returns a copy', () => {
  setLanguagePreference({languages: ['fr-CA']});
  getLanguagePreference().push('zz-ZZ');
  assert.deepEqual(getLanguagePreference(), ['fr-CA']);
  setLanguagePreference();
});

test('the language value is escaped into the document', () => {
  /* The tag is validated, so this is belt-and-braces: if validation ever
  loosened, the value still must not be able to close the script element. */
  setLanguagePreference({languages: ['fr-CA']});
  const {html} = renderToHtml({credential: MOCK_HTML_CREDENTIAL});
  assert.ok(
    !/<\/script>\s*<\/script>/.test(html), 'the document is malformed');
  setLanguagePreference();
});

test('the language override runs before the template markup', async () => {
  /* A template that reads `navigator.language` at parse time must already see
  the host's value, so the override has to be in `<head>`. */
  setLanguagePreference({languages: ['ja-JP']});
  const {html} = await renderHostPage({credential: MOCK_HTML_CREDENTIAL});
  const overrideAt = html.indexOf('Navigator.prototype');
  const bodyAt = html.indexOf('&lt;body&gt;');
  assert.ok(overrideAt !== -1, 'the override is missing');
  assert.ok(
    bodyAt === -1 || overrideAt < bodyAt,
    'the override runs after the template markup');
  setLanguagePreference();
});

// ============================
// The localizing demo card
// ============================

test('the library card selects its fields', () => {
  const {html, name} = renderToHtml({credential: MOCK_LIBRARY_CREDENTIAL});
  assert.equal(name, 'Library card');
  assert.ok(html.includes('UPL-0000-0000'), 'cardNumber missing');
  assert.ok(html.includes('2030-01-15'), 'validThrough missing');
});

test('the library card withholds the fields it does not draw', () => {
  /* `homeBranch` is on the credential but absent from `renderProperty`,
  because the card does not draw it. A second canary alongside
  `unselectedField`: least privilege means the template is not sent a field
  merely because the credential carries one. */
  const {html} = renderToHtml({credential: MOCK_LIBRARY_CREDENTIAL});
  assert.ok(
    !html.includes('Utopia Central'), 'homeBranch reached the template');
  assert.ok(!html.includes('homeBranch'), 'the homeBranch key reached it');
});

test('the library template ships a table per language it claims', () => {
  /* The card advertises three languages; a table removed by an edit would
  otherwise show up only as an English card on a French wallet. */
  for(const primary of ['en', 'fr', 'ja']) {
    assert.ok(
      new RegExp(`\\b${primary}:\\s*\\{`).test(LIBRARY_HTML_TEMPLATE),
      `the "${primary}" string table is missing`);
  }
});

test('the library template reads the standard navigator API', () => {
  /* The portability claim: an issuer writes to `navigator.language` and the
  same template localizes in a browser wallet. A wallet-specific API here
  would break that. */
  assert.ok(
    LIBRARY_HTML_TEMPLATE.includes('navigator.language'),
    'the template does not read navigator.language');
  assert.ok(
    !/renderMethodLanguage|window\.__/.test(LIBRARY_HTML_TEMPLATE),
    'the template depends on a wallet-specific language API');
});

test('the library template falls back rather than rendering empty', () => {
  assert.ok(
    /STRINGS\[primary\]\s*\|\|\s*STRINGS\.en/.test(LIBRARY_HTML_TEMPLATE),
    'an unknown language tag has no fallback');
});

test('the library card does not leak its unselected field', () => {
  const {html} = renderToHtml({credential: MOCK_LIBRARY_CREDENTIAL});
  assert.ok(
    !html.includes('NOT-IN-RENDER-PROPERTY'), 'unselectedField reached it');
});
