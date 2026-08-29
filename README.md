# HTML render method on React Native

A working demo: four verifiable credentials whose cards are drawn by the
**issuer's** HTML template, running on iOS and Android.

The [`html` render suite](https://w3c.github.io/vc-render-method/) is defined in
terms of a sandboxed iframe, which native mobile does not have. This shows the
suite is implementable there anyway, using the specification's own mechanisms
rather than substitutes.

> Prototype. All credential data is synthetic and issuer signatures are not
> verified. See [Limitations](#limitations).

## Watch it

https://github.com/user-attachments/assets/89e14e4a-03b5-4e36-ab82-d297510bc533

Opening each of the three credentials on iOS. ([source](https://github.com/digitalbazaar/rn-wallet-render-demo/issues/1))
Still captures from both platforms, with the measured render times, are in
[`docs/screenshots.md`](docs/screenshots.md).

## Run it

Needs Xcode with an iOS simulator runtime.

```sh
npm install
npm test              # 336 tests, no device needed

cd app
npm install
npm run prebuild      # generates ios/ (gitignored)
npx pod-install       # links react-native-webview -- required
npm run ios
```

`pod-install` is not optional. The renderer draws into a `react-native-webview`,
which is a **native** module: skip it and the JavaScript still loads, the app
still runs, and the cards silently never appear.

Open the **Wallet** tab and tap a credential. Each detail screen shows the
issuer's card, with `prepare` and `display` timings underneath.

## How it works

The WebView is **not** the sandbox. It is the host page, and it contains a
sandboxed iframe holding the issuer's template:

```
BROWSER WALLET                      REACT NATIVE WALLET

wallet page       = host page       React Native app
 └─ <iframe                          └─ WebView         = host page
      sandbox="allow-scripts"             └─ <iframe
      srcdoc>     = sandbox                    sandbox="allow-scripts"
      └─ issuer template                       srcdoc>   = sandbox
                                                └─ issuer template
```

One extra level of nesting; everything enforcing containment sits in the same
place relative to the template. The sandbox attribute, the opaque origin, the
CSP, and the `MessagePort` carrying the ready signal are web platform features,
used as specified.

**An issuer writes one template.** The document it runs in holds no platform
reference of any kind — a test asserts this — so the same template renders
unmodified in a browser wallet and here.

That extends to language. The suite says nothing about how a template learns
which language to render in, and the sandbox default is the *device* locale —
the wrong value, and a fingerprinting signal the holder never agreed to give the
issuer. Here the wallet sets it, and the sandboxed document redefines
`navigator.language` to return it, so a template localizes itself through the
standard API rather than a wallet-specific one. The fourth card, a library card,
renders in English, French, or Japanese from the control on its detail screen.
The write-up, including why the obvious one-line version of that override leaks
the device locale anyway, is in
[`docs/render-method-sandbox-requirements.md`](docs/render-method-sandbox-requirements.md).

The only React Native-specific step is the last one, relaying the finished
status out to the application. That sits outside the sandbox boundary.

[`docs/render-method-sandbox-requirements.md`](docs/render-method-sandbox-requirements.md)
maps each requirement in the specification to the feature that enforces it, in
both deployments.

## Limitations

- **Containment is verified in Chromium, not on the platform engines.** The
  egress, navigation, and CSP checks were run in a desktop browser. Nothing
  confirms WKWebView and the Android System WebView enforce them identically,
  and Android's engine is user-updatable. Because of that, rendering is limited
  to credentials the application names up front — the four bundled here — and
  the check is object identity rather than `id`, so nothing arriving from a
  scanner can reach the template path.
- **Only inline (`data:`) templates work.** A `template.id` pointing at an
  `https:` URL returns an error rather than being fetched. A production wallet
  should fetch the template once, when the credential is accepted, and cache it
  by digest — fetching on each render would tell the issuer every time the
  holder looks at their credential. That caching is not implemented here.
- **Issuer signatures are not verified**, matching the browser wallet stack this
  is built from.
- **All credential data is synthetic** — a fictional jurisdiction, obvious test
  values, `DoNotTrust` issuer DIDs.

## License

Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
