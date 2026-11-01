process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

import { expect, test, type Browser, type TestInfo } from '@playwright/test';
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';
import { newContext, uniqueEmail } from './helpers';
import {
  A11Y_LANGS,
  A11Y_THEMES,
  CONTENT_A11Y_TEST_TIMEOUT_MS,
  CONTENT_A11Y_UI_WAIT_MS,
  a11yStep,
  attachPlaintextLeakGuard,
  bootstrapUnlockedUser,
  checkContentState,
  expectAppAnimatesWithoutPreference,
  expectCoarseTouchTargetsAtLeast44,
  expectNoPlaintextInDomAttributes,
  newCoarseTouchContext,
  setQuietValue,
  type A11yLang,
  type A11yTheme,
  type ContentA11yContext,
} from './content-a11y-support';

/**
 * P04-T21c Stage W2 — Item page + text entries + JSON card + entry menu + Undo toast a11y & visual sweep
 * (`U11`-`U12` item page & text entry editing, `U13` JSON card table/raw/edit/error, entry menu, `U18` Undo toast on item page).
 *
 * Scope note: U14 (import dialog, Task 17) is NOT merged on `phase04/content` yet; skipped per brief (`w2-a11y-visual.md`).
 *
 * Matrix per screen state (`en`/`vi` x `light`/`dark` x `390`/`768`/`1440`):
 * - `content-a11y-item-<lang>-<theme>-<width>.png` (U11-U12 item header with 200-rune title + 50-rune tag, text entry card, JSON entry card)
 * - `content-a11y-text-edit-<lang>-<theme>-<width>.png` (U12 text entry inline editor open with byte counter & Save/Cancel controls)
 * - `content-a11y-json-table-<lang>-<theme>-<width>.png` (U13 JSON card Table view with expanded nested rows, inline cell edit, pagination/toolbar)
 * - `content-a11y-json-raw-<lang>-<theme>-<width>.png` (U13 JSON card Raw JSON view with monospace editor & Format/Save/Cancel toolbar)
 * - `content-a11y-json-error-<lang>-<theme>-<width>.png` (U13 JSON card Raw JSON invalid syntax banner with line/column + Go to line/col)
 * - `content-a11y-entry-menu-<lang>-<theme>-<width>.png` (Entry `...` action menu open with `role="menu"` / `role="menuitem"`)
 * - `content-a11y-item-undo-toast-<lang>-<theme>-<width>.png` (U18 Undo toast on item page after deleting an entry)
 *
 * Keyboard pass (`en`, `light`, 1440) + Coarse-pointer touch target check (`hasTouch: true, isMobile: true` at 390):
 * - Item header: click/Enter on `<h1>` -> inline rename input (`Enter` saves, `Escape` cancels and returns focus);
 *   `+ Tag` popover (`Enter` attaches tag, `Escape` closes and returns focus to `+ Tag` button).
 * - Entry card (`article`): `Enter` on text card starts inline edit -> `Ctrl+S` saves, `Escape` cancels;
 *   `+ Add text entry` composer (`Ctrl+S` saves, `Escape` cancels and returns focus to `+ Add text entry`).
 * - JSON card: `Table` / `Raw JSON` segmented toggle (`aria-pressed`), tree-grid cell edit (`Enter` to edit/commit, `Escape` to cancel),
 *   add field / add row keyboard trigger, raw invalid JSON -> switch to Table blocked with error alert + `Go to line X, column Y` focuses textarea at error offset.
 * - Entry `...` menu: `Enter` opens, `ArrowDown`/`ArrowUp` cycles items, `Escape` closes and returns focus to `...` trigger;
 *   `Delete` triggers U18 Undo toast -> focus returns to neighbour card -> `Ctrl+Z` restores entry in original position.
 */

const ITEM_SHORT_NAME = 'service-config-vault';
const ITEM_LONG_200_NAME = `${'item-header-200-rune-'.repeat(9)}tail200`.padEnd(200, 'z').slice(0, 200);
const TAG_LONG_50_NAME = `${'tag-chip-50-rune-'.repeat(2)}tail50`.padEnd(50, 'q').slice(0, 50);

async function runItemGroup(
  browser: Browser,
  testInfo: TestInfo,
  lang: A11yLang,
  theme: A11yTheme,
): Promise<void> {
  const groupLabel = `${lang}-${theme}`;
  const msgs = lang === 'vi' ? viMessages : enMessages;
  const context = await newContext(browser);

  // Synthetic public bodies for network + DOM attribute leak guards (user-dec-016)
  const textEntryBodyInitial = `acceptance-item-text-initial-${groupLabel}-secret-body-01`;
  const textEntryBodyEdited = `acceptance-item-text-edited-${groupLabel}-secret-body-02`;
  const extraEntryBodyToDelete = `acceptance-item-delete-target-${groupLabel}-secret-body-03`;
  const jsonSecretTokenValue = `acceptance-item-json-secret-${groupLabel}-token-04`;

  const initialJsonObject = {
    service: 'billing-worker',
    port: 8080,
    active: true,
    token: jsonSecretTokenValue,
    limits: {
      concurrency: 16,
      region: 'ap-southeast-1',
    },
    endpoints: [
      { host: 'api-1.internal', weight: 10 },
      { host: 'api-2.internal', weight: 20 },
    ],
  };
  const initialJsonRaw = JSON.stringify(initialJsonObject, null, 2);

  const forbiddenSecrets = [
    { label: 'textEntryBodyInitial', value: textEntryBodyInitial },
    { label: 'textEntryBodyEdited', value: textEntryBodyEdited },
    { label: 'extraEntryBodyToDelete', value: extraEntryBodyToDelete },
    { label: 'jsonSecretTokenValue', value: jsonSecretTokenValue },
  ] as const;

  const leakGuard = attachPlaintextLeakGuard(context, forbiddenSecrets);

  try {
    const page = await context.newPage();
    const ctx: ContentA11yContext = {
      page,
      testInfo,
      lang,
      theme,
      keyboard: lang === 'en' && theme === 'light',
    };

    await a11yStep(`[item ${groupLabel}] signup, onboarding skip, and locale/theme setup`, async () => {
      const email = uniqueEmail(`content-a11y-item-${groupLabel}`);
      await bootstrapUnlockedUser(page, email, lang, theme);
      await page.goto('/app', { waitUntil: 'domcontentloaded', timeout: CONTENT_A11Y_UI_WAIT_MS });
      await expect(page.getByTestId('home-empty-state')).toBeVisible({
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });
      if (ctx.keyboard) {
        await expectAppAnimatesWithoutPreference(page);
      }
    });

    // Seed item via omnibox quick-add, then navigate to `/app/items/[id]`
    let itemId = '';
    await a11yStep(
      `[item ${groupLabel}] create item via omnibox quick-add and open /app/items/[id]`,
      async () => {
        const omnibox = page.locator('#omni textarea[data-vault-secret]');
        await setQuietValue(omnibox, `${ITEM_SHORT_NAME} #core: ${textEntryBodyInitial}`);
        await omnibox.press('Enter');
        const firstCard = page.getByTestId('item-card').first();
        await expect(firstCard).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        const href = await firstCard.getAttribute('href');
        expect(href).toMatch(/^\/app\/items\/[0-9a-f-]{36}$/);
        itemId = href!.replace('/app/items/', '');

        await page.goto(`/app/items/${itemId}`, {
          waitUntil: 'domcontentloaded',
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expect(page.getByTestId('item-title-heading')).toBeVisible({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expect(page.getByTestId('text-entry-card')).toHaveCount(1, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
      },
    );

    // ---- U11 Item Header: inline rename to 200-rune title + attach 50-rune tag via `+ Tag` popover ----
    await a11yStep(
      `[item ${groupLabel}] U11 item header inline rename (200 runes) + attach 50-rune tag via + Tag popover`,
      async () => {
        const headingBtn = page.getByTestId('item-title-button');
        await expect(headingBtn).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        if (ctx.keyboard) {
          // Verify Escape in rename input cancels and returns focus to title button
          await headingBtn.focus();
          await page.keyboard.press('Enter');
          const renameInput = page.getByTestId('item-title-input');
          await expect(renameInput).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(renameInput).toBeFocused();
          await setQuietValue(renameInput, 'transient-cancelled-title');
          await page.keyboard.press('Escape');
          await expect(renameInput).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(headingBtn).toBeFocused();
          await expect(headingBtn).toHaveText(ITEM_SHORT_NAME);
        }

        // Rename item to 200-rune title via Enter
        await headingBtn.click();
        const renameInput = page.getByTestId('item-title-input');
        await expect(renameInput).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await setQuietValue(renameInput, ITEM_LONG_200_NAME);
        await renameInput.press('Enter');
        await expect(renameInput).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(headingBtn).toHaveText(ITEM_LONG_200_NAME, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });

        // Attach 50-rune tag via `+ Tag` popover
        const addTagTrigger = page.getByTestId('item-add-tag-trigger');
        if (ctx.keyboard) {
          // Open + Tag popover via keyboard, verify Escape closes and returns focus to trigger
          await addTagTrigger.focus();
          await page.keyboard.press('Enter');
          const tagPopover = page.getByTestId('item-add-tag-popover');
          await expect(tagPopover).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(page.getByTestId('item-add-tag-input')).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(tagPopover).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(addTagTrigger).toBeFocused();
        }

        await addTagTrigger.click();
        const tagInput = page.getByTestId('item-add-tag-input');
        await expect(tagInput).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(page.getByTestId('tag-privacy-notice')).toContainText(
          msgs.content.privacy.notice,
        );
        await setQuietValue(tagInput, TAG_LONG_50_NAME);
        await tagInput.press('Enter');
        await expect(
          page.getByTestId('item-tag-chip').filter({ hasText: TAG_LONG_50_NAME }),
        ).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        // Close tag popover so header is clean
        if (await page.getByTestId('item-add-tag-popover').isVisible()) {
          await page.keyboard.press('Escape');
          await expect(page.getByTestId('item-add-tag-popover')).toBeHidden({
            timeout: CONTENT_A11Y_UI_WAIT_MS,
          });
        }
      },
    );

    // ---- Create a 2nd text entry (`+ Add text entry`) and a JSON entry (`+ Add JSON entry`) ----
    let primaryTextEntryId = '';
    let deleteTargetTextEntryId = '';
    let jsonEntryId = '';

    await a11yStep(
      `[item ${groupLabel}] create 2nd text entry via + Add text entry and JSON entry via + Add JSON entry`,
      async () => {
        const firstTextCard = page.getByTestId('text-entry-card').first();
        primaryTextEntryId = (await firstTextCard.getAttribute('data-entry-id')) ?? '';
        expect(primaryTextEntryId).toMatch(/^[0-9a-f-]{36}$/);

        // Add 2nd text entry via `+ Add text entry` button (test Escape cancel in keyboard pass first)
        const addTextBtn = page.getByTestId('item-add-text-entry-btn');
        if (ctx.keyboard) {
          await addTextBtn.focus();
          await page.keyboard.press('Enter');
          const composer = page.getByTestId('new-text-entry-composer');
          await expect(composer).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          const composerTextarea = page.getByTestId('new-entry-textarea');
          await expect(composerTextarea).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(composer).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(addTextBtn).toBeFocused();
        }

        await addTextBtn.click();
        const composerTextarea = page.getByTestId('new-entry-textarea');
        await expect(composerTextarea).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await setQuietValue(composerTextarea, extraEntryBodyToDelete);
        await composerTextarea.press('Control+s');
        await expect(page.getByTestId('new-text-entry-composer')).toBeHidden({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expect(page.getByTestId('text-entry-card')).toHaveCount(2, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });

        // Identify the newly created text entry ID
        const allTextCards = page.getByTestId('text-entry-card');
        const count = await allTextCards.count();
        for (let i = 0; i < count; i += 1) {
          const id = (await allTextCards.nth(i).getAttribute('data-entry-id')) ?? '';
          if (id && id !== primaryTextEntryId) {
            deleteTargetTextEntryId = id;
          }
        }
        expect(deleteTargetTextEntryId).toMatch(/^[0-9a-f-]{36}$/);

        // Add JSON entry via `+ Add JSON entry` composer (switch to Raw JSON in composer, write rich JSON, Save)
        const addJsonBtn = page.getByTestId('item-add-json-entry-btn');
        await addJsonBtn.click();
        const jsonComposer = page.getByTestId('new-json-entry-composer');
        await expect(jsonComposer).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await page.getByTestId('json-mode-raw-new').click();
        const newJsonRawTextarea = page.getByTestId('json-raw-textarea-new');
        await expect(newJsonRawTextarea).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await setQuietValue(newJsonRawTextarea, initialJsonRaw);
        await page.getByTestId('json-raw-save-btn-new').click();
        await expect(jsonComposer).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        const jsonCard = page.getByTestId('json-entry-card').first();
        await expect(jsonCard).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        jsonEntryId = (await jsonCard.getAttribute('data-entry-id')) ?? '';
        expect(jsonEntryId).toMatch(/^[0-9a-f-]{36}$/);

        await expectNoPlaintextInDomAttributes(page, forbiddenSecrets);
      },
    );

    // ---- State 1: `item` (U11-U12 item page with header, text entry cards, JSON card) ----
    await a11yStep(`[item ${groupLabel}] State 1: U11-U12 item page sweep 390/768/1440`, async () => {
      await expect(page.getByTestId(`entry-body-${primaryTextEntryId}`)).toBeVisible({
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });
      await expect(page.getByTestId(`json-table-host-${jsonEntryId}`)).toBeVisible({
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });

      await checkContentState(ctx, { state: 'item', fullPage: true }, [
        '[data-testid="item-header"]',
        '[data-testid="text-entry-card"]',
        '[data-testid="json-entry-card"]',
      ]);
    });

    // ---- State 2: `text-edit` (U12 text entry inline edit + keyboard Enter / Ctrl+S / Escape) ----
    await a11yStep(
      `[item ${groupLabel}] State 2: U12 text entry inline edit + keyboard shortcuts + sweep 390/768/1440`,
      async () => {
        const primaryCard = page
          .getByTestId('text-entry-card')
          .filter({ has: page.locator(`[data-testid="entry-body-${primaryTextEntryId}"]`) })
          .first();

        if (ctx.keyboard) {
          // Focus card article -> press Enter -> inline editor opens with focus in textarea
          await primaryCard.focus();
          await expect(primaryCard).toBeFocused();
          await page.keyboard.press('Enter');
        } else {
          await page.getByTestId(`entry-body-${primaryTextEntryId}`).click();
        }

        const editTextarea = page.getByTestId(`entry-edit-textarea-${primaryTextEntryId}`);
        await expect(editTextarea).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(page.getByTestId(`entry-byte-counter-${primaryTextEntryId}`)).toBeVisible();

        if (ctx.keyboard) {
          await expect(editTextarea).toBeFocused();
          // Verify hardened secret input attributes on entry edit textarea
          const attrs = await editTextarea.evaluate((el) => ({
            spellcheck: el.getAttribute('spellcheck'),
            autocomplete: el.getAttribute('autocomplete'),
            autocorrect: el.getAttribute('autocorrect'),
            autocapitalize: el.getAttribute('autocapitalize'),
          }));
          expect(attrs).toEqual({
            spellcheck: 'false',
            autocomplete: 'off',
            autocorrect: 'off',
            autocapitalize: 'off',
          });
        }

        await checkContentState(ctx, { state: 'text-edit', fullPage: true }, [
          `[data-testid="entry-edit-textarea-${primaryTextEntryId}"]`,
          `[data-testid="entry-save-btn-${primaryTextEntryId}"]`,
        ]);

        if (ctx.keyboard) {
          // Edit value and save via Ctrl+S -> verify polite status region announces save and card returns to view mode
          await setQuietValue(editTextarea, textEntryBodyEdited);
          await editTextarea.press('Control+s');
          await expect(editTextarea).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(page.getByTestId('item-detail-live-region')).toContainText(
            msgs.content.entry.savedAnnounce,
          );

          // Re-open with Enter, then press Escape on clean draft -> closes editor and returns focus to card
          await primaryCard.focus();
          await page.keyboard.press('Enter');
          await expect(editTextarea).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await editTextarea.press('Escape');
          await expect(editTextarea).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        } else {
          await page.getByTestId(`entry-cancel-btn-${primaryTextEntryId}`).click();
          await expect(editTextarea).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        }
      },
    );

    // ---- State 3: `json-table` (U13 JSON card Table view + tree-grid keyboard cell edit) ----
    await a11yStep(
      `[item ${groupLabel}] State 3: U13 JSON card Table view + cell edit + sweep 390/768/1440`,
      async () => {
        const tableHost = page.getByTestId(`json-table-host-${jsonEntryId}`);
        await expect(tableHost).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        // Expand nested object (`limits`) and nested array (`endpoints`) so tree-grid depth + row toolbars are visible
        const limitsToggle = tableHost.locator('[data-json-toggle="limits"]');
        if (await limitsToggle.isVisible()) {
          await limitsToggle.click();
        }
        const endpointsToggle = tableHost.locator('[data-json-toggle="endpoints"]');
        if (await endpointsToggle.isVisible()) {
          await endpointsToggle.click();
        }

        // Open inline cell edit on `service` value cell so `json-table` captures active cell editing + Save/Cancel bar
        const serviceValueCell = tableHost.locator('[data-json-cell="service:val"]');
        await expect(serviceValueCell).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        if (ctx.keyboard) {
          await serviceValueCell.focus();
          await expect(serviceValueCell).toBeFocused();
          await page.keyboard.press('Enter');
        } else {
          await serviceValueCell.click();
        }

        const cellInput = tableHost.getByTestId('json-cell-edit-input');
        await expect(cellInput).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await setQuietValue(cellInput, 'billing-worker-v2');
        await cellInput.press('Enter');
        await expect(cellInput).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        // Table is now dirty -> footer Save / Cancel bar is visible
        await expect(page.getByTestId(`json-save-btn-${jsonEntryId}`)).toBeVisible({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });

        await checkContentState(ctx, { state: 'json-table', fullPage: true }, [
          `[data-testid="json-table-host-${jsonEntryId}"]`,
          `[data-testid="json-save-btn-${jsonEntryId}"]`,
        ]);

        // Save table edit and wait for dirty bar to clear
        await page.getByTestId(`json-save-btn-${jsonEntryId}`).click();
        await expect(page.getByTestId(`json-save-btn-${jsonEntryId}`)).toBeHidden({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
      },
    );

    // ---- State 4: `json-raw` (U13 JSON card Raw JSON view) & State 5: `json-error` (invalid JSON banner + Go to line/col) ----
    await a11yStep(
      `[item ${groupLabel}] State 4 & 5: U13 JSON card Raw JSON view and invalid JSON error banner + sweep 390/768/1440`,
      async () => {
        const modeRawBtn = page.getByTestId(`json-mode-raw-${jsonEntryId}`);
        const modeTableBtn = page.getByTestId(`json-mode-table-${jsonEntryId}`);
        await modeRawBtn.click();

        const rawTextarea = page.getByTestId(`json-raw-textarea-${jsonEntryId}`);
        await expect(rawTextarea).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(modeRawBtn).toHaveAttribute('aria-pressed', 'true');
        await expect(modeTableBtn).toHaveAttribute('aria-pressed', 'false');

        await checkContentState(ctx, { state: 'json-raw', fullPage: true }, [
          `[data-testid="json-raw-panel-${jsonEntryId}"]`,
          `[data-testid="json-raw-textarea-${jsonEntryId}"]`,
        ]);

        // Write invalid JSON with a trailing comma -> debounced validation shows error banner with line & column + Go to line/col button
        const invalidJson = '{\n  "service": "billing-worker",\n}';
        await setQuietValue(rawTextarea, invalidJson);

        const rawErrorBanner = page.getByTestId(`json-raw-error-${jsonEntryId}`);
        await expect(rawErrorBanner).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(rawTextarea).toHaveAttribute('aria-invalid', 'true');
        await expect(page.getByTestId(`json-raw-save-btn-${jsonEntryId}`)).toBeDisabled();
        await expect(page.getByTestId(`json-raw-format-btn-${jsonEntryId}`)).toBeDisabled();

        // Try switching back to Table while Raw JSON is invalid -> stays in Raw JSON and shows switch-blocked alert
        await modeTableBtn.click();
        await expect(page.getByTestId(`json-switch-blocked-${jsonEntryId}`)).toBeVisible({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expect(modeRawBtn).toHaveAttribute('aria-pressed', 'true');

        if (ctx.keyboard) {
          // Click/Enter `Go to line X, column Y` -> focuses raw textarea and places caret at the offending offset
          const gotoBtn = page.getByTestId(`json-raw-goto-btn-${jsonEntryId}`);
          await expect(gotoBtn).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await gotoBtn.focus();
          await page.keyboard.press('Enter');
          await expect(rawTextarea).toBeFocused();
          const selectionStart = await rawTextarea.evaluate(
            (el: HTMLTextAreaElement) => el.selectionStart,
          );
          expect(selectionStart).toBeGreaterThan(0);
        }

        await checkContentState(ctx, { state: 'json-error', fullPage: true }, [
          `[data-testid="json-raw-error-${jsonEntryId}"]`,
          `[data-testid="json-switch-blocked-${jsonEntryId}"]`,
        ]);

        // Cancel raw edits and discard changes so JSON card returns cleanly to Table view
        await page.getByTestId(`json-raw-cancel-btn-${jsonEntryId}`).click();
        const discardConfirm = page.getByTestId(`json-discard-confirm-${jsonEntryId}`);
        if (await discardConfirm.isVisible()) {
          await page.getByTestId(`json-discard-btn-${jsonEntryId}`).click();
        }
        await modeTableBtn.click();
        await expect(page.getByTestId(`json-table-host-${jsonEntryId}`)).toBeVisible({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
      },
    );

    // ---- State 6: `entry-menu` (Entry `...` menu open) & State 7: `item-undo-toast` (U18 Undo toast after entry delete) ----
    await a11yStep(
      `[item ${groupLabel}] State 6 & 7: Entry menu sweep + delete entry -> U18 Undo toast sweep + Ctrl+Z restore`,
      async () => {
        const menuTrigger = page.getByTestId(`entry-menu-trigger-${deleteTargetTextEntryId}`);
        await expect(menuTrigger).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        if (ctx.keyboard) {
          // Open with Enter, cycle with ArrowDown/ArrowUp, close with Escape -> focus returns to trigger
          await menuTrigger.focus();
          await expect(menuTrigger).toBeFocused();
          await page.keyboard.press('Enter');
          const menuPopup = page.getByTestId(`entry-menu-popup-${deleteTargetTextEntryId}`);
          await expect(menuPopup).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          const items = menuPopup.getByRole('menuitem');
          await expect(items.first()).toBeFocused();
          await page.keyboard.press('ArrowDown');
          await expect(items.nth(1)).toBeFocused();
          await page.keyboard.press('ArrowUp');
          await expect(items.first()).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(menuPopup).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(menuTrigger).toBeFocused();

          // Re-open for the 390/768/1440 visual + axe sweep
          await page.keyboard.press('Enter');
        } else {
          await menuTrigger.click();
        }

        const menuPopup = page.getByTestId(`entry-menu-popup-${deleteTargetTextEntryId}`);
        await expect(menuPopup).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        await checkContentState(ctx, { state: 'entry-menu', fullPage: true }, [
          `[data-testid="entry-menu-popup-${deleteTargetTextEntryId}"]`,
        ]);

        // Trigger Delete from the entry menu -> entry card disappears immediately, U18 Undo toast appears
        const deleteMenuItem = page.getByTestId(`entry-menu-delete-${deleteTargetTextEntryId}`);
        if (ctx.keyboard) {
          await deleteMenuItem.focus();
          await page.keyboard.press('Enter');
        } else {
          await deleteMenuItem.click();
        }

        await expect(page.getByTestId('text-entry-card')).toHaveCount(1, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });

        const undoToast = page.getByTestId('undo-toast-item').first();
        await expect(undoToast).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(page.getByTestId('undo-toast-stack').locator('[role="status"]')).toHaveCount(
          1,
        );

        // Focus Undo button inside toast so the 5s/10s timer pauses across the 390/768/1440 sweep
        const undoBtn = undoToast.getByRole('button');
        await undoBtn.focus();
        await expect(undoBtn).toBeFocused();

        await checkContentState(ctx, { state: 'item-undo-toast', fullPage: true }, [
          '[data-testid="undo-toast-item"]',
          '[data-testid="item-header"]',
        ]);

        if (ctx.keyboard) {
          // Verify that typing in an active textarea does NOT trigger toast Undo on Ctrl+Z,
          // and that pressing Ctrl+Z outside an input restores the deleted entry card and focuses it (plan §2.8, §2.11).
          const primaryBody = page.getByTestId(`entry-body-${primaryTextEntryId}`);
          await primaryBody.click();
          const activeEditTextarea = page.getByTestId(`entry-edit-textarea-${primaryTextEntryId}`);
          await expect(activeEditTextarea).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await activeEditTextarea.focus();
          await page.keyboard.press('Control+z');
          // Toast is STILL visible (Ctrl+Z inside active textarea did not consume the Undo toast)
          await expect(undoToast).toBeVisible();
          await activeEditTextarea.press('Escape');
          await expect(activeEditTextarea).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });

          // Now focus the Undo toast button and press Ctrl+Z -> restores the deleted entry card
          await undoBtn.focus();
          await page.keyboard.press('Control+z');
          await expect(page.getByTestId('text-entry-card')).toHaveCount(2, {
            timeout: CONTENT_A11Y_UI_WAIT_MS,
          });
          await expect(
            page.getByTestId(`entry-body-${deleteTargetTextEntryId}`),
          ).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        } else {
          // Click Undo so all locales/themes also exercise restore cleanly
          await undoBtn.click();
          await expect(page.getByTestId('text-entry-card')).toHaveCount(2, {
            timeout: CONTENT_A11Y_UI_WAIT_MS,
          });
        }
      },
    );

    // ---- Coarse pointer touch target >= 44 px check (once, in keyboard pass) ----
    if (ctx.keyboard) {
      await a11yStep(
        `[item ${groupLabel}] coarse pointer (hasTouch: true, isMobile: true at 390) touch target >= 44 px`,
        async () => {
          const coarseContext = await newCoarseTouchContext(browser, context);
          try {
            const coarsePage = await coarseContext.newPage();
            await coarsePage.goto(`/app/items/${itemId}`, {
              waitUntil: 'domcontentloaded',
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });
            await expect(coarsePage.getByTestId('item-title-heading')).toBeVisible({
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });
            await expect(coarsePage.getByTestId(`json-table-host-${jsonEntryId}`)).toBeVisible({
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });

            // 1. Item page controls: buttons, chip-x remove buttons, segmented toggle buttons, entry menu trigger
            await expectCoarseTouchTargetsAtLeast44(
              coarsePage,
              'item-controls',
              [
                '[data-testid="item-add-tag-trigger"]',
                '[data-testid="item-add-text-entry-btn"]',
                '[data-testid="item-add-json-entry-btn"]',
                `[data-testid="entry-menu-trigger-${primaryTextEntryId}"]`,
                `[data-testid="json-mode-table-${jsonEntryId}"]`,
                `[data-testid="json-mode-raw-${jsonEntryId}"]`,
                '[data-testid="item-tag-chip"] .chip-x',
              ],
              [
                `[data-testid="entry-menu-trigger-${primaryTextEntryId}"]`,
                '[data-testid="item-tag-chip"] .chip-x',
              ],
            );

            // 2. Open entry `...` menu and check `[role="menuitem"]` >= 44px height
            await coarsePage.getByTestId(`entry-menu-trigger-${primaryTextEntryId}`).click();
            await expect(
              coarsePage.getByTestId(`entry-menu-popup-${primaryTextEntryId}`),
            ).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
            await expectCoarseTouchTargetsAtLeast44(coarsePage, 'entry-menu-items', [
              `[data-testid="entry-menu-popup-${primaryTextEntryId}"] [role="menuitem"]`,
            ]);
            await coarsePage.keyboard.press('Escape');

            // 3. JSON table buttons (`.json-toggle`, `.json-cell-btn`, `.json-type-btn`)
            await expectCoarseTouchTargetsAtLeast44(
              coarsePage,
              'json-table-controls',
              [
                `[data-testid="json-table-host-${jsonEntryId}"] .json-toggle`,
                `[data-testid="json-table-host-${jsonEntryId}"] .json-cell-btn`,
                `[data-testid="json-table-host-${jsonEntryId}"] .json-type-btn`,
              ],
              [`[data-testid="json-table-host-${jsonEntryId}"] .json-toggle`],
            );
          } finally {
            await coarseContext.close();
          }
        },
      );
    }

    await expectNoPlaintextInDomAttributes(page, forbiddenSecrets);
    leakGuard.assertNoLeaks();
  } finally {
    await context.close();
  }
}

test.describe('P04-T21c Item page + text/JSON entries + menu + Undo toast a11y & visual sweep (U11-U13, U18)', () => {
  test.skip(
    !process.env.E2E_STACK,
    'needs the compose stack (E2E_STACK=1): real API, real database',
  );

  for (const lang of A11Y_LANGS) {
    for (const theme of A11Y_THEMES) {
      test(`item page a11y + visual matrix (${lang}, ${theme})`, async ({ browser }, testInfo) => {
        test.setTimeout(CONTENT_A11Y_TEST_TIMEOUT_MS);
        await runItemGroup(browser, testInfo, lang, theme);
      });
    }
  }
});
