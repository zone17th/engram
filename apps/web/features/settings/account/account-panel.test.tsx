import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountPanel } from '@/features/settings/account/account-panel';
import type { Me } from '@/lib/api/auth';
import en from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const mocks = vi.hoisted(() => ({ me: null as Me | null }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({ me: mocks.me, refetchMe: vi.fn(async () => undefined) }),
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
  } as Me;
}

describe('AccountPanel locale radio (D16)', () => {
  afterEach(() => {
    cleanup();
    mocks.me = null;
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
});
