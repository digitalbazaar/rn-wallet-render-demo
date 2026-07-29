/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * QR scanner for verifier requests.
 *
 * Classification lives in `src/wallet/scanner.js` (pure, unit-tested); this
 * screen supplies the camera and renders the verdict. It supports both OID4VP
 * and VC-API, and explicitly recognizes an OIDC browser-login URL so scanning
 * one explains itself instead of failing obscurely.
 *
 * **Accepting works** for issuance over VC-API, verified end to end against a
 * live VC Playground exchange. Accepted credentials are persisted to the
 * encrypted store and survive a cold restart.
 *
 * The one thing it does NOT do is verify the issuer's signature, which is called
 * out in the UI rather than left implied.
 */
import {CameraView, useCameraPermissions} from 'expo-camera';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import React, {useCallback, useState} from 'react';
import {acceptFromScan} from '../../src/wallet/acceptance.js';
import {classifyScan, describeScan} from '../../src/wallet/scanner.js';

export function ScannerScreen({onClose, onAccepted}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [result, setResult] = useState(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(null);
  const [error, setError] = useState(null);

  const accept = useCallback(async scan => {
    setAccepting(true);
    setError(null);
    try {
      const outcome = await acceptFromScan({scan, fetch: globalThis.fetch});
      setAccepted(outcome);
      onAccepted?.(outcome.credentials);
    } catch(e) {
      setError(e.message);
    } finally {
      setAccepting(false);
    }
  }, [onAccepted]);

  const onScanned = useCallback(({data}) => {
    // one scan at a time; the user taps to scan again
    setResult(previous => {
      if(previous) {
        return previous;
      }
      const scan = classifyScan({payload: data});
      return {scan, description: describeScan({scan})};
    });
  }, []);

  if(!permission) {
    return <Centered text="Checking camera permission…" onClose={onClose} />;
  }

  if(!permission.granted) {
    return (
      <View style={styles.container}>
        <Header onClose={onClose} title="Scan" />
        <View style={styles.center}>
          <Text style={styles.body}>
            The scanner needs camera access to read a verifier&apos;s QR code.
          </Text>
          <Pressable style={styles.button} onPress={requestPermission}>
            <Text style={styles.buttonText}>Grant camera access</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* The destination's name, matching the tab that opens it. "Scan a
      verifier QR" was instruction masquerading as a title and no longer fits
      beside the close control at 26px; the instruction is body copy below. */}
      <Header onClose={onClose} title="Scan" />

      {!result && (
        <View style={styles.cameraWrap}>
          <CameraView
            style={styles.camera}
            barcodeScannerSettings={{barcodeTypes: ['qr']}}
            onBarcodeScanned={onScanned} />
          <Text style={styles.hint}>
            Point the camera at an OID4VP or VC-API QR code.
          </Text>
        </View>
      )}

      {result && (
        <View style={styles.resultBox}>
          <Text
            style={[
              styles.resultTitle,
              {color: result.description.actionable ? '#1a7f37' : '#8a6d3b'}
            ]}>
            {result.description.title}
          </Text>
          <Text style={styles.body}>{result.description.message}</Text>

          {result.scan.url && (
            <Text style={styles.url} numberOfLines={3}>
              {result.scan.url}
            </Text>
          )}

          {accepted && (
            <View style={styles.accepted}>
              <Text style={styles.acceptedTitle}>
                Accepted {accepted.credentials.length} credential
                {accepted.credentials.length === 1 ? '' : 's'}
              </Text>
              {accepted.summary.map(item => (
                <View key={item.type} style={styles.acceptedItem}>
                  <Text style={styles.acceptedType}>{item.type}</Text>
                  <Text style={styles.body}>
                    Issued by {item.issuer}
                    {item.signed ? ' · signed' : ' · UNSIGNED'}
                  </Text>
                  <Text style={styles.acceptedFields}>
                    {item.fields.join(', ')}
                  </Text>
                </View>
              ))}
              <Text style={styles.caveat}>
                Saved to encrypted storage and shown in the Wallet tab. The
                issuer&apos;s signature is not verified.
              </Text>
            </View>
          )}

          {error && <Text style={styles.error}>{error}</Text>}

          {result.description.actionable && !accepted && (
            <Pressable
              style={[styles.button, accepting && styles.buttonDisabled]}
              disabled={accepting}
              onPress={() => accept(result.scan)}>
              <Text style={styles.buttonText}>
                {accepting ? 'Accepting…' : 'Accept credential'}
              </Text>
            </Pressable>
          )}

          <Pressable
            style={styles.buttonSecondary}
            onPress={() => {
              setResult(null);
              setAccepted(null);
              setError(null);
            }}>
            <Text style={styles.buttonSecondaryText}>Scan another</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function Header({title, onClose}) {
  return (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>{title}</Text>
      <Pressable
        onPress={onClose} accessibilityRole="button"
        accessibilityLabel="Close" style={styles.closeButton}>
        <Text style={styles.closeText}>✕</Text>
      </Pressable>
    </View>
  );
}

function Centered({text, onClose}) {
  return (
    <View style={styles.container}>
      <Header onClose={onClose} title="Scan" />
      <View style={styles.center}>
        <Text style={styles.body}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#f4f5f7', paddingHorizontal: 20},
  header: {
    /* Clears the status bar / Dynamic Island. `App.js`, `CredentialDetail`, and
    `RecoveryScreen` all use 56 for this; this screen used 12, so its title
    overlapped the clock and the notch. Latent at the old 18px size, obvious once
    the title matched the other screens at 26px. */
    flexDirection: 'row', alignItems: 'center', paddingTop: 56,
    paddingBottom: 10
  },
  /* 26/700 matches every other screen title -- see DiagnosticsScreen. */
  headerTitle: {flex: 1, fontSize: 26, fontWeight: '700', color: '#111'},
  closeButton: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: '#e2e4e9',
    alignItems: 'center', justifyContent: 'center'
  },
  closeText: {fontSize: 15, color: '#333', fontWeight: '600'},
  cameraWrap: {flex: 1},
  camera: {flex: 1, borderRadius: 16, overflow: 'hidden'},
  hint: {
    textAlign: 'center', color: '#666', fontSize: 13, marginTop: 12,
    marginBottom: 20
  },
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  body: {fontSize: 14, color: '#444', lineHeight: 20, textAlign: 'center'},
  resultBox: {
    backgroundColor: '#fff', borderRadius: 16, padding: 18, marginTop: 10
  },
  resultTitle: {fontSize: 16, fontWeight: '700', marginBottom: 8},
  url: {
    fontSize: 11, color: '#555', marginTop: 12, fontFamily: 'Courier'
  },
  caveat: {fontSize: 11, color: '#8a6d3b', marginTop: 12, lineHeight: 16},
  button: {
    backgroundColor: '#1f3a68', borderRadius: 10, paddingVertical: 12,
    paddingHorizontal: 18, marginTop: 18, alignItems: 'center'
  },
  buttonText: {color: '#fff', fontWeight: '600', fontSize: 14},
  buttonDisabled: {opacity: 0.6},
  buttonSecondary: {
    borderRadius: 10, paddingVertical: 12, marginTop: 10, alignItems: 'center'
  },
  buttonSecondaryText: {color: '#1f3a68', fontWeight: '600', fontSize: 14},
  accepted: {
    marginTop: 14, borderTopWidth: 1, borderTopColor: '#e2e4e9', paddingTop: 14
  },
  acceptedTitle: {fontSize: 15, fontWeight: '700', color: '#1a7f37'},
  acceptedItem: {marginTop: 10},
  acceptedType: {fontSize: 14, fontWeight: '600', color: '#111'},
  acceptedFields: {fontSize: 11, color: '#777', marginTop: 2},
  error: {fontSize: 13, color: '#cf222e', marginTop: 12, lineHeight: 19}
});
