import '../features/settings/data/sabk-offline-restore.test';
import '../features/settings/data/decrypted-export-runner.test';
import '../features/settings/data/encrypted-backup-card.test';
import '../features/settings/data/readable-export-dialog.test';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from '@/app/app/settings/page';
import { ThemeProvider } from '@/components/theme-provider';
import { DataSection } from '@/features/settings/data';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  usePathname: () => '/app/settings',
  useSearchParams: () => new URLSearchParams(),
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
});
