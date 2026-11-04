import { expect, test, type Locator, type Page } from '@playwright/test';
import { uniqueEmail } from './helpers';
import {
  createVaultViaOnboarding,
  expectUnlockedOnApp,
  signupPasswordUser,
} from './vault-journey-support';
import { VAULT_PASSPHRASE } from './vault-passkey-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs,
// so a failure while a recovery-key sheet or secret input is mounted can never serialize secrets to disk.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const CAPTURE_TIMEOUT_MS = 240_000;
const UI_WAIT_MS = 30_000;

interface CapturedRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly headersText: string;
  readonly postData: string;
}

/**
 * Writes a value into a `<textarea>` or `<input>` without appearing in Playwright's `fill()` call logs.
 */
async function setSecretTextareaValue(locator: Locator, value: string): Promise<void> {
  await expect(locator).toBeEditable({ timeout: UI_WAIT_MS });
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

interface ApiResponseSummary {
  readonly method: string;
  readonly pathname: string;
  readonly status: number;
}

async function collectOmniboxFailureDiagnostics(
  page: Page,
  apiResponses: readonly ApiResponseSummary[],
): Promise<string> {
  const domState = await page
    .evaluate(() => {
      const stepNodes = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="omnibox-save-plan"] [data-step-key]'),
      );
      const stepStatuses = stepNodes.map(
        (el) => `${el.getAttribute('data-step-key') ?? '?'}:${el.getAttribute('data-step-status') ?? '?'}`,
      );
      const errorTestIds = [
        'omnibox-plan-error',
        'omnibox-action-error',
        'omnibox-add-error',
        'omnibox-guard-alert',
      ].filter((id) => Boolean(document.querySelector(`[data-testid="${id}"]:not([hidden])`)));
      const actionErrorText =
        document.querySelector('[data-testid="omnibox-action-error"]')?.textContent?.trim() ?? null;
      const unlockToSaveVisible = Boolean(
        document.querySelector('[data-testid="omnibox-unlock-to-save-btn"]:not([hidden])'),
      );
      const vaultState =
        document.querySelector('.vault-pill')?.getAttribute('data-vault-state') ?? null;
      return { stepStatuses, errorTestIds, actionErrorText, unlockToSaveVisible, vaultState };
    })
    .catch(() => ({
      stepStatuses: [],
      errorTestIds: [],
      actionErrorText: null,
      unlockToSaveVisible: false,
      vaultState: null,
    }));

  const recentResponses = apiResponses
    .slice(-15)
    .map((r) => `${r.method} ${r.pathname} -> ${r.status}`);
  return JSON.stringify({
    vaultState: domState.vaultState,
    unlockToSaveVisible: domState.unlockToSaveVisible,
    stepStatuses: domState.stepStatuses,
    errorTestIds: domState.errorTestIds,
    actionErrorText: domState.actionErrorText,
    recentResponses,
  });
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0]?.split('#')[0] ?? '';
  }
}

function queryParamsOf(url: string): URLSearchParams {
  try {
    return new URL(url).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** `GET /api/v1/suggest` (any), the keystroke / focus suggest endpoint (P05 T17). */
function isSuggestRequest(rec: CapturedRequestRecord): boolean {
  return rec.method === 'GET' && pathnameOf(rec.url) === '/api/v1/suggest';
}

/** `GET /api/v1/search` (any), the Enter search endpoint (P05 T17). */
function isSearchRequest(rec: CapturedRequestRecord): boolean {
  return rec.method === 'GET' && pathnameOf(rec.url) === '/api/v1/search';
}

function isOmniboxRelevantRequest(rec: CapturedRequestRecord): boolean {
  const { method, url } = rec;
  // Match only omnibox-initiated reads: `GET /search` (Enter), `GET /suggest` WITH a `q` (a keystroke, never the
  // `q`-less `recent` suggest that focus sends: asserted separately in step 0) and `/items/lookup`. Background `/app`
  // home-list or rail refetches (`sort=recent`) are excluded (HM18-R4-6). The old `GET /items?q=&sort=alpha` and
  // `GET /tags?q=&sort=alpha` omnibox reads no longer exist (P05 T17 PR 17-2a).
  if (
    isSearchRequest(rec) ||
    (isSuggestRequest(rec) && queryParamsOf(url).has('q')) ||
    url.includes('/items/lookup')
  ) {
    return true;
  }
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
    if (
      url.includes('/items') ||
      url.includes('/tags') ||
      url.includes('/entries')
    ) {
      return true;
    }
  }
  return false;
}

function attachNetworkRecorder(page: Page): {
  readonly records: CapturedRequestRecord[];
  readonly apiResponses: ApiResponseSummary[];
  readonly flushPending: () => Promise<void>;
  readonly countSince: (index: number) => number;
  readonly expectZeroSince: (index: number, label: string) => void;
  readonly assertNeverContains: (sentinels: readonly string[]) => void;
} {
  const records: CapturedRequestRecord[] = [];
  const apiResponses: ApiResponseSummary[] = [];
  const pendingHeaderTasks = new Set<Promise<void>>();
  const context = page.context();

  context.on('response', (res) => {
    const url = res.url();
    if (url.includes('/api/v1/')) {
      apiResponses.push({
        method: res.request().method(),
        pathname: new URL(url).pathname,
        status: res.status(),
      });
    }
  });

  context.on('request', (req) => {
    const method = req.method();
    const url = req.url();
    const postData = req.postData() ?? '';
    const syncHeaders = req.headers();
    const filterNonBrowserHeaders = (hdrs: Record<string, string>) =>
      Object.entries(hdrs)
        .filter(([k]) => !k.toLowerCase().startsWith('sec-'))
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');

    const recordIndex = records.length;
    records.push({
      method,
      url,
      headersText: filterNonBrowserHeaders(syncHeaders),
      postData,
    });

    const task = req
      .allHeaders()
      .then((allHdrs) => {
        records[recordIndex] = {
          method,
          url,
          headersText: filterNonBrowserHeaders(allHdrs),
          postData,
        };
      })
      .catch(() => undefined)
      .finally(() => {
        pendingHeaderTasks.delete(task);
      });
    pendingHeaderTasks.add(task);
  });

  return {
    records,
    apiResponses,
    async flushPending(): Promise<void> {
      if (pendingHeaderTasks.size > 0) {
        await Promise.all([...pendingHeaderTasks]);
      }
    },
    countSince(index: number): number {
      return records.slice(index).filter(isOmniboxRelevantRequest).length;
    },
    expectZeroSince(index: number, label: string): void {
      const matched = records.slice(index).filter(isOmniboxRelevantRequest);
      if (matched.length > 0) {
        const summary = matched
          .map((rec) => {
            try {
              return `${rec.method} ${new URL(rec.url).pathname}`;
            } catch {
              const rawPath = rec.url.split('?')[0]?.split('#')[0] ?? '/unknown';
              return `${rec.method} ${rawPath}`;
            }
          })
          .join(', ');
        throw new Error(
          `Expected 0 omnibox requests in ${label}, received ${matched.length}: [${summary}]`,
        );
      }
      expect(matched.length).toBe(0);
    },
    assertNeverContains(sentinels: readonly string[]): void {
      for (const rec of records) {
        const combined = `${rec.method} ${rec.url}\n${rec.headersText}\n${rec.postData}`;
        for (let idx = 0; idx < sentinels.length; idx += 1) {
          const needle = sentinels[idx];
          if (needle && combined.includes(needle)) {
            throw new Error(
              `Network leak detected for sentinel[${idx}] in ${rec.method} ${new URL(rec.url).pathname}`,
            );
          }
        }
      }
    },
  };
}

test.describe('P04-T18a A4 omnibox network capture (search & pre-Enter boundaries)', () => {
  test.skip(
    !process.env.E2E_STACK,
    'needs the compose stack (E2E_STACK=1): real API, real database',
  );

  test('records all requests from page load: never sends pasted body before/after prepending name:, never sends a:SECRET before Enter, blocks multi-line and 5 KB search on Enter, and sends nothing when deleting : from an add draft', async ({
    page,
  }) => {
    test.setTimeout(CAPTURE_TIMEOUT_MS);

    const recorder = attachNetworkRecorder(page);

    const email = uniqueEmail('content-omni-cap');
    await signupPasswordUser(page, email);
    // Stay on `/app` directly after onboarding skip (NO `page.goto('/app')` reload) so the vault remains unlocked
    // while `vault.vaultMeta` starts as `null` — exercising the advisor-dec-200 `reloadVaultMeta` bootstrap guard
    // when step 5b saves the first quick-add entry (HM18-CI-8).
    await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
    await expectUnlockedOnApp(page);
    const omnibox = page.locator('#omni textarea[data-vault-secret]');
    await expect(omnibox).toBeVisible({ timeout: UI_WAIT_MS });

    // Wait for initial /items and /tags page-load queries to settle.
    await expect(page.getByTestId('home-empty-state')).toBeVisible({ timeout: UI_WAIT_MS });
    await page.waitForTimeout(300);

    const secretBody123 = 'secret-body-123';
    const secretAfterColon = 'SECRET';
    const fullColonDraft = `a:${secretAfterColon}`;
    const encodedColonDraft = encodeURIComponent(fullColonDraft);
    const base64ColonDraft = Buffer.from(fullColonDraft, 'utf8').toString('base64');
    const multiLineSecret = 'first-line-secret-901\nsecond-line-secret-902';
    const fiveKbSingleLine = `fivekb-secret-${'x'.repeat(5120)}`;
    const draftDeletedColonSecret = 'draft-deleted-colon-secret-777';
    const typedTagSecret = 'typed-tag-secret-555';
    const longTagSecret = `longtag-${'t'.repeat(55)}`;

    const allSentinels = [
      secretBody123,
      secretAfterColon,
      fullColonDraft,
      encodedColonDraft,
      base64ColonDraft,
      'first-line-secret-901',
      'second-line-secret-902',
      'fivekb-secret-',
      draftDeletedColonSecret,
      typedTagSecret,
      'longtag-',
    ] as const;

    // 0. P05 T17 positive controls for the keystroke endpoint (nothing secret is typed here):
    // 0a. Focus sends exactly the `recent` `GET /suggest` WITHOUT `q`.
    await omnibox.blur();
    const markFocus = recorder.records.length;
    await omnibox.focus();
    await expect
      .poll(() => recorder.records.slice(markFocus).filter(isSuggestRequest).length, {
        timeout: UI_WAIT_MS,
      })
      .toBeGreaterThanOrEqual(1);
    for (const rec of recorder.records.slice(markFocus).filter(isSuggestRequest)) {
      expect(queryParamsOf(rec.url).has('q')).toBe(false);
    }
    expect(recorder.records.slice(markFocus).filter(isSearchRequest)).toHaveLength(0);

    // 0b. Clean typing (real key events -> native beforeinput/input with `insertText`) sends `GET /suggest` with `q`
    // after the 120 ms debounce, always `semantic=0` here (the account has the semantic toggle off), and never `/search`.
    const markTyped = recorder.records.length;
    await omnibox.pressSequentially('typed-probe');
    await expect
      .poll(
        () =>
          recorder.records
            .slice(markTyped)
            .filter((r) => isSuggestRequest(r) && queryParamsOf(r.url).get('q') === 'typed-probe')
            .length,
        { timeout: UI_WAIT_MS },
      )
      .toBeGreaterThanOrEqual(1);
    await recorder.flushPending();
    for (const rec of recorder.records.slice(markTyped).filter(isSuggestRequest)) {
      expect(queryParamsOf(rec.url).get('semantic')).toBe('0');
    }
    expect(recorder.records.slice(markTyped).filter(isSearchRequest)).toHaveLength(0);
    await omnibox.press('Control+A');
    await omnibox.press('Backspace');
    await omnibox.press('Escape');
    await page.waitForTimeout(300);

    // 1. Paste `secret-body-123`, wait >= 1 s, then type `name: ` in front -> no request contains `secret-body-123` at any time.
    const mark1 = recorder.records.length;
    await setSecretTextareaValue(omnibox, secretBody123);
    await page.waitForTimeout(1_100);
    recorder.expectZeroSince(mark1, 'step 1a (paste body without colon)');

    await setSecretTextareaValue(omnibox, `name: ${secretBody123}`);
    await page.waitForTimeout(500);
    await recorder.flushPending();
    recorder.expectZeroSince(mark1, 'step 1b (prepend name: before Enter)');
    recorder.assertNeverContains(allSentinels);

    // 2. Paste `a:SECRET`, wait >= 1 s -> no request contains `a:SECRET` (or encoded/base64 variants) or `SECRET` before Enter (advisor-dec-098, HM18A-R1-4).
    const mark2 = recorder.records.length;
    await setSecretTextareaValue(omnibox, fullColonDraft);
    await page.waitForTimeout(1_100);
    await recorder.flushPending();
    recorder.expectZeroSince(mark2, 'step 2 (paste a:SECRET before Enter)');
    recorder.assertNeverContains(allSentinels);
    // 3. Paste multi-line text without `:` then press Enter -> nothing sent; guard alert shown.
    const mark3 = recorder.records.length;
    await setSecretTextareaValue(omnibox, multiLineSecret);
    await omnibox.press('Enter');
    await expect(page.getByTestId('omnibox-guard-alert')).toBeVisible({ timeout: UI_WAIT_MS });
    await page.waitForTimeout(300);
    await recorder.flushPending();
    recorder.expectZeroSince(mark3, 'step 3 (multi-line search on Enter)');
    recorder.assertNeverContains(allSentinels);

    // 4. One 5 KB line without `:` then press Enter -> nothing sent; guard alert shown.
    const mark4 = recorder.records.length;
    await setSecretTextareaValue(omnibox, fiveKbSingleLine);
    await omnibox.press('Enter');
    await expect(page.getByTestId('omnibox-guard-alert')).toBeVisible({ timeout: UI_WAIT_MS });
    await page.waitForTimeout(300);
    await recorder.flushPending();
    recorder.expectZeroSince(mark4, 'step 4 (5 KB search on Enter)');
    recorder.assertNeverContains(allSentinels);
    // 5. Type an add draft then delete the `:` -> nothing sent.
    const mark5 = recorder.records.length;
    await setSecretTextareaValue(omnibox, `wifi #home: ${draftDeletedColonSecret}`);
    await page.waitForTimeout(300);
    await setSecretTextareaValue(omnibox, `wifi #home ${draftDeletedColonSecret}`);
    await page.waitForTimeout(1_100);
    await recorder.flushPending();
    recorder.expectZeroSince(mark5, 'step 5 (delete : from add draft)');
    recorder.assertNeverContains(allSentinels);

    // 5b. Add-mode invalid draft (`a:` with empty body) on Enter -> sends 0 requests;
    // valid add-mode Enter (`name #home: secret-body-123`) sends only `GET /items/lookup?name=name` + metadata/sealed writes, never the body (HM18A-R1-8, HM18A-R2-5).
    const markAddInvalid = recorder.records.length;
    await setSecretTextareaValue(omnibox, 'a:   ');
    await omnibox.press('Enter');
    await page.waitForTimeout(300);
    await recorder.flushPending();
    recorder.expectZeroSince(markAddInvalid, 'step 5b (invalid add draft a: with empty body)');
    recorder.assertNeverContains(allSentinels);

    const markSave = recorder.records.length;
    await setSecretTextareaValue(omnibox, `name #home: ${secretBody123}`);
    await omnibox.press('Enter');

    const savedToast = page.getByTestId('undo-toast-item').first();
    try {
      await expect(savedToast).toBeVisible({ timeout: UI_WAIT_MS });
    } catch (err) {
      const diag = await collectOmniboxFailureDiagnostics(page, recorder.apiResponses);
      throw new Error(
        `Quick-add save did not produce undo-toast-item. Diagnostics: ${diag}\nOriginal error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await expect(savedToast).toContainText('name');
    await recorder.flushPending();
    expect(recorder.countSince(markSave)).toBeGreaterThan(0);

    const addLookupRecords = recorder.records
      .slice(markSave)
      .filter(
        (rec) =>
          rec.method === 'GET' &&
          rec.url.includes('/api/v1/items/lookup') &&
          rec.url.includes('name=name'),
      );
    expect(addLookupRecords).toHaveLength(1);

    const entryPostRecord = recorder.records
      .slice(markSave)
      .find((rec) => rec.method === 'POST' && /\/api\/v1\/items\/[^/]+\/entries$/.test(rec.url));
    expect(entryPostRecord).toBeDefined();
    const parsedPostBody = JSON.parse(entryPostRecord!.postData) as {
      readonly type?: string;
      readonly ciphertext?: string;
      readonly envelope?: { readonly v?: number; readonly alg?: string; readonly key_id?: string };
    };
    expect(parsedPostBody.type).toBe('text');
    expect(typeof parsedPostBody.ciphertext).toBe('string');
    expect(parsedPostBody.ciphertext!.length).toBeGreaterThan(16);
    expect(parsedPostBody.envelope?.v).toBe(1);
    expect(parsedPostBody.envelope?.alg).toBe('xchacha20poly1305-ietf');
    recorder.assertNeverContains(allSentinels);

    // 6. Tag mode (`#secret` typed without Enter, Enter on >50-rune tag token, Ctrl+Enter in `#` mode) -> nothing sent (HM18A-R1-8).
    const markTag = recorder.records.length;
    await setSecretTextareaValue(omnibox, `#${typedTagSecret}`);
    await page.waitForTimeout(500);
    await omnibox.press('Control+Enter');
    await page.waitForTimeout(300);
    await setSecretTextareaValue(omnibox, `#${longTagSecret}`);
    await omnibox.press('Enter');
    await expect(page.getByTestId('omnibox-guard-alert')).toBeVisible({ timeout: UI_WAIT_MS });
    await page.waitForTimeout(300);
    await recorder.flushPending();
    recorder.expectZeroSince(markTag, 'step 6 (tag mode without valid Enter)');
    recorder.assertNeverContains(allSentinels);

    // 7. Positive controls (HM18A-R1-8, HM18A-R2-5):
    // 7a. Valid one-line search + Enter records exactly one `GET /api/v1/search?q=positive-probe&semantic=0` (the pasted-style
    // draft is tainted, so no keystroke `/suggest` and no `GET /items?q=`) and no sentinel leaks.
    const markPos = recorder.records.length;
    await setSecretTextareaValue(omnibox, 'positive-probe');
    await omnibox.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: UI_WAIT_MS });
    await recorder.flushPending();
    expect(recorder.countSince(markPos)).toBeGreaterThanOrEqual(1);
    const positiveSearchRecords = recorder.records
      .slice(markPos)
      .filter((r) => isSearchRequest(r) && queryParamsOf(r.url).get('q') === 'positive-probe');
    expect(positiveSearchRecords).toHaveLength(1);
    expect(queryParamsOf(positiveSearchRecords[0]!.url).get('semantic')).toBe('0');
    expect(
      recorder.records
        .slice(markPos)
        .filter((r) => isSuggestRequest(r) && queryParamsOf(r.url).get('q') === 'positive-probe'),
    ).toHaveLength(0);
    expect(
      recorder.records
        .slice(markPos)
        .filter((r) => r.method === 'GET' && /\/api\/v1\/(items|tags)$/.test(pathnameOf(r.url)) && queryParamsOf(r.url).has('q')),
    ).toHaveLength(0);
    recorder.assertNeverContains(allSentinels);

    // 7b. Valid tag-mode draft (`#positive-tag`, typed with real key events) sends `GET /api/v1/suggest?scope=tag&q=positive-tag`
    // by keystroke (never `GET /tags?q=`); Enter with no active row then sends `GET /search?scope=tag&semantic=0` (HM18A-R2-5).
    await omnibox.press('Control+A');
    await omnibox.press('Backspace');
    const markPosTag = recorder.records.length;
    await omnibox.pressSequentially('#positive-tag');
    await expect
      .poll(
        () =>
          recorder.records
            .slice(markPosTag)
            .filter(
              (r) =>
                isSuggestRequest(r) &&
                queryParamsOf(r.url).get('scope') === 'tag' &&
                queryParamsOf(r.url).get('q') === 'positive-tag',
            ).length,
        { timeout: UI_WAIT_MS },
      )
      .toBeGreaterThanOrEqual(1);
    await omnibox.press('Enter');
    await expect(page.getByTestId('omnibox-tag-empty')).toBeVisible({ timeout: UI_WAIT_MS });
    await recorder.flushPending();
    const positiveTagSearch = recorder.records
      .slice(markPosTag)
      .filter((r) => isSearchRequest(r) && queryParamsOf(r.url).get('q') === 'positive-tag');
    expect(positiveTagSearch).toHaveLength(1);
    expect(queryParamsOf(positiveTagSearch[0]!.url).get('scope')).toBe('tag');
    expect(queryParamsOf(positiveTagSearch[0]!.url).get('semantic')).toBe('0');
    expect(
      recorder.records
        .slice(markPosTag)
        .filter((r) => r.method === 'GET' && pathnameOf(r.url) === '/api/v1/tags' && queryParamsOf(r.url).has('q')),
    ).toHaveLength(0);
    recorder.assertNeverContains(allSentinels);

    // 7c. Valid `Ctrl+Enter` create in search mode (`positive-created-item`) records `POST /api/v1/items` with `{ name }` only and no entry (HM18A-R2-5).
    const markPosCreate = recorder.records.length;
    await setSecretTextareaValue(omnibox, 'positive-created-item');
    await omnibox.press('Control+Enter');
    await expect
      .poll(
        async () =>
          omnibox.evaluate(
            (el) => (el as HTMLTextAreaElement | HTMLInputElement).value.length === 0,
          ),
        { timeout: UI_WAIT_MS },
      )
      .toBe(true);
    await recorder.flushPending();
    const positiveCreateRecords = recorder.records
      .slice(markPosCreate)
      .filter((r) => r.method === 'POST' && /\/api\/v1\/items$/.test(r.url));
    expect(positiveCreateRecords).toHaveLength(1);
    expect(JSON.parse(positiveCreateRecords[0]!.postData)).toEqual({
      name: 'positive-created-item',
    });
    const createSliceEntries = recorder.records
      .slice(markPosCreate)
      .filter((r) => r.method === 'POST' && r.url.includes('/entries'));
    expect(createSliceEntries).toHaveLength(0);
    recorder.assertNeverContains(allSentinels);
  });
});
