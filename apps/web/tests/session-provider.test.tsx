import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import { authFetch, getSessionEpoch } from '@/lib/api/auth-fetch';
import { patchSettings } from '@/lib/api/auth';
import type { SessionBroadcast } from '@/lib/auth/broadcast';

type MessageListener = (event: MessageEvent<SessionBroadcast>) => void;

class TestBroadcastChannel {
  private static readonly instances = new Set<TestBroadcastChannel>();
  private readonly listeners = new Set<MessageListener>();

  constructor() {
    TestBroadcastChannel.instances.add(this);
  }

  addEventListener(type: string, listener: MessageListener): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: MessageListener): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(): void {}

  static emitRemote(message: SessionBroadcast): void {
    for (const instance of TestBroadcastChannel.instances) {
      for (const listener of instance.listeners) {
        listener({ data: message } as MessageEvent<SessionBroadcast>);
      }
    }
  }
}

function problemResponse(code: string, status = 401, extra = {}) {
  return new Response(
    JSON.stringify({
      type: `https://engram.zone17.click/problems/${code}`,
      title: code,
      status,
      code,
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status = 204) {
  return new Response(null, { status });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function authConfig() {
  return {
    oauth_providers: [],
    email_verification_required: false,
    captcha_site_key: null,
  };
}

function meFixture() {
  return {
    user: {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'user@example.test',
      email_verified: true,
      created_at: '2026-01-01T00:00:00Z',
    },
    settings: {
      locale: 'en',
      theme: 'system',
      auto_lock_minutes: 0,
      semantic_suggest: false,
    },
    identities: [{ provider: 'password', linked_at: '2026-01-01T00:00:00Z' }],
    features: {
      semantic_available: false,
      email_verification_required: false,
      oauth_providers: [],
      oauth_reauth_providers: [],
      password_enrollment_available: false,
      captcha_site_key: null,
    },
    vault: { status: 'absent' },
  };
}

function SessionProbe() {
  const { status, lastSessionEndReason } = useSession();
  return <output data-testid="session-state">{status}|{lastSessionEndReason ?? ''}</output>;
}

function CachedMeProbe() {
  const { status, me, refetchMe } = useSession();
  const started = useRef(false);
  useEffect(() => {
    if (!started.current && status === 'authenticated_without_vault') {
      started.current = true;
      void refetchMe().catch(() => undefined);
    }
  }, [refetchMe, status]);
  return <output data-testid="session-state">{status}|{me ? 'cached' : 'empty'}</output>;
}

function MutationProbe() {
  const { status, lastSessionEndReason } = useSession();
  const started = useRef(false);
  useEffect(() => {
    if (!started.current && status === 'authenticated_without_vault') {
      started.current = true;
      void patchSettings({ semantic_suggest: true }).catch(() => undefined);
    }
  }, [status]);
  return <output data-testid="session-state">{status}|{lastSessionEndReason ?? ''}</output>;
}

function RemoteRaceProbe() {
  const { status, me } = useSession();
  const started = useRef(false);
  const [oldReadSettled, setOldReadSettled] = useState(false);

  useEffect(() => {
    if (!started.current && status === 'authenticated_without_vault') {
      started.current = true;
      void authFetch('/auth/sessions', { requireSession: true })
        .catch(() => undefined)
        .finally(() => setOldReadSettled(true));
    }
  }, [status]);

  return (
    <output data-testid="remote-race-state">
      {status}|{me ? 'cached' : 'empty'}|{oldReadSettled ? 'ready' : 'pending'}
    </output>
  );
}

function StaleMeProbe() {
  const { status, me, lastSessionEndReason, refetchMe } = useSession();
  const started = useRef(false);

  useEffect(() => {
    if (!started.current && status === 'authenticated_without_vault') {
      started.current = true;
      void refetchMe().catch(() => undefined);
    }
  }, [refetchMe, status]);

  return (
    <output data-testid="stale-me-state">
      {status}|{lastSessionEndReason ?? ''}|{me ? 'cached' : 'empty'}
    </output>
  );
}

function renderProvider(child: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>{child}</SessionProvider>
    </QueryClientProvider>,
  );
}

describe('SessionProvider auth failure states', () => {
  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    vi.stubGlobal('BroadcastChannel', TestBroadcastChannel);
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: async (_name: string, callback: () => Promise<unknown>) => callback(),
      },
    });
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('keeps a revoked reason when Me reports a terminal session failure', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/csrf')) return emptyResponse();
      if (url.endsWith('/auth/config')) return jsonResponse(authConfig());
      if (url.endsWith('/auth/me')) return problemResponse('session_invalid', 401, { reason: 'revoked' });
      throw new Error(`unexpected request: ${url}`);
    });

    renderProvider(<SessionProbe />);
    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('signed_out|revoked'));
  });

  it('reports unavailable when refresh cannot be confirmed after a network failure', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let meCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/csrf')) return emptyResponse();
      if (url.endsWith('/auth/config')) return jsonResponse(authConfig());
      if (url.endsWith('/auth/me')) {
        meCalls += 1;
        return problemResponse('access_expired');
      }
      if (url.endsWith('/auth/refresh')) throw new TypeError('Failed to fetch');
      throw new Error(`unexpected request: ${url}`);
    });

    renderProvider(<SessionProbe />);
    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('unavailable|'));
    expect(meCalls).toBe(3);
  });

  it('clears the same tab after a mutation receives session_invalid', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/csrf')) return emptyResponse();
      if (url.endsWith('/auth/config')) return jsonResponse(authConfig());
      if (url.endsWith('/auth/me')) return jsonResponse(meFixture());
      if (url.endsWith('/me/settings')) return problemResponse('session_invalid', 401, { reason: 'revoked' });
      throw new Error(`unexpected request: ${url}`);
    });

    renderProvider(<MutationProbe />);
    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('signed_out|revoked'));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/me/settings'))).toHaveLength(1);
  });

  it('marks a cached session unavailable when a refetch loses the network', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let meCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/csrf')) return emptyResponse();
      if (url.endsWith('/auth/config')) return jsonResponse(authConfig());
      if (url.endsWith('/auth/me')) {
        meCalls += 1;
        if (meCalls === 1) return jsonResponse(meFixture());
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`unexpected request: ${url}`);
    });

    renderProvider(<CachedMeProbe />);
    await waitFor(() => expect(screen.getByTestId('session-state')).toHaveTextContent('unavailable|cached'));
  });

  it('advances the local epoch for a remote session change before refetching Me', async () => {
    const oldRequest = deferred<Response>();
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let meCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/csrf')) return emptyResponse();
      if (url.endsWith('/auth/config')) return jsonResponse(authConfig());
      if (url.endsWith('/auth/me')) {
        meCalls += 1;
        return jsonResponse(meFixture());
      }
      if (url.endsWith('/auth/sessions')) return oldRequest.promise;
      throw new Error(`unexpected request: ${url}`);
    });

    renderProvider(<RemoteRaceProbe />);
    await waitFor(() =>
      expect(screen.getByTestId('remote-race-state')).toHaveTextContent(
        'authenticated_without_vault|cached|pending',
      ),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/sessions'))).toBe(true),
    );

    const epochBeforeRemoteChange = getSessionEpoch();
    await act(async () => {
      TestBroadcastChannel.emitRemote({ type: 'session_changed' });
      await Promise.resolve();
    });
    await waitFor(() => expect(getSessionEpoch()).toBe(epochBeforeRemoteChange + 1));
    await waitFor(() => expect(meCalls).toBeGreaterThan(1));

    await act(async () => {
      oldRequest.resolve(problemResponse('session_invalid', 401, { reason: 'revoked' }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId('remote-race-state')).toHaveTextContent(
        'authenticated_without_vault|cached|ready',
      ),
    );
  });

  it('ignores a stale Me failure after a remote session change', async () => {
    const oldRequest = deferred<Response>();
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let meCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/csrf')) return emptyResponse();
      if (url.endsWith('/auth/config')) return jsonResponse(authConfig());
      if (url.endsWith('/auth/me')) {
        meCalls += 1;
        if (meCalls === 2) return oldRequest.promise;
        return jsonResponse(meFixture());
      }
      throw new Error(`unexpected request: ${url}`);
    });

    renderProvider(<StaleMeProbe />);
    await waitFor(() => expect(meCalls).toBe(2));
    await waitFor(() => expect(screen.getByTestId('stale-me-state')).toHaveTextContent('authenticated_without_vault||cached'));

    const epochBeforeRemoteChange = getSessionEpoch();
    await act(async () => {
      TestBroadcastChannel.emitRemote({ type: 'session_changed' });
      await Promise.resolve();
    });
    await waitFor(() => expect(getSessionEpoch()).toBe(epochBeforeRemoteChange + 1));
    await waitFor(() => expect(meCalls).toBeGreaterThan(2));

    await act(async () => {
      oldRequest.resolve(problemResponse('session_invalid', 401, { reason: 'revoked' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('stale-me-state')).toHaveTextContent('authenticated_without_vault||cached'));
  });
});
