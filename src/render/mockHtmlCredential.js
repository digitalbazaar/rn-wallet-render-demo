/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Synthetic credentials carrying HTML render methods, for the render method
 * experiment.
 *
 * **All data here is fabricated**, following the same rules as
 * `src/wallet/mockCredentials.js`: a fictional jurisdiction (Utopia), obvious
 * test values, and `DoNotTrust` issuer DIDs. Each rendered card labels itself
 * as sample data so a screenshot cannot be mistaken for a real credential.
 *
 * This lives apart from `mockCredentials.js` so the experiment does not change
 * the wallet's existing credential list.
 *
 * Each template is written the way an issuer would write one: it reads its data
 * from the injected `<script type="application/vc">` element rather than
 * expecting `{{mustache}}` interpolation, which is what distinguishes the
 * `html` suite from `SvgRenderingTemplate2024`.
 *
 * The four cards are deliberately unalike -- a dark badge, a light perforated
 * ticket, a wide landscape membership card, and a library card that localizes
 * itself -- because a single template would not show that the layout is the
 * issuer's choice rather than the wallet's.
 */

export const ISSUER_UTOPIA_FIRE =
  'did:key:z6MkUtopiaFireMockIssuerDoNotTrust00001';

export const ISSUER_UTOPIA_TRANSIT =
  'did:key:z6MkUtopiaTransitMockIssuerDoNotTrust02';

export const ISSUER_UTOPIA_ARBORETUM =
  'did:key:z6MkUtopiaArbMockIssuerDoNotTrust000003';

export const ISSUER_UTOPIA_LIBRARY =
  'did:key:z6MkUtopiaLibMockIssuerDoNotTrust000004';

const HOLDER = 'did:key:z6MkHolderMockSubjectDoNotTrust0000004';

/**
 * The issuer-authored HTML template.
 *
 * Deliberately plain: the point of the experiment is that arbitrary issuer HTML
 * and JavaScript renders on device, not that this particular card looks good.
 * It uses no external resources, which the emitted CSP would block anyway.
 */
export const DEMO_HTML_TEMPLATE = `
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    font-family: -apple-system, Roboto, system-ui, sans-serif;
    background: transparent;
  }
  .card {
    border-radius: 16px;
    padding: 18px;
    background: linear-gradient(150deg, #1d4f4a, #123230);
    color: #fff;
  }
  .head { display: flex; align-items: center; gap: 12px; }
  .seal {
    width: 44px; height: 44px; border-radius: 10px;
    background: rgba(255,255,255,.16);
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 15px;
  }
  h1 { font-size: 16px; margin: 0; }
  .issuer { font-size: 13px; margin: 2px 0 0; color: #bfdcd8; }
  dl { margin: 16px 0 0; }
  dt {
    font-size: 11px; font-weight: 600; letter-spacing: .4px;
    text-transform: uppercase; color: #bfdcd8;
  }
  dd { font-size: 15px; margin: 2px 0 10px; }
  .tag {
    font-size: 9px; font-weight: 700; letter-spacing: .6px;
    color: #bfdcd8; margin-top: 4px;
  }
  .err { font-size: 12px; color: #ffb3b3; }
</style>

<div class="card">
  <div class="head">
    <div class="seal">UFD</div>
    <div>
      <h1 id="title">—</h1>
      <p class="issuer" id="issuer">—</p>
    </div>
  </div>
  <dl id="rows"></dl>
  <p class="tag">SAMPLE DATA · NOT A REAL CREDENTIAL</p>
</div>

<script>
  // Read the credential the wallet injected. Only the fields the render method
  // listed in "renderProperty" are present.
  function readCredential() {
    var el = document.querySelector('script[type="application/vc"]');
    return el ? JSON.parse(el.textContent) : {};
  }

  function text(id, value) {
    document.getElementById(id).textContent = value || '—';
  }

  try {
    var vc = readCredential();
    var subject = vc.credentialSubject || {};
    var issuer = vc.issuer || {};

    text('title', subject.jobTitle);
    text('issuer', typeof issuer === 'string' ? issuer : issuer.name);

    var rows = [
      ['Holder', subject.name],
      ['Badge number', subject.badgeNumber],
      ['Jurisdiction', subject.jurisdiction]
    ];

    var dl = document.getElementById('rows');
    rows.forEach(function(row) {
      if(!row[1]) { return; }
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.textContent = row[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });

    // Tell the wallet rendering finished. Provided by the wrapper code the
    // render method emits; required by the html suite.
    if(window.renderMethodReady) { window.renderMethodReady(); }
  } catch(e) {
    var p = document.createElement('p');
    p.className = 'err';
    p.textContent = 'Template error: ' + e.message;
    document.body.appendChild(p);
    if(window.renderMethodReady) { window.renderMethodReady(e); }
  }
</script>
`;

/**
 * A transit day-pass template.
 *
 * Light rather than dark, and shaped like a torn ticket stub, so the list shows
 * two cards that share nothing but the mechanism. It also draws a barcode from
 * pure CSS -- no external image, which the CSP would block.
 */
export const TICKET_HTML_TEMPLATE = `
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    font-family: -apple-system, Roboto, system-ui, sans-serif;
    background: transparent;
  }
  .ticket {
    border-radius: 14px;
    background: #fdfbf4;
    color: #22201a;
    overflow: hidden;
    border: 1px solid #e6e0cd;
  }
  .top { padding: 16px 18px 12px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; }
  h1 { font-size: 17px; margin: 0; letter-spacing: -.2px; }
  .issuer { font-size: 12px; margin: 3px 0 0; color: #7c7461; }
  .zone {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .5px; color: #a8642a;
  }
  .rip {
    border-top: 2px dashed #e0d9c4;
    margin: 4px 0 0;
    position: relative;
  }
  .grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px;
    padding: 14px 18px 4px;
  }
  .k {
    font-size: 10px; font-weight: 600; letter-spacing: .4px;
    text-transform: uppercase; color: #7c7461;
  }
  .v { font-size: 14px; margin-top: 2px; }
  .code {
    display: flex; gap: 2px; align-items: flex-end;
    height: 34px; padding: 8px 18px 14px;
  }
  .code i { display: block; width: 2px; background: #22201a; height: 100%; }
  .tag {
    font-size: 9px; font-weight: 700; letter-spacing: .6px;
    color: #7c7461; padding: 0 18px 12px;
  }
  .err { font-size: 12px; color: #a8342a; padding: 0 18px 12px; }
</style>

<div class="ticket">
  <div class="top">
    <div class="row">
      <h1 id="title">—</h1>
      <span class="zone" id="zone">—</span>
    </div>
    <p class="issuer" id="issuer">—</p>
  </div>
  <div class="rip"></div>
  <dl class="grid" id="rows"></dl>
  <div class="code" id="code"></div>
  <p class="tag">SAMPLE DATA · NOT A REAL CREDENTIAL</p>
</div>

<script>
  function readCredential() {
    var el = document.querySelector('script[type="application/vc"]');
    return el ? JSON.parse(el.textContent) : {};
  }

  try {
    var vc = readCredential();
    var subject = vc.credentialSubject || {};
    var issuer = vc.issuer || {};

    document.getElementById('title').textContent = subject.passType || '—';
    document.getElementById('zone').textContent = subject.zone || '—';
    document.getElementById('issuer').textContent =
      typeof issuer === 'string' ? issuer : (issuer.name || '—');

    var rows = [
      ['Passenger', subject.name],
      ['Pass number', subject.passNumber],
      ['Valid through', subject.validThrough],
      ['Fare class', subject.fareClass]
    ];

    var dl = document.getElementById('rows');
    rows.forEach(function(row) {
      if(!row[1]) { return; }
      var wrap = document.createElement('div');
      var dt = document.createElement('dt');
      dt.className = 'k';
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.className = 'v';
      dd.style.margin = '0';
      dd.textContent = row[1];
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      dl.appendChild(wrap);
    });

    /* A decorative barcode derived from the pass number, so the bars differ
    per credential without pulling in an image the CSP would block. */
    var seed = String(subject.passNumber || '');
    var code = document.getElementById('code');
    for(var i = 0; i < 44; ++i) {
      var bar = document.createElement('i');
      var n = seed.charCodeAt(i % (seed.length || 1)) || 48;
      bar.style.height = (((n * (i + 3)) % 70) + 30) + '%';
      code.appendChild(bar);
    }

    if(window.renderMethodReady) { window.renderMethodReady(); }
  } catch(e) {
    var p = document.createElement('p');
    p.className = 'err';
    p.textContent = 'Template error: ' + e.message;
    document.body.appendChild(p);
    if(window.renderMethodReady) { window.renderMethodReady(e); }
  }
</script>
`;

/**
 * An arboretum membership template.
 *
 * Landscape and photo-less, leaning on a CSS pattern rather than a portrait, to
 * show a third layout shape. It also renders an expiry state computed in the
 * template, which is the kind of logic that motivates shipping JavaScript at
 * all rather than a static image.
 */
export const MEMBERSHIP_HTML_TEMPLATE = `
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    font-family: ui-rounded, -apple-system, Roboto, system-ui, sans-serif;
    background: transparent;
  }
  .card {
    position: relative;
    border-radius: 18px;
    padding: 20px;
    background:
      radial-gradient(circle at 12% 20%, rgba(255,255,255,.22), transparent),
      linear-gradient(115deg, #3f5d2e, #6d8f3a 62%, #93ad4e);
    color: #f7fbef;
    overflow: hidden;
  }
  .leaf {
    position: absolute; right: -26px; top: -26px;
    width: 128px; height: 128px; border-radius: 50%;
    background: rgba(255,255,255,.10);
  }
  .kind {
    font-size: 10px; font-weight: 700; letter-spacing: 1.2px;
    text-transform: uppercase; color: #dcecc2;
  }
  h1 { font-size: 21px; margin: 6px 0 0; letter-spacing: -.3px; }
  .issuer { font-size: 12px; margin: 4px 0 0; color: #dcecc2; }
  .foot {
    display: flex; justify-content: space-between; align-items: flex-end;
    margin-top: 22px; gap: 12px;
  }
  .k {
    font-size: 10px; font-weight: 600; letter-spacing: .4px;
    text-transform: uppercase; color: #dcecc2;
  }
  .v { font-size: 14px; margin-top: 2px; }
  .pill {
    font-size: 10px; font-weight: 700; letter-spacing: .4px;
    padding: 5px 10px; border-radius: 999px;
    background: rgba(255,255,255,.18); white-space: nowrap;
  }
  .tag {
    font-size: 9px; font-weight: 700; letter-spacing: .6px;
    color: #dcecc2; margin-top: 14px;
  }
  .err { font-size: 12px; color: #ffd9d9; }
</style>

<div class="card">
  <div class="leaf"></div>
  <p class="kind" id="kind">—</p>
  <h1 id="title">—</h1>
  <p class="issuer" id="issuer">—</p>
  <div class="foot">
    <div>
      <div class="k">Member since</div>
      <div class="v" id="since">—</div>
    </div>
    <div>
      <div class="k">Member number</div>
      <div class="v" id="number">—</div>
    </div>
    <span class="pill" id="status">—</span>
  </div>
  <p class="tag">SAMPLE DATA · NOT A REAL CREDENTIAL</p>
</div>

<script>
  function readCredential() {
    var el = document.querySelector('script[type="application/vc"]');
    return el ? JSON.parse(el.textContent) : {};
  }

  function text(id, value) {
    document.getElementById(id).textContent = value || '—';
  }

  try {
    var vc = readCredential();
    var subject = vc.credentialSubject || {};
    var issuer = vc.issuer || {};

    text('kind', subject.membershipLevel);
    text('title', subject.name);
    text('issuer', typeof issuer === 'string' ? issuer : issuer.name);
    text('since', subject.memberSince);
    text('number', subject.memberNumber);

    /* Computed in the template rather than carried as a field: the point of an
    HTML render method over a static image is that the issuer can express this
    kind of derived state. */
    var until = subject.goodThrough;
    var status = 'Active';
    if(until) {
      var days = Math.ceil(
        (new Date(until).getTime() - new Date().getTime()) / 86400000);
      if(days < 0) {
        status = 'Expired';
      } else if(days <= 45) {
        status = 'Renews in ' + days + 'd';
      } else {
        status = 'Good through ' + until;
      }
    }
    text('status', status);

    if(window.renderMethodReady) { window.renderMethodReady(); }
  } catch(e) {
    var p = document.createElement('p');
    p.className = 'err';
    p.textContent = 'Template error: ' + e.message;
    document.body.appendChild(p);
    if(window.renderMethodReady) { window.renderMethodReady(e); }
  }
</script>
`;

/**
 * Base64-encode a UTF-8 string.
 *
 * React Native provides `btoa` but not `Buffer`, and `btoa` throws on
 * non-latin1 input, so encode to UTF-8 bytes first.
 *
 * @param {string} value - The string to encode.
 * @returns {string} The base64-encoded value.
 */
function _toBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for(const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * A library card template that localizes itself from `navigator.language`.
 *
 * This is the one template here that reads anything about its environment. It
 * picks a string table from the standard `navigator.language`, which inside the
 * sandbox is the value the wallet set through `setLanguagePreference`, not
 * the device locale.
 *
 * Written the way an issuer would write it, which is the point: no
 * wallet-specific API, no interpolation, and the same lookup a page would do in
 * a browser. It falls back to English on an unknown tag, and matches on the
 * primary subtag so `fr-CA` finds the French table.
 *
 * `Intl` formats the date, so the numerals and month order come from the same
 * tag rather than from a second, hand-rolled table.
 */
export const LIBRARY_HTML_TEMPLATE = `
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    font-family: -apple-system, Roboto, system-ui, sans-serif;
    background: transparent;
  }
  .card {
    border-radius: 16px;
    padding: 18px;
    background: linear-gradient(160deg, #3b2f6b, #241d45);
    color: #fff;
  }
  .head {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 10px;
  }
  /* The title wraps and the tag chip keeps its width: a long localized title
  would otherwise push the chip out of the card. */
  h1 { font-size: 16px; margin: 0; flex: 1 1 auto; min-width: 0; }
  .lang {
    font-size: 10px; font-weight: 700; letter-spacing: .5px;
    padding: 3px 7px; border-radius: 999px;
    background: rgba(255,255,255,.18); color: #d9d2ff;
    flex: 0 0 auto; white-space: nowrap;
  }
  .issuer { font-size: 13px; margin: 2px 0 0; color: #c3baf0; }
  dl { margin: 16px 0 0; }
  dt {
    font-size: 11px; font-weight: 600; letter-spacing: .4px;
    text-transform: uppercase; color: #c3baf0;
  }
  dd { font-size: 15px; margin: 2px 0 10px; }
  .tag {
    font-size: 9px; font-weight: 700; letter-spacing: .6px;
    color: #c3baf0; margin-top: 4px;
  }
  .err { font-size: 12px; color: #ffb3b3; }
</style>

<div class="card">
  <div class="head">
    <h1 id="title">&mdash;</h1>
    <span class="lang" id="lang">&mdash;</span>
  </div>
  <p class="issuer" id="issuer">&mdash;</p>
  <dl id="rows"></dl>
  <p class="tag" id="sample">&mdash;</p>
</div>

<script>
  // The issuer ships one table per language it supports.
  var STRINGS = {
    en: {
      title: 'Library Card', holder: 'Holder', number: 'Card number',
      expires: 'Expires',
      sample: 'SAMPLE DATA · NOT A REAL CREDENTIAL'
    },
    fr: {
      title: 'Carte de bibliothèque', holder: 'Titulaire',
      number: 'Numéro de carte', expires: 'Expire le',
      sample: 'DONNÉES D’EXEMPLE · CE N’EST PAS UNE VRAIE ATTESTATION'
    },
    ja: {
      title: '図書館利用カード',
      holder: '氏名', number: 'カード番号', expires: '有効期限',
      sample: 'サンプルデータ · 実在の証明書ではありません'
    }
  };

  function readCredential() {
    var el = document.querySelector('script[type="application/vc"]');
    return el ? JSON.parse(el.textContent) : {};
  }

  /* Match on the primary subtag so a regional tag finds its table: "fr-CA"
  and "fr" both select French. Unknown tags fall back to English rather than
  rendering an empty card. */
  function pickStrings(tag) {
    var primary = String(tag || 'en').toLowerCase().split('-')[0];
    return STRINGS[primary] || STRINGS.en;
  }

  function text(id, value) {
    document.getElementById(id).textContent = value || '—';
  }

  try {
    var vc = readCredential();
    var subject = vc.credentialSubject || {};
    var issuer = vc.issuer || {};

    // The wallet's language, not the device's.
    var tag = navigator.language;
    var t = pickStrings(tag);

    text('title', t.title);
    text('lang', tag);
    text('issuer', typeof issuer === 'string' ? issuer : issuer.name);
    text('sample', t.sample);

    var expires = subject.validThrough;
    if(expires) {
      try {
        expires = new Intl.DateTimeFormat(tag, {
          year: 'numeric', month: 'long', day: 'numeric'
        }).format(new Date(expires));
      } catch(e) {
        // Keep the ISO value if the tag is one Intl will not take.
      }
    }

    var rows = [
      [t.holder, subject.name],
      [t.number, subject.cardNumber],
      [t.expires, expires]
    ];

    var dl = document.getElementById('rows');
    rows.forEach(function(row) {
      if(!row[1]) { return; }
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.textContent = row[1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    });

    if(window.renderMethodReady) { window.renderMethodReady(); }
  } catch(e) {
    document.getElementById('rows').innerHTML =
      '<p class="err">' + String(e && e.message) + '</p>';
    if(window.renderMethodReady) { window.renderMethodReady(e); }
  }
</script>
`;

/**
 * A first-responder style credential offering an HTML render method.
 *
 * `renderProperty` deliberately omits `unselectedField`, which the credential
 * does carry. If the rendered card ever shows it, `renderProperty` filtering
 * has regressed.
 */
export const MOCK_HTML_CREDENTIAL = {
  '@context': [
    'https://www.w3.org/ns/credentials/v2',
    'https://w3id.org/vc/render-method/v2rc2'
  ],
  id: 'urn:uuid:55555555-5555-4555-8555-555555555555',
  type: ['VerifiableCredential', 'FirstResponderCredential'],
  issuer: {
    id: ISSUER_UTOPIA_FIRE,
    name: 'Utopia State Fire Training'
  },
  validFrom: '2026-01-15T00:00:00Z',
  validUntil: '2029-01-15T00:00:00Z',
  credentialSubject: {
    id: HOLDER,
    type: 'FirstResponder',
    name: 'SAMPLEHOLDER ALEX QUINN',
    jobTitle: 'Fire Fighter I',
    badgeNumber: 'UFD-00-0000-0000',
    jurisdiction: 'Utopia',
    // Not listed in `renderProperty`, so the render method must not expose it.
    // The generic card path does show it -- that contrast is the point.
    unselectedField: 'NOT-IN-RENDER-PROPERTY'
  },
  renderMethod: [{
    type: 'TemplateRenderMethod',
    renderSuite: 'html',
    name: 'Badge',
    mediaType: 'text/html',
    renderProperty: [
      '/issuer/name',
      '/credentialSubject/name',
      '/credentialSubject/jobTitle',
      '/credentialSubject/badgeNumber',
      '/credentialSubject/jurisdiction'
    ],
    /* The map form of `template`, so the demo exercises `digestMultibase`
    verification rather than leaving that path untested in the running app.

    The digest is a literal because this credential is a synchronous module
    constant and hashing is async. It will rot if `DEMO_HTML_TEMPLATE` changes,
    so a test recomputes it and fails on drift -- see
    `test/node/htmlRenderMethod.test.js`. */
    template: {
      id: `data:text/html;base64,${_toBase64(DEMO_HTML_TEMPLATE)}`,
      mediaType: 'text/html',
      digestMultibase: 'uEiC2ZGsFtjOZfm0qx8Lv80xuUzrFN3B_QUls1N9Pagbjvw'
    }
  }]
};

/**
 * A transit day-pass credential offering an HTML render method.
 *
 * Like the badge, `renderProperty` omits a field the credential carries
 * (`internalRouteCode`) so the filter stays under test from more than one
 * credential shape.
 */
export const MOCK_TICKET_CREDENTIAL = {
  '@context': [
    'https://www.w3.org/ns/credentials/v2',
    'https://w3id.org/vc/render-method/v2rc2'
  ],
  id: 'urn:uuid:66666666-6666-4666-8666-666666666666',
  type: ['VerifiableCredential', 'TransitPassCredential'],
  issuer: {
    id: ISSUER_UTOPIA_TRANSIT,
    name: 'Utopia Metro Transit'
  },
  validFrom: '2026-03-01T00:00:00Z',
  validUntil: '2027-03-01T00:00:00Z',
  credentialSubject: {
    id: HOLDER,
    type: 'TransitPassHolder',
    name: 'SAMPLEHOLDER ALEX QUINN',
    passType: 'Day Pass',
    passNumber: 'UMT-0000-0000-0000',
    zone: 'Zones 1–3',
    fareClass: 'Standard',
    validThrough: '2027-03-01',
    // Not listed in `renderProperty`; the rendered ticket must not show it.
    internalRouteCode: 'NOT-IN-RENDER-PROPERTY'
  },
  renderMethod: [{
    type: 'TemplateRenderMethod',
    renderSuite: 'html',
    name: 'Pass',
    mediaType: 'text/html',
    renderProperty: [
      '/issuer/name',
      '/credentialSubject/name',
      '/credentialSubject/passType',
      '/credentialSubject/passNumber',
      '/credentialSubject/zone',
      '/credentialSubject/fareClass',
      '/credentialSubject/validThrough'
    ],
    // Recomputed by the digest drift test, same as the badge above.
    template: {
      id: `data:text/html;base64,${_toBase64(TICKET_HTML_TEMPLATE)}`,
      mediaType: 'text/html',
      digestMultibase: 'uEiAQqfwX43VTI-PUBrdTfxc6PEZ1XrOfJvjaY7W9qUcoPg'
    }
  }]
};

/**
 * An arboretum membership credential offering an HTML render method.
 *
 * `goodThrough` is listed in `renderProperty` because the template computes the
 * renewal state from it -- a field selected for what the template does with it
 * rather than to print verbatim.
 */
export const MOCK_MEMBERSHIP_CREDENTIAL = {
  '@context': [
    'https://www.w3.org/ns/credentials/v2',
    'https://w3id.org/vc/render-method/v2rc2'
  ],
  id: 'urn:uuid:77777777-7777-4777-8777-777777777777',
  type: ['VerifiableCredential', 'MembershipCredential'],
  issuer: {
    id: ISSUER_UTOPIA_ARBORETUM,
    name: 'Utopia Arboretum Society'
  },
  validFrom: '2026-02-01T00:00:00Z',
  validUntil: '2027-02-01T00:00:00Z',
  credentialSubject: {
    id: HOLDER,
    type: 'Member',
    name: 'SAMPLEHOLDER ALEX QUINN',
    membershipLevel: 'Sustaining Member',
    memberNumber: 'UAS-000000',
    memberSince: '2019',
    goodThrough: '2027-02-01',
    // Not listed in `renderProperty`; the rendered card must not show it.
    householdNotes: 'NOT-IN-RENDER-PROPERTY'
  },
  renderMethod: [{
    type: 'TemplateRenderMethod',
    renderSuite: 'html',
    name: 'Membership',
    mediaType: 'text/html',
    renderProperty: [
      '/issuer/name',
      '/credentialSubject/name',
      '/credentialSubject/membershipLevel',
      '/credentialSubject/memberNumber',
      '/credentialSubject/memberSince',
      '/credentialSubject/goodThrough'
    ],
    // Recomputed by the digest drift test, same as the badge above.
    template: {
      id: `data:text/html;base64,${_toBase64(MEMBERSHIP_HTML_TEMPLATE)}`,
      mediaType: 'text/html',
      digestMultibase: 'uEiBvjCIJf_KFudbbOrXzwCezXEzwEHsYAqub24Me8QjPaA'
    }
  }]
};

/**
 * A library card whose template localizes itself.
 *
 * The other three cards are fixed-language. This one reads
 * `navigator.language` and renders in English, French, or Japanese from the
 * value the wallet set, which is what makes the language plumbing visible in
 * the running app rather than only in the tests.
 *
 * `validThrough` is in `renderProperty` because the template formats it with
 * `Intl`, so the date has to reach the template rather than arriving
 * pre-rendered.
 */
export const MOCK_LIBRARY_CREDENTIAL = {
  '@context': [
    'https://www.w3.org/ns/credentials/v2',
    'https://w3id.org/vc/render-method/v2rc2'
  ],
  id: 'urn:uuid:88888888-8888-4888-8888-888888888888',
  type: ['VerifiableCredential', 'LibraryCardCredential'],
  issuer: {
    id: ISSUER_UTOPIA_LIBRARY,
    name: 'Utopia Public Library'
  },
  validFrom: '2026-01-15T00:00:00Z',
  validUntil: '2030-01-15T00:00:00Z',
  credentialSubject: {
    id: HOLDER,
    type: 'LibraryPatron',
    name: 'SAMPLEHOLDER ALEX QUINN',
    cardNumber: 'UPL-0000-0000',
    homeBranch: 'Utopia Central',
    validThrough: '2030-01-15',
    // Not listed in `renderProperty`; the rendered card must not show it.
    unselectedField: 'NOT-IN-RENDER-PROPERTY'
  },
  renderMethod: [{
    type: 'TemplateRenderMethod',
    renderSuite: 'html',
    name: 'Library card',
    mediaType: 'text/html',
    renderProperty: [
      '/issuer/name',
      '/credentialSubject/name',
      '/credentialSubject/cardNumber',
      '/credentialSubject/validThrough'
    ],
    // Recomputed by the digest drift test, same as the badge above.
    template: {
      id: `data:text/html;base64,${_toBase64(LIBRARY_HTML_TEMPLATE)}`,
      mediaType: 'text/html',
      digestMultibase: 'uEiBQsQPXAfT1eqzP420BjBhS7qEFxUU8HwGBfSFyHwOJPg'
    }
  }]
};

/**
 * Every bundled demo credential, in the order the wallet lists them.
 *
 * `isDemoHtmlCredential` gates the render path on membership in this array, so
 * adding a credential here is what makes it renderable -- and nothing a holder
 * scans can join it.
 */
export const MOCK_HTML_CREDENTIALS = [
  MOCK_HTML_CREDENTIAL,
  MOCK_TICKET_CREDENTIAL,
  MOCK_MEMBERSHIP_CREDENTIAL,
  MOCK_LIBRARY_CREDENTIAL
];
