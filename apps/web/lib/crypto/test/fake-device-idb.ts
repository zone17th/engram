/**
 * Test doubles for `sabk.device` (IndexedDB) and Web Locks, shared by the Task 18 Vitest suites. No new dependency.
 *
 * Fidelity points the DevKey protocol depends on:
 * - All transactions (both `readwrite` and `readonly`) run strictly one after the other in creation order, queuing
 *   overlapping readers behind earlier writers so a reader never observes uncommitted writes before commit or rollback.
 * - A transaction auto-commits once no request is pending, and placing a request after that (or from a foreign
 *   `await`, i.e. outside the creation task / a request callback) throws `TransactionInactiveError`: a protocol that
 *   awaits WebCrypto / fetch / Worker messages inside a tx fails here.
 * - `abort()` rolls back every write of the transaction.
 * - `wipe()` models the browser / user deleting the DB: data and stores are gone and the next open runs the upgrade.
 * - `deleteDatabase` always throws and is counted (the protocol must NEVER call it).
 */

import { SABK_VAULT_WEB_LOCK_NAME } from '@/features/vault/lock-epoch';

export interface FakeDeviceTransactionInfo {
  storeNames: string[];
  mode: IDBTransactionMode;
  /** Whether `sabk.vault.lock` was held when the transaction was created. */
  lockHeld: boolean;
}

export class FakeWebLocks {
  private readonly heldNames = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  failLocks = false;

  isHeld(name: string = SABK_VAULT_WEB_LOCK_NAME): boolean {
    return this.heldNames.has(name);
  }

  createLockManager(): LockManager {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      request(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<unknown>,
        maybeCallback?: LockGrantedCallback<unknown>,
      ): Promise<unknown> {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
        if (self.failLocks) return Promise.reject(new Error('Web Locks blocked'));
        const run = async () => {
          self.heldNames.add(name);
          try {
            return await callback({ name, mode: 'exclusive' } as Lock);
          } finally {
            self.heldNames.delete(name);
          }
        };
        const next = self.queue.then(run, run);
        self.queue = next.catch(() => undefined);
        return next;
      },
      query: async () => ({ held: [], pending: [] }),
    } as unknown as LockManager;
  }
}

export class FakeDeviceIdb {
  readonly stores = new Map<string, Map<string, unknown>>();
  readonly transactions: FakeDeviceTransactionInfo[] = [];
  options: { failOpen?: boolean; blockOpen?: boolean } = {};
  deleteDatabaseCalls = 0;
  /** Called synchronously when a transaction is created (e.g. to assert a lock is held). */
  onTransaction?: (info: FakeDeviceTransactionInfo) => void;
  private tail: Promise<void> = Promise.resolve();
  private upgraded = false;

  constructor(private readonly locks?: FakeWebLocks) {}

  store(name: string): Map<string, unknown> {
    let store = this.stores.get(name);
    if (!store) {
      store = new Map();
      this.stores.set(name, store);
    }
    return store;
  }

  /** The DB was deleted behind the app's back (browser data clearing, corruption): everything incl. meta is gone. */
  wipe(): void {
    this.stores.clear();
    this.upgraded = false;
  }

  createFactory(): IDBFactory {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
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
          if (self.options.failOpen) {
            req.error = new Error('Simulated IDB open failure (private mode)');
            (req.onerror as (() => void) | null)?.();
            return;
          }
          if (self.options.blockOpen) {
            (req.onblocked as (() => void) | null)?.();
            return;
          }
          req.result = self.createDb();
          // Real IndexedDB runs `upgradeneeded` once for a new (version 0) database, even when a test seeded one store
          // directly through `store()` beforehand; the handler creates the stores and keeps any seeded data.
          if (!self.upgraded) {
            self.upgraded = true;
            (req.onupgradeneeded as (() => void) | null)?.();
          }
          (req.onsuccess as (() => void) | null)?.();
        });
        return req as unknown as IDBOpenDBRequest;
      },
      deleteDatabase(): IDBOpenDBRequest {
        self.deleteDatabaseCalls += 1;
        throw new Error('indexedDB.deleteDatabase must NEVER be called');
      },
    } as unknown as IDBFactory;
  }

  private createDb(): IDBDatabase {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const db = {
      objectStoreNames: { contains: (name: string) => self.stores.has(name) },
      onversionchange: null,
      createObjectStore(name: string) {
        self.store(name);
        return {} as IDBObjectStore;
      },
      close() {
        // no-op
      },
      transaction(storeNames: string | string[], mode: IDBTransactionMode = 'readonly'): IDBTransaction {
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        for (const name of names) {
          if (!self.stores.has(name)) throw new Error(`NotFoundError: no object store ${name}`);
        }
        return self.createTransaction(names, mode);
      },
    };
    return db as unknown as IDBDatabase;
  }

  private createTransaction(names: string[], mode: IDBTransactionMode): IDBTransaction {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const info: FakeDeviceTransactionInfo = {
      storeNames: names,
      mode,
      lockHeld: self.locks?.isHeld(SABK_VAULT_WEB_LOCK_NAME) ?? false,
    };
    self.transactions.push(info);
    self.onTransaction?.(info);

    let releaseTurn: () => void = () => undefined;
    const previous = self.tail;
    self.tail = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const turn: Promise<void> = previous;

    let started = false;
    let finished = false;
    let active = true;
    let pending = 0;
    let running = false;
    const queue: Array<() => void> = [];
    const snapshot = new Map<string, Map<string, unknown>>();

    const tx: Record<string, unknown> = { error: null, oncomplete: null, onerror: null, onabort: null };

    const rollback = () => {
      for (const [name, copy] of snapshot) {
        const backing = self.store(name);
        backing.clear();
        for (const [key, value] of copy) backing.set(key, value);
      }
    };
    const finishAbort = () => {
      finished = true;
      rollback();
      queueMicrotask(() => {
        (tx.onabort as (() => void) | null)?.();
        releaseTurn();
      });
    };
    const callback = (fn: (() => void) | null | undefined) => {
      active = true;
      try {
        fn?.();
      } finally {
        active = false;
      }
    };
    const check = () => {
      if (finished || !started || pending > 0 || queue.length > 0) return;
      finished = true;
      queueMicrotask(() => {
        (tx.oncomplete as (() => void) | null)?.();
        releaseTurn();
      });
    };
    const pump = () => {
      if (running || !started || finished) return;
      running = true;
      queueMicrotask(() => {
        running = false;
        const op = queue.shift();
        if (op) op();
        if (finished) return;
        if (queue.length > 0) pump();
        else queueMicrotask(check);
      });
    };

    void turn.then(() => {
      if (mode === 'readwrite') {
        for (const name of names) snapshot.set(name, new Map(self.store(name)));
      }
      started = true;
      pump();
      queueMicrotask(check);
    });
    // The creation task ends: the tx is only active inside request callbacks from now on.
    setTimeout(() => {
      active = false;
    }, 0);

    tx.abort = () => {
      if (finished) throw new Error('InvalidStateError: transaction already finished');
      finishAbort();
    };
    tx.objectStore = (name: string): IDBObjectStore => {
      if (!names.includes(name)) throw new Error(`NotFoundError: ${name} is not in the transaction scope`);
      const backing = self.store(name);
      const request = (run: () => unknown): IDBRequest => {
        if (finished || !active) throw new Error('TransactionInactiveError: request on an inactive transaction');
        const req: Record<string, unknown> = { result: undefined, error: null, onsuccess: null, onerror: null };
        pending += 1;
        queue.push(() => {
          pending -= 1;
          if (finished) return;
          req.result = run();
          callback(req.onsuccess as (() => void) | null);
        });
        pump();
        return req as unknown as IDBRequest;
      };
      const requireWrite = () => {
        if (mode !== 'readwrite') throw new Error('ReadOnlyError');
      };
      return {
        get: (key: IDBValidKey) =>
          request(() => {
            const value = backing.get(String(key));
            return value === undefined ? undefined : structuredClone(value);
          }),
        getAllKeys: () => request(() => Array.from(backing.keys())),
        put: (value: unknown, key?: IDBValidKey) => {
          requireWrite();
          return request(() => {
            backing.set(String(key), structuredClone(value));
            return key;
          });
        },
        delete: (key: IDBValidKey) => {
          requireWrite();
          return request(() => {
            backing.delete(String(key));
            return undefined;
          });
        },
        clear: () => {
          requireWrite();
          return request(() => {
            backing.clear();
            return undefined;
          });
        },
      } as unknown as IDBObjectStore;
    };
    return tx as unknown as IDBTransaction;
  }
}
