import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { RouteGuard } from '@/features/auth/route-guard';
import { keepAuthFormMountedWhileLoading, resolveGuardRedirect } from '@/features/auth/guard-redirect';
import type { Me } from '@/lib/api/auth';
import en from '../messages/en.json';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/app/settings',
  useRouter: () => ({ replace }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({
    status: 'authenticated_without_vault',
    me: {
      user: { email: 'a@b.c', email_verified: true },
      features: { email_verification_required: false },
      vault: { status: 'absent' },
    },
    refetchMe: vi.fn(),
  }),
}));

function fixture(overrides: {
  user?: Partial<Me['user']>;
  features?: Partial<Me['features']>;
  vault?: Me['vault'];
} = {}): Me {
  return {
    user: {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'a@b.c',
      email_verified: true,
      created_at: '2026-01-01T00:00:00Z',
      ...overrides.user,
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
      ...overrides.features,
    },
    vault: overrides.vault ?? { status: 'absent' },
  };
}

describe('RouteGuard', () => {
  it('allows settings without vault', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <RouteGuard>
          <div>settings content</div>
        </RouteGuard>
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('settings content')).toBeInTheDocument();
  });
});

describe('keepAuthFormMountedWhileLoading', () => {
  it('keeps login, signup, verify-email, and password-enroll mounted', () => {
    expect(keepAuthFormMountedWhileLoading('/app/auth/login')).toBe(true);
    expect(keepAuthFormMountedWhileLoading('/app/auth/signup')).toBe(true);
    expect(keepAuthFormMountedWhileLoading('/app/auth/verify-email')).toBe(true);
    expect(keepAuthFormMountedWhileLoading('/app/auth/password-enroll')).toBe(true);
    expect(keepAuthFormMountedWhileLoading('/app/settings')).toBe(false);
    expect(keepAuthFormMountedWhileLoading('/app')).toBe(false);
  });
});

describe('resolveGuardRedirect', () => {
  it('does not redirect while loading or unavailable', () => {
    expect(resolveGuardRedirect({ status: 'loading', pathname: '/app', me: null })).toBeNull();
    expect(resolveGuardRedirect({ status: 'unavailable', pathname: '/app/settings', me: null })).toBeNull();
  });

  it('sends signed-out users to login except public auth pages', () => {
    expect(resolveGuardRedirect({ status: 'signed_out', pathname: '/app/auth/login', me: null })).toBeNull();
    expect(resolveGuardRedirect({ status: 'signed_out', pathname: '/app/auth/signup', me: null })).toBeNull();
    expect(resolveGuardRedirect({ status: 'signed_out', pathname: '/app/auth/verify-email', me: null })).toBe(
      '/app/auth/login?returnTo=%2Fapp%2Fauth%2Fverify-email',
    );
    expect(resolveGuardRedirect({ status: 'signed_out', pathname: '/app/settings', me: null })).toBe(
      '/app/auth/login?returnTo=%2Fapp%2Fsettings',
    );
    expect(resolveGuardRedirect({ status: 'signed_out', pathname: '/app', me: null })).toBe('/app/auth/login');
  });

  it('keeps unverified users on verify/account routes when the flag is on', () => {
    const me = fixture({
      user: { email_verified: false },
      features: { email_verification_required: true },
    });
    expect(
      resolveGuardRedirect({ status: 'authenticated_without_vault', pathname: '/app/auth/verify-email', me }),
    ).toBeNull();
    expect(
      resolveGuardRedirect({ status: 'authenticated_without_vault', pathname: '/app/settings', me }),
    ).toBeNull();
    expect(resolveGuardRedirect({ status: 'authenticated_without_vault', pathname: '/app', me })).toBe(
      '/app/auth/verify-email',
    );
    expect(
      resolveGuardRedirect({ status: 'authenticated_without_vault', pathname: '/app/onboarding', me }),
    ).toBe('/app/auth/verify-email');
  });

  it('sends accounts without a vault to onboarding, not a fake complete vault', () => {
    const me = fixture({ vault: { status: 'absent' } });
    expect(resolveGuardRedirect({ status: 'authenticated_without_vault', pathname: '/app', me })).toBe(
      '/app/onboarding',
    );
    expect(
      resolveGuardRedirect({ status: 'authenticated_without_vault', pathname: '/app/onboarding', me }),
    ).toBeNull();
    expect(
      resolveGuardRedirect({ status: 'authenticated_without_vault', pathname: '/app/settings', me }),
    ).toBeNull();
    expect(
      resolveGuardRedirect({ status: 'authenticated_without_vault', pathname: '/app/auth/login', me }),
    ).toBe('/app/onboarding');
    expect(
      resolveGuardRedirect({
        status: 'authenticated_without_vault',
        pathname: '/app/auth/callback/google',
        me,
      }),
    ).toBeNull();
  });

  it('lets a present vault leave onboarding and stay on app routes', () => {
    const me = fixture({ vault: { status: 'present' } });
    expect(resolveGuardRedirect({ status: 'authenticated_with_vault', pathname: '/app/onboarding', me })).toBe(
      '/app',
    );
    expect(resolveGuardRedirect({ status: 'authenticated_with_vault', pathname: '/app', me })).toBeNull();
    expect(resolveGuardRedirect({ status: 'authenticated_with_vault', pathname: '/app/settings', me })).toBeNull();
    expect(resolveGuardRedirect({ status: 'authenticated_with_vault', pathname: '/app/auth/login', me })).toBe(
      '/app',
    );
    expect(
      resolveGuardRedirect({ status: 'authenticated_with_vault', pathname: '/app/auth/reauth', me }),
    ).toBeNull();
  });

  it('does not treat a present vault as verified when email is still required', () => {
    const me = fixture({
      user: { email_verified: false },
      features: { email_verification_required: true },
      vault: { status: 'present' },
    });
    expect(resolveGuardRedirect({ status: 'authenticated_with_vault', pathname: '/app', me })).toBe(
      '/app/auth/verify-email',
    );
  });
});
