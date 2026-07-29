/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Crypto and storage diagnostics, shown as the "Checks" tab.
 *
 * This was the original deliverable and is kept because it is what proves the
 * layer under the wallet UI actually works: native crypto, and an encrypted
 * credential round-tripping through SQLite.
 *
 * Check logic lives in `src/verify/{deviceChecks,storageChecks}.js` (pure,
 * unit-tested); this file wires it to the device and renders results.
 */
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import React, {useEffect, useState} from 'react';
import {createSubtle} from '../../src/shim/install.js';
import {runDeviceChecks} from '../../src/verify/deviceChecks.js';
import {runStorageChecks} from '../../src/verify/storageChecks.js';

/* Storage checks need the real SQLite adapter and the patched `web-pouch-edv`.
Imported statically so Metro bundles them -- same lesson as the crypto provider:
a runtime `require` of a variable specifier is never bundled.

The storage checks run through `PouchEdvClient` -- the package's public API and
what the wallet will actually use, so it exercises the full encrypted path
(PBKDF2 -> KEK -> AES-KW -> AES-GCM -> SQLite) rather than internals. */
import SQLiteAdapter from 'pouchdb-adapter-react-native-sqlite';
import * as pouchEdv from '@bedrock/web-pouch-edv';

// `bootstrapCrypto()` already ran in index.js; re-running would be a no-op that
// obscures what actually got installed, so read the globals it configured.
function useCryptoChecks() {
  const [state, setState] = useState({status: 'running'});

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const active = globalThis.crypto?.subtle;
        if(!active) {
          throw new Error(
            'No crypto.subtle installed -- did bootstrapCrypto() run first?');
        }
        const getRandomValues = a => globalThis.crypto.getRandomValues(a);
        // An independent pure-JS instance to compare the active one against.
        const reference = createSubtle({getRandomValues});

        const result = globalThis.__cryptoBootstrapResult ?? {
          implementation: 'unknown',
          reason: 'bootstrap result not recorded -- did index.js run?'
        };

        /* `expectNative` must NOT be derived from `result.implementation`, or
        the check becomes a tautology that can never fail. It is an independent
        assertion of intent, set in `index.js` from whether the optional native
        module could be resolved at all. Running in Expo Go leaves it false;
        running a dev build that bundled quick-crypto sets it true, so a dev
        build that silently fell back to pure JS FAILS the check -- which is the
        outcome this harness exists to catch. */
        const expectNative = globalThis.__expectNativeCrypto === true;

        const crypto = await runDeviceChecks({
          result,
          active,
          reference,
          expectNative,
          getRandomValues,
          now: () => globalThis.performance?.now?.() ?? Date.now()
        });

        if(cancelled) {
          return;
        }
        // Show crypto results before starting storage, which is slower.
        setState({status: 'running-storage', crypto, result});

        /* Storage runs second and on the real SQLite adapter. This is the one
        thing the Node baseline could not verify: `pouchdb-adapter-memory` fails
        the EDV path with "database is closed" from PouchDB's own LevelDB
        backend, so the encrypted round-trip is genuinely first exercised here. */
        const storage = await runStorageChecks({
          pouchEdv,
          adapter: 'react-native-sqlite',
          plugin: SQLiteAdapter
        });

        if(!cancelled) {
          setState({status: 'done', crypto, storage, result});
        }
      } catch(e) {
        if(!cancelled) {
          setState({status: 'error', message: e.message});
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#fff'},
  content: {padding: 20, paddingTop: 60},
  /* 26/700 matches every other screen title. The tab bar shows glyphs only, so
  this is now the sole name the destination has and must not be the odd one. */
  title: {fontSize: 26, fontWeight: '700', marginBottom: 16, color: '#111'},
  pass: {fontSize: 16, fontWeight: '700', color: '#1a7f37', marginBottom: 4},
  fail: {fontSize: 16, fontWeight: '700', color: '#cf222e', marginBottom: 4},
  implementation: {
    fontSize: 13, color: '#444', marginBottom: 16, fontVariant: ['tabular-nums']
  },
  heading: {
    fontSize: 15, fontWeight: '700', color: '#111', marginTop: 22,
    marginBottom: 6
  },
  row: {flexDirection: 'row', marginBottom: 14},
  mark: {width: 22, fontSize: 16, fontWeight: '700'},
  rowBody: {flex: 1},
  checkName: {fontSize: 14, fontWeight: '600', color: '#111'},
  detail: {fontSize: 13, color: '#555', marginTop: 2, lineHeight: 18},
  footnote: {fontSize: 12, color: '#777', marginTop: 20, lineHeight: 17}
});

function CheckRow({check}) {
  const mark = check.skipped ? '—' : (check.pass ? '✓' : '✗');
  const color = check.skipped ? '#888' : (check.pass ? '#1a7f37' : '#cf222e');
  return (
    <View style={styles.row}>
      <Text style={[styles.mark, {color}]}>{mark}</Text>
      <View style={styles.rowBody}>
        <Text style={styles.checkName}>{check.name}</Text>
        <Text style={styles.detail}>{check.detail}</Text>
      </View>
    </View>
  );
}

function Section({heading, suite, pending}) {
  if(pending) {
    return (
      <View>
        <Text style={styles.heading}>{heading}</Text>
        <Text style={styles.detail}>Running…</Text>
      </View>
    );
  }
  if(!suite) {
    return null;
  }
  return (
    <View>
      <Text style={styles.heading}>{heading}</Text>
      <Text style={suite.pass ? styles.pass : styles.fail}>
        {suite.pass ? 'PASSED' : 'FAILED'}
      </Text>
      {suite.checks.map(check => (
        <CheckRow key={check.name} check={check} />
      ))}
    </View>
  );
}

export function DiagnosticsScreen() {
  const state = useCryptoChecks();
  const running = state.status === 'running';
  const runningStorage = state.status === 'running-storage';
  const done = state.status === 'done';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Diagnostics</Text>

      {state.status === 'error' && (
        <View>
          <Text style={styles.fail}>Harness error</Text>
          <Text style={styles.detail}>{state.message}</Text>
        </View>
      )}

      {(runningStorage || done) && (
        <Text style={styles.implementation}>
          crypto implementation: {state.result.implementation}
        </Text>
      )}

      <Section heading="Crypto" suite={state.crypto} pending={running} />
      <Section
        heading="Storage (SQLite)" suite={state.storage}
        pending={runningStorage} />

      {done && (
        <Text style={styles.footnote}>
          A dev build should report &quot;native&quot; crypto. Storage runs on
          pouchdb-adapter-react-native-sqlite — the encrypted round-trip cannot
          be verified under Node, so this is its first real exercise.
        </Text>
      )}
    </ScrollView>
  );
}

