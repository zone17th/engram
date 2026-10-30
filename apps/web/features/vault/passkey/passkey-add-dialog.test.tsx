import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';
import { PasskeyAddDialog, PasskeyAddEntry } from './passkey-add-dialog';
import type { PasskeyRegisterOutcome } from './register-flow';
import {
  NEW_CREDENTIAL_ID,
  PRF_OUTPUT,
  domError,
  fakeCredential,
  problem,
  registerOptionsResponse,
} from './test-helpers';
import { usePasskeyRegister } from './use-passkey-register';

const mocks = vi.hoisted(() => ({
  reauth: {
    grant: null as unknown,
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
    submitPassword: vi.fn(async (password: string) => {
      void password;
    }),
    startOauthReauth: vi.fn(async (provider: string, returnPath?: string) => {
      void provider;
      void returnPath;
    }),
    hasUsableGrant: vi.fn((action: string) => {
      void action;
      return false;
    }),
  },
  vault: {
    getClient: () => ({
      captureGeneration: () => 1,
      getGeneration: () => 1,
      wrapForPasskey: async (params: unknown) => {
        void params;
        return { vk_wrap: 'VK-WRAP-OPAQUE' };
      },
    }),
    registerSecretFormReset: vi.fn(() => () => {}),
    reloadVaultMeta: vi.fn(async () => null),
  },
  fetchPasskeyRegisterOptions: vi.fn(),
  registerPasskey: vi.fn(),
  credentialsCreate: vi.fn(),
}));

vi.mock('@/features/auth/session-provider', () => ({ useSession: () => ({ reauth: mocks.reauth }) }));
vi.mock('@/features/vault/vault-provider', () => ({ useVault: () => mocks.vault }));
vi.mock('@/lib/api/vault', () => ({
  fetchPasskeyRegisterOptions: mocks.fetchPasskeyRegisterOptions,
  registerPasskey: mocks.registerPasskey,
  createIdempotencyKey: () => 'idem-0123456789abcdef',
}));

const SAVED = { id: 'p1', name: 'Work laptop', aaguid: null, created_at: '2026-10-30T00:00:00Z' };

function useValidGrant() {
  mocks.reauth.grant = {
    grant: 'grant-token-1',
    action: 'vault.passkey_register',
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  mocks.reauth.hasUsableGrant.mockImplementation(() => true);
}

function renderDialog(
  onRegistered?: () => void,
  onOpenChange: (open: boolean) => void = () => {},
  locale: 'en' | 'vi' = 'en',
) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? enMessages : viMessages}>
      <PasskeyAddDialog open onOpenChange={onOpenChange} returnPath="/app/settings" onRegistered={onRegistered} />
    </NextIntlClientProvider>,
  );
}

function stubRegistration(prf: { enabled?: boolean; first?: Uint8Array } | null) {
  mocks.fetchPasskeyRegisterOptions.mockResolvedValue(registerOptionsResponse());
  mocks.credentialsCreate.mockResolvedValue(fakeCredential({ rawId: NEW_CREDENTIAL_ID, prf }).credential);
}

describe('T19 bullet 1 - PasskeyAddDialog (Add passkey entry + naming dialog)', () => {
  beforeEach(() => {
    mocks.reauth.grant = null;
    mocks.reauth.pendingAction = null;
    mocks.reauth.error = null;
    mocks.reauth.submitting = false;
    mocks.reauth.capabilities = {
      hasPassword: true,
      oauthReauthProviders: ['google'],
      passwordEnrollmentAvailable: false,
    };
    mocks.reauth.begin.mockClear();
    mocks.reauth.cancel.mockClear();
    mocks.reauth.submitPassword.mockClear();
    mocks.reauth.startOauthReauth.mockClear();
    mocks.reauth.hasUsableGrant.mockImplementation(() => false);
    mocks.fetchPasskeyRegisterOptions.mockReset();
    mocks.registerPasskey.mockReset();
    mocks.credentialsCreate.mockReset();
    mocks.vault.reloadVaultMeta.mockClear();
    Object.defineProperty(navigator, 'credentials', {
      value: { create: mocks.credentialsCreate, get: vi.fn() },
      configurable: true,
    });
  });

  afterEach(() => cleanup());

  it('takes the vault.passkey_register grant the moment the dialog opens, before anything else', async () => {
    renderDialog();
    await waitFor(() => expect(mocks.reauth.begin).toHaveBeenCalledWith('vault.passkey_register', '/app/settings'));
    expect(mocks.fetchPasskeyRegisterOptions).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('does not ask again when a usable grant exists, and enables Continue', async () => {
    useValidGrant();
    renderDialog();
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(mocks.reauth.begin).not.toHaveBeenCalled();
  });

  it('password user re-authenticates in place: the typed password goes to reauth.submitPassword', async () => {
    mocks.reauth.pendingAction = 'vault.passkey_register';
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Login password'), { target: { value: 's3cret-login' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mocks.reauth.submitPassword).toHaveBeenCalledWith('s3cret-login'));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('OAuth-only user sees Google re-auth and no password field', async () => {
    mocks.reauth.pendingAction = 'vault.passkey_register';
    mocks.reauth.capabilities = {
      hasPassword: false,
      oauthReauthProviders: ['google'],
      passwordEnrollmentAvailable: false,
    };
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm with Google' }));
    expect(mocks.reauth.startOauthReauth).toHaveBeenCalledWith('google', '/app/settings');
    expect(screen.queryByLabelText('Login password')).toBeNull();
  });

  it('registers with the typed name, the grant token and an Idempotency-Key, then reports and closes', async () => {
    useValidGrant();
    stubRegistration({ enabled: true, first: PRF_OUTPUT });
    mocks.registerPasskey.mockResolvedValue(SAVED);
    const onRegistered = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog(onRegistered, onOpenChange);
    fireEvent.change(await screen.findByLabelText('Passkey name'), { target: { value: '  Work laptop ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(onRegistered).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const [body, options] = mocks.registerPasskey.mock.calls[0] as [string, { idempotencyKey: string; reauthToken: string }];
    expect(JSON.parse(body)).toMatchObject({ name: 'Work laptop', vk_wrap: 'VK-WRAP-OPAQUE' });
    expect(options).toEqual({ idempotencyKey: 'idem-0123456789abcdef', reauthToken: 'grant-token-1' });
  });

  it('an invalid name is refused client-side with the name copy, before any request', async () => {
    useValidGrant();
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Passkey name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a name for this passkey.');
    expect(mocks.fetchPasskeyRegisterOptions).not.toHaveBeenCalled();
  });

  it('PRF unsupported shows passkey.prf_unsupported plus the orphan notice, and saves nothing', async () => {
    useValidGrant();
    stubRegistration({ enabled: false });
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Passkey name'), { target: { value: 'Key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not support the WebAuthn PRF extension/);
    expect(await screen.findByRole('status')).toHaveTextContent(/not saved to your vault/);
    expect(mocks.registerPasskey).not.toHaveBeenCalled();
  });

  it('cancelling the authenticator prompt shows passkey.register_cancelled without an orphan notice', async () => {
    useValidGrant();
    mocks.fetchPasskeyRegisterOptions.mockResolvedValue(registerOptionsResponse());
    mocks.credentialsCreate.mockRejectedValue(domError('NotAllowedError'));
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Passkey name'), { target: { value: 'Key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Passkey registration was cancelled.');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a definite POST rejection shows passkey.register_failed and the orphan notice', async () => {
    useValidGrant();
    stubRegistration({ enabled: true, first: PRF_OUTPUT });
    mocks.registerPasskey.mockRejectedValue(problem(400, 'passkey_challenge_invalid'));
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Passkey name'), { target: { value: 'Key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not register this passkey. Try another authenticator.');
    expect(await screen.findByRole('status')).toHaveTextContent(/delete the extra credential/);
  });

  it('PKW-R3-1: a lost response followed by a non-201 replay shows the neutral unconfirmed notice (en+vi), never the orphan notice, and reloads the passkey list (advisor-dec-057)', async () => {
    useValidGrant();
    stubRegistration({ enabled: true, first: PRF_OUTPUT });
    mocks.registerPasskey
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(problem(401, 'reauth_invalid'));
    const onRegistered = vi.fn();
    const onOpenChange = vi.fn();
    renderDialog(onRegistered, onOpenChange, 'en');
    fireEvent.change(await screen.findByLabelText('Passkey name'), { target: { value: 'Key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('alert', undefined, { timeout: 5_000 })).toHaveTextContent(
      'Could not confirm whether the passkey was saved; check your passkey list in Settings before removing anything from your device.',
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(mocks.vault.reloadVaultMeta).toHaveBeenCalledTimes(1);
    expect(onRegistered).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mocks.registerPasskey).toHaveBeenCalledTimes(2);
    expect(mocks.registerPasskey.mock.calls[1]).toEqual(mocks.registerPasskey.mock.calls[0]);

    cleanup();
    mocks.vault.reloadVaultMeta.mockClear();
    mocks.registerPasskey.mockReset();
    mocks.registerPasskey
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(problem(503, 'vault_mutations_disabled'));
    renderDialog(undefined, undefined, 'vi');
    fireEvent.change(await screen.findByLabelText('Tên passkey'), { target: { value: 'Key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
    expect(await screen.findByRole('alert', undefined, { timeout: 5_000 })).toHaveTextContent(
      'Không thể xác nhận passkey đã lưu hay chưa; hãy kiểm tra danh sách passkey trong Settings trước khi xoá bất kỳ mục nào khỏi thiết bị của bạn.',
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(mocks.vault.reloadVaultMeta).toHaveBeenCalledTimes(1);
  });

  it('closing the dialog while the re-auth prompt is open cancels the re-auth', async () => {
    mocks.reauth.pendingAction = 'vault.passkey_register';
    const onOpenChange = vi.fn();
    renderDialog(undefined, onOpenChange);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(mocks.reauth.cancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('PKW-R1-24: cancelling the follow-up get() shows passkey.register_cancelled AND the orphan notice', async () => {
    useValidGrant();
    stubRegistration({ enabled: true });
    const get = vi.fn().mockRejectedValue(domError('NotAllowedError'));
    Object.defineProperty(navigator, 'credentials', {
      value: { create: mocks.credentialsCreate, get },
      configurable: true,
    });
    renderDialog();
    fireEvent.change(await screen.findByLabelText('Passkey name'), { target: { value: 'Key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Passkey registration was cancelled.');
    expect(await screen.findByRole('status')).toHaveTextContent(/delete the extra credential/);
  });

  it('PKW-R2-3, PKW-R1-9: unmounting while the POST is in flight suppresses onRegistered and onOpenChange after the operation settles', async () => {
    useValidGrant();
    stubRegistration({ enabled: true, first: PRF_OUTPUT });

    // 1. Hook-level proof: awaits the outer register() promise that invokes onRegistered before asserting.
    const postHook = Promise.withResolvers<typeof SAVED>();
    mocks.registerPasskey.mockReturnValueOnce(postHook.promise);
    const onHookRegistered = vi.fn();
    let registerTask: Promise<PasskeyRegisterOutcome> | null = null;
    function RegisterProbe() {
      const { register } = usePasskeyRegister({
        returnPath: '/app/settings',
        onRegistered: onHookRegistered,
      });
      return (
        <button
          type="button"
          onClick={() => {
            registerTask = register('Key');
          }}
        >
          Start register
        </button>
      );
    }
    const probeView = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RegisterProbe />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start register' }));
    await waitFor(() => expect(mocks.registerPasskey).toHaveBeenCalledTimes(1));
    probeView.unmount();
    let outcome: PasskeyRegisterOutcome | null = null;
    await act(async () => {
      postHook.resolve(SAVED);
      outcome = await registerTask!;
    });
    expect(outcome).toEqual({ ok: true, passkey: SAVED });
    expect(onHookRegistered).not.toHaveBeenCalled();

    // 2. Dialog-level proof: drains the full continuation inside async act() after POST resolves.
    const postDialog = Promise.withResolvers<typeof SAVED>();
    mocks.registerPasskey.mockReturnValueOnce(postDialog.promise);
    const onRegistered = vi.fn();
    const onOpenChange = vi.fn();
    const view = renderDialog(onRegistered, onOpenChange);
    fireEvent.change(await screen.findByLabelText('Passkey name'), { target: { value: 'Key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mocks.registerPasskey).toHaveBeenCalledTimes(2));
    view.unmount();
    await act(async () => {
      postDialog.resolve(SAVED);
      await postDialog.promise;
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    });
    expect(onRegistered).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('PKW-R1-11: post-wrap renewal for a password+Google user shows only the password field, never the Google redirect', async () => {
    mocks.reauth.grant = {
      grant: 'grant-expiring-soon',
      action: 'vault.passkey_register',
      expires_at: new Date(Date.now() + 20_000).toISOString(),
    };
    mocks.reauth.hasUsableGrant.mockImplementation(() => true);
    stubRegistration({ enabled: true, first: PRF_OUTPUT });
    const { promise: renewedGrant, resolve: resolveRenewal } = Promise.withResolvers<{
      grant: string;
      action: string;
      expires_at: string;
    }>();
    mocks.reauth.begin.mockImplementationOnce(() => {
      mocks.reauth.pendingAction = 'vault.passkey_register';
      mocks.reauth.hasUsableGrant.mockImplementation(() => false);
      return renewedGrant as unknown as Promise<never>;
    });
    mocks.registerPasskey.mockResolvedValue(SAVED);

    const view = renderDialog();
    fireEvent.change(await screen.findByLabelText('Passkey name'), { target: { value: 'Key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mocks.reauth.begin).toHaveBeenCalledTimes(1));
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PasskeyAddDialog open onOpenChange={() => {}} returnPath="/app/settings" />
      </NextIntlClientProvider>,
    );
    expect(await screen.findByLabelText('Login password')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm with Google' })).toBeNull();
    resolveRenewal({
      grant: 'grant-renewed',
      action: 'vault.passkey_register',
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    await waitFor(() => expect(mocks.registerPasskey).toHaveBeenCalledTimes(1));
  });

  it('PKW-R1-16: a user with no password and no OAuth provider gets the password-enrollment link (or a clear status notice)', async () => {
    mocks.reauth.pendingAction = 'vault.passkey_register';
    mocks.reauth.capabilities = {
      hasPassword: false,
      oauthReauthProviders: [],
      passwordEnrollmentAvailable: true,
    };
    const onOpenChange = vi.fn();
    renderDialog(undefined, onOpenChange);
    const link = await screen.findByRole('link', { name: 'Send password setup email' });
    expect(link).toHaveAttribute('href', '/app/auth/password-enroll');
    fireEvent.click(link);
    expect(mocks.reauth.cancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    cleanup();
    mocks.reauth.capabilities = {
      hasPassword: false,
      oauthReauthProviders: [],
      passwordEnrollmentAvailable: false,
    };
    renderDialog();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'No re-authentication method is available for this account.',
    );
  });

  it('PKW-R1-17: a rejected Google re-auth start shows an error alert and re-enables the button after its pending state', async () => {
    mocks.reauth.pendingAction = 'vault.passkey_register';
    mocks.reauth.capabilities = {
      hasPassword: false,
      oauthReauthProviders: ['google'],
      passwordEnrollmentAvailable: false,
    };
    const { promise, reject } = Promise.withResolvers<void>();
    mocks.reauth.startOauthReauth.mockReturnValueOnce(promise);
    renderDialog();
    const googleBtn = await screen.findByRole('button', { name: 'Confirm with Google' });
    fireEvent.click(googleBtn);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDisabled());
    reject(new TypeError('Failed to fetch'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start Google re-authentication. Try again.');
    expect(screen.getByRole('button', { name: 'Confirm with Google' })).toBeEnabled();
  });

  it('PKW-R1-18: Cancel and Escape return focus to the Add-passkey opener', async () => {
    mocks.reauth.pendingAction = 'vault.passkey_register';
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PasskeyAddEntry returnPath="/app/settings" />
      </NextIntlClientProvider>,
    );
    const opener = screen.getByRole('button', { name: 'Add passkey' });
    opener.focus();
    expect(document.activeElement).toBe(opener);
    fireEvent.click(opener);
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);

    opener.focus();
    fireEvent.click(opener);
    const dlg = await screen.findByRole('dialog');
    fireEvent.keyDown(dlg, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('PKW-R1-19: the password-visibility toggle uses English and Vietnamese labels from the locale', async () => {
    mocks.reauth.pendingAction = 'vault.passkey_register';
    renderDialog(undefined, undefined, 'en');
    const enToggle = await screen.findByRole('button', { name: 'Show password' });
    expect(enToggle).toHaveTextContent('Show password');
    fireEvent.click(enToggle);
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveTextContent('Hide password');

    cleanup();
    renderDialog(undefined, undefined, 'vi');
    const viToggle = await screen.findByRole('button', { name: 'Hiện mật khẩu' });
    expect(viToggle).toHaveTextContent('Hiện mật khẩu');
    fireEvent.click(viToggle);
    expect(screen.getByRole('button', { name: 'Ẩn mật khẩu' })).toHaveTextContent('Ẩn mật khẩu');
  });
});
