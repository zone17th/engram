/**
 * DevKey ("Remember this device", plan Task 18, ADR 0002 §device wrap, ADR 0003 §6).
 *
 * This module is the MAIN-THREAD driver of the Worker commands `wrapForDevice` / `unlockDevKey` and the only writer of
 * DevKey records in IndexedDB `sabk.device` (`devkeys` store keyed `<user_id>:<vault_key_id>`, origin-wide `meta`
 * record `{ incarnation, deviceRevision }`). `VK` never reaches this module: the Worker seals / opens it with the
 * NON-EXTRACTABLE AES-GCM `DevKey`, so only the 60-byte `wrapped_vk` crosses the Worker boundary.
 *
 * Invariants:
 * 1. `opGeneration` is captured by the caller BEFORE the first `await` of a flow and travels unchanged to the Worker
 *    command. `unlockDevKey` is state-changing (a parallel unlock gets `CLIENT_BUSY`) and has no `*Now` variant.
 * 2. Remember: `(startIncarnation, startRevision)` is captured BEFORE WebCrypto (the first-time meta record is created
 *    and committed in its own short tx). After the WebCrypto wait, INSIDE the Web Lock `sabk.vault.lock`, the vault is
 *    re-verified with `GET /vault` (404, another `vault_key_id` or an unverifiable response abort: CF-T18-REMEMBER-FENCE,
 *    advisor-dec-036) and ONE `readwrite` tx re-reads meta and the generation: missing / changed meta or generation =>
 *    `tx.abort()`, nothing written. The meta record is never inferred as `0` when missing.
 * 3. Inside every IndexedDB tx only that tx's own `IDBRequest`s are awaited (no WebCrypto, Worker, fetch, locks).
 * 4. Never `indexedDB.deleteDatabase`. Forget / reset / revoked purge are the ONE `readwrite` purge tx of
 *    `device-store.ts` (records deleted + new incarnation + deviceRevision + 1).
 * 5. IndexedDB / Web Lock failure (private mode, blocked) never throws out of the public functions: the result says
 *    `unavailable` / `fallback` and the caller falls back to the passphrase.
 */

import { ProblemError } from '@engram/shared-types';
import {
  formatDevKeyRecordKey,
  isValidDeviceMetaRecord,
  parseDevKeyRecordUserId,
  parseDevKeyRecordVaultKeyId,
  purgeDeviceKeysOnRevoked,
  type DeviceKeyScope,
  type DeviceMetaRecord,
  type DeviceStoreEnvironment,
  type StoredDevKeyRecord,
} from '@/features/vault/device-store';
import {
  DEVICE_META_RECORD_KEY,
  DEVKEY_STORE_NAME,
  META_STORE_NAME,
  generateIncarnationToken,
  openSabkDeviceDb,
  withVaultWebLock,
} from '@/features/vault/lock-epoch';
import { fetchVault } from '@/lib/api/vault';
import { CryptoClientError, type CryptoClientErrorCode, type UnlockDevKeyClientParams } from './client';

/** Exact byte length of `iv(12) || ciphertext(32) || tag(16)` (ADR 0002). */
export const DEVKEY_WRAPPED_VK_BYTES = 60;
/** The in-lock `GET /vault` of Remember is bounded so a hung request can never hold `sabk.vault.lock` for long. */
export const REMEMBER_VAULT_VERIFY_TIMEOUT_MS = 10_000;

export interface DeviceEnvironment extends DeviceStoreEnvironment {
  locksManager?: LockManager;
}

// ---------------------------------------------------------------------------
// Test-only hooks (never reachable in production: ignored unless a non-production build or a loopback host)
// ---------------------------------------------------------------------------

export interface RememberTestHooks {
  /** Awaited after the WebCrypto / Worker wait and BEFORE the Web Lock, i.e. where a slow WebCrypto would park. */
  afterWebCrypto?: () => Promise<void> | void;
  /** Awaited INSIDE the Web Lock after the vault was verified and before the final tx (never inside the tx). */
  afterVaultVerified?: () => Promise<void> | void;
  /** Called synchronously at the start of the final key-list callback (after `metaReq.onsuccess` ran). */
  onKeyListSuccess?: () => void;
}

function testHooksAllowed(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  if (typeof window === 'undefined') return false;
  const host = window.location?.hostname;
  return host === '127.0.0.1' || host === 'localhost';
}

// ---------------------------------------------------------------------------
// Device state change notification (same tab; other tabs re-read on visibility / focus / pageshow)
// ---------------------------------------------------------------------------

const deviceStateListeners = new Set<() => void>();

/** Subscribes to Remember / Forget outcomes of this tab (purges also notify through `subscribeDevicePurge`). */
export function subscribeDeviceStateChange(listener: () => void): () => void {
  deviceStateListeners.add(listener);
  return () => {
    deviceStateListeners.delete(listener);
  };
}

function notifyDeviceStateChange(): void {
  for (const listener of [...deviceStateListeners]) {
    try {
      listener();
    } catch {
      // Ignore listener errors
    }
  }
}

// ---------------------------------------------------------------------------
// IndexedDB helpers (each opens and closes its own connection; one short tx each)
// ---------------------------------------------------------------------------

async function withDb<T>(env: DeviceEnvironment | undefined, fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await openSabkDeviceDb(env?.idbFactory);
  try {
    return await fn(db);
  } finally {
    try {
      db.close();
    } catch {
      // Ignore
    }
  }
}

/**
 * Reads the origin-wide meta record, creating and committing `{ incarnation: random, deviceRevision: 1 }` in the same
 * `readwrite` tx when it is missing or invalid (first use, or the DB was cleared / re-created).
 */
function ensureDeviceMetaTx(db: IDBDatabase): Promise<DeviceMetaRecord> {
  return new Promise<DeviceMetaRecord>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(META_STORE_NAME, 'readwrite');
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to start device meta transaction'));
      return;
    }
    let result: DeviceMetaRecord | null = null;
    tx.oncomplete = () => {
      if (result) resolve(result);
      else reject(new Error('Device meta transaction completed without a meta record'));
    };
    tx.onerror = () => reject(tx.error ?? new Error('Device meta transaction error'));
    tx.onabort = () => reject(tx.error ?? new Error('Device meta transaction aborted'));
    const abort = () => {
      try {
        tx.abort();
      } catch {
        // Ignore
      }
    };
    try {
      const store = tx.objectStore(META_STORE_NAME);
      const getReq = store.get(DEVICE_META_RECORD_KEY);
      getReq.onerror = abort;
      getReq.onsuccess = () => {
        const curRaw: unknown = getReq.result;
        if (isValidDeviceMetaRecord(curRaw)) {
          result = { incarnation: curRaw.incarnation, deviceRevision: curRaw.deviceRevision };
          return;
        }
        const fresh: DeviceMetaRecord = { incarnation: generateIncarnationToken(), deviceRevision: 1 };
        const putReq = store.put(fresh, DEVICE_META_RECORD_KEY);
        putReq.onerror = abort;
        putReq.onsuccess = () => {
          result = fresh;
        };
      };
    } catch (err) {
      abort();
      reject(err instanceof Error ? err : new Error('Device meta transaction failed'));
    }
  });
}

type RememberCommitOutcome =
  | { status: 'committed'; meta: DeviceMetaRecord }
  | { status: 'aborted'; reason: 'meta_missing' | 'meta_changed' | 'generation_changed' };

/**
 * The ONE final `readwrite` tx of Remember over `['devkeys', 'meta']`. Re-reads meta, requires it to exist and equal
 * `(startIncarnation, startRevision)` and the generation to be current (a synchronous check inside the request
 * callback), else `tx.abort()` and nothing is written. On success writes `{ startIncarnation, startRevision + 1 }`,
 * deletes the user's records of other `vault_key_id`s and puts the new record.
 */
function commitRememberTx(
  db: IDBDatabase,
  params: {
    userId: string;
    vaultKeyId: string;
    start: DeviceMetaRecord;
    devKey: CryptoKey;
    wrappedVk: Uint8Array;
    isGenerationCurrent: () => boolean;
    onKeyListSuccess?: () => void;
  },
): Promise<RememberCommitOutcome> {
  return new Promise<RememberCommitOutcome>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([DEVKEY_STORE_NAME, META_STORE_NAME], 'readwrite');
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to start Remember transaction'));
      return;
    }
    let committed: DeviceMetaRecord | null = null;
    let abortReason: 'meta_missing' | 'meta_changed' | 'generation_changed' | null = null;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    tx.oncomplete = () =>
      settle(() => {
        if (committed) resolve({ status: 'committed', meta: committed });
        else reject(new Error('Remember transaction completed without writing'));
      });
    tx.onerror = () => {
      // The matching `abort` event settles; an error without our own abort reason is a storage failure.
    };
    tx.onabort = () =>
      settle(() => {
        if (abortReason) resolve({ status: 'aborted', reason: abortReason });
        else reject(tx.error ?? new Error('Remember transaction aborted'));
      });
    const abortWith = (reason: 'meta_missing' | 'meta_changed' | 'generation_changed' | null) => {
      if (reason) abortReason = reason;
      try {
        tx.abort();
      } catch {
        // Ignore
      }
    };

    try {
      const devkeys = tx.objectStore(DEVKEY_STORE_NAME);
      const meta = tx.objectStore(META_STORE_NAME);
      const metaReq = meta.get(DEVICE_META_RECORD_KEY);
      metaReq.onerror = () => abortWith(null);
      metaReq.onsuccess = () => {
        try {
          const cur: unknown = metaReq.result;
          if (!isValidDeviceMetaRecord(cur)) {
            abortWith('meta_missing');
            return;
          }
          if (
            cur.incarnation !== params.start.incarnation ||
            cur.deviceRevision !== params.start.deviceRevision
          ) {
            abortWith('meta_changed');
            return;
          }
          if (!params.isGenerationCurrent()) {
            abortWith('generation_changed');
            return;
          }
          const ownKey = formatDevKeyRecordKey(params.userId, params.vaultKeyId);
          const keysReq = devkeys.getAllKeys();
          keysReq.onerror = () => abortWith(null);
          keysReq.onsuccess = () => {
            try {
              params.onKeyListSuccess?.();
              const latestMeta: unknown = metaReq.result;
              if (!isValidDeviceMetaRecord(latestMeta)) {
                abortWith('meta_missing');
                return;
              }
              if (
                latestMeta.incarnation !== params.start.incarnation ||
                latestMeta.deviceRevision !== params.start.deviceRevision
              ) {
                abortWith('meta_changed');
                return;
              }
              if (!params.isGenerationCurrent()) {
                abortWith('generation_changed');
                return;
              }
              const keys = Array.isArray(keysReq.result) ? keysReq.result : [];
              for (const key of keys) {
                if (key !== ownKey && parseDevKeyRecordUserId(key, undefined) === params.userId) {
                  const delReq = devkeys.delete(key);
                  delReq.onerror = () => abortWith(null);
                }
              }
              const next: DeviceMetaRecord = {
                incarnation: params.start.incarnation,
                deviceRevision: params.start.deviceRevision + 1,
              };
              const record: StoredDevKeyRecord = {
                user_id: params.userId,
                vault_key_id: params.vaultKeyId,
                dev_key: params.devKey,
                wrapped_vk: params.wrappedVk,
                created_at: new Date().toISOString(),
              };
              const putRecord = devkeys.put(record, ownKey);
              putRecord.onerror = () => abortWith(null);
              const putMeta = meta.put(next, DEVICE_META_RECORD_KEY);
              putMeta.onerror = () => abortWith(null);
              putMeta.onsuccess = () => {
                if (!params.isGenerationCurrent()) {
                  abortWith('generation_changed');
                  return;
                }
                committed = next;
              };
            } catch {
              abortWith(null);
            }
          };
        } catch {
          abortWith(null);
        }
      };
    } catch (err) {
      abortWith(null);
      settle(() => reject(err instanceof Error ? err : new Error('Remember transaction failed')));
    }
  });
}

/** The slice of `GET /vault` silent unlock needs. */
export interface LoadedDeviceVault {
  vault_key_id: string;
  private_keys_wrapped?: string;
}

// ---------------------------------------------------------------------------
// Reading the device state
// ---------------------------------------------------------------------------

export interface DeviceRecordEntry {
  vaultKeyId: string;
  /** `null` when the stored value is not a well-formed DevKey record (ignored by Remember state and silent unlock). */
  record: StoredDevKeyRecord | null;
}

export interface DeviceSnapshot {
  meta: DeviceMetaRecord | null;
  /** Every record of the user (any `vault_key_id`), read in ONE readonly tx together with the meta record. */
  entries: DeviceRecordEntry[];
}

/**
 * Realm-independent `Uint8Array` check: bytes that crossed a MessageChannel / structured clone (Worker response, IndexedDB
 * read) may come from another realm (jsdom vs Node, iframe), where `instanceof Uint8Array` is false.
 */
function isUint8ArrayLike(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}

export function isWellFormedDevKeyRecord(
  value: unknown,
  userId: string,
  vaultKeyId: string,
): value is StoredDevKeyRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.user_id === userId &&
    v.vault_key_id === vaultKeyId &&
    typeof v.dev_key === 'object' &&
    v.dev_key !== null &&
    isUint8ArrayLike(v.wrapped_vk) &&
    v.wrapped_vk.byteLength === DEVKEY_WRAPPED_VK_BYTES
  );
}

/** Reads the meta record and all records of `userId` in one readonly tx (a consistent view). Rejects on IDB errors. */
export async function readDeviceSnapshot(userId: string, env?: DeviceEnvironment): Promise<DeviceSnapshot> {
  return withDb(env, (db) =>
    new Promise<DeviceSnapshot>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction([DEVKEY_STORE_NAME, META_STORE_NAME], 'readonly');
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Failed to start device snapshot transaction'));
        return;
      }
      let metaRaw: unknown;
      const found: Array<{ key: IDBValidKey; value: unknown }> = [];
      tx.oncomplete = () => {
        const entries: DeviceRecordEntry[] = [];
        for (const { key, value } of found) {
          const vaultKeyId = parseDevKeyRecordVaultKeyId(key, value);
          if (vaultKeyId === null) continue;
          entries.push({
            vaultKeyId,
            record: isWellFormedDevKeyRecord(value, userId, vaultKeyId) ? value : null,
          });
        }
        resolve({ meta: isValidDeviceMetaRecord(metaRaw) ? metaRaw : null, entries });
      };
      tx.onerror = () => reject(tx.error ?? new Error('Device snapshot transaction error'));
      tx.onabort = () => reject(tx.error ?? new Error('Device snapshot transaction aborted'));
      try {
        const metaReq = tx.objectStore(META_STORE_NAME).get(DEVICE_META_RECORD_KEY);
        metaReq.onsuccess = () => {
          metaRaw = metaReq.result;
        };
        const devkeys = tx.objectStore(DEVKEY_STORE_NAME);
        const keysReq = devkeys.getAllKeys();
        keysReq.onsuccess = () => {
          const keys = Array.isArray(keysReq.result) ? keysReq.result : [];
          for (const key of keys) {
            if (parseDevKeyRecordUserId(key, undefined) !== userId) continue;
            const valReq = devkeys.get(key);
            valReq.onsuccess = () => {
              found.push({ key, value: valReq.result });
            };
          }
        };
      } catch (err) {
        try {
          tx.abort();
        } catch {
          // Ignore
        }
        reject(err instanceof Error ? err : new Error('Device snapshot transaction failed'));
      }
    }),
  );
}

export interface DeviceRememberedState {
  /** `true` when a well-formed DevKey record exists for `(userId, vaultKeyId)`. */
  remembered: boolean;
  meta: DeviceMetaRecord | null;
}

/** Reads the toggle state from `sabk.device`. IDB errors resolve `{ remembered: false, meta: null }` (default off). */
export async function readDeviceRememberedState(
  userId: string,
  vaultKeyId: string,
  env?: DeviceEnvironment,
): Promise<DeviceRememberedState> {
  try {
    const snapshot = await readDeviceSnapshot(userId, env);
    const own = snapshot.entries.find((e) => e.vaultKeyId === vaultKeyId);
    return { remembered: own?.record != null, meta: snapshot.meta };
  } catch {
    return { remembered: false, meta: null };
  }
}

// ---------------------------------------------------------------------------
// Remember
// ---------------------------------------------------------------------------

/** The slice of `CryptoClient` Remember needs (the real client and test doubles both fit). */
export interface DeviceWrapClient {
  captureGeneration(): number;
  wrapForDevice(params: {
    devKey: CryptoKey;
    userId: string;
    vaultKeyId: string;
    opGeneration: number;
  }): Promise<{ wrapped_vk: Uint8Array }>;
}

export type RememberAbortReason =
  | 'generation_changed'
  | 'vault_locked'
  | 'meta_missing'
  | 'meta_changed'
  | 'vault_absent'
  | 'vault_mismatch'
  | 'vault_unverifiable';

export type RememberDeviceResult =
  | { status: 'remembered'; meta: DeviceMetaRecord }
  | { status: 'aborted'; reason: RememberAbortReason }
  | { status: 'unavailable'; reason: 'idb_error' | 'locks_unavailable' | 'webcrypto_error' | 'worker_error'; code?: CryptoClientErrorCode };

export interface RememberDeviceParams {
  client: DeviceWrapClient;
  /** Captured by the caller (`client.captureGeneration()` / `beginOp()`) before its first `await`. */
  opGeneration: number;
  userId: string;
  vaultKeyId: string;
  env?: DeviceEnvironment;
  /** `GET /vault` used for the in-lock re-verification; defaults to `lib/api/vault.fetchVault`. */
  fetchVault?: (opts: { signal: AbortSignal }) => Promise<{ vault_key_id: string }>;
  testHooks?: RememberTestHooks;
}

function isVaultAbsentError(err: unknown): boolean {
  return err instanceof ProblemError && (err.problem.status === 404 || err.problem.code === 'vault_absent');
}

type VaultVerification = 'ok' | 'vault_absent' | 'vault_mismatch' | 'vault_unverifiable';

async function verifyVaultInsideLock(
  expectedVaultKeyId: string,
  fetchVaultFn: NonNullable<RememberDeviceParams['fetchVault']>,
): Promise<VaultVerification> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMEMBER_VAULT_VERIFY_TIMEOUT_MS);
  try {
    const vault = await fetchVaultFn({ signal: controller.signal });
    return vault.vault_key_id === expectedVaultKeyId ? 'ok' : 'vault_mismatch';
  } catch (err) {
    return isVaultAbsentError(err) ? 'vault_absent' : 'vault_unverifiable';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * "Remember this device": generates a non-extractable AES-GCM DevKey, has the Worker seal VK with it
 * (`wrapForDevice`) and stores both, subject to the compare-and-write fence described in the module header.
 * The vault MUST be unlocked in the Worker (`VAULT_LOCKED` otherwise). Never throws.
 */
export async function rememberDevice(params: RememberDeviceParams): Promise<RememberDeviceResult> {
  const { client, opGeneration, userId, vaultKeyId, env } = params;
  const hooks = testHooksAllowed() ? params.testHooks : undefined;
  const fetchVaultFn = params.fetchVault ?? ((opts) => fetchVault(opts));
  const isGenerationCurrent = () => client.captureGeneration() === opGeneration;

  if (!isGenerationCurrent()) return { status: 'aborted', reason: 'generation_changed' };

  // Before WebCrypto: capture (startIncarnation, startRevision), creating the meta record on first use.
  let start: DeviceMetaRecord;
  try {
    start = await withDb(env, (db) => ensureDeviceMetaTx(db));
  } catch {
    return { status: 'unavailable', reason: 'idb_error' };
  }

  let wrappedVk: Uint8Array | null = null;
  let devKey: CryptoKey | null = null;
  const discard = () => {
    wrappedVk?.fill(0);
    wrappedVk = null;
    devKey = null;
  };

  try {
    try {
      devKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } catch {
      return { status: 'unavailable', reason: 'webcrypto_error' };
    }
    try {
      const res = await client.wrapForDevice({ devKey, userId, vaultKeyId, opGeneration });
      wrappedVk = res.wrapped_vk;
    } catch (err) {
      if (err instanceof CryptoClientError) {
        if (err.code === 'STALE_GENERATION') return { status: 'aborted', reason: 'generation_changed' };
        if (err.code === 'VAULT_LOCKED' || err.code === 'VAULT_RECOVERING') {
          return { status: 'aborted', reason: 'vault_locked' };
        }
        return { status: 'unavailable', reason: 'worker_error', code: err.code };
      }
      return { status: 'unavailable', reason: 'worker_error' };
    }
    if (wrappedVk.byteLength !== DEVKEY_WRAPPED_VK_BYTES) {
      return { status: 'unavailable', reason: 'worker_error', code: 'WRAP_INVALID' };
    }

    if (hooks?.afterWebCrypto) await hooks.afterWebCrypto();

    const sealedVk = wrappedVk;
    const sealedKey = devKey;
    type LockedOutcome =
      | { kind: 'result'; result: RememberDeviceResult }
      | { kind: 'commit'; outcome: RememberCommitOutcome };
    let locked: LockedOutcome;
    try {
      locked = await withVaultWebLock<LockedOutcome>(async () => {
        // Compare-and-write under the lock: the vault named by this Remember must still be THE vault on the server.
        const verification = await verifyVaultInsideLock(vaultKeyId, fetchVaultFn);
        if (verification !== 'ok') {
          return { kind: 'result', result: { status: 'aborted', reason: verification } };
        }
        if (hooks?.afterVaultVerified) await hooks.afterVaultVerified();
        const outcome = await withDb(env, (db) =>
          commitRememberTx(db, {
            userId,
            vaultKeyId,
            start,
            devKey: sealedKey,
            wrappedVk: sealedVk,
            isGenerationCurrent,
            onKeyListSuccess: hooks?.onKeyListSuccess,
          }),
        );
        return { kind: 'commit', outcome };
      }, env?.locksManager);
    } catch (err) {
      const locksMissing = err instanceof Error && err.message === 'Web Locks API is unavailable';
      return { status: 'unavailable', reason: locksMissing ? 'locks_unavailable' : 'idb_error' };
    }

    if (locked.kind === 'result') return locked.result;
    if (locked.outcome.status === 'aborted') return { status: 'aborted', reason: locked.outcome.reason };
    notifyDeviceStateChange();
    return { status: 'remembered', meta: locked.outcome.meta };
  } finally {
    // The record keeps its own structured clone; the in-memory copies are dropped on every path.
    discard();
  }
}

// ---------------------------------------------------------------------------
// Forget
// ---------------------------------------------------------------------------

export type ForgetDeviceResult =
  | { status: 'forgotten'; meta: DeviceMetaRecord | null; deletedCount: number }
  | { status: 'unavailable' };

/**
 * "Forget this device": ONE `readwrite` purge tx deleting every DevKey record of `userId` and rotating
 * `{ incarnation, deviceRevision + 1 }`, so a Remember that is parked at WebCrypto in any tab aborts. The open VK
 * stays in the Worker until lock / logout (ADR 0003 §6.3).
 */
export async function forgetDevice(userId: string, env?: DeviceEnvironment): Promise<ForgetDeviceResult> {
  const res = await purgeDeviceKeysOnRevoked(userId, env);
  if (!res.ok) return { status: 'unavailable' };
  notifyDeviceStateChange();
  return { status: 'forgotten', meta: res.meta, deletedCount: res.deletedCount };
}

// ---------------------------------------------------------------------------
// Silent unlock
// ---------------------------------------------------------------------------

export type SilentUnlockSkipReason = 'no_user' | 'not_locked' | 'busy' | 'not_remembered' | 'stale';
export type SilentUnlockFallbackReason =
  | 'idb_error'
  | 'vault_unavailable'
  | 'vault_absent'
  | 'vault_mismatch'
  | 'unlock_failed';

export type SilentUnlockResult =
  | { status: 'unlocked' }
  | { status: 'skipped'; reason: SilentUnlockSkipReason }
  | { status: 'fallback'; reason: SilentUnlockFallbackReason; code?: CryptoClientErrorCode };

export interface SilentUnlockParams {
  userId: string;
  /** Captured by the caller before its first `await`. */
  opGeneration: number;
  /** `false` once a lock / logout / account switch moved on; checked after every await before the next step. */
  isCurrent: () => boolean;
  /** Authoritative `GET /vault`: the vault, or `null` for `404 vault_absent` (the loader already purged). Rejects otherwise. */
  loadVault: () => Promise<LoadedDeviceVault | null>;
  unlock: (params: UnlockDevKeyClientParams) => Promise<{ unlocked: true }>;
  /** Called when post-dispatch verification detects that Forget or a device meta change occurred while `unlockDevKey` was in flight (advisor-dec-054). */
  lockOnInvalidate?: () => Promise<unknown>;
  env?: DeviceEnvironment;
  /** Overridable for tests; defaults to the key-scoped purge. */
  purgeStale?: (scope: DeviceKeyScope) => Promise<unknown>;
}

/**
 * Silent unlock (reload, re-login, auto-lock): only after `GET /vault` returned the vault whose `vault_key_id` the
 * stored DevKey record is namespaced under. A device without any record never touches the network. A record for
 * another `vault_key_id` (vault reset elsewhere) is purged (key-scoped: the present vault's record survives) and the
 * flow falls back to the passphrase. Never throws.
 */
export async function runSilentDeviceUnlock(params: SilentUnlockParams): Promise<SilentUnlockResult> {
  const { userId, opGeneration, isCurrent, env } = params;

  let snapshot: DeviceSnapshot;
  try {
    snapshot = await readDeviceSnapshot(userId, env);
  } catch {
    return { status: 'fallback', reason: 'idb_error' };
  }
  if (snapshot.entries.length === 0) return { status: 'skipped', reason: 'not_remembered' };
  if (!isCurrent()) return { status: 'skipped', reason: 'stale' };

  const startMeta = snapshot.meta;
  const areBytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  };
  const isSnapshotRecordStillCurrent = (
    latest: DeviceSnapshot,
    vaultKeyId: string,
    expectedRecord: StoredDevKeyRecord,
  ): boolean => {
    if (startMeta !== null) {
      if (
        latest.meta === null ||
        latest.meta.incarnation !== startMeta.incarnation ||
        latest.meta.deviceRevision !== startMeta.deviceRevision
      ) {
        return false;
      }
    } else if (latest.meta !== null) {
      return false;
    }
    const latestRecord = latest.entries.find((e) => e.vaultKeyId === vaultKeyId)?.record ?? null;
    if (latestRecord === null) return false;
    return (
      latestRecord.user_id === expectedRecord.user_id &&
      latestRecord.vault_key_id === expectedRecord.vault_key_id &&
      areBytesEqual(latestRecord.wrapped_vk, expectedRecord.wrapped_vk)
    );
  };

  let vault: LoadedDeviceVault | null;
  try {
    vault = await params.loadVault();
  } catch {
    return { status: 'fallback', reason: 'vault_unavailable' };
  }
  if (vault === null) return { status: 'fallback', reason: 'vault_absent' };
  if (!isCurrent()) return { status: 'skipped', reason: 'stale' };

  const own = snapshot.entries.find((e) => e.vaultKeyId === vault.vault_key_id)?.record ?? null;
  if (own === null) {
    const purge =
      params.purgeStale ?? ((scope: DeviceKeyScope) => purgeDeviceKeysOnRevoked(userId, env, { keyScope: scope }));
    try {
      await purge({ except: vault.vault_key_id });
    } catch {
      // Best effort: the passphrase fallback is unaffected.
    }
    return { status: 'fallback', reason: 'vault_mismatch' };
  }

  // Revalidate captured device (incarnation, deviceRevision) + record after loadVault() and immediately before unlockDevKey.
  let postVaultSnapshot: DeviceSnapshot;
  try {
    postVaultSnapshot = await readDeviceSnapshot(userId, env);
  } catch {
    return { status: 'fallback', reason: 'idb_error' };
  }
  if (!isCurrent()) return { status: 'skipped', reason: 'stale' };
  if (!isSnapshotRecordStillCurrent(postVaultSnapshot, vault.vault_key_id, own)) {
    return { status: 'skipped', reason: 'stale' };
  }

  try {
    await params.unlock({
      devKey: own.dev_key as CryptoKey,
      wrappedVk: own.wrapped_vk,
      userId,
      vaultKeyId: vault.vault_key_id,
      privateKeysWrapped: vault.private_keys_wrapped,
      opGeneration,
      beforePostMessage: async () => {
        if (!isCurrent()) {
          throw new CryptoClientError('STALE_GENERATION', 'Silent unlock superseded before Worker dispatch');
        }
        let finalSnapshot: DeviceSnapshot;
        try {
          finalSnapshot = await readDeviceSnapshot(userId, env);
        } catch {
          throw new CryptoClientError('STALE_GENERATION', 'Failed to reverify device record before Worker dispatch');
        }
        if (!isCurrent() || !isSnapshotRecordStillCurrent(finalSnapshot, vault.vault_key_id, own)) {
          throw new CryptoClientError('STALE_GENERATION', 'Device state or Forget invalidated pending silent unlock');
        }
      },
    });
    let postUnlockSnapshot: DeviceSnapshot;
    try {
      postUnlockSnapshot = await readDeviceSnapshot(userId, env);
    } catch {
      if (isCurrent()) await params.lockOnInvalidate?.();
      return { status: 'skipped', reason: 'stale' };
    }
    if (!isCurrent()) return { status: 'skipped', reason: 'stale' };
    if (!isSnapshotRecordStillCurrent(postUnlockSnapshot, vault.vault_key_id, own)) {
      await params.lockOnInvalidate?.();
      return { status: 'skipped', reason: 'stale' };
    }
    return { status: 'unlocked' };
  } catch (err) {
    if (err instanceof CryptoClientError && err.code === 'STALE_GENERATION') {
      return { status: 'skipped', reason: 'stale' };
    }
    if (err instanceof CryptoClientError && err.code === 'CLIENT_BUSY') {
      return { status: 'skipped', reason: 'busy' };
    }
    return {
      status: 'fallback',
      reason: 'unlock_failed',
      code: err instanceof CryptoClientError ? err.code : undefined,
    };
  }
}
