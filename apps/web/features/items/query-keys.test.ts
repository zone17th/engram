import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { QueryProvider } from '@/components/query-provider';
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
    expect(client.getQueryDefaults(['vault', 'body', 'entry-1'])).not.toHaveProperty('refetchOnWindowFocus');
    expect(client.getQueryDefaults(['vault', 'body', 'entry-1'])).not.toHaveProperty('refetchOnReconnect');
  });

  it('CCFE5: QueryProvider wires configureContentQueryDefaults while keeping non-content keys on their P03 defaults (refetchOnWindowFocus: false, staleTime: 30_000, retry: 1)', () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryProvider, null, children);

    const { result } = renderHook(() => useQueryClient(), { wrapper });
    const client = result.current;

    // Global defaults for non-content queries (auth, vault, recovery) remain unchanged from P03
    expect(client.getDefaultOptions().queries).toMatchObject({
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    });
    expect(client.getDefaultOptions().mutations).toMatchObject({
      retry: false,
    });

    // Non-content query keys have no per-prefix override and resolve to global defaults
    expect(client.getQueryDefaults(['vault', 'body', 'entry-1'])).not.toHaveProperty('refetchOnWindowFocus');
    expect(client.getQueryDefaults(['auth', 'me'])).not.toHaveProperty('refetchOnWindowFocus');
    expect(
      client.defaultQueryOptions({ queryKey: ['vault', 'body', 'entry-1'] }).refetchOnWindowFocus,
    ).toBe(false);

    // Content query keys receive refetchOnWindowFocus: true and refetchOnReconnect: true
    expect(client.getQueryDefaults(contentQueryKeys.items({ sort: 'recent' }))).toMatchObject({
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    });
    expect(
      client.defaultQueryOptions({ queryKey: contentQueryKeys.items({ sort: 'recent' }) })
        .refetchOnWindowFocus,
    ).toBe(true);
    expect(
      client.defaultQueryOptions({ queryKey: contentQueryKeys.tags({ sort: 'alpha' }) })
        .refetchOnReconnect,
    ).toBe(true);
  });
});
