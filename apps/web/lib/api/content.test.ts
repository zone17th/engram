import { ERROR_CODES, ProblemError, type ProblemDetails } from '@engram/shared-types';
import { MutationObserver, onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook } from '@testing-library/react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  CONTENT_ERROR_I18N_KEYS,
  CONTENT_PROBLEM_CODES,
  classifyContentMutationError,
  classifyPreLookupError,
  contentMutate,
  contentMutationOptions,
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

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hoistedEslint = new ESLint({ cwd: WEB_ROOT });

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

function htmlErrorResponse(status: number, bodyHtml = '<html><body>502 Bad Gateway</body></html>'): Response {
  return new Response(bodyHtml, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
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
    onlineManager.setOnline(true);
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
    onlineManager.setOnline(true);
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
      // Every P04 content code appended in packages/shared-types/src/problem.ts after passkey_not_found, up to and
      // including changes_window_expired (later appends, e.g. authui reset_token_invalid, are not content codes).
      const passkeyIdx = ERROR_CODES.indexOf('passkey_not_found');
      expect(passkeyIdx).toBeGreaterThan(0);
      const lastContentIdx = ERROR_CODES.indexOf('changes_window_expired');
      expect(lastContentIdx).toBeGreaterThan(passkeyIdx);
      const p04CodesFromCatalog = ERROR_CODES.slice(passkeyIdx + 1, lastContentIdx + 1);
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

    it('CCFE6: caps in-helper Retry-After waits at ≤ 30 s, throws immediately with retryAfterSeconds exposed when Retry-After > 30 s (e.g. 900), and cancels wait on AbortSignal', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();

      // 1) Retry-After: 900 exceeds the 30 s cap -> throws immediately on first send without waiting or retrying
      fetchMock.mockResolvedValueOnce(
        problemResponse('rate_limited', 429, { retry_after: 900 }, { 'Retry-After': '900' }),
      );

      let caughtLong429: unknown;
      try {
        await tagUpsert({ display: 'nhà' }, { idempotencyKey });
      } catch (err) {
        caughtLong429 = err;
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(caughtLong429).toBeInstanceOf(ProblemError);
      expect(caughtLong429).toMatchObject({
        retryAfterSeconds: 900,
        problem: { code: 'rate_limited', status: 429, retry_after: 900 },
      });
      const classified = classifyContentMutationError(caughtLong429);
      expect(classified.kind).toBe('rate_limited');
      expect(classified.retryAfterSeconds).toBe(900);
      expect(classified.canRetrySameBytes).toBe(true);
      expect(classified.isLogoutBoundary).toBe(false);

      // 2) Retry-After: 20 (≤ 30 s) sleeps, and aborting the lock/logout AbortSignal cancels the sleep so it never fires after lock
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(
        problemResponse('rate_limited', 429, { retry_after: 20 }, { 'Retry-After': '20' }),
      );
      const lockAbort = new AbortController();
      const pAbort = entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, {
        idempotencyKey,
        signal: lockAbort.signal,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      lockAbort.abort(new DOMException('Vault locked', 'AbortError'));

      await expect(pAbort).rejects.toThrow(/Vault locked|Aborted/);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('CCFE2: auto-retries non-ProblemError 5xx (e.g. 502 HTML after a lost response) up to 2 times with identical body bytes and key, and classifies it as retryable', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();
      const expectedSerialized = JSON.stringify(SAMPLE_ENTRY_CREATE);

      // Subcase 1: 502 HTML on attempt 0 (after server committed or lost response) -> retries after 1 s with identical bytes + key -> 201
      fetchMock
        .mockResolvedValueOnce(htmlErrorResponse(502))
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

      const recoverPromise = entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, { idempotencyKey });
      await vi.advanceTimersByTimeAsync(1_000);
      const recovered = await recoverPromise;
      expect(recovered.id).toBe(SAMPLE_ENTRY_ID);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      for (const [, init] of fetchMock.mock.calls) {
        const reqInit = init as RequestInit;
        expect(reqInit.body).toBe(expectedSerialized);
        expect(new Headers(reqInit.headers).get('Idempotency-Key')).toBe(idempotencyKey);
      }

      // Subcase 2: persistent 502 HTML across all 3 attempts (initial + 2 auto-retries) -> surfaces retryable server_unavailable
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(htmlErrorResponse(502))
        .mockResolvedValueOnce(htmlErrorResponse(502))
        .mockResolvedValueOnce(htmlErrorResponse(502));

      let caught502: unknown;
      const failPromise = entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, { idempotencyKey }).catch(
        (err: unknown) => {
          caught502 = err;
        },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await failPromise;

      expect(fetchMock).toHaveBeenCalledTimes(3);
      for (const [, init] of fetchMock.mock.calls) {
        const reqInit = init as RequestInit;
        expect(reqInit.body).toBe(expectedSerialized);
        expect(new Headers(reqInit.headers).get('Idempotency-Key')).toBe(idempotencyKey);
      }

      expect(caught502).toBeInstanceOf(Error);
      expect(caught502).not.toBeInstanceOf(ProblemError);
      const classified502 = classifyContentMutationError(caught502, { hadUncertainSend: true });
      expect(classified502.kind).toBe('server_unavailable');
      expect(classified502.status).toBe(502);
      expect(classified502.canRetrySameBytes).toBe(true);
      expect(classified502.isLogoutBoundary).toBe(false);
      expect(classified502.preLookupRecovery).toBe('replay_same_request');
      expect(classified502.i18nKey).toBe('content.errors.dependency_unavailable');
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

    it('advisor-dec-203 (HM18-R3-3): invokes onAttempt in order with { attempt, uncertainOutcome } for clean send, retry after uncertain send, hard failure, and preserves identical behavior without onAttempt', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;

      // 1. Clean send (single attempt, uncertainOutcome: false)
      const cleanAttempts: Array<{ readonly attempt: number; readonly uncertainOutcome: boolean }> = [];
      fetchMock.mockResolvedValueOnce(
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
      const created = await entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, {
        idempotencyKey: createIdempotencyKey(),
        onAttempt: (outcome) => {
          expect(Object.keys(outcome).sort()).toEqual(['attempt', 'uncertainOutcome']);
          cleanAttempts.push(outcome);
        },
      });
      expect(created.id).toBe(SAMPLE_ENTRY_ID);
      expect(cleanAttempts).toEqual([{ attempt: 1, uncertainOutcome: false }]);

      // 2. Retry after an uncertain send (attempt 1: TypeError -> uncertainOutcome: true; attempt 2: 503 -> uncertainOutcome: true; attempt 3: 201 -> uncertainOutcome: false)
      fetchMock.mockReset();
      const retryAttempts: Array<{ readonly attempt: number; readonly uncertainOutcome: boolean }> = [];
      fetchMock
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(problemResponse('dependency_unavailable', 503, { retry_after: 1 }))
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
      const retryPromise = entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, {
        idempotencyKey: createIdempotencyKey(),
        onAttempt: (outcome) => {
          retryAttempts.push(outcome);
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const retriedCreated = await retryPromise;
      expect(retriedCreated.id).toBe(SAMPLE_ENTRY_ID);
      expect(retryAttempts).toEqual([
        { attempt: 1, uncertainOutcome: true },
        { attempt: 2, uncertainOutcome: true },
        { attempt: 3, uncertainOutcome: false },
      ]);

      // 3. Hard failure (e.g. 401 session_invalid after uncertain send, or direct 409 item_tag_limit)
      fetchMock.mockReset();
      const hardFailAttempts: Array<{ readonly attempt: number; readonly uncertainOutcome: boolean }> = [];
      fetchMock
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(problemResponse('session_invalid', 401));
      await expect(
        entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, {
          idempotencyKey: createIdempotencyKey(),
          onAttempt: (outcome) => {
            hardFailAttempts.push(outcome);
          },
        }),
      ).rejects.toMatchObject({
        name: 'ProblemError',
        problem: { code: 'session_invalid', status: 401 },
      });
      expect(hardFailAttempts).toEqual([
        { attempt: 1, uncertainOutcome: true },
        { attempt: 2, uncertainOutcome: false },
      ]);

      // 4. Identical behavior when onAttempt is omitted
      fetchMock.mockReset();
      fetchMock
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(problemResponse('session_invalid', 401));
      await expect(
        entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, {
          idempotencyKey: createIdempotencyKey(),
        }),
      ).rejects.toMatchObject({
        name: 'ProblemError',
        problem: { code: 'session_invalid', status: 401 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // 5. A throwing onAttempt callback never alters response resolution, retry flow, or error mapping
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(
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
      const createdDespiteThrow = await entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, {
        idempotencyKey: createIdempotencyKey(),
        onAttempt: () => {
          throw new Error('observer callback boom');
        },
      });
      expect(createdDespiteThrow.id).toBe(SAMPLE_ENTRY_ID);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockReset();
      fetchMock
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(problemResponse('session_invalid', 401));
      await expect(
        entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, {
          idempotencyKey: createIdempotencyKey(),
          onAttempt: () => {
            throw new Error('observer callback boom on failure');
          },
        }),
      ).rejects.toMatchObject({
        name: 'ProblemError',
        problem: { code: 'session_invalid', status: 401 },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('pre-lookup 401/403 split (SPEC §3.4, advisor-dec-098/119/121, CFE5-3, CBE4-1)', () => {
    it('CFE5-3 & CCFE9: reuses authFetch refresh path (no second refresh) and sends identical Idempotency-Key, If-Match, and body string on auto-retry for both access_expired and unauthenticated with session CSRF', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();
      const ifMatch = formatVersionIfMatch(3);
      const body: EntryUpdateRequest = {
        envelope: SAMPLE_ENVELOPE,
        ciphertext: 'BBBBBBBBBBBBBBBBBBBBBBBB',
        plaintext_len_bucket: 256,
      };
      const expectedSerialized = JSON.stringify(body);

      // Subcase 1: unauthenticated (with session CSRF cookie present) -> refresh -> replay
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
      const refreshCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/refresh'));
      expect(refreshCalls).toHaveLength(1);

      const entryCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes(`/entries/${SAMPLE_ENTRY_ID}`),
      );
      expect(entryCalls).toHaveLength(2);
      for (const [, init] of entryCalls) {
        const reqInit = init as RequestInit;
        expect(reqInit.body).toBe(expectedSerialized);
        expect(new Headers(reqInit.headers).get('Idempotency-Key')).toBe(idempotencyKey);
        expect(new Headers(reqInit.headers).get('If-Match')).toBe(ifMatch);
      }

      // Subcase 2: access_expired -> refresh -> replay with identical body bytes, key, and If-Match
      fetchMock.mockReset();
      const idempotencyKey2 = createIdempotencyKey();
      fetchMock
        .mockResolvedValueOnce(problemResponse('access_expired', 401))
        .mockResolvedValueOnce(problemResponse('access_expired', 401))
        .mockResolvedValueOnce(emptyResponse(204))
        .mockResolvedValueOnce(
          jsonResponse({
            id: SAMPLE_ENTRY_ID,
            item_id: SAMPLE_ITEM_ID,
            type: 'text',
            position: 0,
            version: 5,
            plaintext_len_bucket: 256,
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:03Z',
          }),
        );

      const updated2 = await entryUpdate(SAMPLE_ENTRY_ID, body, {
        idempotencyKey: idempotencyKey2,
        ifMatch: formatVersionIfMatch(4),
      });
      expect(updated2.version).toBe(5);

      const refreshCalls2 = fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/refresh'));
      expect(refreshCalls2).toHaveLength(1);
      const entryCalls2 = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes(`/entries/${SAMPLE_ENTRY_ID}`),
      );
      expect(entryCalls2).toHaveLength(2);
      for (const [, init] of entryCalls2) {
        const reqInit = init as RequestInit;
        expect(reqInit.body).toBe(expectedSerialized);
        expect(new Headers(reqInit.headers).get('Idempotency-Key')).toBe(idempotencyKey2);
        expect(new Headers(reqInit.headers).get('If-Match')).toBe('"4"');
      }
    });

    it('CCFE8: bootstraps CSRF and replays once with the same bytes and key when csrf_invalid occurs on the first send (within the 2-retry budget)', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();
      const expectedSerialized = JSON.stringify(SAMPLE_ENTRY_CREATE);

      // 1) First send gets 403 csrf_invalid immediately (no prior uncertain send)
      // 2) contentMutate bootstraps GET /auth/csrf -> 204
      // 3) Replay sends identical body bytes + key -> 201
      fetchMock
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

      const csrfCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/csrf'));
      expect(csrfCalls).toHaveLength(1);

      const postCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes(`/items/${SAMPLE_ITEM_ID}/entries`),
      );
      expect(postCalls).toHaveLength(2);
      for (const [, init] of postCalls) {
        const reqInit = init as RequestInit;
        expect(reqInit.body).toBe(expectedSerialized);
        expect(new Headers(reqInit.headers).get('Idempotency-Key')).toBe(idempotencyKey);
      }
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

      // Case 1b (CCFE9): session CSRF present, initial send gets 401 unauthenticated, conditional POST /auth/refresh fails with 401 unauthenticated -> terminal case (b), no replay
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        writable: true,
        value: `sabk_csrf=${sessionCsrfCookie()}`,
      });
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401)) // initial mutation -> 401
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401)) // lock GET /auth/me -> 401
        .mockResolvedValueOnce(problemResponse('unauthenticated', 401)); // POST /auth/refresh -> 401 terminal

      let caughtRefresh401: unknown;
      try {
        await entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, { idempotencyKey });
      } catch (err) {
        caughtRefresh401 = err;
      }
      expect(caughtRefresh401).toBeInstanceOf(ProblemError);
      const postRefresh401Calls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes(`/items/${SAMPLE_ITEM_ID}/entries`),
      );
      expect(postRefresh401Calls).toHaveLength(1);
      const classifiedRefresh401 = classifyContentMutationError(caughtRefresh401, {
        hadUncertainSend: true,
      });
      expect(classifiedRefresh401.kind).toBe('terminal_auth');
      expect(classifiedRefresh401.isLogoutBoundary).toBe(true);
      expect(classifiedRefresh401.canRetrySameBytes).toBe(false);
      expect(classifiedRefresh401.preLookupRecovery).toBe('terminal_logout_boundary');

      // Case 2: session_invalid after uncertain send -> ends immediately, no replay
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

    it('CBE4-1 & CCFE2 & CCFE9: a refresh that fails on a network error, Problem 5xx, or non-Problem 502 HTML is NOT a logout; re-sends identical bytes/key across attempts and surfaces a retryable error', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const idempotencyKey = createIdempotencyKey();
      const expectedSerialized = JSON.stringify(SAMPLE_ENTRY_CREATE);

      const assertAllEntryPostCallsMatch = () => {
        const entryPostCalls = fetchMock.mock.calls.filter(([url]) =>
          String(url).includes(`/items/${SAMPLE_ITEM_ID}/entries`),
        );
        expect(entryPostCalls).toHaveLength(3);
        for (const [, init] of entryPostCalls) {
          const reqInit = init as RequestInit;
          expect(reqInit.body).toBe(expectedSerialized);
          expect(new Headers(reqInit.headers).get('Idempotency-Key')).toBe(idempotencyKey);
        }
      };

      // Subcase A: lost response -> retry gets 401 unauthenticated -> conditional refresh fails with network TypeError
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

      assertAllEntryPostCallsMatch();
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

      assertAllEntryPostCallsMatch();
      expect(surfaced503Err).toBeInstanceOf(ProblemError);
      const classified503 = classifyContentMutationError(surfaced503Err, {
        hadUncertainSend: true,
      });
      expect(classified503.kind).toBe('server_unavailable');
      expect(classified503.isLogoutBoundary).toBe(false);
      expect(classified503.canRetrySameBytes).toBe(true);
      expect(classified503.preLookupRecovery).toBe('replay_same_request');

      // Subcase C (CCFE2): refresh POST returns 502 HTML (non-ProblemError 5xx) -> auto-retried with identical bytes + key, classified retryable
      fetchMock.mockReset();
      fetchMock
        .mockRejectedValueOnce(networkOutage) // attempt 0: lost mutation response
        .mockResolvedValueOnce(problemResponse('access_expired', 401)) // attempt 1: hits access_expired
        .mockResolvedValueOnce(problemResponse('access_expired', 401)) // refresh lock: GET /auth/me
        .mockResolvedValueOnce(htmlErrorResponse(502)) // refresh lock: POST /auth/refresh -> 502 HTML
        .mockResolvedValueOnce(problemResponse('access_expired', 401)) // refresh lock: probe GET /auth/me -> rethrows 502 Error
        .mockResolvedValueOnce(htmlErrorResponse(502)); // attempt 2: 502 HTML

      let surfacedRefresh502: unknown;
      const pRefresh502 = entryCreate(SAMPLE_ITEM_ID, SAMPLE_ENTRY_CREATE, { idempotencyKey }).catch(
        (err: unknown) => {
          surfacedRefresh502 = err;
        },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await pRefresh502;

      assertAllEntryPostCallsMatch();
      expect(surfacedRefresh502).toBeInstanceOf(Error);
      expect(surfacedRefresh502).not.toBeInstanceOf(ProblemError);
      const classifiedRefresh502 = classifyContentMutationError(surfacedRefresh502, {
        hadUncertainSend: true,
      });
      expect(classifiedRefresh502.kind).toBe('server_unavailable');
      expect(classifiedRefresh502.status).toBe(502);
      expect(classifiedRefresh502.isLogoutBoundary).toBe(false);
      expect(classifiedRefresh502.canRetrySameBytes).toBe(true);
      expect(classifiedRefresh502.preLookupRecovery).toBe('replay_same_request');
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

      // Never let `act` itself reject (CCFE4-1): a rejecting act() callback makes React report
      // "overlapping act() calls" and leaves the act environment broken for the next test. Catch the
      // expected rejection INSIDE the callback so act always resolves, then assert on the captured error.
      let plaintextError: unknown;
      await act(async () => {
        try {
          await result.current.mutateAsync({
            plaintext: 'secret-text',
          } as unknown as EntryCreateRequest);
        } catch (e) {
          plaintextError = e;
        }
      });
      expect(plaintextError).toBeInstanceOf(Error);
      expect(String(plaintextError)).toMatch(/forbids plaintext fields/);

      await act(async () => {
        await result.current.mutateAsync(SAMPLE_ENTRY_CREATE);
      });

      unmount();
      // With gcTime: 0, inactive mutation entries are garbage-collected immediately.
      await vi.advanceTimersByTimeAsync(0);
      expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    });

    it('CCFE3 (advisor-dec-134): useContentMutation wires contentMutationOptions into useMutation (gcTime 0, retry false, networkMode always, plaintext guard)', async () => {
      // Real timers: the offline-proof/probe flow needs no fake clock, and the whole React commit
      // pipeline then runs on its native schedulers (afterEach restores the file-level fake timers).
      vi.useRealTimers();
      const queryClient = new QueryClient();
      // Probe component instead of renderHook: capture the hook value DURING RENDER so the test never
      // depends on an effect flush (CI r41267951137 saw renderHook's `result.current` null here).
      type ContentMutation = ReturnType<
        typeof useContentMutation<{ ok: boolean }, Error, EntryCreateRequest>
      >;
      let hook: ContentMutation | undefined;
      function Probe() {
        hook = useContentMutation<{ ok: boolean }, Error, EntryCreateRequest>({
          mutationFn: async (vars) => ({ ok: Boolean(vars.id) }),
        });
        return null;
      }
      const { unmount } = render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)),
      );
      try {
        expect(hook, 'Probe did not render useContentMutation').toBeDefined();
        const mutation$ = hook as ContentMutation;

        await act(async () => {
          await mutation$.mutateAsync(SAMPLE_ENTRY_CREATE);
        });
        // The mutation is still in the cache while the hook is mounted: its options are what the hook passed.
        const mutation = queryClient.getMutationCache().getAll()[0];
        expect(mutation?.options).toMatchObject({ gcTime: 0, retry: false, networkMode: 'always' });
        const built = contentMutationOptions<{ ok: boolean }, Error, EntryCreateRequest>({
          mutationFn: async (vars) => ({ ok: Boolean(vars.id) }),
        });
        expect(built).toMatchObject({ gcTime: 0, retry: false, networkMode: 'always' });
        await expect(
          built.mutationFn?.({ plaintext: 'x' } as unknown as EntryCreateRequest, undefined as never),
        ).rejects.toThrow(/forbids plaintext fields/);
      } finally {
        unmount();
      }
    });

    it(
      'CCFE3 & CCFE2-2: contentMutationOptions forces networkMode "always" so mutations run immediately under onlineManager.setOnline(false), while plain options stay isPaused (no React)',
      async () => {
        const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
        const queryClient = new QueryClient();
        try {
          onlineManager.setOnline(false);
          Object.defineProperty(navigator, 'onLine', {
            value: false,
            configurable: true,
            writable: true,
          });

          // 1) Negative proof (CCFE2-2): default networkMode "online" pauses and NEVER calls fetch.
          const pausedKey = createIdempotencyKey();
          const plainObserver = new MutationObserver<unknown, Error, EntryCreateRequest>(queryClient, {
            mutationFn: (vars) => entryCreate(SAMPLE_ITEM_ID, vars, { idempotencyKey: pausedKey }),
          });
          // Not awaited: a paused mutation stays pending until the network returns.
          plainObserver.mutate(SAMPLE_ENTRY_CREATE).catch(() => undefined);
          await vi.advanceTimersByTimeAsync(0);
          expect(plainObserver.getCurrentResult().isPaused).toBe(true);
          expect(fetchMock).toHaveBeenCalledTimes(0);
          plainObserver.reset();
          queryClient.getMutationCache().clear();

          // 2) Positive proof (CCFE3): contentMutationOptions executes immediately while offline
          // (3 attempts, network retries have zero delay) and surfaces an `offline` error.
          const key = createIdempotencyKey();
          const contentObserver = new MutationObserver<unknown, Error, EntryCreateRequest>(
            queryClient,
            contentMutationOptions<unknown, Error, EntryCreateRequest>({
              mutationFn: (vars) => entryCreate(SAMPLE_ITEM_ID, vars, { idempotencyKey: key }),
            }),
          );
          const caught = await contentObserver.mutate(SAMPLE_ENTRY_CREATE).catch((err: unknown) => err);

          expect(contentObserver.getCurrentResult().isPaused).toBe(false);
          expect(fetchMock).toHaveBeenCalledTimes(3);
          expect(caught).toBeInstanceOf(TypeError);
          const classified = classifyContentMutationError(caught);
          expect(classified.kind).toBe('offline');
          expect(classified.i18nKey).toBe('content.errors.offline');
          expect(classified.canRetrySameBytes).toBe(true);
        } finally {
          onlineManager.setOnline(true);
          queryClient.getMutationCache().clear();
        }
      },
      15_000,
    );

    it(
      'CCFE11 (P4FE2-16): ESLint no-restricted-imports bans useMutation from @tanstack/react-query in features/{items,entries,json-table,omnibox,tags}/** and allows useContentMutation',
      async () => {
        vi.useRealTimers();

        // 1) Importing useMutation in a P04 content feature directory triggers no-restricted-imports error
        const [badResult] = await hoistedEslint.lintText(
          "import { useMutation } from '@tanstack/react-query';\nexport const x = useMutation;\n",
          { filePath: path.join(WEB_ROOT, 'features/items/forbidden-mutation-fixture.ts') },
        );
        expect(badResult).toBeDefined();
        const restrictedMsgs = (badResult?.messages ?? []).filter(
          (m) => m.ruleId === 'no-restricted-imports',
        );
        expect(restrictedMsgs.length).toBeGreaterThan(0);
        expect(restrictedMsgs[0]?.message).toMatch(/useContentMutation/);

        // 2) Importing useQuery from @tanstack/react-query and useContentMutation from @/lib/api/content is allowed
        const [goodResult] = await hoistedEslint.lintText(
          "import { useQuery } from '@tanstack/react-query';\nimport { useContentMutation } from '@/lib/api/content';\nexport const q = [useQuery, useContentMutation];\n",
          { filePath: path.join(WEB_ROOT, 'features/items/allowed-mutation-fixture.ts') },
        );
        const goodRestrictedMsgs = (goodResult?.messages ?? []).filter(
          (m) => m.ruleId === 'no-restricted-imports',
        );
        expect(goodRestrictedMsgs).toHaveLength(0);

        // 3) Importing useMutation outside P04 content directories (e.g. features/vault/**) is unaffected
        const [vaultResult] = await hoistedEslint.lintText(
          "import { useMutation } from '@tanstack/react-query';\nexport const v = useMutation;\n",
          { filePath: path.join(WEB_ROOT, 'features/vault/allowed-vault-mutation-fixture.ts') },
        );
        const vaultRestrictedMsgs = (vaultResult?.messages ?? []).filter(
          (m) => m.ruleId === 'no-restricted-imports',
        );
        expect(vaultRestrictedMsgs).toHaveLength(0);
      },
      30_000,
    );
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
