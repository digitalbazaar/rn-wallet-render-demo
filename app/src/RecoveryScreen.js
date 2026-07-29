/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Recovery phrase: back up, or restore onto a new device.
 *
 * ## Why this screen exists
 *
 * `unlock.js` keeps the secret in the platform keystore and never prompts. That
 * is the right default, but it leaves the user with no way to reach a secret
 * they may need — and on Android the keystore entry **does not survive
 * uninstall**, so without this screen a reinstall permanently destroys every
 * stored credential. iOS Keychain does survive, which is why the gap was easy to
 * miss on the platform this was developed against.
 *
 * ## Reveal is gated
 *
 * The phrase is hidden until an explicit tap. **Showing it is equivalent to
 * showing the decryption key** — anyone who photographs this screen can decrypt
 * a copy of the database. The tap is a deliberate speed bump against revealing
 * it by merely wandering into a settings tab.
 *
 * That tap is *not* authentication. It should be biometric-gated
 * (`expo-local-authentication`) before this is shown to anyone outside a demo;
 * that module is not installed, and adding it means another native rebuild, so
 * it is left as the documented next step rather than half-built here.
 *
 * All wording and the restore-safety rule come from `src/wallet/recovery.js`,
 * which is pure and unit-tested. This file supplies the camera-free UI only.
 */
import {Pressable, ScrollView, StyleSheet, Text, TextInput, View} from
  'react-native';
import React, {useCallback, useEffect, useState} from 'react';
import {
  describeRestore, phraseWords
} from '../../src/wallet/recovery.js';
import {exportRecoveryPhrase, importRecoveryPhrase} from
  '../../src/wallet/unlock.js';
import * as SecureStore from 'expo-secure-store';

export function RecoveryScreen() {
  const [phrase, setPhrase] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [mode, setMode] = useState('backup');
  const [entry, setEntry] = useState('');
  const [restoreResult, setRestoreResult] = useState(null);

  /* Read the phrase once so the screen knows whether a secret exists -- that
  determines whether a restore is safe. The phrase is held in state but not
  rendered until revealed. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await exportRecoveryPhrase({secureStore: SecureStore});
        if(!cancelled) {
          setPhrase(stored);
        }
      } catch(e) {
        if(!cancelled) {
          setLoadError(e.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const restore = useCallback(async () => {
    const check = describeRestore({
      phrase: entry, hasExistingSecret: Boolean(phrase)
    });
    if(!check.canRestore) {
      setRestoreResult({ok: false, message: check.reason});
      return;
    }
    try {
      await importRecoveryPhrase({secureStore: SecureStore, phrase: entry});
      setRestoreResult({
        ok: true,
        message: 'Phrase restored. Close and reopen the app to load the ' +
          'credentials it unlocks.'
      });
    } catch(e) {
      setRestoreResult({ok: false, message: e.message});
    }
  }, [entry, phrase]);

  /* Recomputed every keystroke so the button state and the reason shown always
  agree with what a tap would actually do. */
  const check = describeRestore({
    phrase: entry, hasExistingSecret: Boolean(phrase)
  });

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>Recovery</Text>
      <Text style={styles.sub}>
        The phrase that unlocks this wallet&apos;s encrypted storage.
      </Text>

      <View style={styles.switcher}>
        {[
          {key: 'backup', label: 'Back up'},
          {key: 'restore', label: 'Restore'}
        ].map(m => (
          <Pressable
            key={m.key}
            onPress={() => setMode(m.key)}
            accessibilityRole="button"
            style={[styles.switch, mode === m.key && styles.switchActive]}>
            <Text
              style={[
                styles.switchText, mode === m.key && styles.switchTextActive
              ]}>
              {m.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {mode === 'backup' && (
        <View style={styles.card}>
          {loadError && <Text style={styles.error}>{loadError}</Text>}

          {!loadError && phrase === null && (
            <Text style={styles.body}>
              No recovery phrase is stored yet. One is generated the first time
              the wallet opens its storage.
            </Text>
          )}

          {!loadError && phrase && !revealed && (
            <>
              <Text style={styles.warnTitle}>Anyone who sees this can read
                your credentials</Text>
              <Text style={styles.body}>
                These 12 words are the key to your encrypted storage. Write them
                down somewhere private. Do not photograph this screen or store
                the words on another device.
              </Text>
              <Pressable
                style={styles.button}
                accessibilityRole="button"
                onPress={() => setRevealed(true)}>
                <Text style={styles.buttonText}>Reveal phrase</Text>
              </Pressable>
            </>
          )}

          {!loadError && phrase && revealed && (
            <>
              <View style={styles.wordGrid}>
                {phraseWords({phrase}).map(({number, word}) => (
                  <View key={number} style={styles.wordCell}>
                    <Text style={styles.wordNumber}>{number}</Text>
                    <Text style={styles.word}>{word}</Text>
                  </View>
                ))}
              </View>
              <Text style={styles.caveat}>
                Word order matters. On Android the keystore entry is erased when
                the app is uninstalled, so this phrase is the only way back to
                these credentials.
              </Text>
              <Pressable
                style={styles.buttonSecondary}
                accessibilityRole="button"
                onPress={() => setRevealed(false)}>
                <Text style={styles.buttonSecondaryText}>Hide</Text>
              </Pressable>
            </>
          )}
        </View>
      )}

      {mode === 'restore' && (
        <View style={styles.card}>
          <Text style={styles.body}>
            Enter the 12-word phrase from your other device.
          </Text>
          <TextInput
            style={styles.input}
            value={entry}
            onChangeText={text => {
              setEntry(text);
              setRestoreResult(null);
            }}
            placeholder="alpha bravo charlie…"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            accessibilityLabel="Recovery phrase" />

          {/* Shown before the tap, so the refusal and its reason are visible
          rather than arriving as a surprise after typing 12 words. */}
          {!check.empty && !check.canRestore && (
            <Text
              style={check.destructive ? styles.error : styles.pending}>
              {check.reason}
            </Text>
          )}

          <Pressable
            style={[styles.button, !check.canRestore && styles.buttonDisabled]}
            disabled={!check.canRestore}
            accessibilityRole="button"
            onPress={restore}>
            <Text style={styles.buttonText}>Restore wallet</Text>
          </Pressable>

          {restoreResult && (
            <Text style={restoreResult.ok ? styles.success : styles.error}>
              {restoreResult.message}
            </Text>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {padding: 20, paddingTop: 56},
  title: {fontSize: 26, fontWeight: '700', color: '#111'},
  sub: {fontSize: 13, color: '#666', marginTop: 4, marginBottom: 18},
  switcher: {
    flexDirection: 'row', backgroundColor: '#e6e8ec', borderRadius: 10,
    padding: 3, marginBottom: 16
  },
  switch: {flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center'},
  switchActive: {backgroundColor: '#fff'},
  switchText: {fontSize: 13, color: '#777', fontWeight: '600'},
  switchTextActive: {color: '#1f3a68'},
  card: {backgroundColor: '#fff', borderRadius: 16, padding: 18},
  warnTitle: {
    fontSize: 15, fontWeight: '700', color: '#8a6d3b', marginBottom: 8
  },
  body: {fontSize: 14, color: '#444', lineHeight: 20},
  caveat: {fontSize: 11, color: '#8a6d3b', marginTop: 14, lineHeight: 16},
  wordGrid: {flexDirection: 'row', flexWrap: 'wrap'},
  wordCell: {
    flexDirection: 'row', alignItems: 'center', width: '50%',
    paddingVertical: 6
  },
  wordNumber: {
    fontSize: 11, color: '#999', width: 22, textAlign: 'right', marginRight: 8
  },
  word: {fontSize: 15, color: '#111', fontWeight: '600'},
  input: {
    borderWidth: 1, borderColor: '#dfe1e6', borderRadius: 10, padding: 12,
    marginTop: 12, fontSize: 15, color: '#111', minHeight: 88,
    textAlignVertical: 'top'
  },
  button: {
    backgroundColor: '#1f3a68', borderRadius: 10, paddingVertical: 12,
    marginTop: 16, alignItems: 'center'
  },
  buttonDisabled: {opacity: 0.4},
  buttonText: {color: '#fff', fontWeight: '600', fontSize: 14},
  buttonSecondary: {
    borderRadius: 10, paddingVertical: 12, marginTop: 8, alignItems: 'center'
  },
  buttonSecondaryText: {color: '#1f3a68', fontWeight: '600', fontSize: 14},
  pending: {fontSize: 12, color: '#8a6d3b', marginTop: 10, lineHeight: 17},
  error: {fontSize: 13, color: '#cf222e', marginTop: 12, lineHeight: 19},
  success: {fontSize: 13, color: '#1a7f37', marginTop: 12, lineHeight: 19}
});
