import { ProblemError } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthApiModule from '@/lib/api/auth';
import type { Me, SettingsPatch } from '@/lib/api/auth';
import { bumpSessionEpoch, getSessionEpoch } from '@/lib/api/auth-fetch';
import {
  AUTH_ME_QUERY_KEY_PREFIX,
  readMeFromQueryClient,
  useSemanticSuggestSetting,
} from './use-semantic-suggest-setting';

const patchSettingsMock = vi.hoisted(() => vi.fn<(patch: SettingsPatch) => Promise<Me>>());

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthApiModule>();
  return {
    ...actual,
    patchSettings: (patch: SettingsPatch) => patchSettingsMock(patch),
  };
});

function makeMe(overrides: {
  readonly id?: string;
  readonly email?: string;
  readonly semantic_suggest?: boolean;
  readonly semantic_available?: boolean;
  readonly semantic_external?: boolean;
} = {}): Me {
  const features: Me['features'] = {
    semantic_available: overrides.semantic_available ?? true,
    email_verification_required: false,
    oauth_providers: [],
    oauth_reauth_providers: [],
    password_enrollment_available: false,
    captcha_site_key: null,
    ...(overrides.semantic_external !== undefined
      ? { semantic_external: overrides.semantic_external }
      : {}),
  };

  return {
    user: {
      id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
      email: overrides.email ?? 'user@example.com',
      email_verified: true,
      created_at: '2026-11-02T00:00:00Z',
    },
    settings: {
      locale: 'vi',
      theme: 'light',
      auto_lock_minutes: 15,
      semantic_suggest: overrides.semantic_suggest ?? false,
    },
    identities: [],
    vault: {
      status: 'present',
    },
    features,
    semantic_consent_seen_at: null,
  };
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('features/omnibox/suggest/use-semantic-suggest-setting', () => {
  beforeEach(() => {
    patchSettingsMock.mockReset();
  });

  it('non-optimistic PATCH', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const initialMe = makeMe({
      semantic_suggest: false,
      semantic_available: true,
    });
    const meKey = [...AUTH_ME_QUERY_KEY_PREFIX, getSessionEpoch()] as const;
    queryClient.setQueryData(meKey, initialMe);

    const deferred = Promise.withResolvers<Me>();
    patchSettingsMock.mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useSemanticSuggestSetting(), {
      wrapper: createWrapper(queryClient),
    });

    // Initial state: semanticSuggest is false, and absent semantic_external defaults to true (2.24 item 4)
    expect(result.current.semanticSuggest).toBe(false);
    expect(result.current.semanticAvailable).toBe(true);
    expect(result.current.semanticExternal).toBe(true);

    let pendingPromise!: Promise<boolean>;
    act(() => {
      pendingPromise = result.current.setSemanticSuggest(true);
    });

    // While PATCH is in flight, neither the hook state nor the QueryClient cache is updated optimistically
    expect(result.current.isPending).toBe(true);
    expect(result.current.semanticSuggest).toBe(false);
    expect(readMeFromQueryClient(queryClient)?.settings.semantic_suggest).toBe(false);
    expect(patchSettingsMock).toHaveBeenCalledWith({ semantic_suggest: true });

    // Resolve HTTP 200 -> cache and hook update to true
    const serverMe = makeMe({
      semantic_suggest: true,
      semantic_available: true,
      semantic_external: false,
    });
    await act(async () => {
      deferred.resolve(serverMe);
      const ok = await pendingPromise;
      expect(ok).toBe(true);
    });

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
      expect(result.current.semanticSuggest).toBe(true);
      expect(result.current.semanticExternal).toBe(false);
    });
    expect(readMeFromQueryClient(queryClient)?.settings.semantic_suggest).toBe(true);
  });

  it('409 reverts', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const initialMe = makeMe({
      semantic_suggest: false,
      semantic_available: true,
      semantic_external: true,
    });
    const meKey = [...AUTH_ME_QUERY_KEY_PREFIX, getSessionEpoch()] as const;
    queryClient.setQueryData(meKey, initialMe);

    patchSettingsMock.mockRejectedValueOnce(
      new ProblemError({
        type: 'https://engram.zone17.click/problems/semantic_unavailable',
        title: 'Semantic search unavailable',
        status: 409,
        code: 'semantic_unavailable',
      }),
    );

    const { result } = renderHook(() => useSemanticSuggestSetting(), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.semanticSuggest).toBe(false);

    let outcome = true;
    await act(async () => {
      outcome = await result.current.toggleSemanticSuggest();
    });

    expect(outcome).toBe(false);
    expect(result.current.semanticSuggest).toBe(false);
    expect(result.current.isPending).toBe(false);
    expect(result.current.errorCode).toBe('semantic_unavailable');
    expect(result.current.isSemanticUnavailableError).toBe(true);
    expect(readMeFromQueryClient(queryClient)?.settings.semantic_suggest).toBe(false);

    // Clear error state
    act(() => {
      result.current.clearError();
    });
    expect(result.current.errorCode).toBeNull();
    expect(result.current.isSemanticUnavailableError).toBe(false);
  });

  it('epoch changed mid-PATCH drops response and never writes into new epoch or logged-out null entry', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const userAMe = makeMe({
      id: '00000000-0000-4000-8000-00000000000a',
      email: 'a@example.com',
      semantic_suggest: false,
      semantic_available: true,
    });
    const epochA = getSessionEpoch();
    const keyA = [...AUTH_ME_QUERY_KEY_PREFIX, epochA] as const;
    queryClient.setQueryData(keyA, userAMe);

    const deferred = Promise.withResolvers<Me>();
    patchSettingsMock.mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useSemanticSuggestSetting(), {
      wrapper: createWrapper(queryClient),
    });

    let pendingPromise!: Promise<boolean>;
    act(() => {
      pendingPromise = result.current.setSemanticSuggest(true);
    });

    // Concurrent toggle while in-flight returns false and sets lastOutcome = 'busy'
    let concurrentOk = true;
    await act(async () => {
      concurrentOk = await result.current.setSemanticSuggest(false);
    });
    expect(concurrentOk).toBe(false);
    expect(result.current.lastOutcome).toBe('busy');

    // Remote logout / session_changed bumps epoch and sets new epoch cache entry to null
    const epochB = bumpSessionEpoch();
    const keyB = [...AUTH_ME_QUERY_KEY_PREFIX, epochB] as const;
    queryClient.setQueryData<Me | null>(keyB, null);

    // Read in new epoch must not fall back to old epoch's user A data
    expect(readMeFromQueryClient(queryClient)).toBeNull();

    // Late PATCH response from user A resolves -> must be dropped
    const updatedUserAMe = makeMe({
      id: '00000000-0000-4000-8000-00000000000a',
      email: 'a@example.com',
      semantic_suggest: true,
      semantic_available: true,
    });
    await act(async () => {
      deferred.resolve(updatedUserAMe);
      const ok = await pendingPromise;
      expect(ok).toBe(false);
    });

    expect(result.current.lastOutcome).toBe('failed');
    expect(queryClient.getQueryData(keyB)).toBeNull();
    expect(queryClient.getQueryData<Me>(keyA)?.settings.semantic_suggest).toBe(false);
  });

  it('user switched mid-PATCH drops response and keeps new user Me intact', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const userAMe = makeMe({
      id: '00000000-0000-4000-8000-00000000000a',
      email: 'a@example.com',
      semantic_suggest: false,
      semantic_available: true,
    });
    const userBMe = makeMe({
      id: '00000000-0000-4000-8000-00000000000b',
      email: 'b@example.com',
      semantic_suggest: false,
      semantic_available: false,
    });
    const epoch = getSessionEpoch();
    const meKey = [...AUTH_ME_QUERY_KEY_PREFIX, epoch] as const;
    queryClient.setQueryData(meKey, userAMe);

    const deferred = Promise.withResolvers<Me>();
    patchSettingsMock.mockReturnValueOnce(deferred.promise);

    const { result, rerender } = renderHook(
      ({ fallback }: { readonly fallback?: Me | null }) =>
        useSemanticSuggestSetting({ fallbackMe: fallback }),
      {
        initialProps: { fallback: null },
        wrapper: createWrapper(queryClient),
      },
    );

    // Verify callback identity stability across inline opts re-renders (RV-T9-FE1-13)
    const firstSetRef = result.current.setSemanticSuggest;
    const firstToggleRef = result.current.toggleSemanticSuggest;
    rerender({ fallback: null });
    expect(result.current.setSemanticSuggest).toBe(firstSetRef);
    expect(result.current.toggleSemanticSuggest).toBe(firstToggleRef);

    let pendingPromise!: Promise<boolean>;
    act(() => {
      pendingPromise = result.current.setSemanticSuggest(true);
    });

    // User B replaces the Me cache entry before User A's PATCH resolves
    act(() => {
      queryClient.setQueryData(meKey, userBMe);
    });

    const updatedUserAMe = makeMe({
      id: '00000000-0000-4000-8000-00000000000a',
      email: 'a@example.com',
      semantic_suggest: true,
      semantic_available: true,
    });
    await act(async () => {
      deferred.resolve(updatedUserAMe);
      const ok = await pendingPromise;
      expect(ok).toBe(false);
    });

    expect(result.current.lastOutcome).toBe('failed');
    expect(readMeFromQueryClient(queryClient)?.user.id).toBe(userBMe.user.id);
    expect(readMeFromQueryClient(queryClient)?.settings.semantic_suggest).toBe(false);
  });
});
