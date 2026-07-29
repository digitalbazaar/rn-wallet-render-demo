<!--
Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
-->

# Conforming to the `html` render suite on React Native

How a React Native wallet satisfies the existing
[render method specification](https://w3c.github.io/vc-render-method/). No
changes to the spec are proposed.

**The claim:** a React Native wallet meets the sandbox requirements using the
same mechanisms a browser wallet uses, because it runs the same sandboxed
iframe. React Native adds one hop at the outer edge; it replaces nothing inside
the boundary.

## The two deployments, side by side

A browser wallet puts the issuer's template in a sandboxed iframe inside its own
page. A React Native wallet has no page to put one in — so it makes one. The
WebView becomes the host page, and the sandboxed iframe goes inside it.

```
BROWSER WALLET                        REACT NATIVE WALLET

wallet page          = host page      React Native application
 └─ <iframe                            └─ WebView            = host page
      sandbox="allow-scripts"               └─ <iframe
      srcdoc="…">    = sandbox                   sandbox="allow-scripts"
      └─ wrapper + issuer template              srcdoc="…">  = sandbox
                                                 └─ wrapper + issuer template
```

The nesting is one level deeper. Everything that enforces containment is in the
same place relative to the template:

| | Browser | React Native |
|---|---|---|
| What the template runs in | `<iframe sandbox="allow-scripts" srcdoc>` | `<iframe sandbox="allow-scripts" srcdoc>` |
| Origin of that frame | opaque | opaque |
| CSP over the template | `default-src data: 'unsafe-inline'; frame-src 'none'; form-action 'none'; base-uri 'none'` | identical |
| How the credential arrives | HTML Data Block, `type="application/vc"` | identical |
| How the template reports ready | `window.renderMethodReady()` → transferred `MessagePort` | identical |
| Who creates the `MessageChannel` | the wallet page | the WebView host page |
| Where the status ends up | wallet page JavaScript | one further hop, out to React Native |

Only the last row differs, and it sits **outside** the sandbox boundary — it is
the host application learning that rendering finished, which every wallet does
in whatever way its platform allows.

The consequence worth stating to implementers: **an issuer writes one template.**
The document the template runs in contains no platform reference of any kind — a
test asserts that — so the same template, unmodified, renders in a browser
wallet and a React Native wallet and makes the same calls in both.

### Why the WebView is not the sandbox

The tempting shortcut is to treat the WebView itself as the sandbox: load the
template directly, rely on the WebView's own props for containment. That does
not conform, for two reasons.

1. **The spec's mechanisms are iframe mechanisms.** `sandbox="allow-scripts"`,
   an opaque origin, and a transferred `MessagePort` are defined on frames. A
   WebView has no `sandbox` attribute; its props are a different, narrower, and
   platform-divergent set — several of the obvious ones are Android-only.
2. **It would put the template in the same context as the host shim**, so the
   wrapper code and the code relaying status out to the application would share
   a global. The isolation the suite depends on comes from those being separated
   by an origin boundary.

Creating an iframe inside the WebView costs one extra level of nesting and buys
the specification's guarantees.

## Structure

```
React Native application
  └─ WebView  = host page
       ├─ CSP: default-src data: 'unsafe-inline'; frame-src 'none';
       │        form-action 'none'; base-uri 'none'
       ├─ <iframe sandbox="allow-scripts" srcdoc="…">   ← the sandbox
       │     └─ wrapper code + issuer template
       │          · same CSP
       │          · window.renderMethodReady()
       │          · MessagePort received from the shim
       └─ host shim
            · creates MessageChannel, transfers port2 to the iframe
            · relays {type:'ready'|'error'} out to React Native
```

Because the template runs in a sandboxed iframe, the spec's mechanisms apply as
written — same attributes, same CSP, same `MessageChannel`. `port2` is
transferred between two web contexts inside one document.

`renderToHtml()` returns the sandboxed inner document; `renderHostPage()` wraps
it in the host page. The inner document contains no platform reference at all — a
test asserts that, since the point is that a template makes identical calls
everywhere. The only platform-specific hop is the last one, relaying a status out
to React Native via `window.ReactNativeWebView.postMessage`, which sits outside
the sandbox boundary.

A working implementation is in this repository — see the README to run it, and
`src/render/htmlRenderMethod.js` for the renderer itself.

## Spec requirements and where they are met

Every row is satisfied by the same feature in both deployments. The enforcing
mechanism is a web platform feature in each case, which is the point: React
Native does not substitute anything.

| Requirement | Enforcing feature | Where |
|---|---|---|
| `type` is `TemplateRenderMethod`; `renderSuite` discriminates | — | `findHtmlRenderMethod()` |
| `template` as a URL, including `data:` | — | `_decodeTemplate()` |
| `template` as `{id, mediaType, digestMultibase}` | — | `_decodeTemplate()`; an `https:` `id` errors — only inline `data:` templates render |
| `digestMultibase` is a SHA-2-256 multihash, multibase `u` | `crypto.subtle.digest` | `verifyTemplateDigest()`; `renderHostPage()` refuses a mismatch |
| Template code carries no `<html>`/`<head>`/`<body>` | — | `_toFragment()` strips and warns |
| Filter credential data | `selectJsonLd` over `renderProperty` | `_filterCredential()`, per-pointer |
| Absent `renderProperty` uses the whole credential | — | `_filterCredential()`, with a warning |
| Deliver credential data | HTML Data Block, `type="application/vc"`, in `<head>` | `_assembleDocument()` |
| Prevent network requests | CSP `default-src data: 'unsafe-inline'` | `CSP`, plus `form-action`/`base-uri` |
| Prevent nested framing | CSP `frame-src 'none'` | `CSP` and `HOST_CSP` |
| Prevent navigation and top-level access | `sandbox="allow-scripts"` | `renderHostPage()` |
| Wrapper injected via `srcdoc` | — | `renderHostPage()`, attribute-escaped |
| Signal completion / error | `MessageChannel`, `port2` via `postMessage`, `window.renderMethodReady()` | `HOST_SHIM` and `WRAPPER_CODE` |
| Follow `outputPreference` | `style` width/height on the iframe | `renderHostPage()`, values validated as CSS lengths |

## What the sandbox delivers, and how

`sandbox="allow-scripts"` does a lot of work in one token:

| Effect on the template | Enforcing feature |
|---|---|
| No network access | CSP `default-src data: 'unsafe-inline'`, plus `form-action 'none'; base-uri 'none'` — neither falls back to `default-src` |
| No nested framing | CSP `frame-src 'none'` |
| No top-level navigation | `sandbox`, omitting `allow-top-navigation` |
| No new browsing contexts | `sandbox`, omitting `allow-popups` |
| No local file access | `sandbox` — an opaque origin has no `file:` privileges |
| No persistent state | `sandbox`, omitting `allow-same-origin` — no cookie or storage jar |
| No reach into the embedder | `sandbox`, omitting `allow-same-origin` |
| Scripts still run | `sandbox="allow-scripts"` |
| Can report ready/error | `MessageChannel`, `port2` transferred via `postMessage` |

File access, persistence, and isolation all follow from omitting
`allow-same-origin`: an opaque origin has no filesystem privileges and nothing to
persist into.

The WebView props in `app/src/HtmlRenderCard.js` are defense in depth around that
iframe, not the containment itself. Several do less than they appear to:

| Prop | What it actually does |
|---|---|
| `originWhitelist={['*']}` | Deliberately permissive. On a non-matching URL `react-native-webview` calls `Linking.openURL` — the **system browser** — and does so *before* `onShouldStartLoadWithRequest`, so a narrow whitelist escalates a blocked navigation out of the app instead of stopping it. |
| `onShouldStartLoadWithRequest` | The actual navigation gate. Denies by default; allows only `about:blank` and `about:srcdoc`. |
| `setSupportMultipleWindows={false}` | Blocks popups. Note the spelling — `setSupportsMultipleWindows` is silently ignored by React. |
| `domStorageEnabled={false}`, `allowFileAccess={false}` | **Android only** per the library's `@platform` tags. |
| `incognito={true}` | **iOS only** — the iOS side of the storage guarantee. |
| `allowFileAccessFromFileURLs`, `allowUniversalAccessFromFileURLs` | Cross-platform (ios, macos, android). |
| `javaScriptEnabled={true}` | Required — the template scripts itself. |

## Two details the spec does not state

Both matter because the template is untrusted:

- **A synchronous template signals before the port exists.** The host transfers
  `port2` on the iframe's `onload`, but a template that renders inline calls
  `renderMethodReady()` earlier. Dropping that signal makes a working template
  look like one that hung, so it is buffered until a port arrives.
- **Rendering completes once.** Only the first signal is forwarded, so a template
  cannot report ready and then flip the host into an error state.

The channel crosses the sandbox boundary, so it carries a status and nothing
else.

## Verified in Chromium

- **The full chain.** Sandboxed iframe → `renderMethodReady()` → transferred
  `MessagePort` → host shim → relayed out as `{"type":"ready"}`. A template that
  threw produced `{"type":"error","message":…}`.
- **No egress, with the channel live.** Six escape attempts — `fetch`, an `<img>`
  `src`, an `Image()` beacon, `XMLHttpRequest`, top-level navigation, and
  `window.open` — produced zero requests at a local listener while the ready
  signal still arrived.
- **`form-action`.** Reproduced the form-submission escape under `default-src`
  alone, then confirmed `form-action 'none'` blocks it.
- **`frame-src 'none'` does not block a `srcdoc` frame**, so the host page keeps
  the directive and still gets its iframe.

Unit tests cover the pure core with no mocks.

## Verified on device

The nested `srcdoc` iframe renders and the template's ready signal arrives on
**both iOS and Android**, so the structure works on WKWebView and Android System
WebView, not only in a desktop engine.

## Not verified

- **The containment behavior on a device.** The egress, navigation, and CSP
  checks above were run in Chromium. Nothing confirms the platform engines
  enforce them the same way — and the `<meta>` CSP is honored by the engine
  rather than the renderer, with Android's being user-updatable.
- **Reach from the iframe into the host page**, and whether anything persists
  between sequential renders.

The render path is therefore gated to the bundled demo credential
(`isDemoHtmlCredential()`) rather than to "has an HTML render method".

## Not implemented

- **Remote templates.** A `template.id` pointing at an `https:` URL returns an
  error; only inline `data:` templates render. The digest check is already in
  place, so what is missing is deciding *when* a wallet fetches. Fetching at
  render time tells the issuer each time a holder views the credential, which is
  the tracking harm the sandbox rules exist to prevent — so a fetch belongs at
  credential acceptance, with the result cached by digest. That is a
  wallet-lifecycle change rather than a render-method one. Oblivious HTTP for
  that fetch is moot until then.
- **`outputPreference.accessMode`** other than `visual` is reported as a warning,
  since this renderer only draws.

An earlier revision also failed closed when `renderProperty` was absent, sending
no fields. The spec says the entire credential is used, and says so twice; that
divergence is fixed.

## Scope

The `html` suite renders a **single** credential — a detail view the holder
navigated to. Lists and compact cards are served by the other render methods,
which produce an image rather than a live document. That bounds the cost: a
sandboxed browser engine per credential is affordable when only one is live at a
time. The wallet list uses the generic card layout and creates a WebView only
when a credential is opened.

## Traps worth knowing about

Each of these looked correct and was not. They are listed because another
implementer will hit the same ones:

| Assumption | Reality |
|---|---|
| A CSP `default-src` denies every network destination | `form-action` and `base-uri` do **not** fall back to `default-src`. Under `default-src` alone, a template's form submission reached a listener with its field values in the query string. |
| `originWhitelist={['about:blank']}` blocks navigation | `react-native-webview` hands a non-matching URL to `Linking.openURL` — the system browser — and does so *before* `onShouldStartLoadWithRequest`. A narrow whitelist escalates a blocked navigation out of the app instead of stopping it. |
| `setSupportsMultipleWindows={false}` blocks popups | The prop is `setSupportMultipleWindows`. Misspelled, it is silently ignored and the guard is never active. |
| The containment props work on both platforms | `domStorageEnabled` and `allowFileAccess` are Android-only; `incognito` is iOS-only. You need both sets. |
| `renderProperty` bounds what the template sees | `['']` and a bare string both select the entire credential — the former with no warning at all. |
