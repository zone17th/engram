import { expect, test } from '@playwright/test';
import { LOCKED_ITEM_FIXTURE, installItemPageContentMocks } from './content-itempage-support';
import {
  UI_WAIT_MS,
  gotoLocked,
  installApiMocks,
  prepare,
  unlockFromBanner,
} from './vault-locked-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

const ITEM = LOCKED_ITEM_FIXTURE.item;
const ENTRIES = LOCKED_ITEM_FIXTURE.entries;

test.describe('P04-T17 Import JSON U14 real-browser clipboard paste & import flow (project content)', () => {
  test('writes a\\r\\nb JSON to the real Chromium clipboard, pastes into the Import JSON dialog, records whether CR survived in testInfo.annotations, and verifies encrypted POST /entries/import-json', async ({
    context,
    page,
  }, testInfo) => {
    test.setTimeout(90_000);

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await installApiMocks(context);
    await installItemPageContentMocks(context);

    const capturedImportRequests: Array<{
      readonly url: string;
      readonly rawBody: string;
    }> = [];

    await context.route(`**/api/v1/items/${ITEM.id}/entries/import-json`, async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        const rawBody = req.postData() ?? '';
        capturedImportRequests.push({ url: req.url(), rawBody });
        const parsed = JSON.parse(rawBody) as {
          id: string;
          type: 'json';
          source: 'paste' | 'file';
          plaintext_len_bucket: number;
        };
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: parsed.id,
            item_id: ITEM.id,
            type: 'json',
            position: ENTRIES.length,
            version: 1,
            plaintext_len_bucket: parsed.plaintext_len_bucket,
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          }),
        });
        return;
      }
      await route.fallback();
    });

    await prepare(page, 'light', 1440, 900);
    await gotoLocked(page, `/app/items/${ITEM.id}`, 'light');
    await unlockFromBanner(page);

    await expect(page).toHaveURL(new RegExp(`/app/items/${ITEM.id}$`), { timeout: UI_WAIT_MS });
    await expect(page.getByTestId('entry-body')).toHaveCount(ENTRIES.length, { timeout: UI_WAIT_MS });

    // Open the Import JSON dialog from the item page action bar
    const importBtn = page.getByTestId('btn-import-json');
    await expect(importBtn).toBeVisible({ timeout: UI_WAIT_MS });
    await importBtn.click();

    const dialog = page.getByTestId('import-json-dialog');
    await expect(dialog).toBeVisible({ timeout: UI_WAIT_MS });

    const textarea = dialog.getByTestId('import-json-source-textarea');
    await expect(textarea).toBeEditable({ timeout: UI_WAIT_MS });
    await textarea.focus();

    // Write valid JSON containing `a\r\nb` CRLF line breaks to the real Chromium clipboard
    const clipboardCrlfJson = '{\r\n  "line": "a\\r\\nb",\r\n  "port": 5432\r\n}';
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, clipboardCrlfJson);

    // Observe the raw `clipboardData.getData('text/plain')` string delivered by Chromium's real paste event
    const pasteObservationPromise = page.evaluate(() => {
      const { promise, resolve } = Promise.withResolvers<{
        readonly rawClipboardData: string;
        readonly crSurvivedInClipboardData: boolean;
      }>();
      const el = document.querySelector('[data-testid="import-json-source-textarea"]');
      el?.addEventListener(
        'paste',
        (ev) => {
          const clipEv = ev as ClipboardEvent;
          const raw = clipEv.clipboardData?.getData('text/plain') ?? '';
          resolve({
            rawClipboardData: raw,
            crSurvivedInClipboardData: raw.includes('\r\n'),
          });
        },
        { once: true, capture: true },
      );
      return promise;
    });

    // Trigger real browser paste via keyboard shortcut
    await page.keyboard.press('ControlOrMeta+V');
    const observation = await pasteObservationPromise;

    // Record whether CR survived in Chromium's paste event into Playwright annotations and CI stdout (plan §2.10 rule 3, Task 17, IP17-R1-6)
    console.log(
      `[T17 chromium paste CR] crSurvivedInClipboardData=${String(observation.crSurvivedInClipboardData)}`,
    );
    testInfo.annotations.push({
      type: 'chromium-paste-cr-observation',
      description: `crSurvivedInClipboardData=${String(observation.crSurvivedInClipboardData)} byteLength=${observation.rawClipboardData.length}`,
    });
    // Verify table preview renders the pasted JSON and submit button is enabled
    await expect(dialog.getByRole('treegrid')).toBeVisible({ timeout: UI_WAIT_MS });
    const submitBtn = dialog.getByTestId('import-json-submit-btn');
    await expect(submitBtn).toBeEnabled({ timeout: UI_WAIT_MS });

    await submitBtn.click();
    await expect(dialog).toBeHidden({ timeout: UI_WAIT_MS });

    // Verify POST /items/{id}/entries/import-json was sent with source="paste" and zero plaintext leak
    expect(capturedImportRequests).toHaveLength(1);
    const sent = JSON.parse(capturedImportRequests[0]!.rawBody) as {
      source: string;
      type: string;
      ciphertext: string;
    };
    expect(sent.type).toBe('json');
    expect(sent.source).toBe('paste');
    expect(typeof sent.ciphertext).toBe('string');
    expect(capturedImportRequests[0]!.url).not.toContain('5432');
    expect(capturedImportRequests[0]!.url).not.toContain('line');
    expect(capturedImportRequests[0]!.rawBody).not.toContain('5432');
    expect(capturedImportRequests[0]!.rawBody).not.toContain('"line"');
    expect(capturedImportRequests[0]!.rawBody).not.toContain('"port"');
  });
});
