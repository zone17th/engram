import { describe, expect, it } from 'vitest';
import {
  SEARCH_QUERY_CACHE_OPTIONS,
  SEARCH_QUERY_GC_TIME_MS,
  SEARCH_QUERY_KEY_PREFIX,
  SEARCH_QUERY_STALE_TIME_MS,
  buildSearchQueryKey,
  buildSuggestQueryKey,
  isCacheableSearchResponse,
  isSearchQueryKeyPrefix,
} from './query-keys';

describe('features/omnibox/suggest/query-keys', () => {
  it('every key has userId', () => {
    const suggestKey = buildSuggestQueryKey({
      userId: 'user-123',
      scope: 'all',
      limit: 8,
      requestMode: 'hybrid',
      semanticSuggestSetting: true,
      generationId: 2,
      qn: 'wifi',
    });
    expect(suggestKey).toEqual([
      'search',
      'user-123',
      'suggest',
      'all',
      8,
      'hybrid',
      true,
      2,
      'wifi',
    ]);
    expect(suggestKey?.[1]).toBe('user-123');

    const searchKey = buildSearchQueryKey({
      userId: 'user-123',
      scope: 'item',
      limit: 20,
      requestMode: 'lex',
      semanticSuggestSetting: false,
      generationId: null,
      qn: 'router',
      cursor: 'cursor-abc',
    });
    expect(searchKey).toEqual([
      'search',
      'user-123',
      'search',
      'item',
      20,
      'lex',
      false,
      '-',
      'router',
      'cursor-abc',
    ]);
    expect(searchKey?.[1]).toBe('user-123');
  });

  it('no key with q only', () => {
    for (const missingUserId of [null, undefined, '', '   ']) {
      expect(
        buildSuggestQueryKey({
          userId: missingUserId,
          scope: 'all',
          limit: 8,
          requestMode: 'lex',
          semanticSuggestSetting: false,
          qn: 'secret-query',
        }),
      ).toBeNull();

      expect(
        buildSearchQueryKey({
          userId: missingUserId,
          scope: 'all',
          limit: 20,
          requestMode: 'lex',
          semanticSuggestSetting: false,
          qn: 'secret-query',
        }),
      ).toBeNull();
    }
  });

  it('forces requestMode=lex on cursor pages and matches ["search"] prefix for cache clearing', () => {
    const cursorKey = buildSearchQueryKey({
      userId: 'u-1',
      scope: 'all',
      limit: 20,
      requestMode: 'hybrid',
      semanticSuggestSetting: true,
      generationId: 1,
      qn: 'wifi',
      cursor: 'next-page-token',
    });
    expect(cursorKey).not.toBeNull();
    expect(cursorKey?.[5]).toBe('lex');
    expect(cursorKey?.[9]).toBe('next-page-token');

    expect(isSearchQueryKeyPrefix(SEARCH_QUERY_KEY_PREFIX)).toBe(true);
    expect(isSearchQueryKeyPrefix(cursorKey!)).toBe(true);
    expect(isSearchQueryKeyPrefix(['content', 'items', { q: 'wifi' }])).toBe(false);
    expect(isSearchQueryKeyPrefix([])).toBe(false);

    expect(SEARCH_QUERY_STALE_TIME_MS).toBe(30_000);
    expect(SEARCH_QUERY_GC_TIME_MS).toBe(60_000);
    expect(SEARCH_QUERY_CACHE_OPTIONS).toEqual({
      staleTime: 30_000,
      gcTime: 60_000,
    });
  });

  it('marks responses with non-empty lexical_partial as non-cacheable', () => {
    expect(
      isCacheableSearchResponse({
        scope: 'all',
        limit: 8,
        mode: 'full',
        quota: { tag: 3, lexical: 6, near: 2 },
        tags: [],
        items: [],
        has_more: false,
        lexical_partial: ['item'],
        semantic: false,
        semantic_reason: 'disabled_server',
        near: [],
        generation: null,
      }),
    ).toBe(false);

    expect(
      isCacheableSearchResponse({
        scope: 'all',
        limit: 8,
        mode: 'full',
        quota: { tag: 3, lexical: 6, near: 2 },
        tags: [],
        items: [],
        has_more: false,
        lexical_partial: [],
        semantic: false,
        semantic_reason: 'disabled_server',
        near: [],
        generation: null,
      }),
    ).toBe(true);
  });
});
