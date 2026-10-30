import { ProblemError } from '@engram/shared-types';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';
import { AutoLockCard } from './auto-lock-card';
import { PasskeySecurityCard } from './passkey-card';

interface MockVaultState {
  workerState: string;
  autoLockMinutes?: number;
  vaultMeta?: {
    vault_key_id?: string;
    passkeys: Array<{ id: string; name: string; aaguid: string | null; created_at: string }>;
  } | null;
  reloadVaultMeta: () => Promise<unknown>;
  notifySettingsChanged: (payload: { auto_lock_minutes: number }) => void;
  registerSecretFormReset: (fn: () => void) => () => void;
}

const mocks = vi.hoisted(() => ({
  optionalVault: null as MockVaultState | null,
  rememberDevice: {
    status: 'ready' as 'loading' | 'ready' | 'unavailable',
    remembered: false,
    busy: false,
    notice: null as 'device_state_changed' | null,
    lastAbortReason: null as string | null,
    meta: null as { incarnation: string; deviceRevision: number } | null,
    available: true,
    remember: vi.fn(),
    forget: vi.fn(),
    refresh: vi.fn(async () => undefined),
    dismissNotice: vi.fn(),
  },
  me: {
    user: { id: 'u1', email: 'user@example.test', email_verified: true, created_at: '2026-10-01T00:00:00Z' },
    vault: { status: 'present' as 'present' | 'absent' },
    settings: { locale: 'en', theme: 'light', auto_lock_minutes: 15, semantic_suggest: true },
    identities: [{ provider: 'password' }],
    features: { oauth_providers: ['google'], oauth_reauth_providers: ['google'], password_enrollment_available: false },
  } as unknown,
  refetchMe: vi.fn(async () => undefined),
  reauth: {
    grant: null as { grant: string; action: string; expires_at: string } | null,
    pendingAction: null as string | null,
    error: null as string | null,
    submitting: false,
    capabilities: {
      hasPassword: true,
      oauthReauthProviders: ['google'] as string[],
      passwordEnrollmentAvailable: false,
    },
    begin: vi.fn((action: string, returnPath?: string) => {
      void action;
      void returnPath;
      return new Promise<never>(() => {});
    }),
    cancel: vi.fn(),
    clearGrant: vi.fn(),
    submitPassword: vi.fn(),
    startOauthReauth: vi.fn(),
    hasUsableGrant: vi.fn(() => false),
  },
  fetchPasskeysList: vi.fn(),
  renamePasskey: vi.fn(),
  revokePasskey: vi.fn(),
  patchSettings: vi.fn(),
}));

vi.mock('@/features/vault/device/use-remember-device', () => ({
  useRememberDevice: () => mocks.rememberDevice,
}));

vi.mock('@/features/vault/vault-provider', () => ({
  useOptionalVault: () => mocks.optionalVault,
  useVault: () => ({
    workerState: mocks.optionalVault?.workerState ?? 'unlocked',
    vaultMeta: mocks.optionalVault?.vaultMeta ?? { vault_key_id: 'vk:test-settings-1', passkeys: [] },
    getClient: () => ({
      captureGeneration: () => 1,
      getGeneration: () => 1,
      wrapForPasskey: async () => ({ vk_wrap: 'VK-WRAP' }),
    }),
    registerSecretFormReset: mocks.optionalVault?.registerSecretFormReset ?? (() => () => {}),
    reloadVaultMeta: mocks.optionalVault?.reloadVaultMeta ?? (async () => null),
  }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({
    me: mocks.me,
    refetchMe: mocks.refetchMe,
    reauth: mocks.reauth,
  }),
}));

vi.mock('@/lib/api/vault', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchPasskeysList: (...args: unknown[]) => mocks.fetchPasskeysList(...args),
    renamePasskey: (...args: unknown[]) => mocks.renamePasskey(...args),
    revokePasskey: (...args: unknown[]) => mocks.revokePasskey(...args),
  };
});

vi.mock('@/lib/api/auth', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    patchSettings: (...args: unknown[]) => mocks.patchSettings(...args),
  };
});

function problem(status: number, code: string, detail = code): ProblemError {
  return new ProblemError({
    type: `https://engram.local/problems/${code}`,
    title: code,
    status,
    code,
    detail,
  });
}

const PASSKEY_A = {
  id: 'pk-1111-aaaa',
  name: 'MacBook Pro · Touch ID',
  aaguid: '00000000-0000-0000-0000-000000000000',
  created_at: '2026-02-12T10:00:00Z',
};

const PASSKEY_B = {
  id: 'pk-2222-bbbb',
  name: 'YubiKey 5C',
  aaguid: '00000000-0000-0000-0000-000000000001',
  created_at: '2026-05-20T12:00:00Z',
};

function setupUnlockedVault(autoLockMinutes = 15) {
  const reloadVaultMeta = vi.fn(async () => null);
  const notifySettingsChanged = vi.fn();
  const registerSecretFormReset = vi.fn(() => () => {});
  mocks.optionalVault = {
    workerState: 'unlocked',
    autoLockMinutes,
    vaultMeta: null,
    reloadVaultMeta,
    notifySettingsChanged,
    registerSecretFormReset,
  };
  return { reloadVaultMeta, notifySettingsChanged, registerSecretFormReset };
}

function useValidRevokeGrant(token = 'revoke-grant-token-1') {
  const grant = {
    grant: token,
    action: 'vault.passkey_revoke',
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  mocks.reauth.grant = grant;
  mocks.reauth.hasUsableGrant.mockImplementation((action?: string) => action === 'vault.passkey_revoke');
  return grant;
}

function renderPasskeyCard(locale: 'en' | 'vi' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? enMessages : viMessages}>
      <PasskeySecurityCard revokeSleep={async () => {}} />
    </NextIntlClientProvider>,
  );
}

function renderAutoLockCard(locale: 'en' | 'vi' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? enMessages : viMessages}>
      <AutoLockCard />
    </NextIntlClientProvider>,
  );
}

describe('P03-T20B Settings passkey list, rename, revoke and auto-lock (Task 20 20B)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupUnlockedVault(15);
    mocks.rememberDevice = {
      status: 'ready',
      remembered: false,
      busy: false,
      notice: null,
      lastAbortReason: null,
      meta: null,
      available: true,
      remember: vi.fn(async () => ({
        status: 'ready' as const,
        remembered: true,
        busy: false,
        notice: null,
        lastAbortReason: null,
        meta: { incarnation: 'inc-1', deviceRevision: 1 },
      })),
      forget: vi.fn(async () => ({
        status: 'ready' as const,
        remembered: false,
        busy: false,
        notice: null,
        lastAbortReason: null,
        meta: { incarnation: 'inc-2', deviceRevision: 2 },
      })),
      refresh: vi.fn(async () => undefined),
      dismissNotice: vi.fn(),
    };
    mocks.me = {
      user: { id: 'u1', email: 'user@example.test', email_verified: true, created_at: '2026-10-01T00:00:00Z' },
      vault: { status: 'present' },
      settings: { locale: 'en', theme: 'light', auto_lock_minutes: 15, semantic_suggest: true },
      identities: [{ provider: 'password' }],
      features: { oauth_providers: ['google'], oauth_reauth_providers: ['google'], password_enrollment_available: false },
    };
    mocks.reauth.grant = null;
    mocks.reauth.pendingAction = null;
    mocks.reauth.error = null;
    mocks.reauth.submitting = false;
    mocks.reauth.hasUsableGrant.mockImplementation(() => false);
    mocks.fetchPasskeysList.mockResolvedValue({ items: [PASSKEY_A, PASSKEY_B] });
  });

  afterEach(() => {
    cleanup();
  });

  it('20B: passkey list renders items, empty state, and error + retry state (en and vi)', async () => {
    renderPasskeyCard('en');
    const list = await screen.findByTestId('settings-passkey-list');
    expect(within(list).getByText('MacBook Pro · Touch ID')).toBeInTheDocument();
    expect(within(list).getByText('YubiKey 5C')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename MacBook Pro · Touch ID' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remove MacBook Pro · Touch ID' })).toBeEnabled();
    cleanup();

    // Empty state in Vietnamese
    mocks.fetchPasskeysList.mockResolvedValueOnce({ items: [] });
    renderPasskeyCard('vi');
    expect(await screen.findByTestId('settings-passkey-empty')).toHaveTextContent(
      'Chưa có passkey. Thêm trong Settings sau khi mở vault.',
    );
    cleanup();

    // Error state + retry reloads list
    mocks.fetchPasskeysList
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce({ items: [PASSKEY_A] });
    renderPasskeyCard('en');
    const errBox = await screen.findByTestId('settings-passkey-load-error');
    expect(errBox).toHaveTextContent('Could not load your registered passkeys.');
    fireEvent.click(within(errBox).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('settings-passkey-list')).toHaveTextContent('MacBook Pro · Touch ID');
  });

  it('20B: rename passkey validates client-side, saves trimmed name, reloads list + vaultMeta, and handles server passkey_name_invalid', async () => {
    const { reloadVaultMeta } = setupUnlockedVault();
    let currentItems = [PASSKEY_A, PASSKEY_B];
    mocks.fetchPasskeysList.mockImplementation(async () => ({ items: currentItems }));

    renderPasskeyCard('en');
    await screen.findByTestId('settings-passkey-list');

    fireEvent.click(screen.getByTestId(`settings-passkey-rename-${PASSKEY_A.id}`));
    const input = screen.getByTestId(`settings-passkey-rename-input-${PASSKEY_A.id}`);

    // Client-side empty validation
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId(`settings-passkey-rename-save-${PASSKEY_A.id}`));
    expect(await screen.findByTestId('settings-passkey-rename-error')).toHaveTextContent(
      'Enter a name for this passkey.',
    );
    expect(mocks.renamePasskey).not.toHaveBeenCalled();

    // Client-side bidi / control character validation
    fireEvent.change(input, { target: { value: 'Bad\u202Ename' } });
    fireEvent.click(screen.getByTestId(`settings-passkey-rename-save-${PASSKEY_A.id}`));
    expect(await screen.findByTestId('settings-passkey-rename-error')).toHaveTextContent(
      'The passkey name contains characters that are not allowed.',
    );
    expect(mocks.renamePasskey).not.toHaveBeenCalled();

    // Server passkey_name_invalid rejection
    mocks.renamePasskey.mockRejectedValueOnce(problem(400, 'passkey_name_invalid'));
    fireEvent.change(input, { target: { value: 'Valid locally' } });
    fireEvent.click(screen.getByTestId(`settings-passkey-rename-save-${PASSKEY_A.id}`));
    expect(await screen.findByTestId('settings-passkey-rename-error')).toHaveTextContent(
      'The passkey name contains characters that are not allowed.',
    );

    // Successful rename trims and reloads list + vaultMeta
    mocks.renamePasskey.mockImplementationOnce(async (id: string, body: { name: string }) => {
      const updated = { ...PASSKEY_A, id, name: body.name };
      currentItems = [updated, PASSKEY_B];
      return updated;
    });
    fireEvent.change(input, { target: { value: '  Studio Mac · Touch ID  ' } });
    fireEvent.click(screen.getByTestId(`settings-passkey-rename-save-${PASSKEY_A.id}`));

    await waitFor(() =>
      expect(mocks.renamePasskey).toHaveBeenLastCalledWith(PASSKEY_A.id, { name: 'Studio Mac · Touch ID' }),
    );
    expect(await screen.findByTestId(`settings-passkey-name-${PASSKEY_A.id}`)).toHaveTextContent(
      'Studio Mac · Touch ID',
    );
    expect(screen.getByTestId('settings-passkey-status')).toHaveTextContent('Passkey renamed.');
    expect(reloadVaultMeta).toHaveBeenCalled();
  });

  it('20B: revoke passkey acquires vault.passkey_revoke grant when needed, deletes on server, and reloads list + vaultMeta', async () => {
    const { reloadVaultMeta } = setupUnlockedVault();
    let currentItems = [PASSKEY_A, PASSKEY_B];
    mocks.fetchPasskeysList.mockImplementation(async () => ({ items: currentItems }));
    mocks.revokePasskey.mockImplementation(async (id: string) => {
      currentItems = currentItems.filter((item) => item.id !== id);
    });
    mocks.reauth.submitPassword.mockImplementation(async () => {
      const grant = useValidRevokeGrant('fresh-revoke-grant');
      return grant;
    });

    renderPasskeyCard('en');
    await screen.findByTestId('settings-passkey-list');

    // Clicking Remove without a grant opens the re-auth dialog and begins vault.passkey_revoke
    fireEvent.click(screen.getByTestId(`settings-passkey-revoke-${PASSKEY_A.id}`));
    expect(mocks.reauth.begin).toHaveBeenCalledWith('vault.passkey_revoke', '/app/settings');
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Remove passkey');

    fireEvent.change(within(dialog).getByLabelText('Login password'), { target: { value: 'correct-login-pass' } });
    fireEvent.click(within(dialog).getByTestId('settings-passkey-revoke-confirm'));

    await waitFor(() => expect(mocks.revokePasskey).toHaveBeenCalledWith(PASSKEY_A.id, 'fresh-revoke-grant'));
    await waitFor(() => expect(screen.queryByTestId(`settings-passkey-row-${PASSKEY_A.id}`)).toBeNull());
    expect(screen.getByTestId('settings-passkey-status')).toHaveTextContent('Passkey removed.');
    expect(reloadVaultMeta).toHaveBeenCalledTimes(1);
  });

  it('20B: revoke lost response then retry does not report an error', async () => {
    const { reloadVaultMeta } = setupUnlockedVault();
    useValidRevokeGrant('grant-revoke-retry');

    let currentItems = [PASSKEY_A, PASSKEY_B];
    mocks.fetchPasskeysList.mockImplementation(async () => ({ items: currentItems }));

    // First DELETE commits on server (removes item) but the response is lost (network error);
    // automatic retry receives 404 passkey_not_found for the id this client just revoked -> treated as revoked, no error.
    let callCount = 0;
    mocks.revokePasskey.mockImplementation(async (id: string) => {
      callCount += 1;
      if (callCount === 1) {
        currentItems = currentItems.filter((item) => item.id !== id);
        throw new TypeError('Failed to fetch');
      }
      throw problem(404, 'passkey_not_found');
    });

    renderPasskeyCard('en');
    await screen.findByTestId('settings-passkey-list');

    fireEvent.click(screen.getByTestId(`settings-passkey-revoke-${PASSKEY_A.id}`));

    await waitFor(() => expect(mocks.revokePasskey).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId(`settings-passkey-row-${PASSKEY_A.id}`)).toBeNull());
    expect(screen.queryByTestId('settings-passkey-error')).toBeNull();
    expect(screen.getByTestId('settings-passkey-status')).toHaveTextContent('Passkey removed.');
    expect(reloadVaultMeta).toHaveBeenCalledTimes(1);
  });

  it('20B: 404 passkey_not_found for an id this client did NOT revoke shows an error and reloads the list', async () => {
    const { reloadVaultMeta } = setupUnlockedVault();
    useValidRevokeGrant('grant-revoke-foreign');

    let currentItems = [PASSKEY_A, PASSKEY_B];
    mocks.fetchPasskeysList.mockImplementation(async () => ({ items: currentItems }));
    mocks.revokePasskey.mockImplementationOnce(async () => {
      currentItems = [PASSKEY_B];
      throw problem(404, 'passkey_not_found');
    });

    renderPasskeyCard('en');
    await screen.findByTestId('settings-passkey-list');

    fireEvent.click(screen.getByTestId(`settings-passkey-revoke-${PASSKEY_A.id}`));

    expect(await screen.findByTestId('settings-passkey-error')).toHaveTextContent(
      'Could not remove this passkey because it was not found on the server.',
    );
    expect(mocks.revokePasskey).toHaveBeenCalledTimes(1);
    expect(reloadVaultMeta).toHaveBeenCalledTimes(1);
  });

  it('20B: auto-lock selector shows current value (default 15), PATCHes /me/settings + calls notifySettingsChanged (including never = 0), and reverts with error on failure', async () => {
    const { notifySettingsChanged } = setupUnlockedVault(15);
    renderAutoLockCard('en');

    const card = screen.getByTestId('settings-auto-lock-card');
    expect(within(card).getByRole('radio', { name: '15 min' })).toHaveAttribute('data-state', 'on');

    // Part D remember-device section is rendered inside the auto-lock card and defaults to off
    const rememberSwitch = within(card).getByRole('switch', { name: 'Remember this device' });
    expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');
    // Change to 5 min
    mocks.patchSettings.mockImplementationOnce(async (patch: { auto_lock_minutes: number }) => ({
      ...(mocks.me as Record<string, unknown>),
      settings: { locale: 'en', theme: 'light', auto_lock_minutes: patch.auto_lock_minutes, semantic_suggest: true },
    }));
    fireEvent.click(within(card).getByRole('radio', { name: '5 min' }));
    await waitFor(() => expect(mocks.patchSettings).toHaveBeenCalledWith({ auto_lock_minutes: 5 }));
    expect(notifySettingsChanged).toHaveBeenCalledWith({ auto_lock_minutes: 5 });

    // Change to Never (0)
    mocks.patchSettings.mockImplementationOnce(async (patch: { auto_lock_minutes: number }) => ({
      ...(mocks.me as Record<string, unknown>),
      settings: { locale: 'en', theme: 'light', auto_lock_minutes: patch.auto_lock_minutes, semantic_suggest: true },
    }));
    fireEvent.click(within(card).getByRole('radio', { name: 'Never' }));
    await waitFor(() => expect(mocks.patchSettings).toHaveBeenCalledWith({ auto_lock_minutes: 0 }));
    expect(notifySettingsChanged).toHaveBeenCalledWith({ auto_lock_minutes: 0 });

    // Failure -> reverts to effective value and shows error message
    mocks.patchSettings.mockRejectedValueOnce(problem(500, 'internal_error'));
    fireEvent.click(within(card).getByRole('radio', { name: '1 hour' }));
    expect(await screen.findByTestId('settings-auto-lock-error')).toHaveTextContent(
      'Could not save auto-lock setting. Reverted to the previous value.',
    );
    expect(within(card).getByRole('radio', { name: '15 min' })).toHaveAttribute('data-state', 'on');
  });

  it('20B: remember / forget device in Settings shows on/off state, calls remember() when unlocked, forget() with forgetDescription, cross-tab notice, and unavailable state (en + vi)', async () => {
    const { rerender } = renderAutoLockCard('en');

    // 1. Default off state
    const rememberSwitch = screen.getByTestId('settings-remember-device-switch');
    expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');
    expect(rememberSwitch).toBeEnabled();
    expect(screen.getByTestId('settings-remember-device-state')).toHaveTextContent(
      enMessages.vault.device.remember.off,
    );
    expect(screen.queryByTestId('settings-forget-device-button')).toBeNull();
    expect(screen.queryByTestId('settings-remember-device-forget-description')).toBeNull();

    // Clicking switch when off + unlocked calls remember()
    fireEvent.click(rememberSwitch);
    await waitFor(() => expect(mocks.rememberDevice.remember).toHaveBeenCalledTimes(1));

    // 2. Remembered (on) state -> shows On copy, forgetDescription, and Forget button
    mocks.rememberDevice.remembered = true;
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AutoLockCard />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('settings-remember-device-switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('settings-remember-device-state')).toHaveTextContent(
      enMessages.vault.device.remember.on,
    );
    expect(screen.getByTestId('settings-remember-device-forget-description')).toHaveTextContent(
      enMessages.vault.device.remember.forgetDescription,
    );
    const forgetBtn = screen.getByTestId('settings-forget-device-button');
    expect(forgetBtn).toHaveTextContent(enMessages.vault.device.remember.forget);
    fireEvent.click(forgetBtn);
    await waitFor(() => expect(mocks.rememberDevice.forget).toHaveBeenCalledTimes(1));

    // Clicking switch when remembered also calls forget()
    fireEvent.click(screen.getByTestId('settings-remember-device-switch'));
    await waitFor(() => expect(mocks.rememberDevice.forget).toHaveBeenCalledTimes(2));

    // 3. Cross-tab notice shown when notice === 'device_state_changed'
    mocks.rememberDevice.remembered = false;
    mocks.rememberDevice.notice = 'device_state_changed';
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AutoLockCard />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('settings-remember-device-notice')).toHaveTextContent(
      enMessages.vault.device.notice.stateChanged,
    );

    // 4. Unavailable state (IDB blocked / private mode) disables switch and shows unavailable copy
    mocks.rememberDevice.notice = null;
    mocks.rememberDevice.status = 'unavailable';
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AutoLockCard />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('settings-remember-device-switch')).toBeDisabled();
    expect(screen.getByTestId('settings-remember-device-unavailable')).toHaveTextContent(
      enMessages.vault.device.unavailable,
    );

    // 5. Locked vault disables turning on Remember when off, but allows Forget when already remembered (vi parity)
    mocks.rememberDevice.status = 'ready';
    mocks.rememberDevice.remembered = false;
    mocks.optionalVault!.workerState = 'locked';
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <AutoLockCard />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('settings-remember-device-switch')).toBeDisabled();
    expect(screen.getByTestId('settings-remember-device-state')).toHaveTextContent(
      viMessages.vault.device.remember.off,
    );

    mocks.rememberDevice.remembered = true;
    rerender(
      <NextIntlClientProvider locale="vi" messages={viMessages}>
        <AutoLockCard />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('settings-remember-device-switch')).toBeEnabled();
    expect(screen.getByTestId('settings-forget-device-button')).toHaveTextContent(
      viMessages.vault.device.remember.forget,
    );
  });
});
