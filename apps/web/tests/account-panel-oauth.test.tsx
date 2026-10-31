import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@/lib/api/auth';
import en from '@/messages/en.json';
import { AccountPanel } from '@/features/settings/account/account-panel';

// HOTFIX-OAUTH-NULL: production (OAuth off) crashed /app/settings in this panel. The API now always
// sends `oauth_providers: []`; this proves the panel renders with an empty list.

const mocks = vi.hoisted(() => ({ me: null as unknown }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({ me: mocks.me, refetchMe: vi.fn(async () => undefined) }),
}));

function meWith(oauthProviders: Me['features']['oauth_providers']): Me {
  return {
    user: { id: 'u1', email: 'user@example.test', email_verified: true, created_at: '2026-10-01T00:00:00Z' },
    settings: { locale: 'en', theme: 'light', auto_lock_minutes: 15, semantic_suggest: false },
    identities: [{ provider: 'password', linked_at: '2026-10-01T00:00:00Z' }],
    features: {
      semantic_available: false,
      email_verification_required: false,
      oauth_providers: oauthProviders,
      oauth_reauth_providers: [],
      password_enrollment_available: false,
      captcha_site_key: null,
    },
    vault: { status: 'absent' },
  } as Me;
}

function renderPanel() {
  const dialogs = { open: vi.fn() } as unknown as Parameters<typeof AccountPanel>[0]['dialogs'];
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AccountPanel dialogs={dialogs} />
    </NextIntlClientProvider>,
  );
}

describe('AccountPanel oauth_providers', () => {
  afterEach(() => {
    cleanup();
    mocks.me = null;
  });

  it('renders when oauth_providers is an empty array (OAuth off)', () => {
    mocks.me = meWith([]);
    renderPanel();
    expect(screen.getByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByText('Sign-in methods')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link Google' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link GitHub' })).not.toBeInTheDocument();
  });

  it('offers a link button for each enabled, unlinked provider', () => {
    mocks.me = meWith(['google']);
    renderPanel();
    expect(screen.getByRole('button', { name: 'Link Google' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link GitHub' })).not.toBeInTheDocument();
  });
});
