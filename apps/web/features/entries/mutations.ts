'use client';

import {
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import {
  entryCreate,
  entryImportJson,
  entryUpdate,
  useContentMutation,
  type EntryCreateRequest,
  type EntryImportJsonRequest,
  type EntryMeta,
  type EntryMetaList,
  type EntryUpdateRequest,
  type SafeContentMutationVariables,
} from '@/lib/api/content';
import { contentQueryKeys } from '@/features/items/query-keys';
import { useOptionalVault, vaultBodyQueryKey } from '@/features/vault/vault-provider';
import {
  EntrySealError,
  type EntryOpHandle,
  type SealedEntryUpdatePayload,
  type SealedImportJsonEntryPayload,
  type SealedNewEntryPayload,
} from '@/features/entries/seal';
/**
 * Variables accepted by `useCreateEntryMutation` / `mutateSealedEntryCreate`.
 * Only sealed payload + metadata + op handle — never plaintext (plan §2.10, P4FE1-2, P4BE2-1).
 */
export interface SealedEntryCreateVariables {
  readonly itemId: string;
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly requestBody: EntryCreateRequest;
  readonly serializedBody?: string;
  readonly op: EntryOpHandle;
  readonly signal?: AbortSignal;
  readonly uncertainPriorSend?: boolean;
  readonly onAttempt?: (outcome: { readonly attempt: number; readonly uncertainOutcome: boolean }) => void;
}

/**
 * Variables accepted by `useImportJsonEntryMutation` / `mutateSealedEntryImportJson`.
 */
export interface SealedEntryImportJsonVariables {
  readonly itemId: string;
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly requestBody: EntryImportJsonRequest;
  readonly serializedBody?: string;
  readonly op: EntryOpHandle;
  readonly signal?: AbortSignal;
  readonly uncertainPriorSend?: boolean;
}

/**
 * Variables accepted by `useUpdateEntryMutation` / `mutateSealedEntryUpdate`.
 * Only sealed payload + metadata + op handle — never plaintext (plan §2.10, P4FE1-2, P4BE2-1).
 */
export interface SealedEntryUpdateVariables {
  readonly entryId: string;
  readonly itemId?: string;
  readonly ifMatch: number | string;
  readonly idempotencyKey: string;
  readonly requestBody: EntryUpdateRequest;
  readonly serializedBody?: string;
  readonly op: EntryOpHandle;
  readonly signal?: AbortSignal;
  readonly uncertainPriorSend?: boolean;
}
function assertSealedMutationVariables(variables: unknown): void {
  if (typeof variables !== 'object' || variables === null) {
    throw new Error('Entry mutation variables must be an object.');
  }
  if ('plaintext' in variables || 'rawJson' in variables || 'text' in variables) {
    throw new Error('Entry mutation variables must not contain plaintext fields.');
  }
  if ('requestBody' in variables) {
    const rb = variables.requestBody;
    if (typeof rb === 'object' && rb !== null) {
      if ('plaintext' in rb || 'rawJson' in rb || 'text' in rb) {
        throw new Error('Entry mutation requestBody must not contain plaintext fields.');
      }
    }
  }
}

function createStaleOpError(): EntrySealError {
  return new EntrySealError(
    'STALE_GENERATION',
    'Vault locked or operation generation changed before entry mutation completed.',
  );
}

/**
 * Enforces that a sealed mutation is still current BEFORE the initial send and binds an
 * `AbortSignal` to the sealed operation's lifetime (aborting immediately on vault lock,
 * logout, user switch, or reset via `registerSecretFormReset` / `op.onReset` — IP14-BE1-3).
 * Also verifies that `serializedBody` (when carried from `seal*`) remains byte-identical to
 * `JSON.stringify(requestBody)` (IP14-FE1-13).
 */
async function executeWithOpLifetimeSignal<T>(params: {
  readonly op: EntryOpHandle;
  readonly requestBody: object;
  readonly serializedBody?: string;
  readonly callerSignal?: AbortSignal;
  readonly registerReset?: (resetFn: () => void) => () => void;
  readonly run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const { op, requestBody, serializedBody, callerSignal, registerReset, run } = params;

  if (serializedBody !== undefined && JSON.stringify(requestBody) !== serializedBody) {
    throw new Error('Sealed requestBody was mutated after initial serialization.');
  }

  if (!op.isCurrent()) {
    throw createStaleOpError();
  }

  const controller = new AbortController();
  const abortForLock = () => {
    if (!controller.signal.aborted) {
      controller.abort(createStaleOpError());
    }
  };
  const abortForCaller = () => {
    if (!controller.signal.aborted) {
      controller.abort(callerSignal?.reason);
    }
  };

  if (callerSignal?.aborted) {
    abortForCaller();
  } else if (callerSignal) {
    callerSignal.addEventListener('abort', abortForCaller, { once: true });
  }

  const unsubOpReset = typeof op.onReset === 'function' ? op.onReset(abortForLock) : undefined;
  const unsubProviderReset =
    typeof registerReset === 'function' ? registerReset(abortForLock) : undefined;

  if (!op.isCurrent()) {
    abortForLock();
  }

  try {
    if (!op.isCurrent()) {
      throw createStaleOpError();
    }
    return await run(controller.signal);
  } finally {
    unsubOpReset?.();
    unsubProviderReset?.();
    op.dispose?.();
    if (callerSignal) {
      callerSignal.removeEventListener('abort', abortForCaller);
    }
  }
}

function upsertEntryMetaInList(
  current: EntryMetaList | EntryMeta[] | undefined,
  nextMeta: EntryMeta,
): EntryMetaList | EntryMeta[] | undefined {
  if (!current) return current;
  if (Array.isArray(current)) {
    const idx = current.findIndex((entry) => entry.id === nextMeta.id);
    if (idx === -1) {
      return [...current, nextMeta].sort(
        (a, b) => a.position - b.position || a.id.localeCompare(b.id),
      );
    }
    const copy = current.slice();
    copy[idx] = nextMeta;
    return copy;
  }
  if (typeof current === 'object' && Array.isArray(current.items)) {
    const idx = current.items.findIndex((entry) => entry.id === nextMeta.id);
    if (idx === -1) {
      const nextItems = [...current.items, nextMeta].sort(
        (a, b) => a.position - b.position || a.id.localeCompare(b.id),
      );
      return {
        ...current,
        items: nextItems,
      };
    }
    const nextItems = current.items.slice();
    nextItems[idx] = nextMeta;
    return {
      ...current,
      items: nextItems,
    };
  }
  return current;
}

/**
 * Applies post-save cache updates for a committed entry create/update (plan Task 14 item 2, §2.10, P4FE1-2, P4BE2-1):
 * - Always removes every cached decrypted body under `vaultBodyQueryKey(entryId)` (all versions) so stale versions
 *   never remain in QueryCache.
 * - Updates `['content', 'entries', itemId]` metadata (new `EntryMeta` with updated `version`) ONLY while the op
 *   captured at seal time is still current (`op.isCurrent() === true`).
 * - NEVER writes plaintext into any cache (including `vaultBodyQueryKey`); the new body enters QueryCache ONLY
 *   via `EntryBodyLoader` while the vault is unlocked.
 */
export function applyCommittedEntryMetaToCache(params: {
  readonly queryClient: QueryClient;
  readonly entryId: string;
  readonly itemId?: string;
  readonly meta: EntryMeta;
  readonly op: EntryOpHandle;
}): boolean {
  const { queryClient, entryId, itemId, meta, op } = params;

  // Always drop any cached body versions for this entryId.
  queryClient.removeQueries({ queryKey: vaultBodyQueryKey(entryId) });

  // P4BE2-1: Before ANY cache or state write after an await, verify the op captured at seal time is still current.
  if (!op.isCurrent()) {
    return false;
  }

  const targetItemId = itemId ?? meta.item_id;
  if (typeof targetItemId === 'string' && targetItemId.length > 0) {
    queryClient.setQueryData<EntryMetaList | EntryMeta[] | undefined>(
      contentQueryKeys.entries(targetItemId),
      (prev) => upsertEntryMetaInList(prev, meta),
    );
  }
  return true;
}

/**
 * Converts a `SealedNewEntryPayload` from `sealNewEntry` into `SealedEntryCreateVariables`.
 */
export function toEntryCreateVariables(
  sealed: SealedNewEntryPayload,
  opts?: {
    readonly signal?: AbortSignal;
    readonly uncertainPriorSend?: boolean;
    readonly onAttempt?: (outcome: { readonly attempt: number; readonly uncertainOutcome: boolean }) => void;
  },
): SealedEntryCreateVariables {
  return {
    itemId: sealed.itemId,
    entryId: sealed.entryId,
    idempotencyKey: sealed.idempotencyKey,
    requestBody: sealed.requestBody,
    serializedBody: sealed.serializedBody,
    op: sealed.op,
    signal: opts?.signal,
    uncertainPriorSend: opts?.uncertainPriorSend,
    onAttempt: opts?.onAttempt,
  };
}

/**
 * Converts a `SealedImportJsonEntryPayload` from `sealEntryImportJson` into `SealedEntryImportJsonVariables`.
 */
export function toEntryImportJsonVariables(
  sealed: SealedImportJsonEntryPayload,
  opts?: { readonly signal?: AbortSignal; readonly uncertainPriorSend?: boolean },
): SealedEntryImportJsonVariables {
  return {
    itemId: sealed.itemId,
    entryId: sealed.entryId,
    idempotencyKey: sealed.idempotencyKey,
    requestBody: sealed.requestBody,
    serializedBody: sealed.serializedBody,
    op: sealed.op,
    signal: opts?.signal,
    uncertainPriorSend: opts?.uncertainPriorSend,
  };
}

/**
 * Converts a `SealedEntryUpdatePayload` from `sealEntryUpdate` into `SealedEntryUpdateVariables`.
 */
export function toEntryUpdateVariables(
  sealed: SealedEntryUpdatePayload,
  ifMatch: number | string,
  opts?: {
    readonly itemId?: string;
    readonly signal?: AbortSignal;
    readonly uncertainPriorSend?: boolean;
  },
): SealedEntryUpdateVariables {
  return {
    entryId: sealed.entryId,
    itemId: opts?.itemId ?? sealed.itemId,
    ifMatch,
    idempotencyKey: sealed.idempotencyKey,
    requestBody: sealed.requestBody,
    serializedBody: sealed.serializedBody,
    op: sealed.op,
    signal: opts?.signal,
    uncertainPriorSend: opts?.uncertainPriorSend,
  };
}

/**
 * Imperative helper around `entryCreate` (`contentMutate`) that accepts ONLY a sealed payload
 * and updates cache metadata only if `op.isCurrent()` still holds after the response settles.
 */
export async function mutateSealedEntryCreate(
  queryClient: QueryClient,
  variables: SealedEntryCreateVariables,
): Promise<{ readonly meta: EntryMeta; readonly applied: boolean }> {
  assertSealedMutationVariables(variables);
  const meta = await executeWithOpLifetimeSignal({
    op: variables.op,
    requestBody: variables.requestBody,
    serializedBody: variables.serializedBody,
    callerSignal: variables.signal,
    run: (signal) =>
      entryCreate(variables.itemId, variables.requestBody, {
        idempotencyKey: variables.idempotencyKey,
        serializedBody: variables.serializedBody,
        signal,
        uncertainPriorSend: variables.uncertainPriorSend,
        onAttempt: variables.onAttempt,
      }),
  });
  const applied = applyCommittedEntryMetaToCache({
    queryClient,
    entryId: variables.entryId,
    itemId: variables.itemId,
    meta,
    op: variables.op,
  });
  return { meta, applied };
}

/**
 * Imperative helper around `entryImportJson` (`contentMutate`) that accepts ONLY a sealed payload
 * and updates cache metadata only if `op.isCurrent()` still holds after the response settles.
 */
export async function mutateSealedEntryImportJson(
  queryClient: QueryClient,
  variables: SealedEntryImportJsonVariables,
): Promise<{ readonly meta: EntryMeta; readonly applied: boolean }> {
  assertSealedMutationVariables(variables);
  const meta = await executeWithOpLifetimeSignal({
    op: variables.op,
    requestBody: variables.requestBody,
    serializedBody: variables.serializedBody,
    callerSignal: variables.signal,
    run: (signal) =>
      entryImportJson(variables.itemId, variables.requestBody, {
        idempotencyKey: variables.idempotencyKey,
        serializedBody: variables.serializedBody,
        signal,
        uncertainPriorSend: variables.uncertainPriorSend,
      }),
  });
  const applied = applyCommittedEntryMetaToCache({
    queryClient,
    entryId: variables.entryId,
    itemId: variables.itemId,
    meta,
    op: variables.op,
  });
  return { meta, applied };
}

/**
 * Imperative helper around `entryUpdate` (`contentMutate`) that accepts ONLY a sealed payload
 * and updates cache metadata only if `op.isCurrent()` still holds after the response settles.
 */
export async function mutateSealedEntryUpdate(
  queryClient: QueryClient,
  variables: SealedEntryUpdateVariables,
): Promise<{ readonly meta: EntryMeta; readonly applied: boolean }> {
  assertSealedMutationVariables(variables);
  const meta = await executeWithOpLifetimeSignal({
    op: variables.op,
    requestBody: variables.requestBody,
    serializedBody: variables.serializedBody,
    callerSignal: variables.signal,
    run: (signal) =>
      entryUpdate(variables.entryId, variables.requestBody, {
        idempotencyKey: variables.idempotencyKey,
        ifMatch: variables.ifMatch,
        serializedBody: variables.serializedBody,
        signal,
        uncertainPriorSend: variables.uncertainPriorSend,
      }),
  });
  const applied = applyCommittedEntryMetaToCache({
    queryClient,
    entryId: variables.entryId,
    itemId: variables.itemId,
    meta,
    op: variables.op,
  });
  return { meta, applied };
}

export interface EntryMutationCallbacks {
  /**
   * Invoked after a commit ONLY while the op captured at seal time is still current (`op.isCurrent()`).
   * Receives `EntryMeta` only — never plaintext.
   */
  readonly onCurrentSuccess?: (
    meta: EntryMeta,
    info: { readonly entryId: string; readonly itemId: string },
  ) => void;
  /**
   * Invoked on error ONLY while the op captured at seal time is still current (`op.isCurrent()`).
   */
  readonly onCurrentError?: (
    error: unknown,
    info: { readonly entryId: string; readonly itemId?: string },
  ) => void;
  /**
   * Invoked when the mutation settles ONLY while the op captured at seal time is still current (`op.isCurrent()`).
   */
  readonly onCurrentSettled?: (
    meta: EntryMeta | undefined,
    error: unknown,
    info: { readonly entryId: string; readonly itemId?: string },
  ) => void;
}

/**
 * React hook built on `useContentMutation` (`gcTime: 0`, `retry: false`, `networkMode: 'always'`)
 * for `POST /items/{id}/entries` (plan Task 14 item 2, P4FE1-2, P4BE2-1, P4FE2-16).
 *
 * - Variables carry ONLY sealed ciphertext + metadata + op handle (never plaintext).
 * - On success: removes `vaultBodyQueryKey(entryId)` (all versions) and updates `['content','entries',itemId]`
 *   metadata ONLY while `variables.op.isCurrent()` is true.
 * - Never writes plaintext into any cache.
 */
export function useCreateEntryMutation(
  callbacks?: EntryMutationCallbacks,
): UseMutationResult<
  EntryMeta,
  unknown,
  SafeContentMutationVariables<SealedEntryCreateVariables>
> {
  const queryClient = useQueryClient();
  const vault = useOptionalVault();
  const registerReset = vault?.registerSecretFormReset;

  return useContentMutation<EntryMeta, unknown, SealedEntryCreateVariables>({
    mutationFn: async (variables) => {
      assertSealedMutationVariables(variables);
      return executeWithOpLifetimeSignal({
        op: variables.op,
        requestBody: variables.requestBody,
        serializedBody: variables.serializedBody,
        callerSignal: variables.signal,
        registerReset,
        run: (signal) =>
          entryCreate(variables.itemId, variables.requestBody, {
            idempotencyKey: variables.idempotencyKey,
            serializedBody: variables.serializedBody,
            signal,
            uncertainPriorSend: variables.uncertainPriorSend,
            onAttempt: variables.onAttempt,
          }),
      });
    },
    onSuccess: (meta, variables) => {
      const applied = applyCommittedEntryMetaToCache({
        queryClient,
        entryId: variables.entryId,
        itemId: variables.itemId,
        meta,
        op: variables.op,
      });
      if (applied) {
        callbacks?.onCurrentSuccess?.(meta, {
          entryId: variables.entryId,
          itemId: variables.itemId,
        });
      }
    },
    onError: (error, variables) => {
      if (variables.op.isCurrent()) {
        callbacks?.onCurrentError?.(error, {
          entryId: variables.entryId,
          itemId: variables.itemId,
        });
      }
    },
    onSettled: (meta, error, variables) => {
      if (variables.op.isCurrent()) {
        callbacks?.onCurrentSettled?.(meta, error, {
          entryId: variables.entryId,
          itemId: variables.itemId,
        });
      }
    },
  });
}

/**
 * React hook built on `useContentMutation` for `PUT /entries/{id}` (plan Task 14 item 2, P4FE1-2, P4BE2-1, P4FE2-16).
 *
 * - Variables carry ONLY sealed ciphertext + metadata + op handle (never plaintext).
 * - On success: removes `vaultBodyQueryKey(entryId)` (all versions) and updates `['content','entries',itemId]`
 *   metadata (`version` increment) ONLY while `variables.op.isCurrent()` is true.
 * - Never writes plaintext into any cache.
 */
export function useUpdateEntryMutation(
  callbacks?: EntryMutationCallbacks,
): UseMutationResult<
  EntryMeta,
  unknown,
  SafeContentMutationVariables<SealedEntryUpdateVariables>
> {
  const queryClient = useQueryClient();
  const vault = useOptionalVault();
  const registerReset = vault?.registerSecretFormReset;

  return useContentMutation<EntryMeta, unknown, SealedEntryUpdateVariables>({
    mutationFn: async (variables) => {
      assertSealedMutationVariables(variables);
      return executeWithOpLifetimeSignal({
        op: variables.op,
        requestBody: variables.requestBody,
        serializedBody: variables.serializedBody,
        callerSignal: variables.signal,
        registerReset,
        run: (signal) =>
          entryUpdate(variables.entryId, variables.requestBody, {
            idempotencyKey: variables.idempotencyKey,
            ifMatch: variables.ifMatch,
            serializedBody: variables.serializedBody,
            signal,
            uncertainPriorSend: variables.uncertainPriorSend,
          }),
      });
    },
    onSuccess: (meta, variables) => {
      const applied = applyCommittedEntryMetaToCache({
        queryClient,
        entryId: variables.entryId,
        itemId: variables.itemId,
        meta,
        op: variables.op,
      });
      if (applied) {
        callbacks?.onCurrentSuccess?.(meta, {
          entryId: variables.entryId,
          itemId: variables.itemId ?? meta.item_id,
        });
      }
    },
    onError: (error, variables) => {
      if (variables.op.isCurrent()) {
        callbacks?.onCurrentError?.(error, {
          entryId: variables.entryId,
          itemId: variables.itemId,
        });
      }
    },
    onSettled: (meta, error, variables) => {
      if (variables.op.isCurrent()) {
        callbacks?.onCurrentSettled?.(meta, error, {
          entryId: variables.entryId,
          itemId: variables.itemId ?? meta?.item_id,
        });
      }
    },
  });
}

/**
 * React hook built on `useContentMutation` for `POST /items/{id}/entries/import-json` (Task 17).
 */
export function useImportJsonEntryMutation(
  callbacks?: EntryMutationCallbacks,
): UseMutationResult<
  EntryMeta,
  unknown,
  SafeContentMutationVariables<SealedEntryImportJsonVariables>
> {
  const queryClient = useQueryClient();
  const vault = useOptionalVault();
  const registerReset = vault?.registerSecretFormReset;

  return useContentMutation<EntryMeta, unknown, SealedEntryImportJsonVariables>({
    mutationFn: async (variables) => {
      assertSealedMutationVariables(variables);
      return executeWithOpLifetimeSignal({
        op: variables.op,
        requestBody: variables.requestBody,
        serializedBody: variables.serializedBody,
        callerSignal: variables.signal,
        registerReset,
        run: (signal) =>
          entryImportJson(variables.itemId, variables.requestBody, {
            idempotencyKey: variables.idempotencyKey,
            serializedBody: variables.serializedBody,
            signal,
            uncertainPriorSend: variables.uncertainPriorSend,
          }),
      });
    },
    onSuccess: (meta, variables) => {
      const applied = applyCommittedEntryMetaToCache({
        queryClient,
        entryId: variables.entryId,
        itemId: variables.itemId,
        meta,
        op: variables.op,
      });
      if (applied) {
        callbacks?.onCurrentSuccess?.(meta, {
          entryId: variables.entryId,
          itemId: variables.itemId,
        });
      }
    },
    onError: (error, variables) => {
      if (variables.op.isCurrent()) {
        callbacks?.onCurrentError?.(error, {
          entryId: variables.entryId,
          itemId: variables.itemId,
        });
      }
    },
    onSettled: (meta, error, variables) => {
      if (variables.op.isCurrent()) {
        callbacks?.onCurrentSettled?.(meta, error, {
          entryId: variables.entryId,
          itemId: variables.itemId,
        });
      }
    },
  });
}
