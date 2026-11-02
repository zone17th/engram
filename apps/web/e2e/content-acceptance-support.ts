import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PASSWORD } from './helpers';
import { CRYPTO_WAIT_MS, UI_WAIT_MS, expectVaultShut, gotoSettings } from './vault-passkey-support';
import { fillSecret } from './vault-settings-secret';

// Helpers for the P04-T21a acceptance specs (`content-journey.spec.ts`, `content-journey-p03.spec.ts`,
// `content-artifacts.spec.ts`). Nothing here stubs `/api/**` (all calls reach the compose stack's real API
// and Postgres database via the production Next proxy).
//
// Security (user-dec-016, ACC-FE1-9):
// - Secret inputs (passphrases, recovery keys, entry bodies, raw JSON) are written via DOM prototype setters
//   so Playwright never logs plaintext in actionability timeout call logs, and body-carrying UI checks use
//   boolean helpers (`expectTextEqualsBool`, `expectInputValueEqualsBool`) so failing assertions do not echo
//   expected/received body text in error messages.
// - Plaintext leak checks across requests, DOM, and browser storage/caches return only structural diagnostics
//   (method, pathname, location, needle label), never echoing secret values into the public CI log.
export const ACCEPTANCE_UI_WAIT_MS = UI_WAIT_MS;

/**
 * Wraps `test.step` and logs a single timing line (`journey-step: <name> (<ms>ms)`) for CI visibility.
 * `name` must be a static literal, never user/entry data.
 */
export async function timedJourneyStep<T>(name: string, body: () => Promise<T>): Promise<T> {
  const startMs = Date.now();
  console.log(`journey-step: ${name} [start]`);
  return test.step(name, async () => {
    try {
      return await body();
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const firstLine = (rawMessage.split(/\r?\n/)[0] ?? '').slice(0, 300);
      console.log(`journey-step-failed: ${name}: ${firstLine}`);
      throw error;
    } finally {
      const elapsedMs = Date.now() - startMs;
      console.log(`journey-step: ${name} (${elapsedMs}ms)`);
    }
  });
}

/**
 * Quietly writes a value into an `<input>` or `<textarea>` via its prototype value setter and dispatches
 * a bubbling `input` event, avoiding `locator.fill()` so values never appear in Playwright timeout logs.
 */
export async function setQuietInputValue(locator: Locator, value: string, timeout = ACCEPTANCE_UI_WAIT_MS): Promise<void> {
  await expect(locator).toBeEditable({ timeout });
  await locator.evaluate((element, nextValue) => {
    const isTextarea = element.tagName.toUpperCase() === 'TEXTAREA';
    const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) {
      throw new Error('Value setter missing on element prototype');
    }
    setter.call(element, nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/**
 * Quietly attaches a `.json` `File` built from `rawUtf8Content` to an `<input type="file">` via `DataTransfer`
 * and dispatches a bubbling `change` event, avoiding `locator.setInputFiles()` so file buffers never appear in
 * Playwright call logs (user-dec-016).
 */
export async function setQuietJsonFileInput(
  fileInputLocator: Locator,
  rawUtf8Content: string,
  fileName = 'import.json',
): Promise<void> {
  await fileInputLocator.evaluate(
    (el, { content, name }) => {
      const input = el as HTMLInputElement;
      const bytes = new TextEncoder().encode(content);
      const file = new File([bytes], name, { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { content: rawUtf8Content, name: fileName },
  );
}

/**
 * Pure decision behind `expectServerHoldsOpaqueCiphertext` (ACC-FE3-3), kept in Node so it can be fed crafted input
 * by `verifyOpaqueCiphertextCheckNegativeControl`. Returns true only when the record is a structurally sound entry and
 * neither the literal ciphertext string nor its base64url-DECODED bytes contain any needle (UTF-8 byte search).
 */
export function isOpaqueCiphertextRecord(
  record: {
    readonly id?: string;
    readonly type?: string;
    readonly ciphertext?: string;
    readonly envelope?: { readonly key_id?: string };
  } | null,
  entryId: string,
  expectedType: string,
  needles: readonly string[],
): boolean {
  if (
    !record ||
    record.id !== entryId ||
    record.type !== expectedType ||
    typeof record.ciphertext !== 'string' ||
    record.ciphertext.length === 0 ||
    typeof record.envelope?.key_id !== 'string'
  ) {
    return false;
  }
  const ct = record.ciphertext;
  if (!/^[A-Za-z0-9_-]+$/.test(ct)) return false;
  const bytes = Buffer.from(ct, 'base64url');
  if (bytes.length === 0) return false;
  for (const needle of needles) {
    if (needle.length === 0) continue;
    if (ct.includes(needle)) return false;
    if (bytes.includes(Buffer.from(needle, 'utf8'))) return false;
  }
  return true;
}

/**
 * Negative control for `isOpaqueCiphertextRecord` (Advisor on ACC-FE3-3: the check must be able to fail). A crafted
 * base64url ciphertext whose decoded bytes embed a needle at a non-aligned offset must be rejected, and the same
 * record without the needle must pass. Values are synthetic and never printed.
 */
export function verifyOpaqueCiphertextCheckNegativeControl(): void {
  const needle = `opaque-negative-control-${Date.now().toString(36)}`;
  const leaking = Buffer.concat([Buffer.from([1, 2]), Buffer.from(needle, 'utf8'), Buffer.from([3])]).toString('base64url');
  const clean = Buffer.alloc(48, 7).toString('base64url');
  const base = { id: 'nc', type: 'json', envelope: { key_id: 'vk:negative-control' } } as const;
  expect(isOpaqueCiphertextRecord({ ...base, ciphertext: leaking }, 'nc', 'json', [needle])).toBe(false);
  expect(isOpaqueCiphertextRecord({ ...base, ciphertext: clean }, 'nc', 'json', [needle])).toBe(true);
}

/**
 * Boolean check that the SERVER holds only opaque ciphertext for the entry (P04-A6, ACC-FE1-9, ACC-FE3-3).
 * It fetches `GET /api/v1/entries/<entryId>` in the page and decides with `isOpaqueCiphertextRecord` (type `json`,
 * non-empty base64url ciphertext, a `key_id`, and no needle in the ciphertext string or its decoded bytes).
 * It does NOT prove what the browser decrypts: byte-exact plaintext proofs live in the callers
 * (`json-raw-bytes` count, Raw textarea compare, zero-PUT no-op save). Nothing is printed on failure.
 */
export async function expectServerHoldsOpaqueCiphertext(
  page: Page,
  entryId: string,
  expectedPlaintext: string,
  extraNeedles: readonly string[] = [],
  timeout = ACCEPTANCE_UI_WAIT_MS,
): Promise<void> {
  verifyOpaqueCiphertextCheckNegativeControl();
  await expect
    .poll(
      async () => {
        const fetched = await page.evaluate(async (id) => {
          const res = await fetch(`/api/v1/entries/${encodeURIComponent(id)}`, { credentials: 'include' });
          if (res.status !== 200) return null;
          return (await res.json().catch(() => null)) as {
            readonly id?: string;
            readonly type?: string;
            readonly ciphertext?: string;
            readonly envelope?: { readonly key_id?: string };
          } | null;
        }, entryId);
        return isOpaqueCiphertextRecord(fetched, entryId, 'json', [expectedPlaintext, ...extraNeedles]);
      },
      { timeout },
    )
    .toBe(true);
}

/**
 * Boolean check that an input/textarea is empty without printing its current value on failure.
 */
export async function expectInputEmptyBool(locator: Locator, timeout = ACCEPTANCE_UI_WAIT_MS): Promise<void> {
  await expect
    .poll(
      () =>
        locator.evaluate((el) => {
          const field = el as HTMLInputElement | HTMLTextAreaElement;
          return field.value.length === 0;
        }),
      { timeout },
    )
    .toBe(true);
}

/**
 * Boolean check that an input/textarea equals `expected` without printing either value on failure.
 */
export async function expectInputValueEqualsBool(
  locator: Locator,
  expected: string,
  timeout = ACCEPTANCE_UI_WAIT_MS,
): Promise<void> {
  await expect
    .poll(
      () =>
        locator.evaluate((el, target) => {
          const field = el as HTMLInputElement | HTMLTextAreaElement;
          return field.value === target;
        }, expected),
      { timeout },
    )
    .toBe(true);
}

/**
 * Boolean check that a locator's trimmed textContent equals `expected` without printing either value on failure
 * (ACC-FE1-9).
 */
export async function expectTextEqualsBool(
  locator: Locator,
  expected: string,
  timeout = ACCEPTANCE_UI_WAIT_MS,
): Promise<void> {
  await expect
    .poll(
      () =>
        locator.evaluate((el, target) => {
          return (el.textContent ?? '').trim() === target;
        }, expected),
      { timeout },
    )
    .toBe(true);
}

export interface NeedleForm {
  /** Label suffix only (never a value): '' for the literal, otherwise `#b64-0`, `#hex`, `#uri`, ... */
  readonly suffix: string;
  readonly value: string;
}

const MIN_ENCODED_NEEDLE_LENGTH = 8;

/**
 * Literal, base64 / base64url (all three 3-byte alignments, so a needle embedded at any offset of a larger
 * encoded payload still matches), lowercase hex and `encodeURIComponent` forms of a secret (ACC-FE3-4).
 * Encoded forms shorter than 8 characters are dropped (false-positive guard). Labels carry a form suffix only.
 */
export function needleForms(value: string): NeedleForm[] {
  const forms: NeedleForm[] = [{ suffix: '', value }];
  const bytes = Buffer.from(value, 'utf8');
  const push = (suffix: string, form: string) => {
    if (form.length >= MIN_ENCODED_NEEDLE_LENGTH && form !== value) {
      forms.push({ suffix, value: form });
    }
  };
  const leadingSkip = [0, 2, 3];
  for (let offset = 0; offset < 3; offset += 1) {
    const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
    let encoded = padded.toString('base64').replace(/=+$/, '');
    if (padded.length % 3 !== 0) {
      encoded = encoded.slice(0, -1);
    }
    encoded = encoded.slice(leadingSkip[offset] ?? 0);
    push(`#b64-${offset}`, encoded);
    push(`#b64url-${offset}`, encoded.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  push('#hex', bytes.toString('hex'));
  push('#uri', encodeURIComponent(value));
  return forms;
}

/**
 * Negative control for the request monitor's encoded-needle path (ACC-FE3-4, ACC-FE4-1; Advisor: each check must be
 * able to fail). It drives a throwaway, unattached monitor through the SAME code as the real one: `registerSecret`
 * (form generation + storage) and the request scan (`ingestRequestForSelfTest` -> `inspectRequest`). A synthetic needle
 * sent as base64 at a non-aligned offset, as base64url, as hex and URI-encoded must each be reported with an encoded
 * form label, a body without it must not, and a needle in a URL path must be reported with the path redacted
 * (ACC-FE4-2). Values are synthetic and never printed.
 */
export function verifyEncodedNeedleMatcherNegativeControl(): void {
  const needle = `enc-negative-control/${Date.now().toString(36)}?+é`;
  const raw = Buffer.from(needle, 'utf8');
  const b64Odd = Buffer.concat([Buffer.from([9]), raw, Buffer.from([8, 7])]).toString('base64');
  const b64urlOdd = Buffer.concat([Buffer.from([1, 2]), raw]).toString('base64url');
  const cases: ReadonlyArray<{ readonly body: string; readonly form: RegExp }> = [
    { body: JSON.stringify({ ciphertext: b64Odd }), form: /#b64-\d$/ },
    { body: JSON.stringify({ ciphertext: b64urlOdd }), form: /#b64(url)?-\d$/ },
    { body: JSON.stringify({ q: raw.toString('hex') }), form: /#hex$/ },
    { body: `q=${encodeURIComponent(needle)}`, form: /#uri$/ },
  ];
  for (const c of cases) {
    const probe = createRequestPlaintextMonitor([], { skipSelfTest: true });
    probe.registerSecret('selfTestNeedle', needle);
    probe.ingestRequestForSelfTest({ method: 'POST', url: 'https://self-test.invalid/api/v1/x', headers: {}, postData: c.body });
    expect(probe.getLeaks().some((l) => l.surface === 'postData' && c.form.test(l.needleLabel))).toBe(true);
  }
  const clean = createRequestPlaintextMonitor([], { skipSelfTest: true });
  clean.registerSecret('selfTestNeedle', needle);
  clean.ingestRequestForSelfTest({
    method: 'POST',
    url: 'https://self-test.invalid/api/v1/x',
    headers: {},
    postData: JSON.stringify({ ciphertext: Buffer.alloc(64, 5).toString('base64') }),
  });
  expect(clean.getLeaks().length).toBe(0);
  const inPath = createRequestPlaintextMonitor([], { skipSelfTest: true });
  inPath.registerSecret('selfTestNeedle', needle);
  inPath.ingestRequestForSelfTest({
    method: 'GET',
    url: `https://self-test.invalid/api/v1/items/${encodeURIComponent(needle)}/entries`,
    headers: {},
    postData: null,
  });
  const pathLeaks = inPath.getLeaks().filter((l) => l.surface === 'url');
  expect(pathLeaks.length > 0).toBe(true);
  expect(pathLeaks.every((l) => !l.pathname.includes('enc-negative-control') && l.pathname.includes('<redacted>'))).toBe(true);
}

export interface ReplayedRequestRecord {
  readonly idemKey: string;
  readonly postData: string;
}

/** True when the retry carries the same non-empty Idempotency-Key and byte-identical non-empty body (ACC-FE3-2). */
export function retryReplaysSameRequest(first: ReplayedRequestRecord, retry: ReplayedRequestRecord): boolean {
  return (
    first.idemKey.length > 0 &&
    first.postData.length > 0 &&
    first.idemKey === retry.idemKey &&
    first.postData === retry.postData
  );
}

/**
 * Negative control for `retryReplaysSameRequest` (ACC-FE3-2): a fresh key, a re-sealed body or an empty key must each
 * be rejected; only an exact replay passes. Synthetic values only.
 */
export function verifyRetryReplayCheckNegativeControl(): void {
  const first = { idemKey: 'nc-key-1', postData: '{"ciphertext":"AAAA"}' };
  expect(retryReplaysSameRequest(first, { ...first })).toBe(true);
  expect(retryReplaysSameRequest(first, { ...first, idemKey: 'nc-key-2' })).toBe(false);
  expect(retryReplaysSameRequest(first, { ...first, postData: '{"ciphertext":"BBBB"}' })).toBe(false);
  expect(retryReplaysSameRequest({ idemKey: '', postData: first.postData }, { idemKey: '', postData: first.postData })).toBe(false);
}

export interface RequestPlaintextLeak {
  readonly method: string;
  readonly pathname: string;
  readonly surface: 'url' | 'header' | 'postData';
  readonly headerName?: string;
  readonly needleLabel: string;
}

export interface RequestPlaintextMonitor {
  readonly attachContext: (context: BrowserContext) => void;
  readonly registerSecret: (label: string, value: string) => void;
  readonly getLeaks: () => readonly RequestPlaintextLeak[];
  readonly getRequestCount: () => number;
  readonly assertNoLeaks: () => void;
  /** Feeds one synthetic request through the real scan path; used only by the negative control. */
  readonly ingestRequestForSelfTest: (req: {
    readonly method: string;
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly postData: string | null;
  }) => void;
}

/**
 * Records every request across attached contexts and checks URL, headers, and postData against
 * registered secret strings (user-dec-016, P04-A4, ACC-FE1-8).
 * Retains captured request snapshots in memory (never logged) so `registerSecret` also re-scans
 * requests that occurred before the secret was registered, and listens on the BrowserContext only
 * to avoid duplicate page+context request events.
 */
export function createRequestPlaintextMonitor(
  initialSecrets: ReadonlyArray<{ readonly label: string; readonly value: string }> = [],
  options: { readonly skipSelfTest?: boolean } = {},
): RequestPlaintextMonitor {
  if (!options.skipSelfTest) {
    verifyEncodedNeedleMatcherNegativeControl();
  }
  const secrets = new Map<string, string>();
  const addSecretForms = (label: string, value: string) => {
    for (const form of needleForms(value)) {
      secrets.set(`${label}${form.suffix}`, form.value);
    }
  };
  for (const item of initialSecrets) {
    if (item.value.length > 0) {
      addSecretForms(item.label, item.value);
    }
  }

  interface CapturedRequestSnapshot {
    readonly method: string;
    readonly rawUrl: string;
    readonly pathname: string;
    readonly headers: Record<string, string>;
    readonly postData: string;
  }

  const capturedRequests: CapturedRequestSnapshot[] = [];
  const leaks: RequestPlaintextLeak[] = [];
  const seenLeakKeys = new Set<string>();
  const attachedContexts = new WeakSet<BrowserContext>();
  // ACC-FE4-2: a leak report must never carry the leaked value, so any path segment holding any registered form is
  // redacted; a needle spanning segments (it contains '/') redacts everything after the first three segments.
  const redactPathname = (pathname: string): string => {
    const values = [...secrets.values()].filter((v) => v.length > 0);
    const holdsSecret = (text: string) => values.some((v) => text.includes(v));
    const segments = pathname.split('/').map((seg) => {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        // keep the raw segment
      }
      return holdsSecret(seg) || holdsSecret(decoded) ? '<redacted>' : seg;
    });
    const joined = segments.join('/');
    return holdsSecret(joined) ? `${segments.slice(0, 3).join('/')}/<redacted>` : joined;
  };
  const recordLeak = (rawLeak: RequestPlaintextLeak) => {
    const leak: RequestPlaintextLeak = { ...rawLeak, pathname: redactPathname(rawLeak.pathname) };
    const key = `${leak.method}:${leak.pathname}:${leak.surface}:${leak.headerName ?? ''}:${leak.needleLabel}`;
    if (!seenLeakKeys.has(key)) {
      seenLeakKeys.add(key);
      leaks.push(leak);
    }
  };

  const scanSnapshotForSecret = (
    snap: CapturedRequestSnapshot,
    needleLabel: string,
    needle: string,
  ) => {
    if (!needle) return;
    if (snap.rawUrl.includes(needle)) {
      recordLeak({
        method: snap.method,
        pathname: snap.pathname,
        surface: 'url',
        needleLabel,
      });
    }
    for (const [headerName, headerVal] of Object.entries(snap.headers)) {
      if (headerVal && headerVal.includes(needle)) {
        recordLeak({
          method: snap.method,
          pathname: snap.pathname,
          surface: 'header',
          headerName,
          needleLabel,
        });
      }
    }
    if (snap.postData && snap.postData.includes(needle)) {
      recordLeak({
        method: snap.method,
        pathname: snap.pathname,
        surface: 'postData',
        needleLabel,
      });
    }
  };

  const inspectRequest = (req: {
    method: () => string;
    url: () => string;
    headers: () => Record<string, string>;
    postData: () => string | null;
  }) => {
    const rawUrl = req.url();
    let pathname = rawUrl;
    try {
      pathname = new URL(rawUrl).pathname;
    } catch {
      pathname = '<invalid-url>';
    }
    const snap: CapturedRequestSnapshot = {
      method: req.method(),
      rawUrl,
      pathname,
      headers: req.headers(),
      postData: req.postData() ?? '',
    };
    capturedRequests.push(snap);

    for (const [needleLabel, needle] of secrets.entries()) {
      scanSnapshotForSecret(snap, needleLabel, needle);
    }
  };

  const attachContext = (context: BrowserContext) => {
    if (attachedContexts.has(context)) return;
    attachedContexts.add(context);
    context.on('request', inspectRequest);
  };

  return {
    attachContext,
    registerSecret(label: string, value: string) {
      if (value.length > 0) {
        for (const form of needleForms(value)) {
          const formLabel = `${label}${form.suffix}`;
          secrets.set(formLabel, form.value);
          for (const snap of capturedRequests) {
            scanSnapshotForSecret(snap, formLabel, form.value);
          }
        }
      }
    },
    getLeaks() {
      return leaks;
    },
    getRequestCount() {
      return capturedRequests.length;
    },
    assertNoLeaks() {
      expect(leaks, `Plaintext leaked in network requests: ${JSON.stringify(leaks)}`).toEqual([]);
    },
    ingestRequestForSelfTest(req) {
      inspectRequest({
        method: () => req.method,
        url: () => req.url,
        headers: () => req.headers,
        postData: () => req.postData,
      });
    },
  };
}

/**
 * Scans the live DOM when locked (or unlocked for attribute-only checks) for any of `bodies` (with corresponding
 * labels so failure diagnostics never print the secret value). Checks attributes, dataset, input/textarea `.value`,
 * `document.body.innerText`, and `document.documentElement.outerHTML`.
 */
export async function findLabeledDomBodyLeaks(
  page: Page,
  labeledBodies: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): Promise<string[]> {
  return page.evaluate((entries) => {
    const valid = entries.filter((e) => e.value.length > 0);
    const leaks: string[] = [];
    const nodes = [document.documentElement, ...Array.from(document.querySelectorAll<HTMLElement>('*'))];
    for (const node of nodes) {
      const tag = node.tagName.toLowerCase();
      for (const attr of Array.from(node.attributes)) {
        for (const item of valid) {
          if (attr.value.includes(item.value)) {
            leaks.push(`${item.label}:attr:${attr.name}<${tag}>`);
          }
        }
      }
      for (const [key, val] of Object.entries(node.dataset ?? {})) {
        for (const item of valid) {
          if ((val ?? '').includes(item.value)) {
            leaks.push(`${item.label}:dataset:${key}<${tag}>`);
          }
        }
      }
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        for (const item of valid) {
          if (node.value.includes(item.value)) {
            leaks.push(`${item.label}:value<${tag}>`);
          }
        }
      }
    }
    const markup = document.documentElement.outerHTML;
    const text = document.body?.innerText ?? '';
    for (const item of valid) {
      if (markup.includes(item.value)) {
        leaks.push(`${item.label}:outerHTML`);
      }
      if (text.includes(item.value)) {
        leaks.push(`${item.label}:innerText`);
      }
    }
    return [...new Set(leaks)];
  }, labeledBodies);
}

/**
 * Scans browser storage and cache surfaces (`localStorage`, `sessionStorage`, `indexedDB.databases()` + bounded
 * string values of each DB, and `caches.keys()` + bounded response bodies) for any of `labeledBodies`, returning
 * only structural labels on match (ACC-FE1-4, P04-A9).
 */
export async function findLabeledStorageAndCacheBodyLeaks(
  page: Page,
  labeledBodies: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): Promise<string[]> {
  return page.evaluate(async (entries) => {
    const valid = entries.filter((e) => e.value.length > 0);
    const leaks: string[] = [];

    const checkString = (haystack: string, surface: string) => {
      if (!haystack) return;
      for (const item of valid) {
        if (haystack.includes(item.value)) {
          leaks.push(`${item.label}:${surface}`);
        }
      }
    };

    const collectStringsBounded = (val: unknown, surface: string, depth = 0) => {
      if (depth > 5 || val === null || val === undefined) return;
      if (typeof val === 'string') {
        checkString(val, surface);
        return;
      }
      if (Array.isArray(val)) {
        const lim = Math.min(val.length, 50);
        for (let i = 0; i < lim; i += 1) {
          collectStringsBounded(val[i], surface, depth + 1);
        }
        return;
      }
      if (typeof val === 'object') {
        const keys = Object.keys(val as Record<string, unknown>).slice(0, 50);
        for (const k of keys) {
          checkString(k, surface);
          collectStringsBounded((val as Record<string, unknown>)[k], surface, depth + 1);
        }
      }
    };

    try {
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i) ?? '';
        checkString(key, 'localStorage.key');
        checkString(window.localStorage.getItem(key) ?? '', `localStorage:${key}`);
      }
    } catch {
      // Ignore storage access errors
    }

    try {
      for (let i = 0; i < window.sessionStorage.length; i += 1) {
        const key = window.sessionStorage.key(i) ?? '';
        checkString(key, 'sessionStorage.key');
        checkString(window.sessionStorage.getItem(key) ?? '', `sessionStorage:${key}`);
      }
    } catch {
      // Ignore storage access errors
    }

    try {
      if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
        const dbs = await indexedDB.databases();
        for (const dbInfo of dbs.slice(0, 10)) {
          const dbName = dbInfo.name;
          if (!dbName) continue;
          checkString(dbName, 'indexedDB.name');
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(() => resolve(), 1500);
            try {
              const openReq = indexedDB.open(dbName);
              openReq.onerror = () => {
                window.clearTimeout(timer);
                resolve();
              };
              openReq.onsuccess = () => {
                const db = openReq.result;
                const storeNames = Array.from(db.objectStoreNames).slice(0, 10);
                if (storeNames.length === 0) {
                  db.close();
                  window.clearTimeout(timer);
                  resolve();
                  return;
                }
                let pendingStores = storeNames.length;
                const finishStore = () => {
                  pendingStores -= 1;
                  if (pendingStores <= 0) {
                    db.close();
                    window.clearTimeout(timer);
                    resolve();
                  }
                };
                for (const storeName of storeNames) {
                  checkString(storeName, `indexedDB:${dbName}.store`);
                  try {
                    const tx = db.transaction(storeName, 'readonly');
                    const store = tx.objectStore(storeName);
                    const getAllReq = store.getAll(undefined, 50);
                    getAllReq.onsuccess = () => {
                      collectStringsBounded(
                        getAllReq.result,
                        `indexedDB:${dbName}/${storeName}`,
                      );
                      finishStore();
                    };
                    getAllReq.onerror = () => finishStore();
                  } catch {
                    finishStore();
                  }
                }
              };
            } catch {
              window.clearTimeout(timer);
              resolve();
            }
          });
        }
      }
    } catch {
      // Best effort IndexedDB scan
    }

    try {
      if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
        const cacheNames = await caches.keys();
        for (const cacheName of cacheNames.slice(0, 10)) {
          checkString(cacheName, 'caches.name');
          const cache = await caches.open(cacheName);
          const requests = await cache.keys();
          for (const req of requests.slice(0, 30)) {
            checkString(req.url, `caches:${cacheName}.url`);
            const res = await cache.match(req);
            if (res) {
              const text = (await res.text().catch(() => '')).slice(0, 65_536);
              checkString(text, `caches:${cacheName}.body`);
            }
          }
        }
      }
    } catch {
      // Best effort CacheStorage scan
    }

    return [...new Set(leaks)];
  }, labeledBodies);
}

/**
 * Self-checks `findLabeledStorageAndCacheBodyLeaks` (ACC-FE2-5): plants synthetic nonces into `localStorage`
 * and an `IndexedDB` object store, asserts the scanner reports both labels, and removes both fixtures cleanly.
 * Keep this out of the lock assertions' path so it never interferes with real lock-wipe verification.
 */
export async function verifyStorageAndCacheScannerPositiveControl(
  page: Page,
  nonce: string,
): Promise<void> {
  const lsKey = `__engram_scanner_selfcheck_${nonce}`;
  const lsNeedle = `scanner-positive-ls-needle-${nonce}`;
  const idbName = `__engram_scanner_selfcheck_idb_${nonce}`;
  const idbStore = 'selfcheck_store';
  const idbNeedle = `scanner-positive-idb-needle-${nonce}`;

  await page.evaluate(
    async ({ key, lsVal, dbName, storeName, idbVal }) => {
      window.localStorage.setItem(key, lsVal);
      const { promise, resolve } = Promise.withResolvers<void>();
      const openReq = indexedDB.open(dbName, 1);
      openReq.onupgradeneeded = () => {
        openReq.result.createObjectStore(storeName);
      };
      openReq.onsuccess = () => {
        const db = openReq.result;
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put({ nested: idbVal }, 'k1');
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          resolve();
        };
      };
      openReq.onerror = () => resolve();
      await promise;
    },
    { key: lsKey, lsVal: lsNeedle, dbName: idbName, storeName: idbStore, idbVal: idbNeedle },
  );

  try {
    const hits = await findLabeledStorageAndCacheBodyLeaks(page, [
      { label: 'selfcheckLocalStorage', value: lsNeedle },
      { label: 'selfcheckIndexedDB', value: idbNeedle },
    ]);
    expect(hits).toContain(`selfcheckLocalStorage:localStorage:${lsKey}`);
    expect(hits).toContain(`selfcheckIndexedDB:indexedDB:${idbName}/${idbStore}`);
  } finally {
    await page.evaluate(
      async ({ key, dbName }) => {
        window.localStorage.removeItem(key);
        const { promise, resolve } = Promise.withResolvers<void>();
        const delReq = indexedDB.deleteDatabase(dbName);
        delReq.onsuccess = () => resolve();
        delReq.onerror = () => resolve();
        delReq.onblocked = () => resolve();
        await promise;
      },
      { key: lsKey, dbName: idbName },
    );
  }

  const afterCleanup = await findLabeledStorageAndCacheBodyLeaks(page, [
    { label: 'selfcheckLocalStorage', value: lsNeedle },
    { label: 'selfcheckIndexedDB', value: idbNeedle },
  ]);
  expect(afterCleanup).toEqual([]);
}

/**
 * Asserts that neither the live DOM nor browser storage/caches (`localStorage`, `sessionStorage`, `indexedDB`,
 * `caches`) contain any of `labeledBodies` after vault lock (ACC-FE1-4, P04-A9).
 */
export async function expectNoDomOrStorageBodyLeaks(
  page: Page,
  labeledBodies: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): Promise<void> {
  const domLeaks = await findLabeledDomBodyLeaks(page, labeledBodies);
  expect(domLeaks).toEqual([]);
  const storageLeaks = await findLabeledStorageAndCacheBodyLeaks(page, labeledBodies);
  expect(storageLeaks).toEqual([]);
}
/**
 * Fetches entries metadata and item summary from the real API using the page's authenticated session
 * and asserts the item is 200 and its live entry IDs match `expectedLiveEntryIds` (with `forbiddenEntryIds`
 * absent), proving Undo restored server state rather than rendering from client cache (ACC-FE1-1, P04-A8).
 */
export async function expectServerItemAndLiveEntryIds(
  page: Page,
  itemId: string,
  expectedLiveEntryIds: readonly string[],
  forbiddenEntryIds: readonly string[] = [],
): Promise<void> {
  const probe = await page.evaluate(async (id) => {
    const [itemRes, entriesRes] = await Promise.all([
      fetch(`/api/v1/items/${encodeURIComponent(id)}`, { credentials: 'include' }),
      fetch(`/api/v1/items/${encodeURIComponent(id)}/entries`, { credentials: 'include' }),
    ]);
    const entriesBody = (await entriesRes.json().catch(() => null)) as {
      readonly items?: ReadonlyArray<{ readonly id: string }>;
    } | null;
    return {
      itemStatus: itemRes.status,
      entriesStatus: entriesRes.status,
      entryIds: (entriesBody?.items ?? []).map((e) => e.id),
    };
  }, itemId);

  expect(probe.itemStatus).toBe(200);
  expect(probe.entriesStatus).toBe(200);
  for (const forbiddenId of forbiddenEntryIds) {
    expect(probe.entryIds).not.toContain(forbiddenId);
  }
  expect([...probe.entryIds].sort()).toEqual([...expectedLiveEntryIds].sort());
}

/**
 * Saves an item hint via the `item-hint-input` field on `/app/items/<id>`, waits for the `PATCH /api/v1/items/<id>`
 * response (status 200), and reads back `GET /api/v1/items/<id>` with a boolean comparison to prove the hint was
 * persisted on the server (ACC-FE1-2).
 */
export async function saveAndVerifyItemHintPersisted(
  page: Page,
  itemId: string,
  hint: string,
): Promise<void> {
  const hintInput = page.getByTestId('item-hint-input');
  await expect(hintInput).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
  const targetPathname = `/api/v1/items/${itemId}`;
  const patchResponsePromise = page.waitForResponse(
    (res) => res.request().method() === 'PATCH' && new URL(res.url()).pathname === targetPathname,
    { timeout: ACCEPTANCE_UI_WAIT_MS },
  );
  await setQuietInputValue(hintInput, hint);
  await hintInput.press('Enter');
  const patchRes = await patchResponsePromise;
  expect(patchRes.status()).toBe(200);
  await expectInputValueEqualsBool(hintInput, hint);

  const persistedMatches = await page.evaluate(
    async ({ id, expectedHint }) => {
      const res = await fetch(`/api/v1/items/${encodeURIComponent(id)}`, {
        credentials: 'include',
      });
      if (res.status !== 200) return false;
      const body = (await res.json().catch(() => null)) as { readonly hint?: unknown } | null;
      return body?.hint === expectedHint;
    },
    { id: itemId, expectedHint: hint },
  );
  expect(persistedMatches).toBe(true);
}

/**
 * Inspects raw SSR HTML string for:
 * 1) any occurrence of `forbiddenStrings` (reported by label only),
 * 2) any `<... data-vault-decrypted ...>` element that has non-empty inner content.
 */
export function inspectSsrHtml(
  html: string,
  forbiddenStrings: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): {
  readonly matchedLabels: string[];
  readonly nonEmptyDecryptedNodes: number;
  readonly hasHtmlRootAndTheme: boolean;
  readonly hasAuthLoginShellMarker: boolean;
} {
  const matchedLabels: string[] = [];
  for (const item of forbiddenStrings) {
    if (item.value.length > 0 && html.includes(item.value)) {
      matchedLabels.push(item.label);
    }
  }

  // Check for any tag carrying `data-vault-decrypted` whose inner content before its closing tag is non-whitespace.
  const decryptedTagRegex = /<([a-zA-Z0-9-]+)\b[^>]*\bdata-vault-decrypted\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let nonEmptyDecryptedNodes = 0;
  let match = decryptedTagRegex.exec(html);
  while (match !== null) {
    const inner = (match[2] ?? '').trim();
    if (inner.length > 0) {
      nonEmptyDecryptedNodes += 1;
    }
    match = decryptedTagRegex.exec(html);
  }

  // Positive controls (ACC-FE1-3): `app/app/layout.tsx` renders `<html lang="..." data-theme="...">` and the
  // authenticated `/app` routes never embed the login page marker (`id="auth-login"` / `data-testid="auth-explainer-aside"`).
  const hasHtmlRootAndTheme = /<html\b[^>]*\bdata-theme=/i.test(html);
  const hasAuthLoginShellMarker =
    html.includes('id="auth-login"') || html.includes('data-testid="auth-explainer-aside"');

  return {
    matchedLabels,
    nonEmptyDecryptedNodes,
    hasHtmlRootAndTheme,
    hasAuthLoginShellMarker,
  };
}

export interface DiskArtifactScanResult {
  readonly scannedFileCount: number;
  readonly secretHits: ReadonlyArray<{ readonly relativeFile: string; readonly label: string }>;
  readonly forbiddenStorageFiles: readonly string[];
}

function walkFilesSafe(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  const results: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function isForbiddenStorageFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.includes('storagestate') || lower.endsWith('.auth.json');
}

/**
 * Recursively scans the given directories (`testInfo.outputDir`, `test-results`, etc.) for:
 * - any file whose name matches `*storageState*` or `*.auth.json`,
 * - any file content containing any of the supplied labeled secrets (bodies, passphrase, recovery key).
 * Never echoes secret values in its return object.
 */
export function scanDirectoriesForSecretsAndStorageState(
  dirs: readonly string[],
  labeledSecrets: ReadonlyArray<{ readonly label: string; readonly value: string }>,
): DiskArtifactScanResult {
  const validSecrets = labeledSecrets.filter((s) => s.value.length > 0);
  const seenFiles = new Set<string>();
  const secretHits: Array<{ readonly relativeFile: string; readonly label: string }> = [];
  const forbiddenStorageFiles: string[] = [];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const files = walkFilesSafe(dir);
    for (const filePath of files) {
      if (seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);

      const name = basename(filePath);
      if (isForbiddenStorageFileName(name)) {
        forbiddenStorageFiles.push(name);
      }

      try {
        const st = statSync(filePath);
        if (st.size === 0 || st.size > 32 * 1024 * 1024) continue;
        const content = readFileSync(filePath, 'utf8');
        for (const secret of validSecrets) {
          if (content.includes(secret.value)) {
            secretHits.push({
              relativeFile: name,
              label: secret.label,
            });
          }
        }
      } catch {
        // Ignore files that vanish or cannot be read while scanning
      }
    }
  }

  return {
    scannedFileCount: seenFiles.size,
    secretHits,
    forbiddenStorageFiles,
  };
}

/**
 * Like `expectOnUnlockPage` (vault-passkey-support.ts, frozen P03 helper) but also accepts the `returnTo` query that the
 * app adds when a locked deep link (for example a reload of `/app/items/<id>`) is sent to the unlock page.
 */
export async function expectOnUnlockPageAllowingReturnTo(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/app\/unlock(?:\?returnTo=[^&#]*)?$/, { timeout: ACCEPTANCE_UI_WAIT_MS });
  await expect(page.getByTestId('vault-unlock-page')).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
  await expectVaultShut(page);
}

/**
 * Dispatches a window `focus` event on `page` so `<ContentChangesSync />` runs its coalesced wake cycle
 * (refetching active canonical sources, reconciling `GET /api/v1/vault`, and draining `/api/v1/entries/changes`).
 */
export async function triggerFocusWake(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

/**
 * Walks through the real Settings > Security "Reset vault" dialog (`#resetDlg`: step 1 "None of these work" ->
 * step 2 "Checked backups" -> step 3 login password reauth via `fillSecret` -> step 4 type `RESET` + confirm),
 * awaits the `204` `DELETE /api/v1/vault` response and `[data-view="rst-s5"]`, and clicks the dialog's
 * "Create new vault" link to land on `/app/onboarding` (`content-sync.spec.ts:458-569`).
 */
export async function executeVaultResetAndClickCreateNewVault(
  page: Page,
  loginPassword = PASSWORD,
): Promise<void> {
  await gotoSettings(page);
  await page.locator('[data-open-dialog="resetDlg"]').click();
  const resetDialog = page.getByRole('dialog');
  await expect(resetDialog).toBeVisible({ timeout: ACCEPTANCE_UI_WAIT_MS });
  await resetDialog
    .getByRole('button', { name: /^(None of these work|Không đường nào dùng được)$/ })
    .click();
  await resetDialog
    .getByRole('button', { name: /^(Checked backups|Đã kiểm tra backup)$/ })
    .click();
  await fillSecret(resetDialog.locator('#rst-reauth-pwd'), loginPassword, ACCEPTANCE_UI_WAIT_MS);
  await resetDialog.getByRole('button', { name: /^(Continue|Tiếp tục)$/ }).click();
  await resetDialog.locator('#rst-confirm-word').fill('RESET');
  await expect(resetDialog.locator('#rstConfirmBtn')).toBeEnabled({ timeout: ACCEPTANCE_UI_WAIT_MS });

  const deleteVaultPromise = page.waitForResponse(
    (res) => res.request().method() === 'DELETE' && new URL(res.url()).pathname === '/api/v1/vault',
    { timeout: CRYPTO_WAIT_MS },
  );
  await resetDialog.locator('#rstConfirmBtn').click();
  expect((await deleteVaultPromise).status()).toBe(204);
  await expect(resetDialog.locator('[data-view="rst-s5"]')).toBeVisible({
    timeout: CRYPTO_WAIT_MS,
  });

  await resetDialog.getByRole('link', { name: /^(Create new vault|Tạo vault mới)$/ }).click();
  await expect(page).toHaveURL(/\/app\/onboarding$/, { timeout: ACCEPTANCE_UI_WAIT_MS });
}

export interface ServerItemsAndTagsSnapshot {
  readonly itemsStatus: number;
  readonly tagsStatus: number;
  readonly itemIds: readonly string[];
  readonly tagIds: readonly string[];
  readonly itemTagIdsByItem: Readonly<Record<string, readonly string[]>>;
  readonly entryCountsByItem: Readonly<Record<string, number>>;
}

/**
 * Fetches `GET /api/v1/items` and `GET /api/v1/tags` using the page's authenticated session and returns
 * the sorted ID sets, per-item tag ID sets, and per-item `entry_count` map.
 */
export async function fetchServerItemsAndTagsSnapshot(
  page: Page,
): Promise<ServerItemsAndTagsSnapshot> {
  return page.evaluate(async () => {
    const [itemsRes, tagsRes] = await Promise.all([
      fetch('/api/v1/items', { credentials: 'include' }),
      fetch('/api/v1/tags', { credentials: 'include' }),
    ]);
    const itemsBody = (await itemsRes.json().catch(() => null)) as {
      readonly items?: ReadonlyArray<{
        readonly id: string;
        readonly entry_count: number;
        readonly tags?: ReadonlyArray<{ readonly id: string }>;
      }>;
    } | null;
    const tagsBody = (await tagsRes.json().catch(() => null)) as {
      readonly items?: ReadonlyArray<{ readonly id: string }>;
    } | null;

    const rawItems = itemsBody?.items ?? [];
    const rawTags = tagsBody?.items ?? [];
    const itemTagIdsByItem: Record<string, string[]> = {};
    const entryCountsByItem: Record<string, number> = {};
    for (const item of rawItems) {
      itemTagIdsByItem[item.id] = (item.tags ?? []).map((t) => t.id).sort();
      entryCountsByItem[item.id] = item.entry_count;
    }

    return {
      itemsStatus: itemsRes.status,
      tagsStatus: tagsRes.status,
      itemIds: rawItems.map((it) => it.id).sort(),
      tagIds: rawTags.map((t) => t.id).sort(),
      itemTagIdsByItem,
      entryCountsByItem,
    };
  });
}

/**
 * Fetches `GET /api/v1/items/<id>` and `GET /api/v1/items/<id>/entries` for each item in `itemIds` and asserts
 * that every item still exists with `entry_count === 0` and an empty `entries` list (`items: []`), and that
 * `GET /api/v1/entries/<id>` returns `404` for every `deletedEntryIds` (P04-A9).
 */
export async function expectServerItemsHaveZeroEntries(
  page: Page,
  itemIds: readonly string[],
  deletedEntryIds: readonly string[] = [],
): Promise<void> {
  const probe = await page.evaluate(
    async ({ targetItemIds, targetEntryIds }) => {
      const itemChecks = await Promise.all(
        targetItemIds.map(async (id) => {
          const [itemRes, entriesRes] = await Promise.all([
            fetch(`/api/v1/items/${encodeURIComponent(id)}`, { credentials: 'include' }),
            fetch(`/api/v1/items/${encodeURIComponent(id)}/entries`, { credentials: 'include' }),
          ]);
          const itemBody = (await itemRes.json().catch(() => null)) as {
            readonly id?: string;
            readonly entry_count?: number;
          } | null;
          const entriesBody = (await entriesRes.json().catch(() => null)) as {
            readonly items?: ReadonlyArray<{ readonly id: string }>;
          } | null;
          return {
            itemId: id,
            itemStatus: itemRes.status,
            entryCount: itemBody?.entry_count ?? -1,
            entriesStatus: entriesRes.status,
            entriesLen: (entriesBody?.items ?? []).length,
          };
        }),
      );
      const entryStatuses = await Promise.all(
        targetEntryIds.map(async (entryId) => {
          const res = await fetch(`/api/v1/entries/${encodeURIComponent(entryId)}`, {
            credentials: 'include',
          });
          return { entryId, status: res.status };
        }),
      );
      return { itemChecks, entryStatuses };
    },
    { targetItemIds: itemIds, targetEntryIds: deletedEntryIds },
  );

  for (const check of probe.itemChecks) {
    expect(check.itemStatus).toBe(200);
    expect(check.entryCount).toBe(0);
    expect(check.entriesStatus).toBe(200);
    expect(check.entriesLen).toBe(0);
  }
  for (const entryCheck of probe.entryStatuses) {
    expect(entryCheck.status).toBe(404);
  }
}

/**
 * Probes the server API directly from the page's authenticated session with an envelope carrying `oldVaultKeyId`
 * after a new vault has been created (`newVaultKeyId !== oldVaultKeyId`), proving the server rejects stale-key
 * writes (`POST /api/v1/items/<id>/entries` and `POST /api/v1/items/<id>/entries/import-json`) with
 * `409 entry_key_mismatch` (plan Task 8, P04-A9). Uses a fixed 17-byte dummy base64url ciphertext (`256` bucket)
 * containing no secret material.
 */
export async function expectServerRejectsOldVaultKeyEntryWrites(
  page: Page,
  itemId: string,
  oldVaultKeyId: string,
): Promise<void> {
  const result = await page.evaluate(
    async ({ targetItemId, staleKeyId }) => {
      let csrf: string | null = null;
      for (const part of document.cookie.split(';')) {
        const trimmed = part.trim();
        if (trimmed.startsWith('sabk_csrf=')) {
          csrf = decodeURIComponent(trimmed.slice('sabk_csrf='.length));
          break;
        }
      }
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      };
      // Well-formed envelope so the request passes ValidatePayload (apps/api/internal/entry/entry.go) and reaches the
      // key_id comparison: 24 zero bytes base64url = 32 'A's (XChaCha20 nonce, vault.WrapNonceBytes);
      // 17 zero bytes base64url = 23 'A's (1 B plaintext + 16 B tag -> bucket 256).
      const dummyNonce = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const dummyCiphertext = 'AAAAAAAAAAAAAAAAAAAAAAA';

      const createRes = await fetch(`/api/v1/items/${encodeURIComponent(targetItemId)}/entries`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          ...headers,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          type: 'text',
          envelope: {
            v: 1,
            alg: 'xchacha20poly1305-ietf',
            key_id: staleKeyId,
            nonce: dummyNonce,
            ct_enc: 'utf8',
          },
          ciphertext: dummyCiphertext,
          plaintext_len_bucket: 256,
        }),
      });
      const createProblem = (await createRes.json().catch(() => null)) as {
        readonly code?: string;
      } | null;

      const importRes = await fetch(
        `/api/v1/items/${encodeURIComponent(targetItemId)}/entries/import-json`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            ...headers,
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            type: 'json',
            source: 'file',
            envelope: {
              v: 1,
              alg: 'xchacha20poly1305-ietf',
              key_id: staleKeyId,
              nonce: dummyNonce,
              ct_enc: 'utf8',
            },
            ciphertext: dummyCiphertext,
            plaintext_len_bucket: 256,
          }),
        },
      );
      const importProblem = (await importRes.json().catch(() => null)) as {
        readonly code?: string;
      } | null;

      return {
        createStatus: createRes.status,
        createCode: createProblem?.code ?? null,
        importStatus: importRes.status,
        importCode: importProblem?.code ?? null,
      };
    },
    { targetItemId: itemId, staleKeyId: oldVaultKeyId },
  );

  expect(result.createStatus).toBe(409);
  expect(result.createCode).toBe('entry_key_mismatch');
  expect(result.importStatus).toBe(409);
  expect(result.importCode).toBe('entry_key_mismatch');
}
