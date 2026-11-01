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

function attachNetworkRecorder(page: Page): {
  readonly records: CapturedRequestRecord[];
  readonly flushPending: () => Promise<void>;
  readonly countSince: (index: number) => number;
  readonly assertNeverContains: (sentinels: readonly string[]) => void;
} {
  const records: CapturedRequestRecord[] = [];
  const pendingHeaderTasks = new Set<Promise<void>>();
  const context = page.context();

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
    async flushPending(): Promise<void> {
      if (pendingHeaderTasks.size > 0) {
        await Promise.all([...pendingHeaderTasks]);
      }
    },
    countSince(index: number): number {
      return records.length - index;
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
    await createVaultViaOnboarding(page, VAULT_PASSPHRASE, { kind: 'skip' });
    await expectUnlockedOnApp(page);

    await page.goto('/app');
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

    // 1. Paste `secret-body-123`, wait >= 1 s, then type `name: ` in front -> no request contains `secret-body-123` at any time.
    const mark1 = recorder.records.length;
    await setSecretTextareaValue(omnibox, secretBody123);
    await page.waitForTimeout(1_100);
    expect(recorder.countSince(mark1)).toBe(0);

    await setSecretTextareaValue(omnibox, `name: ${secretBody123}`);
    await page.waitForTimeout(500);
    await recorder.flushPending();
    expect(recorder.countSince(mark1)).toBe(0);
    recorder.assertNeverContains(allSentinels);

    // 2. Paste `a:SECRET`, wait >= 1 s -> no request contains `a:SECRET` (or encoded/base64 variants) or `SECRET` before Enter (advisor-dec-098, HM18A-R1-4).
    const mark2 = recorder.records.length;
    await setSecretTextareaValue(omnibox, fullColonDraft);
    await page.waitForTimeout(1_100);
    await recorder.flushPending();
    expect(recorder.countSince(mark2)).toBe(0);
    recorder.assertNeverContains(allSentinels);
    // 3. Paste multi-line text without `:` then press Enter -> nothing sent; guard alert shown.
    const mark3 = recorder.records.length;
    await setSecretTextareaValue(omnibox, multiLineSecret);
    await omnibox.press('Enter');
    await expect(page.getByTestId('omnibox-guard-alert')).toBeVisible({ timeout: UI_WAIT_MS });
    await page.waitForTimeout(300);
    expect(recorder.countSince(mark3)).toBe(0);
    recorder.assertNeverContains(allSentinels);

    // 4. One 5 KB line without `:` then press Enter -> nothing sent; guard alert shown.
    const mark4 = recorder.records.length;
    await setSecretTextareaValue(omnibox, fiveKbSingleLine);
    await omnibox.press('Enter');
    await expect(page.getByTestId('omnibox-guard-alert')).toBeVisible({ timeout: UI_WAIT_MS });
    await page.waitForTimeout(300);
    expect(recorder.countSince(mark4)).toBe(0);
    recorder.assertNeverContains(allSentinels);

    // 5. Type an add draft then delete the `:` -> nothing sent.
    const mark5 = recorder.records.length;
    await setSecretTextareaValue(omnibox, `wifi #home: ${draftDeletedColonSecret}`);
    await page.waitForTimeout(300);
    await setSecretTextareaValue(omnibox, `wifi #home ${draftDeletedColonSecret}`);
    await page.waitForTimeout(1_100);
    await recorder.flushPending();
    expect(recorder.countSince(mark5)).toBe(0);
    recorder.assertNeverContains(allSentinels);

    // 5b. Add-mode Enter stub in 18a -> sends 0 requests (HM18A-R1-8).
    const markAddStub = recorder.records.length;
    await setSecretTextareaValue(omnibox, fullColonDraft);
    await omnibox.press('Enter');
    await page.waitForTimeout(300);
    await recorder.flushPending();
    expect(recorder.countSince(markAddStub)).toBe(0);
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
    expect(recorder.countSince(markTag)).toBe(0);
    recorder.assertNeverContains(allSentinels);

    // 7. Positive control (HM18A-R1-8): a valid one-line search + Enter records `GET /api/v1/items?...q=positive-probe` and no sentinel leaks.
    const markPos = recorder.records.length;
    await setSecretTextareaValue(omnibox, 'positive-probe');
    await omnibox.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible({ timeout: UI_WAIT_MS });
    await recorder.flushPending();
    expect(recorder.countSince(markPos)).toBeGreaterThanOrEqual(1);
    const positiveSearchRecords = recorder.records
      .slice(markPos)
      .filter((r) => r.method === 'GET' && r.url.includes('/api/v1/items') && r.url.includes('q=positive-probe'));
    expect(positiveSearchRecords).toHaveLength(1);
    recorder.assertNeverContains(allSentinels);
  });
});
