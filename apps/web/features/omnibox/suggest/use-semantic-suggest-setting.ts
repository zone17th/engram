'use client';

/**
 * Shared hook for reading and updating `Me.settings.semantic_suggest` (`PATCH /me/settings`)
 * per P05 plan mục 2.11, mục 2.24 item 4, and SPEC §6.8, §6.10.
 *
 * Shared by:
 * - Omnibox `≈` toggle button (Task 17)
 * - Settings `#timkiem` "Tìm gần nghĩa" card (Task 18)
 *
 * Contract:
 * - Reads `Me` from the app's existing `['auth', 'me', ...]` TanStack Query cache
 *   (matches `SessionProvider` in `features/auth/session-provider.tsx` and `omnibox.tsx:308`).
 * - `semanticExternal` defaults to `true` when `features.semantic_external` is absent (`undefined`)
 *   (fail-safe external provider privacy copy, plan mục 2.24 item 4).
 * - NOT optimistic: `PATCH /me/settings` via `patchSettings` (`lib/api/auth.ts:92`) updates the `Me`
 *   query cache ONLY after HTTP 200 resolves.
 * - On `409 semantic_unavailable` (or any failure), the setting stays/reverts to `false` (or prior value)
 *   and exposes an error state (`errorCode: 'semantic_unavailable' | 'patch_failed'`) without throwing
 *   out of `setSemanticSuggest`/`toggleSemanticSuggest`.
 */

import { ProblemError } from '@engram/shared-types';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { patchSettings, type Me } from '@/lib/api/auth';
import { getSessionEpoch } from '@/lib/api/auth-fetch';

export const AUTH_ME_QUERY_KEY_PREFIX = ['auth', 'me'] as const;

export type SemanticSuggestErrorCode = 'semantic_unavailable' | 'patch_failed';

export type SemanticSuggestPatchOutcome = 'ok' | 'busy' | 'unavailable' | 'failed';

export interface UseSemanticSuggestSettingResult {
  readonly me: Me | null;
  readonly semanticSuggest: boolean;
  readonly semanticAvailable: boolean;
  /** True when `features.semantic_external` is `true` OR absent (`undefined`) per plan 2.24 item 4. */
  readonly semanticExternal: boolean;
  readonly isPending: boolean;
  readonly errorCode: SemanticSuggestErrorCode | null;
  readonly isSemanticUnavailableError: boolean;
  readonly lastOutcome: SemanticSuggestPatchOutcome | null;
  readonly setSemanticSuggest: (next: boolean) => Promise<boolean>;
  readonly toggleSemanticSuggest: () => Promise<boolean>;
  readonly clearError: () => void;
}

export function readMeFromQueryClient(
  queryClient: QueryClient | undefined,
  epoch: number = getSessionEpoch(),
): Me | null {
  if (!queryClient) return null;
  const epochKey = ['auth', 'me', epoch] as const;
  return queryClient.getQueryData<Me | null>(epochKey) ?? null;
}

export function writeMeToQueryClient(
  queryClient: QueryClient | undefined,
  updatedMe: Me,
  epoch: number = getSessionEpoch(),
): void {
  if (!queryClient) return;
  if (getSessionEpoch() !== epoch) return;
  const epochKey = ['auth', 'me', epoch] as const;
  const existing = queryClient.getQueryData<Me | null>(epochKey);
  // If the current epoch entry was explicitly cleared to `null` (signed_out) or belongs to another user,
  // never resurrect or cross-write `Me` (RV-T9-FE1-3).
  if (existing === null) return;
  if (existing !== undefined && existing.user.id !== updatedMe.user.id) return;
  queryClient.setQueryData<Me | null>(epochKey, updatedMe);
}

export function useSemanticSuggestSetting(opts?: {
  readonly fallbackMe?: Me | null;
  readonly onUpdated?: (updatedMe: Me, nextValue: boolean) => void;
}): UseSemanticSuggestSettingResult {
  const queryClient = useContext(QueryClientContext);
  const [isPending, setIsPending] = useState(false);
  const [errorCode, setErrorCode] = useState<SemanticSuggestErrorCode | null>(null);
  const [lastOutcome, setLastOutcome] = useState<SemanticSuggestPatchOutcome | null>(null);
  const inFlightRef = useRef(false);
  const fallbackMe = opts?.fallbackMe;
  const onUpdatedRef = useRef(opts?.onUpdated);
  onUpdatedRef.current = opts?.onUpdated;

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (!queryClient) return () => {};
      return queryClient.getQueryCache().subscribe((event) => {
        const key = event.query?.queryKey;
        if (Array.isArray(key) && key[0] === 'auth' && key[1] === 'me') {
          onStoreChange();
        }
      });
    },
    [queryClient],
  );

  const getSnapshot = useCallback((): Me | null => {
    return readMeFromQueryClient(queryClient) ?? fallbackMe ?? null;
  }, [queryClient, fallbackMe]);

  const me = useSyncExternalStore(subscribe, getSnapshot, () => fallbackMe ?? null);
  const semanticAvailable = Boolean(me?.features?.semantic_available);
  const semanticSuggest = Boolean(me?.settings?.semantic_suggest);
  // Plan 2.24 item 4: `Me.features.semantic_external` absent (`undefined`) -> treat as `true`.
  const semanticExternal = me?.features?.semantic_external ?? true;

  const clearError = useCallback(() => {
    setErrorCode(null);
  }, []);

  const setSemanticSuggest = useCallback(
    async (next: boolean): Promise<boolean> => {
      if (inFlightRef.current) {
        setLastOutcome('busy');
        return false;
      }
      const startEpoch = getSessionEpoch();
      const currentMe = readMeFromQueryClient(queryClient, startEpoch) ?? fallbackMe ?? null;
      const startUserId = currentMe?.user.id ?? null;
      if (next && currentMe && !currentMe.features.semantic_available) {
        setErrorCode('semantic_unavailable');
        setLastOutcome('unavailable');
        return false;
      }

      inFlightRef.current = true;
      setIsPending(true);
      setErrorCode(null);

      try {
        // Non-optimistic PATCH: wait for HTTP 200 before mutating the `Me` cache.
        const updatedMe = await patchSettings({ semantic_suggest: next });
        // Guard against session epoch change, logout (`null` cache), or user switch mid-PATCH (RV-T9-FE1-3).
        if (getSessionEpoch() !== startEpoch) {
          setLastOutcome('failed');
          return false;
        }
        if (startUserId !== null && updatedMe.user.id !== startUserId) {
          setLastOutcome('failed');
          return false;
        }
        const latestCachedMe = readMeFromQueryClient(queryClient, startEpoch);
        if (latestCachedMe !== null && latestCachedMe.user.id !== updatedMe.user.id) {
          setLastOutcome('failed');
          return false;
        }
        if (queryClient && queryClient.getQueryData<Me | null>(['auth', 'me', startEpoch]) === null) {
          setLastOutcome('failed');
          return false;
        }
        writeMeToQueryClient(queryClient, updatedMe, startEpoch);
        onUpdatedRef.current?.(updatedMe, Boolean(updatedMe.settings.semantic_suggest));
        setLastOutcome('ok');
        return true;
      } catch (err) {
        if (err instanceof ProblemError && err.problem.code === 'semantic_unavailable') {
          // Ensure cache stays/reverts to `semantic_suggest: false` on 409 semantic_unavailable
          // only if the session epoch and user are still the same.
          if (getSessionEpoch() === startEpoch) {
            const latestMe = readMeFromQueryClient(queryClient, startEpoch) ?? currentMe;
            if (
              latestMe &&
              (startUserId === null || latestMe.user.id === startUserId) &&
              latestMe.settings.semantic_suggest !== false
            ) {
              writeMeToQueryClient(
                queryClient,
                {
                  ...latestMe,
                  settings: {
                    ...latestMe.settings,
                    semantic_suggest: false,
                  },
                },
                startEpoch,
              );
            }
          }
          setErrorCode('semantic_unavailable');
          setLastOutcome('unavailable');
          return false;
        }
        setErrorCode('patch_failed');
        setLastOutcome('failed');
        return false;
      } finally {
        inFlightRef.current = false;
        setIsPending(false);
      }
    },
    [queryClient, fallbackMe],
  );

  const toggleSemanticSuggest = useCallback(async (): Promise<boolean> => {
    const currentMe = readMeFromQueryClient(queryClient) ?? fallbackMe ?? null;
    const currentVal = Boolean(currentMe?.settings?.semantic_suggest);
    return setSemanticSuggest(!currentVal);
  }, [queryClient, fallbackMe, setSemanticSuggest]);

  return {
    me,
    semanticSuggest,
    semanticAvailable,
    semanticExternal,
    isPending,
    errorCode,
    isSemanticUnavailableError: errorCode === 'semantic_unavailable',
    lastOutcome,
    setSemanticSuggest,
    toggleSemanticSuggest,
    clearError,
  };
}
