import { ProblemError } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { StrictMode, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from '@/features/auth/forms/login-form';
import {
  DELETE_ACCOUNT_ACTION,
  DELETE_ACCOUNT_RETURN_TO,
  DangerZoneSection,
  DeleteAccountDialog,
  LOGIN_DELETED_HREF,
  isConfirmEmailMatching,
  normalizeConfirmEmail,
  type DeleteAccountDialogProps,
} from '@/features/settings/data';
import type { DeleteAccountOptions } from '@/lib/api/account';
import type { ReauthAction, ReauthGrant } from '@/lib/api/auth';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_EMAIL = 'an@example.com';

let mockHasPassword = true;
let mockOauthProviders: Array<'google'> = ['google'];
let mockGrant: ReauthGrant | null = null;
let mockPendingAction: ReauthAction | null = null;
let mockSearchParamsString = '';

const mockBegin = vi.fn(async (action: ReauthAction) => {
  mockPendingAction = action;
  return {
    grant: 'reauth-token-123',
    action,
    expires_at: '2026-11-08T15:00:00Z',
  };
});
const mockStartOauthReauth = vi.fn(async () => undefined);
const mockClearGrant = vi.fn(() => {
  mockGrant = null;
});
const mockCancelReauth = vi.fn(() => {
  mockPendingAction = null;
  mockGrant = null;
});
const mockClearPrivateCache = vi.fn();
const mockVaultLock = vi.fn(async () => undefined);
const secretResetCallbacks = new Set<() => void>();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => '/app/settings',
  useSearchParams: () => new URLSearchParams(mockSearchParamsString),
}));

vi.mock('@/features/vault/vault-provider', () => ({
  useOptionalVault: () => ({
    state: 'unlocked',
    lock: mockVaultLock,
    registerSecretFormReset: (cb: () => void) => {
      secretResetCallbacks.add(cb);
      return () => {
        secretResetCallbacks.delete(cb);
      };
    },
  }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({
    status: 'authenticated_with_vault',
    me: {
      user: {
        id: TEST_USER_ID,
        email: TEST_USER_EMAIL,
        email_verified: true,
        created_at: '2026-11-01T00:00:00Z',
        locale: 'vi',
        theme: 'system',
        settings: {
          auto_lock_minutes: 15,
          semantic_suggest: false,
        },
        semantic_consent_seen_at: null,
      },
      identities: mockHasPassword
        ? [{ provider: 'password', created_at: '2026-11-01T00:00:00Z' }]
        : [{ provider: 'google', created_at: '2026-11-01T00:00:00Z' }],
      vault: {
        status: 'present',
        recovery_keys_remaining: 10,
        passkeys_count: 0,
      },
      features: {
        oauth_reauth_providers: mockOauthProviders,
        password_enrollment_available: false,
        semantic_available: true,
        semantic_external: true,
      },
    },
    config: {
      oauth_providers: ['google'],
      email_verification_required: false,
      captcha_site_key: null,
      mail_delivery_available: false,
    },
    configLoading: false,
    configError: false,
    bootstrapComplete: true,
    sessionEpoch: 1,
    webLocksAvailable: true,
    lastSessionEndReason: null,
    refetchMe: vi.fn(async () => undefined),
    signup: vi.fn(),
    login: vi.fn(async () => {
      throw new ProblemError({
        type: 'about:blank',
        title: 'Invalid credentials',
        status: 401,
        code: 'invalid_credentials',
      });
    }),
    completeOAuthLogin: vi.fn(),
    signOut: vi.fn(async () => undefined),
    clearPrivateCache: mockClearPrivateCache,
    reauth: {
      grant: mockGrant,
      pendingAction: mockPendingAction,
      error: null,
      submitting: false,
      capabilities: {
        hasPassword: mockHasPassword,
        oauthReauthProviders: mockOauthProviders,
        passwordEnrollmentAvailable: false,
      },
      begin: mockBegin,
      cancel: mockCancelReauth,
      submitPassword: vi.fn(),
      startOauthReauth: mockStartOauthReauth,
      consumeOauthReceipt: vi.fn(),
      readStoredPending: vi.fn(() => null),
      clearGrant: mockClearGrant,
      clearPending: vi.fn(),
      hasUsableGrant: () => false,
    },
  }),
}));

function renderWithProviders(
  props: Partial<DeleteAccountDialogProps> = {},
  locale: 'vi' | 'en' = 'vi',
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const nowMs = Date.parse('2026-11-08T14:00:00Z');
  function Host() {
    const [open, setOpen] = useState(props.open ?? true);
    const openerRef = useRef<HTMLButtonElement | null>(null);
    return (
      <div>
        <button
          ref={openerRef}
          type="button"
          data-testid="delete-account-open-btn"
          onClick={() => setOpen(true)}
        >
          Open Delete Account
        </button>
        <DeleteAccountDialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            props.onOpenChange?.(next);
          }}
          returnFocusRef={openerRef}
          now={() => nowMs}
          {...props}
        />
      </div>
    );
  }

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <NextIntlClientProvider
          locale={locale}
          messages={locale === 'vi' ? viMessages : enMessages}
        >
          <Host />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    ),
  };
}

describe('features/settings/data/delete-account-dialog (U17b #deleteDlg)', () => {
  beforeEach(() => {
    mockHasPassword = true;
    mockOauthProviders = ['google'];
    mockGrant = null;
    mockPendingAction = null;
    mockSearchParamsString = '';
    secretResetCallbacks.clear();
    mockBegin.mockClear();
    mockStartOauthReauth.mockClear();
    mockClearGrant.mockClear();
    mockCancelReauth.mockClear();
    mockClearPrivateCache.mockClear();
    mockVaultLock.mockClear();
    window.history.replaceState(null, '', '/app/settings');
  });

  afterEach(() => {
    cleanup();
  });

  it('normalizes email confirmation (trim + lowercase) and validates match against user email', () => {
    expect(normalizeConfirmEmail('  An@Example.COM ')).toBe('an@example.com');
    expect(isConfirmEmailMatching('  AN@EXAMPLE.COM ', 'an@example.com')).toBe(true);
    expect(isConfirmEmailMatching('an@exampl', 'an@example.com')).toBe(false);
    expect(isConfirmEmailMatching('', 'an@example.com')).toBe(false);
  });

  it('1. renders all 6 del-* views (del-s1, del-s2, del-busy, del-failed, del-reauth-expired, del-done) in vi and en, and verifies focus on open/step change/close + step 1 backup & reset links', async () => {
    // Open del-s1 in vi -> initial focus lands on safe choice "Giữ tài khoản" (FE-R1-13)
    const { unmount: uVi } = renderWithProviders({}, 'vi');

    await waitFor(() => {
      expect(document.querySelector('[data-view="del-s1"]')).toBeInTheDocument();
    });
    const keepBtn = screen.getByTestId('delete-account-keep-btn');
    await waitFor(() => {
      expect(document.activeElement).toBe(keepBtn);
    });

    // Verify consequence bullets (including 8-day internal backup retention & 90-day security log)
    expect(screen.getByText(/rời khỏi mọi bản sao lưu chậm nhất sau 8 ngày/i)).toBeInTheDocument();
    expect(screen.getByText(/nhật ký bảo mật \(không có nội dung\) giữ 90 ngày/i)).toBeInTheDocument();

    // Advance del-s1 -> del-s2 -> focus moves to password input
    fireEvent.click(screen.getByTestId('delete-account-continue-btn'));
    await waitFor(() => {
      expect(document.querySelector('[data-view="del-s2"]')).toBeInTheDocument();
    });
    const pwdInput = document.getElementById('delete-account-password') as HTMLInputElement;
    await waitFor(() => {
      expect(document.activeElement).toBe(pwdInput);
    });

    // Back del-s2 -> del-s1 -> focus returns to Keep account button
    fireEvent.click(screen.getByTestId('delete-account-back-btn'));
    await waitFor(() => {
      expect(document.querySelector('[data-view="del-s1"]')).toBeInTheDocument();
      expect(document.activeElement).toBe(screen.getByTestId('delete-account-keep-btn'));
    });

    // Close dialog via Keep account -> focus returns to opener button
    const openerBtn = screen.getByTestId('delete-account-open-btn');
    fireEvent.click(screen.getByTestId('delete-account-keep-btn'));
    await waitFor(() => {
      expect(document.getElementById('deleteDlg')).not.toBeInTheDocument();
      expect(document.activeElement).toBe(openerBtn);
    });
    uVi();

    // Test "Download backup first" and "Reset vault" links in del-s1 (en)
    const dulieuSection = document.createElement('section');
    dulieuSection.id = 'dulieu';
    const dulieuScrollSpy = vi.fn();
    dulieuSection.scrollIntoView = dulieuScrollSpy;
    const backupStartBtn = document.createElement('button');
    backupStartBtn.setAttribute('data-testid', 'export-encrypted-start-btn');
    dulieuSection.appendChild(backupStartBtn);
    document.body.appendChild(dulieuSection);

    const baomatSection = document.createElement('section');
    baomatSection.id = 'baomat';
    const baomatScrollSpy = vi.fn();
    baomatSection.scrollIntoView = baomatScrollSpy;
    const resetOpenBtn = document.createElement('button');
    resetOpenBtn.setAttribute('data-open-dialog', 'resetDlg');
    baomatSection.appendChild(resetOpenBtn);
    document.body.appendChild(baomatSection);

    try {
      const { unmount: uEnLinks } = renderWithProviders({}, 'en');
      await waitFor(() => {
        expect(document.querySelector('[data-view="del-s1"]')).toBeInTheDocument();
      });
      expect(
        screen.getByText(/Deleted data leaves all internal backups within 8 days/i),
      ).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('delete-account-download-backup-link'));
      await waitFor(() => {
        expect(document.getElementById('deleteDlg')).not.toBeInTheDocument();
      });
      expect(dulieuScrollSpy).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(backupStartBtn);

      // Reopen and click Reset vault link
      fireEvent.click(screen.getByTestId('delete-account-open-btn'));
      await waitFor(() => {
        expect(document.querySelector('[data-view="del-s1"]')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('delete-account-reset-vault-link'));
      await waitFor(() => {
        expect(document.getElementById('deleteDlg')).not.toBeInTheDocument();
      });
      expect(baomatScrollSpy).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(resetOpenBtn);
      uEnLinks();
    } finally {
      dulieuSection.remove();
      baomatSection.remove();
    }

    // Verify del-done view rendering directly
    const { unmount: uDone } = renderWithProviders({ initialView: 'del-done' }, 'en');
    await waitFor(() => {
      expect(document.querySelector('[data-view="del-done"]')).toBeInTheDocument();
    });
    expect(screen.getByTestId('delete-account-done-status')).toHaveTextContent(
      enMessages.settings.data.deleteDialog.doneStatus,
    );
    expect(screen.getByTestId('delete-account-go-home-link')).toHaveAttribute('href', '/');
    uDone();
  });

  it('2. validates email mismatch (#delEmailErr), keeps focus on password input on wrong password, blocks Escape during del-busy, and executes full 204 delete cleanup (vault.lock + purgeDeviceKeysOnRevoked + TanStack cache clear + redirect to ?deleted=1)', async () => {
    const deleteGate = Promise.withResolvers<void>();
    const deleteCalls: DeleteAccountOptions[] = [];
    const purgeSpy = vi.fn(async () => ({
      ok: true as const,
      meta: null,
      deletedCount: 1,
      skipped: false,
    }));
    const navigateSpy = vi.fn();
    let reauthCallCount = 0;

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['items', 'list'], [{ id: 'item-1' }]);

    const { unmount } = renderWithProviders(
      {
        deps: {
          reauthPassword: async (action, pwd) => {
            reauthCallCount += 1;
            if (pwd === 'wrong-password-12') {
              throw new ProblemError({
                type: 'about:blank',
                title: 'Invalid credentials',
                status: 401,
                code: 'invalid_credentials',
              });
            }
            return {
              action,
              grant: 'fresh-delete-grant',
              expires_at: '2026-11-08T14:05:00Z',
            };
          },
          deleteAccount: async (opts) => {
            deleteCalls.push(opts);
            await deleteGate.promise;
          },
          purgeDeviceKeysOnRevoked: purgeSpy,
          navigateToDeletedLogin: navigateSpy,
        },
      },
      'vi',
      queryClient,
    );

    fireEvent.click(screen.getByTestId('delete-account-continue-btn'));
    await waitFor(() => {
      expect(document.querySelector('[data-view="del-s2"]')).toBeInTheDocument();
    });

    const pwdInput = document.getElementById('delete-account-password') as HTMLInputElement;
    const emailInput = screen.getByTestId('delete-account-email-input') as HTMLInputElement;
    const submitBtn = screen.getByTestId('delete-account-submit-btn') as HTMLButtonElement;

    expect(submitBtn).toBeDisabled();

    // Type mismatched email -> shows #delEmailErr and keeps submit disabled
    fireEvent.change(emailInput, { target: { value: 'an@exampl' } });
    fireEvent.change(pwdInput, { target: { value: 'wrong-password-12' } });
    expect(document.getElementById('delEmailErr')).toHaveTextContent(
      viMessages.settings.data.deleteDialog.confirmEmailMismatchError,
    );
    expect(emailInput).toHaveAttribute('aria-invalid', 'true');
    expect(emailInput).toHaveAttribute('aria-describedby', 'delEmailErr');
    expect(submitBtn).toBeDisabled();

    // Fix email (with uppercase/whitespace to verify NormalizeEmail) -> #delEmailErr disappears and submit enables
    fireEvent.change(emailInput, { target: { value: '  AN@EXAMPLE.COM  ' } });
    expect(document.getElementById('delEmailErr')).toBeNull();
    expect(submitBtn).not.toBeDisabled();

    // Submit with wrong password -> error appears below password input and focus stays on password input
    pwdInput.focus();
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(document.getElementById('delete-account-password-error')).toHaveTextContent(
        viMessages.settings.data.deleteDialog.invalidPasswordError,
      );
    });
    expect(document.activeElement).toBe(pwdInput);
    expect(pwdInput.value).toBe('');
    expect(deleteCalls).toHaveLength(0);

    // Enter correct password and submit -> enters del-busy
    fireEvent.change(pwdInput, { target: { value: 'correct-password-12' } });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(document.querySelector('[data-view="del-busy"]')).toBeInTheDocument();
    });
    expect(reauthCallCount).toBe(2);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toMatchObject({
      confirmEmail: 'an@example.com',
      reauthToken: 'fresh-delete-grant',
    });

    // Pressing Escape during del-busy is blocked and does NOT close the dialog
    fireEvent.keyDown(document.getElementById('deleteDlg')!, {
      key: 'Escape',
      code: 'Escape',
    });
    expect(document.querySelector('[data-view="del-busy"]')).toBeInTheDocument();

    // Resolve DELETE /api/v1/me 204 -> locks vault, purges device keys for user.id, clears TanStack cache, navigates to /app/auth/login?deleted=1
    deleteGate.resolve();

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(LOGIN_DELETED_HREF);
    });
    expect(mockVaultLock).toHaveBeenCalledWith({ broadcast: false, reason: 'logout' });
    expect(purgeSpy).toHaveBeenCalledWith(TEST_USER_ID);
    expect(mockClearPrivateCache).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(['items', 'list'])).toBeUndefined();
    expect(document.querySelector('[data-view="del-done"]')).toBeInTheDocument();

    unmount();
  });

  it('3. handles del-failed (5xx / network / 429) with retry reusing Idempotency-Key, and del-reauth-expired (401 reauth_required) with inline Verify & delete', async () => {
    const deleteCalls: DeleteAccountOptions[] = [];
    let attempt = 0;
    const navigateSpy = vi.fn();

    const { unmount } = renderWithProviders(
      {
        deps: {
          reauthPassword: async (action) => ({
            action,
            grant: `grant-attempt-${attempt}`,
            expires_at: '2026-11-08T14:05:00Z',
          }),
          deleteAccount: async (opts) => {
            attempt += 1;
            deleteCalls.push(opts);
            if (attempt === 1) {
              throw new ProblemError({
                type: 'about:blank',
                title: 'Internal Server Error',
                status: 500,
                code: 'internal_error',
              });
            }
            if (attempt === 2) {
              throw new ProblemError({
                type: 'about:blank',
                title: 'Reauth required',
                status: 401,
                code: 'reauth_required',
              });
            }
          },
          purgeDeviceKeysOnRevoked: async () => ({
            ok: true as const,
            meta: null,
            deletedCount: 0,
            skipped: true,
          }),
          navigateToDeletedLogin: navigateSpy,
        },
      },
      'en',
    );

    fireEvent.click(screen.getByTestId('delete-account-continue-btn'));
    await waitFor(() => {
      expect(document.querySelector('[data-view="del-s2"]')).toBeInTheDocument();
    });

    fireEvent.change(document.getElementById('delete-account-password')!, {
      target: { value: 'login-password-12' },
    });
    fireEvent.change(screen.getByTestId('delete-account-email-input'), {
      target: { value: TEST_USER_EMAIL },
    });
    fireEvent.click(screen.getByTestId('delete-account-submit-btn'));

    // Attempt 1 fails with 500 -> transitions to del-failed and focuses alert
    await waitFor(() => {
      expect(document.querySelector('[data-view="del-failed"]')).toBeInTheDocument();
    });
    const failedAlert = screen.getByTestId('delete-account-failed-alert');
    expect(failedAlert).toHaveTextContent(enMessages.settings.data.deleteDialog.failedAlert);
    await waitFor(() => {
      expect(document.activeElement).toBe(failedAlert);
    });

    // Click Try again while grant is still valid -> retries with the SAME Idempotency-Key -> Attempt 2 returns 401 reauth_required -> del-reauth-expired
    fireEvent.click(screen.getByTestId('delete-account-retry-btn'));
    await waitFor(() => {
      expect(document.querySelector('[data-view="del-reauth-expired"]')).toBeInTheDocument();
    });
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[1]!.idempotencyKey).toBe(deleteCalls[0]!.idempotencyKey);

    const expiredPwdInput = document.getElementById(
      'delete-account-expired-password',
    ) as HTMLInputElement;
    await waitFor(() => {
      expect(document.activeElement).toBe(expiredPwdInput);
    });

    // Re-enter password in del-reauth-expired and click Verify & delete -> Attempt 3 succeeds (204)
    fireEvent.change(expiredPwdInput, { target: { value: 'login-password-12' } });
    fireEvent.click(screen.getByTestId('delete-account-verify-delete-btn'));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(LOGIN_DELETED_HREF);
    });
    expect(deleteCalls).toHaveLength(3);
    expect(deleteCalls[2]!.idempotencyKey).toBe(deleteCalls[0]!.idempotencyKey);

    unmount();
  });

  it('4. OAuth-only account: starts Google OAuth reauth with returnTo=/app/settings?reauth=account.delete#xoataikhoan and auto-opens #deleteDlg at del-s2 on return (with StrictMode safety)', async () => {
    mockHasPassword = false;
    mockOauthProviders = ['google'];

    // Step A: Open DangerZoneSection, click Delete account..., advance to del-s2, click Verify with Google
    const { unmount: uStart } = render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="vi" messages={viMessages}>
          <DangerZoneSection />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId('delete-account-open-btn'));
    await waitFor(() => {
      expect(document.querySelector('[data-view="del-s1"]')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('delete-account-continue-btn'));
    await waitFor(() => {
      expect(document.querySelector('[data-view="del-s2"]')).toBeInTheDocument();
    });

    const oauthBtn = screen.getByTestId('delete-account-oauth-btn');
    await waitFor(() => {
      expect(document.activeElement).toBe(oauthBtn);
    });
    fireEvent.click(oauthBtn);
    await waitFor(() => {
      expect(mockStartOauthReauth).toHaveBeenCalledWith('google', DELETE_ACCOUNT_RETURN_TO);
    });
    uStart();

    // Step B: Simulate return to /app/settings?reauth=account.delete#xoataikhoan with valid account.delete grant under <StrictMode>
    mockGrant = {
      action: DELETE_ACCOUNT_ACTION,
      grant: 'oauth-delete-grant-789',
      expires_at: '2026-11-08T14:05:00Z',
    };
    window.history.replaceState(
      null,
      '',
      '/app/settings?reauth=account.delete#xoataikhoan',
    );

    const deleteCalls: DeleteAccountOptions[] = [];
    const navigateSpy = vi.fn();

    const { unmount: uReturn } = render(
      <StrictMode>
        <QueryClientProvider client={new QueryClient()}>
          <NextIntlClientProvider locale="vi" messages={viMessages}>
            <DangerZoneSection
              deleteDialogProps={{
                now: () => Date.parse('2026-11-08T14:00:00Z'),
                deps: {
                  deleteAccount: async (opts) => {
                    deleteCalls.push(opts);
                  },
                  purgeDeviceKeysOnRevoked: async () => ({
                    ok: true as const,
                    meta: null,
                    deletedCount: 0,
                    skipped: true,
                  }),
                  navigateToDeletedLogin: navigateSpy,
                },
              }}
            />
          </NextIntlClientProvider>
        </QueryClientProvider>
      </StrictMode>,
    );

    // Auto-opens #deleteDlg directly at del-s2 and strips ?reauth=account.delete via replaceState
    await waitFor(() => {
      expect(document.querySelector('[data-view="del-s2"]')).toBeInTheDocument();
    });
    expect(window.location.search).toBe('');
    expect(screen.getByTestId('delete-account-oauth-verified-status')).toBeInTheDocument();

    // Focus lands on confirm_email input since OAuth grant is already present
    const emailInput = screen.getByTestId('delete-account-email-input');
    await waitFor(() => {
      expect(document.activeElement).toBe(emailInput);
    });

    // Submit button is disabled until email matches
    const submitBtn = screen.getByTestId('delete-account-submit-btn');
    expect(submitBtn).toBeDisabled();

    fireEvent.change(emailInput, { target: { value: TEST_USER_EMAIL } });
    expect(submitBtn).not.toBeDisabled();

    fireEvent.click(submitBtn);
    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(LOGIN_DELETED_HREF);
    });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toMatchObject({
      confirmEmail: TEST_USER_EMAIL,
      reauthToken: 'oauth-delete-grant-789',
    });

    uReturn();
  });

  it('5. LoginForm renders #login-account-deleted-banner role="status" when ?deleted=1 is present and cleans the URL via history.replaceState', async () => {
    mockSearchParamsString = 'deleted=1';
    window.history.replaceState(null, '', '/app/auth/login?deleted=1');

    const { unmount } = render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <LoginForm />
      </NextIntlClientProvider>,
    );

    const banner = screen.getByTestId('login-account-deleted-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute('id', 'login-account-deleted-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent(viMessages.auth.login.accountDeletedBanner);
    expect(window.location.search).toBe('');

    unmount();
  });
});
