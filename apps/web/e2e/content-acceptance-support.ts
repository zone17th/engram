import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { UI_WAIT_MS, expectVaultShut } from './vault-passkey-support';

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
 * Boolean check that the decrypted plaintext in the page's React Query cache (`['vault','entry-body',entryId,version]`)
 * is byte-identical (`===`) to `expectedPlaintext` without printing either string on failure (P04-A6, ACC-FE1-9).
 * Also verifies via `GET /api/v1/entries/<entryId>` that the server stored only ciphertext (`ciphertext !== expectedPlaintext`).
 */
export async function expectEntryDecryptedPlaintextExactBool(
  page: Page,
  entryId: string,
  expectedPlaintext: string,
  timeout = ACCEPTANCE_UI_WAIT_MS,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ id, target }) => {
            const res = await fetch(`/api/v1/entries/${encodeURIComponent(id)}`, {
              credentials: 'include',
            });
            if (res.status !== 200) return false;
            const record = (await res.json().catch(() => null)) as {
              readonly id?: string;
              readonly type?: string;
              readonly ciphertext?: string;
              readonly envelope?: {
                readonly v?: number;
                readonly key_id?: string;
                readonly nonce?: string;
                readonly ct_enc?: string;
              };
            } | null;
            if (
              !record ||
              record.id !== id ||
              record.type !== 'json' ||
              typeof record.ciphertext !== 'string' ||
              record.ciphertext.length === 0 ||
              record.ciphertext === target ||
              record.ciphertext.includes(target) ||
              typeof record.envelope?.key_id !== 'string'
            ) {
              return false;
            }
            return true;
          },
          { id: entryId, target: expectedPlaintext },
        ),
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
): RequestPlaintextMonitor {
  const secrets = new Map<string, string>();
  for (const item of initialSecrets) {
    if (item.value.length > 0) {
      secrets.set(item.label, item.value);
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
  const recordLeak = (leak: RequestPlaintextLeak) => {
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
        secrets.set(label, value);
        for (const snap of capturedRequests) {
          scanSnapshotForSecret(snap, label, value);
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
