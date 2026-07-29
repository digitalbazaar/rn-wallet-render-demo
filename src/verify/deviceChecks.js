/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * The on-device verification checks: that the native crypto provider is in use,
 * and that it performs acceptably. Extracted here as the functional core so the
 * logic is testable under plain Node, with the RN screen acting as the
 * imperative shell.
 *
 * Each check takes its dependencies as arguments and returns a plain result
 * object rather than logging or throwing, so the same code drives both the
 * on-device UI and the Node test suite.
 *
 * The three questions these answer:
 *
 * 1. Is the native implementation actually active in a dev build?
 * 2. Are native and pure-JS output byte-compatible? (Data written under one
 *    must be readable under the other, or a user switching build types loses
 *    access to their credentials.)
 * 3. Is PBKDF2 unlock latency acceptable at the real iteration count?
 */

/* Ceiling for a password unlock before it feels broken. Chosen as a UX
threshold, not a security one -- if unlock exceeds this, the fix is native
crypto, NEVER lowering the iteration count. */
export const UNLOCK_BUDGET_MS = 1500;

// `web-pouch-edv`'s default; do not lower to make a benchmark pass
export const PBKDF2_ITERATIONS = 100000;

/**
 * Reports which `subtle` implementation is active and whether that is expected.
 *
 * @param {object} options - The options.
 * @param {object} options.result - The `bootstrapCrypto()` return value.
 * @param {boolean} options.expectNative - Whether a dev build with native
 *   crypto is expected (false for Expo Go).
 *
 * @returns {object} The check result.
 */
export function checkImplementation({result, expectNative}) {
  const {implementation, reason, missing} = result;
  const pass = expectNative ?
    implementation === 'native' :
    implementation === 'pure-js' || implementation === 'native';

  return {
    name: 'active implementation',
    pass,
    implementation,
    detail: expectNative && implementation !== 'native' ?
      `expected native, got "${implementation}" (${reason})` +
        (missing?.length ? `; missing: ${missing.join(', ')}` : '') :
      `${implementation} (${reason})`
  };
}

/**
 * Verifies two `subtle` implementations produce interoperable AES-KW output.
 *
 * This is the check that actually matters for data safety: if a credential's
 * content key is wrapped by native crypto and cannot be unwrapped by the
 * pure-JS path (or vice versa), a user moving between build types loses access
 * to their wallet.
 *
 * Tests both directions, because a one-way check would miss an asymmetric bug.
 *
 * @param {object} options - The options.
 * @param {object} options.a - First `SubtleCrypto` implementation.
 * @param {object} options.b - Second `SubtleCrypto` implementation.
 * @param {Function} options.getRandomValues - Secure random source.
 *
 * @returns {Promise<object>} The check result.
 */
export async function checkAesKwInterop({a, b, getRandomValues}) {
  const kekBytes = new Uint8Array(32);
  getRandomValues(kekBytes);
  const contentKeyBytes = new Uint8Array(32);
  getRandomValues(contentKeyBytes);

  const failures = [];

  for(const [fromName, from, toName, to] of [
    ['a', a, 'b', b],
    ['b', b, 'a', a]
  ]) {
    try {
      const wrapKek = await from.importKey(
        'raw', kekBytes, {name: 'AES-KW', length: 256}, false, ['wrapKey']);
      const contentKey = await from.importKey(
        'raw', contentKeyBytes, {name: 'AES-GCM', length: 256}, true,
        ['encrypt', 'decrypt']);
      // The 4th argument (wrap algorithm) is REQUIRED by the WebCrypto spec.
      // Omitting it works on lenient implementations and throws on strict ones
      // (Node), so always pass it.
      const wrapped = await from.wrapKey(
        'raw', contentKey, wrapKek, 'AES-KW');

      const unwrapKek = await to.importKey(
        'raw', kekBytes, {name: 'AES-KW', length: 256}, false, ['unwrapKey']);
      const unwrapped = await to.unwrapKey(
        'raw', wrapped, unwrapKek, 'AES-KW',
        {name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
      const exported = new Uint8Array(
        await to.exportKey('raw', unwrapped));

      if(!_bytesEqual(exported, contentKeyBytes)) {
        failures.push(
          `${fromName} wrapped -> ${toName} unwrapped gave wrong bytes`);
      }
    } catch(e) {
      failures.push(`${fromName} -> ${toName} threw: ${e.message}`);
    }
  }

  return {
    name: 'AES-KW interop (both directions)',
    pass: failures.length === 0,
    detail: failures.length === 0 ?
      'wrapped keys round-trip between implementations' :
      failures.join('; ')
  };
}

/**
 * Verifies two implementations derive identical PBKDF2 bits.
 *
 * A mismatch here means a password that unlocks under one build type will not
 * unlock under the other.
 *
 * @param {object} options - The options.
 * @param {object} options.a - First `SubtleCrypto` implementation.
 * @param {object} options.b - Second `SubtleCrypto` implementation.
 * @param {number} [options.iterations] - Iteration count to compare at. Kept
 *   low by default because this checks agreement, not speed.
 *
 * @returns {Promise<object>} The check result.
 */
export async function checkPbkdf2Agreement({a, b, iterations = 1000}) {
  const password = new TextEncoder().encode('interop probe');
  const salt = new Uint8Array(16).fill(9);
  const algorithm = {
    name: 'PBKDF2', hash: 'SHA-256', salt, iterations
  };

  try {
    const derive = async subtle => {
      const key = await subtle.importKey(
        'raw', password, 'PBKDF2', false, ['deriveBits']);
      return new Uint8Array(await subtle.deriveBits(algorithm, key, 256));
    };
    const [bitsA, bitsB] = await Promise.all([derive(a), derive(b)]);

    return {
      name: 'PBKDF2 agreement',
      pass: _bytesEqual(bitsA, bitsB),
      detail: _bytesEqual(bitsA, bitsB) ?
        'both implementations derive identical bits' :
        'derived bits DIFFER -- a password would not unlock across builds'
    };
  } catch(e) {
    return {
      name: 'PBKDF2 agreement', pass: false,
      detail: `threw: ${e.message}`
    };
  }
}

/**
 * Measures PBKDF2 latency at the real iteration count.
 *
 * @param {object} options - The options.
 * @param {object} options.subtle - The `SubtleCrypto` to measure.
 * @param {Function} options.now - Monotonic clock returning milliseconds.
 * @param {number} [options.iterations] - Iteration count.
 * @param {number} [options.budgetMs] - Acceptable ceiling.
 *
 * @returns {Promise<object>} The check result, including `elapsedMs`.
 */
export async function checkPbkdf2Latency({
  subtle, now, iterations = PBKDF2_ITERATIONS, budgetMs = UNLOCK_BUDGET_MS
}) {
  const password = new TextEncoder().encode('a realistic wallet password');
  const salt = new Uint8Array(16).fill(3);

  const started = now();
  const key = await subtle.importKey(
    'raw', password, 'PBKDF2', false, ['deriveBits']);
  await subtle.deriveBits(
    {name: 'PBKDF2', hash: 'SHA-256', salt, iterations}, key, 256);
  const elapsedMs = now() - started;

  return {
    name: `PBKDF2 latency (${iterations} iterations)`,
    pass: elapsedMs <= budgetMs,
    elapsedMs,
    detail: elapsedMs <= budgetMs ?
      `${Math.round(elapsedMs)}ms, within ${budgetMs}ms budget` :
      `${Math.round(elapsedMs)}ms EXCEEDS ${budgetMs}ms budget -- adopt ` +
      'native crypto; do NOT lower the iteration count'
  };
}

/**
 * Runs every check and summarizes.
 *
 * @param {object} options - The options.
 * @param {object} options.result - The `bootstrapCrypto()` return value.
 * @param {object} options.active - The installed `SubtleCrypto`.
 * @param {object} options.reference - The pure-JS `SubtleCrypto` to compare
 *   against. When the active implementation *is* pure JS, interop checks are
 *   skipped as vacuous.
 * @param {boolean} options.expectNative - Whether native crypto is expected.
 * @param {Function} options.getRandomValues - Secure random source.
 * @param {Function} options.now - Monotonic clock in milliseconds.
 *
 * @returns {Promise<object>} `{pass, checks}`.
 */
export async function runDeviceChecks({
  result, active, reference, expectNative, getRandomValues, now
}) {
  const checks = [checkImplementation({result, expectNative})];

  // Comparing an implementation against itself proves nothing, so only run the
  // interop checks when the active implementation differs from the reference.
  const isDistinct = result.implementation === 'native' && active !== reference;
  if(isDistinct) {
    checks.push(await checkAesKwInterop(
      {a: active, b: reference, getRandomValues}));
    checks.push(await checkPbkdf2Agreement({a: active, b: reference}));
  } else {
    for(const name of ['AES-KW interop (both directions)',
      'PBKDF2 agreement']) {
      checks.push({
        name, pass: true, skipped: true,
        detail: 'skipped: active implementation is the pure-JS reference'
      });
    }
  }

  checks.push(await checkPbkdf2Latency({subtle: active, now}));

  return {pass: checks.every(c => c.pass), checks};
}

function _bytesEqual(a, b) {
  if(a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for(let i = 0; i < a.length; ++i) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
