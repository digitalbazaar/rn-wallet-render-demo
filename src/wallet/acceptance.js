/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Accepting a credential from an issuer.
 *
 * Two halves, deliberately separated:
 *
 * - **Pure** (`extractCredentials`, `summarizeOffer`, `pickProtocol`) — parses
 *   and validates what an issuer returned. Testable against real captured
 *   responses with no network.
 * - **Imperative** (`fetchProtocols`, `runVcapiExchange`, `acceptFromScan`) —
 *   does the HTTP. Takes an injected `fetch`, so tests drive it
 *   deterministically.
 *
 * ## Why this does not use `@bedrock/web-wallet`'s exchange handlers yet
 *
 * `lib/exchanges/oid4vci.js` and `vcapi.js` are the right long-term path and
 * the plan's whole premise. But both import `profileManager` from
 * `../state.js`,
 * which pulls in the full Bedrock profile stack — KMS, zcaps, meters, remote
 * EDVs. That is Phase 2/3 infrastructure this prototype does not have, and
 * standing it up to accept one credential would be a much larger change than
 * the acceptance itself.
 *
 * So the VC-API flow is implemented directly here — it is a single POST — and
 * the reuse of those handlers is left as the documented Phase 2 step. The shape
 * of this module deliberately mirrors theirs (`next()`-style single step,
 * protocol negotiation via the interaction URL) so swapping it out later is
 * mechanical.
 *
 * Verified against a live VC Playground exchange (2026-07-27): POSTing `{}` to
 * the `vcapi` protocol URL returns
 * `{verifiablePresentation: {verifiableCredential: [...]}}` with a real proof.
 */

/**
 * Protocols this wallet can complete, best first.
 *
 * `vcapi` is preferred because it needs no DID Auth for the unsigned case;
 * OID4VCI issuance here would require a holder DID and profile signer.
 *
 * @type {string[]}
 */
export const SUPPORTED_PROTOCOLS = Object.freeze(['vcapi']);

/**
 * Chooses a protocol from an issuer's protocol list.
 *
 * @param {object} options - The options.
 * @param {object} options.protocols - The issuer's `protocols` map.
 * @param {string[]} [options.supported] - Protocols this client can run.
 *
 * @returns {object} `{protocol, url}` or `{unsupported}` listing what was
 *   offered.
 */
export function pickProtocol({
  protocols, supported = SUPPORTED_PROTOCOLS
} = {}) {
  const offered = Object.keys(protocols ?? {});
  for(const protocol of supported) {
    const url = protocols?.[protocol];
    if(typeof url === 'string' && url) {
      return {protocol, url};
    }
  }
  return {unsupported: offered};
}

/**
 * Extracts credentials from an issuance response.
 *
 * Handles the shapes a VC-API exchange can return: a `verifiablePresentation`
 * wrapping one or many credentials, or a bare credential. Throws with a
 * specific message rather than returning empty, so a caller can report *why*
 * nothing arrived.
 *
 * @param {object} options - The options.
 * @param {object} options.response - The parsed issuance response.
 *
 * @returns {object[]} The credentials found.
 */
export function extractCredentials({response} = {}) {
  if(!response || typeof response !== 'object') {
    throw new TypeError('Issuer response was not an object.');
  }

  /* An exchange that wants more steps returns a presentation *request* rather
  than a presentation. Detect it explicitly: silently treating it as "no
  credentials" would hide a DID Auth requirement. */
  if(response.verifiablePresentationRequest) {
    const error = new Error(
      'The issuer requires a presentation before issuing (DID Auth). This ' +
      'prototype has no holder key, so it cannot complete that exchange.');
    error.name = 'PresentationRequiredError';
    throw error;
  }

  const vp = response.verifiablePresentation;
  const raw = vp?.verifiableCredential ??
    response.verifiableCredential ??
    // a bare credential, identified structurally
    (response.credentialSubject ? response : undefined);

  if(raw === undefined) {
    throw new Error(
      'No credentials in the issuer response; top-level keys were: ' +
      `${Object.keys(response).join(', ') || '(none)'}.`);
  }

  const credentials = Array.isArray(raw) ? raw : [raw];
  const valid = credentials.filter(
    c => c && typeof c === 'object' && c.credentialSubject);
  if(valid.length === 0) {
    throw new Error('Issuer response contained no usable credentials.');
  }
  return valid;
}

/**
 * Normalizes an issuer, which may be a string or an object.
 *
 * The VC data model allows either. The VC Playground returns an object
 * (`{id, name, image}`), while the mock credentials use a plain DID string —
 * so anything rendering an issuer must handle both.
 *
 * @param {object|string} issuer - The credential's `issuer`.
 *
 * @returns {object} `{id, name, image}` with `name` falling back to `id`.
 */
export function normalizeIssuer(issuer) {
  if(typeof issuer === 'string') {
    return {id: issuer, name: issuer};
  }
  const id = issuer?.id;
  return {
    id,
    name: issuer?.name ?? id ?? 'Unknown issuer',
    image: issuer?.image
  };
}

/**
 * Summarizes an accepted credential for a confirmation screen.
 *
 * @param {object} options - The options.
 * @param {object[]} options.credentials - Accepted credentials.
 *
 * @returns {object[]} One `{type, issuer, fields, signed}` entry each.
 */
export function summarizeOffer({credentials} = {}) {
  return (credentials ?? []).map(credential => {
    const {name: issuer} = normalizeIssuer(credential.issuer);
    const subject = credential.credentialSubject ?? {};
    return {
      type: credential.type?.find(t => t !== 'VerifiableCredential') ??
        'VerifiableCredential',
      issuer,
      fields: Object.keys(subject).filter(k => k !== 'id').sort(),
      // whether the issuer signed it; this prototype does not verify the proof
      signed: Boolean(credential.proof)
    };
  });
}

/**
 * Fetches an issuer's protocol list from an interaction URL.
 *
 * @param {object} options - The options.
 * @param {string} options.interactionUrl - The scanned interaction URL.
 * @param {Function} options.fetch - A `fetch` implementation.
 *
 * @returns {Promise<object>} The `protocols` map.
 */
export async function fetchProtocols({interactionUrl, fetch: doFetch} = {}) {
  const response = await doFetch(interactionUrl, {
    headers: {accept: 'application/json'}
  });
  if(!response.ok) {
    throw new Error(
      `Could not read the credential offer (HTTP ${response.status}).`);
  }
  const body = await response.json();
  const {protocols} = body ?? {};
  if(!protocols || typeof protocols !== 'object') {
    throw new Error('The offer did not list any protocols.');
  }
  return protocols;
}

/**
 * Runs a VC-API exchange to completion.
 *
 * A VC-API exchange is driven by POSTing to the exchange URL. For an issuance
 * that needs nothing from the holder, one POST with an empty body returns the
 * credentials — confirmed against the live VC Playground.
 *
 * @param {object} options - The options.
 * @param {string} options.exchangeUrl - The `vcapi` protocol URL.
 * @param {Function} options.fetch - A `fetch` implementation.
 * @param {object} [options.body] - The request body.
 *
 * @returns {Promise<object>} The parsed exchange response.
 */
export async function runVcapiExchange({
  exchangeUrl, fetch: doFetch, body = {}
} = {}) {
  const response = await doFetch(exchangeUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify(body)
  });
  if(!response.ok) {
    /* Exchange URLs are single-use AND short-lived. Measured against the VC
    Playground: an exchange POSTed immediately returns 200, while the same
    freshly-generated URL used a couple of minutes later returns 403. The bare
    body is "Internal Server Error" for both, which sends you looking in the
    wrong place -- it did during development, where a 403 on a brand-new URL was
    first misread as replay. Name both causes. */
    throw new Error(
      `The exchange failed (HTTP ${response.status}). Exchange URLs are ` +
      'single-use and expire quickly — scan a freshly generated QR and ' +
      'accept it right away.');
  }
  return response.json();
}

/**
 * Accepts credentials from a classified scan.
 *
 * Orchestrates: fetch the protocol list (if the scan was an interaction URL),
 * choose a protocol, run the exchange, extract credentials.
 *
 * @param {object} options - The options.
 * @param {object} options.scan - A `classifyScan` result.
 * @param {Function} options.fetch - A `fetch` implementation.
 *
 * @returns {Promise<object>} `{credentials, summary, protocol}`.
 */
export async function acceptFromScan({scan, fetch: doFetch} = {}) {
  if(!scan?.url) {
    throw new Error('Nothing to accept; the scan had no URL.');
  }

  let exchangeUrl = scan.url;
  let protocol = 'vcapi';

  // an interaction URL negotiates; a bare exchange URL does not
  if(scan.kind === 'interaction') {
    const protocols = await fetchProtocols({
      interactionUrl: scan.url, fetch: doFetch
    });
    const picked = pickProtocol({protocols});
    if(picked.unsupported) {
      throw new Error(
        'The issuer offered only protocols this prototype cannot complete: ' +
        `${picked.unsupported.join(', ')}. Supported: ` +
        `${SUPPORTED_PROTOCOLS.join(', ')}.`);
    }
    ({protocol, url: exchangeUrl} = picked);
  }

  const response = await runVcapiExchange({exchangeUrl, fetch: doFetch});
  const credentials = extractCredentials({response});
  return {
    credentials,
    summary: summarizeOffer({credentials}),
    protocol
  };
}
