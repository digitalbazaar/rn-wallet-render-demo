/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Building a presentation and its QR payload.
 *
 * Pure functions: no crypto globals, no storage, no React. The screens call
 * these and render the result, which keeps the payload format testable.
 *
 * ## Note on `@digitalbazaar/vpqr`
 *
 * `vpqr` is the right production answer: it CBOR-LD compresses the VP so it
 * fits a scannable QR. But `toQrCode()` requires a `registryEntryId`, i.e. A
 * real CBOR-LD context registry entry. Inventing one for mock credential types
 * would fabricate infrastructure that does not exist, and the QR would not
 * decode against any real registry.
 *
 * So this prototype encodes the VP as a JSON payload and leaves compression as
 * the documented next step. Consequence worth knowing: an uncompressed VP makes
 * a dense QR, so payloads stay deliberately small (one credential, minimal
 * disclosure).
 */

/**
 * Wraps credentials in an unsigned Verifiable Presentation.
 *
 * **Unsigned.** Signing requires a holder key and a real signature suite; this
 * prototype has neither, so a verifier would reject this. Structure is correct
 * so the signing step can be dropped in later.
 *
 * `renderMethod` is dropped from each credential. It is display instructions
 * for a holder's wallet, not a claim about the subject, so a verifier has no
 * use for it — and it is large enough to matter: an HTML template can exceed a
 * QR code's entire capacity on its own, making the QR page unrenderable.
 *
 * @param {object} options - The options.
 * @param {object[]} options.credentials - Credentials to present.
 * @param {string} [options.holder] - The holder DID.
 *
 * @returns {object} An unsigned VP.
 */
export function createPresentation({credentials, holder} = {}) {
  if(!Array.isArray(credentials) || credentials.length === 0) {
    throw new TypeError('"credentials" must be a non-empty array.');
  }
  const vp = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    type: ['VerifiablePresentation'],
    verifiableCredential: credentials.map(_forPresentation)
  };
  if(holder) {
    vp.holder = holder;
  }
  return vp;
}

/**
 * Strips wallet-only properties from a credential before it is presented.
 *
 * Copies rather than mutates: the wallet's stored credential keeps its render
 * method, since that is what the detail screen draws the card from.
 *
 * @private
 * @param {object} credential - The credential to present.
 * @returns {object} A copy with presentation-irrelevant properties removed.
 */
function _forPresentation(credential) {
  if(!credential || typeof credential !== 'object') {
    return credential;
  }
  const presented = {...credential};
  delete presented.renderMethod;
  return presented;
}

/**
 * Selects only the fields a verifier asked for.
 *
 * This is the selective-disclosure seam. Real selective disclosure uses
 * `ecdsa-sd-2023`/`bbs-2023` so unrequested attributes are cryptographically
 * absent rather than merely omitted. This prototype filters plaintext, which
 * is **not** equivalent and must not be mistaken for it. It exists so the
 * consent UI has real data about what will leave the device.
 *
 * @param {object} options - The options.
 * @param {object} options.credential - The source credential.
 * @param {string[]} options.fields - `credentialSubject` field names to keep.
 *
 * @returns {object} A credential carrying only the requested fields.
 */
export function selectFields({credential, fields} = {}) {
  const subject = credential?.credentialSubject ?? {};
  const kept = {};
  // `id` and `type` are structural, not disclosed attributes
  for(const key of ['id', 'type']) {
    if(subject[key] !== undefined) {
      kept[key] = subject[key];
    }
  }
  for(const field of fields ?? []) {
    if(subject[field] !== undefined) {
      kept[field] = subject[field];
    }
  }
  return {...credential, credentialSubject: kept};
}

/* A `VP1-` prefix marks the payload as this prototype's format, so a scanner
can tell it apart from a real CBOR-LD `vpqr` payload rather than failing to
parse one as the other. */
export const QR_PREFIX = 'VP1-';

/**
 * Encodes a presentation as a QR payload string.
 *
 * @param {object} options - The options.
 * @param {object} options.vp - The presentation to encode.
 *
 * @returns {string} The payload to render as a QR code.
 */
export function toQrPayload({vp} = {}) {
  if(!vp || typeof vp !== 'object') {
    throw new TypeError('"vp" must be an object.');
  }
  return QR_PREFIX + JSON.stringify(vp);
}

/**
 * Decodes a QR payload produced by `toQrPayload`.
 *
 * @param {object} options - The options.
 * @param {string} options.payload - The scanned payload.
 *
 * @returns {object} The decoded presentation.
 */
export function fromQrPayload({payload} = {}) {
  if(typeof payload !== 'string' || !payload.startsWith(QR_PREFIX)) {
    throw new Error(
      `Not a recognized presentation payload; expected a "${QR_PREFIX}" ` +
      'prefix.');
  }
  return JSON.parse(payload.slice(QR_PREFIX.length));
}

/**
 * Summarizes what a presentation would disclose, for a consent screen.
 *
 * The spec makes consent the primary privacy control in the app: the user must
 * see exactly which attributes leave the device before anything is sent. This
 * produces that list.
 *
 * @param {object} options - The options.
 * @param {object} options.vp - The presentation about to be sent.
 *
 * @returns {object[]} One `{type, issuer, fields}` entry per credential.
 */
export function describeDisclosure({vp} = {}) {
  const credentials = vp?.verifiableCredential ?? [];
  return credentials.map(credential => {
    const subject = credential?.credentialSubject ?? {};
    const fields = Object.keys(subject)
      // structural identifiers are not disclosed attributes
      .filter(k => !['id', 'type'].includes(k))
      .sort();
    return {
      type: credential?.type?.[1] ?? 'VerifiableCredential',
      issuer: typeof credential?.issuer === 'string' ?
        credential.issuer : credential?.issuer?.id,
      fields
    };
  });
}
