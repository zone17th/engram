import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultState } from '@/lib/api/vault';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';
import { PasskeyUnlockButton } from './passkey-unlock-button';
import { CRED_A, PRF_OUTPUT, domError, fakeCredential, problem, unlockOptionsResponse } from './test-helpers';
import type { PasskeyUnlockOutcome } from './unlock-flow';
import { usePasskeyUnlock } from './use-passkey-unlock';

const mocks = vi.hoisted(() => ({
  vault: {
    inFlight: false,
    vaultMeta: null as unknown,
    beginOp: () => ({ opGeneration: 1 }),
    getClient: () => ({ getGeneration: () => 1 }),
    reloadVaultMeta: vi.fn(async () => ({ private_keys_wrapped: 'PRIV-WRAP-OPAQUE' }) as unknown as VaultState),
    unlockPrf: vi.fn(async (params: unknown) => {
      void params;
      return { unlocked: true as const };
    }),
    lock: vi.fn(async (options: unknown) => {
      void options;
    }),
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

function stubAssertion() {
  mocks.fetchPasskeyUnlockOptions.mockResolvedValue(unlockOptionsResponse());
  mocks.credentialsGet.mockResolvedValue(
    fakeCredential({ rawId: CRED_A.id, prf: { enabled: true, first: PRF_OUTPUT } }).credential,
  );
}

describe('T19 bullet 2 - PasskeyUnlockButton', () => {
  beforeEach(() => {
    mocks.fetchPasskeyUnlockOptions.mockReset();
    mocks.credentialsGet.mockReset();
    mocks.vault.unlockPrf.mockClear();
    mocks.vault.lock.mockClear();
    mocks.vault.reloadVaultMeta.mockClear();
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

  it('renders nothing when the vault metadata has no passkey list yet', async () => {
    mocks.vault.vaultMeta = null;
    const { container } = renderButton();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('loads the vault metadata once when the unlock screen has none (fresh page load)', async () => {
    mocks.vault.vaultMeta = null;
    renderButton();
    await waitFor(() => expect(mocks.vault.reloadVaultMeta).toHaveBeenCalledTimes(1));
  });

  it('PKW-R2-4: a transient bootstrap GET /vault failure shows a localized retry state and reveals the passkey button on retry', async () => {
    mocks.vault.vaultMeta = null;
    mocks.vault.reloadVaultMeta.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const view = renderButton();
    const status = await screen.findByTestId('unlock-passkey-load-error');
    expect(status).toHaveTextContent('Could not check your registered passkeys.');
    expect(screen.queryByTestId('unlock-passkey-button')).toBeNull();
    expect(mocks.vault.reloadVaultMeta).toHaveBeenCalledTimes(1);

    mocks.vault.reloadVaultMeta.mockImplementationOnce(async () => {
      setPasskeys(1);
      return mocks.vault.vaultMeta as unknown as VaultState;
    });
    fireEvent.click(screen.getByTestId('unlock-passkey-retry-button'));
    await waitFor(() => expect(mocks.vault.reloadVaultMeta).toHaveBeenCalledTimes(2));
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PasskeyUnlockButton />
      </NextIntlClientProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Unlock with passkey' })).toBeEnabled();
    expect(screen.queryByTestId('unlock-passkey-load-error')).toBeNull();

    // Vietnamese copy parity for the failed-load state.
    cleanup();
    mocks.vault.vaultMeta = null;
    mocks.vault.reloadVaultMeta.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderButton(undefined, 'vi');
    expect(await screen.findByTestId('unlock-passkey-load-error')).toHaveTextContent(
      'Không kiểm tra được danh sách passkey đã đăng ký.',
    );
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeEnabled();
  });

  it('PKW-R3-4: Retry keeps its busy control mounted and preserves keyboard focus across pending, repeated failure, and successful handoff', async () => {
    mocks.vault.vaultMeta = null;
    mocks.vault.reloadVaultMeta.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const view = renderButton();
    const retryBtn = await screen.findByTestId('unlock-passkey-retry-button');
    retryBtn.focus();
    expect(document.activeElement).toBe(retryBtn);
    expect(retryBtn).toHaveAttribute('aria-busy', 'false');

    // 1. Deferred retry that fails again: control stays mounted (`aria-busy="true"`), ignores duplicate clicks, and keeps focus.
    const firstRetry = Promise.withResolvers<VaultState>();
    mocks.vault.reloadVaultMeta.mockReturnValueOnce(firstRetry.promise);
    fireEvent.click(retryBtn);

    await waitFor(() => expect(retryBtn).toHaveAttribute('aria-busy', 'true'));
    expect(retryBtn).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('unlock-passkey-load-error')).toBeInTheDocument();
    expect(document.activeElement).toBe(retryBtn);

    // Clicking while pending starts no second request.
    fireEvent.click(retryBtn);
    expect(mocks.vault.reloadVaultMeta).toHaveBeenCalledTimes(2);

    await act(async () => {
      firstRetry.reject(new TypeError('Still offline'));
      await firstRetry.promise.catch(() => undefined);
    });
    expect(retryBtn).toHaveAttribute('aria-busy', 'false');
    expect(retryBtn).not.toHaveAttribute('aria-disabled');
    expect(document.activeElement).toBe(retryBtn);

    // 2. Deferred retry that succeeds and discovers passkeys: control stays mounted while pending, then hands focus to Unlock with passkey.
    const secondRetry = Promise.withResolvers<VaultState>();
    mocks.vault.reloadVaultMeta.mockReturnValueOnce(secondRetry.promise);
    fireEvent.click(retryBtn);

    await waitFor(() => expect(retryBtn).toHaveAttribute('aria-busy', 'true'));
    expect(document.activeElement).toBe(retryBtn);

    await act(async () => {
      setPasskeys(1);
      secondRetry.resolve(mocks.vault.vaultMeta as unknown as VaultState);
      await secondRetry.promise;
    });
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PasskeyUnlockButton />
      </NextIntlClientProvider>,
    );
    const unlockBtn = await screen.findByTestId('unlock-passkey-button');
    expect(document.activeElement).toBe(unlockBtn);
    expect(screen.queryByTestId('unlock-passkey-load-error')).toBeNull();
  });

  it('does not reload the vault metadata when the passkey list is already known', async () => {
    setPasskeys(1);
    renderButton();
    expect(await screen.findByRole('button', { name: 'Unlock with passkey' })).toBeEnabled();
    expect(mocks.vault.reloadVaultMeta).not.toHaveBeenCalled();
  });

  it('does not load the vault metadata in a browser without WebAuthn', async () => {
    mocks.vault.vaultMeta = null;
    Reflect.deleteProperty(window, 'PublicKeyCredential');
    const { container } = renderButton();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(mocks.vault.reloadVaultMeta).not.toHaveBeenCalled();
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
    expect(await screen.findByRole('button', { name: 'Unlock with passkey' })).toBeEnabled();
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

  it('is disabled while another unlock or vault operation is in flight, and starts nothing', async () => {
    setPasskeys(1);
    mocks.vault.inFlight = true;
    renderButton();
    const button = await screen.findByRole('button', { name: 'Unlock with passkey' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mocks.fetchPasskeyUnlockOptions).not.toHaveBeenCalled();
    expect(mocks.credentialsGet).not.toHaveBeenCalled();
  });

  it('CLIENT_BUSY raised by the Worker slot shows the busy copy, never a wrong-key message', async () => {
    setPasskeys(1);
    stubAssertion();
    mocks.vault.unlockPrf.mockRejectedValueOnce({ code: 'CLIENT_BUSY' });
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/another vault operation/i);
  });

  it('a cancelled prompt shows the exact passkey.unlock_cancelled copy and keeps the button usable', async () => {
    setPasskeys(1);
    mocks.fetchPasskeyUnlockOptions.mockResolvedValue(unlockOptionsResponse());
    mocks.credentialsGet.mockRejectedValue(domError('NotAllowedError'));
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Passkey prompt was cancelled.');
    expect(screen.getByRole('button', { name: 'Unlock with passkey' })).toBeEnabled();
  });

  it('an authenticator that returns no PRF shows passkey.unlock_prf_missing', async () => {
    setPasskeys(1);
    mocks.fetchPasskeyUnlockOptions.mockResolvedValue(unlockOptionsResponse());
    mocks.credentialsGet.mockResolvedValue(fakeCredential({ rawId: CRED_A.id, prf: { enabled: true } }).credential);
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Authenticator did not return PRF. Cannot unlock with passkey.',
    );
  });

  it('a successful assertion unlocks and calls onUnlocked', async () => {
    setPasskeys(2);
    const onUnlocked = vi.fn();
    stubAssertion();
    renderButton(onUnlocked);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with passkey' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(mocks.vault.unlockPrf).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('PKW-R1-12..15: leaving the screen while the prompt is open stops before Worker admission, locks, reports abandoned and never calls onUnlocked', async () => {
    setPasskeys(1);
    let release: (value: unknown) => void = () => {};
    mocks.fetchPasskeyUnlockOptions.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    mocks.credentialsGet.mockResolvedValue(
      fakeCredential({ rawId: CRED_A.id, prf: { enabled: true, first: PRF_OUTPUT } }).credential,
    );
    const onUnlocked = vi.fn();
    const view = renderButton(onUnlocked);
    fireEvent.click(await screen.findByRole('button', { name: 'Unlock with passkey' }));
    await waitFor(() => expect(mocks.fetchPasskeyUnlockOptions).toHaveBeenCalledTimes(1));
    view.unmount();
    release(unlockOptionsResponse());
    await waitFor(() => expect(mocks.vault.lock).toHaveBeenCalledTimes(1));
    expect(mocks.vault.lock).toHaveBeenCalledWith({ broadcast: false, reason: 'passkey_unlock_abandoned' });
    expect(mocks.vault.unlockPrf).not.toHaveBeenCalled();
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('PKW-R1-12..15: leaving the screen while unlockPrf is already in flight locks, resolves abandoned and never calls onUnlocked', async () => {
    setPasskeys(1);
    mocks.fetchPasskeyUnlockOptions.mockResolvedValue(unlockOptionsResponse());
    mocks.credentialsGet.mockResolvedValue(
      fakeCredential({ rawId: CRED_A.id, prf: { enabled: true, first: PRF_OUTPUT } }).credential,
    );
    let finishWorker: (value: { unlocked: true }) => void = () => {};
    mocks.vault.unlockPrf.mockImplementationOnce(
      () => new Promise((resolve) => (finishWorker = resolve)),
    );

    let resolved: PasskeyUnlockOutcome | null = null;
    const onUnlocked = vi.fn();
    function Probe() {
      const { unlock } = usePasskeyUnlock();
      return (
        <button
          type="button"
          onClick={() => {
            void unlock().then((outcome) => {
              resolved = outcome;
              if (outcome.ok) onUnlocked();
            });
          }}
        >
          Probe unlock
        </button>
      );
    }
    const view = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <Probe />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Probe unlock' }));
    await waitFor(() => expect(mocks.vault.unlockPrf).toHaveBeenCalledTimes(1));
    view.unmount();
    finishWorker({ unlocked: true });
    await waitFor(() => expect(resolved).toEqual({ ok: false, error: 'abandoned' }));
    expect(mocks.vault.lock).toHaveBeenCalledWith({ broadcast: false, reason: 'passkey_unlock_abandoned' });
    expect(onUnlocked).not.toHaveBeenCalled();
  });
});
