import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// HOTFIX (advisor-dec-090): on production, signing out and then signing in again in the same tab
// failed with csrf_invalid until a reload. POST /auth/logout clears sabk_csrf and sabk_anon, and
// SessionProvider only bootstraps GET /auth/csrf once per page load. The fake API below mirrors the
// server's CSRF cookie rules (authhttp CSRF, Logout, applySession, CSRFAdapter), so these tests fail
// without the client re-issuing the anonymous pair.

const CSRF = 'sabk_csrf';

type Kind = 'anon' | 'sess';

/** Same shape as auth.CSRF tokens: base64url("v1|kind|subject|nonce|exp") + "." + signature. */
function token(kind: Kind, subject: string, nonce: number): string {
  const payload = btoa(`v1|${kind}|${subject}|n${nonce}|4102444800`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${payload}.sig`;
}

function kindOf(raw: string | null): Kind | null {
  if (!raw) return null;
  const encoded = (raw.split('.')[0] ?? '').replace(/-/g, '+').replace(/_/g, '/');
  try {
    const kind = atob(encoded + '='.repeat((4 - (encoded.length % 4)) % 4)).split('|')[1];
    return kind === 'anon' || kind === 'sess' ? kind : null;
  } catch {
    return null;
  }
}

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
  return new Response(
    JSON.stringify({ type: `https://engram.zone17.click/problems/${code}`, title: code, status, code }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

const ME = {
  user: { id: 'u1', email: 'user@example.test', email_verified: true, created_at: '2026-10-01T00:00:00Z' },
};

function fakeApi() {
  let session = false;
  let seq = 0;
  let csrfFails = false;
  const log: string[] = [];
  const csrfHeaders: Record<string, string | null> = {};

  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('/api/v1', '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const header = new Headers(init?.headers).get('X-CSRF-Token');
    log.push(`${method} ${path}`);
    csrfHeaders[`${method} ${path}`] = header;

    if (path === '/auth/csrf' && method === 'GET') {
      if (csrfFails) return problem('dependency_unavailable', 503);
      const cookie = readCookie(CSRF);
      const want: Kind = session ? 'sess' : 'anon';
      // ReuseIfValid: keep a cookie of the right kind, otherwise issue a new one.
      if (kindOf(cookie) !== want) {
        seq += 1;
        setCookie(CSRF, token(want, session ? 'session-1' : `anon-nonce-${seq}`, seq));
      }
      return new Response(null, { status: 204 });
    }
    if (method !== 'GET') {
      // Double submit: the header equals the cookie and the kind matches the caller.
      const cookie = readCookie(CSRF);
      const want: Kind = session ? 'sess' : 'anon';
      if (!cookie || cookie !== header || kindOf(cookie) !== want) return problem('csrf_invalid', 403);
    }
    if (path === '/auth/logout') {
      session = false;
      clearCookie(CSRF);
      return new Response(null, { status: 204 });
    }
    if (path === '/auth/login' || path === '/auth/signup' || path === '/auth/oauth/complete') {
      session = true;
      seq += 1;
      setCookie(CSRF, token('sess', 'session-2', seq));
      return new Response(JSON.stringify(ME), {
        status: path === '/auth/signup' ? 201 : 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return problem('not_found', 404);
  });

  return {
    handler,
    log,
    csrfHeaders,
    signedIn() {
      session = true;
      seq += 1;
      setCookie(CSRF, token('sess', 'session-1', seq));
    },
    /** session_invalid (revoked elsewhere, expired): the server ends the session but sets no cookie. */
    endSessionServerSide() {
      session = false;
    },
    failCsrf() {
      csrfFails = true;
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
    api.signedIn();
    const { signOut } = await import('@/lib/api/auth-fetch');
    const { login } = await import('@/lib/api/auth');

    await signOut();
    expect(kindOf(readCookie(CSRF))).toBe('anon');

    await expect(login({ email: 'user@example.test', password: 'correcthorse' })).resolves.toMatchObject(ME);
    expect(kindOf(api.csrfHeaders['POST /auth/login'] ?? null)).toBe('anon');
    expect(kindOf(readCookie(CSRF))).toBe('sess');
  });

  it('broadcasts signed_out before the CSRF bootstrap, and still finishes when the bootstrap fails', async () => {
    api.signedIn();
    api.failCsrf();
    const { subscribeSessionBroadcast } = await import('@/lib/auth/broadcast');
    const { signOut } = await import('@/lib/api/auth-fetch');
    const unsubscribe = subscribeSessionBroadcast((message, origin) => {
      if (origin === 'local') api.log.push(`broadcast ${message.type}`);
    });

    await expect(signOut()).resolves.toBeUndefined();
    unsubscribe();
    expect(api.log).toEqual(['POST /auth/logout', 'broadcast signed_out', 'GET /auth/csrf']);
  });

  it('re-issues the anonymous pair before login when the session ended server-side', async () => {
    api.signedIn();
    api.endSessionServerSide();
    const { login } = await import('@/lib/api/auth');

    await expect(login({ email: 'user@example.test', password: 'correcthorse' })).resolves.toMatchObject(ME);
    expect(api.log).toEqual(['GET /auth/csrf', 'POST /auth/login']);
  });

  it.each([
    ['login', 'POST /auth/login'],
    ['signup', 'POST /auth/signup'],
    ['oauthComplete', 'POST /auth/oauth/complete'],
  ] as const)('re-issues the anonymous pair before %s when the cookie is gone', async (fn, call) => {
    const auth = await import('@/lib/api/auth');
    const run = {
      login: () => auth.login({ email: 'user@example.test', password: 'correcthorse' }),
      signup: () => auth.signup({ email: 'new@example.test', password: 'correcthorse', locale: 'en' }),
      oauthComplete: () => auth.oauthComplete(),
    }[fn];

    await expect(run()).resolves.toMatchObject(ME);
    expect(api.log).toEqual(['GET /auth/csrf', call]);
  });

  it('adds no bootstrap request when an anonymous cookie is present', async () => {
    setCookie(CSRF, token('anon', 'anon-nonce-0', 0));
    const { login } = await import('@/lib/api/auth');

    await expect(login({ email: 'user@example.test', password: 'correcthorse' })).resolves.toMatchObject(ME);
    expect(api.log).toEqual(['POST /auth/login']);
  });
});
