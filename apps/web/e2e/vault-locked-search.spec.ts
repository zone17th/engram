import { expect, test } from '@playwright/test';
import { DEMO_ITEMS } from '../lib/demo-fixtures';
import {
  installHomeContentMetadataRoutes,
  installItemPageMetadataRoutes,
} from './content-home-support';
import { UI_WAIT_MS, findBodyLeaks, installApiMocks } from './vault-locked-support';

/**
 * P03-T21 locked state U5 search (`list search on /app` and `item header search`), split from `vault-locked.spec.ts`
 * and migrated in Task 18a to Enter-only prefix search (P4FE3-1, P4FE4-1, P4FE5-4).
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
      const bodyOnly = DEMO_ITEMS[0]!; // "phin" is only in this item's body, never in a title or tag

      await page.goto('/app');
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
      const input = page.locator('#omni textarea[data-vault-secret]');
      await expect(input).toBeVisible({ timeout: UI_WAIT_MS });

      // Name prefix query: typing sends nothing; Enter queries GET /items?q= and opens the listbox with no body.
      await input.fill('Cà phê');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await input.press('Enter');
      const listbox = page.getByRole('listbox');
      await expect(listbox).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(listbox.getByRole('option', { name: new RegExp(bodyOnly.title) })).toBeVisible();
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);

      // Body-only query: nothing matches while locked (only "Create item" option is offered), and nothing leaks.
      await input.fill('phin');
      await expect(listbox).toHaveCount(0);
      await input.press('Enter');
      await expect(listbox).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.getByTestId('omnibox-search-empty')).toBeVisible();
      await expect(listbox.getByRole('option', { name: /Create item “phin”|Tạo mục “phin”/ })).toBeVisible();
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
      await installHomeContentMetadataRoutes(context);
      await installItemPageMetadataRoutes(context, DEMO_ITEMS[1]!.id);
      const page = await context.newPage();
      const bodyOnly = DEMO_ITEMS[0]!; // "phin" is only in this item's body, never in a title or tag

      await page.goto(`/app/items/${DEMO_ITEMS[1]!.id}`);
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
      const input = page.locator('header textarea[data-vault-secret]');
      await expect(input).toBeVisible({ timeout: UI_WAIT_MS });

      // Name prefix query: typing sends nothing; Enter queries GET /items?q= and opens the listbox with no body.
      await input.fill('Cà phê');
      await expect(page.getByRole('listbox')).toHaveCount(0);
      await input.press('Enter');
      const listbox = page.getByRole('listbox');
      await expect(listbox).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(listbox.getByRole('option', { name: new RegExp(bodyOnly.title) })).toBeVisible();
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);

      // Body-only query: nothing matches while locked, and still nothing leaks.
      await input.fill('phin');
      await expect(listbox).toHaveCount(0);
      await input.press('Enter');
      await expect(listbox).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.getByTestId('omnibox-search-empty')).toBeVisible();
      await expect(listbox.getByRole('option', { name: /Create item “phin”|Tạo mục “phin”/ })).toBeVisible();
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
