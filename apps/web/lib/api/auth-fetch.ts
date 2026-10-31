import { ProblemError, type ProblemDetails } from '@engram/shared-types';
import { readCsrfToken } from '@/lib/api/csrf';
import { postSessionBroadcast } from '@/lib/auth/broadcast';
import { retryAfterFromHeader } from '@/lib/auth/retry-after';
import { hasWebLocks, type SessionLockToken, withSessionLock } from '@/lib/auth/session-lock';
import { purgeDeviceKeysOnRevoked } from '@/features/vault/device-store';

const API_PREFIX = '/api/v1';

export type SessionEndReason = 'revoked' | 'expired' | 'invalid' | 'logout';

export type AuthFetchOptions = RequestInit & {
  /** Route yêu cầu session — cho phép auto-refresh khi access hết. */
  requireSession?: boolean;
  /** Không retry sau refresh (dùng cho chính POST refresh / raw Me trong lock). */
  skipAutoRefresh?: boolean;
  reauthToken?: string;
  json?: unknown;
};

let inTabRefreshPromise: Promise<boolean> | null = null;
let sessionEpoch = 0;

export function getSessionEpoch(): number {
  return sessionEpoch;
}

export function bumpSessionEpoch(): number {
  sessionEpoch += 1;
  return sessionEpoch;
}

export function resetSessionEpoch(): void {
  // Keep generations monotonic so late requests cannot match a new login.
  sessionEpoch += 1;
}

function assertRelativePath(path: string): void {
  const escapes = path.startsWith('//') || path.startsWith('/\\');
  if (!path.startsWith('/') || escapes) {
    throw new Error(`authFetch chỉ nhận đường tương đối: ${path}`);
  }
}

function mergeHeaders(init: HeadersInit | undefined, csrf: string | null, reauth?: string): Headers {
  const headers = new Headers(init);
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  if (csrf) headers.set('X-CSRF-Token', csrf);
  if (reauth) headers.set('X-Reauth-Token', reauth);
  return headers;
}

function isJsonContentType(contentType: string): boolean {
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return type === 'application/json' || type.endsWith('+json');
}

function hasSessionCsrfEvidence(): boolean {
  let raw: string | null;
  try {
    raw = readCsrfToken();
  } catch {
    return false;
  }
  if (!raw) return false;

  const parts = raw.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  if (typeof atob !== 'function') return false;
  const encoded = parts[0].replace(/-/g, '+').replace(/_/g, '/');
  const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
  try {
    const payload = atob(padded).split('|');
    // GET /auth/csrf only emits this kind after it identifies a live session
    // through the HttpOnly refresh cookie, including when access is missing.
    return payload.length === 5 && payload[0] === 'v1' && payload[1] === 'sess' && payload[2] !== '';
  } catch {
    return false;
  }
}

function shouldAttemptRefresh(problem: ProblemDetails): boolean {
  // Missing JWT is normally unauthenticated. A session-bound CSRF cookie is
  // the explicit evidence that bootstrap recovered a session from refresh.
  return problem.code === 'access_expired' || (problem.code === 'unauthenticated' && hasSessionCsrfEvidence());
}

function broadcastTerminalSession(problem: ProblemDetails): void {
  if (problem.code !== 'session_invalid') return;
  const reason = problem.reason ?? 'invalid';
  if (reason === 'revoked') {
    void purgeDeviceKeysOnRevoked();
  }
  postSessionBroadcast({ type: 'signed_out', reason });
}

function withRetryAfter(problem: ProblemDetails, res: Response): ProblemDetails {
  if (problem.retry_after != null) return problem;
  const fromHeader = retryAfterFromHeader(res.headers.get('Retry-After'));
  if (fromHeader == null) return problem;
  return { ...problem, retry_after: fromHeader };
}

async function parseResponse<T>(res: Response, method?: string): Promise<T> {
  const contentType = res.headers.get('content-type') ?? '';
  // 202 Accepted (email change / verify send / enroll send) has no JSON body.
  const hasNoBody =
    res.body === null ||
    res.status === 202 ||
    res.status === 204 ||
    res.status === 205 ||
    method?.toUpperCase() === 'HEAD';

  if (mediaType(contentType) === 'application/problem+json' && !hasNoBody) {
    const body: unknown = await res.json();
    if (isProblem(body)) throw new ProblemError(withRetryAfter(body, res));
    throw new Error(`Lỗi không rõ định dạng (HTTP ${res.status}).`);
  }
  if (!res.ok) throw new Error(`Yêu cầu thất bại (HTTP ${res.status}).`);
  if (hasNoBody) return undefined as T;
  if (isJsonContentType(contentType) || contentType === '') {
    const text = await res.text();
    if (!text.trim()) return undefined as T;
    return JSON.parse(text) as T;
  }
  return (await res.text()) as T;
}

function mediaType(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isProblem(value: unknown): value is ProblemDetails {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ProblemDetails).code === 'string' &&
    typeof (value as ProblemDetails).title === 'string'
  );
}

function isUnsafeMethod(method: string | undefined): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

async function rawFetch<T>(path: string, opts: AuthFetchOptions = {}): Promise<T> {
  assertRelativePath(path);
  const method = opts.method?.toUpperCase();
  const csrf = readCsrfToken();
  const headers = mergeHeaders(opts.headers as HeadersInit | undefined, csrf, opts.reauthToken);
  // Contract: every unsafe request is JSON + Origin + CSRF. Refresh/logout/complete
  // have no body — still send application/json so RequireJSONContent does not 415.
  if (opts.json !== undefined || (isUnsafeMethod(method) && !headers.has('content-type'))) {
    headers.set('content-type', 'application/json');
  }
  const body =
    opts.json !== undefined
      ? JSON.stringify(opts.json)
      : opts.body !== undefined
        ? opts.body
        : isUnsafeMethod(method)
          ? '{}'
          : undefined;
  const res = await fetch(`${API_PREFIX}${path}`, {
    ...opts,
    headers,
    body,
    credentials: 'same-origin',
  });
  return parseResponse<T>(res, method);
}

function markSessionChanged(): void {
  bumpSessionEpoch();
  postSessionBroadcast({ type: 'session_changed' });
}

/** Trong lock: raw GET Me trước; chỉ POST refresh khi access vẫn hết. */
async function refreshInsideLock(): Promise<boolean> {
  try {
    await rawFetch<unknown>('/auth/me', { skipAutoRefresh: true });
    markSessionChanged();
    return true;
  } catch (error) {
    // Keep the latest server decision, especially session_invalid.reason.
    if (!(error instanceof ProblemError) || !shouldAttemptRefresh(error.problem)) {
      throw error;
    }
  }

  try {
    await rawFetch<void>('/auth/refresh', { method: 'POST', skipAutoRefresh: true });
    markSessionChanged();
    return true;
  } catch (refreshError) {
    // Authentication and rate-limit responses are final. A network/5xx
    // response may have arrived after the server committed rotation, so one
    // read-only Me probe can establish whether the new access cookie landed.
    if (refreshError instanceof ProblemError && refreshError.problem.status < 500) {
      throw refreshError;
    }
    try {
      await rawFetch<unknown>('/auth/me', { skipAutoRefresh: true });
      markSessionChanged();
      return true;
    } catch (probeError) {
      if (probeError instanceof ProblemError && probeError.problem.code === 'session_invalid') {
        throw probeError;
      }
      throw refreshError;
    }
  }
}

async function tryRefreshOnce(): Promise<boolean> {
  if (!hasWebLocks()) return false;
  return withSessionLock(() => refreshInsideLock());
}

function scheduleInTabRefresh(lock?: SessionLockToken): Promise<boolean> {
  if (lock && hasWebLocks()) return refreshInsideLock();
  if (!inTabRefreshPromise) {
    inTabRefreshPromise = tryRefreshOnce().finally(() => {
      inTabRefreshPromise = null;
    });
  }
  return inTabRefreshPromise;
}

async function authFetchWithLock<T>(path: string, opts: AuthFetchOptions, lock?: SessionLockToken): Promise<T> {
  const requestEpoch = getSessionEpoch();
  try {
    return await rawFetch<T>(path, opts);
  } catch (error) {
    if (!(error instanceof ProblemError)) throw error;
    if (requestEpoch === getSessionEpoch()) broadcastTerminalSession(error.problem);

    if (opts.skipAutoRefresh || !opts.requireSession || !shouldAttemptRefresh(error.problem)) {
      throw error;
    }

    let retryEpoch = requestEpoch;
    try {
      const refreshed = await scheduleInTabRefresh(lock);
      if (!refreshed) throw error;
      retryEpoch = getSessionEpoch();
      return await rawFetch<T>(path, opts);
    } catch (refreshError) {
      if (refreshError instanceof ProblemError && retryEpoch === getSessionEpoch()) {
        broadcastTerminalSession(refreshError.problem);
      }
      throw refreshError;
    }
  }
}

/** Fetch API có CSRF, optional reauth, refresh tối đa một lần cho session-required routes. */
export async function authFetch<T>(path: string, opts: AuthFetchOptions = {}): Promise<T> {
  return authFetchWithLock(path, opts);
}

/** Mutation thay cookie session — luôn dưới Web Lock khi có. */
export async function authMutate<T>(path: string, opts: AuthFetchOptions = {}): Promise<T> {
  const requestOpts = { ...opts, requireSession: opts.requireSession ?? true };
  const run = async (lock?: SessionLockToken): Promise<T> => {
    const result = await authFetchWithLock<T>(path, requestOpts, lock);
    // Password rotation revokes the old session and installs a replacement.
    if (path === '/me/password') markSessionChanged();
    return result;
  };
  if (!hasWebLocks()) return run();
  return withSessionLock((lock) => run(lock));
}

export async function bootstrapCsrf(): Promise<void> {
  await rawFetch<void>('/auth/csrf');
}

/**
 * Anonymous credential POSTs (login, signup) need the anonymous CSRF pair. POST /auth/logout
 * clears it and the anonymous cookie also expires on its own, while SessionProvider bootstraps
 * only once per page load. Re-issue it when the cookie is gone instead of failing csrf_invalid.
 */
export async function ensureCsrf(): Promise<void> {
  if (readCsrfToken()) return;
  await bootstrapCsrf();
}

export async function signOut(reason: SessionEndReason = 'logout'): Promise<void> {
  await withSessionLock(async () => {
    try {
      await rawFetch<void>('/auth/logout', { method: 'POST' });
    } catch {
      // Clear client state even if server unreachable.
    }
    try {
      // Logout clears sabk_csrf and sabk_anon. Issue a fresh anonymous pair now so a sign-in
      // in this tab without a reload carries a valid token.
      await bootstrapCsrf();
    } catch {
      // ensureCsrf() before login/signup retries the bootstrap.
    }
    resetSessionEpoch();
    postSessionBroadcast({ type: 'signed_out', reason });
  });
}
