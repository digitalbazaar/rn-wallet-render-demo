/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Credential card rendering.
 *
 * Cards render from `describeCredential()` output rather than per-type layouts,
 * so adding a credential type is a data change.
 *
 * **Styling is deliberately generic.** The reference designs carry real agency
 * and insurer branding; reproducing that in a prototype risks a screenshot being
 * mistaken for an official app. Same information and layout, visually distinct
 * palette, and every card is marked as sample data.
 */
import {Pressable, StyleSheet, Text, View} from 'react-native';
import React from 'react';

/* One palette entry per credential kind. Chosen to be clearly distinct from the
real products these are modeled on. */
const PALETTE = {
  license: {bg: '#1f3a68', fg: '#ffffff', dim: '#c3d1ea'},
  placard: {bg: '#1d4f4a', fg: '#ffffff', dim: '#bfdcd8'},
  age: {bg: '#43356b', fg: '#ffffff', dim: '#d2c8ea'},
  insurance: {bg: '#5a3320', fg: '#ffffff', dim: '#e6cdbf'},
  generic: {bg: '#3a3a3a', fg: '#ffffff', dim: '#cccccc'}
};

const GLYPH = {
  license: 'ID',
  placard: '♿',
  age: '21+',
  insurance: '⛨',
  generic: '◈'
};

export function CredentialCard({description, onPress, compact = false}) {
  const theme = PALETTE[description.kind] ?? PALETTE.generic;
  const expired = description.status === 'Expired';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${description.title}, ${description.status}`}
      style={({pressed}) => [
        styles.card,
        {backgroundColor: theme.bg, opacity: pressed ? 0.85 : 1}
      ]}>
      <View style={styles.headerRow}>
        <View style={styles.glyphBox}>
          <Text style={styles.glyph}>{GLYPH[description.kind] ?? '◈'}</Text>
        </View>
        <View style={styles.headerText}>
          <Text style={[styles.title, {color: theme.fg}]}>
            {description.title}
          </Text>
          <Text style={[styles.subtitle, {color: theme.dim}]}>
            {description.subtitle}
          </Text>
        </View>
        <Text
          style={[
            styles.status,
            {color: expired ? '#ffb3b3' : '#9ff0c4'}
          ]}>
          {expired ? '✕ ' : '✓ '}{description.status}
        </Text>
      </View>

      {!compact && (
        <View style={styles.rows}>
          {description.rows.map(([label, value]) => (
            <View key={label} style={styles.row}>
              <Text style={[styles.label, {color: theme.dim}]}>{label}</Text>
              <Text style={[styles.value, {color: theme.fg}]}>
                {value ?? '—'}
              </Text>
            </View>
          ))}
        </View>
      )}

      {compact && (
        <Text style={[styles.issuedBy, {color: theme.dim}]}>
          Issued by {description.issuedBy}
        </Text>
      )}

      {/* Every card says it is sample data, so a screenshot cannot be mistaken
      for a real credential. */}
      <Text style={[styles.sampleTag, {color: theme.dim}]}>
        SAMPLE DATA · NOT A REAL CREDENTIAL
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {borderRadius: 16, padding: 18, marginBottom: 14},
  headerRow: {flexDirection: 'row', alignItems: 'center'},
  glyphBox: {
    width: 44, height: 44, borderRadius: 10, marginRight: 12,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center', justifyContent: 'center'
  },
  glyph: {fontSize: 18, fontWeight: '700', color: '#fff'},
  headerText: {flex: 1},
  title: {fontSize: 16, fontWeight: '700'},
  subtitle: {fontSize: 13, marginTop: 2},
  status: {fontSize: 12, fontWeight: '700'},
  rows: {marginTop: 16},
  row: {marginBottom: 10},
  label: {
    fontSize: 11, fontWeight: '600', letterSpacing: 0.4,
    textTransform: 'uppercase'
  },
  value: {fontSize: 15, marginTop: 2},
  issuedBy: {fontSize: 12, marginTop: 12},
  sampleTag: {
    fontSize: 9, fontWeight: '700', letterSpacing: 0.6, marginTop: 14,
    opacity: 0.85
  }
});
