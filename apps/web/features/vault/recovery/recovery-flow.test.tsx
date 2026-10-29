import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '@/components/theme-provider';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import type { UseReauthReturn } from '@/features/auth/use-reauth';
import {
  postVaultBroadcast,
  resetVaultBroadcastForTests,
  subscribeVaultBroadcast,
} from '@/features/vault/broadcast';
import { recordLockEpochEvent, type LockEpochEnvironment } from '@/features/vault/lock-epoch';
import { VaultRecoveryFlow } from '@/features/vault/recovery';
import { hasRecoveryCompletedNotice } from '@/features/vault/unlock/recovery-notice';
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

  const broadcastUnsubscribers: Array<() => void> = [];

  afterEach(() => {
    cleanup();
    while (activeShims.length > 0) {
      activeShims.pop()?.close();
    }
    while (broadcastUnsubscribers.length > 0) {
      broadcastUnsubscribers.pop()?.();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Every `vault_changed` the provider actually publishes (what sibling tabs would receive), not a spy on a precondition. */
  function collectVaultChangedBroadcasts() {
    const messages: Array<{ vault_key_id: string; version: number | null }> = [];
    broadcastUnsubscribers.push(
      subscribeVaultBroadcast((message) => {
        if (message.type === 'vault_changed') {
          messages.push({ vault_key_id: message.vault_key_id, version: message.version });
        }
      }),
    );
    return messages;
  }

  function renderRecovery(options?: {
    locale?: 'en' | 'vi';
    workerFactory?: () => CryptoWorkerPort;
    lockEpochEnv?: LockEpochEnvironment;
    onVaultProbe?: (ctx: VaultContextValue) => void;
    onReauthProbe?: (reauth: UseReauthReturn) => void;
    /** Receives a setter that mounts / unmounts only the recovery flow (provider and session stay mounted). */
    onFlowGate?: (setShowFlow: (show: boolean) => void) => void;
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

    function FlowGate() {
      const [showFlow, setShowFlow] = useState(true);
      useEffect(() => {
        options?.onFlowGate?.(setShowFlow);
      }, []);
      return showFlow ? <VaultRecoveryFlow /> : null;
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
                <FlowGate />
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
    // FE1-4: the field was disabled while pending; after the async failure focus is restored to it.
    await waitFor(() => {
      expect(screen.getByTestId('recovery-key-input')).toHaveFocus();
    });

    // 2. Valid format RK that is already used / unknown / belongs to another vault -> server 401 `recovery_key_invalid`
    screen.getByTestId('recovery-key-input').blur();
    expect(screen.getByTestId('recovery-key-input')).not.toHaveFocus();
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
    await waitFor(() => {
      expect(screen.getByTestId('recovery-key-input')).toHaveFocus();
    });

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

  // -------------------------------------------------------------------------
  // review-2-delta-be BE2-3 / BE2-4 / BE2-12: one scenario per test, each from a clean mount.
  // -------------------------------------------------------------------------
  interface RecoveryRaceFetchState {
    holdLookup: boolean;
    /** Resolvers of every lookup POST that is currently held, oldest first (`holdLookup` holds each new call). */
    lookupReleases: Array<() => void>;
    releaseLookup: (() => void) | null;
    holdComplete: boolean;
    completeReleases: Array<() => void>;
    /** When set, the (held or immediate) complete POST answers this problem instead of 200. */
    completeProblem: { status: number; code: string } | null;
    holdRecoveryKeysStatus: boolean;
    recoveryKeysStatusReleases: Array<() => void>;
    /** Replaces the GET /vault/recovery-keys response (e.g. `{}` for the malformed-shape case) or fails it with `'reject'`. */
    recoveryKeysStatusBody: unknown;
    holdRegen: boolean;
    regenReleases: Array<() => void>;
    holdRegenReauth: boolean;
    regenReauthReleases: Array<() => void>;
    /** GET /vault answers this vault (a replacement vault B) instead of the recovered one. */
    vaultMetaOverride: VaultState | null;
    vaultGets: number;
    /** Holds the next N GET /vault requests; each held GET answers the body it saw when it was requested. */
    vaultGetHolds: number;
    vaultGetReleases: Array<() => void>;
    /** Answers every GET /vault (held ones at release time) with this failure instead of metadata. */
    vaultGetFailure: 'network' | { status: number; code: string } | null;
    completeIfMatches: Array<string | null>;
    regenIfMatches: Array<string | null>;
    vaultVersion: number;
    completeCalls: number;
    regenCalls: number;
    rkStatusFetches: number;
    regenReauthPosts: number;
    lookupPosts: number;
  }

  function installRecoveryRaceFetchMock(
    options: { holdLookup?: boolean; holdComplete?: boolean; hasPassword?: boolean } = {},
  ): RecoveryRaceFetchState {
    const state: RecoveryRaceFetchState = {
      holdLookup: options.holdLookup ?? false,
      lookupReleases: [],
      releaseLookup: null,
      holdComplete: options.holdComplete ?? false,
      completeReleases: [],
      completeProblem: null,
      holdRecoveryKeysStatus: false,
      recoveryKeysStatusReleases: [],
      recoveryKeysStatusBody: { remaining: 9, empty_slots: [1] },
      holdRegen: false,
      regenReleases: [],
      holdRegenReauth: false,
      regenReauthReleases: [],
      vaultMetaOverride: null,
      vaultGets: 0,
      vaultGetHolds: 0,
      vaultGetReleases: [],
      vaultGetFailure: null,
      completeIfMatches: [],
      regenIfMatches: [],
      vaultVersion: 1,
      completeCalls: 0,
      regenCalls: 0,
      rkStatusFetches: 0,
      regenReauthPosts: 0,
      lookupPosts: 0,
    };
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
        return jsonResponse(makeMeFixture({ hasPassword: options.hasPassword ?? true }));
      }
      if (url.endsWith('/auth/reauth') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}')) as { action: string };
        if (body.action === 'vault.recovery_keys_regenerate') {
          state.regenReauthPosts += 1;
          if (state.holdRegenReauth) {
            await new Promise<void>((resolve) => {
              state.regenReauthReleases.push(resolve);
            });
          }
        }
        return jsonResponse({
          grant: `grant-${body.action}-token`,
          action: body.action,
          expires_at: futureIso(300),
        });
      }
      if (url.endsWith('/vault') && (!init?.method || init.method === 'GET')) {
        state.vaultGets += 1;
        const metaAtRequest = state.vaultMetaOverride ?? makeVaultMetaFixture(state.vaultVersion);
        if (state.vaultGetHolds > 0) {
          state.vaultGetHolds -= 1;
          await new Promise<void>((resolve) => {
            state.vaultGetReleases.push(resolve);
          });
        }
        if (state.vaultGetFailure === 'network') {
          throw new TypeError('network down');
        }
        if (state.vaultGetFailure) {
          return problemResponse(state.vaultGetFailure.status, state.vaultGetFailure.code);
        }
        return jsonResponse(metaAtRequest);
      }
      if (url.endsWith('/vault/unlock/recovery') && init?.method === 'POST') {
        state.lookupPosts += 1;
        if (state.holdLookup) {
          await new Promise<void>((resolve) => {
            state.releaseLookup = resolve;
            state.lookupReleases.push(resolve);
          });
        }
        return jsonResponse({
          recovery_key_id: 'rk-id-slot-1',
          slot: 1,
          wrap: TEST_VECTOR_RK_WRAP,
        });
      }
      if (url.endsWith('/vault/recover/complete') && init?.method === 'POST') {
        state.completeCalls += 1;
        state.completeIfMatches.push(new Headers(init.headers).get('If-Match'));
        if (state.holdComplete) {
          await new Promise<void>((resolve) => {
            state.completeReleases.push(resolve);
          });
        }
        if (state.completeProblem) {
          return problemResponse(state.completeProblem.status, state.completeProblem.code);
        }
        state.vaultVersion = 2;
        return jsonResponse({
          vault_key_id: TEST_VECTOR_VAULT_KEY_ID,
          version: 2,
          recovery_keys_remaining: 9,
          empty_slots: [1],
        });
      }
      if (url.endsWith('/vault/recovery-keys') && (!init?.method || init.method === 'GET')) {
        // Step 4A reads the live empty slots before generating replacement keys (`fetchRecoveryKeysStatus`)
        state.rkStatusFetches += 1;
        if (state.holdRecoveryKeysStatus) {
          await new Promise<void>((resolve) => {
            state.recoveryKeysStatusReleases.push(resolve);
          });
        }
        if (state.recoveryKeysStatusBody === 'reject') {
          throw new TypeError('network down');
        }
        return jsonResponse(state.recoveryKeysStatusBody);
      }
      if (url.endsWith('/vault/recovery-keys/regenerate') && init?.method === 'POST') {
        state.regenCalls += 1;
        state.regenIfMatches.push(new Headers(init.headers).get('If-Match'));
        if (state.holdRegen) {
          await new Promise<void>((resolve) => {
            state.regenReleases.push(resolve);
          });
        }
        state.vaultVersion = 3;
        return jsonResponse({
          version: 3,
          remaining: 10,
        });
      }
      return jsonResponse({});
    });
    return state;
  }

  /** Lock-epoch env whose next Web Lock request (the wake verification) can be held, plus the base env for sibling writes. */
  function makeHeldWakeLockEpochEnv() {
    const baseLockEpochEnv = makeSimpleLockEpochEnv();
    const wake: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };
    const lockEpochEnv: LockEpochEnvironment = {
      idbFactory: baseLockEpochEnv.idbFactory,
      locksManager: {
        request: async (name: string, opts: unknown, cb: () => Promise<unknown>) => {
          if (wake.hold) {
            wake.hold = false;
            await new Promise<void>((resolve) => {
              wake.release = resolve;
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
    return { baseLockEpochEnv, lockEpochEnv, wake };
  }

  /** Step 1: `recovery-step-reauth` renders before Me has loaded, so wait for the probe and the password field. */
  async function completeRecoveryStep1() {
    await waitFor(() => {
      expect(screen.getByTestId('test-recovery-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
      expect(screen.getByTestId('recovery-reauth-password-input')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('recovery-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
    });
  }

  async function submitRecoveryStep2() {
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-key-submit'));
    });
  }

  /** Steps 1-3 to the verified unlocked Step 4A (`regenerate-reauth`). */
  async function driveRecoveryToStep4A(getVault: () => VaultContextValue) {
    await completeRecoveryStep1();
    await submitRecoveryStep2();
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    expect(getVault().state).toBe('recovering');
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
    expect(getVault().state).toBe('unlocked');
  }

  it('BE2-3: a sibling durable lockEpoch write while POST /vault/unlock/recovery is in flight makes resumeRecovery fail closed (never Step 3), and a clean retry still recovers', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdLookup: true });
    const { baseLockEpochEnv } = makeHeldWakeLockEpochEnv();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      lockEpochEnv: baseLockEpochEnv,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await completeRecoveryStep1();

    // Submit Step 2: unlockRecovery captures the durable lockEpoch baseline BEFORE the lookup POST.
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    fireEvent.click(screen.getByTestId('recovery-key-submit'));
    await waitFor(() => {
      expect(fetchState.releaseLookup).not.toBeNull();
    });

    // While the lookup POST is in flight a sibling tab locks and increments the durable lockEpoch.
    await act(async () => {
      await recordLockEpochEvent(vaultCtx.tabKnownLockEpoch, baseLockEpochEnv);
    });

    // Release the lookup: resumeRecovery verifies the pre-lookup baseline, rejects and locks (never recovering).
    await act(async () => {
      fetchState.holdLookup = false;
      fetchState.releaseLookup?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-key-submit')).not.toBeDisabled();
      expect(vaultCtx.state).toBe('locked');
      expect(vaultCtx.workerState).toBe('locked');
    });
    expect(screen.queryByTestId('recovery-step-new-passphrase')).not.toBeInTheDocument();
    expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();

    // A clean retry is not wedged by the failed attempt and reaches Step 3 with a fresh baseline.
    await submitRecoveryStep2();
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    expect(vaultCtx.state).toBe('recovering');

    shim.close();
  }, 25_000);

  it('BE2-4: a held wake verification on Step 4A withholds the regenerate re-auth, the empty-slot lookup and Worker makeRecoveryKeys until the vault is verified unlocked again', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock();
    const { lockEpochEnv, wake } = makeHeldWakeLockEpochEnv();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      lockEpochEnv,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await driveRecoveryToStep4A(() => vaultCtx);

    // Wake while on Step 4A with the lockEpoch verification held: `vault.state === 'unlocking'`.
    const rkStatusFetchesBeforeGate = fetchState.rkStatusFetches;
    wake.hold = true;
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
    // Unverified access: no regenerate grant, no empty-slot lookup, no replacement keys.
    expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();
    expect(fetchState.regenReauthPosts).toBe(0);
    expect(fetchState.rkStatusFetches).toBe(rkStatusFetchesBeforeGate);

    // Release the verification -> verified unlocked again and the flow kept its Step 4A progress.
    await act(async () => {
      wake.release?.();
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
    });
    expect(screen.getByTestId('recovery-step-regenerate-reauth')).toBeInTheDocument();

    // Now the same submit advances to Step 4B with the replacement key.
    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });
    expect(fetchState.regenReauthPosts).toBe(1);

    shim.close();
  }, 25_000);

  it('BE2-4 & BE2-12: a held wake verification on Step 4B hides the replacement recovery keys and keeps the prepared bundle, which saves once verified unlocked again', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock();
    const { lockEpochEnv, wake } = makeHeldWakeLockEpochEnv();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      lockEpochEnv,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });

    await driveRecoveryToStep4A(() => vaultCtx);
    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });

    // Wake with the verification held: the replacement recovery key surface MUST hide immediately.
    wake.hold = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(vaultCtx.state).toBe('unlocking');
    expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-key-slot-1')).not.toBeInTheDocument();
    expect(fetchState.regenCalls).toBe(0);

    // Verification succeeds: the same prepared bundle is shown again (progress preserved, not reset to Step 1).
    await act(async () => {
      wake.release?.();
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });

    // Saving after verification dispatches the regenerate POST and routes to /app.
    const published = collectVaultChangedBroadcasts();
    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-save-button'));
    });
    await waitFor(() => {
      expect(fetchState.regenCalls).toBe(1);
      expect(routerMocks.replace).toHaveBeenCalledWith('/app');
    });
    // BE2-12 matching-origin control: a current success is published exactly once.
    expect(published).toEqual([{ vault_key_id: TEST_VECTOR_VAULT_KEY_ID, version: 3 }]);

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

    // `recovery-step-reauth` renders while the session is still loading, before `reauth.capabilities.hasPassword`
    // is known; the password field only exists once Me has loaded.
    await waitFor(() => {
      expect(screen.getByTestId('test-recovery-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
      expect(screen.getByTestId('recovery-reauth-password-input')).toBeInTheDocument();
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
    const published = collectVaultChangedBroadcasts();
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
    // Siblings really receive it, exactly once, for the vault that was recovered (BE3-2 same-origin control).
    expect(published).toEqual([{ vault_key_id: TEST_VECTOR_VAULT_KEY_ID, version: 2 }]);
    expect(routerMocks.replace).toHaveBeenCalledWith('/app/unlock');
    // FE1-7: the notice outlives this component: the unlock route reads it from the non-secret tab store.
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(true);

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

    // `recovery-step-reauth` renders while the session is still loading, before `reauth.capabilities.hasPassword`
    // is known; the password field only exists once Me has loaded.
    await waitFor(() => {
      expect(screen.getByTestId('test-recovery-probe')).toHaveTextContent(
        'authenticated_with_vault|locked|locked|',
      );
      expect(screen.getByTestId('recovery-reauth-password-input')).toBeInTheDocument();
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
  // -------------------------------------------------------------------------
  // review-3-delta-be / review-2-delta-fe (fix round 3): one race per test, each from a clean mount.
  // -------------------------------------------------------------------------
  const REPLACEMENT_VAULT_KEY_ID = 'vk:replacement-vault-b-0123';

  /** Lets timers and microtasks queued by the released response run before asserting what did NOT happen. */
  async function settle() {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  /** Step 1-3 up to a held `POST /vault/recover/complete` (the server has not answered yet). */
  async function driveRecoveryToHeldComplete(fetchState: RecoveryRaceFetchState) {
    await completeRecoveryStep1();
    await submitRecoveryStep2();
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('recovery-step3-submit'));
    await waitFor(() => {
      expect(fetchState.completeReleases).toHaveLength(1);
    });
  }

  async function unlockReplacementSession(getVault: () => VaultContextValue) {
    const op = getVault().beginOp();
    await act(async () => {
      await getVault().createVault({
        passphrase: STRONG_NEW_PASSPHRASE,
        opGeneration: op.opGeneration,
      });
    });
    expect(getVault().state).toBe('unlocked');
    expect(getVault().workerState).toBe('unlocked');
  }

  it('BE3-2: a held, already committed recovery A that returns after the same user recreated and unlocked vault B publishes nothing, navigates nowhere and leaves B unlocked', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
    const published = collectVaultChangedBroadcasts();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveRecoveryToHeldComplete(fetchState);

    // Same user: lock, a sibling announces the recreated vault B, and B is unlocked here.
    await act(async () => {
      await vaultCtx.lockNow();
    });
    expect(vaultCtx.state).toBe('locked');
    await act(async () => {
      vaultCtx.notifyVaultChanged({ vault_key_id: REPLACEMENT_VAULT_KEY_ID, version: 1 });
    });
    fetchState.vaultMetaOverride = {
      ...makeVaultMetaFixture(1),
      vault_key_id: REPLACEMENT_VAULT_KEY_ID,
    };
    await unlockReplacementSession(() => vaultCtx);
    const replacementGeneration = vaultCtx.getClient().getGeneration();
    const publishedBeforeRelease = published.length;
    const vaultGetsBeforeRelease = fetchState.vaultGets;
    routerMocks.replace.mockClear();

    // The old server success A returns now.
    await act(async () => {
      fetchState.completeReleases[0]?.();
    });
    // The recovery flow reconciled against the authoritative current identity (GET /vault) ...
    await waitFor(() => {
      expect(fetchState.vaultGets).toBe(vaultGetsBeforeRelease + 1);
    });
    await settle();
    // ... found vault B, and therefore never published A into B, navigated, or announced A's outcome.
    expect(published.slice(publishedBeforeRelease)).toEqual([]);
    expect(published.some((m) => m.vault_key_id === TEST_VECTOR_VAULT_KEY_ID)).toBe(false);
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recovery-completed-while-locked-notice')).not.toBeInTheDocument();
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(false);
    expect(vaultCtx.state).toBe('unlocked');
    expect(vaultCtx.workerState).toBe('unlocked');
    expect(vaultCtx.getClient().getGeneration()).toBe(replacementGeneration);

    shim.close();
  }, 30_000);

  it('BE3-2: a committed recovery whose flow unmounted (provider kept) never publishes, navigates or even reads GET /vault when the old success returns', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
    const published = collectVaultChangedBroadcasts();

    let vaultCtx!: VaultContextValue;
    let setShowFlow!: (show: boolean) => void;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
      onFlowGate: (setter) => {
        setShowFlow = setter;
      },
    });
    await driveRecoveryToHeldComplete(fetchState);

    // Leave only the recovery route: it locks the pending recovery continuation; the provider outlives it.
    await act(async () => {
      setShowFlow(false);
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('locked');
    });
    await unlockReplacementSession(() => vaultCtx);
    const vaultGetsBeforeRelease = fetchState.vaultGets;
    routerMocks.replace.mockClear();

    await act(async () => {
      fetchState.completeReleases[0]?.();
    });
    await settle();
    expect(published).toEqual([]);
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(fetchState.vaultGets).toBe(vaultGetsBeforeRelease);
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(false);
    expect(vaultCtx.state).toBe('unlocked');

    shim.close();
  }, 30_000);

  it('BE3-8 & BE3-5 (flow side): a sibling lock that is missed while the complete POST is in flight and detected during confirmation still surfaces the committed recovery, stays locked and leaves no secrets', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
    const { baseLockEpochEnv } = makeHeldWakeLockEpochEnv();
    const published = collectVaultChangedBroadcasts();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      lockEpochEnv: baseLockEpochEnv,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveRecoveryToHeldComplete(fetchState);
    expect(vaultCtx.workerState).toBe('recovering');

    // A sibling tab locks and advances the durable lockEpoch; this tab never receives the notification.
    await act(async () => {
      await recordLockEpochEvent(vaultCtx.tabKnownLockEpoch, baseLockEpochEnv);
    });
    expect(vaultCtx.workerState).toBe('recovering');

    // The server commits and answers 200: generation and flow still look current, so only confirmRecovery's durable
    // baseline check can detect the missed lock, and it does so after the mutation is already committed.
    await act(async () => {
      fetchState.completeReleases[0]?.();
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app/unlock');
    });
    expect(fetchState.completeCalls).toBe(1);
    expect(vaultCtx.state).toBe('locked');
    expect(vaultCtx.workerState).toBe('locked');
    expect(screen.getByTestId('recovery-completed-while-locked-notice')).toHaveTextContent(
      /Recovery completed — unlock with your new passphrase/i,
    );
    expect(published).toEqual([{ vault_key_id: TEST_VECTOR_VAULT_KEY_ID, version: 2 }]);
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(true);
    // Never promoted to Step 4 and no secret surface is left behind.
    expect(screen.queryByTestId('recovery-step-regenerate-reauth')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-new-passphrase-input')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain(STRONG_NEW_PASSPHRASE);

    shim.close();
  }, 30_000);

  it('BE3-6: a regenerate success that returns after the session was replaced never publishes the obsolete identity, refreshes Me or navigates', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock();
    const published = collectVaultChangedBroadcasts();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveRecoveryToStep4A(() => vaultCtx);
    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));

    // Hold the regenerate POST, then replace the session while it is in flight.
    fetchState.holdRegen = true;
    const publishedBeforeSave = published.length;
    fireEvent.click(screen.getByTestId('recovery-step4-save-button'));
    await waitFor(() => {
      expect(fetchState.regenReleases).toHaveLength(1);
    });
    await act(async () => {
      await vaultCtx.lockNow();
    });
    await unlockReplacementSession(() => vaultCtx);
    const replacementGeneration = vaultCtx.getClient().getGeneration();
    routerMocks.replace.mockClear();
    const fetchesBeforeRelease = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls.length;

    await act(async () => {
      fetchState.holdRegen = false;
      fetchState.regenReleases[0]?.();
    });
    await settle();

    expect(published.slice(publishedBeforeSave)).toEqual([]);
    expect(routerMocks.replace).not.toHaveBeenCalled();
    // No post-success Me refresh either: the late success is dropped before any follow-up request.
    const urlsAfterRelease = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .slice(fetchesBeforeRelease)
      .map((call) => String(call[0]));
    expect(urlsAfterRelease.filter((url) => url.endsWith('/auth/me'))).toEqual([]);
    expect(vaultCtx.state).toBe('unlocked');
    expect(vaultCtx.workerState).toBe('unlocked');
    expect(vaultCtx.getClient().getGeneration()).toBe(replacementGeneration);

    shim.close();
  }, 30_000);

  for (const lateProblem of [
    { status: 401, code: 'reauth_expired', badge: 'recovery-error-reauth-expired-password' },
    { status: 503, code: 'vault_mutations_disabled', badge: 'recovery-error-mutations-disabled' },
  ]) {
    it(`BE2-11: a late ${lateProblem.status} ${lateProblem.code} from the complete POST never locks the replacement session, clears the grant or renders for the obsolete flow`, async () => {
      const shim = makeTestShim();
      const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
      fetchState.completeProblem = { status: lateProblem.status, code: lateProblem.code };

      let vaultCtx!: VaultContextValue;
      let reauthCtx!: UseReauthReturn;
      renderRecovery({
        locale: 'en',
        workerFactory: () => shim.port,
        onVaultProbe: (ctx) => {
          vaultCtx = ctx;
        },
        onReauthProbe: (r) => {
          reauthCtx = r;
        },
      });
      await driveRecoveryToHeldComplete(fetchState);

      await act(async () => {
        await vaultCtx.lockNow();
      });
      await unlockReplacementSession(() => vaultCtx);
      const replacementGeneration = vaultCtx.getClient().getGeneration();
      const grantBefore = reauthCtx.grant?.grant;
      const pendingActionBefore = reauthCtx.pendingAction;
      expect(grantBefore).toBeTruthy();

      await act(async () => {
        fetchState.completeReleases[0]?.();
      });
      await settle();

      expect(fetchState.completeCalls).toBe(1);
      expect(vaultCtx.state).toBe('unlocked');
      expect(vaultCtx.workerState).toBe('unlocked');
      expect(vaultCtx.getClient().getGeneration()).toBe(replacementGeneration);
      // The late error neither cleared the grant (OAuth branch) nor started a new re-auth (password branch).
      expect(reauthCtx.grant?.grant).toBe(grantBefore);
      expect(reauthCtx.pendingAction).toBe(pendingActionBefore);
      expect(screen.queryByTestId(lateProblem.badge)).not.toBeInTheDocument();

      shim.close();
    }, 30_000);
  }

  it('BE3-10: a cancelled lookup that settles while its successor lookup is still pending keeps the successor busy, so no third lookup can be launched', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdLookup: true });

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await completeRecoveryStep1();

    // Lookup A is held in flight ...
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    fireEvent.click(screen.getByTestId('recovery-key-submit'));
    await waitFor(() => {
      expect(fetchState.lookupReleases).toHaveLength(1);
    });

    // ... a hard lock retires it and immediately frees the form, so lookup B can start and is held too.
    await act(async () => {
      await vaultCtx.lockNow();
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-key-submit')).not.toBeDisabled();
    });
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    fireEvent.click(screen.getByTestId('recovery-key-submit'));
    await waitFor(() => {
      expect(fetchState.lookupReleases).toHaveLength(2);
    });
    expect(screen.getByTestId('recovery-key-submit')).toBeDisabled();

    // The obsolete lookup A settles while B is pending: its finalizer must not release B's busy state.
    await act(async () => {
      fetchState.lookupReleases[0]?.();
    });
    await settle();
    expect(screen.getByTestId('recovery-key-submit')).toBeDisabled();
    expect(screen.getByTestId('recovery-key-input')).toBeDisabled();
    // A forced submit (Enter key / form submit) while B is pending sends nothing.
    const lookupPostsWhileBPending = fetchState.lookupPosts;
    fireEvent.change(screen.getByTestId('recovery-key-input'), {
      target: { value: TEST_VECTOR_RK_DISPLAY },
    });
    await act(async () => {
      fireEvent.submit(screen.getByTestId('recovery-key-input').closest('form')!);
    });
    expect(fetchState.lookupPosts).toBe(lookupPostsWhileBPending);

    // Only B's own completion releases it and carries the flow to Step 3.
    await act(async () => {
      fetchState.lookupReleases[1]?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    expect(vaultCtx.state).toBe('recovering');

    shim.close();
  }, 30_000);

  it('BE2-4: a wake verification that starts while the Step 4A re-auth submission is in flight stops the submission from fetching slots or generating keys, and nothing appears late', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock();
    const { lockEpochEnv, wake } = makeHeldWakeLockEpochEnv();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      lockEpochEnv,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveRecoveryToStep4A(() => vaultCtx);
    const slotFetchesBeforeSubmit = fetchState.rkStatusFetches;

    // Submit while verified unlocked: the re-auth POST is accepted and held in flight ...
    fetchState.holdRegenReauth = true;
    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    await waitFor(() => {
      expect(fetchState.regenReauthReleases).toHaveLength(1);
    });

    // ... and only THEN the wake verification starts (held).
    wake.hold = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(vaultCtx.state).toBe('unlocking');
    // FE2-1 / FE2-2: the gated step says why it is withheld and its submit is disabled instead of silently doing nothing.
    expect(screen.getByTestId('recovery-wake-gate-status')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('recovery-step4-reauth-password-submit')).toBeDisabled();

    await act(async () => {
      fetchState.holdRegenReauth = false;
      fetchState.regenReauthReleases[0]?.();
    });
    await settle();
    // The in-flight submission is dropped at the verified-access check: no slot lookup, no keys, no regenerate request.
    expect(fetchState.rkStatusFetches).toBe(slotFetchesBeforeSubmit);
    expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();
    expect(fetchState.regenCalls).toBe(0);

    // Verification succeeds: the dropped submission does not resume by itself.
    await act(async () => {
      wake.release?.();
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
    });
    await settle();
    expect(screen.getByTestId('recovery-step-regenerate-reauth')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-wake-gate-status')).not.toBeInTheDocument();
    expect(fetchState.rkStatusFetches).toBe(slotFetchesBeforeSubmit);
    expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();

    shim.close();
  }, 30_000);

  it('BE2-4: a wake verification that starts while the empty-slot lookup is in flight keeps the replacement keys from ever being published, even after verification succeeds', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock();
    const { lockEpochEnv, wake } = makeHeldWakeLockEpochEnv();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      lockEpochEnv,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveRecoveryToStep4A(() => vaultCtx);

    // The re-auth succeeds and key preparation starts: GET /vault/recovery-keys is held in flight.
    fetchState.holdRecoveryKeysStatus = true;
    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    await waitFor(() => {
      expect(fetchState.recoveryKeysStatusReleases).toHaveLength(1);
    });

    wake.hold = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(vaultCtx.state).toBe('unlocking');

    // The slot lookup answers while access is unverified: the preparation must stop before generating or publishing keys.
    await act(async () => {
      fetchState.holdRecoveryKeysStatus = false;
      fetchState.recoveryKeysStatusReleases[0]?.();
    });
    await settle();
    expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-keys-grid')).not.toBeInTheDocument();
    expect(fetchState.regenCalls).toBe(0);

    await act(async () => {
      wake.release?.();
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
    });
    await settle();
    expect(screen.getByTestId('recovery-step-regenerate-reauth')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-keys-grid')).not.toBeInTheDocument();

    shim.close();
  }, 30_000);

  it('BE2-4 & FE2-1: a wake verification that FAILS over prepared replacement keys hides them for good, replaces the step with the completed notice and never reveals the keys again', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock();
    const { baseLockEpochEnv, lockEpochEnv, wake } = makeHeldWakeLockEpochEnv();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      lockEpochEnv,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveRecoveryToStep4A(() => vaultCtx);
    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });
    const replacementKeyText = screen.getByTestId('recovery-key-slot-1').textContent ?? '';
    expect(replacementKeyText).toMatch(/^rk1_/);

    // Wake with the verification held, and a sibling lock the verification will discover once it runs.
    wake.hold = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(vaultCtx.state).toBe('unlocking');
    expect(screen.queryByTestId('recovery-key-slot-1')).not.toBeInTheDocument();
    await act(async () => {
      await recordLockEpochEvent(vaultCtx.tabKnownLockEpoch, baseLockEpochEnv);
    });
    await act(async () => {
      wake.release?.();
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('locked');
    });
    expect(vaultCtx.workerState).toBe('locked');

    // The keys are gone for good: no grid, no status placeholder, the committed notice replaces the step.
    expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-step-regenerate-pending')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-keys-grid')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain(replacementKeyText);
    expect(screen.getByTestId('recovery-completed-while-locked-notice')).toBeInTheDocument();
    expect(fetchState.regenCalls).toBe(0);

    // A later wake cannot bring them back either.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(screen.queryByTestId('recovery-keys-grid')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain(replacementKeyText);

    shim.close();
  }, 30_000);

  it('FE2-1: a hard lock on Step 4A replaces the password form with the completed-recovery notice (no silent no-op) whose CTA hands the notice to the unlock page', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveRecoveryToStep4A(() => vaultCtx);

    await act(async () => {
      await vaultCtx.lockNow();
    });
    expect(vaultCtx.state).toBe('locked');

    // No enabled form that silently ignores the submit: the step is replaced by the notice.
    expect(screen.queryByTestId('recovery-step-regenerate-reauth')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-step4-reauth-password-submit')).not.toBeInTheDocument();
    expect(screen.getByTestId('recovery-completed-while-locked-notice')).toHaveTextContent(
      /Recovery completed — unlock with your new passphrase/i,
    );
    expect(fetchState.regenReauthPosts).toBe(0);
    expect(fetchState.regenCalls).toBe(0);
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(false);

    routerMocks.replace.mockClear();
    fireEvent.click(screen.getByTestId('recovery-completed-while-locked-cta'));
    expect(routerMocks.replace).toHaveBeenCalledWith('/app/unlock');
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(true);

    shim.close();
  }, 30_000);

  it('FE2-2: a wake verification over Step 4B shows a localized pending status where the keys were, then restores focus to the step heading with the same bundle saveable', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock();
    const { lockEpochEnv, wake } = makeHeldWakeLockEpochEnv();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      lockEpochEnv,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveRecoveryToStep4A(() => vaultCtx);
    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });

    // Keyboard focus sits on a control inside the replacement-key sheet.
    const confirmCheckbox = screen.getByTestId('recovery-keys-confirm-checkbox');
    confirmCheckbox.focus();
    expect(confirmCheckbox).toHaveFocus();

    wake.hold = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(vaultCtx.state).toBe('unlocking');
    expect(screen.queryByTestId('recovery-key-slot-1')).not.toBeInTheDocument();
    // The screen is not left empty: a nonsecret status explains the wait.
    const status = screen.getByTestId('recovery-wake-gate-status');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent(/Checking that your vault is still unlocked/i);
    expect(status).toHaveTextContent(/Your recovery progress is kept/i);

    await act(async () => {
      wake.release?.();
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('recovery-wake-gate-status')).not.toBeInTheDocument();
    // Focus is restored to the step heading instead of falling back to <body>.
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    });

    // The same prepared bundle still saves.
    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-save-button'));
    });
    await waitFor(() => {
      expect(fetchState.regenCalls).toBe(1);
    });

    shim.close();
  }, 30_000);

  it('BE3-3 & FE1-4: Step 4A preparation failures (network error, malformed recovery-key status) show a focused alert on the same step, create no keys, and a corrected retry succeeds', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveRecoveryToStep4A(() => vaultCtx);

    async function submitStep4Password() {
      fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
        target: { value: 'account-login-password-123' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
      });
    }

    // 1. The status GET fails at the network level.
    fetchState.recoveryKeysStatusBody = 'reject';
    await submitStep4Password();
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step4-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('recovery-step-regenerate-reauth')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-step4-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('recovery-step4-error')).toHaveFocus();
    expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();
    expect(fetchState.regenCalls).toBe(0);

    // 2. The server answers 200 with a malformed body (no `empty_slots`): fail closed, visible, no raw TypeError text.
    fetchState.recoveryKeysStatusBody = {};
    await submitStep4Password();
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step4-error')).toHaveTextContent(
        /Could not reach the server/i,
      );
    });
    expect(screen.getByTestId('recovery-step4-error').textContent ?? '').not.toMatch(/iterable|undefined/i);
    expect(screen.getByTestId('recovery-step-regenerate-reauth')).toBeInTheDocument();
    expect(screen.queryByTestId('recovery-keys-grid')).not.toBeInTheDocument();
    expect(fetchState.regenCalls).toBe(0);

    // 3. A corrected response lets the same step retry and reach the replacement keys.
    fetchState.recoveryKeysStatusBody = { remaining: 9, empty_slots: [1] };
    await submitStep4Password();
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('recovery-step4-error')).not.toBeInTheDocument();

    shim.close();
  }, 30_000);
  for (const lateProblem of [
    { status: 401, code: 'reauth_expired' },
    { status: 503, code: 'vault_mutations_disabled' },
  ]) {
    it(`BE2-11 (OAuth-only account): a late ${lateProblem.status} ${lateProblem.code} from the complete POST never clears the replacement's grant, locks it or changes its pending re-auth`, async () => {
      const shim = makeTestShim();
      const fetchState = installRecoveryRaceFetchMock({ holdComplete: true, hasPassword: false });
      fetchState.completeProblem = { status: lateProblem.status, code: lateProblem.code };

      let vaultCtx!: VaultContextValue;
      let reauthCtx!: UseReauthReturn;
      renderRecovery({
        locale: 'en',
        workerFactory: () => shim.port,
        onVaultProbe: (ctx) => {
          vaultCtx = ctx;
        },
        onReauthProbe: (r) => {
          reauthCtx = r;
        },
      });

      // OAuth-only account: the `vault.recover` grant comes from the OAuth receipt (mocked grant, no real token), not a password.
      await waitFor(() => {
        expect(screen.getByTestId('test-recovery-probe')).toHaveTextContent(
          'authenticated_with_vault|locked|locked|',
        );
        expect(reauthCtx.pendingAction).toBe('vault.recover');
      });
      expect(reauthCtx.capabilities.hasPassword).toBe(false);
      await act(async () => {
        await reauthCtx.consumeOauthReceipt('vault.recover', 'google');
      });
      await waitFor(() => {
        expect(screen.getByTestId('recovery-step-enter-key')).toBeInTheDocument();
      });
      await submitRecoveryStep2();
      await waitFor(() => {
        expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
        target: { value: STRONG_NEW_PASSPHRASE },
      });
      fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
        target: { value: STRONG_NEW_PASSPHRASE },
      });
      fireEvent.click(screen.getByTestId('recovery-step3-submit'));
      await waitFor(() => {
        expect(fetchState.completeReleases).toHaveLength(1);
      });

      // Lock and unlock a replacement session while the old complete POST is still in flight.
      await act(async () => {
        await vaultCtx.lockNow();
      });
      await unlockReplacementSession(() => vaultCtx);
      const replacementGeneration = vaultCtx.getClient().getGeneration();
      const grantBefore = reauthCtx.grant?.grant;
      const pendingActionBefore = reauthCtx.pendingAction;
      expect(grantBefore).toBeTruthy();

      await act(async () => {
        fetchState.completeReleases[0]?.();
      });
      await settle();

      expect(fetchState.completeCalls).toBe(1);
      // The OAuth branch of the late error would clear the grant and lock: neither may touch the replacement.
      expect(vaultCtx.state).toBe('unlocked');
      expect(vaultCtx.workerState).toBe('unlocked');
      expect(vaultCtx.getClient().getGeneration()).toBe(replacementGeneration);
      expect(reauthCtx.grant?.grant).toBe(grantBefore);
      expect(reauthCtx.pendingAction).toBe(pendingActionBefore);
      expect(screen.queryByTestId('recovery-error-reauth-expired-oauth')).not.toBeInTheDocument();
      expect(screen.queryByTestId('recovery-error-mutations-disabled')).not.toBeInTheDocument();

      shim.close();
    }, 30_000);
  }

  it('BE4-4: a completion A released with an error while the hard-locked successor B completion POST is pending keeps B busy; a forced submit sends nothing and only B settling releases it', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveRecoveryToHeldComplete(fetchState);

    // A hard lock retires completion A; the form is usable again and successor B reaches its own held completion POST.
    await act(async () => {
      await vaultCtx.lockNow();
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-key-submit')).not.toBeDisabled();
    });
    await submitRecoveryStep2();
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('recovery-step3-submit'));
    await waitFor(() => {
      expect(fetchState.completeReleases).toHaveLength(2);
    });
    expect(fetchState.completeCalls).toBe(2);
    expect(vaultCtx.workerState).toBe('recovering');
    expect(screen.getByTestId('recovery-step3-submit')).toBeDisabled();

    // Completion A now returns with an ERROR while B is pending: its finalizer must not release B's busy state.
    fetchState.completeProblem = { status: 503, code: 'vault_mutations_disabled' };
    await act(async () => {
      fetchState.completeReleases[0]?.();
    });
    await settle();
    fetchState.completeProblem = null;
    expect(screen.getByTestId('recovery-step3-submit')).toBeDisabled();
    expect(screen.getByTestId('recovery-new-passphrase-input')).toBeDisabled();
    expect(screen.getByTestId('recovery-confirm-passphrase-input')).toBeDisabled();
    // A's obsolete error is not rendered for B either.
    expect(screen.queryByTestId('recovery-error-mutations-disabled')).not.toBeInTheDocument();

    // A forced submit (Enter key / form submit) while B is pending sends no third completion request.
    await act(async () => {
      fireEvent.submit(screen.getByTestId('recovery-new-passphrase-input').closest('form')!);
    });
    await settle();
    expect(fetchState.completeCalls).toBe(2);
    expect(screen.getByTestId('recovery-step3-submit')).toBeDisabled();

    // Only B's own settlement releases it and carries the flow to Step 4A.
    await act(async () => {
      fetchState.completeReleases[1]?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-reauth')).toBeInTheDocument();
    });
    expect(fetchState.completeCalls).toBe(2);
    expect(vaultCtx.state).toBe('unlocked');

    shim.close();
  }, 30_000);

  for (const verifier of ['succeeds', 'fails'] as const) {
    it(`BE2-4 (Worker generation): replacement-key plaintext returned by the Worker while the wake verification is still held is never rendered, and a verifier that ${verifier} does not bring it back`, async () => {
      const shim = makeTestShim();
      const fetchState = installRecoveryRaceFetchMock();
      const { baseLockEpochEnv, lockEpochEnv, wake } = makeHeldWakeLockEpochEnv();

      let vaultCtx!: VaultContextValue;
      renderRecovery({
        locale: 'en',
        workerFactory: () => shim.port,
        lockEpochEnv,
        onVaultProbe: (ctx) => {
          vaultCtx = ctx;
        },
      });
      await driveRecoveryToStep4A(() => vaultCtx);

      // Instrument the real Worker call: it is held before the message is posted, and the plaintext it later returns is recorded.
      const client = vaultCtx.getClient();
      const realMakeRecoveryKeys = client.makeRecoveryKeys.bind(client);
      const workerGate = Promise.withResolvers<void>();
      let makeStarted = false;
      let plaintextReturned = false;
      let plaintextKeys: string[] = [];
      vi.spyOn(client, 'makeRecoveryKeys').mockImplementation(async (params) => {
        makeStarted = true;
        const result = await realMakeRecoveryKeys({
          ...params,
          beforePostMessage: () => workerGate.promise,
        });
        plaintextKeys = result.recovery_keys.map((rk) => rk.display);
        plaintextReturned = true;
        return result;
      });

      fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
        target: { value: 'account-login-password-123' },
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
      });
      await waitFor(() => {
        expect(makeStarted).toBe(true);
      });
      expect(plaintextReturned).toBe(false);

      // The wake verification starts AFTER makeRecoveryKeys began and stays held.
      wake.hold = true;
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(vaultCtx.state).toBe('unlocking');

      // The Worker plaintext returns while the verifier is still held: it must not be published.
      await act(async () => {
        workerGate.resolve();
      });
      await waitFor(() => {
        expect(plaintextReturned).toBe(true);
      });
      await settle();
      expect(vaultCtx.state).toBe('unlocking');
      expect(plaintextKeys.length).toBeGreaterThan(0);
      const expectNoReplacementKeyRendered = () => {
        expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();
        expect(screen.queryByTestId('recovery-keys-grid')).not.toBeInTheDocument();
        for (const display of plaintextKeys) {
          expect(document.body.textContent ?? '').not.toContain(display);
        }
      };
      expectNoReplacementKeyRendered();
      expect(fetchState.regenCalls).toBe(0);

      if (verifier === 'fails') {
        // A sibling lock that the verification discovers: access is never verified.
        await act(async () => {
          await recordLockEpochEvent(vaultCtx.tabKnownLockEpoch, baseLockEpochEnv);
        });
      }
      await act(async () => {
        wake.release?.();
      });
      await waitFor(() => {
        expect(vaultCtx.state).toBe(verifier === 'fails' ? 'locked' : 'unlocked');
      });
      await settle();
      expectNoReplacementKeyRendered();
      if (verifier === 'fails') {
        expect(screen.getByTestId('recovery-completed-while-locked-notice')).toBeInTheDocument();
      } else {
        // The dropped generation does not resume by itself once access is verified again.
        expect(screen.getByTestId('recovery-step-regenerate-reauth')).toBeInTheDocument();
      }

      // No later reappearance after another wake either.
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      await settle();
      expectNoReplacementKeyRendered();
      expect(fetchState.regenCalls).toBe(0);

      shim.close();
    }, 30_000);
  }

  /** Committed recovery A: the complete POST is held, then a hard lock retires the flow (the old 200 is released by the test). */
  async function driveToLockedCommittedRecovery(
    fetchState: RecoveryRaceFetchState,
    getVault: () => VaultContextValue,
  ) {
    await driveRecoveryToHeldComplete(fetchState);
    await act(async () => {
      await getVault().lockNow();
    });
    expect(getVault().state).toBe('locked');
    routerMocks.replace.mockClear();
  }

  it('BE4-1: a reconciliation GET held across an announced vault B transition publishes nothing, navigates nowhere and causes no lock when the old metadata arrives', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
    const published = collectVaultChangedBroadcasts();
    const lockBroadcasts: number[] = [];
    broadcastUnsubscribers.push(
      subscribeVaultBroadcast((message) => {
        if (message.type === 'lock') lockBroadcasts.push(message.lockEpoch);
      }),
    );

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveToLockedCommittedRecovery(fetchState, () => vaultCtx);

    // The old success commits and its reconciliation GET /vault is held in flight.
    fetchState.vaultGetHolds = 1;
    await act(async () => {
      fetchState.completeReleases[0]?.();
    });
    await waitFor(() => {
      expect(fetchState.vaultGetReleases).toHaveLength(1);
    });
    expect(screen.getByTestId('recovery-committed-recheck-notice')).toHaveAttribute(
      'data-phase',
      'verifying',
    );

    // While it is held a sibling announces the recreated vault B; no follow-up GET has produced any outcome.
    await act(async () => {
      vaultCtx.notifyVaultChanged({ vault_key_id: REPLACEMENT_VAULT_KEY_ID, version: 1 });
    });
    const publishedAfterTransition = published.length;
    const locksBeforeRelease = lockBroadcasts.length;
    const lockEpochBeforeRelease = vaultCtx.tabKnownLockEpoch;
    routerMocks.replace.mockClear();

    // The held answer (the OLD vault A) arrives now.
    await act(async () => {
      fetchState.vaultGetReleases[0]?.();
    });
    await settle();
    expect(published.slice(publishedAfterTransition)).toEqual([]);
    expect(published.some((m) => m.vault_key_id === TEST_VECTOR_VAULT_KEY_ID)).toBe(false);
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recovery-completed-while-locked-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-committed-recheck-notice')).not.toBeInTheDocument();
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(false);
    // No extra lock for the already locked vault.
    expect(lockBroadcasts.length).toBe(locksBeforeRelease);
    expect(vaultCtx.tabKnownLockEpoch).toBe(lockEpochBeforeRelease);
    expect(vaultCtx.state).toBe('locked');

    shim.close();
  }, 30_000);

  it('BE4-1: a same-account successor recovery that starts while the reconciliation GET is held keeps its prepared bundle, busy state and route', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
    const published = collectVaultChangedBroadcasts();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveToLockedCommittedRecovery(fetchState, () => vaultCtx);

    fetchState.vaultGetHolds = 1;
    await act(async () => {
      fetchState.completeReleases[0]?.();
    });
    await waitFor(() => {
      expect(fetchState.vaultGetReleases).toHaveLength(1);
    });

    // While the reconciliation waits, the same user starts a successor recovery that reaches a pending completion POST.
    await waitFor(() => {
      expect(screen.getByTestId('recovery-key-submit')).not.toBeDisabled();
    });
    await submitRecoveryStep2();
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('recovery-step3-submit'));
    await waitFor(() => {
      expect(fetchState.completeReleases).toHaveLength(2);
    });
    expect(vaultCtx.workerState).toBe('recovering');
    expect(screen.getByTestId('recovery-step3-submit')).toBeDisabled();
    routerMocks.replace.mockClear();

    // The old reconciliation answers now: the successor's UI must not be cleared, navigated or published over.
    await act(async () => {
      fetchState.vaultGetReleases[0]?.();
    });
    await settle();
    expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    expect(screen.getByTestId('recovery-step3-submit')).toBeDisabled();
    expect(screen.getByTestId('recovery-new-passphrase-input')).toBeDisabled();
    expect(screen.queryByTestId('recovery-completed-while-locked-notice')).not.toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(published).toEqual([]);
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(false);
    await act(async () => {
      fireEvent.submit(screen.getByTestId('recovery-new-passphrase-input').closest('form')!);
    });
    expect(fetchState.completeCalls).toBe(2);

    // The successor's own prepared bundle still completes.
    await act(async () => {
      fetchState.completeReleases[1]?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-reauth')).toBeInTheDocument();
    });
    expect(vaultCtx.state).toBe('unlocked');

    shim.close();
  }, 30_000);

  it('BE4-2: a failed reconciliation GET after a committed 200 keeps the completed outcome with a retry, publishes nothing unverified and opens no secret surface; the retry verifies and hands off', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
    const published = collectVaultChangedBroadcasts();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveToLockedCommittedRecovery(fetchState, () => vaultCtx);

    fetchState.vaultGetFailure = { status: 503, code: 'service_unavailable' };
    await act(async () => {
      fetchState.completeReleases[0]?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-committed-recheck-notice')).toHaveAttribute(
        'data-phase',
        'recheck_needed',
      );
    });
    const notice = screen.getByTestId('recovery-committed-recheck-notice');
    expect(notice).toHaveAttribute('role', 'alert');
    expect(notice).toHaveTextContent(/Recovery completed/i);
    expect(notice).toHaveTextContent(/could not confirm/i);
    // Truthful and safe: nothing unverified is published, claimed or navigated, and no secret surface reopens.
    expect(published).toEqual([]);
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(false);
    expect(screen.queryByTestId('recovery-completed-while-locked-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-step-regenerate-reauth')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-step-regenerate-keys')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain(STRONG_NEW_PASSPHRASE);
    expect(vaultCtx.state).toBe('locked');
    expect(vaultCtx.workerState).toBe('locked');

    // Usable verification path: once the server answers, the retry verifies and completes the hand-off exactly once.
    fetchState.vaultGetFailure = null;
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-committed-recheck-retry'));
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app/unlock');
    });
    expect(published).toEqual([{ vault_key_id: TEST_VECTOR_VAULT_KEY_ID, version: 2 }]);
    expect(screen.queryByTestId('recovery-committed-recheck-notice')).not.toBeInTheDocument();
    expect(screen.getByTestId('recovery-completed-while-locked-notice')).toBeInTheDocument();
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(true);

    shim.close();
  }, 30_000);

  it('BE4-2: a stalled reconciliation GET shows the committed outcome as pending without publishing; a later failure asks for a re-check and a later success hands off exactly once', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
    const published = collectVaultChangedBroadcasts();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveToLockedCommittedRecovery(fetchState, () => vaultCtx);

    fetchState.vaultGetHolds = 1;
    await act(async () => {
      fetchState.completeReleases[0]?.();
    });
    await waitFor(() => {
      expect(fetchState.vaultGetReleases).toHaveLength(1);
    });
    // Still pending: the user sees the committed outcome instead of an apparently unfinished recovery.
    const pending = screen.getByTestId('recovery-committed-recheck-notice');
    expect(pending).toHaveAttribute('data-phase', 'verifying');
    expect(pending).toHaveAttribute('role', 'status');
    expect(pending).toHaveTextContent(/Recovery completed/i);
    expect(published).toEqual([]);
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('recovery-step-regenerate-reauth')).not.toBeInTheDocument();
    expect(vaultCtx.state).toBe('locked');

    // The stalled request then fails: a re-check is required, still nothing published.
    fetchState.vaultGetFailure = 'network';
    await act(async () => {
      fetchState.vaultGetReleases[0]?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-committed-recheck-notice')).toHaveAttribute(
        'data-phase',
        'recheck_needed',
      );
    });
    expect(published).toEqual([]);
    expect(routerMocks.replace).not.toHaveBeenCalled();

    // A retry that the server answers verifies the vault and hands off once.
    fetchState.vaultGetFailure = null;
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-committed-recheck-retry'));
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app/unlock');
    });
    expect(published).toEqual([{ vault_key_id: TEST_VECTOR_VAULT_KEY_ID, version: 2 }]);
    expect(routerMocks.replace).toHaveBeenCalledTimes(1);

    shim.close();
  }, 30_000);

  it('BE4-5: the reconciliation publishes the verified live version 3, not the stale completion version 2, and the next mutation sends If-Match 3', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
    const published = collectVaultChangedBroadcasts();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveToLockedCommittedRecovery(fetchState, () => vaultCtx);

    // The complete POST answers version 2, but another mutation of the same vault already reached version 3.
    fetchState.vaultMetaOverride = makeVaultMetaFixture(3);
    await act(async () => {
      fetchState.completeReleases[0]?.();
    });
    await waitFor(() => {
      expect(routerMocks.replace).toHaveBeenCalledWith('/app/unlock');
    });
    expect(published).toEqual([{ vault_key_id: TEST_VECTOR_VAULT_KEY_ID, version: 3 }]);
    expect(vaultCtx.vaultMeta?.version).toBe(3);

    // The next mutation (a fresh recovery attempt on the same page) captures If-Match from the live version 3.
    fetchState.holdComplete = false;
    await waitFor(() => {
      expect(screen.getByTestId('recovery-key-submit')).not.toBeDisabled();
    });
    await submitRecoveryStep2();
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
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
      expect(fetchState.completeIfMatches).toHaveLength(2);
    });
    expect(fetchState.completeIfMatches[1]).toBe(`"${TEST_VECTOR_VAULT_KEY_ID}:3"`);

    shim.close();
  }, 30_000);

  it('FE4-1: a successor B that completed while the old completion A was held keeps its route and prepared regeneration UI when A is released and its recheck GET fails', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
    const published = collectVaultChangedBroadcasts();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveToLockedCommittedRecovery(fetchState, () => vaultCtx);

    // Successor B (same account) starts while A's 200 is still held and completes through to its prepared replacement keys.
    await waitFor(() => {
      expect(screen.getByTestId('recovery-key-submit')).not.toBeDisabled();
    });
    await submitRecoveryStep2();
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-new-passphrase')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('recovery-new-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.change(screen.getByTestId('recovery-confirm-passphrase-input'), {
      target: { value: STRONG_NEW_PASSPHRASE },
    });
    fireEvent.click(screen.getByTestId('recovery-step3-submit'));
    await waitFor(() => {
      expect(fetchState.completeReleases).toHaveLength(2);
    });
    await act(async () => {
      fetchState.completeReleases[1]?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-reauth')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });
    expect(vaultCtx.state).toBe('unlocked');
    const publishedBeforeA = published.length;
    routerMocks.replace.mockClear();

    // The old completion A is released and the recheck GET it would start fails.
    fetchState.vaultGetFailure = { status: 503, code: 'service_unavailable' };
    await act(async () => {
      fetchState.completeReleases[0]?.();
    });
    await settle();

    // No obsolete notice or actions over B, and B's route, prepared keys and session are unchanged.
    expect(screen.queryByTestId('recovery-committed-recheck-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-committed-recheck-retry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-completed-while-locked-notice')).not.toBeInTheDocument();
    expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(published.slice(publishedBeforeA)).toEqual([]);
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(false);
    expect(vaultCtx.state).toBe('unlocked');

    shim.close();
  }, 30_000);

  it('FE4-1: a vault B announced while the old recheck GET is held removes the verifying notice, and the failing GET never brings old Check again / Go to unlock controls back', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
    const published = collectVaultChangedBroadcasts();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveToLockedCommittedRecovery(fetchState, () => vaultCtx);

    fetchState.vaultGetHolds = 1;
    await act(async () => {
      fetchState.completeReleases[0]?.();
    });
    await waitFor(() => {
      expect(fetchState.vaultGetReleases).toHaveLength(1);
    });
    expect(screen.getByTestId('recovery-committed-recheck-notice')).toHaveAttribute(
      'data-phase',
      'verifying',
    );

    // While the recheck waits, a sibling announces the recreated vault B.
    await act(async () => {
      vaultCtx.notifyVaultChanged({ vault_key_id: REPLACEMENT_VAULT_KEY_ID, version: 1 });
    });
    const publishedAfterTransition = published.length;
    routerMocks.replace.mockClear();

    // Then the stalled request fails: the old recovery's feedback is obsolete and must not turn into actions.
    fetchState.vaultGetFailure = 'network';
    await act(async () => {
      fetchState.vaultGetReleases[0]?.();
    });
    await settle();
    expect(screen.queryByTestId('recovery-committed-recheck-notice')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-committed-recheck-retry')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recovery-completed-while-locked-notice')).not.toBeInTheDocument();
    expect(published.slice(publishedAfterTransition)).toEqual([]);
    expect(routerMocks.replace).not.toHaveBeenCalled();
    expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(false);

    shim.close();
  }, 30_000);

  for (const announce of ['local notifyVaultChanged', 'sibling-tab broadcast'] as const) {
    it(`FE5-1: a vault B announced (${announce}) while the old completion A's 200 is still held, with the Worker staying locked, never lets A's failing recheck bring old notice or actions back`, async () => {
      const shim = makeTestShim();
      const fetchState = installRecoveryRaceFetchMock({ holdComplete: true });
      const published = collectVaultChangedBroadcasts();

      let vaultCtx!: VaultContextValue;
      renderRecovery({
        locale: 'en',
        workerFactory: () => shim.port,
        onVaultProbe: (ctx) => {
          vaultCtx = ctx;
        },
      });
      await driveToLockedCommittedRecovery(fetchState, () => vaultCtx);

      // Pre-reconciliation interval: A's 200 is still held when the recreated vault B is announced; the Worker stays locked.
      fetchState.vaultMetaOverride = {
        ...makeVaultMetaFixture(1),
        vault_key_id: REPLACEMENT_VAULT_KEY_ID,
      };
      await act(async () => {
        if (announce === 'local notifyVaultChanged') {
          vaultCtx.notifyVaultChanged({ vault_key_id: REPLACEMENT_VAULT_KEY_ID, version: 1 });
        } else {
          postVaultBroadcast({
            type: 'vault_changed',
            vault_key_id: REPLACEMENT_VAULT_KEY_ID,
            version: 1,
          });
        }
      });
      await settle();
      expect(vaultCtx.state).toBe('locked');
      expect(vaultCtx.workerState).toBe('locked');
      const publishedAfterTransition = published.length;
      const uiBefore = document.body.textContent;
      routerMocks.replace.mockClear();

      // A's 200 is released now and its recheck GET fails.
      fetchState.vaultGetFailure = { status: 503, code: 'service_unavailable' };
      await act(async () => {
        fetchState.completeReleases[0]?.();
      });
      await settle();
      await settle();

      // No old notice or actions at any point, and B's route and UI are unchanged.
      expect(screen.queryByTestId('recovery-committed-recheck-notice')).not.toBeInTheDocument();
      expect(screen.queryByTestId('recovery-committed-recheck-retry')).not.toBeInTheDocument();
      expect(screen.queryByTestId('recovery-completed-while-locked-notice')).not.toBeInTheDocument();
      expect(published.slice(publishedAfterTransition)).toEqual([]);
      expect(routerMocks.replace).not.toHaveBeenCalled();
      expect(hasRecoveryCompletedNotice('user-recovery-test-1')).toBe(false);
      expect(document.body.textContent).toBe(uiBefore);
      expect(vaultCtx.state).toBe('locked');
      expect(vaultCtx.workerState).toBe('locked');

      shim.close();
    }, 30_000);
  }

  it('BE5-2 (consumer boundary): a newly prepared regeneration bundle sends the live vault version, not the lower completion version', async () => {
    const shim = makeTestShim();
    const fetchState = installRecoveryRaceFetchMock();

    let vaultCtx!: VaultContextValue;
    renderRecovery({
      locale: 'en',
      workerFactory: () => shim.port,
      onVaultProbe: (ctx) => {
        vaultCtx = ctx;
      },
    });
    await driveRecoveryToStep4A(() => vaultCtx);

    // The completion answered version 2, but the vault is already at version 3 when the regeneration bundle is prepared.
    fetchState.vaultMetaOverride = makeVaultMetaFixture(3);
    fireEvent.change(screen.getByTestId('recovery-step4-reauth-password-input'), {
      target: { value: 'account-login-password-123' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-reauth-password-submit'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('recovery-step-regenerate-keys')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('recovery-keys-confirm-checkbox'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('recovery-step4-save-button'));
    });
    await waitFor(() => {
      expect(fetchState.regenCalls).toBe(1);
    });
    expect(fetchState.regenIfMatches).toEqual([`"${TEST_VECTOR_VAULT_KEY_ID}:3"`]);

    shim.close();
  }, 30_000);

  for (const locale of ['en', 'vi'] as const) {
    it(`FE3-1 (${locale}): while the wake gate says password entry is paused the Step 4A password field is not editable, and it is editable again once access is verified`, async () => {
      const shim = makeTestShim();
      installRecoveryRaceFetchMock();
      const { lockEpochEnv, wake } = makeHeldWakeLockEpochEnv();

      let vaultCtx!: VaultContextValue;
      renderRecovery({
        locale,
        workerFactory: () => shim.port,
        lockEpochEnv,
        onVaultProbe: (ctx) => {
          vaultCtx = ctx;
        },
      });
      await driveRecoveryToStep4A(() => vaultCtx);
      const passwordInput = screen.getByTestId('recovery-step4-reauth-password-input') as HTMLInputElement;
      expect(passwordInput).not.toBeDisabled();

      wake.hold = true;
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(vaultCtx.state).toBe('unlocking');

      // The status promises that password entry is paused: the field is present but cannot be edited.
      const status = screen.getByTestId('recovery-wake-gate-status');
      const messages = locale === 'vi' ? viMessages : enMessages;
      expect(status).toHaveTextContent(messages.recovery.wakeGate.title);
      expect(status.textContent ?? '').toContain(
        locale === 'vi' ? 'việc nhập mật khẩu tạm dừng' : 'password entry is paused',
      );
      expect(status.textContent ?? '').not.toMatch(/password fields stay hidden|các ô mật khẩu được ẩn/);
      expect(passwordInput).toBeDisabled();
      expect(screen.getByTestId('recovery-step4-reauth-password-submit')).toBeDisabled();

      // Verified again: the status goes away and the same field accepts input.
      await act(async () => {
        wake.release?.();
      });
      await waitFor(() => {
        expect(vaultCtx.state).toBe('unlocked');
      });
      expect(screen.queryByTestId('recovery-wake-gate-status')).not.toBeInTheDocument();
      expect(passwordInput).not.toBeDisabled();
      fireEvent.change(passwordInput, { target: { value: 'typed-after-verification' } });
      expect(passwordInput.value).toBe('typed-after-verification');

      shim.close();
    }, 30_000);
  }
});
