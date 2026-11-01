process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';
import { newContext, uniqueEmail } from './helpers';
import {
  A11Y_LANGS,
  A11Y_THEMES,
  CONTENT_A11Y_TEST_TIMEOUT_MS,
  CONTENT_A11Y_UI_WAIT_MS,
  a11yStep,
  apiLookupItems,
  attachPlaintextLeakGuard,
  bootstrapUnlockedUser,
  checkContentState,
  expectAppAnimatesWithoutPreference,
  expectCoarseTouchTargetsAtLeast44,
  expectInputEmpty,
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
 * P04-T21c Stage W2 — Home page a11y + visual sweep (`U8` omnibox quick-add & search listbox,
 * `U9` duplicate item picker, `U10` home rail / tag filter / recent items, `U18` Undo toast on home).
 *
 * Matrix per screen state (`en`/`vi` x `light`/`dark` x `390`/`768`/`1440`):
 * - `content-a11y-home-<lang>-<theme>-<width>.png` (U10 home rail, tag filter, recent grid with 200-rune item name + 50-rune tag)
 * - `content-a11y-omnibox-open-<lang>-<theme>-<width>.png` (U8 omnibox search listbox open with prefix results)
 * - `content-a11y-picker-<lang>-<theme>-<width>.png` (U9 duplicate item name picker dialog open)
 * - `content-a11y-undo-toast-<lang>-<theme>-<width>.png` (U18 Undo toast stack on home after quick-add save)
 *
 * Keyboard pass (`en`, `light`, 1440) + Coarse-pointer touch target check (`hasTouch: true, isMobile: true` at 390):
 * - Omnibox `<textarea rows="1">` implicit role `textbox`, `aria-describedby` -> `searchHint`, `aria-controls` -> listbox ONLY when open,
 *   `aria-activedescendant` follows `ArrowDown`/`ArrowUp` and clears on `Escape`, result count in single live region,
 *   NO `role="combobox"` and NO `aria-expanded` (`advisor-dec-152`, `advisor-dec-156`, `advisor-dec-157`).
 * - Picker (`role="listbox"` inside `<dialog id="dupDialog">`), `ArrowDown`/`ArrowUp`, `Escape` closes and returns focus to omnibox,
 *   `Enter` chooses target item ID and returns focus to omnibox.
 * - Undo toast on home: focusable action button, single shared `role="status"` live region, `Ctrl+Z` undoes when focus is in the
 *   just-cleared omnibox or outside text inputs, and does NOT trigger toast Undo when typing inside a non-empty input (`plan §2.8`, `P4FE2-3`).
 */

const LONG_200_ITEM_NAME = `${'long-item-segment-'.repeat(10)}end200`.padEnd(200, 'x').slice(0, 200);
const LONG_50_TAG_NAME = `${'long-tag-segment-'.repeat(2)}end50`.padEnd(50, 't').slice(0, 50);
const DUP_ITEM_NAME = 'cluster-node';


async function quickAddEntryViaUi(
  page: Page,
  draft: string,
  expectedItemName: string,
  useCtrlEnter = false,
): Promise<void> {
  const omnibox = page.locator('#omni textarea[data-vault-secret]');
  const saveBtn = page.getByTestId('omnibox-save-now-btn');
  await setQuietValue(omnibox, draft);
  if (useCtrlEnter) {
    await omnibox.press('Control+Enter');
  } else {
    await expect(saveBtn).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
    await saveBtn.click();
  }
  await expectInputEmpty(omnibox);
  const toast = page
    .getByTestId('undo-toast-item')
    .filter({ hasText: expectedItemName })
    .first();
  await expect(toast).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
}


async function runHomeGroup(
  browser: Browser,
  testInfo: TestInfo,
  lang: A11yLang,
  theme: A11yTheme,
): Promise<void> {
  const groupLabel = `${lang}-${theme}`;
  const msgs = lang === 'vi' ? viMessages : enMessages;
  const context = await newContext(browser);

  // Synthetic public bodies for network + DOM attribute leak guards (user-dec-016)
  const bodyLongItem = `acceptance-home-long-body-${groupLabel}-alpha`;
  const bodyDup1 = `acceptance-home-dup1-body-${groupLabel}-beta`;
  const bodyDup2 = `acceptance-home-dup2-body-${groupLabel}-gamma`;
  const bodyDupPick = `acceptance-home-duppick-body-${groupLabel}-delta`;

  const forbiddenSecrets = [
    { label: 'bodyLongItem', value: bodyLongItem },
    { label: 'bodyDup1', value: bodyDup1 },
    { label: 'bodyDup2', value: bodyDup2 },
    { label: 'bodyDupPick', value: bodyDupPick },
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

    await a11yStep(`[home ${groupLabel}] signup, onboarding skip, and locale/theme setup`, async () => {
      const email = uniqueEmail(`content-a11y-home-${groupLabel}`);
      await bootstrapUnlockedUser(page, email, lang, theme);
      await expect(page.getByTestId('home-empty-state')).toBeVisible({
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });
      if (ctx.keyboard) {
        await expectAppAnimatesWithoutPreference(page);
      }
    });

    const omnibox = page.getByRole('textbox', { name: msgs.content.omnibox.ariaLabel });
    await expect(omnibox).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });

    await a11yStep(
      `[home ${groupLabel}] create real items/tags/entries via omnibox quick-add (incl. 200-rune name + 50-rune tag + duplicate items)`,
      async () => {
        // 1. Create long 200-rune item name + 50-rune tag via UI quick-add
        await quickAddEntryViaUi(
          page,
          `${LONG_200_ITEM_NAME} #${LONG_50_TAG_NAME}: ${bodyLongItem}`,
          LONG_200_ITEM_NAME.slice(0, 32),
        );

        // 2. Create 1st duplicate-named item (`cluster-node` with `#ops`)
        await quickAddEntryViaUi(
          page,
          `${DUP_ITEM_NAME} #ops: ${bodyDup1}`,
          DUP_ITEM_NAME,
        );

        // 3. Create 2nd duplicate-named item (`cluster-node` with `#prod`) via Ctrl+Enter
        await quickAddEntryViaUi(
          page,
          `${DUP_ITEM_NAME} #prod: ${bodyDup2}`,
          DUP_ITEM_NAME,
          true,
        );

        await expect(page.getByTestId('item-card')).toHaveCount(3, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expectNoPlaintextInDomAttributes(page, forbiddenSecrets);
      },
    );

    // ---- State 1: `home` (U10 home rail, tag filter, recent grid — deterministic 0 toasts, no mask over cards/omnibox) ----
    // Wait for the seed quick-add Undo toasts to auto-dismiss (UNDO_TOAST_DEFAULT_DURATION_MS = 5_000, UNDO_TOAST_KEYBOARD_DURATION_MS = 10_000)
    // after moving pointer away from the bottom-centered toast stack and blurring active focus so `paused === false` (`undo-toast.tsx:209`).
    // This makes `home`, `omnibox-open`, and `picker` 100% deterministic with 0 toasts (ACC-TV1-1, ACC-TV1-6, ACC-A11Y1-8).
    await a11yStep(`[home ${groupLabel}] settle clean U10 home state and sweep 390/768/1440`, async () => {
      await page.mouse.move(10, 10);
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      });
      await expect(page.getByTestId('undo-toast-item')).toHaveCount(0, {
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });
      await expect(page.getByTestId('item-card')).toHaveCount(3, {
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });
      await expect(page.getByTestId('rail-tag-item')).toHaveCount(3, {
        timeout: CONTENT_A11Y_UI_WAIT_MS,
      });

      await checkContentState(
        ctx,
        {
          state: 'home',
          fullPage: true,
        },
        [
          '[data-testid="item-card"]',
          '[data-testid="item-card"] h3',
          '[data-testid="item-tag-chip"]',
          '[data-testid="rail-tags"]',
          '[data-testid="rail-tag-item"]',
        ],
      );
    });

    // ---- U10 Rail tag filter & tag menu keyboard check (in keyboard pass) ----
    if (ctx.keyboard) {
      await a11yStep(`[home ${groupLabel}] U10 rail tag filter and tag menu keyboard focus return`, async () => {
        const firstTagGroup = page.getByTestId('rail-tag-item').first();
        const filterBtn = firstTagGroup.locator('[data-tag-filter]');
        const menuTrigger = firstTagGroup.locator('[data-tag-menu-btn]');

        // Filter by tag via keyboard Enter -> URL gets ?tag=<id> -> Clear filter returns to /app
        await filterBtn.focus();
        await expect(filterBtn).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\?tag=[0-9a-f-]{36}$/, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expect(filterBtn).toHaveAttribute('aria-pressed', 'true');

        const clearBtn = page.getByTestId('rail-clear-filter');
        await expect(clearBtn).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await clearBtn.focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/app$/, { timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(page.getByTestId('item-card')).toHaveCount(3, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });

        // Open rail tag menu via keyboard, navigate with ArrowDown/ArrowUp, close with Escape -> focus returns to trigger
        await menuTrigger.focus();
        await expect(menuTrigger).toBeFocused();
        await page.keyboard.press('Enter');
        const menu = firstTagGroup.getByRole('menu');
        await expect(menu).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        const menuItems = menu.getByRole('menuitem');
        await expect(menuItems.first()).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(menuItems.nth(1)).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await expect(menuItems.first()).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(menuTrigger).toBeFocused();
      });
    }

    // ---- State 2: `omnibox-open` (U8 search listbox open + advisor-dec-152/156/157 ARIA contract) ----
    await a11yStep(
      `[home ${groupLabel}] U8 omnibox search listbox state + ARIA contract (advisor-dec-152/156/157) + sweep 390/768/1440`,
      async () => {
        await setQuietValue(omnibox, DUP_ITEM_NAME);
        await omnibox.focus();

        // Pre-Enter invariants: implicit textbox role, no role="combobox", no aria-expanded, no aria-controls while closed,
        // aria-describedby -> omni-hint (searchHint visible).
        const preEnterAttrs = await omnibox.evaluate((el) => ({
          tagName: el.tagName.toUpperCase(),
          rows: el.getAttribute('rows'),
          roleAttr: el.getAttribute('role'),
          ariaExpanded: el.getAttribute('aria-expanded'),
          ariaControls: el.getAttribute('aria-controls'),
          ariaDescribedBy: el.getAttribute('aria-describedby'),
          ariaActiveDescendant: el.getAttribute('aria-activedescendant'),
          spellcheck: el.getAttribute('spellcheck'),
          autocomplete: el.getAttribute('autocomplete'),
          autocorrect: el.getAttribute('autocorrect'),
          autocapitalize: el.getAttribute('autocapitalize'),
        }));

        expect(preEnterAttrs.tagName).toBe('TEXTAREA');
        expect(preEnterAttrs.rows).toBe('1');
        expect(preEnterAttrs.roleAttr).toBeNull();
        expect(preEnterAttrs.ariaExpanded).toBeNull();
        expect(preEnterAttrs.ariaControls).toBeNull();
        expect(preEnterAttrs.ariaDescribedBy).toBe('omni-hint');
        expect(preEnterAttrs.ariaActiveDescendant).toBeNull();
        expect(preEnterAttrs.spellcheck).toBe('false');
        expect(preEnterAttrs.autocomplete).toBe('off');
        expect(preEnterAttrs.autocorrect).toBe('off');
        expect(preEnterAttrs.autocapitalize).toBe('off');
        await expect(page.getByTestId('omnibox-hint')).toBeVisible();

        // Press Enter to run prefix search and open the listbox
        await omnibox.press('Enter');
        const listbox = page.getByRole('listbox', {
          name: msgs.content.omnibox.searchListboxAriaLabel,
        });
        await expect(listbox).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        const options = listbox.getByRole('option');
        await expect(options).toHaveCount(2, { timeout: CONTENT_A11Y_UI_WAIT_MS });

        // Post-Enter open invariants: aria-controls points to omni-listbox, still no role="combobox" or aria-expanded,
        // single live region announces result count, no option active initially.
        const openAttrs = await omnibox.evaluate((el) => ({
          roleAttr: el.getAttribute('role'),
          ariaExpanded: el.getAttribute('aria-expanded'),
          ariaControls: el.getAttribute('aria-controls'),
          ariaActiveDescendant: el.getAttribute('aria-activedescendant'),
        }));
        expect(openAttrs.roleAttr).toBeNull();
        expect(openAttrs.ariaExpanded).toBeNull();
        expect(openAttrs.ariaControls).toBe('omni-listbox');
        expect(openAttrs.ariaActiveDescendant).toBeNull();

        const liveRegion = page.getByTestId('omnibox-live');
        await expect(liveRegion).toContainText(/2/);

        if (ctx.keyboard) {
          // ArrowDown moves aria-activedescendant to option 0, then option 1; ArrowUp moves back to option 0
          await page.keyboard.press('ArrowDown');
          const opt0Id = await options.nth(0).getAttribute('id');
          expect(opt0Id).toBeTruthy();
          await expect(omnibox).toHaveAttribute('aria-activedescendant', opt0Id!);
          await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');

          await page.keyboard.press('ArrowDown');
          const opt1Id = await options.nth(1).getAttribute('id');
          expect(opt1Id).toBeTruthy();
          await expect(omnibox).toHaveAttribute('aria-activedescendant', opt1Id!);
          await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');

          await page.keyboard.press('ArrowUp');
          await expect(omnibox).toHaveAttribute('aria-activedescendant', opt0Id!);
        } else {
          // Highlight first option for visual parity across locales/themes
          await page.keyboard.press('ArrowDown');
        }

        await checkContentState(ctx, { state: 'omnibox-open', fullPage: true }, [
          '#omni-pop',
          '#omni-listbox .sugg-row',
          '[data-testid="item-card"]',
          '[data-testid="item-card"] h3',
          '[data-testid="item-tag-chip"]',
        ]);

        // Escape closes listbox, removes aria-controls and aria-activedescendant, and keeps focus on omnibox
        await omnibox.focus();
        await expect(omnibox).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(listbox).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(omnibox).not.toHaveAttribute('aria-controls');
        await expect(omnibox).not.toHaveAttribute('aria-activedescendant');
        await expect(omnibox).toBeFocused();
      },
    );

    // ---- State 3: `picker` (U9 duplicate item name picker) + State 4: `undo-toast` (U18 Undo toast on home) ----
    await a11yStep(
      `[home ${groupLabel}] U9 duplicate picker sweep + keyboard navigation + U18 Undo toast sweep & Ctrl+Z`,
      async () => {
        const lookupBefore = await apiLookupItems(page, DUP_ITEM_NAME);
        expect(lookupBefore.total).toBe(2);
        const secondDupId = lookupBefore.items[1]!.id;

        const addDraft = `${DUP_ITEM_NAME}: ${bodyDupPick}`;
        await setQuietValue(omnibox, addDraft);
        await omnibox.focus();

        // Add preview shows privacy notice (user-dec-016)
        await expect(page.getByTestId('omnibox-add-preview')).toBeVisible({
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });
        await expect(page.getByTestId('omnibox-add-privacy')).toContainText(
          msgs.content.privacy.notice,
        );

        // Press Enter -> >= 2 matches opens U9 picker dialog
        await omnibox.press('Enter');
        const pickerDialog = page.getByTestId('dup-picker-dialog');
        await expect(pickerDialog).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        const pickerListbox = page.getByTestId('dup-picker-listbox');
        await expect(pickerListbox).toHaveAttribute('role', 'listbox');

        if (ctx.keyboard) {
          // Verify Escape closes picker, preserves draft, and returns focus to omnibox (plan §2.8, §2.11)
          const pickerOptions = pickerListbox.getByRole('option');
          await expect(pickerOptions).toHaveCount(3);
          await expect(pickerOptions.nth(0)).toHaveAttribute('aria-selected', 'true');

          await page.keyboard.press('ArrowDown');
          await expect(pickerOptions.nth(1)).toHaveAttribute('aria-selected', 'true');
          await expect(pickerOptions.nth(1)).toBeFocused();

          await page.keyboard.press('ArrowUp');
          await expect(pickerOptions.nth(0)).toHaveAttribute('aria-selected', 'true');
          await expect(pickerOptions.nth(0)).toBeFocused();

          await page.keyboard.press('Escape');
          await expect(pickerDialog).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(omnibox).toBeFocused();
          await expectInputEquals(omnibox, addDraft);

          // Re-open picker for the 390/768/1440 visual + axe sweep
          await omnibox.press('Enter');
          await expect(pickerDialog).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        }

        await checkContentState(
          ctx,
          { state: 'picker', axeInclude: '#dupDialog', fullPage: false },
          ['#dupDialog .dup-panel', '#dupDialog .dup-row', '#dupDialog .dup-chip'],
        );

        // Ensure 0 stale toasts exist before picking (ACC-A11Y1-8, ACC-TV1-6)
        await expect(page.getByTestId('undo-toast-item')).toHaveCount(0, {
          timeout: CONTENT_A11Y_UI_WAIT_MS,
        });

        // Choose the 2nd item (`secondDupId`) via keyboard ArrowDown + Enter (in keyboard pass) or click
        if (ctx.keyboard) {
          const firstOpt = pickerListbox.getByRole('option').first();
          await firstOpt.focus();
          await expect(firstOpt).toBeFocused();
          await page.keyboard.press('ArrowDown');
          const secondOpt = page.locator(`#dup-opt-${secondDupId}`);
          await expect(secondOpt).toHaveAttribute('aria-selected', 'true');
          await expect(secondOpt).toBeFocused();
          await secondOpt.press('Enter');
        } else {
          await page.locator(`#dup-opt-${secondDupId}`).click();
        }

        await expect(pickerDialog).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expectInputEmpty(omnibox);
        if (ctx.keyboard) {
          await expect(omnibox).toBeFocused();
        }

        // Verify U18 Undo toast appears on home with detail scope line, count 1, and 1 shared role="status" live region
        const toastStack = page.getByTestId('undo-toast-stack');
        const toastItems = page.getByTestId('undo-toast-item');
        await expect(toastItems).toHaveCount(1, { timeout: CONTENT_A11Y_UI_WAIT_MS });
        const toastItem = toastItems.first();
        await expect(toastItem).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
        await expect(toastItem).toContainText(DUP_ITEM_NAME);
        await expect(toastItem.getByTestId('undo-toast-detail')).toContainText(
          msgs.content.omnibox.savedUndoDetail,
        );
        await expect(toastStack.locator('[role="status"]')).toHaveCount(1);

        if (ctx.keyboard) {
          // ACC-A11Y1-4 (P4FE2-3, `undo-toast.tsx:511-545`):
          // 1) Immediately after quick-add save, focus is in the just-cleared omnibox (`omniboxClearedElRef.current === activeEl`
          //    and `value === ''`): pressing Ctrl+Z WITH FOCUS LEFT IN THE CLEARED OMNIBOX consumes the Undo toast!
          const lookupAfterPick = await apiLookupItems(page, DUP_ITEM_NAME);
          const secondItemAfterPick = lookupAfterPick.items.find((it) => it.id === secondDupId);
          expect(secondItemAfterPick?.entry_count).toBe(2);

          await expect(omnibox).toBeFocused();
          await expectInputEmpty(omnibox);
          await page.keyboard.press('Control+z');
          await expect(toastItems).toHaveCount(0, { timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(omnibox).toBeFocused();
          await expect
            .poll(
              async () => {
                const res = await apiLookupItems(page, DUP_ITEM_NAME);
                return res.items.find((it) => it.id === secondDupId)?.entry_count ?? -1;
              },
              { timeout: CONTENT_A11Y_UI_WAIT_MS },
            )
            .toBe(1);

          // 2) Re-create the quick-add toast via the picker so we can prove:
          //    (a) typing a character in the omnibox clears `omniboxClearedElRef` (`undo-toast.tsx:250-254`) so Ctrl+Z keeps the toast,
          //    (b) sweeping `undo-toast` across 390/768/1440, and
          //    (c) pressing Ctrl+Z on the focused Undo button consumes the toast and restores focus to the omnibox.
          await setQuietValue(omnibox, addDraft);
          await omnibox.press('Enter');
          await expect(pickerDialog).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          const firstOpt = pickerListbox.getByRole('option').first();
          await firstOpt.focus();
          await expect(firstOpt).toBeFocused();
          await page.keyboard.press('ArrowDown');
          const secondOpt2 = page.locator(`#dup-opt-${secondDupId}`);
          await expect(secondOpt2).toBeFocused();
          await secondOpt2.press('Enter');
          await expect(pickerDialog).toBeHidden({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expectInputEmpty(omnibox);
          await expect(omnibox).toBeFocused();
          await expect(toastItems).toHaveCount(1, { timeout: CONTENT_A11Y_UI_WAIT_MS });

          // Type a character into the omnibox, then press Ctrl+Z -> toast MUST remain (native input undo, not toast Undo)
          await omnibox.press('x');
          await page.keyboard.press('Control+z');
          await expect(toastItems).toHaveCount(1);
          await setQuietValue(omnibox, '');
          await expectInputEmpty(omnibox);
        }

        // Pause toast timer by focusing the Undo button so the toast remains stable across the 390/768/1440 sweep
        const undoBtn = toastItems.first().getByRole('button');
        await undoBtn.focus();
        await expect(undoBtn).toBeFocused();

        await checkContentState(ctx, { state: 'undo-toast', fullPage: true }, [
          '[data-testid="undo-toast-item"]',
          '[data-testid="item-card"]',
          '[data-testid="item-card"] h3',
          '[data-testid="item-tag-chip"]',
        ]);

        if (ctx.keyboard) {
          // Focus the Undo button in the toast stack and press Ctrl+Z -> triggers Undo, restores focus to omnibox
          await undoBtn.focus();
          await expect(undoBtn).toBeFocused();
          await page.keyboard.press('Control+z');
          await expect(toastItems).toHaveCount(0, { timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect(omnibox).toBeFocused({ timeout: CONTENT_A11Y_UI_WAIT_MS });
          await expect
            .poll(
              async () => {
                const res = await apiLookupItems(page, DUP_ITEM_NAME);
                return res.items.find((it) => it.id === secondDupId)?.entry_count ?? -1;
              },
              { timeout: CONTENT_A11Y_UI_WAIT_MS },
            )
            .toBe(1);
        }
      },
    );

    // ---- Coarse pointer touch target >= 44 px check (once, in keyboard pass) ----
    if (ctx.keyboard) {
      await a11yStep(
        `[home ${groupLabel}] coarse pointer (hasTouch: true, isMobile: true at 390) touch target >= 44 px`,
        async () => {
          const coarseContext = await newCoarseTouchContext(browser, context);
          const coarseLeakGuard = attachPlaintextLeakGuard(coarseContext, forbiddenSecrets);
          try {
            const coarsePage = await coarseContext.newPage();
            await coarsePage.goto('/app', {
              waitUntil: 'domcontentloaded',
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });
            // New browser context / page has a fresh CryptoClient Worker without the in-memory vault key: unlock via real UI first
            await unlockLockedAppPage(coarsePage);
            await expect(coarsePage.getByTestId('item-card')).toHaveCount(3, {
              timeout: CONTENT_A11Y_UI_WAIT_MS,
            });

            // 1. Generic 44x44 px touch target sweep on `home` state (plus rail controls)
            await expectCoarseTouchTargetsAtLeast44(coarsePage, 'home-rail', [
              '.tag-pill-btn',
              '.tag-menu-trigger',
            ]);

            // 2. Open omnibox search listbox (`omnibox-open` state) and sweep generic interactive controls + `[role="option"]`
            const coarseOmnibox = coarsePage.getByRole('textbox', {
              name: msgs.content.omnibox.ariaLabel,
            });
            await setQuietValue(coarseOmnibox, DUP_ITEM_NAME);
            await coarseOmnibox.press('Enter');
            await expect(
              coarsePage.getByRole('listbox', {
                name: msgs.content.omnibox.searchListboxAriaLabel,
              }),
            ).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
            await expectCoarseTouchTargetsAtLeast44(coarsePage, 'omnibox-open', ['.sugg-row']);
            await coarsePage.keyboard.press('Escape');

            // 3. Open U9 duplicate picker (`picker` state) and sweep generic interactive controls inside modal + `.dup-row`
            await setQuietValue(coarseOmnibox, `${DUP_ITEM_NAME}: ${bodyDupPick}`);
            await coarseOmnibox.press('Enter');
            const coarsePicker = coarsePage.getByTestId('dup-picker-dialog');
            await expect(coarsePicker).toBeVisible({ timeout: CONTENT_A11Y_UI_WAIT_MS });
            await expectCoarseTouchTargetsAtLeast44(coarsePage, 'picker', [
              '#dupDialog .dup-row',
              '[data-testid="dup-picker-cancel"]',
            ]);

            // 4. Pick first option -> sweep Undo toast state (`undo-toast`)
            await coarsePicker.getByRole('option').first().click();
            const coarseToast = coarsePage.getByTestId('undo-toast-item');
            await expect(coarseToast).toHaveCount(1, { timeout: CONTENT_A11Y_UI_WAIT_MS });
            await expectCoarseTouchTargetsAtLeast44(coarsePage, 'home-undo-toast', [
              '[data-testid="undo-toast-item"] button',
            ]);

            // ACC-A11Y1-2 & ACC-A11Y1-11: DOM attribute scan + network leak guard + positive control on coarseContext
            await expectNoPlaintextInDomAttributes(coarsePage, forbiddenSecrets);
            coarseLeakGuard.assertNoLeaks();
            coarseLeakGuard.assertSawEntriesPost();
          } finally {
            await coarseContext.close();
          }
        },
      );
    }

    await expectNoPlaintextInDomAttributes(page, forbiddenSecrets);
    leakGuard.assertNoLeaks();
    leakGuard.assertSawEntriesPost();
  } finally {
    await context.close();
  }
}

test.describe('P04-T21c Home a11y + visual sweep (U8, U9, U10, U18 on home)', () => {
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
      test(`home a11y + visual matrix (${lang}, ${theme})`, async ({ browser }, testInfo) => {
        test.setTimeout(CONTENT_A11Y_TEST_TIMEOUT_MS);
        await runHomeGroup(browser, testInfo, lang, theme);
      });
    }
  }
});
