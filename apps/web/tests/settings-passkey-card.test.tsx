import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PasskeySecurityCard } from '@/features/settings/security/passkey-card';
import enMessages from '@/messages/en.json';

const mocks = vi.hoisted(() => ({
  optionalVault: null as unknown,
  begin: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock('@/features/vault/vault-provider', () => ({
  useOptionalVault: () => mocks.optionalVault,
  useVault: () => ({
    getClient: () => ({}),
    registerSecretFormReset: () => () => {},
  }),
}));

vi.mock('@/features/auth/session-provider', () => ({
  useSession: () => ({
    reauth: {
      grant: null,
      pendingAction: null,
      error: null,
      submitting: false,
      capabilities: { hasPassword: true, oauthReauthProviders: [] as string[] },
      begin: mocks.begin,
      cancel: () => {},
      hasUsableGrant: () => false,
    },
  }),
}));

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PasskeySecurityCard />
    </NextIntlClientProvider>,
  );
}

function vaultWith(workerState: string) {
  return { workerState, reloadVaultMeta: async () => null };
}

describe('Settings passkey card mount (T19, advisor-dec-047)', () => {
  beforeEach(() => {
    mocks.begin.mockClear();
    mocks.optionalVault = null;
  });
  afterEach(cleanup);

  it('shows the Add passkey entry while the vault is unlocked', () => {
    mocks.optionalVault = vaultWith('unlocked');
    renderCard();
    const card = screen.getByTestId('settings-passkey-card');
    expect(card).toHaveTextContent('Passkey');
    expect(screen.getByRole('button', { name: 'Add passkey' })).toBeEnabled();
  });

  it.each(['locked', 'recovering', 'error'])('is absent while the vault worker is %s', (workerState) => {
    mocks.optionalVault = vaultWith(workerState);
    renderCard();
    expect(screen.queryByTestId('settings-passkey-card')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add passkey' })).toBeNull();
  });

  it('is absent without a vault provider', () => {
    renderCard();
    expect(screen.queryByTestId('settings-passkey-card')).toBeNull();
  });

  it('pressing Add passkey opens the naming dialog and takes the registration grant first', () => {
    mocks.optionalVault = vaultWith('unlocked');
    renderCard();
    expect(mocks.begin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Add a passkey');
    expect(mocks.begin).toHaveBeenCalledWith('vault.passkey_register', '/app/settings');
  });
});
