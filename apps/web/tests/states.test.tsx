import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppError from '../app/app/error';
import AppNotFound from '../app/app/not-found';
import MarketingNotFound from '../app/(marketing)/[locale]/not-found';
import { OfflineBanner } from '../components/app-shell/offline-banner';
import { RouteGuard } from '../features/auth/route-guard';
import { LockedBanner } from '../features/items/locked-banner';
import { SemanticCard } from '../features/settings/search/semantic-card';
import enMessages from '../messages/en.json';
import viMessages from '../messages/vi.json';

// U18 states (P06 Task 6, FE-R1-15): five groups, each in en and vi.
const LOCALES = [
  { locale: 'en', messages: enMessages },
  { locale: 'vi', messages: viMessages },
] as const;
type Entry = (typeof LOCALES)[number];

const mockReplace = vi.fn();
let mockPathname = '/app';
let mockSession: Record<string, unknown> = {};
let mockVault: { state: string } | null = null;
let mockSemantic: Record<string, unknown> = {};
let mockLocale = 'en';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ replace: mockReplace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/features/auth/session-provider', () => ({ useSession: () => mockSession }));
vi.mock('@/features/vault/vault-provider', () => ({ useOptionalVault: () => mockVault }));
vi.mock('@/features/omnibox/suggest/use-semantic-suggest-setting', () => ({
  useSemanticSuggestSetting: () => mockSemantic,
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  return {
    getLocale: async () => mockLocale,
    getTranslations: async ({ locale, namespace }: { locale: 'en' | 'vi'; namespace: string }) =>
      createTranslator({ locale, messages: locale === 'vi' ? viMessages : enMessages, namespace } as never),
  };
});

function wrap(entry: Entry, ui: ReactNode) {
  return (
    <NextIntlClientProvider locale={entry.locale} messages={entry.messages}>
      {ui}
    </NextIntlClientProvider>
  );
}

function setOnLine(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
}

beforeEach(() => {
  mockReplace.mockReset();
  mockPathname = '/app';
  mockVault = null;
  setOnLine(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each(LOCALES)('U18 #off offline banner ($locale)', (entry) => {
  it('announces offline, then reconnects, refreshes queries and hides the note', () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      wrap(
        entry,
        <QueryClientProvider client={queryClient}>
          <OfflineBanner />
        </QueryClientProvider>,
      ),
    );
    // M-3: always-mounted live region, empty while online
    const live = screen.getByTestId('offline-live');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toBeEmptyDOMElement();

    setOnLine(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    const banner = screen.getByTestId('offline-banner');
    expect(live).toContainElement(banner);
    expect(banner).toHaveTextContent(entry.messages.offline.bannerTitle);
    expect(banner).toHaveTextContent(entry.messages.offline.bannerBody);
    expect(invalidate).not.toHaveBeenCalled();

    setOnLine(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    expect(screen.getByTestId('offline-live')).toBe(live);
    expect(screen.getByTestId('offline-reconnected')).toHaveTextContent(entry.messages.offline.reconnectedTitle);
    expect(invalidate).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.queryByTestId('offline-reconnected')).toBeNull();
  });

  it('retries by itself when the online event was missed (periodic re-check)', () => {
    vi.useFakeTimers();
    setOnLine(false);
    render(wrap(entry, <OfflineBanner />));
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
    setOnLine(true);
    act(() => {
      vi.advanceTimersByTime(10_500);
    });
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    expect(screen.getByTestId('offline-reconnected')).toBeInTheDocument();
  });
});

describe.each(LOCALES)('U18 #auth-session-expired-midflow ($locale)', (entry) => {
  it('names the reason, keeps the page (no silent redirect) and offers one way back to login', () => {
    mockPathname = '/app/items/abc';
    // The page had a live session first (me in hand), then the session ended mid-flow.
    mockSession = {
      status: 'authenticated_with_vault',
      me: {
        user: { id: 'u', email_verified: true },
        vault: { status: 'present' },
        features: { email_verification_required: false },
      },
      refetchMe: vi.fn(),
      lastSessionEndReason: null,
    };
    const tree = () => (
      <RouteGuard>
        <div>private page</div>
      </RouteGuard>
    );
    const view = render(wrap(entry, tree()));
    mockReplace.mockClear();
    mockSession = {
      status: 'signed_out',
      me: null,
      refetchMe: vi.fn(),
      lastSessionEndReason: 'expired',
    };
    view.rerender(wrap(entry, tree()));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(entry.messages.states.sessionExpiredTitle);
    expect(alert).toHaveTextContent(entry.messages.states.sessionExpiredBody);
    expect(screen.queryByText('private page')).toBeNull();
    const cta = screen.getByRole('link', { name: entry.messages.states.sessionExpiredCta });
    expect(cta).toHaveAttribute('href', '/app/auth/login?returnTo=%2Fapp%2Fitems%2Fabc');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('M-2: a cold load with a dead cookie (no session ever seen on this page) redirects to login, no "unsaved changes cleared" frame', () => {
    mockPathname = '/app/items/abc';
    mockSession = {
      status: 'signed_out',
      me: null,
      refetchMe: vi.fn(),
      lastSessionEndReason: 'expired',
    };
    render(
      wrap(
        entry,
        <RouteGuard>
          <div>private page</div>
        </RouteGuard>,
      ),
    );
    expect(screen.queryByTestId('session-expired-midflow')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockReplace).toHaveBeenCalledWith(expect.stringContaining('/app/auth/login'));
  });

  it('a voluntary logout still redirects without the expired frame', () => {
    mockSession = { status: 'signed_out', me: null, refetchMe: vi.fn(), lastSessionEndReason: 'logout' };
    render(
      wrap(
        entry,
        <RouteGuard>
          <div>private page</div>
        </RouteGuard>,
      ),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mockReplace).toHaveBeenCalledWith('/app/auth/login');
  });
});

describe.each(LOCALES)('U18 #err-server-500 / #err-not-found ($locale)', (entry) => {
  it('server error shows translated copy and a retry', () => {
    const reset = vi.fn();
    render(wrap(entry, <AppError error={new Error('boom')} reset={reset} />));
    expect(screen.getByRole('heading', { name: entry.messages.states.server500Title })).toBeInTheDocument();
    expect(screen.getByText(entry.messages.states.server500Body)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: entry.messages.states.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('app not-found is translated and links back to the list', () => {
    render(wrap(entry, <AppNotFound />));
    expect(screen.getByRole('heading', { name: entry.messages.states.notFoundTitle })).toBeInTheDocument();
    expect(screen.getByText(entry.messages.states.notFoundBody)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: entry.messages.states.backToList })).toHaveAttribute('href', '/app');
  });

  it('F2: public-site not-found (/vi/<x>, /<x>) is branded and uses the request locale', async () => {
    mockLocale = entry.locale;
    render(await MarketingNotFound());
    expect(screen.getByRole('heading', { name: entry.messages.states.notFoundTitle })).toBeInTheDocument();
    // M-1 / R2-M1: page-level body, no item-specific sentence and no way into /app for an anonymous visitor; the only
    // action is the site home, named in plain words (not the literal brand).
    expect(screen.getByText(entry.messages.states.pageNotFoundBody)).toBeInTheDocument();
    expect(screen.queryByText(entry.messages.states.notFoundBody)).toBeNull();
    expect(screen.queryByRole('link', { name: entry.messages.states.backToList })).toBeNull();
    const home = screen.getByRole('link', { name: entry.messages.states.backHome });
    expect(home).toBe(screen.getByTestId('err-not-found-home'));
    expect(home).toHaveAttribute('href', entry.locale === 'vi' ? '/vi' : '/');
    expect(screen.queryByRole('link', { name: 'engram' })).toBeNull();
    expect(document.querySelector('main#main-content')).not.toBeNull();
  });
});

describe.each(LOCALES)('U18 #degr semantic card inline notes ($locale)', (entry) => {
  const base = {
    me: { user: { id: 'u' } },
    semanticSuggest: false,
    semanticAvailable: true,
    semanticExternal: true,
    isPending: false,
    errorCode: null,
    isSemanticUnavailableError: false,
    setSemanticSuggest: vi.fn(),
    clearError: vi.fn(),
  };

  it('#timkiem-server-off-note when the server has semantic search off', () => {
    mockSemantic = { ...base, semanticAvailable: false };
    render(wrap(entry, <SemanticCard />));
    expect(screen.getByTestId('settings-semantic-server-off')).toHaveTextContent(
      entry.messages.settings.search.semanticServerOff,
    );
  });

  it('#semantic-enable-409 sits in an always-mounted role=status note', () => {
    mockSemantic = { ...base, isSemanticUnavailableError: true, errorCode: 'semantic_unavailable' };
    render(wrap(entry, <SemanticCard />));
    const status = screen.getByTestId('settings-semantic-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent(entry.messages.settings.search.semanticEnable409);
  });

  it('#semantic-save-failed sits in the same role=status note', () => {
    mockSemantic = { ...base, errorCode: 'patch_failed' };
    render(wrap(entry, <SemanticCard />));
    expect(screen.getByTestId('settings-semantic-status')).toHaveTextContent(
      entry.messages.settings.search.semanticSaveFailed,
    );
  });
});

describe.each(LOCALES)('U18 #vault-locked-broadcast neutral banner ($locale)', (entry) => {
  it('is one neutral sentence with a single unlock action (no alarm role, no error colour class)', () => {
    mockVault = { state: 'locked' };
    mockPathname = '/app';
    render(wrap(entry, <LockedBanner />));
    const banner = screen.getByTestId('vault-locked-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveClass('locked-banner');
    expect(screen.getByTestId('vault-locked-banner-body')).toHaveTextContent(entry.messages.states.vaultLocked);
    expect(screen.getByTestId('vault-locked-unlock-cta')).toHaveTextContent(entry.messages.states.vaultLockedCta);
    expect(banner.className).not.toMatch(/error/);
  });
});
