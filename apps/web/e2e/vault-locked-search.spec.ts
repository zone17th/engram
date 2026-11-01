import { expect, test } from '@playwright/test';
import { DEMO_ITEMS } from '../lib/demo-fixtures';
import { installHomeContentMetadataRoutes } from './content-home-support';
import { LOCKED_ITEM_FIXTURE, installItemPageContentMocks } from './content-itempage-support';
import { UI_WAIT_MS, findBodyLeaks, installApiMocks } from './vault-locked-support';

/**
 * P03-T21 locked state U5 search (`list search on /app` and `item header search`), split from `vault-locked.spec.ts`
 * (P4FE3-1, P4FE4-1).
 */
const BODIES = DEMO_ITEMS.map((item) => item.preview);

test.describe('P03-T21 Locked state U5', () => {
  // FE1-2: suggestions are another place a body could surface. Locked search is names and tags only, with no preview text.
  test('locked list search on /app matches names and tags only and shows no body preview anywhere', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await installApiMocks(context);
      await installHomeContentMetadataRoutes(context);
      const page = await context.newPage();
      const bodyOnly = DEMO_ITEMS[0]; // "phin" is only in this item's body, never in a title or tag

      await page.goto('/app');
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
      const input = page.getByRole('combobox');
      await expect(input).toBeVisible({ timeout: UI_WAIT_MS });

      // Name query: the item is suggested, with the popover open the page still holds no body.
      await input.fill('ca phe');
      const listbox = page.getByRole('listbox');
      await expect(listbox).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(listbox.locator(`[data-search-option="${bodyOnly.id}"]`)).toBeVisible();
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);

      // Body-only query: nothing matches while locked, and still nothing leaks.
      await input.fill('phin');
      await expect(listbox).toBeVisible();
      await expect(listbox.locator('[data-search-option]')).toHaveCount(0);
      await expect(listbox.getByText('Không có mục mẫu phù hợp.')).toBeVisible();
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('locked item header search matches names and tags only and shows no body preview anywhere', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await installApiMocks(context);
      await installItemPageContentMocks(context);
      const page = await context.newPage();
      const bodyOnly = DEMO_ITEMS[0]; // "phin" is only in this item's body, never in a title or tag

      await page.goto(`/app/items/${LOCKED_ITEM_FIXTURE.item.id}`);
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
      const input = page.getByRole('combobox');
      await expect(input).toBeVisible({ timeout: UI_WAIT_MS });

      // Name query: the item is suggested, with the popover open the page still holds no body.
      await input.fill('ca phe');
      await expect(page.getByRole('listbox')).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.locator(`[data-search-option="${bodyOnly.id}"]`)).toBeVisible();
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);

      // Body-only query: nothing matches while locked, and still nothing leaks.
      await input.fill('phin');
      await expect(page.getByRole('listbox')).toBeVisible();
      await expect(page.locator('[data-search-option]')).toHaveCount(0);
      await expect(page.getByText('Không có mục mẫu phù hợp.')).toBeVisible();
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
