import { ProblemError } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthApiModule from '@/lib/api/auth';
import type { Me, SettingsPatch } from '@/lib/api/auth';
import { getSessionEpoch } from '@/lib/api/auth-fetch';
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
  readonly semantic_suggest?: boolean;
  readonly semantic_available?: boolean;
  readonly semantic_external?: boolean;
} = {}): Me {
  const features: Me['features'] = {
    semantic_available: overrides.semantic_available ?? true,
    email_verification_required: false,
    oauth_providers: [],
    oauth_reauth_providers: [],
    captcha_enabled: false,
    passkey_prf_enabled: true,
    ...(overrides.semantic_external !== undefined
      ? { semantic_external: overrides.semantic_external }
      : {}),
  };

  return {
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.com',
      email_verified: true,
      has_password: true,
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
      vault_key_id: 'vk:123',
      version: 1,
    },
    features,
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
});
