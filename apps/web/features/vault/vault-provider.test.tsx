import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from '@/components/app-shell/app-header';
import { ThemeProvider } from '@/components/theme-provider';
import { resolveGuardRedirect } from '@/features/auth/guard-redirect';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import {
  DEVKEY_STORE_NAME,
  LOCK_EPOCH_RECORD_KEY,
  LOCK_EPOCH_STORE_NAME,
  META_STORE_NAME,
  SABK_DEVICE_DB_NAME,
  VAULT_BODY_QUERY_KEY_PREFIX,
  VAULT_BROADCAST_CHANNEL,
  VaultProvider,
  classifyCryptoError,
  deriveVaultStateMachineMode,
  openSabkDeviceDb,
  recordLockEpochEvent,
  resetVaultBroadcastForTests,
  useVault,
  vaultBodyQueryKey,
  verifyUnlockBaseline,
  type LockEpochEnvironment,
  type VaultContextValue,
} from '@/features/vault';
import type { Me } from '@/lib/api/auth';
import { CryptoClientError } from '@/lib/crypto/client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from '@/lib/crypto/kdf';
import type { Sodium } from '@/lib/crypto/sodium';
import { createWorkerShim, type ShimmedWorkerInstance } from '@/lib/crypto/test/worker-shim';
import en from '../../messages/en.json';

/**
 * Fast deterministic KEK derive (`BLAKE2b-256`) for Vitest unit tests so state-machine and race
 * tests run in milliseconds while exercising the real `worker-core` + `attachWorkerCore` + `MessageChannel` shim.
 */
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

// ---------------------------------------------------------------------------
// In-memory BroadcastChannel hub (supports multiple providers / tabs in one test)
// ---------------------------------------------------------------------------
type MessageListener = (event: MessageEvent<unknown>) => void;

class HubBroadcastChannel {
  private static readonly channelsByName = new Map<string, Set<HubBroadcastChannel>>();
  private readonly listeners = new Set<MessageListener>();
  readonly name: string;
  closed = false;
  frozen = false;

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
      if (peer === this || peer.closed || peer.frozen) continue;
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
  }
}

// ---------------------------------------------------------------------------
// In-memory IndexedDB + Web Locks fake (no external fake-indexeddb dependency)
// ---------------------------------------------------------------------------
interface FakeIdbOptions {
  failOpen?: boolean;
  failPutOnStore?: string;
  failGetOnStore?: string;
}

class FakeIDBStorage {
  readonly stores = new Map<string, Map<string, unknown>>();
  options: FakeIdbOptions = {};

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

    const factory = {
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
          if (storage.options.failOpen) {
            req.error = new Error('Simulated IDB open blocked/failed');
            if (typeof req.onerror === 'function') (req.onerror as () => void)();
            return;
          }

          const db = storage.createDatabase();
          req.result = db;
          if (typeof req.onupgradeneeded === 'function') {
            (req.onupgradeneeded as () => void)();
          }
          if (typeof req.onsuccess === 'function') {
            (req.onsuccess as () => void)();
          }
        });

        return req as unknown as IDBOpenDBRequest;
      },
    };

    return factory as unknown as IDBFactory;
  }

  private createDatabase(): IDBDatabase {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const storage = this;

    const objectStoreNames = {
      contains(name: string): boolean {
        return storage.stores.has(name);
      },
    };

    const db = {
      objectStoreNames,
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

        let aborted = false;
        let pendingRequests = 0;
        let finishScheduled = false;

        const tx: Record<string, unknown> = {
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          abort() {
            if (aborted) return;
            aborted = true;
            queueMicrotask(() => {
              if (typeof tx.onabort === 'function') (tx.onabort as () => void)();
            });
          },
          objectStore(name: string): IDBObjectStore {
            const backing = storage.ensureStore(name);

            const scheduleCheckComplete = () => {
              if (finishScheduled || aborted) return;
              if (pendingRequests === 0) {
                finishScheduled = true;
                queueMicrotask(() => {
                  if (!aborted && pendingRequests === 0) {
                    if (typeof tx.oncomplete === 'function') (tx.oncomplete as () => void)();
                  }
                });
              }
            };

            const makeRequest = (runOp: () => { ok: boolean; value?: unknown; err?: Error }) => {
              pendingRequests += 1;
              finishScheduled = false;
              const r: Record<string, unknown> = {
                result: undefined,
                error: null,
                onsuccess: null,
                onerror: null,
              };
              queueMicrotask(() => {
                pendingRequests -= 1;
                if (aborted) return;
                const outcome = runOp();
                if (!outcome.ok) {
                  r.error = outcome.err ?? new Error('IDB request failed');
                  tx.error = r.error;
                  if (typeof r.onerror === 'function') (r.onerror as () => void)();
                  if (!aborted) {
                    aborted = true;
                    queueMicrotask(() => {
                      if (typeof tx.onabort === 'function') (tx.onabort as () => void)();
                    });
                  }
                  return;
                }
                r.result = outcome.value;
                if (typeof r.onsuccess === 'function') (r.onsuccess as () => void)();
                scheduleCheckComplete();
              });
              return r as unknown as IDBRequest;
            };

            const storeObj = {
              get(key: IDBValidKey): IDBRequest {
                return makeRequest(() => {
                  if (storage.options.failGetOnStore === name) {
                    return { ok: false, err: new Error('Simulated get error') };
                  }
                  const val = backing.get(String(key));
                  return {
                    ok: true,
                    value: val !== undefined ? structuredClone(val) : undefined,
                  };
                });
              },
              put(value: unknown, key?: IDBValidKey): IDBRequest {
                return makeRequest(() => {
                  if (storage.options.failPutOnStore === name) {
                    return { ok: false, err: new Error('QuotaExceededError') };
                  }
                  backing.set(String(key), structuredClone(value));
                  return { ok: true, value: key };
                });
              },
              delete(key: IDBValidKey): IDBRequest {
                return makeRequest(() => {
                  backing.delete(String(key));
                  return { ok: true, value: undefined };
                });
              },
            };

            return storeObj as unknown as IDBObjectStore;
          },
        };

        return tx as unknown as IDBTransaction;
      },
    };

    return db as unknown as IDBDatabase;
  }
}

class FakeWebLocks {
  private queue: Promise<unknown> = Promise.resolve();
  failLocks = false;
  readonly acquiredNames: string[] = [];

  createLockManager(): LockManager {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      request(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
        maybeCallback?: LockGrantedCallback<unknown>,
      ): Promise<unknown> {
        const cb =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
        if (self.failLocks) {
          return Promise.reject(new Error('Web Locks blocked'));
        }
        self.acquiredNames.push(name);
        const run = async () => cb({ name, mode: 'exclusive' } as Lock);
        const next = self.queue.then(run, run);
        self.queue = next.catch(() => undefined);
        return next;
      },
      query: async () => ({ held: [], pending: [] }),
    } as unknown as LockManager;
  }
}

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------
function makeMeFixture(overrides: {
  userId?: string;
  email?: string;
  vaultStatus?: 'absent' | 'present';
  autoLockMinutes?: 0 | 5 | 15 | 60;
} = {}): Me {
  return {
    user: {
      id: overrides.userId ?? '11111111-1111-1111-1111-111111111111',
      email: overrides.email ?? 'user-a@example.test',
      email_verified: true,
      created_at: '2026-01-01T00:00:00Z',
    },
    settings: {
      locale: 'en',
      theme: 'system',
      auto_lock_minutes: overrides.autoLockMinutes ?? 15,
      semantic_suggest: false,
    },
    identities: [{ provider: 'password', linked_at: '2026-01-01T00:00:00Z' }],
    features: {
      semantic_available: false,
      email_verification_required: false,
      oauth_providers: [],
      oauth_reauth_providers: [],
      password_enrollment_available: false,
      captcha_site_key: null,
    },
    vault: { status: overrides.vaultStatus ?? 'present' },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Task 15A — VaultProvider, state machine, lock, BroadcastChannel, and lockEpoch marker', () => {
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
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    cleanup();
    for (const shim of activeShims.splice(0)) {
      shim.close();
    }
    resetVaultBroadcastForTests();
    HubBroadcastChannel.reset();
    vi.unstubAllGlobals();
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

  it('derives all plan §2.6 state machine modes from Me.vault.status + authoritative Worker state', () => {
    expect(
      deriveVaultStateMachineMode({
        serverVaultStatus: 'absent',
        workerState: 'locked',
        activeOperation: null,
      }),
    ).toBe('no_vault');

    expect(
      deriveVaultStateMachineMode({
        serverVaultStatus: 'absent',
        workerState: 'locked',
        activeOperation: 'onboarding',
      }),
    ).toBe('onboarding');

    expect(
      deriveVaultStateMachineMode({
        serverVaultStatus: 'present',
        workerState: 'locked',
        activeOperation: null,
      }),
    ).toBe('locked');

    expect(
      deriveVaultStateMachineMode({
        serverVaultStatus: 'present',
        workerState: 'locked',
        activeOperation: 'unlocking',
      }),
    ).toBe('unlocking');

    expect(
      deriveVaultStateMachineMode({
        serverVaultStatus: 'present',
        workerState: 'unlocked',
        activeOperation: null,
      }),
    ).toBe('unlocked');

    expect(
      deriveVaultStateMachineMode({
        serverVaultStatus: 'present',
        workerState: 'unlocked',
        activeOperation: 'rewrapping',
      }),
    ).toBe('rewrapping');

    expect(
      deriveVaultStateMachineMode({
        serverVaultStatus: 'present',
        workerState: 'unlocked',
        activeOperation: 'resetting',
      }),
    ).toBe('resetting');

    expect(
      deriveVaultStateMachineMode({
        serverVaultStatus: 'present',
        workerState: 'recovering',
        activeOperation: 'rewrapping',
      }),
    ).toBe('recovering');

    expect(
      deriveVaultStateMachineMode({
        serverVaultStatus: 'present',
        workerState: 'error',
        activeOperation: 'unlocking',
      }),
    ).toBe('error');

    // Error classification never maps CLIENT_BUSY, KDF_ALLOCATION_FAILED, or PASSPHRASE_INVALID to wrong_passphrase
    expect(classifyCryptoError(new CryptoClientError('CLIENT_BUSY', 'busy'))).toEqual({
      kind: 'busy',
      code: 'CLIENT_BUSY',
      requiresLockFirstToSwitch: false,
    });
    expect(classifyCryptoError(new CryptoClientError('VAULT_RECOVERING', 'recovering'))).toEqual({
      kind: 'recovering_locked_to_whitelist',
      code: 'VAULT_RECOVERING',
      requiresLockFirstToSwitch: true,
    });
    expect(classifyCryptoError(new CryptoClientError('KDF_ALLOCATION_FAILED', 'oom')).kind).toBe(
      'insufficient_memory',
    );
    expect(classifyCryptoError(new CryptoClientError('PASSPHRASE_INVALID', 'bad')).kind).toBe(
      'passphrase_invalid',
    );
    expect(classifyCryptoError(new CryptoClientError('AEAD_DECRYPT_FAILED', 'aead')).kind).toBe(
      'wrong_passphrase',
    );
  });

  it('createssabk.device with lock_epoch, devkeys, and meta stores compatible with Task 18', async () => {
    const db = await openSabkDeviceDb(fakeIdb.createFactory());
    expect(db.objectStoreNames.contains(LOCK_EPOCH_STORE_NAME)).toBe(true);
    expect(db.objectStoreNames.contains(DEVKEY_STORE_NAME)).toBe(true);
    expect(db.objectStoreNames.contains(META_STORE_NAME)).toBe(true);
    db.close();
    expect(fakeIdb.stores.has( SABK_DEVICE_DB_NAME )).toBe(false); // stores are inside fakeIdb.stores
  });

  it('transitions no_vault -> onboarding -> unlocked -> locked -> unlocking -> unlocked and enforces single-flight CLIENT_BUSY + recovering whitelist ("lock() first to switch")', async () => {
    let currentMe = makeMeFixture({ vaultStatus: 'absent' });
    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (u.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (u.endsWith('/auth/me')) return jsonResponse(currentMe);
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    let sessionCtx!: { refetchMe: () => Promise<void> };

    function Probe() {
      vaultCtx = useVault();
      sessionCtx = useSession();
      return (
        <output data-testid="vault-probe">
          {vaultCtx.state}|{vaultCtx.workerState}|{String(vaultCtx.inFlight)}|{vaultCtx.lastErrorCode ?? ''}
        </output>
      );
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={makeLockEpochEnv()}
          >
            <Probe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('vault-probe')).toHaveTextContent('no_vault|locked|false|');
    });

    // Start createVault and concurrently attempt a second state-changing call -> second fails immediately with CLIENT_BUSY
    let releaseFirstPost!: () => void;
    const firstPostGate = new Promise<void>((res) => {
      releaseFirstPost = res;
    });

    const op1 = vaultCtx.beginOp();
    const firstPromise = vaultCtx.createVault({
      passphrase: 'correct-horse-battery-staple',
      opGeneration: op1.opGeneration,
      beforePostMessage: () => firstPostGate,
    });

    await waitFor(() => {
      expect(vaultCtx.state).toBe('onboarding');
      expect(vaultCtx.inFlight).toBe(true);
    });

    await expect(
      vaultCtx.createVault({
        passphrase: 'second-concurrent-passphrase',
        opGeneration: op1.opGeneration,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof CryptoClientError && err.code === 'CLIENT_BUSY';
    });
    await waitFor(() => {
      expect(vaultCtx.lastErrorCode).toBe('CLIENT_BUSY');
    });
    releaseFirstPost();
    const created = await firstPromise;
    expect(created.recovery_keys).toHaveLength(10);

    // Server now has the vault
    currentMe = makeMeFixture({ vaultStatus: 'present' });
    await act(async () => {
      await sessionCtx.refetchMe();
    });

    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
      expect(vaultCtx.workerState).toBe('unlocked');
      expect(vaultCtx.inFlight).toBe(false);
    });

    // Lock -> transitions to locked
    await act(async () => {
      await vaultCtx.lockNow();
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('locked');
      expect(vaultCtx.workerState).toBe('locked');
    });

    // Unlock via recovery key -> enters `recovering` mode
    const rk0 = created.recovery_keys[0]!;
    const opRec = vaultCtx.beginOp();
    const lookupRes = await vaultCtx.unlockRecovery({
      recoveryKey: rk0.display,
      opGeneration: opRec.opGeneration,
    });
    expect(lookupRes.lookup_hash).toBe(rk0.lookup_hash);

    const resumed = await vaultCtx.resumeRecovery({
      wrap: rk0.wrap,
      privateKeysWrapped: created.private_keys_wrapped,
      opGeneration: opRec.opGeneration,
    });
    expect(resumed.recovering).toBe(true);
    await waitFor(() => {
      expect(vaultCtx.state).toBe('recovering');
      expect(vaultCtx.isRecovering).toBe(true);
    });

    // While recovering, even after local rewrap, non-whitelisted calls (e.g. createVault / unlockPassphrase) reject with VAULT_RECOVERING
    const rewrapped = await vaultCtx.rewrap({
      passphrase: 'brand-new-recovery-passphrase-123',
      currentKdf: created.kdf,
      opGeneration: opRec.opGeneration,
    });
    expect(vaultCtx.state).toBe('recovering');

    await expect(
      vaultCtx.unlockPassphrase({
        passphrase: 'brand-new-recovery-passphrase-123',
        kdf: rewrapped.kdf,
        vaultKeyWrappedByKek: rewrapped.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: opRec.opGeneration,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const info = classifyCryptoError(err);
      return info.code === 'VAULT_RECOVERING' && info.requiresLockFirstToSwitch === true;
    });

    // Confirm recovery -> transitions to unlocked
    await act(async () => {
      await vaultCtx.confirmRecovery({ opGeneration: opRec.opGeneration });
    });
    await waitFor(() => {
      expect(vaultCtx.state).toBe('unlocked');
      expect(vaultCtx.isRecovering).toBe(false);
    });
  });

  it('lock while decrypting does not revive the body (cache cleared synchronously, late Worker result dropped by generation)', async () => {
    const me = makeMeFixture({ vaultStatus: 'present' });
    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (u.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (u.endsWith('/auth/me')) return jsonResponse(me);
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    function Probe() {
      vaultCtx = useVault();
      return <output data-testid="state">{vaultCtx.state}</output>;
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={makeLockEpochEnv()}
          >
            <Probe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('locked'));

    // Create vault & seal an entry so we have valid ciphertext
    const opCreate = vaultCtx.beginOp();
    await vaultCtx.createVault({
      passphrase: 'entry-decrypt-race-passphrase',
      opGeneration: opCreate.opGeneration,
    });
    await waitFor(() => expect(vaultCtx.state).toBe('unlocked'));

    const entryId = '22222222-2222-4222-8222-222222222222';
    const keyId = 'vk:7f3a91c4e0b2d8a1f5c309';
    const sealed = await vaultCtx.getClient().sealEntry({
      entryId,
      keyId,
      plaintext: 'top-secret-wifi-password',
      opGeneration: opCreate.opGeneration,
    });

    // Seed decrypted body cache
    qc.setQueryData(vaultBodyQueryKey(entryId), 'cached-plaintext-before-lock');
    expect(qc.getQueryData(vaultBodyQueryKey(entryId))).toBe('cached-plaintext-before-lock');

    // Start a slow openEntry that pauses at beforePostMessage, then lock while it is in flight
    let releaseDecrypt!: () => void;
    const decryptGate = new Promise<void>((res) => {
      releaseDecrypt = res;
    });

    const decryptOp = vaultCtx.beginOp();
    const decryptPromise = vaultCtx
      .getClient()
      .openEntry({
        entryId,
        envelope: sealed.envelope,
        ciphertext: sealed.ciphertext,
        opGeneration: decryptOp.opGeneration,
        beforePostMessage: () => decryptGate,
      })
      .then((res) => {
        if (decryptOp.isCurrent()) {
          qc.setQueryData(vaultBodyQueryKey(entryId), res.plaintext);
        }
        return res;
      });

    // Lock synchronously clears the body cache BEFORE await lock() or decrypt finishes
    void vaultCtx.lockNow();
    expect(qc.getQueryData(vaultBodyQueryKey(entryId))).toBeUndefined();
    expect(vaultCtx.getClient().getState()).toBe('locked');
    await waitFor(() => {
      expect(vaultCtx.state).toBe('locked');
    });
    // Let the in-flight decrypt proceed -> rejected with STALE_GENERATION and never revives the cache
    releaseDecrypt();
    await expect(decryptPromise).rejects.toSatisfy((err: unknown) => {
      return err instanceof CryptoClientError && err.code === 'STALE_GENERATION';
    });
    expect(qc.getQueryData(vaultBodyQueryKey(entryId))).toBeUndefined();
    expect(vaultCtx.state).toBe('locked');
  });

  it('propagates lock from Tab A to Tab B over BroadcastChannel("sabk.vault"), while unlocking Tab A does NOT unlock Tab B', async () => {
    const me = makeMeFixture({ vaultStatus: 'present' });
    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (u.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (u.endsWith('/auth/me')) return jsonResponse(me);
      return jsonResponse({});
    });

    // Use separate BroadcastChannel instances per tab by wiring a per-tab VaultProvider
    let tabA!: VaultContextValue;
    let tabB!: VaultContextValue;

    function TabAProbe() {
      tabA = useVault();
      return <output data-testid="tab-a">{tabA.state}</output>;
    }
    function TabBProbe() {
      tabB = useVault();
      return <output data-testid="tab-b">{tabB.state}</output>;
    }

    const qcA = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const qcB = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <div>
        <QueryClientProvider client={qcA}>
          <SessionProvider>
            <VaultProvider
              createWorker={makeShimmedWorkerFactory()}
              lockEpochEnv={makeLockEpochEnv()}
            >
              <TabAProbe />
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
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('tab-a')).toHaveTextContent('locked');
      expect(screen.getByTestId('tab-b')).toHaveTextContent('locked');
    });

    // Unlock Tab A -> Tab B MUST stay locked ("unlocking tab A does not unlock tab B")
    const opA = tabA.beginOp();
    const created = await tabA.createVault({
      passphrase: 'multi-tab-passphrase-12345',
      opGeneration: opA.opGeneration,
    });
    await waitFor(() => {
      expect(screen.getByTestId('tab-a')).toHaveTextContent('unlocked');
    });
    expect(screen.getByTestId('tab-b')).toHaveTextContent('locked');

    // Now unlock Tab B independently with the same vault wraps
    const opB = tabB.beginOp();
    await tabB.unlockPassphrase({
      passphrase: 'multi-tab-passphrase-12345',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      privateKeysWrapped: created.private_keys_wrapped,
      opGeneration: opB.opGeneration,
    });
    await waitFor(() => {
      expect(screen.getByTestId('tab-b')).toHaveTextContent('unlocked');
    });

    qcB.setQueryData(vaultBodyQueryKey('entry-b'), 'tab-b-decrypted-body');

    // Simulate a remote BroadcastChannel('sabk.vault') lock from Tab A arriving at Tab B
    const remoteSender = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    act(() => {
      remoteSender.postMessage({ type: 'lock', lockEpoch: 5 });
    });
    remoteSender.close();

    await waitFor(() => {
      expect(screen.getByTestId('tab-b')).toHaveTextContent('locked');
      expect(qcB.getQueryData(vaultBodyQueryKey('entry-b'))).toBeUndefined();
    });
  });

  it('locks Tab B when vault_changed arrives with another vault_key_id or when GET /vault returns 404 vault_absent (reset)', async () => {
    const me = makeMeFixture({ vaultStatus: 'present' });
    let serverVaultResponse: 'v1' | 'new_key' | '404' = 'v1';
    const KEY_1 = 'vk:1111111111111111111111';
    const KEY_2 = 'vk:2222222222222222222222';

    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (u.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (u.endsWith('/auth/me')) return jsonResponse(me);
      if (u.endsWith('/vault')) {
        if (serverVaultResponse === '404') {
          return new Response(
            JSON.stringify({
              type: 'https://key.zone17th.click/problems/vault_absent',
              title: 'Vault absent',
              status: 404,
              code: 'vault_absent',
            }),
            { status: 404, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        return jsonResponse({
          vault_key_id: serverVaultResponse === 'v1' ? KEY_1 : KEY_2,
          version: 1,
          kdf: {
            alg: 'argon2id13',
            ops: 3,
            mem: 67108864,
            parallelism: 1,
            salt: 'AAAAAAAAAAAAAAAAAAAAAA',
          },
          vault_key_wrapped_by_kek: 'w',
          x25519_public: 'x',
          ed25519_public: 'e',
          private_keys_wrapped: 'p',
          recovery_keys_remaining: 10,
          passkeys: [],
        });
      }
      return jsonResponse({});
    });

    let tabB!: VaultContextValue;
    function TabBProbe() {
      tabB = useVault();
      return <output data-testid="tab-b">{tabB.state}</output>;
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={makeLockEpochEnv()}
          >
            <TabBProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('tab-b')).toHaveTextContent('locked'));

    // Load initial vault meta (KEY_1) and unlock Tab B
    await act(async () => {
      await tabB.reloadVaultMeta();
    });
    expect(tabB.vaultMeta?.vault_key_id).toBe(KEY_1);

    const op1 = tabB.beginOp();
    const created = await tabB.createVault({
      passphrase: 'reset-propagation-passphrase',
      opGeneration: op1.opGeneration,
    });
    await waitFor(() => expect(screen.getByTestId('tab-b')).toHaveTextContent('unlocked'));

    // Case 1: another tab broadcasts vault_changed with a different vault_key_id (KEY_2)
    serverVaultResponse = 'new_key';
    const remoteSender = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    act(() => {
      remoteSender.postMessage({
        type: 'vault_changed',
        vault_key_id: KEY_2,
        version: 1,
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('tab-b')).toHaveTextContent('locked');
    });

    // Unlock again on KEY_2, then simulate reset (404 vault_absent on reload)
    const op2 = tabB.beginOp();
    await tabB.unlockPassphrase({
      passphrase: 'reset-propagation-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      privateKeysWrapped: created.private_keys_wrapped,
      opGeneration: op2.opGeneration,
    });
    await waitFor(() => expect(screen.getByTestId('tab-b')).toHaveTextContent('unlocked'));

    serverVaultResponse = '404';
    act(() => {
      remoteSender.postMessage({
        type: 'vault_changed',
        vault_key_id: KEY_2,
        version: 2,
      });
    });
    remoteSender.close();

    await waitFor(() => {
      expect(screen.getByTestId('tab-b')).toHaveTextContent('locked');
      expect(tabB.vaultMeta).toBeNull();
    });
  });

  it('fails closed on wake/resume when frozen tab missed a manual lock elsewhere (marker != unlockBaseline), when marker is missing/unreadable, and deletes marker on writer failure', async () => {
    const me = makeMeFixture({ vaultStatus: 'present' });
    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (u.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (u.endsWith('/auth/me')) return jsonResponse(me);
      return jsonResponse({});
    });

    let tabC!: VaultContextValue;
    function TabCProbe() {
      tabC = useVault();
      return <output data-testid="tab-c">{tabC.state}</output>;
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={makeLockEpochEnv()}
          >
            <TabCProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('tab-c')).toHaveTextContent('locked'));

    // 1. Tab C unlocks and captures unlockBaseline (E_1, 1)
    const op1 = tabC.beginOp();
    const created = await tabC.createVault({
      passphrase: 'frozen-tab-wake-passphrase',
      opGeneration: op1.opGeneration,
    });
    await waitFor(() => expect(screen.getByTestId('tab-c')).toHaveTextContent('unlocked'));
    expect(tabC.unlockBaseline?.lockEpoch).toBe(1);

    // 2. While Tab C is frozen (misses BroadcastChannel), another tab writes a manual lock -> lockEpoch becomes 2
    const writerRes = await recordLockEpochEvent(1, makeLockEpochEnv());
    expect(writerRes.ok).toBe(true);
    expect(writerRes.lockEpoch).toBe(2);

    // Tab C wakes up (visibilitychange / focus / resume) -> reads marker (2 != baseline 1) and locks immediately
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('tab-c')).toHaveTextContent('locked');
    });

    // 3. Re-unlock Tab C -> captures baseline at lockEpoch 2. Then simulate writer failure in another tab:
    //    Primary put fails with QuotaExceededError -> fallback tx deletes marker in the same Web Lock region.
    const op2 = tabC.beginOp();
    await tabC.unlockPassphrase({
      passphrase: 'frozen-tab-wake-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      privateKeysWrapped: created.private_keys_wrapped,
      opGeneration: op2.opGeneration,
    });
    await waitFor(() => expect(screen.getByTestId('tab-c')).toHaveTextContent('unlocked'));
    expect(tabC.unlockBaseline?.lockEpoch).toBe(2);

    fakeIdb.options.failPutOnStore = LOCK_EPOCH_STORE_NAME;
    const failedWriteRes = await recordLockEpochEvent(2, makeLockEpochEnv());
    expect(failedWriteRes.ok).toBe(false);
    expect(failedWriteRes.markerDeletedOnFailure).toBe(true);
    expect(
      fakeIdb.ensureStore(LOCK_EPOCH_STORE_NAME).get(LOCK_EPOCH_RECORD_KEY),
    ).toBeUndefined();
    fakeIdb.options.failPutOnStore = undefined;

    // Tab C resumes -> marker is missing -> fails closed (locked)
    act(() => {
      window.dispatchEvent(new Event('resume'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('tab-c')).toHaveTextContent('locked');
    });

    // 4. Re-unlock Tab C -> initializes fresh marker with new epochIncarnation. Then block IDB/locks on wake -> fails closed
    const op3 = tabC.beginOp();
    await tabC.unlockPassphrase({
      passphrase: 'frozen-tab-wake-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      privateKeysWrapped: created.private_keys_wrapped,
      opGeneration: op3.opGeneration,
    });
    await waitFor(() => expect(screen.getByTestId('tab-c')).toHaveTextContent('unlocked'));

    fakeLocks.failLocks = true;
    const unreadableCheck = await verifyUnlockBaseline(
      tabC.unlockBaseline,
      makeLockEpochEnv(),
    );
    expect(unreadableCheck.matches).toBe(false);

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('tab-c')).toHaveTextContent('locked');
    });
    fakeLocks.failLocks = false;
  });

  it('logout then login as another user clears VK/plaintext and shows no old user data while keeping DevKey store untouched', async () => {
    const userA = makeMeFixture({
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: 'alice@example.test',
      vaultStatus: 'present',
    });
    const userB = makeMeFixture({
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      email: 'bob@example.test',
      vaultStatus: 'present',
    });
    let activeMe: Me | null = userA;

    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (u.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (u.endsWith('/auth/me')) {
        if (!activeMe) {
          return new Response(
            JSON.stringify({
              type: 'https://key.zone17th.click/problems/unauthenticated',
              title: 'Unauthenticated',
              status: 401,
              code: 'unauthenticated',
            }),
            { status: 401, headers: { 'content-type': 'application/problem+json' } },
          );
        }
        return jsonResponse(activeMe);
      }
      if (u.endsWith('/auth/logout')) return new Response(null, { status: 204 });
      if (u.endsWith('/auth/login')) return jsonResponse(userB);
      return jsonResponse({});
    });

    // Seed a simulated DevKey record in sabk.device to verify logout NEVER deletes DevKey records
    fakeIdb.ensureStore(DEVKEY_STORE_NAME).set('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:vk:1111', {
      user_id: userA.user.id,
      vault_key_id: 'vk:1111',
    });

    let vaultCtx!: VaultContextValue;
    let sessionCtx!: {
      me: Me | null;
      signOut: () => Promise<void>;
      login: (body: { email: string; password: string }) => Promise<Me>;
    };

    function Probe() {
      vaultCtx = useVault();
      sessionCtx = useSession();
      const cachedBody = useQuery({
        queryKey: vaultBodyQueryKey('alice-secret-entry'),
        queryFn: () => 'alice-decrypted-plaintext',
        enabled: false,
      });
      return (
        <div>
          <output data-testid="user-email">{sessionCtx.me?.user.email ?? 'none'}</output>
          <output data-testid="vault-state">{vaultCtx.state}</output>
          <output data-testid="cached-body">{cachedBody.data ?? 'empty'}</output>
        </div>
      );
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={makeLockEpochEnv()}
          >
            <Probe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('user-email')).toHaveTextContent('alice@example.test');
    });

    // Unlock Alice's vault and populate Alice's decrypted body cache
    const opAlice = vaultCtx.beginOp();
    await vaultCtx.createVault({
      passphrase: 'alice-passphrase-12345',
      opGeneration: opAlice.opGeneration,
    });
    act(() => {
      qc.setQueryData(vaultBodyQueryKey('alice-secret-entry'), 'alice-decrypted-plaintext');
    });
    await waitFor(() => {
      expect(screen.getByTestId('vault-state')).toHaveTextContent('unlocked');
      expect(screen.getByTestId('cached-body')).toHaveTextContent('alice-decrypted-plaintext');
    });

    // Logout Alice -> VK and decrypted body cache are cleared, DevKey record in sabk.device is untouched
    activeMe = null;
    await act(async () => {
      await sessionCtx.signOut();
    });

    await waitFor(() => {
      expect(screen.getByTestId('user-email')).toHaveTextContent('none');
      expect(screen.getByTestId('vault-state')).toHaveTextContent('no_vault');
      expect(screen.getByTestId('cached-body')).toHaveTextContent('empty');
    });
    expect(qc.getQueryData(vaultBodyQueryKey('alice-secret-entry'))).toBeUndefined();
    expect(
      fakeIdb.ensureStore(DEVKEY_STORE_NAME).has('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:vk:1111'),
    ).toBe(true);

    // Login as Bob -> vault is locked and Alice's cached data is completely gone
    activeMe = userB;
    await act(async () => {
      await sessionCtx.login({ email: 'bob@example.test', password: 'bob-login-password' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('user-email')).toHaveTextContent('bob@example.test');
      expect(screen.getByTestId('vault-state')).toHaveTextContent('locked');
      expect(screen.getByTestId('cached-body')).toHaveTextContent('empty');
    });
  });

  it('history Back (popstate / pageshow) after lock shows no plaintext, and L shortcut locks outside inputs but is ignored inside inputs/textareas/contenteditable', async () => {
    const me = makeMeFixture({ vaultStatus: 'present' });
    vi.mocked(fetch).mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/auth/csrf')) return new Response(null, { status: 204 });
      if (u.endsWith('/auth/config')) {
        return jsonResponse({
          oauth_providers: [],
          email_verification_required: false,
          captcha_site_key: null,
        });
      }
      if (u.endsWith('/auth/me')) return jsonResponse(me);
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;

    function ItemViewWithSecretForm() {
      vaultCtx = useVault();
      const [secretDraft, setSecretDraft] = useState('my-typed-secret-note');
      const bodyQuery = useQuery({
        queryKey: vaultBodyQueryKey('item-1'),
        queryFn: () => 'plaintext-entry-content-123',
        enabled: false,
      });

      // Register form reset on lock
      useState(() =>
        vaultCtx.registerSecretFormReset(() => {
          setSecretDraft('');
        }),
      );

      return (
        <div>
          <AppHeader showLogout />
          <output data-testid="vault-mode">{vaultCtx.state}</output>
          <div data-testid="entry-view">
            {vaultCtx.state === 'unlocked' && bodyQuery.data ? bodyQuery.data : '🔒 ••••••'}
          </div>
          <input
            aria-label="Search or note input"
            data-testid="text-input"
            value={secretDraft}
            onChange={(e) => setSecretDraft(e.target.value)}
          />
          <textarea aria-label="Note textarea" data-testid="textarea-input" />
          <div
            data-testid="editable-div"
            contentEditable="true"
            suppressContentEditableWarning
          >
            editable
          </div>
        </div>
      );
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ThemeProvider>
          <QueryClientProvider client={qc}>
            <SessionProvider>
              <VaultProvider
                createWorker={makeShimmedWorkerFactory()}
                lockEpochEnv={makeLockEpochEnv()}
              >
                <ItemViewWithSecretForm />
              </VaultProvider>
            </SessionProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </NextIntlClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('vault-mode')).toHaveTextContent('locked'));

    // Unlock and populate decrypted entry body in cache
    const op = vaultCtx.beginOp();
    await vaultCtx.createVault({
      passphrase: 'shortcut-and-history-passphrase',
      opGeneration: op.opGeneration,
    });
    act(() => {
      qc.setQueryData(vaultBodyQueryKey('item-1'), 'plaintext-entry-content-123');
    });

    await waitFor(() => {
      expect(screen.getByTestId('vault-mode')).toHaveTextContent('unlocked');
      expect(screen.getByTestId('entry-view')).toHaveTextContent('plaintext-entry-content-123');
    });

    // Pressing `L` inside input, textarea, or contenteditable MUST be ignored
    const textInput = screen.getByTestId('text-input');
    textInput.focus();
    fireEvent.keyDown(textInput, { key: 'l' });
    fireEvent.keyDown(textInput, { key: 'L' });
    expect(screen.getByTestId('vault-mode')).toHaveTextContent('unlocked');

    const textarea = screen.getByTestId('textarea-input');
    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'L' });
    expect(screen.getByTestId('vault-mode')).toHaveTextContent('unlocked');

    const editableDiv = screen.getByTestId('editable-div');
    fireEvent.keyDown(editableDiv, { key: 'L' });
    expect(screen.getByTestId('vault-mode')).toHaveTextContent('unlocked');

    // Pressing `L` with a modifier (Ctrl+L) MUST be ignored
    textarea.blur();
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true });
    expect(screen.getByTestId('vault-mode')).toHaveTextContent('unlocked');

    // Pressing bare `L` outside inputs locks immediately, clears body cache, and resets secret form state
    fireEvent.keyDown(window, { key: 'L' });
    await waitFor(() => {
      expect(screen.getByTestId('vault-mode')).toHaveTextContent('locked');
      expect(screen.getByTestId('entry-view')).toHaveTextContent('🔒 ••••••');
      expect(screen.getByTestId('entry-view')).not.toHaveTextContent('plaintext-entry-content-123');
    });
    expect((textInput as HTMLInputElement).value).toBe('');
    expect(qc.getQueryData(vaultBodyQueryKey('item-1'))).toBeUndefined();

    // Re-unlock and verify clicking the header lock button locks immediately and clears the body cache
    const op2 = vaultCtx.beginOp();
    await vaultCtx.createVault({
      passphrase: 'shortcut-and-history-passphrase-2',
      opGeneration: op2.opGeneration,
    });
    act(() => {
      qc.setQueryData(vaultBodyQueryKey('item-1'), 'plaintext-entry-content-123');
    });
    await waitFor(() => {
      expect(screen.getByTestId('vault-mode')).toHaveTextContent('unlocked');
      expect(screen.getByTestId('entry-view')).toHaveTextContent('plaintext-entry-content-123');
    });
    fireEvent.click(screen.getByTestId('vault-lock-button'));
    await waitFor(() => {
      expect(screen.getByTestId('vault-mode')).toHaveTextContent('locked');
      expect(screen.getByTestId('entry-view')).toHaveTextContent('🔒 ••••••');
    });
    expect(qc.getQueryData(vaultBodyQueryKey('item-1'))).toBeUndefined();

    // Simulate History Back (popstate + pageshow persisted) after lock -> must NOT show plaintext
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(screen.getByTestId('vault-mode')).toHaveTextContent('locked');
    expect(screen.getByTestId('entry-view')).toHaveTextContent('🔒 ••••••');
    expect(screen.getByTestId('entry-view')).not.toHaveTextContent('plaintext-entry-content-123');
    expect(qc.getQueryData(vaultBodyQueryKey(VAULT_BODY_QUERY_KEY_PREFIX[0]))).toBeUndefined();
  });

  it('redirects present + locked vault to /app/unlock with returnTo preserved, while allowing unlock, forgot, recovery, and settings', () => {
    const me = makeMeFixture({ vaultStatus: 'present' });
    expect(
      resolveGuardRedirect({
        status: 'authenticated_with_vault',
        pathname: '/app',
        me,
        vaultState: 'locked',
      }),
    ).toBe('/app/unlock');
    expect(
      resolveGuardRedirect({
        status: 'authenticated_with_vault',
        pathname: '/app/items/item-42',
        me,
        vaultState: 'locked',
      }),
    ).toBe('/app/unlock?returnTo=%2Fapp%2Fitems%2Fitem-42');
    expect(
      resolveGuardRedirect({
        status: 'authenticated_with_vault',
        pathname: '/app/unlock',
        me,
        vaultState: 'locked',
      }),
    ).toBeNull();
    expect(
      resolveGuardRedirect({
        status: 'authenticated_with_vault',
        pathname: '/app/unlock/forgot',
        me,
        vaultState: 'locked',
      }),
    ).toBeNull();
    expect(
      resolveGuardRedirect({
        status: 'authenticated_with_vault',
        pathname: '/app/recovery',
        me,
        vaultState: 'recovering',
      }),
    ).toBeNull();
    expect(
      resolveGuardRedirect({
        status: 'authenticated_with_vault',
        pathname: '/app/settings',
        me,
        vaultState: 'locked',
      }),
    ).toBeNull();
    expect(
      resolveGuardRedirect({
        status: 'authenticated_with_vault',
        pathname: '/app',
        me,
        vaultState: 'unlocked',
      }),
    ).toBeNull();
    expect(
      resolveGuardRedirect({
        status: 'authenticated_with_vault',
        pathname: '/app/unlock',
        me,
        vaultState: 'unlocked',
      }),
    ).toBe('/app');
  });
});
