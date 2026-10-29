/**
 * Authoritative `lockEpoch` marker in IndexedDB `sabk.device` under Web Lock `'sabk.vault.lock'`
 * (ADR 0003 §8).
 *
 * Invariants:
 * 1. Authoritative record `{ epochIncarnation: string, lockEpoch: number }` is stored in IndexedDB
 *    `sabk.device` object store `lock_epoch` under key `'__lock_epoch__'`.
 *    `sabk.device` also defines `devkeys` and `meta` object stores at version 1 so the DB schema
 *    stays compatible with Task 18 (`lib/crypto/device.ts`).
 * 2. Every read/write runs inside `navigator.locks.request('sabk.vault.lock', { mode: 'exclusive' })`.
 * 3. Inside every IndexedDB transaction, ONLY the transaction's own `IDBRequest`s are awaited
 *    (never WebCrypto, Worker messages, `fetch`, or external Promises).
 * 4. Lock writer: `next = Math.max(cur?.lockEpoch ?? 0, tabKnownLockEpoch) + 1`.
 *    If the write transaction fails or aborts, the writer opens a separate `readwrite` transaction
 *    inside the same Web Lock region that ONLY deletes the marker record so waking tabs see the
 *    marker as missing and fail closed.
 * 5. Unlock baseline: captured under the Web Lock before unlock starts; verified under the Web Lock
 *    before transitioning to `unlocked` and on every wake/visibility/focus/pageshow/resume event.
 *    If unreadable (IDB or Web Locks blocked/failed), missing, or != baseline, fail closed (lock).
 */

export const SABK_DEVICE_DB_NAME = 'sabk.device' as const;
export const SABK_DEVICE_DB_VERSION = 1 as const;
export const SABK_VAULT_WEB_LOCK_NAME = 'sabk.vault.lock' as const;

export const LOCK_EPOCH_STORE_NAME = 'lock_epoch' as const;
export const DEVKEY_STORE_NAME = 'devkeys' as const;
export const META_STORE_NAME = 'meta' as const;

export const LOCK_EPOCH_RECORD_KEY = '__lock_epoch__' as const;
export const DEVICE_META_RECORD_KEY = '__meta__' as const;

export interface LockEpochMarker {
  epochIncarnation: string;
  lockEpoch: number;
}

export function isValidLockEpochMarker(value: unknown): value is LockEpochMarker {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.epochIncarnation === 'string' &&
    v.epochIncarnation.length > 0 &&
    typeof v.lockEpoch === 'number' &&
    Number.isSafeInteger(v.lockEpoch) &&
    v.lockEpoch >= 1
  );
}

export function generateIncarnationToken(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function openSabkDeviceDb(idbFactory?: IDBFactory): Promise<IDBDatabase> {
  const factory =
    idbFactory ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  if (!factory || typeof factory.open !== 'function') {
    return Promise.reject(new Error('IndexedDB is unavailable'));
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(SABK_DEVICE_DB_NAME, SABK_DEVICE_DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to open sabk.device'));
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOCK_EPOCH_STORE_NAME)) {
        db.createObjectStore(LOCK_EPOCH_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(DEVKEY_STORE_NAME)) {
        db.createObjectStore(DEVKEY_STORE_NAME);
      }
      if (!db.objectStoreNames.contains(META_STORE_NAME)) {
        db.createObjectStore(META_STORE_NAME);
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try {
          db.close();
        } catch {
          // Ignore
        }
      };
      resolve(db);
    };

    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB open failed'));
    };

    req.onblocked = () => {
      reject(new Error('IndexedDB open blocked'));
    };
  });
}

/**
 * Runs `fn` inside `navigator.locks.request('sabk.vault.lock', { mode: 'exclusive' })`.
 * Rejects if Web Locks API is missing or throws (fail-closed requirement for lockEpoch).
 */
export async function withVaultWebLock<T>(
  fn: () => Promise<T>,
  locksManager?: LockManager,
): Promise<T> {
  const locks =
    locksManager ??
    (typeof navigator !== 'undefined' ? navigator.locks : undefined);
  if (!locks || typeof locks.request !== 'function') {
    throw new Error('Web Locks API is unavailable');
  }
  return locks.request(SABK_VAULT_WEB_LOCK_NAME, { mode: 'exclusive' }, fn);
}

/**
 * Increments `lockEpoch` inside `sabk.device` in a single `readwrite` transaction.
 * Only `IDBRequest`s of the transaction itself are awaited inside the transaction.
 */
function incrementLockEpochTx(
  db: IDBDatabase,
  tabKnownLockEpoch: number,
  freshIncarnation: string,
): Promise<LockEpochMarker> {
  return new Promise<LockEpochMarker>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(LOCK_EPOCH_STORE_NAME, 'readwrite');
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to start readwrite transaction'));
      return;
    }

    let committedMarker: LockEpochMarker | null = null;
    let settled = false;

    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason instanceof Error ? reason : new Error('lockEpoch transaction failed'));
    };

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      if (committedMarker) {
        resolve(committedMarker);
      } else {
        reject(new Error('Transaction completed without writing lockEpoch marker'));
      }
    };
    tx.onerror = () => fail(tx.error ?? new Error('Transaction error'));
    tx.onabort = () => fail(tx.error ?? new Error('Transaction aborted'));

    try {
      const store = tx.objectStore(LOCK_EPOCH_STORE_NAME);
      const getReq = store.get(LOCK_EPOCH_RECORD_KEY);
      getReq.onerror = () => {
        try {
          tx.abort();
        } catch {
          // Ignore
        }
      };
      getReq.onsuccess = () => {
        try {
          const curRaw: unknown = getReq.result;
          const cur = isValidLockEpochMarker(curRaw) ? curRaw : null;
          const nextEpoch = Math.max(cur?.lockEpoch ?? 0, tabKnownLockEpoch) + 1;
          const nextMarker: LockEpochMarker = {
            epochIncarnation: cur ? cur.epochIncarnation : freshIncarnation,
            lockEpoch: nextEpoch,
          };
          const putReq = store.put(nextMarker, LOCK_EPOCH_RECORD_KEY);
          putReq.onerror = () => {
            try {
              tx.abort();
            } catch {
              // Ignore
            }
          };
          putReq.onsuccess = () => {
            committedMarker = nextMarker;
          };
        } catch (err) {
          try {
            tx.abort();
          } catch {
            // Ignore
          }
          fail(err);
        }
      };
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
 * Fallback transaction executed inside the same Web Lock region when the primary `lockEpoch`
 * increment transaction fails: opens a separate `readwrite` transaction that ONLY deletes the
 * marker record so resumed tabs see `missing` and fail closed (ADR 0003 §8.3).
 */
function deleteLockEpochMarkerTx(db: IDBDatabase): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(LOCK_EPOCH_STORE_NAME, 'readwrite');
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to start delete transaction'));
      return;
    }

    let settled = false;
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason instanceof Error ? reason : new Error('Delete marker transaction failed'));
    };

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    tx.onerror = () => fail(tx.error ?? new Error('Delete transaction error'));
    tx.onabort = () => fail(tx.error ?? new Error('Delete transaction aborted'));

    try {
      const store = tx.objectStore(LOCK_EPOCH_STORE_NAME);
      const delReq = store.delete(LOCK_EPOCH_RECORD_KEY);
      delReq.onerror = () => {
        try {
          tx.abort();
        } catch {
          // Ignore
        }
      };
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
 * Captures `unlockBaseline` inside a `readwrite` transaction:
 * - If a valid marker exists with `lockEpoch >= 1` and `lockEpoch >= tabKnownLockEpoch`, returns it.
 * - If the marker is missing or has `lockEpoch < tabKnownLockEpoch`, initializes and writes a fresh
 *   marker `{ epochIncarnation: freshIncarnation, lockEpoch: Math.max(cur?.lockEpoch ?? 0, tabKnownLockEpoch) + 1 }`.
 * Only the transaction's own `IDBRequest`s are awaited inside the transaction.
 */
function captureUnlockBaselineTx(
  db: IDBDatabase,
  tabKnownLockEpoch: number,
  freshIncarnation: string,
): Promise<LockEpochMarker> {
  return new Promise<LockEpochMarker>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(LOCK_EPOCH_STORE_NAME, 'readwrite');
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to start baseline transaction'));
      return;
    }

    let baseline: LockEpochMarker | null = null;
    let settled = false;
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason instanceof Error ? reason : new Error('Baseline transaction failed'));
    };

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      if (baseline) {
        resolve(baseline);
      } else {
        reject(new Error('Baseline transaction completed without baseline'));
      }
    };
    tx.onerror = () => fail(tx.error ?? new Error('Baseline transaction error'));
    tx.onabort = () => fail(tx.error ?? new Error('Baseline transaction aborted'));

    try {
      const store = tx.objectStore(LOCK_EPOCH_STORE_NAME);
      const getReq = store.get(LOCK_EPOCH_RECORD_KEY);
      getReq.onerror = () => {
        try {
          tx.abort();
        } catch {
          // Ignore
        }
      };
      getReq.onsuccess = () => {
        try {
          const curRaw: unknown = getReq.result;
          const cur = isValidLockEpochMarker(curRaw) ? curRaw : null;
          if (cur && cur.lockEpoch >= 1 && cur.lockEpoch >= tabKnownLockEpoch) {
            baseline = cur;
            return;
          }
          const nextMarker: LockEpochMarker = {
            epochIncarnation: freshIncarnation,
            lockEpoch: Math.max(cur?.lockEpoch ?? 0, tabKnownLockEpoch) + 1,
          };
          const putReq = store.put(nextMarker, LOCK_EPOCH_RECORD_KEY);
          putReq.onerror = () => {
            try {
              tx.abort();
            } catch {
              // Ignore
            }
          };
          putReq.onsuccess = () => {
            baseline = nextMarker;
          };
        } catch (err) {
          try {
            tx.abort();
          } catch {
            // Ignore
          }
          fail(err);
        }
      };
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
 * Reads the persisted `lockEpoch` marker in a `readwrite` transaction (serialized with writers).
 * Only the transaction's own `IDBRequest`s are awaited inside the transaction.
 */
function readLockEpochMarkerTx(db: IDBDatabase): Promise<LockEpochMarker | null> {
  return new Promise<LockEpochMarker | null>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(LOCK_EPOCH_STORE_NAME, 'readwrite');
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Failed to start read transaction'));
      return;
    }

    let markerResult: LockEpochMarker | null = null;
    let settled = false;
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason instanceof Error ? reason : new Error('Read marker transaction failed'));
    };

    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(markerResult);
    };
    tx.onerror = () => fail(tx.error ?? new Error('Read transaction error'));
    tx.onabort = () => fail(tx.error ?? new Error('Read transaction aborted'));

    try {
      const store = tx.objectStore(LOCK_EPOCH_STORE_NAME);
      const getReq = store.get(LOCK_EPOCH_RECORD_KEY);
      getReq.onerror = () => {
        try {
          tx.abort();
        } catch {
          // Ignore
        }
      };
      getReq.onsuccess = () => {
        const raw: unknown = getReq.result;
        markerResult = isValidLockEpochMarker(raw) ? raw : null;
      };
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

export interface LockEpochEnvironment {
  idbFactory?: IDBFactory;
  locksManager?: LockManager;
  onBroadcastLock?: (lockEpoch: number) => void;
}

export interface RecordLockEventResult {
  ok: boolean;
  lockEpoch: number;
  markerDeletedOnFailure: boolean;
}

/**
 * Writer protocol on lock (ADR 0003 §8.3):
 * Acquires `'sabk.vault.lock'` exclusive Web Lock, opens `sabk.device`, and runs a `readwrite`
 * transaction to compute `next = Math.max(cur?.lockEpoch ?? 0, tabKnownLockEpoch) + 1` and persist it.
 * If the write transaction fails, opens a separate `readwrite` transaction inside the same Web Lock
 * region that ONLY deletes the marker record, and still broadcasts `lock`.
 */
export async function recordLockEpochEvent(
  tabKnownLockEpoch: number,
  env: LockEpochEnvironment = {},
): Promise<RecordLockEventResult> {
  const fallbackEpoch = tabKnownLockEpoch + 1;
  try {
    return await withVaultWebLock(async () => {
      const freshIncarnation = generateIncarnationToken();
      let db: IDBDatabase | null = null;
      try {
        db = await openSabkDeviceDb(env.idbFactory);
        try {
          const marker = await incrementLockEpochTx(db, tabKnownLockEpoch, freshIncarnation);
          env.onBroadcastLock?.(marker.lockEpoch);
          return {
            ok: true,
            lockEpoch: marker.lockEpoch,
            markerDeletedOnFailure: false,
          };
        } catch {
          // Primary write transaction failed -> delete marker in a separate readwrite tx inside the same Web Lock region
          let deleted = false;
          try {
            await deleteLockEpochMarkerTx(db);
            deleted = true;
          } catch {
            // Residual risk bounded by auto-lock and authoritative Me refresh on wake (ADR 0003 §8.3)
          }
          env.onBroadcastLock?.(fallbackEpoch);
          return {
            ok: false,
            lockEpoch: fallbackEpoch,
            markerDeletedOnFailure: deleted,
          };
        }
      } finally {
        try {
          db?.close();
        } catch {
          // Ignore
        }
      }
    }, env.locksManager);
  } catch {
    env.onBroadcastLock?.(fallbackEpoch);
    return {
      ok: false,
      lockEpoch: fallbackEpoch,
      markerDeletedOnFailure: false,
    };
  }
}

/**
 * Captures `unlockBaseline` under `'sabk.vault.lock'` before an unlock flow begins (ADR 0003 §8.4).
 * Returns `null` if Web Locks or IndexedDB is unavailable or fails (caller must fail closed).
 */
export async function captureUnlockBaseline(
  tabKnownLockEpoch: number,
  env: LockEpochEnvironment = {},
): Promise<LockEpochMarker | null> {
  try {
    return await withVaultWebLock(async () => {
      const freshIncarnation = generateIncarnationToken();
      let db: IDBDatabase | null = null;
      try {
        db = await openSabkDeviceDb(env.idbFactory);
        return await captureUnlockBaselineTx(db, tabKnownLockEpoch, freshIncarnation);
      } finally {
        try {
          db?.close();
        } catch {
          // Ignore
        }
      }
    }, env.locksManager);
  } catch {
    return null;
  }
}

export interface VerifyUnlockBaselineResult {
  matches: boolean;
  persistedMarker: LockEpochMarker | null;
}

/**
 * Reads `persistedMarker` under `'sabk.vault.lock'` and verifies it exists and matches `unlockBaseline`
 * on both `epochIncarnation` and `lockEpoch` (ADR 0003 §8.4).
 * Fails closed (`matches: false`) if unreadable, missing, or mismatched.
 */
export async function verifyUnlockBaseline(
  unlockBaseline: LockEpochMarker | null,
  env: LockEpochEnvironment = {},
): Promise<VerifyUnlockBaselineResult> {
  if (!unlockBaseline) {
    return { matches: false, persistedMarker: null };
  }
  try {
    return await withVaultWebLock(async () => {
      let db: IDBDatabase | null = null;
      try {
        db = await openSabkDeviceDb(env.idbFactory);
        const persisted = await readLockEpochMarkerTx(db);
        if (!persisted) {
          return { matches: false, persistedMarker: null };
        }
        const matches =
          persisted.epochIncarnation === unlockBaseline.epochIncarnation &&
          persisted.lockEpoch === unlockBaseline.lockEpoch;
        return { matches, persistedMarker: persisted };
      } finally {
        try {
          db?.close();
        } catch {
          // Ignore
        }
      }
    }, env.locksManager);
  } catch {
    return { matches: false, persistedMarker: null };
  }
}
