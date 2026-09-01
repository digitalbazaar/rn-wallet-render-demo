/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tests for the unlock secret.
 *
 * The secure store is injected, so the keystore behavior — including the
 * platform difference that motivated a portable phrase — is testable without a
 * device.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  exportRecoveryPhrase, generateRecoveryPhrase, getOrCreateUnlockSecret,
  importRecoveryPhrase, isValidRecoveryPhrase, normalizePhrase,
  passwordFromPhrase, SECRET_KEY
} from '../../src/wallet/unlock.js';

function fakeSecureStore(initial = {}) {
  const items = {...initial};
  return {
    items,
    async getItemAsync(key) {
      return items[key] ?? null;
    },
    async setItemAsync(key, value) {
      items[key] = value;
    }
  };
}

/* Builds a 12-word phrase that definitely fails its checksum.
Swapping one word is not enough on its own: BIP-39's checksum is 4 bits at this
entropy, so a substituted word still validates about 1 time in 16. Search until
the checksum actually rejects, so the test is deterministic. Mirrors the helper
in `recovery.test.js`. */
function _phraseFailingChecksum() {
  for(let attempt = 0; attempt < 100; ++attempt) {
    const words = generateRecoveryPhrase().split(' ');
    words[0] = words[0] === 'abandon' ? 'ability' : 'abandon';
    const candidate = words.join(' ');
    if(!isValidRecoveryPhrase(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not construct a checksum-failing phrase.');
}

/* --- phrases --- */

test('generateRecoveryPhrase produces a valid 12-word phrase', () => {
  const phrase = generateRecoveryPhrase();
  assert.equal(phrase.split(' ').length, 12);
  assert.equal(isValidRecoveryPhrase(phrase), true);
});

test('generated phrases are unique', () => {
  const seen = new Set();
  for(let i = 0; i < 50; ++i) {
    seen.add(generateRecoveryPhrase());
  }
  assert.equal(seen.size, 50);
});

test('isValidRecoveryPhrase rejects junk and detects typos', () => {
  assert.equal(isValidRecoveryPhrase(''), false);
  assert.equal(isValidRecoveryPhrase('not a real phrase at all'), false);
  assert.equal(isValidRecoveryPhrase(undefined), false);

  /* BIP-39 carries a checksum, so a swapped word is detectable rather than
  silently deriving the wrong key -- which would present as data loss. The
  checksum is only 4 bits at this entropy, so one substitution passes it about
  1 time in 16; `_phraseFailingChecksum` searches for one that does not. */
  assert.equal(
    isValidRecoveryPhrase(_phraseFailingChecksum()), false,
    'a mistyped word must fail the checksum');
});

test('normalizePhrase makes cosmetic differences irrelevant', () => {
  const phrase = generateRecoveryPhrase();
  const messy = `  ${phrase.toUpperCase().replace(/ /g, '   ')}  `;
  assert.equal(normalizePhrase(messy), phrase);
});

/* --- deriving the password --- */

test('passwordFromPhrase is deterministic', () => {
  const phrase = generateRecoveryPhrase();
  assert.equal(
    passwordFromPhrase({phrase}), passwordFromPhrase({phrase}));
});

test('passwordFromPhrase ignores whitespace and case', () => {
  // a transcribed phrase must unlock the same store
  const phrase = generateRecoveryPhrase();
  assert.equal(
    passwordFromPhrase({phrase}),
    passwordFromPhrase({phrase: `  ${phrase.toUpperCase()}  `}));
});

test('different phrases derive different passwords', () => {
  assert.notEqual(
    passwordFromPhrase({phrase: generateRecoveryPhrase()}),
    passwordFromPhrase({phrase: generateRecoveryPhrase()}));
});

test('passwordFromPhrase refuses an invalid phrase', () => {
  assert.throws(
    () => passwordFromPhrase({phrase: 'nonsense words here'}),
    /Invalid recovery phrase/);
});

/* --- first launch and subsequent launches --- */

test('getOrCreateUnlockSecret generates and stores on first launch',
  async () => {
    const secureStore = fakeSecureStore();
    const result = await getOrCreateUnlockSecret({secureStore});
    assert.equal(result.created, true);
    assert.ok(result.password);
    assert.equal(isValidRecoveryPhrase(result.phrase), true);
    assert.equal(
      secureStore.items[SECRET_KEY], result.phrase,
      'persisted to the keystore');
  });

test('getOrCreateUnlockSecret reuses the stored secret', async () => {
  const secureStore = fakeSecureStore();
  const first = await getOrCreateUnlockSecret({secureStore});
  const second = await getOrCreateUnlockSecret({secureStore});
  assert.equal(second.created, false);
  assert.equal(
    second.password, first.password,
    'the same password must be derived, or credentials become unreadable');
});

test('getOrCreateUnlockSecret never prompts', async () => {
  /* The whole design point: the device lock is the gate. There is nothing to
  call for user input, so a prompt cannot be introduced accidentally. */
  const secureStore = fakeSecureStore();
  const result = await getOrCreateUnlockSecret({secureStore});
  assert.equal(typeof result.password, 'string');
  assert.equal(Object.keys(result).sort().join(','), 'created,password,phrase');
});

test('getOrCreateUnlockSecret refuses to replace a corrupt secret',
  async () => {
  /* Silently generating a replacement would orphan every stored credential and
  present as an empty wallet rather than an error. */
    const secureStore = fakeSecureStore({[SECRET_KEY]: 'garbage value'});
    await assert.rejects(
      () => getOrCreateUnlockSecret({secureStore}),
      /Refusing to replace/);
    assert.equal(
      secureStore.items[SECRET_KEY], 'garbage value', 'left untouched');
  });

test('getOrCreateUnlockSecret validates the store it was given', async () => {
  await assert.rejects(
    () => getOrCreateUnlockSecret({secureStore: {}}),
    /getItemAsync and setItemAsync/);
});

/* --- portability, which is what makes sync possible later --- */

test('exportRecoveryPhrase returns the stored phrase', async () => {
  const secureStore = fakeSecureStore();
  const {phrase} = await getOrCreateUnlockSecret({secureStore});
  assert.equal(await exportRecoveryPhrase({secureStore}), phrase);
});

test('exportRecoveryPhrase returns null when nothing is stored', async () => {
  assert.equal(
    await exportRecoveryPhrase({secureStore: fakeSecureStore()}), null);
});

test('importRecoveryPhrase restores the SAME password on a new device',
  async () => {
  /* This is the property that makes sync possible without a migration: the
  phrase from device A derives the identical unlock password on device B. It is
  also what saves an Android user after a reinstall, since Android Keystore
  entries are destroyed on uninstall while iOS Keychain entries survive. */
    const deviceA = fakeSecureStore();
    const {phrase, password} = await getOrCreateUnlockSecret(
      {secureStore: deviceA});

    const deviceB = fakeSecureStore();
    const restored = await importRecoveryPhrase({secureStore: deviceB, phrase});
    assert.equal(restored.password, password);
    assert.equal(deviceB.items[SECRET_KEY], phrase);
  });

test('importRecoveryPhrase accepts a transcribed phrase', async () => {
  const deviceA = fakeSecureStore();
  const {phrase, password} = await getOrCreateUnlockSecret(
    {secureStore: deviceA});
  // as a user might retype it
  const typed = `  ${phrase.toUpperCase().replace(/ /g, '  ')} `;
  const restored = await importRecoveryPhrase(
    {secureStore: fakeSecureStore(), phrase: typed});
  assert.equal(restored.password, password);
});

test('importRecoveryPhrase will not clobber an existing secret', async () => {
  const secureStore = fakeSecureStore();
  const {phrase: original} = await getOrCreateUnlockSecret({secureStore});
  await assert.rejects(
    () => importRecoveryPhrase({
      secureStore, phrase: generateRecoveryPhrase()
    }), /already has an unlock secret/);
  assert.equal(secureStore.items[SECRET_KEY], original, 'unchanged');
});

test('importRecoveryPhrase can be forced', async () => {
  const secureStore = fakeSecureStore();
  await getOrCreateUnlockSecret({secureStore});
  const replacement = generateRecoveryPhrase();
  await importRecoveryPhrase({secureStore, phrase: replacement, force: true});
  assert.equal(secureStore.items[SECRET_KEY], replacement);
});

test('importRecoveryPhrase rejects a mistyped phrase with guidance',
  async () => {
    await assert.rejects(
      () => importRecoveryPhrase({
        secureStore: fakeSecureStore(), phrase: 'clearly not valid words here'
      }), /mistyped or out-of-order/);
  });
