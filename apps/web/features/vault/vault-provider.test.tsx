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
            vault_key_id: 'vk:reset-target-vs-r4-1',
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

    // Path 2: Acting tab (Tab A) resets a second vault ('vk:reset-target-vs-r4-1'), its dialog purges once
    // and marks the reset transition via markResetPurged('vk:reset-target-vs-r4-1') (or notifyVaultChanged),
    // post-reset /me fails, and the user clicks 'Reload vault' (tabAVault.reloadVaultMeta() -> 404) ->
    // reloadVaultMeta()'s 404 branch is a no-op (deviceRevision: 11 -> 12, never 13).
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
      tabAVault.markResetPurged('vk:reset-target-vs-r4-1');
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

    // 1. BE2-6: Trigger two overlapping wake events (`focus` then `pageshow`) where Verify #1 finishes while Verify #2 is still held.
    // Plaintext MUST remain gated (`unlocking`) until Verify #2 also finishes.
    holdVerifyCount = 2;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(pendingVerifies).toHaveLength(2);
    expect(screen.getByTestId('be2-overlap-state')).toHaveTextContent('unlocking');
    expect(winBridge?.state).toBe('unlocking');
    expect(screen.getByTestId('be2-overlap-body')).toHaveTextContent('locked-surface');

    // Release Verify #1 only -> Verify #2 is still pending, so state MUST remain 'unlocking' (never re-enabling plaintext early)
    await act(async () => {
      pendingVerifies.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pendingVerifies).toHaveLength(1);
    expect(screen.getByTestId('be2-overlap-state')).toHaveTextContent('unlocking');
    expect(screen.getByTestId('be2-overlap-body')).toHaveTextContent('locked-surface');

    // Release Verify #2 -> both verifications and Me refreshes complete, returning to 'unlocked'
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

  it('BE2-5, BE2-8 & BE1-8: concurrent state-changing operations keep baseline/inFlight fences alive and reloadVaultMeta forces fresh network fetch with currentVaultKeyIdRef updated from server responses', async () => {
    let vaultVersion = 1;
    let currentVaultKeyId = 'vk:be2-8-initial';
    let getVaultNetworkCalls = 0;
    const userId = '11111111-1111-1111-1111-111111111111';
    const me = makeMeFixture({ userId, vaultStatus: 'present', autoLockMinutes: 15 });

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
        getVaultNetworkCalls += 1;
        return jsonResponse({
          vault_key_id: currentVaultKeyId,
          version: vaultVersion,
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

    const idbFactory = fakeIdb.createFactory();
    const locksManager = fakeLocks.createLockManager();
    const lockEpochEnv: LockEpochEnvironment = { idbFactory, locksManager };

    let vaultCtx!: VaultContextValue;
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 60_000, // Even with a 60s staleTime on QueryClient, reloadVaultMeta MUST force a fresh network GET /vault (BE1-8)
        },
      },
    });
    function Probe() {
      vaultCtx = useVault();
      return <output data-testid="be2-8-state">{vaultCtx.state}</output>;
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
      expect(screen.getByTestId('be2-8-state')).toHaveTextContent('locked');
    });
    expect(getVaultNetworkCalls).toBe(1);

    // BE1-8: Bump server version and call reloadVaultMeta() while cached query is still fresh under staleTime: 60_000.
    // reloadVaultMeta MUST bypass stale cache and perform a fresh network GET /vault.
    vaultVersion = 2;
    let reloadedVersion: number | null = null;
    await act(async () => {
      const meta = await vaultCtx.reloadVaultMeta();
      reloadedVersion = meta?.version ?? null;
    });
    expect(getVaultNetworkCalls).toBe(2);
    expect(reloadedVersion).toBe(2);

    // Seed DevKey for vk:be2-8-initial
    const devkeysMap = fakeIdb.ensureStore(DEVKEY_STORE_NAME);
    devkeysMap.set(formatDevKeyRecordKey(userId, 'vk:be2-8-initial'), {
      user_id: userId,
      vault_key_id: 'vk:be2-8-initial',
      wrapped_vk: new Uint8Array([1, 2, 3]),
    });

    // BE2-8: Reset vault on server -> vault_changed { version: null } purges once for vk:be2-8-initial.
    // Then server creates a new vault ONLY observed via GET /vault (`reloadVaultMeta`) without calling notifyVaultChanged({ vault_key_id }).
    // A subsequent vault_changed { version: null } for the new vault MUST NOT be suppressed by resetPurgedVaultKeyIdRef!
    const remotePeer = new HubBroadcastChannel(VAULT_BROADCAST_CHANNEL);
    await act(async () => {
      remotePeer.postMessage({ type: 'vault_changed', version: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    const metaAfterFirstReset = await readDeviceMetaRecord({ idbFactory });
    const revAfterFirstReset = metaAfterFirstReset?.deviceRevision ?? 0;
    expect(revAfterFirstReset).toBeGreaterThanOrEqual(1);

    // New vault created on another tab; this tab learns the new vault_key_id via reloadVaultMeta() (GET /vault)
    currentVaultKeyId = 'vk:be2-8-second-vault';
    vaultVersion = 1;
    await act(async () => {
      await vaultCtx.reloadVaultMeta();
    });
    expect(vaultCtx.vaultMeta?.vault_key_id).toBe('vk:be2-8-second-vault');

    // Second reset happens -> must purge again and bump deviceRevision (not suppressed by first vault's purge latch!)
    await act(async () => {
      remotePeer.postMessage({ type: 'vault_changed', version: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    const metaAfterSecondReset = await readDeviceMetaRecord({ idbFactory });
    expect(metaAfterSecondReset?.deviceRevision).toBe(revAfterFirstReset + 1);
    remotePeer.close();
  });
});
