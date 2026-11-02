/**
 * TanStack Query key builders and predicates for `/suggest` and `/search`
 * per P05 plan mục 2.7, SPEC §6.6, §6.8, §7.7:
 *
 * - Suggest key: `['search', userId, 'suggest', scope, limit, requestMode, semanticSuggestSetting, generationId ?? '-', qn]`
 * - Search key:  `['search', userId, 'search', scope, limit, requestMode, semanticSuggestSetting, generationId ?? '-', qn, cursor ?? '']`
 * - `staleTime: 30_000`, `gcTime: 60_000`, never persisted.
 * - Missing or blank `userId` is rejected / returns `null` so no request or cache entry is created without a user namespace.
 */

import type {
  SearchLimit,
  SearchResponse,
  SearchScope,
  SuggestLimit,
  SuggestResponse,
} from '@/lib/api/search';

export const SEARCH_QUERY_KEY_PREFIX = ['search'] as const;

export const SEARCH_QUERY_STALE_TIME_MS = 30_000;
export const SEARCH_QUERY_GC_TIME_MS = 60_000;

export const SEARCH_QUERY_CACHE_OPTIONS = {
  staleTime: SEARCH_QUERY_STALE_TIME_MS,
  gcTime: SEARCH_QUERY_GC_TIME_MS,
} as const;

export type SearchRequestMode = 'lex' | 'hybrid';
export type SearchGenerationKeySegment = number | '-';

export type SuggestQueryKey = readonly [
  'search',
  string,
  'suggest',
  SearchScope,
  SuggestLimit,
  SearchRequestMode,
  boolean,
  SearchGenerationKeySegment,
  string,
];

export type SearchPageQueryKey = readonly [
  'search',
  string,
  'search',
  SearchScope,
  SearchLimit,
  SearchRequestMode,
  boolean,
  SearchGenerationKeySegment,
  string,
  string,
];

export type AnySearchQueryKey = SuggestQueryKey | SearchPageQueryKey;

export interface SuggestQueryKeyParams {
  readonly userId: string | null | undefined;
  readonly scope: SearchScope;
  readonly limit: SuggestLimit;
  readonly requestMode: SearchRequestMode;
  readonly semanticSuggestSetting: boolean;
  readonly generationId?: number | null;
  readonly qn: string;
}

export interface SearchPageQueryKeyParams {
  readonly userId: string | null | undefined;
  readonly scope: SearchScope;
  readonly limit: SearchLimit;
  readonly requestMode: SearchRequestMode;
  readonly semanticSuggestSetting: boolean;
  readonly generationId?: number | null;
  readonly qn: string;
  readonly cursor?: string | null;
}

function normalizeUserId(userId: string | null | undefined): string | null {
  if (typeof userId !== 'string') return null;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGenerationSegment(
  generationId: number | null | undefined,
): SearchGenerationKeySegment {
  if (typeof generationId === 'number' && Number.isInteger(generationId) && generationId > 0) {
    return generationId;
  }
  return '-';
}

/**
 * Builds a `SuggestQueryKey` or returns `null` when `userId` is missing/empty
 * (plan mục 2.7: "thiếu `userId` → không gửi").
 */
export function buildSuggestQueryKey(params: SuggestQueryKeyParams): SuggestQueryKey | null {
  const uid = normalizeUserId(params.userId);
  if (!uid) return null;
  return [
    'search',
    uid,
    'suggest',
    params.scope,
    params.limit,
    params.requestMode,
    Boolean(params.semanticSuggestSetting),
    normalizeGenerationSegment(params.generationId),
    params.qn,
  ] as const;
}

/**
 * Builds a `SuggestQueryKey` and throws if `userId` is missing/empty.
 */
export function requireSuggestQueryKey(params: SuggestQueryKeyParams): SuggestQueryKey {
  const key = buildSuggestQueryKey(params);
  if (!key) {
    throw new Error('Suggest query key requires a non-empty userId.');
  }
  return key;
}

/**
 * Builds a `SearchPageQueryKey` or returns `null` when `userId` is missing/empty.
 * Cursor pages ("Xem thêm", SPEC §6.8) always force `requestMode = 'lex'`.
 */
export function buildSearchQueryKey(params: SearchPageQueryKeyParams): SearchPageQueryKey | null {
  const uid = normalizeUserId(params.userId);
  if (!uid) return null;
  const cursor = params.cursor ?? '';
  const effectiveRequestMode: SearchRequestMode = cursor !== '' ? 'lex' : params.requestMode;
  return [
    'search',
    uid,
    'search',
    params.scope,
    params.limit,
    effectiveRequestMode,
    Boolean(params.semanticSuggestSetting),
    normalizeGenerationSegment(params.generationId),
    params.qn,
    cursor,
  ] as const;
}

/**
 * Builds a `SearchPageQueryKey` and throws if `userId` is missing/empty.
 */
export function requireSearchQueryKey(params: SearchPageQueryKeyParams): SearchPageQueryKey {
  const key = buildSearchQueryKey(params);
  if (!key) {
    throw new Error('Search query key requires a non-empty userId.');
  }
  return key;
}

export const searchQueryKeys = {
  all: SEARCH_QUERY_KEY_PREFIX,
  user: (userId: string) => {
    const uid = normalizeUserId(userId);
    if (!uid) {
      throw new Error('Search user query key prefix requires a non-empty userId.');
    }
    return ['search', uid] as const;
  },
  suggest: buildSuggestQueryKey,
  requireSuggest: requireSuggestQueryKey,
  search: buildSearchQueryKey,
  requireSearch: requireSearchQueryKey,
} as const;

/**
 * Predicate matching the `['search', ...]` query key prefix (plan mục 2.7).
 * Used by `removeOmniboxSearchQueries` / `isOmniboxSearchQueryKey` in `omnibox.tsx` (Task 17)
 * on lock, logout, and user switch.
 */
export function isSearchQueryKeyPrefix(queryKey: readonly unknown[]): boolean {
  return Array.isArray(queryKey) && queryKey.length >= 1 && queryKey[0] === 'search';
}

/**
 * Checks whether a `/suggest` or `/search` response may be stored in TanStack Query cache
 * (plan mục 2.7: "Response có `lexical_partial`/lỗi không cache").
 */
export function isCacheableSearchResponse(
  response: SuggestResponse | SearchResponse | null | undefined,
): boolean {
  if (!response || typeof response !== 'object') return false;
  if ('lexical_partial' in response && Array.isArray(response.lexical_partial)) {
    return response.lexical_partial.length === 0;
  }
  return true;
}
