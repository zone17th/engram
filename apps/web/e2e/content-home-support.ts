import { expect, type BrowserContext, type Page } from '@playwright/test';
import { DEMO_ITEMS, DEMO_TAGS } from '../lib/demo-fixtures';
import type { ItemSummary, Tag } from '../lib/api/content';
import { STEP_TIMEOUT, type Theme } from './vault-locked-support';

/**
 * Shared mocked content metadata for `/app` locked-list E2E specs (`vault-locked-list.spec.ts` and
 * `vault-locked-visual-list.spec.ts`) while keeping `vault-locked-support.ts` frozen in W3 (P4FE5-3, Task 19).
 *
 * Per Q6 / advisor-dec-104, the home recent grid renders only item name, up to 3 tag chips, and entry count
 * (never entry bodies or body masks).
 */
export const MOCKED_HOME_TAGS: readonly Tag[] = DEMO_TAGS.map((tag, index) => ({
  id: `00000000-0000-4000-8000-00000000010${index + 1}`,
  display: tag.name,
  item_count: tag.count,
  last_used_at: '2026-10-30T00:00:00Z',
  created_at: '2026-10-30T00:00:00Z',
}));

const TAG_BY_DISPLAY = new Map(MOCKED_HOME_TAGS.map((tag) => [tag.display, tag]));

export const MOCKED_HOME_ITEMS: readonly ItemSummary[] = DEMO_ITEMS.map((item, index) => ({
  id: `00000000-0000-4000-8000-00000000020${index + 1}`,
  name: item.title,
  hint: null,
  tags: item.tags.map((tagName, tagIdx) => {
    const matched = TAG_BY_DISPLAY.get(tagName);
    return {
      id: matched?.id ?? `00000000-0000-4000-8000-0000000003${index}${tagIdx}`,
      display: tagName,
    };
  }),
  entry_count: index + 1,
  version: 1,
  created_at: '2026-10-30T00:00:00Z',
  updated_at: '2026-10-30T00:00:00Z',
  last_used_at: '2026-10-30T00:00:00Z',
}));

export async function installHomeContentMetadataRoutes(context: BrowserContext): Promise<void> {
  await context.route('**/api/v1/tags*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: MOCKED_HOME_TAGS,
        next_cursor: null,
      }),
    });
  });

  await context.route('**/api/v1/items*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    const tagId = url.searchParams.get('tag_id');
    const filtered = tagId
      ? MOCKED_HOME_ITEMS.filter((item) => item.tags.some((t) => t.id === tagId))
      : MOCKED_HOME_ITEMS;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: filtered,
        next_cursor: null,
      }),
    });
  });
}

export async function gotoLockedHomeList(page: Page, route: string, theme: Theme): Promise<void> {
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme, { timeout: STEP_TIMEOUT });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: STEP_TIMEOUT });
  await expect(page.getByTestId('vault-locked-banner')).toBeVisible({ timeout: STEP_TIMEOUT });
  await expect(page.getByTestId('item-card').first()).toBeVisible({ timeout: STEP_TIMEOUT });
  await expect(page.getByTestId('entry-body')).toHaveCount(0);
  await expect(page.getByTestId('entry-body-locked')).toHaveCount(0);
}
