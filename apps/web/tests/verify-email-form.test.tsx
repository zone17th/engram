import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VerifyEmailForm,
  clearPendingVerificationToken,
} from '@/features/auth/forms/verify-email-form';
import en from '../messages/en.json';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  send: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  refetchMe: vi.fn(),
  signOut: vi.fn(),
}));

const sessionState = vi.hoisted(() => ({
  current: {
    status: 'authenticated_without_vault' as 'signed_out' | 'authenticated_without_vault',
    me: null as { user: { email: string; email_verified: boolean } } | null,
    refetchMe: mocks.refetchMe,
    signOut: mocks.signOut,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace, push: mocks.push }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => sessionState.current,
}));

vi.mock('@/lib/api/auth', () => ({
  verifyEmailConfirm: mocks.confirm,
  verifyEmailSend: mocks.send,
}));

function session(status: 'signed_out' | 'authenticated_without_vault', emailVerified: boolean) {
  sessionState.current.status = status;
  sessionState.current.me =
    status === 'signed_out' ? null : { user: { email: 'current@example.com', email_verified: emailVerified } };
}

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <VerifyEmailForm />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingVerificationToken();
  window.history.replaceState(null, '', '/app/auth/verify-email');
  mocks.confirm.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.refetchMe.mockResolvedValue(undefined);
  session('authenticated_without_vault', false);
});

afterEach(() => {
  cleanup();
  clearPendingVerificationToken();
  window.history.replaceState(null, '', '/app/auth/verify-email');
});

describe('VerifyEmailForm token flow', () => {
  it('keeps a verified account on a pending email-change confirmation', async () => {
    const token = 'email-change-token';
    window.history.replaceState(null, '', `/app/auth/verify-email#token=${encodeURIComponent(token)}`);
    session('authenticated_without_vault', true);

    renderForm();

    const confirm = await screen.findByRole('button', { name: 'Confirm email' });
    expect(window.location.hash).toBe('');
    expect(mocks.replace).not.toHaveBeenCalledWith('/app/onboarding');

    await userEvent.click(confirm);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(token));
    expect(mocks.replace).toHaveBeenCalledWith('/app/onboarding');
  });

  it('keeps a signed-out token in memory across login navigation', async () => {
    const token = 'signup-token';
    window.history.replaceState(null, '', `/app/auth/verify-email#token=${encodeURIComponent(token)}`);
    session('signed_out', false);

    const view = renderForm();
    await waitFor(() => expect(window.location.hash).toBe(''));

    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(mocks.push).toHaveBeenCalledWith('/app/auth/login?returnTo=%2Fapp%2Fauth%2Fverify-email');
    expect(mocks.push.mock.calls[0][0]).not.toContain(token);

    view.unmount();
    session('authenticated_without_vault', false);
    renderForm();

    const confirm = await screen.findByRole('button', { name: 'Confirm email' });
    await userEvent.click(confirm);
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(token));
  });

  it('scrubs a malformed token fragment without throwing', async () => {
    window.history.replaceState(null, '', '/app/auth/verify-email#token=%E0%A4%A');

    renderForm();

    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(screen.queryByRole('button', { name: 'Confirm email' })).not.toBeInTheDocument();
  });
});
