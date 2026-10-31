import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// HOTFIX (advisor-dec-090): on production, signing out and then signing in again in the same tab
// failed with csrf_invalid until a reload. POST /auth/logout clears sabk_csrf and sabk_anon, and
// SessionProvider only bootstraps GET /auth/csrf once per page load. This fake API mirrors those
// cookie rules so the test fails without the client re-issuing the anonymous CSRF pair.

const CSRF = 'sabk_csrf';

function readCookie(name: string): string | null {
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return decodeURIComponent(trimmed.slice(name.length + 1));
  }
  return null;
}

function setCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/`;
}

function clearCookie(name: string) {
  document.cookie = `${name}=; path=/; max-age=0`;
}

function problem(code: string, status: number) {
  return new Response(JSON.stringify({ type: `https://engram.zone17.click/problems/${code}`, title: code, status, code }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

const ME = {
  user: { id: 'u1', email: 'user@example.test', email_verified: true, created_at: '2026-10-01T00:00:00Z' },
};

/** Minimal stand-in for the API's CSRF rules (authhttp.CSRF, Logout, applySession). */
function fakeApi() {
  let session = false;
  let anonSeq = 0;
  const calls: Array<{ path: string; method: string; csrfHeader: string | null }> = [];
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('/api/v1', '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const csrfHeader = new Headers(init?.headers).get('X-CSRF-Token');
    calls.push({ path, method, csrfHeader });

    if (path === '/auth/csrf' && method === 'GET') {
      if (!session) {
        anonSeq += 1;
        setCookie(CSRF, `anon-${anonSeq}`);
      }
      return new Response(null, { status: 204 });
    }
    if (method !== 'GET') {
      // Double-submit: header must equal the cookie and match the caller's kind.
      const cookie = readCookie(CSRF);
      const wantKind = session ? 'sess' : 'anon';
      if (!cookie || cookie !== csrfHeader || !cookie.startsWith(wantKind)) {
        return problem('csrf_invalid', 403);
      }
    }
    if (path === '/auth/logout') {
      session = false;
      clearCookie(CSRF);
      return new Response(null, { status: 204 });
    }
    if (path === '/auth/login' || path === '/auth/signup') {
      session = true;
      setCookie(CSRF, 'sess-2');
      return new Response(JSON.stringify(ME), { status: path === '/auth/signup' ? 201 : 200, headers: { 'content-type': 'application/json' } });
    }
    return problem('not_found', 404);
  });
  return {
    handler,
    calls,
    signIn() {
      session = true;
      setCookie(CSRF, 'sess-1');
    },
  };
}

describe('CSRF after sign-out (same tab, no reload)', () => {
  let api: ReturnType<typeof fakeApi>;

  beforeEach(() => {
    clearCookie(CSRF);
    api = fakeApi();
    vi.stubGlobal('fetch', api.handler);
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: { request: async (_name: string, fn: () => Promise<unknown>) => fn() },
    });
  });

  afterEach(() => {
    clearCookie(CSRF);
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('signs in again right after signing out', async () => {
    api.signIn();
    const { signOut } = await import('@/lib/api/auth-fetch');
    const { login } = await import('@/lib/api/auth');

    await signOut();
    expect(readCookie(CSRF)).toMatch(/^anon-/);

    await expect(login({ email: 'user@example.test', password: 'correcthorse' })).resolves.toMatchObject(ME);
    const loginCall = api.calls.find((c) => c.path === '/auth/login');
    expect(loginCall?.csrfHeader).toMatch(/^anon-/);
    expect(readCookie(CSRF)).toBe('sess-2');
  });

  it('re-issues the anonymous token before login when the cookie is gone', async () => {
    const { login } = await import('@/lib/api/auth');

    await expect(login({ email: 'user@example.test', password: 'correcthorse' })).resolves.toMatchObject(ME);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /auth/csrf', 'POST /auth/login']);
  });

  it('re-issues the anonymous token before signup when the cookie is gone', async () => {
    const { signup } = await import('@/lib/api/auth');

    await expect(
      signup({ email: 'new@example.test', password: 'correcthorse', locale: 'en' }),
    ).resolves.toMatchObject(ME);
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /auth/csrf', 'POST /auth/signup']);
  });

  it('does not add a bootstrap request when a CSRF cookie is present', async () => {
    setCookie(CSRF, 'anon-0');
    const { login } = await import('@/lib/api/auth');

    await login({ email: 'user@example.test', password: 'correcthorse' });
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /auth/login']);
  });
});
