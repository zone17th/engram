import type { BrowserContext } from '@playwright/test';
import type { Entry, EntryMeta, ItemSummary } from '../lib/api/content';
import rawFixture from './fixtures/locked-item-entries.json';

export interface LockedItemEntriesFixture {
  readonly item: ItemSummary;
  readonly entries: ReadonlyArray<{
    readonly meta: EntryMeta;
    readonly entry: Entry;
    readonly plaintext: string;
  }>;
}

export const LOCKED_ITEM_FIXTURE: LockedItemEntriesFixture =
  rawFixture as unknown as LockedItemEntriesFixture;

export const LOCKED_ITEM_BODIES: readonly string[] = LOCKED_ITEM_FIXTURE.entries.map(
  (entry) => entry.plaintext,
);
// Registers content API mocks (`GET /items/{id}`, `GET /items/{id}/entries`, `GET /entries/{id}`,
// and `GET /tags`) on top of `installApiMocks` / `installVisualApiMocks` (`e2e/vault-locked-support.ts`
// is frozen per P4FE5-3).
//
// Because Playwright evaluates later `context.route(...)` registrations first, these handlers
// intercept the real item page's requests before the catch-all `/api/v1/` handler in
// `vault-locked-support.ts`.
export async function installItemPageContentMocks(
  context: BrowserContext,
  fixture: LockedItemEntriesFixture = LOCKED_ITEM_FIXTURE,
): Promise<void> {
  const { item, entries } = fixture;
  const entryById = new Map<string, Entry>(
    entries.map((record) => [record.entry.id, record.entry]),
  );
  const entryMetaList = {
    items: entries.map((record) => record.meta),
    next_cursor: null,
  };

  await context.route(`**/api/v1/items/${item.id}`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(item),
      });
      return;
    }
    await route.fallback();
  });

  await context.route(`**/api/v1/items/${item.id}/entries*`, async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(entryMetaList),
      });
      return;
    }
    await route.fallback();
  });

  await context.route('**/api/v1/entries/*', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      const url = new URL(request.url());
      const entryId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      const entry = entryById.get(entryId);
      if (entry) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(entry),
        });
        return;
      }
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://engram.zone17.click/problems/not_found',
          title: 'not_found',
          status: 404,
          code: 'not_found',
        }),
      });
      return;
    }
    await route.fallback();
  });

  await context.route('**/api/v1/tags*', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: item.tags.map((tag) => ({
            id: tag.id,
            display: tag.display,
            item_count: 1,
            created_at: item.created_at,
            last_used_at: item.last_used_at,
          })),
          next_cursor: null,
        }),
      });
      return;
    }
    await route.fallback();
  });
}
