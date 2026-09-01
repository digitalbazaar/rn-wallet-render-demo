/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Credential detail: the card, then a swipe-left QR page.
 *
 * Mirrors the reference flow — page 1 shows the credential fields, page 2 shows
 * a QR a verifier can scan, with page dots between them.
 *
 * The QR is regenerated each time this screen opens, matching the reference's
 * "single-use" language. Here that is presentational rather than a real
 * guarantee: without a signed, nonce-bound presentation the payload is
 * replayable, so the label says "regenerated" instead of claiming single-use.
 */
import {
  Dimensions, Pressable, ScrollView, StyleSheet, Text, View
} from 'react-native';
import React, {useMemo, useRef, useState} from 'react';
import {
  createPresentation, describeDisclosure, toQrPayload
} from '../../src/wallet/presentation.js';
import {CredentialCard} from './CredentialCard.js';
import {HtmlRenderCard} from './HtmlRenderCard.js';
import {
  getLanguagePreference, isRenderAllowed, setLanguagePreference
} from '../../src/render/htmlRenderMethod.js';
import QRCode from 'react-native-qrcode-svg';

const {width: SCREEN_WIDTH} = Dimensions.get('window');

/* The languages the demo offers. The library card's template carries a string
table for each; the other templates ignore the setting, which is itself worth
seeing -- localizing is the issuer's choice, not the wallet's. */
const LANGUAGES = [
  {tag: 'en', label: 'English'},
  {tag: 'fr-CA', label: 'Français'},
  {tag: 'ja-JP', label: '日本語'}
];

export function CredentialDetail({credential, description, onClose}) {
  const [page, setPage] = useState(0);
  const [timing, setTiming] = useState(null);
  /* Seeded from the renderer so the control shows the value templates are
  actually getting, rather than a second copy that could drift from it. */
  const [language, setLanguage] = useState(() => getLanguagePreference()[0]);
  const scrollRef = useRef(null);

  /* Gated on the host application's render policy rather than on "has a render
  method": the render path executes issuer-supplied JavaScript, and while it
  renders on both iOS and Android the containment behavior was only checked in
  Chromium. `App.js` declares the policy; the renderer denies by default.
  See docs/render-method-sandbox-requirements.md. */
  const useRenderMethod = isRenderAllowed({credential});

  /* Rebuilt per mount, so reopening the screen yields a fresh payload. */
  const {payload, disclosure} = useMemo(() => {
    const vp = createPresentation({credentials: [credential]});
    return {
      payload: toQrPayload({vp}),
      disclosure: describeDisclosure({vp})
    };
  }, [credential]);

  const pageWidth = SCREEN_WIDTH - 40;

  return (
    <View style={styles.container}>
      {/* A wide, left-aligned Back control. The previous top-right ✕ was both
      small and positioned under the Expo dev-menu bubble, so it was hard to
      hit; a labeled row is unambiguous and matches platform convention. */}
      <View style={styles.topBar}>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Back to wallet"
          hitSlop={12}
          style={({pressed}) => [
            styles.backButton, pressed && styles.backButtonPressed
          ]}>
          <Text style={styles.backChevron}>‹</Text>
          <Text style={styles.backText}>Wallet</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>
          {description.title}
        </Text>
      </View>

      <ScrollView
        style={styles.vertical}
        contentContainerStyle={styles.verticalContent}>
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={e => {
          setPage(Math.round(e.nativeEvent.contentOffset.x / pageWidth));
        }}
        style={styles.pager}>
        <View style={{width: pageWidth}}>
          {/* An issuer that supplied a render method decides how its credential
          looks, so use it instead of the wallet's own layout. Cards without one
          still use `CredentialCard`, which is where the comparison lives. */}
          {useRenderMethod ?
            <HtmlRenderCard
              credential={credential} width={pageWidth}
              language={language} onTiming={setTiming} /> :
            <CredentialCard description={description} onPress={() => {}} />}
          {/* The wallet's language, which is what `navigator.language` reports
          inside the sandbox. Switching it rebuilds the document, so a template
          that localizes itself redraws in the new language. */}
          {useRenderMethod && (
            <View style={styles.langRow}>
              <Text style={styles.langLabel}>Wallet language</Text>
              <View style={styles.langChips}>
                {LANGUAGES.map(({tag, label}) => (
                  <Pressable
                    key={tag}
                    onPress={() => {
                      setLanguagePreference({languages: [tag, 'en']});
                      setLanguage(tag);
                    }}
                    accessibilityRole="button"
                    accessibilityState={{selected: language === tag}}
                    style={[
                      styles.langChip, language === tag && styles.langChipOn
                    ]}>
                    <Text
                      style={[
                        styles.langChipText,
                        language === tag && styles.langChipTextOn
                      ]}>
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
          {/* Shown so a demo reports measured numbers rather than an
          impression. `prepare` is the JS half -- field filtering and the
          SHA-256 digest check; `display` is the WebView mounting, building the
          sandboxed iframe, and the template running to its ready signal. */}
          {timing && (
            <Text style={styles.timing}>
              {`prepare ${timing.prepareMs} ms · display ` +
                `${timing.displayMs} ms · total ${timing.totalMs} ms`}
            </Text>
          )}
          <Text style={styles.hint}>Swipe left for QR code  »</Text>
        </View>

        <View style={{width: pageWidth}}>
          <View style={styles.qrCard}>
            <Text style={styles.qrTitle}>
              This QR code is regenerated each time you open this screen.
            </Text>
            <View style={styles.qrBox}>
              <QRCode value={payload} size={pageWidth - 80} />
            </View>
            <Text style={styles.qrCaption}>
              A verifier scans this to check the credential.
            </Text>
            <Text style={styles.hintLeft}>«  Swipe right for details</Text>
          </View>
        </View>
      </ScrollView>

      <View style={styles.dots}>
        {[0, 1].map(i => (
          <View
            key={i}
            style={[styles.dot, page === i && styles.dotActive]} />
        ))}
      </View>

      {/* The spec makes consent the primary privacy control: the user must see
      exactly which attributes leave the device before anything is sent. */}
      <View style={styles.disclosure}>
        <Text style={styles.disclosureTitle}>This QR discloses</Text>
        {disclosure.map(entry => (
          <Text key={entry.type} style={styles.disclosureText}>
            {entry.type}: {entry.fields.join(', ') || 'no attributes'}
          </Text>
        ))}
        <Text style={styles.caveat}>
          Prototype: this presentation is unsigned and uncompressed, so a real
          verifier would reject it.
        </Text>
      </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#f4f5f7', paddingHorizontal: 20},
  vertical: {flex: 1},
  // room so the disclosure text clears the tab bar on shorter screens
  verticalContent: {paddingBottom: 28},
  topBar: {
    flexDirection: 'row', alignItems: 'center',
    /* Clears the status bar / notch. The wallet list uses paddingTop 56 for the
    same reason; matching it keeps the two screens visually aligned and avoids
    pulling in react-native-safe-area-context for a single inset. */
    paddingTop: 56,
    paddingBottom: 10
  },
  backButton: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 8,
    paddingRight: 14, borderRadius: 8
  },
  backButtonPressed: {opacity: 0.5},
  backChevron: {
    fontSize: 26, color: '#1f3a68', fontWeight: '600', marginRight: 2,
    marginTop: -4
  },
  backText: {fontSize: 16, color: '#1f3a68', fontWeight: '600'},
  topTitle: {
    flex: 1, textAlign: 'right', fontSize: 13, color: '#777',
    marginLeft: 12
  },
  pager: {flexGrow: 0},
  hint: {textAlign: 'center', color: '#666', fontSize: 13, marginTop: 4},
  /* Monospaced so the figures do not jitter as they change between renders. */
  timing: {
    textAlign: 'center', color: '#6b7280', fontSize: 11, marginTop: 8,
    fontFamily: 'Menlo'
  },
  langRow: {marginTop: 14, alignItems: 'center'},
  langLabel: {
    fontSize: 11, color: '#6b7280', fontWeight: '600', letterSpacing: 0.4,
    textTransform: 'uppercase', marginBottom: 8
  },
  langChips: {flexDirection: 'row', gap: 8},
  langChip: {
    paddingVertical: 7, paddingHorizontal: 14, borderRadius: 999,
    backgroundColor: '#e6e9ef', borderWidth: 1, borderColor: '#d4d9e2'
  },
  langChipOn: {backgroundColor: '#1f3a68', borderColor: '#1f3a68'},
  langChipText: {fontSize: 13, color: '#41506b', fontWeight: '600'},
  langChipTextOn: {color: '#fff'},
  hintLeft: {textAlign: 'center', color: '#c3d1ea', fontSize: 13, marginTop: 14},
  qrCard: {backgroundColor: '#1f3a68', borderRadius: 16, padding: 18},
  qrTitle: {
    color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center',
    marginBottom: 14
  },
  qrBox: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14,
    alignItems: 'center'
  },
  qrCaption: {
    color: '#c3d1ea', fontSize: 12, textAlign: 'center', marginTop: 12
  },
  dots: {flexDirection: 'row', justifyContent: 'center', marginTop: 14},
  dot: {
    width: 7, height: 7, borderRadius: 4, backgroundColor: '#c7cbd4',
    marginHorizontal: 4
  },
  dotActive: {backgroundColor: '#1f3a68'},
  disclosure: {marginTop: 22},
  disclosureTitle: {fontSize: 12, fontWeight: '700', color: '#444'},
  disclosureText: {fontSize: 12, color: '#555', marginTop: 4},
  caveat: {fontSize: 11, color: '#8a6d3b', marginTop: 12, lineHeight: 16}
});
