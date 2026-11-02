import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  search,
  suggest,
  type SearchParams,
  type SearchResponse,
  type SuggestParams,
  type SuggestResponse,
} from '@/lib/api/search';

const SAMPLE_SUGGEST_RESPONSE: SuggestResponse = {
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
};

const SAMPLE_SEARCH_RESPONSE: SearchResponse = {
  scope: 'all',
  limit: 20,
  mode: 'full',
  items: [],
  tags: [],
  next_cursor: null,
  semantic: false,
  semantic_reason: 'disabled_server',
  near: [],
  generation: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('lib/api/search', () => {
  let fetchSpy: MockInstance;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('suggest omits q when absent or empty (recent mode) and only serializes typed params', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(SAMPLE_SUGGEST_RESPONSE));
    const res1 = await suggest({ scope: 'all', limit: 8, semantic: 0 });
    expect(res1).toEqual(SAMPLE_SUGGEST_RESPONSE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/v1/suggest?scope=all&limit=8&semantic=0');

    fetchSpy.mockResolvedValueOnce(jsonResponse(SAMPLE_SUGGEST_RESPONSE));
    await suggest({ q: '', scope: 'all', limit: 5, semantic: 0 });
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('/api/v1/suggest?scope=all&limit=5&semantic=0');
  });

  it('suggest serializes q, scope, limit, and semantic and ignores unknown properties', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(SAMPLE_SUGGEST_RESPONSE));
    const controller = new AbortController();
    const paramsWithExtra = {
      q: 'đường đi',
      scope: 'item',
      limit: 12,
      semantic: 1,
      extraSecret: 'must-not-appear',
    } as unknown as SuggestParams;

    await suggest(paramsWithExtra, { signal: controller.signal });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      '/api/v1/suggest?q=%C4%91%C6%B0%E1%BB%9Dng+%C4%91i&scope=item&limit=12&semantic=1',
    );
    expect(url).not.toContain('extraSecret');
    expect(url).not.toContain('must-not-appear');
    expect(init.signal).toBe(controller.signal);
  });

  it('search serializes q, scope, limit, cursor, and semantic and forwards AbortSignal', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(SAMPLE_SEARCH_RESPONSE));
    const controller = new AbortController();
    const paramsWithExtra = {
      q: 'wifi',
      scope: 'all',
      limit: 20,
      cursor: 'opaque_cursor_token',
      semantic: 0,
      untrusted: 'ignored',
    } as unknown as SearchParams;

    const res = await search(paramsWithExtra, { signal: controller.signal });
    expect(res).toEqual(SAMPLE_SEARCH_RESPONSE);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      '/api/v1/search?q=wifi&scope=all&limit=20&cursor=opaque_cursor_token&semantic=0',
    );
    expect(url).not.toContain('untrusted');
    expect(init.signal).toBe(controller.signal);
  });

  it('defaults semantic to 0 (fails closed) when omitted at runtime', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(SAMPLE_SUGGEST_RESPONSE));
    await suggest();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('/api/v1/suggest?semantic=0');

    fetchSpy.mockResolvedValueOnce(jsonResponse(SAMPLE_SUGGEST_RESPONSE));
    await suggest({ q: 'wifi', scope: 'all' } as unknown as SuggestParams);
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('/api/v1/suggest?q=wifi&scope=all&semantic=0');

    fetchSpy.mockResolvedValueOnce(jsonResponse(SAMPLE_SEARCH_RESPONSE));
    await search({ q: 'wifi', scope: 'all' } as unknown as SearchParams);
    expect(fetchSpy.mock.calls[2]?.[0]).toBe('/api/v1/search?q=wifi&scope=all&semantic=0');
  });

  it('never logs q to console on success or failure', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      fetchSpy.mockResolvedValueOnce(jsonResponse(SAMPLE_SUGGEST_RESPONSE));
      await suggest({ q: 'sensitive-query-alpha', semantic: 0 });

      fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await expect(search({ q: 'sensitive-query-bravo', semantic: 0 })).rejects.toThrow();

      for (const spy of [logSpy, warnSpy, errorSpy]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain('sensitive-query');
        }
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
