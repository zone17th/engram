import { ProblemError } from '@engram/shared-types';
import { classifyCryptoError } from '@/features/vault/vault-provider';
import { normalizeRetryAfter } from '@/lib/auth/retry-after';

export const GRANT_MIN_REMAINING_MS = 60_000;

/**
 * Checks whether a re-authentication grant has at least 60 seconds left before its expiration
 * per plan §1 ("Re-auth trong flow giữ secret": client checks grant has at least 60 seconds left before POST).
 */
export function hasGrantMinRemainingTtl(
  expiresAt: string | undefined,
  minRemainingMs: number = GRANT_MIN_REMAINING_MS,
  now: number = Date.now(),
): boolean {
  if (!expiresAt) return false;
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return false;
  return exp - now >= minRemainingMs;
}

export type VaultSettingsErrorKind =
  | 'version_mismatch'
  | 'precondition_required'
  | 'idempotency_conflict'
  | 'idempotency_in_progress'
  | 'kill_switch_disabled'
  | 'rate_limited'
  | 'reauth_expired'
  | 'reauth_failed'
  | 'client_busy'
  | 'vault_recovering'
  | 'vault_locked'
  | 'stale_generation'
  | 'insufficient_memory'
  | 'passphrase_invalid'
  | 'recovery_key_slot_taken'
  | 'recovery_key_conflict'
  | 'network'
  | 'generic';

export interface ClassifiedVaultSettingsError {
  kind: VaultSettingsErrorKind;
  retryAfterSeconds?: number;
  currentVersion?: number;
  canRetrySameOperation: boolean;
}

/**
 * Maps HTTP ProblemError and CryptoClient/CryptoWorker errors into distinct, non-secret UI error states.
 * Never returns "wrong passphrase" for Settings rewrap/RK/reset flows, and never echoes secret inputs.
 */
export function classifyVaultSettingsError(err: unknown): ClassifiedVaultSettingsError {
  if (err instanceof ProblemError) {
    const { code, status, retry_after, current_version } = err.problem;
    if (status === 412 || code === 'version_mismatch') {
      return {
        kind: 'version_mismatch',
        currentVersion: current_version,
        canRetrySameOperation: false,
      };
    }
    if (status === 428 || code === 'precondition_required') {
      return { kind: 'precondition_required', canRetrySameOperation: false };
    }
    if (code === 'idempotency_conflict') {
      return { kind: 'idempotency_conflict', canRetrySameOperation: false };
    }
    if (code === 'idempotency_in_progress') {
      return {
        kind: 'idempotency_in_progress',
        retryAfterSeconds: normalizeRetryAfter(retry_after, 1),
        canRetrySameOperation: true,
      };
    }
    if (status === 503 && code === 'vault_mutations_disabled') {
      return { kind: 'kill_switch_disabled', canRetrySameOperation: false };
    }
    if (status === 429 || code === 'rate_limited') {
      return {
        kind: 'rate_limited',
        retryAfterSeconds: normalizeRetryAfter(retry_after, 45),
        canRetrySameOperation: true,
      };
    }
    if (code === 'reauth_required' || code === 'reauth_invalid') {
      return { kind: 'reauth_expired', canRetrySameOperation: true };
    }
    if (
      status === 401 ||
      status === 403 ||
      code === 'invalid_credentials' ||
      code === 'reauth_failed' ||
      code === 'account_locked'
    ) {
      return { kind: 'reauth_failed', canRetrySameOperation: true };
    }
    if (code === 'recovery_key_slot_taken') {
      return { kind: 'recovery_key_slot_taken', canRetrySameOperation: false };
    }
    if (code === 'recovery_key_conflict') {
      return { kind: 'recovery_key_conflict', canRetrySameOperation: false };
    }
    return { kind: 'generic', canRetrySameOperation: false };
  }

  const cryptoClass = classifyCryptoError(err);
  if (cryptoClass.code) {
    switch (cryptoClass.code) {
      case 'CLIENT_BUSY':
        return { kind: 'client_busy', canRetrySameOperation: false };
      case 'VAULT_RECOVERING':
        return { kind: 'vault_recovering', canRetrySameOperation: false };
      case 'VAULT_LOCKED':
        return { kind: 'vault_locked', canRetrySameOperation: false };
      case 'STALE_GENERATION':
        return { kind: 'stale_generation', canRetrySameOperation: false };
      case 'KDF_ALLOCATION_FAILED':
      case 'KDF_DERIVE_FAILED':
        return { kind: 'insufficient_memory', canRetrySameOperation: false };
      case 'PASSPHRASE_INVALID':
        return { kind: 'passphrase_invalid', canRetrySameOperation: false };
      default:
        return { kind: 'generic', canRetrySameOperation: false };
    }
  }

  if (err instanceof TypeError || (err instanceof Error && /network|fetch|offline/i.test(err.message))) {
    return { kind: 'network', canRetrySameOperation: true };
  }

  return { kind: 'generic', canRetrySameOperation: true };
}

/**
 * Formats a list of slot numbers (e.g. `[6, 7, 8, 9, 10]`) as `rk6…rk10` or `rk2, rk5`.
 */
export function formatSlotRange(slots: readonly number[]): string {
  const sorted = [...slots].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  if (sorted.length === 1) return `rk${sorted[0]}`;
  const isContiguous = sorted.every((s, idx) => idx === 0 || s === (sorted[idx - 1] ?? s) + 1);
  if (isContiguous && sorted.length >= 3) {
    return `rk${sorted[0]}…rk${sorted[sorted.length - 1]}`;
  }
  return sorted.map((s) => `rk${s}`).join(', ');
}
