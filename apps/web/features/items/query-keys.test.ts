import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_ENTRIES_QUERY_KEY_PREFIX,
  CONTENT_ITEM_QUERY_KEY_PREFIX,
  CONTENT_ITEMS_QUERY_KEY_PREFIX,
  CONTENT_LOOKUP_QUERY_KEY_PREFIX,
  CONTENT_QUERY_KEY_PREFIX,
  CONTENT_QUERY_OPTIONS,
  CONTENT_TAGS_QUERY_KEY_PREFIX,
  configureContentQueryDefaults,
  contentQueryKeys,
} from './query-keys';

describe('features/items/query-keys', () => {
  it('constructs exact query keys per plan §2.10', () => {
    expect(contentQueryKeys.all).toEqual(['content']);
    expect(contentQueryKeys.items({ sort: 'recent', tagId: 'tag-1', q: 'wifi' })).toEqual([
      'content',
      'items',
      { sort: 'recent', tagId: 'tag-1', q: 'wifi' },
    ]);
    expect(contentQueryKeys.items()).toEqual([
      'content',
      'items',
      { sort: undefined, tagId: undefined, q: undefined },
    ]);
    expect(contentQueryKeys.item('item-123')).toEqual(['content', 'item', 'item-123']);
    expect(contentQueryKeys.lookup('wifi')).toEqual(['content', 'lookup', 'wifi']);
    expect(contentQueryKeys.tags({ sort: 'alpha', q: 'nh' })).toEqual([
      'content',
      'tags',
      { sort: 'alpha', q: 'nh' },
    ]);
    expect(contentQueryKeys.tags()).toEqual([
      'content',
      'tags',
      { sort: undefined, q: undefined },
    ]);
    expect(contentQueryKeys.entries('item-123')).toEqual(['content', 'entries', 'item-123']);
  });

  it('exposes stable prefixes for targeted invalidation and removal', () => {
    expect(contentQueryKeys.itemsAll()).toBe(CONTENT_ITEMS_QUERY_KEY_PREFIX);
    expect(contentQueryKeys.itemAll()).toBe(CONTENT_ITEM_QUERY_KEY_PREFIX);
    expect(contentQueryKeys.lookupAll()).toBe(CONTENT_LOOKUP_QUERY_KEY_PREFIX);
    expect(contentQueryKeys.tagsAll()).toBe(CONTENT_TAGS_QUERY_KEY_PREFIX);
    expect(contentQueryKeys.entriesAll()).toBe(CONTENT_ENTRIES_QUERY_KEY_PREFIX);
  });

  it('enables refetchOnWindowFocus and refetchOnReconnect for content queries only', () => {
    expect(CONTENT_QUERY_OPTIONS).toEqual({
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    });

    const client = new QueryClient({
      defaultOptions: {
        queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
      },
    });

    configureContentQueryDefaults(client);

    expect(client.getQueryDefaults(CONTENT_QUERY_KEY_PREFIX)).toMatchObject({
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    });
    expect(client.getQueryDefaults(contentQueryKeys.items({ sort: 'recent' }))).toMatchObject({
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    });
    expect(client.getQueryDefaults(['vault', 'body', 'entry-1'])).toBeUndefined();
  });
});
