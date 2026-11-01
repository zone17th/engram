import { ERROR_CODES, ProblemError, type ProblemDetails } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  CONTENT_ERROR_I18N_KEYS,
  CONTENT_PROBLEM_CODES,
  classifyContentMutationError,
  classifyPreLookupError,
  contentMutate,
  createIdempotencyKey,
  entriesChanges,
  entryCreate,
  entryDelete,
  entryGet,
  entryImportJson,
  entryRestore,
  entryUpdate,
  formatVersionIfMatch,
  getContentErrorI18nKey,
  itemCreate,
  itemDelete,
  itemEntriesList,
  itemEntriesReorder,
  itemGet,
  itemRestore,
  itemsList,
  itemsLookupExact,
  itemTagRemove,
  itemTagsAdd,
  itemUpdate,
  tagDelete,
  tagRename,
  tagRestore,
  tagsList,
  tagUpsert,
  useContentMutation,
  type ContentErrorCode,
  type EntryCreateRequest,
  type EntryEnvelopeV1,
  type EntryImportJsonRequest,
  type EntryUpdateRequest,
  type SafeContentMutationVariables,
} from '@/lib/api/content';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const SAMPLE_ITEM_ID = '00000000-0000-4000-8000-000000000010';
const SAMPLE_TAG_ID = '00000000-0000-4000-8000-000000000020';
const SAMPLE_ENTRY_ID = '00000000-0000-4000-8000-000000000030';
const SAMPLE_KEY_ID = 'vk:7f3a91c4e0b2d8a1f5c309';

const SAMPLE_ENVELOPE: EntryEnvelopeV1 = {
  v: 1,
  alg: 'xchacha20poly1305-ietf',
  key_id: SAMPLE_KEY_ID,
  nonce: 'AAAAAAAAAAAAAAAAAAAAAAAA________________________',
  ct_enc: 'utf8',
};

const SAMPLE_ENTRY_CREATE: EntryCreateRequest = {
  id: SAMPLE_ENTRY_ID,
  type: 'text',
  envelope: SAMPLE_ENVELOPE,
  ciphertext: 'BBBBBBBBBBBBBBBBBBBBBBBB',
  plaintext_len_bucket: 256,
};

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function emptyResponse(status = 204): Response {
  return new Response(null, { status });
}

function problemResponse(
  code: ProblemDetails['code'],
  status: number,
  extra: Partial<ProblemDetails> = {},
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://engram.zone17.click/problems/${code}`,
      title: code,
      status,
      code,
      ...extra,
    }),
    {
      status,
      headers: {
        'content-type': 'application/problem+json',
        ...extraHeaders,
      },
    },
  );
}

function sessionCsrfCookie(): string {
  const payload = btoa('v1|sess|00000000-0000-0000-0000-000000000001|nonce|4102444800')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${payload}.test-signature`;
}

function getMessageErrorMap(messages: unknown): Record<string, string> | undefined {
  if (typeof messages !== 'object' || messages === null || !('content' in messages)) {
    return undefined;
  }
  const content = messages.content;
  if (typeof content !== 'object' || content === null || !('errors' in content)) {
    return undefined;
  }
  const errors = content.errors;
  if (typeof errors !== 'object' || errors === null) {
    return undefined;
  }
  return errors as Record<string, string>;
}

function lastFetchInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  const init = fetchMock.mock.lastCall?.[1];
  return (init ?? {}) as RequestInit;
}

describe('lib/api/content', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      writable: true,
      value: `sabk_csrf=${sessionCsrfCookie()}`,
    });
    vi.stubGlobal('navigator', {
      ...navigator,
      onLine: true,
      locks: {
        request: vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback()),
      },
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('formatVersionIfMatch', () => {
    it('formats positive int32 version as strong ETag "<version>" and rejects malformed versions', () => {
      expect(formatVersionIfMatch(1)).toBe('"1"');
      expect(formatVersionIfMatch(42)).toBe('"42"');
      expect(formatVersionIfMatch(2_147_483_647)).toBe('"2147483647"');

      expect(() => formatVersionIfMatch(0)).toThrow(/Invalid content version/);
      expect(() => formatVersionIfMatch(-1)).toThrow(/Invalid content version/);
      expect(() => formatVersionIfMatch(1.5)).toThrow(/Invalid content version/);
      expect(() => formatVersionIfMatch(Number.NaN)).toThrow(/Invalid content version/);
      expect(() => formatVersionIfMatch(2_147_483_648)).toThrow(/Invalid content version/);
    });
  });

  describe('content.errors.* i18n mapping', () => {
    it('exhaustively maps every P04 problem code and reused §3 code (+ network, offline, 429) to en/vi messages', () => {
      // Every P04 code appended in packages/shared-types/src/problem.ts after passkey_not_found
      const passkeyIdx = ERROR_CODES.indexOf('passkey_not_found');
      expect(passkeyIdx).toBeGreaterThan(0);
      const p04CodesFromCatalog = ERROR_CODES.slice(passkeyIdx + 1);
      expect(p04CodesFromCatalog.length).toBe(16);

      for (const code of p04CodesFromCatalog) {
        expect(CONTENT_PROBLEM_CODES).toContain(code);
        const key = getContentErrorI18nKey(code);
        expect(key).toBe(`content.errors.${code}`);
      }

      const allExpectedCodes: readonly ContentErrorCode[] = [
        ...CONTENT_PROBLEM_CODES,
        'network',
        'offline',
      ];

      const enErrors = getMessageErrorMap(enMessages);
      const viErrors = getMessageErrorMap(viMessages);
      expect(enErrors).toBeDefined();
      expect(viErrors).toBeDefined();

      for (const code of allExpectedCodes) {
        const fullKey = CONTENT_ERROR_I18N_KEYS[code];
        expect(fullKey).toBe(`content.errors.${code}`);
        expect(getContentErrorI18nKey(code)).toBe(fullKey);
        expect(typeof enErrors?.[code]).toBe('string');
        expect(enErrors?.[code]?.trim().length).toBeGreaterThan(0);
        expect(typeof viErrors?.[code]).toBe('string');
        expect(viErrors?.[code]?.trim().length).toBeGreaterThan(0);
      }

      // 429 ProblemError maps to content.errors.rate_limited
      const err429 = new ProblemError({
        type: 'https://engram.zone17.click/problems/rate_limited',
        title: 'Rate limited',
        status: 429,
        code: 'rate_limited',
        retry_after: 2,
      });
      expect(getContentErrorI18nKey(err429)).toBe('content.errors.rate_limited');

      // Network error maps to content.errors.network, or offline when navigator.onLine === false
      expect(getContentErrorI18nKey(new TypeError('Failed to fetch'))).toBe('content.errors.network');
      vi.stubGlobal('navigator', { ...navigator, onLine: false });
      expect(getContentErrorI18nKey(new TypeError('Failed to fetch'))).toBe('content.errors.offline');
    });
  });

  describe('contentMutate retry & serialization invariants', () => {
    it('retry after timeout/network error resends the EXACT SAME body bytes, Idempotency-Key, and If-Match', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();
      const mutablePayload: EntryUpdateRequest = {
        envelope: { ...SAMPLE_ENVELOPE },
        ciphertext: 'BBBBBBBBBBBBBBBBBBBBBBBB',
        plaintext_len_bucket: 256,
      };
      const expectedSerialized = JSON.stringify(mutablePayload);

      let attempt = 0;
      fetchMock.mockImplementation(async () => {
        attempt += 1;
        // Mutate the caller's object after the first call starts to prove contentMutate serialized ONCE.
        mutablePayload.ciphertext = 'MUTATED_AFTER_FIRST_SEND';
        if (attempt === 1) {
          throw new DOMException('The operation timed out.', 'TimeoutError');
        }
        if (attempt === 2) {
          throw new TypeError('Failed to fetch');
        }
        return jsonResponse({
          id: SAMPLE_ENTRY_ID,
          item_id: SAMPLE_ITEM_ID,
          type: 'text',
          position: 0,
          version: 2,
          plaintext_len_bucket: 256,
          created_at: '2026-11-01T00:00:00Z',
          updated_at: '2026-11-01T00:00:01Z',
        });
      });

      const result = await contentMutate<{ version: number }, EntryUpdateRequest>({
        method: 'PUT',
        path: `/entries/${SAMPLE_ENTRY_ID}`,
        body: mutablePayload,
        idempotencyKey,
        ifMatch: formatVersionIfMatch(1),
      });

      expect(result.version).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      for (let i = 0; i < 3; i += 1) {
        const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
        expect(url).toBe(`/api/v1/entries/${SAMPLE_ENTRY_ID}`);
        expect(init.body).toBe(expectedSerialized);
        const headers = new Headers(init.headers);
        expect(headers.get('Idempotency-Key')).toBe(idempotencyKey);
        expect(headers.get('If-Match')).toBe('"1"');
      }
    });

    it('stops after at most 2 auto-retries on persistent network/timeout errors', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const timeoutErr = new DOMException('The operation timed out.', 'TimeoutError');
      fetchMock.mockRejectedValue(timeoutErr);

      await expect(
        contentMutate({
          method: 'POST',
          path: '/items',
          body: { name: 'wifi' },
          idempotencyKey: createIdempotencyKey(),
        }),
      ).rejects.toBe(timeoutErr);

      // Initial send + 2 retries = 3 calls total
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('waits 1 second on 409 idempotency_in_progress then retries with the same bytes and key', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();

      fetchMock
        .mockResolvedValueOnce(
          problemResponse('idempotency_in_progress', 409, { retry_after: 1 }, { 'Retry-After': '1' }),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            {
              id: SAMPLE_ITEM_ID,
              name: 'wifi',
              hint: null,
              tags: [],
              entry_count: 0,
              version: 1,
              created_at: '2026-11-01T00:00:00Z',
              updated_at: '2026-11-01T00:00:00Z',
              last_used_at: '2026-11-01T00:00:00Z',
            },
            201,
          ),
        );

      let settled = false;
      const promise = itemCreate({ id: SAMPLE_ITEM_ID, name: 'wifi' }, { idempotencyKey }).then((res) => {
        settled = true;
        return res;
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const item = await promise;
      expect(settled).toBe(true);
      expect(item.id).toBe(SAMPLE_ITEM_ID);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const firstCall = fetchMock.mock.calls[0] as [string, RequestInit];
      const secondCall = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(secondCall[1].body).toBe(firstCall[1].body);
      expect(new Headers(secondCall[1].headers).get('Idempotency-Key')).toBe(idempotencyKey);
    });

    it('honours Retry-After on 429 rate_limited and retries with the same key and body', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();

      fetchMock
        .mockResolvedValueOnce(
          problemResponse('rate_limited', 429, { retry_after: 3 }, { 'Retry-After': '3' }),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            {
              id: SAMPLE_TAG_ID,
              display: 'nhà',
              item_count: 0,
              last_used_at: '2026-11-01T00:00:00Z',
              created_at: '2026-11-01T00:00:00Z',
            },
            201,
          ),
        );

      let resolved = false;
      const promise = tagUpsert({ display: 'nhà' }, { idempotencyKey }).then((tag) => {
        resolved = true;
        return tag;
      });

      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const tag = await promise;
      expect(resolved).toBe(true);
      expect(tag.id).toBe(SAMPLE_TAG_ID);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries 503 dependency_unavailable up to 2 times and does NOT retry other 4xx errors', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();

      fetchMock
        .mockResolvedValueOnce(problemResponse('dependency_unavailable', 503, { retry_after: 1 }))
        .mockResolvedValueOnce(emptyResponse(204));

      const deletePromise = entryDelete(SAMPLE_ENTRY_ID, { idempotencyKey });
      await vi.advanceTimersByTimeAsync(1_000);
      await deletePromise;
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Deterministic 4xx codes must NOT be retried
      const nonRetryable4xx: Array<[ProblemDetails['code'], number]> = [
        ['name_invalid', 400],
        ['entry_invalid', 400],
        ['entry_nonce_reused', 400],
        ['not_found', 404],
        ['vault_absent', 404],
        ['item_id_conflict', 409],
        ['idempotency_conflict', 409],
        ['entry_key_mismatch', 409],
        ['item_tag_limit', 409],
        ['item_entry_limit', 409],
        ['tag_conflict', 409],
        ['reorder_mismatch', 409],
        ['version_mismatch', 412],
        ['entry_too_large', 413],
        ['precondition_required', 428],
      ];

      for (const [code, status] of nonRetryable4xx) {
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(problemResponse(code, status));

        await expect(
          contentMutate({
            method: 'POST',
            path: `/items/${SAMPLE_ITEM_ID}/entries`,
            body: SAMPLE_ENTRY_CREATE,
            idempotencyKey: createIdempotencyKey(),
          }),
        ).rejects.toMatchObject({
          name: 'ProblemError',
          problem: { code, status },
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe('pre-lookup 401/403 split (SPEC §3.4, advisor-dec-098/119/121, CFE5-3, CBE4-1)', () => {
    it('CFE5-3: reuses authFetch refresh path (no second refresh) and sends identical Idempotency-Key, If-Match, and body string on auto-retry for access_expired and unauthenticated with session CSRF', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();
      const ifMatch = formatVersionIfMatch(3);
      const body: EntryUpdateRequest = {
        envelope: SAMPLE_ENVELOPE,
        ciphertext: 'BBBBBBBBBBBBBBBBBBBBBBBB',
        plaintext_len_bucket: 256,
      };
      const expectedSerialized = JSON.stringify(body);

      // 1) Initial PUT -> 401 unauthenticated (with session CSRF cookie present)
      // 2) Lock-time GET /auth/me -> 401 unauthenticated
      // 3) POST /auth/refresh -> 204
      // 4) Replay PUT -> 200 EntryMeta
      fetchMock
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401))
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(
          jsonResponse({
            id: SAMPLE_ENTRY_ID,
            item_id: SAMPLE_ITEM_ID,
            type: 'text',
            position: 0,
            version: 4,
            plaintext_len_bucket: 256,
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:02Z',
          }),
        );

      const updated = await entryUpdate(SAMPLE_ENTRY_ID, body, {
        idempotencyKey,
        ifMatch,
      });

      expect(updated.version).toBe(4);
      // Exactly 1 refresh call inside authFetch, no second refresh in contentMutate
      const refreshCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/refresh'));
      expect(refreshCalls).toHaveLength(1);

      const entryCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes(`/entries/${SAMPLE_ENTRY_ID}`),
      );
      expect(entryCalls).toHaveLength(2);
      const firstInit = entryCalls[0]?.[1] as RequestInit;
      const secondInit = entryCalls[1]?.[1] as RequestInit;
      expect(firstInit.body).toBe(expectedSerialized);
      expect(secondInit.body).toBe(expectedSerialized);
      expect(new Headers(firstInit.headers).get('Idempotency-Key')).toBe(idempotencyKey);
      expect(new Headers(secondInit.headers).get('Idempotency-Key')).toBe(idempotencyKey);
      expect(new Headers(firstInit.headers).get('If-Match')).toBe(ifMatch);
      expect(new Headers(secondInit.headers).get('If-Match')).toBe(ifMatch);
    });

    it('replays the exact same bytes and key after an uncertain send hits access_expired or csrf_invalid', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();
      const expectedSerialized = JSON.stringify(SAMPLE_ENTRY_CREATE);

      // 1) First send times out (uncertain outcome)
      // 2) First auto-retry gets 403 csrf_invalid before idempotency lookup
      // 3) contentMutate bootstraps /auth/csrf -> 204
      // 4) Next retry sends the exact same bytes + key -> 201 replayed by server
      fetchMock
        .mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
        .mockResolvedValueOnce(problemResponse('csrf_invalid', 403))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(
          jsonResponse(
            {
              id: SAMPLE_ENTRY_ID,
              item_id: SAMPLE_ITEM_ID,
              type: 'text',
              position: 0,
              version: 1,
              plaintext_len_bucket: 256,
              created_at: '2026-11-01T00:00:00Z',
              updated_at: '2026-11-01T00:00:00Z',
            },
            201,
          ),
        );

      const created = await entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, { idempotencyKey });
      expect(created.id).toBe(SAMPLE_ENTRY_ID);

      const postCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes(`/items/${SAMPLE_ITEM_ID}/entries`),
      );
      expect(postCalls).toHaveLength(3);
      for (const [, init] of postCalls) {
        const reqInit = init as RequestInit;
        expect(reqInit.body).toBe(expectedSerialized);
        expect(new Headers(reqInit.headers).get('Idempotency-Key')).toBe(idempotencyKey);
      }
    });

    it('does NOT replay on unauthenticated without successful refresh, session_invalid, or forbidden (case b)', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();

      // Case 1: unauthenticated without session CSRF cookie -> no refresh attempted, reaches contentMutate as ProblemError
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        writable: true,
        value: 'sabk_csrf=v1|anon||nonce|4102444800.sig',
      });
      fetchMock
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401));

      let caughtUnauth: unknown;
      try {
        await entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, { idempotencyKey });
      } catch (err) {
        caughtUnauth = err;
      }
      expect(caughtUnauth).toBeInstanceOf(ProblemError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const classifiedUnauth = classifyContentMutationError(caughtUnauth, { hadUncertainSend: true });
      expect(classifiedUnauth.kind).toBe('terminal_auth');
      expect(classifiedUnauth.isLogoutBoundary).toBe(true);
      expect(classifiedUnauth.canRetrySameBytes).toBe(false);
      expect(classifiedUnauth.preLookupRecovery).toBe('terminal_logout_boundary');

      // Case 2: session_invalid after uncertain send -> ends immediately, no replay
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        writable: true,
        value: `sabk_csrf=${sessionCsrfCookie()}`,
      });
      fetchMock.mockReset();
      fetchMock
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(problemResponse('session_invalid', 401, { reason: 'revoked' }));

      let caughtSessionInvalid: unknown;
      try {
        await entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, { idempotencyKey });
      } catch (err) {
        caughtSessionInvalid = err;
      }
      expect(caughtSessionInvalid).toBeInstanceOf(ProblemError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const classifiedSession = classifyContentMutationError(caughtSessionInvalid, {
        hadUncertainSend: true,
      });
      expect(classifiedSession.kind).toBe('terminal_auth');
      expect(classifiedSession.isLogoutBoundary).toBe(true);
      expect(classifiedSession.canRetrySameBytes).toBe(false);
      expect(classifiedSession.preLookupRecovery).toBe('terminal_logout_boundary');

      // Case 3: forbidden after uncertain send -> ends immediately, no replay
      fetchMock.mockReset();
      fetchMock
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(problemResponse('forbidden', 403));

      let caughtForbidden: unknown;
      try {
        await entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, { idempotencyKey });
      } catch (err) {
        caughtForbidden = err;
      }
      expect(caughtForbidden).toBeInstanceOf(ProblemError);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const classifiedForbidden = classifyContentMutationError(caughtForbidden, {
        hadUncertainSend: true,
      });
      expect(classifiedForbidden.kind).toBe('terminal_auth');
      expect(classifiedForbidden.isLogoutBoundary).toBe(true);
      expect(classifiedForbidden.canRetrySameBytes).toBe(false);
      expect(classifiedForbidden.preLookupRecovery).toBe('terminal_logout_boundary');
    });

    it('CBE4-1: a refresh that fails on a network error or 5xx is NOT a logout; keeps bytes/key and surfaces a retryable error', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();

      // Subcase A: lost response -> retry gets 401 unauthenticated -> conditional refresh fails with network TypeError
      // (and remaining auto-retries also fail with network TypeError).
      const networkOutage = new TypeError('Failed to fetch');
      fetchMock
        .mockRejectedValueOnce(networkOutage) // attempt 0: lost mutation response
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401)) // attempt 1: hits unauthenticated
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401)) // refresh lock: GET /auth/me
        .mockRejectedValueOnce(networkOutage) // refresh lock: POST /auth/refresh fails on network
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401)) // refresh lock: probe GET /auth/me still unauthenticated -> rethrows networkOutage
        .mockRejectedValueOnce(networkOutage); // attempt 2: still offline

      let surfacedNetworkErr: unknown;
      try {
        await entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, { idempotencyKey });
      } catch (err) {
        surfacedNetworkErr = err;
      }

      expect(surfacedNetworkErr).toBe(networkOutage);
      const classifiedNet = classifyContentMutationError(surfacedNetworkErr, {
        hadUncertainSend: true,
      });
      expect(classifiedNet.kind).toBe('network');
      expect(classifiedNet.isLogoutBoundary).toBe(false);
      expect(classifiedNet.canRetrySameBytes).toBe(true);
      expect(classifiedNet.preLookupRecovery).toBe('replay_same_request');
      expect(classifyPreLookupError(surfacedNetworkErr, { hadUncertainSend: true })).toBe(
        'replay_same_request',
      );

      // Subcase B: lost response -> retry gets 401 unauthenticated -> conditional refresh fails with 503 dependency_unavailable
      fetchMock.mockReset();
      fetchMock
        .mockRejectedValueOnce(networkOutage) // attempt 0: lost mutation response
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401)) // attempt 1: hits unauthenticated
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401)) // refresh lock: GET /auth/me
        .mockResolvedValueOnce(problemResponse('dependency_unavailable', 503)) // refresh lock: POST /auth/refresh 503
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401)) // refresh lock: probe GET /auth/me -> rethrows 503
        .mockResolvedValueOnce(problemResponse('dependency_unavailable', 503)); // attempt 2: 503

      let surfaced503Err: unknown;
      const p503 = entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, { idempotencyKey }).catch(
        (err: unknown) => {
          surfaced503Err = err;
        },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await p503;

      expect(surfaced503Err).toBeInstanceOf(ProblemError);
      const classified503 = classifyContentMutationError(surfaced503Err, {
        hadUncertainSend: true,
      });
      expect(classified503.kind).toBe('server_unavailable');
      expect(classified503.isLogoutBoundary).toBe(false);
      expect(classified503.canRetrySameBytes).toBe(true);
      expect(classified503.preLookupRecovery).toBe('replay_same_request');
    });
  });

  describe('no plaintext body invariant (plan §2.10, user-dec-016)', () => {
    it('rejects string or plaintext-bearing objects in contentMutate and useContentMutation at compile time and runtime', async () => {
      // Compile-time checks: string or object with plaintext/rawJson/text resolves to never
      expectTypeOf<SafeContentMutationVariables<string>>().toEqualTypeOf<never>();
      expectTypeOf<SafeContentMutationVariables<{ plaintext: string }>>().toEqualTypeOf<never>();
      expectTypeOf<SafeContentMutationVariables<{ rawJson: string }>>().toEqualTypeOf<never>();
      expectTypeOf<SafeContentMutationVariables<{ text: string }>>().toEqualTypeOf<never>();
      expectTypeOf<SafeContentMutationVariables<{ body: string }>>().toEqualTypeOf<never>();
      expectTypeOf<
        SafeContentMutationVariables<EntryCreateRequest>
      >().toEqualTypeOf<EntryCreateRequest>();

      // Runtime checks on contentMutate
      await expect(
        contentMutate({
          method: 'POST',
          path: `/items/${SAMPLE_ITEM_ID}/entries`,
          body: 'raw-plaintext-secret' as unknown as EntryCreateRequest,
          idempotencyKey: createIdempotencyKey(),
        }),
      ).rejects.toThrow(/does not accept a string body/);

      await expect(
        contentMutate({
          method: 'POST',
          path: `/items/${SAMPLE_ITEM_ID}/entries`,
          body: { plaintext: 'secret' } as unknown as EntryCreateRequest,
          idempotencyKey: createIdempotencyKey(),
        }),
      ).rejects.toThrow(/does not accept plaintext/);

      // Runtime + gcTime: 0 checks on useContentMutation
      const queryClient = new QueryClient();
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client: queryClient }, children);

      const { result, unmount } = renderHook(
        () =>
          useContentMutation< { ok: boolean }, Error, EntryCreateRequest>({
            mutationFn: async (vars) => ({ ok: Boolean(vars.id) }),
          }),
        { wrapper },
      );

      await expect(
        act(async () => {
          await result.current.mutateAsync({
            plaintext: 'secret-text',
          } as unknown as EntryCreateRequest);
        }),
      ).rejects.toThrow(/forbids plaintext fields/);

      await act(async () => {
        await result.current.mutateAsync(SAMPLE_ENTRY_CREATE);
      });

      unmount();
      // With gcTime: 0, inactive mutation entries are garbage-collected immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    });
  });

  describe('all 23 plan §3 operations', () => {
    it('calls the exact method, path, query, and headers for every item, tag, and entry operation', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const key = createIdempotencyKey();

      // 1. itemsList
      fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }));
      await itemsList({ tag_id: SAMPLE_TAG_ID, q: 'wi', sort: 'recent', limit: 20, cursor: 'c1' });
      expect(fetchMock.mock.lastCall?.[0]).toBe(
        `/api/v1/items?tag_id=${SAMPLE_TAG_ID}&q=wi&cursor=c1&limit=20&sort=recent`,
      );

      // 2. itemsLookupExact
      fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], total: 0, next_cursor: null }));
      await itemsLookupExact({ name: 'wifi', limit: 10 });
      expect(fetchMock.mock.lastCall?.[0]).toBe('/api/v1/items/lookup?name=wifi&limit=10');

      // 3. itemCreate
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_ITEM_ID }, 201));
      await itemCreate({ id: SAMPLE_ITEM_ID, name: 'wifi', hint: 'router' }, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe('/api/v1/items');

      // 4. itemGet
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_ITEM_ID }));
      await itemGet(SAMPLE_ITEM_ID);
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/items/${SAMPLE_ITEM_ID}`);

      // 5. itemUpdate
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_ITEM_ID, version: 2 }));
      await itemUpdate(SAMPLE_ITEM_ID, { name: 'wifi-2' }, { idempotencyKey: key, ifMatch: 1 });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/items/${SAMPLE_ITEM_ID}`);
      expect(new Headers(lastFetchInit(fetchMock).headers).get('If-Match')).toBe('"1"');

      // 6. itemDelete
      fetchMock.mockResolvedValueOnce(emptyResponse(204));
      await itemDelete(SAMPLE_ITEM_ID, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/items/${SAMPLE_ITEM_ID}`);
      expect(lastFetchInit(fetchMock).method).toBe('DELETE');

      // 7. itemRestore
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_ITEM_ID }));
      await itemRestore(SAMPLE_ITEM_ID, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/items/${SAMPLE_ITEM_ID}/restore`);
      expect(lastFetchInit(fetchMock).body).toBe('{}');

      // 8. itemTagsAdd
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_ITEM_ID }));
      await itemTagsAdd(SAMPLE_ITEM_ID, { tag_ids: [SAMPLE_TAG_ID] }, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/items/${SAMPLE_ITEM_ID}/tags`);

      // 9. itemTagRemove
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_ITEM_ID }));
      await itemTagRemove(SAMPLE_ITEM_ID, SAMPLE_TAG_ID, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe(
        `/api/v1/items/${SAMPLE_ITEM_ID}/tags/${SAMPLE_TAG_ID}`,
      );

      // 10. itemEntriesReorder
      fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [{ id: SAMPLE_ENTRY_ID, position: 0 }] }));
      await itemEntriesReorder(
        SAMPLE_ITEM_ID,
        { entry_ids: [SAMPLE_ENTRY_ID] },
        { idempotencyKey: key },
      );
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/items/${SAMPLE_ITEM_ID}/entries/reorder`);

      // 11. tagsList
      fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }));
      await tagsList({ q: 'nh', sort: 'alpha' });
      expect(fetchMock.mock.lastCall?.[0]).toBe('/api/v1/tags?q=nh&sort=alpha');

      // 12. tagUpsert
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_TAG_ID, display: 'nhà' }, 201));
      await tagUpsert({ display: 'nhà' }, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe('/api/v1/tags');

      // 13. tagRename
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_TAG_ID, display: 'nhà mới' }));
      await tagRename(SAMPLE_TAG_ID, { display: 'nhà mới' }, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/tags/${SAMPLE_TAG_ID}`);

      // 14. tagDelete
      fetchMock.mockResolvedValueOnce(emptyResponse(204));
      await tagDelete(SAMPLE_TAG_ID, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/tags/${SAMPLE_TAG_ID}`);

      // 15. tagRestore
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_TAG_ID }));
      await tagRestore(SAMPLE_TAG_ID, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/tags/${SAMPLE_TAG_ID}/restore`);
      expect(lastFetchInit(fetchMock).body).toBe('{}');

      // 16. itemEntriesList
      fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }));
      await itemEntriesList(SAMPLE_ITEM_ID, { limit: 200 });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/items/${SAMPLE_ITEM_ID}/entries?limit=200`);

      // 17. entryCreate
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_ENTRY_ID }, 201));
      await entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/items/${SAMPLE_ITEM_ID}/entries`);

      // 18. entryImportJson
      const importPayload: EntryImportJsonRequest = {
        ...SAMPLE_ENTRY_CREATE,
        type: 'json',
        source: 'file',
      };
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_ENTRY_ID }, 201));
      await entryImportJson(SAMPLE_ITEM_ID, importPayload, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe(
        `/api/v1/items/${SAMPLE_ITEM_ID}/entries/import-json`,
      );

      // 19. entryGet
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...SAMPLE_ENTRY_CREATE, item_id: SAMPLE_ITEM_ID, position: 0, version: 1 }),
      );
      await entryGet(SAMPLE_ENTRY_ID);
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/entries/${SAMPLE_ENTRY_ID}`);

      // 20. entryUpdate
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_ENTRY_ID, version: 2 }));
      await entryUpdate(
        SAMPLE_ENTRY_ID,
        {
          envelope: SAMPLE_ENVELOPE,
          ciphertext: 'BBBBBBBBBBBBBBBBBBBBBBBB',
          plaintext_len_bucket: 256,
        },
        { idempotencyKey: key, ifMatch: 1 },
      );
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/entries/${SAMPLE_ENTRY_ID}`);

      // 21. entryDelete
      fetchMock.mockResolvedValueOnce(emptyResponse(204));
      await entryDelete(SAMPLE_ENTRY_ID, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/entries/${SAMPLE_ENTRY_ID}`);

      // 22. entryRestore
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: SAMPLE_ENTRY_ID }));
      await entryRestore(SAMPLE_ENTRY_ID, { idempotencyKey: key });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`/api/v1/entries/${SAMPLE_ENTRY_ID}/restore`);
      expect(lastFetchInit(fetchMock).body).toBe('{}');

      // 23. entriesChanges
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ changes: [], next_cursor: null, watermark: '2026-11-01T00:00:00Z' }),
      );
      await entriesChanges({ since: '2026-11-01T00:00:00Z', limit: 100 });
      expect(fetchMock.mock.lastCall?.[0]).toBe(
        '/api/v1/entries/changes?since=2026-11-01T00%3A00%3A00Z&limit=100',
      );
    });
  });
});
