import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemError, type ProblemDetails } from '@engram/shared-types';
import { AuthChrome } from '@/features/auth/auth-chrome';
import { ForgotPasswordForm } from '@/features/auth/forms/forgot-password-form';
import { LoginForm } from '@/features/auth/forms/login-form';
import { OAuthCallbackView } from '@/features/auth/forms/oauth-callback';
import { PasswordEnrollForm } from '@/features/auth/forms/password-enroll-form';
import { ReauthForm } from '@/features/auth/forms/reauth-form';
import * as resetPasswordModule from '@/features/auth/forms/reset-password-form';
import { ResetPasswordForm, extractResetTokenFromHash } from '@/features/auth/forms/reset-password-form';
import { SignupForm } from '@/features/auth/forms/signup-form';
import { VerifyEmailForm } from '@/features/auth/forms/verify-email-form';
import { evaluateAccountPasswordStrength } from '@/features/auth/password-strength-meter';
import { RouteGuard } from '@/features/auth/route-guard';
import en from '../messages/en.json';
import viMessages from '../messages/vi.json';

const mocks = vi.hoisted(() => {
  const authPasswordForgot = vi.fn();
  const authPasswordReset = vi.fn();
  const bootstrapCsrf = vi.fn();
  const ensureCsrf = vi.fn();
  const postSessionBroadcast = vi.fn();
  const verifyEmailConfirm = vi.fn();
  const verifyEmailSend = vi.fn();
  const passwordEnrollSend = vi.fn();
  const changePassword = vi.fn();
  const completeOAuthLogin = vi.fn();
  const refetchMe = vi.fn();
  const login = vi.fn();
  const signup = vi.fn();
  const submitPassword = vi.fn();
  const startOauthReauth = vi.fn();
  const consumeOauthReceipt = vi.fn();
  const readStoredPending = vi.fn();

  return {
    authPasswordForgot,
    authPasswordReset,
    bootstrapCsrf,
    ensureCsrf,
    postSessionBroadcast,
    verifyEmailConfirm,
    verifyEmailSend,
    passwordEnrollSend,
    changePassword,
    completeOAuthLogin,
    refetchMe,
    login,
    signup,
    submitPassword,
    startOauthReauth,
    consumeOauthReceipt,
    readStoredPending,
    replace: vi.fn(),
    push: vi.fn(),
    pathname: '/app/auth/forgot-password',
    searchParams: '',
    session: {
      status: 'signed_out' as
        | 'loading'
        | 'signed_out'
        | 'authenticated_without_vault'
        | 'authenticated_with_vault'
        | 'unavailable',
      me: null as unknown,
      config: {
        oauth_providers: ['google'] as Array<'google' | 'github'>,
        email_verification_required: false,
        captcha_site_key: null as string | null,
        mail_delivery_available: true,
      } as {
        oauth_providers: Array<'google' | 'github'>;
        email_verification_required: boolean;
        captcha_site_key: string | null;
        mail_delivery_available: boolean;
      } | null,
      configLoading: false,
      configError: false,
      bootstrapComplete: true,
      sessionEpoch: 0,
      webLocksAvailable: true,
      lastSessionEndReason: null,
      refetchMe,
      signup,
      login,
      completeOAuthLogin,
      signOut: vi.fn(),
      clearPrivateCache: vi.fn(),
      reauth: {
        grant: null,
        pendingAction: 'password_change' as const,
        error: null as string | null,
        submitting: false,
        capabilities: {
          hasPassword: true,
          oauthReauthProviders: ['google'] as Array<'google'>,
          passwordEnrollmentAvailable: false,
        },
        begin: vi.fn(),
        cancel: vi.fn(),
        submitPassword,
        startOauthReauth,
        consumeOauthReceipt,
        readStoredPending,
        clearGrant: vi.fn(),
        hasUsableGrant: vi.fn(),
      },
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.searchParams),
}));

vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', resolved: 'light', setTheme: vi.fn(), toggle: vi.fn() }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => mocks.session,
}));

vi.mock('@/features/vault/vault-provider', () => ({
  useOptionalVault: () => null,
}));

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    authPasswordForgot: mocks.authPasswordForgot,
    authPasswordReset: mocks.authPasswordReset,
    bootstrapCsrf: mocks.bootstrapCsrf,
    verifyEmailConfirm: mocks.verifyEmailConfirm,
    verifyEmailSend: mocks.verifyEmailSend,
    passwordEnrollSend: mocks.passwordEnrollSend,
    changePassword: mocks.changePassword,
  };
});

vi.mock('@/lib/api/auth-fetch', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ensureCsrf: mocks.ensureCsrf,
  };
});

vi.mock('@/lib/auth/broadcast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    postSessionBroadcast: mocks.postSessionBroadcast,
  };
});

function problem(code: string, overrides: Partial<ProblemDetails> = {}): ProblemError {
  return new ProblemError({
    type: `https://engram.zone17.click/problems/${code}`,
    title: 'SERIOUSLY_RAW_SERVER_TITLE_DO_NOT_RENDER',
    detail: 'SERIOUSLY_RAW_SERVER_DETAIL_DO_NOT_RENDER',
    status: 400,
    code,
    ...overrides,
  });
}

function renderWithLocale(ui: React.ReactNode, locale: 'en' | 'vi' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : viMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const VALID_TOKEN_43 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.pathname = '/app/auth/forgot-password';
  mocks.searchParams = '';
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
  mocks.session.reauth.error = null;
  mocks.authPasswordForgot.mockResolvedValue(undefined);
  mocks.authPasswordReset.mockResolvedValue(undefined);
  mocks.bootstrapCsrf.mockResolvedValue(undefined);
  mocks.ensureCsrf.mockResolvedValue(undefined);
  mocks.refetchMe.mockResolvedValue(undefined);
  window.history.replaceState(null, '', '/app/auth/forgot-password');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PasswordStrengthMeter estimator (local-only)', () => {
  it('scores password strength across 0..4 without any network call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(evaluateAccountPasswordStrength('')).toBe(0);
    expect(evaluateAccountPasswordStrength('short1!')).toBe(1);
    expect(evaluateAccountPasswordStrength('alllowercase12')).toBe(2);
    expect(evaluateAccountPasswordStrength('MixedCase12345')).toBe(3);
    expect(evaluateAccountPasswordStrength('StrongPassphrase!2026#Engram')).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ForgotPasswordForm states and problem-code mapping (ADR 0006 §9.2)', () => {
  it('renders loading skeleton while config is still loading', () => {
    mocks.session.config = null;
    mocks.session.configLoading = true;
    renderWithLocale(<ForgotPasswordForm />);
    expect(screen.getByTestId('forgot-loading-skeleton')).toBeInTheDocument();
  });

  it('renders network error card when /auth/config fails, and RouteGuard does not preempt public forgot-password when status is unavailable (AU2-FE3-2)', () => {
    mocks.pathname = '/app/auth/forgot-password';
    mocks.session.config = null;
    mocks.session.configError = true;
    mocks.session.status = 'unavailable';

    renderWithLocale(
      <RouteGuard>
        <ForgotPasswordForm />
      </RouteGuard>,
    );

    expect(screen.getByTestId('forgot-config-error')).toBeInTheDocument();
    expect(screen.getByText(en.auth.errors.network)).toBeInTheDocument();
  });

  it('renders unavailable card with /privacy#contact (en) and /vi/privacy#contact (vi) when mail_delivery_available === false', () => {
    mocks.session.config = {
      oauth_providers: ['google'],
      email_verification_required: false,
      captcha_site_key: null,
      mail_delivery_available: false,
    };

    const { unmount } = renderWithLocale(<ForgotPasswordForm />, 'en');
    expect(screen.getByTestId('forgot-unavailable')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.auth.forgot.mailUnavailableContactLink })).toHaveAttribute(
      'href',
      '/privacy#contact',
    );
    expect(screen.getByText(en.auth.forgot.mailUnavailableOauthHint)).toBeInTheDocument();
    unmount();

    renderWithLocale(<ForgotPasswordForm />, 'vi');
    expect(screen.getByRole('link', { name: viMessages.auth.forgot.mailUnavailableContactLink })).toHaveAttribute(
      'href',
      '/vi/privacy#contact',
    );
  });

  it('submits email + locale, transitions to sent card, and "Try another email" returns to form', async () => {
    renderWithLocale(<ForgotPasswordForm />, 'en');

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: '  user@example.com  ' } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
    });

    expect(mocks.authPasswordForgot).toHaveBeenCalledWith({
      email: 'user@example.com',
      captcha_token: undefined,
      locale: 'en',
    });
    expect(screen.getByTestId('forgot-sent')).toBeInTheDocument();
    expect(screen.getByText(en.auth.forgot.sentTitle)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: en.auth.forgot.tryAnotherEmail }));
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('retries once after 403 csrf_invalid via ensureCsrf()', async () => {
    mocks.authPasswordForgot
      .mockRejectedValueOnce(problem('csrf_invalid', { status: 403 }))
      .mockResolvedValueOnce(undefined);

    renderWithLocale(<ForgotPasswordForm />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
    });

    expect(mocks.ensureCsrf).toHaveBeenCalledTimes(1);
    expect(mocks.authPasswordForgot).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('forgot-sent')).toBeInTheDocument();
  });

  it.each([
    ['invalid_request', 400, en.auth.validation.email.invalid],
    ['captcha_required', 403, en.auth.errors.captchaRequired],
    ['rate_limited', 429, 'Too many attempts. Try again in 5 seconds.'],
    ['dependency_unavailable', 503, en.auth.errors.genericBody],
  ] as const)('maps %s (%i) to localized UI copy without leaking raw problem title/detail', async (code, status, expectedText) => {
    mocks.authPasswordForgot.mockRejectedValueOnce(
      problem(code, { status, retry_after: code === 'rate_limited' ? 5 : 1, captcha_required: code === 'captcha_required' }),
    );

    renderWithLocale(<ForgotPasswordForm />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
    });

    expect(screen.getByText(expectedText)).toBeInTheDocument();
    expect(screen.queryByText(/SERIOUSLY_RAW_SERVER/)).not.toBeInTheDocument();
  });

  it('switches to mail_unavailable view on 503 mail_delivery_unavailable', async () => {
    mocks.authPasswordForgot.mockRejectedValueOnce(problem('mail_delivery_unavailable', { status: 503 }));

    renderWithLocale(<ForgotPasswordForm />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
    });

    expect(screen.getByTestId('forgot-unavailable')).toBeInTheDocument();
  });
});

describe('ResetPasswordForm token lifecycle, strict mode, and problem-code mapping (ADR 0006 §6.1-6.2, §9.2)', () => {
  it('validates 43-char base64url token format strictly', () => {
    expect(extractResetTokenFromHash(`#token=${VALID_TOKEN_43}`)).toBe(VALID_TOKEN_43);
    expect(extractResetTokenFromHash('#token=too-short')).toBeNull();
    expect(extractResetTokenFromHash(`#token=${'a'.repeat(44)}`)).toBeNull();
    expect(extractResetTokenFromHash('#token=invalid+chars/==============================')).toBeNull();
    expect(extractResetTokenFromHash('')).toBeNull();
  });

  it('extracts #token on mount, strips hash via history.replaceState, and survives double-effect execution', async () => {
    window.history.replaceState(null, '', `/app/auth/reset-password#token=${VALID_TOKEN_43}`);
    const replaceSpy = vi.spyOn(window.history, 'replaceState');

    renderWithLocale(<ResetPasswordForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(en.auth.fields.newLoginPassword)).toBeInTheDocument();
    });
    expect(window.location.hash).toBe('');
    expect(replaceSpy).toHaveBeenCalledWith(null, '', '/app/auth/reset-password');
    expect(screen.getByText(en.auth.reset.vaultNotice)).toBeInTheDocument();
  });

  it('shows missing-token invalid card when opened without #token', () => {
    window.history.replaceState(null, '', '/app/auth/reset-password');
    renderWithLocale(<ResetPasswordForm />);

    expect(screen.getByTestId('reset-invalid-token')).toBeInTheDocument();
    expect(screen.getByText(en.auth.reset.missingTokenTitle)).toBeInTheDocument();
  });

  it('validates unicode codepoint length (<12), byte length (>1024), and password confirmation mismatch locally', async () => {
    window.history.replaceState(null, '', `/app/auth/reset-password#token=${VALID_TOKEN_43}`);
    renderWithLocale(<ResetPasswordForm />);

    const newPwInput = screen.getByLabelText(en.auth.fields.newLoginPassword);
    const confirmInput = screen.getByLabelText(en.auth.fields.confirmNewPassword);
    const form = newPwInput.closest('form')!;

    // 11 emoji codepoints (>12 UTF-16 code units, but only 11 unicode codepoints)
    fireEvent.change(newPwInput, { target: { value: '🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒' } });
    fireEvent.change(confirmInput, { target: { value: '🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒' } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(screen.getByText(en.auth.validation.password.short)).toBeInTheDocument();
    expect(mocks.authPasswordReset).not.toHaveBeenCalled();

    // >1024 UTF-8 bytes
    const over1024Bytes = '🔒'.repeat(260); // 260 * 4 = 1040 bytes
    fireEvent.change(newPwInput, { target: { value: over1024Bytes } });
    fireEvent.change(confirmInput, { target: { value: over1024Bytes } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(screen.getByText(en.auth.validation.password.tooLong)).toBeInTheDocument();

    // Mismatch
    fireEvent.change(newPwInput, { target: { value: 'ValidNewPassword!2026' } });
    fireEvent.change(confirmInput, { target: { value: 'DifferentNewPassword!2026' } });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(screen.getByText(en.auth.validation.password.mismatch)).toBeInTheDocument();
  });

  it('on 204: clears token, broadcasts signed_out, calls bootstrapCsrf (tolerating failure), and hard-navigates to /app/auth/login?reset=done (AU2-FE3-4)', async () => {
    window.history.replaceState(null, '', `/app/auth/reset-password#token=${VALID_TOKEN_43}`);
    mocks.bootstrapCsrf.mockRejectedValueOnce(new Error('network blip during csrf bootstrap'));

    renderWithLocale(<ResetPasswordForm />);

    fireEvent.change(screen.getByLabelText(en.auth.fields.newLoginPassword), {
      target: { value: 'StrongReplacementPassword!2026' },
    });
    fireEvent.change(screen.getByLabelText(en.auth.fields.confirmNewPassword), {
      target: { value: 'StrongReplacementPassword!2026' },
    });

    await act(async () => {
      fireEvent.submit(screen.getByLabelText(en.auth.fields.newLoginPassword).closest('form')!);
    });

    expect(mocks.authPasswordReset).toHaveBeenCalledWith({
      token: VALID_TOKEN_43,
      new_password: 'StrongReplacementPassword!2026',
    });
    expect(mocks.postSessionBroadcast).toHaveBeenCalledWith({ type: 'signed_out', reason: 'logout' });
    expect(mocks.bootstrapCsrf).toHaveBeenCalledTimes(1);
    expect(resetPasswordModule).toBeDefined();
  });

  it('maps 400 reset_token_invalid to the invalid/expired token card and clears in-memory token', async () => {
    window.history.replaceState(null, '', `/app/auth/reset-password#token=${VALID_TOKEN_43}`);
    mocks.authPasswordReset.mockRejectedValueOnce(problem('reset_token_invalid', { status: 400 }));

    renderWithLocale(<ResetPasswordForm />);
    fireEvent.change(screen.getByLabelText(en.auth.fields.newLoginPassword), {
      target: { value: 'StrongReplacementPassword!2026' },
    });
    fireEvent.change(screen.getByLabelText(en.auth.fields.confirmNewPassword), {
      target: { value: 'StrongReplacementPassword!2026' },
    });

    await act(async () => {
      fireEvent.submit(screen.getByLabelText(en.auth.fields.newLoginPassword).closest('form')!);
    });

    expect(screen.getByTestId('reset-invalid-token')).toBeInTheDocument();
    expect(screen.getByText(en.auth.reset.invalidTokenTitle)).toBeInTheDocument();
    expect(screen.queryByText(/SERIOUSLY_RAW_SERVER/)).not.toBeInTheDocument();
  });

  it.each([
    ['password_weak', 400, en.auth.validation.password.weak],
    ['rate_limited', 429, 'Too many attempts. Try again in 4 seconds.'],
    ['dependency_unavailable', 503, en.auth.errors.genericBody],
  ] as const)('maps %s (%i) on reset without keeping raw server strings', async (code, status, expectedText) => {
    window.history.replaceState(null, '', `/app/auth/reset-password#token=${VALID_TOKEN_43}`);
    mocks.authPasswordReset.mockRejectedValueOnce(
      problem(code, { status, retry_after: code === 'rate_limited' ? 4 : 1 }),
    );

    renderWithLocale(<ResetPasswordForm />);
    fireEvent.change(screen.getByLabelText(en.auth.fields.newLoginPassword), {
      target: { value: 'StrongReplacementPassword!2026' },
    });
    fireEvent.change(screen.getByLabelText(en.auth.fields.confirmNewPassword), {
      target: { value: 'StrongReplacementPassword!2026' },
    });

    await act(async () => {
      fireEvent.submit(screen.getByLabelText(en.auth.fields.newLoginPassword).closest('form')!);
    });

    expect(screen.getByText(expectedText)).toBeInTheDocument();
    expect(screen.queryByText(/SERIOUSLY_RAW_SERVER/)).not.toBeInTheDocument();
  });

  it('renders plain <a> tags (no client-router Link) for every exit on /app/auth/reset-password including AuthChrome logo (AU2-FE3-1)', () => {
    mocks.pathname = '/app/auth/reset-password';
    window.history.replaceState(null, '', `/app/auth/reset-password#token=${VALID_TOKEN_43}`);

    renderWithLocale(
      <AuthChrome>
        <ResetPasswordForm />
      </AuthChrome>,
    );

    const logoLink = screen.getByRole('link', { name: 'engram' });
    expect(logoLink).toHaveAttribute('href', '/');
    const backLink = screen.getByRole('link', { name: en.auth.reset.backToLogin });
    expect(backLink).toHaveAttribute('href', '/app/auth/login');
  });
});

describe('OAuthCallbackView problem-code mapping (AU2-FE3-6)', () => {
  it('maps 400 oauth_state_invalid on /auth/oauth/complete to localized oauthCallback.invalidFlow without rendering raw problem.detail', async () => {
    mocks.searchParams = 'status=login_ready';
    mocks.completeOAuthLogin.mockRejectedValueOnce(problem('oauth_state_invalid', { status: 400 }));

    renderWithLocale(<OAuthCallbackView provider="google" />, 'en');

    await waitFor(() => {
      expect(screen.getByText(en.auth.oauthCallback.invalidFlow)).toBeInTheDocument();
    });
    expect(screen.queryByText(/SERIOUSLY_RAW_SERVER/)).not.toBeInTheDocument();
  });
});

describe('Zero language mixing across all auth screens (en has zero Vietnamese diacritics; vi has zero stray English UI chrome)', () => {
  const VIETNAMESE_DIACRITIC_RE =
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/;

  const STRAY_ENGLISH_IN_VI_RE =
    /\b(Sign in|Create account|Forgot password|Send reset link|Save new password|Show|Hide|Toggle light\/dark theme)\b/;

  it('renders every auth screen in English with zero Vietnamese diacritics and localized theme/password-toggle labels', () => {
    const screens: Array<{ name: string; path: string; hash?: string; search?: string; node: React.ReactNode }> = [
      { name: 'login', path: '/app/auth/login', search: 'reset=done', node: <LoginForm /> },
      { name: 'signup', path: '/app/auth/signup', node: <SignupForm /> },
      { name: 'forgot', path: '/app/auth/forgot-password', node: <ForgotPasswordForm /> },
      {
        name: 'reset',
        path: '/app/auth/reset-password',
        hash: `#token=${VALID_TOKEN_43}`,
        node: <ResetPasswordForm />,
      },
      { name: 'verify-email', path: '/app/auth/verify-email', node: <VerifyEmailForm /> },
      { name: 'password-enroll', path: '/app/auth/password-enroll', node: <PasswordEnrollForm /> },
      { name: 'reauth', path: '/app/auth/reauth', node: <ReauthForm /> },
      {
        name: 'oauth-callback',
        path: '/app/auth/callback/google',
        search: 'status=invalid_flow',
        node: <OAuthCallbackView provider="google" />,
      },
    ];

    mocks.session.status = 'authenticated_without_vault';
    mocks.session.me = {
      user: { id: 'u1', email: 'person@example.com', email_verified: false, created_at: '2026-01-01T00:00:00Z' },
      settings: { locale: 'en', theme: 'light', auto_lock_minutes: 15, semantic_suggest: false },
      identities: [{ provider: 'password', linked_at: '2026-01-01T00:00:00Z' }],
      features: {
        semantic_available: false,
        email_verification_required: true,
        oauth_providers: ['google'],
        oauth_reauth_providers: ['google'],
        password_enrollment_available: true,
        captcha_site_key: null,
      },
      vault: { status: 'absent' },
    };

    for (const item of screens) {
      mocks.pathname = item.path;
      mocks.searchParams = item.search ?? '';
      window.history.replaceState(null, '', `${item.path}${item.search ? `?${item.search}` : ''}${item.hash ?? ''}`);

      const { container, unmount } = renderWithLocale(<AuthChrome>{item.node}</AuthChrome>, 'en');
      const text = container.textContent ?? '';
      expect(text, `Screen ${item.name} in en contained Vietnamese diacritics`).not.toMatch(VIETNAMESE_DIACRITIC_RE);

      for (const el of Array.from(container.querySelectorAll('[aria-label], [title]'))) {
        const aria = el.getAttribute('aria-label') ?? '';
        const title = el.getAttribute('title') ?? '';
        expect(aria, `Screen ${item.name} aria-label in en`).not.toMatch(VIETNAMESE_DIACRITIC_RE);
        expect(title, `Screen ${item.name} title in en`).not.toMatch(VIETNAMESE_DIACRITIC_RE);
      }
      unmount();
    }
  });

  it('renders every auth screen in Vietnamese with zero stray English UI chrome', () => {
    const screens: Array<{ name: string; path: string; hash?: string; search?: string; node: React.ReactNode }> = [
      { name: 'login', path: '/app/auth/login', search: 'reset=done', node: <LoginForm /> },
      { name: 'signup', path: '/app/auth/signup', node: <SignupForm /> },
      { name: 'forgot', path: '/app/auth/forgot-password', node: <ForgotPasswordForm /> },
      {
        name: 'reset',
        path: '/app/auth/reset-password',
        hash: `#token=${VALID_TOKEN_43}`,
        node: <ResetPasswordForm />,
      },
      { name: 'verify-email', path: '/app/auth/verify-email', node: <VerifyEmailForm /> },
      { name: 'password-enroll', path: '/app/auth/password-enroll', node: <PasswordEnrollForm /> },
      { name: 'reauth', path: '/app/auth/reauth', node: <ReauthForm /> },
      {
        name: 'oauth-callback',
        path: '/app/auth/callback/google',
        search: 'status=invalid_flow',
        node: <OAuthCallbackView provider="google" />,
      },
    ];

    mocks.session.status = 'authenticated_without_vault';
    mocks.session.me = {
      user: { id: 'u1', email: 'person@example.com', email_verified: false, created_at: '2026-01-01T00:00:00Z' },
      settings: { locale: 'vi', theme: 'light', auto_lock_minutes: 15, semantic_suggest: false },
      identities: [{ provider: 'password', linked_at: '2026-01-01T00:00:00Z' }],
      features: {
        semantic_available: false,
        email_verification_required: true,
        oauth_providers: ['google'],
        oauth_reauth_providers: ['google'],
        password_enrollment_available: true,
        captcha_site_key: null,
      },
      vault: { status: 'absent' },
    };

    for (const item of screens) {
      mocks.pathname = item.path;
      mocks.searchParams = item.search ?? '';
      window.history.replaceState(null, '', `${item.path}${item.search ? `?${item.search}` : ''}${item.hash ?? ''}`);

      const { container, unmount } = renderWithLocale(<AuthChrome>{item.node}</AuthChrome>, 'vi');
      const text = container.textContent ?? '';
      expect(text, `Screen ${item.name} in vi contained stray English UI strings`).not.toMatch(STRAY_ENGLISH_IN_VI_RE);

      for (const el of Array.from(container.querySelectorAll('[aria-label], [title]'))) {
        const aria = el.getAttribute('aria-label') ?? '';
        const title = el.getAttribute('title') ?? '';
        expect(aria, `Screen ${item.name} aria-label in vi`).not.toMatch(STRAY_ENGLISH_IN_VI_RE);
        expect(title, `Screen ${item.name} title in vi`).not.toMatch(STRAY_ENGLISH_IN_VI_RE);
      }
      unmount();
    }
  });
});
