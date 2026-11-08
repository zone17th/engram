import { ProblemError } from '@engram/shared-types';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { StrictMode, useEffect, useRef, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReauthAction, ReauthGrant } from '@/lib/api/auth';
import { EXPORT_STATUS, type DecryptedExportPage, type ExportJob } from '@/lib/api/export';
import type { DecryptedExportRunnerDeps, ShowSaveFilePickerFn } from './decrypted-export-runner';
import { ReadableExportDialog } from './readable-export-dialog';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const TEST_VAULT_KEY_ID = 'vk:AAECAwQFBgcICQoLDA0ODw';
const TEST_JOB_ID = '11111111-2222-4333-8444-555555555555';

let mockVaultState: 'unlocked' | 'locked' = 'unlocked';
let mockVaultKeyId: string | null = TEST_VAULT_KEY_ID;
const secretResetListeners = new Set<() => void>();
const mockOpenEntry = vi.fn();

let mockHasPassword = true;
let mockOauthProviders: ('google')[] = ['google'];
let mockGrant: ReauthGrant | null = null;
let mockPendingAction: ReauthAction | null = null;
const mockBegin = vi.fn(async (action: ReauthAction) => {
  mockPendingAction = action;
  return {
    grant: 'grant-token',
    action,
    expires_at: '2026-11-08T10:10:00Z',
  } satisfies ReauthGrant;
});
const mockCancel = vi.fn(() => {
  mockPendingAction = null;
});
const mockClearGrant = vi.fn(() => {
  mockGrant = null;
});
const mockStartOauthReauth = vi.fn(async () => undefined);

vi.mock('@/features/vault/vault-provider', () => ({
  useVault: () => ({
    state: mockVaultState,
    vaultMeta: mockVaultKeyId
      ? { vault_key_id: mockVaultKeyId, version: 1, passkeys: [], recovery_keys: [] }
      : null,
    beginOp: () => ({
      opGeneration: 1,
      isCurrent: () => mockVaultState === 'unlocked',
      client: {
        openEntry: mockOpenEntry,
      },
    }),
    registerSecretFormReset: (fn: () => void) => {
      secretResetListeners.add(fn);
      return () => {
        secretResetListeners.delete(fn);
      };
    },
  }),
  useOptionalVault: () => ({
    state: mockVaultState,
  }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({
    me: {
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'user@example.com',
        email_verified: true,
        created_at: '2026-11-01T00:00:00Z',
      },
      settings: {
        locale: 'vi',
        theme: 'light',
        auto_lock_minutes: 15,
        semantic_suggest: false,
      },
      identities: [{ provider: 'password', linked_at: '2026-11-01T00:00:00Z' }],
      features: {
        semantic_available: false,
        email_verification_required: false,
        oauth_providers: ['google'],
        oauth_reauth_providers: ['google'],
        password_enrollment_available: false,
        captcha_site_key: null,
      },
      vault: { status: 'present' },
      semantic_consent_seen_at: null,
    },
    refetchMe: vi.fn(async () => undefined),
    reauth: {
      grant: mockGrant,
      pendingAction: mockPendingAction,
      error: null,
      submitting: false,
      capabilities: {
        hasPassword: mockHasPassword,
        oauthReauthProviders: mockOauthProviders,
        passwordEnrollmentAvailable: true,
      },
      begin: mockBegin,
      cancel: mockCancel,
      clearGrant: mockClearGrant,
      startOauthReauth: mockStartOauthReauth,
      hasUsableGrant: (action: ReauthAction) =>
        Boolean(mockGrant && mockGrant.action === action),
    },
  }),
}));

const mockReauthPassword = vi.fn();
vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/auth')>();
  return {
    ...actual,
    reauthPassword: (...args: unknown[]) => mockReauthPassword(...args),
  };
});

function makeReadyJob(overrides: Partial<ExportJob> = {}): ExportJob {
  return {
    id: TEST_JOB_ID,
    kind: 'encrypted',
    status: EXPORT_STATUS.ready,
    created_at: '2026-11-08T10:00:00Z',
    completed_at: '2026-11-08T10:01:00Z',
    expires_at: '2026-11-09T10:01:00Z',
    size_bytes: 1024,
    items_total: 1,
    items_processed: 1,
    ...overrides,
  };
}

function renderDialogHost(options: {
  initialOpen?: boolean;
  locale?: 'vi' | 'en';
  runnerDeps?: DecryptedExportRunnerDeps;
  now?: () => number;
} = {}) {
  const locale = options.locale ?? 'vi';
  const messages = locale === 'en' ? enMessages : viMessages;
  const nowFn = options.now ?? (() => Date.parse('2026-11-08T10:02:00Z'));

  function Host() {
    const [open, setOpen] = useState(options.initialOpen ?? true);
    const openerRef = useRef<HTMLButtonElement | null>(null);
    return (
      <div>
        <button
          ref={openerRef}
          type="button"
          data-testid="host-open-btn"
          onClick={() => setOpen(true)}
        >
          Open Readable
        </button>
        <ReadableExportDialog
          open={open}
          onOpenChange={setOpen}
          returnFocusRef={openerRef}
          runnerDeps={options.runnerDeps}
          now={nowFn}
        />
      </div>
    );
  }

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale={locale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    );
  }

  return render(<Host />, { wrapper: Wrapper });
}

describe('features/settings/data/readable-export-dialog (U17a #plainDlg)', () => {
  beforeEach(() => {
    mockVaultState = 'unlocked';
    mockVaultKeyId = TEST_VAULT_KEY_ID;
    mockHasPassword = true;
    mockOauthProviders = ['google'];
    mockGrant = null;
    mockPendingAction = null;
    secretResetListeners.clear();
    mockOpenEntry.mockReset();
    mockBegin.mockClear();
    mockCancel.mockClear();
    mockClearGrant.mockClear();
    mockStartOauthReauth.mockClear();
    mockReauthPassword.mockReset();
    vi.stubGlobal('navigator', {
      ...navigator,
      onLine: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows pl-locked and focuses unlock link when vault is locked; shows pl-confirm and focuses password input (or OAuth button for OAuth-only) when unlocked', async () => {
    // 1. Vault locked -> pl-locked, focus on Unlock vault
    mockVaultState = 'locked';
    const { unmount: u1 } = renderDialogHost();
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-locked"]')).toBeInTheDocument();
    });
    const unlockLink = screen.getByTestId('readable-export-unlock-link');
    await waitFor(() => {
      expect(document.activeElement).toBe(unlockLink);
    });
    expect(unlockLink).toHaveAttribute(
      'href',
      '/app/unlock?returnTo=%2Fapp%2Fsettings%3Freauth%3Dexport.decrypted%23dulieu',
    );
    u1();

    // 2. Vault unlocked with password -> pl-confirm, focus on password input
    mockVaultState = 'unlocked';
    mockHasPassword = true;
    const { unmount: u2 } = renderDialogHost();
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-confirm"]')).toBeInTheDocument();
    });
    const pwdInput = document.getElementById('plain-export-password');
    await waitFor(() => {
      expect(document.activeElement).toBe(pwdInput);
    });
    u2();

    // 3. Vault unlocked OAuth-only -> pl-confirm, focus on Google OAuth button
    mockHasPassword = false;
    const { unmount: u3 } = renderDialogHost();
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-confirm"]')).toBeInTheDocument();
    });
    const oauthBtn = screen.getByTestId('readable-export-oauth-btn');
    await waitFor(() => {
      expect(document.activeElement).toBe(oauthBtn);
    });
    fireEvent.click(oauthBtn);
    expect(mockStartOauthReauth).toHaveBeenCalledWith(
      'google',
      '/app/settings?reauth=export.decrypted#dulieu',
    );
    u3();
  });

  it('runs pl-confirm -> pl-progress -> pl-done, and Escape in pl-progress aborts sink, stays open showing cancelled status, and closing returns focus to opener', async () => {
    const nowMs = Date.parse('2026-11-08T10:02:00Z');
    const readyJob = makeReadyJob();

    mockReauthPassword.mockResolvedValue({
      grant: 'grant-valid',
      action: 'export.decrypted',
      expires_at: '2026-11-08T10:07:00Z',
    } satisfies ReauthGrant);

    const pageGate = Promise.withResolvers<DecryptedExportPage>();
    let sinkAborted = false;

    const showSaveFilePicker: ShowSaveFilePickerFn = async () => ({
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => undefined,
        abort: async () => {
          sinkAborted = true;
        },
      }),
    });

    const { unmount } = renderDialogHost({
      runnerDeps: {
        now: () => nowMs,
        showSaveFilePicker,
        getLatestExport: async () => ({ job: readyJob }),
        getDecryptedPage: () => pageGate.promise,
        postDecryptedAudit: async () => undefined,
      },
    });

    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-confirm"]')).toBeInTheDocument();
    });

    const pwdInput = document.getElementById('plain-export-password') as HTMLInputElement;
    fireEvent.change(pwdInput, { target: { value: 'correct-password-123' } });
    fireEvent.click(screen.getByTestId('readable-export-submit-btn'));

    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-progress"]')).toBeInTheDocument();
    });

    // Press Escape during pl-progress -> aborts export, stays open in pl-confirm with cancelled status focused (M8)
    fireEvent.keyDown(document.getElementById('plainDlg')!, { key: 'Escape', code: 'Escape' });

    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-confirm"]')).toBeInTheDocument();
    });
    expect(sinkAborted).toBe(true);
    const cancelledStatus = screen.getByTestId('readable-export-cancelled-status');
    expect(cancelledStatus).toHaveTextContent(viMessages.settings.data.readable.cancelledStatus);
    await waitFor(() => {
      expect(document.activeElement).toBe(cancelledStatus);
    });

    // Now close dialog -> returns focus to opener
    fireEvent.click(screen.getByTestId('readable-export-cancel-btn'));
    await waitFor(() => {
      expect(document.getElementById('plainDlg')).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(screen.getByTestId('host-open-btn'));
    unmount();

    // Now test full completion -> pl-done
    renderDialogHost({
      runnerDeps: {
        now: () => nowMs,
        showSaveFilePicker: null,
        onTriggerBlobDownload: () => undefined,
        getLatestExport: async () => ({ job: readyJob }),
        getDecryptedPage: async () => ({
          source_export_id: TEST_JOB_ID,
          vault_key_id: TEST_VAULT_KEY_ID,
          total_entries: 0,
          section: 'entries',
          items: [],
          next_cursor: null,
        }),
        postDecryptedAudit: async () => undefined,
      },
    });

    const pwdInput2 = document.getElementById('plain-export-password') as HTMLInputElement;
    fireEvent.change(pwdInput2, { target: { value: 'correct-password-123' } });
    fireEvent.click(screen.getByTestId('readable-export-submit-btn'));

    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-done"]')).toBeInTheDocument();
    });
    expect(screen.getByText('engram-readable-2026-11-08.json')).toBeInTheDocument();
  });

  it('handles mid-flow grant expiry on page N -> pl-reauth-expired (no partial file), and re-authenticating reuses ready source job (0 quota) and restarts from empty cursor', async () => {
    const nowMs = Date.parse('2026-11-08T10:02:00Z');
    const readyJob = makeReadyJob();

    mockReauthPassword
      .mockResolvedValueOnce({
        grant: 'grant-first',
        action: 'export.decrypted',
        expires_at: '2026-11-08T10:07:00Z',
      } satisfies ReauthGrant)
      .mockResolvedValueOnce({
        grant: 'grant-renewed',
        action: 'export.decrypted',
        expires_at: '2026-11-08T10:12:00Z',
      } satisfies ReauthGrant);

    const createExportMock = vi.fn();
    const getLatestExportMock = vi.fn().mockResolvedValue({ job: readyJob });
    const cursorsRequested: Array<string | null | undefined> = [];
    let attempt = 0;

    const getDecryptedPageMock = vi.fn().mockImplementation(async (_id: string, cursor?: string | null) => {
      cursorsRequested.push(cursor ?? null);
      if (attempt === 0) {
        if (!cursor) {
          return {
            source_export_id: TEST_JOB_ID,
            vault_key_id: TEST_VAULT_KEY_ID,
            total_entries: 1,
            section: 'tags',
            items: [],
            next_cursor: 'cursor-page-2',
          } satisfies DecryptedExportPage;
        }
        attempt = 1;
        throw new ProblemError({
          type: 'https://engram.zone17.click/problems/reauth_required',
          title: 'reauth_required',
          status: 401,
          code: 'reauth_required',
        });
      }
      return {
        source_export_id: TEST_JOB_ID,
        vault_key_id: TEST_VAULT_KEY_ID,
        total_entries: 0,
        section: 'entries',
        items: [],
        next_cursor: null,
      } satisfies DecryptedExportPage;
    });

    const downloadTriggerMock = vi.fn();

    renderDialogHost({
      runnerDeps: {
        now: () => nowMs,
        showSaveFilePicker: null,
        onTriggerBlobDownload: downloadTriggerMock,
        getLatestExport: getLatestExportMock,
        createExport: createExportMock,
        getDecryptedPage: getDecryptedPageMock,
        postDecryptedAudit: async () => undefined,
      },
    });

    const pwdInput = document.getElementById('plain-export-password') as HTMLInputElement;
    fireEvent.change(pwdInput, { target: { value: 'password-123' } });
    fireEvent.click(screen.getByTestId('readable-export-submit-btn'));

    // Should hit 401 on page 2 -> transition to pl-reauth-expired, no partial file downloaded
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-reauth-expired"]')).toBeInTheDocument();
    });
    expect(downloadTriggerMock).not.toHaveBeenCalled();

    // Re-enter password in pl-reauth-expired and click Continue
    const expiredPwdInput = document.getElementById(
      'plain-export-expired-password',
    ) as HTMLInputElement;
    fireEvent.change(expiredPwdInput, { target: { value: 'password-123' } });
    fireEvent.click(screen.getByTestId('readable-export-continue-btn'));

    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-done"]')).toBeInTheDocument();
    });

    // Must not have called createExport (0 quota consumed), and second run started from null cursor
    expect(createExportMock).not.toHaveBeenCalled();
    expect(cursorsRequested).toEqual([null, 'cursor-page-2', null]);
    expect(downloadTriggerMock).toHaveBeenCalledTimes(1);
  });

  it('covers pl-failed, pl-limit (429 when creating new source), pl-offline, and pl-too-large', async () => {
    const nowMs = Date.parse('2026-11-08T14:00:00Z');
    mockGrant = {
      grant: 'grant-active',
      action: 'export.decrypted',
      expires_at: '2026-11-08T14:05:00Z',
    };

    // 1. pl-limit when createExport returns 429
    const { unmount: u1 } = renderDialogHost({
      now: () => nowMs,
      runnerDeps: {
        now: () => nowMs,
        showSaveFilePicker: null,
        getLatestExport: async () => ({ job: null }),
        createExport: async () => {
          throw new ProblemError({
            type: 'https://engram.zone17.click/problems/rate_limited',
            title: 'rate_limited',
            status: 429,
            code: 'rate_limited',
            retry_after: 720,
          });
        },
      },
    });
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-limit"]')).toBeInTheDocument();
    });
    u1();

    // 2. pl-offline when network fails mid-flow
    mockGrant = {
      grant: 'grant-active',
      action: 'export.decrypted',
      expires_at: '2026-11-08T14:05:00Z',
    };
    const { unmount: u2 } = renderDialogHost({
      now: () => nowMs,
      runnerDeps: {
        now: () => nowMs,
        showSaveFilePicker: null,
        getLatestExport: async () => {
          throw new TypeError('Failed to fetch');
        },
      },
    });
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-offline"]')).toBeInTheDocument();
    });
    u2();

    // 3. pl-too-large when fallback byte budget is exceeded
    mockGrant = {
      grant: 'grant-active',
      action: 'export.decrypted',
      expires_at: '2026-11-08T14:05:00Z',
    };
    const readyJob = makeReadyJob({
      created_at: '2026-11-08T13:59:00Z',
      completed_at: '2026-11-08T13:59:10Z',
      expires_at: '2026-11-09T13:59:10Z',
    });
    const { unmount: u3 } = renderDialogHost({
      now: () => nowMs,
      runnerDeps: {
        now: () => nowMs,
        showSaveFilePicker: null,
        maxFallbackBytes: 100, // tiny budget to trigger pl-too-large
        getLatestExport: async () => ({ job: readyJob }),
        getDecryptedPage: async () => ({
          source_export_id: TEST_JOB_ID,
          vault_key_id: TEST_VAULT_KEY_ID,
          total_entries: 0,
          section: 'entries',
          items: [],
          next_cursor: null,
        }),
      },
    });
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-too-large"]')).toBeInTheDocument();
    });
    u3();

    // 4. pl-failed when key_id mismatches
    mockGrant = {
      grant: 'grant-active',
      action: 'export.decrypted',
      expires_at: '2026-11-08T14:05:00Z',
    };
    const { unmount: u4 } = renderDialogHost({
      now: () => nowMs,
      runnerDeps: {
        now: () => nowMs,
        showSaveFilePicker: null,
        getLatestExport: async () => ({ job: readyJob }),
        getDecryptedPage: async () => ({
          source_export_id: TEST_JOB_ID,
          vault_key_id: 'vk:differentKeyId00000000',
          total_entries: 0,
          section: 'entries',
          items: [],
          next_cursor: null,
        }),
      },
    });
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-failed"]')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(viMessages.settings.data.readable.failedAlert);
    u4();

    // 5. pl-limit paused variant when createExport returns 503 dependency_unavailable (M7)
    mockGrant = {
      grant: 'grant-active',
      action: 'export.decrypted',
      expires_at: '2026-11-08T14:05:00Z',
    };
    const { unmount: u5 } = renderDialogHost({
      now: () => nowMs,
      runnerDeps: {
        now: () => nowMs,
        showSaveFilePicker: null,
        getLatestExport: async () => ({ job: null }),
        createExport: async () => {
          throw new ProblemError({
            type: 'https://engram.zone17.click/problems/dependency_unavailable',
            title: 'dependency_unavailable',
            status: 503,
            code: 'dependency_unavailable',
            retry_after: 600,
          });
        },
      },
    });
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-limit"]')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('tạm dừng');
    u5();

    // 6. pl-failed generic variant when source export fails (non-key-mismatch, M7)
    mockGrant = {
      grant: 'grant-active',
      action: 'export.decrypted',
      expires_at: '2026-11-08T14:05:00Z',
    };
    const { unmount: u6 } = renderDialogHost({
      now: () => nowMs,
      runnerDeps: {
        now: () => nowMs,
        showSaveFilePicker: null,
        getLatestExport: async () => ({
          job: makeReadyJob({ status: EXPORT_STATUS.failed }),
        }),
        createExport: async () => {
          throw new ProblemError({
            type: 'https://engram.zone17.click/problems/internal_error',
            title: 'internal_error',
            status: 500,
            code: 'internal_error',
          });
        },
      },
    });
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-failed"]')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      viMessages.settings.data.readable.failedGenericAlert,
    );
    u6();
  });

  it('OAuth returnTo resume: when dialog opens while vault is locked and user then unlocks with valid grant, transitions directly to pl-progress -> pl-done', async () => {
    const nowMs = Date.parse('2026-11-08T10:02:00Z');
    const readyJob = makeReadyJob();

    mockVaultState = 'locked';
    mockGrant = {
      grant: 'oauth-grant-token',
      action: 'export.decrypted',
      expires_at: '2026-11-08T10:07:00Z',
    };

    const { rerender } = render(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <ReadableExportDialog
          open={true}
          onOpenChange={() => undefined}
          now={() => nowMs}
          runnerDeps={{
            now: () => nowMs,
            showSaveFilePicker: null,
            onTriggerBlobDownload: () => undefined,
            getLatestExport: async () => ({ job: readyJob }),
            getDecryptedPage: async () => ({
              source_export_id: TEST_JOB_ID,
              vault_key_id: TEST_VAULT_KEY_ID,
              total_entries: 0,
              section: 'entries',
              items: [],
              next_cursor: null,
            }),
            postDecryptedAudit: async () => undefined,
          }}
        />
      </NextIntlClientProvider>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-locked"]')).toBeInTheDocument();
    });

    // User unlocks vault -> dialog detects unlocked + valid grant -> runs export -> pl-done
    act(() => {
      mockVaultState = 'unlocked';
    });
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <ReadableExportDialog
          open={true}
          onOpenChange={() => undefined}
          now={() => nowMs}
          runnerDeps={{
            now: () => nowMs,
            showSaveFilePicker: null,
            onTriggerBlobDownload: () => undefined,
            getLatestExport: async () => ({ job: readyJob }),
            getDecryptedPage: async () => ({
              source_export_id: TEST_JOB_ID,
              vault_key_id: TEST_VAULT_KEY_ID,
              total_entries: 0,
              section: 'entries',
              items: [],
              next_cursor: null,
            }),
            postDecryptedAudit: async () => undefined,
          }}
        />
      </NextIntlClientProvider>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-done"]')).toBeInTheDocument();
    });
  });

  it('M-1, m-1, m-2, m-3: keeps focus on password input with linked password-only error after wrong reauth password, and renders provider-appropriate hints/primary button', async () => {
    // 1. Password-only account: m-1 shows passwordOnlyHint (no Google button mention), M-1 + m-3 wrong password keeps focus on input with aria-invalid + aria-describedby
    mockHasPassword = true;
    mockOauthProviders = [];
    mockReauthPassword.mockRejectedValueOnce(
      new ProblemError({
        type: 'https://engram.zone17.click/problems/invalid_credentials',
        title: 'invalid_credentials',
        status: 401,
        code: 'invalid_credentials',
      }),
    );

    const { unmount: u1 } = renderDialogHost({ locale: 'en' });
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-confirm"]')).toBeInTheDocument();
    });

    const pwdInput = document.getElementById('plain-export-password') as HTMLInputElement;
    await waitFor(() => {
      expect(document.activeElement).toBe(pwdInput);
    });

    // m-1: hint is passwordOnlyHint ("Confirms it's you.") without mentioning the button below
    const hintEl = document.getElementById('plain-export-password-hint');
    expect(hintEl).toHaveTextContent(enMessages.settings.data.readable.passwordOnlyHint);
    expect(hintEl).not.toHaveTextContent('Google/GitHub-only');

    fireEvent.change(pwdInput, { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByTestId('readable-export-submit-btn'));

    const errorEl = await waitFor(() => {
      const el = document.getElementById('plain-export-password-error');
      expect(el).toBeInTheDocument();
      return el!;
    });
    expect(errorEl).toHaveTextContent(enMessages.settings.data.readable.invalidPasswordError);
    expect(pwdInput).toHaveAttribute('aria-invalid', 'true');
    expect(pwdInput).toHaveAttribute('aria-describedby', 'plain-export-password-error');

    // M-1: focus stays on / returns to #plain-export-password, not #plainDlg
    await waitFor(() => {
      expect(document.activeElement).toBe(pwdInput);
    });
    u1();

    // 2. OAuth-only account: m-2 renders oauthOnlyHint and makes Verify with Google btn-primary
    mockHasPassword = false;
    mockOauthProviders = ['google'];
    const { unmount: u2 } = renderDialogHost({ locale: 'en' });
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-confirm"]')).toBeInTheDocument();
    });
    expect(screen.getByText(enMessages.settings.data.readable.oauthOnlyHint)).toBeInTheDocument();
    const oauthBtn = screen.getByTestId('readable-export-oauth-btn');
    expect(oauthBtn.className).toContain('btn-primary');
    u2();
  });

  it('R1 + N1: survives <StrictMode> mount/unmount/remount and OAuth round trip with resume={true}, clears grant only on cancel/close/consumption/expiry, and does not auto-start on manual open with a leftover grant', async () => {
    const nowMs = Date.parse('2026-11-08T14:00:00Z');
    const readyJob = makeReadyJob({
      created_at: '2026-11-08T13:58:00Z',
      completed_at: '2026-11-08T13:59:00Z',
      expires_at: '2026-11-09T13:59:00Z',
    });

    // 1. Manual open with a leftover grant (resume={false}) does NOT auto-start and clears the leftover grant (N1)
    mockGrant = {
      grant: 'residual-grant-token',
      action: 'export.decrypted',
      expires_at: '2026-11-08T14:05:00Z',
    };
    const getLatestManualMock = vi.fn();
    const { unmount: uManual } = render(
      <StrictMode>
        <NextIntlClientProvider locale="vi" messages={viMessages}>
          <ReadableExportDialog
            open={true}
            onOpenChange={() => undefined}
            resume={false}
            now={() => nowMs}
            runnerDeps={{
              now: () => nowMs,
              getLatestExport: getLatestManualMock,
            }}
          />
        </NextIntlClientProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-confirm"]')).toBeInTheDocument();
    });
    expect(mockClearGrant).toHaveBeenCalledTimes(1);
    expect(getLatestManualMock).not.toHaveBeenCalled();
    uManual();

    // 2. <StrictMode> double-mount + unmount/remount with a valid grant + resume={true} preserves the grant and auto-resumes export to pl-done (R1)
    mockClearGrant.mockClear();
    mockGrant = {
      grant: 'strictmode-resume-grant',
      action: 'export.decrypted',
      expires_at: '2026-11-08T14:05:00Z',
    };

    // First mount closed under <StrictMode> (simulates DataSection mounting before ?reauth= effect or before navigating back from /app/unlock)
    const { unmount: uPreMount } = render(
      <StrictMode>
        <NextIntlClientProvider locale="vi" messages={viMessages}>
          <ReadableExportDialog
            open={false}
            onOpenChange={() => undefined}
            resume={false}
            now={() => nowMs}
          />
        </NextIntlClientProvider>
      </StrictMode>,
    );
    // Unmounting must NEVER clear the grant
    uPreMount();
    expect(mockClearGrant).not.toHaveBeenCalled();
    expect(mockGrant?.grant).toBe('strictmode-resume-grant');

    // Remount under <StrictMode> where parent effect opens the dialog with resume={true} (just like DataSection on ?reauth=export.decrypted)
    function StrictResumeHost() {
      const [open, setOpen] = useState(false);
      const [resume, setResume] = useState(false);
      useEffect(() => {
        setResume(true);
        setOpen(true);
      }, []);
      return (
        <ReadableExportDialog
          open={open}
          onOpenChange={setOpen}
          resume={resume}
          now={() => nowMs}
          runnerDeps={{
            now: () => nowMs,
            showSaveFilePicker: null,
            onTriggerBlobDownload: () => undefined,
            getLatestExport: async () => ({ job: readyJob }),
            getDecryptedPage: async () => ({
              source_export_id: TEST_JOB_ID,
              vault_key_id: TEST_VAULT_KEY_ID,
              total_entries: 0,
              section: 'entries',
              items: [],
              next_cursor: null,
            }),
            postDecryptedAudit: async () => undefined,
          }}
        />
      );
    }

    const { unmount: uStrictResume } = render(
      <StrictMode>
        <NextIntlClientProvider locale="vi" messages={viMessages}>
          <StrictResumeHost />
        </NextIntlClientProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-done"]')).toBeInTheDocument();
    });
    // Cleared exactly once on successful consumption
    expect(mockClearGrant).toHaveBeenCalledTimes(1);
    expect(mockGrant).toBeNull();
    uStrictResume();
    // 3. Direct <StrictMode> mount with open={true} and resume={true} also survives simulated unmount/remount and completes to pl-done
    mockClearGrant.mockClear();
    mockGrant = {
      grant: 'strictmode-direct-open-grant',
      action: 'export.decrypted',
      expires_at: '2026-11-08T14:05:00Z',
    };
    const { unmount: uDirectStrict } = render(
      <StrictMode>
        <NextIntlClientProvider locale="vi" messages={viMessages}>
          <ReadableExportDialog
            open={true}
            onOpenChange={() => undefined}
            resume={true}
            now={() => nowMs}
            runnerDeps={{
              now: () => nowMs,
              showSaveFilePicker: null,
              onTriggerBlobDownload: () => undefined,
              getLatestExport: async () => ({ job: readyJob }),
              getDecryptedPage: async () => ({
                source_export_id: TEST_JOB_ID,
                vault_key_id: TEST_VAULT_KEY_ID,
                total_entries: 0,
                section: 'entries',
                items: [],
                next_cursor: null,
              }),
              postDecryptedAudit: async () => undefined,
            }}
          />
        </NextIntlClientProvider>
      </StrictMode>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-done"]')).toBeInTheDocument();
    });
    expect(mockClearGrant).toHaveBeenCalledTimes(1);
    uDirectStrict();

    // 4. Expired grant on resume clears the grant and lands in pl-reauth-expired
    mockClearGrant.mockClear();
    mockGrant = {
      grant: 'expired-resume-grant',
      action: 'export.decrypted',
      expires_at: '2026-11-08T13:59:00Z',
    };
    const { unmount: uExpired } = render(
      <StrictMode>
        <NextIntlClientProvider locale="vi" messages={viMessages}>
          <ReadableExportDialog
            open={true}
            onOpenChange={() => undefined}
            resume={true}
            now={() => nowMs}
          />
        </NextIntlClientProvider>
      </StrictMode>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-view="pl-reauth-expired"]')).toBeInTheDocument();
    });
    expect(mockClearGrant).toHaveBeenCalledTimes(1);
    uExpired();
  });
});
