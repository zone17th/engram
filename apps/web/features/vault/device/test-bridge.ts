/**
 * Browser-test-only bridge (installed by `VaultProvider` under the SAME gate as `window.__engramVaultTestBridge`:
 * non-production build or loopback host). It lets Playwright drive the Remember / Forget / purge flows of a REAL tab
 * (real Worker, real IndexedDB, real Web Locks) for the ADR 0003 two-page test, without UI. It exposes booleans, counts
 * and revisions only: never DevKey material, VK or wraps.
 */

import { purgeDeviceKeysOnRevoked, type DeviceMetaRecord } from '@/features/vault/device-store';
import { DEVKEY_STORE_NAME, openSabkDeviceDb } from '@/features/vault/lock-epoch';
import {
  readDeviceSnapshot,
  type DeviceEnvironment,
} from '@/lib/crypto/device';
import {
  createRememberDeviceStore,
  type RememberDeviceContext,
  type RememberDeviceState,
} from './remember-store';

export interface DeviceWorkerWitness {
  /** `true` once the tab's real CryptoWorker has been spawned and exercised at least one command (`epoch >= 0`). */
  workerInitialized: boolean;
  /** Authoritative Worker epoch (`-1` before the first Worker command settles). */
  workerEpoch: number;
  /** Monotonic CryptoClient generation of this tab. */
  workerGeneration: number;
  /** Authoritative Worker state (`locked` | `unlocked` | `recovering` | `error`). */
  workerState: string;
}

export interface IntentBaselineTraceEvent {
  action: 'register' | 'consume' | 'release' | 'missing_owned' | 'capture_fresh';
  generation: number;
  id?: number;
  kind?: 'manual' | 'owned';
}

export interface DeviceTestSnapshot {
  /** Number of well-formed or malformed DevKey records of the signed-in user. */
  userRecordCount: number;
  /** Number of DevKey records of every user in the DB. */
  allRecordCount: number;
  meta: DeviceMetaRecord | null;
  workerInitialized: boolean;
  workerEpoch: number;
  workerGeneration: number;
  workerState: string;
}

export interface DeviceTestBridge {
  /** Starts Remember through the real store; the flow parks AFTER WebCrypto (before the Web Lock) until `release()`. */
  startPausedRemember: () => void;
  /** `true` once the parked Remember reached the WebCrypto wait (its start meta is captured by then). */
  isPausedAtWebCrypto: () => boolean;
  release: () => void;
  /** Resolves the state after the parked Remember settled. */
  awaitRemember: () => Promise<RememberDeviceState>;
  /** Remember without pause. */
  remember: () => Promise<RememberDeviceState>;
  forget: () => Promise<RememberDeviceState>;
  /** Purge as reset / revoked would: `known` = the signed-in user's records; `unknown_user` = every record. */
  purge: (scope: 'known' | 'unknown_user') => Promise<{ ok: boolean }>;
  state: () => RememberDeviceState;
  refresh: () => Promise<RememberDeviceState>;
  snapshot: () => Promise<DeviceTestSnapshot>;
  workerWitness: () => DeviceWorkerWitness;
  intentBaselineWitness: () => {
    pending: Array<{ generation: number; id: number; kind: 'manual' | 'owned' }>;
    trace: IntentBaselineTraceEvent[];
    removeEntry: (generation: number, id: number) => boolean;
  };
}

export function createDeviceTestBridge(options: {
  getContext: () => RememberDeviceContext | null;
  getWorkerWitness?: () => DeviceWorkerWitness;
  getIntentBaselineWitness?: () => {
    pending: Array<{ generation: number; id: number; kind: 'manual' | 'owned' }>;
    trace: IntentBaselineTraceEvent[];
    removeEntry: (generation: number, id: number) => boolean;
  };
  env?: DeviceEnvironment;
}): DeviceTestBridge {
  let paused = false;
  let release: () => void = () => undefined;
  let pending: Promise<RememberDeviceState> | null = null;

  const plain = createRememberDeviceStore({ getContext: options.getContext, env: options.env });
  const parked = createRememberDeviceStore({
    getContext: options.getContext,
    env: options.env,
    testHooks: {
      afterWebCrypto: () =>
        new Promise<void>((resolve) => {
          paused = true;
          release = () => {
            paused = false;
            resolve();
          };
        }),
    },
  });

  return {
    startPausedRemember: () => {
      pending = parked.remember();
    },
    isPausedAtWebCrypto: () => paused,
    release: () => release(),
    awaitRemember: async () => {
      if (!pending) throw new Error('No paused Remember was started');
      return pending;
    },
    remember: () => plain.remember(),
    forget: () => plain.forget(),
    purge: async (scope) => {
      const ctx = options.getContext();
      const res = await purgeDeviceKeysOnRevoked(scope === 'known' ? (ctx?.userId ?? null) : null, options.env);
      return { ok: res.ok };
    },
    state: () => (pending ? parked.getState() : plain.getState()),
    refresh: async () => {
      await (pending ? parked.refresh() : plain.refresh());
      return pending ? parked.getState() : plain.getState();
    },
    snapshot: async () => {
      const ctx = options.getContext();
      const snap = await readDeviceSnapshot(ctx?.userId ?? '', options.env);
      const witness = options.getWorkerWitness?.() ?? {
        workerInitialized: false,
        workerEpoch: -1,
        workerGeneration: 0,
        workerState: 'locked',
      };
      return {
        userRecordCount: snap.entries.length,
        allRecordCount: await countAll(options.env),
        meta: snap.meta,
        ...witness,
      };
    },
    workerWitness: () =>
      options.getWorkerWitness?.() ?? {
        workerInitialized: false,
        workerEpoch: -1,
        workerGeneration: 0,
        workerState: 'locked',
      },
    intentBaselineWitness: () =>
      options.getIntentBaselineWitness?.() ?? {
        pending: [],
        trace: [],
        removeEntry: () => false,
      },
  };
}

async function countAll(env?: DeviceEnvironment): Promise<number> {
  const db = await openSabkDeviceDb(env?.idbFactory);
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(DEVKEY_STORE_NAME, 'readonly');
      const req = tx.objectStore(DEVKEY_STORE_NAME).getAllKeys();
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result.length : 0);
      req.onerror = () => reject(req.error ?? new Error('count failed'));
    });
  } finally {
    db.close();
  }
}
