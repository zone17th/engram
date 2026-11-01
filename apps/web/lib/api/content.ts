import { ProblemError, type components } from '@engram/shared-types';
import {
  useMutation,
  type UseMutationOptions,
  type UseMutationResult,
} from '@tanstack/react-query';
import { authFetch, authMutate, type AuthFetchOptions } from '@/lib/api/auth-fetch';
import { createIdempotencyKey } from '@/lib/api/vault';
import { normalizeRetryAfter } from '@/lib/auth/retry-after';

export { createIdempotencyKey };

export type ProblemCode = components['schemas']['ProblemCode'];
export type ContentSort = components['parameters']['ContentSort'];
export type ItemName = components['schemas']['ItemName'];
export type ItemHint = components['schemas']['ItemHint'];
export type TagDisplay = components['schemas']['TagDisplay'];
export type TagRef = components['schemas']['TagRef'];
export type ItemSummary = components['schemas']['ItemSummary'];
export type ItemList = components['schemas']['ItemList'];
export type ItemLookupResult = components['schemas']['ItemLookupResult'];
export type ItemCreateRequest = components['schemas']['ItemCreateRequest'];
export type ItemUpdateRequest = components['schemas']['ItemUpdateRequest'];
export type ItemTagsAddRequest = components['schemas']['ItemTagsAddRequest'];
export type ItemEntriesReorderRequest = components['schemas']['ItemEntriesReorderRequest'];
export type EntryPosition = components['schemas']['EntryPosition'];
export type ItemEntriesReorderResponse = components['schemas']['ItemEntriesReorderResponse'];
export type Tag = components['schemas']['Tag'];
export type TagList = components['schemas']['TagList'];
export type TagUpsertRequest = components['schemas']['TagUpsertRequest'];
export type TagRenameRequest = components['schemas']['TagRenameRequest'];
export type EntryType = components['schemas']['EntryType'];
export type EntryIdValue = components['schemas']['EntryIdValue'];
export type EntryEnvelopeV1 = components['schemas']['EntryEnvelopeV1'];
export type EntryCiphertext = components['schemas']['EntryCiphertext'];
export type PlaintextLenBucket = components['schemas']['PlaintextLenBucket'];
export type EntryMeta = components['schemas']['EntryMeta'];
export type Entry = components['schemas']['Entry'];
export type EntryMetaList = components['schemas']['EntryMetaList'];
export type EntryCreateRequest = components['schemas']['EntryCreateRequest'];
export type EntryImportJsonRequest = components['schemas']['EntryImportJsonRequest'];
export type EntryUpdateRequest = components['schemas']['EntryUpdateRequest'];
export type EntryChange = components['schemas']['EntryChange'];
export type EntryChangesPage = components['schemas']['EntryChangesPage'];
export type EmptyObject = components['schemas']['EmptyObject'];

const MAX_INT32_VERSION = 2_147_483_647;
const MAX_AUTO_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;
export const MAX_AUTO_RETRY_WAIT_SECONDS = 30;
const MAX_AUTO_RETRY_WAIT_MS = MAX_AUTO_RETRY_WAIT_SECONDS * 1_000;
/**
 * Formats the strong `If-Match: "<version>"` precondition header for content mutations
 * (`PATCH /items/{id}`, `PUT /entries/{id}` — plan §2.4, ADR 0005 §3).
 */
export function formatVersionIfMatch(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_INT32_VERSION) {
    throw new Error(`Invalid content version for If-Match: ${String(version)}`);
  }
  return `"${version}"`;
}

/**
 * Every problem code returned by content operations in plan §3 (16 P04 codes + 9 reused codes +
 * auth/session/internal codes that can surface on content routes).
 */
export const CONTENT_PROBLEM_CODES = [
  'name_invalid',
  'hint_invalid',
  'tag_display_invalid',
  'item_id_conflict',
  'item_deleted',
  'item_tag_limit',
  'item_entry_limit',
  'tag_conflict',
  'entry_invalid',
  'entry_too_large',
  'entry_id_conflict',
  'entry_key_mismatch',
  'entry_nonce_reused',
  'entry_restore_via_item',
  'reorder_mismatch',
  'changes_window_expired',
  'not_found',
  'invalid_request',
  'rate_limited',
  'precondition_required',
  'version_mismatch',
  'idempotency_conflict',
  'idempotency_in_progress',
  'vault_absent',
  'dependency_unavailable',
  'unauthenticated',
  'access_expired',
  'session_invalid',
  'csrf_invalid',
  'forbidden',
  'internal_error',
] as const satisfies readonly ProblemCode[];

export type ContentProblemCode = (typeof CONTENT_PROBLEM_CODES)[number];

export type ContentExtraErrorCode = 'network' | 'offline';
export type ContentErrorCode = ContentProblemCode | ContentExtraErrorCode;
export type ContentErrorI18nKey = `content.errors.${ContentErrorCode}`;

export const CONTENT_ERROR_I18N_KEYS: Record<ContentErrorCode, ContentErrorI18nKey> = {
  name_invalid: 'content.errors.name_invalid',
  hint_invalid: 'content.errors.hint_invalid',
  tag_display_invalid: 'content.errors.tag_display_invalid',
  item_id_conflict: 'content.errors.item_id_conflict',
  item_deleted: 'content.errors.item_deleted',
  item_tag_limit: 'content.errors.item_tag_limit',
  item_entry_limit: 'content.errors.item_entry_limit',
  tag_conflict: 'content.errors.tag_conflict',
  entry_invalid: 'content.errors.entry_invalid',
  entry_too_large: 'content.errors.entry_too_large',
  entry_id_conflict: 'content.errors.entry_id_conflict',
  entry_key_mismatch: 'content.errors.entry_key_mismatch',
  entry_nonce_reused: 'content.errors.entry_nonce_reused',
  entry_restore_via_item: 'content.errors.entry_restore_via_item',
  reorder_mismatch: 'content.errors.reorder_mismatch',
  changes_window_expired: 'content.errors.changes_window_expired',
  not_found: 'content.errors.not_found',
  invalid_request: 'content.errors.invalid_request',
  rate_limited: 'content.errors.rate_limited',
  precondition_required: 'content.errors.precondition_required',
  version_mismatch: 'content.errors.version_mismatch',
  idempotency_conflict: 'content.errors.idempotency_conflict',
  idempotency_in_progress: 'content.errors.idempotency_in_progress',
  vault_absent: 'content.errors.vault_absent',
  dependency_unavailable: 'content.errors.dependency_unavailable',
  unauthenticated: 'content.errors.unauthenticated',
  access_expired: 'content.errors.access_expired',
  session_invalid: 'content.errors.session_invalid',
  csrf_invalid: 'content.errors.csrf_invalid',
  forbidden: 'content.errors.forbidden',
  internal_error: 'content.errors.internal_error',
  network: 'content.errors.network',
  offline: 'content.errors.offline',
};

function isContentProblemCode(code: string): code is ContentProblemCode {
  return Object.prototype.hasOwnProperty.call(CONTENT_ERROR_I18N_KEYS, code) && code !== 'network' && code !== 'offline';
}

function isOfflineNavigator(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function isNetworkOrTimeoutError(error: unknown): boolean {
  if (error instanceof ProblemError) return false;
  if (error instanceof TypeError) return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'TimeoutError' || error.name === 'NetworkError';
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'NetworkError') return true;
    return /network|fetch|timeout|timed out|offline|failed to fetch|load failed/i.test(error.message);
  }
  return false;
}

/**
 * Extracts a 5xx HTTP status from a non-Problem `Error` thrown by `authFetch.parseResponse`
 * (e.g. `Error("Yêu cầu thất bại (HTTP 502).")` or `Error("Lỗi không rõ định dạng (HTTP 504).")`
 * when a reverse proxy or gateway returns an HTML/plain 5xx page — CCFE2, CBE4-1, SPEC §3.4).
 */
export function extractNonProblem5xxStatus(error: unknown): number | null {
  if (error instanceof ProblemError) return null;
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const rawStatus = error.status;
    if (typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 500 && rawStatus <= 599) {
      return rawStatus;
    }
  }
  if (error instanceof Error) {
    const match = /\bHTTP\s+(5\d{2})\b/i.exec(error.message);
    if (match?.[1]) {
      const parsed = Number.parseInt(match[1], 10);
      if (parsed >= 500 && parsed <= 599) {
        return parsed;
      }
    }
  }
  return null;
}

export function isNonProblem5xxError(error: unknown): boolean {
  return extractNonProblem5xxStatus(error) !== null;
}

/**
 * Maps a `ProblemCode`, `ProblemError`, or network/offline error to its `content.errors.*` i18n key.
 */
export function getContentErrorI18nKey(errorOrCode: unknown): ContentErrorI18nKey {
  if (typeof errorOrCode === 'string') {
    if (errorOrCode === 'offline' || errorOrCode === 'network') {
      return CONTENT_ERROR_I18N_KEYS[errorOrCode];
    }
    if (isContentProblemCode(errorOrCode)) {
      return CONTENT_ERROR_I18N_KEYS[errorOrCode];
    }
    return CONTENT_ERROR_I18N_KEYS.internal_error;
  }

  if (errorOrCode instanceof ProblemError) {
    const code = errorOrCode.problem.code;
    if (isContentProblemCode(code)) {
      return CONTENT_ERROR_I18N_KEYS[code];
    }
    if (errorOrCode.problem.status === 429) {
      return CONTENT_ERROR_I18N_KEYS.rate_limited;
    }
    return CONTENT_ERROR_I18N_KEYS.internal_error;
  }

  if (isOfflineNavigator()) {
    return CONTENT_ERROR_I18N_KEYS.offline;
  }

  if (isNetworkOrTimeoutError(errorOrCode)) {
    return CONTENT_ERROR_I18N_KEYS.network;
  }

  if (isNonProblem5xxError(errorOrCode)) {
    return CONTENT_ERROR_I18N_KEYS.dependency_unavailable;
  }

  return CONTENT_ERROR_I18N_KEYS.internal_error;
}

export type PreLookupRecoveryOutcome =
  /**
   * (a) In-session recoverable (`access_expired`, `csrf_invalid`, or `unauthenticated` whose
   * conditional refresh succeeded, or CBE4-1 transient network/5xx failure during refresh):
   * keep plan, draft, serialized body bytes, and Idempotency-Key; allow replay with the same key + bytes.
   */
  | 'replay_same_request'
  /**
   * (b) Terminal authentication/authorization boundary (`unauthenticated` without successful refresh,
   * `session_invalid`, `forbidden`): drop plan and draft, never replay across logout/re-login,
   * record the unconfirmed save notice for the current user.
   */
  | 'terminal_logout_boundary'
  /**
   * Business/handler response or other deterministic status that is not a pre-lookup 401/403.
   */
  | 'not_pre_lookup';

export type ContentMutationErrorKind =
  | 'network'
  | 'offline'
  | 'server_unavailable'
  | 'rate_limited'
  | 'idempotency_in_progress'
  | 'idempotency_conflict'
  | 'recoverable_auth'
  | 'terminal_auth'
  | 'version_mismatch'
  | 'precondition_required'
  | 'not_found'
  | 'vault_absent'
  | 'entry_key_mismatch'
  | 'entry_nonce_reused'
  | 'entry_too_large'
  | 'entry_invalid'
  | 'entry_id_conflict'
  | 'entry_restore_via_item'
  | 'item_id_conflict'
  | 'item_deleted'
  | 'item_tag_limit'
  | 'item_entry_limit'
  | 'tag_conflict'
  | 'reorder_mismatch'
  | 'changes_window_expired'
  | 'validation'
  | 'generic';

export interface ClassifiedContentMutationError {
  readonly kind: ContentMutationErrorKind;
  readonly i18nKey: ContentErrorI18nKey;
  readonly code?: ProblemCode | (string & {});
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly currentVersion?: number;
  /**
   * True when the caller (Tasks 15/16/18) should keep the draft, plan, serialized body bytes,
   * and Idempotency-Key and offer "Thử lại" (Retry) with the exact same request.
   */
  readonly canRetrySameBytes: boolean;
  /**
   * True ONLY when the error represents a terminal session/permission boundary (case b:
   * `session_invalid`, `forbidden`, or `unauthenticated` after conditional refresh was not
   * attempted or failed with 4xx). Never true on network/5xx (CBE4-1).
   */
  readonly isLogoutBoundary: boolean;
  /**
   * Outcome split for an error received after a prior send had an uncertain outcome
   * (SPEC §3.4 / §3.7, advisor-dec-098/119/121, CBE2-1, CFE4-1, CFE5-3, CBE4-1).
   */
  readonly preLookupRecovery: PreLookupRecoveryOutcome;
}

/**
 * Classifies a pre-lookup 401/403 or transient refresh failure after an uncertain mutation send
 * (SPEC §3.4, §3.7, §9.1, advisor-dec-098/119/121, CFE5-3, CBE4-1).
 *
 * Note: `authFetch`/`authMutate` already executes the conditional refresh for `access_expired`
 * and `unauthenticated` (when session CSRF evidence is present). If that refresh succeeds and
 * the automatic retry inside `authFetch` succeeds, no error is thrown. If a `ProblemError` with
 * `code === 'unauthenticated'` still reaches `contentMutate` / the caller, the refresh was either
 * not eligible or rejected by the server, making it case (b) (`terminal_logout_boundary`).
 * Conversely, if the refresh failed due to a network error or 5xx (`dependency_unavailable`, etc.),
 * `authFetch` throws that network/5xx error — which is NOT a logout (CBE4-1) and returns
 * `'replay_same_request'` so the caller keeps the plan, draft, bytes, and key.
 */
export function classifyPreLookupError(
  error: unknown,
  options: { readonly hadUncertainSend?: boolean } = {},
): PreLookupRecoveryOutcome {
  const hadUncertainSend = options.hadUncertainSend ?? true;

  if (error instanceof ProblemError) {
    const { code, status } = error.problem;
    if (code === 'session_invalid' || code === 'forbidden' || code === 'unauthenticated') {
      return 'terminal_logout_boundary';
    }
    if (code === 'access_expired' || code === 'csrf_invalid') {
      return 'replay_same_request';
    }
    if (hadUncertainSend && (status >= 500 || code === 'dependency_unavailable')) {
      // CBE4-1: a 5xx (including from a refresh attempt during recovery) is not a logout.
      return 'replay_same_request';
    }
    return 'not_pre_lookup';
  }

  if (hadUncertainSend && (isNetworkOrTimeoutError(error) || isNonProblem5xxError(error))) {
    // CBE4-1: a network/timeout failure or non-problem 5xx (including during refresh) is not a logout.
    return 'replay_same_request';
  }

  return 'not_pre_lookup';
}

/**
 * Classifies any error surfaced by `contentMutate` so Tasks 15/16/18 can decide whether to
 * keep the same bytes + Idempotency-Key and show "Thử lại" (`canRetrySameBytes: true`),
 * transition to conflict/validation UI, or treat as a terminal logout boundary (`isLogoutBoundary: true`).
 */
export function classifyContentMutationError(
  error: unknown,
  options: { readonly hadUncertainSend?: boolean } = {},
): ClassifiedContentMutationError {
  const i18nKey = getContentErrorI18nKey(error);
  const preLookupRecovery = classifyPreLookupError(error, options);

  if (error instanceof ProblemError) {
    const { code, status, retry_after, current_version } = error.problem;

    if (code === 'session_invalid' || code === 'forbidden' || code === 'unauthenticated') {
      return {
        kind: 'terminal_auth',
        i18nKey,
        code,
        status,
        canRetrySameBytes: false,
        isLogoutBoundary: true,
        preLookupRecovery: 'terminal_logout_boundary',
      };
    }

    if (code === 'access_expired' || code === 'csrf_invalid') {
      return {
        kind: 'recoverable_auth',
        i18nKey,
        code,
        status,
        canRetrySameBytes: true,
        isLogoutBoundary: false,
        preLookupRecovery: 'replay_same_request',
      };
    }

    if (code === 'idempotency_in_progress') {
      return {
        kind: 'idempotency_in_progress',
        i18nKey,
        code,
        status,
        retryAfterSeconds: normalizeRetryAfter(retry_after, 1),
        canRetrySameBytes: true,
        isLogoutBoundary: false,
        preLookupRecovery,
      };
    }

    if (status === 429 || code === 'rate_limited') {
      return {
        kind: 'rate_limited',
        i18nKey,
        code,
        status,
        retryAfterSeconds: normalizeRetryAfter(retry_after, 1),
        canRetrySameBytes: true,
        isLogoutBoundary: false,
        preLookupRecovery,
      };
    }

    if (status >= 500 || code === 'dependency_unavailable' || code === 'internal_error') {
      // CBE4-1: 5xx (direct or from conditional refresh) is never a logout; keep plan, draft, bytes, and key.
      return {
        kind: 'server_unavailable',
        i18nKey,
        code,
        status,
        retryAfterSeconds: retry_after !== undefined ? normalizeRetryAfter(retry_after, 1) : undefined,
        canRetrySameBytes: true,
        isLogoutBoundary: false,
        preLookupRecovery,
      };
    }

    if (status === 412 || code === 'version_mismatch') {
      return {
        kind: 'version_mismatch',
        i18nKey,
        code,
        status,
        currentVersion: current_version,
        canRetrySameBytes: false,
        isLogoutBoundary: false,
        preLookupRecovery: 'not_pre_lookup',
      };
    }

    if (status === 428 || code === 'precondition_required') {
      return {
        kind: 'precondition_required',
        i18nKey,
        code,
        status,
        canRetrySameBytes: false,
        isLogoutBoundary: false,
        preLookupRecovery: 'not_pre_lookup',
      };
    }

    if (code === 'idempotency_conflict') {
      return {
        kind: 'idempotency_conflict',
        i18nKey,
        code,
        status,
        canRetrySameBytes: false,
        isLogoutBoundary: false,
        preLookupRecovery: 'not_pre_lookup',
      };
    }

    if (code === 'vault_absent') {
      return {
        kind: 'vault_absent',
        i18nKey,
        code,
        status,
        canRetrySameBytes: false,
        isLogoutBoundary: false,
        preLookupRecovery: 'not_pre_lookup',
      };
    }

    if (status === 404 || code === 'not_found') {
      return {
        kind: 'not_found',
        i18nKey,
        code,
        status,
        canRetrySameBytes: false,
        isLogoutBoundary: false,
        preLookupRecovery: 'not_pre_lookup',
      };
    }

    switch (code) {
      case 'entry_key_mismatch':
      case 'entry_nonce_reused':
      case 'entry_too_large':
      case 'entry_invalid':
      case 'entry_id_conflict':
      case 'entry_restore_via_item':
      case 'item_id_conflict':
      case 'item_deleted':
      case 'item_tag_limit':
      case 'item_entry_limit':
      case 'tag_conflict':
      case 'reorder_mismatch':
      case 'changes_window_expired':
        return {
          kind: code,
          i18nKey,
          code,
          status,
          canRetrySameBytes: false,
          isLogoutBoundary: false,
          preLookupRecovery: 'not_pre_lookup',
        };
      case 'name_invalid':
      case 'hint_invalid':
      case 'tag_display_invalid':
      case 'invalid_request':
        return {
          kind: 'validation',
          i18nKey,
          code,
          status,
          canRetrySameBytes: false,
          isLogoutBoundary: false,
          preLookupRecovery: 'not_pre_lookup',
        };
      default:
        return {
          kind: 'generic',
          i18nKey,
          code,
          status,
          canRetrySameBytes: false,
          isLogoutBoundary: false,
          preLookupRecovery: 'not_pre_lookup',
        };
    }
  }

  if (isOfflineNavigator()) {
    return {
      kind: 'offline',
      i18nKey: CONTENT_ERROR_I18N_KEYS.offline,
      canRetrySameBytes: true,
      isLogoutBoundary: false,
      preLookupRecovery,
    };
  }

  if (isNetworkOrTimeoutError(error)) {
    return {
      kind: 'network',
      i18nKey: CONTENT_ERROR_I18N_KEYS.network,
      canRetrySameBytes: true,
      isLogoutBoundary: false,
      preLookupRecovery,
    };
  }

  const nonProblem5xxStatus = extractNonProblem5xxStatus(error);
  if (nonProblem5xxStatus !== null) {
    return {
      kind: 'server_unavailable',
      i18nKey: CONTENT_ERROR_I18N_KEYS.dependency_unavailable,
      status: nonProblem5xxStatus,
      canRetrySameBytes: true,
      isLogoutBoundary: false,
      preLookupRecovery: options.hadUncertainSend === false ? preLookupRecovery : 'replay_same_request',
    };
  }

  return {
    kind: 'generic',
    i18nKey,
    canRetrySameBytes: false,
    isLogoutBoundary: false,
    preLookupRecovery,
  };
}

/**
 * Union of all valid non-secret / already-sealed request payloads for content mutations.
 * Never includes a raw `string` or any object containing plaintext entry content.
 */
export type ContentMutationBody =
  | ItemCreateRequest
  | ItemUpdateRequest
  | ItemTagsAddRequest
  | ItemEntriesReorderRequest
  | TagUpsertRequest
  | TagRenameRequest
  | EntryCreateRequest
  | EntryImportJsonRequest
  | EntryUpdateRequest
  | EmptyObject;

export type ContentMutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ContentMutateOptions<TBody extends ContentMutationBody | undefined = ContentMutationBody | undefined> {
  readonly method: ContentMutationMethod;
  readonly path: string;
  /**
   * Structured request payload (metadata or already-sealed `{envelope, ciphertext, plaintext_len_bucket}`).
   * Plaintext strings are forbidden at both compile time and runtime.
   */
  readonly body?: TBody;
  readonly idempotencyKey: string;
  readonly ifMatch?: string;
  /**
   * AbortSignal to cancel in-flight requests and bounded `Retry-After` waits.
   * Callers (Tasks 15/16/18) MUST tie this signal to vault lock, logout, and reset so a sleeping
   * retry never fires stale ciphertext after the vault locks (plan §2.10, §2.11 step 5, CCFE6).
   */
  readonly signal?: AbortSignal;
  /**
   * When true, marks that this request was already sent at least once with an uncertain outcome
   * (e.g. caller is replaying after an earlier timeout/network drop).
   */
  readonly uncertainPriorSend?: boolean;
  /**
   * Optional per-attempt outcome observer invoked once per real send after the outcome is classified
   * (advisor-dec-203, HM18-R3-3). Never receives body, headers, URL, or entry data.
   */
  readonly onAttempt?: (outcome: { readonly attempt: number; readonly uncertainOutcome: boolean }) => void;
}

function isUncertainMutationOutcomeError(error: unknown): boolean {
  if (error instanceof ProblemError) {
    const { status, code } = error.problem;
    return status >= 500 || code === 'dependency_unavailable' || code === 'internal_error';
  }
  return isNetworkOrTimeoutError(error) || isNonProblem5xxError(error);
}

function assertNotPlaintextBody(body: unknown): void {
  if (typeof body === 'string') {
    throw new Error('contentMutate does not accept a string body; pass sealed payload or metadata object.');
  }
  if (typeof body === 'object' && body !== null) {
    if ('plaintext' in body || 'rawJson' in body) {
      throw new Error('contentMutate does not accept plaintext entry content.');
    }
  }
}

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortFromCaller(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  return error instanceof Error && error.name === 'AbortError';
}

function attachRetryAfterSeconds(error: unknown, retryAfterSeconds: number): void {
  if (typeof error === 'object' && error !== null) {
    try {
      Object.defineProperty(error, 'retryAfterSeconds', {
        value: retryAfterSeconds,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // Ignore frozen error objects; ProblemError still carries problem.retry_after.
    }
  }
}

function getAutoRetryDelayMs(error: unknown): number | null {
  if (error instanceof ProblemError) {
    const { code, status, retry_after } = error.problem;
    if (status === 409 && code === 'idempotency_in_progress') {
      const seconds = normalizeRetryAfter(retry_after, 1);
      const delayMs = seconds * 1_000;
      if (delayMs > MAX_AUTO_RETRY_WAIT_MS) {
        attachRetryAfterSeconds(error, seconds);
        return null;
      }
      return delayMs;
    }
    if (status === 429 || code === 'rate_limited') {
      const seconds = normalizeRetryAfter(retry_after, 1);
      const delayMs = seconds * 1_000;
      if (delayMs > MAX_AUTO_RETRY_WAIT_MS) {
        attachRetryAfterSeconds(error, seconds);
        return null;
      }
      return delayMs;
    }
    if (status === 503 && code === 'dependency_unavailable') {
      if (retry_after !== undefined) {
        const seconds = normalizeRetryAfter(retry_after, 1);
        const delayMs = seconds * 1_000;
        if (delayMs > MAX_AUTO_RETRY_WAIT_MS) {
          attachRetryAfterSeconds(error, seconds);
          return null;
        }
        return delayMs;
      }
      return DEFAULT_RETRY_DELAY_MS;
    }
    return null;
  }
  if (isNonProblem5xxError(error)) {
    return DEFAULT_RETRY_DELAY_MS;
  }
  if (isNetworkOrTimeoutError(error)) {
    return 0;
  }
  return null;
}

/**
 * Single mutation helper for all P04 content writes (plan §2.10, §3, SPEC §3.4, §3.7, §9.1).
 *
 * - Serializes `body` ONCE into a JSON string before the first send and reuses the exact same
 *   serialized bytes, `Idempotency-Key`, and `If-Match` across both `authMutate`'s internal
 *   refresh retry (CFE5-3) and up to 2 automatic retries.
 * - Auto-retries at most 2 times on:
 *   - network error or timeout
 *   - `409 idempotency_in_progress` (waits 1 s, capped at ≤ 30 s)
 *   - `429 rate_limited` (waits `Retry-After` seconds when ≤ 30 s; above 30 s throws immediately
 *     with `retryAfterSeconds` exposed so the UI can show "Thử lại")
 *   - `503 dependency_unavailable` and non-Problem 5xx (e.g. proxy 502/504 HTML)
 * - Callers MUST pass an `AbortSignal` tied to vault lock/logout so a sleeping retry never fires
 *   after lock.
 * - Pre-lookup recovery (SPEC §3.4, advisor-dec-098/119):
 *   - `access_expired` and `unauthenticated` with session CSRF evidence are refreshed inside
 *     `authMutate` once and replayed with the exact same bytes + key + If-Match (CFE5-3).
 *   - `403 csrf_invalid` (on the first send or after an uncertain send) bootstraps CSRF via
 *     `GET /auth/csrf` once within the 2-retry budget and replays the exact same bytes + key + If-Match.
 *   - `unauthenticated` reaching `contentMutate` (no refresh or refresh failed with 401),
 *     `session_invalid`, and `forbidden` are terminal (case b): never replayed.
 *   - CBE4-1: a refresh that fails on network error or 5xx (including non-Problem 5xx) surfaces as a
 *     retryable error, never as a terminal logout boundary.
 */
export async function contentMutate<
  TResponse,
  TBody extends ContentMutationBody | undefined = ContentMutationBody | undefined,
>(opts: ContentMutateOptions<TBody>): Promise<TResponse> {
  assertNotPlaintextBody(opts.body);

  if (!opts.idempotencyKey || opts.idempotencyKey.trim() === '') {
    throw new Error('contentMutate requires a non-empty idempotencyKey.');
  }

  const method = opts.method;
  const serializedBody: string | null =
    opts.body !== undefined
      ? JSON.stringify(opts.body)
      : method === 'DELETE'
        ? null
        : '{}';

  const headers: Record<string, string> = {
    'Idempotency-Key': opts.idempotencyKey,
  };
  if (opts.ifMatch !== undefined) {
    headers['If-Match'] = opts.ifMatch;
  }

  let csrfRecoveredOnce = false;

  for (let retryCount = 0; ; retryCount += 1) {
    const attempt = retryCount + 1;
    try {
      const response = await authMutate<TResponse>(opts.path, {
        method,
        body: serializedBody,
        headers,
        signal: opts.signal,
      });
      opts.onAttempt?.({ attempt, uncertainOutcome: false });
      return response;
    } catch (error) {
      if (isAbortFromCaller(error, opts.signal)) {
        throw error;
      }
      opts.onAttempt?.({
        attempt,
        uncertainOutcome: isUncertainMutationOutcomeError(error),
      });
      // Pre-lookup recovery: if the server rejected before idempotency lookup with `403 csrf_invalid`
      // (either on the first send or after an uncertain prior send — CCFE8), bootstrap the CSRF
      // cookie in-session once within the 2-retry budget and replay the exact same bytes + key.
      if (
        !csrfRecoveredOnce &&
        error instanceof ProblemError &&
        error.problem.code === 'csrf_invalid' &&
        retryCount < MAX_AUTO_RETRIES
      ) {
        csrfRecoveredOnce = true;
        try {
          await authFetch<void>('/auth/csrf', { signal: opts.signal });
        } catch {
          // Even if /auth/csrf fails, readCsrfToken() on the next attempt may already have an updated cookie from another tab.
        }
        continue;
      }

      const delayMs = getAutoRetryDelayMs(error);
      if (delayMs === null || retryCount >= MAX_AUTO_RETRIES) {
        throw error;
      }


      if (delayMs > 0) {
        await waitMs(delayMs, opts.signal);
      }
    }
  }
}

export interface ContentIdempotentOptions {
  readonly idempotencyKey: string;
  /**
   * AbortSignal tied to vault lock/logout so in-flight requests or Retry-After waits are cancelled immediately on lock.
   */
  readonly signal?: AbortSignal;
  readonly uncertainPriorSend?: boolean;
  readonly onAttempt?: (outcome: { readonly attempt: number; readonly uncertainOutcome: boolean }) => void;
}

export interface ContentConditionalOptions extends ContentIdempotentOptions {
  /** Version number or pre-formatted `"<version>"` strong ETag. */
  readonly ifMatch: number | string;
}

function resolveVersionIfMatch(ifMatch: number | string): string {
  return typeof ifMatch === 'number' ? formatVersionIfMatch(ifMatch) : ifMatch;
}

function buildQueryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export interface ItemsListParams {
  readonly tag_id?: string;
  readonly q?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: ContentSort;
  readonly signal?: AbortSignal;
}

/** `GET /items` — operationId `itemsList`. */
export function itemsList(params: ItemsListParams = {}): Promise<ItemList> {
  const qs = buildQueryString({
    tag_id: params.tag_id,
    q: params.q,
    cursor: params.cursor,
    limit: params.limit,
    sort: params.sort,
  });
  return authFetch<ItemList>(`/items${qs}`, {
    requireSession: true,
    signal: params.signal,
  });
}

export interface ItemsLookupExactParams {
  readonly name: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/** `GET /items/lookup` — operationId `itemsLookupExact`. */
export function itemsLookupExact(params: ItemsLookupExactParams): Promise<ItemLookupResult> {
  const qs = buildQueryString({
    name: params.name,
    cursor: params.cursor,
    limit: params.limit,
  });
  return authFetch<ItemLookupResult>(`/items/lookup${qs}`, {
    requireSession: true,
    signal: params.signal,
  });
}

/** `POST /items` — operationId `itemCreate`. */
export function itemCreate(
  body: ItemCreateRequest,
  opts: ContentIdempotentOptions,
): Promise<ItemSummary> {
  return contentMutate<ItemSummary, ItemCreateRequest>({
    method: 'POST',
    path: '/items',
    body,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `GET /items/{id}` — operationId `itemGet`. */
export function itemGet(
  id: string,
  opts?: Pick<AuthFetchOptions, 'signal'>,
): Promise<ItemSummary> {
  return authFetch<ItemSummary>(`/items/${encodeURIComponent(id)}`, {
    requireSession: true,
    signal: opts?.signal,
  });
}

/** `PATCH /items/{id}` — operationId `itemUpdate`. */
export function itemUpdate(
  id: string,
  body: ItemUpdateRequest,
  opts: ContentConditionalOptions,
): Promise<ItemSummary> {
  return contentMutate<ItemSummary, ItemUpdateRequest>({
    method: 'PATCH',
    path: `/items/${encodeURIComponent(id)}`,
    body,
    idempotencyKey: opts.idempotencyKey,
    ifMatch: resolveVersionIfMatch(opts.ifMatch),
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `DELETE /items/{id}` — operationId `itemDelete`. */
export function itemDelete(
  id: string,
  opts: ContentIdempotentOptions,
): Promise<void> {
  return contentMutate<void, undefined>({
    method: 'DELETE',
    path: `/items/${encodeURIComponent(id)}`,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `POST /items/{id}/restore` — operationId `itemRestore`. */
export function itemRestore(
  id: string,
  opts: ContentIdempotentOptions,
): Promise<ItemSummary> {
  const emptyBody: EmptyObject = {};
  return contentMutate<ItemSummary, EmptyObject>({
    method: 'POST',
    path: `/items/${encodeURIComponent(id)}/restore`,
    body: emptyBody,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `POST /items/{id}/tags` — operationId `itemTagsAdd`. */
export function itemTagsAdd(
  id: string,
  body: ItemTagsAddRequest,
  opts: ContentIdempotentOptions,
): Promise<ItemSummary> {
  return contentMutate<ItemSummary, ItemTagsAddRequest>({
    method: 'POST',
    path: `/items/${encodeURIComponent(id)}/tags`,
    body,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `DELETE /items/{id}/tags/{tag_id}` — operationId `itemTagRemove`. */
export function itemTagRemove(
  id: string,
  tagId: string,
  opts: ContentIdempotentOptions,
): Promise<ItemSummary> {
  return contentMutate<ItemSummary, undefined>({
    method: 'DELETE',
    path: `/items/${encodeURIComponent(id)}/tags/${encodeURIComponent(tagId)}`,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `PATCH /items/{id}/entries/reorder` — operationId `itemEntriesReorder`. */
export function itemEntriesReorder(
  id: string,
  body: ItemEntriesReorderRequest,
  opts: ContentIdempotentOptions,
): Promise<ItemEntriesReorderResponse> {
  return contentMutate<ItemEntriesReorderResponse, ItemEntriesReorderRequest>({
    method: 'PATCH',
    path: `/items/${encodeURIComponent(id)}/entries/reorder`,
    body,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

export interface TagsListParams {
  readonly q?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: ContentSort;
  readonly signal?: AbortSignal;
}

/** `GET /tags` — operationId `tagsList`. */
export function tagsList(params: TagsListParams = {}): Promise<TagList> {
  const qs = buildQueryString({
    q: params.q,
    cursor: params.cursor,
    limit: params.limit,
    sort: params.sort,
  });
  return authFetch<TagList>(`/tags${qs}`, {
    requireSession: true,
    signal: params.signal,
  });
}

/** `POST /tags` — operationId `tagUpsert`. */
export function tagUpsert(
  body: TagUpsertRequest,
  opts: ContentIdempotentOptions,
): Promise<Tag> {
  return contentMutate<Tag, TagUpsertRequest>({
    method: 'POST',
    path: '/tags',
    body,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `PATCH /tags/{id}` — operationId `tagRename`. */
export function tagRename(
  id: string,
  body: TagRenameRequest,
  opts: ContentIdempotentOptions,
): Promise<Tag> {
  return contentMutate<Tag, TagRenameRequest>({
    method: 'PATCH',
    path: `/tags/${encodeURIComponent(id)}`,
    body,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `DELETE /tags/{id}` — operationId `tagDelete`. */
export function tagDelete(
  id: string,
  opts: ContentIdempotentOptions,
): Promise<void> {
  return contentMutate<void, undefined>({
    method: 'DELETE',
    path: `/tags/${encodeURIComponent(id)}`,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `POST /tags/{id}/restore` — operationId `tagRestore`. */
export function tagRestore(
  id: string,
  opts: ContentIdempotentOptions,
): Promise<Tag> {
  const emptyBody: EmptyObject = {};
  return contentMutate<Tag, EmptyObject>({
    method: 'POST',
    path: `/tags/${encodeURIComponent(id)}/restore`,
    body: emptyBody,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

export interface ItemEntriesListParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/** `GET /items/{id}/entries` — operationId `itemEntriesList` (metadata only, no envelope/ciphertext). */
export function itemEntriesList(
  itemId: string,
  params: ItemEntriesListParams = {},
): Promise<EntryMetaList> {
  const qs = buildQueryString({
    cursor: params.cursor,
    limit: params.limit,
  });
  return authFetch<EntryMetaList>(`/items/${encodeURIComponent(itemId)}/entries${qs}`, {
    requireSession: true,
    signal: params.signal,
  });
}

/** `POST /items/{id}/entries` — operationId `entryCreate` (accepts sealed EntryCreateRequest only). */
export function entryCreate(
  itemId: string,
  body: EntryCreateRequest,
  opts: ContentIdempotentOptions,
): Promise<EntryMeta> {
  return contentMutate<EntryMeta, EntryCreateRequest>({
    method: 'POST',
    path: `/items/${encodeURIComponent(itemId)}/entries`,
    body,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `POST /items/{id}/entries/import-json` — operationId `entryImportJson` (accepts sealed EntryImportJsonRequest only). */
export function entryImportJson(
  itemId: string,
  body: EntryImportJsonRequest,
  opts: ContentIdempotentOptions,
): Promise<EntryMeta> {
  return contentMutate<EntryMeta, EntryImportJsonRequest>({
    method: 'POST',
    path: `/items/${encodeURIComponent(itemId)}/entries/import-json`,
    body,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `GET /entries/{id}` — operationId `entryGet` (single-card loader: EntryMeta + envelope + ciphertext). */
export function entryGet(
  id: string,
  opts?: Pick<AuthFetchOptions, 'signal'>,
): Promise<Entry> {
  return authFetch<Entry>(`/entries/${encodeURIComponent(id)}`, {
    requireSession: true,
    signal: opts?.signal,
  });
}

/** `PUT /entries/{id}` — operationId `entryUpdate` (accepts sealed EntryUpdateRequest only). */
export function entryUpdate(
  id: string,
  body: EntryUpdateRequest,
  opts: ContentConditionalOptions,
): Promise<EntryMeta> {
  return contentMutate<EntryMeta, EntryUpdateRequest>({
    method: 'PUT',
    path: `/entries/${encodeURIComponent(id)}`,
    body,
    idempotencyKey: opts.idempotencyKey,
    ifMatch: resolveVersionIfMatch(opts.ifMatch),
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `DELETE /entries/{id}` — operationId `entryDelete`. */
export function entryDelete(
  id: string,
  opts: ContentIdempotentOptions,
): Promise<void> {
  return contentMutate<void, undefined>({
    method: 'DELETE',
    path: `/entries/${encodeURIComponent(id)}`,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

/** `POST /entries/{id}/restore` — operationId `entryRestore`. */
export function entryRestore(
  id: string,
  opts: ContentIdempotentOptions,
): Promise<EntryMeta> {
  const emptyBody: EmptyObject = {};
  return contentMutate<EntryMeta, EmptyObject>({
    method: 'POST',
    path: `/entries/${encodeURIComponent(id)}/restore`,
    body: emptyBody,
    idempotencyKey: opts.idempotencyKey,
    signal: opts.signal,
    uncertainPriorSend: opts.uncertainPriorSend,
    onAttempt: opts.onAttempt,
  });
}

export interface EntriesChangesParams {
  readonly since?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/** `GET /entries/changes` — operationId `entriesChanges`. */
export function entriesChanges(params: EntriesChangesParams = {}): Promise<EntryChangesPage> {
  const qs = buildQueryString({
    since: params.since,
    cursor: params.cursor,
    limit: params.limit,
  });
  return authFetch<EntryChangesPage>(`/entries/changes${qs}`, {
    requireSession: true,
    signal: params.signal,
  });
}

/**
 * Allowed variable shapes for `useContentMutation`.
 * Rejects primitive strings and any object with `plaintext`, `rawJson`, or string `body`
 * so `MutationCache` never holds plaintext entry content (plan §2.10, P4FE1-2, user-dec-016).
 */
export type SafeContentMutationVariables<TVariables> = TVariables extends string
  ? never
  : TVariables extends { readonly plaintext?: unknown } | { readonly rawJson?: unknown } | { readonly text?: unknown } | { readonly body?: string }
    ? never
    : TVariables;

export type UseContentMutationOptions<
  TData = unknown,
  TError = unknown,
  TVariables extends object | void = void,
  TContext = unknown,
> = Omit<
  UseMutationOptions<TData, TError, SafeContentMutationVariables<TVariables>, TContext>,
  'gcTime' | 'retry' | 'networkMode'
>;

function assertSafeMutationVariables(variables: unknown): void {
  if (typeof variables === 'string') {
    throw new Error('useContentMutation forbids string variables; seal entry content before calling mutate.');
  }
  if (typeof variables === 'object' && variables !== null) {
    if ('plaintext' in variables || 'rawJson' in variables || 'text' in variables) {
      throw new Error('useContentMutation forbids plaintext fields in mutation variables.');
    }
    if ('body' in variables && typeof variables.body === 'string') {
      throw new Error('useContentMutation forbids string body in mutation variables.');
    }
  }
}

/**
 * The exact options `useContentMutation` hands to TanStack `useMutation`: `gcTime: 0`, `retry: false`
 * (retries are handled inside `contentMutate` with stable serialized bytes + `Idempotency-Key`),
 * `networkMode: 'always'` (never pauses/queues mutations offline across a vault lock — SPEC §7.7,
 * §3.4 step 6, CCFE3) and a `mutationFn` wrapper that rejects plaintext variables
 * (plan §2.10, P4FE1-2). Exported so tests can drive a `MutationObserver` without React.
 */
export function contentMutationOptions<
  TData = unknown,
  TError = unknown,
  TVariables extends object | void = void,
  TContext = unknown,
>(
  options: UseContentMutationOptions<TData, TError, TVariables, TContext>,
): UseMutationOptions<TData, TError, SafeContentMutationVariables<TVariables>, TContext> {
  const { mutationFn, ...rest } = options;
  return {
    ...rest,
    gcTime: 0,
    retry: false,
    networkMode: 'always',
    mutationFn: mutationFn
      ? async (variables, context) => {
          assertSafeMutationVariables(variables);
          return mutationFn(variables, context);
        }
      : undefined,
  };
}

/**
 * Wraps TanStack `useMutation` with `contentMutationOptions` (`gcTime: 0`, `retry: false`,
 * `networkMode: 'always'`) and enforces that variables contain only sealed payloads or metadata
 * (never plaintext body — plan §2.10, P4FE1-2).
 */
export function useContentMutation<
  TData = unknown,
  TError = unknown,
  TVariables extends object | void = void,
  TContext = unknown,
>(
  options: UseContentMutationOptions<TData, TError, TVariables, TContext>,
): UseMutationResult<TData, TError, SafeContentMutationVariables<TVariables>, TContext> {
  return useMutation<TData, TError, SafeContentMutationVariables<TVariables>, TContext>(
    contentMutationOptions(options),
  );
}
