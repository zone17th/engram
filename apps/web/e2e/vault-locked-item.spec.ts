import { expect, test } from '@playwright/test';
import { DEMO_ITEMS } from '../lib/demo-fixtures';
import { UI_WAIT_MS, findBodyLeaks, installApiMocks, unlockFromBanner } from './vault-locked-support';

/**
 * P03-T21 locked state U5 item page (`/app/items/<id>`), split from `vault-locked.spec.ts` (P4FE3-1, P4FE4-1).
 */
const BODIES = DEMO_ITEMS.map((item) => item.preview);

test.describe('P03-T21 Locked state U5', () => {
  test('locked item page shows title, tags and type with a masked body and no plaintext in the DOM; unlock shows the body', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    try {
      await installApiMocks(context);
      const page = await context.newPage();
      const item = DEMO_ITEMS[0];

      await page.goto(`/app/items/${item.id}`);
      await expect(page.getByRole('heading', { level: 1, name: item.title })).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.getByTestId('item-article')).toBeVisible();
      await expect(page.getByTestId('entry-body-locked')).toHaveCount(1);
      await expect(page.getByTestId('entry-body-locked')).toContainText('🔒 ••••••');
      await expect(page.getByTestId('entry-body')).toHaveCount(0);
      await expect(page.locator('.vault-pill')).toHaveAttribute('data-vault-state', 'locked');
      for (const tag of item.tags) {
        await expect(page.getByTestId('item-tags')).toContainText(`#${tag}`);
      }
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);
      expect(await page.locator('textarea, [contenteditable]:not([contenteditable="false"])').count()).toBe(0);

      await unlockFromBanner(page);
      await expect(page).toHaveURL(new RegExp(`/app/items/${item.id}$`), { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body')).toHaveText(item.preview, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body-locked')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
