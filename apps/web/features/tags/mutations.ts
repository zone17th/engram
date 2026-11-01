'use client';

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  CONTENT_ITEM_QUERY_KEY_PREFIX,
  CONTENT_ITEMS_QUERY_KEY_PREFIX,
  CONTENT_LOOKUP_QUERY_KEY_PREFIX,
  CONTENT_TAGS_QUERY_KEY_PREFIX,
} from '@/features/items/query-keys';
import {
  createIdempotencyKey,
  tagDelete,
  tagRename,
  tagRestore,
  tagUpsert,
  useContentMutation,
  type Tag,
} from '@/lib/api/content';

export interface TagRenameVariables {
  readonly id: string;
  readonly display: string;
  readonly idempotencyKey?: string;
}

export interface TagDeleteVariables {
  readonly id: string;
  readonly idempotencyKey?: string;
}

export interface TagRestoreVariables {
  readonly id: string;
  readonly idempotencyKey?: string;
}

export interface TagUpsertVariables {
  readonly display: string;
  readonly idempotencyKey?: string;
}

/**
 * Invalidates tag and item metadata query namespaces after any tag mutation so rail chips,
 * filtered item grids, and item headers stay in sync (plan §2.10, Task 19).
 */
export async function invalidateTagAndItemQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: CONTENT_TAGS_QUERY_KEY_PREFIX }),
    queryClient.invalidateQueries({ queryKey: CONTENT_ITEMS_QUERY_KEY_PREFIX }),
    queryClient.invalidateQueries({ queryKey: CONTENT_ITEM_QUERY_KEY_PREFIX }),
    queryClient.invalidateQueries({ queryKey: CONTENT_LOOKUP_QUERY_KEY_PREFIX }),
  ]);
}

/**
 * `PATCH /tags/{id}` — renames a tag's display string via `useContentMutation`.
 */
export function useTagRenameMutation() {
  const queryClient = useQueryClient();
  return useContentMutation<Tag, unknown, TagRenameVariables>({
    mutationFn: ({ id, display, idempotencyKey }) =>
      tagRename(
        id,
        { display },
        { idempotencyKey: idempotencyKey ?? createIdempotencyKey() },
      ),
    onSuccess: async () => {
      await invalidateTagAndItemQueries(queryClient);
    },
  });
}

/**
 * `DELETE /tags/{id}` — soft-deletes a tag while keeping items intact (`item_tag` rows remain).
 */
export function useTagDeleteMutation() {
  const queryClient = useQueryClient();
  return useContentMutation<void, unknown, TagDeleteVariables>({
    mutationFn: ({ id, idempotencyKey }) =>
      tagDelete(id, { idempotencyKey: idempotencyKey ?? createIdempotencyKey() }),
    onSuccess: () => {
      void invalidateTagAndItemQueries(queryClient);
    },
  });
}

/**
 * `POST /tags/{id}/restore` — restores a soft-deleted tag (triggered from the Undo toast).
 */
export function useTagRestoreMutation() {
  const queryClient = useQueryClient();
  return useContentMutation<Tag, unknown, TagRestoreVariables>({
    mutationFn: ({ id, idempotencyKey }) =>
      tagRestore(id, { idempotencyKey: idempotencyKey ?? createIdempotencyKey() }),
    onSuccess: async () => {
      await invalidateTagAndItemQueries(queryClient);
    },
  });
}

/**
 * `POST /tags` — upserts a tag by normalized display name.
 */
export function useTagUpsertMutation() {
  const queryClient = useQueryClient();
  return useContentMutation<Tag, unknown, TagUpsertVariables>({
    mutationFn: ({ display, idempotencyKey }) =>
      tagUpsert(
        { display },
        { idempotencyKey: idempotencyKey ?? createIdempotencyKey() },
      ),
    onSuccess: async () => {
      await invalidateTagAndItemQueries(queryClient);
    },
  });
}
