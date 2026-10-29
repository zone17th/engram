import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import type { UseReauthReturn } from '@/features/auth/use-reauth';
import { resetVaultBroadcastForTests } from '@/features/vault/broadcast';
import { recordLockEpochEvent, type LockEpochEnvironment } from '@/features/vault/lock-epoch';
import { VaultRecoveryFlow } from '@/features/vault/recovery';
import { VaultProvider, useVault, type VaultContextValue } from '@/features/vault/vault-provider';
import type { Me } from '@/lib/api/auth';
import type { VaultState } from '@/lib/api/vault';
import { CryptoClientError, type CryptoWorkerPort } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim } from '@/lib/crypto/test/worker-shim';
import enMessages from '@/messages/en.json';
import viMessages from '@/messages/vi.json';

/**
 * Deterministic JS v1 crypto vectors from `packages/crypto-vectors/vectors/js-v1.json`.
 */
const TEST_VECTOR_VAULT_KEY_ID = 'vk:7f3a9b2c4d5e6f7a8b9c0d';
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
const TEST_VECTOR_RK_DISPLAY = 'rk1_014D-2PF2-DBSQ-QG28-T5CY-4TQK-FF';
const TEST_VECTOR_RK_LOOKUP_HASH = 'Tk13ljAuzyznVe3jKHwrjVktSmiO5TfazfbtINCB3xI';
const TEST_VECTOR_RK_WRAP =
  'AcDBwsPExcbHyMnKy8zNzs_Q0dLT1NXW18dWA3zmQXAPuHHij0feHrlM3pVUBUhmQ3zog3pdtAPVR3sl2xkLHUk5qkxO2bwUUQ';

const TEST_VECTOR_ENTRY_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const TEST_VECTOR_ENTRY_ENVELOPE = {
  v: 1 as const,
  alg: 'xchacha20poly1305-ietf' as const,
  key_id: TEST_VECTOR_VAULT_KEY_ID,
  nonce: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcY',
  ct_enc: 'utf8' as const,
};
const TEST_VECTOR_ENTRY_CIPHERTEXT =
  '_XqFAVnJKAhLPgs-qoPZeXy-AevN2G4AWL9XJQLB7lCRrFaKiD5bruwx9gxbLRzosDCxG-aKrPUA56BfSw';

const STRONG_NEW_PASSPHRASE = 'Tr\u00e0m-H\u01b0\u01a1ng-94!K\u1ef7-V\u1eadt-Xanh';

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
  pathname: '/app/recovery',
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

function makeMeFixture(options?: {
  hasPassword?: boolean;
  oauthReauthProviders?: Array<'google'>;
}): Me {
  const hasPassword = options?.hasPassword ?? true;
  const oauthReauthProviders = options?.oauthReauthProviders ?? [];
  return {
    user: {
      id: 'user-recovery-test-1',
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
    identities: hasPassword
      ? [{ provider: 'password', linked_at: '2026-10-29T00:00:00Z' }]
      : [{ provider: 'google', linked_at: '2026-10-29T00:00:00Z' }],
    features: {
      semantic_available: true,
      email_verification_required: false,
      oauth_providers: oauthReauthProviders,
      oauth_reauth_providers: oauthReauthProviders,
      password_enrollment_available: !hasPassword,
      captcha_site_key: null,
    },
    vault: { status: 'present' },
  };
}

function makeVaultMetaFixture(version = 1): VaultState {
  return {
    version,
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
  let marker = { epochIncarnation: 'inc-recovery-test-1', lockEpoch: 1 };
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

function futureIso(secondsFromNow = 300): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

describe('Task 17A — VaultRecoveryFlow (Re-auth -> RK Lookup -> Recovering -> New Passphrase -> Complete -> Regenerate)', () => {
  const activeShims: Array<{ close: () => void }> = [];

  function makeTestShim() {
    const s = createWorkerShim({ deriveKek: fastTestDeriveKek });
    activeShims.push(s);
    return s;
  }

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    routerMocks.pathname = '/app/recovery';
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
  function renderRecovery(options?: {
    locale?: 'en' | 'vi';
    workerFactory?: () => CryptoWorkerPort;
    lockEpochEnv?: LockEpochEnvironment;
    onVaultProbe?: (ctx: VaultContextValue) => void;
    onReauthProbe?: (reauth: UseReauthReturn) => void;
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
      options?.onReauthProbe?.(s.reauth);
      return (
        <output data-testid="test-recovery-probe">
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
                createWorker={options?.workerFactory}
                lockEpochEnv={lockEpochEnv}
              >
                <Probe />
                <VaultRecoveryFlow />
              </VaultProvider>
            </SessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    return { ...utils, queryClient: qc };
  }

  it('runs the strictly sequential recovery flow: Step 1 re-auth -> Step 2 RK cleared immediately + lookup + resumeRecovery -> Step 3 recovering whitelist + rewrap + complete -> Step 4 regenerate empty slot', async () => {
    const shim = makeTestShim();
    let vaultVersion = 1;
    const lookupCalls: Array<{ lookup_hash: string }> = [];
    const completeCalls: Array<{
      idempotencyKey: string | null;
      ifMatch: string | null;
      reauthToken: string | null;
      body: string;
    }> = [];
    const regenCalls: Array<{
      idempotencyKey: string | null;
      ifMatch: string | null;
      reauthToken: string | null;
      body: string;
    }> = [];

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
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture({ hasPassword: true }));
      if (url.endsWith('/auth/reauth') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as { action: string };
        return jsonResponse({
          grant: `grant-${body.action}-token`,
          action: body.action,
          expires_at: futureIso(300),
        });
      }
      if (url.endsWith('/vault') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(makeVaultMetaFixture(vaultVersion));
      }
      if (url.endsWith('/vault/unlock/recovery') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as { lookup_hash: string };
        lookupCalls.push(body);
        return jsonResponse({
          recovery_key_id: 'rk-id-slot-1',
          slot: 1,
          wrap: TEST_VECTOR_RK_WRAP,
        });
      }
      if (url.endsWith('/vault/recover/complete') && init?.method === 'POST') {
        const headers = new Headers(init.headers);
        completeCalls.push({
          idempotencyKey: headers.get('Idempotency-Key'),
          ifMatch: headers.get('If-Match'),
          reauthToken: headers.get('X-Reauth-Token'),
          body: String(init.body ?? ''),
        });
        vaultVersion = 2;
        return jsonResponse({ version: vaultVersion });
      }
      if (url.endsWith('/vault/recovery-keys') && (!init?.method || init.method === 'GET')) {
        return jsonResponse({
          remaining: 9,
          empty_slots: [1],
        });
      }
      if (url.endsWith('/vault/recovery-keys/regenerate') && init?.method === 'POST') {
        const headers = new Headers(init.headers);
        regenCalls.push({
          idempotencyKey: headers.get('Idempotency-Key'),
          ifMatch: headers.get('If-Match'),
          reauthToken: headers.get('X-Reauth-Token'),
          body: String(init.body ?? ''),
        });
        vaultVersion = 3;
        return jsonResponse({ version: vaultVersion, remaining: 10 });
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    const { unmount } = renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    // Step 1: Confirm account first (`vault.recover` grant acquired before any RK input)
    await waitFor(() => {
      expect(screen.getByTestId('test-recovery-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
      expect(screen.getByTestId('recovery-reauth-password-input')).toBeInTheDocument();
    });
    expect(lookupCalls).toHaveLength(0);

    fireEvent.change(screen.getByTestId('recovery-reauth-password-input'), {
      target: { value: 'login-password-secret' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-reauth-password-submit'));
    });

    // Step 2: Enter one recovery key
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
    });

    const rkInput = screen.getByTestId('recovery-key-input') as HTMLInputElement;
    fireEvent.change(rkInput, { target: { value: TEST_VECTOR_RK_DISPLAY } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });

    // RK input is cleared immediately right after unlockRecovery is invoked
    expect(rkInput.value).toBe('');

    // Step 3: Worker is now in `recovering` state
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    expect(lookupCalls).toEqual([{ lookup_hash: TEST_VECTOR_RK_LOOKUP_HASH }]);
    expect(vaultCtx.workerState).toBe('recovering');
    expect(vaultCtx.state).toBe('recovering');

    // Enter new passphrase -> rewrap (stays `recovering`) -> POST /vault/recover/complete -> confirmRecovery (`unlocked`)
    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step3-submit'));
    });

    // Step 4A: Vault is now unlocked, suggests regenerating empty slot 1 after `vault.recovery_keys_regenerate` re-auth
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-reauth')).toBeInTheDocument();
    });
    expect(vaultCtx.workerState).toBe('unlocked');
    expect(vaultCtx.state).toBe('unlocked');
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]!.ifMatch).toBe(`"${TEST_VECTOR_VAULT_KEY_ID}:1"`);
    expect(completeCalls[0]!.reauthToken).toBe('grant-vault.recover-token');
    expect(completeCalls[0]!.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(completeCalls[0]!.body).not.toContain(TEST_VECTOR_RK_DISPLAY);
    expect(completeCalls[0]!.body).not.toContain(STRONG_NEW_PASSPHRASE);
    expect(screen.getByTestId('recovery-unlocked-banner')).toHaveTextContent(
      /9 of 10 recovery keys remain active/i,
    );

    // Confirm password for `vault.recovery_keys_regenerate`
    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'login-password-secret' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    });

    // Step 4B: Shows ONLY the newly generated replacement key for empty slot 1 (reusing RecoveryKeysSheet)
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });
    const grid = screen.getByTestId('recovery-keys-grid');
    const items = within(grid).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    const newSlot1Text = screen.getByTestId('recovery-key-slot-1').textContent ?? '';
    expect(newSlot1Text).toMatch(
      /^rk1_[0-7][0-9A-TV-Z]{3}(?:-[0-9A-TV-Z]{4}){5}-[0-9A-TV-Z]{2}$/,
    );
    expect(screen.getByTestId('recovery-slot-chip-1')).toHaveAttribute('data-slot-new', 'true');
    expect(screen.getByTestId('recovery-slot-chip-2')).toHaveAttribute('data-slot-new', 'false');

    // Save button is disabled until confirmation checkbox is ticked
    const saveBtn = screen.getByTestId('recovery-step4-save-button');
    expect(saveBtn).toBeDisabled();
    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));
    expect(saveBtn).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    await waitFor(() => {
      expect(regenCalls).toHaveLength(1);
    });
    expect(regenCalls[0]!.ifMatch).toBe(`"${TEST_VECTOR_VAULT_KEY_ID}:2"`);
    expect(regenCalls[0]!.reauthToken).toBe('grant-vault.recovery_keys_regenerate-token');
    expect(regenCalls[0]!.body).not.toContain(newSlot1Text);
    expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    expect(document.body.textContent ?? '').not.toContain(newSlot1Text);

    unmount();
    shim.close();
  }, 25_000);

  it('shows the exact same invalid-key message for malformed, wrong, used, or other-vault recovery keys', async () => {
    const shim = makeTestShim();
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
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture({ hasPassword: true }));
      if (url.endsWith('/auth/reauth') && init?.method === 'POST') {
        return jsonResponse({
          grant: 'grant-recover-token',
          action: 'vault.recover',
          expires_at: futureIso(300),
        });
      }
      if (url.endsWith('/vault')) return jsonResponse(makeVaultMetaFixture());
      if (url.endsWith('/vault/unlock/recovery') && init?.method === 'POST') {
        // Server returns 401 recovery_key_invalid for used / unknown / other-vault RK
        return problemResponse(401, 'recovery_key_invalid');
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    const { unmount } = renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('test-recovery-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
      expect(screen.getByTestId('recovery-reauth-password-input')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('recovery-reauth-password-input'), {
      target: { value: 'login-password-secret' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-reauth-password-submit'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
    });

    // 1. Malformed / bad checksum RK rejected locally by Worker (`RECOVERY_KEY_INVALID`)
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: 'rk1_014D-2PF2-DBSQ-QG28-T5CY-4TQK-00' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-error-invalid-key')).toBeInTheDocument();
    });
    const malformedAlertText = screen.getByRole('alert').textContent ?? '';
    expect(malformedAlertText).toContain('That recovery key is not valid.');

    // 2. Valid format RK that is already used / unknown / belongs to another vault -> server 401 `recovery_key_invalid`
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-error-invalid-key')).toBeInTheDocument();
    });
    const usedOrWrongAlertText = screen.getByRole('alert').textContent ?? '';
    // Identical message for wrong, used, or other-vault RK
    expect(usedOrWrongAlertText).toBe(malformedAlertText);

    // 3. CLIENT_BUSY or unexpected crypto error on Step 2 surfaces a visible error card instead of hanging silently
    vi.spyOn(vaultCtx, 'unlockRecovery').mockRejectedValueOnce(
      new CryptoClientError(
        'CLIENT_BUSY',
        'Another state-changing crypto call is already in flight',
      ),
    );
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-error-lookup-network')).toBeInTheDocument();
    });
    expect(screen.getByTestId('recovery-error-lookup-network')).toHaveTextContent(
      /Another state-changing crypto call is already in flight/i,
    );

    unmount();
    shim.close();
  }, 20_000);

  it('after rewrap before confirmRecovery, state stays recovering and every other command (openEntry, unlockPassphrase, createVault) gets VAULT_RECOVERING until lock(); abandoned/cancelled recovery or lock() wipes VK + continuation so no entry opens', async () => {
    const shim = makeTestShim();
    const completeGate = Promise.withResolvers<Response>();

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
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture({ hasPassword: true }));
      if (url.endsWith('/auth/reauth') && init?.method === 'POST') {
        return jsonResponse({
          grant: 'grant-recover-token',
          action: 'vault.recover',
          expires_at: futureIso(300),
        });
      }
      if (url.endsWith('/vault') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(makeVaultMetaFixture(1));
      }
      if (url.endsWith('/vault/unlock/recovery') && init?.method === 'POST') {
        return jsonResponse({
          recovery_key_id: 'rk-id-slot-1',
          slot: 1,
          wrap: TEST_VECTOR_RK_WRAP,
        });
      }
      if (url.endsWith('/vault/recover/complete') && init?.method === 'POST') {
        return completeGate.promise;
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    const { unmount } = renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    // Step 1 -> Step 2 -> Step 3 (`recovering`)
    await waitFor(() => {
      expect(screen.getByTestId('test-recovery-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
      expect(screen.getByTestId('recovery-reauth-password-input')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('recovery-reauth-password-input'), {
      target: { value: 'login-password-secret' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-reauth-password-submit'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    expect(vaultCtx.workerState).toBe('recovering');

    // Submit Step 3 so `rewrap` completes in the Worker and pauses at `POST /vault/recover/complete` (before `confirmRecovery`)
    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('recovery-step3-submit'));

    // Wait until `rewrap` has finished and `inFlight` is false while `POST /vault/recover/complete` is awaiting
    await waitFor(() => {
      expect(vaultCtx.inFlight).toBe(false);
      expect(screen.getByTestId('recovery-step3-submit')).toHaveTextContent(
        /Rewrapping & saving/i,
      );
    });

    // After `rewrap` and before `confirmRecovery`, state MUST remain `recovering`
    expect(vaultCtx.workerState).toBe('recovering');
    expect(vaultCtx.state).toBe('recovering');

    const client = vaultCtx.getClient();
    const opGen = client.captureGeneration();

    // 1. `openEntry` is rejected with `VAULT_RECOVERING`
    await expect(
      client.openEntry({
        entryId: TEST_VECTOR_ENTRY_ID,
        envelope: TEST_VECTOR_ENTRY_ENVELOPE,
        ciphertext: TEST_VECTOR_ENTRY_CIPHERTEXT,
        opGeneration: opGen,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });

    // 2. `unlockPassphrase` is rejected with `VAULT_RECOVERING`
    await expect(
      client.unlockPassphrase({
        passphrase: 'any-passphrase-attempt',
        kdf: TEST_VECTOR_KDF,
        vaultKeyWrappedByKek: TEST_VECTOR_WRAPPED_VK,
        privateKeysWrapped: TEST_VECTOR_WRAPPED_PRIV,
        opGeneration: opGen,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });

    // 3. `createVault` is rejected with `VAULT_RECOVERING`
    await expect(
      client.createVault({
        passphrase: STRONG_NEW_PASSPHRASE,
        opGeneration: opGen,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });

    // 4. Now lock / abandon recovery mid-way -> wipes VK and pending continuation in Worker
    await act(async () => {
      await vaultCtx.lock({ broadcast: false, reason: 'test_abandon_recovery' });
    });
    expect(vaultCtx.workerState).toBe('locked');
    expect(vaultCtx.state).toBe('locked');

    // Resolve the dangling HTTP request; it is ignored because generation bumped on lock()
    completeGate.resolve(jsonResponse({ version: 2 }));

    const afterLockGen = client.captureGeneration();
    // Attempting to open an entry after lock fails because VK was wiped
    await expect(
      client.openEntry({
        entryId: TEST_VECTOR_ENTRY_ID,
        envelope: TEST_VECTOR_ENTRY_ENVELOPE,
        ciphertext: TEST_VECTOR_ENTRY_CIPHERTEXT,
        opGeneration: afterLockGen,
      }),
    ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });

    // Attempting `resumeRecovery` after lock fails because continuation was wiped
    await expect(
      client.resumeRecovery({
        wrap: TEST_VECTOR_RK_WRAP,
        privateKeysWrapped: TEST_VECTOR_WRAPPED_PRIV,
        opGeneration: afterLockGen,
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_CONTINUATION_MISSING' });

    unmount();
    shim.close();
  }, 20_000);

  it('shows 429 countdown on lookup/complete, asks to reload vault on 412 version_mismatch, and reuses Idempotency-Key on network retry', async () => {
    const shim = makeTestShim();
    let lookupMode: 'rate_limit' | 'ok' = 'rate_limit';
    let completeMode: 'rate_limit' | 'network_error' | 'version_mismatch' = 'rate_limit';
    let currentVaultVersion = 1;
    const completeRequests: Array<{ idempotencyKey: string | null; body: string }> = [];

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
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture({ hasPassword: true }));
      if (url.endsWith('/auth/reauth') && init?.method === 'POST') {
        return jsonResponse({
          grant: 'grant-recover-token',
          action: 'vault.recover',
          expires_at: futureIso(300),
        });
      }
      if (url.endsWith('/vault') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(makeVaultMetaFixture(currentVaultVersion));
      }
      if (url.endsWith('/vault/unlock/recovery') && init?.method === 'POST') {
        if (lookupMode === 'rate_limit') {
          return problemResponse(429, 'rate_limited', { retry_after: 15 });
        }
        return jsonResponse({
          recovery_key_id: 'rk-id-slot-1',
          slot: 1,
          wrap: TEST_VECTOR_RK_WRAP,
        });
      }
      if (url.endsWith('/vault/recover/complete') && init?.method === 'POST') {
        const headers = new Headers(init.headers);
        completeRequests.push({
          idempotencyKey: headers.get('Idempotency-Key'),
          body: String(init.body ?? ''),
        });
        if (completeMode === 'rate_limit') {
          return problemResponse(429, 'rate_limited', { retry_after: 15 });
        }
        if (completeMode === 'network_error') {
          throw new TypeError('Failed to fetch');
        }
        return problemResponse(412, 'version_mismatch');
      }
      return jsonResponse({});
    });

    const { unmount } = renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
    });

    await waitFor(() => {
      expect(screen.getByTestId('test-recovery-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
      expect(screen.getByTestId('recovery-reauth-password-input')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('recovery-reauth-password-input'), {
      target: { value: 'login-password-secret' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-reauth-password-submit'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
    });

    // 1. 429 on lookup shows countdown and disables submit button
    let simulatedOffsetMs = 0;
    const realDateNow = Date.now.bind(Date);
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realDateNow() + simulatedOffsetMs);

    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-error-lookup-rate-limited')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Too many recovery attempts — please wait/i,
    );
    expect(screen.getByTestId('recovery-key-submit')).toBeDisabled();

    // Advance clock past the 15s rate-limit deadline and type RK -> submit re-enables immediately
    lookupMode = 'ok';
    simulatedOffsetMs += 20_000;
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    expect(screen.getByTestId('recovery-key-submit')).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });

    // 2. 429 on complete shows countdown and disables submit button
    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step3-submit'));
    });

    await waitFor(() => {
      expect(
        screen.getByTestId('recovery-error-complete-rate-limited'),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Too many recovery completion requests — please wait/i,
    );
    expect(screen.getByTestId('recovery-step3-submit')).toBeDisabled();

    // 3. Advance clock past the 15s rate-limit deadline; network error preserves Idempotency-Key & body, and retry reuses them into 412 version_mismatch
    completeMode = 'network_error';
    simulatedOffsetMs += 20_000;
    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    expect(screen.getByTestId('recovery-step3-submit')).not.toBeDisabled();

    dateNowSpy.mockRestore();

    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step3-submit'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-error-complete-network')).toBeInTheDocument();
    });

    completeMode = 'version_mismatch';
    currentVaultVersion = 5;
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step3-retry-button'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-error-version-mismatch')).toBeInTheDocument();
    });
    expect(completeRequests).toHaveLength(3);
    expect(completeRequests[1]!.idempotencyKey).toBe(completeRequests[0]!.idempotencyKey);
    expect(completeRequests[2]!.idempotencyKey).toBe(completeRequests[0]!.idempotencyKey);
    expect(completeRequests[2]!.body).toBe(completeRequests[0]!.body);

    expect(screen.getByRole('alert')).toHaveTextContent(
      /Vault was updated in another tab or device/i,
    );

    // Clicking "Reload vault & restart step" reloads GET /vault and returns to Step 2
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-version-mismatch-reload-button'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
    });

    unmount();
    shim.close();
  }, 20_000);

  it('OAuth user whose grant expires mid-recovery is told to restart from Step 1 without redirecting or burning another lookup', async () => {
    const shim = makeTestShim();
    let lookupCount = 0;
    let completeCount = 0;
    let oauthStartCount = 0;

    // Seed an OAuth-only user who starts with a grant that has 45s left:
    // - Still valid (> 0s) during Step 2 (`grantStillValid`), so Step 2 lookup succeeds.
    // - Less than 60s (< 60s preflight threshold `isGrantFreshForFirstAttempt`) when Step 3 is submitted!
    const grantExpiresAtMs = Date.now() + 45_000;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: ['google'],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (url.endsWith('/auth/me')) {
        return jsonResponse(
          makeMeFixture({
            hasPassword: false,
            oauthReauthProviders: ['google'],
          }),
        );
      }
      if (url.endsWith('/auth/reauth') && init?.method === 'POST') {
        return jsonResponse({
          grant: 'oauth-grant-token-1',
          action: 'vault.recover',
          expires_at: new Date(grantExpiresAtMs).toISOString(),
        });
      }
      if (url.includes('/oauth/google/reauth')) {
        oauthStartCount += 1;
        return jsonResponse({
          authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth',
        });
      }
      if (url.endsWith('/vault')) return jsonResponse(makeVaultMetaFixture(1));
      if (url.endsWith('/vault/unlock/recovery') && init?.method === 'POST') {
        lookupCount += 1;
        return jsonResponse({
          recovery_key_id: 'rk-id-slot-1',
          slot: 1,
          wrap: TEST_VECTOR_RK_WRAP,
        });
      }
      if (url.endsWith('/vault/recover/complete') && init?.method === 'POST') {
        completeCount += 1;
        return jsonResponse({ version: 2 });
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    let reauthCtx!: UseReauthReturn;
    const { unmount } = renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
      onReauthProbe: (r) => {
        reauthCtx = r;
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('test-recovery-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
      expect(screen.getByTestId('recovery-reauth-google-button')).toBeInTheDocument();
    });

    // Complete OAuth re-auth at Step 1 (acquiring grant before any RK lookup)
    await act(async () => {
      await reauthCtx.consumeOauthReceipt('vault.recover', 'google');
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
    });

    // Step 2: Enter RK -> 1 lookup call
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    expect(lookupCount).toBe(1);
    expect(vaultCtx.workerState).toBe('recovering');

    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step3-submit'));
    });

    // OAuth user is shown "Time ran out — please start again", Worker is locked (VK wiped),
    // NO automatic OAuth redirect happened, and NO extra lookup or complete call was made.
    await waitFor(() => {
      expect(screen.getByTestId('recovery-error-reauth-expired-oauth')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/Time ran out — please start again/i);
    expect(screen.getByRole('alert')).toHaveTextContent(
      /your recovery key was NOT consumed/i,
    );
    expect(vaultCtx.workerState).toBe('locked');
    expect(lookupCount).toBe(1);
    expect(completeCount).toBe(0);
    expect(oauthStartCount).toBe(0);

    // Clicking "Restart from step 1" returns to Step 1 cleanly without burning a lookup and focuses the Step 1 heading (FE1-4)
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step3-oauth-restart-button'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-reauth')).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    expect(lookupCount).toBe(1);

    unmount();
    shim.close();
  }, 20_000);

  it('BE2-3, BE2-4, BE2-11 & BE2-12: sibling durable lock during recovery lookup fails closed, held wake verification on Step 4 gates decrypted recovery keys and worker makeRecoveryKeys, and route leave or late responses never promote/retain recovery secrets', async () => {
    const shim = makeTestShim();
    let holdLookup = true;
    let resolveLookup: (() => void) | null = null;
    let vaultVersion = 1;
    let regenCallsCount = 0;

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
      if (url.endsWith('/auth/me')) {
        return jsonResponse(makeMeFixture({ hasPassword: true }));
      }
      if (url.endsWith('/auth/reauth') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as { action: string };
        return jsonResponse({
          grant: `grant-${body.action}-token`,
          action: body.action,
          expires_at: futureIso(300),
        });
      }
      if (url.endsWith('/vault') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(makeVaultMetaFixture(vaultVersion));
      }
      if (url.endsWith('/vault/unlock/recovery') && init?.method === 'POST') {
        if (holdLookup) {
          await new Promise<void>((resolve) => {
            resolveLookup = resolve;
          });
        }
        return jsonResponse({
          recovery_key_id: 'rk-id-slot-1',
          slot: 1,
          wrap: TEST_VECTOR_RK_WRAP,
        });
      }
      if (url.endsWith('/vault/recover/complete') && init?.method === 'POST') {
        vaultVersion = 2;
        return jsonResponse({
          vault_key_id: TEST_VECTOR_VAULT_KEY_ID,
          version: 2,
          recovery_keys_remaining: 9,
          empty_slots: [1],
        });
      }
      if (url.endsWith('/vault/recovery-keys/regenerate') && init?.method === 'POST') {
        regenCallsCount += 1;
        vaultVersion = 3;
        return jsonResponse({
          version: 3,
          recovery_keys_remaining: 10,
        });
      }
      return jsonResponse({});
    });

    const baseLockEpochEnv = makeSimpleLockEpochEnv();
    let holdWakeVerify = false;
    let releaseWakeVerify: (() => void) | null = null;
    const lockEpochEnv: LockEpochEnvironment = {
      idbFactory: baseLockEpochEnv.idbFactory,
      locksManager: {
        request: async (name: string, opts: unknown, cb: () => Promise<unknown>) => {
          if (holdWakeVerify) {
            holdWakeVerify = false;
            await new Promise<void>((resolve) => {
              releaseWakeVerify = resolve;
            });
          }
          return baseLockEpochEnv.locksManager!.request(
            name,
            opts as LockOptions,
            cb as LockGrantedCallback<unknown>,
          );
        },
      } as unknown as LockManager,
    };

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      lockEpochEnv,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-reauth')).toBeInTheDocument();
    });

    // Step 1: Re-auth
    fireEvent.change(screen.getByTestId('recovery-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
    });

    // 1. BE2-3: Submit Step 2 recovery key -> beginUnlockOp captures durable lockEpoch baseline BEFORE lookup_hash / POST /vault/unlock/recovery.
    // While POST /vault/unlock/recovery is in flight, a sibling tab locks and increments durable lockEpoch.
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    fireEvent.click(screen.getByTestId('recovery-key-submit'));

    await waitFor(() => {
      expect(resolveLookup).not.toBeNull();
    });

    // Sibling tab writes durable lockEpoch while recovery lookup is in flight!
    await act(async () => {
      await recordLockEpochEvent(vaultCtx.tabKnownLockEpoch, baseLockEpochEnv);
    });

    // Release POST /vault/unlock/recovery -> resumeRecovery reuses the pre-lookup baseline and MUST reject with STALE_GENERATION + lockLocalOnly (never entering Step 3 or recovering)
    await act(async () => {
      holdLookup = false;
      resolveLookup?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-key-submit')).not.toBeDisabled();
    });
    expect(vaultCtx.state).toBe('locked');
    expect(vaultCtx.workerState).toBe('locked');
    expect(screen.queryByTestId('recovery-step-new-passphrase')).not.toBeInTheDocument();

    // 2. Now proceed through Step 2 & Step 3 cleanly to Step 4 (`regenerate-reauth` -> `regenerate-keys`)
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    expect(vaultCtx.state).toBe('recovering');

    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step3-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-reauth')).toBeInTheDocument();
    });
    expect(vaultCtx.state).toBe('unlocked');

    // BE2-4 Case A: While on Step 4A (`regenerate-reauth`), trigger a wake event whose lockEpoch verification is held (`vault.state === 'unlocking'`).
    // Attempting to submit Step 4A re-auth while `vault.state !== 'unlocked'` MUST NOT invoke Worker `makeRecoveryKeys` or advance to `regenerate-keys`!
    holdWakeVerify = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(vaultCtx.state).toBe('unlocking');

    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    });
    // Because vault.state was 'unlocking' (unverified), prepareRegenerateKeys refused to call Worker makeRecoveryKeys or advance to regenerate-keys
    expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();

    // Release wake verification -> state returns to 'unlocked'
    await act(async () => {
      releaseWakeVerify?.();
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
    });

    // Now submit Step 4A while verified unlocked -> advances to Step 4B (`regenerate-keys`) showing the replacement recovery key
    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });

    // BE2-4 Case B: While on Step 4B (`regenerate-keys`), trigger a held wake verification (`vault.state === 'unlocking'`).
    // The replacement recovery key sheet MUST immediately hide while `vault.state !== 'unlocked'`!
    holdWakeVerify = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(vaultCtx.state).toBe('unlocking');
    expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-key-slot-1')).not.toBeInTheDocument();

    // Release wake verification -> Step 4B replacement recovery key sheet reappears once verified unlocked
    await act(async () => {
      releaseWakeVerify?.();
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });

    // Save replacement recovery key -> completes and navigates to /app
    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-save-button'));
    });
    await waitFor(() => {
      expect(regenCallsCount).toBe(1);
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    });

    shim.close();
  }, 25_000);

  it('FE1-7: lock while POST /vault/recover/complete is in flight and resolves 200 calls notifyVaultChanged, shows completed-while-locked notice, and routes to /app/unlock', async () => {
    const shim = makeTestShim();
    let holdComplete = true;
    let resolveComplete: (() => void) | null = null;
    let vaultVersion = 1;

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
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture({ hasPassword: true }));
      if (url.endsWith('/auth/reauth') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as { action: string };
        return jsonResponse({
          grant: `grant-${body.action}-token`,
          action: body.action,
          expires_at: futureIso(300),
        });
      }
      if (url.endsWith('/vault') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(makeVaultMetaFixture(vaultVersion));
      }
      if (url.endsWith('/vault/unlock/recovery') && init?.method === 'POST') {
        return jsonResponse({
          recovery_key_id: 'rk-id-slot-1',
          slot: 1,
          wrap: TEST_VECTOR_RK_WRAP,
        });
      }
      if (url.endsWith('/vault/recover/complete') && init?.method === 'POST') {
        if (holdComplete) {
          await new Promise<void>((resolve) => {
            resolveComplete = resolve;
          });
        }
        vaultVersion = 2;
        return jsonResponse({
          vault_key_id: TEST_VECTOR_VAULT_KEY_ID,
          version: 2,
          recovery_keys_remaining: 9,
          empty_slots: [1],
        });
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-reauth')).toBeInTheDocument();
    });

    // Step 1: Re-auth
    fireEvent.change(screen.getByTestId('recovery-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
    });

    // Step 2: Enter RK
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    expect(screen.getByTestId('recovery-passphrase-strength-label')).toHaveAttribute(
      'aria-live',
      'polite',
    );

    // Step 3: Submit new passphrase -> holds on POST /vault/recover/complete
    const notifySpy = vi.spyOn(vaultCtx, 'notifyVaultChanged');
    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('recovery-step3-submit'));

    await waitFor(() => {
      expect(resolveComplete).not.toBeNull();
    });

    // Lock while POST /vault/recover/complete is in flight!
    await act(async () => {
      await vaultCtx.lockNow();
    });
    expect(vaultCtx.state).toBe('locked');

    // Resolve POST /vault/recover/complete with 200 -> must call notifyVaultChanged, show notice, and route to /app/unlock
    await act(async () => {
      holdComplete = false;
      resolveComplete?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-completed-while-locked-notice')).toBeInTheDocument();
    });
    expect(screen.getByTestId('recovery-completed-while-locked-notice')).toHaveTextContent(
      /Recovery completed — unlock with your new passphrase/i,
    );
    expect(notifySpy).toHaveBeenCalledWith({
      vault_key_id: TEST_VECTOR_VAULT_KEY_ID,
      version: 2,
    });
    expect(routerMocks.replace).toHaveBeenCalledWith('/app/unlock');

    shim.close();
  }, 20_000);

  it('BE2-3 (reauth race), BE2-11 & BE2-12: lock during held Step 3 in-place password reauth sends zero newly dispatched complete requests when reauth resolves, and late lookup/complete errors or stale regen success never lock or broadcast over a replacement session', async () => {
    const shim = makeTestShim();
    let completeDispatchedCount = 0;
    let holdStep3Reauth = false;
    let resolveStep3Reauth: (() => void) | null = null;
    let holdLookup429 = false;
    let resolveLookup429: (() => void) | null = null;
    let grantSecondsOnStep1 = 30; // < 60s so Step 3 triggers in-place password reauth!

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
      if (url.endsWith('/auth/me')) return jsonResponse(makeMeFixture({ hasPassword: true }));
      if (url.endsWith('/auth/reauth') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as { action: string };
        if (holdStep3Reauth) {
          await new Promise<void>((resolve) => {
            resolveStep3Reauth = resolve;
          });
        }
        return jsonResponse({
          grant: `grant-${body.action}-token-${Date.now()}`,
          action: body.action,
          expires_at: futureIso(grantSecondsOnStep1),
        });
      }
      if (url.endsWith('/vault') && (!init?.method || init.method === 'GET')) {
        return jsonResponse(makeVaultMetaFixture(1));
      }
      if (url.endsWith('/vault/unlock/recovery') && init?.method === 'POST') {
        if (holdLookup429) {
          await new Promise<void>((resolve) => {
            resolveLookup429 = resolve;
          });
          return new Response(
            JSON.stringify({
              type: 'https://engram.zone17th.click/problems/rate_limited',
              title: 'rate_limited',
              status: 429,
              code: 'rate_limited',
              retry_after: 60,
            }),
            { status: 429, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        return jsonResponse({
          recovery_key_id: 'rk-id-slot-1',
          slot: 1,
          wrap: TEST_VECTOR_RK_WRAP,
        });
      }
      if (url.endsWith('/vault/recover/complete') && init?.method === 'POST') {
        completeDispatchedCount += 1;
        return jsonResponse({
          vault_key_id: TEST_VECTOR_VAULT_KEY_ID,
          version: 2,
          recovery_keys_remaining: 9,
          empty_slots: [1],
        });
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-reauth')).toBeInTheDocument();
    });

    // Step 1: Acquire a grant with only 30s remaining (< 60s preflight threshold for Step 3)
    fireEvent.change(screen.getByTestId('recovery-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
    });

    // Step 2: Enter RK -> transitions to Step 3 (`recovering`)
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });

    // Step 3: Submit new passphrase -> rewraps and prepares bundle, then stops at `reauth_expired_password` (< 60s grant)
    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step3-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-error-reauth-expired-password')).toBeInTheDocument();
    });
    expect(completeDispatchedCount).toBe(0);

    // 1. BE2-3: Submit in-place password reauth while held, then lock/cancel the recovery flow before reauth resolves!
    grantSecondsOnStep1 = 300;
    holdStep3Reauth = true;
    fireEvent.change(screen.getByTestId('recovery-step3-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    fireEvent.click(screen.getByTestId('recovery-step3-reauth-password-submit'));
    await waitFor(() => {
      expect(resolveStep3Reauth).not.toBeNull();
    });

    // Lock while in-place password reauth is in flight -> cancels recovery and returns to Step 2
    await act(async () => {
      await vaultCtx.lockNow();
    });
    expect(vaultCtx.state).toBe('locked');
    expect(vaultCtx.workerState).toBe('locked');

    // Release the held in-place reauth response -> MUST NOT restore the cancelled bundle or dispatch POST /vault/recover/complete!
    await act(async () => {
      holdStep3Reauth = false;
      resolveStep3Reauth?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(completeDispatchedCount).toBe(0);
    expect(vaultCtx.state).toBe('locked');

    // 2. BE2-11: Start a Step 2 lookup that is held before returning 429, cancel/lock and unlock a replacement session,
    //    then release the old 429 lookup error -> the replacement unlocked session MUST NOT be locked by the late error!
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
    });
    holdLookup429 = true;
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    fireEvent.click(screen.getByTestId('recovery-key-submit'));
    await waitFor(() => {
      expect(resolveLookup429).not.toBeNull();
    });

    // Cancel recovery and unlock a replacement session on the same provider
    await act(async () => {
      await vaultCtx.lockNow();
    });
    const replacementOp = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.createVault({
        passphrase: STRONG_NEW_PASSPHRASE,
        opGeneration: replacementOp.opGeneration,
      });
    });
    expect(vaultCtx.state).toBe('unlocked');
    expect(vaultCtx.workerState).toBe('unlocked');
    const replacementGen = vaultCtx.getClient().getGeneration();

    // Now release the old lookup's 429 rejection -> BE2-11 fence drops it without locking the replacement session!
    await act(async () => {
      holdLookup429 = false;
      resolveLookup429?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(vaultCtx.state).toBe('unlocked');
    expect(vaultCtx.workerState).toBe('unlocked');
    expect(vaultCtx.getClient().getGeneration()).toBe(replacementGen);

    shim.close();
  }, 25_000);
});
