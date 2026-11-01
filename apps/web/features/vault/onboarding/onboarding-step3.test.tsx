import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import { SessionProvider, useSession, type SessionState } from '@/features/auth/session-provider';
import { resetVaultBroadcastForTests } from '@/features/vault/broadcast';
import {
  DEVICE_META_RECORD_KEY,
  DEVKEY_STORE_NAME,
  META_STORE_NAME,
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
import { VaultProvider, useVault, type VaultContextValue } from '@/features/vault/vault-provider';
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

function makeMeFixture(
  vaultStatus: 'absent' | 'present' = 'absent',
  options: { oauthOnly?: boolean; userId?: string } = {},
): Me {
  return {
    user: {
      id: options.userId ?? 'user-onboarding-step3-test-1',
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
    identities: options.oauthOnly
      ? [{ provider: 'google', linked_at: '2026-10-30T00:00:00Z' }]
      : [{ provider: 'password', linked_at: '2026-10-30T00:00:00Z' }],
    features: {
      semantic_available: true,
      email_verification_required: false,
      oauth_providers: options.oauthOnly ? ['google'] : [],
      oauth_reauth_providers: options.oauthOnly ? ['google'] : [],
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

// Waits that follow a crypto step (KDF / vault creation in the worker, WebCrypto + IndexedDB for Remember,
// passkey wrap) get an explicit generous timeout, like the 16A suite: Testing Library's default 1000 ms is
// not enough on a cold CI worker (CI-41035830732 flake).
const CRYPTO_WAIT = { timeout: 15_000 };
const CRYPTO_TEST_TIMEOUT = 30_000;

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

  async function advanceToStep3(
    locale: 'en' | 'vi' = 'en',
    options: {
      oauthOnly?: boolean;
      onBeforeGetVault?: () => Promise<void> | void;
      getVaultMode?: 'present' | 'absent_404';
    } = {},
  ) {
    let currentMe = makeMeFixture('absent', options);
    let vaultCtx!: VaultContextValue;
    let sessionCtx!: Pick<SessionState, 'status' | 'me'> & { refetchMe: () => Promise<void> };
    const oauthReauthCalls: Array<{ url: string; body: string }> = [];
    let getVaultCalls = 0;
    // Armed by a test AFTER step 3 rendered: runs on every later GET /vault (the in-lock Remember verification and any
    // provider reload) and may return a different vault_key_id to simulate another tab replacing the vault.
    let vaultGetHook: (() => string | undefined) | null = null;
    let passkeyPosts = 0;
    const savedPasskeys: Array<{ id: string; name: string; aaguid: string | null; created_at: string }> = [];
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
          oauth_providers: options.oauthOnly ? ['google'] : [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(currentMe);
      if (url.endsWith('/vault') && init?.method === 'POST') {
        currentMe = makeMeFixture('present', options);
        return jsonResponse({ vault_key_id: 'vk:7f3a9b2c4d5e6f7a8b9c0d', version: 1 }, 201);
      }
      if (url.endsWith('/vault') && (!init?.method || init.method === 'GET')) {
        getVaultCalls += 1;
        await options.onBeforeGetVault?.();
        if (options.getVaultMode === 'absent_404') {
          return new Response(
            JSON.stringify({
              type: 'https://engram.zone17.click/problems/vault_absent',
              title: 'vault_absent',
              status: 404,
              code: 'vault_absent',
            }),
            {
              status: 404,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        }
        const vkId = vaultGetHook?.() ?? 'vk:7f3a9b2c4d5e6f7a8b9c0d';
        return jsonResponse({
          version: 1,
          vault_key_id: vkId,
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
          passkeys: [...savedPasskeys],
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
        passkeyPosts += 1;
        const item = {
          id: `passkey-step3-${passkeyPosts}`,
          name: 'Onboarding laptop',
          aaguid: null,
          created_at: '2026-10-30T00:00:00Z',
        };
        savedPasskeys.push(item);
        return jsonResponse(item, 201);
      }
      if (url.includes('/auth/oauth/') && url.endsWith('/reauth') && init?.method === 'POST') {
        oauthReauthCalls.push({ url, body: String(init.body ?? '') });
        return jsonResponse({
          authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=step3-test',
        });
      }
      return jsonResponse({});
    });

    function VaultProbe() {
      vaultCtx = useVault();
      sessionCtx = useSession();
      return null;
    }

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
                <VaultProbe />
                <VaultOnboardingFlow />
              </VaultProvider>
            </SessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );
    // Readiness gates (CI-41036636607). The app mounts the flow behind RouteGuard, so `me` is always loaded there; this
    // harness has no guard, and `onboarding-step-passphrase` renders before GET /auth/me resolves. handleStep1Submit
    // captures `opUserId` (null until /me) + `opGeneration` before its first await and silently discards the createVault
    // result when either changed, so submit only once the session and the provider's initial state have settled.
    await waitFor(() => {
      expect(sessionCtx.status).toBe('authenticated_without_vault');
      expect(sessionCtx.me?.user.id).toBeTruthy();
      expect(vaultCtx.state).toBe('no_vault');
      expect(vaultCtx.workerState).toBe('locked');
      expect(vaultCtx.inFlight).toBe(false);
      expect(screen.getByTestId('onboarding-step-passphrase')).toBeInTheDocument();
    }, CRYPTO_WAIT);
    const passInput = screen.getByLabelText(/^Passphrase$/i);
    const confirmInput = screen.getByLabelText(
      locale === 'en' ? /Confirm passphrase/i : /Gõ lại passphrase/i,
    );
    fireEvent.change(passInput, { target: { value: STRONG_PASSPHRASE } });
    fireEvent.change(confirmInput, { target: { value: STRONG_PASSPHRASE } });
    // zxcvbn is lazy-loaded: wait until the live policy evaluation accepted the passphrase before submitting.
    await waitFor(() => {
      expect(screen.getByTestId('rule-min-length')).toHaveAttribute('data-satisfied', 'true');
      expect(screen.getByTestId('rule-min-score')).toHaveAttribute('data-satisfied', 'true');
    }, CRYPTO_WAIT);
    const userIdAtSubmit = sessionCtx.me?.user.id;
    const generationAtSubmit = vaultCtx.generation;
    fireEvent.click(screen.getByTestId('onboarding-continue-button'));

    // The submit started: handleStep1Submit clears both inputs right before the KDF (or the flow already moved on).
    await waitFor(() => {
      if (screen.queryByTestId('onboarding-step-passphrase') === null) return;
      expect(passInput).toHaveValue('');
      expect(confirmInput).toHaveValue('');
    }, CRYPTO_WAIT);

    try {
      await waitFor(() => {
        expect(screen.getByTestId('onboarding-step-recovery-keys')).toBeInTheDocument();
      }, CRYPTO_WAIT);
    } catch (error) {
      // A cleared step 1 that never advanced means createVault's result was discarded (generation or user id moved).
      throw new Error(
        `step 1 submitted but never reached the recovery-keys step: user id changed=${String(
          sessionCtx.me?.user.id !== userIdAtSubmit,
        )}, generation ${String(generationAtSubmit)} -> ${String(vaultCtx.generation)}, session=${
          sessionCtx.status
        }, vault=${vaultCtx.state}/${vaultCtx.workerState}`,
        { cause: error },
      );
    }

    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-create-vault-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-passkey')).toBeInTheDocument();
    }, CRYPTO_WAIT);

    return {
      credentialsCreate,
      getVault: () => vaultCtx,
      oauthReauthCalls,
      getVaultCallsCount: () => getVaultCalls,
      setVaultGetHook: (hook: (() => string | undefined) | null) => {
        vaultGetHook = hook;
      },
      setCurrentMe: (nextMe: Me) => {
        currentMe = nextMe;
      },
      getSession: () => sessionCtx,
    };
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
    }, CRYPTO_WAIT);
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(0);
  }, CRYPTO_TEST_TIMEOUT);

  it('16B: step 3 turning Remember this device on calls remember() and stores DevKey, and toggling off forgets it', async () => {
    await advanceToStep3('en');

    const rememberSwitch = screen.getByTestId('onboarding-remember-device-switch');
    expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');

    await act(async () => {
      fireEvent.click(rememberSwitch);
    });
    await waitFor(() => {
      expect(rememberSwitch).toHaveAttribute('aria-checked', 'true');
    }, CRYPTO_WAIT);
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(1);

    // Toggling off calls forget() and removes the record
    await act(async () => {
      fireEvent.click(rememberSwitch);
    });
    await waitFor(() => {
      expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');
    }, CRYPTO_WAIT);
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(0);

    // Turn back on and Finish -> goes to /app with the device remembered
    await act(async () => {
      fireEvent.click(rememberSwitch);
    });
    await waitFor(() => {
      expect(rememberSwitch).toHaveAttribute('aria-checked', 'true');
    }, CRYPTO_WAIT);
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-finish-button'));
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    }, CRYPTO_WAIT);
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(1);
  }, CRYPTO_TEST_TIMEOUT);

  it('16B: step 3 shows unavailable message when IndexedDB is blocked without blocking Skip or Finish', async () => {
    idb.options.failOpen = true;
    await advanceToStep3('en');

    const rememberSwitch = screen.getByTestId('onboarding-remember-device-switch');
    expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');

    await act(async () => {
      fireEvent.click(rememberSwitch);
    });

    const unavailableMsg = await screen.findByTestId(
      'onboarding-remember-device-unavailable',
      {},
      CRYPTO_WAIT,
    );
    expect(unavailableMsg).toHaveTextContent(enMessages.vault.device.unavailable);
    expect(rememberSwitch).toBeDisabled();
    expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');

    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-skip-passkey-button'));
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    }, CRYPTO_WAIT);
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(0);
  }, CRYPTO_TEST_TIMEOUT);

  it('16B: step 3 add passkey success stays on step 3 showing addedStatus, refreshes vaultMeta.passkeys even when Remember was toggled on first (VB-R2-2), and Finish goes on to /app', async () => {
    const { credentialsCreate, getVault, getVaultCallsCount } = await advanceToStep3('en');
    credentialsCreate.mockResolvedValue(
      fakeCredential({ rawId: NEW_CREDENTIAL_ID, prf: { enabled: true, first: PRF_OUTPUT } }).credential,
    );

    // Toggle Remember this device ON first (loads GET /vault with passkeys: [])
    const rememberSwitch = screen.getByTestId('onboarding-remember-device-switch');
    await act(async () => {
      fireEvent.click(rememberSwitch);
    });
    await waitFor(() => {
      expect(rememberSwitch).toHaveAttribute('aria-checked', 'true');
    }, CRYPTO_WAIT);
    expect(getVault().vaultMeta?.passkeys).toEqual([]);
    const getVaultCallsBeforeAdd = getVaultCallsCount();

    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
    const pwdInput = await screen.findByLabelText('Login password');
    fireEvent.change(pwdInput, { target: { value: 'correct-login-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const continueBtn = await screen.findByRole('button', { name: 'Continue' }, CRYPTO_WAIT);
    await waitFor(() => expect(continueBtn).toBeEnabled(), CRYPTO_WAIT);

    fireEvent.change(screen.getByLabelText('Passkey name'), {
      target: { value: 'Onboarding laptop' },
    });
    fireEvent.click(continueBtn);

    const addedStatus = await screen.findByTestId(
      'onboarding-passkey-added-status',
      {},
      CRYPTO_WAIT,
    );
    expect(addedStatus).toHaveAttribute('role', 'status');
    expect(addedStatus).toHaveTextContent(enMessages.vault.b.onboarding.addedStatus);
    expect(screen.getByTestId('onboarding-step-passkey')).toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalledWith('/app');

    await waitFor(() => {
      expect(getVaultCallsCount()).toBeGreaterThan(getVaultCallsBeforeAdd);
      expect(getVault().vaultMeta?.passkeys).toEqual([
        {
          id: 'passkey-step3-1',
          name: 'Onboarding laptop',
          aaguid: null,
          created_at: '2026-10-30T00:00:00Z',
        },
      ]);
    }, CRYPTO_WAIT);

    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-finish-button'));
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    }, CRYPTO_WAIT);
  }, CRYPTO_TEST_TIMEOUT);

  it('16B: step 3 PRF-unsupported and cancel show §5.10 messages and still allow Skip to finish onboarding (en + vi)', async () => {
    const { credentialsCreate } = await advanceToStep3('en');

    credentialsCreate.mockResolvedValueOnce(
      fakeCredential({ rawId: NEW_CREDENTIAL_ID, prf: { enabled: false } }).credential,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));

    const pwdInput = await screen.findByLabelText('Login password');
    fireEvent.change(pwdInput, { target: { value: 'correct-login-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    const continueBtn = await screen.findByRole('button', { name: 'Continue' }, CRYPTO_WAIT);
    await waitFor(() => expect(continueBtn).toBeEnabled(), CRYPTO_WAIT);

    fireEvent.change(screen.getByLabelText('Passkey name'), { target: { value: 'No PRF key' } });
    fireEvent.click(continueBtn);

    expect(await screen.findByRole('alert', {}, CRYPTO_WAIT)).toHaveTextContent(
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
    }, CRYPTO_WAIT);

    // Vietnamese parity check for Step 3 + Finish button
    cleanup();
    routerMocks.replace.mockReset();
    await advanceToStep3('vi');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      viMessages.vault.b.onboarding.title,
    );
    expect(screen.getByRole('switch', { name: /Nhớ thiết bị này/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-finish-button'));
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    }, CRYPTO_WAIT);
  }, CRYPTO_TEST_TIMEOUT);

  it('16B (VB-R1-1 / VB-R1-2 / VB-R2-3): window focus / visibility wake on step 3 keeps onboarding-step-passkey and the Add passkey dialog mounted, while a real lock moves on', async () => {
    const { getVault } = await advanceToStep3('en');

    expect(screen.getByTestId('onboarding-step-passkey')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    // Trigger provider wake events (window focus, pageshow, document visibilitychange)
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Step 3 and the Add passkey dialog remain mounted and no navigation happened
    expect(screen.getByTestId('onboarding-step-passkey')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalled();

    // A real lock while on step 3 ends step 3
    await act(async () => {
      await getVault().lock({ broadcast: false, reason: 'step3_test_lock' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-step-passkey')).not.toBeInTheDocument();
    }, CRYPTO_WAIT);
  }, CRYPTO_TEST_TIMEOUT);

  it('16B (VB-R2-4 / VB-R2-6): step 3 cross-tab remember-device change raises neutral stateChanged notice with role="status" and Dismiss clears it', async () => {
    const { setVaultGetHook } = await advanceToStep3('en');

    const rememberSwitch = screen.getByTestId('onboarding-remember-device-switch');
    expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');

    // Another tab bumps the device meta revision while this tab's Remember is verifying the vault inside the Web Lock:
    // start (incarnation, revision) was captured before WebCrypto, so the final tx aborts with `meta_changed`, which
    // raises the neutral notice WITHOUT the provider locking (only vault_absent / vault_mismatch reload and reconcile).
    setVaultGetHook(() => {
      const metaStore = idb.store(META_STORE_NAME);
      const cur = metaStore.get(DEVICE_META_RECORD_KEY) as
        | { incarnation: string; deviceRevision: number }
        | undefined;
      if (cur) {
        metaStore.set(DEVICE_META_RECORD_KEY, {
          incarnation: cur.incarnation,
          deviceRevision: cur.deviceRevision + 1,
        });
      }
      return undefined;
    });

    await act(async () => {
      fireEvent.click(rememberSwitch);
    });

    const notice = await screen.findByTestId('onboarding-remember-device-notice', {}, CRYPTO_WAIT);
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent(enMessages.vault.device.notice.stateChanged);
    expect(rememberSwitch).toHaveAttribute('aria-checked', 'false');
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(0);
    // No lock: step 3 stays mounted.
    expect(screen.getByTestId('onboarding-step-passkey')).toBeInTheDocument();

    const dismissBtn = screen.getByTestId('onboarding-remember-device-notice-dismiss');
    expect(dismissBtn).toHaveTextContent(enMessages.vault.b.onboarding.rememberDevice.dismiss);
    fireEvent.click(dismissBtn);
    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-remember-device-notice')).not.toBeInTheDocument();
    });
  }, CRYPTO_TEST_TIMEOUT);

  it('16B (VB-R4-1): step 3 Remember whose in-lock vault GET returns another vault_key_id aborts with vault_mismatch, the store reconciliation reload locks the provider, step 3 ends and no DevKey is stored', async () => {
    const { getVault, setVaultGetHook } = await advanceToStep3('en');

    // Load the ORIGINAL vault metadata first (advanceToStep3 leaves `vaultMeta` null): with a non-null key,
    // Remember skips its preliminary reload and its only GETs are the in-lock verification and the reconciliation.
    await act(async () => {
      await getVault().reloadVaultMeta();
    });
    await waitFor(() => {
      expect(getVault().vaultMeta?.vault_key_id).toBe('vk:7f3a9b2c4d5e6f7a8b9c0d');
    }, CRYPTO_WAIT);
    expect(getVault().workerState).toBe('unlocked');
    expect(screen.getByTestId('onboarding-step-passkey')).toBeInTheDocument();

    // Only now another tab "replaces" the vault: Remember's in-lock verification GET (and the reload that follows
    // the abort) sees the replacement key.
    let replacementServed = 0;
    setVaultGetHook(() => {
      replacementServed += 1;
      return 'vk:other-tab-replaced-key';
    });

    const rememberSwitch = screen.getByTestId('onboarding-remember-device-switch');
    await act(async () => {
      fireEvent.click(rememberSwitch);
    });

    await waitFor(() => {
      expect(getVault().workerState).toBe('locked');
    }, CRYPTO_WAIT);
    await waitFor(() => {
      expect(getVault().getClient().getState()).toBe('locked');
    }, CRYPTO_WAIT);
    await waitFor(() => {
      expect(screen.queryByTestId('onboarding-step-passkey')).not.toBeInTheDocument();
    }, CRYPTO_WAIT);
    // Verification GET + the store's reconciliation reload: both saw the replacement key.
    expect(replacementServed).toBeGreaterThanOrEqual(2);
    expect(idb.store(DEVKEY_STORE_NAME).size).toBe(0);
  }, CRYPTO_TEST_TIMEOUT);

  it('16B (VB-R1-2): OAuth-only account on step 3 Add passkey invokes OAuth re-auth and claims no registration success', async () => {
    const { oauthReauthCalls } = await advanceToStep3('en', { oauthOnly: true });

    fireEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
    const googleBtn = await screen.findByRole('button', { name: enMessages.auth.reauth.google });
    await act(async () => {
      fireEvent.click(googleBtn);
    });

    await waitFor(() => {
      expect(oauthReauthCalls).toHaveLength(1);
    });
    expect(oauthReauthCalls[0]!.url).toContain('/auth/oauth/google/reauth');
    expect(JSON.parse(oauthReauthCalls[0]!.body)).toEqual({ action: 'vault.passkey_register' });
    expect(screen.queryByTestId('onboarding-passkey-added-status')).not.toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalledWith('/app');
  }, CRYPTO_TEST_TIMEOUT);

  it('FU2 (advisor-dec-200): completing onboarding to step 3 and clicking Skip populates vaultMeta with the new vault_key_id before routing to /app without any manual reloadVaultMeta call', async () => {
    let holdGetVault = true;
    const heldGetVault = Promise.withResolvers<void>();
    const { getVault, getVaultCallsCount } = await advanceToStep3('en', {
      onBeforeGetVault: async () => {
        if (holdGetVault) {
          await heldGetVault.promise;
        }
      },
    });

    expect(screen.getByTestId('onboarding-step-passkey')).toBeInTheDocument();
    // Step 2 -> Step 3 transition does NOT eagerly fire GET /vault (avoiding any post-create reload race on Step 3)
    expect(getVaultCallsCount()).toBe(0);
    expect(getVault().vaultMeta).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-skip-passkey-button'));
    });

    // Clicking Skip starts GET /vault (reloadVaultMeta) and waits before navigating to /app
    expect(getVaultCallsCount()).toBe(1);
    expect(routerMocks.replace).not.toHaveBeenCalledWith('/app');

    await act(async () => {
      holdGetVault = false;
      heldGetVault.resolve();
    });

    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    }, CRYPTO_WAIT);
    expect(getVault().vaultMeta).not.toBeNull();
    expect(getVault().vaultMeta?.vault_key_id).toBe('vk:7f3a9b2c4d5e6f7a8b9c0d');
    expect(getVault().vaultMeta?.version).toBe(1);
  }, CRYPTO_TEST_TIMEOUT);

  it('FU2 (advisor-dec-200): stale/aborted submit or user switch or lock during post-create reloadVaultMeta never commits meta for the wrong user or navigates to /app', async () => {
    // 1. User switch during the held post-create GET /vault reload -> does not commit meta for the new user or navigate to /app
    let holdGetVault = true;
    let heldGetVault = Promise.withResolvers<void>();
    const { getVault, getSession, setCurrentMe } = await advanceToStep3('en', {
      onBeforeGetVault: async () => {
        if (holdGetVault) {
          await heldGetVault.promise;
        }
      },
    });

    expect(screen.getByTestId('onboarding-step-passkey')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-skip-passkey-button'));
    });

    // Switch to another user while GET /vault is in flight
    setCurrentMe(makeMeFixture('absent', { userId: 'user-onboarding-step3-test-2' }));
    await act(async () => {
      await getSession().refetchMe();
    });
    await waitFor(() => {
      expect(getSession().me?.user.id).toBe('user-onboarding-step3-test-2');
    }, CRYPTO_WAIT);

    // Release user 1's held GET /vault response -> foreign response is discarded; user 2's vaultMeta stays null and no /app navigation
    await act(async () => {
      holdGetVault = false;
      heldGetVault.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getVault().vaultMeta).toBeNull();
    expect(routerMocks.replace).not.toHaveBeenCalledWith('/app');

    // 2. Lock during the held post-create GET /vault reload -> does not navigate to /app when reload settles
    cleanup();
    routerMocks.replace.mockReset();
    holdGetVault = true;
    heldGetVault = Promise.withResolvers<void>();
    const hLock = await advanceToStep3('en', {
      onBeforeGetVault: async () => {
        if (holdGetVault) {
          await heldGetVault.promise;
        }
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-skip-passkey-button'));
    });
    await act(async () => {
      await hLock.getVault().lock({ broadcast: false, reason: 'lock_during_step3_reload' });
    });
    await act(async () => {
      holdGetVault = false;
      heldGetVault.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hLock.getVault().workerState).toBe('locked');
    expect(routerMocks.replace).not.toHaveBeenCalledWith('/app');

    // 3. User switch while POST /vault is in flight (stale submit) -> does not call reloadVaultMeta or commit meta for the wrong user
    cleanup();
    routerMocks.replace.mockReset();
    let holdPostVault = true;
    const heldPostVault = Promise.withResolvers<void>();
    let getVaultCallsDuringStaleSubmit = 0;
    let currentMe3 = makeMeFixture('absent', { userId: 'user-onboarding-step3-test-1' });
    let vaultCtx3!: VaultContextValue;
    let sessionCtx3!: SessionState & { refetchMe: () => Promise<void> };

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
      if (url.endsWith('/auth/me')) return jsonResponse(currentMe3);
      if (url.endsWith('/vault') && init?.method === 'POST') {
        if (holdPostVault) {
          await heldPostVault.promise;
        }
        return jsonResponse({ vault_key_id: 'vk:7f3a9b2c4d5e6f7a8b9c0d', version: 1 }, 201);
      }
      if (url.endsWith('/vault') && (!init?.method || init.method === 'GET')) {
        getVaultCallsDuringStaleSubmit += 1;
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
      return jsonResponse({});
    });

    function Probe3() {
      vaultCtx3 = useVault();
      sessionCtx3 = useSession();
      return null;
    }

    const qc3 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ThemeProvider>
          <QueryClientProvider client={qc3}>
            <SessionProvider>
              <VaultProvider
                createWorker={makeOnboardingStep3WorkerFactory()}
                lockEpochEnv={makeSimpleLockEpochEnv()}
              >
                <Probe3 />
                <VaultOnboardingFlow />
              </VaultProvider>
            </SessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    await waitFor(() => {
      expect(sessionCtx3.status).toBe('authenticated_without_vault');
      expect(screen.getByTestId('onboarding-step-passphrase')).toBeInTheDocument();
    }, CRYPTO_WAIT);

    fireEvent.change(screen.getByLabelText(/^Passphrase$/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.change(screen.getByLabelText(/Confirm passphrase/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    await waitFor(() => {
      expect(screen.getByTestId('rule-min-length')).toHaveAttribute('data-satisfied', 'true');
      expect(screen.getByTestId('rule-min-score')).toHaveAttribute('data-satisfied', 'true');
    }, CRYPTO_WAIT);
    fireEvent.click(screen.getByTestId('onboarding-continue-button'));
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-recovery-keys')).toBeInTheDocument();
    }, CRYPTO_WAIT);

    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));
    fireEvent.click(screen.getByTestId('onboarding-create-vault-button'));

    // Switch user while POST /vault for user 1 is in flight
    currentMe3 = makeMeFixture('absent', { userId: 'user-onboarding-step3-test-2' });
    await act(async () => {
      await sessionCtx3.refetchMe();
    });
    await waitFor(() => {
      expect(sessionCtx3.me?.user.id).toBe('user-onboarding-step3-test-2');
    }, CRYPTO_WAIT);

    // Release user 1's POST /vault -> stale submit is ignored before notifyVaultChanged / reloadVaultMeta
    await act(async () => {
      holdPostVault = false;
      heldPostVault.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getVaultCallsDuringStaleSubmit).toBe(0);
    expect(vaultCtx3.vaultMeta).toBeNull();
    expect(routerMocks.replace).not.toHaveBeenCalled();
  }, CRYPTO_TEST_TIMEOUT);

  it('FU2 fix2 (CI-41336756651 regression): when GET /vault is mocked to return 404 vault_absent (as in e2e/vault-onboarding.spec.ts), Step 3 stays mounted and unlocked after POST /vault so Skip is clickable', async () => {
    const { getVault, getVaultCallsCount } = await advanceToStep3('en', {
      getVaultMode: 'absent_404',
    });

    // Allow microtasks/effects after POST /vault to flush
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // If POST /vault eagerly called reloadVaultMeta(), the 404 response would trigger VaultProvider.loadVaultMeta()
    // row 1a -> lock() -> registerSecretFormReset -> setStep('done'), unmounting Step 3 before Skip can be clicked!
    expect(getVaultCallsCount()).toBe(0);
    expect(getVault().workerState).toBe('unlocked');
    expect(getVault().state).toBe('unlocked');
    expect(screen.getByTestId('onboarding-step-passkey')).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-skip-passkey-button')).toBeEnabled();
  }, CRYPTO_TEST_TIMEOUT);
});
