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

export interface UseSemanticSuggestSettingResult {
  readonly me: Me | null;
  readonly semanticSuggest: boolean;
  readonly semanticAvailable: boolean;
  /** True when `features.semantic_external` is `true` OR absent (`undefined`) per plan 2.24 item 4. */
  readonly semanticExternal: boolean;
  readonly isPending: boolean;
  readonly errorCode: SemanticSuggestErrorCode | null;
  readonly isSemanticUnavailableError: boolean;
  readonly setSemanticSuggest: (next: boolean) => Promise<boolean>;
  readonly toggleSemanticSuggest: () => Promise<boolean>;
  readonly clearError: () => void;
}

export function readMeFromQueryClient(queryClient: QueryClient | undefined): Me | null {
  if (!queryClient) return null;
  const epochKey = ['auth', 'me', getSessionEpoch()] as const;
  const exact = queryClient.getQueryData<Me | null>(epochKey);
  if (exact) return exact;

  const queries = queryClient.getQueriesData<Me | null>({
    queryKey: AUTH_ME_QUERY_KEY_PREFIX,
  });
  for (let i = queries.length - 1; i >= 0; i -= 1) {
    const data = queries[i]?.[1];
    if (data) return data;
  }
  return null;
}

export function writeMeToQueryClient(
  queryClient: QueryClient | undefined,
  updatedMe: Me,
): void {
  if (!queryClient) return;
  const existing = queryClient.getQueriesData<Me | null>({
    queryKey: AUTH_ME_QUERY_KEY_PREFIX,
  });
  let updatedAny = false;
  for (const [key, data] of existing) {
    if (data !== undefined) {
      queryClient.setQueryData<Me | null>(key, updatedMe);
      updatedAny = true;
    }
  }
  if (!updatedAny) {
    queryClient.setQueryData<Me | null>(['auth', 'me', getSessionEpoch()], updatedMe);
  }
}

export function useSemanticSuggestSetting(opts?: {
  readonly fallbackMe?: Me | null;
  readonly onUpdated?: (updatedMe: Me, nextValue: boolean) => void;
}): UseSemanticSuggestSettingResult {
  const queryClient = useContext(QueryClientContext);
  const [isPending, setIsPending] = useState(false);
  const [errorCode, setErrorCode] = useState<SemanticSuggestErrorCode | null>(null);
  const inFlightRef = useRef(false);

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
    return readMeFromQueryClient(queryClient) ?? opts?.fallbackMe ?? null;
  }, [queryClient, opts?.fallbackMe]);

  const me = useSyncExternalStore(subscribe, getSnapshot, () => opts?.fallbackMe ?? null);

  const semanticAvailable = Boolean(me?.features?.semantic_available);
  const semanticSuggest = Boolean(me?.settings?.semantic_suggest);
  // Plan 2.24 item 4: `Me.features.semantic_external` absent (`undefined`) -> treat as `true`.
  const semanticExternal = me?.features?.semantic_external ?? true;

  const clearError = useCallback(() => {
    setErrorCode(null);
  }, []);

  const setSemanticSuggest = useCallback(
    async (next: boolean): Promise<boolean> => {
      if (inFlightRef.current) return false;
      const currentMe = readMeFromQueryClient(queryClient) ?? opts?.fallbackMe ?? null;
      if (next && currentMe && !currentMe.features.semantic_available) {
        setErrorCode('semantic_unavailable');
        return false;
      }

      inFlightRef.current = true;
      setIsPending(true);
      setErrorCode(null);

      try {
        // Non-optimistic PATCH: wait for HTTP 200 before mutating the `Me` cache.
        const updatedMe = await patchSettings({ semantic_suggest: next });
        writeMeToQueryClient(queryClient, updatedMe);
        opts?.onUpdated?.(updatedMe, Boolean(updatedMe.settings.semantic_suggest));
        return true;
      } catch (err) {
        if (err instanceof ProblemError && err.problem.code === 'semantic_unavailable') {
          // Ensure cache stays/reverts to `semantic_suggest: false` on 409 semantic_unavailable.
          const latestMe = readMeFromQueryClient(queryClient) ?? currentMe;
          if (latestMe && latestMe.settings.semantic_suggest !== false) {
            writeMeToQueryClient(queryClient, {
              ...latestMe,
              settings: {
                ...latestMe.settings,
                semantic_suggest: false,
              },
            });
          }
          setErrorCode('semantic_unavailable');
          return false;
        }
        setErrorCode('patch_failed');
        return false;
      } finally {
        inFlightRef.current = false;
        setIsPending(false);
      }
    },
    [queryClient, opts],
  );

  const toggleSemanticSuggest = useCallback(async (): Promise<boolean> => {
    const currentMe = readMeFromQueryClient(queryClient) ?? opts?.fallbackMe ?? null;
    const currentVal = Boolean(currentMe?.settings?.semantic_suggest);
    return setSemanticSuggest(!currentVal);
  }, [queryClient, opts?.fallbackMe, setSemanticSuggest]);

  return {
    me,
    semanticSuggest,
    semanticAvailable,
    semanticExternal,
    isPending,
    errorCode,
    isSemanticUnavailableError: errorCode === 'semantic_unavailable',
    setSemanticSuggest,
    toggleSemanticSuggest,
    clearError,
  };
}
