import { act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from '@/features/auth/forms/login-form';
import { SignupForm } from '@/features/auth/forms/signup-form';
import { hasWebLocks } from '@/lib/auth/session-lock';
import en from '../messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({
    login: vi.fn(),
    signup: vi.fn(),
    config: {
      oauth_providers: [],
      email_verification_required: false,
      captcha_site_key: null,
      mail_delivery_available: true,
    },
    configLoading: false,
    configError: false,
    bootstrapComplete: true,
    status: 'signed_out',
    lastSessionEndReason: null,
    webLocksAvailable: hasWebLocks(),
  }),
}));

const IS_REACT_ACT_ENVIRONMENT = 'IS_REACT_ACT_ENVIRONMENT';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function withIntl(ui: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {ui}
    </NextIntlClientProvider>
  );
}

describe.each([
  ['LoginForm', <LoginForm key="login" />],
  ['SignupForm', <SignupForm key="signup" />],
])('%s hydration gate (VW-AUTH-E2E)', (_name, form) => {
  it('ships the SSR form disabled and flags it unhydrated, then enables it once hydrated', async () => {
    (globalThis as Record<string, unknown>)[IS_REACT_ACT_ENVIRONMENT] = true;
    const html = renderToString(withIntl(form));
    container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    const ssrForm = container.querySelector('form');
    expect(ssrForm?.getAttribute('data-hydrated')).toBe('false');
    const ssrControls = Array.from(container.querySelectorAll('input, button[type="submit"]'));
    expect(ssrControls.length).toBeGreaterThan(0);
    for (const control of ssrControls) {
      expect((control as HTMLInputElement | HTMLButtonElement).disabled).toBe(true);
    }

    await act(async () => {
      root = hydrateRoot(container as HTMLElement, withIntl(form));
    });

    const hydratedForm = container.querySelector('form');
    expect(hydratedForm?.getAttribute('data-hydrated')).toBe('true');
    for (const control of Array.from(container.querySelectorAll('input, button[type="submit"]'))) {
      expect((control as HTMLInputElement | HTMLButtonElement).disabled).toBe(false);
    }
  });
});

describe('LoginForm web-locks hydration parity (FU5, dec-213)', () => {
  it('hydrates without recoverable errors when SSR has navigator.locks absent and client has navigator.locks present', async () => {
    (globalThis as Record<string, unknown>)[IS_REACT_ACT_ENVIRONMENT] = true;

    vi.stubGlobal('navigator', { ...navigator, locks: undefined });
    const html = renderToString(withIntl(<LoginForm />));
    expect(html).not.toContain(en.auth.errors.webLocksDegraded);
    expect(html).toContain(en.auth.login.passwordHint);

    vi.stubGlobal('navigator', {
      ...navigator,
      locks: { request: vi.fn(async (_name: string, fn: () => unknown) => fn()) },
    });

    container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    const onRecoverableError = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      root = hydrateRoot(container as HTMLElement, withIntl(<LoginForm />), {
        onRecoverableError,
      });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(en.auth.errors.webLocksDegraded);
    expect(container.textContent).toContain(en.auth.login.passwordHint);
  });

  it('hydrates cleanly and then renders the degraded web-locks notice post-hydration when navigator.locks remains absent on the client', async () => {
    (globalThis as Record<string, unknown>)[IS_REACT_ACT_ENVIRONMENT] = true;

    vi.stubGlobal('navigator', { ...navigator, locks: undefined });
    const html = renderToString(withIntl(<LoginForm />));
    expect(html).not.toContain(en.auth.errors.webLocksDegraded);

    container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    const onRecoverableError = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await act(async () => {
      root = hydrateRoot(container as HTMLElement, withIntl(<LoginForm />), {
        onRecoverableError,
      });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain(en.auth.errors.webLocksDegraded);
    expect(container.textContent).toContain(en.auth.login.passwordHint);
  });
});
