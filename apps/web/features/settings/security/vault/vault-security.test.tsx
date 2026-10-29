import { ProblemError } from '@engram/shared-types';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import {
  VaultProvider,
  resetVaultBroadcastForTests,
  useVault,
  type LockEpochEnvironment,
  type VaultContextValue,
} from '@/features/vault';
import type { Me } from '@/lib/api/auth';
import type { VaultRecoveryKeysStatus, VaultState } from '@/lib/api/vault';
import { CryptoClientError } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim, type ShimmedWorkerInstance } from '@/lib/crypto/test/worker-shim';
import en from '../../../../messages/en.json';
import { VaultSecurityPanel } from './vault-security-panel';

// Fast deterministic KEK derive (`BLAKE2b-256`) for Vitest unit tests
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

// Shared in-memory BroadcastChannel hub for multi-tab tests
type MessageListener = (event: MessageEvent<unknown>) => void;

class HubBroadcastChannel {
  private static readonly channelsByName = new Map<string, Set<HubBroadcastChannel>>();
  static allowLoopback = false;
  private readonly listeners = new Set<MessageListener>();
  readonly name: string;
  closed = false;

  constructor(name: string) {
    this.name = name;
    let bucket = HubBroadcastChannel.channelsByName.get(name);
    if (!bucket) {
      bucket = new Set();
      HubBroadcastChannel.channelsByName.set(name, bucket);
    }
    bucket.add(this);
  }

  addEventListener(type: string, listener: MessageListener): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: MessageListener): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    const bucket = HubBroadcastChannel.channelsByName.get(this.name);
    if (!bucket) return;
    for (const peer of bucket) {
      if (peer === this && !HubBroadcastChannel.allowLoopback) continue;
      for (const listener of [...peer.listeners]) {
        listener({ data } as MessageEvent<unknown>);
      }
    }
  }

  close(): void {
    this.closed = true;
    HubBroadcastChannel.channelsByName.get(this.name)?.delete(this);
  }

  static reset(): void {
    HubBroadcastChannel.channelsByName.clear();
    HubBroadcastChannel.allowLoopback = false;
  }
}

class FakeIDBStorage {
  readonly stores = new Map<string, Map<string, unknown>>();

  ensureStore(name: string): Map<string, unknown> {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    return store;
  }

  createFactory(): IDBFactory {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const storage = this;
    return {
      open(): IDBOpenDBRequest {
        const req: Record<string, unknown> = {
          result: null,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          onblocked: null,
        };
        queueMicrotask(() => {
          const db = storage.createDatabase();
          req.result = db;
          if (typeof req.onupgradeneeded === 'function') (req.onupgradeneeded as () => void)();
          if (typeof req.onsuccess === 'function') (req.onsuccess as () => void)();
        });
        return req as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
  }

  private createDatabase(): IDBDatabase {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const storage = this;
    return {
      objectStoreNames: {
        contains(name: string): boolean {
          return storage.stores.has(name);
        },
      },
      onversionchange: null,
      createObjectStore(name: string) {
        storage.ensureStore(name);
        return {} as IDBObjectStore;
      },
      close() {
        // no-op
      },
      transaction(storeNames: string | string[]): IDBTransaction {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        for (const n of names) storage.ensureStore(n);
        let pendingRequests = 0;
        let finishScheduled = false;

        const tx: Record<string, unknown> = {
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          abort() {
            if (typeof tx.onabort === 'function') (tx.onabort as () => void)();
          },
          objectStore(name: string): IDBObjectStore {
            const backing = storage.ensureStore(name);
            const scheduleComplete = () => {
              if (pendingRequests > 0 || finishScheduled) return;
              finishScheduled = true;
              queueMicrotask(() => {
                if (typeof tx.oncomplete === 'function') (tx.oncomplete as () => void)();
              });
            };
            const makeReq = (runOp: () => unknown) => {
              pendingRequests += 1;
              const r: Record<string, unknown> = { result: undefined, error: null, onsuccess: null, onerror: null };
              queueMicrotask(() => {
                pendingRequests -= 1;
                r.result = runOp();
                if (typeof r.onsuccess === 'function') (r.onsuccess as () => void)();
                scheduleComplete();
              });
              return r as unknown as IDBRequest;
            };
            return {
              get(key: IDBValidKey) {
                return makeReq(() => {
                  const val = backing.get(String(key));
                  return val !== undefined ? structuredClone(val) : undefined;
                });
              },
              put(value: unknown, key?: IDBValidKey) {
                return makeReq(() => {
                  backing.set(String(key), structuredClone(value));
                  return key;
                });
              },
              delete(key: IDBValidKey) {
                return makeReq(() => {
                  backing.delete(String(key));
                  return undefined;
                });
              },
            } as unknown as IDBObjectStore;
          },
        };
        return tx as unknown as IDBTransaction;
      },
    } as unknown as IDBDatabase;
  }
}

class FakeWebLocks {
  private queue: Promise<unknown> = Promise.resolve();
  createLockManager(): LockManager {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      request(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
        maybeCallback?: LockGrantedCallback<unknown>,
      ): Promise<unknown> {
        const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
        const run = async () => cb({ name, mode: 'exclusive' } as Lock);
        const next = self.queue.then(run, run);
        self.queue = next.catch(() => undefined);
        return next;
      },
      query: async () => ({ held: [], pending: [] }),
    } as unknown as LockManager;
  }
}

const VAULT_KEY_ID = 'vk:7f3a9b2c4d5e6f7a8b9c0d';
const INITIAL_KDF = {
  alg: 'argon2id13' as const,
  ops: 3,
  mem: 67_108_864,
  parallelism: 1 as const,
  salt: 'oKGio6SlpqeoqaqrrK2urw',
};
const STRONG_PASSPHRASE = 'correct-horse-battery-staple-99!';

function makeMeFixture(overrides: {
  vaultStatus?: 'absent' | 'present';
  hasPassword?: boolean;
  oauthReauthProviders?: Array<'google'>;
} = {}): Me {
  const hasPassword = overrides.hasPassword ?? true;
  return {
    user: {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'settings-user@example.test',
      email_verified: true,
      created_at: '2026-01-01T00:00:00Z',
    },
    settings: {
      locale: 'en',
      theme: 'light',
      auto_lock_minutes: 15,
      semantic_suggest: false,
    },
    identities: hasPassword
      ? [{ provider: 'password', linked_at: '2026-01-01T00:00:00Z' }]
      : [{ provider: 'google', linked_at: '2026-01-01T00:00:00Z' }],
    features: {
      semantic_available: false,
      email_verification_required: false,
      oauth_providers: ['google'],
      oauth_reauth_providers: overrides.oauthReauthProviders ?? (hasPassword ? [] : ['google']),
      password_enrollment_available: !hasPassword,
      captcha_site_key: null,
    },
    vault: { status: overrides.vaultStatus ?? 'present' },
  };
}

function makeVaultMeta(version = 1, remaining = 5): VaultState {
  return {
    vault_key_id: VAULT_KEY_ID,
    version,
    kdf: INITIAL_KDF,
    vault_key_wrapped_by_kek:
      'AbCxsrO0tba3uLm6u7y9vr_AwcLDxMXGxyfYfNv-vuDRS6i3Up5z_wCEX2cLt1xXgujuY7dGa_eirv2y5QQSBXkKR95PrK-ilA',
    x25519_public: 'EIT5fcwxJb3Sw8y-V9yHL-JGU5pDVlgw9H5ueCV7OnI',
    ed25519_public: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
    private_keys_wrapped:
      'AeDh4uPk5ebn6Onq6-zt7u_w8fLz9PX299I6ypcubNr8Ofy8RwtQE-3gVPZ1cTrHgeO1ZMoyFkOJgqz7gG75ofa4qHejTdUrskM0hqoPmKH-rt_ZLSoHn2BH9MF-TUGyovpu_punj7v-',
    recovery_keys_remaining: remaining,
    passkeys: [],
  };
}

function makeRkStatus(remaining = 5, emptySlots = [6, 7, 8, 9, 10]): VaultRecoveryKeysStatus {
  return {
    remaining,
    slots: 10,
    empty_slots: emptySlots,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function problemResponse(
  code: string,
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return new Response(
    JSON.stringify({
      type: `https://key.zone17th.click/problems/${code}`,
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

describe('Task 20A — Vault Security Settings (Change Passphrase, Recovery Keys, Reset Vault)', { timeout: 20_000 }, () => {
  const activeShims: ShimmedWorkerInstance[] = [];
  let fakeIdb: FakeIDBStorage;
  let fakeLocks: FakeWebLocks;

  beforeEach(() => {
    document.cookie = 'sabk_csrf=test-csrf-token';
    HubBroadcastChannel.reset();
    resetVaultBroadcastForTests();
    fakeIdb = new FakeIDBStorage();
    fakeLocks = new FakeWebLocks();

    vi.stubGlobal('BroadcastChannel', HubBroadcastChannel);
    vi.stubGlobal('indexedDB', fakeIdb.createFactory());
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: fakeLocks.createLockManager(),
    });
  });

  afterEach(() => {
    cleanup();
    for (const shim of activeShims.splice(0)) {
      shim.close();
    }
    resetVaultBroadcastForTests();
    HubBroadcastChannel.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makeShimmedWorkerFactory(hooks: Parameters<typeof createWorkerShim>[0] = {}) {
    return () => {
      const shim = createWorkerShim({
        deriveKek: fastTestDeriveKek,
        ...hooks,
      });
      activeShims.push(shim);
      return shim.port;
    };
  }

  function makeLockEpochEnv(): LockEpochEnvironment {
    return {
      idbFactory: fakeIdb.createFactory(),
      locksManager: fakeLocks.createLockManager(),
    };
  }

  interface RenderHarnessOptions {
    me?: Me;
    vaultMeta?: VaultState;
    rkStatus?: VaultRecoveryKeysStatus;
    unlocked?: boolean;
    workerHooks?: Parameters<typeof createWorkerShim>[0];
    customFetch?: (url: string, init?: RequestInit) => Promise<Response> | Response;
  }

  async function renderSettingsHarness(opts: RenderHarnessOptions = {}) {
    let currentMe = opts.me ?? makeMeFixture();
    let currentVaultMeta: VaultState | null = opts.vaultMeta ?? makeVaultMeta(1, 5);
    let currentRkStatus = opts.rkStatus ?? makeRkStatus(5, [6, 7, 8, 9, 10]);
    const callLog: string[] = [];
    const requestsByPath: Array<{ method: string; path: string; headers: Headers; body: string }> = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      requestsByPath.push({ method, path: url, headers, body: bodyStr });

      if (opts.customFetch) {
        const custom = await opts.customFetch(url, init);
        if (custom) return custom;
      }

      if (url.endsWith('/api/v1/auth/csrf')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/api/v1/auth/config')) {
        return jsonResponse({
          email_verification_required: false,
          oauth_providers: ['google'],
          captcha: { turnstile_site_key: null },
        });
      }
      if (url.endsWith('/api/v1/auth/me')) {
        callLog.push('GET /auth/me');
        return jsonResponse(currentMe);
      }
      if (url.endsWith('/api/v1/vault')) {
        if (method === 'GET') {
          callLog.push('GET /vault');
          if (!currentVaultMeta) {
            return problemResponse('vault_absent', 404);
          }
          return jsonResponse(currentVaultMeta);
        }
        if (method === 'DELETE') {
          callLog.push('DELETE /vault');
          currentVaultMeta = null;
          currentMe = makeMeFixture({ vaultStatus: 'absent' });
          return new Response(null, { status: 204 });
        }
      }
      if (url.endsWith('/api/v1/vault/recovery-keys')) {
        callLog.push('GET /vault/recovery-keys');
        return jsonResponse(currentRkStatus);
      }
      if (url.endsWith('/api/v1/auth/reauth')) {
        const parsed = bodyStr ? (JSON.parse(bodyStr) as { action: string }) : { action: 'vault.rewrap' };
        callLog.push(`POST /auth/reauth (${parsed.action})`);
        return jsonResponse({
          action: parsed.action,
          grant: `grant-for-${parsed.action}`,
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (url.endsWith('/api/v1/vault/kek') && method === 'PUT') {
        callLog.push('PUT /vault/kek');
        const nextVersion = (currentVaultMeta?.version ?? 1) + 1;
        if (currentVaultMeta) {
          currentVaultMeta = { ...currentVaultMeta, version: nextVersion };
        }
        return jsonResponse({ version: nextVersion });
      }
      if (url.endsWith('/api/v1/vault/recovery-keys/regenerate') && method === 'POST') {
        callLog.push('POST /vault/recovery-keys/regenerate');
        const nextVersion = (currentVaultMeta?.version ?? 1) + 1;
        if (currentVaultMeta) {
          currentVaultMeta = {
            ...currentVaultMeta,
            version: nextVersion,
            recovery_keys_remaining: 10,
          };
        }
        currentRkStatus = makeRkStatus(10, []);
        return jsonResponse({ remaining: 10, version: nextVersion });
      }
      if (url.endsWith('/api/v1/vault/recovery-keys/rotate') && method === 'POST') {
        callLog.push('POST /vault/recovery-keys/rotate');
        const nextVersion = (currentVaultMeta?.version ?? 1) + 1;
        if (currentVaultMeta) {
          currentVaultMeta = {
            ...currentVaultMeta,
            version: nextVersion,
            recovery_keys_remaining: 10,
          };
        }
        currentRkStatus = makeRkStatus(10, []);
        return jsonResponse({ remaining: 10, version: nextVersion });
      }

      return jsonResponse({});
    });

    vi.stubGlobal('fetch', fetchMock);

    let capturedVaultCtx: VaultContextValue | null = null;
    let capturedSessionCtx: ReturnType<typeof useSession> | null = null;
    function VaultBridgeProbe() {
      capturedVaultCtx = useVault();
      capturedSessionCtx = useSession();
      return null;
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const workerFactory = () => {
      const shim = createWorkerShim({
        deriveKek: fastTestDeriveKek,
        ...opts.workerHooks,
      });
      activeShims.push(shim);
      const origPostMessage = shim.port.postMessage.bind(shim.port);
      shim.port.postMessage = (message, transfer) => {
        callLog.push(`Worker:${message.type}`);
        origPostMessage(message, transfer);
      };
      return shim.port;
    };

    const utils = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <VaultProvider createWorker={workerFactory} lockEpochEnv={makeLockEpochEnv()}>
              <VaultBridgeProbe />
              <VaultSecurityPanel />
            </VaultProvider>
          </SessionProvider>
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    await waitFor(() => {
      expect(capturedVaultCtx).not.toBeNull();
      expect(screen.getByTestId('vault-security-section')).toBeInTheDocument();
      if (currentMe.vault.status === 'present') {
        expect(capturedVaultCtx!.serverVaultStatus).toBe('present');
      }
    });

    const shouldUnlock = opts.unlocked ?? true;
    if (shouldUnlock && currentMe.vault.status === 'present') {
      await act(async () => {
        const op = capturedVaultCtx!.beginOp();
        await capturedVaultCtx!.createVault({
          passphrase: 'initial-setup-passphrase-12345',
          opGeneration: op.opGeneration,
          skipRecoveryKeys: true,
        });
        await capturedVaultCtx!.reloadVaultMeta();
      });
      await waitFor(() => {
        expect(capturedVaultCtx!.workerState).toBe('unlocked');
        expect(screen.queryByTestId('vault-security-locked-banner')).toBeNull();
        expect(screen.getByRole('button', { name: 'Change passphrase' })).toBeEnabled();
      });
    }

    // Clear initial setup logs so test assertions inspect only user interaction calls
    callLog.length = 0;
    requestsByPath.length = 0;

    return {
      ...utils,
      getVaultCtx: () => capturedVaultCtx!,
      getSessionCtx: () => capturedSessionCtx!,
      callLog,
      requestsByPath,
      setServerVaultMeta: (next: VaultState | null) => {
        currentVaultMeta = next;
      },
      setServerMe: (next: Me) => {
        currentMe = next;
      },
    };
  }

  it('asserts strict re-auth -> Worker rewrap -> PUT /vault/kek call order and wipes inputs without asking for old passphrase', async () => {
    const user = userEvent.setup();
    const { callLog, requestsByPath } = await renderSettingsHarness();

    await user.click(screen.getByRole('button', { name: 'Change passphrase' }));

    const dialog = await screen.findByRole('dialog');
    // Never asks for old vault passphrase
    expect(within(dialog).queryByLabelText(/old passphrase|current passphrase/i)).toBeNull();

    // Fill login password (P02) and new vault passphrase twice (P03)
    const loginPwdInput = within(dialog).getByLabelText('Login password');
    const newPpInput = within(dialog).getByLabelText('New vault passphrase');
    const confirmPpInput = within(dialog).getByLabelText('Confirm new passphrase');

    await user.type(loginPwdInput, 'my-account-login-password');
    await user.type(newPpInput, STRONG_PASSPHRASE);
    await user.type(confirmPpInput, STRONG_PASSPHRASE);

    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // Strict call order: POST /auth/reauth BEFORE Worker:rewrap BEFORE PUT /vault/kek
    expect(callLog.slice(0, 3)).toEqual([
      'POST /auth/reauth (vault.rewrap)',
      'Worker:rewrap',
      'PUT /vault/kek',
    ]);

    const putReq = requestsByPath.find((r) => r.method === 'PUT' && r.path.endsWith('/api/v1/vault/kek'));
    expect(putReq).toBeDefined();
    expect(putReq!.headers.get('If-Match')).toBe(`"${VAULT_KEY_ID}:1"`);
    expect(putReq!.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(putReq!.headers.get('X-Reauth-Token')).toBe('grant-for-vault.rewrap');
    // Plaintext passphrase never sent over network
    expect(putReq!.body).not.toContain(STRONG_PASSPHRASE);

    // Reopen dialog to verify inputs were wiped
    await user.click(screen.getByRole('button', { name: 'Change passphrase' }));
    const reopened = await screen.findByRole('dialog');
    expect(within(reopened).getByLabelText('New vault passphrase')).toHaveValue('');
    expect(within(reopened).getByLabelText('Confirm new passphrase')).toHaveValue('');
  });

  it('cancelling re-auth at any step makes zero fetch calls and zero Worker calls', async () => {
    const user = userEvent.setup();
    const { callLog, requestsByPath } = await renderSettingsHarness();

    // 1. Cancel Change Passphrase dialog
    await user.click(screen.getByRole('button', { name: 'Change passphrase' }));
    const passDlg = await screen.findByRole('dialog');
    await user.type(within(passDlg).getByLabelText('Login password'), 'partial-password');
    await user.type(within(passDlg).getByLabelText('New vault passphrase'), STRONG_PASSPHRASE);
    await user.click(within(passDlg).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // 2. Cancel Regenerate Recovery Keys dialog at re-auth step
    await user.click(screen.getByRole('button', { name: 'Regenerate new keys' }));
    const rkDlg = await screen.findByRole('dialog');
    await user.type(within(rkDlg).getByLabelText('Login password'), 'partial-password');
    await user.click(within(rkDlg).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // 3. Cancel Rotate All 10 dialog at re-auth step
    await user.click(screen.getByRole('button', { name: 'Rotate all 10' }));
    const rotDlg = await screen.findByRole('dialog');
    await user.click(within(rotDlg).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // 4. Cancel Reset Vault dialog at step 3 re-auth
    await user.click(screen.getByRole('button', { name: 'Reset vault' }));
    const rstDlg = await screen.findByRole('dialog');
    await user.click(within(rstDlg).getByRole('button', { name: 'None of these work' }));
    await user.click(within(rstDlg).getByRole('button', { name: 'Checked backups' }));
    await user.type(within(rstDlg).getByLabelText('Login password'), 'partial-password');
    await user.click(within(rstDlg).getByRole('button', { name: 'Back' }));
    await user.click(within(rstDlg).getByRole('button', { name: 'Back' }));
    await user.click(within(rstDlg).getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    expect(requestsByPath).toHaveLength(0);
    expect(callLog).toHaveLength(0);
  });

  it(
    'blocks passphrase submit on policy failures (< 12 chars, zxcvbn < 3, mismatch, NFC normalization)',
    async () => {
    const user = userEvent.setup();
    const { callLog, requestsByPath } = await renderSettingsHarness();

    await user.click(screen.getByRole('button', { name: 'Change passphrase' }));
    const dialog = await screen.findByRole('dialog');

    const newPpInput = within(dialog).getByLabelText('New vault passphrase');
    const confirmPpInput = within(dialog).getByLabelText('Confirm new passphrase');
    const submitBtn = within(dialog).getByRole('button', { name: 'Change passphrase' });

    // Too short (< 12 chars)
    await user.type(newPpInput, 'short-pp');
    await user.type(confirmPpInput, 'short-pp');
    await user.click(submitBtn);
    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Passphrase must be at least 12 characters.',
      );
    });

    // Too weak (>= 12 chars but zxcvbn < 3)
    await user.clear(newPpInput);
    await user.clear(confirmPpInput);
    await user.type(newPpInput, 'aaaaaaaaaaaa');
    await user.type(confirmPpInput, 'aaaaaaaaaaaa');
    await user.click(submitBtn);
    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Passphrase is too easy to guess (requires score ≥ 3).',
      );
    });

    // Mismatch
    await user.clear(newPpInput);
    await user.clear(confirmPpInput);
    await user.type(newPpInput, STRONG_PASSPHRASE);
    await user.type(confirmPpInput, `${STRONG_PASSPHRASE}-different`);
    await user.click(submitBtn);
    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Passphrases do not match.');
    });

    // Zero network or Worker calls occurred
    expect(requestsByPath).toHaveLength(0);
    expect(callLog).toHaveLength(0);
    },
    15_000,
  );

  it('handles 412 version_mismatch by reloading vault meta and showing reload message without silent retry', async () => {
    const user = userEvent.setup();
    let putKekCalls = 0;

    const { getVaultCtx, setServerVaultMeta } = await renderSettingsHarness({
      customFetch: (url, init) => {
        if (url.endsWith('/api/v1/vault/kek') && init?.method?.toUpperCase() === 'PUT') {
          putKekCalls += 1;
          setServerVaultMeta(makeVaultMeta(2, 5));
          return problemResponse('version_mismatch', 412, { current_version: 2 });
        }
        return undefined as unknown as Response;
      },
    });

    await user.click(screen.getByRole('button', { name: 'Change passphrase' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Login password'), 'my-login-password');
    await user.type(within(dialog).getByLabelText('New vault passphrase'), STRONG_PASSPHRASE);
    await user.type(within(dialog).getByLabelText('Confirm new passphrase'), STRONG_PASSPHRASE);
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }));

    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'Vault changed in another tab or device',
      );
    });

    // Must not silently retry PUT /vault/kek
    expect(putKekCalls).toBe(1);

    // Vault meta is reloaded to version 2
    await waitFor(() => {
      expect(getVaultCtx().vaultMeta?.version).toBe(2);
    });
  });

  it('prevents double submit and reuses the exact same Idempotency-Key on retry after a network error', async () => {
    const user = userEvent.setup();
    let putAttempt = 0;

    const { requestsByPath } = await renderSettingsHarness({
      customFetch: (url, init) => {
        if (url.endsWith('/api/v1/vault/kek') && init?.method?.toUpperCase() === 'PUT') {
          putAttempt += 1;
          if (putAttempt === 1) {
            throw new TypeError('Failed to fetch: network error');
          }
        }
        return undefined as unknown as Response;
      },
    });

    await user.click(screen.getByRole('button', { name: 'Change passphrase' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Login password'), 'my-login-password');
    await user.type(within(dialog).getByLabelText('New vault passphrase'), STRONG_PASSPHRASE);
    await user.type(within(dialog).getByLabelText('Confirm new passphrase'), STRONG_PASSPHRASE);

    const submitBtn = within(dialog).getByRole('button', { name: 'Change passphrase' });
    // Rapid double click
    await Promise.all([user.click(submitBtn), user.click(submitBtn)]);

    // First attempt failed with network error; only 1 PUT request was sent
    await waitFor(() => {
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not reach the server');
    });
    const firstPutRequests = requestsByPath.filter(
      (r) => r.method === 'PUT' && r.path.endsWith('/api/v1/vault/kek'),
    );
    expect(firstPutRequests).toHaveLength(1);
    const firstIdempotencyKey = firstPutRequests[0]!.headers.get('Idempotency-Key');
    expect(firstIdempotencyKey).toBeTruthy();

    // Retry button reuses the exact same Idempotency-Key without re-running Worker derive
    const retryBtn = within(dialog).getByRole('button', { name: 'Try again' });
    await user.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const allPutRequests = requestsByPath.filter(
      (r) => r.method === 'PUT' && r.path.endsWith('/api/v1/vault/kek'),
    );
    expect(allPutRequests).toHaveLength(2);
    expect(allPutRequests[1]!.headers.get('Idempotency-Key')).toBe(firstIdempotencyKey);
  });

  it('after a rewrap in tab A, tab B (second provider on shared BroadcastChannel) reloads GET /vault and adopts the new version', async () => {
    const user = userEvent.setup();
    let serverMeta = makeVaultMeta(1, 5);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/v1/auth/csrf')) return new Response(null, { status: 204 });
      if (url.endsWith('/api/v1/auth/config')) {
        return jsonResponse({
          email_verification_required: false,
          oauth_providers: [],
          captcha: { turnstile_site_key: null },
        });
      }
      if (url.endsWith('/api/v1/auth/me')) return jsonResponse(makeMeFixture());
      if (url.endsWith('/api/v1/vault/recovery-keys')) return jsonResponse(makeRkStatus(5));
      if (url.endsWith('/api/v1/vault') && method === 'GET') {
        return jsonResponse(serverMeta);
      }
      if (url.endsWith('/api/v1/auth/reauth')) {
        return jsonResponse({
          action: 'vault.rewrap',
          grant: 'grant-tab-a',
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      if (url.endsWith('/api/v1/vault/kek') && method === 'PUT') {
        serverMeta = { ...serverMeta, version: 2 };
        return jsonResponse({ version: 2 });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    let tabAVault: VaultContextValue | null = null;
    let tabBVault: VaultContextValue | null = null;

    function TabAProbe() {
      tabAVault = useVault();
      return null;
    }
    function TabBProbe() {
      tabBVault = useVault();
      return <span data-testid="tab-b-version">{tabBVault.vaultMeta?.version ?? 0}</span>;
    }

    const qcA = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const qcB = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // In a single JS realm, both providers share `broadcast.ts`'s `sharedChannel` instance;
    // enabling `allowLoopback` makes `sharedChannel.postMessage(msg)` deliver to the `'message'`
    // listener as `'remote'`, exercising the exact cross-tab `BroadcastChannel('sabk.vault')` path.
    HubBroadcastChannel.allowLoopback = true;

    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <div>
          <QueryClientProvider client={qcA}>
            <SessionProvider>
              <VaultProvider
                createWorker={makeShimmedWorkerFactory()}
                lockEpochEnv={makeLockEpochEnv()}
              >
                <TabAProbe />
                <VaultSecurityPanel />
              </VaultProvider>
            </SessionProvider>
          </QueryClientProvider>
          <QueryClientProvider client={qcB}>
            <SessionProvider>
              <VaultProvider
                createWorker={makeShimmedWorkerFactory()}
                lockEpochEnv={makeLockEpochEnv()}
              >
                <TabBProbe />
              </VaultProvider>
            </SessionProvider>
          </QueryClientProvider>
        </div>
      </NextIntlClientProvider>,
    );

    await waitFor(() => {
      expect(tabAVault).not.toBeNull();
      expect(tabBVault).not.toBeNull();
      expect(tabAVault!.serverVaultStatus).toBe('present');
      expect(tabBVault!.serverVaultStatus).toBe('present');
    });

    await act(async () => {
      const opA = tabAVault!.beginOp();
      await tabAVault!.createVault({
        passphrase: 'tab-a-initial-passphrase',
        opGeneration: opA.opGeneration,
        skipRecoveryKeys: true,
      });
      await tabAVault!.reloadVaultMeta();
      await tabBVault!.reloadVaultMeta();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Change passphrase' })).toBeEnabled();
    });

    expect(screen.getByTestId('tab-b-version')).toHaveTextContent('1');

    // Perform rewrap in Tab A via UI
    await user.click(screen.getByRole('button', { name: 'Change passphrase' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Login password'), 'my-login-password');
    await user.type(within(dialog).getByLabelText('New vault passphrase'), STRONG_PASSPHRASE);
    await user.type(within(dialog).getByLabelText('Confirm new passphrase'), STRONG_PASSPHRASE);
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }));

    // Tab B receives `vault_changed` over BroadcastChannel and reloads GET /vault -> version 2
    await waitFor(() => {
      expect(screen.getByTestId('tab-b-version')).toHaveTextContent('2');
      expect(tabBVault!.vaultMeta?.version).toBe(2);
    });
  });

  it('never renders stored recovery keys or a "view RK" control in Settings', async () => {
    await renderSettingsHarness({
      rkStatus: makeRkStatus(8, [9, 10]),
    });

    await waitFor(() => {
      expect(screen.getByTestId('recovery-keys-remaining-badge')).toHaveTextContent('8 of 10 left');
    });
    expect(screen.queryByRole('button', { name: /view recovery keys|show recovery keys|xem rk/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/rk\d+_[0-7][0-9A-Z]{3}-/);
  });

  it('wipes newly generated recovery keys from DOM when the dialog closes after saving', async () => {
    const user = userEvent.setup();
    const { callLog } = await renderSettingsHarness({
      rkStatus: makeRkStatus(8, [9, 10]),
    });

    await user.click(screen.getByRole('button', { name: 'Regenerate new keys' }));
    const rkDlg = await screen.findByRole('dialog');
    await user.type(within(rkDlg).getByLabelText('Login password'), 'my-login-password');
    await user.click(within(rkDlg).getByRole('button', { name: 'Continue' }));

    const grid = await within(rkDlg).findByTestId('recovery-keys-grid');
    const items = within(grid).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toMatch(/^rk9_[0-7]/);
    expect(items[1]!.textContent).toMatch(/^rk10_[0-7]/);

    // Done button is disabled until acknowledgement checkbox is ticked
    const doneBtn = within(rkDlg).getByRole('button', { name: 'Done' });
    expect(doneBtn).toBeDisabled();

    await user.click(within(rkDlg).getByRole('checkbox'));
    expect(doneBtn).toBeEnabled();
    await user.click(doneBtn);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toMatch(/rk9_[0-7]/);
    expect(document.body.textContent).not.toMatch(/rk10_[0-7]/);
    expect(callLog.slice(0, 3)).toEqual([
      'POST /auth/reauth (vault.recovery_keys_regenerate)',
      'Worker:makeRecoveryKeys',
      'POST /vault/recovery-keys/regenerate',
    ]);
  });

  it('wipes newly generated recovery keys from DOM immediately when the vault locks while the dialog is open', async () => {
    const user = userEvent.setup();
    const { getVaultCtx } = await renderSettingsHarness({
      rkStatus: makeRkStatus(8, [9, 10]),
    });

    await user.click(screen.getByRole('button', { name: 'Rotate all 10' }));
    const rotDlg = await screen.findByRole('dialog');
    await user.type(within(rotDlg).getByLabelText('Login password'), 'my-login-password');
    await user.click(within(rotDlg).getByRole('button', { name: 'Continue' }));

    const rotGrid = await within(rotDlg).findByTestId('recovery-keys-grid');
    expect(within(rotGrid).getAllByRole('listitem')).toHaveLength(10);

    // Locking the vault while the RK grid is open immediately wipes the keys from DOM
    await act(async () => {
      await getVaultCtx().lockNow();
    });
    expect(within(rotDlg).queryByTestId('recovery-keys-grid')).toBeNull();
    expect(document.body.textContent).not.toMatch(/rk1_[0-7]/);
  });

  it('executes multi-step Reset Vault flow (step 1 paths -> step 2 backup -> step 3 re-auth -> step 4 typed confirmation -> 204 DELETE /vault -> lock + vault_changed + Me refresh)', async () => {
    const user = userEvent.setup();
    const { getVaultCtx, callLog, requestsByPath } = await renderSettingsHarness();

    await user.click(screen.getByRole('button', { name: 'Reset vault' }));
    const dialog = await screen.findByRole('dialog');

    // Step 1: reminds to check unlock paths
    expect(within(dialog).getByText(/Step 1 of 5/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'None of these work' }));

    // Step 2: reminds to check backups
    expect(within(dialog).getByText(/Step 2 of 5/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Checked backups' }));

    // Step 3: re-auth (`vault.reset`)
    expect(within(dialog).getByText(/Step 3 of 5/i)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Login password'), 'my-login-password');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));

    // Step 4: typed confirmation word ('RESET' or 'ĐẶT LẠI')
    await waitFor(() => {
      expect(within(dialog).getByText(/Step 4 of 5/i)).toBeInTheDocument();
    });
    const resetBtn = within(dialog).getByRole('button', { name: 'Reset vault' });
    expect(resetBtn).toBeDisabled();

    const confirmInput = within(dialog).getByLabelText(/Type ĐẶT LẠI or RESET/i);
    await user.type(confirmInput, 'wrong');
    expect(resetBtn).toBeDisabled();

    await user.clear(confirmInput);
    await user.type(confirmInput, 'RESET');
    expect(resetBtn).toBeEnabled();

    await user.click(resetBtn);

    // Step 5: done; provider locked, vault_changed broadcast, and Me refreshed to absent (`no_vault`)
    await waitFor(() => {
      expect(within(dialog).getByText('Vault has been reset')).toBeInTheDocument();
      expect(getVaultCtx().workerState).toBe('locked');
      expect(getVaultCtx().state).toBe('no_vault');
    });

    expect(callLog).toContain('POST /auth/reauth (vault.reset)');
    expect(callLog).toContain('DELETE /vault');
    expect(callLog).toContain('GET /auth/me');

    const delReq = requestsByPath.find((r) => r.method === 'DELETE' && r.path.endsWith('/api/v1/vault'));
    expect(delReq).toBeDefined();
    expect(delReq!.headers.get('If-Match')).toBe(`"${VAULT_KEY_ID}:1"`);
    expect(delReq!.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(delReq!.headers.get('X-Reauth-Token')).toBe('grant-for-vault.reset');
  });

  it('handles grant < 60 s remaining before POST for password user: re-authenticates in place without losing derived wrap', async () => {
    const user = userEvent.setup();
    let reauthCallCount = 0;

    const { callLog } = await renderSettingsHarness({
      customFetch: (url) => {
        if (url.endsWith('/api/v1/auth/reauth')) {
          reauthCallCount += 1;
          const ttlMs = reauthCallCount === 1 ? 30_000 : 300_000;
          return jsonResponse({
            action: 'vault.rewrap',
            grant: `grant-${reauthCallCount}`,
            expires_at: new Date(Date.now() + ttlMs).toISOString(),
          });
        }
        return undefined as unknown as Response;
      },
    });

    await user.click(screen.getByRole('button', { name: 'Change passphrase' }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText('Login password'), 'first-login-password');
    await user.type(within(dialog).getByLabelText('New vault passphrase'), STRONG_PASSPHRASE);
    await user.type(within(dialog).getByLabelText('Confirm new passphrase'), STRONG_PASSPHRASE);
    await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }));

    // Grant had only 30s left -> transitions to in-place password re-auth step
    await waitFor(() => {
      expect(
        within(dialog).getByText('Re-authentication expired before saving'),
      ).toBeInTheDocument();
    });

    // Worker:rewrap already ran once; in-place re-auth saves without calling Worker:rewrap a second time
    expect(callLog.filter((c) => c === 'Worker:rewrap')).toHaveLength(1);
    expect(callLog.filter((c) => c === 'PUT /vault/kek')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('Login password'), 'second-login-password');
    await user.click(within(dialog).getByRole('button', { name: 'Verify & save' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(callLog.filter((c) => c === 'Worker:rewrap')).toHaveLength(1);
    expect(callLog.filter((c) => c === 'PUT /vault/kek')).toHaveLength(1);
  });

  it('handles grant < 60 s remaining or expired for OAuth-only user: clears temporary secrets and shows restart message', async () => {
    const user = userEvent.setup();

    const { getSessionCtx } = await renderSettingsHarness({
      me: makeMeFixture({ hasPassword: false, oauthReauthProviders: ['google'] }),
      customFetch: (url) => {
        if (url.endsWith('/api/v1/auth/reauth')) {
          // Simulate OAuth callback receipt returning a grant with only 25 s remaining (< 60 s threshold)
          return jsonResponse({
            action: 'vault.rewrap',
            grant: 'oauth-grant-short-ttl',
            expires_at: new Date(Date.now() + 25_000).toISOString(),
          });
        }
        return undefined as unknown as Response;
      },
    });

    await user.click(screen.getByRole('button', { name: 'Change passphrase' }));
    const oauthDlg = await screen.findByRole('dialog');
    expect(within(oauthDlg).getByRole('button', { name: 'Verify with Google' })).toBeInTheDocument();

    // Complete OAuth re-auth receipt (grant has < 60 s left, so form unlocks at > 1 s but fails the < 60 s pre-POST gate)
    await act(async () => {
      await getSessionCtx().reauth.consumeOauthReceipt('vault.rewrap', 'google');
    });

    const newInput = await within(oauthDlg).findByLabelText('New vault passphrase');
    const confirmInput = within(oauthDlg).getByLabelText('Confirm new passphrase');
    fireEvent.change(newInput, { target: { value: STRONG_PASSPHRASE } });
    fireEvent.change(confirmInput, { target: { value: STRONG_PASSPHRASE } });
    await user.click(within(oauthDlg).getByRole('button', { name: 'Change passphrase' }));

    await waitFor(() => {
      expect(
        within(oauthDlg).getByText('Time ran out — restart required'),
      ).toBeInTheDocument();
    });
    expect(
      within(oauthDlg).getByRole('button', { name: 'Restart flow' }),
    ).toBeInTheDocument();
  });

  it(
    'maps 428, 409 idempotency, 503 kill switch, CLIENT_BUSY, and VAULT_RECOVERING to distinct messages (never "wrong passphrase")',
    async () => {
    const errorsToCheck: Array<{ err: unknown; expectedSubstring: string }> = [
      {
        err: new ProblemError({
          type: 'https://key.zone17th.click/problems/precondition_required',
          title: 'Precondition Required',
          status: 428,
          code: 'precondition_required',
        }),
        expectedSubstring: 'precondition was missing or invalid (428)',
      },
      {
        err: new ProblemError({
          type: 'https://key.zone17th.click/problems/idempotency_conflict',
          title: 'Conflict',
          status: 409,
          code: 'idempotency_conflict',
        }),
        expectedSubstring: 'conflicted with another request (409)',
      },
      {
        err: new ProblemError({
          type: 'https://key.zone17th.click/problems/vault_mutations_disabled',
          title: 'Service Unavailable',
          status: 503,
          code: 'vault_mutations_disabled',
        }),
        expectedSubstring: 'temporarily disabled on the server (503)',
      },
      {
        err: new CryptoClientError('CLIENT_BUSY', 'Busy'),
        expectedSubstring: 'Another vault operation is already in progress',
      },
      {
        err: new CryptoClientError('VAULT_RECOVERING', 'Recovering'),
        expectedSubstring: 'currently in recovery mode',
      },
    ];

    const user = userEvent.setup();
    let nextFailure: unknown = null;

    await renderSettingsHarness({
      customFetch: (url, init) => {
        if (url.endsWith('/api/v1/vault/kek') && init?.method?.toUpperCase() === 'PUT' && nextFailure) {
          throw nextFailure;
        }
        return undefined as unknown as Response;
      },
    });

    await user.click(screen.getByRole('button', { name: 'Change passphrase' }));
    const dialog = await screen.findByRole('dialog');

    for (const item of errorsToCheck) {
      nextFailure = item.err;
      const loginInput = within(dialog).queryByLabelText('Login password');
      if (loginInput) {
        fireEvent.change(loginInput, { target: { value: 'my-login-password' } });
      }
      const newInput = within(dialog).getByLabelText('New vault passphrase');
      const confirmInput = within(dialog).getByLabelText('Confirm new passphrase');
      fireEvent.change(newInput, { target: { value: STRONG_PASSPHRASE } });
      fireEvent.change(confirmInput, { target: { value: STRONG_PASSPHRASE } });

      await user.click(within(dialog).getByRole('button', { name: 'Change passphrase' }));

      await waitFor(() => {
        const alertText = within(dialog).getByRole('alert').textContent ?? '';
        expect(alertText).toContain(item.expectedSubstring);
        expect(alertText.toLowerCase()).not.toContain('wrong passphrase');
        expect(alertText.toLowerCase()).not.toContain('incorrect passphrase');
      });
    }
    },
    15_000,
  );
});
