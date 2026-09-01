/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * HTML render method core.
 *
 * An HTML render method is `type: 'TemplateRenderMethod'` with
 * `renderSuite: 'html'`. There is no dedicated `HtmlRenderingTemplate` type;
 * `renderSuite` is what discriminates HTML from the other suites (`literal` is
 * used for NFC).
 *
 * Unlike `SvgRenderingTemplate2024`, an HTML template is **not** interpolated.
 * The credential is filtered down to the fields named by `renderProperty` and
 * injected as a `<script type="application/vc">` element; the template's own
 * JavaScript reads that element. This mirrors the `html` suite in `vc-viewer`
 * so the same issuer templates render in both places.
 *
 * This module is pure — it returns an HTML document string and never touches a
 * WebView. See `app/src/HtmlRenderCard.js` for the shell that displays it.
 *
 * It imports nothing from React Native and nothing from this repo's demo data,
 * so it drops into another application unchanged. Which credentials may render
 * is the host application's decision, declared through `setRenderPolicy`; the
 * default is deny-all. See the README for the integration steps.
 *
 * Two properties matter more than the rendering itself:
 *
 * 1. **Least privilege.** Only `renderProperty`-selected fields reach the
 *    issuer-supplied template. An absent `renderProperty` sends the whole
 *    credential, which is what the spec requires, with a warning.
 * 2. **No egress.** The emitted CSP allows `data:` and inline only, so a
 *    template cannot exfiltrate what it is shown.
 *
 * The template runs inside a real `<iframe sandbox="allow-scripts" srcdoc>` on
 * every platform — see `renderHostPage` — so the specification's own mechanisms
 * apply directly. See `docs/render-method-sandbox-requirements.md`.
 */
import {selectJsonLd} from '@digitalbazaar/di-sd-primitives';

const HTML_RENDER_SUITE = 'html';
const TEMPLATE_RENDER_METHOD = 'TemplateRenderMethod';

/*
Allows inline scripts/styles and `data:` URLs (images are embedded as data URLs)
while denying every network destination.

`frame-src 'none'` blocks the template from nesting a frame of its own.

`form-action` and `base-uri` do **not** fall back to `default-src`, so both are
required rather than implied. Verified in Chromium: under `default-src` alone a
template's form submission navigates to the network and carries its field values
with it, which would defeat the no-egress property entirely.
*/
const CSP = 'default-src data: \'unsafe-inline\'; frame-src \'none\'; ' +
  'form-action \'none\'; base-uri \'none\'';

/*
CSP for the host page. Same policy as the sandboxed document, including
`frame-src 'none'`, which the spec requires on the host page precisely
because it forces `srcdoc` rather than `src` -- a frame never fetched.

Verified in Chromium that `frame-src 'none'` does *not* block a `srcdoc`
frame: the nested template still rendered and signalled ready with this
policy in place, so the host page keeps the directive and gets its frame.
*/
const HOST_CSP = CSP;

/*
Wrapper code, per the `html` suite's "Wrapper Code" algorithm: it must provide
`window.renderMethodReady()` so the template can report that rendering finished,
or failed.

This is standards-only. A transferred `MessagePort` is the sole transport,
exactly as the specification describes, because this document always runs inside
a sandboxed iframe -- on React Native too, where the WebView hosts that iframe
rather than being the sandbox itself. See `renderHostPage`.

Keeping any platform bridge out of here is the point: an issuer's template must
see the same environment and make the same calls everywhere.

Two things this must get right, both because the template is untrusted:

1. A template that renders synchronously calls `renderMethodReady()` before the
   host has transferred a port. That signal is buffered, not dropped.
2. Rendering completes once, so only the first signal is forwarded. A template
   cannot report ready and then flip the host into an error state.

Kept free of template data: the channel crosses the sandbox boundary, so it
carries a status and nothing else.
*/
const WRAPPER_CODE = `
(function() {
  var port = null;
  var pending = null;
  var done = false;

  function transmit(message) {
    if(port) {
      port.postMessage(message);
      return true;
    }
    return false;
  }

  window.addEventListener('message', function(event) {
    if(port || !event || !event.ports || !event.ports[0]) {
      return;
    }
    port = event.ports[0];
    if(typeof port.start === 'function') {
      port.start();
    }
    if(pending) {
      var message = pending;
      pending = null;
      transmit(message);
    }
  });

  window.renderMethodReady = function(error) {
    if(done) {
      return;
    }
    var message = {type: 'ready'};
    if(error !== undefined) {
      message = {
        type: 'error',
        message: error && error.message ? String(error.message) : String(error)
      };
    }
    done = true;
    if(!transmit(message)) {
      // Buffer until a port shows up.
      pending = message;
    }
  };
})();`;

/*
Language override, prepended to the wrapper code.

`navigator.language` inside a sandboxed iframe is the engine's, which is the
device locale. This replaces it with the host application's choice so an
issuer's template localizes itself from the standard API rather than from a
wallet-specific one, and so the device locale is not disclosed to the template.

Both the prototype accessor and an own property on `navigator` are defined, and
neither ordering alone is sufficient. Verified in Chromium against a real
sandboxed `srcdoc` frame:

· instance only -- the template still reads the true device locale through
  `Object.getOwnPropertyDescriptor(Navigator.prototype, 'language').get
  .call(navigator)`, so the override leaks what it is meant to hide.
· prototype only -- with no own property in the way, the template defines its
  own and shadows the host's value entirely.

`configurable: false` on both is what stops the template redefining them
afterwards, and `Object.freeze` on the returned array stops an in-place
mutation of `navigator.languages`.

Wrapped in try/catch because an engine that refuses either redefinition must
still render the card: a template that falls back to the engine's own language
is a worse outcome than a blank card only if the card is blank.
*/
function _languageOverride({languages} = {}) {
  /* JSON.stringify, not string concatenation: the tags are validated on the
  way in, so this is the second of two independent reasons the value cannot
  break out of the script element. */
  const list = JSON.stringify(languages).replaceAll('<', '\\u003c');
  return `
(function() {
  var LANGUAGES = ${list};
  function first() { return LANGUAGES[0]; }
  function all() { return Object.freeze(LANGUAGES.slice()); }
  function pin(target, name, getter) {
    Object.defineProperty(target, name, {
      configurable: false, enumerable: true, get: getter
    });
  }
  try {
    // The prototype first, closing the descriptor-getter read path...
    pin(Navigator.prototype, 'language', first);
    pin(Navigator.prototype, 'languages', all);
    // ...then the instance, which a template can no longer shadow.
    pin(navigator, 'language', first);
    pin(navigator, 'languages', all);
  } catch(e) {}
})();`;
}

/*
Host page shim, for a renderer whose platform is not itself a browser page.

The WebView is the *host page*, not the sandbox. It creates a real
`<iframe sandbox="allow-scripts" srcdoc>`, sets up a `MessageChannel`, and
transfers `port2` to the frame -- the specification's Host Page algorithm,
unmodified, because both ends are ordinary web contexts inside one document.

Only the last hop is platform-specific: relaying the resulting status out to the
React Native application. That hop is outside the sandbox boundary and has no
spec-defined semantics, so an implementation may use whatever its platform
offers.
*/
const HOST_SHIM = `
(function() {
  var frame = document.getElementById('render-method-frame');
  var relayed = false;

  function relay(message) {
    if(relayed) {
      return;
    }
    relayed = true;
    var bridge = window.ReactNativeWebView;
    if(bridge && typeof bridge.postMessage === 'function') {
      bridge.postMessage(JSON.stringify(message));
    }
  }

  frame.addEventListener('load', function() {
    var channel = new MessageChannel();
    channel.port1.onmessage = function(event) {
      relay(event.data);
    };
    channel.port1.start();
    frame.contentWindow.postMessage('render-method-port', '*',
      [channel.port2]);
  });
})();`;

// ============
// Public API
// ============

/**
 * Check whether a credential offers an HTML render method.
 *
 * @param {object} options - Options object.
 * @param {object} options.credential - The verifiable credential.
 * @returns {boolean} `true` if an HTML render method is present and usable.
 */
export function supportsHtmlRendering({credential} = {}) {
  try {
    return findHtmlRenderMethod({credential}) !== null;
  } catch {
    return false;
  }
}

/*
The set of credentials the host application has cleared for rendering.

Empty until `setRenderPolicy` is called, so the default is deny-all: an
integration that never sets a policy renders nothing, rather than running
issuer JavaScript on everything the holder owns.
*/
let _allowedCredentials = [];

/**
 * Declare which credentials may be rendered.
 *
 * Rendering executes issuer-supplied JavaScript. Containment rests on the
 * sandboxed iframe and the CSP, but those have only been verified in Chromium
 * -- not on the platform engines -- so a host application must say explicitly
 * which credentials it accepts that risk for. There is no "render anything"
 * setting; the caller passes the actual objects.
 *
 * Identity is by object reference rather than by `id`, because a scanned
 * credential can claim any `id` it likes but cannot be an object the host
 * application already held. Pass credentials your code constructed or loaded
 * deliberately -- never one straight off a scanner.
 *
 * @param {object} options - Options object.
 * @param {Array<object>} options.credentials - The credentials to allow.
 */
export function setRenderPolicy({credentials = []} = {}) {
  if(!Array.isArray(credentials)) {
    throw new TypeError('"credentials" must be an array.');
  }
  // Copied, so a later mutation of the caller's array cannot widen the policy
  // after the fact.
  _allowedCredentials = [...credentials];
}

/**
 * Check whether a credential has been cleared for rendering.
 *
 * False for everything until `setRenderPolicy` establishes otherwise.
 *
 * @param {object} options - Options object.
 * @param {object} options.credential - The verifiable credential.
 * @returns {boolean} `true` only for a credential the host allowed.
 */
export function isRenderAllowed({credential} = {}) {
  // `includes` uses SameValueZero, so an absent credential would match an
  // `undefined` entry. Refuse non-objects outright rather than rely on the
  // caller never passing one in.
  if(credential === null || typeof credential !== 'object') {
    return false;
  }
  return _allowedCredentials.includes(credential);
}

/*
The language tags the host application wants templates to render in, most
preferred first.

Defaults to English rather than to the device locale: this module is pure and
has no device to ask, and a wallet that never sets a preference should get a
predictable value rather than one that varies by handset.
*/
let _languages = ['en'];

/* A conservative BCP 47 shape: subtags of letters or digits, 1-8 characters,
separated by hyphens. Deliberately not a full RFC 5646 parser -- the value is
interpolated into a script element, so the test it has to pass is "cannot be
anything but a language tag", which this does. */
const LANGUAGE_TAG = /^[a-zA-Z0-9]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/;

/**
 * Declare the language the issuer's template should render in.
 *
 * The template reads the standard `navigator.language` and
 * `navigator.languages`; this is what those return inside the sandbox. A
 * template therefore needs no wallet-specific API to localize itself, and the
 * same template localizes identically in a browser wallet that sets these the
 * same way.
 *
 * **This is not spec-defined.** The `html` render suite says nothing about
 * language, so a template has no conformant way to learn the holder's. See
 * `docs/render-method-sandbox-requirements.md`.
 *
 * Two reasons the host value replaces the engine's rather than supplementing
 * it. The holder's language preference is a wallet setting, and a wallet whose
 * UI is in French should not hand a card that renders in the phone's German.
 * And `navigator.language` inside the sandbox would otherwise be the device
 * locale -- a fingerprinting signal the holder never agreed to give an issuer.
 *
 * @param {object} options - Options object.
 * @param {Array<string>} options.languages - BCP 47 tags, most preferred first.
 */
export function setLanguagePreference({languages = ['en']} = {}) {
  if(!Array.isArray(languages)) {
    throw new TypeError('"languages" must be an array of BCP 47 tags.');
  }
  if(languages.length === 0) {
    throw new TypeError('"languages" must have at least one language tag.');
  }
  for(const language of languages) {
    if(typeof language !== 'string' || !LANGUAGE_TAG.test(language)) {
      throw new TypeError(
        `"${language}" is not a well-formed BCP 47 language tag.`);
    }
  }
  // Copied, so a later mutation of the caller's array cannot change what
  // templates see after the fact.
  _languages = [...languages];
}

/**
 * Get the language preference templates currently render in.
 *
 * @returns {Array<string>} BCP 47 tags, most preferred first.
 */
export function getLanguagePreference() {
  return [..._languages];
}

/**
 * Find the HTML render method on a credential.
 *
 * A render method with no `template` is unusable, so it is not returned.
 *
 * @param {object} options - Options object.
 * @param {object} options.credential - The verifiable credential.
 * @returns {object|null} The HTML render method, or `null` if there is none.
 */
export function findHtmlRenderMethod({credential} = {}) {
  let renderMethods = credential?.renderMethod;
  if(!renderMethods) {
    return null;
  }

  // a single render method need not be wrapped in an array
  if(!Array.isArray(renderMethods)) {
    renderMethods = [renderMethods];
  }

  for(const renderMethod of renderMethods) {
    if(renderMethod?.type === TEMPLATE_RENDER_METHOD &&
      renderMethod?.renderSuite === HTML_RENDER_SUITE &&
      renderMethod?.template !== undefined) {
      return renderMethod;
    }
  }

  return null;
}

/**
 * Render a credential to a self-contained HTML document.
 *
 * @param {object} options - Options object.
 * @param {object} options.credential - The verifiable credential.
 * @returns {object} The document to display (`html`), the render method's name
 *   (`name`), and any non-fatal problems encountered (`warnings`), such as a
 *   `renderProperty` pointer that did not match the credential.
 * @throws {Error} If the credential has no HTML render method, or the template
 *   is malformed.
 */
export function renderToHtml({credential} = {}) {
  const renderMethod = findHtmlRenderMethod({credential});
  if(!renderMethod) {
    throw new Error(
      'The verifiable credential does not support HTML rendering.');
  }

  const decoded = _decodeTemplate({template: renderMethod.template});
  const {markup, warnings: fragmentWarnings} = _toFragment({markup: decoded});
  const {selected, warnings} = _filterCredential({credential, renderMethod});

  return {
    html: _assembleDocument({markup, selected}),
    name: renderMethod.name,
    warnings: [
      ...fragmentWarnings,
      ...warnings,
      ..._checkOutputPreference({renderMethod})
    ]
  };
}

/**
 * Verify a template against its `digestMultibase`, if it carries one.
 *
 * Per the spec, `digestMultibase` is an optional multibase-encoded multihash
 * of the template file: the multibase value must be `u` (base64url-nopad) and
 * the multihash must be SHA-2 with 256 bits of output (`0x12`).
 *
 * For a `data:` template the bytes travel inside the credential, so a signature
 * over the credential already covers them and the digest is a consistency check
 * rather than the integrity anchor it is for a remote template. A mismatch
 * still means something is wrong — a template altered after the digest was
 * computed — so it must not render.
 *
 * Async because it uses `crypto.subtle.digest`. A synchronous alternative would
 * mean either `node:crypto` (deliberately absent from this app's bundle) or
 * hand-rolled SHA-256, and the hash costs ~0.01ms on a typical template, so the
 * platform implementation is worth an async signature.
 *
 * @param {object} options - Options object.
 * @param {object} options.credential - The verifiable credential.
 * @returns {Promise<{verified: boolean|null, reason: string}>} `verified` is
 *   `true` on a match, `false` on a mismatch or an unusable digest, and `null`
 *   when there is no digest to check — which is conformant, since the property
 *   is optional.
 */
export async function verifyTemplateDigest({credential} = {}) {
  const renderMethod = findHtmlRenderMethod({credential});
  const template = renderMethod?.template;
  const digestMultibase = template?.digestMultibase;

  if(typeof digestMultibase !== 'string' || digestMultibase === '') {
    return {
      verified: null,
      reason: 'Render method has no "digestMultibase"; nothing to verify.'
    };
  }

  let decoded;
  try {
    decoded = _decodeMultibase({value: digestMultibase});
  } catch(e) {
    return {verified: false, reason: e.message};
  }

  const {bytes: multihash, note} = decoded;

  // Multihash header: 0x12 identifies sha2-256, followed by the digest length.
  if(multihash[0] !== 0x12 || multihash[1] !== 0x20) {
    return {
      verified: false,
      reason: 'Template "digestMultibase" must be a SHA-2-256 multihash ' +
        '(0x12, 32 bytes); found ' +
        `0x${multihash[0]?.toString(16)} with length ${multihash[1]}.`
    };
  }
  if(multihash.length !== 34) {
    return {
      verified: false,
      reason: 'Template "digestMultibase" multihash is ' +
        `${multihash.length} bytes; expected 34.`
    };
  }

  const markup = _decodeTemplate({template});
  const actual = new Uint8Array(await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(markup)));

  const expected = multihash.subarray(2);
  let equal = actual.length === expected.length;
  for(let i = 0; i < expected.length; ++i) {
    equal = equal && actual[i] === expected[i];
  }

  if(!equal) {
    return {
      verified: false,
      reason: 'Template does not match its "digestMultibase"; it may have ' +
        'been altered after the credential was issued.'
    };
  }

  return {verified: true, reason: note ?? 'Template matches its digest.'};
}

/**
 * Decode a multibase value to bytes.
 *
 * The spec requires the `u` prefix (base64url-nopad). Every example in the spec
 * uses `z` (base58btc) instead — the `zQm…` values — so a credential built by
 * copying those examples would fail a strict reading. Both are accepted, and
 * `z` is reported as off-spec rather than silently treated as equivalent.
 *
 * @private
 * @param {object} options - Options object.
 * @param {string} options.value - The multibase-encoded value.
 * @returns {{bytes: Uint8Array, note: string|undefined}} The decoded bytes.
 */
function _decodeMultibase({value} = {}) {
  const prefix = value[0];
  const body = value.slice(1);

  if(prefix === 'u') {
    return {bytes: _fromBase64url({value: body})};
  }
  if(prefix === 'z') {
    return {
      bytes: _fromBase58btc({value: body}),
      note: 'Template digest uses multibase "z" (base58btc); the render ' +
        'method specification requires "u" (base64url-nopad), though its ' +
        'own examples use "z".'
    };
  }

  throw new Error(
    `Unsupported multibase prefix "${prefix}" in "digestMultibase"; ` +
    'expected "u" (base64url-nopad).');
}

/**
 * Decode base64url-nopad to bytes.
 *
 * `atob` exists in React Native and Node; `Buffer` does not in React Native.
 *
 * @private
 * @param {object} options - Options object.
 * @param {string} options.value - The base64url payload.
 * @returns {Uint8Array} The decoded bytes.
 */
function _fromBase64url({value} = {}) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(
    base64.length + ((4 - (base64.length % 4)) % 4), '=');
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Template "digestMultibase" is not valid base64url.');
  }
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decode base58btc to bytes.
 *
 * @private
 * @param {object} options - Options object.
 * @param {string} options.value - The base58btc payload.
 * @returns {Uint8Array} The decoded bytes.
 */
function _fromBase58btc({value} = {}) {
  /* Accumulate big-endian by repeated multiply-and-add, little-endian in
  `bytes`, then reverse. Started empty rather than seeded with a zero: a seed
  would survive as a spurious leading byte when the value encodes only zeros. */
  const bytes = [];
  for(const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if(digit === -1) {
      throw new Error(
        'Template "digestMultibase" is not valid base58btc.');
    }
    let carry = digit;
    for(let i = 0; i < bytes.length; ++i) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while(carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  /* Each leading '1' is one leading zero byte. Pushing here appends to the
  little-endian tail, which becomes the front after the reverse below. */
  for(const char of value) {
    if(char !== '1') {
      break;
    }
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

/**
 * Render a credential to a host page that sandboxes it in a real iframe.
 *
 * Use this where the display surface is not itself a browser page — a React
 * Native `WebView`, for example. The returned document is the *host page*: it
 * contains a sandboxed `<iframe srcdoc>` holding the document `renderToHtml`
 * produces, and the specification's `MessageChannel` setup for talking to it.
 *
 * The template therefore runs in a standard sandboxed iframe on every platform
 * and makes the same calls everywhere.
 *
 * @param {object} options - Options object.
 * @param {object} options.credential - The verifiable credential.
 * @returns {object} The host page to display (`html`), the render method's name
 *   (`name`), and any non-fatal problems encountered (`warnings`).
 * @throws {Error} If the credential has no HTML render method, or the template
 *   is malformed.
 */
export async function renderHostPage({credential} = {}) {
  const {html: sandboxed, name, warnings} = renderToHtml({credential});
  const renderMethod = findHtmlRenderMethod({credential});

  /* A template that does not match its own digest must not run: something
  altered it after the credential was issued. An absent digest is conformant --
  the property is optional -- so it only blocks on an actual mismatch. */
  const digest = await verifyTemplateDigest({credential});
  if(digest.verified === false) {
    throw new Error(digest.reason);
  }
  // A verified-but-off-spec encoding is worth surfacing, not blocking.
  if(digest.verified === true && /multibase/i.test(digest.reason)) {
    warnings.push(digest.reason);
  }

  /* `outputPreference.style` carries width/height "to be set on the iframe",
  and the spec says an implementation SHOULD follow it. Defaults fill the
  WebView. */
  const style = renderMethod?.outputPreference?.style ?? {};
  const width = _cssLength({value: style.width}) ?? '100%';
  const height = _cssLength({value: style.height}) ?? '100vh';

  return {
    html: `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="content-security-policy" content="${HOST_CSP}">
<style>
html, body {margin: 0; padding: 0; background: transparent;}
#render-method-frame {
  display: block; width: ${width}; height: ${height}; border: 0;
}
</style>
</head>
<body>
<iframe id="render-method-frame" sandbox="allow-scripts" srcdoc="${
  _escapeAttribute({value: sandboxed})}"></iframe>
<script class="render-method-host">${HOST_SHIM}</script>
</body>
</html>`,
    name,
    warnings
  };
}

// ==================
// Template decoding
// ==================

/**
 * Decode an HTML template to markup.
 *
 * Accepts a `data:text/html;base64,…` URL, a plain `data:text/html,…` URL, or
 * raw markup with no prefix.
 *
 * @private
 * @param {object} options - Options object.
 * @param {string} options.template - The template from the render method.
 * @returns {string} The decoded markup.
 */
function _decodeTemplate({template} = {}) {
  /* The spec allows `template` to be a URL *or* a map of
  `{id, mediaType, digestMultibase}`. In the map form the template is at `id`;
  a `data:` id needs no fetching and is usable directly. */
  if(template !== null && typeof template === 'object') {
    const {id} = template;
    if(typeof id !== 'string') {
      throw new TypeError('Render method "template.id" must be a string.');
    }
    if(!id.startsWith('data:')) {
      /* A remote template must be preloaded and checked against
      `digestMultibase` before it is injected -- that is why the spec requires
      `frame-src 'none'`. This prototype does no fetching, so refuse rather than
      render an empty card. */
      throw new Error(
        'A remote template URL is not supported; the template must be a ' +
        'data: URL so it can be verified before rendering.');
    }
    return _decodeTemplate({template: id});
  }

  if(typeof template !== 'string') {
    throw new TypeError('Render method "template" must be a string or a map.');
  }

  // raw markup, no data URL wrapper
  if(!template.startsWith('data:')) {
    return template;
  }

  const match = template.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
  if(!match) {
    throw new Error('Invalid data URL format for HTML template.');
  }

  const [, mediaType, base64, data] = match;
  if(mediaType !== 'text/html') {
    throw new Error(
      'Invalid data URL media type. HTML templates must use "text/html". ' +
      `Found: "${mediaType}"`);
  }

  return base64 ? _decodeBase64({data}) : decodeURIComponent(data);
}

/**
 * Reduce a template to the HTML fragment the spec requires.
 *
 * The spec says template code "MUST NOT include any `<html>`, `<head>`, or
 * `<body>` tags, as these will be provided by the wrapper code". A template
 * that includes them anyway would nest a second document inside the wrapper,
 * which browsers recover from unpredictably, so unwrap it and say so.
 *
 * `<head>` content is dropped rather than hoisted: a template's `<head>` could
 * carry its own `<meta>` CSP, and letting that into the wrapper would let a
 * template weaken the policy that contains it.
 *
 * @private
 * @param {object} options - Options object.
 * @param {string} options.markup - The decoded template markup.
 * @returns {{markup: string, warnings: Array<string>}} The fragment and any
 *   note about what was removed.
 */
function _toFragment({markup} = {}) {
  if(!/<(?:html|head|body)[\s>]/i.test(markup)) {
    return {markup, warnings: []};
  }

  const warnings = [
    'Template included <html>, <head>, or <body> tags, which the render ' +
    'method specification does not allow; they were removed and any <head> ' +
    'content was dropped.'
  ];

  // Prefer the body's contents; otherwise strip the document tags in place.
  const body = markup.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if(body) {
    return {markup: body[1].trim(), warnings};
  }

  const stripped = markup
    .replace(/<\/?(?:html|body)[^>]*>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?head[^>]*>/gi, '');
  return {markup: stripped.trim(), warnings};
}

/**
 * Note any `outputPreference` this renderer cannot honor.
 *
 * `outputPreference` is advisory — the spec says an implementation SHOULD
 * follow it. This renderer is visual, so an `accessMode` asking for something
 * else is reported rather than silently ignored.
 *
 * @private
 * @param {object} options - Options object.
 * @param {object} options.renderMethod - The HTML render method.
 * @returns {Array<string>} Warnings, if any.
 */
function _checkOutputPreference({renderMethod} = {}) {
  const accessMode = renderMethod?.outputPreference?.accessMode;
  if(!Array.isArray(accessMode) || accessMode.length === 0) {
    return [];
  }
  if(accessMode.includes('visual')) {
    return [];
  }
  return [
    `Render method requests accessMode ${JSON.stringify(accessMode)}, but ` +
    'this renderer is visual only.'
  ];
}

/**
 * Decode base64 to a UTF-8 string.
 *
 * React Native provides `atob` but not `Buffer`, so prefer `atob` and decode
 * the resulting byte string as UTF-8 rather than assuming latin1.
 *
 * @private
 * @param {object} options - Options object.
 * @param {string} options.data - The base64 payload.
 * @returns {string} The decoded string.
 */
function _decodeBase64({data} = {}) {
  const binary = atob(data);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// ===================================
// renderProperty filtering
// ===================================

/**
 * Reduce a credential to the fields named by `renderProperty`.
 *
 * `selectJsonLd` throws if any pointer does not match the document. A stale
 * pointer in an issuer's render method should not take the whole card down, so
 * pointers are resolved one at a time and failures are collected as warnings.
 *
 * Absent or empty `renderProperty` means the issuer selected nothing, so
 * nothing is sent.
 *
 * @private
 * @param {object} options - Options object.
 * @param {object} options.credential - The verifiable credential.
 * @param {object} options.renderMethod - The HTML render method.
 * @returns {{selected: object|null, warnings: Array<string>}} The filtered
 *   credential and any pointers that failed to resolve.
 */
function _filterCredential({credential, renderMethod} = {}) {
  const {renderProperty} = renderMethod;
  const warnings = [];

  /* A bare string has a `length`, so it would pass a naive emptiness check and
  then be iterated character by character. Since `/` is a valid root pointer,
  one character would select the entire credential. */
  if(renderProperty !== undefined && !Array.isArray(renderProperty)) {
    warnings.push(
      'Render method "renderProperty" must be an array of JSON pointers; ' +
      'no credential data was sent to the template.');
    return {selected: null, warnings};
  }

  // `renderMethod` and `proof` are stripped first: a template has no need for
  // its own definition or for the signature over the credential.
  const document = {...credential};
  delete document.renderMethod;
  delete document.proof;

  /* Spec: "If `renderMethod.renderProperty` is not present, the entire
  verifiable credential is used." The issuer minimized nothing, so surface that
  rather than only obeying it -- a holder should be able to tell the difference
  between a render method that named three fields and one that named none. */
  if(!(renderProperty?.length > 0)) {
    warnings.push(
      'Render method has no "renderProperty", so the entire credential was ' +
      'sent to the template.');
    return {selected: document, warnings};
  }

  const usable = [];
  for(const pointer of renderProperty) {
    if(typeof pointer !== 'string') {
      warnings.push(
        `Render property ${JSON.stringify(pointer)} is not a JSON pointer ` +
        'string and was ignored.');
      continue;
    }

    /* An empty pointer, or one that is only a separator, addresses the whole
    document. Honoring it would hand the template every field while looking like
    an ordinary selection, defeating the point of `renderProperty`. */
    if(pointer === '' || pointer === '/') {
      warnings.push(
        `Render property "${pointer}" selects the whole credential and was ` +
        'ignored; list the fields the template needs instead.');
      continue;
    }

    try {
      selectJsonLd({document, pointers: [pointer]});
      usable.push(pointer);
    } catch(e) {
      warnings.push(
        `Render property "${pointer}" did not match the credential: ` +
        `${e.message}`);
    }
  }

  if(usable.length === 0) {
    return {selected: null, warnings};
  }

  return {selected: selectJsonLd({document, pointers: usable}), warnings};
}

// =====================
// Document assembly
// =====================

/**
 * Assemble the final document from decoded markup and selected data.
 *
 * @private
 * @param {object} options - Options object.
 * @param {string} options.markup - The decoded template markup.
 * @param {object|null} options.selected - The filtered credential, if any.
 * @returns {string} A self-contained HTML document.
 */
function _assembleDocument({markup, selected} = {}) {
  const payload = _encodePayload({selected});

  /* The wrapper is in `<head>`, ahead of the template markup, because a
  template that renders synchronously may call `renderMethodReady()` as soon as
  its own script runs.

  The language override comes first of all: a template may read
  `navigator.language` at parse time, and by then it must already be the host's
  value rather than the device's. */
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="content-security-policy" content="${CSP}">
<script class="render-method-language">${
  _languageOverride({languages: _languages})}</script>
<script name="credential" type="application/vc">${payload}</script>
<script class="render-method-wrapper">${WRAPPER_CODE}</script>
</head>
<body>
${markup}
</body>
</html>`;
}

/**
 * Serialize the selected credential for embedding in a script element.
 *
 * The payload is credential data, which is not necessarily trustworthy markup.
 * Escaping `<` prevents a value containing `</script>` from closing the element
 * and becoming live markup. `JSON.parse` reverses the escape transparently, so
 * templates need no special handling.
 *
 * @private
 * @param {object} options - Options object.
 * @param {object|null} options.selected - The filtered credential, if any.
 * @returns {string} JSON safe to place inside a script element.
 */
function _encodePayload({selected} = {}) {
  return JSON.stringify(selected ?? {}, null, 2).replaceAll('<', '\\u003c');
}

/**
 * Validate an issuer-supplied CSS length.
 *
 * `outputPreference.style` comes from the credential, so it is untrusted input
 * that would land inside a `<style>` block on the host page. Interpolating it
 * directly would let a render method inject arbitrary CSS — or close the block
 * and add markup — so accept only a plain number with a known unit and reject
 * everything else.
 *
 * @private
 * @param {object} options - Options object.
 * @param {*} options.value - The candidate length.
 * @returns {string|null} The value if it is a safe CSS length, else `null`.
 */
function _cssLength({value} = {}) {
  if(typeof value !== 'string') {
    return null;
  }
  return /^\d+(?:\.\d+)?(?:px|%|vh|vw|em|rem)$/.test(value.trim()) ?
    value.trim() : null;
}

/**
 * Escape a value for use inside a double-quoted HTML attribute.
 *
 * The sandboxed document goes into the host page's `srcdoc` attribute, and it
 * contains issuer-supplied markup. An unescaped `"` would close the attribute
 * early and the remainder would become markup in the *host page* — outside the
 * sandbox. `&` is escaped first so the other replacements cannot be re-formed.
 *
 * @private
 * @param {object} options - Options object.
 * @param {string} options.value - The value to escape.
 * @returns {string} The escaped value.
 */
function _escapeAttribute({value} = {}) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export default {
  findHtmlRenderMethod,
  getLanguagePreference,
  isRenderAllowed,
  renderHostPage,
  renderToHtml,
  setLanguagePreference,
  setRenderPolicy,
  supportsHtmlRendering,
  verifyTemplateDigest
};
