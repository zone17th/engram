import type { components, operations } from '@engram/shared-types';
import { authFetch } from '@/lib/api/auth-fetch';

export type SearchScope = components['schemas']['SearchScope'];
export type SuggestMode = components['schemas']['SuggestMode'];
export type SuggestMatch = components['schemas']['SuggestMatch'];
export type SemanticReason = components['schemas']['SemanticReason'];
export type SuggestLexicalCorpus = components['schemas']['SuggestLexicalCorpus'];
export type SuggestQuota = components['schemas']['SuggestQuota'];
export type SuggestTag = components['schemas']['SuggestTag'];
export type SuggestItem = components['schemas']['SuggestItem'];
export type SuggestNearRow = components['schemas']['SuggestNearRow'];
export type SuggestResponse = components['schemas']['SuggestResponse'];
export type SearchResponse = components['schemas']['SearchResponse'];
export type TagRef = components['schemas']['TagRef'];

export type SuggestLimit = NonNullable<
  NonNullable<operations['suggest']['parameters']['query']>['limit']
>;
export type SearchLimit = NonNullable<
  NonNullable<operations['search']['parameters']['query']>['limit']
>;
export type SemanticParam = 0 | 1;

export interface SearchRequestOptions {
  readonly signal?: AbortSignal;
}

export interface SuggestParams {
  readonly q?: string;
  readonly scope?: SearchScope;
  readonly limit?: SuggestLimit;
  readonly semantic?: SemanticParam;
  readonly signal?: AbortSignal;
}

export interface SearchParams {
  readonly q: string;
  readonly scope?: SearchScope;
  readonly limit?: SearchLimit;
  readonly cursor?: string;
  readonly semantic?: SemanticParam;
  readonly signal?: AbortSignal;
}

function buildSuggestQueryString(params: SuggestParams): string {
  const searchParams = new URLSearchParams();
  if (params.q !== undefined && params.q !== '') {
    searchParams.set('q', params.q);
  }
  if (params.scope !== undefined) {
    searchParams.set('scope', params.scope);
  }
  if (params.limit !== undefined) {
    searchParams.set('limit', String(params.limit));
  }
  if (params.semantic !== undefined) {
    searchParams.set('semantic', String(params.semantic));
  }
  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}

function buildSearchQueryString(params: SearchParams): string {
  const searchParams = new URLSearchParams();
  searchParams.set('q', params.q);
  if (params.scope !== undefined) {
    searchParams.set('scope', params.scope);
  }
  if (params.limit !== undefined) {
    searchParams.set('limit', String(params.limit));
  }
  if (params.cursor !== undefined && params.cursor !== '') {
    searchParams.set('cursor', params.cursor);
  }
  if (params.semantic !== undefined) {
    searchParams.set('semantic', String(params.semantic));
  }
  const qs = searchParams.toString();
  return qs ? `?${qs}` : '';
}

/**
 * `GET /suggest` — operationId `suggest` (plan P05 mục 3).
 * Builds the query string exclusively from the typed allowlisted parameters
 * (`q`, `scope`, `limit`, `semantic`); omits `q` when absent or empty (recent mode).
 * Never logs `q`.
 */
export function suggest(
  params: SuggestParams = {},
  opts?: SearchRequestOptions,
): Promise<SuggestResponse> {
  const qs = buildSuggestQueryString(params);
  return authFetch<SuggestResponse>(`/suggest${qs}`, {
    requireSession: true,
    signal: opts?.signal ?? params.signal,
  });
}

/**
 * `GET /search` — operationId `search` (plan P05 mục 3).
 * Builds the query string exclusively from the typed allowlisted parameters
 * (`q`, `scope`, `limit`, `cursor`, `semantic`).
 * Never logs `q`.
 */
export function search(
  params: SearchParams,
  opts?: SearchRequestOptions,
): Promise<SearchResponse> {
  const qs = buildSearchQueryString(params);
  return authFetch<SearchResponse>(`/search${qs}`, {
    requireSession: true,
    signal: opts?.signal ?? params.signal,
  });
}
