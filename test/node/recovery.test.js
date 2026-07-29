/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tests for recovery-phrase presentation and restore safety.
 *
 * These cover the logic a settings screen needs but should not contain: how a
 * phrase is laid out for transcription, and whether a restore is safe to run.
 * Restore is destructive — it makes credentials already on the device
 * unreadable — so the decision belongs in a tested function rather than in a
 * button handler.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeRestore, formatPhraseForDisplay, phraseWords
} from '../../src/wallet/recovery.js';
import {
  generateRecoveryPhrase, isValidRecoveryPhrase
} from '../../src/wallet/unlock.js';

/* Builds a 12-word phrase that definitely fails its checksum.
Swapping one word is not enough on its own: BIP-39's checksum is 4 bits at this
entropy, so a substituted word still validates about 1 time in 16. Measured at
6.5% over 2000 trials -- a test built that way would fail roughly one run in
fifteen. Search until the checksum actually rejects, so the test is
deterministic. */
function _phraseFailingChecksum() {
  for(let attempt = 0; attempt < 100; ++attempt) {
    const words = generateRecoveryPhrase().split(' ');
    words[3] = words[3] === 'zoo' ? 'zone' : 'zoo';
    const candidate = words.join(' ');
    if(!isValidRecoveryPhrase(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not construct a checksum-failing phrase.');
}

test('phraseWords splits a phrase into numbered words', () => {
  const words = phraseWords({phrase: 'alpha bravo charlie'});
  assert.deepEqual(words, [
    {number: 1, word: 'alpha'},
    {number: 2, word: 'bravo'},
    {number: 3, word: 'charlie'}
  ]);
});

test('phraseWords normalizes spacing and case', () => {
  // a pasted phrase may arrive with odd whitespace or capitals
  const words = phraseWords({phrase: '  Alpha   BRAVO\ncharlie '});
  assert.deepEqual(words.map(w => w.word), ['alpha', 'bravo', 'charlie']);
});

test('phraseWords returns nothing for an absent phrase', () => {
  assert.deepEqual(phraseWords({phrase: null}), []);
  assert.deepEqual(phraseWords({}), []);
});

test('formatPhraseForDisplay numbers every word of a real phrase', () => {
  const phrase = generateRecoveryPhrase();
  const text = formatPhraseForDisplay({phrase});
  assert.equal(text.split('\n').length, 12);
  assert.match(text, /^1\. \w+/);
  assert.match(text, /\n12\. \w+$/);
});

test('describeRestore refuses when a secret already exists', () => {
  const phrase = generateRecoveryPhrase();
  const result = describeRestore({phrase, hasExistingSecret: true});
  assert.equal(result.canRestore, false);
  assert.equal(result.destructive, true);
  /* The message must say what is lost, not just that it is blocked -- a bare
  "cannot restore" gives the user no way to reason about the trade. */
  assert.match(result.reason, /unreadable/i);
});

test('describeRestore allows a valid phrase on a fresh device', () => {
  const phrase = generateRecoveryPhrase();
  const result = describeRestore({phrase, hasExistingSecret: false});
  assert.equal(result.canRestore, true);
  assert.equal(result.destructive, false);
});

test('describeRestore rejects a 12-word phrase that fails its checksum', () => {
  /* Checksum failure must be reported as a typo, because that is the likely
  cause when transcribing 12 words by hand. The phrase is the right length, so
  this exercises the checksum rather than the word count. */
  const phrase = _phraseFailingChecksum();
  const result = describeRestore({phrase, hasExistingSecret: false});
  assert.equal(result.canRestore, false);
  assert.match(result.reason, /mistyped|not valid/i);
});

test('describeRestore reports a wrong-length phrase distinctly', () => {
  const short = generateRecoveryPhrase().split(' ').slice(0, 8).join(' ');
  const result = describeRestore({phrase: short, hasExistingSecret: false});
  assert.equal(result.canRestore, false);
  assert.match(result.reason, /12 words/);
});

test('describeRestore treats an empty phrase as nothing entered', () => {
  const result = describeRestore({phrase: '   ', hasExistingSecret: false});
  assert.equal(result.canRestore, false);
  assert.equal(result.empty, true);
});
