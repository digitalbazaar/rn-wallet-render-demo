<!--
Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
-->

# The demo, on device

Captured from the iOS Simulator (iPhone 15) and an Android emulator
(Medium Phone, API 35), both running this repository unchanged.

## The wallet list

Three credentials, each carrying an `html` render method. The list itself uses
the wallet's own layout — a render method draws the detail view, not the row.

These list captures predate the library card; the wallet now holds four
render-method credentials.

| iOS | Android |
|---|---|
| <img src="screenshots/ios-wallet-list.png" width="300" alt="Wallet list on iOS showing three credentials"> | <img src="screenshots/android-wallet-list.png" width="300" alt="Wallet list on Android showing three credentials"> |

## While the template renders

Tapping a credential opens a single-credential page. The card is hidden until
the template signals `renderMethodReady()` over its `MessagePort`, so a
half-drawn card is never shown. A template that never signals is displayed
anyway after five seconds, with a warning.

| iOS | Android |
|---|---|
| <img src="screenshots/ios-rendering.png" width="300" alt="Loading state on iOS: a spinner and the text Rendering the issuer's template"> | <img src="screenshots/android-rendering.png" width="300" alt="Loading state on Android: a spinner and the text Rendering the issuer's template"> |

This state is normally too brief to see — these were captured with the card
held in its loading state deliberately.

## The issuer's card

The markup, layout, and colors come from the template the issuer shipped inside
the credential. The wallet contributes the surrounding page.

| iOS — first responder badge | Android — arboretum membership |
|---|---|
| <img src="screenshots/ios-badge-card.png" width="300" alt="A dark green first responder badge rendered on iOS"> | <img src="screenshots/android-membership-card.png" width="300" alt="A green landscape membership card rendered on Android"> |

Two of the four bundled templates, chosen to show that the layout is the
issuer's decision: one portrait badge with a seal and a field list, one
landscape membership card whose renewal pill is computed by the template rather
than carried as a field.

## Timings

The line under each card reports two phases:

- **prepare** — filtering the credential to its `renderProperty` fields and
  verifying the template's SHA-256 digest, in JavaScript.
- **display** — the WebView mounting, the sandboxed iframe being created, the
  template executing, and its ready signal arriving back.

| Capture | prepare | display | total |
|---|---|---|---|
| Android, membership card | 4 ms | 98 ms | **102 ms** |
| Android, first responder badge | 3 ms | 130 ms | **133 ms** |
| iOS, first responder badge (cold) | 3 ms | 278 ms | **281 ms** |

The JavaScript half is a few milliseconds; the cost is the WebView. The iOS
figure is a **cold** first open, where the engine starts up as part of the
measurement — the Android figures are warm. Expect the first credential opened
in a session to be the slow one and every later one to land near 100 ms.

These are **debug builds on a simulator and an emulator**. A release build on
real hardware was not measured.

## The template picks its own language

The library card's template carries string tables for English, French, and
Japanese and chooses one by reading `navigator.language` — the standard API,
with the value the *wallet* set rather than the device locale. Switching the
wallet language rebuilds the document, and the template redraws.

The tag in the corner of each card is `navigator.language` as the template read
it, and the date is formatted by `Intl.DateTimeFormat` with the same tag, so the
month name and the numeral order follow from it rather than a second table.

| English | Français | 日本語 |
|---|---|---|
| <img src="screenshots/ios-library-card-en.png" width="260" alt="A purple library card rendered on iOS in English, tagged en, expiring January 14, 2030"> | <img src="screenshots/ios-library-card-fr.png" width="260" alt="The same library card rendered in French, tagged fr-CA, expiring 14 janvier 2030"> | <img src="screenshots/ios-library-card-ja.png" width="260" alt="The same library card rendered in Japanese, tagged ja-JP, expiring 2030年1月14日"> |

The other three templates ignore the setting, which is the point: localizing is
the issuer's decision, taken in the template, not something the wallet imposes.

The `html` render suite does not specify any of this — see
[`render-method-sandbox-requirements.md`](render-method-sandbox-requirements.md)
for what the gap is and why the override has to be pinned in two places.
