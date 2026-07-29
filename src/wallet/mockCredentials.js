/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Synthetic credentials for the prototype wallet.
 *
 * **All data here is fabricated.** No real person, licence, policy, or
 * government record is represented, and nothing is fetched from a live issuer.
 * That is deliberate: the spec makes Privacy Officer sign-off a precondition
 * for handling real identity credentials, and a prototype should not be what
 * touches them first.
 *
 * The issuer for the DMV-style credentials is **Utopia**, a fictional
 * jurisdiction, rather than a real state agency. Reproducing a real DMV's
 * identity in a prototype invites exactly the confusion that a stray screenshot
 * causes.
 *
 * Credential shapes follow W3C VC data model conventions so the same rendering
 * code will work against real issued credentials later.
 */

import {normalizeIssuer} from './acceptance.js';

// A fictional jurisdiction, so nothing here can be mistaken for a real record.
export const ISSUER_UTOPIA = 'did:key:z6MkUtopiaDmvMockIssuerDoNotTrust00001';
export const ISSUER_TRUAGE = 'did:key:z6MkTruAgeMockIssuerDoNotTrust000002';
export const ISSUER_INSURER = 'did:key:z6MkMutualMockInsurerDoNotTrust00003';

const HOLDER = 'did:key:z6MkHolderMockSubjectDoNotTrust0000004';

/**
 * A mobile driver's licence, shaped after an mDL summary view.
 */
export const MOCK_DRIVERS_LICENSE = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:11111111-1111-4111-8111-111111111111',
  type: ['VerifiableCredential', 'Iso18013DriversLicenseCredential'],
  issuer: ISSUER_UTOPIA,
  issuanceDate: '2026-04-02T00:00:00Z',
  expirationDate: '2029-03-21T00:00:00Z',
  credentialSubject: {
    id: HOLDER,
    type: 'LicensedDriver',
    // deliberately obvious test values, in the spirit of "MDLTEST FOUR"
    familyName: 'SAMPLEHOLDER',
    givenName: 'ALEX QUINN',
    birthDate: '1985-03-21',
    documentNumber: 'U0000000',
    issuingAuthority: 'Utopia Department of Motor Vehicles',
    issuingJurisdiction: 'UT',
    realId: true
  }
};

/**
 * A disabled person parking placard.
 */
export const MOCK_PARKING_PLACARD = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:22222222-2222-4222-8222-222222222222',
  type: ['VerifiableCredential', 'DisabledPersonPlacardCredential'],
  issuer: ISSUER_UTOPIA,
  issuanceDate: '2026-01-15T00:00:00Z',
  expirationDate: '2028-01-15T00:00:00Z',
  credentialSubject: {
    id: HOLDER,
    type: 'PlacardHolder',
    familyName: 'SAMPLEHOLDER',
    givenName: 'ALEX QUINN',
    placardNumber: 'P0000000',
    placardType: 'Permanent',
    issuingAuthority: 'Utopia Department of Motor Vehicles'
  }
};

/**
 * A digital age-verification credential.
 *
 * Note this carries an `overAge` predicate rather than a birth date — the point
 * of an age credential is to disclose the answer, not the underlying data.
 */
export const MOCK_AGE_VERIFICATION = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:33333333-3333-4333-8333-333333333333',
  type: ['VerifiableCredential', 'OverAgeTokenCredential'],
  issuer: ISSUER_TRUAGE,
  issuanceDate: '2026-06-01T00:00:00Z',
  expirationDate: '2026-12-01T00:00:00Z',
  credentialSubject: {
    id: HOLDER,
    type: 'AgeVerification',
    overAge: 21
  }
};

/**
 * An auto insurance card.
 *
 * Per the requested design this omits any "not official proof of coverage"
 * disclaimer and is presented as verifiable via a QR code instead — which is
 * the actual point of a VC: the verifier checks the signature rather than
 * trusting the rendering.
 */
export const MOCK_INSURANCE_CARD = {
  '@context': ['https://www.w3.org/2018/credentials/v1'],
  id: 'urn:uuid:44444444-4444-4444-8444-444444444444',
  type: ['VerifiableCredential', 'AutoInsuranceCredential'],
  issuer: ISSUER_INSURER,
  issuanceDate: '2026-02-21T00:00:00Z',
  expirationDate: '2026-08-21T00:00:00Z',
  credentialSubject: {
    id: HOLDER,
    type: 'InsuredDriver',
    familyName: 'SAMPLEHOLDER',
    givenName: 'ALEX QUINN',
    policyNumber: '000000000 0000',
    insurer: 'Mutual Mock Insurance',
    coverageType: 'Automobile Liability'
  }
};

export const MOCK_CREDENTIALS = [
  MOCK_DRIVERS_LICENSE,
  MOCK_PARKING_PLACARD,
  MOCK_AGE_VERIFICATION,
  MOCK_INSURANCE_CARD
];

/**
 * Classifies a credential into a display kind, from its `type` array.
 *
 * Kept as a pure function so the card components stay dumb and this logic is
 * testable. Falls back to `generic` rather than throwing: an unknown credential
 * should still render something rather than break the list.
 *
 * @param {object} credential - A verifiable credential.
 *
 * @returns {string} One of `license`, `placard`, `age`, `insurance`,
 *   `generic`.
 */
export function classifyCredential(credential) {
  const types = credential?.type ?? [];
  if(types.includes('Iso18013DriversLicenseCredential')) {
    return 'license';
  }
  if(types.includes('DisabledPersonPlacardCredential')) {
    return 'placard';
  }
  if(types.includes('OverAgeTokenCredential')) {
    return 'age';
  }
  if(types.includes('AutoInsuranceCredential')) {
    return 'insurance';
  }
  return 'generic';
}

/**
 * Builds the display fields for a credential.
 *
 * Returns a title, subtitle, and ordered label/value rows, so each card renders
 * from data rather than hard-coding a layout per credential type.
 *
 * @param {object} credential - A verifiable credential.
 *
 * @returns {object} `{kind, title, subtitle, issuedBy, status, rows}`.
 */
export function describeCredential(credential) {
  const kind = classifyCredential(credential);
  const s = credential?.credentialSubject ?? {};
  const name = [s.familyName, s.givenName].filter(Boolean).join(', ');
  /* An issuer may be a plain DID string OR an object `{id, name, image}` -- the
  VC data model allows both, the mock credentials use strings, and a real
  VC Playground credential uses an object. Normalizing here means a real
  credential shows its issuer name instead of "Unknown issuer". */
  const {name: issuerName} = normalizeIssuer(credential?.issuer);
  const issuedBy = s.issuingAuthority ?? s.insurer ??
    (kind === 'age' ? 'TruAge (mock)' : issuerName);

  const expiry = credential?.expirationDate;
  const status = _isExpired(expiry) ? 'Expired' : 'Active';

  const common = {kind, issuedBy, status, name};

  if(kind === 'license') {
    return {
      ...common,
      title: 'Mobile DL/ID',
      subtitle: 'Driver Licence',
      rows: [
        ['Issued by', s.issuingAuthority],
        ['Data source', 'Utopia DMV (mock)'],
        ['Customer identifier', s.documentNumber],
        ['DOB', _formatDate(s.birthDate)],
        ['REAL ID', s.realId ? 'True' : 'False'],
        ['ISS', _formatDate(credential.issuanceDate)],
        ['EXP', _formatDate(expiry)],
        ['Name', name]
      ]
    };
  }
  if(kind === 'placard') {
    return {
      ...common,
      title: 'Disabled Person Placard',
      subtitle: 'Parking Placard',
      rows: [
        ['Issued by', s.issuingAuthority],
        ['Placard number', s.placardNumber],
        ['Type', s.placardType],
        ['ISS', _formatDate(credential.issuanceDate)],
        ['EXP', _formatDate(expiry)],
        ['Name', name]
      ]
    };
  }
  if(kind === 'age') {
    return {
      ...common,
      title: 'Digital Age Verification',
      subtitle: 'TruAge (mock)',
      rows: [
        ['Verified', `Over ${s.overAge}`],
        ['Issued', _formatDate(credential.issuanceDate)],
        ['EXP', _formatDate(expiry)]
      ]
    };
  }
  if(kind === 'insurance') {
    return {
      ...common,
      title: 'Auto Insurance',
      subtitle: s.insurer,
      rows: [
        ['Policy number', s.policyNumber],
        ['Name of insured', [s.givenName, s.familyName]
          .filter(Boolean).join(' ')],
        ['Effective date', _formatDate(credential.issuanceDate)],
        ['Expiration date', _formatDate(expiry)],
        ['Coverage', s.coverageType]
      ]
    };
  }
  /* Generic fallback for a credential type this wallet does not know -- which
  includes anything freshly accepted from an issuer. Rows must be strings:
  React Native throws if asked to render a raw object, and `issuer` is an object
  on real credentials. */
  return {
    ...common,
    title: credential?.type?.find(t => t !== 'VerifiableCredential') ??
      'Credential',
    subtitle: 'Verifiable Credential',
    rows: [
      ['Issuer', issuerName],
      ...Object.entries(s)
        .filter(([key]) => key !== 'id' && key !== 'type')
        .map(([key, value]) => [_humanize(key), _renderValue(value)])
    ]
  };
}

/* Turns `ownerInformation` into `Owner information` for display. */
function _humanize(key) {
  const spaced = String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* Coerces any credential-subject value into something renderable. Nested
objects and arrays are common in real credentials (`ownerInformation`, `badge`),
and passing one to a React Native <Text> throws. */
function _renderValue(value) {
  if(value === null || value === undefined) {
    return '—';
  }
  if(typeof value === 'string') {
    // data URIs are megabytes of base64; never render one as text
    return value.startsWith('data:') ? '(image)' : value;
  }
  if(typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if(Array.isArray(value)) {
    return value.map(_renderValue).join(', ');
  }
  if(typeof value === 'object') {
    const named = value.name ?? value.title ?? value.id;
    if(typeof named === 'string') {
      return named;
    }
    return Object.entries(value)
      .filter(([, v]) => typeof v !== 'object')
      .map(([k, v]) => `${_humanize(k)}: ${_renderValue(v)}`)
      .join(' · ') || '(details)';
  }
  return String(value);
}

function _isExpired(date) {
  if(!date) {
    return false;
  }
  const t = Date.parse(date);
  return Number.isFinite(t) && t < Date.now();
}

// deterministic, locale-independent formatting so snapshots are stable
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

function _formatDate(value) {
  if(!value) {
    return '—';
  }
  // date-only values must not shift by timezone, so parse the parts directly
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if(dateOnly) {
    const [, y, m, d] = dateOnly;
    return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
  }
  const t = new Date(value);
  if(Number.isNaN(t.getTime())) {
    return String(value);
  }
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`;
}
