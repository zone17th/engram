'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  CONTENT_QUERY_OPTIONS,
  contentQueryKeys,
  type ContentTagsQueryKey,
} from '@/features/items/query-keys';
import { tagsList, type ContentSort, type Tag, type TagList } from '@/lib/api/content';

export type { Tag, TagList, ContentTagsQueryKey };

export interface UseTagsListOptions {
  readonly sort?: ContentSort;
  readonly q?: string;
  readonly limit?: number;
  readonly enabled?: boolean;
}

/**
 * Fetches the user's active tag catalog (`GET /tags`) under the shared `['content', 'tags', { sort, q }]`
 * query key (plan §2.10, Task 19). Reused by the rail on `/app` and the item page tag suggester.
 */
export function useTagsList(options: UseTagsListOptions = {}): UseQueryResult<TagList, unknown> {
  const { sort = 'recent', q, limit, enabled = true } = options;
  return useQuery({
    queryKey: contentQueryKeys.tags({ sort, q }),
    queryFn: ({ signal }) => tagsList({ sort, q, limit, signal }),
    enabled,
    ...CONTENT_QUERY_OPTIONS,
  });
}

export interface UsePaginatedTagsListResult {
  readonly query: UseQueryResult<TagList, unknown>;
  readonly tags: readonly Tag[];
  readonly hasMore: boolean;
  readonly isLoadingMore: boolean;
  readonly loadMoreError: unknown;
  readonly loadMore: () => Promise<void>;
}

/**
 * Wraps `useTagsList` (keeping the shared first-page `['content', 'tags', { sort, q }]` query key
 * and `useTagsList` signature intact for the itempage seam) while managing additional cursor pages
 * (`next_cursor`) for the `/app` tag rail ("Show more" / HM19-R1-4).
 */
export function usePaginatedTagsList(
  options: UseTagsListOptions = {},
): UsePaginatedTagsListResult {
  const { sort = 'recent', q, limit, enabled = true } = options;
  const query = useTagsList(options);

  const [extraPages, setExtraPages] = useState<TagList[]>([]);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<unknown>(null);
  const prevDataRef = useRef<TagList | undefined>(query.data);
  const prevKeyRef = useRef({ sort, q, limit, enabled });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const prevKey = prevKeyRef.current;
    if (
      prevKey.sort !== sort ||
      prevKey.q !== q ||
      prevKey.limit !== limit ||
      prevKey.enabled !== enabled
    ) {
      prevKeyRef.current = { sort, q, limit, enabled };
      prevDataRef.current = query.data;
      abortRef.current?.abort();
      abortRef.current = null;
      setExtraPages([]);
      setIsLoadingMore(false);
      setLoadMoreError(null);
      return;
    }

    if (prevDataRef.current === query.data) {
      return;
    }
    prevDataRef.current = query.data;
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoadingMore(false);
    setLoadMoreError(null);

    if (!query.data) {
      setExtraPages([]);
      return;
    }

    const firstIds = new Set(query.data.items.map((tag) => tag.id));
    setExtraPages((prev) => {
      if (prev.length === 0) return prev;
      const seen = new Set(firstIds);
      const nextPages: TagList[] = [];
      for (const page of prev) {
        const remainingItems = page.items.filter((tag) => {
          if (seen.has(tag.id)) return false;
          seen.add(tag.id);
          return true;
        });
        if (remainingItems.length > 0 || page.next_cursor !== null) {
          nextPages.push({
            items: remainingItems,
            next_cursor: page.next_cursor,
          });
        }
      }
      return nextPages;
    });
  }, [enabled, limit, q, query.data, sort]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const nextCursor = useMemo(() => {
    if (extraPages.length > 0) {
      return extraPages[extraPages.length - 1]?.next_cursor ?? null;
    }
    return query.data?.next_cursor ?? null;
  }, [extraPages, query.data?.next_cursor]);

  const tags = useMemo(() => {
    const firstItems = query.data?.items ?? [];
    if (extraPages.length === 0) return firstItems;
    const seen = new Set<string>();
    const merged: Tag[] = [];
    for (const tag of firstItems) {
      if (!seen.has(tag.id)) {
        seen.add(tag.id);
        merged.push(tag);
      }
    }
    for (const page of extraPages) {
      for (const tag of page.items) {
        if (!seen.has(tag.id)) {
          seen.add(tag.id);
          merged.push(tag);
        }
      }
    }
    return merged;
  }, [query.data?.items, extraPages]);

  const loadMore = useCallback(async () => {
    if (!enabled || !nextCursor || isLoadingMore) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await tagsList({
        sort,
        q,
        limit,
        cursor: nextCursor,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setExtraPages((prev) => [...prev, page]);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setLoadMoreError(error);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsLoadingMore(false);
      }
    }
  }, [enabled, isLoadingMore, limit, nextCursor, q, sort]);

  return {
    query,
    tags,
    hasMore: Boolean(nextCursor),
    isLoadingMore,
    loadMoreError,
    loadMore,
  };
}
