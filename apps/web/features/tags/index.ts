/**
 * Public surface of `features/tags` (P04-T19).
 * Kept minimal so `itempage` (Task 15) and `omnibox` (Task 18) can import tag query/mutation hooks cleanly.
 */
export {
  usePaginatedTagsList,
  useTagsList,
  type UsePaginatedTagsListResult,
  type UseTagsListOptions,
  type Tag,
  type TagList,
  type ContentTagsQueryKey,
} from './queries';

export {
  invalidateTagAndItemQueries,
  useTagDeleteMutation,
  useTagRenameMutation,
  useTagRestoreMutation,
  useTagUpsertMutation,
  type TagDeleteVariables,
  type TagRenameVariables,
  type TagRestoreVariables,
  type TagUpsertVariables,
} from './mutations';

export { RailTagChip, type RailTagChipProps } from './rail-tag-menu';
