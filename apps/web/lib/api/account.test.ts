import { ProblemError } from '@engram/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyAccountDeleteError,
  deleteAccount,
  isAccountDeleteReauthProblem,
} from '@/lib/api/account';

function problemResponse(
  code: string,
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
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
        ...headers,
      },
    },
  );
}

describe('lib/api/account', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    Object.defineProperty(document, 'cookie', {
      writable: true,
      value: 'sabk_csrf=test-csrf-token',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls DELETE /api/v1/me with confirm_email, X-CSRF-Token, X-Reauth-Token, and Idempotency-Key and resolves on 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await deleteAccount({
      confirmEmail: 'an@example.com',
      reauthToken: 'reauth-grant-123',
      idempotencyKey: '11111111-2222-4333-8444-555555555555',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/me');
    expect(init?.method).toBe('DELETE');
    const headers = new Headers(init?.headers);
    expect(headers.get('X-CSRF-Token')).toBe('test-csrf-token');
    expect(headers.get('X-Reauth-Token')).toBe('reauth-grant-123');
    expect(headers.get('Idempotency-Key')).toBe('11111111-2222-4333-8444-555555555555');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      confirm_email: 'an@example.com',
    });
  });

  it('generates a UUID v4 Idempotency-Key when omitted and propagates ProblemError on failure', async () => {
    fetchMock.mockResolvedValueOnce(
      problemResponse('account_delete_confirm_invalid', 400),
    );

    await expect(
      deleteAccount({
        confirmEmail: 'wrong@example.com',
        reauthToken: 'reauth-grant-456',
      }),
    ).rejects.toMatchObject({
      problem: { status: 400, code: 'account_delete_confirm_invalid' },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get('Idempotency-Key')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('classifies 400 account_delete_confirm_invalid, 401 reauth_required/reauth_invalid, 429 rate_limited, 503 dependency_unavailable, offline, and 5xx generic errors', () => {
    const fixedNow = new Date(2026, 10, 8, 14, 0, 0).getTime();

    const confirmErr = new ProblemError({
      type: 'about:blank',
      title: 'Confirm email mismatch',
      status: 400,
      code: 'account_delete_confirm_invalid',
    });
    expect(classifyAccountDeleteError(confirmErr, fixedNow)).toEqual({
      kind: 'confirm_email_invalid',
      problemCode: 'account_delete_confirm_invalid',
      status: 400,
      canRetrySameOperation: false,
    });

    const reauthReqErr = new ProblemError({
      type: 'about:blank',
      title: 'Reauth required',
      status: 401,
      code: 'reauth_required',
    });
    expect(isAccountDeleteReauthProblem(reauthReqErr)).toBe(true);
    expect(classifyAccountDeleteError(reauthReqErr, fixedNow)).toEqual({
      kind: 'reauth_expired',
      problemCode: 'reauth_required',
      status: 401,
      canRetrySameOperation: true,
    });

    const reauthInvErr = new ProblemError({
      type: 'about:blank',
      title: 'Reauth invalid',
      status: 401,
      code: 'reauth_invalid',
    });
    expect(isAccountDeleteReauthProblem(reauthInvErr)).toBe(true);
    expect(classifyAccountDeleteError(reauthInvErr, fixedNow)).toEqual({
      kind: 'reauth_expired',
      problemCode: 'reauth_invalid',
      status: 401,
      canRetrySameOperation: true,
    });

    const rateLimitErr = new ProblemError({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      code: 'rate_limited',
      retry_after: 60,
    });
    expect(classifyAccountDeleteError(rateLimitErr, fixedNow)).toEqual({
      kind: 'rate_limited',
      problemCode: 'rate_limited',
      status: 429,
      retryAfterSeconds: 60,
      retryClock: '14:01',
      canRetrySameOperation: true,
    });

    const pausedErr = new ProblemError({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      code: 'dependency_unavailable',
      retry_after: 120,
    });
    expect(classifyAccountDeleteError(pausedErr, fixedNow)).toEqual({
      kind: 'paused',
      problemCode: 'dependency_unavailable',
      status: 503,
      retryAfterSeconds: 120,
      retryClock: '14:02',
      canRetrySameOperation: true,
    });

    const conflictErr = new ProblemError({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'idempotency_conflict',
    });
    expect(classifyAccountDeleteError(conflictErr, fixedNow)).toEqual({
      kind: 'generic',
      problemCode: 'idempotency_conflict',
      status: 409,
      canRetrySameOperation: false,
    });

    const serverErr = new ProblemError({
      type: 'about:blank',
      title: 'Internal Error',
      status: 500,
      code: 'internal_error',
    });
    expect(classifyAccountDeleteError(serverErr, fixedNow)).toEqual({
      kind: 'generic',
      problemCode: 'internal_error',
      status: 500,
      canRetrySameOperation: true,
    });

    expect(classifyAccountDeleteError(new TypeError('Failed to fetch'), fixedNow)).toEqual({
      kind: 'offline',
      canRetrySameOperation: true,
    });
  });
});
