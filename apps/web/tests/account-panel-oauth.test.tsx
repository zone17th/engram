import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '@/lib/api/auth';
import en from '@/messages/en.json';
import { AccountPanel } from '@/features/settings/account/account-panel';

// HOTFIX-OAUTH-NULL: production (OAuth off) crashed /app/settings in this panel. The API now always
// sends `oauth_providers: []`; this proves the panel renders with an empty list.

const mocks = vi.hoisted(() => ({ me: null as unknown, config: null as unknown }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({ me: mocks.me, config: mocks.config, refetchMe: vi.fn(async () => undefined) }),
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
    semantic_consent_seen_at: null,
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
    mocks.config = null;
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

  // F-17: no inert 'not linked' pills for providers this server does not offer.
  it('hides unconfigured provider pills and says why when none is offered', () => {
    mocks.me = meWith([]);
    renderPanel();
    expect(screen.queryByText(/Google · /)).not.toBeInTheDocument();
    expect(screen.queryByText(/GitHub · /)).not.toBeInTheDocument();
    expect(screen.getByTestId('account-oauth-unavailable')).toHaveTextContent(en.settings.account.oauthUnavailable);
  });

  it('shows a pill only for the configured provider', () => {
    mocks.me = meWith(['github']);
    renderPanel();
    expect(screen.getByText('GitHub · not linked')).toBeInTheDocument();
    expect(screen.queryByText(/Google · /)).not.toBeInTheDocument();
    expect(screen.queryByTestId('account-oauth-unavailable')).not.toBeInTheDocument();
  });

  // F-13: without mail delivery the address can never be verified.
  it('hides the Not verified badge when mail delivery is off, keeps it when mail works', () => {
    const me = meWith([]) as Me;
    mocks.me = { ...me, user: { ...me.user, email_verified: false } };
    mocks.config = { mail_delivery_available: false };
    const { unmount } = renderPanel();
    expect(screen.queryByText(/Not verified/)).not.toBeInTheDocument();
    unmount();
    mocks.config = { mail_delivery_available: true };
    renderPanel();
    expect(screen.getByText(/Not verified/)).toBeInTheDocument();
  });
});
