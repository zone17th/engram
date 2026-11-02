import type {
  SearchLimit,
  SearchScope,
  SuggestLimit,
} from '@/lib/api/search';

export interface SuggestQuotaTableRow {
  readonly scope: SearchScope;
  readonly limit: SuggestLimit;
  readonly tag_max: number;
  readonly lex_max: number;
  readonly near_base: number;
  readonly near_max_cap: number;
  readonly recent_tag: number;
  readonly recent_item: number;
}
export const SUGGEST_LIMITS: readonly SuggestLimit[] = [5, 8, 12] as const;
export const SUGGEST_DEFAULT_LIMIT: SuggestLimit = 8;
export const SUGGEST_MOBILE_LIMIT: SuggestLimit = 5;

export const SEARCH_LIMITS: readonly SearchLimit[] = [20, 50] as const;
export const SEARCH_DEFAULT_LIMIT: SearchLimit = 20;
export const SEARCH_ALL_SCOPE_FIRST_PAGE_TAGS_MAX = 5;
export const SEARCH_FIRST_PAGE_NEAR_MAX = 5;

export const SUGGEST_QUOTA_TABLE: readonly SuggestQuotaTableRow[] = [
  {
    scope: 'all',
    limit: 5,
    tag_max: 2,
    lex_max: 4,
    near_base: 1,
    near_max_cap: 2,
    recent_tag: 2,
    recent_item: 3,
  },
  {
    scope: 'all',
    limit: 8,
    tag_max: 3,
    lex_max: 6,
    near_base: 2,
    near_max_cap: 3,
    recent_tag: 3,
    recent_item: 5,
  },
  {
    scope: 'all',
    limit: 12,
    tag_max: 4,
    lex_max: 9,
    near_base: 3,
    near_max_cap: 4,
    recent_tag: 4,
    recent_item: 8,
  },
  {
    scope: 'item',
    limit: 5,
    tag_max: 0,
    lex_max: 4,
    near_base: 1,
    near_max_cap: 2,
    recent_tag: 0,
    recent_item: 5,
  },
  {
    scope: 'item',
    limit: 8,
    tag_max: 0,
    lex_max: 6,
    near_base: 2,
    near_max_cap: 3,
    recent_tag: 0,
    recent_item: 8,
  },
  {
    scope: 'item',
    limit: 12,
    tag_max: 0,
    lex_max: 9,
    near_base: 3,
    near_max_cap: 4,
    recent_tag: 0,
    recent_item: 12,
  },
  {
    scope: 'tag',
    limit: 5,
    tag_max: 4,
    lex_max: 4,
    near_base: 1,
    near_max_cap: 2,
    recent_tag: 5,
    recent_item: 0,
  },
  {
    scope: 'tag',
    limit: 8,
    tag_max: 6,
    lex_max: 6,
    near_base: 2,
    near_max_cap: 3,
    recent_tag: 8,
    recent_item: 0,
  },
  {
    scope: 'tag',
    limit: 12,
    tag_max: 9,
    lex_max: 9,
    near_base: 3,
    near_max_cap: 4,
    recent_tag: 12,
    recent_item: 0,
  },
] as const;

/**
 * Clips the client-side `near` zone according to `min(quota.near, limit - lexicalLength)`
 * (plan mục 2.8 rule 3, mục 2.24 item 5).
 */
export function computeClientNearCap(
  quotaNear: number,
  limit: number,
  lexicalLength: number,
): number {
  return Math.max(0, Math.min(quotaNear, limit - lexicalLength));
}
