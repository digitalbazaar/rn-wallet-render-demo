/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * A credential card drawn by the issuer's own HTML render method.
 *
 * Drop-in alternative to `CredentialCard` for a credential that supplies a
 * usable HTML render method: same place in the layout, same card footprint, but
 * the markup comes from the issuer instead of from `describeCredential()`.
 *
 * All of the logic lives in `src/render/htmlRenderMethod.js`, which is pure and
 * unit-tested. This file does one thing: put the resulting document in a
 * `WebView`.
 *
 * **The WebView is not the sandbox — it is the host page.** `renderHostPage`
 * returns a document that itself contains
 * `<iframe sandbox="allow-scripts" srcdoc>` holding the issuer's template, plus
 * the specification's `MessageChannel` setup for talking to it. So the template
 * runs in a standard sandboxed iframe here exactly as it would in a browser, and
 * makes the same calls.
 *
 * The WebView props below are defense in depth around that iframe, not the
 * containment itself. The only platform-specific hop is relaying the template's
 * ready/error status from the host page out to React Native, which happens
 * outside the sandbox boundary. See
 * `docs/render-method-sandbox-requirements.md`.
 */
import {ActivityIndicator, StyleSheet, Text, View} from 'react-native';
import React, {useEffect, useRef, useState} from 'react';
import {renderHostPage} from '../../src/render/htmlRenderMethod.js';
import {WebView} from 'react-native-webview';

/* The card is a fixed height: content-sized WebViews need a round trip to
measure, and `renderMethodReady` does not carry size, so the spec's channel does
not help here either. Matches the wallet card's footprint closely enough that
swapping one for the other does not shift the page. */
const CARD_HEIGHT = 260;

/* How long to wait for the template's `ready` signal before showing the card
anyway. A template that never signals is non-conformant, but refusing to display
a credential because of it would be worse than showing it with a warning. */
const READY_TIMEOUT_MS = 5000;

/* `language` is not read here -- `renderHostPage` picks the preference up from
module state. It is a prop so that changing the wallet's language re-runs the
effect below and rebuilds the document; without it the card would keep showing
the language it first rendered in. */
export function HtmlRenderCard({credential, width, language, onTiming}) {
  const [failure, setFailure] = useState(null);
  /* 'waiting' until the template signals, per the spec's renderPromise: resolve
  means display, reject means show the error. 'timeout' is neither — the template
  never answered. */
  const [renderState, setRenderState] = useState('waiting');
  const timedOut = useRef(false);

  /* Async because the template's `digestMultibase` is checked with
  `crypto.subtle.digest` before anything renders. A template that does not match
  its digest never reaches the WebView. */
  const [result, setResult] = useState(null);

  /* Timing, kept in refs so recording a measurement never triggers a re-render
  and changes what is being measured.

  Two phases, reported separately because they cost very differently and an
  aggregate would hide which one dominates:

  · prepare -- filter, decode, and digest-verify the template, in JS
  · display -- WebView mount, iframe creation, template execution, ready signal

  `Date.now()` rather than `performance.now()`: Hermes does not implement the
  latter, and millisecond resolution is enough for figures in this range. */
  const startedAt = useRef(0);
  const preparedAt = useRef(0);

  useEffect(() => {
    let live = true;
    /* A rebuild is a fresh render: go back to waiting so the new document's
    ready signal is what clears the spinner, not the previous one's. */
    setRenderState('waiting');
    timedOut.current = false;
    startedAt.current = Date.now();
    preparedAt.current = 0;
    renderHostPage({credential})
      .then(value => {
        if(!live) {
          return;
        }
        preparedAt.current = Date.now();
        setResult(value);
      })
      .catch(e => live && setResult({error: e.message}));
    return () => {
      live = false;
    };
  }, [credential, language]);

  /* Report once the template signals. Called from the message handler rather
  than an effect so the stamp is taken when the signal lands. */
  function reportTiming({state}) {
    if(!onTiming || !preparedAt.current) {
      return;
    }
    const now = Date.now();
    onTiming({
      prepareMs: preparedAt.current - startedAt.current,
      displayMs: now - preparedAt.current,
      totalMs: now - startedAt.current,
      state
    });
  }

  /* Covers both the digest check and the template's ready signal. */
  const waiting = !result?.error && renderState === 'waiting';

  useEffect(() => {
    if(!waiting) {
      return;
    }
    const timer = setTimeout(() => {
      timedOut.current = true;
      setRenderState('timeout');
    }, READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  /* The template's end of this is `window.renderMethodReady()`, provided by the
  wrapper code the core emits. Inside the sandboxed iframe that call travels over
  a real transferred `MessagePort` to the host page's shim, which relays it out
  to React Native — the one platform-specific hop, and the only reason this
  handler exists. */
  function onMessage({nativeEvent}) {
    if(timedOut.current) {
      return;
    }
    let message;
    try {
      message = JSON.parse(nativeEvent.data);
    } catch {
      // A template can post anything over the bridge; ignore what we can't read.
      return;
    }
    if(message?.type === 'ready') {
      setRenderState('ready');
      reportTiming({state: 'ready'});
    } else if(message?.type === 'error') {
      setRenderState('error');
      setFailure(message.message ?? 'The template reported an error.');
      reportTiming({state: 'error'});
    }
  }

  if(result?.error) {
    return (
      <View style={styles.errorBox}>
        <Text style={styles.errorText}>{result.error}</Text>
      </View>
    );
  }

  return (
    <View>
      {/* Hidden, not unmounted, until the template signals ready: it has to be
      live to run and report back. Absent until the digest check resolves. */}
      {result && (
      <View style={[
        styles.cardFrame, {width}, waiting && styles.cardFrameWaiting
      ]}>
        <WebView
          // The template's ready/error signal arrives here.
          onMessage={onMessage}
          // The host page is passed inline; nothing is loaded from a URL.
          source={{html: result.html}}
          // The sandboxed iframe inside needs scripting; that is the suite's
          // whole contract, and also why the containment matters.
          javaScriptEnabled={true}
          /* Deny the extras a render template has no reason to need. These are
          platform-split per the library's `@platform` tags:
          `domStorageEnabled`/`allowFileAccess` are Android-only, `incognito` is
          iOS-only, and the two `*FromFileURLs` props are cross-platform. */
          domStorageEnabled={false}
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          incognito={true}
          allowsInlineMediaPlayback={false}
          mediaPlaybackRequiresUserAction={true}
          /* Block navigation: a template may render, but it may not take over
          the screen or open anything.

          `originWhitelist` is deliberately NOT set to a narrow value. On a
          non-matching URL react-native-webview calls `Linking.openURL`, handing
          the URL to the system browser — and it does so *before*
          `onShouldStartLoadWithRequest` runs, so a narrow whitelist escalates a
          blocked navigation out of the app instead of stopping it. Allowing
          everything through the whitelist keeps the decision in the handler
          below, which denies by default. */
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={request =>
            request.url === 'about:blank' ||
            request.url.startsWith('about:srcdoc')}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          // No horizontal scroll or zoom, so the card behaves like a card.
          scrollEnabled={false}
          scalesPageToFit={false}
          backgroundColor="transparent"
          onError={({nativeEvent}) =>
            setFailure(nativeEvent.description ?? 'WebView failed to load.')}
          style={styles.webview}
        />
      </View>
      )}

      {waiting && (
        <View style={[styles.placeholder, {width}]}>
          <ActivityIndicator />
          <Text style={styles.placeholderText}>
            Rendering the issuer's template…
          </Text>
        </View>
      )}

      {renderState === 'timeout' && (
        <Text style={styles.note}>
          The template never signalled that it finished rendering, so this card
          may be incomplete.
        </Text>
      )}

      {failure && <Text style={styles.errorText}>{failure}</Text>}

      {/* Surfaced rather than swallowed: a warning here means the issuer's
      render method pointed at a field the credential does not have. */}
      {result?.warnings?.length > 0 && (
        <View style={styles.warnBox}>
          {result.warnings.map(warning => (
            <Text key={warning} style={styles.warnText}>• {warning}</Text>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  cardFrame: {borderRadius: 16, overflow: 'hidden', height: CARD_HEIGHT},
  /* Zero opacity rather than unmounted: the WebView must run to report back. */
  cardFrameWaiting: {opacity: 0, height: 1},
  webview: {flex: 1, backgroundColor: 'transparent'},
  placeholder: {
    height: CARD_HEIGHT, borderRadius: 16, backgroundColor: '#e9ebf0',
    alignItems: 'center', justifyContent: 'center', gap: 10
  },
  placeholderText: {fontSize: 13, color: '#5b5b66'},
  errorBox: {
    backgroundColor: '#fdecec', borderRadius: 12, padding: 14
  },
  errorText: {fontSize: 13, color: '#8c1d1d'},
  warnBox: {
    backgroundColor: '#fff6e0', borderRadius: 12, padding: 12, marginTop: 10
  },
  warnText: {fontSize: 12, color: '#7a5200'},
  note: {fontSize: 12, color: '#7a5200', marginTop: 8, lineHeight: 17}
});
