import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ProblemCode =
  | 'access_expired'
  | 'dependency_unavailable'
  | 'invalid_credentials'
  | 'session_invalid'
  | 'unauthenticated';

function problemResponse(code: ProblemCode, status = code === 'dependency_unavailable' ? 503 : 401, extra = {}) {
  return new Response(
    JSON.stringify({
      type: `https://key.zone17th.click/problems/${code}`,
      title: code,
      status,
      code,
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status = 204) {
  return new Response(null, { status });
}

function sessionCsrfCookie(): string {
  const payload = btoa('v1|sess|00000000-0000-0000-0000-000000000001|nonce|4102444800')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${payload}.test-signature`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function queuedLocks() {
  let active = false;
  const waiters: Array<() => void> = [];
  const request = vi.fn(async (_name: string, callback: () => Promise<unknown>) => {
    await new Promise<void>((resolve) => {
      if (!active) {
        active = true;
        resolve();
      } else {
        waiters.push(() => {
          active = true;
          resolve();
        });
      }
    });
    try {
      return await callback();
    } finally {
      active = false;
      waiters.shift()?.();
    }
  });
  return { request };
}

describe('authFetch refresh coordination', () => {
  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: async (_name: string, fn: () => Promise<unknown>) => fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('retries once after access_expired on session-required routes', async () => {
    const { authFetch } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await authFetch<{ ok: boolean }>('/auth/me', { requireSession: true });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/auth/refresh');
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit | undefined)?.method).toBe('POST');
  });

  it('POSTs refresh only when the lock-time Me is still expired', async () => {
    const { authFetch } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(authFetch<{ ok: boolean }>('/auth/sessions', { requireSession: true })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/auth/refresh');
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).method).toBe('POST');
    expect(new Headers((fetchMock.mock.calls[2]?.[1] as RequestInit).headers).get('content-type')).toBe(
      'application/json',
    );
  });

  it('recovers a missing access cookie only with session-bound CSRF evidence', async () => {
    document.cookie = `sabk_csrf=${sessionCsrfCookie()}`;
    const { authFetch } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(problemResponse('unauthenticated'))
      .mockResolvedValueOnce(problemResponse('unauthenticated'))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(authFetch<{ ok: boolean }>('/auth/me', { requireSession: true })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/auth/refresh');
  });

  it('does not refresh when Web Locks are missing', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: undefined });
    const { authFetch } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(problemResponse('access_expired'));

    await expect(authFetch('/auth/me', { requireSession: true })).rejects.toMatchObject({
      name: 'ProblemError',
      problem: { code: 'access_expired' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refresh unauthenticated signed-out Me without session evidence', async () => {
    const { authFetch } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(problemResponse('unauthenticated'));

    await expect(authFetch('/auth/me', { requireSession: true })).rejects.toMatchObject({
      name: 'ProblemError',
      problem: { code: 'unauthenticated' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves a terminal session_invalid reason from the lock-time probe', async () => {
    const { authFetch } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockResolvedValueOnce(problemResponse('session_invalid', 401, { reason: 'revoked' }));

    await expect(authFetch('/auth/me', { requireSession: true })).rejects.toMatchObject({
      name: 'ProblemError',
      problem: { code: 'session_invalid', reason: 'revoked' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('broadcasts a terminal retry failure after a successful refresh', async () => {
    const { authFetch } = await import('@/lib/api/auth-fetch');
    const { subscribeSessionBroadcast } = await import('@/lib/auth/broadcast');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const signedOut = vi.fn();
    const unsubscribe = subscribeSessionBroadcast((message, origin) => {
      if (origin === 'local' && message.type === 'signed_out') signedOut(message);
    });
    fetchMock
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(problemResponse('session_invalid', 401, { reason: 'revoked' }));

    try {
      await expect(authFetch('/auth/me', { requireSession: true })).rejects.toMatchObject({
        name: 'ProblemError',
        problem: { code: 'session_invalid', reason: 'revoked' },
      });
      expect(signedOut).toHaveBeenCalledWith(expect.objectContaining({ reason: 'revoked' }));
    } finally {
      unsubscribe();
    }
  });

  it('preserves a transient refresh failure after one Me probe', async () => {
    const { authFetch } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const offline = new TypeError('Failed to fetch');
    fetchMock
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockRejectedValueOnce(offline)
      .mockResolvedValueOnce(problemResponse('access_expired'));

    await expect(authFetch('/auth/me', { requireSession: true })).rejects.toBe(offline);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('preserves a 503 refresh problem after one Me probe', async () => {
    const { authFetch } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockResolvedValueOnce(problemResponse('dependency_unavailable'))
      .mockResolvedValueOnce(problemResponse('access_expired'));

    await expect(authFetch('/auth/me', { requireSession: true })).rejects.toMatchObject({
      name: 'ProblemError',
      problem: { code: 'dependency_unavailable', status: 503 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('shares one refresh between concurrent authFetch calls under a queued lock', async () => {
    const locks = queuedLocks();
    vi.stubGlobal('navigator', { ...navigator, locks });
    const { authFetch } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const probe = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockResolvedValueOnce(problemResponse('access_expired'))
      .mockReturnValueOnce(probe.promise)
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const first = authFetch<{ ok: boolean }>('/auth/me', { requireSession: true });
    const second = authFetch<{ ok: boolean }>('/auth/sessions', { requireSession: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(locks.request).toHaveBeenCalledTimes(1);
    probe.resolve(problemResponse('access_expired'));

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/auth/refresh'))).toHaveLength(1);
    expect(locks.request).toHaveBeenCalledTimes(1);
  });

  it('keeps authFetch queued behind a lock-held authMutate refresh', async () => {
    const locks = queuedLocks();
    vi.stubGlobal('navigator', { ...navigator, locks });
    const { authFetch, authMutate } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const probe = deferred<Response>();
    let meCalls = 0;
    let settingsCalls = 0;
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/me')) {
        meCalls += 1;
        if (meCalls === 1) return problemResponse('access_expired');
        if (meCalls === 2) return probe.promise;
        // The fixed implementation acquires the queued lock before this
        // probe; the buggy shared hold counter bypasses that queue.
        if (locks.request.mock.calls.length >= 2) return jsonResponse({ ok: true });
        return problemResponse('access_expired');
      }
      if (url.endsWith('/me/settings')) {
        settingsCalls += 1;
        return settingsCalls === 1 ? problemResponse('access_expired') : jsonResponse({ ok: true });
      }
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        return refreshCalls === 1
          ? emptyResponse()
          : problemResponse('session_invalid', 401, { reason: 'revoked' });
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const mutation = authMutate('/me/settings', { method: 'PATCH', json: { locale: 'en' } });
    const read = authFetch<{ ok: boolean }>('/auth/me', { requireSession: true });
    await vi.waitFor(() => expect(meCalls).toBe(2));
    expect(locks.request).toHaveBeenCalledTimes(2);
    probe.resolve(problemResponse('access_expired'));

    await expect(Promise.all([mutation, read])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(refreshCalls).toBe(1);
  });

  it('treats 202 Accepted with an empty body as success', async () => {
    const { authMutate } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(emptyResponse(202));

    await expect(
      authMutate('/me/email', { method: 'POST', json: { new_email: 'new@example.test' } }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refresh invalid_credentials', async () => {
    const { authFetch } = await import('@/lib/api/auth-fetch');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(problemResponse('invalid_credentials'));

    await expect(authFetch('/auth/login', { method: 'POST', requireSession: false })).rejects.toMatchObject({
      name: 'ProblemError',
      problem: { code: 'invalid_credentials' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps session epochs monotonic across a sign-out reset', async () => {
    const { bumpSessionEpoch, getSessionEpoch, resetSessionEpoch } = await import('@/lib/api/auth-fetch');
    bumpSessionEpoch();
    const activeEpoch = getSessionEpoch();

    resetSessionEpoch();

    expect(getSessionEpoch()).toBe(activeEpoch + 1);
  });
});
