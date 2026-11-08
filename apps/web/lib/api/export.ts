import { ProblemError, type ProblemDetails, type components } from '@engram/shared-types';
import {
  authFetch,
  authMutate,
  bumpSessionEpoch,
  getSessionEpoch,
  type AuthFetchOptions,
} from '@/lib/api/auth-fetch';
import { readCsrfToken } from '@/lib/api/csrf';
import { postSessionBroadcast } from '@/lib/auth/broadcast';
import {
  formatRetryClock as formatRetryDurationClock,
  normalizeRetryAfter,
  retryAfterFromHeader,
} from '@/lib/auth/retry-after';
import { hasWebLocks, withSessionLock } from '@/lib/auth/session-lock';
import { createIdempotencyKey } from '@/lib/api/vault';
import { purgeDeviceKeysOnRevoked } from '@/features/vault/device-store';

export type ExportKind = components['schemas']['ExportKind'];
export type ExportStatus = components['schemas']['ExportStatus'];
export type ExportCreateRequest = components['schemas']['ExportCreateRequest'];
export type ExportJob = components['schemas']['ExportJob'];
export type ExportLatestResponse = components['schemas']['ExportLatestResponse'];
export type DecryptedExportSection = components['schemas']['DecryptedExportSection'];
export type DecryptedExportItemRow = components['schemas']['DecryptedExportItemRow'];
export type DecryptedExportItemTagRow = components['schemas']['DecryptedExportItemTagRow'];
export type DecryptedExportPage = components['schemas']['DecryptedExportPage'];
export type Tag = components['schemas']['Tag'];
export type Entry = components['schemas']['Entry'];

export const EXPORT_STATUS = {
  queued: 'queued',
  running: 'running',
  ready: 'ready',
  failed: 'failed',
  cancelled: 'cancelled',
  expired: 'expired',
} as const satisfies Record<ExportStatus, ExportStatus>;

export const EXPORT_KIND_ENCRYPTED: ExportKind = 'encrypted';

export interface CreateExportOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface CancelExportOptions {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface DecryptedPageOptions {
  cursor?: string | null;
  reauthToken: string;
  signal?: AbortSignal;
  onReauthRequired?: () => Promise<string | null | undefined>;
}

export interface DecryptedAuditOptions {
  idempotencyKey?: string;
  reauthToken: string;
  signal?: AbortSignal;
  onReauthRequired?: () => Promise<string | null | undefined>;
}

/**
 * Formats a retry-after duration (in seconds) as a wall-clock `HH:mm` string (e.g. `14:12`)
 * relative to `now` (mockup `#dulieu` / `#plainDlg`: "Thử lại lúc 14:12").
 */
export function formatRetryWallClock(
  retryAfterSeconds: number | undefined,
  now: number | Date = Date.now(),
): string {
  const safeSeconds = normalizeRetryAfter(retryAfterSeconds, 60);
  const baseMs = typeof now === 'number' ? now : now.getTime();
  const target = new Date(baseMs + safeSeconds * 1000);
  const hours = target.getHours().toString().padStart(2, '0');
  const minutes = target.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

export { formatRetryDurationClock as formatRetryClock, normalizeRetryAfter };

export type ClassifiedExportApiErrorKind =
  | 'rate_limited'
  | 'paused'
  | 'reauth_expired'
  | 'export_expired'
  | 'export_not_ready'
  | 'not_found'
  | 'vault_absent'
  | 'offline'
  | 'generic';

export interface ClassifiedExportApiError {
  kind: ClassifiedExportApiErrorKind;
  retryAfterSeconds?: number;
  retryClock?: string;
  problemCode?: string;
  status?: number;
}

export function isReauthProblem(err: unknown): err is ProblemError {
  return (
    err instanceof ProblemError &&
    err.problem.status === 401 &&
    (err.problem.code === 'reauth_required' || err.problem.code === 'reauth_invalid')
  );
}

export function classifyExportError(
  err: unknown,
  now: number | Date = Date.now(),
): ClassifiedExportApiError {
  if (err instanceof ProblemError) {
    const code = err.problem.code;
    const status = err.problem.status;
    if (status === 429 || code === 'rate_limited') {
      const retryAfterSeconds = normalizeRetryAfter(err.problem.retry_after, 60);
      return {
        kind: 'rate_limited',
        retryAfterSeconds,
        retryClock: formatRetryWallClock(retryAfterSeconds, now),
        problemCode: code,
        status,
      };
    }
    if (status === 503 && code === 'dependency_unavailable') {
      const retryAfterSeconds = normalizeRetryAfter(err.problem.retry_after, 600);
      return {
        kind: 'paused',
        retryAfterSeconds,
        retryClock: formatRetryWallClock(retryAfterSeconds, now),
        problemCode: code,
        status,
      };
    }
    if (status === 401 && (code === 'reauth_required' || code === 'reauth_invalid')) {
      return {
        kind: 'reauth_expired',
        problemCode: code,
        status,
      };
    }
    if (status === 410 || code === 'export_expired') {
      return {
        kind: 'export_expired',
        problemCode: code,
        status,
      };
    }
    if (status === 409 && code === 'export_not_ready') {
      return {
        kind: 'export_not_ready',
        problemCode: code,
        status,
      };
    }
    if (status === 404 && code === 'vault_absent') {
      return {
        kind: 'vault_absent',
        problemCode: code,
        status,
      };
    }
    if (status === 404 || code === 'not_found') {
      return {
        kind: 'not_found',
        problemCode: code,
        status,
      };
    }
    return {
      kind: 'generic',
      problemCode: code,
      status,
    };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { kind: 'offline' };
  }
  if (err instanceof TypeError) {
    return { kind: 'offline' };
  }

  return { kind: 'generic' };
}

function isProblemBody(value: unknown): value is ProblemDetails {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    'title' in value &&
    typeof value.title === 'string'
  );
}

async function postCreateExportRaw(
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<ExportJob> {
  const csrf = readCsrfToken();
  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  });
  if (csrf) {
    headers.set('X-CSRF-Token', csrf);
  }
  const res = await fetch('/api/v1/exports', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: EXPORT_KIND_ENCRYPTED } satisfies ExportCreateRequest),
    credentials: 'same-origin',
    signal,
  });
  const contentType = (res.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (contentType === 'application/problem+json') {
    const body: unknown = await res.json();
    if (isProblemBody(body)) {
      const fromHeader = retryAfterFromHeader(res.headers.get('Retry-After'));
      const enriched =
        body.retry_after == null && fromHeader != null
          ? { ...body, retry_after: fromHeader }
          : body;
      throw new ProblemError(enriched);
    }
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (await res.json()) as ExportJob;
}

/** `POST /api/v1/exports` — operationId `exportCreate` (returns `202 Accepted` with `ExportJob` JSON body). */
export function createExport(opts: CreateExportOptions = {}): Promise<ExportJob> {
  const idempotencyKey = opts.idempotencyKey ?? createIdempotencyKey();
  const run = async (): Promise<ExportJob> => {
    const requestEpoch = getSessionEpoch();
    try {
      return await postCreateExportRaw(idempotencyKey, opts.signal);
    } catch (err) {
      if (!(err instanceof ProblemError)) throw err;
      if (requestEpoch === getSessionEpoch() && err.problem.code === 'session_invalid') {
        const reason = err.problem.reason ?? 'invalid';
        if (reason === 'revoked') {
          void purgeDeviceKeysOnRevoked();
        }
        postSessionBroadcast({ type: 'signed_out', reason });
      }
      if (err.problem.code !== 'access_expired') {
        throw err;
      }
      await authFetch<unknown>('/auth/me', { requireSession: true, signal: opts.signal });
      bumpSessionEpoch();
      return await postCreateExportRaw(idempotencyKey, opts.signal);
    }
  };
  if (!hasWebLocks()) return run();
  return withSessionLock(() => run());
}

/** `GET /api/v1/exports/latest` — operationId `exportGetLatest`. */
export function getLatestExport(
  opts?: Pick<AuthFetchOptions, 'signal'>,
): Promise<ExportLatestResponse> {
  return authFetch<ExportLatestResponse>('/exports/latest', {
    requireSession: true,
    signal: opts?.signal,
  });
}

/** `GET /api/v1/exports/{id}` — operationId `exportGet`. */
export function getExport(
  id: string,
  opts?: Pick<AuthFetchOptions, 'signal'>,
): Promise<ExportJob> {
  return authFetch<ExportJob>(`/exports/${encodeURIComponent(id)}`, {
    requireSession: true,
    signal: opts?.signal,
  });
}

/** `POST /api/v1/exports/{id}/cancel` — operationId `exportCancel`. */
export function cancelExport(id: string, opts: CancelExportOptions = {}): Promise<ExportJob> {
  const idempotencyKey = opts.idempotencyKey ?? createIdempotencyKey();
  return authMutate<ExportJob>(`/exports/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    json: {},
    headers: {
      'Idempotency-Key': idempotencyKey,
    },
    signal: opts.signal,
  });
}

/**
 * Returns the session-authenticated download path `/api/v1/exports/{id}/download`
 * (uses `sabk_session` cookie only; never embeds a query token).
 */
export function downloadUrl(id: string): string {
  return `/api/v1/exports/${encodeURIComponent(id)}/download`;
}

/** `GET /api/v1/exports/{id}/decrypted-pages` — operationId `exportDecryptedPages`. */
export async function getDecryptedPage(
  id: string,
  cursor?: string | null | DecryptedPageOptions,
  maybeOpts?: DecryptedPageOptions,
): Promise<DecryptedExportPage> {
  let cursorStr: string | null | undefined;
  let opts: DecryptedPageOptions;
  if (typeof cursor === 'object' && cursor !== null && 'reauthToken' in cursor) {
    cursorStr = cursor.cursor;
    opts = cursor;
  } else {
    cursorStr = cursor;
    opts = maybeOpts!;
  }

  const query = cursorStr ? `?cursor=${encodeURIComponent(cursorStr)}` : '';
  const path = `/exports/${encodeURIComponent(id)}/decrypted-pages${query}`;

  const runRequest = (token: string) =>
    authFetch<DecryptedExportPage>(path, {
      requireSession: true,
      reauthToken: token,
      signal: opts.signal,
    });

  try {
    return await runRequest(opts.reauthToken);
  } catch (err) {
    if (isReauthProblem(err) && opts.onReauthRequired) {
      const freshToken = await opts.onReauthRequired();
      if (freshToken) {
        return await runRequest(freshToken);
      }
    }
    throw err;
  }
}

/** `POST /api/v1/audit/export-decrypted` — operationId `exportDecryptedAudit`. */
export async function postDecryptedAudit(opts: DecryptedAuditOptions): Promise<void> {
  const idempotencyKey = opts.idempotencyKey ?? createIdempotencyKey();
  const runRequest = (token: string) =>
    authMutate<void>('/audit/export-decrypted', {
      method: 'POST',
      json: {},
      reauthToken: token,
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
      signal: opts.signal,
    });

  try {
    await runRequest(opts.reauthToken);
  } catch (err) {
    if (isReauthProblem(err) && opts.onReauthRequired) {
      const freshToken = await opts.onReauthRequired();
      if (freshToken) {
        await runRequest(freshToken);
        return;
      }
    }
    throw err;
  }
}
