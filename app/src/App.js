/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Prototype wallet.
 *
 * Four tabs: the credential list, a QR scanner, recovery-phrase backup, and the
 * crypto/storage diagnostics that were the earlier deliverable — kept, because
 * they are what prove the layer underneath this UI actually works.
 *
 * All credential data is synthetic and every card is labeled as such. The
 * DMV-style credentials are issued by "Utopia", a fictional jurisdiction, rather
 * than a real agency.
 *
 * The sample cards come from `src/wallet/mockCredentials.js` and stay in memory.
 * Credentials **accepted from an issuer** are written through the verified EDV
 * path and survive a cold restart. The Privacy Officer precondition in the spec
 * still applies to *real* identity documents; everything stored here is
 * synthetic.
 */
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import React, {useState} from 'react';
import {AppRegistry} from 'react-native';
import {CredentialCard} from './CredentialCard.js';
import {CredentialDetail} from './CredentialDetail.js';
import {describeCredential} from '../../src/wallet/mockCredentials.js';
import {DiagnosticsScreen} from './DiagnosticsScreen.js';
import {MOCK_HTML_CREDENTIALS} from '../../src/render/mockHtmlCredential.js';
import {RecoveryScreen} from './RecoveryScreen.js';
import {ScannerScreen} from './ScannerScreen.js';
import {setRenderPolicy} from '../../src/render/htmlRenderMethod.js';
import {TabIcon} from './TabIcon.js';

/* Persistence. Statically imported so Metro bundles them -- a runtime
`require`/`import()` of a variable specifier is never bundled. */
import SQLiteAdapter from 'pouchdb-adapter-react-native-sqlite';
import * as pouchEdv from '@bedrock/web-pouch-edv';
import {VerifiableCredentialStore} from '@bedrock/web-vc-store';
import {
  loadCredentials, openCredentialStore, saveCredentials
} from '../../src/wallet/store.js';
import {getOrCreateUnlockSecret} from '../../src/wallet/unlock.js';
import * as SecureStore from 'expo-secure-store';

/* The bar shows glyphs only; each screen names itself at the top. `label`
therefore stops being display text and becomes the ACCESSIBLE name — with no
visible text, it is the only name a screen reader has.

`diagnostics` was `checks`, which disagreed with the screen it opens: that screen
has always titled itself "Diagnostics", and diagnostics is the accurate word.
These are measurements against thresholds, not a verdict on a credential. */
const TABS = [
  {key: 'wallet', label: 'Wallet'},
  {key: 'scan', label: 'Scan'},
  {key: 'recovery', label: 'Recovery'},
  {key: 'diagnostics', label: 'Diagnostics'}
];

/* Idle glyph color. Not `#888`, which is 3.5:1 on white and fails the 4.5:1
minimum — tolerable when a label sat beside it, not when the glyph carries the
tab alone. `#6b7280` measures 4.8:1 and still reads clearly unselected. */
const TAB_IDLE = '#6b7280';
const TAB_ACTIVE = '#1f3a68';

/* Declare which credentials may execute their issuer's JavaScript. The renderer
denies everything until this runs, so the demo credentials are named here rather
than the renderer knowing about them -- which is what lets `src/render/` drop
into another application unchanged.

Module scope, not an effect: the policy must be in place before any render, and
a credential opened on first paint would otherwise race it. */
setRenderPolicy({credentials: MOCK_HTML_CREDENTIALS});

export default function App() {
  const [tab, setTab] = useState('wallet');
  const [selected, setSelected] = useState(null);
  /* Credentials loaded from, and saved to, encrypted SQLite storage. */
  const [stored, setStored] = useState([]);
  const [storeState, setStoreState] = useState({status: 'opening'});
  const storeRef = React.useRef(null);

  /* Open the credential store once and load what is already there. The adapter
  must be configured before any database is opened, so that happens first. */
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        pouchEdv.setAdapter({
          adapter: 'react-native-sqlite', plugin: SQLiteAdapter
        });
        /* No prompt: the unlock secret comes from the platform keystore
        (iOS Keychain / Android Keystore), generated silently on first launch.
        The device lock is the gate. */
        const {password} = await getOrCreateUnlockSecret({
          secureStore: SecureStore
        });
        const {store, created} = await openCredentialStore({
          pouchEdv, VerifiableCredentialStore, password
        });
        storeRef.current = store;
        const credentials = await loadCredentials({store});
        if(!cancelled) {
          setStored(credentials);
          setStoreState({status: 'ready', created});
        }
      } catch(e) {
        if(!cancelled) {
          setStoreState({status: 'error', message: e.message});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Every bundled credential carries an HTML render method, so the list shows
  only issuer-drawn cards. The generic mock credentials in `mockCredentials.js`
  are deliberately left out rather than deleted: `describeCredential` and
  `classifyCredential` still back the list rows and the detail screen's
  disclosure list, and the existing suite covers them. */
  const described = [
    ...MOCK_HTML_CREDENTIALS, ...stored
  ].map(credential => ({
    credential, description: describeCredential(credential)
  }));

  /* The detail view renders INSIDE the tab layout rather than replacing it.
  Returning it early removed the tab bar, which left the small top-right ✕ as
  the only way back -- and on a dev build that sits under the Expo dev-menu
  bubble, so it was effectively unreachable. */
  return (
    <View style={styles.root}>
      <View style={styles.body}>
        {/* One detail screen for every credential. Whether the card on it is
        drawn by the wallet or by the issuer's render method is decided inside
        `CredentialDetail`, so the QR page and its disclosure list are the same
        either way. */}
        {selected && (
          <CredentialDetail
            credential={selected.credential}
            description={selected.description}
            onClose={() => setSelected(null)} />
        )}

        {!selected && tab === 'wallet' && (
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.title}>My Wallet</Text>
            <Text style={styles.sub}>
              {described.length} credentials · {_storageLabel(
                {storeState, storedCount: stored.length})}
            </Text>
            {described.map(item => (
              <CredentialCard
                key={item.credential.id ?? item.description.title}
                description={item.description}
                compact
                onPress={() => setSelected(item)} />
            ))}
          </ScrollView>
        )}

        {!selected && tab === 'scan' && (
          <ScannerScreen
            onClose={() => setTab('wallet')}
            onAccepted={async credentials => {
              const store = storeRef.current;
              if(!store) {
                return;
              }
              /* Persist first, then reload from storage rather than appending
              to state. Reloading means the list always reflects what is
              actually stored -- if a save failed, the credential does not
              appear, instead of showing a credential the wallet does not
              really have. */
              await saveCredentials({store, credentials});
              setStored(await loadCredentials({store}));
            }} />
        )}
        {!selected && tab === 'recovery' && <RecoveryScreen />}
        {!selected && tab === 'diagnostics' && <DiagnosticsScreen />}
      </View>

      <View style={styles.tabBar}>
        {TABS.map(t => {
          const selectedTab = tab === t.key;
          return (
            <Pressable
              key={t.key}
              onPress={() => {
                setSelected(null);
                setTab(t.key);
              }}
              /* `tab` rather than `button`, with `selected` state, so the bar
              announces "Wallet, tab, selected, 1 of 4" instead of four
              unrelated buttons. The label is mandatory now that no text is
              rendered. */
              accessibilityRole="tab"
              accessibilityLabel={t.label}
              accessibilityState={{selected: selectedTab}}
              hitSlop={8}
              style={styles.tab}>
              {/* Position and shape carry the selection, not hue alone — a
              tinted pill survives greyscale and color blindness, which matters
              more once the label is gone. */}
              <View
                style={[styles.tabHit, selectedTab && styles.tabHitActive]}>
                <TabIcon
                  name={t.key}
                  color={selectedTab ? TAB_ACTIVE : TAB_IDLE} />
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/* Describes the storage state in the subtitle, so a failure to open the store is
visible rather than looking like an empty wallet. */
function _storageLabel({storeState, storedCount}) {
  if(storeState.status === 'opening') {
    return 'opening storage…';
  }
  if(storeState.status === 'error') {
    return `storage unavailable: ${storeState.message}`;
  }
  if(storedCount === 0) {
    return 'sample data · storage ready';
  }
  return `${storedCount} stored · encrypted on device`;
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#f4f5f7'},
  body: {flex: 1},
  content: {padding: 20, paddingTop: 56},
  title: {fontSize: 26, fontWeight: '700', color: '#111'},
  sub: {fontSize: 13, color: '#666', marginTop: 4, marginBottom: 20},
  /* The vertical padding lives on `tab`, NOT here. With it on the container the
  Pressable had no height of its own, so the touch target was the label's line
  box -- roughly 18px -- ringed by 34px of dead space that looked tappable. */
  tabBar: {
    flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#dfe1e6',
    backgroundColor: '#fff'
  },
  tab: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingTop: 8, paddingBottom: 22, minHeight: 48
  },
  tabHit: {
    width: 46, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center'
  },
  tabHitActive: {backgroundColor: '#eaeff8'}
});

AppRegistry.registerComponent('main', () => App);
