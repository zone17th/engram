import { act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from '@/features/auth/forms/login-form';
import { SignupForm } from '@/features/auth/forms/signup-form';
import en from '../messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({
    login: vi.fn(),
    signup: vi.fn(),
    config: { oauth_providers: [], email_verification_required: false, captcha_site_key: null },
    lastSessionEndReason: null,
    webLocksAvailable: true,
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
