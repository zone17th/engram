import type {
  SearchLimit,
  SearchScope,
  SuggestLimit,
  SuggestMode,
  SuggestQuota,
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

export interface SuggestQuotaSpec {
  readonly limits: readonly SuggestLimit[];
  readonly default_limit: SuggestLimit;
  readonly mobile_limit: SuggestLimit;
  readonly table: readonly SuggestQuotaTableRow[];
}

export interface SearchQuotaSpec {
  readonly limits: readonly SearchLimit[];
  readonly default_limit: SearchLimit;
  readonly all_scope_first_page_tags_max: number;
  readonly first_page_near_max: number;
}

export interface QuotaContract {
  readonly version: 1;
  readonly schema: 'engram-search-quota-v1';
  readonly suggest: SuggestQuotaSpec;
  readonly search: SearchQuotaSpec;
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

export const QUOTA_CONTRACT: QuotaContract = {
  version: 1,
  schema: 'engram-search-quota-v1',
  suggest: {
    limits: SUGGEST_LIMITS,
    default_limit: SUGGEST_DEFAULT_LIMIT,
    mobile_limit: SUGGEST_MOBILE_LIMIT,
    table: SUGGEST_QUOTA_TABLE,
  },
  search: {
    limits: SEARCH_LIMITS,
    default_limit: SEARCH_DEFAULT_LIMIT,
    all_scope_first_page_tags_max: SEARCH_ALL_SCOPE_FIRST_PAGE_TAGS_MAX,
    first_page_near_max: SEARCH_FIRST_PAGE_NEAR_MAX,
  },
};

export function getSuggestQuotaRow(
  scope: SearchScope,
  limit: SuggestLimit,
): SuggestQuotaTableRow {
  const row = SUGGEST_QUOTA_TABLE.find((entry) => entry.scope === scope && entry.limit === limit);
  if (!row) {
    throw new Error(`Invalid suggest quota (scope=${String(scope)}, limit=${String(limit)})`);
  }
  return row;
}

export interface ComputedSuggestSlotUsage {
  readonly tagsUsed: number;
  readonly itemsUsed: number;
  readonly nearUsed: number;
  readonly quota: SuggestQuota;
}

/**
 * Computes suggest slot usage and wire `SuggestQuota` per P05 plan mục 2.4 + 2.24 item 5.
 */
export function computeSuggestSlotUsage(params: {
  readonly scope: SearchScope;
  readonly limit: SuggestLimit;
  readonly mode: SuggestMode;
  readonly tagHits: number;
  readonly itemHits: number;
  readonly nearHitsAfterDedup?: number;
}): ComputedSuggestSlotUsage {
  const row = getSuggestQuotaRow(params.scope, params.limit);
  const tagHits = Math.max(0, params.tagHits);
  const itemHits = Math.max(0, params.itemHits);
  const nearHits = Math.max(0, params.nearHitsAfterDedup ?? 0);

  if (params.mode === 'recent') {
    const tagsUsed = Math.min(tagHits, row.recent_tag);
    const itemsUsed = Math.min(itemHits, params.limit - tagsUsed);
    return {
      tagsUsed,
      itemsUsed,
      nearUsed: 0,
      quota: {
        tag: row.recent_tag,
        lexical: row.recent_tag + row.recent_item,
        near: 0,
      },
    };
  }

  const tagsUsed = Math.min(tagHits, Math.max(row.tag_max, row.lex_max - itemHits));
  const itemsUsed = Math.min(itemHits, row.lex_max - tagsUsed);
  const lexicalUnused = Math.max(0, row.lex_max - tagsUsed - itemsUsed);
  const effectiveNearQuota = Math.min(row.near_max_cap, row.near_base + lexicalUnused);
  const nearUsed = Math.min(nearHits, effectiveNearQuota, params.limit - tagsUsed - itemsUsed);

  return {
    tagsUsed,
    itemsUsed,
    nearUsed,
    quota: {
      tag: row.tag_max,
      lexical: row.lex_max,
      near: effectiveNearQuota,
    },
  };
}

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
