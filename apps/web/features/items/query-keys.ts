import type { QueryClient } from '@tanstack/react-query';
import type { ContentSort } from '@/lib/api/content';

export type { ContentSort };

export interface ContentItemsListKeyParams {
  readonly sort?: ContentSort;
  readonly tagId?: string;
  readonly q?: string;
}

export interface ContentTagsListKeyParams {
  readonly sort?: ContentSort;
  readonly q?: string;
}

/** Root prefix for all non-secret content metadata queries (`['content', ...]`). */
export const CONTENT_QUERY_KEY_PREFIX = ['content'] as const;

/** Prefix for all item list queries (`['content', 'items', ...]`). */
export const CONTENT_ITEMS_QUERY_KEY_PREFIX = ['content', 'items'] as const;

/** Prefix for all single-item detail queries (`['content', 'item', ...]`). */
export const CONTENT_ITEM_QUERY_KEY_PREFIX = ['content', 'item'] as const;

/** Prefix for all exact item-name lookup queries (`['content', 'lookup', ...]`). */
export const CONTENT_LOOKUP_QUERY_KEY_PREFIX = ['content', 'lookup'] as const;

/** Prefix for all tag list queries (`['content', 'tags', ...]`). */
export const CONTENT_TAGS_QUERY_KEY_PREFIX = ['content', 'tags'] as const;

/**
 * Prefix for all entry metadata list queries (`['content', 'entries', ...]`).
 * Holds `EntryMeta` only — never envelope, ciphertext, or decrypted plaintext body.
 */
export const CONTENT_ENTRIES_QUERY_KEY_PREFIX = ['content', 'entries'] as const;

export const CONTENT_QUERY_OPTIONS = {
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
} as const;

export type ContentItemsQueryKey = readonly [
  'content',
  'items',
  {
    readonly sort: ContentSort | undefined;
    readonly tagId: string | undefined;
    readonly q: string | undefined;
  },
];
export type ContentItemQueryKey = readonly ['content', 'item', string];
export type ContentLookupQueryKey = readonly ['content', 'lookup', string];
export type ContentTagsQueryKey = readonly [
  'content',
  'tags',
  {
    readonly sort: ContentSort | undefined;
    readonly q: string | undefined;
  },
];
export type ContentEntriesQueryKey = readonly ['content', 'entries', string];

export const contentQueryKeys = {
  all: CONTENT_QUERY_KEY_PREFIX,

  itemsAll: () => CONTENT_ITEMS_QUERY_KEY_PREFIX,
  items: (params: ContentItemsListKeyParams = {}): ContentItemsQueryKey =>
    [
      'content',
      'items',
      {
        sort: params.sort,
        tagId: params.tagId,
        q: params.q,
      },
    ] as const,

  itemAll: () => CONTENT_ITEM_QUERY_KEY_PREFIX,
  item: (id: string): ContentItemQueryKey => ['content', 'item', id] as const,

  lookupAll: () => CONTENT_LOOKUP_QUERY_KEY_PREFIX,
  lookup: (name: string): ContentLookupQueryKey => ['content', 'lookup', name] as const,

  tagsAll: () => CONTENT_TAGS_QUERY_KEY_PREFIX,
  tags: (params: ContentTagsListKeyParams = {}): ContentTagsQueryKey =>
    [
      'content',
      'tags',
      {
        sort: params.sort,
        q: params.q,
      },
    ] as const,

  entriesAll: () => CONTENT_ENTRIES_QUERY_KEY_PREFIX,
  /** Entry metadata list key (`EntryMeta` only — never envelope/ciphertext/plaintext). */
  entries: (itemId: string): ContentEntriesQueryKey => ['content', 'entries', itemId] as const,
} as const;

/**
 * Applies `refetchOnWindowFocus: true` and `refetchOnReconnect: true` to the `['content', ...]`
 * query key prefix on a `QueryClient` without changing global defaults for auth/vault queries.
 */
export function configureContentQueryDefaults(queryClient: QueryClient): void {
  queryClient.setQueryDefaults(CONTENT_QUERY_KEY_PREFIX, {
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}
