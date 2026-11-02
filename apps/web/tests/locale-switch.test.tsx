import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteHeader } from '@/components/landing/site-header';
import { LocaleSwitch, toLandingLocaleHref } from '@/components/locale-switch';
import { AuthChrome } from '@/features/auth/auth-chrome';
import { ForgotPasswordForm } from '@/features/auth/forms/forgot-password-form';
import { LocaleThemeSync } from '@/features/auth/locale-sync';
import { ReauthMessagesProvider } from '@/features/auth/use-reauth';
import type { PasswordForgotRequest } from '@/lib/api/auth';
import { LOCALE_COOKIE, THEME_COOKIE } from '@/lib/preferences/cookies';
import en from '../messages/en.json';
import viMessages from '../messages/vi.json';

const mocks = vi.hoisted(() => {
  return {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    pathname: '/app/auth/login',
    searchParams: '',
    theme: 'light' as 'system' | 'light' | 'dark',
    resolvedTheme: 'light' as 'light' | 'dark',
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
    authPasswordForgot: vi.fn<(body: PasswordForgotRequest) => Promise<void>>(),
    bootstrapCsrf: vi.fn<() => Promise<void>>(),
    session: {
      status: 'signed_out' as
        | 'loading'
        | 'signed_out'
        | 'authenticated_without_vault'
        | 'authenticated_with_vault'
        | 'unavailable',
      me: null as {
        settings: {
          locale: 'en' | 'vi';
          theme: 'system' | 'light' | 'dark';
        };
      } | null,
      config: {
        oauth_providers: ['google'] as Array<'google' | 'github'>,
        email_verification_required: false,
        captcha_site_key: null as string | null,
        mail_delivery_available: true,
      },
      configLoading: false,
      configError: false,
      bootstrapComplete: true,
    },
  };
});

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) => (
    <a href={href} data-next-link="true" {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mocks.push,
    replace: mocks.replace,
    refresh: mocks.refresh,
  }),
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.searchParams),
}));

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({
    theme: mocks.theme,
    resolved: mocks.resolvedTheme,
    setTheme: mocks.setTheme,
    toggle: mocks.toggleTheme,
  }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => mocks.session,
}));

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    authPasswordForgot: mocks.authPasswordForgot,
    bootstrapCsrf: mocks.bootstrapCsrf,
  };
});

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const entry = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}

function clearPreferenceCookies() {
  document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0`;
  document.cookie = `${THEME_COOKIE}=; path=/; max-age=0`;
}

function renderWithLocale(ui: ReactNode, locale: 'en' | 'vi' = 'en') {
  const messages = locale === 'en' ? en : viMessages;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <ReauthMessagesProvider auth={messages.auth}>{ui}</ReauthMessagesProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  clearPreferenceCookies();
  document.documentElement.lang = 'en';
  mocks.pathname = '/app/auth/login';
  mocks.searchParams = '';
  mocks.theme = 'light';
  mocks.resolvedTheme = 'light';
  mocks.session.status = 'signed_out';
  mocks.session.me = null;
  mocks.session.config = {
    oauth_providers: ['google'],
    email_verification_required: false,
    captcha_site_key: null,
    mail_delivery_available: true,
  };
  mocks.session.configLoading = false;
  mocks.session.configError = false;
  mocks.session.bootstrapComplete = true;
  mocks.authPasswordForgot.mockResolvedValue(undefined);
  mocks.bootstrapCsrf.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  clearPreferenceCookies();
});

describe('LocaleSwitch (FU15-LOCALE-SWITCH)', () => {
  it('sets sabk_locale and refreshes', () => {
    mocks.theme = 'dark';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { unmount } = renderWithLocale(
      <AuthChrome>
        <div>login content</div>
      </AuthChrome>,
      'en',
    );

    const group = screen.getByRole('group', { name: 'Language' });
    fireEvent.click(within(group).getByRole('radio', { name: 'VI' }));

    expect(readCookie(LOCALE_COOKIE)).toBe('vi');
    expect(readCookie(THEME_COOKIE)).toBe('dark');
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    unmount();

    // Landing SiteHeader writes sabk_locale and navigates between / and /vi while preserving subpaths.
    mocks.pathname = '/';
    const { unmount: unmountLandingEn } = renderWithLocale(<SiteHeader />, 'en');
    const landingEnGroup = screen.getByRole('group', { name: 'Language' });
    fireEvent.click(within(landingEnGroup).getByRole('radio', { name: 'VI' }));
    expect(readCookie(LOCALE_COOKIE)).toBe('vi');
    expect(mocks.push).toHaveBeenCalledWith('/vi');
    unmountLandingEn();

    mocks.push.mockClear();
    mocks.pathname = '/vi';
    renderWithLocale(<SiteHeader />, 'vi');
    const landingViGroup = screen.getByRole('group', { name: 'Ngôn ngữ' });
    fireEvent.click(within(landingViGroup).getByRole('radio', { name: 'EN' }));
    expect(readCookie(LOCALE_COOKIE)).toBe('en');
    expect(mocks.push).toHaveBeenCalledWith('/');

    expect(toLandingLocaleHref('/terms', 'vi')).toBe('/vi/terms');
    expect(toLandingLocaleHref('/vi/privacy', 'en')).toBe('/privacy');
    fetchSpy.mockRestore();
  });

  it('aria-pressed reflects active locale', () => {
    const { unmount } = renderWithLocale(<LocaleSwitch />, 'en');

    const enGroup = screen.getByRole('group', { name: 'Language' });
    const enItem = within(enGroup).getByRole('radio', { name: 'EN' });
    const viItem = within(enGroup).getByRole('radio', { name: 'VI' });

    expect(enItem).toHaveAttribute('aria-pressed', 'true');
    expect(enItem).toHaveAttribute('aria-checked', 'true');
    expect(enItem).toHaveAttribute('data-state', 'on');
    expect(enItem).toHaveClass('touch-target');

    expect(viItem).toHaveAttribute('aria-pressed', 'false');
    expect(viItem).toHaveAttribute('aria-checked', 'false');
    expect(viItem).toHaveAttribute('data-state', 'off');
    expect(viItem).toHaveClass('touch-target');
    unmount();

    mocks.pathname = '/app/auth/reset-password';
    const { container } = renderWithLocale(
      <AuthChrome>
        <div>reset content</div>
      </AuthChrome>,
      'vi',
    );

    // ADR 0006 §6.2: /app/auth/reset-password keeps its plain <a> logo link (no next/link).
    expect(container.querySelector('[data-next-link]')).toBeNull();
    const viGroup = screen.getByRole('group', { name: 'Ngôn ngữ' });
    const viActive = within(viGroup).getByRole('radio', { name: 'VI' });
    const enInactive = within(viGroup).getByRole('radio', { name: 'EN' });

    expect(viActive).toHaveAttribute('aria-pressed', 'true');
    expect(viActive).toHaveAttribute('aria-checked', 'true');
    expect(viActive).toHaveAttribute('data-state', 'on');
    expect(enInactive).toHaveAttribute('aria-pressed', 'false');
    expect(enInactive).toHaveAttribute('aria-checked', 'false');
    expect(enInactive).toHaveAttribute('data-state', 'off');
  });

  it('signed-in me.settings still wins', () => {
    renderWithLocale(<LocaleSwitch />, 'en');
    const group = screen.getByRole('group', { name: 'Language' });
    fireEvent.click(within(group).getByRole('radio', { name: 'VI' }));
    expect(readCookie(LOCALE_COOKIE)).toBe('vi');

    cleanup();
    mocks.session.status = 'authenticated_with_vault';
    mocks.session.me = {
      settings: {
        locale: 'en',
        theme: 'dark',
      },
    };

    renderWithLocale(<LocaleThemeSync />, 'vi');

    expect(readCookie(LOCALE_COOKIE)).toBe('en');
    expect(readCookie(THEME_COOKIE)).toBe('dark');
    expect(mocks.setTheme).toHaveBeenCalledWith('dark');
    expect(document.documentElement.lang).toBe('en');
  });

  it('forgot request carries switched locale', async () => {
    mocks.pathname = '/app/auth/forgot-password';
    const { rerender } = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ReauthMessagesProvider auth={en.auth}>
          <AuthChrome>
            <ForgotPasswordForm />
          </AuthChrome>
        </ReauthMessagesProvider>
      </NextIntlClientProvider>,
    );

    const group = screen.getByRole('group', { name: 'Language' });
    fireEvent.click(within(group).getByRole('radio', { name: 'VI' }));
    expect(readCookie(LOCALE_COOKIE)).toBe('vi');
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    // Simulate router.refresh() re-rendering AppLayout with the updated sabk_locale cookie ('vi').
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <ReauthMessagesProvider auth={viMessages.auth}>
          <AuthChrome>
            <ForgotPasswordForm />
          </AuthChrome>
        </ReauthMessagesProvider>
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole('heading', { name: viMessages.auth.forgot.title })).toBeInTheDocument();
    const emailInput = screen.getByLabelText('Email');
    fireEvent.change(emailInput, { target: { value: 'person@example.test' } });
    await act(async () => {
      fireEvent.submit(emailInput.closest('form')!);
    });

    expect(mocks.authPasswordForgot).toHaveBeenCalledWith({
      email: 'person@example.test',
      captcha_token: undefined,
      locale: 'vi',
    });
  });
});
