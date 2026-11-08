import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from '@/app/app/settings/page';
import { ThemeProvider } from '@/components/theme-provider';
import { DataSection } from '@/features/settings/data';
import type { ReauthAction, ReauthGrant } from '@/lib/api/auth';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

let mockGrant: ReauthGrant | null = null;
let mockPendingAction: ReauthAction | null = null;
const mockClearGrant = vi.fn(() => {
  mockGrant = null;
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  usePathname: () => '/app/settings',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/features/vault/vault-provider', () => ({
  useVault: () => ({
    state: 'unlocked',
    vaultMeta: {
      vault_key_id: 'vk:AAECAwQFBgcICQoLDA0ODw',
      version: 1,
      passkeys: [],
      recovery_keys: [],
    },
    beginOp: () => ({
      opGeneration: 1,
      isCurrent: () => true,
      client: {
        openEntry: vi.fn(),
      },
    }),
    registerSecretFormReset: () => () => undefined,
  }),
  useOptionalVault: () => ({
    state: 'unlocked',
  }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({
    me: {
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'user@example.com',
        email_verified: true,
        created_at: '2026-11-01T00:00:00Z',
      },
      settings: {
        locale: 'vi',
        theme: 'light',
        auto_lock_minutes: 15,
        semantic_suggest: false,
      },
      identities: [{ provider: 'password', linked_at: '2026-11-01T00:00:00Z' }],
      features: {
        semantic_available: false,
        email_verification_required: false,
        oauth_providers: ['google'],
        oauth_reauth_providers: ['google'],
        password_enrollment_available: false,
        captcha_site_key: null,
      },
      vault: { status: 'present' },
      semantic_consent_seen_at: null,
    },
    refetchMe: vi.fn(async () => undefined),
    reauth: {
      grant: mockGrant,
      pendingAction: mockPendingAction,
      error: null,
      submitting: false,
      capabilities: {
        hasPassword: true,
        oauthReauthProviders: ['google'],
        passwordEnrollmentAvailable: true,
      },
      begin: vi.fn(async (action: ReauthAction) => {
        mockPendingAction = action;
        return {
          grant: 'grant-token',
          action,
          expires_at: '2026-11-08T10:10:00Z',
        } satisfies ReauthGrant;
      }),
      cancel: vi.fn(() => {
        mockPendingAction = null;
      }),
      clearGrant: mockClearGrant,
      startOauthReauth: vi.fn(async () => undefined),
      hasUsableGrant: (action: ReauthAction) =>
        Boolean(mockGrant && mockGrant.action === action),
    },
  }),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
describe('tests/settings-data.test.tsx (Settings #dulieu, #xoataikhoan, and <main id="main-content">)', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    mockGrant = null;
    mockPendingAction = null;
    mockClearGrant.mockClear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/exports/latest')) {
        return jsonResponse({ job: null });
      }
      if (url.includes('/auth/sessions')) {
        return jsonResponse({ items: [] });
      }
      if (url.includes('/auth/audit')) {
        return jsonResponse({ items: [], next_cursor: null });
      }
      if (url.includes('/me/notifications')) {
        return jsonResponse({ items: [], next_cursor: null });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders SettingsPage with <main id="main-content">, #dulieu DataSection, and #xoataikhoan DangerZoneSection', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <ThemeProvider initialTheme="light" initialLocale="vi">
            <NextIntlClientProvider locale="vi" messages={viMessages}>
              {children}
            </NextIntlClientProvider>
          </ThemeProvider>
        </QueryClientProvider>
      );
    }

    render(<SettingsPage />, { wrapper: Wrapper });

    const mainEl = document.querySelector('main#main-content');
    expect(mainEl).toBeInTheDocument();

    const dulieuSection = document.getElementById('dulieu');
    expect(dulieuSection).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('export-encrypted-start-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('export-readable-open-btn')).toBeInTheDocument();

    const dangerSection = document.getElementById('xoataikhoan');
    expect(dangerSection).toBeInTheDocument();
    expect(screen.getByTestId('delete-account-open-btn')).toBeInTheDocument();
  });

  it('auto-opens #plainDlg when returning to /app/settings?reauth=export.decrypted#dulieu and cleans query param via replaceState', async () => {
    const origUrl = window.location.href;
    window.history.replaceState(null, '', '/app/settings?reauth=export.decrypted#dulieu');

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <NextIntlClientProvider locale="en" messages={enMessages}>
            {children}
          </NextIntlClientProvider>
        </QueryClientProvider>
      );
    }

    render(<DataSection />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(document.getElementById('plainDlg')).toBeInTheDocument();
    });
    expect(window.location.search).toBe('');

    window.history.replaceState(null, '', origUrl);
  });

  it('does NOT auto-open #plainDlg or auto-start export when a stale export.decrypted grant is present without ?reauth=export.decrypted query (M3)', async () => {
    const origUrl = window.location.href;
    window.history.replaceState(null, '', '/app/settings#dulieu');
    mockGrant = {
      grant: 'stale-grant-token',
      action: 'export.decrypted',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
    };

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          <NextIntlClientProvider locale="en" messages={enMessages}>
            {children}
          </NextIntlClientProvider>
        </QueryClientProvider>
      );
    }

    render(<DataSection />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByTestId('export-encrypted-start-btn')).toBeInTheDocument();
    });
    expect(document.getElementById('plainDlg')).not.toBeInTheDocument();

    window.history.replaceState(null, '', origUrl);
  });
});
