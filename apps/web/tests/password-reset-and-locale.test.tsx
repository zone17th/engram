import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { StrictMode, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemError, type ProblemDetails } from '@engram/shared-types';
import { AuthChrome } from '@/features/auth/auth-chrome';
import { ForgotPasswordForm } from '@/features/auth/forms/forgot-password-form';
import { LoginForm } from '@/features/auth/forms/login-form';
import { OAuthCallbackView } from '@/features/auth/forms/oauth-callback';
import { PasswordEnrollForm } from '@/features/auth/forms/password-enroll-form';
import { ReauthForm } from '@/features/auth/forms/reauth-form';
import { ResetPasswordForm, extractResetTokenFromHash } from '@/features/auth/forms/reset-password-form';
import { SignupForm } from '@/features/auth/forms/signup-form';
import { VerifyEmailForm } from '@/features/auth/forms/verify-email-form';
import { evaluateAccountPasswordStrength } from '@/features/auth/password-strength-meter';
import { RouteGuard } from '@/features/auth/route-guard';
import { AccountDialogs } from '@/features/settings/account/account-dialogs';
import en from '../messages/en.json';
import viMessages from '../messages/vi.json';

type TurnstileOptions = { callback: (token: string) => void };

const turnstileMocks = vi.hoisted(() => ({
  render: vi.fn(),
  reset: vi.fn(),
  remove: vi.fn(),
}));

let tokenCallback: ((token: string) => void) | undefined;

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
  const oauthLinkStart = vi.fn();
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
    oauthLinkStart,
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
        pendingAction: 'account.password_change' as const,
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
    oauthLinkStart: mocks.oauthLinkStart,
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
  tokenCallback = undefined;
  turnstileMocks.render.mockImplementation((_element: HTMLElement, options: TurnstileOptions) => {
    tokenCallback = options.callback;
    return 'widget-1';
  });
  Object.defineProperty(window, 'turnstile', {
    configurable: true,
    value: turnstileMocks,
  });
  document.querySelectorAll('script[data-engram-turnstile]').forEach((script) => script.remove());
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
  mocks.oauthLinkStart.mockResolvedValue({ authorization_url: 'https://accounts.google.com/o/oauth2/auth' });
  window.history.replaceState(null, '', '/app/auth/forgot-password');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'turnstile');
});

describe('PasswordStrengthMeter estimator (local-only)', () => {
  it('scores password strength across 0..4 without any network call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(evaluateAccountPasswordStrength('')).toBe(0);
    expect(evaluateAccountPasswordStrength('short1!')).toBe(1);
    expect(evaluateAccountPasswordStrength('alllowercase')).toBe(2);
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

  it('does not mount Turnstile widget or script when mail_delivery_available === false (AU4-FE1-8)', () => {
    mocks.session.config = {
      oauth_providers: ['google'],
      email_verification_required: false,
      captcha_site_key: 'site-key-123',
      mail_delivery_available: false,
    };

    renderWithLocale(<ForgotPasswordForm />);
    expect(screen.getByTestId('forgot-unavailable')).toBeInTheDocument();
    expect(document.querySelector('script[data-engram-turnstile]')).toBeNull();
    expect(turnstileMocks.render).not.toHaveBeenCalled();
  });

  it('renders Turnstile when captcha_site_key is configured and resets it after 403/429/503/network and tryAnotherEmail (AU4-FE1-8)', async () => {
    mocks.session.config = {
      oauth_providers: ['google'],
      email_verification_required: false,
      captcha_site_key: 'site-key-123',
      mail_delivery_available: true,
    };

    renderWithLocale(<ForgotPasswordForm />);
    expect(turnstileMocks.render).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'user@example.com' } });
    const form = screen.getByLabelText('Email').closest('form')!;

    // 1. 403 captcha_required
    act(() => {
      tokenCallback?.('tok-1');
    });
    mocks.authPasswordForgot.mockRejectedValueOnce(problem('captcha_required', { status: 403, captcha_required: true }));
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(turnstileMocks.reset).toHaveBeenCalledTimes(1);

    // 2. 429 rate_limited
    act(() => {
      tokenCallback?.('tok-2');
    });
    mocks.authPasswordForgot.mockRejectedValueOnce(problem('rate_limited', { status: 429, retry_after: 0 }));
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(turnstileMocks.reset).toHaveBeenCalledTimes(2);

    // 3. 503 dependency_unavailable
    act(() => {
      tokenCallback?.('tok-3');
    });
    mocks.authPasswordForgot.mockRejectedValueOnce(problem('dependency_unavailable', { status: 503, retry_after: 0 }));
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(turnstileMocks.reset).toHaveBeenCalledTimes(3);

    // 4. Network error
    act(() => {
      tokenCallback?.('tok-4');
    });
    mocks.authPasswordForgot.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(turnstileMocks.reset).toHaveBeenCalledTimes(4);

    // 5. 202 sent -> Try another email resets widget
    act(() => {
      tokenCallback?.('tok-5');
    });
    mocks.authPasswordForgot.mockResolvedValueOnce(undefined);
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(screen.getByTestId('forgot-sent')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.auth.forgot.tryAnotherEmail }));
    expect(turnstileMocks.reset).toHaveBeenCalledTimes(5);
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

  it('extracts #token on mount, strips hash via history.replaceState, and survives <StrictMode> double-effect execution (AU4-FE1-7)', async () => {
    window.history.replaceState(null, '', `/app/auth/reset-password#token=${VALID_TOKEN_43}`);
    const replaceSpy = vi.spyOn(window.history, 'replaceState');

    renderWithLocale(
      <StrictMode>
        <ResetPasswordForm />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText(en.auth.fields.newLoginPassword)).toBeInTheDocument();
    });
    expect(window.location.hash).toBe('');
    expect(replaceSpy).toHaveBeenCalledWith(null, '', '/app/auth/reset-password');
    expect(screen.getByText(en.auth.reset.vaultNotice)).toBeInTheDocument();
    expect(screen.queryByTestId('reset-invalid-token')).not.toBeInTheDocument();
  });

  it('replaces in-memory token and scrubs URL on hashchange, and shows invalid card for malformed/non-token hashes (AU4-FE1-7)', async () => {
    window.history.replaceState(null, '', '/app/auth/reset-password#not-a-valid-token');
    renderWithLocale(<ResetPasswordForm />);

    expect(screen.getByTestId('reset-invalid-token')).toBeInTheDocument();
    expect(window.location.hash).toBe('');

    const replacementToken = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg';
    act(() => {
      window.history.replaceState(null, '', `/app/auth/reset-password#token=${replacementToken}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    await waitFor(() => {
      expect(screen.getByLabelText(en.auth.fields.newLoginPassword)).toBeInTheDocument();
    });
    expect(window.location.hash).toBe('');

    fireEvent.change(screen.getByLabelText(en.auth.fields.newLoginPassword), {
      target: { value: 'ValidReplacementPass!2026' },
    });
    fireEvent.change(screen.getByLabelText(en.auth.fields.confirmNewPassword), {
      target: { value: 'ValidReplacementPass!2026' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText(en.auth.fields.newLoginPassword).closest('form')!);
    });
    expect(mocks.authPasswordReset).toHaveBeenCalledWith({
      token: replacementToken,
      new_password: 'ValidReplacementPass!2026',
    });
  });

  it('shows missing-token invalid card when opened without #token, and RouteGuard keeps reset route mounted when status is unavailable (AU2-FE3-2)', () => {
    mocks.pathname = '/app/auth/reset-password';
    mocks.session.status = 'unavailable';
    window.history.replaceState(null, '', '/app/auth/reset-password');
    renderWithLocale(
      <RouteGuard>
        <ResetPasswordForm />
      </RouteGuard>,
    );

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

  it('on 204: clears token without flashing invalid card, broadcasts signed_out before navigating, tolerates failed/slow bootstrapCsrf, and calls location.assign("/app/auth/login?reset=done") (AU4-FE1-5, AU4-FE1-10)', async () => {
    window.history.replaceState(null, '', `/app/auth/reset-password#token=${VALID_TOKEN_43}`);
    const callOrder: string[] = [];
    const assignMock = vi.fn((url: string) => {
      callOrder.push(`assign:${url}`);
    });
    vi.stubGlobal('location', {
      ...window.location,
      hash: `#token=${VALID_TOKEN_43}`,
      pathname: '/app/auth/reset-password',
      search: '',
      assign: assignMock,
    });
    mocks.postSessionBroadcast.mockImplementation(() => {
      callOrder.push('broadcast');
    });
    const csrfDeferred = Promise.withResolvers<void>();
    mocks.bootstrapCsrf.mockImplementation(() => {
      callOrder.push('bootstrapCsrf');
      return csrfDeferred.promise;
    });

    renderWithLocale(<ResetPasswordForm />);

    fireEvent.change(screen.getByLabelText(en.auth.fields.newLoginPassword), {
      target: { value: 'StrongReplacementPassword!2026' },
    });
    fireEvent.change(screen.getByLabelText(en.auth.fields.confirmNewPassword), {
      target: { value: 'StrongReplacementPassword!2026' },
    });

    let submitDone = false;
    const submitPromise = act(async () => {
      fireEvent.submit(screen.getByLabelText(en.auth.fields.newLoginPassword).closest('form')!);
    }).then(() => {
      submitDone = true;
    });

    // While bootstrapCsrf is pending after 204, the missing/invalid link card must NOT flash (AU4-FE1-10).
    await waitFor(() => {
      expect(mocks.postSessionBroadcast).toHaveBeenCalledWith({ type: 'signed_out', reason: 'logout' });
    });
    expect(screen.queryByTestId('reset-invalid-token')).not.toBeInTheDocument();
    expect(screen.getByTestId('reset-completed-redirecting')).toBeInTheDocument();

    await act(async () => {
      csrfDeferred.reject(new Error('network blip during csrf bootstrap'));
      await submitPromise;
    });
    expect(submitDone).toBe(true);
    expect(mocks.authPasswordReset).toHaveBeenCalledWith({
      token: VALID_TOKEN_43,
      new_password: 'StrongReplacementPassword!2026',
    });
    expect(assignMock).toHaveBeenCalledTimes(1);
    expect(assignMock).toHaveBeenCalledWith('/app/auth/login?reset=done');
    expect(callOrder).toEqual(['broadcast', 'bootstrapCsrf', 'assign:/app/auth/login?reset=done']);
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

  it('renders plain <a> tags (zero next/link) and hard-navigates via location.assign for every exit on /app/auth/reset-password in both states (AU2-FE3-1, AU4-FE1-6)', () => {
    mocks.pathname = '/app/auth/reset-password';
    const assignMock = vi.fn();

    // State 1: token present
    vi.stubGlobal('location', {
      ...window.location,
      hash: `#token=${VALID_TOKEN_43}`,
      pathname: '/app/auth/reset-password',
      search: '',
      assign: assignMock,
    });
    const { container, unmount } = renderWithLocale(
      <AuthChrome>
        <ResetPasswordForm />
      </AuthChrome>,
    );
    expect(container.querySelector('[data-next-link]')).toBeNull();
    const logoLink = screen.getByRole('link', { name: 'engram' });
    expect(logoLink).toHaveAttribute('href', '/');
    const formBackLink = screen.getByRole('link', { name: en.auth.reset.backToLogin });
    fireEvent.click(formBackLink);
    expect(assignMock).toHaveBeenCalledWith('/app/auth/login');
    unmount();

    // State 2: token missing (invalid card)
    assignMock.mockClear();
    vi.stubGlobal('location', {
      ...window.location,
      hash: '',
      pathname: '/app/auth/reset-password',
      search: '',
      assign: assignMock,
    });
    const { container: invalidContainer } = renderWithLocale(
      <AuthChrome>
        <ResetPasswordForm />
      </AuthChrome>,
    );
    expect(invalidContainer.querySelector('[data-next-link]')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: en.auth.reset.requestNewLink }));
    expect(assignMock).toHaveBeenCalledWith('/app/auth/forgot-password');
    fireEvent.click(screen.getByRole('link', { name: en.auth.reset.backToLogin }));
    expect(assignMock).toHaveBeenCalledWith('/app/auth/login');
  });
});

describe('OAuthCallbackView problem-code mapping (AU2-FE3-6) and AccountDialogs linkRequiresVerifiedEmail (AU4-FE1-12)', () => {
  it('maps 400 oauth_state_invalid and 409 email_taken on /auth/oauth/complete to localized copy without rendering raw problem.detail', async () => {
    mocks.searchParams = 'status=login_ready';
    mocks.completeOAuthLogin.mockRejectedValueOnce(problem('oauth_state_invalid', { status: 400 }));

    const { unmount } = renderWithLocale(<OAuthCallbackView provider="google" />, 'en');
    await waitFor(() => {
      expect(screen.getByText(en.auth.oauthCallback.invalidFlow)).toBeInTheDocument();
    });
    expect(screen.queryByText(/SERIOUSLY_RAW_SERVER/)).not.toBeInTheDocument();
    unmount();

    mocks.completeOAuthLogin.mockRejectedValueOnce(problem('email_taken', { status: 409 }));
    renderWithLocale(<OAuthCallbackView provider="google" />, 'en');
    await waitFor(() => {
      expect(screen.getByText(en.auth.errors.emailTaken)).toBeInTheDocument();
    });
    expect(screen.queryByText(/SERIOUSLY_RAW_SERVER/)).not.toBeInTheDocument();
  });

  it('maps 403 email_not_verified from oauthLinkStart in AccountDialogs to settings.account.linkRequiresVerifiedEmail (AU4-FE1-12, advisor-dec-161)', async () => {
    mocks.session.me = {
      user: { id: 'u1', email: 'person@example.com', email_verified: false, created_at: '2026-01-01T00:00:00Z' },
      settings: { locale: 'en', theme: 'light', auto_lock_minutes: 15, semantic_suggest: false },
      identities: [{ provider: 'password', linked_at: '2026-01-01T00:00:00Z' }],
      features: {
        semantic_available: false,
        email_verification_required: true,
        oauth_providers: ['google'],
        oauth_reauth_providers: ['google'],
        password_enrollment_available: false,
        captcha_site_key: null,
      },
      vault: { status: 'absent' },
    };
    mocks.session.reauth.hasUsableGrant.mockReturnValue(true);
    mocks.session.reauth.grant = {
      grant: 'reauth-grant-tok',
      action: 'account.identity_link',
      expires_at: '2099-01-01T00:00:00Z',
    } as never;
    mocks.oauthLinkStart.mockRejectedValueOnce(problem('email_not_verified', { status: 403 }));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <QueryClientProvider client={queryClient}>
          <AccountDialogs
            active="linkProviderDlg"
            context={{ provider: 'google' }}
            close={vi.fn()}
            open={vi.fn()}
          />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.settings.common.continue }));
    });

    await waitFor(() => {
      expect(screen.getByText(en.settings.account.linkRequiresVerifiedEmail)).toBeInTheDocument();
    });
    expect(screen.queryByText(/SERIOUSLY_RAW_SERVER/)).not.toBeInTheDocument();
  });
});

describe('Zero language mixing across all auth screens and states (AU4-FE1-9)', () => {
  const VIETNAMESE_DIACRITIC_RE =
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/;

  function collectDifferingEnLeaves(
    enObj: Record<string, unknown>,
    viObj: Record<string, unknown>,
  ): string[] {
    const result: string[] = [];
    const walk = (eNode: unknown, vNode: unknown) => {
      if (typeof eNode === 'string' && typeof vNode === 'string') {
        const cleanEn = eNode.replace(/\{[^}]+\}/g, '').trim();
        if (cleanEn.length >= 4 && eNode !== vNode) {
          result.push(cleanEn);
        }
        return;
      }
      if (eNode && typeof eNode === 'object' && vNode && typeof vNode === 'object') {
        for (const key of Object.keys(eNode as Record<string, unknown>)) {
          walk((eNode as Record<string, unknown>)[key], (vNode as Record<string, unknown>)[key]);
        }
      }
    };
    walk(enObj, viObj);
    return result;
  }

  const EN_ONLY_AUTH_STRINGS = collectDifferingEnLeaves(
    en.auth as unknown as Record<string, unknown>,
    viMessages.auth as unknown as Record<string, unknown>,
  );

  function assertLocalePurity(container: HTMLElement, locale: 'en' | 'vi', contextLabel: string) {
    const text = container.textContent ?? '';
    const attrs = Array.from(container.querySelectorAll('[aria-label], [title]')).flatMap((el) => [
      el.getAttribute('aria-label') ?? '',
      el.getAttribute('title') ?? '',
    ]);

    if (locale === 'en') {
      expect(text, `${contextLabel} (en) contained Vietnamese diacritics`).not.toMatch(VIETNAMESE_DIACRITIC_RE);
      for (const attr of attrs) {
        expect(attr, `${contextLabel} (en) attr contained Vietnamese diacritics`).not.toMatch(VIETNAMESE_DIACRITIC_RE);
      }
    } else {
      for (const enPhrase of EN_ONLY_AUTH_STRINGS) {
        expect(text, `${contextLabel} (vi) leaked English string "${enPhrase}"`).not.toContain(enPhrase);
        for (const attr of attrs) {
          expect(attr, `${contextLabel} (vi) attr leaked English string "${enPhrase}"`).not.toContain(enPhrase);
        }
      }
    }
  }

  it.each(['en', 'vi'] as const)(
    'renders every auth screen and interactive/error state in %s with strict catalog purity',
    async (locale) => {
      expect(EN_ONLY_AUTH_STRINGS.length).toBeGreaterThan(80);

      const resetConfig = () => {
        mocks.session.status = 'authenticated_without_vault';
        mocks.session.config = {
          oauth_providers: ['google', 'github'],
          email_verification_required: true,
          captcha_site_key: null,
          mail_delivery_available: true,
        };
        mocks.session.configLoading = false;
        mocks.session.configError = false;
        mocks.session.bootstrapComplete = true;
        mocks.session.me = {
          user: { id: 'u1', email: 'person@example.com', email_verified: false, created_at: '2026-01-01T00:00:00Z' },
          settings: { locale, theme: 'light', auto_lock_minutes: 15, semantic_suggest: false },
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
      };

      // 1. Login: default + ?reset=done banner + 401 invalid_credentials error alert
      resetConfig();
      mocks.pathname = '/app/auth/login';
      mocks.searchParams = 'reset=done';
      window.history.replaceState(null, '', '/app/auth/login?reset=done');
      mocks.login.mockRejectedValueOnce(problem('invalid_credentials', { status: 401 }));
      {
        const { container, unmount } = renderWithLocale(<AuthChrome><LoginForm /></AuthChrome>, locale);
        assertLocalePurity(container, locale, 'login-banner');
        const emailInput = container.querySelector('input[type="email"]')!;
        const pwInput = container.querySelector('input[type="password"]')!;
        fireEvent.change(emailInput, { target: { value: 'person@example.com' } });
        fireEvent.change(pwInput, { target: { value: 'ValidLoginPassword!2026' } });
        await act(async () => {
          fireEvent.submit(container.querySelector('form')!);
        });
        assertLocalePurity(container, locale, 'login-invalid-credentials');
        unmount();
      }

      // 2. Signup: default + password mismatch + terms-blocked validation errors
      resetConfig();
      mocks.pathname = '/app/auth/signup';
      mocks.searchParams = '';
      window.history.replaceState(null, '', '/app/auth/signup');
      {
        const { container, unmount } = renderWithLocale(<AuthChrome><SignupForm /></AuthChrome>, locale);
        assertLocalePurity(container, locale, 'signup-default');
        const pwInputs = container.querySelectorAll('input[type="password"]');
        fireEvent.change(container.querySelector('input[type="email"]')!, { target: { value: 'person@example.com' } });
        fireEvent.change(pwInputs[0]!, { target: { value: 'ValidSignupPassword!2026' } });
        fireEvent.change(pwInputs[1]!, { target: { value: 'DifferentPassword!2026' } });
        await act(async () => {
          fireEvent.submit(container.querySelector('form')!);
        });
        assertLocalePurity(container, locale, 'signup-mismatch-and-terms-error');
        unmount();
      }

      // 3. Forgot: skeleton, config-error, mail-unavailable, form -> 429/503/network -> 202 sent
      resetConfig();
      mocks.pathname = '/app/auth/forgot-password';
      mocks.session.config = null;
      mocks.session.configLoading = true;
      {
        const { container, unmount } = renderWithLocale(<AuthChrome><ForgotPasswordForm /></AuthChrome>, locale);
        assertLocalePurity(container, locale, 'forgot-skeleton');
        unmount();
      }

      resetConfig();
      mocks.session.config = null;
      mocks.session.configError = true;
      {
        const { container, unmount } = renderWithLocale(<AuthChrome><ForgotPasswordForm /></AuthChrome>, locale);
        assertLocalePurity(container, locale, 'forgot-config-error');
        unmount();
      }

      resetConfig();
      mocks.session.config!.mail_delivery_available = false;
      {
        const { container, unmount } = renderWithLocale(<AuthChrome><ForgotPasswordForm /></AuthChrome>, locale);
        assertLocalePurity(container, locale, 'forgot-unavailable');
        unmount();
      }

      resetConfig();
      {
        const { container, unmount } = renderWithLocale(<AuthChrome><ForgotPasswordForm /></AuthChrome>, locale);
        assertLocalePurity(container, locale, 'forgot-form');
        const emailInput = container.querySelector('input[type="email"]')!;
        const form = container.querySelector('form')!;
        fireEvent.change(emailInput, { target: { value: 'person@example.com' } });

        mocks.authPasswordForgot.mockRejectedValueOnce(problem('rate_limited', { status: 429, retry_after: 0 }));
        await act(async () => {
          fireEvent.submit(form);
        });
        assertLocalePurity(container, locale, 'forgot-429');

        mocks.authPasswordForgot.mockRejectedValueOnce(problem('dependency_unavailable', { status: 503, retry_after: 0 }));
        await act(async () => {
          fireEvent.submit(form);
        });
        assertLocalePurity(container, locale, 'forgot-503');

        mocks.authPasswordForgot.mockRejectedValueOnce(new Error('network error'));
        await act(async () => {
          fireEvent.submit(form);
        });
        assertLocalePurity(container, locale, 'forgot-network');

        mocks.authPasswordForgot.mockResolvedValueOnce(undefined);
        await act(async () => {
          fireEvent.submit(form);
        });
        assertLocalePurity(container, locale, 'forgot-sent');
        unmount();
      }

      // 4. Reset: missing token card, form -> 429/503/network -> 400 invalid token card
      resetConfig();
      mocks.pathname = '/app/auth/reset-password';
      window.history.replaceState(null, '', '/app/auth/reset-password');
      {
        const { container, unmount } = renderWithLocale(<AuthChrome><ResetPasswordForm /></AuthChrome>, locale);
        assertLocalePurity(container, locale, 'reset-missing-token');
        unmount();
      }

      window.history.replaceState(null, '', `/app/auth/reset-password#token=${VALID_TOKEN_43}`);
      {
        const { container, unmount } = renderWithLocale(<AuthChrome><ResetPasswordForm /></AuthChrome>, locale);
        assertLocalePurity(container, locale, 'reset-form');
        const pwInputs = container.querySelectorAll('input[type="password"]');
        const form = container.querySelector('form')!;
        fireEvent.change(pwInputs[0]!, { target: { value: 'ValidResetPassword!2026' } });
        fireEvent.change(pwInputs[1]!, { target: { value: 'ValidResetPassword!2026' } });

        mocks.authPasswordReset.mockRejectedValueOnce(problem('rate_limited', { status: 429, retry_after: 0 }));
        await act(async () => {
          fireEvent.submit(form);
        });
        assertLocalePurity(container, locale, 'reset-429');

        mocks.authPasswordReset.mockRejectedValueOnce(problem('dependency_unavailable', { status: 503, retry_after: 0 }));
        await act(async () => {
          fireEvent.submit(form);
        });
        assertLocalePurity(container, locale, 'reset-503');

        mocks.authPasswordReset.mockRejectedValueOnce(new Error('network error'));
        await act(async () => {
          fireEvent.submit(form);
        });
        assertLocalePurity(container, locale, 'reset-network');

        mocks.authPasswordReset.mockRejectedValueOnce(problem('reset_token_invalid', { status: 400 }));
        await act(async () => {
          fireEvent.submit(form);
        });
        assertLocalePurity(container, locale, 'reset-invalid-token');
        unmount();
      }

      // 5. VerifyEmail, PasswordEnroll, Reauth, OAuthCallback states
      const extraScreens: Array<{ name: string; path: string; search?: string; node: React.ReactNode }> = [
        { name: 'verify-email', path: '/app/auth/verify-email', node: <VerifyEmailForm /> },
        { name: 'password-enroll', path: '/app/auth/password-enroll', node: <PasswordEnrollForm /> },
        { name: 'reauth', path: '/app/auth/reauth', node: <ReauthForm /> },
        {
          name: 'oauth-callback-invalid',
          path: '/app/auth/callback/google',
          search: 'status=invalid_flow',
          node: <OAuthCallbackView provider="google" />,
        },
        {
          name: 'oauth-callback-conflict',
          path: '/app/auth/callback/google',
          search: 'status=identity_conflict',
          node: <OAuthCallbackView provider="google" />,
        },
      ];

      for (const item of extraScreens) {
        resetConfig();
        mocks.pathname = item.path;
        mocks.searchParams = item.search ?? '';
        window.history.replaceState(null, '', `${item.path}${item.search ? `?${item.search}` : ''}`);
        const { container, unmount } = renderWithLocale(<AuthChrome>{item.node}</AuthChrome>, locale);
        assertLocalePurity(container, locale, item.name);
        unmount();
      }
    },
  );
});
