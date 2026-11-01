import { ProblemError } from '@engram/shared-types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import { resetVaultBroadcastForTests } from '@/features/vault/broadcast';
import { recordLockEpochEvent, type LockEpochEnvironment } from '@/features/vault/lock-epoch';
import { ForgotPassphraseView, VaultUnlockFlow } from '@/features/vault/unlock';
import {
  hasRecoveryCompletedNotice,
  rememberRecoveryCompletedNotice,
} from '@/features/vault/unlock/recovery-notice';
import { VaultProvider, useVault, type VaultContextValue } from '@/features/vault/vault-provider';
import type { Me } from '@/lib/api/auth';
import type { VaultState } from '@/lib/api/vault';
import { CryptoClientError, CryptoWorkerError, type CryptoWorkerPort } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim } from '@/lib/crypto/test/worker-shim';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

const TEST_VECTOR_PASSPHRASE = 'correct-horse-battery-staple-engram-js-v1';
const TEST_VECTOR_KDF = {
  alg: 'argon2id13' as const,
  ops: 3,
  mem: 67_108_864,
  parallelism: 1 as const,
  salt: 'oKGio6SlpqeoqaqrrK2urw',
};
const TEST_VECTOR_WRAPPED_VK =
  'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA';
const TEST_VECTOR_WRAPPED_PRIV =
  'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-';
const TEST_VECTOR_VAULT_KEY_ID = 'vk:7f3a9b2c4d5e6f7a8b9c0d';

const fastTestDeriveKek: DeriveKekFn = (
  sodium: Sodium,
  passphrase: Uint8Array,
  params: ValidatedKdfParams,
): Uint8Array => {
  const input = new Uint8Array(passphrase.byteLength + params.saltBytes.byteLength + 8);
  input.set(passphrase, 0);
  input.set(params.saltBytes, passphrase.byteLength);
  const view = new DataView(
    input.buffer,
    input.byteOffset + passphrase.byteLength + params.saltBytes.byteLength,
    8,
  );
  view.setUint32(0, params.ops, true);
  view.setUint32(4, params.mem, true);
  return sodium.crypto_generichash(KEK_BYTES, input, null, 'uint8array');
};

const routerMocks = vi.hoisted(() => ({
  pathname: '/app/unlock',
  searchParams: new URLSearchParams(),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => routerMocks.pathname,
  useRouter: () => ({ replace: routerMocks.replace, push: routerMocks.push }),
  useSearchParams: () => routerMocks.searchParams,
}));

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeMeFixture(vaultStatus: 'absent' | 'present' = 'present'): Me {
  return {
    user: {
      id: 'user-unlock-test-1',
      email: 'minh@zone17th.click',
      email_verified: true,
      created_at: '2026-10-29T00:00:00Z',
    },
    settings: {
      locale: 'en',
      theme: 'light',
      auto_lock_minutes: 15,
      semantic_suggest: true,
    },
    identities: [{ provider: 'password', linked_at: '2026-10-29T00:00:00Z' }],
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

function makeVaultMetaFixture(): VaultState {
  return {
    version: 1,
    vault_key_id: TEST_VECTOR_VAULT_KEY_ID,
    kdf: TEST_VECTOR_KDF,
    vault_key_wrapped_by_kek: TEST_VECTOR_WRAPPED_VK,
    x25519_public: 'EIT5fcwxJb3Sw8y-V9yHL-JGU5pDVlgw9H5ueCV7OnI',
    ed25519_public: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
    private_keys_wrapped: TEST_VECTOR_WRAPPED_PRIV,
    recovery_keys_remaining: 10,
    passkeys: [],
  };
}

function makeSimpleLockEpochEnv(): LockEpochEnvironment {
  let marker = { epochIncarnation: 'inc-unlock-test-1', lockEpoch: 1 };
  const fakeIdb = {
    open() {
      const req: Record<string, unknown> = {
        result: {
          objectStoreNames: {
            contains: () => true,
          },
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

function makeUnlockWorkerFactory(options?: {
  expectedPassphrase?: string;
  errorCodeOnUnlock?:
    | 'AEAD_DECRYPT_FAILED'
    | 'PRIVATE_KEYS_WRAP_INVALID'
    | 'KDF_ALLOCATION_FAILED'
    | 'KDF_DERIVE_FAILED'
    | 'VAULT_RECOVERING';
  initialMode?: 'locked' | 'recovering';
}): () => CryptoWorkerPort {
  return () => {
    let generation = 0;
    let epoch = 0;
    let mode: 'locked' | 'unlocked' | 'recovering' = options?.initialMode ?? 'locked';
    let onMessage: ((event: MessageEvent) => void) | null = null;

    const port: CryptoWorkerPort = {
      get onmessage() {
        return onMessage;
      },
      set onmessage(handler) {
        onMessage = handler;
      },
      onerror: null,
      postMessage(message) {
        let decodedPassphrase = '';
        if ('passphraseBuffer' in message && message.passphraseBuffer) {
          const bytes = new Uint8Array(message.passphraseBuffer);
          decodedPassphrase = new TextDecoder().decode(bytes);
          bytes.fill(0);
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

          if (message.type === 'unlockPassphrase') {
            if (message.generation < generation) {
              onMessage?.({
                data: {
                  id: message.id,
                  generation,
                  ok: false,
                  state: { mode, generation, epoch },
                  error: { code: 'STALE_GENERATION', message: 'Stale generation' },
                },
              } as MessageEvent);
              return;
            }
            generation = message.generation;

            if (mode === 'recovering' || options?.errorCodeOnUnlock === 'VAULT_RECOVERING') {
              mode = 'recovering';
              onMessage?.({
                data: {
                  id: message.id,
                  generation,
                  ok: false,
                  state: { mode, generation, epoch },
                  error: {
                    code: 'VAULT_RECOVERING',
                    message: 'Vault is recovering; call lock() first to switch',
                  },
                },
              } as MessageEvent);
              return;
            }

            if (options?.errorCodeOnUnlock) {
              const err = new CryptoWorkerError(
                options.errorCodeOnUnlock,
                `Simulated ${options.errorCodeOnUnlock}`,
              );
              onMessage?.({
                data: {
                  id: message.id,
                  generation,
                  ok: false,
                  state: { mode, generation, epoch },
                  error: { code: err.code, message: err.message },
                },
              } as MessageEvent);
              return;
            }

            const expected = options?.expectedPassphrase ?? TEST_VECTOR_PASSPHRASE;
            if (decodedPassphrase !== expected) {
              onMessage?.({
                data: {
                  id: message.id,
                  generation,
                  ok: false,
                  state: { mode, generation, epoch },
                  error: {
                    code: 'AEAD_DECRYPT_FAILED',
                    message: 'AEAD authentication failed',
                  },
                },
              } as MessageEvent);
              return;
            }

            mode = 'unlocked';
            epoch += 1;
            onMessage?.({
              data: {
                id: message.id,
                generation,
                ok: true,
                state: { mode, generation, epoch },
                result: { unlocked: true },
              },
            } as MessageEvent);
          }
        });
      },
      terminate() {
        onMessage = null;
      },
    };

    return port;
  };
}

describe('Task 17A — VaultUnlockFlow & ForgotPassphraseView U4', () => {
  const activeShims: Array<{ close: () => void }> = [];

  function makeTestShim() {
    const s = createWorkerShim({ deriveKek: fastTestDeriveKek });
    activeShims.push(s);
    return s;
  }

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    routerMocks.pathname = '/app/unlock';
    routerMocks.searchParams = new URLSearchParams();
    routerMocks.replace.mockReset();
    routerMocks.push.mockReset();
    resetVaultBroadcastForTests();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    while (activeShims.length > 0) {
      activeShims.pop()?.close();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  function renderUnlock(options?: {
    locale?: 'en' | 'vi';
    workerFactory?: () => CryptoWorkerPort;
    lockEpochEnv?: LockEpochEnvironment;
    onVaultProbe?: (ctx: VaultContextValue) => void;
    view?: 'unlock' | 'forgot';
  }) {
    const locale = options?.locale ?? 'en';
    const messages = locale === 'vi' ? viMessages : enMessages;
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const lockEpochEnv = options?.lockEpochEnv ?? makeSimpleLockEpochEnv();
    function Probe() {
      const v = useVault();
      const s = useSession();
      options?.onVaultProbe?.(v);
      return (
        <output data-testid="test-vault-probe">
          {s.status}|{v.state}|{v.workerState}|{v.lastErrorCode ?? ''}
        </output>
      );
    }

    const utils = render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <ThemeProvider>
          <QueryClientProvider client={qc}>
            <SessionProvider>
              <VaultProvider
                createWorker={options?.workerFactory ?? makeUnlockWorkerFactory()}
                lockEpochEnv={lockEpochEnv}
              >
                <Probe />
                {options?.view === 'forgot' ? <ForgotPassphraseView /> : <VaultUnlockFlow />}
              </VaultProvider>
            </SessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    return { ...utils, queryClient: qc };
  }

  it('unlocks with the right passphrase (capturing opGeneration before GET /vault) and navigates to /app (or sanitized returnTo), while wrong passphrase shows "Incorrect passphrase" / "Passphrase không đúng"', async () => {
    routerMocks.searchParams = new URLSearchParams('returnTo=/app/settings');
    let getVaultCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('present'));
      if (url.endsWith('/vault')) {
        getVaultCount += 1;
        return jsonResponse(makeVaultMetaFixture());
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    renderUnlock({
      locale: 'en',
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('test-vault-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
    });

    // 1. Empty passphrase validation
    fireEvent.click(screen.getByTestId('unlock-submit-button'));
    expect(screen.getByText(/Enter your vault passphrase/i)).toBeInTheDocument();

    // 2. Wrong passphrase -> AEAD_DECRYPT_FAILED -> "Incorrect passphrase"
    const passInput = screen.getByTestId('unlock-passphrase-input') as HTMLInputElement;
    fireEvent.change(passInput, { target: { value: 'wrong-passphrase-123456' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });

    // Input is cleared immediately on submit
    expect(passInput.value).toBe('');

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error-incorrect-passphrase')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Incorrect passphrase');
    expect(vaultCtx.state).toBe('locked');
    expect(routerMocks.replace).not.toHaveBeenCalled();

    // 3. Correct passphrase -> unlocked + redirects to sanitized returnTo
    fireEvent.change(passInput, { target: { value: TEST_VECTOR_PASSPHRASE } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });

    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
    });
    expect(getVaultCount).toBeGreaterThanOrEqual(2);
    expect(routerMocks.replace).toHaveBeenCalledWith('/app/settings');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  }, 15_000);

  it('renders Vietnamese "Passphrase không đúng" on AEAD_DECRYPT_FAILED and works end-to-end with the real libsodium Worker shim', async () => {
    const setupShim = makeTestShim();
    // Create a vault first in setupShim so we have valid wraps for fastTestDeriveKek
    const createDeferred = Promise.withResolvers<{
      kdf: VaultState['kdf'];
      vault_key_wrapped_by_kek: string;
      private_keys_wrapped: string;
    }>();
    const passBytes = new TextEncoder().encode(TEST_VECTOR_PASSPHRASE);
    setupShim.port.onmessage = (evt: MessageEvent) => {
      if (evt.data.ok && evt.data.result?.kdf) {
        createDeferred.resolve(evt.data.result);
      } else if (!evt.data.ok) {
        createDeferred.reject(new Error(evt.data.error?.message ?? 'createVault failed'));
      }
    };
    setupShim.port.postMessage({
      id: 1,
      generation: 0,
      type: 'createVault',
      passphraseBuffer: passBytes.buffer,
    });
    const created = await createDeferred.promise;
    setupShim.close();

    const shim = makeTestShim();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('present'));
      if (url.endsWith('/vault')) {
        return jsonResponse({
          ...makeVaultMetaFixture(),
          kdf: created.kdf,
          vault_key_wrapped_by_kek: created.vault_key_wrapped_by_kek,
          private_keys_wrapped: created.private_keys_wrapped,
        });
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    const { unmount } = renderUnlock({
      locale: 'vi',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('test-vault-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
    });

    const passInput = screen.getByTestId('unlock-passphrase-input');
    fireEvent.change(passInput, { target: { value: 'sai-passphrase-9999' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error-incorrect-passphrase')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Passphrase không đúng');

    // Now unlock with the right passphrase
    fireEvent.change(passInput, { target: { value: TEST_VECTOR_PASSPHRASE } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });

    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
    });
    expect(routerMocks.replace).toHaveBeenCalledWith('/app');

    unmount();
    shim.close();
  }, 20_000);
  it('surfaces device-memory state on KDF_ALLOCATION_FAILED and KDF_DERIVE_FAILED, and never shows "Incorrect passphrase"', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('present'));
      if (url.endsWith('/vault')) return jsonResponse(makeVaultMetaFixture());
      return jsonResponse({});
    });

    // 1. KDF_ALLOCATION_FAILED
    const { unmount } = renderUnlock({
      locale: 'en',
      workerFactory: makeUnlockWorkerFactory({
        errorCodeOnUnlock: 'KDF_ALLOCATION_FAILED',
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-passphrase-input')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('unlock-passphrase-input'), {
      target: { value: TEST_VECTOR_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error-insufficient-memory')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Not enough memory to unlock your vault/i,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      /This does not mean your passphrase is wrong/i,
    );
    expect(
      screen.queryByTestId('unlock-error-incorrect-passphrase'),
    ).not.toBeInTheDocument();

    unmount();

    // 2. KDF_DERIVE_FAILED
    renderUnlock({
      locale: 'en',
      workerFactory: makeUnlockWorkerFactory({
        errorCodeOnUnlock: 'KDF_DERIVE_FAILED',
      }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-passphrase-input')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('unlock-passphrase-input'), {
      target: { value: TEST_VECTOR_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error-insufficient-memory')).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId('unlock-error-incorrect-passphrase'),
    ).not.toBeInTheDocument();
  }, 15_000);
  it('handles PASSPHRASE_INVALID, PRIVATE_KEYS_WRAP_INVALID, CLIENT_BUSY, and VAULT_RECOVERING with distinct error cards (never shown as wrong passphrase)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('present'));
      if (url.endsWith('/vault')) return jsonResponse(makeVaultMetaFixture());
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    const { unmount } = renderUnlock({
      locale: 'en',
      workerFactory: makeUnlockWorkerFactory({
        errorCodeOnUnlock: 'PRIVATE_KEYS_WRAP_INVALID',
      }),
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-passphrase-input')).toBeInTheDocument();
    });

    // 1. PASSPHRASE_INVALID (lone UTF-16 surrogate rejected before Worker call)
    fireEvent.change(screen.getByTestId('unlock-passphrase-input'), {
      target: { value: 'invalid-\uD800-surrogate' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error-passphrase-invalid')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/Invalid passphrase characters/i);
    expect(
      screen.queryByTestId('unlock-error-incorrect-passphrase'),
    ).not.toBeInTheDocument();

    // 2. PRIVATE_KEYS_WRAP_INVALID (distinct from AEAD_DECRYPT_FAILED)
    fireEvent.change(screen.getByTestId('unlock-passphrase-input'), {
      target: { value: TEST_VECTOR_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('unlock-error-private-keys-wrap-invalid'),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Could not verify vault key pair/i,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      /This is not a wrong-passphrase error/i,
    );
    expect(
      screen.queryByTestId('unlock-error-incorrect-passphrase'),
    ).not.toBeInTheDocument();

    // 3. CLIENT_BUSY (never shown as wrong passphrase)
    vi.spyOn(vaultCtx, 'unlockPassphrase').mockRejectedValueOnce(
      new CryptoClientError('CLIENT_BUSY', 'Another operation is in flight'),
    );
    fireEvent.change(screen.getByTestId('unlock-passphrase-input'), {
      target: { value: TEST_VECTOR_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error-busy')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/Unlock already in progress/i);
    expect(
      screen.queryByTestId('unlock-error-incorrect-passphrase'),
    ).not.toBeInTheDocument();

    unmount();

    // 4. VAULT_RECOVERING ("lock() first to switch")
    renderUnlock({
      locale: 'en',
      workerFactory: makeUnlockWorkerFactory({
        errorCodeOnUnlock: 'VAULT_RECOVERING',
      }),
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-passphrase-input')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('unlock-passphrase-input'), {
      target: { value: TEST_VECTOR_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error-recovering')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Recovery is in progress in this tab/i,
    );

    // Clicking "Lock and switch to unlock" locks the Worker and clears the error
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-recovering-lock-button'));
    });
    expect(screen.queryByTestId('unlock-error-recovering')).not.toBeInTheDocument();
    expect(vaultCtx.workerState).toBe('locked');
  }, 15_000);
  it('shows a live countdown when GET /vault returns 429 rate_limited', async () => {
    let return429 = true;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('present'));
      if (url.endsWith('/vault')) {
        if (return429) {
          throw new ProblemError({
            type: 'https://engram.zone17.click/problems/rate_limited',
            title: 'rate_limited',
            status: 429,
            code: 'rate_limited',
            retry_after: 45,
          });
        }
        return jsonResponse(makeVaultMetaFixture());
      }
      return jsonResponse({});
    });

    renderUnlock({ locale: 'en' });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-passphrase-input')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('unlock-passphrase-input'), {
      target: { value: TEST_VECTOR_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-error-rate-limited')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/Too many requests — please wait/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/0:4[45] \(4[45]s\)/);
    expect(screen.getByTestId('unlock-submit-button')).toBeDisabled();

    return429 = false;
  }, 15_000);
  it('renders the "I forgot my passphrase" link on Unlock and milestone A recovery/reset paths on ForgotPassphraseView', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('present'));
      if (url.endsWith('/vault')) return jsonResponse(makeVaultMetaFixture());
      return jsonResponse({});
    });

    const { unmount } = renderUnlock({ locale: 'en', view: 'unlock' });

    // FE1-1 & FE1-3: English header pill/actions rendered, and non-operative Remember-device checkbox is hidden until T18
    await waitFor(() => {
      expect(screen.getByTestId('unlock-forgot-passphrase-link')).toBeInTheDocument();
      expect(screen.getByText('Vault locked')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('unlock-remember-device-checkbox')).not.toBeInTheDocument();

    expect(screen.getByTestId('unlock-forgot-passphrase-link')).toHaveAttribute(
      'href',
      '/app/unlock/forgot',
    );
    expect(screen.getByTestId('unlock-forgot-passphrase-link')).toHaveTextContent(
      /I forgot my passphrase/i,
    );

    unmount();

    // Render ForgotPassphraseView (§3.10 milestone A paths: recovery key + reset entry point)
    renderUnlock({ locale: 'en', view: 'forgot' });

    await waitFor(() => {
      expect(screen.getByTestId('forgot-passphrase-page')).toBeInTheDocument();
      expect(screen.getByText('Vault locked')).toBeInTheDocument();
    });
    const useRecoveryKeyLink = screen.getByTestId('forgot-use-recovery-key-cta');
    expect(useRecoveryKeyLink).toHaveAttribute('href', '/app/recovery');

    const resetVaultLink = screen.getByTestId('forgot-reset-vault-link');
    expect(resetVaultLink).toHaveAttribute('href', '/app/settings#baomat');
    // FE1-2: uses AA-safe .auth-alert token class instead of hardcoded #B4232A inline style
    expect(resetVaultLink).toHaveClass('auth-alert');
    expect(resetVaultLink.getAttribute('style') ?? '').not.toContain('#B4232A');
    const backToUnlockLink = screen.getByTestId('forgot-bottom-back-link');
    expect(backToUnlockLink).toHaveAttribute('href', '/app/unlock');
    // The note must say account re-auth comes before the recovery key and is time-limited (UIA-17: plain words, no purpose code).
    const reauthNote = screen.getByTestId('forgot-reauth-note');
    expect(reauthNote).toHaveTextContent(enMessages.forgotPassphrase.reauthNote.title);
    expect(reauthNote).toHaveTextContent(enMessages.forgotPassphrase.reauthNote.body);
    expect(reauthNote).toHaveTextContent(/re-authenticate your account before entering a recovery key/i);
    expect(reauthNote).toHaveTextContent(/clicking use a recovery key asks you to confirm your account \(.*valid for 5 minutes\) before you paste your recovery key/i);
  }, 15_000);

  it('BE2-1 & BE2-13: sibling durable lock during in-flight GET /vault on unlock fails closed on baseline mismatch (never reaching unlocked), and route leave during GET /vault aborts unlock', async () => {
    let holdGetVault = true;
    let resolveGetVault: (() => void) | null = null;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('present'));
      if (url.endsWith('/vault')) {
        if (holdGetVault) {
          await new Promise<void>((resolve) => {
            resolveGetVault = resolve;
          });
        }
        return jsonResponse(makeVaultMetaFixture());
      }
      return jsonResponse({});
    });

    const lockEpochEnv = makeSimpleLockEpochEnv();
    let vaultCtx!: VaultContextValue;
    const workerFactory = makeUnlockWorkerFactory();
    const { rerender, queryClient } = renderUnlock({
      locale: 'en',
      workerFactory,
      lockEpochEnv,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('test-vault-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
    });

    // 1. BE2-1: Submit unlock -> beginUnlockOp captures durable lockEpoch baseline BEFORE awaiting GET /vault.
    // While GET /vault is in flight, a sibling tab writes a durable lockEpoch increment (missed BroadcastChannel).
    const passInput = screen.getByTestId('unlock-passphrase-input') as HTMLInputElement;
    fireEvent.change(passInput, { target: { value: TEST_VECTOR_PASSPHRASE } });
    fireEvent.click(screen.getByTestId('unlock-submit-button'));

    await waitFor(() => {
      expect(resolveGetVault).not.toBeNull();
    });

    // Sibling tab locks and increments durable lockEpoch while GET /vault is still in flight!
    await act(async () => {
      await recordLockEpochEvent(vaultCtx.tabKnownLockEpoch, lockEpochEnv);
    });

    // Release GET /vault -> unlockPassphrase reuses the pre-GET baseline and MUST reject with STALE_GENERATION + lockLocalOnly (never reaching unlocked or navigating)
    await act(async () => {
      holdGetVault = false;
      resolveGetVault?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId('unlock-submit-button')).not.toBeDisabled();
    });
    expect(vaultCtx.state).toBe('locked');
    expect(vaultCtx.workerState).toBe('locked');
    expect(routerMocks.replace).not.toHaveBeenCalled();

    // 2. BE2-13: Submit unlock again while holding GET /vault, then unmount the unlock view before GET /vault settles.
    // Unmounting MUST retire the unlock intent and never unlock the Worker or navigate when GET /vault later resolves.
    resolveGetVault = null;
    holdGetVault = true;
    fireEvent.change(screen.getByTestId('unlock-passphrase-input'), {
      target: { value: TEST_VECTOR_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('unlock-submit-button'));

    await waitFor(() => {
      expect(resolveGetVault).not.toBeNull();
    });

    // Leave only the VaultUnlockFlow route (switching to ForgotPassphraseView) while keeping VaultProvider mounted!
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <SessionProvider>
              <VaultProvider createWorker={workerFactory} lockEpochEnv={lockEpochEnv}>
                <ForgotPassphraseView />
              </VaultProvider>
            </SessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    // Release GET /vault after VaultUnlockFlow unmounted (with VaultProvider still alive) -> Worker stays locked and router.replace is never called
    await act(async () => {
      holdGetVault = false;
      resolveGetVault?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vaultCtx.state).toBe('locked');
    expect(vaultCtx.workerState).toBe('locked');
    expect(routerMocks.replace).not.toHaveBeenCalled();
  }, 15_000);
  function installUnlockFetchMock() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('present'));
      if (url.endsWith('/vault')) return jsonResponse(makeVaultMetaFixture());
      return jsonResponse({});
    });
  }

  for (const locale of ['en', 'vi'] as const) {
    it(`FE1-1 (${locale}): the provider-backed open-vault header button's accessible name contains its visible pill text and still locks the vault`, async () => {
      installUnlockFetchMock();
      let vaultCtx!: VaultContextValue;
      renderUnlock({
        locale,
        onVaultProbe: (ctx) => {
          vaultCtx = ctx;
        },
      });
      await waitFor(() => {
        expect(screen.getByTestId('test-vault-probe')).toHaveTextContent(
          'authenticated_with_vault|locked|locked|',
        );
      });

      // Unlock for real; the (mocked) router keeps this page mounted, so its header now renders the open pill button.
      fireEvent.change(screen.getByTestId('unlock-passphrase-input'), {
        target: { value: TEST_VECTOR_PASSPHRASE },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('unlock-submit-button'));
      });
      await waitFor(() => {
        expect(vaultCtx.state).toBe('unlocked');
        expect(screen.getByTestId('vault-lock-button')).toBeInTheDocument();
      });

      const lockButton = screen.getByTestId('vault-lock-button');
      const visiblePillText = Array.from(
        lockButton.querySelectorAll('.vault-pill > span:not([aria-hidden="true"])'),
      )
        .map((node) => (node.textContent ?? '').trim())
        .join(' ');
      expect(visiblePillText).toContain(locale === 'en' ? 'Vault open' : 'Vault mở');
      const accessibleName = lockButton.getAttribute('aria-label') ?? '';
      // WCAG 2.5.3 label in name: the visible words are inside the accessible name, which also says what the button does.
      expect(accessibleName.startsWith(visiblePillText)).toBe(true);
      expect(accessibleName).toContain(locale === 'en' ? 'Lock vault now (L)' : 'Khoá vault ngay (L)');
      expect(lockButton).toHaveAccessibleName(accessibleName);
      expect(lockButton).toHaveAttribute('aria-keyshortcuts', 'L');

      await act(async () => {
        fireEvent.click(lockButton);
      });
      await waitFor(() => {
        expect(vaultCtx.state).toBe('locked');
      });
      expect(screen.queryByTestId('vault-lock-button')).not.toBeInTheDocument();
    }, 20_000);
  }

  it('FE1-4: an asynchronous wrong-passphrase failure returns keyboard focus to the re-enabled passphrase field', async () => {
    installUnlockFetchMock();
    renderUnlock({ locale: 'en' });
    await waitFor(() => {
      expect(screen.getByTestId('test-vault-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
    });

    const passInput = screen.getByTestId('unlock-passphrase-input') as HTMLInputElement;
    fireEvent.change(passInput, { target: { value: 'wrong-passphrase-123456' } });
    // Focus is on <body> (like after the field was disabled while pending); only the product may move it back.
    expect(passInput).not.toHaveFocus();
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('unlock-error-incorrect-passphrase')).toBeInTheDocument();
    });
    // The field was disabled while pending (focus would have fallen back to <body>); it must be focused again.
    await waitFor(() => {
      expect(screen.getByTestId('unlock-passphrase-input')).not.toBeDisabled();
      expect(screen.getByTestId('unlock-passphrase-input')).toHaveFocus();
    });
  }, 15_000);

  it('FE1-7: the recovery-completed notice handed over by the recovery flow is shown on the unlock page after a real route change, only to the same account, and clears once the vault unlocks', async () => {
    installUnlockFetchMock();
    // The recovery route wrote the notice for this account, then navigated: nothing else is shared between the pages.
    rememberRecoveryCompletedNotice('user-unlock-test-1');
    let vaultCtx!: VaultContextValue;
    const first = renderUnlock({
      locale: 'en',
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId('unlock-recovered-notice')).toHaveTextContent(
        /Recovery completed[\s\S]*unlock your vault with the new passphrase/i,
      );
    });
    expect(screen.getByTestId('unlock-recovered-notice')).toHaveAttribute('role', 'status');
    first.unmount();

    // A notice written for another account is never shown to this one.
    window.sessionStorage.clear();
    rememberRecoveryCompletedNotice('another-user-id');
    expect(hasRecoveryCompletedNotice('user-unlock-test-1')).toBe(false);
    renderUnlock({ locale: 'en' });
    await waitFor(() => {
      expect(screen.getByTestId('test-vault-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
    });
    expect(screen.queryByTestId('unlock-recovered-notice')).not.toBeInTheDocument();
    cleanup();

    // A reload of the unlock page keeps the notice until the user actually unlocks with the new passphrase.
    window.sessionStorage.clear();
    rememberRecoveryCompletedNotice('user-unlock-test-1');
    renderUnlock({
      locale: 'en',
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId('unlock-recovered-notice')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('unlock-passphrase-input'), {
      target: { value: TEST_VECTOR_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('unlock-submit-button'));
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
    });
    expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    expect(hasRecoveryCompletedNotice('user-unlock-test-1')).toBe(false);
    expect(window.sessionStorage.length).toBe(0);
  }, 20_000);

});
