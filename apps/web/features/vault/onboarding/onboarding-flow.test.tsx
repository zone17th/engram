import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import { resetVaultBroadcastForTests } from '@/features/vault/broadcast';
import type { LockEpochEnvironment } from '@/features/vault/lock-epoch';
import { VaultOnboardingFlow } from '@/features/vault/onboarding';
import { VaultProvider, useVault, type VaultContextValue } from '@/features/vault/vault-provider';
import type { Me } from '@/lib/api/auth';
import { CryptoWorkerError, type CreateVaultResult, type CryptoWorkerPort } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim } from '@/lib/crypto/test/worker-shim';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';


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
  pathname: '/app/onboarding',
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => routerMocks.pathname,
  useRouter: () => ({ replace: routerMocks.replace, push: routerMocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function problemResponse(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return new Response(
    JSON.stringify({
      type: `https://engram.zone17th.click/problems/${code}`,
      title: code,
      status,
      code,
      ...extra,
    }),
    {
      status,
      headers: { 'content-type': 'application/problem+json', ...headers },
    },
  );
}

function makeMeFixture(vaultStatus: 'absent' | 'present' = 'absent'): Me {
  return {
    user: {
      id: 'user-onboarding-test-1',
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

function makeFastOnboardingWorkerFactory(options?: {
  failOom?: boolean;
}): () => CryptoWorkerPort {
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

    const port: CryptoWorkerPort = {
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
            if (options?.failOom) {
              const err = new CryptoWorkerError(
                'KDF_ALLOCATION_FAILED',
                'WASM memory allocation failed for Argon2id 64 MiB',
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

function makeSimpleLockEpochEnv(): LockEpochEnvironment {
  let marker = { epochIncarnation: 'inc-test-1', lockEpoch: 1 };
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

const STRONG_PASSPHRASE = 'Tr\u00e0m-H\u01b0\u01a1ng-94!K\u1ef7-V\u1eadt-Xanh';

describe('Task 16 (steps 1-2) — VaultOnboardingFlow U3', () => {
  beforeEach(() => {
    routerMocks.pathname = '/app/onboarding';
    routerMocks.replace.mockReset();
    routerMocks.push.mockReset();
    resetVaultBroadcastForTests();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function renderOnboarding(options?: {
    locale?: 'en' | 'vi';
    workerFactory?: () => CryptoWorkerPort;
    onVaultProbe?: (ctx: VaultContextValue) => void;
  }) {
    const locale = options?.locale ?? 'en';
    const messages = locale === 'vi' ? viMessages : enMessages;
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    function Probe() {
      const v = useVault();
      const s = useSession();
      options?.onVaultProbe?.(v);
      return (
        <output data-testid="test-session-status">
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
                createWorker={options?.workerFactory ?? makeFastOnboardingWorkerFactory()}
                lockEpochEnv={makeSimpleLockEpochEnv()}
              >
                <Probe />
                <VaultOnboardingFlow />
              </VaultProvider>
            </SessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    return { ...utils, queryClient: qc };
  }

  it('Step 1 validates NFC length (>= 12), zxcvbn score (>= 3), and confirmation match, and distinguishes vault passphrase from login password', async () => {
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
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('absent'));
      return jsonResponse({});
    });

    renderOnboarding({ locale: 'en' });

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-passphrase')).toBeInTheDocument();
    });

    // Distinguishes vault passphrase from login password
    expect(screen.getByText(/vault encryption passphrase/i)).toBeInTheDocument();
    expect(screen.getAllByText(/login password/i).length).toBeGreaterThanOrEqual(2);

    const passInput = screen.getByLabelText(/^Passphrase$/i);
    const confirmInput = screen.getByLabelText(/Confirm passphrase/i);
    const continueBtn = screen.getByTestId('onboarding-continue-button');

    // 1. NFD passphrase that is >= 12 UTF-16 code units in NFD (16) but < 12 in NFC (10) -> rejected as too short
    const nfdShortInNfc = 'e\u0301'.repeat(6) + 'X!9a';
    expect(nfdShortInNfc.length).toBe(16);
    expect(nfdShortInNfc.normalize('NFC').length).toBe(10);

    fireEvent.change(passInput, { target: { value: nfdShortInNfc } });
    fireEvent.change(confirmInput, { target: { value: nfdShortInNfc } });
    fireEvent.click(continueBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/Passphrase must be at least 12 characters/i),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId('onboarding-step-recovery-keys')).not.toBeInTheDocument();

    // 2. >= 12 chars in NFC but weak zxcvbn (< 3) -> rejected as too weak
    fireEvent.change(passInput, { target: { value: 'password123456' } });
    fireEvent.change(confirmInput, { target: { value: 'password123456' } });
    fireEvent.click(continueBtn);

    await waitFor(() => {
      expect(screen.getByText(/Passphrase is too easy to guess/i)).toBeInTheDocument();
    });

    // 3. Strong passphrase (>= 12, zxcvbn >= 3) but confirmation mismatch -> rejected
    fireEvent.change(passInput, { target: { value: STRONG_PASSPHRASE } });
    fireEvent.change(confirmInput, { target: { value: `${STRONG_PASSPHRASE}-mismatch` } });
    fireEvent.click(continueBtn);

    await waitFor(() => {
      expect(screen.getByText(/Passphrases do not match/i)).toBeInTheDocument();
    });
  });

  it('Step 2: does NOT send POST /vault until checkbox is ticked, renders accessible 10-key grid, and wipes RKs from DOM/storage on completion or reload/unmount', async () => {
    const postVaultCalls: Array<{ idempotencyKey: string | null; body: string }> = [];
    let currentMe = makeMeFixture('absent');

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
        const headers = new Headers(init.headers);
        postVaultCalls.push({
          idempotencyKey: headers.get('Idempotency-Key'),
          body: String(init.body ?? ''),
        });
        currentMe = makeMeFixture('present');
        return jsonResponse(
          {
            vault_key_id: 'vk:7f3a9b2c4d5e6f7a8b9c0d',
            version: 1,
          },
          201,
        );
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    const { queryClient } = renderOnboarding({
      locale: 'en',
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('test-session-status')).toHaveTextContent('authenticated_without_vault');
      expect(screen.getByTestId('onboarding-step-passphrase')).toBeInTheDocument();
    });
    const passInput = screen.getByLabelText(/^Passphrase$/i);
    const confirmInput = screen.getByLabelText(/Confirm passphrase/i);
    fireEvent.change(passInput, { target: { value: STRONG_PASSPHRASE } });
    fireEvent.change(confirmInput, { target: { value: STRONG_PASSPHRASE } });
    fireEvent.click(screen.getByTestId('onboarding-continue-button'));

    // Step 2 appears with 10 recovery keys, one-time screenshot warning, and disabled Create vault button
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-recovery-keys')).toBeInTheDocument();
    });

    expect(screen.getByTestId('onboarding-screenshot-warning')).toHaveTextContent(
      /Shown only this once/i,
    );

    // Keyboard & screen reader accessibility on the 10-key grid: ordered list with 10 labeled listitems + focusable code elements
    const gridList = screen.getByRole('list', { name: /10 single-use recovery keys/i });
    const items = within(gridList).getAllByRole('listitem');
    expect(items).toHaveLength(10);
    expect(items[0]).toHaveAttribute('aria-label', 'Recovery key 1 of 10');
    expect(items[9]).toHaveAttribute('aria-label', 'Recovery key 10 of 10');

    const slot1Code = screen.getByTestId('recovery-key-slot-1');
    expect(slot1Code).toHaveAttribute('tabindex', '0');
    expect(slot1Code.textContent).toMatch(/^rk1_/);

    // No RK or passphrase in localStorage, sessionStorage, URL, or TanStack Query cache
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.location.href).not.toContain('rk1_');
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain('rk1_3F8K');

    // Before ticking the checkbox: button is disabled and clicking it never triggers POST /vault
    const createVaultBtn = screen.getByTestId('onboarding-create-vault-button');
    expect(createVaultBtn).toBeDisabled();
    fireEvent.click(createVaultBtn);
    expect(postVaultCalls).toHaveLength(0);

    // Tick the confirmation checkbox -> Create vault button becomes enabled, still no POST until clicked
    const checkbox = screen.getByTestId('recovery-keys-confirm-checkbox');
    fireEvent.click(checkbox);
    expect(createVaultBtn).not.toBeDisabled();
    expect(postVaultCalls).toHaveLength(0);

    // Click Create vault -> sends POST /vault with UUID v4 Idempotency-Key and 10 RK slots
    await act(async () => {
      fireEvent.click(createVaultBtn);
    });

    await waitFor(() => {
      expect(postVaultCalls).toHaveLength(1);
    });

    const sentCall = postVaultCalls[0]!;
    expect(sentCall.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const parsedBody = JSON.parse(sentCall.body);
    expect(parsedBody.recovery_keys).toHaveLength(10);
    expect(/rk(?:10|[1-9])_/.test(sentCall.body)).toBe(false);

    // After leaving Step 2, RKs are completely gone from the DOM and provider moves to unlocked
    await waitFor(() => {
      expect(screen.queryByTestId('recovery-keys-grid')).not.toBeInTheDocument();
      expect(document.body.textContent ?? '').not.toContain('rk1_3F8K');
      expect(vaultCtx.state).toBe('unlocked');
    });
    expect(routerMocks.replace).toHaveBeenCalledWith('/app');
  });

  it('reuses the exact same Idempotency-Key and request body bytes when retrying after a network error (creates no second vault)', async () => {
    const postVaultCalls: Array<{ idempotencyKey: string | null; body: string }> = [];
    let currentMe = makeMeFixture('absent');
    let postAttempt = 0;

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
        postAttempt += 1;
        const headers = new Headers(init.headers);
        postVaultCalls.push({
          idempotencyKey: headers.get('Idempotency-Key'),
          body: String(init.body ?? ''),
        });
        if (postAttempt === 1) {
          throw new TypeError('Failed to fetch');
        }
        currentMe = makeMeFixture('present');
        return jsonResponse(
          {
            vault_key_id: 'vk:7f3a9b2c4d5e6f7a8b9c0d',
            version: 1,
          },
          201,
        );
      }
      return jsonResponse({});
    });

    renderOnboarding({ locale: 'en' });

    await waitFor(() => {
      expect(screen.getByTestId('test-session-status')).toHaveTextContent('authenticated_without_vault');
      expect(screen.getByTestId('onboarding-step-passphrase')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/^Passphrase$/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.change(screen.getByLabelText(/Confirm passphrase/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('onboarding-continue-button'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-recovery-keys')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));
    const createBtn = screen.getByTestId('onboarding-create-vault-button');

    // First attempt fails with network error
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step2-error')).toHaveTextContent(
        /Could not reach the server/i,
      );
    });
    expect(postVaultCalls).toHaveLength(1);

    // Second attempt (retry) reuses the exact same Idempotency-Key and byte-identical JSON body
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(postVaultCalls).toHaveLength(2);
    });

    expect(postVaultCalls[1]!.idempotencyKey).toBe(postVaultCalls[0]!.idempotencyKey);
    expect(postVaultCalls[1]!.body).toBe(postVaultCalls[0]!.body);
  });

  it('handles 409 vault_exists by immediately removing the RK grid from the DOM, warning the user to discard the generated RKs, and navigating to unlock', async () => {
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
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('absent'));
      if (url.endsWith('/vault') && init?.method === 'POST') {
        return problemResponse(409, 'vault_exists', {
          detail: 'Vault already exists for this user.',
        });
      }
      return jsonResponse({});
    });

    renderOnboarding({ locale: 'en' });

    await waitFor(() => {
      expect(screen.getByTestId('test-session-status')).toHaveTextContent('authenticated_without_vault');
      expect(screen.getByTestId('onboarding-step-passphrase')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/^Passphrase$/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.change(screen.getByLabelText(/Confirm passphrase/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('onboarding-continue-button'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-recovery-keys')).toBeInTheDocument();
    });
    expect(document.body.textContent ?? '').toContain('rk1_3F8K');

    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-create-vault-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-vault-exists')).toBeInTheDocument();
    });

    // RK grid is immediately removed from DOM and discard warning is shown
    expect(screen.queryByTestId('recovery-keys-grid')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('rk1_3F8K');
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Vault was created elsewhere \(another tab or device\)/i,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/discard them immediately/i);

    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-go-to-unlock'));
    });
    expect(routerMocks.replace).toHaveBeenCalledWith('/app/unlock');
  });

  it('surfaces the dedicated insufficient-memory state when Argon2id 64 MiB allocation fails in the Worker', async () => {
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
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('absent'));
      return jsonResponse({});
    });

    renderOnboarding({
      locale: 'en',
      workerFactory: makeFastOnboardingWorkerFactory({ failOom: true }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('test-session-status')).toHaveTextContent('authenticated_without_vault');
      expect(screen.getByTestId('onboarding-step-passphrase')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/^Passphrase$/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.change(screen.getByLabelText(/Confirm passphrase/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('onboarding-continue-button'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-oom')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/Not enough memory to create your vault/i);
  });

  it('works end-to-end with the real libsodium Worker shim (real Argon2id + 10 Crockford Base32 RKs) and leaves no RK in storage on mid-flow unmount/reload', async () => {
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
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('absent'));
      return jsonResponse({});
    });

    const { unmount } = renderOnboarding({
      locale: 'vi',
      workerFactory: () => createWorkerShim({ deriveKek: fastTestDeriveKek }).port,
    });

    await waitFor(() => {
      expect(screen.getByTestId('test-session-status')).toHaveTextContent('authenticated_without_vault');
      expect(screen.getByTestId('onboarding-step-passphrase')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText(/^Passphrase$/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.change(screen.getByLabelText(/Gõ lại passphrase/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('onboarding-continue-button'));

    await waitFor(
      () => {
        expect(screen.getByTestId('onboarding-step-recovery-keys')).toBeInTheDocument();
      },
      { timeout: 15_000 },
    );

    const slot1 = screen.getByTestId('recovery-key-slot-1').textContent ?? '';
    const slot10 = screen.getByTestId('recovery-key-slot-10').textContent ?? '';
    expect(slot1).toMatch(/^rk1_[0-7][0-9A-TV-Z]{3}(?:-[0-9A-TV-Z]{4}){5}-[0-9A-TV-Z]{2}$/);
    expect(slot10).toMatch(/^rk10_[0-7][0-9A-TV-Z]{3}(?:-[0-9A-TV-Z]{4}){5}-[0-9A-TV-Z]{2}$/);

    // Simulate reload / leaving mid-flow before ticking -> unmount leaves zero RKs in DOM or storage
    unmount();
    expect(document.body.textContent ?? '').not.toContain(slot1);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  }, 20_000);

  it('supports Download .txt, Print, Copy all (with 30s clipboard clear), Back button RK wipe, and maps 429 rate_limited / 503 vault_mutations_disabled / 403 email_not_verified', async () => {
    let nextError: Response | null = null;
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
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture('absent'));
      if (url.endsWith('/vault') && init?.method === 'POST') {
        if (nextError) return nextError;
        return problemResponse(503, 'vault_mutations_disabled');
      }
      return jsonResponse({});
    });

    const createObjectUrlSpy = vi.fn(() => 'blob:mock-rk-url');
    const revokeObjectUrlSpy = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: createObjectUrlSpy,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeObjectUrlSpy,
    });

    const printSpy = vi.fn();
    Object.defineProperty(window, 'print', {
      configurable: true,
      writable: true,
      value: printSpy,
    });

    const writeTextSpy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextSpy },
    });

    renderOnboarding({ locale: 'en' });

    await waitFor(() => {
      expect(screen.getByTestId('test-session-status')).toHaveTextContent('authenticated_without_vault');
      expect(screen.getByTestId('onboarding-step-passphrase')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/^Passphrase$/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.change(screen.getByLabelText(/Confirm passphrase/i), {
      target: { value: STRONG_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('onboarding-continue-button'));

    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-recovery-keys')).toBeInTheDocument();
    });

    // Download .txt
    fireEvent.click(screen.getByTestId('recovery-keys-download'));
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('recovery-keys-action-status')).toHaveTextContent(
      /Downloaded engram-recovery-keys\.txt/i,
    );

    // Print
    fireEvent.click(screen.getByTestId('recovery-keys-print'));
    expect(printSpy).toHaveBeenCalledTimes(1);

    // Copy all
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-keys-copy'));
    });
    expect(writeTextSpy).toHaveBeenCalledWith(expect.stringContaining('rk1_3F8K'));
    expect(screen.getByTestId('recovery-keys-action-status')).toHaveTextContent(
      /Copied 10 keys/i,
    );

    // Tick and test 503 vault_mutations_disabled
    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));
    nextError = problemResponse(503, 'vault_mutations_disabled');
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-create-vault-button'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step2-error')).toHaveTextContent(
        /Vault key changes are temporarily paused/i,
      );
    });

    // Test 429 rate_limited
    nextError = problemResponse(429, 'rate_limited', { retry_after: 42 });
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-create-vault-button'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step2-error')).toHaveTextContent(
        /Please wait 42 seconds/i,
      );
    });

    // Test 403 email_not_verified
    nextError = problemResponse(403, 'email_not_verified');
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-create-vault-button'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step2-error')).toHaveTextContent(
        /Verify your email before creating a vault/i,
      );
    });

    // Back to Step 1 wipes RKs from DOM
    await act(async () => {
      fireEvent.click(screen.getByTestId('onboarding-back-button'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('onboarding-step-passphrase')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('recovery-keys-grid')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('rk1_3F8K');
  });
});
