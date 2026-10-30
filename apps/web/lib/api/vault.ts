import type { components } from '@engram/shared-types';
import { authFetch, authMutate, type AuthFetchOptions } from '@/lib/api/auth-fetch';

export type VaultKeyId = components['schemas']['VaultKeyId'];
export type WrappedVaultKey = components['schemas']['WrappedVaultKey'];
export type WrappedPrivateKeys = components['schemas']['WrappedPrivateKeys'];
export type PublicKey32 = components['schemas']['PublicKey32'];
export type RecoveryKeyLookupHash = components['schemas']['RecoveryKeyLookupHash'];
export type PrfSalt = components['schemas']['PrfSalt'];
export type VaultKdf = components['schemas']['VaultKdf'];
export type VaultPasskeyItem = components['schemas']['VaultPasskeyItem'];
export type VaultPasskeyList = components['schemas']['VaultPasskeyList'];
export type VaultState = components['schemas']['VaultState'];
export type RecoveryKeyUploadItem = components['schemas']['RecoveryKeyUploadItem'];
export type VaultCreateRequest = components['schemas']['VaultCreateRequest'];
export type VaultCreatedResponse = components['schemas']['VaultCreatedResponse'];
export type VaultRewrapRequest = components['schemas']['VaultRewrapRequest'];
export type VaultVersionResponse = components['schemas']['VaultVersionResponse'];
export type VaultRecoveryKeysStatus = components['schemas']['VaultRecoveryKeysStatus'];
export type VaultRecoveryLookupRequest = components['schemas']['VaultRecoveryLookupRequest'];
export type VaultRecoveryLookupResponse = components['schemas']['VaultRecoveryLookupResponse'];
export type VaultRecoverCompleteRequest = components['schemas']['VaultRecoverCompleteRequest'];
export type VaultRecoveryKeysRegenerateRequest =
  components['schemas']['VaultRecoveryKeysRegenerateRequest'];
export type VaultRecoveryKeysRotateRequest = components['schemas']['VaultRecoveryKeysRotateRequest'];
export type VaultRecoveryKeysMutationResponse =
  components['schemas']['VaultRecoveryKeysMutationResponse'];
export type VaultRecoveryKeysRotateResponse =
  components['schemas']['VaultRecoveryKeysRotateResponse'];
export type VaultPasskeyRegisterOptionsResponse =
  components['schemas']['VaultPasskeyRegisterOptionsResponse'];
export type VaultPasskeyCreateRequest = components['schemas']['VaultPasskeyCreateRequest'];
export type VaultPasskeyRenameRequest = components['schemas']['VaultPasskeyRenameRequest'];
export type VaultPasskeyUnlockOptionsResponse =
  components['schemas']['VaultPasskeyUnlockOptionsResponse'];

const VAULT_KEY_ID_PATTERN = /^vk:[A-Za-z0-9_-]{22}$/;

/**
 * Formats the strong `If-Match: "<vault_key_id>:<version>"` precondition header per plan §2.3.
 */
export function formatVaultIfMatch(vaultKeyId: string, version: number): string {
  if (!VAULT_KEY_ID_PATTERN.test(vaultKeyId)) {
    throw new Error(`Invalid vault_key_id for If-Match: ${vaultKeyId}`);
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`Invalid vault version for If-Match: ${String(version)}`);
  }
  return `"${vaultKeyId}:${version}"`;
}

/**
 * Generates a fresh UUID v4 `Idempotency-Key` once per user intent (plan §2.3, ADR 0002 §8.4).
 */
export function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface VaultIdempotentOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface VaultConditionalMutateOptions extends VaultIdempotentOptions {
  ifMatch: string;
  reauthToken: string;
}

function buildVaultHeaders(opts: {
  idempotencyKey?: string;
  ifMatch?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey) {
    headers['Idempotency-Key'] = opts.idempotencyKey;
  }
  if (opts.ifMatch) {
    headers['If-Match'] = opts.ifMatch;
  }
  return headers;
}

/** `GET /vault` — operationId `vaultGet`. */
export function fetchVault(opts?: Pick<AuthFetchOptions, 'signal'>): Promise<VaultState> {
  return authFetch<VaultState>('/vault', {
    requireSession: true,
    signal: opts?.signal,
  });
}

/** `POST /vault` — operationId `vaultCreate`. */
export function createVault(
  body: VaultCreateRequest | string,
  opts: VaultIdempotentOptions,
): Promise<VaultCreatedResponse> {
  const isRaw = typeof body === 'string';
  return authMutate<VaultCreatedResponse>('/vault', {
    method: 'POST',
    ...(isRaw ? { body } : { json: body }),
    headers: buildVaultHeaders({ idempotencyKey: opts.idempotencyKey }),
    signal: opts.signal,
  });
}

/** `PUT /vault/kek` — operationId `vaultRewrap`. */
export function rewrapVault(
  body: VaultRewrapRequest | string,
  opts: VaultConditionalMutateOptions,
): Promise<VaultVersionResponse> {
  const isRaw = typeof body === 'string';
  return authMutate<VaultVersionResponse>('/vault/kek', {
    method: 'PUT',
    ...(isRaw ? { body } : { json: body }),
    reauthToken: opts.reauthToken,
    headers: buildVaultHeaders({
      idempotencyKey: opts.idempotencyKey,
      ifMatch: opts.ifMatch,
    }),
    signal: opts.signal,
  });
}

/** `DELETE /vault` — operationId `vaultReset` (no request body per plan Task 3). */
export function resetVault(opts: VaultConditionalMutateOptions): Promise<void> {
  return authMutate<void>('/vault', {
    method: 'DELETE',
    body: null,
    reauthToken: opts.reauthToken,
    headers: buildVaultHeaders({
      idempotencyKey: opts.idempotencyKey,
      ifMatch: opts.ifMatch,
    }),
    signal: opts.signal,
  });
}

/** `GET /vault/recovery-keys` — operationId `vaultRecoveryKeysGet`. */
export function fetchRecoveryKeysStatus(
  opts?: Pick<AuthFetchOptions, 'signal'>,
): Promise<VaultRecoveryKeysStatus> {
  return authFetch<VaultRecoveryKeysStatus>('/vault/recovery-keys', {
    requireSession: true,
    signal: opts?.signal,
  });
}

/** `POST /vault/unlock/recovery` — operationId `vaultRecoveryLookup`. */
export function lookupRecoveryKey(
  body: VaultRecoveryLookupRequest,
  opts?: Pick<AuthFetchOptions, 'signal'>,
): Promise<VaultRecoveryLookupResponse> {
  return authMutate<VaultRecoveryLookupResponse>('/vault/unlock/recovery', {
    method: 'POST',
    json: body,
    signal: opts?.signal,
  });
}

/** `POST /vault/recover/complete` — operationId `vaultRecoverComplete`. */
export function completeRecovery(
  body: VaultRecoverCompleteRequest | string,
  opts: VaultConditionalMutateOptions,
): Promise<VaultVersionResponse> {
  const isRaw = typeof body === 'string';
  return authMutate<VaultVersionResponse>('/vault/recover/complete', {
    method: 'POST',
    ...(isRaw ? { body } : { json: body }),
    reauthToken: opts.reauthToken,
    headers: buildVaultHeaders({
      idempotencyKey: opts.idempotencyKey,
      ifMatch: opts.ifMatch,
    }),
    signal: opts.signal,
  });
}

/** `POST /vault/recovery-keys/regenerate` — operationId `vaultRecoveryKeysRegenerate`. */
export function regenerateRecoveryKeys(
  body: VaultRecoveryKeysRegenerateRequest | string,
  opts: VaultConditionalMutateOptions,
): Promise<VaultRecoveryKeysMutationResponse> {
  const isRaw = typeof body === 'string';
  return authMutate<VaultRecoveryKeysMutationResponse>('/vault/recovery-keys/regenerate', {
    method: 'POST',
    ...(isRaw ? { body } : { json: body }),
    reauthToken: opts.reauthToken,
    headers: buildVaultHeaders({
      idempotencyKey: opts.idempotencyKey,
      ifMatch: opts.ifMatch,
    }),
    signal: opts.signal,
  });
}

/** `POST /vault/recovery-keys/rotate` — operationId `vaultRecoveryKeysRotate`. */
export function rotateRecoveryKeys(
  body: VaultRecoveryKeysRotateRequest | string,
  opts: VaultConditionalMutateOptions,
): Promise<VaultRecoveryKeysRotateResponse> {
  const isRaw = typeof body === 'string';
  return authMutate<VaultRecoveryKeysRotateResponse>('/vault/recovery-keys/rotate', {
    method: 'POST',
    ...(isRaw ? { body } : { json: body }),
    reauthToken: opts.reauthToken,
    headers: buildVaultHeaders({
      idempotencyKey: opts.idempotencyKey,
      ifMatch: opts.ifMatch,
    }),
    signal: opts.signal,
  });
}

/** `POST /vault/passkeys/register/options` — operationId `vaultPasskeyRegisterOptions`. */
export function fetchPasskeyRegisterOptions(
  opts?: Pick<AuthFetchOptions, 'signal'>,
): Promise<VaultPasskeyRegisterOptionsResponse> {
  return authMutate<VaultPasskeyRegisterOptionsResponse>('/vault/passkeys/register/options', {
    method: 'POST',
    json: {},
    signal: opts?.signal,
  });
}

/** `POST /vault/passkeys` — operationId `vaultPasskeyCreate`. */
export function registerPasskey(
  body: VaultPasskeyCreateRequest | string,
  opts: VaultIdempotentOptions & { reauthToken: string },
): Promise<VaultPasskeyItem> {
  const isRaw = typeof body === 'string';
  return authMutate<VaultPasskeyItem>('/vault/passkeys', {
    method: 'POST',
    ...(isRaw ? { body } : { json: body }),
    reauthToken: opts.reauthToken,
    headers: buildVaultHeaders({ idempotencyKey: opts.idempotencyKey }),
    signal: opts.signal,
  });
}

/** `GET /vault/passkeys` — operationId `vaultPasskeysList`. */
export function fetchPasskeysList(
  opts?: Pick<AuthFetchOptions, 'signal'>,
): Promise<VaultPasskeyList> {
  return authFetch<VaultPasskeyList>('/vault/passkeys', {
    requireSession: true,
    signal: opts?.signal,
  });
}

/** `PATCH /vault/passkeys/{id}` — operationId `vaultPasskeyRename`. */
export function renamePasskey(
  id: string,
  body: VaultPasskeyRenameRequest,
  opts?: Pick<AuthFetchOptions, 'signal'>,
): Promise<VaultPasskeyItem> {
  return authMutate<VaultPasskeyItem>(`/vault/passkeys/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: body,
    signal: opts?.signal,
  });
}

/** `DELETE /vault/passkeys/{id}` — operationId `vaultPasskeyRevoke`. */
export function revokePasskey(
  id: string,
  reauthToken: string,
  opts?: Pick<AuthFetchOptions, 'signal'>,
): Promise<void> {
  return authMutate<void>(`/vault/passkeys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: null,
    reauthToken,
    signal: opts?.signal,
  });
}

/** `POST /vault/unlock/passkey/options` — operationId `vaultPasskeyUnlockOptions`. */
export function fetchPasskeyUnlockOptions(
  opts?: Pick<AuthFetchOptions, 'signal'>,
): Promise<VaultPasskeyUnlockOptionsResponse> {
  return authMutate<VaultPasskeyUnlockOptionsResponse>('/vault/unlock/passkey/options', {
    method: 'POST',
    json: {},
    signal: opts?.signal,
  });
}
