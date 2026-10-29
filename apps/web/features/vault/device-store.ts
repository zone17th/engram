/**
 * Origin-wide IndexedDB `sabk.device` store helpers for DevKey lifecycle and `revoked` purge
 * (ADR 0003 §6, plan §2.6, Task 15B).
 *
 * Invariants:
 * 1. Database name: `'sabk.device'` (version 1), object stores:
 *    - `'devkeys'`: keyed by `formatDevKeyRecordKey(userId, vaultKeyId)` (`"${user_id}:${vault_key_id}"`)
 *      holding `{ user_id, vault_key_id, dev_key, wrapped_vk, created_at }`.
 *    - `'meta'`: single origin-wide record at key `'__meta__'` holding
 *      `{ incarnation: string, deviceRevision: number }`.
 *    - `'lock_epoch'`: single origin-wide record at key `'__lock_epoch__'`.
 * 2. Every purge (`session_invalid` with `reason = "revoked"`, `"Forget this device"`, `reset`,
 *    or `vault_key_id` mismatch) executes in ONE atomic `readwrite` transaction over
 *    `['devkeys', 'meta']` on `sabk.device`:
 *    - If `userId` is known: deletes all `DevKey` records belonging to `userId` (leaves other
 *      users' `DevKey` records untouched).
 *    - If `userId` is unknown (`null` / `undefined`, e.g. reload bootstrap returns `revoked`
 *      before `me.user.id` is loaded): deletes ALL `DevKey` records across all users.
 *    - Simultaneously overwrites the origin-wide `'__meta__'` record with a fresh 128-bit random
 *      `incarnation` token and `deviceRevision = (currentMeta?.deviceRevision ?? 0) + 1`.
 * 3. NEVER calls `indexedDB.deleteDatabase('sabk.device')` (preserves the anti-race metadata
 *    fence and avoids `blocked` hangs across open tabs).
 * 4. Inside every IndexedDB transaction, ONLY the transaction's own `IDBRequest`s are awaited
 *    (never WebCrypto, Worker messages, `fetch`, or external Promises).
 * 5. Active logout (`reason = 'logout'`) NEVER invokes `purgeDeviceKeysInSingleTx` — DevKey
 *    records remain intact across voluntary sign-out (ADR 0003 §6.5).
 */

import {
  DEVKEY_STORE_NAME,
  DEVICE_META_RECORD_KEY,
  META_STORE_NAME,
  generateIncarnationToken,
  openSabkDeviceDb,
} from './lock-epoch';

export interface DeviceMetaRecord {
  incarnation: string;
  deviceRevision: number;
}

export interface StoredDevKeyRecord {
  user_id: string;
  vault_key_id: string;
  dev_key: CryptoKey | unknown;
  wrapped_vk: Uint8Array;
  created_at: string;
}

export interface DeviceStoreEnvironment {
  idbFactory?: IDBFactory;
}

export interface PurgeDeviceKeysResult {
  ok: boolean;
  meta: DeviceMetaRecord | null;
  deletedCount: number;
}

export function isValidDeviceMetaRecord(value: unknown): value is DeviceMetaRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.incarnation === 'string' &&
    v.incarnation.length > 0 &&
    typeof v.deviceRevision === 'number' &&
    Number.isSafeInteger(v.deviceRevision) &&
    v.deviceRevision >= 1
  );
}

export function formatDevKeyRecordKey(userId: string, vaultKeyId: string): string {
  return `${userId}:${vaultKeyId}`;
}

export function parseDevKeyRecordUserId(
  key: IDBValidKey,
  value: unknown,
): string | null {
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>;
    if (typeof rec.user_id === 'string' && rec.user_id.length > 0) {
      return rec.user_id;
    }
  }
  if (typeof key === 'string') {
    const colonIdx = key.indexOf(':');
    if (colonIdx > 0) {
      return key.slice(0, colonIdx);
    }
    if (key.length > 0) {
      return key;
    }
  }
  if (Array.isArray(key) && typeof key[0] === 'string' && key[0].length > 0) {
    return key[0];
  }
  return null;
}

let defaultDeviceStoreEnv: DeviceStoreEnvironment = {};
let lastKnownSessionUserId: string | null = null;
const purgeListeners = new Set<(result: PurgeDeviceKeysResult) => void>();

/** Sets the current known authenticated `user_id` so a terminal `revoked` response can scope its purge. */
export function setKnownDeviceSessionUserId(userId: string | null): void {
  lastKnownSessionUserId = userId;
}

/** Reads the last known authenticated `user_id` (or `null` when unknown / never loaded). */
export function getKnownDeviceSessionUserId(): string | null {
  return lastKnownSessionUserId;
}

/** Configures the default `IDBFactory` used by automatic `revoked` purge hooks (used in unit tests). */
export function setDefaultDeviceStoreEnvironmentForTests(
  env: DeviceStoreEnvironment,
): void {
  defaultDeviceStoreEnv = env;
}

/** Subscribes to completed `revoked` / device purge operations. */
export function subscribeDevicePurge(
  listener: (result: PurgeDeviceKeysResult) => void,
): () => void {
  purgeListeners.add(listener);
  return () => {
    purgeListeners.delete(listener);
  };
}

/**
 * Executes a single atomic `readwrite` transaction on `sabk.device` over `['devkeys', 'meta']`:
 * - Deletes DevKey records for `userId` (or ALL DevKey records across all users when `userId` is `null`/`undefined`).
 * - Rotates `meta.__meta__` to `{ incarnation: freshIncarnation, deviceRevision: (cur?.deviceRevision ?? 0) + 1 }`.
 * - Awaits ONLY `IDBRequest`s belonging to this transaction.
 * - Never calls `indexedDB.deleteDatabase`.
 */
function runSingleReadwritePurgeTx(
  db: IDBDatabase,
  userId: string | null,
  freshIncarnation: string,
): Promise<{ meta: DeviceMetaRecord; deletedCount: number }> {
  return new Promise<{ meta: DeviceMetaRecord; deletedCount: number }>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([DEVKEY_STORE_NAME, META_STORE_NAME], 'readwrite');
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to start device purge transaction'));
      return;
    }

    let committedMeta: DeviceMetaRecord | null = null;
    let deletedCount = 0;
    let settled = false;

    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason instanceof Error ? reason : new Error('Device purge transaction failed'));
    };

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      if (committedMeta) {
        resolve({ meta: committedMeta, deletedCount });
      } else {
        reject(new Error('Device purge transaction completed without updating meta'));
      }
    };
    tx.onerror = () => fail(tx.error ?? new Error('Device purge transaction error'));
    tx.onabort = () => fail(tx.error ?? new Error('Device purge transaction aborted'));

    try {
      const devkeysStore = tx.objectStore(DEVKEY_STORE_NAME);
      const metaStore = tx.objectStore(META_STORE_NAME);

      const abortTx = () => {
        try {
          tx.abort();
        } catch {
          // Ignore
        }
      };

      const writeRotatedMeta = () => {
        const metaGetReq = metaStore.get(DEVICE_META_RECORD_KEY);
        metaGetReq.onerror = abortTx;
        metaGetReq.onsuccess = () => {
          try {
            const curRaw: unknown = metaGetReq.result;
            const cur = isValidDeviceMetaRecord(curRaw) ? curRaw : null;
            const nextMeta: DeviceMetaRecord = {
              incarnation: freshIncarnation,
              deviceRevision: (cur?.deviceRevision ?? 0) + 1,
            };
            const metaPutReq = metaStore.put(nextMeta, DEVICE_META_RECORD_KEY);
            metaPutReq.onerror = abortTx;
            metaPutReq.onsuccess = () => {
              committedMeta = nextMeta;
            };
          } catch (err) {
            abortTx();
            fail(err);
          }
        };
      };

      if (!userId) {
        // Unknown user: clear all DevKey records across all users in this single readwrite tx,
        // then rotate origin-wide meta.
        if (typeof devkeysStore.getAllKeys === 'function') {
          const keysReq = devkeysStore.getAllKeys();
          keysReq.onerror = abortTx;
          keysReq.onsuccess = () => {
            try {
              const keys = Array.isArray(keysReq.result) ? keysReq.result : [];
              deletedCount = keys.length;
              const clearReq = devkeysStore.clear();
              clearReq.onerror = abortTx;
              clearReq.onsuccess = () => {
                writeRotatedMeta();
              };
            } catch (err) {
              abortTx();
              fail(err);
            }
          };
        } else {
          const clearReq = devkeysStore.clear();
          clearReq.onerror = abortTx;
          clearReq.onsuccess = () => {
            writeRotatedMeta();
          };
        }
      } else {
        // Known user: delete only records matching `userId`, leaving other users' DevKey records intact.
        const keysReq = devkeysStore.getAllKeys();
        keysReq.onerror = abortTx;
        keysReq.onsuccess = () => {
          try {
            const keys = Array.isArray(keysReq.result) ? keysReq.result : [];
            if (keys.length === 0) {
              writeRotatedMeta();
              return;
            }

            let inspected = 0;
            const inspectNext = () => {
              if (inspected === keys.length) {
                writeRotatedMeta();
              }
            };

            for (const key of keys) {
              const valReq = devkeysStore.get(key);
              valReq.onerror = abortTx;
              valReq.onsuccess = () => {
                try {
                  const recUserId = parseDevKeyRecordUserId(key, valReq.result);
                  if (recUserId === userId) {
                    const delReq = devkeysStore.delete(key);
                    delReq.onerror = abortTx;
                    delReq.onsuccess = () => {
                      deletedCount += 1;
                      inspected += 1;
                      inspectNext();
                    };
                  } else {
                    inspected += 1;
                    inspectNext();
                  }
                } catch (err) {
                  abortTx();
                  fail(err);
                }
              };
            }
          } catch (err) {
            abortTx();
            fail(err);
          }
        };
      }
    } catch (err) {
      try {
        tx.abort();
      } catch {
        // Ignore
      }
      fail(err);
    }
  });
}

/**
 * Purges `DevKey` records in ONE `readwrite` transaction on `sabk.device` and rotates
 * `{ incarnation: new random, deviceRevision: (cur?.deviceRevision ?? 0) + 1 }` (ADR 0003 §6.3, §6.6).
 *
 * - When `userId` is provided (non-empty string), deletes only that user's `DevKey` records.
 * - When `userId` is `null` or `undefined` (unknown user, e.g. just reloaded), deletes ALL users'
 *   `DevKey` records.
 * - Never calls `indexedDB.deleteDatabase`.
 */
export async function purgeDeviceKeysOnRevoked(
  userId?: string | null,
  env?: DeviceStoreEnvironment,
): Promise<PurgeDeviceKeysResult> {
  const effectiveUserId =
    userId !== undefined ? userId : lastKnownSessionUserId;
  const effectiveEnv = env ?? defaultDeviceStoreEnv;
  const freshIncarnation = generateIncarnationToken();

  let db: IDBDatabase | null = null;
  try {
    db = await openSabkDeviceDb(effectiveEnv.idbFactory);
    const { meta, deletedCount } = await runSingleReadwritePurgeTx(
      db,
      effectiveUserId && effectiveUserId.length > 0 ? effectiveUserId : null,
      freshIncarnation,
    );
    const result: PurgeDeviceKeysResult = {
      ok: true,
      meta,
      deletedCount,
    };
    for (const listener of [...purgeListeners]) {
      try {
        listener(result);
      } catch {
        // Ignore listener errors
      }
    }
    return result;
  } catch {
    // Gracefully swallow storage blocked / Private Browsing errors (ADR 0003 §6.8)
    const result: PurgeDeviceKeysResult = {
      ok: false,
      meta: null,
      deletedCount: 0,
    };
    return result;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore
    }
  }
}

/**
 * Reads the current origin-wide `DeviceMetaRecord` (`__meta__`) from `sabk.device` (for UI / test inspection).
 */
export async function readDeviceMetaRecord(
  env?: DeviceStoreEnvironment,
): Promise<DeviceMetaRecord | null> {
  const effectiveEnv = env ?? defaultDeviceStoreEnv;
  let db: IDBDatabase | null = null;
  try {
    db = await openSabkDeviceDb(effectiveEnv.idbFactory);
    return await new Promise<DeviceMetaRecord | null>((resolve, reject) => {
      const tx = db!.transaction(META_STORE_NAME, 'readonly');
      const store = tx.objectStore(META_STORE_NAME);
      const req = store.get(DEVICE_META_RECORD_KEY);
      let raw: unknown;
      req.onsuccess = () => {
        raw = req.result;
      };
      tx.oncomplete = () => {
        resolve(isValidDeviceMetaRecord(raw) ? raw : null);
      };
      tx.onerror = () => reject(tx.error ?? new Error('Read device meta failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Read device meta aborted'));
    });
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore
    }
  }
}
