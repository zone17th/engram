import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LOCKED_ITEM_FIXTURE, installItemPageContentMocks } from './content-itempage-support';
import {
  STEP_TIMEOUT,
  THEMES,
  UI_WAIT_MS,
  WIDTHS,
  gotoLocked,
  installApiMocks,
  installVisualApiMocks,
  prepare,
  unlockFromBanner,
  type Theme,
  type ViewportWidth,
} from './vault-locked-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

/**
 * P04-T16 U13 unlocked JSON card visual captures (Advisor msg_ef31bfd2c663):
 * CI evidence only, picked up by `scripts/sanitize-e2e-artifacts.mjs` into the
 * `playwright-results-content-verify-true` artifact for Tester visual comparison against
 * `mockups/item.html` U13.
 *
 * Uses only the seeded test-vector fixture `e2e/fixtures/locked-item-entries.json` (never real
 * secrets, no crypto calls in the spec). Unlocks via the locked banner, then captures:
 *   - Table tab (`content-item-json-table-{light,dark}-{390,1440}.png`)
 *   - Raw JSON tab (`content-item-json-raw-{light,dark}-{390,1440}.png`)
 *   - Invalid-JSON error state (`content-item-json-error-{light,dark}-{390,1440}.png`)
 */
const ITEM = LOCKED_ITEM_FIXTURE.item;
const ENTRIES = LOCKED_ITEM_FIXTURE.entries;
const JSON_RECORD = ENTRIES.find((entry) => entry.meta.type === 'json')!;

type JsonVisualState = 'table' | 'raw' | 'error';

/**
 * Writes a value into a `<textarea>` without the string appearing in Playwright's `fill()` call logs.
 */
async function setTextareaValue(locator: Locator, value: string): Promise<void> {
  await expect(locator).toBeEditable({ timeout: UI_WAIT_MS });
  await locator.evaluate((element, nextValue) => {
    const field = element as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) {
      throw new Error('HTMLTextAreaElement value setter is missing');
    }
    setter.call(field, nextValue);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function captureContentItemJson(
  page: Page,
  testInfo: TestInfo,
  state: JsonVisualState,
  theme: Theme,
  width: ViewportWidth,
): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;}',
  });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    return promise;
  });
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

  const outputPath = testInfo.outputPath(`content-item-json-${state}-${theme}-${width}.png`);
  mkdirSync(dirname(outputPath), { recursive: true });
  const buffer = await page.screenshot({
    path: outputPath,
    timeout: STEP_TIMEOUT,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
  expect(buffer.byteLength).toBeGreaterThan(0);
}

test.describe('P04-T16 Unlocked JSON card U13 visual captures (CI artifacts only)', () => {
  for (const theme of THEMES) {
    for (const viewport of WIDTHS) {
      const label = `${theme}-${viewport.width}`;

      test(`unlocked JSON card table, raw, and error (${label})`, async ({ context, page }, testInfo) => {
        test.setTimeout(180_000);

        // `installApiMocks` registers `GET /api/v1/vault` with the test-vector envelope;
        // `installVisualApiMocks` layers theme-specific `/api/v1/auth/me` and cookies on top;
        // `installItemPageContentMocks` layers the item & entry endpoints on top.
        await installApiMocks(context);
        await installVisualApiMocks(context, theme);
        await installItemPageContentMocks(context);

        await prepare(page, theme, viewport.width, viewport.height);
        await gotoLocked(page, `/app/items/${ITEM.id}`, theme);

        await unlockFromBanner(page);
        await expect(page).toHaveURL(new RegExp(`/app/items/${ITEM.id}$`), { timeout: UI_WAIT_MS });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: STEP_TIMEOUT });
        await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: STEP_TIMEOUT });
        await expect(page.getByTestId('entry-body-locked')).toHaveCount(0, { timeout: UI_WAIT_MS });
        await expect(page.getByTestId('entry-body')).toHaveCount(ENTRIES.length, { timeout: UI_WAIT_MS });

        const jsonEntryId = JSON_RECORD.meta.id;
        const card = page.getByTestId(`entry-card-${jsonEntryId}`);
        const tableTab = card.getByTestId(`json-tab-table-${jsonEntryId}`);
        const rawTab = card.getByTestId(`json-tab-raw-${jsonEntryId}`);

        // 1. Table tab capture
        await expect(card).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(tableTab).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(rawTab).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(tableTab).toHaveAttribute('aria-pressed', 'true');
        await expect(card.getByTestId(`json-table-host-${jsonEntryId}`)).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(card.getByTestId('json-cell-btn-root.p0')).toHaveText('postgres-prod', {
          timeout: UI_WAIT_MS,
        });
        await expect(card.getByTestId('json-cell-btn-root.p1')).toHaveText('5432', { timeout: UI_WAIT_MS });
        await expect(card.getByTestId('json-cell-btn-root.p2')).toHaveText('9007199254740993', {
          timeout: UI_WAIT_MS,
        });

        await captureContentItemJson(page, testInfo, 'table', theme, viewport.width);

        // 2. Raw JSON tab capture
        await rawTab.click();
        await expect(rawTab).toHaveAttribute('aria-pressed', 'true');
        const rawPanel = card.getByTestId(`json-raw-panel-${jsonEntryId}`);
        const rawTextarea = card.getByTestId(`json-raw-textarea-${jsonEntryId}`);
        await expect(rawPanel).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(rawTextarea).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(rawTextarea).toHaveValue(JSON_RECORD.plaintext, { timeout: UI_WAIT_MS });
        await expect(card.getByTestId(`json-raw-format-btn-${jsonEntryId}`)).toBeEnabled();
        await expect(card.getByTestId(`json-raw-save-btn-${jsonEntryId}`)).toBeEnabled();
        await expect(card.getByTestId(`json-raw-error-${jsonEntryId}`)).toHaveCount(0);

        await captureContentItemJson(page, testInfo, 'raw', theme, viewport.width);

        // 3. Invalid-JSON error state capture (type invalid JSON in Raw, wait for the line/col error box)
        await setTextareaValue(rawTextarea, '{"service": "postgres-prod",}');
        const errorBox = card.getByTestId(`json-raw-error-${jsonEntryId}`);
        await expect(errorBox).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(errorBox).toContainText(/Line 1, column 29:/);
        await expect(errorBox).toContainText(/trailing comma is not allowed in RFC 8259 JSON/i);
        await expect(card.getByTestId(`json-raw-goto-btn-${jsonEntryId}`)).toBeVisible();
        await expect(card.getByTestId(`json-raw-save-btn-${jsonEntryId}`)).toBeDisabled();
        await expect(card.getByTestId(`json-raw-format-btn-${jsonEntryId}`)).toBeDisabled();

        await captureContentItemJson(page, testInfo, 'error', theme, viewport.width);
      });
    }
  }
});
