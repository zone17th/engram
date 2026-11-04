import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Entry, EntryMeta, ItemSummary } from '../lib/api/content';
import {
  LOCKED_ITEM_FIXTURE,
  installItemPageContentMocks,
  type LockedItemEntriesFixture,
} from './content-itempage-support';
import {
  STEP_TIMEOUT,
  THEMES,
  UI_WAIT_MS,
  gotoLocked,
  installApiMocks,
  prepare,
  unlockFromBanner,
  type Theme,
} from './vault-locked-support';

// Disable Playwright's automatic error-context DOM snapshot in this worker before any test runs.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

/**
 * P05-entryux Stage T visual & behaviour regression specs (advisor-dec-370, dec-371, dec-373):
 *
 * 1. Visual captures at 390 / 768 / 1440 x light / dark (`content-entry-<state>-<theme>-<width>.png`),
 *    picked up by `scripts/sanitize-e2e-artifacts.mjs` into the `playwright-results-content-verify-true`
 *    CI artifact and attached via `testInfo.attach`:
 *    - `empty-kv`: newly opened KV entry editor with 1 placeholder row
 *    - `filled-rows`: 3 filled rows (string, number via type chip, nested object)
 *    - `validation-error`: inline row validation errors + footer error count summary
 *    - `raw-json`: JSON gốc (`Raw JSON`) tab with Format & byte counter
 *    - `array-root`: root switched to Array (`[]`) with indexed items
 *    - `multiline-value`: multi-line string value (>3 lines) clamped with expand toggle
 *    - `import-dialog`: Import JSON dialog with valid JSON table preview
 *    - `saved-json-card`: saved JSON entry card in Table view
 *    - `locked-state`: locked item page with locked banner and masked entry cards
 *    Deterministic: freezes animations/transitions/caret, masks timestamps & secret-bearing nodes,
 *    scrolls to top, waits two rAFs, and asserts two consecutive captures of each state are byte-equal
 *    (`Buffer.compare(shot1, shot2) === 0`). No OS-specific `toHaveScreenshot` baselines are committed.
 *
 * 2. No-horizontal-overflow (`document.documentElement.scrollWidth <= window.innerWidth`) at
 *    390 / 768 / 1250 / 1440, including a 200-rune item name and long key/value tokens.
 *
 * 3. End-to-end behaviour cases:
 *    - Add 3 pairs including a number (via type chip) and a nested object -> Save -> reopen -> exact JSON
 *    - Keyboard-only flow (`Tab`, `Enter`, `Shift+Enter`, `Alt+ArrowDown`, `Escape`, `Ctrl+S`)
 *    - Paste `key: value` lines (including URL `https://a.b:8080/x` and time `12:30:45` values split only
 *      at the first `: `) into an empty Key input -> populates rows with verbatim values
 *    - Paste multi-line PEM block into a Value input -> stays in that single value -> Save -> reopen
 *      byte-exact; `Enter` still moves to the next row
 *    - Root `Array -> Object` conversion with committed items prompts inline confirmation and flags
 *      empty keys with `EMPTY_KEY` validation (`RFD-20`, `L2`) before allowing Save
 *    - Saved JSON card (`dec-370`): `+ Add field` with string and number values in one step persisted
 *      and reopened byte-exact
 */

const ITEM = LOCKED_ITEM_FIXTURE.item;
const ENTRIES = LOCKED_ITEM_FIXTURE.entries;
const JSON_RECORD = ENTRIES.find((entry) => entry.meta.type === 'json')!;

const ENTRY_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

const OVERFLOW_WIDTHS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1250, height: 900 },
  { width: 1440, height: 900 },
] as const;

type EntryVisualWidth = (typeof ENTRY_VIEWPORTS)[number]['width'];

type EntryVisualState =
  | 'empty-kv'
  | 'filled-rows'
  | 'validation-error'
  | 'raw-json'
  | 'array-root'
  | 'multiline-value'
  | 'import-dialog'
  | 'saved-json-card'
  | 'locked-state';

const MASK_SELECTORS = [
  '[data-testid="item-meta-summary"]',
  '[data-visual-mask]',
  'p[data-testid="entry-body"]',
  'pre[data-testid="entry-body"]',
  'textarea[data-vault-secret]',
  'input[data-vault-secret]',
  '[data-testid^="json-cell-btn-"]',
  '[data-testid^="json-cell-input-"]',
  '[data-testid^="json-readonly-cell-"]',
  '[data-testid^="json-raw-textarea-"]',
  '[data-testid="import-json-preview-raw"]',
  '[data-testid="import-json-source-textarea"]',
  '[data-testid="json-table-host-import-preview"] [role="gridcell"]',
  '[data-testid="json-table-host-import-preview"] td',
] as const;

function buildMaskAndFreezeCss(): string {
  const transparentTextSelectors = MASK_SELECTORS.flatMap((sel) => [sel, `${sel} *`]).join(',\n');
  return `
*,*::before,*::after {
  animation: none !important;
  transition: none !important;
  caret-color: transparent !important;
}
.toast, [data-testid="undo-toast-stack"] {
  display: none !important;
}
${transparentTextSelectors} {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
  caret-color: transparent !important;
}
`;
}

async function applyThemeMocks(context: BrowserContext, theme: Theme): Promise<void> {
  const origin = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3000').origin;
  await context.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
  await context.addCookies([
    { name: 'sabk_locale', value: 'en', url: `${origin}/` },
    { name: 'sabk_theme', value: theme, url: `${origin}/` },
    { name: 'sabk_csrf', value: 'test-csrf-token', url: `${origin}/` },
  ]);

  await context.route('**/api/v1/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'vault-locked@example.test',
          email_verified: true,
          created_at: '2026-10-30T00:00:00Z',
        },
        settings: { locale: 'en', theme, auto_lock_minutes: 15, semantic_suggest: false },
        identities: [{ provider: 'password', linked_at: '2026-10-30T00:00:00Z' }],
        features: {
          semantic_available: false,
          email_verification_required: false,
          oauth_providers: [],
          oauth_reauth_providers: [],
          password_enrollment_available: false,
          captcha_site_key: null,
        },
        vault: { status: 'present' },
      }),
    });
  });
}

interface StatefulContentMockController {
  readonly getEntriesMeta: () => readonly EntryMeta[];
  readonly getEntryById: (id: string) => Entry | undefined;
}

/**
 * Installs stateful content mocks on top of `installApiMocks` so `POST /api/v1/items/{id}/entries`
 * and `PUT /api/v1/entries/{id}` persist encrypted envelopes in memory across page reloads and
 * re-unlocks during the test.
 */
async function installStatefulItemPageMocks(
  context: BrowserContext,
  initialFixture: LockedItemEntriesFixture = LOCKED_ITEM_FIXTURE,
): Promise<StatefulContentMockController> {
  await installItemPageContentMocks(context, initialFixture);

  let currentItem: ItemSummary = { ...initialFixture.item };
  const entryById = new Map<string, Entry>(
    initialFixture.entries.map((record) => [record.entry.id, record.entry]),
  );
  const metaList: EntryMeta[] = initialFixture.entries.map((record) => ({ ...record.meta }));
  let nextCreatedIdx = 1;

  await context.route(`**/api/v1/items/${currentItem.id}`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...currentItem,
          entry_count: metaList.length,
        }),
      });
      return;
    }
    if (request.method() === 'PATCH') {
      const patch = JSON.parse(request.postData() ?? '{}') as {
        name?: string;
        hint?: string | null;
      };
      currentItem = {
        ...currentItem,
        name: patch.name ?? currentItem.name,
        hint: patch.hint !== undefined ? patch.hint : currentItem.hint,
        version: currentItem.version + 1,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(currentItem),
      });
      return;
    }
    await route.fallback();
  });

  await context.route(`**/api/v1/items/${currentItem.id}/entries*`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: metaList,
          next_cursor: null,
        }),
      });
      return;
    }
    if (request.method() === 'POST') {
      const payload = JSON.parse(request.postData() ?? '{}') as {
        id?: string;
        type: 'text' | 'json';
        plaintext_len_bucket: number;
        envelope: Entry['envelope'];
        ciphertext: string;
      };
      const newId =
        payload.id ??
        `99999999-9999-4999-8999-${String(nextCreatedIdx++).padStart(12, '0')}`;
      const nowIso = '2026-11-01T00:00:00Z';
      const createdMeta: EntryMeta = {
        id: newId,
        item_id: currentItem.id,
        type: payload.type,
        position: metaList.length,
        version: 1,
        plaintext_len_bucket: payload.plaintext_len_bucket,
        created_at: nowIso,
        updated_at: nowIso,
      };
      const createdEntry: Entry = {
        ...createdMeta,
        envelope: payload.envelope,
        ciphertext: payload.ciphertext,
      };
      metaList.push(createdMeta);
      entryById.set(newId, createdEntry);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(createdMeta),
      });
      return;
    }
    await route.fallback();
  });

  await context.route('**/api/v1/entries/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const entryId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    if (request.method() === 'GET') {
      const found = entryById.get(entryId);
      if (found) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(found),
        });
        return;
      }
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://engram.zone17.click/problems/not_found',
          title: 'not_found',
          status: 404,
          code: 'not_found',
        }),
      });
      return;
    }
    if (request.method() === 'PUT') {
      const existing = entryById.get(entryId);
      if (!existing) {
        await route.fulfill({ status: 404 });
        return;
      }
      const payload = JSON.parse(request.postData() ?? '{}') as {
        plaintext_len_bucket: number;
        envelope: Entry['envelope'];
        ciphertext: string;
      };
      const nextVersion = existing.version + 1;
      const updatedMeta: EntryMeta = {
        id: existing.id,
        item_id: existing.item_id,
        type: existing.type,
        position: existing.position,
        version: nextVersion,
        plaintext_len_bucket: payload.plaintext_len_bucket,
        created_at: existing.created_at,
        updated_at: '2026-11-01T00:00:00Z',
      };
      const updatedEntry: Entry = {
        ...updatedMeta,
        envelope: payload.envelope,
        ciphertext: payload.ciphertext,
      };
      entryById.set(entryId, updatedEntry);
      const idx = metaList.findIndex((m) => m.id === entryId);
      if (idx !== -1) {
        metaList[idx] = updatedMeta;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(updatedMeta),
      });
      return;
    }
    await route.fallback();
  });

  return {
    getEntriesMeta: () => metaList,
    getEntryById: (id: string) => entryById.get(id),
  };
}

/**
 * Writes a value into an `<input>` or `<textarea>` without the string appearing in Playwright's `fill()` call logs.
 */
async function setFieldValue(locator: Locator, value: string): Promise<void> {
  await expect(locator).toBeEditable({ timeout: UI_WAIT_MS });
  await locator.evaluate((element, nextValue) => {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (!setter) {
      throw new Error('Value setter is missing on target element');
    }
    setter.call(element, nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/**
 * Dispatches a synthetic `ClipboardEvent('paste')` with `text/plain` payload on `locator`.
 * If `defaultPrevented` is false (verbatim browser paste), writes the value into the control.
 */
async function dispatchPlainTextPaste(locator: Locator, text: string): Promise<boolean> {
  await expect(locator).toBeEditable({ timeout: UI_WAIT_MS });
  return locator.evaluate((element, pastedText) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', pastedText);
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    const notCancelled = element.dispatchEvent(pasteEvent);
    if (notCancelled) {
      const proto =
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(element, pastedText);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return !notCancelled;
  }, text);
}

/**
 * Freezes animations/transitions/caret, masks timestamps and secret-bearing elements, asserts
 * no horizontal overflow (`scrollWidth <= innerWidth`), takes two consecutive screenshots,
 * asserts they are byte-identical (`Buffer.compare(shot1, shot2) === 0`), writes to `outputPath`,
 * and attaches the PNG to `testInfo`.
 */
async function captureDeterministicEntryState(
  page: Page,
  testInfo: TestInfo,
  state: EntryVisualState,
  theme: Theme,
  width: EntryVisualWidth,
): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  // Blur any active element so focus rings/carets are deterministic, and tag non-empty inputs for masking
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    for (const input of Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
    )) {
      if (input instanceof HTMLInputElement && (input.type === 'checkbox' || input.type === 'radio' || input.type === 'hidden')) {
        continue;
      }
      if (input.value !== '' || input.hasAttribute('data-vault-secret')) {
        input.setAttribute('data-visual-mask', 'true');
      } else {
        input.removeAttribute('data-visual-mask');
      }
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });

  await page.evaluate(() => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    return promise;
  });

  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    scrollWidth,
    `no horizontal overflow in state ${state} (${theme}, ${width}px)`,
  ).toBeLessThanOrEqual(innerWidth);

  const fileName = `content-entry-${state}-${theme}-${width}.png`;
  const outputPath = testInfo.outputPath(fileName);
  mkdirSync(dirname(outputPath), { recursive: true });

  const maskLocators = MASK_SELECTORS.map((sel) => page.locator(sel));
  const styleCss = buildMaskAndFreezeCss();

  const shot1 = await page.screenshot({
    path: outputPath,
    timeout: STEP_TIMEOUT,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    style: styleCss,
    mask: maskLocators,
  });

  const shot2 = await page.screenshot({
    timeout: STEP_TIMEOUT,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
    style: styleCss,
    mask: maskLocators,
  });

  expect(shot1.byteLength).toBeGreaterThan(0);
  expect(
    Buffer.compare(shot1, shot2),
    `consecutive captures of ${fileName} must be byte-equal`,
  ).toBe(0);

  await testInfo.attach(fileName, {
    body: shot1,
    contentType: 'image/png',
  });
}

test.describe('P05-entryux Stage T visual captures (390/768/1440 x light/dark, byte-equal determinism)', () => {
  for (const theme of THEMES) {
    for (const viewport of ENTRY_VIEWPORTS) {
      const label = `${theme}-${viewport.width}`;

      test(`captures all 9 entry editor & item page visual states deterministically (${label})`, async ({
        context,
        page,
      }, testInfo) => {
        test.setTimeout(180_000);

        await installApiMocks(context);
        await applyThemeMocks(context, theme);
        await installItemPageContentMocks(context);

        await prepare(page, theme, viewport.width as 390 | 1440, viewport.height);
        await gotoLocked(page, `/app/items/${ITEM.id}`, theme);

        // 1. State `locked-state`: locked item page before unlocking
        await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(page.getByTestId('entry-body-locked')).toHaveCount(ENTRIES.length, {
          timeout: UI_WAIT_MS,
        });
        await captureDeterministicEntryState(page, testInfo, 'locked-state', theme, viewport.width);

        // Unlock vault via banner
        await unlockFromBanner(page);
        await expect(page).toHaveURL(new RegExp(`/app/items/${ITEM.id}$`), { timeout: UI_WAIT_MS });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme, {
          timeout: STEP_TIMEOUT,
        });
        await expect(page.getByTestId('entry-body-locked')).toHaveCount(0, { timeout: UI_WAIT_MS });
        await expect(page.getByTestId('entry-body')).toHaveCount(ENTRIES.length, {
          timeout: UI_WAIT_MS,
        });

        const jsonEntryId = JSON_RECORD.meta.id;
        const savedCard = page.getByTestId(`entry-card-${jsonEntryId}`);
        await expect(savedCard).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(savedCard.getByTestId(`json-table-host-${jsonEntryId}`)).toBeVisible({
          timeout: UI_WAIT_MS,
        });

        // 2. State `saved-json-card`: saved JSON entry card in Table view
        await captureDeterministicEntryState(
          page,
          testInfo,
          'saved-json-card',
          theme,
          viewport.width,
        );

        // 3. State `empty-kv`: click `+ JSON / table` (`btn-add-json`) -> opens KV editor with 1 placeholder row
        const addJsonBtn = page.getByTestId('btn-add-json');
        await addJsonBtn.click();
        const composer = page.getByTestId('new-json-entry-composer');
        await expect(composer).toBeVisible({ timeout: UI_WAIT_MS });
        await expect(composer.getByTestId('json-table-host-new-json')).toBeVisible({
          timeout: UI_WAIT_MS,
        });
        await expect(composer.getByTestId('new-json-save-btn')).toBeDisabled();
        await captureDeterministicEntryState(page, testInfo, 'empty-kv', theme, viewport.width);

        // 4. State `filled-rows`: 3 filled rows (string, number via type chip, nested object)
        const row1Key = composer.getByTestId('json-new-key-input-root');
        const row1Val = composer.getByTestId('json-new-val-input-root');
        await setFieldValue(row1Key, 'service');
        await setFieldValue(row1Val, 'api-gateway');

        // Add row 2 (number via type chip)
        await composer.getByTestId('json-open-add-field-root').click();
        const keyInputsAfter2 = composer.locator('[data-kv-key-input]');
        await expect(keyInputsAfter2).toHaveCount(2, { timeout: UI_WAIT_MS });
        const row2Id = (await keyInputsAfter2.nth(1).getAttribute('data-kv-key-input'))!;
        await setFieldValue(keyInputsAfter2.nth(1), 'port');
        await composer.getByTestId(`kv-type-chip-${row2Id}`).click();
        await composer.getByTestId(`kv-pick-type-${row2Id}-number`).click();
        await setFieldValue(composer.getByTestId(`kv-val-input-${row2Id}`), '8443');

        // Add row 3 (nested object with 1 child field)
        await composer.getByTestId('json-open-add-field-root').click();
        const keyInputsAfter3 = composer.locator('[data-kv-key-input]');
        await expect(keyInputsAfter3).toHaveCount(3, { timeout: UI_WAIT_MS });
        const row3Id = (await keyInputsAfter3.nth(2).getAttribute('data-kv-key-input'))!;
        await setFieldValue(keyInputsAfter3.nth(2), 'tls');
        await composer.getByTestId(`kv-type-chip-${row3Id}`).click();
        await composer.getByTestId(`kv-pick-type-${row3Id}-object`).click();

        const nestGroup = composer.getByTestId(`kv-nest-${row3Id}`);
        await expect(nestGroup).toBeVisible({ timeout: UI_WAIT_MS });
        const childKeyInput = nestGroup.locator('[data-kv-key-input]').first();
        const childValInput = nestGroup.locator('[data-kv-val-input]').first();
        await setFieldValue(childKeyInput, 'mode');
        await setFieldValue(childValInput, 'strict');
        await expect(composer.getByTestId('new-json-save-btn')).toBeEnabled();

        await captureDeterministicEntryState(page, testInfo, 'filled-rows', theme, viewport.width);

        // 5. State `raw-json`: switch to `JSON gốc` (`Raw JSON`) tab
        await composer.getByTestId('new-json-tab-raw').click();
        const rawTextarea = composer.getByTestId('json-raw-textarea-new-json');
        await expect(rawTextarea).toBeVisible({ timeout: UI_WAIT_MS });
        await captureDeterministicEntryState(page, testInfo, 'raw-json', theme, viewport.width);

        // Return to Table tab
        await composer.getByTestId('new-json-tab-table').click();
        await expect(composer.getByTestId('json-table-host-new-json')).toBeVisible({
          timeout: UI_WAIT_MS,
        });

        // 6. State `multiline-value`: multi-line string value (>3 lines) clamped with expand toggle
        await setFieldValue(
          row1Val,
          '-----BEGIN PUBLIC TOKEN-----\nline-2-payload-alpha\nline-3-payload-beta\nline-4-payload-gamma\n-----END PUBLIC TOKEN-----',
        );
        const row1Id = (await row1Key.getAttribute('data-kv-key-input'))!;
        await expect(composer.getByTestId(`kv-multiline-toggle-${row1Id}`)).toBeVisible({
          timeout: UI_WAIT_MS,
        });
        await captureDeterministicEntryState(
          page,
          testInfo,
          'multiline-value',
          theme,
          viewport.width,
        );

        // 7. State `validation-error`: duplicate key + invalid RFC 8259 number (`036`)
        await setFieldValue(keyInputsAfter2.nth(1), 'service');
        await setFieldValue(composer.getByTestId(`kv-val-input-${row2Id}`), '036');
        await expect(composer.getByTestId(`kv-err-key-${row2Id}`)).toBeVisible({
          timeout: UI_WAIT_MS,
        });
        await expect(composer.getByTestId(`kv-err-val-${row2Id}`)).toBeVisible({
          timeout: UI_WAIT_MS,
        });
        await expect(composer.getByTestId('new-json-save-btn')).toBeDisabled();
        await captureDeterministicEntryState(
          page,
          testInfo,
          'validation-error',
          theme,
          viewport.width,
        );

        // 8. State `array-root`: switch root to Array (`[]`) and confirm inline prompt
        await composer.getByTestId('new-json-root-menu-btn').click();
        await composer.getByTestId('new-json-preset-array').click();
        const inlinePrompt = composer.getByTestId('new-json-inline-prompt');
        await expect(inlinePrompt).toBeVisible({ timeout: UI_WAIT_MS });
        await composer.getByTestId('new-json-prompt-confirm').click();
        await expect(inlinePrompt).toBeHidden({ timeout: UI_WAIT_MS });
        await setFieldValue(composer.getByTestId(`kv-val-input-${row2Id}`), '8443');
        await captureDeterministicEntryState(page, testInfo, 'array-root', theme, viewport.width);

        // Discard composer cleanly
        await composer.getByTestId('new-json-cancel-btn').click();
        await expect(composer.getByTestId('new-json-discard-confirm')).toBeVisible({
          timeout: UI_WAIT_MS,
        });
        await composer.getByTestId('new-json-discard-btn').click();
        await expect(composer).toBeHidden({ timeout: UI_WAIT_MS });

        // 9. State `import-dialog`: open Import JSON dialog with valid JSON preview
        await page.getByTestId('btn-import-json').click();
        const importDialog = page.getByTestId('import-json-dialog');
        await expect(importDialog).toBeVisible({ timeout: UI_WAIT_MS });
        await setFieldValue(
          importDialog.getByTestId('import-json-source-textarea'),
          '{"ssid":"Demo","vlan":10}',
        );
        await expect(importDialog.getByTestId('json-table-host-import-preview')).toBeVisible({
          timeout: UI_WAIT_MS,
        });
        await captureDeterministicEntryState(
          page,
          testInfo,
          'import-dialog',
          theme,
          viewport.width,
        );
      });
    }
  }
});

test.describe('P05-entryux Stage T item page no-horizontal-overflow at 390/768/1250/1440 & E2E behaviour cases', () => {
  test('item page has no horizontal overflow at 390/768/1250/1440 with a 200-rune item name and long keys/values', async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);

    const longItemName200 = `${' very-long-item-title-segment-without-overflow-'.repeat(4)}end200`
      .trim()
      .padEnd(200, 'x')
      .slice(0, 200);
    expect(Array.from(longItemName200).length).toBe(200);

    const longFixture: LockedItemEntriesFixture = {
      item: {
        ...ITEM,
        name: longItemName200,
      },
      entries: ENTRIES,
    };

    await installApiMocks(context);
    await applyThemeMocks(context, 'light');
    await installItemPageContentMocks(context, longFixture);

    await prepare(page, 'light', 1440, 900);
    await gotoLocked(page, `/app/items/${ITEM.id}`, 'light');
    await unlockFromBanner(page);
    await expect(page).toHaveURL(new RegExp(`/app/items/${ITEM.id}$`), { timeout: UI_WAIT_MS });

    // Open KV composer and enter a very long unbroken key and value plus a deep nested object
    await page.getByTestId('btn-add-json').click();
    const composer = page.getByTestId('new-json-entry-composer');
    await expect(composer).toBeVisible({ timeout: UI_WAIT_MS });

    const longKey = `very_long_configuration_key_${'segment_'.repeat(12)}tail`;
    const longVal = `https://gateway.internal.example.test:8443/v1/clusters/${'node-segment-'.repeat(10)}status`;
    await setFieldValue(composer.getByTestId('json-new-key-input-root'), longKey);
    await setFieldValue(composer.getByTestId('json-new-val-input-root'), longVal);

    await composer.getByTestId('json-open-add-field-root').click();
    const keyInputs = composer.locator('[data-kv-key-input]');
    await expect(keyInputs).toHaveCount(2, { timeout: UI_WAIT_MS });
    const row2Id = (await keyInputs.nth(1).getAttribute('data-kv-key-input'))!;
    await setFieldValue(keyInputs.nth(1), `nested_container_${'deep_'.repeat(10)}key`);
    await composer.getByTestId(`kv-type-chip-${row2Id}`).click();
    await composer.getByTestId(`kv-pick-type-${row2Id}-object`).click();

    for (const vp of OVERFLOW_WIDTHS) {
      await page.setViewportSize(vp);
      await page.evaluate(() => {
        const { promise, resolve } = Promise.withResolvers<void>();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        return promise;
      });
      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        metrics.scrollWidth,
        `document.documentElement.scrollWidth (${metrics.scrollWidth}) <= innerWidth (${metrics.innerWidth}) at ${vp.width}px`,
      ).toBeLessThanOrEqual(metrics.innerWidth);
    }
  });

  test('behaviour: add 3 pairs (string, number via type chip, nested object) -> save -> reopen -> exact JSON, plus dec-370 saved card add field with string and number values', async ({
    context,
    page,
  }) => {
    test.setTimeout(150_000);

    await installApiMocks(context);
    await applyThemeMocks(context, 'light');
    const mockCtrl = await installStatefulItemPageMocks(context);

    await prepare(page, 'light', 1440, 900);
    await gotoLocked(page, `/app/items/${ITEM.id}`, 'light');
    await unlockFromBanner(page);
    await expect(page).toHaveURL(new RegExp(`/app/items/${ITEM.id}$`), { timeout: UI_WAIT_MS });

    // 1. Create a new JSON entry with 3 pairs: string, number (via type chip), and nested object
    await page.getByTestId('btn-add-json').click();
    const composer = page.getByTestId('new-json-entry-composer');
    await expect(composer).toBeVisible({ timeout: UI_WAIT_MS });

    // Pair 1: string ("env": "staging")
    await setFieldValue(composer.getByTestId('json-new-key-input-root'), 'env');
    await setFieldValue(composer.getByTestId('json-new-val-input-root'), 'staging');

    // Pair 2: number via type chip ("retries": 5)
    await composer.getByTestId('json-open-add-field-root').click();
    const rootKeys2 = composer.locator('[data-kv-key-input]');
    await expect(rootKeys2).toHaveCount(2, { timeout: UI_WAIT_MS });
    const row2Id = (await rootKeys2.nth(1).getAttribute('data-kv-key-input'))!;
    await setFieldValue(rootKeys2.nth(1), 'retries');
    await composer.getByTestId(`kv-type-chip-${row2Id}`).click();
    await composer.getByTestId(`kv-pick-type-${row2Id}-number`).click();
    await setFieldValue(composer.getByTestId(`kv-val-input-${row2Id}`), '5');

    // Pair 3: nested object ("db": { "host": "db.internal" })
    await composer.getByTestId('json-open-add-field-root').click();
    const rootKeys3 = composer.locator('[data-kv-key-input]');
    await expect(rootKeys3).toHaveCount(3, { timeout: UI_WAIT_MS });
    const row3Id = (await rootKeys3.nth(2).getAttribute('data-kv-key-input'))!;
    await setFieldValue(rootKeys3.nth(2), 'db');
    await composer.getByTestId(`kv-type-chip-${row3Id}`).click();
    await composer.getByTestId(`kv-pick-type-${row3Id}-object`).click();

    const nest = composer.getByTestId(`kv-nest-${row3Id}`);
    await expect(nest).toBeVisible({ timeout: UI_WAIT_MS });
    await setFieldValue(nest.locator('[data-kv-key-input]').first(), 'host');
    await setFieldValue(nest.locator('[data-kv-val-input]').first(), 'db.internal');

    // Save the new JSON entry
    await composer.getByTestId('new-json-save-btn').click();
    await expect(composer).toBeHidden({ timeout: UI_WAIT_MS });

    const allMetas = mockCtrl.getEntriesMeta();
    expect(allMetas.length).toBe(ENTRIES.length + 1);
    const createdEntryId = allMetas[allMetas.length - 1]!.id;

    // Reload page -> unlock -> reopen created card and verify exact JSON
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
    await unlockFromBanner(page);

    const createdCard = page.getByTestId(`entry-card-${createdEntryId}`);
    await expect(createdCard).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(createdCard.getByTestId('json-cell-btn-root.p0')).toHaveText('staging', {
      timeout: UI_WAIT_MS,
    });
    await expect(createdCard.getByTestId('json-cell-btn-root.p1')).toHaveText('5', {
      timeout: UI_WAIT_MS,
    });

    await createdCard.getByTestId(`json-tab-raw-${createdEntryId}`).click();
    const expectedJson3Pairs = JSON.stringify(
      {
        env: 'staging',
        retries: 5,
        db: {
          host: 'db.internal',
        },
      },
      null,
      2,
    );
    await expect(createdCard.getByTestId(`json-raw-textarea-${createdEntryId}`)).toHaveValue(
      expectedJson3Pairs,
      { timeout: UI_WAIT_MS },
    );
    await createdCard.getByTestId(`json-tab-table-${createdEntryId}`).click();

    // 2. dec-370: On the saved JSON card, add a string key/value and a number key/value in one step, save, reopen, and verify persisted JSON
    const tableHost = createdCard.getByTestId(`json-table-host-${createdEntryId}`);
    await tableHost.getByTestId('json-open-add-field-root').click();
    await setFieldValue(tableHost.getByTestId('json-new-key-input-root'), 'region');
    await setFieldValue(tableHost.getByTestId('json-new-val-input-root'), 'ap-southeast-1');
    await tableHost.getByTestId('json-confirm-add-field-root').click();
    await expect(tableHost.getByTestId('json-cell-btn-root.p3')).toHaveText('ap-southeast-1', {
      timeout: UI_WAIT_MS,
    });

    await tableHost.getByTestId('json-open-add-field-root').click();
    await setFieldValue(tableHost.getByTestId('json-new-key-input-root'), 'timeout_ms');
    await tableHost.getByTestId('json-new-type-select-root').selectOption('number');
    await setFieldValue(tableHost.getByTestId('json-new-val-input-root'), '1500');
    await tableHost.getByTestId('json-confirm-add-field-root').click();
    await expect(tableHost.getByTestId('json-cell-btn-root.p4')).toHaveText('1500', {
      timeout: UI_WAIT_MS,
    });

    await createdCard.getByTestId(`entry-save-btn-${createdEntryId}`).click();
    await expect(createdCard.getByTestId('entry-saved-badge')).toBeVisible({ timeout: UI_WAIT_MS });

    // Reopen via reload + unlock and verify exact persisted JSON
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
    await unlockFromBanner(page);

    const reopenedCard = page.getByTestId(`entry-card-${createdEntryId}`);
    await reopenedCard.getByTestId(`json-tab-raw-${createdEntryId}`).click();
    const expectedAfterDec370 = JSON.stringify(
      {
        env: 'staging',
        retries: 5,
        db: {
          host: 'db.internal',
        },
        region: 'ap-southeast-1',
        timeout_ms: 1500,
      },
      null,
      2,
    );
    await expect(reopenedCard.getByTestId(`json-raw-textarea-${createdEntryId}`)).toHaveValue(
      expectedAfterDec370,
      { timeout: UI_WAIT_MS },
    );
  });

  test('behaviour: keyboard-only flow (Tab, Enter, Shift+Enter, Alt+ArrowDown, Escape, Ctrl+S)', async ({
    context,
    page,
  }) => {
    test.setTimeout(150_000);

    await installApiMocks(context);
    await applyThemeMocks(context, 'light');
    const mockCtrl = await installStatefulItemPageMocks(context);

    await prepare(page, 'light', 1440, 900);
    await gotoLocked(page, `/app/items/${ITEM.id}`, 'light');
    await unlockFromBanner(page);
    await expect(page).toHaveURL(new RegExp(`/app/items/${ITEM.id}$`), { timeout: UI_WAIT_MS });

    // Open composer -> initial focus is inside first Key input
    await page.getByTestId('btn-add-json').click();
    const composer = page.getByTestId('new-json-entry-composer');
    await expect(composer).toBeVisible({ timeout: UI_WAIT_MS });

    const row1Key = composer.getByTestId('json-new-key-input-root');
    const row1Val = composer.getByTestId('json-new-val-input-root');
    const row1Type = composer.getByTestId('json-new-type-select-root');
    const row1Id = (await row1Key.getAttribute('data-kv-key-input'))!;
    const row1Menu = composer.getByTestId(`kv-row-menu-btn-${row1Id}`);

    await expect(row1Key).toBeFocused();

    // 1. Native Tab traversal: Key -> Value -> Type chip -> Row menu
    await page.keyboard.press('Tab');
    await expect(row1Val).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(row1Type).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(row1Menu).toBeFocused();

    // Shift+Tab returns to Value, then Key
    await page.keyboard.press('Shift+Tab');
    await expect(row1Type).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(row1Val).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(row1Key).toBeFocused();

    // 2. Type key in row 1, press Enter -> moves focus to row 1 Value
    await setFieldValue(row1Key, 'notes');
    await page.keyboard.press('Enter');
    await expect(row1Val).toBeFocused();

    // 3. Shift+Enter in string Value textarea inserts a newline (`\n`) without creating a new row
    await page.keyboard.type('first-line');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second-line');
    await expect(row1Val).toHaveValue('first-line\nsecond-line');
    await expect(composer.locator('[data-kv-row]')).toHaveCount(1);

    // 4. Plain Enter on the last row's Value appends row 2 and focuses row 2's Key input
    await page.keyboard.press('Enter');
    const keyInputs = composer.locator('[data-kv-key-input]');
    await expect(keyInputs).toHaveCount(2, { timeout: UI_WAIT_MS });
    const row2Key = keyInputs.nth(1);
    const row2Id = (await row2Key.getAttribute('data-kv-key-input'))!;
    await expect(row2Key).toBeFocused();

    // 5. Alt+ArrowDown opens the row's Type menu; Escape closes the menu and restores focus to the Type chip;
    //    re-open with Alt+ArrowDown from Key, ArrowDown selects Number, Enter commits type change and focuses Value
    await setFieldValue(row2Key, 'port');
    await page.keyboard.press('Alt+ArrowDown');
    const typeMenu2 = composer.getByTestId(`kv-type-menu-${row2Id}`);
    await expect(typeMenu2).toBeVisible({ timeout: UI_WAIT_MS });
    await page.keyboard.press('Escape');
    await expect(typeMenu2).toBeHidden({ timeout: UI_WAIT_MS });
    await expect(composer.getByTestId(`kv-type-chip-${row2Id}`)).toBeFocused();

    await row2Key.focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(typeMenu2).toBeVisible({ timeout: UI_WAIT_MS });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(typeMenu2).toBeHidden({ timeout: UI_WAIT_MS });
    const row2Val = composer.getByTestId(`kv-val-input-${row2Id}`);
    await expect(row2Val).toBeFocused();
    await setFieldValue(row2Val, '9090');

    // 6. Escape when dirty opens inline discard confirmation; second Escape dismisses the confirmation bar
    await page.keyboard.press('Escape');
    const discardConfirm = composer.getByTestId('new-json-discard-confirm');
    await expect(discardConfirm).toBeVisible({ timeout: UI_WAIT_MS });
    await page.keyboard.press('Escape');
    await expect(discardConfirm).toBeHidden({ timeout: UI_WAIT_MS });

    // 7. Ctrl+S saves the entry
    await row2Val.focus();
    await page.keyboard.press('Control+s');
    await expect(composer).toBeHidden({ timeout: UI_WAIT_MS });

    const allMetas = mockCtrl.getEntriesMeta();
    const savedId = allMetas[allMetas.length - 1]!.id;
    const savedCard = page.getByTestId(`entry-card-${savedId}`);
    await savedCard.getByTestId(`json-tab-raw-${savedId}`).click();
    await expect(savedCard.getByTestId(`json-raw-textarea-${savedId}`)).toHaveValue(
      '{\n  "notes": "first-line\\nsecond-line",\n  "port": 9090\n}',
      { timeout: UI_WAIT_MS },
    );
  });

  test('behaviour: paste key: value lines (with URLs https://a.b:8080/x and times 12:30:45 split only at first ": "), paste PEM block into value -> save -> reopen byte-exact, and Array -> Object root conversion', async ({
    context,
    page,
  }) => {
    test.setTimeout(150_000);

    await installApiMocks(context);
    await applyThemeMocks(context, 'light');
    const mockCtrl = await installStatefulItemPageMocks(context);

    await prepare(page, 'light', 1440, 900);
    await gotoLocked(page, `/app/items/${ITEM.id}`, 'light');
    await unlockFromBanner(page);
    await expect(page).toHaveURL(new RegExp(`/app/items/${ITEM.id}$`), { timeout: UI_WAIT_MS });

    // 1. Open composer and paste multi-line `key: value` lines whose values contain URLs and times
    await page.getByTestId('btn-add-json').click();
    const composer = page.getByTestId('new-json-entry-composer');
    await expect(composer).toBeVisible({ timeout: UI_WAIT_MS });

    const pasteLines = [
      'endpoint: https://a.b:8080/x',
      'window_start: 12:30:45',
      'schedule: 08:00:00:backup:daily',
    ].join('\n');

    const intercepted = await dispatchPlainTextPaste(
      composer.getByTestId('json-new-key-input-root'),
      pasteLines,
    );
    expect(intercepted).toBe(true);

    const keyInputs = composer.locator('[data-kv-key-input]');
    const valInputs = composer.locator('[data-kv-val-input]');
    await expect(keyInputs).toHaveCount(3, { timeout: UI_WAIT_MS });
    await expect(keyInputs.nth(0)).toHaveValue('endpoint');
    await expect(valInputs.nth(0)).toHaveValue('https://a.b:8080/x');
    await expect(keyInputs.nth(1)).toHaveValue('window_start');
    await expect(valInputs.nth(1)).toHaveValue('12:30:45');
    await expect(keyInputs.nth(2)).toHaveValue('schedule');
    await expect(valInputs.nth(2)).toHaveValue('08:00:00:backup:daily');

    // Also verify single-line paste with URL value into an empty Key input splits only at the first ': '
    await valInputs.nth(2).focus();
    await page.keyboard.press('Enter');
    await expect(keyInputs).toHaveCount(4, { timeout: UI_WAIT_MS });
    const singleUrlIntercepted = await dispatchPlainTextPaste(
      keyInputs.nth(3),
      'webhook: https://a.b:8080/x?at=12:30:45',
    );
    expect(singleUrlIntercepted).toBe(true);
    await expect(keyInputs.nth(3)).toHaveValue('webhook');
    await expect(valInputs.nth(3)).toHaveValue('https://a.b:8080/x?at=12:30:45');

    // 2. Press Enter on the 4th row's Value to add a 5th row, name it `pem_cert`, and paste a multi-line PEM block into its Value input
    await valInputs.nth(3).focus();
    await page.keyboard.press('Enter');
    await expect(keyInputs).toHaveCount(5, { timeout: UI_WAIT_MS });
    await setFieldValue(keyInputs.nth(4), 'pem_cert');

    const pemBlock = [
      '-----BEGIN CERTIFICATE-----',
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7V1',
      'Subject: CN=engram.zone17.click:8443',
      'NotBefore: 12:30:45 UTC',
      '-----END CERTIFICATE-----',
    ].join('\n');

    const pemValInput = valInputs.nth(4);
    const pemIntercepted = await dispatchPlainTextPaste(pemValInput, pemBlock);
    // Paste into a Value input is verbatim (never split into key:value rows)
    expect(pemIntercepted).toBe(false);
    await expect(keyInputs).toHaveCount(5);
    await expect(pemValInput).toHaveValue(pemBlock);

    // Verify `Enter` inside the multi-line value textarea still moves focus to a new placeholder row (and placeholder row is omitted on serialize)
    await pemValInput.focus();
    await page.keyboard.press('Enter');
    await expect(keyInputs).toHaveCount(6, { timeout: UI_WAIT_MS });
    await expect(keyInputs.nth(5)).toBeFocused();
    await expect(keyInputs.nth(5)).toHaveValue('');

    // Save -> reload -> unlock -> verify byte-exact JSON (including PEM \n escapes and URL/time colons)
    await composer.getByTestId('new-json-save-btn').click();
    await expect(composer).toBeHidden({ timeout: UI_WAIT_MS });

    const allMetas = mockCtrl.getEntriesMeta();
    const savedEntryId = allMetas[allMetas.length - 1]!.id;

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
    await unlockFromBanner(page);

    const savedCard = page.getByTestId(`entry-card-${savedEntryId}`);
    await expect(savedCard).toBeVisible({ timeout: UI_WAIT_MS });
    await savedCard.getByTestId(`json-tab-raw-${savedEntryId}`).click();

    const expectedSavedJson = JSON.stringify(
      {
        endpoint: 'https://a.b:8080/x',
        window_start: '12:30:45',
        schedule: '08:00:00:backup:daily',
        webhook: 'https://a.b:8080/x?at=12:30:45',
        pem_cert: pemBlock,
      },
      null,
      2,
    );
    await expect(savedCard.getByTestId(`json-raw-textarea-${savedEntryId}`)).toHaveValue(
      expectedSavedJson,
      { timeout: UI_WAIT_MS },
    );

    // 3. Array root -> Object conversion (RFD-20, L2):
    // Open a new composer, switch root to Array, add 2 items, switch Array -> Object -> confirm inline prompt ->
    // verify EMPTY_KEY validation blocks Save until keys are named -> name keys -> Save -> verify exact JSON object
    await page.getByTestId('btn-add-json').click();
    await expect(composer).toBeVisible({ timeout: UI_WAIT_MS });

    await composer.getByTestId('new-json-root-menu-btn').click();
    await composer.getByTestId('new-json-preset-array').click();
    // Empty editor switches to Array without confirmation prompt
    await expect(composer.getByTestId('new-json-inline-prompt')).toHaveCount(0);

    const arrVal0 = composer.getByTestId('json-new-val-input-root');
    await setFieldValue(arrVal0, 'alpha-node');
    await arrVal0.focus();
    await page.keyboard.press('Enter');

    const arrVals = composer.locator('[data-kv-val-input]');
    await expect(arrVals).toHaveCount(2, { timeout: UI_WAIT_MS });
    await setFieldValue(arrVals.nth(1), 'beta-node');

    // Request Array -> Object root switch
    await composer.getByTestId('new-json-root-menu-btn').click();
    await composer.getByTestId('new-json-preset-object').click();

    const switchPrompt = composer.getByTestId('new-json-inline-prompt');
    await expect(switchPrompt).toBeVisible({ timeout: UI_WAIT_MS });
    await expect(switchPrompt).toContainText(/2 items need key names/i);
    await composer.getByTestId('new-json-prompt-confirm').click();
    await expect(switchPrompt).toBeHidden({ timeout: UI_WAIT_MS });

    // Both converted items have empty keys -> Save is disabled with EMPTY_KEY errors
    await expect(composer.getByTestId('new-json-save-btn')).toBeDisabled();
    const convertedKeys = composer.locator('[data-kv-key-input]');
    await expect(convertedKeys).toHaveCount(2);
    await expect(convertedKeys.nth(0)).toHaveAttribute('aria-invalid', 'true');
    await expect(convertedKeys.nth(1)).toHaveAttribute('aria-invalid', 'true');

    // Fill key names -> errors clear and Save enables
    await setFieldValue(convertedKeys.nth(0), 'primary');
    await setFieldValue(convertedKeys.nth(1), 'secondary');
    await expect(composer.getByTestId('new-json-save-btn')).toBeEnabled();

    await composer.getByTestId('new-json-save-btn').click();
    await expect(composer).toBeHidden({ timeout: UI_WAIT_MS });

    const metasAfterConvert = mockCtrl.getEntriesMeta();
    const convertedEntryId = metasAfterConvert[metasAfterConvert.length - 1]!.id;
    const convertedCard = page.getByTestId(`entry-card-${convertedEntryId}`);
    await convertedCard.getByTestId(`json-tab-raw-${convertedEntryId}`).click();
    await expect(convertedCard.getByTestId(`json-raw-textarea-${convertedEntryId}`)).toHaveValue(
      '{\n  "primary": "alpha-node",\n  "secondary": "beta-node"\n}',
      { timeout: UI_WAIT_MS },
    );
  });
});
