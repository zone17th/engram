import { ProblemError, type components } from '@engram/shared-types';
import { authMutate, type AuthFetchOptions } from '@/lib/api/auth-fetch';
import { formatRetryWallClock } from '@/lib/api/export';
import { normalizeRetryAfter } from '@/lib/auth/retry-after';
import { createIdempotencyKey } from '@/lib/api/vault';

export type AccountDeleteRequest = components['schemas']['AccountDeleteRequest'];

export interface DeleteAccountOptions {
  confirmEmail: string;
  reauthToken: string;
  idempotencyKey?: string;
  signal?: AuthFetchOptions['signal'];
}

export type ClassifiedAccountDeleteErrorKind =
  | 'confirm_email_invalid'
  | 'reauth_expired'
  | 'rate_limited'
  | 'paused'
  | 'offline'
  | 'generic';

export interface ClassifiedAccountDeleteError {
  kind: ClassifiedAccountDeleteErrorKind;
  problemCode?: string;
  status?: number;
  retryAfterSeconds?: number;
  retryClock?: string;
  canRetrySameOperation: boolean;
}

export function isAccountDeleteReauthProblem(err: unknown): err is ProblemError {
  return (
    err instanceof ProblemError &&
    err.problem.status === 401 &&
    (err.problem.code === 'reauth_required' || err.problem.code === 'reauth_invalid')
  );
}

/**
 * Classifies errors from `DELETE /api/v1/me` (`accountDelete`) and re-authentication
 * into UI states for `delete-account-dialog.tsx` (`del-s2`, `del-reauth-expired`, `del-failed`).
 */
export function classifyAccountDeleteError(
  err: unknown,
  now: number | Date = Date.now(),
): ClassifiedAccountDeleteError {
  if (err instanceof ProblemError) {
    const problem = err.problem;
    const code = problem.code;
    const status = problem.status;

    if (status === 400 && code === 'account_delete_confirm_invalid') {
      return {
        kind: 'confirm_email_invalid',
        problemCode: code,
        status,
        canRetrySameOperation: false,
      };
    }

    if (isAccountDeleteReauthProblem(err)) {
      return {
        kind: 'reauth_expired',
        problemCode: code,
        status,
        canRetrySameOperation: true,
      };
    }

    if (status === 429 || code === 'rate_limited') {
      const retryAfterSeconds = normalizeRetryAfter(problem.retry_after);
      return {
        kind: 'rate_limited',
        problemCode: code,
        status,
        retryAfterSeconds,
        retryClock: formatRetryWallClock(retryAfterSeconds, now),
        canRetrySameOperation: true,
      };
    }

    if (status === 503 && code === 'dependency_unavailable') {
      const retryAfterSeconds =
        problem.retry_after !== undefined
          ? normalizeRetryAfter(problem.retry_after)
          : undefined;
      return {
        kind: 'paused',
        problemCode: code,
        status,
        retryAfterSeconds,
        retryClock:
          retryAfterSeconds !== undefined
            ? formatRetryWallClock(retryAfterSeconds, now)
            : undefined,
        canRetrySameOperation: true,
      };
    }

    if (status === 409 && code === 'idempotency_conflict') {
      return {
        kind: 'generic',
        problemCode: code,
        status,
        canRetrySameOperation: false,
      };
    }

    return {
      kind: 'generic',
      problemCode: code,
      status,
      canRetrySameOperation: status >= 500,
    };
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      kind: 'offline',
      canRetrySameOperation: true,
    };
  }

  if (err instanceof TypeError) {
    return {
      kind: 'offline',
      canRetrySameOperation: true,
    };
  }

  return {
    kind: 'generic',
    canRetrySameOperation: true,
  };
}

/**
 * `DELETE /api/v1/me` — operationId `accountDelete` (plan §2.9, §3).
 * Protected by `S + C + A("account.delete") + R("vault_sensitive") + I`.
 * Sends `{"confirm_email": "<email>"}` with `X-CSRF-Token`, `X-Reauth-Token`, and `Idempotency-Key`.
 * Returns `204 No Content` and clears auth cookies on the server.
 */
export function deleteAccount(opts: DeleteAccountOptions): Promise<void> {
  const idempotencyKey = opts.idempotencyKey ?? createIdempotencyKey();
  const body: AccountDeleteRequest = {
    confirm_email: opts.confirmEmail,
  };
  return authMutate<void>('/me', {
    method: 'DELETE',
    json: body,
    reauthToken: opts.reauthToken,
    headers: {
      'Idempotency-Key': idempotencyKey,
    },
    signal: opts.signal,
  });
}
