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
  expectHorizontallyScrollable,
  expectInputEquals,
  expectNoPlaintextInDomAttributes,
  newCoarseTouchContext,
  setQuietValue,
  unlockLockedAppPage,
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
 * - Item header: `#item-name-input` inline rename (`Enter` saves, `Escape` reverts to committed name);
 *   `+ Tag` (`tag-add-chip`) popover (`Enter` attaches tag, `Escape` closes and returns focus to `+ Tag` button).
 * - Entry card (`article[data-entry-card]`): `Edit` button (`entry-edit-btn-${id}`) starts inline edit with focus in textarea -> `Ctrl+S` saves,
 *   `Escape` cancels and returns focus to `Edit` button; `+ Add text entry` (`btn-add-text`) composer (`Ctrl+S` saves, `Escape` cancels and returns focus to `btn-add-text`).
 * - JSON card: `Table` / `Raw JSON` segmented toggle (`json-tab-table-${id}` / `json-tab-raw-${id}`, `aria-pressed`), tree-grid cell edit (`Enter` to open/commit, `Escape` to cancel),
 *   raw invalid JSON -> switch to Table blocked with error alert (`json-switch-blocked-msg-${id}`) + `Go to line X, column Y` (`json-raw-goto-btn-${id}`) focuses textarea at error offset.
 * - Entry `...` menu (`entry-menu-trigger-${id}` -> `entry-menu-pop-${id}`): `Enter` opens, `ArrowDown`/`ArrowUp` cycles items, `Escape` closes and returns focus to `...` trigger;
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
      await expect(page.getByTestId('home-empty-state')).toBeVisible({
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });
      if (ctx.keyboard) {
        await expectAppAnimatesWithoutPreference(page);
      }
    });

    // Seed item via omnibox quick-add (clicking Save now so initial toast uses 5s default duration),
    // then client-navigate via `<Link>` to `/app/items/[id]` so the in-memory vault key stays unlocked
    let itemId = '';
    await a11yStep(
      `[item ${groupLabel}] create item via omnibox quick-add and open /app/items/[id]`,
      async () => {
        const omnibox = page.locator('#omni textarea[data-vault-secret]');
        const saveBtn = page.getByTestId('omnibox-save-now-btn');
        await setQuietValue(omnibox, `${ITEM_SHORT_NAME} #core: ${textEntryBodyInitial}`);
        await expect(saveBtn).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await saveBtn.click();
        const firstCard = page.getByTestId('item-card').first();
        await expect(firstCard).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        const href = await firstCard.getAttribute('href');
        expect(href).toMatch(/^\/app\/items\/[0-9a-f-]{36}$/);
        itemId = href!.replace('/app/items/', '');

        // Navigate via SPA `<Link>` (keeps in-memory vault key open)
        await firstCard.click();
        await expect(page).toHaveURL(new RegExp(`/app/items/${itemId}$`), {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expect(page.getByTestId('item-header')).toBeVisible({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expect(page.getByTestId('item-name-input')).toBeVisible({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expect(page.locator('article[data-entry-card]')).toHaveCount(1, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
      },
    );

    // ---- U11 Item Header: inline rename to 200-rune title + attach 50-rune tag via `+ Tag` popover ----
    await a11yStep(
      `[item ${groupLabel}] U11 item header inline rename (200 runes) + attach 50-rune tag via + Tag popover`,
      async () => {
        const nameInput = page.getByTestId('item-name-input');
        await expect(nameInput).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        if (ctx.keyboard) {
          // Verify Escape in `#item-name-input` reverts uncommitted edits to the committed item name
          await nameInput.focus();
          await expect(nameInput).toBeFocused();
          await setQuietValue(nameInput, 'transient-cancelled-title');
          await page.keyboard.press('Escape');
          await expectInputEquals(nameInput, ITEM_SHORT_NAME);
          await expect(page.getByTestId('breadcrumb-item-name')).toHaveText(ITEM_SHORT_NAME);
        }

        // Rename item to 200-rune title via Enter
        await nameInput.focus();
        await setQuietValue(nameInput, ITEM_LONG_200_NAME);
        await nameInput.press('Enter');
        await expect(page.getByTestId('breadcrumb-item-name')).toHaveText(ITEM_LONG_200_NAME, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expect(page.getByTestId('item-page-live-region')).toContainText(
          msgs.content.item.nameSaved,
          { timeout: CONTENT_A11Y_UI_WAIT_MS },
        );

        // Attach 50-rune tag via `+ Tag` (`tag-add-chip`) popover
        const addTagTrigger = page.getByTestId('tag-add-chip');
        if (ctx.keyboard) {
          // Open + Tag popover via keyboard, verify Escape closes and returns focus to trigger
          await addTagTrigger.focus();
          await expect(addTagTrigger).toBeFocused();
          await page.keyboard.press('Enter');
          const tagPopover = page.getByTestId('tag-add-popover');
          await expect(tagPopover).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(page.getByTestId('tag-suggest-input')).toBeFocused();
          await page.keyboard.press('Escape');
          await expect(tagPopover).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(addTagTrigger).toBeFocused();
        }

        await addTagTrigger.click();
        const tagInput = page.getByTestId('tag-suggest-input');
        await expect(tagInput).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(page.getByTestId('tag-privacy-note')).toContainText(
          msgs.content.privacy.notice,
        );
        await setQuietValue(tagInput, TAG_LONG_50_NAME);
        await tagInput.press('Enter');
        await expect(
          page.getByTestId(`item-tag-chip-${TAG_LONG_50_NAME}`),
        ).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        // Tag attach closes the popover automatically (`item-header.tsx:610`): assert it is hidden (ACC-A11Y1-7)
        await expect(page.getByTestId('tag-add-popover')).toBeHidden({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
      },
    );

    // ---- Create a 2nd text entry (`+ Add text entry`) and a JSON entry (`+ Add JSON entry`) ----
    let primaryTextEntryId = '';
    let deleteTargetTextEntryId = '';
    let jsonEntryId = '';

    await a11yStep(
      `[item ${groupLabel}] create 2nd text entry via + Add text entry and JSON entry via + Add JSON entry`,
      async () => {
        const firstTextCard = page.locator('article[data-entry-card]:not([data-entry-type="json"])').first();
        primaryTextEntryId = (await firstTextCard.getAttribute('data-entry-card')) ?? '';
        expect(primaryTextEntryId).toMatch(/^[0-9a-f-]{36}$/);

        // Add 2nd text entry via `btn-add-text` button (test Escape cancel in keyboard pass first)
        const addTextBtn = page.getByTestId('btn-add-text');
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
        const textCards = page.locator('article[data-entry-card]:not([data-entry-type="json"])');
        await expect(textCards).toHaveCount(2, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });

        // Identify the newly created text entry ID
        const count = await textCards.count();
        for (let i = 0; i < count; i += 1) {
          const id = (await textCards.nth(i).getAttribute('data-entry-card')) ?? '';
          if (id && id !== primaryTextEntryId) {
            deleteTargetTextEntryId = id;
          }
        }
        expect(deleteTargetTextEntryId).toMatch(/^[0-9a-f-]{36}$/);

        // Add JSON entry via `btn-add-json` composer (switch to Raw JSON in composer, write rich JSON, Save)
        const addJsonBtn = page.getByTestId('btn-add-json');
        await addJsonBtn.click();
        const jsonComposer = page.getByTestId('new-json-entry-composer');
        await expect(jsonComposer).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await page.getByTestId('new-json-tab-raw').click();
        const newJsonRawTextarea = page.getByTestId('json-raw-textarea-new-json');
        await expect(newJsonRawTextarea).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await setQuietValue(newJsonRawTextarea, initialJsonRaw);
        await page.getByTestId('json-raw-save-btn-new-json').click();
        await expect(jsonComposer).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        const jsonCard = page.locator('article[data-entry-type="json"]').first();
        await expect(jsonCard).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        jsonEntryId = (await jsonCard.getAttribute('data-entry-card')) ?? '';
        expect(jsonEntryId).toMatch(/^[0-9a-f-]{36}$/);

        await expectNoPlaintextInDomAttributes(page, forbiddenSecrets);
      },
    );

    // ---- State 1: `item` (U11-U12 item page with header, text entry cards, JSON card — deterministic 0 toasts) ----
    await a11yStep(`[item ${groupLabel}] State 1: U11-U12 item page sweep 390/768/1440`, async () => {
      // Move pointer away from the bottom-centered toast stack and wait for the initial quick-add toast from `/app`
      // to auto-dismiss so States 1..6 are 100% deterministic with 0 toasts across all locales/themes (ACC-TV1-6, ACC-A11Y1-8).
      await page.mouse.move(10, 10);
      await expect(page.getByTestId('undo-toast-item')).toHaveCount(0, {
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });

      const primaryCard = page.getByTestId(`entry-card-${primaryTextEntryId}`);
      await expect(primaryCard.getByTestId('entry-body')).toBeVisible({
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });
      await expect(page.getByTestId(`json-table-host-${jsonEntryId}`)).toBeVisible({
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });

      await checkContentState(
        ctx,
        {
          state: 'item',
          fullPage: true,
          allowedHorizontalScrollSelectors: [`[data-testid="json-table-host-${jsonEntryId}"]`],
        },
        [
          '[data-testid="item-header"]',
          '[data-testid="breadcrumb-item-name"]',
          `[data-testid="item-tag-chip-${TAG_LONG_50_NAME}"]`,
          `[data-testid="entry-card-${primaryTextEntryId}"]`,
          `[data-testid="entry-card-${jsonEntryId}"]`,
          `[data-testid="json-table-host-${jsonEntryId}"]`,
        ],
      );
    });

    // ---- State 2: `text-edit` (U12 text entry inline edit + keyboard Enter / Ctrl+S / Escape) ----
    await a11yStep(
      `[item ${groupLabel}] State 2: U12 text entry inline edit + keyboard shortcuts + sweep 390/768/1440`,
      async () => {
        const editBtn = page.getByTestId(`entry-edit-btn-${primaryTextEntryId}`);
        await expect(editBtn).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        if (ctx.keyboard) {
          // Focus card's Edit button -> press Enter -> inline editor opens with focus in textarea
          await editBtn.focus();
          await expect(editBtn).toBeFocused();
          await page.keyboard.press('Enter');
        } else {
          await editBtn.click();
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

        await checkContentState(
          ctx,
          {
            state: 'text-edit',
            fullPage: true,
            allowedHorizontalScrollSelectors: [`[data-testid="json-table-host-${jsonEntryId}"]`],
          },
          [
            '[data-testid="item-header"]',
            '[data-testid="breadcrumb-item-name"]',
            `[data-testid="item-tag-chip-${TAG_LONG_50_NAME}"]`,
            `[data-testid="entry-edit-textarea-${primaryTextEntryId}"]`,
            `[data-testid="entry-save-btn-${primaryTextEntryId}"]`,
          ],
        );

        if (ctx.keyboard) {
          // Edit value and save via Ctrl+S -> verify polite status region announces save and card returns to view mode
          await setQuietValue(editTextarea, textEntryBodyEdited);
          await editTextarea.press('Control+s');
          await expect(editTextarea).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(page.getByTestId('item-page-live-region')).toContainText(
            msgs.content.entry.savedAnnounce,
          );

          // Re-open with Enter on Edit button, then press Escape on clean draft -> closes editor and returns focus to Edit button
          await editBtn.focus();
          await expect(editBtn).toBeFocused();
          await editBtn.press('Enter');
          await expect(editTextarea).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await editTextarea.press('Escape');
          await expect(editTextarea).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(editBtn).toBeFocused();
        } else {
          await page.getByTestId(`entry-cancel-btn-${primaryTextEntryId}`).click();
          await expect(editTextarea).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        }
      },
    );

    // ---- State 3: `json-table` (U13 JSON card Table view + treegrid ARIA & keyboard navigation + cell edit) ----
    await a11yStep(
      `[item ${groupLabel}] State 3: U13 JSON card Table view + treegrid ARIA/keyboard + cell edit + sweep 390/768/1440`,
      async () => {
        const tableHost = page.getByTestId(`json-table-host-${jsonEntryId}`);
        await expect(tableHost).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        // ACC-A11Y1-3 & ACC-A11Y1-7: Verify root `<table role="treegrid">`, row `aria-level="1"` and `aria-expanded`
        const rootTreegrid = tableHost.locator('table[role="treegrid"]').first();
        await expect(rootTreegrid).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(rootTreegrid).toHaveAttribute('aria-label', msgs.content.json.treegridAria);

        const limitsToggle = tableHost.getByTestId('json-toggle-root.p4');
        await expect(limitsToggle).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(limitsToggle).toHaveAttribute('aria-expanded', 'false');
        const limitsRow = limitsToggle.locator('xpath=ancestor::tr[1]');
        await expect(limitsRow).toHaveAttribute('role', 'row');
        await expect(limitsRow).toHaveAttribute('aria-level', '1');
        await expect(limitsRow).toHaveAttribute('aria-expanded', 'false');

        await limitsToggle.click();
        await expect(limitsToggle).toHaveAttribute('aria-expanded', 'true');
        await expect(limitsRow).toHaveAttribute('aria-expanded', 'true');

        // Verify child table inside `json-nest-root.p4` has `role="treegrid"` and rows at `aria-level="2"`
        const limitsNest = tableHost.getByTestId('json-nest-root.p4');
        await expect(limitsNest).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(limitsNest.locator('table[role="treegrid"]')).toBeVisible();
        await expect(limitsNest.locator('tbody tr[role="row"]').first()).toHaveAttribute(
          'aria-level',
          '2',
        );

        const endpointsToggle = tableHost.getByTestId('json-toggle-root.p5');
        await expect(endpointsToggle).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(endpointsToggle).toHaveAttribute('aria-expanded', 'false');
        await endpointsToggle.click();
        await expect(endpointsToggle).toHaveAttribute('aria-expanded', 'true');
        await expect(tableHost.getByTestId('json-nest-root.p5')).toBeVisible({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });

        if (ctx.keyboard) {
          // ACC-A11Y1-3: Keyboard arrow navigation between treegrid cells (`json-tree-grid.tsx:508-568`)
          // Focus row 1 key cell (`root.k0`) -> ArrowRight focuses row 1 value cell (`root.p0`) -> ArrowDown focuses row 2 value cell (`root.p1`)
          const keyCell0 = tableHost.getByTestId('json-cell-btn-root.k0');
          const valCell0 = tableHost.getByTestId('json-cell-btn-root.p0');
          const valCell1 = tableHost.getByTestId('json-cell-btn-root.p1');

          await keyCell0.focus();
          await expect(keyCell0).toBeFocused();
          await page.keyboard.press('ArrowRight');
          await expect(valCell0).toBeFocused();
          await page.keyboard.press('ArrowDown');
          await expect(valCell1).toBeFocused();
          await page.keyboard.press('ArrowUp');
          await expect(valCell0).toBeFocused();
        }

        // Open inline cell edit on `service` value cell (`root.p0`) so `json-table` captures active cell editing + Save/Cancel bar
        const serviceValueCell = tableHost.getByTestId('json-cell-btn-root.p0');
        await expect(serviceValueCell).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        if (ctx.keyboard) {
          await serviceValueCell.focus();
          await expect(serviceValueCell).toBeFocused();
          await serviceValueCell.press('Enter');
        } else {
          await serviceValueCell.click();
        }

        const cellInput = tableHost.getByTestId('json-cell-input-root.p0');
        await expect(cellInput).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await setQuietValue(cellInput, 'billing-worker-v2');
        await cellInput.press('Enter');
        await expect(cellInput).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        // Table is now dirty -> footer Save / Cancel bar is visible (`entry-save-btn-${jsonEntryId}`)
        const jsonTableSaveBtn = page.getByTestId(`entry-save-btn-${jsonEntryId}`);
        await expect(jsonTableSaveBtn).toBeVisible({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });

        await checkContentState(
          ctx,
          {
            state: 'json-table',
            fullPage: true,
            allowedHorizontalScrollSelectors: [`[data-testid="json-table-host-${jsonEntryId}"]`],
          },
          [
            '[data-testid="item-header"]',
            '[data-testid="breadcrumb-item-name"]',
            `[data-testid="item-tag-chip-${TAG_LONG_50_NAME}"]`,
            `[data-testid="json-table-host-${jsonEntryId}"]`,
            `[data-testid="entry-save-btn-${jsonEntryId}"]`,
          ],
        );

        // Prove that at 390 px the JSON table host (`overflow-x-auto`) is horizontally scrollable inside the card (S3TV1-7)
        await page.setViewportSize({ width: 390, height: 844 });
        await expectHorizontallyScrollable(
          page,
          `[data-testid="json-table-host-${jsonEntryId}"]`,
          `json-table ${groupLabel} 390`,
        );
        await page.setViewportSize({ width: 1440, height: 900 });
        await jsonTableSaveBtn.click();
        await expect(jsonTableSaveBtn).toBeHidden({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
      },
    );

    // ---- State 4: `json-raw` (U13 JSON card Raw JSON view) & State 5: `json-error` (invalid JSON banner + Go to line/col) ----
    await a11yStep(
      `[item ${groupLabel}] State 4 & 5: U13 JSON card Raw JSON view and invalid JSON error banner + sweep 390/768/1440`,
      async () => {
        const modeRawBtn = page.getByTestId(`json-tab-raw-${jsonEntryId}`);
        const modeTableBtn = page.getByTestId(`json-tab-table-${jsonEntryId}`);
        await modeRawBtn.click();

        const rawTextarea = page.getByTestId(`json-raw-textarea-${jsonEntryId}`);
        await expect(rawTextarea).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(modeRawBtn).toHaveAttribute('aria-pressed', 'true');
        await expect(modeTableBtn).toHaveAttribute('aria-pressed', 'false');

        await checkContentState(ctx, { state: 'json-raw', fullPage: true }, [
          '[data-testid="item-header"]',
          '[data-testid="breadcrumb-item-name"]',
          `[data-testid="item-tag-chip-${TAG_LONG_50_NAME}"]`,
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

        // Try switching back to Table while Raw JSON is invalid -> stays in Raw JSON, shows switch-blocked alert (`role="alert"`),
        // and announces `switchBlockedInvalidError` in `item-page-live-region` (`json-entry-card.tsx:610-611`, ACC-A11Y1-3)
        await modeTableBtn.click();
        const switchBlockedAlert = page.getByTestId(`json-switch-blocked-msg-${jsonEntryId}`);
        await expect(switchBlockedAlert).toBeVisible({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expect(switchBlockedAlert).toHaveAttribute('role', 'alert');
        await expect(switchBlockedAlert).toContainText(
          msgs.content.json.switchBlockedInvalidError,
        );
        await expect(rawErrorBanner).toHaveAttribute('role', 'alert');
        await expect(page.getByTestId('item-page-live-region')).toContainText(
          msgs.content.json.switchBlockedInvalidError,
          { timeout: CONTENT_A11Y_UI_WAIT_MS },
        );
        await expect(modeRawBtn).toHaveAttribute('aria-pressed', 'true');

        if (ctx.keyboard) {
          // Click/Enter `Go to line X, column Y` -> focuses raw textarea and places caret at the offending offset
          const gotoBtn = page.getByTestId(`json-raw-goto-btn-${jsonEntryId}`);
          await expect(gotoBtn).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await gotoBtn.focus();
          await expect(gotoBtn).toBeFocused();
          await gotoBtn.press('Enter');
          await expect(rawTextarea).toBeFocused();
          const selectionStart = await rawTextarea.evaluate(
            (el: HTMLTextAreaElement) => el.selectionStart,
          );
          expect(selectionStart).toBeGreaterThan(0);
        }

        await checkContentState(ctx, { state: 'json-error', fullPage: true }, [
          '[data-testid="item-header"]',
          '[data-testid="breadcrumb-item-name"]',
          `[data-testid="item-tag-chip-${TAG_LONG_50_NAME}"]`,
          `[data-testid="json-raw-error-${jsonEntryId}"]`,
          `[data-testid="json-switch-blocked-msg-${jsonEntryId}"]`,
        ]);

        // Cancel raw edits and discard changes so JSON card returns cleanly to Table view (ACC-A11Y1-7: explicit waiting assertions)
        await page.getByTestId(`json-raw-cancel-btn-${jsonEntryId}`).click();
        const discardConfirm = page.getByTestId(`entry-discard-confirm-${jsonEntryId}`);
        await expect(discardConfirm).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await page.getByTestId(`entry-discard-btn-${jsonEntryId}`).click();
        await expect(discardConfirm).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
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
          const menuPopup = page.getByTestId(`entry-menu-pop-${deleteTargetTextEntryId}`);
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

        const menuPopup = page.getByTestId(`entry-menu-pop-${deleteTargetTextEntryId}`);
        await expect(menuPopup).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

        await checkContentState(
          ctx,
          {
            state: 'entry-menu',
            fullPage: true,
            allowedHorizontalScrollSelectors: [`[data-testid="json-table-host-${jsonEntryId}"]`],
          },
          [
            '[data-testid="item-header"]',
            '[data-testid="breadcrumb-item-name"]',
            `[data-testid="item-tag-chip-${TAG_LONG_50_NAME}"]`,
            `[data-testid="entry-menu-pop-${deleteTargetTextEntryId}"]`,
            `[data-testid="json-table-host-${jsonEntryId}"]`,
          ],
        );

        // Ensure 0 stale toasts exist before deleting the entry (ACC-A11Y1-8, ACC-TV1-6)
        await expect(page.getByTestId('undo-toast-item')).toHaveCount(0, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });

        // Trigger Delete from the entry menu -> entry card disappears immediately, U18 Undo toast appears,
        // and focus moves to the neighbour card's menu trigger (`item-detail-page.tsx:240-249, 630, 657-659`:
        // `nextNeighbor = current[index + 1] ?? current[index - 1]` -> JSON entry card at index 2;
        // `tryFocusCardDom` queries `[data-card-menu-trigger], button:not(:disabled)` -> `entry-menu-trigger-${jsonEntryId}`) (ACC-A11Y1-3).
        // Note: `checkContentState` at 1440 px runs `expectReducedMotion`, which temporarily flips `prefers-reduced-motion`
        // and blurs/scrolls during `saveContentScreenshot`, leaving `deleteMenuItem` unfocused after the sweep.
        // Explicitly focus, assert `toBeFocused()`, and invoke `deleteMenuItem.press('Enter')` in the keyboard pass.
        const deleteMenuItem = page.getByTestId(`entry-menu-delete-${deleteTargetTextEntryId}`);
        if (ctx.keyboard) {
          await deleteMenuItem.focus();
          await expect(deleteMenuItem).toBeFocused();
          await deleteMenuItem.press('Enter');
        } else {
          await deleteMenuItem.click();
        }
        const textCards = page.locator('article[data-entry-card]:not([data-entry-type="json"])');
        await expect(textCards).toHaveCount(1, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });

        if (ctx.keyboard) {
          const activeAfterDelete = await page.evaluate(() => {
            const el = document.activeElement;
            return el
              ? `${el.tagName.toLowerCase()}#${el.id || ''}[data-testid="${el.getAttribute('data-testid') || ''}"]`
              : 'null';
          });
          console.log(`focus-after-delete ${groupLabel}: ${activeAfterDelete}`);
          await expect(
            page.getByTestId(`entry-menu-trigger-${jsonEntryId}`),
            `focus-after-delete (${groupLabel}): activeElement=${activeAfterDelete}`,
          ).toBeFocused({
            timeout: CONTENT_A11Y_UI_WAIT_MS,
          });
        }

        const undoToasts = page.getByTestId('undo-toast-item');
        await expect(undoToasts).toHaveCount(1, { timeout: CONTENT_A11Y_UI_WAIT_MS });
        const undoToast = undoToasts.first();
        await expect(undoToast).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(page.getByTestId('undo-toast-stack').locator('[role="status"]')).toHaveCount(
          1,
        );

        // Focus Undo button inside toast so the 5s/10s timer pauses across the 390/768/1440 sweep
        const undoBtn = undoToast.getByRole('button');
        await undoBtn.focus();
        await expect(undoBtn).toBeFocused();

        await checkContentState(
          ctx,
          {
            state: 'item-undo-toast',
            fullPage: true,
            allowedHorizontalScrollSelectors: [`[data-testid="json-table-host-${jsonEntryId}"]`],
          },
          [
            '[data-testid="undo-toast-item"]',
            '[data-testid="item-header"]',
            '[data-testid="breadcrumb-item-name"]',
            `[data-testid="item-tag-chip-${TAG_LONG_50_NAME}"]`,
            `[data-testid="json-table-host-${jsonEntryId}"]`,
          ],
        );

        if (ctx.keyboard) {
          // Verify that typing in an active textarea does NOT trigger toast Undo on Ctrl+Z,
          // and that pressing Ctrl+Z outside an input restores the deleted entry card, announces `restoredNotice`,
          // and focuses the restored card's menu trigger (`item-detail-page.tsx:712-713`) (plan §2.8, §2.11, ACC-A11Y1-3).
          await page.getByTestId(`entry-edit-btn-${primaryTextEntryId}`).click();
          const activeEditTextarea = page.getByTestId(`entry-edit-textarea-${primaryTextEntryId}`);
          await expect(activeEditTextarea).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await activeEditTextarea.focus();
          await page.keyboard.press('Control+z');
          // Toast is STILL visible (Ctrl+Z inside active textarea did not consume the Undo toast)
          await expect(undoToasts).toHaveCount(1);
          await activeEditTextarea.press('Escape');
          await expect(activeEditTextarea).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          // After Escape closes clean editor, focus returns to `entry-edit-btn-${primaryTextEntryId}` (outside toast stack).
          // Pressing Ctrl+Z outside an input triggers global Undo without tripping `restoreFocusIfNeeded` (`undo-toast.tsx:315-317, 539-544`),
          // allowing `onUndo` (`item-detail-page.tsx:712-713`) to restore the entry card and focus `entry-menu-trigger-${deleteTargetTextEntryId}`.
          await expect(page.getByTestId(`entry-edit-btn-${primaryTextEntryId}`)).toBeFocused();
          await page.keyboard.press('Control+z');
          await expect(undoToasts).toHaveCount(0, { timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(textCards).toHaveCount(2, {
            timeout: CONTENT_A11Y_UI_WAIT_MS,
          });
          await expect(
            page.getByTestId(`entry-menu-trigger-${deleteTargetTextEntryId}`),
          ).toBeFocused({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(page.getByTestId('item-page-live-region')).toContainText(
            msgs.content.entry.restoredNotice,
            { timeout: CONTENT_A11Y_UI_WAIT_MS },
          );
          await expect(
            page.getByTestId(`entry-card-${deleteTargetTextEntryId}`).getByTestId('entry-body'),
          ).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        } else {
          // Click Undo so all locales/themes also exercise restore cleanly
          await undoBtn.click();
          await expect(undoToasts).toHaveCount(0, { timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(textCards).toHaveCount(2, {
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
          const coarseLeakGuard = attachPlaintextLeakGuard(coarseContext, forbiddenSecrets);
          try {
            const coarsePage = await coarseContext.newPage();
            await coarsePage.goto('/app', {
              waitUntil: 'domcontentloaded',
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });
            // New browser context / page has a fresh CryptoClient Worker without the in-memory vault key: unlock via real UI first,
            // then client-navigate via `<Link>` to `/app/items/${itemId}` so decrypted JSON table & entry controls are mounted.
            await unlockLockedAppPage(coarsePage);
            await coarsePage.locator(`[data-item-card="${itemId}"]`).click();
            await expect(coarsePage).toHaveURL(new RegExp(`/app/items/${itemId}$`), {
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });
            await expect(coarsePage.getByTestId('item-header')).toBeVisible({
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });
            // Per `JsonEntryCard` (`useEntryInViewport`, Task 14 item 5), cards below the 390x844 mobile fold render
            // `entry-body-loading` until scrolled into the viewport (`IntersectionObserver` rootMargin `100px`), and then
            // mount `json-tab-table-${id}` / `json-table-host-${id}` once `useEntryBody` finishes decrypting.
            const coarseJsonCard = coarsePage.getByTestId(`entry-card-${jsonEntryId}`);
            await expect(coarseJsonCard).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
            await coarseJsonCard.scrollIntoViewIfNeeded();
            await expect(coarsePage.getByTestId(`json-tab-table-${jsonEntryId}`)).toBeVisible({
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });
            await expect(coarsePage.getByTestId(`json-table-host-${jsonEntryId}`)).toBeVisible({
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });

            // Expand `limits` (`root.p4`) on the coarse page so `.json-toggle` and child cells are visible (ACC-A11Y1-7)
            const coarseLimitsToggle = coarsePage.getByTestId('json-toggle-root.p4');
            await expect(coarseLimitsToggle).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
            await expect(coarseLimitsToggle).toHaveAttribute('aria-expanded', 'false');
            await coarseLimitsToggle.click();
            await expect(coarseLimitsToggle).toHaveAttribute('aria-expanded', 'true');

            // 1. Generic 44x44 px touch target sweep on `item` / `json-table` state
            await expectCoarseTouchTargetsAtLeast44(coarsePage, 'item-controls', [
              '[data-testid="tag-add-chip"]',
              '[data-testid="btn-add-text"]',
              '[data-testid="btn-add-json"]',
              `[data-testid="entry-menu-trigger-${primaryTextEntryId}"]`,
              `[data-testid="json-tab-table-${jsonEntryId}"]`,
              `[data-testid="json-tab-raw-${jsonEntryId}"]`,
              `[data-testid="item-tag-remove-${TAG_LONG_50_NAME}"]`,
              `[data-testid="json-table-host-${jsonEntryId}"] .json-toggle`,
              `[data-testid="json-table-host-${jsonEntryId}"] .json-cell-btn`,
            ]);

            // 2. Open entry `...` menu and sweep `entry-menu` state
            await coarsePage.getByTestId(`entry-menu-trigger-${primaryTextEntryId}`).click();
            await expect(
              coarsePage.getByTestId(`entry-menu-pop-${primaryTextEntryId}`),
            ).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
            await expectCoarseTouchTargetsAtLeast44(coarsePage, 'entry-menu-items', [
              `[data-testid="entry-menu-pop-${primaryTextEntryId}"] [role="menuitem"]`,
            ]);
            await coarsePage.keyboard.press('Escape');
            await expect(
              coarsePage.getByTestId(`entry-menu-pop-${primaryTextEntryId}`),
            ).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
            // 3. Open text entry inline editor and sweep `text-edit` state
            await coarsePage.getByTestId(`entry-edit-btn-${primaryTextEntryId}`).click();
            await expect(
              coarsePage.getByTestId(`entry-edit-textarea-${primaryTextEntryId}`),
            ).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
            await expectCoarseTouchTargetsAtLeast44(coarsePage, 'text-edit-controls', [
              `[data-testid="entry-save-btn-${primaryTextEntryId}"]`,
              `[data-testid="entry-cancel-btn-${primaryTextEntryId}"]`,
            ]);
            await coarsePage.getByTestId(`entry-cancel-btn-${primaryTextEntryId}`).click();

            // 4. Open cell edit in JSON table to sweep `.json-type-btn` (`json-type-select-root.p0`)
            await coarsePage.getByTestId('json-cell-btn-root.p0').click();
            await expect(coarsePage.getByTestId('json-type-select-root.p0')).toBeVisible({
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });
            await expectCoarseTouchTargetsAtLeast44(coarsePage, 'json-cell-editor-type', [
              `[data-testid="json-table-host-${jsonEntryId}"] .json-type-btn`,
            ]);
            await coarsePage.keyboard.press('Escape');
            await expect(coarsePage.getByTestId('json-type-select-root.p0')).toBeHidden({
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });
            // 5. Switch JSON card to Raw JSON view and sweep `json-raw` state
            await coarsePage.getByTestId(`json-tab-raw-${jsonEntryId}`).click();
            await expect(
              coarsePage.getByTestId(`json-raw-textarea-${jsonEntryId}`),
            ).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
            await expectCoarseTouchTargetsAtLeast44(coarsePage, 'json-raw-controls', [
              `[data-testid="json-raw-format-btn-${jsonEntryId}"]`,
              `[data-testid="json-raw-save-btn-${jsonEntryId}"]`,
            ]);
            await coarsePage.getByTestId(`json-tab-table-${jsonEntryId}`).click();

            // ACC-A11Y1-2: DOM attribute scan + network leak guard on coarseContext
            await expectNoPlaintextInDomAttributes(coarsePage, forbiddenSecrets);
            coarseLeakGuard.assertNoLeaks();
          } finally {
            await coarseContext.close();
          }
        },
      );
    }

    await expectNoPlaintextInDomAttributes(page, forbiddenSecrets);
    leakGuard.assertNoLeaks();
    leakGuard.assertSawEntriesPost();
    // T17: U14 import dialog sweep goes here
  } finally {
    await context.close();
  }
}

test.describe('P04-T21c Item page + text/JSON entries + menu + Undo toast a11y & visual sweep (U11-U13, U18)', () => {
  test.describe.configure({ retries: 1 });
  test.skip(
    !process.env.E2E_STACK,
    'needs the compose stack (E2E_STACK=1): real API, real database',
  );
  test.skip(
    process.env.E2E_CONTENT_A11Y !== '1',
    'runs only in the Content a11y CI job (E2E_CONTENT_A11Y=1)',
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
