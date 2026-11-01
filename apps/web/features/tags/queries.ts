'use client';

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
