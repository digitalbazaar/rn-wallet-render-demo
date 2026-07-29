/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tests for the wallet's functional core: credential description, presentation
 * building, and scan classification.
 *
 * These are the parts the UI renders from, so getting them right off-device is
 * cheaper than debugging through a simulator.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyCredential, describeCredential, ISSUER_UTOPIA, MOCK_AGE_VERIFICATION,
  MOCK_CREDENTIALS, MOCK_DRIVERS_LICENSE, MOCK_INSURANCE_CARD,
  MOCK_PARKING_PLACARD
} from '../../src/wallet/mockCredentials.js';
import {
  classifyScan, describeScan, SCAN_KINDS, toInteractionArgs
} from '../../src/wallet/scanner.js';
import {
  createPresentation, describeDisclosure, fromQrPayload, QR_PREFIX,
  selectFields, toQrPayload
} from '../../src/wallet/presentation.js';
import {MOCK_HTML_CREDENTIAL} from '../../src/render/mockHtmlCredential.js';

/* --- mock credentials --- */

test('all four requested credentials exist', () => {
  assert.equal(MOCK_CREDENTIALS.length, 4);
  assert.deepEqual(
    MOCK_CREDENTIALS.map(classifyCredential),
    ['license', 'placard', 'age', 'insurance']);
});

test('DMV credentials are issued by Utopia, not a real agency', () => {
  // a prototype must not impersonate a real state agency
  for(const credential of [MOCK_DRIVERS_LICENSE, MOCK_PARKING_PLACARD]) {
    assert.equal(credential.issuer, ISSUER_UTOPIA);
    assert.match(
      credential.credentialSubject.issuingAuthority, /Utopia/,
      'issuing authority must be the fictional jurisdiction');
  }
});

test('no mock credential names a real jurisdiction or person', () => {
  const serialized = JSON.stringify(MOCK_CREDENTIALS);
  for(const forbidden of ['California', 'CA DMV', 'USAA', 'Scruggs']) {
    assert.equal(
      serialized.includes(forbidden), false,
      `mock data must not reference "${forbidden}"`);
  }
});

test('age credential discloses a predicate, not a birth date', () => {
  // the point of an age credential is the answer, not the underlying data
  const subject = MOCK_AGE_VERIFICATION.credentialSubject;
  assert.equal(subject.overAge, 21);
  assert.equal(subject.birthDate, undefined);
});

test('describeCredential builds license display rows', () => {
  const d = describeCredential(MOCK_DRIVERS_LICENSE);
  assert.equal(d.kind, 'license');
  assert.equal(d.title, 'Mobile DL/ID');
  assert.equal(d.status, 'Active');
  const labels = d.rows.map(([label]) => label);
  for(const expected of ['Issued by', 'DOB', 'REAL ID', 'EXP', 'Name']) {
    assert.ok(labels.includes(expected), `missing row "${expected}"`);
  }
});

test('describeCredential formats dates without timezone drift', () => {
  // a date-only value must not shift a day based on the runner's timezone
  const d = describeCredential(MOCK_DRIVERS_LICENSE);
  const dob = d.rows.find(([label]) => label === 'DOB')[1];
  assert.equal(dob, 'Mar 21, 1985');
});

test('describeCredential marks expired credentials', () => {
  const expired = {
    ...MOCK_INSURANCE_CARD, expirationDate: '2000-01-01T00:00:00Z'
  };
  assert.equal(describeCredential(expired).status, 'Expired');
});

test('describeCredential handles an unknown credential type', () => {
  const d = describeCredential({
    type: ['VerifiableCredential', 'SomethingNew'], issuer: 'did:example:1'
  });
  assert.equal(d.kind, 'generic');
  assert.ok(d.rows.length >= 1, 'still renders something');
});

test('insurance card carries no "not official proof" disclaimer', () => {
  // per the brief: the QR replaces the disclaimer
  const serialized = JSON.stringify(MOCK_INSURANCE_CARD).toLowerCase();
  assert.equal(serialized.includes('not official'), false);
});

/* --- presentation + QR --- */

test('createPresentation wraps credentials in a VP', () => {
  const vp = createPresentation({
    credentials: [MOCK_DRIVERS_LICENSE], holder: 'did:example:holder'
  });
  assert.deepEqual(vp.type, ['VerifiablePresentation']);
  assert.equal(vp.verifiableCredential.length, 1);
  assert.equal(vp.holder, 'did:example:holder');
});

test('createPresentation rejects an empty credential set', () => {
  assert.throws(() => createPresentation({credentials: []}), /non-empty/);
});

test('createPresentation strips renderMethod from credentials', () => {
  /* A render method is display instructions for a holder's wallet, not a claim
  about the subject — a verifier checking a badge number has no use for the
  issuer's HTML. It is also large: the demo credential's base64 template alone
  exceeds a QR code's entire capacity, so leaving it in makes the QR
  unrenderable. */
  const vp = createPresentation({credentials: [MOCK_HTML_CREDENTIAL]});
  assert.equal(vp.verifiableCredential[0].renderMethod, undefined);
  // The claims themselves must survive.
  assert.ok(vp.verifiableCredential[0].credentialSubject);
});

test('createPresentation does not mutate the credential it was given', () => {
  const before = JSON.stringify(MOCK_HTML_CREDENTIAL);
  createPresentation({credentials: [MOCK_HTML_CREDENTIAL]});
  assert.equal(
    JSON.stringify(MOCK_HTML_CREDENTIAL), before,
    'the wallet\'s own copy must keep its render method');
});

test('a credential with a render method still fits in a QR code', () => {
  /* QR version 40, byte mode, lowest error correction tops out at 2953 bytes.
  Anything larger throws inside the QR library rather than degrading. */
  const vp = createPresentation({credentials: [MOCK_HTML_CREDENTIAL]});
  const payload = toQrPayload({vp});
  assert.ok(
    payload.length <= 2953,
    `payload is ${payload.length} bytes; a QR code holds at most 2953`);
});

test('QR payload round-trips', () => {
  const vp = createPresentation({credentials: [MOCK_AGE_VERIFICATION]});
  const payload = toQrPayload({vp});
  assert.ok(payload.startsWith(QR_PREFIX));
  assert.deepEqual(fromQrPayload({payload}), vp);
});

test('fromQrPayload rejects foreign payloads', () => {
  assert.throws(() => fromQrPayload({payload: 'https://example.com'}), /prefix/);
});

test('selectFields keeps only requested attributes', () => {
  const reduced = selectFields({
    credential: MOCK_DRIVERS_LICENSE, fields: ['familyName']
  });
  const subject = reduced.credentialSubject;
  assert.equal(subject.familyName, 'SAMPLEHOLDER');
  assert.equal(subject.birthDate, undefined, 'DOB must not be disclosed');
  assert.equal(subject.documentNumber, undefined);
  // structural fields are retained
  assert.ok(subject.id);
});

test('describeDisclosure lists exactly what would be sent', () => {
  const vp = createPresentation({credentials: [MOCK_AGE_VERIFICATION]});
  const [entry] = describeDisclosure({vp});
  assert.equal(entry.type, 'OverAgeTokenCredential');
  assert.deepEqual(entry.fields, ['overAge']);
});

test('describeDisclosure omits structural identifiers', () => {
  const vp = createPresentation({credentials: [MOCK_PARKING_PLACARD]});
  const [entry] = describeDisclosure({vp});
  assert.equal(entry.fields.includes('id'), false);
  assert.equal(entry.fields.includes('type'), false);
});

/* --- scanner --- */

test('classifyScan detects OID4VP custom schemes', () => {
  for(const scheme of ['openid4vp', 'openid-vc']) {
    const scan = classifyScan({
      payload: `${scheme}://?request_uri=https://verifier.example/req/1`
    });
    assert.equal(scan.kind, SCAN_KINDS.OID4VP, scheme);
    assert.equal(scan.requestUri, 'https://verifier.example/req/1');
  }
});

test('classifyScan detects an inlined OID4VP request', () => {
  const scan = classifyScan({
    payload: 'openid4vp://?presentation_definition=%7B%7D'
  });
  assert.equal(scan.kind, SCAN_KINDS.OID4VP);
  assert.equal(scan.requestUri, undefined);
  assert.match(scan.detail, /inlined/);
});

test('classifyScan detects OID4VP over https', () => {
  const scan = classifyScan({
    payload: 'https://verifier.example/vp?request_uri=https://v.example/r'
  });
  assert.equal(scan.kind, SCAN_KINDS.OID4VP);
});

test('classifyScan treats a plain https URL as a VC-API exchange', () => {
  const scan = classifyScan({
    payload: 'https://issuer.example/exchanges/abc123'
  });
  assert.equal(scan.kind, SCAN_KINDS.VCAPI);
});

test('classifyScan recognizes an OIDC browser login, not an exchange', () => {
  /* The CA DMV link in the brief is this shape. Misreading it as a VC-API
  exchange would POST to a login endpoint and fail confusingly. */
  const scan = classifyScan({
    payload: 'https://credentials.dmv.example/login?redirect_uri=' +
      'https://www.dmv.example/redirect&response_type=code&state=abc&' +
      'scope=openid&client_id=ovc-prod'
  });
  assert.equal(scan.kind, SCAN_KINDS.OIDC_LOGIN);
  assert.equal(describeScan({scan}).actionable, false);
  assert.match(describeScan({scan}).message, /browser/i);
});

test('classifyScan recognizes this wallet own presentation QR', () => {
  const vp = createPresentation({credentials: [MOCK_DRIVERS_LICENSE]});
  const scan = classifyScan({payload: toQrPayload({vp})});
  assert.equal(scan.kind, SCAN_KINDS.PRESENTATION);
  assert.equal(describeScan({scan}).actionable, false);
});

test('classifyScan rejects junk and unsupported schemes', () => {
  for(const payload of ['', '   ', 'not a url', 'ftp://example.com/x']) {
    const scan = classifyScan({payload});
    assert.equal(scan.kind, SCAN_KINDS.UNKNOWN, JSON.stringify(payload));
    assert.equal(describeScan({scan}).actionable, false);
  }
});

test('toInteractionArgs shapes OID4VP and VC-API differently', () => {
  const vcapi = classifyScan({payload: 'https://x.example/exchanges/1'});
  const vcapiArgs = toInteractionArgs({scan: vcapi});
  assert.equal(vcapiArgs.interactionUrl, 'https://x.example/exchanges/1');
  assert.equal(vcapiArgs.origin, 'https://x.example');
  assert.ok(vcapiArgs.protocols.vcapi);

  const oid4vp = classifyScan({payload: 'openid4vp://?request_uri=https://y'});
  const oid4vpArgs = toInteractionArgs({scan: oid4vp});
  assert.ok(oid4vpArgs.protocols.OID4VP, 'OID4VP protocol entry present');
});

test('toInteractionArgs refuses non-actionable scans', () => {
  const scan = classifyScan({payload: 'not a url'});
  assert.throws(() => toInteractionArgs({scan}), /no actionable URL/);
});

/* --- real VC Playground payloads (captured 2026-07-26) --- */

/* Captured from https://vcplayground.org/issuer by generating a QR for the
"Utopia Birth Certificate" credential. Kept verbatim: the point is to pin
behavior to a payload that was actually observed, not one that was assumed. */
const PLAYGROUND_INTERACTION_URL =
  'https://vcplayground.org/interactions/https%3A%2F%2Fsandbox.platform.' +
  'veres.dev%2Fworkflows%2Fz1ABDEb82XRQ1KyF3joLco8hB%2Fexchanges%2F' +
  'z1ACN4jMzTm7rpfKM5eDuKh4H?iuv=1';

test('the real playground QR is an interaction URL, not an exchange', () => {
  /* This is the shape the playground actually issues. An earlier version of
  classifyScan called it `vcapi`, which would POST to the wrapper URL and skip
  protocol negotiation. Fetching it returns:
    {"protocols": {"OID4VCI": "openid-credential-offer://...",
                   "vcapi": "https://sandbox.platform.veres.dev/..."}} */
  const scan = classifyScan({payload: PLAYGROUND_INTERACTION_URL});
  assert.equal(scan.kind, SCAN_KINDS.INTERACTION);
  assert.equal(describeScan({scan}).actionable, true);
  assert.equal(describeScan({scan}).title, 'Credential offer');
});

test('an interaction URL defers protocol choice to ClientInteraction', () => {
  // no guessed protocol list: it must be fetched from the URL over TLS
  const scan = classifyScan({payload: PLAYGROUND_INTERACTION_URL});
  const args = toInteractionArgs({scan});
  assert.equal(args.interactionUrl, PLAYGROUND_INTERACTION_URL);
  assert.equal(args.origin, 'https://vcplayground.org');
  assert.equal(
    args.protocols, undefined,
    'protocols must come from the interaction URL, not be assumed');
});

test('iuv=1 is what distinguishes an interaction URL', () => {
  // `ClientInteraction._parseInteractionUrl` requires it, so the same test
  // applies here. Without it, the URL is just an exchange endpoint.
  const withoutIuv = PLAYGROUND_INTERACTION_URL.replace('?iuv=1', '');
  assert.equal(
    classifyScan({payload: withoutIuv}).kind, SCAN_KINDS.VCAPI);
  assert.equal(
    classifyScan({payload: PLAYGROUND_INTERACTION_URL}).kind,
    SCAN_KINDS.INTERACTION);
});

test('an interaction URL must be https, not http', () => {
  // `_parseInteractionUrl` rejects non-https; the protocol list is only
  // trustworthy over TLS
  const insecure = PLAYGROUND_INTERACTION_URL.replace('https://', 'http://');
  assert.notEqual(
    classifyScan({payload: insecure}).kind, SCAN_KINDS.INTERACTION);
});

test('the OID4VCI offer scheme from the protocol list is recognized', () => {
  /* The playground's protocol list offers this for OID4VCI. It is a credential
  *offer* (issuance), distinct from an OID4VP presentation request. */
  const offer = 'openid-credential-offer://?credential_offer_uri=' +
    'https%3A%2F%2Fsandbox.platform.veres.dev%2Fworkflows%2Fx%2Fexchanges' +
    '%2Fy%2Fopenid%2Fcredential-offer';
  const scan = classifyScan({payload: offer});
  assert.notEqual(
    scan.kind, SCAN_KINDS.UNKNOWN,
    'a credential offer must not be reported as unrecognized');
});
