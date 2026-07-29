/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Presenting a recovery phrase, and deciding whether a restore is safe.
 *
 * `src/wallet/unlock.js` owns the secret itself. This module owns the two
 * decisions a settings screen needs but should not make inline:
 *
 * - **How a phrase is laid out** for someone copying it onto paper. Numbered
 *   words, because word order is part of the secret and an unnumbered list
 *   invites transcribing it out of order.
 * - **Whether a restore is safe to run**, and if not, why — in words that name
 *   the consequence rather than just blocking the button.
 *
 * Both are pure, so the wording and the safety rule are testable without a
 * device. The screen renders what these return.
 */
import {isValidRecoveryPhrase, normalizePhrase} from './unlock.js';

/* BIP-39 at 128 bits of entropy. Matches ENTROPY_BITS in unlock.js; a phrase of
another length is a transcription error, not a different-but-valid secret. */
const EXPECTED_WORDS = 12;

/**
 * Splits a phrase into numbered words for display.
 *
 * @param {object} options - The options.
 * @param {string} [options.phrase] - The phrase.
 *
 * @returns {object[]} `{number, word}` entries, or `[]` if there is no phrase.
 */
export function phraseWords({phrase} = {}) {
  if(typeof phrase !== 'string' || phrase.trim() === '') {
    return [];
  }
  return normalizePhrase(phrase)
    .split(' ')
    .map((word, i) => ({number: i + 1, word}));
}

/**
 * Formats a phrase as numbered lines.
 *
 * Numbered because word order is part of the secret; an unnumbered list invites
 * transcribing the words out of order.
 *
 * @param {object} options - The options.
 * @param {string} [options.phrase] - The phrase.
 *
 * @returns {string} One `N. Word` line per word.
 */
export function formatPhraseForDisplay({phrase} = {}) {
  return phraseWords({phrase})
    .map(({number, word}) => `${number}. ${word}`)
    .join('\n');
}

/**
 * Decides whether a phrase can be restored onto this device.
 *
 * Restore is destructive: importing a different secret leaves the credentials
 * already stored here encrypted under a key nothing holds. So an existing
 * secret blocks the restore, and the reason names that consequence — a bare
 * refusal gives the user no way to reason about it.
 *
 * Failures are distinguished because they have different fixes: an empty box
 * means nothing was entered, a wrong word count means a word was dropped, and a
 * checksum failure means a word was mistyped or reordered.
 *
 * @param {object} options - The options.
 * @param {string} [options.phrase] - The phrase the user entered.
 * @param {boolean} [options.hasExistingSecret] - Whether this device already
 *   holds an unlock secret.
 *
 * @returns {object} `{canRestore, destructive, empty, reason}`.
 */
export function describeRestore({phrase, hasExistingSecret = false} = {}) {
  const normalized = typeof phrase === 'string' ? normalizePhrase(phrase) : '';

  if(normalized === '') {
    return {
      canRestore: false,
      destructive: false,
      empty: true,
      reason: 'Enter the 12-word phrase from your other device.'
    };
  }

  const count = normalized.split(' ').length;
  if(count !== EXPECTED_WORDS) {
    return {
      canRestore: false,
      destructive: false,
      empty: false,
      reason: `A recovery phrase is 12 words; this one has ${count}.`
    };
  }

  if(!isValidRecoveryPhrase(normalized)) {
    /* BIP-39's checksum catches this, which is why the phrase is words rather
    than raw hex -- a mistyped word is detected here instead of silently
    deriving the wrong key and presenting as an empty wallet. */
    return {
      canRestore: false,
      destructive: false,
      empty: false,
      reason: 'That phrase is not valid. Check for mistyped or out-of-order ' +
        'words.'
    };
  }

  if(hasExistingSecret) {
    return {
      canRestore: false,
      destructive: true,
      empty: false,
      reason: 'This device already has a wallet. Restoring a different ' +
        'phrase would make the credentials already stored here permanently ' +
        'unreadable.'
    };
  }

  return {
    canRestore: true,
    destructive: false,
    empty: false,
    reason: 'Ready to restore.'
  };
}
