import { ProblemError } from '@engram/shared-types';
import type { QueryClient } from '@tanstack/react-query';
import { entryGet, type Entry } from '@/lib/api/content';
import { contentQueryKeys } from '@/features/items/query-keys';
import type { EntryBodyLoadContext, EntryBodyLoader } from '@/features/items/entry-body';
import { ENTRY_KEY_ID_REGEX } from '@/features/entries/seal';
import { CryptoClientError, CryptoWorkerError } from '@/lib/crypto/client';
export type EntryOpenErrorKind =
  | 'old_key'
  | 'decrypt_failed'
  | 'stale_generation'
  | 'vault_locked'
  | 'not_found'
  | 'network'
  | 'other';

/**
 * Typed error raised by `realEntryBodyLoader` / `createRealEntryBodyLoader`
 * so `useEntryBody` and `EntryBody` can distinguish:
 * - `old_key`: `envelope.key_id !== vaultMeta.vault_key_id` (checked BEFORE calling Worker `openEntry`)
 * - `decrypt_failed`: AEAD verification or envelope validation failed (`AEAD_DECRYPT_FAILED`, `ENVELOPE_INVALID`)
 * - `stale_generation` / `vault_locked`: vault locked or generation changed during load
 */
export class EntryBodyOpenError extends Error {
  readonly kind: EntryOpenErrorKind;
  readonly envelopeKeyId?: string;
  readonly expectedKeyId?: string;

  constructor(
    kind: EntryOpenErrorKind,
    message: string,
    options?: ErrorOptions & {
      readonly envelopeKeyId?: string;
      readonly expectedKeyId?: string;
    },
  ) {
    super(message, options);
    this.name = 'EntryBodyOpenError';
    this.kind = kind;
    this.envelopeKeyId = options?.envelopeKeyId;
    this.expectedKeyId = options?.expectedKeyId;
  }
}

/**
 * Entry-specific error classifier (plan Task 14 item 3, §2.6).
 *
 * IMPORTANT: Never uses `classifyCryptoError` from `vault-provider.tsx`, which maps
 * `AEAD_DECRYPT_FAILED` to `wrong_passphrase` (appropriate only during vault unlock).
 * For an entry card, `AEAD_DECRYPT_FAILED` or `ENVELOPE_INVALID` maps to `decrypt_failed`
 * ("Không giải mã được" / "Could not decrypt this entry" with Retry), and a `key_id` mismatch
 * maps to `old_key` ("Entry này được mã hoá bằng khoá vault cũ").
 */
export function classifyEntryOpenError(error: unknown): {
  readonly kind: EntryOpenErrorKind;
  readonly canRetry: boolean;
} {
  if (error instanceof EntryBodyOpenError) {
    return {
      kind: error.kind,
      canRetry:
        error.kind === 'decrypt_failed' ||
        error.kind === 'network' ||
        error.kind === 'other',
    };
  }

  if (error instanceof CryptoClientError || error instanceof CryptoWorkerError) {
    switch (error.code) {
      case 'AEAD_DECRYPT_FAILED':
      case 'ENVELOPE_INVALID':
        return { kind: 'decrypt_failed', canRetry: true };
      case 'STALE_GENERATION':
        return { kind: 'stale_generation', canRetry: false };
      case 'VAULT_LOCKED':
      case 'VAULT_RECOVERING':
        return { kind: 'vault_locked', canRetry: false };
      default:
        return { kind: 'decrypt_failed', canRetry: true };
    }
  }

  if (error instanceof ProblemError) {
    if (error.problem.code === 'entry_key_mismatch') {
      return { kind: 'old_key', canRetry: false };
    }
    if (error.problem.status === 404 || error.problem.code === 'not_found') {
      return { kind: 'not_found', canRetry: false };
    }
    if (error.problem.code === 'entry_invalid') {
      return { kind: 'decrypt_failed', canRetry: true };
    }
    return { kind: 'other', canRetry: true };
  }

  if (error instanceof Error) {
    if (error.message === 'vault_locked_during_load') {
      return { kind: 'stale_generation', canRetry: false };
    }
    if (error.message === 'vault_unavailable') {
      return { kind: 'vault_locked', canRetry: false };
    }
    if (error instanceof TypeError) {
      return { kind: 'network', canRetry: true };
    }
  }

  return { kind: 'other', canRetry: true };
}

export interface CreateRealEntryBodyLoaderOptions {
  readonly fetchEntry?: (
    entryId: string,
    opts?: { readonly signal?: AbortSignal },
  ) => Promise<Entry>;
  readonly getExpectedKeyId?: () => string | null | undefined;
  readonly queryClient?: QueryClient;
}

/**
 * Creates a real `EntryBodyLoader` (plan Task 14 item 3, §2.6, §2.10):
 * 1. Fetches `GET /entries/{id}` via `entryGet` (Task 11 typed call). The returned `{ envelope, ciphertext }`
 *    is used once in memory to decrypt and is NEVER cached separately in QueryCache.
 * 2. Compares `entry.envelope.key_id` with `vaultMeta.vault_key_id` BEFORE calling `client.openEntry`.
 *    On mismatch: throws `EntryBodyOpenError('old_key')` and NEVER calls the Worker.
 * 3. Calls `client.openEntry({ entryId, envelope, ciphertext, opGeneration })`.
 * 4. Checks `isCurrent` / `client.getGeneration() === opGeneration` before returning or touching QueryCache.
 * 5. If the returned `entry.version` differs from the caller's list-metadata `version`:
 *    notifies `ctx.onResolvedVersion(entry.version)` so the body is stored under the new version's key
 *    and invalidates `['content', 'entries', itemId]`.
 */
export function createRealEntryBodyLoader(
  options: CreateRealEntryBodyLoaderOptions = {},
): EntryBodyLoader {
  const fetchEntry = options.fetchEntry ?? entryGet;

  return async (entryId: string, ctx: EntryBodyLoadContext): Promise<string> => {
    const checkCurrent = (): boolean => {
      if (typeof ctx.isCurrent === 'function' && !ctx.isCurrent()) {
        return false;
      }
      return ctx.client.getGeneration() === ctx.opGeneration;
    };

    if (!checkCurrent()) {
      throw new EntryBodyOpenError(
        'stale_generation',
        'Vault generation changed before fetching entry.',
      );
    }

    const entry = await fetchEntry(entryId, { signal: ctx.signal });

    if (!checkCurrent()) {
      throw new EntryBodyOpenError(
        'stale_generation',
        'Vault locked or generation changed while fetching entry.',
      );
    }
    // IP14-BE1-1 (HIGH): Authenticate the requested entry identity, never trust an ID supplied by the server response.
    if (typeof entry.id !== 'string' || entry.id !== entryId) {
      throw new EntryBodyOpenError(
        'decrypt_failed',
        'Returned entry identity does not match the requested entry ID.',
      );
    }

    const expectedKeyId = ctx.vaultKeyId ?? options.getExpectedKeyId?.() ?? null;
    if (typeof expectedKeyId !== 'string' || expectedKeyId.length === 0) {
      throw new EntryBodyOpenError(
        'vault_locked',
        'Current vault_key_id is unavailable while opening entry.',
      );
    }

    const envelopeKeyId =
      typeof entry.envelope === 'object' &&
      entry.envelope !== null &&
      typeof entry.envelope.key_id === 'string'
        ? entry.envelope.key_id
        : '';

    // IP14-FE1-10: A missing or malformed envelope key_id is a corrupt/invalid entry ('decrypt_failed'), not 'old_key'.
    if (!ENTRY_KEY_ID_REGEX.test(envelopeKeyId)) {
      throw new EntryBodyOpenError(
        'decrypt_failed',
        'Entry envelope key_id is missing or malformed.',
      );
    }

    // Compare envelope.key_id with vaultMeta.vault_key_id BEFORE calling Worker openEntry
    if (envelopeKeyId !== expectedKeyId) {
      throw new EntryBodyOpenError(
        'old_key',
        'Entry was encrypted with a different vault key.',
        {
          envelopeKeyId,
          expectedKeyId,
        },
      );
    }

    let opened: { plaintext: string };
    try {
      opened = await ctx.client.openEntry({
        entryId,
        envelope: entry.envelope,
        ciphertext: entry.ciphertext,
        opGeneration: ctx.opGeneration,
      });
    } catch (err) {
      const classified = classifyEntryOpenError(err);
      if (classified.kind === 'stale_generation' || classified.kind === 'vault_locked') {
        throw new EntryBodyOpenError(
          classified.kind,
          'Vault locked or generation changed during decryption.',
          { cause: err },
        );
      }
      throw new EntryBodyOpenError(
        'decrypt_failed',
        'Could not decrypt entry content.',
        { cause: err },
      );
    }

    if (!checkCurrent()) {
      throw new EntryBodyOpenError(
        'stale_generation',
        'Vault locked or generation changed after decryption.',
      );
    }

    // If the returned version differs from the list-metadata version:
    // use the new version and invalidate ['content', 'entries', itemId].
    if (
      ctx.version !== undefined &&
      typeof entry.version === 'number' &&
      entry.version !== ctx.version
    ) {
      ctx.onResolvedVersion?.(entry.version);
      const qc = ctx.queryClient ?? options.queryClient;
      const targetItemId = ctx.itemId ?? entry.item_id;
      if (qc && typeof targetItemId === 'string' && targetItemId.length > 0) {
        void qc.invalidateQueries({
          queryKey: contentQueryKeys.entries(targetItemId),
        });
      }
    }

    return opened.plaintext;
  };
}

/**
 * Default real `EntryBodyLoader` instance that fetches `GET /entries/{id}` and decrypts via `client.openEntry`.
 */
export const loadRealEntryBody: EntryBodyLoader = createRealEntryBodyLoader();
