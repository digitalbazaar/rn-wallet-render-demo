/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Classifying scanned QR payloads, and starting the right exchange.
 *
 * Handles the payload shapes an issuer or verifier can present:
 *
 * - **Interaction URL** (`?iuv=1`) — not an exchange itself; it serves a
 *   protocol list the wallet fetches and negotiates from. This is what the VC
 *   Playground issues, verified against a live QR.
 * - **OID4VCI** — `openid-credential-offer://`, an issuer *offering* a
 *   credential.
 * - **OID4VP** — `openid4vp://` / `openid-vc://`, a verifier *requesting* one,
 *   including the `request_uri` indirection.
 * - **VC-API** — an exchange URL that is POSTed to, per
 *   `@bedrock/web-wallet`'s `VcapiExchange`.
 *
 * Detection is a pure function so every payload shape is testable without a
 * camera, a network, or a device. Actually running an exchange reuses
 * `@bedrock/web-wallet`'s handlers rather than reimplementing either protocol —
 * that reuse is the whole point of the plan.
 *
 * ## On the CA DMV login link
 *
 * The DMV URL in the brief is an **OIDC login** flow
 * (`response_type=code&client_id=…`), which is the relying party's browser-side
 * entry point, not a wallet-scannable QR. Whatever QR that page eventually
 * renders will be one of the two protocols above; `classifyScan` reports
 * `oidcLogin` for such URLs so the UI can say something useful instead of
 * silently failing.
 */

/**
 * Scan classification kinds.
 *
 * @type {object}
 */
export const SCAN_KINDS = Object.freeze({
  INTERACTION: 'interaction',
  OID4VCI: 'OID4VCI',
  OID4VP: 'OID4VP',
  VCAPI: 'vcapi',
  PRESENTATION: 'presentation',
  OIDC_LOGIN: 'oidcLogin',
  UNKNOWN: 'unknown'
});

/* Presentation requests: a verifier asking for a credential. */
const OID4VP_SCHEMES = ['openid4vp:', 'openid-vc:'];

/* Credential offers: an issuer offering a credential. A different direction
from OID4VP and a different handler (`oid4vci`, not `oid4vp`), so they are
classified separately. An earlier version lumped an incorrect
`openid-credential:` into the OID4VP list, which both misspelled the scheme and
mislabeled the flow. The
real scheme, observed in the VC Playground's protocol list, is
`openid-credential-offer://?credential_offer_uri=...`. */
const OID4VCI_SCHEMES = ['openid-credential-offer:'];

/**
 * Classifies a scanned QR payload.
 *
 * Ordering matters: the checks run most-specific first, so an `openid4vp://`
 * URL is never mistaken for a generic HTTPS exchange URL.
 *
 * @param {object} options - The options.
 * @param {string} options.payload - The raw scanned text.
 *
 * @returns {object} `{kind, url, detail}` where `url` is the actionable URL.
 */
export function classifyScan({payload} = {}) {
  const text = typeof payload === 'string' ? payload.trim() : '';
  if(!text) {
    return {
      kind: SCAN_KINDS.UNKNOWN, detail: 'Empty scan.'
    };
  }

  // 1. this prototype's own presentation payload
  if(text.startsWith('VP1-')) {
    return {
      kind: SCAN_KINDS.PRESENTATION,
      detail: 'A presentation from this wallet.'
    };
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    return {
      kind: SCAN_KINDS.UNKNOWN,
      detail: 'Not a URL or a recognized payload.'
    };
  }

  // 2a. OID4VCI credential offer (issuance)
  if(OID4VCI_SCHEMES.includes(url.protocol)) {
    const offerUri = url.searchParams.get('credential_offer_uri');
    return {
      kind: SCAN_KINDS.OID4VCI,
      url: text,
      credentialOfferUri: offerUri ?? undefined,
      detail: offerUri ?
        'OID4VCI credential offer, fetched from credential_offer_uri.' :
        'OID4VCI credential offer, inlined in the QR.'
    };
  }

  // 2b. OID4VP presentation request
  if(OID4VP_SCHEMES.includes(url.protocol)) {
    const requestUri = url.searchParams.get('request_uri');
    return {
      kind: SCAN_KINDS.OID4VP,
      url: text,
      requestUri: requestUri ?? undefined,
      detail: requestUri ?
        'OID4VP request, fetched from request_uri.' :
        'OID4VP request, inlined in the QR.'
    };
  }

  if(url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      kind: SCAN_KINDS.UNKNOWN,
      detail: `Unsupported scheme "${url.protocol}".`
    };
  }

  const params = url.searchParams;

  /* 3. An *interaction URL*, identified by `iuv=1`.

  This is the shape the VC Playground actually issues, and it is the correct
  answer to "support both protocols": the URL is not itself an exchange, it
  serves a protocol list that the wallet fetches and chooses from. Confirmed
  against a live playground QR, which returns:

    {"protocols": {
      "OID4VCI": "openid-credential-offer://?credential_offer_uri=...",
      "vcapi": "https://sandbox.platform.veres.dev/workflows/.../exchanges/..."
    }}

  `ClientInteraction._parseInteractionUrl` requires `iuv=1` and HTTPS, so the
  same test is applied here. Treating one of these as a bare VC-API endpoint --
  which an earlier version of this function did -- would POST to the wrong URL
  and skip protocol negotiation entirely. */
  if(url.protocol === 'https:' && params.get('iuv') === '1') {
    return {
      kind: SCAN_KINDS.INTERACTION,
      url: text,
      detail: 'Interaction URL; the wallet fetches the protocol list and ' +
        'negotiates OID4VCI or VC-API.'
    };
  }

  /* 4. An OIDC authorization request is a browser login, not a wallet
  exchange. Detected so the UI can explain that rather than appearing broken. */
  if(params.get('response_type') === 'code' && params.has('client_id')) {
    return {
      kind: SCAN_KINDS.OIDC_LOGIN,
      url: text,
      detail: 'An OIDC browser login, not a wallet exchange. Open it in a ' +
        'browser; the wallet QR appears later in that flow.'
    };
  }

  // 5. OID4VP can also arrive over https with its parameters present
  if(params.has('request_uri') || params.has('presentation_definition') ||
    params.has('presentation_definition_uri')) {
    return {
      kind: SCAN_KINDS.OID4VP,
      url: text,
      requestUri: params.get('request_uri') ?? undefined,
      detail: 'OID4VP request over HTTPS.'
    };
  }

  // 6. otherwise treat an https URL as a VC-API exchange endpoint
  return {
    kind: SCAN_KINDS.VCAPI,
    url: text,
    detail: 'VC-API exchange URL.'
  };
}

/**
 * Builds the `ClientInteraction` arguments for a scanned exchange.
 *
 * `@bedrock/web-wallet`'s protocol handlers all take a `ClientInteraction`,
 * whose usual constructor path is a CHAPI browser event. A scanned QR has no
 * such event, so the interaction is built directly from the URL — which
 * `ClientInteraction` supports via `interactionUrl` + `getProtocols`.
 *
 * @param {object} options - The options.
 * @param {object} options.scan - A `classifyScan` result.
 *
 * @returns {object} `{interactionUrl, origin, protocols}`.
 */
export function toInteractionArgs({scan} = {}) {
  if(!scan?.url) {
    throw new Error('Scan has no actionable URL.');
  }
  const {origin} = new URL(scan.url);

  if(scan.kind === SCAN_KINDS.OID4VP) {
    /* OID4VP handlers look for an authorization request URL. Pass the scanned
    URL through as the protocol entry rather than fetching a protocol list --
    the QR *is* the request. */
    return {
      interactionUrl: undefined,
      origin,
      protocols: {OID4VP: scan.url}
    };
  }
  if(scan.kind === SCAN_KINDS.OID4VCI) {
    return {
      interactionUrl: undefined,
      origin,
      protocols: {OID4VCI: scan.url}
    };
  }
  if(scan.kind === SCAN_KINDS.INTERACTION) {
    /* No `protocols` here on purpose: `ClientInteraction` fetches them from the
    interaction URL over TLS, which is the trustworthy source. Supplying a
    guessed list would defeat that. */
    return {interactionUrl: scan.url, origin};
  }
  if(scan.kind === SCAN_KINDS.VCAPI) {
    return {
      interactionUrl: scan.url,
      origin,
      protocols: {vcapi: scan.url}
    };
  }
  throw new Error(`Scan kind "${scan.kind}" does not start an exchange.`);
}

/**
 * Human-readable guidance for a scan result, for the UI.
 *
 * @param {object} options - The options.
 * @param {object} options.scan - A `classifyScan` result.
 *
 * @returns {object} `{title, message, actionable}`.
 */
export function describeScan({scan} = {}) {
  switch(scan?.kind) {
    case SCAN_KINDS.OID4VP:
      return {
        title: 'OID4VP request',
        message: scan.detail,
        actionable: true
      };
    case SCAN_KINDS.OID4VCI:
      return {
        title: 'Credential offer (OID4VCI)',
        message: scan.detail,
        actionable: true
      };
    case SCAN_KINDS.INTERACTION:
      return {
        title: 'Credential offer',
        message: scan.detail,
        actionable: true
      };
    case SCAN_KINDS.VCAPI:
      return {
        title: 'VC-API exchange',
        message: scan.detail,
        actionable: true
      };
    case SCAN_KINDS.PRESENTATION:
      return {
        title: 'Presentation',
        message: 'This QR came from a wallet. Verifiers scan these; wallets ' +
          'do not.',
        actionable: false
      };
    case SCAN_KINDS.OIDC_LOGIN:
      return {
        title: 'Browser login',
        message: scan.detail,
        actionable: false
      };
    default:
      return {
        title: 'Unrecognized code',
        message: scan?.detail ?? 'Nothing usable in this QR code.',
        actionable: false
      };
  }
}
