/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Deriving the wallet's unlock secret, without prompting the user.
 *
 * ## The model
 *
 * There is **no password prompt**. The device lock is the gate, matching how
 * Apple Wallet and shipped mDL apps behave: browsing credentials is open, and
 * adding an app-level password is friction that protects against a threat the
 * OS already handles better.
 *
 * But "no prompt" is not "no key". The unlock secret is a **recovery phrase**
 * generated on first launch and kept in the platform keystore (iOS Keychain /
 * Android Keystore via `expo-secure-store`), retrieved silently on every
 * launch. The user sees nothing; the key is device-bound and hardware-protected
 * rather than sitting in the app bundle.
 *
 * ## Why a phrase rather than raw random bytes
 *
 * Because sync is a stated goal, and device-bound keys are in tension with it:
 * a second device cannot decrypt data whose key never leaves the first device's
 * Secure Enclave. A BIP-39 phrase is the same entropy in a form a human can
 * transcribe, so the same secret can reach another device later **without a
 * migration**. Nothing surfaces the phrase yet — `exportRecoveryPhrase` exists
 * so the door stays open.
 *
 * This matters more on Android than iOS: Keychain entries survive uninstall,
 * Android Keystore entries **do not**. Without a portable secret, an Android
 * reinstall would permanently destroy every stored credential.
 *
 * ## What this protects, and what it does not
 *
 * Protects: another app reading the SQLite file (it gets ciphertext), and the
 * database lifted from a filesystem backup without the keystore entry.
 *
 * Does not protect: anyone who can unlock the device and open the app. That is
 * the intended trade.
 */
import {generateMnemonic, mnemonicToEntropy, validateMnemonic} from
  '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english.js';

/* Keystore item name. Changing this orphans existing credentials, because the
old secret becomes unreachable and the EDV cannot be unwrapped. */
export const SECRET_KEY = 'rn-wallet.unlock.v1';

/* 128 bits -> 12 words. Enough entropy for a KEK; 24 words would be more to
transcribe for no practical gain here. */
const ENTROPY_BITS = 128;

/**
 * Generates a new recovery phrase.
 *
 * @returns {string} A 12-word BIP-39 phrase.
 */
export function generateRecoveryPhrase() {
  return generateMnemonic(wordlist, ENTROPY_BITS);
}

/**
 * Checks a phrase's validity, including its checksum.
 *
 * BIP-39 phrases carry a checksum, so a mistyped word is detectable rather than
 * silently deriving the wrong key and presenting as data loss.
 *
 * @param {string} phrase - The phrase to check.
 *
 * @returns {boolean} `true` if the phrase is well-formed.
 */
export function isValidRecoveryPhrase(phrase) {
  if(typeof phrase !== 'string' || phrase.trim() === '') {
    return false;
  }
  try {
    return validateMnemonic(normalizePhrase(phrase), wordlist);
  } catch {
    return false;
  }
}

/**
 * Normalizes a phrase for comparison and derivation.
 *
 * Whitespace and case vary when a phrase is transcribed or pasted; BIP-39
 * requires single spaces and lowercase, so a phrase that only differs
 * cosmetically must still derive the same key.
 *
 * @param {string} phrase - The phrase to normalize.
 *
 * @returns {string} The normalized phrase.
 */
export function normalizePhrase(phrase) {
  return String(phrase).trim().toLowerCase().split(/\s+/).join(' ');
}

/**
 * Derives the EDV unlock password from a recovery phrase.
 *
 * The phrase's entropy is hex-encoded and used as the password that
 * `PouchEdvClient` runs through PBKDF2. Deriving from entropy rather than the
 * word string means cosmetic differences in the phrase cannot change the key.
 *
 * @param {object} options - The options.
 * @param {string} options.phrase - A valid recovery phrase.
 *
 * @returns {string} The unlock password.
 */
export function passwordFromPhrase({phrase} = {}) {
  const normalized = normalizePhrase(phrase);
  if(!isValidRecoveryPhrase(normalized)) {
    throw new Error('Invalid recovery phrase.');
  }
  const entropy = mnemonicToEntropy(normalized, wordlist);
  return Array.from(entropy, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Gets the unlock secret, generating and storing one on first launch.
 *
 * Silent: no prompt, no UI. The `secureStore` is injected so this is testable
 * without a device, and so a caller can supply a different backend.
 *
 * @param {object} options - The options.
 * @param {object} options.secureStore - An object with async
 *   `getItemAsync(key)` and `setItemAsync(key, value)` methods, e.g.
 *   `expo-secure-store`.
 * @param {string} [options.key] - The keystore item name.
 *
 * @returns {Promise<object>} `{password, phrase, created}`.
 */
export async function getOrCreateUnlockSecret({
  secureStore, key = SECRET_KEY
} = {}) {
  if(!secureStore?.getItemAsync || !secureStore?.setItemAsync) {
    throw new TypeError(
      '"secureStore" must provide getItemAsync and setItemAsync.');
  }

  const existing = await secureStore.getItemAsync(key);

  if(existing) {
    /* A stored value that does not validate means the keystore holds something
    unusable -- a partial write, or a format change. Fail loudly: silently
    generating a replacement would orphan every stored credential and present as
    an empty wallet rather than an error. */
    if(!isValidRecoveryPhrase(existing)) {
      throw new Error(
        'The stored unlock secret is not a valid recovery phrase. Refusing ' +
        'to replace it, because generating a new one would make existing ' +
        'credentials permanently unreadable.');
    }
    return {
      password: passwordFromPhrase({phrase: existing}),
      phrase: existing,
      created: false
    };
  }

  const phrase = generateRecoveryPhrase();
  await secureStore.setItemAsync(key, phrase);
  return {
    password: passwordFromPhrase({phrase}),
    phrase,
    created: true
  };
}

/**
 * Reads the recovery phrase for display or backup.
 *
 * Nothing in the UI surfaces this yet. It exists so the secret is portable from
 * the start — see the module note on sync — and so the phrase can be shown for
 * backup without a migration later.
 *
 * **Displaying this is equivalent to displaying the decryption key.** It must
 * be behind an explicit user action, ideally biometric-gated, and never logged.
 *
 * @param {object} options - The options.
 * @param {object} options.secureStore - The secure store.
 * @param {string} [options.key] - The keystore item name.
 *
 * @returns {Promise<string|null>} The phrase, or `null` if none is stored.
 */
export async function exportRecoveryPhrase({
  secureStore, key = SECRET_KEY
} = {}) {
  const phrase = await secureStore.getItemAsync(key);
  return phrase && isValidRecoveryPhrase(phrase) ? phrase : null;
}

/**
 * Stores a recovery phrase supplied by the user, for restoring on a new device.
 *
 * Refuses to overwrite an existing secret unless `force` is set: doing so would
 * make credentials already on this device unreadable.
 *
 * @param {object} options - The options.
 * @param {object} options.secureStore - The secure store.
 * @param {string} options.phrase - The phrase to import.
 * @param {string} [options.key] - The keystore item name.
 * @param {boolean} [options.force] - Replace an existing secret.
 *
 * @returns {Promise<object>} `{password}`.
 */
export async function importRecoveryPhrase({
  secureStore, phrase, key = SECRET_KEY, force = false
} = {}) {
  const normalized = normalizePhrase(phrase);
  if(!isValidRecoveryPhrase(normalized)) {
    throw new Error(
      'That is not a valid recovery phrase. Check for mistyped or ' +
      'out-of-order words.');
  }
  const existing = await secureStore.getItemAsync(key);
  if(existing && !force) {
    throw new Error(
      'This device already has an unlock secret. Replacing it would make the ' +
      'credentials already stored here unreadable.');
  }
  await secureStore.setItemAsync(key, normalized);
  return {password: passwordFromPhrase({phrase: normalized})};
}
