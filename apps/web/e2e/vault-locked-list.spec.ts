import { expect, test, type Page } from '@playwright/test';
import { DEMO_ITEMS } from '../lib/demo-fixtures';
import { MOCKED_HOME_ITEMS, installHomeContentMetadataRoutes } from './content-home-support';
import { UI_WAIT_MS, findBodyLeaks, installApiMocks, unlockFromBanner } from './vault-locked-support';

/**
 * P03-T21 locked state U5 list (`/app`), ported to P04 Task 19 home recent grid (P4FE3-1, P4FE4-1, Q6 / advisor-dec-104).
 * Cards on `/app` show item name, up to 3 tag chips, and entry count only — entry bodies are never fetched or rendered on the home grid.
 */
const BODIES = DEMO_ITEMS.map((item) => item.preview);

async function expectLockedList(page: Page) {
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
  await expect(page.locator('.vault-pill')).toHaveAttribute('data-vault-state', 'locked', { timeout: UI_WAIT_MS });
  await expect(page.locator('.vault-pill')).toHaveClass(/vault-shut/);
  await expect(page.getByTestId('item-card')).toHaveCount(MOCKED_HOME_ITEMS.length, { timeout: UI_WAIT_MS });
  await expect(page.getByTestId('entry-body-locked')).toHaveCount(0);
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
      await installHomeContentMetadataRoutes(context);
      const page = await context.newPage();

      // Fresh context = locked vault. The recent grid stays on screen with names, tag chips, and entry counts; no bodies on home.
      await page.goto('/app');
      await expectLockedList(page);
      for (const item of MOCKED_HOME_ITEMS) {
        await expect(page.getByRole('heading', { name: item.name })).toBeVisible();
      }
      await expect(page.getByTestId('item-card').first()).toContainText(`#${MOCKED_HOME_ITEMS[0].tags[0].display}`);
      await expect(page.getByTestId('item-card').first()).toContainText('1 entry');
      expect(await page.locator('textarea, [contenteditable]:not([contenteditable="false"])').count()).toBe(0);

      // Unlock (real Worker): home grid still holds no bodies (Q6), and no attribute or dataset carries a body.
      await unlockFromBanner(page);
      await expect(page).toHaveURL(/\/app$/, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('item-card')).toHaveCount(MOCKED_HOME_ITEMS.length, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body')).toHaveCount(0);
      await expect(page.getByTestId('entry-body-locked')).toHaveCount(0);
      await expect(page.getByTestId('vault-locked-banner')).toHaveCount(0);
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);

      // Lock now (header pill): the list stays with names and tags, still no body leaks.
      await page.getByTestId('vault-lock-button').click();
      await expectLockedList(page);
      await expect(page).toHaveURL(/\/app$/);

      // Unlock again: list stays intact with no bodies on the home grid.
      await unlockFromBanner(page);
      await expect(page.getByTestId('item-card')).toHaveCount(MOCKED_HOME_ITEMS.length, { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body')).toHaveCount(0);
      await expect(page.getByTestId('entry-body-locked')).toHaveCount(0);
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
