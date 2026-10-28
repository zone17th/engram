import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import { authFetch } from '@/lib/api/auth-fetch';
import { changePassword } from '@/lib/api/auth';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status = 204) {
  return new Response(null, { status });
}

function problemResponse(code: string, status = 401, extra = {}) {
  return new Response(
    JSON.stringify({
      type: `https://key.zone17th.click/problems/${code}`,
      title: code,
      status,
      code,
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function meFixture(email: string) {
  return {
    user: {
      id: '11111111-1111-1111-1111-111111111111',
      email,
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

function RotationProbe() {
  const { status, me, refetchMe } = useSession();
  const started = useRef(false);

  useEffect(() => {
    if (!started.current && status === 'authenticated_without_vault') {
      started.current = true;
      void (async () => {
        await changePassword({ new_password: 'rotated-password-12' }, 'grant-token');
        await refetchMe();
      })();
    }
  }, [refetchMe, status]);

  return <output data-testid="rotation-state">{me?.user.email ?? ''}</output>;
}

function renderProvider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <RotationProbe />
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('password rotation session race', () => {
  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    let meCalls = 0;
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: async (_name: string, callback: () => Promise<unknown>) => callback(),
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/auth/csrf')) return emptyResponse();
      if (url.endsWith('/auth/config')) return jsonResponse({
        oauth_providers: [],
        email_verification_required: false,
        captcha_site_key: null,
      });
      if (url.endsWith('/auth/me')) {
        meCalls += 1;
        return jsonResponse(meFixture(meCalls === 1 ? 'old@example.test' : 'new@example.test'));
      }
      if (url.endsWith('/me/password')) return jsonResponse(meFixture('new@example.test'));
      throw new Error(`unexpected request: ${url}`);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('updates Me after password mutation and refetch', async () => {
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('rotation-state')).toHaveTextContent('new@example.test'));
  });

  it('keeps the replacement session when an old protected request finishes after rotation', async () => {
    const oldRequest = deferred<Response>();
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let meCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/auth/csrf')) return emptyResponse();
      if (url.endsWith('/auth/config')) return jsonResponse({
        oauth_providers: [],
        email_verification_required: false,
        captcha_site_key: null,
      });
      if (url.endsWith('/auth/me')) {
        meCalls += 1;
        return jsonResponse(meFixture(meCalls === 1 ? 'old@example.test' : 'new@example.test'));
      }
      if (url.endsWith('/me/password')) return jsonResponse(meFixture('new@example.test'));
      if (url.endsWith('/auth/sessions')) return oldRequest.promise;
      throw new Error(`unexpected request: ${url}`);
    });

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SessionProvider>
          <RotationRaceProbe />
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('rotation-race-state')).toHaveTextContent('replacement-pending'));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/sessions'))).toBe(true);
    oldRequest.resolve(problemResponse('session_invalid', 401, { reason: 'revoked' }));
    await waitFor(() => expect(screen.getByTestId('rotation-race-state')).toHaveTextContent('replacement-ready'));
  });
});

function RotationRaceProbe() {
  const { status, me, refetchMe } = useSession();
  const started = useRef(false);
  const [oldReadSettled, setOldReadSettled] = useState(false);

  useEffect(() => {
    if (!started.current && status === 'authenticated_without_vault') {
      started.current = true;
      void (async () => {
        const oldRead = authFetch('/auth/sessions', { requireSession: true }).catch(() => undefined);
        await changePassword({ new_password: 'rotated-password-12' }, 'grant-token');
        await refetchMe();
        await oldRead;
        setOldReadSettled(true);
      })();
    }
  }, [refetchMe, status]);

  return (
    <output data-testid="rotation-race-state">
      {me?.user.email === 'new@example.test'
        ? oldReadSettled
          ? 'replacement-ready'
          : 'replacement-pending'
        : status}
    </output>
  );
}
