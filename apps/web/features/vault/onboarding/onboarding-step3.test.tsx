import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import { SessionProvider } from '@/features/auth/session-provider';
import { resetVaultBroadcastForTests } from '@/features/vault/broadcast';
import {
  DEVKEY_STORE_NAME,
  type LockEpochEnvironment,
} from '@/features/vault/lock-epoch';
import { setDefaultDeviceStoreEnvironmentForTests } from '@/features/vault/device-store';
import {
  NEW_CREDENTIAL_ID,
  PRF_OUTPUT,
  domError,
  fakeCredential,
  registerOptionsResponse,
} from '@/features/vault/passkey/test-helpers';
import { VaultOnboardingFlow } from '@/features/vault/onboarding';
import { VaultProvider } from '@/features/vault/vault-provider';
import type { Me } from '@/lib/api/auth';
import type { CreateVaultResult, CryptoWorkerPort } from '@/lib/crypto/client';
import { DEVKEY_WRAPPED_VK_BYTES } from '@/lib/crypto/device';
import { FakeDeviceIdb, FakeWebLocks } from '@/lib/crypto/test/fake-device-idb';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';
const STRONG_PASSPHRASE = 'Tr\u00e0m-H\u01b0\u01a1ng-94!K\u1ef7-V\u1eadt-Xanh';

const routerMocks = vi.hoisted(() => ({
  pathname: '/app/onboarding',
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => routerMocks.pathname,
  useRouter: () => ({ replace: routerMocks.replace, push: routerMocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeMeFixture(vaultStatus: 'absent' | 'present' = 'absent'): Me {
  return {
    user: {
      id: 'user-onboarding-step3-test-1',
      email: 'minh@zone17th.click',
      email_verified: true,
      created_at: '2026-10-30T00:00:00Z',
    },
    settings: {
      locale: 'en',
      theme: 'light',
      auto_lock_minutes: 15,
      semantic_suggest: true,
    },
    identities: [{ provider: 'password', linked_at: '2026-10-30T00:00:00Z' }],
    features: {
      semantic_available: true,
      email_verification_required: false,
      oauth_providers: [],
      oauth_reauth_providers: [],
      password_enrollment_available: false,
      captcha_site_key: null,
    },
    vault: { status: vaultStatus },
  };
}

function makeSimpleLockEpochEnv(): LockEpochEnvironment {
  let marker = { epochIncarnation: 'inc-step3-test-1', lockEpoch: 1 };
  const fakeIdb = {
    open() {
      const req: Record<string, unknown> = {
        result: {
          objectStoreNames: { contains: () => true },
          transaction() {
            let pending = 0;
            const tx: Record<string, unknown> = {
              objectStore() {
                const scheduleComplete = () => {
                  if (pending === 0) {
                    queueMicrotask(() => {
                      if (pending === 0 && typeof tx.oncomplete === 'function') {
                        tx.oncomplete();
                      }
                    });
                  }
                };
                return {
                  get() {
                    pending += 1;
                    const getReq: Record<string, unknown> = { result: marker };
                    queueMicrotask(() => {
                      pending -= 1;
                      if (typeof getReq.onsuccess === 'function') getReq.onsuccess();
                      scheduleComplete();
                    });
                    return getReq;
                  },
                  put(val: typeof marker) {
                    pending += 1;
                    marker = val;
                    const putReq: Record<string, unknown> = { result: undefined };
                    queueMicrotask(() => {
                      pending -= 1;
                      if (typeof putReq.onsuccess === 'function') putReq.onsuccess();
                      scheduleComplete();
                    });
                    return putReq;
                  },
                  delete() {
                    pending += 1;
                    const delReq: Record<string, unknown> = { result: undefined };
                    queueMicrotask(() => {
                      pending -= 1;
                      if (typeof delReq.onsuccess === 'function') delReq.onsuccess();
                      scheduleComplete();
                    });
                    return delReq;
                  },
                };
              },
            };
            return tx;
          },
          close() {},
        },
      };
      queueMicrotask(() => {
        if (typeof req.onsuccess === 'function') req.onsuccess();
      });
      return req;
    },
  } as unknown as IDBFactory;

  return {
    idbFactory: fakeIdb,
    locksManager: {
      request: async (_name: string, _opts: unknown, cb: () => Promise<unknown>) => cb(),
    } as unknown as LockManager,
  };
}

function makeOnboardingStep3WorkerFactory(): () => CryptoWorkerPort {
  return () => {
    let generation = 0;
    let epoch = 0;
    let mode: 'locked' | 'unlocked' | 'recovering' = 'locked';
    let onMessage: ((event: MessageEvent) => void) | null = null;

    const fakeResult: CreateVaultResult = {
      kdf: {
        alg: 'argon2id13',
        ops: 3,
        mem: 67_108_864,
        parallelism: 1,
        salt: 'oKGio6SlpqeoqaqrrK2urw',
      },
      vault_key_wrapped_by_kek:
        'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA',
      x25519_public: '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff',
      ed25519_public: 'ffeeddccbbaa00998877665544332211ffeeddccbbaa00998877665544332211',
      private_keys_wrapped:
        'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-',
      recovery_keys: Array.from({ length: 10 }, (_, idx) => {
        const slot = idx + 1;
        const suffix = String(slot).padStart(2, '0');
        return {
          slot,
          display: `rk${slot}_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-${suffix}`,
          lookup_hash: `lookup_hash_slot_${slot}_base64url_test_value_123456`,
          wrap: `wrap_slot_${slot}_base64url_test_value_1234567890abcdef`,
        };
      }),
    };

    return {
      get onmessage() {
        return onMessage;
      },
      set onmessage(handler) {
        onMessage = handler;
      },
      onerror: null,
      postMessage(message) {
        if ('passphraseBuffer' in message && message.passphraseBuffer) {
          new Uint8Array(message.passphraseBuffer).fill(0);
        }
        if ('pwkBuffer' in message && message.pwkBuffer) {
          new Uint8Array(message.pwkBuffer).fill(0);
        }

        queueMicrotask(() => {
          if (message.type === 'lock') {
            generation = Math.max(generation, message.generation);
            mode = 'locked';
            epoch += 1;
            onMessage?.({
              data: {
                id: message.id,
                generation,
                ok: true,
                state: { mode, generation, epoch },
                result: { generation },
              },
            } as MessageEvent);
            return;
          }

          if (message.type === 'createVault') {
            generation = message.generation;
            mode = 'unlocked';
            epoch += 1;
            onMessage?.({
              data: {
                id: message.id,
                generation,
                ok: true,
                state: { mode, generation, epoch },
                result: fakeResult,
              },
            } as MessageEvent);
            return;
          }

          if (message.type === 'wrapForPasskey') {
            onMessage?.({
              data: {
                id: message.id,
                generation,
                ok: true,
                state: { mode, generation, epoch },
                result: { vk_wrap: 'vk-wrap-passkey-step3-test' },
              },
            } as MessageEvent);
            return;
          }

          if (message.type === 'wrapForDevice') {
            onMessage?.({
              data: {
                id: message.id,
                generation,
                ok: true,
                state: { mode, generation, epoch },
                result: { wrapped_vk: new Uint8Array(DEVKEY_WRAPPED_VK_BYTES).fill(0x42) },
              },
            } as MessageEvent);
            return;
          }
        });
      },
      terminate() {
        onMessage = null;
      },
    };
  };
}

describe('P03-T16B — Onboarding Step 3 (Optional Add Passkey & Skip)', () => {
  let idb: FakeDeviceIdb;
  let locks: FakeWebLocks;

  beforeEach(() => {
    routerMocks.pathname = '/app/onboarding';
    routerMocks.replace.mockReset();
    routerMocks.push.mockReset();
    resetVaultBroadcastForTests();
    window.localStorage.clear();
    window.sessionStorage.clear();
    locks = new FakeWebLocks();
    idb = new FakeDeviceIdb(locks);
    vi.stubGlobal('indexedDB', idb.createFactory());
    vi.stubGlobal('navigator', { ...navigator, locks: locks.createLockManager() });
    setDefaultDeviceStoreEnvironmentForTests({ idbFactory: idb.createFactory() });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function advanceToStep3(locale: 'en' | 'vi' = 'en') {
    let currentMe = makeMeFixture('absent');
    const credentialsCreate = vi.fn();
    Object.defineProperty(navigator, 'credentials', {
      value: { create: credentialsCreate, get: vi.fn() },
      configurable: true,
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(currentMe);
      if (url.endsWith('/vault') && init?.method === 'POST') {
        currentMe = makeMeFixture('present');
        return jsonResponse({ vault_key_id: 'vk:7f3a9b2c4d5e6f7a8b9c0d', version: 1 }, 201);
      }
      if (url.endsWith('/vault') && (!init?.method || init.method === 'GET')) {
        return jsonResponse({
          version: 1,
          vault_key_id: 'vk:7f3a9b2c4d5e6f7a8b9c0d',
          kdf: {
            alg: 'argon2id13',
            ops: 3,
            mem: 67_108_864,
            parallelism: 1,
            salt: 'oKGio6SlpqeoqaqrrK2urw',
          },
          vault_key_wrapped_by_kek:
            'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA',
          x25519_public: '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff',
          ed25519_public: 'ffeeddccbbaa00998877665544332211ffeeddccbbaa00998877665544332211',
          private_keys_wrapped:
            'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-',
          recovery_keys_remaining: 10,
          passkeys: [],
        });
      }
      if (url.endsWith('/auth/reauth') && init?.method === 'POST') {
        return jsonResponse({
          grant: 'grant-passkey-register-token',
          action: 'vault.passkey_register',
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        });
      }
      if (url.endsWith('/vault/passkeys/register/options') && init?.method === 'POST') {
        return jsonResponse(registerOptionsResponse());
      }
      if (url.endsWith('/vault/passkeys') && init?.method === 'POST') {
        return jsonResponse(
          {
            id: 'passkey-step3-1',
            name: 'Onboarding laptop',
            aaguid: null,
            created_at: '2026-10-30T00:00:00Z',
          },
          201,
        );
      }
      return jsonResponse({});
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <NextIntlClientProvider
        locale={locale}
        messages={locale === 'vi' ? viMessages : enMessages}
      >
        <ThemeProvider>
          <QueryClientProvider client={qc}>
            <SessionProvider>
              <VaultProvider
                createWorker={makeOnboardingStep3WorkerFactory()}
                lockEpochEnv={makeSimpleLockEpochEnv()}
              >
                <VaultOnboardingFlow />
              </VaultProvider>
            </SessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-passphrase')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/^Passphrase$/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.change(
      screen.getByLabelText(locale === 'en' ? /Confirm passphrase/i : /Gõ lại passphrase/i),
      { target: { value: STRONG_PASSPHRASE } },
    );
    fireEvent.click(screen.getByTestId('onboarding-continue-button'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-recovery-keys')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-create-vault-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-passkey')).toBeInTheDocument();
    });

    return { credentialsCreate };
  }

  it('16B: step 3 renders after RK confirm, remember-device toggle is default off, and Skip goes on to /app without remembering', async () => {
    await advanceToStep3('en');

    expect(screen.getByTestId('onboarding-step-passkey')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-keys-grid')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('rk1_3F8K');

    const rememberSwitch = screen.getByRole('switch', { name: 'Remember this device' });
    expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');

    expect(routerMocks.replace).not.toHaveBeenCalledWith('/app');
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-skip-passkey-button'));
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    });
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(0);
  });

  it('16B: step 3 turning Remember this device on calls remember() and stores DevKey, and toggling off forgets it', async () => {
    await advanceToStep3('en');

    const rememberSwitch = screen.getByTestId('onboarding-remember-device-switch');
    expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');

    await act(async () => {
      fireEvent.click(rememberSwitch);
    });
    await waitFor(() => {
      expect(rememberSwitch).toHaveAttribute('aria-checked', 'true');
    });
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(1);

    // Toggling off calls forget() and removes the record
    await act(async () => {
      fireEvent.click(rememberSwitch);
    });
    await waitFor(() => {
      expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');
    });
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(0);

    // Turn back on and Finish -> goes to /app with the device remembered
    await act(async () => {
      fireEvent.click(rememberSwitch);
    });
    await waitFor(() => {
      expect(rememberSwitch).toHaveAttribute('aria-checked', 'true');
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-finish-button'));
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    });
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(1);
  });

  it('16B: step 3 shows unavailable message when IndexedDB is blocked without blocking Skip or Finish', async () => {
    idb.options.failOpen = true;
    await advanceToStep3('en');

    const unavailableMsg = await screen.findByTestId('onboarding-remember-device-unavailable');
    expect(unavailableMsg).toHaveTextContent(enMessages.vault.device.unavailable);

    const rememberSwitch = screen.getByTestId('onboarding-remember-device-switch');
    expect(rememberSwitch).toBeDisabled();
    expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');

    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-skip-passkey-button'));
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    });
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(0);
  });

  it('16B: step 3 add passkey success goes on to /app', async () => {
    const { credentialsCreate } = await advanceToStep3('en');
    credentialsCreate.mockResolvedValue(
      fakeCredential({ rawId: NEW_CREDENTIAL_ID, prf: { enabled: true, first: PRF_OUTPUT } }).credential,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
    const pwdInput = await screen.findByLabelText('Login password');
    fireEvent.change(pwdInput, { target: { value: 'correct-login-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const continueBtn = await screen.findByRole('button', { name: 'Continue' });
    await waitFor(() => expect(continueBtn).toBeEnabled());

    fireEvent.change(screen.getByLabelText('Passkey name'), {
      target: { value: 'Onboarding laptop' },
    });
    fireEvent.click(continueBtn);

    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    });
  });

  it('16B: step 3 PRF-unsupported and cancel show §5.10 messages and still allow Skip', async () => {
    const { credentialsCreate } = await advanceToStep3('en');

    credentialsCreate.mockResolvedValueOnce(
      fakeCredential({ rawId: NEW_CREDENTIAL_ID, prf: { enabled: false } }).credential,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    const pwdInput = await screen.findByLabelText('Login password');
    fireEvent.change(pwdInput, { target: { value: 'correct-login-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const continueBtn = await screen.findByRole('button', { name: 'Continue' });
    await waitFor(() => expect(continueBtn).toBeEnabled());

    fireEvent.change(screen.getByLabelText('Passkey name'), { target: { value: 'No PRF key' } });
    fireEvent.click(continueBtn);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      enMessages.vault.passkey.prf_unsupported,
    );

    credentialsCreate.mockRejectedValueOnce(domError('NotAllowedError'));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        enMessages.vault.passkey.register_cancelled,
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-skip-passkey-button'));
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    });
  });
});
