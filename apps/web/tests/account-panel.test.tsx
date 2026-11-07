import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountPanel } from '@/features/settings/account/account-panel';
import type { Me } from '@/lib/api/auth';
import en from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const mocks = vi.hoisted(() => ({
  me: null as Me | null,
  refresh: vi.fn(),
  refetchMe: vi.fn(async () => undefined),
  patchSettings: vi.fn(),
  setPreferenceCookies: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh, replace: vi.fn() }),
}));

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({ me: mocks.me, refetchMe: mocks.refetchMe }),
}));

vi.mock('@/lib/api/auth', () => ({
  patchSettings: (...args: unknown[]) => mocks.patchSettings(...args),
}));

vi.mock('@/lib/preferences/cookies', () => ({
  setPreferenceCookies: (...args: unknown[]) => mocks.setPreferenceCookies(...args),
}));

function makeMe(serverLocale: 'en' | 'vi'): Me {
  return {
    user: {
      id: 'u1',
      email: 'user@example.test',
      email_verified: true,
      created_at: '2026-10-01T00:00:00Z',
    },
    settings: {
      locale: serverLocale,
      theme: 'light',
      auto_lock_minutes: 15,
      semantic_suggest: false,
    },
    identities: [{ provider: 'password', linked_at: '2026-10-01T00:00:00Z' }],
    features: {
      semantic_available: false,
      email_verification_required: false,
      oauth_providers: [],
      oauth_reauth_providers: [],
      password_enrollment_available: false,
      captcha_site_key: null,
    },
    vault: { status: 'absent' },
    semantic_consent_seen_at: null,
  } as Me;
}

describe('AccountPanel locale radio (D16)', () => {
  afterEach(() => {
    cleanup();
    mocks.me = null;
    mocks.refresh.mockReset();
    mocks.refetchMe.mockClear();
    mocks.patchSettings.mockReset();
    mocks.setPreferenceCookies.mockReset();
  });

  it('selects Tiếng Việt when the active UI locale is vi even if me.settings.locale is still en', () => {
    mocks.me = makeMe('en');
    const dialogs = { open: vi.fn() } as unknown as Parameters<typeof AccountPanel>[0]['dialogs'];

    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <AccountPanel dialogs={dialogs} />
      </NextIntlClientProvider>,
    );

    const localeGroup = screen.getByRole('radiogroup', {
      name: viMessages.settings.account.localeTitle,
    });
    expect(within(localeGroup).getByRole('radio', { name: 'Tiếng Việt' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(localeGroup).getByRole('radio', { name: 'English' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('selects English when the active UI locale is en', () => {
    mocks.me = makeMe('vi');
    const dialogs = { open: vi.fn() } as unknown as Parameters<typeof AccountPanel>[0]['dialogs'];

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AccountPanel dialogs={dialogs} />
      </NextIntlClientProvider>,
    );

    const localeGroup = screen.getByRole('radiogroup', {
      name: en.settings.account.localeTitle,
    });
    expect(within(localeGroup).getByRole('radio', { name: 'English' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(localeGroup).getByRole('radio', { name: 'Tiếng Việt' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('patches locale, updates preference cookies, refetches me, and triggers router.refresh()', async () => {
    mocks.me = makeMe('vi');
    const updatedMe = makeMe('en');
    mocks.patchSettings.mockResolvedValueOnce(updatedMe);
    const dialogs = { open: vi.fn() } as unknown as Parameters<typeof AccountPanel>[0]['dialogs'];

    render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <AccountPanel dialogs={dialogs} />
      </NextIntlClientProvider>,
    );

    const localeGroup = screen.getByRole('radiogroup', {
      name: viMessages.settings.account.localeTitle,
    });
    fireEvent.click(within(localeGroup).getByRole('radio', { name: 'English' }));

    await waitFor(() => {
      expect(mocks.patchSettings).toHaveBeenCalledWith({ locale: 'en' });
      expect(mocks.setPreferenceCookies).toHaveBeenCalledWith('en', 'light');
      expect(mocks.refetchMe).toHaveBeenCalledTimes(1);
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
    });
  });
});
