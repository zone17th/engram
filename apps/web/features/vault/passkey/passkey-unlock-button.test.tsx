import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultState } from '@/lib/api/vault';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';
import { PasskeyUnlockButton } from './passkey-unlock-button';
import { CRED_A, PRF_OUTPUT, domError, fakeCredential, problem, unlockOptionsResponse } from './test-helpers';

const mocks = vi.hoisted(() => ({
  vault: {
    inFlight: false,
    vaultMeta: null as unknown,
    beginOp: () => ({ opGeneration: 1 }),
    getClient: () => ({ getGeneration: () => 1 }),
    reloadVaultMeta: async () => ({ private_keys_wrapped: 'PRIV-WRAP-OPAQUE' }) as unknown as VaultState,
    unlockPrf: async (params: unknown) => {
      void params;
      return { unlocked: true as const };
    },
  },
  fetchPasskeyUnlockOptions: vi.fn(),
  credentialsGet: vi.fn(),
}));

vi.mock('@/features/vault/vault-provider', () => ({ useVault: () => mocks.vault }));
vi.mock('@/lib/api/vault', () => ({ fetchPasskeyUnlockOptions: mocks.fetchPasskeyUnlockOptions }));

function setPasskeys(count: number) {
  mocks.vault.vaultMeta = {
    passkeys: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, name: `Key ${i}`, aaguid: null, created_at: '' })),
  };
}

function renderButton(onUnlocked?: () => void, locale: 'en' | 'vi' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? enMessages : viMessages}>
      <PasskeyUnlockButton onUnlocked={onUnlocked} />
    </NextIntlClientProvider>,
  );
}

describe('T19 bullet 2 - PasskeyUnlockButton', () => {
  beforeEach(() => {
    mocks.fetchPasskeyUnlockOptions.mockReset();
    mocks.credentialsGet.mockReset();
    mocks.vault.inFlight = false;
    Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true, writable: true });
    Object.defineProperty(navigator, 'credentials', {
      value: { get: mocks.credentialsGet },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'PublicKeyCredential');
  });

  it('renders nothing when the user has no passkey', async () => {
    setPasskeys(0);
    const { container } = renderButton();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing when the browser has no WebAuthn', async () => {
    setPasskeys(2);
    Reflect.deleteProperty(window, 'PublicKeyCredential');
    const { container } = renderButton();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows the button (en and vi copy) when passkeys exist', async () => {
    setPasskeys(1);
    renderButton();
    expect(await screen.findByRole('button', { name: 'Unlock with passkey' })).toBeInTheDocument();
    cleanup();
    renderButton(undefined, 'vi');
    expect(await screen.findByRole('button', { name: 'Mở khoá bằng passkey' })).toBeInTheDocument();
  });

  it('404 passkey_not_found hides the button', async () => {
    setPasskeys(1);
    mocks.fetchPasskeyUnlockOptions.mockRejectedValue(problem(404, 'passkey_not_found'));
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with passkey' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unlock with passkey' })).toBeNull());
  });

  it('a cancelled prompt shows the exact passkey.unlock_cancelled copy and keeps the button', async () => {
    setPasskeys(1);
    mocks.fetchPasskeyUnlockOptions.mockResolvedValue(unlockOptionsResponse());
    mocks.credentialsGet.mockRejectedValue(domError('NotAllowedError'));
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Passkey prompt was cancelled.');
    expect(screen.getByRole('button', { name: 'Unlock with passkey' })).toBeEnabled();
  });

  it('a successful assertion unlocks and calls onUnlocked', async () => {
    setPasskeys(2);
    const onUnlocked = vi.fn();
    mocks.fetchPasskeyUnlockOptions.mockResolvedValue(unlockOptionsResponse());
    mocks.credentialsGet.mockResolvedValue(
      fakeCredential({ rawId: CRED_A.id, prf: { enabled: true, first: PRF_OUTPUT } }).credential,
    );
    renderButton(onUnlocked);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with passkey' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses while another vault operation is in flight (CLIENT_BUSY copy), without a prompt', async () => {
    setPasskeys(1);
    mocks.vault.inFlight = true;
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/another vault operation/i);
    expect(mocks.fetchPasskeyUnlockOptions).not.toHaveBeenCalled();
    expect(mocks.credentialsGet).not.toHaveBeenCalled();
  });
});
