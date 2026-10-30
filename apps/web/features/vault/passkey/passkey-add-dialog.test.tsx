import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import enMessages from '@/messages/en.json';
import { PasskeyAddDialog } from './passkey-add-dialog';
import {
  NEW_CREDENTIAL_ID,
  PRF_OUTPUT,
  domError,
  fakeCredential,
  problem,
  registerOptionsResponse,
} from './test-helpers';

const mocks = vi.hoisted(() => ({
  reauth: {
    grant: null as unknown,
    pendingAction: null as string | null,
    error: null as string | null,
    submitting: false,
    capabilities: { hasPassword: true, oauthReauthProviders: ['google'] as string[] },
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

function renderDialog(onRegistered?: () => void, onOpenChange: (open: boolean) => void = () => {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
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
    mocks.reauth.capabilities = { hasPassword: true, oauthReauthProviders: ['google'] };
    mocks.reauth.begin.mockClear();
    mocks.reauth.cancel.mockClear();
    mocks.reauth.submitPassword.mockClear();
    mocks.reauth.startOauthReauth.mockClear();
    mocks.reauth.hasUsableGrant.mockImplementation(() => false);
    mocks.fetchPasskeyRegisterOptions.mockReset();
    mocks.registerPasskey.mockReset();
    mocks.credentialsCreate.mockReset();
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
    mocks.reauth.capabilities = { hasPassword: false, oauthReauthProviders: ['google'] };
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

  it('closing the dialog while the re-auth prompt is open cancels the re-auth', async () => {
    mocks.reauth.pendingAction = 'vault.passkey_register';
    const onOpenChange = vi.fn();
    renderDialog(undefined, onOpenChange);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(mocks.reauth.cancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
