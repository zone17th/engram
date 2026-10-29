import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from '@/components/app-shell/app-header';
import { ThemeProvider } from '@/components/theme-provider';
import { resolveGuardRedirect } from '@/features/auth/guard-redirect';
import { SessionProvider, useSession } from '@/features/auth/session-provider';
import {
  DEVICE_META_RECORD_KEY,
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
  formatDevKeyRecordKey,
  openSabkDeviceDb,
  purgeDeviceKeysOnRevoked,
  readDeviceMetaRecord,
  recordLockEpochEvent,
  resetVaultBroadcastForTests,
  setDefaultDeviceStoreEnvironmentForTests,
  setKnownDeviceSessionUserId,
  subscribeDevicePurge,
  useVault,
  vaultBodyQueryKey,
  verifyUnlockBaseline,
  type LockEpochEnvironment,
  type VaultContextValue,
} from '@/features/vault';
import { authFetch } from '@/lib/api/auth-fetch';
import type { Me } from '@/lib/api/auth';
import { CryptoClientError, type CreateVaultResult } from '@/lib/crypto/client';
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
  abortBeforeCompleteOnStore?: string;
}
class FakeIDBStorage {
  readonly stores = new Map<string, Map<string, unknown>>();
  options: FakeIdbOptions = {};
  readonly transactions: Array<{ storeNames: string[]; mode: string }> = [];
  deleteDatabaseCalls = 0;
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
      deleteDatabase(): IDBOpenDBRequest {
        storage.deleteDatabaseCalls += 1;
        throw new Error('indexedDB.deleteDatabase must NEVER be called');
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
      transaction(storeNames: string | string[], mode: IDBTransactionMode = 'readonly'): IDBTransaction {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        storage.transactions.push({ storeNames: names, mode });
        const snapshots = new Map<string, Map<string, unknown>>();
        for (const n of names) {
          const existing = storage.ensureStore(n);
          if (mode === 'readwrite') {
            const copy = new Map<string, unknown>();
            for (const [k, v] of existing.entries()) {
              copy.set(k, structuredClone(v));
            }
            snapshots.set(n, copy);
          }
        }
        let aborted = false;
        let pendingRequests = 0;
        let finishScheduled = false;
        let shouldAbortBeforeComplete = false;

        const rollbackSnapshots = () => {
          if (mode !== 'readwrite') return;
          for (const [storeName, snap] of snapshots.entries()) {
            const backing = storage.ensureStore(storeName);
            backing.clear();
            for (const [k, v] of snap.entries()) {
              backing.set(k, structuredClone(v));
            }
          }
        };

        const tx: Record<string, unknown> = {
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          abort() {
            if (aborted) return;
            aborted = true;
            rollbackSnapshots();
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
                    if (shouldAbortBeforeComplete) {
                      aborted = true;
                      tx.error = new Error('Simulated transaction abort before commit');
                      rollbackSnapshots();
                      if (typeof tx.onabort === 'function') (tx.onabort as () => void)();
                      return;
                    }
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
                  if (!aborted) {
                    aborted = true;
                    rollbackSnapshots();
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
                  if (storage.options.abortBeforeCompleteOnStore === name) {
                    shouldAbortBeforeComplete = true;
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
              getAllKeys(): IDBRequest {
                return makeRequest(() => {
                  return { ok: true, value: Array.from(backing.keys()) };
                });
              },
              clear(): IDBRequest {
                return makeRequest(() => {
                  backing.clear();
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
    setDefaultDeviceStoreEnvironmentForTests({ idbFactory: fakeIdb.createFactory() });
    setKnownDeviceSessionUserId(null);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(async () => {
    cleanup();
    for (const shim of activeShims.splice(0)) {
      shim.close();
    }
    resetVaultBroadcastForTests();
    HubBroadcastChannel.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await Promise.resolve();
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

  // -------------------------------------------------------------------------
  // Task 15B — Shared multi-tab auto-lock, wake/resume Me deadline, clock skew,
  // settings_changed, logout keeps DevKey, and revoked single-tx purge
  // -------------------------------------------------------------------------
  it('auto-locks after auto_lock_minutes * 60_000 ms using a fake clock', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z');
    // Pin Date to t0 BEFORE mount so the provider's lastActivityAt starts at t0 (no clock-rollback lock).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const me = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 5 });
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
      return (
        <div>
          <output data-testid="state">{vaultCtx.state}</output>
          <output data-testid="minutes-left">{String(vaultCtx.minutesLeft ?? 'none')}</output>
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

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('locked'));

    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(t0);

    const op = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.createVault({
        passphrase: 'fake-clock-timer-passphrase-123',
        opGeneration: op.opGeneration,
      });
    });
    expect(screen.getByTestId('state')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('minutes-left')).toHaveTextContent('5');
    qc.setQueryData(vaultBodyQueryKey('item-timer'), 'secret-body-timer');

    // Advance 4 minutes and 59 seconds -> still unlocked
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 59_000);
    });
    expect(screen.getByTestId('state')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('minutes-left')).toHaveTextContent('1');

    // Advance past the 5-minute mark -> locks immediately and wipes decrypted body cache
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(screen.getByTestId('state')).toHaveTextContent('locked');
    expect(qc.getQueryData(vaultBodyQueryKey('item-timer'))).toBeUndefined();
  });

  it('auto_lock_minutes=0 ("Never") never locks, including across tab switches and hours of idle time', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z');
    // Pin Date to t0 BEFORE mount so the provider's lastActivityAt starts at t0 (no clock-rollback lock).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const me = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 0 });
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
      return (
        <div>
          <output data-testid="state">{vaultCtx.state}</output>
          <output data-testid="minutes-left">{String(vaultCtx.minutesLeft ?? 'none')}</output>
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

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('locked'));

    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(t0);

    const op = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.createVault({
        passphrase: 'never-auto-lock-passphrase-123',
        opGeneration: op.opGeneration,
      });
    });
    expect(screen.getByTestId('state')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('minutes-left')).toHaveTextContent('none');

    // Advance 24 hours with zero activity
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    });
    expect(screen.getByTestId('state')).toHaveTextContent('unlocked');

    // Switch tab visibility and focus -> refreshes Me (which still returns auto_lock_minutes: 0) and stays unlocked
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByTestId('state')).toHaveTextContent('unlocked');
  });

  it('idle background tab does not lock while another tab broadcasts user activity', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z');
    // Pin Date to t0 BEFORE mount so the provider's lastActivityAt starts at t0 (no clock-rollback lock).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const me = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 5 });
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

    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(t0);

    const opA = tabA.beginOp();
    let created!: CreateVaultResult;
    await act(async () => {
      created = await tabA.createVault({
        passphrase: 'shared-activity-passphrase-123',
        opGeneration: opA.opGeneration,
      });
    });

    const opB = tabB.beginOp();
    await act(async () => {
      await tabB.unlockPassphrase({
        passphrase: 'shared-activity-passphrase-123',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: opB.opGeneration,
      });
    });
    expect(screen.getByTestId('tab-a')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('tab-b')).toHaveTextContent('unlocked');

    // Advance 3 minutes (Tab B is completely idle in background)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });

    // BE1-14: Trigger ONLY Tab A's production `recordActivity` sender (without injecting any manual remotePeer.postMessage)
    // and verify Tab B receives the broadcast through the shared BroadcastChannel / subscriber hub and extends its deadline!
    act(() => {
      tabA.recordActivity(Date.now());
    });

    // Advance another 3 minutes (total 6 minutes since Tab B's own unlock, but only 3 minutes since Tab A's activity)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    // Neither tab should have locked because max(lastActivity across tabs) + 5m is at t = +8m
    expect(screen.getByTestId('tab-a')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('tab-b')).toHaveTextContent('unlocked');

    // Advance the remaining 2 minutes + 1s with no activity in any tab -> both lock
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000 + 1_000);
    });
    expect(screen.getByTestId('tab-a')).toHaveTextContent('locked');
    expect(screen.getByTestId('tab-b')).toHaveTextContent('locked');
  });

  it('locks immediately on wake when device slept past the deadline (without trusting throttled timers), when clock moves back > 1 minute, or when wake Me refresh fails/times out (5s deadline)', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z').getTime();
    // Pin Date to t0 BEFORE mount so the provider's lastActivityAt starts at t0 (no clock-rollback lock).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

    let meResponseMode: 'ok' | 'hang' | '401' = 'ok';
    const me = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 15 });
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
        if (meResponseMode === 'hang') {
          return new Promise<Response>(() => {
            // Never resolves -> triggers 5s wake deadline
          });
        }
        if (meResponseMode === '401') {
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
        return jsonResponse(me);
      }
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

    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(t0);

    // 1. Sleep past the 15-minute deadline without firing intermediate setTimeout callbacks
    const op1 = vaultCtx.beginOp();
    let created!: CreateVaultResult;
    await act(async () => {
      created = await vaultCtx.createVault({
        passphrase: 'sleep-and-clock-skew-passphrase',
        opGeneration: op1.opGeneration,
      });
    });
    expect(screen.getByTestId('state')).toHaveTextContent('unlocked');

    // Jump wall clock forward by 20 minutes (simulating OS sleep where timers were suspended)
    vi.setSystemTime(t0 + 20 * 60_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId('state')).toHaveTextContent('locked');

    // 2. Clock going back by > 1 minute -> locks immediately
    const t1 = t0 + 30 * 60_000;
    vi.setSystemTime(t1);
    const op2 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.unlockPassphrase({
        passphrase: 'sleep-and-clock-skew-passphrase',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: op2.opGeneration,
      });
    });
    expect(screen.getByTestId('state')).toHaveTextContent('unlocked');

    // Move system clock back by 2 minutes (> 60_000 ms tolerance) and trigger wake/focus
    vi.setSystemTime(t1 - 2 * 60_000);
    await act(async () => {
      window.dispatchEvent(new Event('resume'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId('state')).toHaveTextContent('locked');

    // 3. Wake GET /auth/me hangs past the 5s ADR 0003 deadline -> locks fail-closed
    const t2 = t0 + 60 * 60_000;
    vi.setSystemTime(t2);
    const op3 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.unlockPassphrase({
        passphrase: 'sleep-and-clock-skew-passphrase',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: op3.opGeneration,
      });
    });
    expect(screen.getByTestId('state')).toHaveTextContent('unlocked');

    meResponseMode = 'hang';
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(screen.getByTestId('state')).toHaveTextContent('locked');
    meResponseMode = 'ok';
  });

  it('changing auto_lock_minutes in Tab A broadcasts settings_changed and applies immediately in Tab B', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z').getTime();
    // Pin Date to t0 BEFORE mount so the provider's lastActivityAt starts at t0 (no clock-rollback lock).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

    let currentAutoLock: 0 | 5 | 15 | 60 = 60;
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
        return jsonResponse(
          makeMeFixture({ vaultStatus: 'present', autoLockMinutes: currentAutoLock }),
        );
      }
      return jsonResponse({});
    });

    let tabB!: VaultContextValue;
    function TabBProbe() {
      tabB = useVault();
      return (
        <div>
          <output data-testid="tab-b-state">{tabB.state}</output>
          <output data-testid="tab-b-minutes">{tabB.autoLockMinutes}</output>
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
            <TabBProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('tab-b-state')).toHaveTextContent('locked');
      expect(screen.getByTestId('tab-b-minutes')).toHaveTextContent('60');
    });

    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(t0);

    const op = tabB.beginOp();
    await act(async () => {
      await tabB.createVault({
        passphrase: 'settings-changed-passphrase-123',
        opGeneration: op.opGeneration,
      });
    });
    expect(screen.getByTestId('tab-b-state')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('tab-b-minutes')).toHaveTextContent('60');

    // Advance 6 minutes -> still unlocked under 60-minute timeout
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60_000);
    });
    expect(screen.getByTestId('tab-b-state')).toHaveTextContent('unlocked');

    // Tab A lowers auto_lock_minutes to 5 minutes and broadcasts settings_changed on 'sabk.vault'
    currentAutoLock = 5;
    const remoteTabA = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      remoteTabA.postMessage({ type: 'settings_changed', auto_lock_minutes: 5 });
      await vi.advanceTimersByTimeAsync(50);
    });
    remoteTabA.close();

    // Because 6 minutes have already elapsed since lastActivity, Tab B locks immediately upon applying 5m
    expect(screen.getByTestId('tab-b-minutes')).toHaveTextContent('5');
    expect(screen.getByTestId('tab-b-state')).toHaveTextContent('locked');
  });

  it('401 session_invalid with reason=revoked purges DevKey records in ONE readwrite transaction (never deleteDatabase) and rotates incarnation + bumps deviceRevision', async () => {
    const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    // Seed initial DevKey records for User A and User B plus initial origin-wide meta (deviceRevision = 3)
    const devkeysMap = fakeIdb.ensureStore(DEVKEY_STORE_NAME);
    devkeysMap.set(formatDevKeyRecordKey(USER_A, 'vk:a1'), {
      user_id: USER_A,
      vault_key_id: 'vk:a1',
      wrapped_vk: new Uint8Array([1, 2, 3]),
    });
    devkeysMap.set(formatDevKeyRecordKey(USER_B, 'vk:b1'), {
      user_id: USER_B,
      vault_key_id: 'vk:b1',
      wrapped_vk: new Uint8Array([4, 5, 6]),
    });
    const metaMap = fakeIdb.ensureStore(META_STORE_NAME);
    metaMap.set(DEVICE_META_RECORD_KEY, {
      incarnation: '00112233445566778899aabbccddeeff',
      deviceRevision: 3,
    });

    // Case 1: Known user (User A) receives 401 session_invalid with reason="revoked"
    setKnownDeviceSessionUserId(USER_A);
    fakeIdb.transactions.length = 0;

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'https://key.zone17th.click/problems/session_invalid',
          title: 'Session invalid',
          status: 401,
          code: 'session_invalid',
          reason: 'revoked',
        }),
        { status: 401, headers: { 'content-type': 'application/problem+json' } },
      ),
    );

    await expect(authFetch('/vault', { requireSession: true })).rejects.toThrow();

    await waitFor(() => {
      expect(devkeysMap.has(formatDevKeyRecordKey(USER_A, 'vk:a1'))).toBe(false);
    });
    // User B's DevKey record is preserved when User A is known
    expect(devkeysMap.has(formatDevKeyRecordKey(USER_B, 'vk:b1'))).toBe(true);
    // Exactly ONE readwrite transaction on ['devkeys', 'meta'] was used, and deleteDatabase was NEVER called
    const readwriteTxs1 = fakeIdb.transactions.filter((t) => t.mode === 'readwrite');
    expect(readwriteTxs1).toHaveLength(1);
    expect(readwriteTxs1[0]?.storeNames).toEqual([DEVKEY_STORE_NAME, META_STORE_NAME]);
    expect(fakeIdb.deleteDatabaseCalls).toBe(0);

    const metaAfter1 = await readDeviceMetaRecord({ idbFactory: fakeIdb.createFactory() });
    expect(metaAfter1).not.toBeNull();
    expect(metaAfter1?.deviceRevision).toBe(4);
    expect(metaAfter1?.incarnation).not.toBe('00112233445566778899aabbccddeeff');
    expect(metaAfter1?.incarnation).toMatch(/^[0-9a-f]{32}$/);

    // Case 2: Unknown user (e.g. just reloaded before Me resolved) -> purges ALL users' DevKey records in ONE readwrite tx
    devkeysMap.set(formatDevKeyRecordKey(USER_A, 'vk:a2'), {
      user_id: USER_A,
      vault_key_id: 'vk:a2',
      wrapped_vk: new Uint8Array([7, 8, 9]),
    });
    setKnownDeviceSessionUserId(null);
    fakeIdb.transactions.length = 0;

    const purgeUnknownResult = await purgeDeviceKeysOnRevoked(null, {
      idbFactory: fakeIdb.createFactory(),
    });
    expect(purgeUnknownResult.ok).toBe(true);
    expect(devkeysMap.size).toBe(0);

    const readwriteTxs2 = fakeIdb.transactions.filter((t) => t.mode === 'readwrite');
    expect(readwriteTxs2).toHaveLength(1);
    expect(readwriteTxs2[0]?.storeNames).toEqual([DEVKEY_STORE_NAME, META_STORE_NAME]);
    expect(fakeIdb.deleteDatabaseCalls).toBe(0);

    const metaAfter2 = await readDeviceMetaRecord({ idbFactory: fakeIdb.createFactory() });
    expect(metaAfter2?.deviceRevision).toBe(5);
    expect(metaAfter2?.incarnation).not.toBe(metaAfter1?.incarnation);

    // Case 3 (BE1-18): DevKey delete and meta put requests succeed, then the encompassing readwrite transaction aborts before commit ->
    // must return ok:false, emit no purge success notification, and roll back both DevKey and metadata stores!
    devkeysMap.set(formatDevKeyRecordKey(USER_A, 'vk:a3'), {
      user_id: USER_A,
      vault_key_id: 'vk:a3',
      wrapped_vk: new Uint8Array([10, 11, 12]),
    });
    const notifications: unknown[] = [];
    const unsubscribePurge = subscribeDevicePurge((res) => notifications.push(res));
    fakeIdb.options.abortBeforeCompleteOnStore = META_STORE_NAME;

    const abortPurgeResult = await purgeDeviceKeysOnRevoked(USER_A, {
      idbFactory: fakeIdb.createFactory(),
    });
    fakeIdb.options.abortBeforeCompleteOnStore = undefined;
    unsubscribePurge();

    expect(abortPurgeResult.ok).toBe(false);
    expect(notifications).toHaveLength(0);
    expect(devkeysMap.has(formatDevKeyRecordKey(USER_A, 'vk:a3'))).toBe(true);
    const metaAfterAbort = await readDeviceMetaRecord({ idbFactory: fakeIdb.createFactory() });
    expect(metaAfterAbort?.deviceRevision).toBe(5);
    expect(metaAfterAbort?.incarnation).toBe(metaAfter2?.incarnation);
  });
  // BE7-2 (device-store): `skipIfNoDevKeys` decides INSIDE the one readwrite purge transaction. Real IndexedDB serialises
  // readwrite transactions with overlapping scope in creation order, so a DevKey write committed before the purge
  // transaction is seen by its listing (and deleted), and one created after it commits after the skip. The fake does not
  // queue transactions, so the "before" case is modelled by a write that lands before the purge transaction starts.
  describe('purgeDeviceKeysOnRevoked skipIfNoDevKeys', () => {
    const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const devkey = (userId: string, vaultKeyId: string) => ({
      user_id: userId,
      vault_key_id: vaultKeyId,
      wrapped_vk: new Uint8Array([1, 2, 3]),
    });
    function seedStore() {
      const devkeys = fakeIdb.ensureStore(DEVKEY_STORE_NAME);
      fakeIdb.ensureStore(META_STORE_NAME).set(DEVICE_META_RECORD_KEY, {
        incarnation: '00112233445566778899aabbccddeeff',
        deviceRevision: 3,
      });
      return devkeys;
    }
    const env = () => ({ idbFactory: fakeIdb.createFactory() });

    it('without the option the purge is unconditional: it rotates the meta even with no DevKey', async () => {
      seedStore();
      const res = await purgeDeviceKeysOnRevoked(USER_A, env());
      expect(res.ok).toBe(true);
      expect(res.skipped).toBeUndefined();
      expect(res.meta?.deviceRevision).toBe(4);
      expect((await readDeviceMetaRecord(env()))?.deviceRevision).toBe(4);
    });

    it('known user with no DevKey (other users keep theirs): commits nothing, returns skipped with the unchanged meta and does not notify', async () => {
      const devkeys = seedStore();
      devkeys.set(formatDevKeyRecordKey(USER_B, 'vk:b'), devkey(USER_B, 'vk:b'));
      const notifications: unknown[] = [];
      const unsubscribe = subscribeDevicePurge((r) => notifications.push(r));
      fakeIdb.transactions.length = 0;
      const res = await purgeDeviceKeysOnRevoked(USER_A, env(), { skipIfNoDevKeys: true });
      unsubscribe();
      expect(res).toEqual({
        ok: true,
        meta: { incarnation: '00112233445566778899aabbccddeeff', deviceRevision: 3 },
        deletedCount: 0,
        skipped: true,
      });
      expect(notifications).toHaveLength(0);
      expect(devkeys.has(formatDevKeyRecordKey(USER_B, 'vk:b'))).toBe(true);
      expect(fakeIdb.transactions.filter((t) => t.mode === 'readwrite')).toHaveLength(1);
      const meta = await readDeviceMetaRecord(env());
      expect(meta?.deviceRevision).toBe(3);
      expect(meta?.incarnation).toBe('00112233445566778899aabbccddeeff');
    });

    it('known user with a DevKey: purges as before (delete + rotate once), not skipped', async () => {
      const devkeys = seedStore();
      devkeys.set(formatDevKeyRecordKey(USER_A, 'vk:a'), devkey(USER_A, 'vk:a'));
      devkeys.set(formatDevKeyRecordKey(USER_B, 'vk:b'), devkey(USER_B, 'vk:b'));
      const res = await purgeDeviceKeysOnRevoked(USER_A, env(), { skipIfNoDevKeys: true });
      expect(res.ok).toBe(true);
      expect(res.skipped).toBeUndefined();
      expect(res.deletedCount).toBe(1);
      expect(devkeys.has(formatDevKeyRecordKey(USER_A, 'vk:a'))).toBe(false);
      expect(devkeys.has(formatDevKeyRecordKey(USER_B, 'vk:b'))).toBe(true);
      expect((await readDeviceMetaRecord(env()))?.deviceRevision).toBe(4);
    });

    it('unknown user: an empty devkeys store is skipped, a non-empty one is cleared and rotated', async () => {
      const devkeys = seedStore();
      const skipped = await purgeDeviceKeysOnRevoked(null, env(), { skipIfNoDevKeys: true });
      expect(skipped.skipped).toBe(true);
      expect((await readDeviceMetaRecord(env()))?.deviceRevision).toBe(3);
      devkeys.set(formatDevKeyRecordKey(USER_B, 'vk:b'), devkey(USER_B, 'vk:b'));
      const purged = await purgeDeviceKeysOnRevoked(null, env(), { skipIfNoDevKeys: true });
      expect(purged.skipped).toBeUndefined();
      expect(devkeys.size).toBe(0);
      expect((await readDeviceMetaRecord(env()))?.deviceRevision).toBe(4);
    });

    it('a DevKey committed before the purge transaction starts blocks the skip (deleted + rotated); one written after the skip survives with the revision unchanged', async () => {
      const devkeys = seedStore();
      const racing = purgeDeviceKeysOnRevoked(USER_A, env(), { skipIfNoDevKeys: true });
      // Lands before the purge transaction is created (the factory open is still pending).
      devkeys.set(formatDevKeyRecordKey(USER_A, 'vk:a-race'), devkey(USER_A, 'vk:a-race'));
      const first = await racing;
      expect(first.skipped).toBeUndefined();
      expect(first.deletedCount).toBe(1);
      expect(devkeys.has(formatDevKeyRecordKey(USER_A, 'vk:a-race'))).toBe(false);
      expect((await readDeviceMetaRecord(env()))?.deviceRevision).toBe(4);

      const second = await purgeDeviceKeysOnRevoked(USER_A, env(), { skipIfNoDevKeys: true });
      expect(second.skipped).toBe(true);
      devkeys.set(formatDevKeyRecordKey(USER_A, 'vk:a-after'), devkey(USER_A, 'vk:a-after'));
      expect(devkeys.has(formatDevKeyRecordKey(USER_A, 'vk:a-after'))).toBe(true);
      expect((await readDeviceMetaRecord(env()))?.deviceRevision).toBe(4);
    });
  });

  it('BE1-1: holds post-unlock lockEpoch verification pending without exposing unlocked state or enabling decrypted consumers; locks on changed marker and unlocks on matching marker', async () => {
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

    let holdNextLockRequest = false;
    let releaseHeldLock: (() => void) | null = null;
    let lockRequestCount = 0;
    const baseLockManager = fakeLocks.createLockManager();
    const gatedLockManager: LockManager = {
      request(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
        maybeCallback?: LockGrantedCallback<unknown>,
      ): Promise<unknown> {
        lockRequestCount += 1;
        const cb =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
        if (holdNextLockRequest) {
          holdNextLockRequest = false;
          const { promise, resolve } = Promise.withResolvers<void>();
          releaseHeldLock = resolve;
          return promise.then(() => baseLockManager.request(name, { mode: 'exclusive' }, cb));
        }
        return baseLockManager.request(name, { mode: 'exclusive' }, cb);
      },
      query: async () => ({ held: [], pending: [] }),
    } as unknown as LockManager;

    let vaultCtx!: VaultContextValue;
    const seenStates: string[] = [];

    function DecryptedConsumerProbe() {
      vaultCtx = useVault();
      seenStates.push(vaultCtx.state);
      const bodyQuery = useQuery({
        queryKey: vaultBodyQueryKey('be1-1-entry'),
        queryFn: () => 'be1-1-decrypted-secret',
        enabled: vaultCtx.state === 'unlocked',
      });
      return (
        <div>
          <output data-testid="be1-1-state">{vaultCtx.state}</output>
          <output data-testid="be1-1-baseline">
            {vaultCtx.unlockBaseline ? String(vaultCtx.unlockBaseline.lockEpoch) : 'none'}
          </output>
          <output data-testid="be1-1-body">
            {vaultCtx.state === 'unlocked' && bodyQuery.data ? bodyQuery.data : 'locked-surface'}
          </output>
        </div>
      );
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={{
              idbFactory: fakeIdb.createFactory(),
              locksManager: gatedLockManager,
            }}
          >
            <DecryptedConsumerProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('be1-1-state')).toHaveTextContent('locked'));

    // Control step 0: create vault to get valid wrapped keys, then lock
    const opInit = vaultCtx.beginOp();
    const created = await vaultCtx.createVault({
      passphrase: 'be1-1-baseline-gate-passphrase',
      opGeneration: opInit.opGeneration,
    });
    await act(async () => {
      await vaultCtx.lockNow();
    });
    await waitFor(() => expect(screen.getByTestId('be1-1-state')).toHaveTextContent('locked'));
    seenStates.length = 0;

    // Case A: Hold post-unlock verification pending -> state MUST stay 'unlocking' (never 'unlocked'),
    // decrypted consumer query MUST NOT enable, and changing the marker before release MUST reject and lock.
    const opMismatch = vaultCtx.beginOp();
    let settledMismatch = false;
    const unlockMismatchPromise = vaultCtx
      .unlockPassphrase({
        passphrase: 'be1-1-baseline-gate-passphrase',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: opMismatch.opGeneration,
        beforePostMessage: () => {
          // Next Web Lock request will be verifyUnlockBaseline after Worker responds
          holdNextLockRequest = true;
        },
      })
      .finally(() => {
        settledMismatch = true;
      });
    unlockMismatchPromise.catch(() => undefined);

    // Wait until the post-unlock verification Web Lock is held
    await waitFor(() => {
      expect(releaseHeldLock).not.toBeNull();
    });

    // While verification is pending, Worker has already replied unlocked,
    // but provider MUST NOT expose 'unlocked' or enable decrypted body consumers.
    expect(settledMismatch).toBe(false);
    expect(screen.getByTestId('be1-1-state')).toHaveTextContent('unlocking');
    expect(screen.getByTestId('be1-1-baseline')).toHaveTextContent('none');
    expect(screen.getByTestId('be1-1-body')).toHaveTextContent('locked-surface');
    expect(qc.getQueryData(vaultBodyQueryKey('be1-1-entry'))).toBeUndefined();
    expect(seenStates).not.toContain('unlocked');

    // Mutate the durable lockEpoch marker in IndexedDB while verification is waiting (simulating concurrent lock)
    fakeIdb.ensureStore(LOCK_EPOCH_STORE_NAME).set(LOCK_EPOCH_RECORD_KEY, {
      epochIncarnation: 'changed-incarnation-during-unlock',
      lockEpoch: 99,
    });

    // Release the post-unlock verification gate -> operation rejects with STALE_GENERATION and provider locks
    act(() => {
      releaseHeldLock?.();
      releaseHeldLock = null;
    });

    await expect(unlockMismatchPromise).rejects.toSatisfy(
      (err: unknown) => err instanceof CryptoClientError && err.code === 'STALE_GENERATION',
    );
    await waitFor(() => {
      expect(screen.getByTestId('be1-1-state')).toHaveTextContent('locked');
    });
    expect(screen.getByTestId('be1-1-body')).toHaveTextContent('locked-surface');
    expect(qc.getQueryData(vaultBodyQueryKey('be1-1-entry'))).toBeUndefined();
    // Confirm 'unlocked' was NEVER rendered at any point during the mismatched unlock attempt
    expect(seenStates).not.toContain('unlocked');

    // Case B (Control): Hold post-unlock verification pending, keep marker matching, then release -> transitions cleanly to 'unlocked'
    const opMatch = vaultCtx.beginOp();
    let settledMatch = false;
    const unlockMatchPromise = vaultCtx
      .unlockPassphrase({
        passphrase: 'be1-1-baseline-gate-passphrase',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: opMatch.opGeneration,
        beforePostMessage: () => {
          holdNextLockRequest = true;
        },
      })
      .finally(() => {
        settledMatch = true;
      });

    await waitFor(() => {
      expect(releaseHeldLock).not.toBeNull();
    });
    expect(settledMatch).toBe(false);
    expect(screen.getByTestId('be1-1-state')).toHaveTextContent('unlocking');
    expect(screen.getByTestId('be1-1-body')).toHaveTextContent('locked-surface');

    act(() => {
      releaseHeldLock?.();
      releaseHeldLock = null;
    });

    await expect(unlockMatchPromise).resolves.toEqual({ unlocked: true });
    await waitFor(() => {
      expect(screen.getByTestId('be1-1-state')).toHaveTextContent('unlocked');
      expect(screen.getByTestId('be1-1-body')).toHaveTextContent('be1-1-decrypted-secret');
    });
    expect(lockRequestCount).toBeGreaterThan(0);
  });

  it('BE1-2: pending Web Lock or IDB verification on wake gates plaintext immediately, enforces the 5s fail-closed deadline (including auto_lock_minutes=0), and ignores late completion', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z').getTime();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

    let currentMe = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 0 });
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

    let holdWakeLock = false;
    let releaseWakeLock: (() => void) | null = null;
    const baseLockManager = fakeLocks.createLockManager();
    const gatedLockManager: LockManager = {
      request(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
        maybeCallback?: LockGrantedCallback<unknown>,
      ): Promise<unknown> {
        const cb =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
        if (holdWakeLock) {
          holdWakeLock = false;
          const { promise, resolve } = Promise.withResolvers<void>();
          releaseWakeLock = resolve;
          return promise.then(() => baseLockManager.request(name, { mode: 'exclusive' }, cb));
        }
        return baseLockManager.request(name, { mode: 'exclusive' }, cb);
      },
      query: async () => ({ held: [], pending: [] }),
    } as unknown as LockManager;

    let vaultCtx!: VaultContextValue;
    function WakeProbe() {
      vaultCtx = useVault();
      const cachedBody = qc.getQueryData<string>(vaultBodyQueryKey('be1-2-entry'));
      return (
        <div>
          <output data-testid="be1-2-state">{vaultCtx.state}</output>
          <output data-testid="be1-2-worker">{vaultCtx.workerState}</output>
          <output data-testid="be1-2-body">
            {vaultCtx.state === 'unlocked' && cachedBody ? cachedBody : 'gated'}
          </output>
        </div>
      );
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={{
              idbFactory: fakeIdb.createFactory(),
              locksManager: gatedLockManager,
            }}
          >
            <WakeProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('be1-2-state')).toHaveTextContent('locked'));

    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(t0);

    const op1 = vaultCtx.beginOp();
    let created!: CreateVaultResult;
    await act(async () => {
      created = await vaultCtx.createVault({
        passphrase: 'be1-2-wake-deadline-passphrase',
        opGeneration: op1.opGeneration,
      });
    });
    qc.setQueryData(vaultBodyQueryKey('be1-2-entry'), 'be1-2-plaintext');
    expect(screen.getByTestId('be1-2-state')).toHaveTextContent('unlocked');
    expect(qc.getQueryData(vaultBodyQueryKey('be1-2-entry'))).toBe('be1-2-plaintext');

    // Hold the wake Web Lock acquisition unresolved and dispatch focus while policy is 0 (Never)
    holdWakeLock = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    // Plaintext surface must be gated immediately (`unlocking`, never `unlocked` and never falsely `locked` before Worker locks)
    expect(screen.getByTestId('be1-2-state')).toHaveTextContent('unlocking');
    expect(screen.getByTestId('be1-2-worker')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('be1-2-body')).toHaveTextContent('gated');
    // Advance 6 seconds past the 5s wake fail-closed deadline while Web Lock is still held ->
    // Tab MUST lock fail-closed and wipe the decrypted body cache
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(screen.getByTestId('be1-2-state')).toHaveTextContent('locked');
    expect(screen.getByTestId('be1-2-worker')).toHaveTextContent('locked');
    expect(qc.getQueryData(vaultBodyQueryKey('be1-2-entry'))).toBeUndefined();

    // Late completion of the held Web Lock / IDB check MUST NOT restore unlocked access
    await act(async () => {
      releaseWakeLock?.();
      releaseWakeLock = null;
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByTestId('be1-2-state')).toHaveTextContent('locked');
    expect(screen.getByTestId('be1-2-worker')).toHaveTextContent('locked');
    expect(screen.getByTestId('be1-2-body')).toHaveTextContent('gated');

    // Control & lock-epoch (a) regression guard:
    // Unlock again, advance durable lockEpoch in IDB, then fire a burst of `resume` + `focus` + `visibilitychange`
    // synchronously in the same turn (exact `e2e/lock-epoch.spec.ts` (a) resume pattern):
    // - While Web Lock / IDB check is in flight, `state` is `'unlocking'` (never `'locked'` while `workerState` is `'unlocked'`).
    // - When verification completes, BOTH `state` and `workerState` transition to `'locked'`.
    const op2 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.unlockPassphrase({
        passphrase: 'be1-2-wake-deadline-passphrase',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: op2.opGeneration,
      });
    });
    expect(screen.getByTestId('be1-2-state')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('be1-2-worker')).toHaveTextContent('unlocked');

    await act(async () => {
      await recordLockEpochEvent(vaultCtx.tabKnownLockEpoch, {
        idbFactory: fakeIdb.createFactory(),
        locksManager: baseLockManager,
      });
      window.dispatchEvent(new Event('resume'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByTestId('be1-2-state')).toHaveTextContent('locked');
    expect(screen.getByTestId('be1-2-worker')).toHaveTextContent('locked');

    // Re-unlock again to test EC-P3 / VG-P2 wake activity watermark preservation
    const op3 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.unlockPassphrase({
        passphrase: 'be1-2-wake-deadline-passphrase',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: op3.opGeneration,
      });
    });
    act(() => {
      qc.setQueryData(vaultBodyQueryKey('be1-2-entry'), 'be1-2-plaintext-control');
    });
    expect(screen.getByTestId('be1-2-state')).toHaveTextContent('unlocked');
    // slept 10m, and user dispatches activity during wake before Me resolves, it still locks on Me completion!
    currentMe = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 5 });
    vi.setSystemTime(t0 + 10 * 60_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      // User input during wake before Me finishes must not erase the pre-wake idle watermark
      window.dispatchEvent(new Event('pointerdown'));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByTestId('be1-2-state')).toHaveTextContent('locked');
    expect(qc.getQueryData(vaultBodyQueryKey('be1-2-entry'))).toBeUndefined();
  });

  it('BE1-3: stale settings_changed {auto_lock_minutes:0} notification does not override an unchanged server positive policy (5m), reconciles on every successful Me refresh, and does not relax to Never on failed refresh or cross-tab reordering', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z').getTime();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

    const serverMinutes: 0 | 5 | 15 | 60 = 5;
    let failMeFetch = false;
    let meRefetchCount = 0;

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
        meRefetchCount += 1;
        if (failMeFetch) {
          throw new Error('Simulated network failure during Me refresh');
        }
        return jsonResponse(
          makeMeFixture({ vaultStatus: 'present', autoLockMinutes: serverMinutes }),
        );
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    function SettingsProbe() {
      vaultCtx = useVault();
      return (
        <div>
          <output data-testid="be1-3-state">{vaultCtx.state}</output>
          <output data-testid="be1-3-minutes">{vaultCtx.autoLockMinutes}</output>
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
            <SettingsProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('be1-3-state')).toHaveTextContent('locked');
      expect(screen.getByTestId('be1-3-minutes')).toHaveTextContent('5');
    });

    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(t0);

    const op1 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.createVault({
        passphrase: 'be1-3-stale-never-passphrase',
        opGeneration: op1.opGeneration,
      });
    });
    expect(screen.getByTestId('be1-3-state')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('be1-3-minutes')).toHaveTextContent('5');

    const remotePeer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);

    // 1. Deliver a stale { auto_lock_minutes: 0 } notification while server remains 5 ->
    //    Provider refreshes Me (which still returns numeric 5), keeps 5 authoritative, and enforces the 5m idle deadline.
    const countBeforeStale = meRefetchCount;
    await act(async () => {
      remotePeer.postMessage({ type: 'settings_changed', auto_lock_minutes: 0 });
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(meRefetchCount).toBeGreaterThan(countBeforeStale);
    expect(screen.getByTestId('be1-3-minutes')).toHaveTextContent('5');
    expect(screen.getByTestId('be1-3-state')).toHaveTextContent('unlocked');

    // 2. Deliver a { auto_lock_minutes: 0 } notification when Me refresh fails ->
    //    Must NOT relax the current positive 5m policy to Never (0).
    failMeFetch = true;
    await act(async () => {
      remotePeer.postMessage({ type: 'settings_changed', auto_lock_minutes: 0 });
      await vi.advanceTimersByTimeAsync(50);
    });
    failMeFetch = false;
    expect(screen.getByTestId('be1-3-minutes')).toHaveTextContent('5');

    // 3. Cross-tab reordering: a notification sets a different value transiently, then a delayed stale 0 arrives
    //    while server is 5 -> reconciled back to 5 and original 5m idle deadline is enforced.
    await act(async () => {
      remotePeer.postMessage({ type: 'settings_changed', auto_lock_minutes: 15 });
      remotePeer.postMessage({ type: 'settings_changed', auto_lock_minutes: 0 });
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByTestId('be1-3-minutes')).toHaveTextContent('5');

    // Advance to the 5-minute mark -> original 5-minute idle deadline locks the vault
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    remotePeer.close();
    expect(screen.getByTestId('be1-3-state')).toHaveTextContent('locked');
  });

  it('BE1-5 & BE1-15: missed Never-to-finite wake transition locks on wake without input, remote/local activity broadcasts and overlapping wake triggers do not erase the pre-wake idle watermark, and stale settings_changed refresh across lock/re-unlock is fenced', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z').getTime();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

    let currentMe = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 0 });
    let holdWakeMe = false;
    let resolveWakeMe: ((res: Response) => void) | null = null;
    let holdSettingsMe = false;
    let resolveSettingsMe: ((res: Response) => void) | null = null;

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
        if (holdWakeMe) {
          holdWakeMe = false;
          return new Promise<Response>((resolve) => {
            resolveWakeMe = resolve;
          });
        }
        if (holdSettingsMe) {
          holdSettingsMe = false;
          return new Promise<Response>((resolve) => {
            resolveSettingsMe = resolve;
          });
        }
        return jsonResponse(currentMe);
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    function WakeWatermarkProbe() {
      vaultCtx = useVault();
      return (
        <div>
          <output data-testid="be1-5-state">{vaultCtx.state}</output>
          <output data-testid="be1-5-minutes">{vaultCtx.autoLockMinutes}</output>
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
            <WakeWatermarkProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('be1-5-state')).toHaveTextContent('locked');
    });

    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(t0);

    const op1 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.createVault({
        passphrase: 'be1-5-wake-watermark-passphrase',
        opGeneration: op1.opGeneration,
      });
    });
    expect(screen.getByTestId('be1-5-state')).toHaveTextContent('unlocked');

    const remotePeer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);

    // Sleep 10 minutes; server tightened policy to 5m while tab had 0 (Never)
    currentMe = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 5 });
    vi.setSystemTime(t0 + 10 * 60_000);
    holdWakeMe = true;

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(10);
    });

    // While wake #1 is waiting on Me, a remote tab broadcasts activity AND an overlapping wake event (pageshow) fires
    await act(async () => {
      remotePeer.postMessage({ type: 'activity', at: t0 + 10 * 60_000 });
      vaultCtx.recordActivity(t0 + 10 * 60_000);
      window.dispatchEvent(new Event('pageshow'));
      await vi.advanceTimersByTimeAsync(10);
    });

    // Release wake #1 Me response -> must still evaluate against pre-wake t0 watermark and lock!
    await act(async () => {
      resolveWakeMe?.(jsonResponse(currentMe));
      resolveWakeMe = null;
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByTestId('be1-5-state')).toHaveTextContent('locked');

    // BE1-8: Stale settings_changed fetchMe across lock / re-unlock is fenced by generation
    currentMe = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 5 });
    const op2 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.createVault({
        passphrase: 'be1-8-settings-fence-passphrase',
        opGeneration: op2.opGeneration,
      });
    });
    expect(screen.getByTestId('be1-5-state')).toHaveTextContent('unlocked');

    // Hold the settings_changed fetchMe in flight (which will later return 0/Never from an older state)
    holdSettingsMe = true;
    await act(async () => {
      remotePeer.postMessage({ type: 'settings_changed', auto_lock_minutes: 0 });
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(resolveSettingsMe).not.toBeNull();

    // Lock and re-unlock with stricter 5m policy before the old settings_changed fetchMe resolves
    await act(async () => {
      await vaultCtx.lockNow();
    });
    const op3 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.createVault({
        passphrase: 'be1-8-settings-fence-passphrase-2',
        opGeneration: op3.opGeneration,
      });
    });
    await act(async () => {
      vaultCtx.notifySettingsChanged({ auto_lock_minutes: 5 });
    });
    expect(screen.getByTestId('be1-5-minutes')).toHaveTextContent('5');

    // Now resolve the stale settings_changed fetchMe with 0 (Never) -> must be ignored because generation & seq changed
    await act(async () => {
      resolveSettingsMe?.(
        jsonResponse(makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 0 })),
      );
      resolveSettingsMe = null;
      await vi.advanceTimersByTimeAsync(50);
    });
    remotePeer.close();
    expect(screen.getByTestId('be1-5-minutes')).toHaveTextContent('5');
  });

  it('BE1-6 & BE1-7: recovery ops capture and verify unlockBaseline (locking on remote lock during recovery or before confirmRecovery) and recovering state enforces idle auto-lock', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z').getTime();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

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
        return jsonResponse(makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 5 }));
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    function RecoveryProbe() {
      vaultCtx = useVault();
      return (
        <div>
          <output data-testid="be1-6-state">{vaultCtx.state}</output>
          <output data-testid="be1-6-worker">{vaultCtx.workerState}</output>
        </div>
      );
    }

    const lockEpochEnv = makeLockEpochEnv();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={lockEpochEnv}
          >
            <RecoveryProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('be1-6-state')).toHaveTextContent('locked');
    });

    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(t0);

    // Create a vault first to obtain a valid recovery key and wrapped VK
    const opCreate = vaultCtx.beginOp();
    let created!: CreateVaultResult;
    await act(async () => {
      created = await vaultCtx.createVault({
        passphrase: 'be1-6-recovery-passphrase',
        opGeneration: opCreate.opGeneration,
      });
      await vaultCtx.lockNow();
    });
    expect(screen.getByTestId('be1-6-state')).toHaveTextContent('locked');

    const rk0 = created.recovery_keys[0]!;

    // Case 1 (BE1-6): A remote lock occurs while resumeRecovery is running -> fails closed instead of entering recovering
    const opRec1 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.unlockRecovery({
        recoveryKey: rk0.display,
        opGeneration: opRec1.opGeneration,
      });
    });
    // Simulate a sibling tab recording a durable lock event while BroadcastChannel is missed before resumeRecovery
    await act(async () => {
      await recordLockEpochEvent(vaultCtx.tabKnownLockEpoch, {
        idbFactory: fakeIdb.createFactory(),
        locksManager: fakeLocks.createLockManager(),
      });
    });
    let rec1Err: unknown = null;
    await act(async () => {
      rec1Err = await vaultCtx
        .resumeRecovery({
          wrap: rk0.wrap,
          privateKeysWrapped: created.private_keys_wrapped,
          opGeneration: opRec1.opGeneration,
        })
        .catch((err: unknown) => err);
    });
    expect(rec1Err).toMatchObject({ code: 'STALE_GENERATION' });
    expect(screen.getByTestId('be1-6-state')).toHaveTextContent('locked');
    expect(screen.getByTestId('be1-6-worker')).toHaveTextContent('locked');

    // Case 2 (BE1-6): Enter recovering cleanly, then a missed remote lock happens while in recovering ->
    // wake/focus check detects the durable lockEpoch change and locks immediately!
    const opRec2 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.unlockRecovery({
        recoveryKey: rk0.display,
        opGeneration: opRec2.opGeneration,
      });
    });
    await act(async () => {
      await vaultCtx.resumeRecovery({
        wrap: rk0.wrap,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: opRec2.opGeneration,
      });
    });
    expect(screen.getByTestId('be1-6-state')).toHaveTextContent('recovering');
    expect(vaultCtx.unlockBaseline).not.toBeNull();

    // Ordinary focus while in recovering with unchanged marker MUST preserve recovering state (BE1-6)
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByTestId('be1-6-state')).toHaveTextContent('recovering');
    expect(screen.getByTestId('be1-6-worker')).toHaveTextContent('recovering');

    // Missed remote durable lock while in recovering before confirmRecovery ->
    // confirmRecovery MUST verify the original recovery-start baseline (never overwriting it with a fresh capture) and fail closed!
    await act(async () => {
      await recordLockEpochEvent(vaultCtx.tabKnownLockEpoch, {
        idbFactory: fakeIdb.createFactory(),
        locksManager: fakeLocks.createLockManager(),
      });
    });
    let rec2Err: unknown = null;
    await act(async () => {
      rec2Err = await vaultCtx
        .confirmRecovery({
          opGeneration: opRec2.opGeneration,
        })
        .catch((err: unknown) => err);
    });
    expect(rec2Err).toMatchObject({ code: 'STALE_GENERATION' });
    expect(screen.getByTestId('be1-6-state')).toHaveTextContent('locked');
    expect(screen.getByTestId('be1-6-worker')).toHaveTextContent('locked');

    // Case 3 (BE1-7): Enter recovering cleanly and stay idle for 5 minutes -> auto-lock timer locks recovering state!
    const opRec3 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.unlockRecovery({
        recoveryKey: rk0.display,
        opGeneration: opRec3.opGeneration,
      });
    });
    await act(async () => {
      await vaultCtx.resumeRecovery({
        wrap: rk0.wrap,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: opRec3.opGeneration,
      });
    });
    expect(screen.getByTestId('be1-6-state')).toHaveTextContent('recovering');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
    });
    expect(screen.getByTestId('be1-6-state')).toHaveTextContent('locked');
    expect(screen.getByTestId('be1-6-worker')).toHaveTextContent('locked');
  });

  it('BE1-8, BE1-11, BE1-16, BE1-17 & VS-R1-11: fences stale wake continuation across re-unlock, fences stale reloadVaultMeta across logout/account switch, advances durable lockEpoch on reset/key-id-change, refetches Me on vault_changed{version:null}, and locks on incarnation-only mismatch', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z').getTime();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

    let currentMe: Me | null = makeMeFixture({
      userId: '11111111-1111-1111-1111-111111111111',
      vaultStatus: 'present',
      autoLockMinutes: 15,
    });
    let holdVaultFetch = false;
    let resolveVaultFetch: ((res: Response) => void) | null = null;
    let vaultKeyIdOnServer = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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
        if (!currentMe) {
          return jsonResponse({ status: 401, code: 'session_invalid', title: 'Unauthorized' }, 401);
        }
        return jsonResponse(currentMe);
      }
      if (u.endsWith('/vault')) {
        if (holdVaultFetch) {
          holdVaultFetch = false;
          return new Promise<Response>((resolve) => {
            resolveVaultFetch = resolve;
          });
        }
        return jsonResponse({
          vault_key_id: vaultKeyIdOnServer,
          version: 1,
          kdf: {
            alg: 'argon2id13',
            ops: 3,
            mem: 67_108_864,
            parallelism: 1,
            salt: 'dGVzdC1zYWx0LTE2Ynl0ZXM',
          },
          vault_key_wrapped_by_kek: 'dGVzdC12ay13cmFw',
          x25519_public: 'dGVzdC14MjU1MTktcHVi',
          ed25519_public: 'dGVzdC1lZDI1NTE5LXB1Yg',
          private_keys_wrapped: 'dGVzdC1wcml2LXdyYXA',
          passkey_slots: [],
          recovery_keys_remaining: 10,
        });
      }
      return jsonResponse({});
    });

    let holdWakeVerifyLock = false;
    let releaseWakeVerifyLock: (() => void) | null = null;
    let holdUnlockVerifyLock = false;
    let releaseUnlockVerifyLock: (() => void) | null = null;
    const baseLockManager = fakeLocks.createLockManager();
    const customLockManager: LockManager = {
      request(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
        maybeCallback?: LockGrantedCallback<unknown>,
      ): Promise<unknown> {
        const cb =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
        if (holdWakeVerifyLock) {
          holdWakeVerifyLock = false;
          return new Promise<void>((resolve) => {
            releaseWakeVerifyLock = resolve;
          }).then(() => baseLockManager.request(name, { mode: 'exclusive' }, cb));
        }
        if (holdUnlockVerifyLock) {
          holdUnlockVerifyLock = false;
          return new Promise<void>((resolve) => {
            releaseUnlockVerifyLock = resolve;
          }).then(() => baseLockManager.request(name, { mode: 'exclusive' }, cb));
        }
        return baseLockManager.request(name, { mode: 'exclusive' }, cb);
      },
      query: async () => ({ held: [], pending: [] }),
    } as unknown as LockManager;

    let vaultCtx!: VaultContextValue;
    let sessionRefetch!: () => Promise<void>;
    function FenceProbe() {
      vaultCtx = useVault();
      const session = useSession();
      sessionRefetch = session.refetchMe;
      return (
        <div>
          <output data-testid="be1-11-state">{vaultCtx.state}</output>
          <output data-testid="be1-11-meta">{vaultCtx.vaultMeta?.vault_key_id ?? 'none'}</output>
        </div>
      );
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={{
              idbFactory: fakeIdb.createFactory(),
              locksManager: customLockManager,
            }}
          >
            <FenceProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('be1-11-state')).toHaveTextContent('locked');
    });

    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(t0);

    // 1. BE1-11: Unlock #1 -> start wake verification and hold its Web Lock -> lock & start Unlock #2 (hold Unlock #2 post-unlock verify)
    //    -> let stale wake #1 finish -> must NOT flip baselineVerified true while Unlock #2 is still verifying!
    const op1 = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.createVault({
        passphrase: 'be1-11-passphrase-one',
        opGeneration: op1.opGeneration,
      });
    });
    expect(screen.getByTestId('be1-11-state')).toHaveTextContent('unlocked');

    holdWakeVerifyLock = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByTestId('be1-11-state')).toHaveTextContent('unlocking');
    await act(async () => {
      await vaultCtx.lockNow();
    });

    // Start Unlock #2, holding its post-unlock verifyUnlockBaseline Web Lock
    const op2 = vaultCtx.beginOp();
    let unlock2Promise!: Promise<CreateVaultResult>;
    await act(async () => {
      unlock2Promise = vaultCtx.createVault({
        passphrase: 'be1-11-passphrase-two',
        opGeneration: op2.opGeneration,
        beforePostMessage: async () => {
          // After captureUnlockBaseline acquires the lock, hold the next lock request (verifyUnlockBaseline)
          queueMicrotask(() => {
            holdUnlockVerifyLock = true;
          });
        },
      });
      await vi.advanceTimersByTimeAsync(20);
    });
    // Unlock #2 is still pending verification -> state must be 'unlocking', not 'unlocked'
    expect(screen.getByTestId('be1-11-state')).toHaveTextContent('unlocking');

    // Release stale wake #1 lock while Unlock #2 verification is still held -> state must stay 'unlocking'
    await act(async () => {
      releaseWakeVerifyLock?.();
      releaseWakeVerifyLock = null;
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(screen.getByTestId('be1-11-state')).toHaveTextContent('unlocking');

    // Release Unlock #2 verification -> now transitions cleanly to 'unlocked'
    await act(async () => {
      releaseUnlockVerifyLock?.();
      releaseUnlockVerifyLock = null;
      await unlock2Promise;
    });
    expect(screen.getByTestId('be1-11-state')).toHaveTextContent('unlocked');

    // 2. BE1-12: reloadVaultMeta detecting vault_key_id mismatch or remote vault_changed reset advances durable lockEpoch in IDB
    await act(async () => {
      await vaultCtx.reloadVaultMeta();
    });
    expect(screen.getByTestId('be1-11-meta')).toHaveTextContent(vaultKeyIdOnServer);
    const epochBeforeMismatch = vaultCtx.tabKnownLockEpoch;

    // Server rotates vault_key_id (e.g. reset + re-create on another device)
    vaultKeyIdOnServer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await act(async () => {
      await vaultCtx.reloadVaultMeta();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(screen.getByTestId('be1-11-state')).toHaveTextContent('locked');
    expect(vaultCtx.tabKnownLockEpoch).toBeGreaterThan(epochBeforeMismatch);

    // Verify persisted lockEpoch in IndexedDB also advanced so a frozen sibling tab will lock on wake (BE1-16)
    const checkFrozen = await verifyUnlockBaseline(
      { epochIncarnation: 'stale', lockEpoch: epochBeforeMismatch },
      { idbFactory: fakeIdb.createFactory(), locksManager: baseLockManager },
    );
    expect(checkFrozen.matches).toBe(false);
    expect(checkFrozen.persistedMarker?.lockEpoch).toBeGreaterThan(epochBeforeMismatch);

    // VS-R1-11 & BE1-16: Receiving vault_changed { version: null } (remote vault reset) locks, advances durable lockEpoch,
    // and calls refetchMe() so serverVaultStatus transitions from 'present' to 'absent' ('no_vault').
    const epochBeforeResetBroadcast = vaultCtx.tabKnownLockEpoch;
    currentMe = makeMeFixture({
      userId: '11111111-1111-1111-1111-111111111111',
      vaultStatus: 'absent',
      autoLockMinutes: 15,
    });
    const resetPeer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      resetPeer.postMessage({
        type: 'vault_changed',
        vault_key_id: vaultKeyIdOnServer,
        version: null,
      });
      await vi.advanceTimersByTimeAsync(50);
    });
    resetPeer.close();
    expect(screen.getByTestId('be1-11-state')).toHaveTextContent('no_vault');
    expect(vaultCtx.tabKnownLockEpoch).toBeGreaterThan(epochBeforeResetBroadcast);

    // Restore currentMe to 'present' for subsequent test step and verify BE1-17 (incarnation-only mismatch with identical numeric lockEpoch)
    currentMe = makeMeFixture({
      userId: '11111111-1111-1111-1111-111111111111',
      vaultStatus: 'present',
      autoLockMinutes: 15,
    });
    await act(async () => {
      await sessionRefetch();
      await vi.advanceTimersByTimeAsync(20);
    });
    const opInc = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.createVault({
        passphrase: 'be1-17-incarnation-only-passphrase',
        opGeneration: opInc.opGeneration,
      });
    });
    expect(screen.getByTestId('be1-11-state')).toHaveTextContent('unlocked');
    const baselineBeforeIncSwap = vaultCtx.unlockBaseline!;
    expect(baselineBeforeIncSwap).not.toBeNull();
    fakeIdb.ensureStore(LOCK_EPOCH_STORE_NAME).set(LOCK_EPOCH_RECORD_KEY, {
      epochIncarnation: '99999999999999999999999999999999',
      lockEpoch: baselineBeforeIncSwap.lockEpoch,
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(screen.getByTestId('be1-11-state')).toHaveTextContent('locked');
    //    late User A response is ignored and never populates vaultMeta for User B!
    holdVaultFetch = true;
    let staleReloadPromise!: Promise<unknown>;
    await act(async () => {
      staleReloadPromise = vaultCtx.reloadVaultMeta();
    });
    expect(resolveVaultFetch).not.toBeNull();

    // Switch session to User B
    currentMe = makeMeFixture({
      userId: '22222222-2222-4222-8222-222222222222',
      email: 'user-b@example.test',
      vaultStatus: 'absent',
    });
    await act(async () => {
      await sessionRefetch();
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(screen.getByTestId('be1-11-meta')).toHaveTextContent('none');

    // Now resolve the stale User A fetchVault -> must be dropped and leave vaultMeta as 'none'
    await act(async () => {
      resolveVaultFetch?.(
        jsonResponse({
          vault_key_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          version: 9,
          kdf: {
            alg: 'argon2id13',
            ops: 3,
            mem: 67_108_864,
            parallelism: 1,
            salt: 'dGVzdC1zYWx0LTE2Ynl0ZXM',
          },
          vault_key_wrapped_by_kek: 'dGVzdC12ay13cmFw',
          x25519_public: 'dGVzdC14MjU1MTktcHVi',
          ed25519_public: 'dGVzdC1lZDI1NTE5LXB1Yg',
          private_keys_wrapped: 'dGVzdC1wcml2LXdyYXA',
          passkey_slots: [],
          recovery_keys_remaining: 10,
        }),
      );
      resolveVaultFetch = null;
      await staleReloadPromise;
    });
    expect(screen.getByTestId('be1-11-meta')).toHaveTextContent('none');
  });

  it('VS-R1-11: receiving vault_changed { version: null } refetches Me after locking and advancing durable lockEpoch so serverVaultStatus transitions from present to absent (no_vault)', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z').getTime();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

    let currentMe = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 15 });
    let meRefetchCount = 0;

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
        meRefetchCount += 1;
        return jsonResponse(currentMe);
      }
      if (u.endsWith('/vault')) {
        return new Response(
          JSON.stringify({
            type: 'https://engram.zone17th.click/problems/vault_absent',
            title: 'vault_absent',
            status: 404,
            code: 'vault_absent',
          }),
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      return jsonResponse({});
    });

    let vaultCtx!: VaultContextValue;
    function ResetStatusProbe() {
      vaultCtx = useVault();
      return (
        <div>
          <output data-testid="vs-r1-11-state">{vaultCtx.state}</output>
          <output data-testid="vs-r1-11-server">{vaultCtx.serverVaultStatus}</output>
          <output data-testid="vs-r1-11-worker">{vaultCtx.workerState}</output>
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
            <ResetStatusProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('vs-r1-11-state')).toHaveTextContent('locked');
      expect(screen.getByTestId('vs-r1-11-server')).toHaveTextContent('present');
    });

    vi.useRealTimers();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(t0);

    const op = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.createVault({
        passphrase: 'vs-r1-11-reset-passphrase',
        opGeneration: op.opGeneration,
      });
    });
    expect(screen.getByTestId('vs-r1-11-state')).toHaveTextContent('unlocked');
    const epochBeforeReset = vaultCtx.tabKnownLockEpoch;
    const meCountBeforeReset = meRefetchCount;

    // Tab A resets vault -> server Me now has vault.status = 'absent' and broadcasts vault_changed { version: null }
    currentMe = makeMeFixture({ vaultStatus: 'absent', autoLockMinutes: 15 });
    const remotePeer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      remotePeer.postMessage({
        type: 'vault_changed',
        vault_key_id: 'vk:reset-target',
        version: null,
      });
      await vi.advanceTimersByTimeAsync(50);
    });
    remotePeer.close();

    expect(meRefetchCount).toBeGreaterThan(meCountBeforeReset);
    expect(vaultCtx.tabKnownLockEpoch).toBeGreaterThan(epochBeforeReset);
    expect(screen.getByTestId('vs-r1-11-worker')).toHaveTextContent('locked');
    expect(screen.getByTestId('vs-r1-11-server')).toHaveTextContent('absent');
    expect(screen.getByTestId('vs-r1-11-state')).toHaveTextContent('no_vault');
  });

  it('first recovery on a device without marker succeeds and records a baseline', async () => {
    const me = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 15 });
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
    function FreshRecoveryProbe() {
      vaultCtx = useVault();
      return (
        <div>
          <output data-testid="fresh-rec-state">{vaultCtx.state}</output>
          <output data-testid="fresh-rec-worker">{vaultCtx.workerState}</output>
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
            <FreshRecoveryProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('fresh-rec-state')).toHaveTextContent('locked');
    });

    // Obtain a valid RK + wrapped private keys, then wipe __lock_epoch__ from IDB to simulate a fresh device
    const opSetup = vaultCtx.beginOp();
    let created!: CreateVaultResult;
    await act(async () => {
      created = await vaultCtx.createVault({
        passphrase: 'fresh-device-recovery-setup-passphrase',
        opGeneration: opSetup.opGeneration,
      });
      await vaultCtx.lockNow();
    });
    fakeIdb.ensureStore(LOCK_EPOCH_STORE_NAME).delete(LOCK_EPOCH_RECORD_KEY);
    expect(fakeIdb.ensureStore(LOCK_EPOCH_STORE_NAME).has(LOCK_EPOCH_RECORD_KEY)).toBe(false);

    const rk0 = created.recovery_keys[0]!;
    const opRec = vaultCtx.beginOp();

    // Step 1: unlockRecovery on fresh device with no marker -> initializes marker under Web Lock and records unlockBaseline
    await act(async () => {
      await vaultCtx.unlockRecovery({
        recoveryKey: rk0.display,
        opGeneration: opRec.opGeneration,
      });
    });
    const baselineAfterUnlockRecovery = vaultCtx.unlockBaseline;
    expect(baselineAfterUnlockRecovery).not.toBeNull();
    expect(baselineAfterUnlockRecovery?.lockEpoch).toBeGreaterThanOrEqual(1);
    expect(fakeIdb.ensureStore(LOCK_EPOCH_STORE_NAME).get(LOCK_EPOCH_RECORD_KEY)).toEqual(
      baselineAfterUnlockRecovery,
    );

    // Step 2: resumeRecovery -> verifies the same baseline and transitions to 'recovering'
    await act(async () => {
      await vaultCtx.resumeRecovery({
        wrap: rk0.wrap,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: opRec.opGeneration,
      });
    });
    expect(screen.getByTestId('fresh-rec-state')).toHaveTextContent('recovering');
    expect(vaultCtx.unlockBaseline).toEqual(baselineAfterUnlockRecovery);

    // Step 3: confirmRecovery -> verifies the same baseline and transitions to 'unlocked'
    await act(async () => {
      await vaultCtx.confirmRecovery({
        opGeneration: opRec.opGeneration,
      });
    });
    expect(screen.getByTestId('fresh-rec-state')).toHaveTextContent('unlocked');
    expect(vaultCtx.unlockBaseline).toEqual(baselineAfterUnlockRecovery);
  });

  it('VS-R4-1: idempotent 404 reset-transition purge across receiving tab vault_changed { version: null } and acting tab Reload vault after dialog purge (deviceRevision increases by +1 exactly once per reset)', async () => {
    let currentMe = makeMeFixture({
      userId: '11111111-1111-1111-1111-111111111111',
      vaultStatus: 'present',
      autoLockMinutes: 15,
    });
    let vaultReturnedPresent = true;
    let vaultKeyId = 'vk:reset-target-vs-r4-1';
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
        return jsonResponse(currentMe);
      }
      if (u.endsWith('/vault')) {
        if (vaultReturnedPresent) {
          return jsonResponse({
            vault_key_id: vaultKeyId,
            version: 1,
            kdf: {
              alg: 'argon2id13',
              ops: 3,
              mem: 67108864,
              parallelism: 1,
              salt: 'dGVzdC1zYWx0LTE2Ynl0ZXM',
            },
            vault_key_wrapped_by_kek: 'd3JhcHBlZC12aw',
            x25519_public: 'eDI1NTE5LXB1Yg',
            ed25519_public: 'ZWQyNTUxOS1wdWI',
            private_keys_wrapped: 'd3JhcHBlZC1wcml2',
            recovery_keys_remaining: 10,
          });
        }
        return new Response(
          JSON.stringify({
            type: 'https://engram.zone17th.click/problems/vault_absent',
            title: 'vault_absent',
            status: 404,
            code: 'vault_absent',
          }),
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      return jsonResponse({});
    });

    // Seed initial DevKey meta record with deviceRevision = 10
    fakeIdb.ensureStore(META_STORE_NAME).set(DEVICE_META_RECORD_KEY, {
      key: DEVICE_META_RECORD_KEY,
      incarnation: 'initial-incarnation-vs-r4-1',
      deviceRevision: 10,
    });

    let tabAVault!: VaultContextValue;
    let tabBVault!: VaultContextValue;
    const workerFactoryA = makeShimmedWorkerFactory();
    const workerFactoryB = makeShimmedWorkerFactory();
    const lockEnvA = makeLockEpochEnv();
    const lockEnvB = makeLockEpochEnv();
    function TabAProbe() {
      tabAVault = useVault();
      return <output data-testid="vs-r4-1-tab-a">{tabAVault.state}</output>;
    }
    function TabBProbe() {
      tabBVault = useVault();
      return <output data-testid="vs-r4-1-tab-b">{tabBVault.state}</output>;
    }

    const qcA = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const qcB = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <div>
        <QueryClientProvider client={qcA}>
          <SessionProvider>
            <VaultProvider createWorker={workerFactoryA} lockEpochEnv={lockEnvA}>
              <TabAProbe />
            </VaultProvider>
          </SessionProvider>
        </QueryClientProvider>
        <QueryClientProvider client={qcB}>
          <SessionProvider>
            <VaultProvider createWorker={workerFactoryB} lockEpochEnv={lockEnvB}>
              <TabBProbe />
            </VaultProvider>
          </SessionProvider>
        </QueryClientProvider>
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('vs-r4-1-tab-a')).toHaveTextContent('locked');
      expect(screen.getByTestId('vs-r4-1-tab-b')).toHaveTextContent('locked');
    });

    // Both tabs load initial vaultMeta ('vk:reset-target-vs-r4-1')
    await act(async () => {
      await tabAVault.reloadVaultMeta();
      await tabBVault.reloadVaultMeta();
    });

    const metaBefore = await readDeviceMetaRecord({ idbFactory: fakeIdb.createFactory() });
    expect(metaBefore?.deviceRevision).toBe(10);

    // Path 1: Receiving tab (Tab B) receives vault_changed { version: null } when vault is now 404 ->
    // purges once in broadcast handler and reloadVaultMeta() 404 branch is a no-op (deviceRevision: 10 -> 11).
    vaultReturnedPresent = false;
    currentMe = makeMeFixture({
      userId: '11111111-1111-1111-1111-111111111111',
      vaultStatus: 'absent',
      autoLockMinutes: 15,
    });
    const externalPeer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      // Mark Tab A as already purged so this step isolates Tab B's receiving-tab behavior
      tabAVault.markResetPurged('vk:reset-target-vs-r4-1');
      externalPeer.postMessage({
        type: 'vault_changed',
        vault_key_id: 'vk:reset-target-vs-r4-1',
        version: null,
      });
    });
    externalPeer.close();

    await waitFor(() => {
      expect(screen.getByTestId('vs-r4-1-tab-b')).toHaveTextContent('no_vault');
    });
    // Even if Tab B calls reloadVaultMeta() again on the same 404 reset transition, it stays a no-op
    await act(async () => {
      await tabBVault.reloadVaultMeta();
    });

    const metaAfterReceivingTab = await readDeviceMetaRecord({ idbFactory: fakeIdb.createFactory() });
    expect(metaAfterReceivingTab?.deviceRevision).toBe(11);

    // Path 2: Acting tab (Tab A) resets a second vault ('vk:reset-target-vs-r4-1-b'), its dialog purges once
    // and marks the reset transition via markResetPurged('vk:reset-target-vs-r4-1-b') (or notifyVaultChanged),
    // post-reset /me fails, and the user clicks 'Reload vault' (tabAVault.reloadVaultMeta() -> 404) ->
    // reloadVaultMeta()'s 404 branch is a no-op (deviceRevision: 11 -> 12, never 13).
    // Production vault_key_ids are unique per reset, so the second vault needs a new id (the first one is retired).
    vaultKeyId = 'vk:reset-target-vs-r4-1-b';
    vaultReturnedPresent = true;
    await act(async () => {
      await tabAVault.reloadVaultMeta();
    });
    vaultReturnedPresent = false;
    await act(async () => {
      // Acting tab's reset dialog purges once and marks the reset transition purged
      await purgeDeviceKeysOnRevoked('11111111-1111-1111-1111-111111111111', {
        idbFactory: fakeIdb.createFactory(),
      });
      tabAVault.markResetPurged('vk:reset-target-vs-r4-1-b');
    });
    const metaAfterDialogPurge = await readDeviceMetaRecord({ idbFactory: fakeIdb.createFactory() });
    expect(metaAfterDialogPurge?.deviceRevision).toBe(12);

    // User later clicks 'Reload vault' on the acting tab -> GET /vault returns 404 -> no second purge
    await act(async () => {
      await tabAVault.reloadVaultMeta();
    });
    const metaAfterReloadVaultClick = await readDeviceMetaRecord({
      idbFactory: fakeIdb.createFactory(),
    });
    expect(metaAfterReloadVaultClick?.deviceRevision).toBe(12);
  });

  it('VW-AUTH-E2E: lock clears [data-vault-secret] inputs and textareas while preserving non-vault <input type="password"> fields (login/signup/reauth)', async () => {
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
    const workerFactory = makeShimmedWorkerFactory();
    const lockEpochEnv = makeLockEpochEnv();
    function SecretScopeProbe() {
      vaultCtx = useVault();
      return (
        <div>
          <output data-testid="vw-auth-state">{vaultCtx.state}</output>
          <input
            type="password"
            name="password"
            data-testid="auth-login-password"
            defaultValue="login-password-preserved-123"
          />
          <input
            type="password"
            data-vault-secret="true"
            data-testid="vault-secret-input"
            defaultValue="vault-passphrase-wiped-456"
          />
          <textarea
            data-vault-secret="true"
            data-testid="vault-secret-textarea"
            defaultValue="vault-recovery-secret-wiped-789"
          />
        </div>
      );
    }

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <VaultProvider createWorker={workerFactory} lockEpochEnv={lockEpochEnv}>
            <SecretScopeProbe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('vw-auth-state')).toHaveTextContent('locked');
    });

    const authPasswordInput = screen.getByTestId('auth-login-password') as HTMLInputElement;
    const vaultSecretInput = screen.getByTestId('vault-secret-input') as HTMLInputElement;
    const vaultSecretTextarea = screen.getByTestId('vault-secret-textarea') as HTMLTextAreaElement;

    authPasswordInput.value = 'login-password-preserved-123';
    vaultSecretInput.value = 'vault-passphrase-wiped-456';
    vaultSecretTextarea.value = 'vault-recovery-secret-wiped-789';

    await act(async () => {
      await vaultCtx.lockNow();
    });

    expect(authPasswordInput.value).toBe('login-password-preserved-123');
    expect(vaultSecretInput.value).toBe('');
    expect(vaultSecretTextarea.value).toBe('');
  });

  it('BE2-2, BE2-6, BE2-7, BE2-9 & VS-R7-1: overlapping wake/recovery verification preserves verifying gate, fails closed on 5s deadline, fences stale reset purge, and bridges reactive state', async () => {
    const t0 = new Date('2026-10-29T10:00:00.000Z').getTime();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);

    const currentMe = makeMeFixture({ vaultStatus: 'present', autoLockMinutes: 0 });
    let holdMe = false;
    let resolveMe: (() => void) | null = null;
    const currentVaultVersion = 2;
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
        if (holdMe) {
          await new Promise<void>((resolve) => {
            resolveMe = resolve;
          });
        }
        return jsonResponse(currentMe);
      }
      if (u.endsWith('/vault')) {
        return jsonResponse({
          vault_key_id: 'vk:be2-overlap',
          version: currentVaultVersion,
          kdf: {
            alg: 'argon2id13',
            ops: 3,
            mem: 67108864,
            parallelism: 1,
            salt: 'dGVzdC1zYWx0LTE2Ynl0ZXM',
          },
          vault_key_wrapped_by_kek: 'd3JhcHBlZC12aw',
          x25519_public: 'eDI1NTE5LXB1Yg',
          ed25519_public: 'ZWQyNTUxOS1wdWI',
          private_keys_wrapped: 'd3JhcHBlZC1wcml2',
          recovery_keys_remaining: 10,
        });
      }
      return jsonResponse({});
    });

    let holdVerifyCount = 0;
    const pendingVerifies: Array<() => void> = [];
    const idbFactory = fakeIdb.createFactory();
    const baseLockManager = fakeLocks.createLockManager();
    const gatedLockManager: LockManager = {
      request(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
        maybeCallback?: LockGrantedCallback<unknown>,
      ): Promise<unknown> {
        const cb =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
        if (holdVerifyCount > 0) {
          holdVerifyCount -= 1;
          return new Promise<void>((resolve) => {
            pendingVerifies.push(resolve);
          }).then(() => baseLockManager.request(name, { mode: 'exclusive' }, cb));
        }
        return baseLockManager.request(name, { mode: 'exclusive' }, cb);
      },
      query: () => Promise.resolve({ held: [], pending: [] }),
    } as unknown as LockManager;

    const lockEpochEnv: LockEpochEnvironment = {
      idbFactory,
      locksManager: gatedLockManager,
    };

    let vaultCtx!: VaultContextValue;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Probe() {
      vaultCtx = useVault();
      const bodyQuery = useQuery({
        queryKey: vaultBodyQueryKey('be2-overlap-entry'),
        queryFn: () => 'be2-overlap-decrypted-secret',
        enabled: vaultCtx.state === 'unlocked',
      });
      return (
        <div>
          <output data-testid="be2-overlap-state">{vaultCtx.state}</output>
          <output data-testid="be2-overlap-worker">{vaultCtx.workerState}</output>
          <output data-testid="be2-overlap-body">
            {vaultCtx.state === 'unlocked' && bodyQuery.data ? bodyQuery.data : 'locked-surface'}
          </output>
        </div>
      );
    }

    render(
      <QueryClientProvider client={qc}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={lockEpochEnv}
            deviceStoreEnv={{ idbFactory }}
          >
            <Probe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('be2-overlap-state')).toHaveTextContent('locked');
    });

    const op1 = vaultCtx.beginOp();
    let created!: CreateVaultResult;
    await act(async () => {
      created = await vaultCtx.createVault({
        passphrase: 'be2-overlap-passphrase-1234',
        opGeneration: op1.opGeneration,
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId('be2-overlap-state')).toHaveTextContent('unlocked');
      expect(screen.getByTestId('be2-overlap-body')).toHaveTextContent(
        'be2-overlap-decrypted-secret',
      );
    });

    // VS-R7-1: window.__engramVaultTestBridge exposes reactive getters matching live provider state
    const winBridge = (
      window as unknown as {
        __engramVaultTestBridge?: VaultContextValue;
      }
    ).__engramVaultTestBridge;
    expect(winBridge).toBeDefined();
    expect(winBridge?.state).toBe('unlocked');

    // 1. BE2-5: Trigger two burst wake events (`focus` then `pageshow`) for the same generation/sessionEpoch/wakeSeq ->
    // verifyOnWake coalesces same-session burst wakes into a single Web Lock verification while holding plaintext gated (`unlocking`).
    holdVerifyCount = 1;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(pendingVerifies).toHaveLength(1);
    expect(screen.getByTestId('be2-overlap-state')).toHaveTextContent('unlocking');
    expect(winBridge?.state).toBe('unlocking');
    expect(screen.getByTestId('be2-overlap-body')).toHaveTextContent('locked-surface');

    // Release the coalesced wake verification -> verification and Me refresh complete, returning to 'unlocked'
    await act(async () => {
      pendingVerifies.shift()?.();
    });
    await waitFor(() => {
      expect(screen.getByTestId('be2-overlap-state')).toHaveTextContent('unlocked');
      expect(screen.getByTestId('be2-overlap-body')).toHaveTextContent(
        'be2-overlap-decrypted-secret',
      );
    });

    // 2. BE2-7: A second wake event while Wake #1's Me refresh is already at 4s MUST NOT reset Wake #1's 5s fail-closed deadline.
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(t0 + 10_000);
    holdMe = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    // Advance 4s (1s before Wake #1's 5s deadline) and fire a second wake event (`pageshow`)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
      window.dispatchEvent(new Event('pageshow'));
    });
    // Advance 1.1s more (5.1s since Wake #1 started, only 1.1s since Wake #2) -> Wake #1's 5s deadline MUST fire and lock fail-closed!
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(screen.getByTestId('be2-overlap-state')).toHaveTextContent('locked');
    expect(winBridge?.state).toBe('locked');
    holdMe = false;
    const unblockMe: (() => void) | null = resolveMe;
    if (unblockMe !== null) {
      (unblockMe as () => void)();
    }

    // 3. BE2-2: While in `recovering`, a remote sibling lock increments durable `lockEpoch` and wake verification runs while `auto_lock_minutes === 0` (`Never`).
    // Wake verification MUST run in `recovering`, detect the durable lockEpoch mismatch, and lock fail-closed!
    vi.useRealTimers();
    const rk0 = created.recovery_keys[0]!;
    const opRec = vaultCtx.beginOp();
    await act(async () => {
      await vaultCtx.unlockRecovery({
        recoveryKey: rk0.display,
        opGeneration: opRec.opGeneration,
      });
    });
    await act(async () => {
      await vaultCtx.resumeRecovery({
        wrap: rk0.wrap,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: opRec.opGeneration,
      });
    });
    expect(screen.getByTestId('be2-overlap-state')).toHaveTextContent('recovering');
    expect(screen.getByTestId('be2-overlap-worker')).toHaveTextContent('recovering');

    // Sibling tab locks and increments durable lockEpoch while BroadcastChannel was missed
    await act(async () => {
      await recordLockEpochEvent(vaultCtx.tabKnownLockEpoch, {
        idbFactory,
        locksManager: baseLockManager,
      });
    });
    // Trigger wake while recovering -> wake verification runs in 'recovering' and locks immediately on lockEpoch mismatch!
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('be2-overlap-state')).toHaveTextContent('locked');
      expect(screen.getByTestId('be2-overlap-worker')).toHaveTextContent('locked');
    });
  });

  // ---------------------------------------------------------------------------
  // review-2-delta-be BE2-2/5/6/7/8/9 + BE1-6 (V1) / BE1-8 regression tests.
  // One scenario per test: each drives the real race (held request, sibling lock, aborted purge) and asserts the
  // observable fail-closed outcome. Real timers are used unless a 5s deadline has to be crossed; the Worker shim
  // runs on a real `MessageChannel`, so fake timers are only armed AFTER the held step has been reached.
  // ---------------------------------------------------------------------------
  const BE2_USER_ID = '11111111-1111-1111-1111-111111111111';
  const BE2_KDF = {
    alg: 'argon2id13',
    ops: 3,
    mem: 67108864,
    parallelism: 1,
    salt: 'dGVzdC1zYWx0LTE2Ynl0ZXM',
  };

  function be2VaultBody(vaultKeyId: string, version: number) {
    return {
      vault_key_id: vaultKeyId,
      version,
      kdf: BE2_KDF,
      vault_key_wrapped_by_kek: 'd3JhcHBlZC12aw',
      x25519_public: 'eDI1NTE5LXB1Yg',
      ed25519_public: 'ZWQyNTUxOS1wdWI',
      private_keys_wrapped: 'd3JhcHBlZC1wcml2',
      recovery_keys_remaining: 10,
    };
  }

  function be2VaultAbsentResponse(): Response {
    return new Response(
      JSON.stringify({
        type: 'https://engram.zone17th.click/problems/vault_absent',
        title: 'vault_absent',
        status: 404,
        code: 'vault_absent',
      }),
      { status: 404, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  function sleepReal(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function mockBe2Fetch(
    handlers: {
      me?: () => Response | Promise<Response>;
      vault?: () => Response | Promise<Response>;
    } = {},
  ) {
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
        return handlers.me
          ? handlers.me()
          : jsonResponse(
              makeMeFixture({ userId: BE2_USER_ID, vaultStatus: 'present', autoLockMinutes: 15 }),
            );
      }
      if (u.endsWith('/vault')) {
        return handlers.vault
          ? handlers.vault()
          : jsonResponse(be2VaultBody('vk:be2-default', 1));
      }
      return jsonResponse({});
    });
  }

  function renderBe2Provider(
    testId: string,
    lockEpochEnv: LockEpochEnvironment,
    queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  ): { vault: () => VaultContextValue } {
    const holder: { ctx: VaultContextValue | null } = { ctx: null };
    function Probe() {
      const ctx = useVault();
      holder.ctx = ctx;
      return (
        <div>
          <output data-testid={`${testId}-state`}>{ctx.state}</output>
          <output data-testid={`${testId}-worker`}>{ctx.workerState}</output>
        </div>
      );
    }
    render(
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={lockEpochEnv}
            deviceStoreEnv={{ idbFactory: lockEpochEnv.idbFactory }}
          >
            <Probe />
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>,
    );
    return {
      vault: () => {
        if (!holder.ctx) throw new Error('VaultProvider probe has not rendered yet');
        return holder.ctx;
      },
    };
  }

  async function be2CreateVault(
    getVault: () => VaultContextValue,
    passphrase: string,
  ): Promise<CreateVaultResult> {
    const op = getVault().beginOp();
    const out: { value: CreateVaultResult | null } = { value: null };
    await act(async () => {
      out.value = await getVault().createVault({ passphrase, opGeneration: op.opGeneration });
    });
    if (!out.value) throw new Error('createVault did not resolve');
    return out.value;
  }

  function seedBe2DeviceMeta(deviceRevision: number) {
    fakeIdb.ensureStore(META_STORE_NAME).set(DEVICE_META_RECORD_KEY, {
      key: DEVICE_META_RECORD_KEY,
      incarnation: 'be2-initial-incarnation',
      deviceRevision,
    });
  }

  it('BE1-8: reloadVaultMeta performs a fresh network GET /vault even while the cached query is within staleTime and applies the new server version', async () => {
    let vaultVersion = 1;
    let getVaultNetworkCalls = 0;
    mockBe2Fetch({
      vault: () => {
        getVaultNetworkCalls += 1;
        return jsonResponse(be2VaultBody('vk:be2-reload', vaultVersion));
      },
    });
    const idbFactory = fakeIdb.createFactory();
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    const { vault } = renderBe2Provider(
      'be18-reload',
      { idbFactory, locksManager: fakeLocks.createLockManager() },
      qc,
    );
    await waitFor(() => {
      expect(screen.getByTestId('be18-reload-state')).toHaveTextContent('locked');
    });

    // The provider never fetches GET /vault on mount: vault metadata is loaded by reloadVaultMeta or unlock flows.
    const first: { value: Awaited<ReturnType<VaultContextValue['reloadVaultMeta']>> } = {
      value: null,
    };
    await act(async () => {
      first.value = await vault().reloadVaultMeta();
    });
    expect(getVaultNetworkCalls).toBe(1);
    expect(first.value?.version).toBe(1);

    vaultVersion = 2;
    const second: { value: Awaited<ReturnType<VaultContextValue['reloadVaultMeta']>> } = {
      value: null,
    };
    await act(async () => {
      second.value = await vault().reloadVaultMeta();
    });
    expect(getVaultNetworkCalls).toBe(2);
    expect(second.value?.version).toBe(2);
    expect(vault().vaultMeta?.version).toBe(2);
  }, 15_000);

  it('BE2-8: a failed reset purge is never cached as committed; repeated reset discovery after storage recovers deletes the DevKey and advances the device fence exactly once', async () => {
    const held: { release: ((res: Response) => void) | null } = { release: null };
    let holdNextVaultGet = false;
    let vaultPresent = true;
    mockBe2Fetch({
      vault: () => {
        if (holdNextVaultGet) {
          holdNextVaultGet = false;
          return new Promise<Response>((resolve) => {
            held.release = resolve;
          });
        }
        return vaultPresent
          ? jsonResponse(be2VaultBody('vk:be2-8-a', 1))
          : be2VaultAbsentResponse();
      },
    });
    const idbFactory = fakeIdb.createFactory();
    const { vault } = renderBe2Provider('be28-purge', {
      idbFactory,
      locksManager: fakeLocks.createLockManager(),
    });
    await waitFor(() => {
      expect(screen.getByTestId('be28-purge-state')).toHaveTextContent('locked');
    });
    await act(async () => {
      await vault().reloadVaultMeta();
    });
    expect(vault().vaultMeta?.vault_key_id).toBe('vk:be2-8-a');

    seedBe2DeviceMeta(10);
    const devkeyRecordKey = formatDevKeyRecordKey(BE2_USER_ID, 'vk:be2-8-a');
    const devkeys = fakeIdb.ensureStore(DEVKEY_STORE_NAME);
    devkeys.set(devkeyRecordKey, {
      user_id: BE2_USER_ID,
      vault_key_id: 'vk:be2-8-a',
      wrapped_vk: new Uint8Array([1, 2, 3]),
    });

    // Phase 1: the reset is discovered via broadcast while the purge transaction aborts before commit and the
    // follow-up GET /vault is still in flight -> nothing is deleted and the failed attempt is not remembered.
    holdNextVaultGet = true;
    vaultPresent = false;
    fakeIdb.options.abortBeforeCompleteOnStore = META_STORE_NAME;
    const peer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      peer.postMessage({ type: 'vault_changed', vault_key_id: 'vk:be2-8-a', version: null });
      await sleepReal(50);
    });
    expect(held.release).not.toBeNull();
    const metaAfterFailedPurge = await readDeviceMetaRecord({ idbFactory });
    expect(metaAfterFailedPurge?.deviceRevision).toBe(10);
    expect(devkeys.has(devkeyRecordKey)).toBe(true);

    // Phase 2: storage recovers and the same reset is discovered again (404 on the held reload) -> the retry runs.
    fakeIdb.options.abortBeforeCompleteOnStore = undefined;
    await act(async () => {
      held.release?.(be2VaultAbsentResponse());
      await sleepReal(50);
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory });
      expect(meta?.deviceRevision).toBe(11);
    });
    expect(devkeys.has(devkeyRecordKey)).toBe(false);

    // The successful attempt advanced the fence exactly once.
    await sleepReal(50);
    const metaAfterRetry = await readDeviceMetaRecord({ idbFactory });
    expect(metaAfterRetry?.deviceRevision).toBe(11);
    peer.close();
  }, 15_000);

  it('BE2-9: a purge receipt for reset vault A never suppresses the purge for vault B, while a duplicate reset of A is skipped', async () => {
    let currentVaultKeyId = 'vk:be2-9-a';
    mockBe2Fetch({ vault: () => jsonResponse(be2VaultBody(currentVaultKeyId, 1)) });
    const idbFactory = fakeIdb.createFactory();
    const { vault } = renderBe2Provider('be29-receipt', {
      idbFactory,
      locksManager: fakeLocks.createLockManager(),
    });
    await waitFor(() => {
      expect(screen.getByTestId('be29-receipt-state')).toHaveTextContent('locked');
    });
    await act(async () => {
      await vault().reloadVaultMeta();
    });
    expect(vault().vaultMeta?.vault_key_id).toBe('vk:be2-9-a');
    seedBe2DeviceMeta(10);

    // Reset A already purged on this device (positive identity) -> a duplicate reset message for A must not purge again.
    vault().markResetPurged('vk:be2-9-a');
    currentVaultKeyId = 'vk:be2-9-b';
    const peer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      peer.postMessage({ type: 'vault_changed', vault_key_id: 'vk:be2-9-a', version: null });
      await sleepReal(50);
    });
    await waitFor(() => {
      expect(vault().vaultMeta?.vault_key_id).toBe('vk:be2-9-b');
    });
    const metaAfterDuplicate = await readDeviceMetaRecord({ idbFactory });
    expect(metaAfterDuplicate?.deviceRevision).toBe(10);

    // Reset B is a different vault: A's receipt must not suppress its purge.
    await act(async () => {
      peer.postMessage({ type: 'vault_changed', vault_key_id: 'vk:be2-9-b', version: null });
      await sleepReal(50);
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory });
      expect(meta?.deviceRevision).toBe(11);
    });
    peer.close();
  }, 15_000);

  it('BE2-2: wake verification keeps a matching session and still locks fail-closed on a durable lockEpoch mismatch when Promise.withResolvers is unavailable', async () => {
    mockBe2Fetch();
    const idbFactory = fakeIdb.createFactory();
    const lockEpochEnv: LockEpochEnvironment = {
      idbFactory,
      locksManager: fakeLocks.createLockManager(),
    };
    const { vault } = renderBe2Provider('be22-wake', lockEpochEnv);
    await waitFor(() => {
      expect(screen.getByTestId('be22-wake-state')).toHaveTextContent('locked');
    });
    await be2CreateVault(vault, 'be2-wake-passphrase-1234');
    expect(screen.getByTestId('be22-wake-state')).toHaveTextContent('unlocked');

    const origWithResolvers = Promise.withResolvers;
    try {
      // Simulate a runtime without Promise.withResolvers (Safari < 17.4, Chrome < 119)
      (Promise as unknown as { withResolvers?: unknown }).withResolvers = undefined;

      // Matching durable marker -> wake verification passes and the session stays unlocked
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('be22-wake-state')).toHaveTextContent('unlocked');
      });

      // A sibling tab advanced the durable lockEpoch and this tab missed the broadcast -> wake must lock
      await act(async () => {
        await recordLockEpochEvent(vault().tabKnownLockEpoch, lockEpochEnv);
      });
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() => {
        expect(screen.getByTestId('be22-wake-state')).toHaveTextContent('locked');
        expect(screen.getByTestId('be22-wake-worker')).toHaveTextContent('locked');
      });
    } finally {
      Promise.withResolvers = origWithResolvers;
    }
  }, 15_000);

  it('BE2-5: a replacement session wake is not swallowed by an obsolete wake promise that is still waiting on GET /auth/me', async () => {
    const held: { releaseMe: (() => void) | null } = { releaseMe: null };
    let holdWakeMe = false;
    mockBe2Fetch({
      me: async () => {
        if (holdWakeMe) {
          await new Promise<void>((resolve) => {
            held.releaseMe = resolve;
          });
        }
        return jsonResponse(
          makeMeFixture({ userId: BE2_USER_ID, vaultStatus: 'present', autoLockMinutes: 15 }),
        );
      },
    });
    const idbFactory = fakeIdb.createFactory();
    const lockEpochEnv: LockEpochEnvironment = {
      idbFactory,
      locksManager: fakeLocks.createLockManager(),
    };
    const { vault } = renderBe2Provider('be25-wake', lockEpochEnv);
    await waitFor(() => {
      expect(screen.getByTestId('be25-wake-state')).toHaveTextContent('locked');
    });
    const created = await be2CreateVault(vault, 'be2-replacement-passphrase-1234');
    expect(screen.getByTestId('be25-wake-state')).toHaveTextContent('unlocked');

    // Old wake: its Me refresh is held, so plaintext stays gated.
    holdWakeMe = true;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByTestId('be25-wake-state')).toHaveTextContent('unlocking');
    await waitFor(() => {
      expect(held.releaseMe).not.toBeNull();
    });

    // Lock and unlock a replacement session while the old wake is still waiting.
    await act(async () => {
      await vault().lockNow();
    });
    await waitFor(() => {
      expect(screen.getByTestId('be25-wake-state')).toHaveTextContent('locked');
    });
    const op2 = vault().beginOp();
    await act(async () => {
      await vault().unlockPassphrase({
        passphrase: 'be2-replacement-passphrase-1234',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: op2.opGeneration,
      });
    });
    expect(screen.getByTestId('be25-wake-state')).toHaveTextContent('unlocked');

    // A sibling advances the durable lockEpoch (missed broadcast) and the replacement session wakes while the old wake
    // is still pending: the new wake must run its own verification and lock.
    holdWakeMe = false;
    await act(async () => {
      await recordLockEpochEvent(vault().tabKnownLockEpoch, lockEpochEnv);
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('be25-wake-state')).toHaveTextContent('locked');
      expect(screen.getByTestId('be25-wake-worker')).toHaveTextContent('locked');
    });

    // Releasing the obsolete wake never revives or re-locks anything.
    await act(async () => {
      held.releaseMe?.();
      await sleepReal(20);
    });
    expect(screen.getByTestId('be25-wake-state')).toHaveTextContent('locked');
  }, 15_000);

  it('BE2-6 & BE1-6 (V1): a rejected VAULT_RECOVERING unlock preserves the recovery baseline, and a real sibling VaultProvider.lock cancels recovery, wipes the VK and rejects confirmRecovery', async () => {
    mockBe2Fetch();
    const idbFactory = fakeIdb.createFactory();
    const locksManager = fakeLocks.createLockManager();

    const holder: { a: VaultContextValue | null; b: VaultContextValue | null } = {
      a: null,
      b: null,
    };
    function ProbeA() {
      const ctx = useVault();
      holder.a = ctx;
      return (
        <div>
          <output data-testid="be26-state-a">{ctx.state}</output>
          <output data-testid="be26-worker-a">{ctx.workerState}</output>
        </div>
      );
    }
    function ProbeB() {
      const ctx = useVault();
      holder.b = ctx;
      return <output data-testid="be26-state-b">{ctx.state}</output>;
    }
    const qcA = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const qcB = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <div>
        <QueryClientProvider client={qcA}>
          <SessionProvider>
            <VaultProvider
              createWorker={makeShimmedWorkerFactory()}
              lockEpochEnv={{ idbFactory, locksManager }}
              deviceStoreEnv={{ idbFactory }}
            >
              <ProbeA />
            </VaultProvider>
          </SessionProvider>
        </QueryClientProvider>
        <QueryClientProvider client={qcB}>
          <SessionProvider>
            <VaultProvider
              createWorker={makeShimmedWorkerFactory()}
              lockEpochEnv={{ idbFactory, locksManager }}
              deviceStoreEnv={{ idbFactory }}
            >
              <ProbeB />
            </VaultProvider>
          </SessionProvider>
        </QueryClientProvider>
      </div>,
    );
    const vaultA = () => {
      if (!holder.a) throw new Error('probe A has not rendered yet');
      return holder.a;
    };
    const vaultB = () => {
      if (!holder.b) throw new Error('probe B has not rendered yet');
      return holder.b;
    };
    await waitFor(() => {
      expect(screen.getByTestId('be26-state-a')).toHaveTextContent('locked');
      expect(screen.getByTestId('be26-state-b')).toHaveTextContent('locked');
    });

    const created = await be2CreateVault(vaultA, 'be2-recovery-passphrase-1234');
    expect(screen.getByTestId('be26-state-a')).toHaveTextContent('unlocked');
    await act(async () => {
      await vaultA().lockNow();
    });
    await waitFor(() => {
      expect(screen.getByTestId('be26-state-a')).toHaveTextContent('locked');
    });

    // Enter `recovering` with a captured baseline E1.
    const rk0 = created.recovery_keys[0]!;
    const opRec = vaultA().beginOp();
    await act(async () => {
      await vaultA().unlockRecovery({
        recoveryKey: rk0.display,
        opGeneration: opRec.opGeneration,
      });
      await vaultA().resumeRecovery({
        wrap: rk0.wrap,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: opRec.opGeneration,
      });
    });
    expect(screen.getByTestId('be26-state-a')).toHaveTextContent('recovering');
    const baselineE1 = vaultA().unlockBaseline;
    expect(baselineE1).not.toBeNull();

    // A passphrase unlock while recovering is rejected and MUST NOT erase the recovery baseline (BE2-6).
    const recoveringErr: { value: unknown } = { value: null };
    await act(async () => {
      try {
        await vaultA().unlockPassphrase({
          passphrase: 'be2-recovery-passphrase-1234',
          kdf: created.kdf,
          vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
          privateKeysWrapped: created.private_keys_wrapped,
          opGeneration: opRec.opGeneration,
        });
      } catch (err) {
        recoveringErr.value = err;
      }
    });
    expect(recoveringErr.value).toMatchObject({ code: 'VAULT_RECOVERING' });
    expect(vaultA().unlockBaseline).toEqual(baselineE1);
    expect(vaultA().workerState).toBe('recovering');

    // A real sibling provider locks mid-recovery (durable lockEpoch increment + broadcast) -> A fails closed.
    await act(async () => {
      await vaultB().lockNow();
    });
    await waitFor(() => {
      expect(screen.getByTestId('be26-state-a')).toHaveTextContent('locked');
      expect(screen.getByTestId('be26-worker-a')).toHaveTextContent('locked');
    });
    expect(vaultA().unlockBaseline).toBeNull();

    // The cancelled recovery can no longer be confirmed.
    const confirmErr: { value: unknown } = { value: null };
    await act(async () => {
      try {
        await vaultA().confirmRecovery({ opGeneration: opRec.opGeneration });
      } catch (err) {
        confirmErr.value = err;
      }
    });
    expect(confirmErr.value).toMatchObject({ code: 'STALE_GENERATION' });
    expect(screen.getByTestId('be26-state-a')).toHaveTextContent('locked');
  }, 20_000);

  it('BE2-7: a post-unlock lockEpoch verification that never settles is cut off at the 5s deadline, the Worker locks and a late completion cannot revive the session', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const held: { release: (() => void) | null } = { release: null };
    let holdPostUnlockVerify = false;
    const idbFactory = fakeIdb.createFactory();
    const baseLockManager = fakeLocks.createLockManager();
    const gatedLockManager: LockManager = {
      request(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
        maybeCallback?: LockGrantedCallback<unknown>,
      ): Promise<unknown> {
        const cb =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
        if (holdPostUnlockVerify) {
          holdPostUnlockVerify = false;
          return new Promise<void>((resolve) => {
            held.release = resolve;
          }).then(() => baseLockManager.request(name, { mode: 'exclusive' }, cb));
        }
        return baseLockManager.request(name, { mode: 'exclusive' }, cb);
      },
      query: () => Promise.resolve({ held: [], pending: [] }),
    } as unknown as LockManager;

    mockBe2Fetch();
    const { vault } = renderBe2Provider('be27-deadline', {
      idbFactory,
      locksManager: gatedLockManager,
    });
    await waitFor(() => {
      expect(screen.getByTestId('be27-deadline-state')).toHaveTextContent('locked');
    });
    const created = await be2CreateVault(vault, 'be2-deadline-passphrase-1234');
    await act(async () => {
      await vault().lockNow();
    });
    await waitFor(() => {
      expect(screen.getByTestId('be27-deadline-state')).toHaveTextContent('locked');
    });

    // Only the timeouts are faked, and only now: everything before this point needs real timers.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const op = vault().beginOp();
      const unlockErr: { value: unknown } = { value: null };
      const unlockPromise = vault()
        .unlockPassphrase({
          passphrase: 'be2-deadline-passphrase-1234',
          kdf: created.kdf,
          vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
          privateKeysWrapped: created.private_keys_wrapped,
          opGeneration: op.opGeneration,
          beforePostMessage: () => {
            holdPostUnlockVerify = true;
          },
        })
        .catch((err: unknown) => {
          unlockErr.value = err;
        });

      // Wait (on real timers) until the post-unlock verification is parked; its 5s deadline timer already exists.
      await act(async () => {
        for (let i = 0; i < 400 && held.release === null; i += 1) {
          await new Promise<void>((resolve) => {
            realSetTimeout(resolve, 5);
          });
        }
      });
      expect(held.release).not.toBeNull();
      expect(screen.getByTestId('be27-deadline-state')).not.toHaveTextContent('unlocked');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_200);
      });
      await act(async () => {
        await unlockPromise;
      });
      expect(unlockErr.value).toMatchObject({ code: 'STALE_GENERATION' });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => {
      expect(screen.getByTestId('be27-deadline-state')).toHaveTextContent('locked');
      expect(screen.getByTestId('be27-deadline-worker')).toHaveTextContent('locked');
    });

    // A late completion of the abandoned verification never revives the session.
    await act(async () => {
      held.release?.();
      await sleepReal(30);
    });
    expect(screen.getByTestId('be27-deadline-state')).toHaveTextContent('locked');
    expect(screen.getByTestId('be27-deadline-worker')).toHaveTextContent('locked');
  }, 20_000);

  it('BE1-8 (out-of-order): a stale same-user reloadVaultMeta response never overwrites a newer one', async () => {
    const pendingVaultGets: Array<(res: Response) => void> = [];
    mockBe2Fetch({
      vault: () =>
        new Promise<Response>((resolve) => {
          pendingVaultGets.push(resolve);
        }),
    });
    const idbFactory = fakeIdb.createFactory();
    const { vault } = renderBe2Provider('be18-order', {
      idbFactory,
      locksManager: fakeLocks.createLockManager(),
    });
    await waitFor(() => {
      expect(screen.getByTestId('be18-order-state')).toHaveTextContent('locked');
    });

    const results: {
      req1: Awaited<ReturnType<VaultContextValue['reloadVaultMeta']>> | undefined;
      req2: Awaited<ReturnType<VaultContextValue['reloadVaultMeta']>> | undefined;
    } = { req1: undefined, req2: undefined };
    const p1 = vault()
      .reloadVaultMeta()
      .then((r) => {
        results.req1 = r;
      });
    const p2 = vault()
      .reloadVaultMeta()
      .then((r) => {
        results.req2 = r;
      });
    await waitFor(() => {
      expect(pendingVaultGets).toHaveLength(2);
    });

    await act(async () => {
      // Resolve the newer request #2 (version 5) first, then the older request #1 (version 1).
      pendingVaultGets[1]!(jsonResponse(be2VaultBody('vk:be2-order', 5)));
      await p2;
      pendingVaultGets[0]!(jsonResponse(be2VaultBody('vk:be2-order', 1)));
      await p1;
    });
    expect(results.req2?.version).toBe(5);
    // BE3-9: a superseded present response reports the authoritative newer metadata, never a bare `null`
    // (which callers read as `vault_absent`).
    expect(results.req1?.version).toBe(5);
    expect(vault().vaultMeta?.version).toBe(5);
  }, 15_000);

  // ---------------------------------------------------------------------------
  // BE3-7 / BE3-9 (fix round 3): metadata response ordering vs. fail-closed reset handling.
  // Only a NEWER request whose outcome was applied may supersede an older response; a newer request that merely
  // started, stalled or failed is not evidence about vault state.
  // ---------------------------------------------------------------------------
  function be3ProblemResponse(status: number, code: string): Response {
    return new Response(
      JSON.stringify({ type: `https://engram.zone17th.click/problems/${code}`, title: code, status, code }),
      { status, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  async function be37Setup(prefix: string) {
    const pending: Array<(res: Response) => void> = [];
    const gate = { hold: false };
    mockBe2Fetch({
      vault: () =>
        gate.hold
          ? new Promise<Response>((resolve) => {
              pending.push(resolve);
            })
          : jsonResponse(be2VaultBody('vk:be3-7', 1)),
    });
    const idbFactory = fakeIdb.createFactory();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { vault } = renderBe2Provider(
      prefix,
      { idbFactory, locksManager: fakeLocks.createLockManager() },
      qc,
    );
    await waitFor(() => {
      expect(screen.getByTestId(`${prefix}-state`)).toHaveTextContent('locked');
    });
    await be2CreateVault(vault, 'be3-7-passphrase-1234');
    expect(screen.getByTestId(`${prefix}-state`)).toHaveTextContent('unlocked');
    await act(async () => {
      await vault().reloadVaultMeta();
    });
    expect(vault().vaultMeta?.vault_key_id).toBe('vk:be3-7');

    seedBe2DeviceMeta(10);
    const devkeyRecordKey = formatDevKeyRecordKey(BE2_USER_ID, 'vk:be3-7');
    const devkeys = fakeIdb.ensureStore(DEVKEY_STORE_NAME);
    devkeys.set(devkeyRecordKey, {
      user_id: BE2_USER_ID,
      vault_key_id: 'vk:be3-7',
      wrapped_vk: new Uint8Array([1, 2, 3]),
    });
    qc.setQueryData(vaultBodyQueryKey('be37-entry'), 'be3-7-decrypted-body');
    return { vault, qc, idbFactory, pending, gate, devkeys, devkeyRecordKey, prefix };
  }

  async function expectBe37LockedAndPurged(
    ctx: Pick<
      Awaited<ReturnType<typeof be37Setup>>,
      'prefix' | 'vault' | 'qc' | 'idbFactory' | 'devkeys' | 'devkeyRecordKey'
    >,
  ) {
    await waitFor(() => {
      expect(screen.getByTestId(`${ctx.prefix}-state`)).toHaveTextContent('locked');
      expect(screen.getByTestId(`${ctx.prefix}-worker`)).toHaveTextContent('locked');
    });
    expect(ctx.vault().vaultMeta).toBeNull();
    expect(ctx.qc.getQueryData(vaultBodyQueryKey('be37-entry'))).toBeUndefined();
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
      expect(meta?.deviceRevision).toBe(11);
    });
    expect(ctx.devkeys.has(ctx.devkeyRecordKey)).toBe(false);
  }

  it('BE3-7: an older same-session 404 vault_absent still locks, wipes and purges when the NEWER GET /vault failed', async () => {
    const ctx = await be37Setup('be37-failed');
    ctx.gate.hold = true;
    const outcome: { older: unknown; newerError: unknown } = { older: undefined, newerError: undefined };
    const olderP = ctx.vault()
      .reloadVaultMeta()
      .then((r) => {
        outcome.older = r;
      });
    const newerP = ctx.vault()
      .reloadVaultMeta()
      .catch((err: unknown) => {
        outcome.newerError = err;
      });
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(2);
    });

    // The newer request fails: that is no verified server state and must not touch the unlocked session.
    await act(async () => {
      ctx.pending[1]!(be3ProblemResponse(503, 'service_unavailable'));
      await newerP;
    });
    expect(outcome.newerError).toBeDefined();
    expect(screen.getByTestId('be37-failed-state')).toHaveTextContent('unlocked');
    expect(ctx.qc.getQueryData(vaultBodyQueryKey('be37-entry'))).toBe('be3-7-decrypted-body');

    // The older request now reports authoritative absence: fail closed immediately.
    await act(async () => {
      ctx.pending[0]!(be2VaultAbsentResponse());
      await olderP;
    });
    expect(outcome.older).toBeNull();
    await expectBe37LockedAndPurged(ctx);
  }, 20_000);

  it('BE3-7: an older same-session 404 vault_absent still locks, wipes and purges while the NEWER GET /vault is stalled, and a late newer success cannot revive access', async () => {
    const ctx = await be37Setup('be37-stalled');
    ctx.gate.hold = true;
    const outcome: { older: unknown } = { older: undefined };
    const olderP = ctx.vault()
      .reloadVaultMeta()
      .then((r) => {
        outcome.older = r;
      });
    const newerP = ctx.vault().reloadVaultMeta();
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(2);
    });

    // Newer request never settles; the older one reports authoritative absence.
    await act(async () => {
      ctx.pending[0]!(be2VaultAbsentResponse());
      await olderP;
    });
    expect(outcome.older).toBeNull();
    await expectBe37LockedAndPurged(ctx);

    // A late "present" answer from the stalled request is applied as metadata only: it never unlocks anything.
    await act(async () => {
      ctx.pending[1]!(jsonResponse(be2VaultBody('vk:be3-7', 2)));
      await newerP;
    });
    expect(screen.getByTestId('be37-stalled-state')).toHaveTextContent('locked');
    expect(screen.getByTestId('be37-stalled-worker')).toHaveTextContent('locked');
  }, 20_000);

  it('BE3-7 control: an older 404 that was superseded by a newer SUCCESSFUL response neither locks nor purges and reports the newer metadata', async () => {
    const ctx = await be37Setup('be37-control');
    ctx.gate.hold = true;
    const outcome: { older: unknown; newer: unknown } = { older: undefined, newer: undefined };
    const olderP = ctx.vault()
      .reloadVaultMeta()
      .then((r) => {
        outcome.older = r;
      });
    const newerP = ctx.vault()
      .reloadVaultMeta()
      .then((r) => {
        outcome.newer = r;
      });
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(2);
    });

    await act(async () => {
      ctx.pending[1]!(jsonResponse(be2VaultBody('vk:be3-7', 2)));
      await newerP;
    });
    await act(async () => {
      ctx.pending[0]!(be2VaultAbsentResponse());
      await olderP;
    });
    expect((outcome.newer as { version: number }).version).toBe(2);
    expect((outcome.older as { version: number } | null)?.version).toBe(2);
    expect(ctx.vault().vaultMeta?.version).toBe(2);
    expect(screen.getByTestId('be37-control-state')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('be37-control-worker')).toHaveTextContent('unlocked');
    expect(ctx.qc.getQueryData(vaultBodyQueryKey('be37-entry'))).toBe('be3-7-decrypted-body');
    expect(ctx.devkeys.has(ctx.devkeyRecordKey)).toBe(true);
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    expect(meta?.deviceRevision).toBe(10);
  }, 20_000);

  it('BE3-9: a first GET /vault that is superseded by a newer same-session request resolves with the authoritative metadata (not null), while a true 404 still resolves null and locks', async () => {
    const pending: Array<(res: Response) => void> = [];
    mockBe2Fetch({
      vault: () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    });
    const { vault } = renderBe2Provider('be39-superseded', {
      idbFactory: fakeIdb.createFactory(),
      locksManager: fakeLocks.createLockManager(),
    });
    await waitFor(() => {
      expect(screen.getByTestId('be39-superseded-state')).toHaveTextContent('locked');
    });
    const out: { first: unknown; second: unknown } = { first: 'unset', second: 'unset' };
    const firstP = vault()
      .reloadVaultMeta()
      .then((r) => {
        out.first = r;
      });
    const secondP = vault()
      .reloadVaultMeta()
      .then((r) => {
        out.second = r;
      });
    await waitFor(() => {
      expect(pending).toHaveLength(2);
    });
    // The newer request lands first; the older "present" answer is superseded and must not look like absence.
    await act(async () => {
      pending[1]!(jsonResponse(be2VaultBody('vk:be3-9', 3)));
      await secondP;
      pending[0]!(jsonResponse(be2VaultBody('vk:be3-9', 3)));
      await firstP;
    });
    expect((out.second as { version: number }).version).toBe(3);
    expect((out.first as { vault_key_id: string } | null)?.vault_key_id).toBe('vk:be3-9');
    expect(vault().vaultMeta?.vault_key_id).toBe('vk:be3-9');

    // True absence still resolves `null` (and drops the metadata).
    const absentP = vault().reloadVaultMeta();
    await waitFor(() => {
      expect(pending).toHaveLength(3);
    });
    await act(async () => {
      pending[2]!(be2VaultAbsentResponse());
      expect(await absentP).toBeNull();
    });
    expect(vault().vaultMeta).toBeNull();
  }, 20_000);

  // ---------------------------------------------------------------------------
  // BE3-1 (fix round 3): an obsolete post-unlock verification must never lock a replacement session.
  // ---------------------------------------------------------------------------
  const BE3_ENTRY_ID = '018f3a40-0000-7000-8000-000000000001';
  const BE3_KEY_ID = 'vk:ABCDEFGHIJKLMNOPQRSTUV';

  function makeGatedLockManager(base: LockManager) {
    const gate: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };
    const manager = {
      request(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
        maybeCallback?: LockGrantedCallback<unknown>,
      ): Promise<unknown> {
        const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
        if (gate.hold) {
          gate.hold = false;
          return new Promise<void>((resolve) => {
            gate.release = resolve;
          }).then(() => base.request(name, { mode: 'exclusive' }, cb));
        }
        return base.request(name, { mode: 'exclusive' }, cb);
      },
      query: () => Promise.resolve({ held: [], pending: [] }),
    } as unknown as LockManager;
    return { gate, manager };
  }

  async function waitUntil(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 400 && !predicate(); i += 1) {
      await sleepReal(5);
    }
    if (!predicate()) throw new Error('waitUntil: condition never became true');
  }

  async function be31StartObsoleteUnlock(prefix: string) {
    const { gate, manager } = makeGatedLockManager(fakeLocks.createLockManager());
    const idbFactory = fakeIdb.createFactory();
    mockBe2Fetch();
    const { vault } = renderBe2Provider(prefix, { idbFactory, locksManager: manager });
    await waitFor(() => {
      expect(screen.getByTestId(`${prefix}-state`)).toHaveTextContent('locked');
    });
    const created = await be2CreateVault(vault, 'be3-1-passphrase-1234');
    await act(async () => {
      await vault().lockNow();
    });
    await waitFor(() => {
      expect(screen.getByTestId(`${prefix}-state`)).toHaveTextContent('locked');
    });
    return { gate, vault, created };
  }

  async function be31UnlockReplacement(
    vault: () => VaultContextValue,
    created: CreateVaultResult,
  ) {
    const op = vault().beginOp();
    await act(async () => {
      await vault().unlockPassphrase({
        passphrase: 'be3-1-passphrase-1234',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: op.opGeneration,
      });
    });
  }

  async function expectBe31ReplacementUsable(prefix: string, vault: () => VaultContextValue) {
    expect(screen.getByTestId(`${prefix}-state`)).toHaveTextContent('unlocked');
    expect(screen.getByTestId(`${prefix}-worker`)).toHaveTextContent('unlocked');
    const sealed = await vault().getClient().sealEntryNow({
      entryId: BE3_ENTRY_ID,
      keyId: BE3_KEY_ID,
      plaintext: 'be3-1-replacement-secret',
    });
    const opened = await vault().getClient().openEntryNow({
      entryId: BE3_ENTRY_ID,
      envelope: sealed.envelope,
      ciphertext: sealed.ciphertext,
    });
    expect(opened.plaintext).toBe('be3-1-replacement-secret');
  }

  it('BE3-1: releasing an obsolete post-unlock verification after lock + replacement unlock rejects the old wrapper without locking the replacement session', async () => {
    const { gate, vault, created } = await be31StartObsoleteUnlock('be31-release');
    const oldOp = vault().beginOp();
    const oldOutcome: { err: unknown } = { err: null };
    const oldUnlock = vault()
      .unlockPassphrase({
        passphrase: 'be3-1-passphrase-1234',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: oldOp.opGeneration,
        beforePostMessage: () => {
          gate.hold = true;
        },
      })
      .catch((err: unknown) => {
        oldOutcome.err = err;
      });
    // Wait until the old unlock's post-Worker verification is parked on the Web Lock.
    await act(async () => {
      await waitUntil(() => gate.release !== null);
    });
    expect(screen.getByTestId('be31-release-state')).not.toHaveTextContent('unlocked');

    // Explicit lock, then a successful replacement unlock (generation G+1) while the old verifier is still held.
    await act(async () => {
      await vault().lockNow();
    });
    await be31UnlockReplacement(vault, created);
    const replacementGeneration = vault().generation;
    expect(screen.getByTestId('be31-release-state')).toHaveTextContent('unlocked');

    // Release the obsolete verification: durable marker moved (lockNow), so the old wrapper must fail closed
    // for ITSELF only.
    await act(async () => {
      gate.release?.();
      await oldUnlock;
    });
    expect(oldOutcome.err).toMatchObject({ code: 'STALE_GENERATION' });
    expect(vault().generation).toBe(replacementGeneration);
    await expectBe31ReplacementUsable('be31-release', vault);
  }, 20_000);

  it('BE3-1: the obsolete operation 5s deadline firing after lock + replacement unlock rejects the old wrapper without locking the replacement session', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const { gate, vault, created } = await be31StartObsoleteUnlock('be31-deadline');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const oldOp = vault().beginOp();
      const oldOutcome: { err: unknown } = { err: null };
      const oldUnlock = vault()
        .unlockPassphrase({
          passphrase: 'be3-1-passphrase-1234',
          kdf: created.kdf,
          vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
          privateKeysWrapped: created.private_keys_wrapped,
          opGeneration: oldOp.opGeneration,
          beforePostMessage: () => {
            gate.hold = true;
          },
        })
        .catch((err: unknown) => {
          oldOutcome.err = err;
        });
      await act(async () => {
        for (let i = 0; i < 400 && gate.release === null; i += 1) {
          await new Promise<void>((resolve) => {
            realSetTimeout(resolve, 5);
          });
        }
      });
      expect(gate.release).not.toBeNull();

      await act(async () => {
        await vault().lockNow();
      });
      await be31UnlockReplacement(vault, created);
      const replacementGeneration = vault().generation;
      expect(screen.getByTestId('be31-deadline-state')).toHaveTextContent('unlocked');

      // Cross the OLD operation's 5s verification deadline while it is still parked.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_200);
      });
      await act(async () => {
        await oldUnlock;
      });
      expect(oldOutcome.err).toMatchObject({ code: 'STALE_GENERATION' });
      expect(vault().generation).toBe(replacementGeneration);
    } finally {
      vi.useRealTimers();
    }
    await expectBe31ReplacementUsable('be31-deadline', vault);

    // A late completion of the abandoned verification still changes nothing.
    await act(async () => {
      gate.release?.();
      await sleepReal(30);
    });
    await expectBe31ReplacementUsable('be31-deadline', vault);
  }, 20_000);

  // ---------------------------------------------------------------------------
  // BE2-9 residual (fix round 3): an unnamed 404 never borrows an old purge receipt, and the setter only accepts a
  // token that matches a reset this provider observed.
  // ---------------------------------------------------------------------------
  async function be29Setup(prefix: string) {
    const gate: { mode: 'present' | 'absent'; keyId: string } = { mode: 'present', keyId: 'vk:be29-a' };
    mockBe2Fetch({
      vault: () =>
        gate.mode === 'present' ? jsonResponse(be2VaultBody(gate.keyId, 1)) : be2VaultAbsentResponse(),
    });
    const idbFactory = fakeIdb.createFactory();
    const { vault } = renderBe2Provider(prefix, {
      idbFactory,
      locksManager: fakeLocks.createLockManager(),
    });
    await waitFor(() => {
      expect(screen.getByTestId(`${prefix}-state`)).toHaveTextContent('locked');
    });
    await act(async () => {
      await vault().reloadVaultMeta();
    });
    expect(vault().vaultMeta?.vault_key_id).toBe('vk:be29-a');
    seedBe2DeviceMeta(10);
    return { vault, gate, idbFactory, devkeys: fakeIdb.ensureStore(DEVKEY_STORE_NAME) };
  }

  function seedBe29DevKey(devkeys: Map<string, unknown>, vaultKeyId: string) {
    const recordKey = formatDevKeyRecordKey(BE2_USER_ID, vaultKeyId);
    devkeys.set(recordKey, {
      user_id: BE2_USER_ID,
      vault_key_id: vaultKeyId,
      wrapped_vk: new Uint8Array([4, 5, 6]),
    });
    return recordKey;
  }

  it('BE2-9: after an observed reset of A is purged, an unnamed 404 caused by a missed later reset of B purges again instead of reusing A receipt', async () => {
    const ctx = await be29Setup('be29-missed');
    ctx.gate.mode = 'absent';
    const peer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      peer.postMessage({ type: 'vault_changed', vault_key_id: 'vk:be29-a', version: null });
      await sleepReal(50);
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
      expect(meta?.deviceRevision).toBe(11);
    });
    expect(ctx.vault().vaultMeta).toBeNull();

    // Vault B is created, remembered on this device and reset in another tab; this tab sees none of it. The device
    // write that seeded B's DevKey rotated `meta` after the purge of A.
    const keyB = seedBe29DevKey(ctx.devkeys, 'vk:be29-b');
    fakeIdb.ensureStore(META_STORE_NAME).set(DEVICE_META_RECORD_KEY, {
      key: DEVICE_META_RECORD_KEY,
      incarnation: 'be29-remember-write-incarnation',
      deviceRevision: 12,
    });
    await act(async () => {
      expect(await ctx.vault().reloadVaultMeta()).toBeNull();
      await sleepReal(50);
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
      expect(meta?.deviceRevision).toBe(13);
    });
    expect(ctx.devkeys.has(keyB)).toBe(false);
    peer.close();
  }, 15_000);

  it('BE2-9 control: a real duplicate-success of the SAME reset (device meta untouched since its purge) is not purged a second time by an unnamed 404', async () => {
    const ctx = await be29Setup('be29-duplicate');
    ctx.gate.mode = 'absent';
    const peer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      peer.postMessage({ type: 'vault_changed', vault_key_id: 'vk:be29-a', version: null });
      await sleepReal(50);
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
      expect(meta?.deviceRevision).toBe(11);
    });
    await act(async () => {
      expect(await ctx.vault().reloadVaultMeta()).toBeNull();
      expect(await ctx.vault().reloadVaultMeta()).toBeNull();
      await sleepReal(50);
    });
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    expect(meta?.deviceRevision).toBe(11);
    peer.close();
  }, 15_000);

  it('BE2-9: markResetPurged with a token this provider never observed does not suppress the purge when that vault reset arrives', async () => {
    const ctx = await be29Setup('be29-wrong-token');
    ctx.gate.mode = 'absent';
    const keyUnseen = seedBe29DevKey(ctx.devkeys, 'vk:be29-unseen');
    act(() => {
      ctx.vault().markResetPurged('vk:be29-unseen');
    });
    const peer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      peer.postMessage({ type: 'vault_changed', vault_key_id: 'vk:be29-unseen', version: null });
      await sleepReal(50);
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
      expect(meta?.deviceRevision).toBe(11);
    });
    expect(ctx.devkeys.has(keyUnseen)).toBe(false);
    peer.close();
  }, 15_000);

  it('BE2-9 acting-tab order: dialog purge, markResetPurged(current vault id) BEFORE the reset is observed, then GET /vault 404 purges exactly once in total', async () => {
    const ctx = await be29Setup('be29-acting');
    // The acting tab's reset dialog purges (rev 10 -> 11) and marks the CURRENT vault, before this provider has seen
    // any 404 or vault_changed for it.
    await act(async () => {
      await purgeDeviceKeysOnRevoked(BE2_USER_ID, { idbFactory: ctx.idbFactory });
    });
    act(() => {
      ctx.vault().markResetPurged('vk:be29-a');
    });
    ctx.gate.mode = 'absent';
    await act(async () => {
      expect(await ctx.vault().reloadVaultMeta()).toBeNull();
      await sleepReal(50);
    });
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    expect(meta?.deviceRevision).toBe(11);
    expect(screen.getByTestId('be29-acting-state')).toHaveTextContent('locked');
  }, 15_000);

  // advisor-dec-041: an accepted markResetPurged snapshots the post-purge device meta, so the unnamed 404 that follows a
  // locally observed reset (current key null) is a proven duplicate while `sabk.device` is untouched.
  it('BE2-9 (vaultsettings order): dialog purge, markResetPurged(K) while K is current, lock({broadcast:false}), notifyVaultChanged(K, null), then a Reload vault 404 purges exactly once in total', async () => {
    const ctx = await be29Setup('be29-dialog');
    await act(async () => {
      await purgeDeviceKeysOnRevoked(BE2_USER_ID, { idbFactory: ctx.idbFactory });
    });
    act(() => {
      ctx.vault().markResetPurged('vk:be29-a');
    });
    await act(async () => {
      await ctx.vault().lock({ broadcast: false });
    });
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be29-a', version: null });
    });
    ctx.gate.mode = 'absent';
    await act(async () => {
      expect(await ctx.vault().reloadVaultMeta()).toBeNull();
      await sleepReal(50);
    });
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    expect(meta?.deviceRevision).toBe(11);
    expect(screen.getByTestId('be29-dialog-state')).toHaveTextContent('locked');
  }, 15_000);

  it('BE2-9 (post-observation order): notifyVaultChanged(K, null), dialog purge, markResetPurged(K), then a Reload vault 404 purges exactly once in total', async () => {
    const ctx = await be29Setup('be29-post');
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be29-a', version: null });
    });
    await act(async () => {
      await purgeDeviceKeysOnRevoked(BE2_USER_ID, { idbFactory: ctx.idbFactory });
    });
    act(() => {
      ctx.vault().markResetPurged('vk:be29-a');
    });
    ctx.gate.mode = 'absent';
    await act(async () => {
      expect(await ctx.vault().reloadVaultMeta()).toBeNull();
      await sleepReal(50);
    });
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    expect(meta?.deviceRevision).toBe(11);
  }, 15_000);

  it('BE2-9 (proof breaks): after the mark, a later device-store write changes meta, so the next unnamed 404 DOES purge', async () => {
    const ctx = await be29Setup('be29-broken');
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be29-a', version: null });
    });
    await act(async () => {
      await purgeDeviceKeysOnRevoked(BE2_USER_ID, { idbFactory: ctx.idbFactory });
    });
    await act(async () => {
      ctx.vault().markResetPurged('vk:be29-a');
      await sleepReal(30);
    });
    // A later write (another vault's DevKey / Remember) rotates `meta` after the mark.
    const keyB = seedBe29DevKey(ctx.devkeys, 'vk:be29-b');
    fakeIdb.ensureStore(META_STORE_NAME).set(DEVICE_META_RECORD_KEY, {
      key: DEVICE_META_RECORD_KEY,
      incarnation: 'be29-after-mark-write-incarnation',
      deviceRevision: 12,
    });
    ctx.gate.mode = 'absent';
    await act(async () => {
      expect(await ctx.vault().reloadVaultMeta()).toBeNull();
      await sleepReal(50);
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
      expect(meta?.deviceRevision).toBe(13);
    });
    expect(ctx.devkeys.has(keyB)).toBe(false);
  }, 15_000);

  it('BE2-9: a stale id from an earlier vault never suppresses the purge of the current vault reset', async () => {
    const ctx = await be29Setup('be29-stale');
    // The device now holds vault B (A was replaced; the key change is observed by the next reload).
    ctx.gate.keyId = 'vk:be29-b';
    await act(async () => {
      await ctx.vault().reloadVaultMeta();
    });
    await waitFor(() => {
      expect(ctx.vault().vaultMeta?.vault_key_id).toBe('vk:be29-b');
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
      expect(meta?.deviceRevision).toBe(11);
    });
    const keyB = seedBe29DevKey(ctx.devkeys, 'vk:be29-b');
    act(() => {
      ctx.vault().markResetPurged('vk:be29-a');
    });
    ctx.gate.mode = 'absent';
    const peer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      peer.postMessage({ type: 'vault_changed', vault_key_id: 'vk:be29-b', version: null });
      await sleepReal(50);
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
      expect(meta?.deviceRevision).toBe(12);
    });
    expect(ctx.devkeys.has(keyB)).toBe(false);
    peer.close();
  }, 15_000);

  it('BE2-9: markResetPurged without a token and without a known current vault records no receipt, so a later reset is still purged', async () => {
    mockBe2Fetch({ vault: () => be2VaultAbsentResponse() });
    const idbFactory = fakeIdb.createFactory();
    const { vault } = renderBe2Provider('be29-no-token', {
      idbFactory,
      locksManager: fakeLocks.createLockManager(),
    });
    await waitFor(() => {
      expect(screen.getByTestId('be29-no-token-state')).toHaveTextContent('locked');
    });
    seedBe2DeviceMeta(10);
    const devkeys = fakeIdb.ensureStore(DEVKEY_STORE_NAME);
    const key = seedBe29DevKey(devkeys, 'vk:be29-later');
    act(() => {
      vault().markResetPurged();
      vault().markResetPurged(null);
    });
    const peer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      peer.postMessage({ type: 'vault_changed', vault_key_id: 'vk:be29-later', version: null });
      await sleepReal(50);
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory });
      expect(meta?.deviceRevision).toBe(11);
    });
    expect(devkeys.has(key)).toBe(false);
    peer.close();
  }, 15_000);

  it('BE4-3: a historical stale reset id (observed A->B) never overwrites the valid receipt of B, so B reset 404 advances the device revision exactly once', async () => {
    const ctx = await be29Setup('be43-stale');
    // Observe A -> B: A becomes a historical id (the replacement purges once itself: 10 -> 11).
    ctx.gate.keyId = 'vk:be29-b';
    await act(async () => {
      await ctx.vault().reloadVaultMeta();
    });
    await waitFor(() => {
      expect(ctx.vault().vaultMeta?.vault_key_id).toBe('vk:be29-b');
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
      expect(meta?.deviceRevision).toBe(11);
    });
    // The acting dialog resets B: its purge commits (11 -> 12) and marks the CURRENT vault B before B's 404 is seen.
    await act(async () => {
      await purgeDeviceKeysOnRevoked(BE2_USER_ID, { idbFactory: ctx.idbFactory });
    });
    act(() => {
      ctx.vault().markResetPurged('vk:be29-b');
    });
    // An obsolete mark for the historical A arrives afterwards: it must be rejected, not replace B's receipt.
    act(() => {
      ctx.vault().markResetPurged('vk:be29-a');
    });
    ctx.gate.mode = 'absent';
    await act(async () => {
      expect(await ctx.vault().reloadVaultMeta()).toBeNull();
      await sleepReal(50);
    });
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    // Exactly one purge for B in total: the dialog's. With A's stale mark honoured B's 404 purged again (13).
    expect(meta?.deviceRevision).toBe(12);
    expect(screen.getByTestId('be43-stale-state')).toHaveTextContent('locked');
  }, 15_000);

  // ---------------------------------------------------------------------------
  // BE4-1 / BE4-5 (fix round 4): a held GET /vault response must not be applied over a local/broadcast metadata
  // transition it predates, and a same-key metadata version never regresses.
  // ---------------------------------------------------------------------------
  it('BE4-1: a held GET /vault for vault A is dropped (no overwrite, purge, lock) after notifyVaultChanged moved the provider to another key', async () => {
    const ctx = await be37Setup('be41-replace');
    ctx.gate.hold = true;
    const outcome: { value: unknown } = { value: 'unset' };
    const heldP = ctx.vault()
      .reloadVaultMeta()
      .then((r) => {
        outcome.value = r;
      });
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(1);
    });
    // Local transition that the held response predates: another vault key becomes current.
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be4-1-b', version: 1 });
    });
    await act(async () => {
      ctx.pending[0]!(jsonResponse(be2VaultBody('vk:be3-7', 2)));
      await heldP;
    });
    // Nothing from the obsolete response was applied: no purge, lock, cache wipe or metadata overwrite.
    expect(outcome.value).toBeNull();
    expect(ctx.vault().vaultMeta?.version).toBe(1);
    expect(screen.getByTestId('be41-replace-state')).toHaveTextContent('unlocked');
    expect(screen.getByTestId('be41-replace-worker')).toHaveTextContent('unlocked');
    expect(ctx.qc.getQueryData(vaultBodyQueryKey('be37-entry'))).toBe('be3-7-decrypted-body');
    expect(ctx.devkeys.has(ctx.devkeyRecordKey)).toBe(true);
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    expect(meta?.deviceRevision).toBe(10);
  }, 20_000);

  it('BE4-1: a held GET /vault that returns vault A present never resurrects metadata after a local reset of A', async () => {
    const ctx = await be37Setup('be41-reset');
    ctx.gate.hold = true;
    const heldP = ctx.vault().reloadVaultMeta();
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(1);
    });
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be3-7', version: null });
    });
    expect(ctx.vault().vaultMeta).toBeNull();
    await act(async () => {
      ctx.pending[0]!(jsonResponse(be2VaultBody('vk:be3-7', 2)));
      expect(await heldP).toBeNull();
    });
    expect(ctx.vault().vaultMeta).toBeNull();
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    expect(meta?.deviceRevision).toBe(10);
  }, 20_000);

  it('BE4-1 control (BE3-7 preserved): an older 404 held across a local reset of the same vault still locks and purges', async () => {
    const ctx = await be37Setup('be41-fail-closed');
    ctx.gate.hold = true;
    const heldP = ctx.vault().reloadVaultMeta();
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(1);
    });
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be3-7', version: null });
    });
    await act(async () => {
      ctx.pending[0]!(be2VaultAbsentResponse());
      expect(await heldP).toBeNull();
    });
    await expectBe37LockedAndPurged(ctx);
  }, 20_000);

  // ---------------------------------------------------------------------------
  // BE5-1 (fix round 5): an authoritative `404 vault_absent` always locks and purges unless a NEWER GET outcome was
  // already APPLIED. A local/broadcast metadata transition alone never proves a 404 stale.
  // ---------------------------------------------------------------------------
  it('BE5-1: a create-201 notification that lands while an earlier GET is held cannot suppress that GET 404: provider and Worker lock, caches wipe, the device fence advances once and nothing revives', async () => {
    const pending: Array<(res: Response) => void> = [];
    const gate = { hold: false };
    mockBe2Fetch({
      vault: () =>
        gate.hold
          ? new Promise<Response>((resolve) => {
              pending.push(resolve);
            })
          : jsonResponse(be2VaultBody('vk:be5-1-a', 1)),
    });
    const idbFactory = fakeIdb.createFactory();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { vault } = renderBe2Provider(
      'be51-create',
      { idbFactory, locksManager: fakeLocks.createLockManager() },
      qc,
    );
    await waitFor(() => {
      expect(screen.getByTestId('be51-create-state')).toHaveTextContent('locked');
    });
    // The prepared Worker already holds the new vault unlocked; no metadata GET has confirmed it yet.
    await be2CreateVault(vault, 'be5-1-passphrase-1234');
    expect(screen.getByTestId('be51-create-state')).toHaveTextContent('unlocked');
    seedBe2DeviceMeta(10);
    const devkeyRecordKey = formatDevKeyRecordKey(BE2_USER_ID, 'vk:be5-1-a');
    const devkeys = fakeIdb.ensureStore(DEVKEY_STORE_NAME);
    devkeys.set(devkeyRecordKey, {
      user_id: BE2_USER_ID,
      vault_key_id: 'vk:be5-1-a',
      wrapped_vk: new Uint8Array([1, 2, 3]),
    });
    qc.setQueryData(vaultBodyQueryKey('be37-entry'), 'be5-1-decrypted-body');

    // Earlier GET G starts and is held; its server evaluation happens after another tab/device reset the vault.
    gate.hold = true;
    const heldP = vault().reloadVaultMeta();
    await waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    // The delayed create 201 arrives first; reset/lock notifications were missed. No newer GET outcome is applied.
    act(() => {
      vault().notifyVaultChanged({ vault_key_id: 'vk:be5-1-a', version: 1 });
    });
    await act(async () => {
      pending[0]!(be2VaultAbsentResponse());
      expect(await heldP).toBeNull();
    });
    // Row 1b: the 404 may predate the create, so it only locks; the ONE follow-up GET under the new key decides. Here
    // the vault really is absent, so the follow-up 404 purges (the device fence advances once in total).
    await waitFor(() => {
      expect(pending).toHaveLength(2);
    });
    await act(async () => {
      pending[1]!(be2VaultAbsentResponse());
      await sleepReal(50);
    });
    await expectBe37LockedAndPurged({ prefix: 'be51-create', vault, qc, idbFactory, devkeys, devkeyRecordKey });

    // Nothing revives the session: a later present answer applies metadata only, and the fence advanced exactly once.
    gate.hold = false;
    await act(async () => {
      await vault().reloadVaultMeta();
      await sleepReal(50);
    });
    expect(screen.getByTestId('be51-create-state')).toHaveTextContent('locked');
    expect(screen.getByTestId('be51-create-worker')).toHaveTextContent('locked');
    expect(qc.getQueryData(vaultBodyQueryKey('be37-entry'))).toBeUndefined();
    const meta = await readDeviceMetaRecord({ idbFactory });
    expect(meta?.deviceRevision).toBe(11);
  }, 20_000);

  it('BE5-1 (Advisor regression): a held GET 404 that crosses a replacement transition still purges, advancing the device revision exactly once', async () => {
    const ctx = await be37Setup('be51-transition');
    ctx.gate.hold = true;
    const heldP = ctx.vault().reloadVaultMeta();
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(1);
    });
    // A replacement vault key becomes current locally while the 404 is in flight.
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be5-1-b', version: 1 });
    });
    await act(async () => {
      ctx.pending[0]!(be2VaultAbsentResponse());
      expect(await heldP).toBeNull();
      await sleepReal(50);
    });
    // Row 1b: the 404 only locks; the ONE follow-up GET under the replacement key decides. The vault really is absent
    // here, so the follow-up 404 purges (revision +1 exactly once in total).
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(2);
    });
    await act(async () => {
      ctx.pending[1]!(be2VaultAbsentResponse());
      await sleepReal(50);
    });
    await expectBe37LockedAndPurged(ctx);
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    expect(meta?.deviceRevision).toBe(11);
  }, 20_000);

  it('BE5-1 control (row 1b): a held 404 that crosses a replacement transition locks, and a follow-up GET that returns the replacement present stays locked and purges nothing', async () => {
    const ctx = await be37Setup('be51-present');
    ctx.gate.hold = true;
    const heldP = ctx.vault().reloadVaultMeta();
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(1);
    });
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be5-1-b', version: 1 });
    });
    await act(async () => {
      ctx.pending[0]!(be2VaultAbsentResponse());
      expect(await heldP).toBeNull();
    });
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(2);
    });
    await act(async () => {
      ctx.pending[1]!(jsonResponse(be2VaultBody('vk:be5-1-b', 1)));
      await sleepReal(50);
    });
    await waitFor(() => {
      expect(screen.getByTestId('be51-present-state')).toHaveTextContent('locked');
      expect(screen.getByTestId('be51-present-worker')).toHaveTextContent('locked');
    });
    expect(ctx.qc.getQueryData(vaultBodyQueryKey('be37-entry'))).toBeUndefined();
    expect(ctx.devkeys.has(ctx.devkeyRecordKey)).toBe(true);
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    expect(meta?.deviceRevision).toBe(10);
    expect(ctx.pending).toHaveLength(2);
  }, 20_000);

  it.each(['stalled', 'failed'] as const)(
    'BE5-1 control: a 404 that crosses a replacement transition (current key non-null) still locks and purges while the NEWER follow-up GET is %s',
    async (followUp) => {
      const ctx = await be37Setup(`be51-follow-${followUp}`);
      ctx.gate.hold = true;
      const olderP = ctx.vault().reloadVaultMeta();
      await waitFor(() => {
        expect(ctx.pending).toHaveLength(1);
      });
      act(() => {
        ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be5-1-b', version: 1 });
      });
      // A newer follow-up GET starts after the transition. Starting, stalling or failing is not supersession.
      const outcome: { newerError: unknown } = { newerError: undefined };
      const newerP = ctx.vault()
        .reloadVaultMeta()
        .catch((err: unknown) => {
          outcome.newerError = err;
        });
      await waitFor(() => {
        expect(ctx.pending).toHaveLength(2);
      });
      if (followUp === 'failed') {
        await act(async () => {
          ctx.pending[1]!(be3ProblemResponse(503, 'service_unavailable'));
          await newerP;
        });
        expect(outcome.newerError).toBeDefined();
        expect(screen.getByTestId(`be51-follow-${followUp}-state`)).toHaveTextContent('unlocked');
      }
      await act(async () => {
        ctx.pending[0]!(be2VaultAbsentResponse());
        expect(await olderP).toBeNull();
      });
      // Row 1b: the older 404 only locks; its own single follow-up GET (the third request) answers 404 and purges.
      await waitFor(() => {
        expect(ctx.pending).toHaveLength(3);
      });
      await act(async () => {
        ctx.pending[2]!(be2VaultAbsentResponse());
        await sleepReal(50);
      });
      await expectBe37LockedAndPurged(ctx);
      if (followUp === 'stalled') {
        // A late present answer from the stalled request is metadata only: it never revives the locked session.
        await act(async () => {
          ctx.pending[1]!(jsonResponse(be2VaultBody('vk:be5-1-b', 2)));
          await newerP;
        });
        expect(screen.getByTestId(`be51-follow-${followUp}-state`)).toHaveTextContent('locked');
        expect(screen.getByTestId(`be51-follow-${followUp}-worker`)).toHaveTextContent('locked');
      }
    },
    20_000,
  );

  // BE6-1 (fix round 6, table row 2): a present response for the CURRENT key is applied even when a local transition
  // happened while it was in flight and no newer GET outcome was applied. Rows 3 and 4 are covered by the BE4-1 tests
  // (stale retired key, nothing applied) and the BE2-9 "stale id" test (genuine replacement purges, locks, installs).
  it('BE6-1: a present response for the current key that crosses a local transition is applied and returned, not dropped as null', async () => {
    const pending: Array<(res: Response) => void> = [];
    mockBe2Fetch({
      vault: () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    });
    const { vault } = renderBe2Provider('be61-current', {
      idbFactory: fakeIdb.createFactory(),
      locksManager: fakeLocks.createLockManager(),
    });
    await waitFor(() => {
      expect(screen.getByTestId('be61-current-state')).toHaveTextContent('locked');
    });
    const outcome: { value: { version: number } | null | 'unset' } = { value: 'unset' };
    const heldP = vault()
      .reloadVaultMeta()
      .then((r) => {
        outcome.value = r;
      });
    await waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    // The create-201 notification makes the key current while the GET (sent with no known key) is held.
    act(() => {
      vault().notifyVaultChanged({ vault_key_id: 'vk:be6-1', version: 1 });
    });
    await act(async () => {
      pending[0]!(jsonResponse(be2VaultBody('vk:be6-1', 2)));
      await heldP;
    });
    expect((outcome.value as { version: number } | null)?.version).toBe(2);
    expect(vault().vaultMeta?.vault_key_id).toBe('vk:be6-1');
    expect(vault().vaultMeta?.version).toBe(2);
  }, 20_000);

  // BE6-1 row 1b (Advisor amendment): a 404 for a GET sent with no known key, held across the creation of key K' (this
  // tab or another tab), locks but never purges K' device keys; ONE follow-up GET under K' decides.
  async function be61KSetup(prefix: string) {
    const pending: Array<(res: Response) => void> = [];
    const rejects: Array<(err: unknown) => void> = [];
    const gate = { hold: false };
    mockBe2Fetch({
      vault: () =>
        gate.hold
          ? new Promise<Response>((resolve, reject) => {
              pending.push(resolve);
              rejects.push(reject);
            })
          : jsonResponse(be2VaultBody('vk:be6-k', 1)),
    });
    const idbFactory = fakeIdb.createFactory();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { vault } = renderBe2Provider(
      prefix,
      { idbFactory, locksManager: fakeLocks.createLockManager() },
      qc,
    );
    await waitFor(() => {
      expect(screen.getByTestId(`${prefix}-state`)).toHaveTextContent('locked');
    });
    // The Worker holds the new vault unlocked; no metadata GET has confirmed it, so GETs are sent with no known key.
    await be2CreateVault(vault, 'be6-k-passphrase-1234');
    expect(screen.getByTestId(`${prefix}-state`)).toHaveTextContent('unlocked');
    seedBe2DeviceMeta(10);
    const devkeyRecordKey = formatDevKeyRecordKey(BE2_USER_ID, 'vk:be6-k');
    const devkeys = fakeIdb.ensureStore(DEVKEY_STORE_NAME);
    devkeys.set(devkeyRecordKey, {
      user_id: BE2_USER_ID,
      vault_key_id: 'vk:be6-k',
      wrapped_vk: new Uint8Array([1, 2, 3]),
    });
    qc.setQueryData(vaultBodyQueryKey('be37-entry'), 'be6-k-decrypted-body');
    gate.hold = true;
    return { vault, qc, idbFactory, pending, rejects, devkeys, devkeyRecordKey, prefix };
  }

  async function expectBe61KLockedNothingPurged(ctx: Awaited<ReturnType<typeof be61KSetup>>) {
    await waitFor(() => {
      expect(screen.getByTestId(`${ctx.prefix}-state`)).toHaveTextContent('locked');
      expect(screen.getByTestId(`${ctx.prefix}-worker`)).toHaveTextContent('locked');
    });
    expect(ctx.qc.getQueryData(vaultBodyQueryKey('be37-entry'))).toBeUndefined();
    expect(ctx.devkeys.has(ctx.devkeyRecordKey)).toBe(true);
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    expect(meta?.deviceRevision).toBe(10);
  }

  it.each(['local', 'broadcast'] as const)(
    "BE6-1 row 1b: an old 404 held across K' created by %s locks without purging K' device keys, and a follow-up GET that returns K' present stays locked and purges nothing",
    async (origin) => {
      const ctx = await be61KSetup(`be61-k-${origin}`);
      const heldP = ctx.vault().reloadVaultMeta();
      await waitFor(() => {
        expect(ctx.pending).toHaveLength(1);
      });
      const peer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
      if (origin === 'local') {
        act(() => {
          ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be6-k', version: 1 });
        });
      } else {
        await act(async () => {
          peer.postMessage({ type: 'vault_changed', vault_key_id: 'vk:be6-k', version: 1 });
          await sleepReal(50);
        });
        // The broadcast itself reloads metadata: that GET is pending too.
        await waitFor(() => {
          expect(ctx.pending).toHaveLength(2);
        });
      }
      await act(async () => {
        ctx.pending[0]!(be2VaultAbsentResponse());
        expect(await heldP).toBeNull();
      });
      // Locked right away, but K' device keys and the device fence are untouched.
      await expectBe61KLockedNothingPurged(ctx);
      const followUp = origin === 'local' ? 1 : 2;
      await waitFor(() => {
        expect(ctx.pending).toHaveLength(followUp + 1);
      });
      await act(async () => {
        ctx.pending[followUp]!(jsonResponse(be2VaultBody('vk:be6-k', 1)));
        await sleepReal(50);
      });
      await expectBe61KLockedNothingPurged(ctx);
      expect(ctx.pending).toHaveLength(followUp + 1);
      peer.close();
    },
    20_000,
  );

  it.each(['network error', 'abort'] as const)(
    "BE6-1 row 1b: when the follow-up GET under K' ends in a %s the provider stays locked and purges nothing",
    async (failure) => {
      const ctx = await be61KSetup(`be61-k-${failure === 'abort' ? 'abort' : 'net'}`);
      const heldP = ctx.vault().reloadVaultMeta();
      await waitFor(() => {
        expect(ctx.pending).toHaveLength(1);
      });
      act(() => {
        ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be6-k', version: 1 });
      });
      await act(async () => {
        ctx.pending[0]!(be2VaultAbsentResponse());
        expect(await heldP).toBeNull();
      });
      await waitFor(() => {
        expect(ctx.pending).toHaveLength(2);
      });
      await act(async () => {
        ctx.rejects[1]!(
          failure === 'abort' ? new DOMException('aborted', 'AbortError') : new TypeError('network error'),
        );
        await sleepReal(50);
      });
      await expectBe61KLockedNothingPurged(ctx);
      expect(ctx.pending).toHaveLength(2);
    },
    20_000,
  );

  // BE7-1: the row-1b follow-up is never itself ambiguous (advisor-dec-038a: exactly ONE follow-up).
  it("BE7-1: a follow-up 404 held while the current key moves K -> C locks and purges nothing, and sends no third GET", async () => {
    const ctx = await be61KSetup('be71-moved');
    const heldP = ctx.vault().reloadVaultMeta();
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(1);
    });
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be6-k', version: 1 });
    });
    // The old 404 (sent with no key) is row 1b: its follow-up GET goes out under K and is held.
    await act(async () => {
      ctx.pending[0]!(be2VaultAbsentResponse());
      expect(await heldP).toBeNull();
    });
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(2);
    });
    // K is replaced locally by C (K retired, C not) while the follow-up is still held.
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be7-c', version: 1 });
    });
    await act(async () => {
      ctx.pending[1]!(be2VaultAbsentResponse());
      await sleepReal(100);
    });
    await expectBe61KLockedNothingPurged(ctx);
    // Exactly 2 GETs in total, even after the turn queue drains.
    await act(async () => {
      await sleepReal(100);
    });
    expect(ctx.pending).toHaveLength(2);
  }, 20_000);

  it('BE7-1: a follow-up 404 with the current key still the one it was sent under is row 1a: purge, device revision +1 exactly once', async () => {
    const ctx = await be61KSetup('be71-same');
    const heldP = ctx.vault().reloadVaultMeta();
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(1);
    });
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be6-k', version: 1 });
    });
    await act(async () => {
      ctx.pending[0]!(be2VaultAbsentResponse());
      expect(await heldP).toBeNull();
    });
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(2);
    });
    // Nothing is purged until the follow-up decides.
    await expectBe61KLockedNothingPurged(ctx);
    await act(async () => {
      ctx.pending[1]!(be2VaultAbsentResponse());
      await sleepReal(100);
    });
    await waitFor(() => {
      expect(ctx.devkeys.has(ctx.devkeyRecordKey)).toBe(false);
    });
    await waitFor(async () => {
      const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
      expect(meta?.deviceRevision).toBe(11);
    });
    await act(async () => {
      await sleepReal(100);
    });
    const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
    expect(meta?.deviceRevision).toBe(11);
    expect(screen.getByTestId('be71-same-state')).toHaveTextContent('locked');
    expect(ctx.pending).toHaveLength(2);
  }, 20_000);

  // BE5-2: the superseded return (success, 404 and failure exits) must not hand back a same-key version older than the
  // live metadata when a local update landed after the saved applied outcome.
  it.each(['success', '404', 'failure'] as const)(
    'BE5-2: G1/G2 -> G2 v2 -> local v3 -> G1 settles with %s returns v3 and the provider stays at v3',
    async (exit) => {
      const ctx = await be37Setup(`be52-${exit}`);
      ctx.gate.hold = true;
      const outcome: { g1: { version: number } | null | 'unset' } = { g1: 'unset' };
      const g1P = ctx.vault()
        .reloadVaultMeta()
        .then((r) => {
          outcome.g1 = r;
        });
      const g2P = ctx.vault().reloadVaultMeta();
      await waitFor(() => {
        expect(ctx.pending).toHaveLength(2);
      });
      // The newer G2 applies v2 first; a local same-key notification then raises the live metadata to v3.
      await act(async () => {
        ctx.pending[1]!(jsonResponse(be2VaultBody('vk:be3-7', 2)));
        expect((await g2P)?.version).toBe(2);
      });
      act(() => {
        ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be3-7', version: 3 });
      });
      expect(ctx.vault().vaultMeta?.version).toBe(3);
      await act(async () => {
        ctx.pending[0]!(
          exit === 'success'
            ? jsonResponse(be2VaultBody('vk:be3-7', 1))
            : exit === '404'
              ? be2VaultAbsentResponse()
              : be3ProblemResponse(503, 'service_unavailable'),
        );
        await g1P;
      });
      expect((outcome.g1 as { version: number } | null)?.version).toBe(3);
      expect(ctx.vault().vaultMeta?.version).toBe(3);
      expect(screen.getByTestId(`be52-${exit}-state`)).toHaveTextContent('unlocked');
      expect(screen.getByTestId(`be52-${exit}-worker`)).toHaveTextContent('unlocked');
      const meta = await readDeviceMetaRecord({ idbFactory: ctx.idbFactory });
      expect(meta?.deviceRevision).toBe(10);
    },
    20_000,
  );

  it('BE4-5: an older same-key GET snapshot held across a local v3 update cannot lower the current metadata version', async () => {
    const ctx = await be37Setup('be45-regress');
    ctx.gate.hold = true;
    const outcome: { value: { version: number } | null } = { value: null };
    const heldP = ctx.vault()
      .reloadVaultMeta()
      .then((r) => {
        outcome.value = r;
      });
    await waitFor(() => {
      expect(ctx.pending).toHaveLength(1);
    });
    // An authoritative local outcome moves the same vault to v3 while the older GET (about to report v2) is held.
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be3-7', version: 3 });
    });
    expect(ctx.vault().vaultMeta?.version).toBe(3);
    await act(async () => {
      ctx.pending[0]!(jsonResponse(be2VaultBody('vk:be3-7', 2)));
      await heldP;
    });
    expect(ctx.vault().vaultMeta?.version).toBe(3);
    expect(outcome.value?.version).toBe(3);
    // A late, lower local notification never lowers it either.
    act(() => {
      ctx.vault().notifyVaultChanged({ vault_key_id: 'vk:be3-7', version: 2 });
    });
    expect(ctx.vault().vaultMeta?.version).toBe(3);
    expect(screen.getByTestId('be45-regress-state')).toHaveTextContent('unlocked');
  }, 20_000);

  // ---------------------------------------------------------------------------
  // BE3-5 / BE1-6 (V1) / BE2-6 (fix round 3): a PENDING recovery continuation is locked mid-operation.
  // The recovery call is held AFTER its baseline pre-check and BEFORE the Worker result is published; a real
  // sibling lock (delivered) or a missed durable lockEpoch advance (durable post-check) then lands while the
  // continuation is pending.
  // ---------------------------------------------------------------------------
  function renderRecordingProviders(
    prefix: string,
    env: { idbFactory: IDBFactory; locksManager: LockManager },
    count: 1 | 2,
  ) {
    const holder: { a: VaultContextValue | null; b: VaultContextValue | null } = { a: null, b: null };
    const statesA: string[] = [];
    function ProbeA() {
      const ctx = useVault();
      holder.a = ctx;
      statesA.push(ctx.state);
      return (
        <div>
          <output data-testid={`${prefix}-state-a`}>{ctx.state}</output>
          <output data-testid={`${prefix}-worker-a`}>{ctx.workerState}</output>
        </div>
      );
    }
    function ProbeB() {
      const ctx = useVault();
      holder.b = ctx;
      return <output data-testid={`${prefix}-state-b`}>{ctx.state}</output>;
    }
    const mount = (probe: ReactNode) => (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SessionProvider>
          <VaultProvider
            createWorker={makeShimmedWorkerFactory()}
            lockEpochEnv={env}
            deviceStoreEnv={{ idbFactory: env.idbFactory }}
          >
            {probe}
          </VaultProvider>
        </SessionProvider>
      </QueryClientProvider>
    );
    render(
      <div>
        {mount(<ProbeA />)}
        {count === 2 ? mount(<ProbeB />) : null}
      </div>,
    );
    return {
      statesA,
      vaultA: () => {
        if (!holder.a) throw new Error('probe A has not rendered yet');
        return holder.a;
      },
      vaultB: () => {
        if (!holder.b) throw new Error('probe B has not rendered yet');
        return holder.b;
      },
    };
  }

  function makeRecoveryHold() {
    const hold: { reached: boolean; release: () => void; promise: Promise<void> } = {
      reached: false,
      release: () => undefined,
      promise: Promise.resolve(),
    };
    hold.promise = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    return hold;
  }

  async function be35EnterLookup(
    prefix: string,
    count: 1 | 2,
  ): Promise<{
    env: { idbFactory: IDBFactory; locksManager: LockManager };
    p: ReturnType<typeof renderRecordingProviders>;
    created: CreateVaultResult;
    op: { opGeneration: number };
  }> {
    mockBe2Fetch();
    const env = { idbFactory: fakeIdb.createFactory(), locksManager: fakeLocks.createLockManager() };
    const p = renderRecordingProviders(prefix, env, count);
    await waitFor(() => {
      expect(screen.getByTestId(`${prefix}-state-a`)).toHaveTextContent('locked');
    });
    const created = await be2CreateVault(p.vaultA, 'be3-5-recovery-passphrase-1234');
    await act(async () => {
      await p.vaultA().lockNow();
    });
    await waitFor(() => {
      expect(screen.getByTestId(`${prefix}-state-a`)).toHaveTextContent('locked');
    });
    const op = p.vaultA().beginOp();
    await act(async () => {
      await p.vaultA().unlockRecovery({
        recoveryKey: created.recovery_keys[0]!.display,
        opGeneration: op.opGeneration,
      });
    });
    return { env, p, created, op };
  }

  it('BE3-5 / BE1-6: a missed durable lockEpoch advance while resumeRecovery is pending is caught by the post-check -> stale rejection, no recovering continuation, both modes locked', async () => {
    const { env, p, created, op } = await be35EnterLookup('be35-resume', 1);
    expect(p.vaultA().unlockBaseline).not.toBeNull();

    const hold = makeRecoveryHold();
    const outcome: { err: unknown } = { err: null };
    const resumeP = p
      .vaultA()
      .resumeRecovery({
        wrap: created.recovery_keys[0]!.wrap,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: op.opGeneration,
        beforePostMessage: () => {
          hold.reached = true;
          return hold.promise;
        },
      })
      .catch((err: unknown) => {
        outcome.err = err;
      });
    await act(async () => {
      await waitUntil(() => hold.reached);
    });

    // A sibling advanced the durable lockEpoch and this tab missed its notification.
    await act(async () => {
      await recordLockEpochEvent(p.vaultA().tabKnownLockEpoch, env);
    });
    await act(async () => {
      hold.release();
      await resumeP;
    });
    expect(outcome.err).toMatchObject({ code: 'STALE_GENERATION' });
    await waitFor(() => {
      expect(screen.getByTestId('be35-resume-state-a')).toHaveTextContent('locked');
      expect(screen.getByTestId('be35-resume-worker-a')).toHaveTextContent('locked');
    });
    expect(p.vaultA().unlockBaseline).toBeNull();

    // The cancelled continuation is unusable and no fresh baseline is recaptured for it.
    const confirmErr: { value: unknown } = { value: null };
    await act(async () => {
      try {
        await p.vaultA().confirmRecovery({ opGeneration: op.opGeneration });
      } catch (err) {
        confirmErr.value = err;
      }
    });
    expect(confirmErr.value).toMatchObject({ code: 'STALE_GENERATION' });
    expect(screen.getByTestId('be35-resume-state-a')).toHaveTextContent('locked');
  }, 20_000);

  it('BE3-5 / BE2-6: a missed durable lockEpoch advance while confirmRecovery is pending is caught by the post-check -> stale rejection, never an unlocked render, both modes locked', async () => {
    const { env, p, created, op } = await be35EnterLookup('be35-confirm', 1);
    await act(async () => {
      await p.vaultA().resumeRecovery({
        wrap: created.recovery_keys[0]!.wrap,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: op.opGeneration,
      });
    });
    expect(screen.getByTestId('be35-confirm-state-a')).toHaveTextContent('recovering');
    const baselineE1 = p.vaultA().unlockBaseline;
    expect(baselineE1).not.toBeNull();
    p.statesA.length = 0;

    const hold = makeRecoveryHold();
    const outcome: { err: unknown } = { err: null };
    const confirmP = p
      .vaultA()
      .confirmRecovery({
        opGeneration: op.opGeneration,
        beforePostMessage: () => {
          hold.reached = true;
          return hold.promise;
        },
      })
      .catch((err: unknown) => {
        outcome.err = err;
      });
    await act(async () => {
      await waitUntil(() => hold.reached);
    });
    // The pre-check passed and the call is pending against the ORIGINAL baseline; nothing was substituted.
    expect(p.vaultA().unlockBaseline).toEqual(baselineE1);

    await act(async () => {
      await recordLockEpochEvent(p.vaultA().tabKnownLockEpoch, env);
    });
    await act(async () => {
      hold.release();
      await confirmP;
    });
    expect(outcome.err).toMatchObject({ code: 'STALE_GENERATION' });
    await waitFor(() => {
      expect(screen.getByTestId('be35-confirm-state-a')).toHaveTextContent('locked');
      expect(screen.getByTestId('be35-confirm-worker-a')).toHaveTextContent('locked');
    });
    expect(p.vaultA().unlockBaseline).toBeNull();
    // The unverified post-confirm Worker session was never exposed as unlocked application access.
    expect(p.statesA).not.toContain('unlocked');
  }, 20_000);

  it('BE3-5: a real sibling VaultProvider.lock delivered while confirmRecovery is pending cancels the continuation -> stale rejection, both modes locked, continuation unusable', async () => {
    const { p, created, op } = await be35EnterLookup('be35-sibling', 2);
    await act(async () => {
      await p.vaultA().resumeRecovery({
        wrap: created.recovery_keys[0]!.wrap,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: op.opGeneration,
      });
    });
    expect(screen.getByTestId('be35-sibling-state-a')).toHaveTextContent('recovering');

    const hold = makeRecoveryHold();
    const outcome: { err: unknown } = { err: null };
    const confirmP = p
      .vaultA()
      .confirmRecovery({
        opGeneration: op.opGeneration,
        beforePostMessage: () => {
          hold.reached = true;
          return hold.promise;
        },
      })
      .catch((err: unknown) => {
        outcome.err = err;
      });
    await act(async () => {
      await waitUntil(() => hold.reached);
    });
    expect(screen.getByTestId('be35-sibling-state-a')).toHaveTextContent('recovering');

    // The sibling's real production lock lands while A's confirm is PENDING (not before it was admitted).
    await act(async () => {
      await p.vaultB().lockNow();
    });
    await waitFor(() => {
      expect(screen.getByTestId('be35-sibling-state-a')).toHaveTextContent('locked');
      expect(screen.getByTestId('be35-sibling-worker-a')).toHaveTextContent('locked');
    });
    await act(async () => {
      hold.release();
      await confirmP;
    });
    expect(outcome.err).toMatchObject({ code: 'STALE_GENERATION' });
    expect(screen.getByTestId('be35-sibling-state-a')).toHaveTextContent('locked');
    expect(p.vaultA().unlockBaseline).toBeNull();

    const retryErr: { value: unknown } = { value: null };
    await act(async () => {
      try {
        await p.vaultA().confirmRecovery({ opGeneration: op.opGeneration });
      } catch (err) {
        retryErr.value = err;
      }
    });
    expect(retryErr.value).toMatchObject({ code: 'STALE_GENERATION' });
  }, 20_000);
});
