import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemError, type ProblemDetails } from '@engram/shared-types';
import { LoginForm } from '@/features/auth/forms/login-form';
import { SignupForm } from '@/features/auth/forms/signup-form';
import { TurnstileWidget } from '@/features/auth/turnstile-widget';
import en from '../messages/en.json';

const mocks = vi.hoisted(() => {
  const login = vi.fn();
  const signup = vi.fn();
  return {
    login,
    signup,
    replace: vi.fn(),
    session: {
      login,
      signup,
      config: null as unknown,
      lastSessionEndReason: null,
      webLocksAvailable: true,
    },
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => mocks.session,
}));

type TurnstileOptions = { callback: (token: string) => void };

const turnstileMocks = vi.hoisted(() => ({
  render: vi.fn(),
  reset: vi.fn(),
  remove: vi.fn(),
}));

let tokenCallback: ((token: string) => void) | undefined;

function problem(code: string, overrides: Partial<ProblemDetails> = {}): ProblemError {
  return new ProblemError({
    type: `https://engram.zone17.click/problems/${code}`,
    title: 'Request failed',
    status: 400,
    code,
    ...overrides,
  });
}

function renderIntl(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>,
  );
}

function formElement(): HTMLFormElement {
  const form = screen.getByLabelText('Email').closest('form');
  if (!(form instanceof HTMLFormElement)) throw new Error('Auth form was not rendered');
  return form;
}

function fillLoginFields() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.com' } });
  fireEvent.change(screen.getByLabelText('Login password'), {
    target: { value: 'a sufficiently long password' },
  });
}

async function submitForm(form: HTMLFormElement) {
  await act(async () => {
    fireEvent.submit(form);
    await Promise.resolve();
    await Promise.resolve();
  });
}

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
  mocks.session.config = {
    oauth_providers: [],
    email_verification_required: false,
    captcha_site_key: null,
  };
  mocks.session.lastSessionEndReason = null;
  mocks.session.webLocksAvailable = true;
  mocks.login.mockResolvedValue(undefined);
  mocks.signup.mockResolvedValue(undefined);
  window.history.replaceState(null, '', '/app/auth/login');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'turnstile');
});

describe('LoginForm retry and CAPTCHA behavior', () => {
  it('keeps a live retry countdown when the rate limit also requires CAPTCHA', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z'));
    mocks.session.config = { oauth_providers: [], captcha_site_key: 'site-key' };
    mocks.login.mockRejectedValueOnce(
      problem('rate_limited', { status: 429, retry_after: 3, captcha_required: true }),
    );

    renderIntl(<LoginForm />);
    fillLoginFields();
    await submitForm(formElement());

    expect(screen.getByText('Too many attempts. Try again in 3 seconds.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.getByTestId('turnstile-widget')).toHaveAttribute('data-configured', 'true');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Too many attempts. Try again in 2 seconds.')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText('Too many attempts. Try again in 0 seconds.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('resets a consumed CAPTCHA token before the next login attempt', async () => {
    mocks.session.config = { oauth_providers: [], captcha_site_key: 'site-key' };
    mocks.login
      .mockRejectedValueOnce(problem('captcha_required', { status: 403, captcha_required: true }))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(undefined);

    renderIntl(<LoginForm />);
    fillLoginFields();
    await submitForm(formElement());
    expect(tokenCallback).toBeDefined();

    act(() => {
      tokenCallback?.('single-use-token');
    });
    await submitForm(formElement());

    expect(mocks.login).toHaveBeenNthCalledWith(2, {
      email: 'person@example.com',
      password: 'a sufficiently long password',
      captcha_token: 'single-use-token',
    });
    expect(turnstileMocks.reset).toHaveBeenCalledWith('widget-1');

    await submitForm(formElement());
    expect(mocks.login).toHaveBeenNthCalledWith(3, {
      email: 'person@example.com',
      password: 'a sufficiently long password',
      captcha_token: undefined,
    });
  });
});

describe('SignupForm retry behavior', () => {
  it('disables and then re-enables signup after Retry-After expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T00:00:00.000Z'));
    mocks.signup.mockRejectedValueOnce(problem('rate_limited', { status: 429, retry_after: 2 }));

    renderIntl(<SignupForm />);
    fillLoginFields();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I agree to the terms and how data is handled.' }));
    await submitForm(formElement());

    expect(screen.getByText('Too many attempts. Try again in 2 seconds.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Too many attempts. Try again in 1 seconds.')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText(/Too many attempts/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeEnabled();
  });
});

describe('TurnstileWidget configuration', () => {
  it('fails closed when the site key is blank', () => {
    renderIntl(
      <TurnstileWidget
        siteKey="  "
        onToken={vi.fn()}
      />,
    );

    expect(screen.getByTestId('turnstile-widget')).toHaveAttribute('data-configured', 'false');
    expect(turnstileMocks.render).not.toHaveBeenCalled();
    expect(document.querySelector('script[data-engram-turnstile]')).not.toBeInTheDocument();
  });
});
