/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Phase 0, part 2: prove `minimal-cipher` — the layer that actually encrypts
 * EDV document payloads — round-trips a real credential through the pure-JS
 * shim.
 *
 * `Kek.js` protects key material; `minimal-cipher` protects the document
 * itself. Both must work for local storage to be viable, so this covers the
 * half the `web-pouch-edv` tests do not.
 *
 * Note: this test exercises the Node-resolved variant of `minimal-cipher`,
 * because Node's resolver ignores the `browser` field. The browser variant
 * differs only in where it sources crypto from (`globalThis.crypto` instead of
 * `node:crypto`) and uses the same `@noble` primitives, so an AES-GCM
 * round-trip here plus the shim's own Node-interop tests together cover the
 * RN path. Confirming the browser variant end-to-end needs a Metro bundle and
 * is tracked as an open item in the plan.
 */
import assert from 'node:assert/strict';
import {Cipher} from '@digitalbazaar/minimal-cipher';
import test from 'node:test';
import {webcrypto} from 'node:crypto';
import {X25519KeyAgreementKey2020} from
  '@digitalbazaar/x25519-key-agreement-key-2020';

// A representative credential, shaped like what CredentialStore persists.
const CREDENTIAL = {
  '@context': [
    'https://www.w3.org/2018/credentials/v1',
    'https://w3id.org/vc/status-list/2021/v1'
  ],
  id: 'urn:uuid:5d0e5f7a-1f0e-4a5b-9c3d-2f8e1a7b4c60',
  type: ['VerifiableCredential', 'UniversityDegreeCredential'],
  issuer: 'did:key:z6MkjRagNiMu91DduvCvgEsqLZDVzrJzFrwahc4tXLt9DoHd',
  issuanceDate: '2026-01-15T00:00:00Z',
  credentialSubject: {
    id: 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    degree: {type: 'BachelorDegree', name: 'Bachelor of Science'}
  }
};

async function createRecipientKey() {
  const keyPair = await X25519KeyAgreementKey2020.generate({
    controller: 'did:example:recipient'
  });
  return keyPair;
}

test('minimal-cipher round-trips a credential, X25519 + AES-GCM', async () => {
  const cipher = new Cipher();
  const keyPair = await createRecipientKey();
  const recipients = [{
    header: {kid: keyPair.id, alg: 'ECDH-ES+A256KW'}
  }];
  const keyResolver = async ({id}) => {
    if(id !== keyPair.id) {
      throw new Error(`Unexpected key id "${id}".`);
    }
    return keyPair.export({publicKey: true});
  };

  const jwe = await cipher.encryptObject({
    obj: CREDENTIAL, recipients, keyResolver
  });

  // structural checks on the JWE
  assert.equal(typeof jwe.protected, 'string');
  assert.equal(typeof jwe.iv, 'string');
  assert.equal(typeof jwe.ciphertext, 'string');
  assert.equal(typeof jwe.tag, 'string');
  assert.equal(Array.isArray(jwe.recipients), true);
  assert.equal(jwe.recipients.length, 1);

  // the plaintext must not be recoverable from the JWE by inspection
  const serialized = JSON.stringify(jwe);
  assert.equal(
    serialized.includes('BachelorDegree'), false,
    'ciphertext must not leak credential contents');
  assert.equal(
    serialized.includes('UniversityDegreeCredential'), false);

  const decrypted = await cipher.decryptObject({
    jwe, keyAgreementKey: keyPair
  });
  assert.deepEqual(decrypted, CREDENTIAL, 'exact round-trip');
});

test('minimal-cipher decryption fails with the wrong key', async () => {
  const cipher = new Cipher();
  const keyPair = await createRecipientKey();
  const other = await createRecipientKey();

  const jwe = await cipher.encryptObject({
    obj: {secret: 'value'},
    recipients: [{header: {kid: keyPair.id, alg: 'ECDH-ES+A256KW'}}],
    keyResolver: async () => keyPair.export({publicKey: true})
  });

  // a different recipient key must not decrypt
  const result = await cipher.decryptObject({
    jwe, keyAgreementKey: other
  }).catch(e => e);
  assert.equal(
    result === null || result instanceof Error, true,
    'wrong key must not yield plaintext');
});

test('minimal-cipher detects tampered ciphertext', async () => {
  const cipher = new Cipher();
  const keyPair = await createRecipientKey();

  const jwe = await cipher.encryptObject({
    obj: CREDENTIAL,
    recipients: [{header: {kid: keyPair.id, alg: 'ECDH-ES+A256KW'}}],
    keyResolver: async () => keyPair.export({publicKey: true})
  });

  // flip a byte in the base64url ciphertext
  const chars = jwe.ciphertext.split('');
  chars[0] = chars[0] === 'A' ? 'B' : 'A';
  const tampered = {...jwe, ciphertext: chars.join('')};

  const result = await cipher.decryptObject({
    jwe: tampered, keyAgreementKey: keyPair
  }).catch(e => e);
  assert.equal(
    result === null || result instanceof Error, true,
    'AEAD tag must reject tampering');
});

test('shim AES-GCM is byte-compatible with the cipher suite', async () => {
  // minimal-cipher's a256gcm uses AES-256-GCM with a 12-byte IV and 16-byte
  // tag appended. Confirm the shim's encrypt matches Node for that exact
  // shape, which is what makes RN-written documents readable on web.
  const {createSubtle} = await import('../../src/shim/install.js');
  const subtle = createSubtle({
    getRandomValues: a => webcrypto.getRandomValues(a)
  });

  const keyBytes = webcrypto.getRandomValues(new Uint8Array(32));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(CREDENTIAL));

  const shimKey = await subtle.importKey(
    'raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const shimCt = await subtle.encrypt({name: 'AES-GCM', iv}, shimKey, data);

  const nodeKey = await webcrypto.subtle.importKey(
    'raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const nodeCt = await webcrypto.subtle.encrypt(
    {name: 'AES-GCM', iv}, nodeKey, data);

  assert.equal(
    Buffer.from(shimCt).toString('hex'),
    Buffer.from(nodeCt).toString('hex'),
    'identical ciphertext and tag');
});
