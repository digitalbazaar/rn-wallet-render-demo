/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Tab bar icons.
 *
 * Four glyphs on one grid: 24-unit viewBox, 2px stroke, round caps and joins,
 * each centred on 12,12. All four are [lucide](https://lucide.dev) (ISC),
 * vendored rather than depended on — four paths is not worth a dependency, and
 * `react-native-svg` is already a direct dependency here.
 *
 * ## Why these four
 *
 * Diagnostics is the one worth explaining. That screen reports *readings against
 * thresholds* — which crypto implementation is active, whether two
 * implementations agree byte-for-byte, PBKDF2 latency against a 1500 ms budget.
 * A check mark would claim "this is valid", which is credential-verification
 * semantics and a different statement, so `circle-gauge` rather than
 * `badge-check`. Recovery is a key because the 12-word BIP-39 phrase *is* the
 * key material (see `src/wallet/unlock.js`), not a metaphor for it.
 *
 * ## Three properties to match, only one of them obvious
 *
 * 1. **Bounding box** — where the glyph sits. Handled by the shared grid.
 * 2. **Ink** — total stroke length inside the box, which is what the eye reads
 *    as weight. An earlier set matched boxes but not ink and ran 48–80 units, a
 *    1.7x spread: one glyph read as a filled block, another as a faint outline.
 * 3. **Optical overshoot** — round forms are drawn ~1 unit larger than rect
 *    forms so they don't read smaller. See `Diagnostics` below; this is the one
 *    that looks like a misalignment bug and is not.
 *
 * | Tab | Glyph | Source | Box | Visual bottom | Ink |
 * |---|---|---|---|---|---|
 * | Wallet | card | `wallet-minimal` | 18 × 18 | 22 | ~77 |
 * | Scan | QR in viewfinder | `scan-qr-code` | 18 × 18 | 22 | ~49 |
 * | Recovery | key | `key-round` | 20 × 20 | 23 | ~59 |
 * | Diagnostics | dial | `circle-gauge` | 20 × 20 | 23 | ~77 |
 *
 * Two rect glyphs on the 22 line, two round glyphs on the 23 line — lucide's own
 * convention, applied consistently rather than flattened.
 *
 * Scan is the deliberate ink outlier: its openness *is* the viewfinder metaphor,
 * so it is left sparse rather than thickened to hit a number.
 *
 * Recorded alternate for Recovery, if the key reads as too generic on device —
 * lucide `rotate-ccw-key`, a key inside a restore arc. Rejected for now only
 * because it is the heaviest glyph in the set (~87) and its arc sits directly
 * beside the dial's:
 *
 * ```
 * M12 7v6 · M12 9h2 · M3 12a9 9 0 1 0 9-9 9.74 9.74 0 0 0-6.74 2.74L3 8
 * M3 3v5h5 · circle cx=12 cy=15 r=2
 * ```
 */
import {Circle, Path, Svg} from 'react-native-svg';
import React from 'react';

// lucide wallet-minimal (ISC)
function Wallet() {
  return (
    <>
      <Path d="M17 14h.01" />
      <Path
        d={'M7 7h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 ' +
          '1 2-2h14'} />
    </>
  );
}

// lucide scan-qr-code (ISC)
function Scan() {
  return (
    <>
      <Path d="M17 12v4a1 1 0 0 1-1 1h-4" />
      <Path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <Path d="M17 8V7" />
      <Path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <Path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <Path d="M7 17h.01" />
      <Path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <Path d="M7 7h4a1 1 0 0 1 1 1v4H8a1 1 0 0 1-1-1z" />
    </>
  );
}

/* lucide key-round (ISC).

The 12-word BIP-39 phrase IS the key material — see `src/wallet/unlock.js` and
the README's "'No prompt' is not 'no key'". So this is literal, not a metaphor.
An earlier attempt drew the phrase as a card of words and read as the universal
"list view" glyph instead. */
function Recovery() {
  return (
    <>
      <Path
        d={'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 ' +
          '1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 ' +
          '0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z'} />
      <Circle cx="16.5" cy="7.5" r="0.5" fill="currentColor" />
    </>
  );
}

/* lucide circle-gauge (ISC).

A hand-drawn dial came before this one and was abandoned for a reason worth
recording, because it is the kind of thing that looks like a bug and isn't.

A stroke is centred on its path, so a glyph's visually lowest point is its path
bottom plus half the stroke width. Measured across the set:

  wallet-minimal   path 21   visual 22   <- rect-based
  scan-qr-code     path 21   visual 22   <- rect-based
  key-round        path 22   visual 23   <- round
  circle-gauge     path 22   visual 23   <- round

The custom dial was r=9 and bottomed at 20.5, so it floated ~0.6px above the
rect glyphs and ~1.7px above the key. The obvious repair -- drop it until its
bottom matched wallet's 21 -- fixes the wrong error. Round forms in this set sit
1 unit LOWER than rect forms on purpose: a circle inscribed in the same box reads
smaller than a square, so it is oversized to compensate. Same principle as a
typeface drawing `O` slightly past the baseline and x-height. lucide applies it
systematically -- rect glyphs span 18 units, circular ones 20.

So the dial belongs on the 22/23 line with the key, not the 21/22 line with the
card, and lucide already draws it that way. Using the stock glyph also leaves
this file with no bespoke geometry to maintain. */
function Diagnostics() {
  return (
    <>
      <Path d="M15.6 2.7a10 10 0 1 0 5.7 5.7" />
      <Circle cx="12" cy="12" r="2" />
      <Path d="M13.4 10.6 19 5" />
    </>
  );
}

const GLYPHS = {
  wallet: Wallet,
  scan: Scan,
  recovery: Recovery,
  diagnostics: Diagnostics
};

/**
 * Renders a tab bar glyph.
 *
 * @param {object} options - The options.
 * @param {string} options.name - `wallet`, `scan`, `recovery`, or
 *   `diagnostics`.
 * @param {string} options.color - Stroke color.
 * @param {number} [options.size] - Rendered size in px.
 *
 * @returns {object} The icon element.
 */
export function TabIcon({name, color, size = 26}) {
  const Glyph = GLYPHS[name];
  if(!Glyph) {
    /* A missing glyph means `TABS` and this map disagree, which is a typo at
    author time rather than a runtime condition to absorb. Failing loudly here
    beats an invisible gap in the tab bar. */
    throw new Error(
      `Unknown tab icon "${name}"; expected one of ` +
      `${Object.keys(GLYPHS).join(', ')}.`);
  }
  return (
    <Svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke={color} strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round">
      <Glyph />
    </Svg>
  );
}
