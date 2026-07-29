/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tests for credential acceptance.
 *
 * The central fixture is a **real issuance response** captured from the VC
 * Playground (`test/fixtures/playgroundIssuance.json`, 2026-07-27), so parsing
 * is pinned to a shape that was actually observed rather than one assumed from
 * the spec. Only the base64 issuer images were trimmed.
 *
 * Network calls take an injected `fetch`, so every path — including failures —
 * is exercised deterministically without touching the sandbox.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {
  acceptFromScan, extractCredentials, fetchProtocols, normalizeIssuer,
  pickProtocol, runVcapiExchange, summarizeOffer, SUPPORTED_PROTOCOLS
} from '../../src/wallet/acceptance.js';
import {classifyScan} from '../../src/wallet/scanner.js';

const REAL_RESPONSE = JSON.parse(readFileSync(
  new URL('../fixtures/playgroundIssuance.json', import.meta.url), 'utf8'));

/* The protocol list the playground actually served, verbatim. */
const REAL_PROTOCOLS = {
  OID4VCI: 'openid-credential-offer://?credential_offer_uri=https%3A%2F%2F' +
    'sandbox.platform.veres.dev%2Fworkflows%2Fx%2Fexchanges%2Fy%2Fopenid%2F' +
    'credential-offer',
  vcapi: 'https://sandbox.platform.veres.dev/workflows/x/exchanges/y'
};

const INTERACTION_URL =
  'https://vcplayground.org/interactions/https%3A%2F%2Fexample%2Fe%2F1?iuv=1';

function fakeFetch(handlers) {
  return async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const handler = handlers[`${method} ${url}`] ?? handlers[url];
    if(!handler) {
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }
    return handler;
  };
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
});

/* --- parsing the real response --- */

test('extractCredentials reads the real playground response', () => {
  const credentials = extractCredentials({response: REAL_RESPONSE});
  assert.equal(credentials.length, 1);
  const [credential] = credentials;
  assert.ok(credential.type.includes('FirstResponderCredential'));
  assert.ok(credential.proof, 'the issuer signed it');
});

test('the real credential has an OBJECT issuer, not a string', () => {
  /* The VC data model allows either, and the playground uses an object while
  the mock credentials use a DID string. Anything rendering an issuer must
  handle both or it breaks on real data. */
  const [credential] = extractCredentials({response: REAL_RESPONSE});
  assert.equal(typeof credential.issuer, 'object');
  const issuer = normalizeIssuer(credential.issuer);
  assert.equal(issuer.name, 'Utopia State Fire Training');
  assert.match(issuer.id, /^did:key:/);
});

test('normalizeIssuer handles a plain string issuer', () => {
  const issuer = normalizeIssuer('did:key:zAbc');
  assert.equal(issuer.id, 'did:key:zAbc');
  assert.equal(issuer.name, 'did:key:zAbc');
});

test('normalizeIssuer survives a missing issuer', () => {
  assert.equal(normalizeIssuer(undefined).name, 'Unknown issuer');
});

test('summarizeOffer describes the real credential', () => {
  const credentials = extractCredentials({response: REAL_RESPONSE});
  const [summary] = summarizeOffer({credentials});
  assert.equal(summary.type, 'FirstResponderCredential');
  assert.equal(summary.issuer, 'Utopia State Fire Training');
  assert.equal(summary.signed, true);
  assert.ok(summary.fields.length > 0);
  assert.equal(summary.fields.includes('id'), false, 'id is not an attribute');
});

test('extractCredentials accepts a bare credential', () => {
  const bare = {
    type: ['VerifiableCredential'], credentialSubject: {name: 'x'}
  };
  assert.equal(extractCredentials({response: bare}).length, 1);
});

test('extractCredentials accepts multiple credentials', () => {
  const many = {
    verifiablePresentation: {
      verifiableCredential: [
        {credentialSubject: {a: 1}}, {credentialSubject: {b: 2}}
      ]
    }
  };
  assert.equal(extractCredentials({response: many}).length, 2);
});

test('extractCredentials reports a DID Auth requirement specifically', () => {
  /* An exchange wanting a presentation first must not look like "no
  credentials" -- that hid a real requirement during development. */
  assert.throws(
    () => extractCredentials({
      response: {verifiablePresentationRequest: {query: []}}
    }),
    e => e.name === 'PresentationRequiredError' && /DID Auth/.test(e.message));
});

test('extractCredentials explains an empty response', () => {
  assert.throws(
    () => extractCredentials({response: {foo: 1}}),
    /No credentials in the issuer response.*foo/);
  assert.throws(() => extractCredentials({response: null}), /not an object/);
});

/* --- protocol negotiation --- */

test('pickProtocol chooses vcapi from the real protocol list', () => {
  const picked = pickProtocol({protocols: REAL_PROTOCOLS});
  assert.equal(picked.protocol, 'vcapi');
  assert.equal(picked.url, REAL_PROTOCOLS.vcapi);
});

test('pickProtocol reports what was offered when none is supported', () => {
  const picked = pickProtocol({protocols: {OID4VCI: 'openid-credential-offer://x'}});
  assert.deepEqual(picked.unsupported, ['OID4VCI']);
  assert.equal(picked.protocol, undefined);
});

test('SUPPORTED_PROTOCOLS is honest about what works', () => {
  // OID4VCI issuance needs a holder DID this prototype does not have
  assert.deepEqual([...SUPPORTED_PROTOCOLS], ['vcapi']);
});

test('fetchProtocols reads a protocol list', async () => {
  const protocols = await fetchProtocols({
    interactionUrl: INTERACTION_URL,
    fetch: fakeFetch({[INTERACTION_URL]: jsonResponse({
      protocols: REAL_PROTOCOLS
    })})
  });
  assert.deepEqual(protocols, REAL_PROTOCOLS);
});

test('fetchProtocols surfaces an HTTP failure', async () => {
  await assert.rejects(() => fetchProtocols({
    interactionUrl: INTERACTION_URL,
    fetch: fakeFetch({[INTERACTION_URL]: jsonResponse({}, 404)})
  }), /HTTP 404/);
});

test('fetchProtocols rejects a response with no protocols', async () => {
  await assert.rejects(() => fetchProtocols({
    interactionUrl: INTERACTION_URL,
    fetch: fakeFetch({[INTERACTION_URL]: jsonResponse({nope: true})})
  }), /did not list any protocols/);
});

/* --- running the exchange --- */

test('runVcapiExchange POSTs and returns the response', async () => {
  const url = REAL_PROTOCOLS.vcapi;
  let sawBody;
  const result = await runVcapiExchange({
    exchangeUrl: url,
    fetch: async (u, o) => {
      sawBody = o.body;
      return jsonResponse(REAL_RESPONSE);
    }
  });
  assert.equal(sawBody, '{}', 'an empty body completes a no-input issuance');
  assert.ok(result.verifiablePresentation);
});

test('runVcapiExchange explains a stale or replayed exchange URL', async () => {
  /* Measured against the playground: POSTing immediately returns 200, the same
  fresh URL a couple of minutes later returns 403, and the body is "Internal
  Server Error" either way. A 403 on a brand-new URL was first misread as
  replay,
  so the message must name expiry too. */
  for(const status of [403, 500]) {
    await assert.rejects(() => runVcapiExchange({
      exchangeUrl: REAL_PROTOCOLS.vcapi,
      fetch: async () => jsonResponse('Internal Server Error', status)
    }), e => /single-use/.test(e.message) && /expire/.test(e.message),
    `status ${status} must mention both causes`);
  }
});

/* --- end to end --- */

test('acceptFromScan negotiates then accepts a real QR shape', async () => {
  const scan = classifyScan({payload: INTERACTION_URL});
  assert.equal(scan.kind, 'interaction');

  const result = await acceptFromScan({
    scan,
    fetch: fakeFetch({
      [INTERACTION_URL]: jsonResponse({protocols: REAL_PROTOCOLS}),
      [`POST ${REAL_PROTOCOLS.vcapi}`]: jsonResponse(REAL_RESPONSE)
    })
  });

  assert.equal(result.protocol, 'vcapi');
  assert.equal(result.credentials.length, 1);
  assert.equal(result.summary[0].issuer, 'Utopia State Fire Training');
  assert.equal(result.summary[0].signed, true);
});

test('acceptFromScan handles a bare exchange URL directly', async () => {
  const url = 'https://issuer.example/exchanges/abc';
  const scan = classifyScan({payload: url});
  assert.equal(scan.kind, 'vcapi');

  const result = await acceptFromScan({
    scan,
    fetch: fakeFetch({[`POST ${url}`]: jsonResponse(REAL_RESPONSE)})
  });
  assert.equal(result.credentials.length, 1);
});

test('acceptFromScan explains an unsupported-only offer', async () => {
  const scan = classifyScan({payload: INTERACTION_URL});
  await assert.rejects(() => acceptFromScan({
    scan,
    fetch: fakeFetch({[INTERACTION_URL]: jsonResponse({
      protocols: {OID4VCI: 'openid-credential-offer://x'}
    })})
  }), /cannot complete.*OID4VCI/);
});

test('acceptFromScan refuses a scan with no URL', async () => {
  await assert.rejects(
    () => acceptFromScan({scan: {kind: 'unknown'}}), /no URL/);
});

/* --- rendering an accepted credential --- */

test('describeCredential safely renders a REAL credential', async () => {
  /* Two bugs this catches, both only visible on real data:
     1. an object issuer showed as "Unknown issuer"
     2. row values were raw objects, which React Native throws on */
  const {describeCredential} = await import(
    '../../src/wallet/mockCredentials.js');
  const [credential] = extractCredentials({response: REAL_RESPONSE});
  const description = describeCredential(credential);

  assert.equal(description.issuedBy, 'Utopia State Fire Training');
  assert.equal(description.title, 'FirstResponderCredential');

  for(const [label, value] of description.rows) {
    assert.equal(
      typeof label, 'string', `label not a string: ${JSON.stringify(label)}`);
    assert.equal(
      typeof value, 'string',
      `row "${label}" is ${typeof value}; React Native cannot render it`);
  }
});

test('describeCredential never renders a data URI as text', async () => {
  // the real credential carries base64 SVG images; rendering one would dump
  // kilobytes of base64 into the UI
  const {describeCredential} = await import(
    '../../src/wallet/mockCredentials.js');
  const [credential] = extractCredentials({response: REAL_RESPONSE});
  for(const [, value] of describeCredential(credential).rows) {
    assert.equal(
      value.startsWith('data:'), false, 'a data URI leaked into a row');
  }
});

test('describeCredential flattens nested subject objects', async () => {
  const {describeCredential} = await import(
    '../../src/wallet/mockCredentials.js');
  const description = describeCredential({
    type: ['VerifiableCredential', 'NestedCredential'],
    issuer: {id: 'did:key:z1', name: 'Nested Issuer'},
    credentialSubject: {
      id: 'did:example:s',
      plain: 'value',
      nested: {name: 'Named Thing'},
      list: ['a', 'b'],
      flag: true
    }
  });
  const rows = Object.fromEntries(description.rows);
  assert.equal(rows.Plain, 'value');
  assert.equal(rows.Nested, 'Named Thing', 'uses a nested name when present');
  assert.equal(rows.List, 'a, b');
  assert.equal(rows.Flag, 'true');
});

test('mock credentials still render after the issuer change', async () => {
  // the string-issuer path must keep working
  const {
    describeCredential: describe, MOCK_CREDENTIALS
  } = await import('../../src/wallet/mockCredentials.js');
  for(const credential of MOCK_CREDENTIALS) {
    const d = describe(credential);
    assert.notEqual(d.issuedBy, 'Unknown issuer', d.title);
    for(const [, value] of d.rows) {
      assert.equal(typeof value, 'string');
    }
  }
});
