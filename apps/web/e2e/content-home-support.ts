import { expect, type BrowserContext, type Page } from '@playwright/test';
import { DEMO_ITEMS, DEMO_TAGS } from '../lib/demo-fixtures';
import type { ItemSummary, Tag } from '../lib/api/content';
import { STEP_TIMEOUT, type Theme } from './vault-locked-support';
import { normalizeForPrefixMatch } from '../features/omnibox/search-helpers';

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
    const url = new URL(route.request().url());
    const rawQ = url.searchParams.get('q') ?? '';
    const normQ = normalizeForPrefixMatch(rawQ);
    const filteredTags = normQ
      ? MOCKED_HOME_TAGS.filter((tag) => normalizeForPrefixMatch(tag.display).startsWith(normQ))
      : MOCKED_HOME_TAGS;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: filteredTags,
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
    const rawQ = url.searchParams.get('q') ?? '';
    const normQ = normalizeForPrefixMatch(rawQ);
    const filtered = MOCKED_HOME_ITEMS.filter((item) => {
      if (tagId && !item.tags.some((t) => t.id === tagId)) {
        return false;
      }
      if (normQ && !normalizeForPrefixMatch(item.name).startsWith(normQ)) {
        return false;
      }
      return true;
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: filtered,
        next_cursor: null,
      }),
    });
  });

  await context.route('**/api/v1/suggest*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    const scope = (url.searchParams.get('scope') ?? 'all') as 'all' | 'item' | 'tag';
    const limit = Number(url.searchParams.get('limit') ?? 8);
    const rawQ = url.searchParams.get('q') ?? '';
    const normQ = normalizeForPrefixMatch(rawQ);
    const filteredTags =
      scope === 'item'
        ? []
        : normQ
          ? MOCKED_HOME_TAGS.filter((tag) => normalizeForPrefixMatch(tag.display).startsWith(normQ))
          : MOCKED_HOME_TAGS;
    const filteredItems =
      scope === 'tag'
        ? []
        : normQ
          ? MOCKED_HOME_ITEMS.filter((item) => normalizeForPrefixMatch(item.name).startsWith(normQ))
          : MOCKED_HOME_ITEMS;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        scope,
        limit,
        mode: 'full',
        quota: { tag: 3, lexical: 6, near: 2 },
        tags: filteredTags.map((tag) => ({
          kind: 'tag',
          id: tag.id,
          display: tag.display,
          item_count: tag.item_count,
        })),
        items: filteredItems.map((item) => ({
          kind: 'item',
          id: item.id,
          name: item.name,
          entry_count: item.entry_count,
          created_at: item.created_at,
          last_used_at: item.last_used_at,
          tags: item.tags,
          tag_total: item.tags.length,
          match: 'prefix',
        })),
        has_more: false,
        lexical_partial: [],
        semantic: false,
        semantic_reason: 'disabled_server',
        near: [],
        generation: null,
      }),
    });
  });

  await context.route('**/api/v1/search*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = new URL(route.request().url());
    const scope = (url.searchParams.get('scope') ?? 'all') as 'all' | 'item' | 'tag';
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const rawQ = url.searchParams.get('q') ?? '';
    const normQ = normalizeForPrefixMatch(rawQ);
    const filteredTags =
      scope === 'item'
        ? []
        : normQ
          ? MOCKED_HOME_TAGS.filter((tag) => normalizeForPrefixMatch(tag.display).startsWith(normQ))
          : MOCKED_HOME_TAGS;
    const filteredItems =
      scope === 'tag'
        ? []
        : normQ
          ? MOCKED_HOME_ITEMS.filter((item) => normalizeForPrefixMatch(item.name).startsWith(normQ))
          : MOCKED_HOME_ITEMS;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        scope,
        limit,
        mode: 'full',
        tags: filteredTags.map((tag) => ({
          kind: 'tag',
          id: tag.id,
          display: tag.display,
          item_count: tag.item_count,
        })),
        items: filteredItems.map((item) => ({
          kind: 'item',
          id: item.id,
          name: item.name,
          entry_count: item.entry_count,
          created_at: item.created_at,
          last_used_at: item.last_used_at,
          tags: item.tags,
          tag_total: item.tags.length,
          match: 'prefix',
        })),
        next_cursor: null,
        semantic: false,
        semantic_reason: 'disabled_server',
        near: [],
        generation: null,
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

export async function installItemPageMetadataRoutes(
  context: BrowserContext,
  itemId: string = DEMO_ITEMS[1]!.id,
): Promise<void> {
  const matchedMocked = MOCKED_HOME_ITEMS.find((it) => it.id === itemId);
  const fallbackItem = matchedMocked ?? MOCKED_HOME_ITEMS[1] ?? MOCKED_HOME_ITEMS[0]!;
  const itemSummary: ItemSummary = {
    ...fallbackItem,
    id: itemId,
    name:
      matchedMocked?.name ??
      DEMO_ITEMS.find((it) => it.id === itemId)?.title ??
      fallbackItem.name,
  };

  await context.route(`**/api/v1/items/${itemId}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(itemSummary),
    });
  });

  await context.route(`**/api/v1/items/${itemId}/entries*`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: '00000000-0000-4000-8000-000000000401',
            item_id: itemId,
            type: 'text',
            position: 0,
            version: 1,
            plaintext_len_bucket: 256,
            created_at: '2026-10-30T00:00:00Z',
            updated_at: '2026-10-30T00:00:00Z',
          },
        ],
        next_cursor: null,
      }),
    });
  });
}
