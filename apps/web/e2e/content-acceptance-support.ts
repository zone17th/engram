import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { UI_WAIT_MS, expectVaultShut } from './vault-passkey-support';

// Helpers for the P04-T21a acceptance specs (`content-journey.spec.ts`, `content-journey-p03.spec.ts`,
// `content-artifacts.spec.ts`). Nothing here stubs `/api/**` (all calls reach the compose stack's real API
// and Postgres database via the production Next proxy).
//
// Security (user-dec-016):
// - Secret inputs (passphrases, recovery keys, entry bodies, raw JSON) are written via DOM prototype setters
//   so Playwright never logs plaintext in actionability timeout call logs.
// - Plaintext leak checks return only structural diagnostics (method, pathname, location, needle index),
//   never echoing secret values into the public CI log.

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

export interface RequestPlaintextLeak {
  readonly method: string;
  readonly pathname: string;
  readonly surface: 'url' | 'header' | 'postData';
  readonly headerName?: string;
  readonly needleLabel: string;
}

export interface RequestPlaintextMonitor {
  readonly attachContext: (context: BrowserContext) => void;
  readonly attachPage: (page: Page) => void;
  readonly registerSecret: (label: string, value: string) => void;
  readonly getLeaks: () => readonly RequestPlaintextLeak[];
  readonly getRequestCount: () => number;
  readonly assertNoLeaks: () => void;
}

/**
 * Records every request across attached pages/contexts and checks URL, headers, and postData against
 * registered secret strings (user-dec-016, P04-A4). Never stores or prints the secret values themselves.
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

  const leaks: RequestPlaintextLeak[] = [];
  let requestCount = 0;
  const attachedPages = new WeakSet<Page>();
  const attachedContexts = new WeakSet<BrowserContext>();

  const inspectRequest = (req: {
    method: () => string;
    url: () => string;
    headers: () => Record<string, string>;
    postData: () => string | null;
  }) => {
    requestCount += 1;
    const rawUrl = req.url();
    let pathname = rawUrl;
    try {
      pathname = new URL(rawUrl).pathname;
    } catch {
      pathname = '<invalid-url>';
    }
    const method = req.method();
    const headers = req.headers();
    const postData = req.postData() ?? '';

    for (const [needleLabel, needle] of secrets.entries()) {
      if (!needle) continue;
      if (rawUrl.includes(needle)) {
        leaks.push({ method, pathname, surface: 'url', needleLabel });
      }
      for (const [headerName, headerVal] of Object.entries(headers)) {
        if (headerVal && headerVal.includes(needle)) {
          leaks.push({ method, pathname, surface: 'header', headerName, needleLabel });
        }
      }
      if (postData && postData.includes(needle)) {
        leaks.push({ method, pathname, surface: 'postData', needleLabel });
      }
    }
  };

  const attachPage = (page: Page) => {
    if (attachedPages.has(page)) return;
    attachedPages.add(page);
    page.on('request', inspectRequest);
  };

  const attachContext = (context: BrowserContext) => {
    if (attachedContexts.has(context)) return;
    attachedContexts.add(context);
    context.on('request', inspectRequest);
    for (const page of context.pages()) {
      attachPage(page);
    }
    context.on('page', (page) => {
      attachPage(page);
    });
  };

  return {
    attachContext,
    attachPage,
    registerSecret(label: string, value: string) {
      if (value.length > 0) {
        secrets.set(label, value);
      }
    },
    getLeaks() {
      return leaks;
    },
    getRequestCount() {
      return requestCount;
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

  return {
    matchedLabels,
    nonEmptyDecryptedNodes,
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
