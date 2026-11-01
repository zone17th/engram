import { expect, test, type Page } from '@playwright/test';
import { DEMO_ITEMS } from '../lib/demo-fixtures';
import { UI_WAIT_MS, findBodyLeaks, installApiMocks, unlockFromBanner } from './vault-locked-support';

/**
 * P03-T21 locked state U5 list (`/app`), split from `vault-locked.spec.ts` (P4FE3-1, P4FE4-1).
 */
const BODIES = DEMO_ITEMS.map((item) => item.preview);

async function expectLockedList(page: Page) {
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
  await expect(page.locator('.vault-pill')).toHaveAttribute('data-vault-state', 'locked', { timeout: UI_WAIT_MS });
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-shut/);
  await expect(page.getByTestId('item-card')).toHaveCount(DEMO_ITEMS.length);
  await expect(page.getByTestId('entry-body-locked')).toHaveCount(DEMO_ITEMS.length);
  await expect(page.getByTestId('entry-body')).toHaveCount(0);
  expect(await findBodyLeaks(page, BODIES)).toEqual([]);
}

test.describe('P03-T21 Locked state U5', () => {
  test('locked list keeps name/tag/type, masks bodies with no plaintext in the DOM; unlock -> bodies; lock -> bodies gone; unlock again -> bodies', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    try {
      await installApiMocks(context);
      const page = await context.newPage();

      // Fresh context = locked vault. The list stays on screen with names, tags and types; bodies are masked.
      await page.goto('/app');
      await expectLockedList(page);
      await expect(page.getByTestId('entry-body-locked').first()).toContainText('🔒 ••••••');
      for (const item of DEMO_ITEMS) {
        await expect(page.getByRole('heading', { name: item.title })).toBeVisible();
      }
      await expect(page.getByTestId('item-card').first()).toContainText(`#${DEMO_ITEMS[0].tags[0]}`);
      await expect(page.getByTestId('item-card').first()).toContainText(DEMO_ITEMS[0].kind.toUpperCase());
      expect(await page.locator('textarea, [contenteditable]:not([contenteditable="false"])').count()).toBe(0);

      // Unlock (real Worker): every body is on screen, and still no attribute or dataset carries a body.
      await unlockFromBanner(page);
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body')).toHaveCount(DEMO_ITEMS.length, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body-locked')).toHaveCount(0);
      await expect(page.getByTestId('entry-body').first()).toHaveText(DEMO_ITEMS[0].preview);
      await expect(page.getByTestId('vault-locked-banner')).toHaveCount(0);
      const unlockedLeaks = await findBodyLeaks(page, BODIES);
      expect(unlockedLeaks.filter((leak) => leak.startsWith('attribute') || leak.startsWith('dataset'))).toEqual([]);

      // Lock now (header pill): bodies leave the DOM, the list stays.
      await page.getByTestId('vault-lock-button').click();
      await expectLockedList(page);
      await expect(page).toHaveURL(/\/app$/);

      // Unlock again: bodies come back.
      await unlockFromBanner(page);
      await expect(page.getByTestId('entry-body')).toHaveCount(DEMO_ITEMS.length, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body').first()).toHaveText(DEMO_ITEMS[0].preview);
    } finally {
      await context.close();
    }
  });
});
