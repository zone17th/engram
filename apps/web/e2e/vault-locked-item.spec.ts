import { expect, test } from '@playwright/test';
import {
  LOCKED_ITEM_BODIES,
  LOCKED_ITEM_FIXTURE,
  installItemPageContentMocks,
} from './content-itempage-support';
import { UI_WAIT_MS, findBodyLeaks, installApiMocks, unlockFromBanner } from './vault-locked-support';

/**
 * P03-T21 locked state U5 item page (`/app/items/<id>`), split from `vault-locked.spec.ts` (P4FE3-1, P4FE4-1)
 * and migrated in P04-T15 to the real item page with sealed test-vector fixture entries (`locked-item-entries.json`).
 */
const BODIES = LOCKED_ITEM_BODIES;

test.describe('P03-T21 Locked state U5', () => {
  test('locked item page shows title, tags and type with a masked body and no plaintext in the DOM; unlock shows the body', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext();
    try {
      await installApiMocks(context);
      await installItemPageContentMocks(context);
      const page = await context.newPage();
      const { item, entries } = LOCKED_ITEM_FIXTURE;

      await page.goto(`/app/items/${item.id}`);
      await expect(page.getByRole('heading', { level: 1, name: item.name })).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('All items');
      await expect(page.getByTestId('item-name-input')).toHaveValue(item.name);
      await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: UI_WAIT_MS });
      await expect(page.getByTestId('vault-locked-banner')).toHaveClass(/locked-banner/);
      for (const record of entries) {
        const card = page.getByTestId(`entry-card-${record.meta.id}`);
        await expect(card).toBeVisible();
        await expect(card).toContainText(new RegExp(`\\b${record.meta.type}\\b`, 'i'));
      }
      await expect(page.getByTestId('entry-body-locked')).toHaveCount(entries.length);
      await expect(page.getByTestId('entry-body-locked').first()).toContainText('🔒 ••••••');
      await expect(page.getByTestId('entry-body')).toHaveCount(0);
      await expect(page.locator('.vault-pill')).toHaveAttribute('data-vault-state', 'locked');
      for (const tag of item.tags) {
        await expect(page.getByTestId('item-tags')).toContainText(`#${tag.display}`);
      }
      expect(await findBodyLeaks(page, BODIES)).toEqual([]);
      expect(await page.locator('textarea:not([data-omnibox-input]), [contenteditable]:not([contenteditable="false"])').count()).toBe(0);
      await expect(page.locator('textarea[data-omnibox-input]').first()).toHaveValue('');
      await expect(page.getByTestId('btn-add-text')).toBeDisabled();

      await unlockFromBanner(page);
      await expect(page).toHaveURL(new RegExp(`/app/items/${item.id}$`), { timeout: UI_WAIT_MS });
      await expect(page.getByTestId('entry-body')).toHaveCount(entries.length, { timeout: UI_WAIT_MS });
      for (let i = 0; i < entries.length; i++) {
        const record = entries[i]!;
        const card = page.getByTestId(`entry-card-${record.meta.id}`);
        if (record.meta.type === 'json') {
          await expect(card.getByTestId('json-cell-btn-root.p0')).toHaveText('postgres-prod', { timeout: UI_WAIT_MS });
          await expect(card.getByTestId('json-cell-btn-root.p1')).toHaveText('5432', { timeout: UI_WAIT_MS });
          await expect(card.getByTestId('json-cell-btn-root.p2')).toHaveText('9007199254740993', { timeout: UI_WAIT_MS });
          await card.getByTestId(`json-tab-raw-${record.meta.id}`).click();
          await expect(card.getByTestId(`json-raw-textarea-${record.meta.id}`)).toHaveValue(record.plaintext, { timeout: UI_WAIT_MS });
          await card.getByTestId(`json-tab-table-${record.meta.id}`).click();
        } else {
          await expect(page.getByTestId('entry-body').nth(i)).toHaveText(record.plaintext, { timeout: UI_WAIT_MS });
        }
      }
      await expect(page.getByTestId('entry-body-locked')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
