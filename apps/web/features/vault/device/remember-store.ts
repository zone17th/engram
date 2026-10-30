/**
 * Framework-free state of the "Remember this device" toggle (plan Task 18; consumed through `useRememberDevice` by
 * T16B onboarding step 3, T17B unlock and T20B settings). The DB is the single source of truth: after every outcome the
 * state is RE-READ from `sabk.device`, never inferred (ADR 0003 §6.1 "đọc lại bản ghi DevKey ... đặt lại trạng thái
 * công tắc"). A Remember that aborts because another tab changed the device state resets the toggle to what the DB says
 * and raises the neutral `device_state_changed` notice. The same re-read runs on `visibilitychange` (visible), `pageshow`
 * and `focus`, and on every purge / Remember / Forget completed in this tab.
 */

import {
  subscribeDevicePurge,
  type DeviceMetaRecord,
} from '@/features/vault/device-store';
import {
  forgetDevice,
  readDeviceRememberedState,
  rememberDevice,
  subscribeDeviceStateChange,
  type DeviceEnvironment,
  type DeviceWrapClient,
  type RememberAbortReason,
  type RememberTestHooks,
} from '@/lib/crypto/device';

/** Neutral, non-alarming notice: another tab changed the device state; the toggle shows what the DB holds now. */
export type RememberDeviceNotice = 'device_state_changed' | null;

export interface RememberDeviceState {
  /** `loading` until the first read; `unavailable` when IndexedDB / Web Locks cannot be used (passphrase fallback). */
  status: 'loading' | 'ready' | 'unavailable';
  remembered: boolean;
  /** `true` while a Remember / Forget is running (disable the toggle). */
  busy: boolean;
  notice: RememberDeviceNotice;
  /** Why the last Remember did not write (`null` after a success / Forget / refresh). For diagnostics and tests. */
  lastAbortReason: RememberAbortReason | 'unavailable' | null;
  meta: DeviceMetaRecord | null;
}

export interface RememberDeviceContext {
  userId: string;
  /** `null` while the vault metadata is not loaded: `remember()` then loads it first. */
  vaultKeyId: string | null;
  /** Synchronously captures `opGeneration` (NO lockEpoch baseline side effect, unlike the unlock flows' `beginOp`). */
  captureOp: () => { opGeneration: number; client: DeviceWrapClient };
  /** Authoritative reload of `GET /vault` (the provider's reconcile: locks / purges on 404 or another key). */
  reloadVaultMeta: () => Promise<{ vault_key_id: string } | null>;
}

export interface RememberDeviceStoreOptions {
  getContext: () => RememberDeviceContext | null;
  env?: DeviceEnvironment;
  testHooks?: RememberTestHooks;
}

export interface RememberDeviceStore {
  getState: () => RememberDeviceState;
  subscribe: (listener: () => void) => () => void;
  /** Re-reads the toggle from `sabk.device`. */
  refresh: () => Promise<void>;
  remember: () => Promise<RememberDeviceState>;
  forget: () => Promise<RememberDeviceState>;
  dismissNotice: () => void;
  /** Attaches the tab wake listeners and the purge / device-state subscriptions; returns the disposer. */
  start: () => () => void;
}

const INITIAL_STATE: RememberDeviceState = {
  status: 'loading',
  remembered: false,
  busy: false,
  notice: null,
  lastAbortReason: null,
  meta: null,
};

/** Abort reasons that mean "another tab / device changed the state": they raise the neutral notice. */
const NOTICE_ABORT_REASONS: Partial<Record<RememberAbortReason, true>> = {
  meta_missing: true,
  meta_changed: true,
  vault_absent: true,
  vault_mismatch: true,
};

export function createRememberDeviceStore(options: RememberDeviceStoreOptions): RememberDeviceStore {
  let state: RememberDeviceState = INITIAL_STATE;
  const listeners = new Set<() => void>();
  let readSeq = 0;

  const setState = (patch: Partial<RememberDeviceState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Ignore listener errors
      }
    }
  };

  const refresh = async (): Promise<void> => {
    const ctx = options.getContext();
    if (!ctx || !ctx.vaultKeyId) return;
    const seq = ++readSeq;
    const read = await readDeviceRememberedState(ctx.userId, ctx.vaultKeyId, options.env);
    // A newer read (or a context change) supersedes this one.
    if (seq !== readSeq) return;
    setState({ status: 'ready', remembered: read.remembered, meta: read.meta });
  };

  const remember = async (): Promise<RememberDeviceState> => {
    const ctx = options.getContext();
    if (!ctx || state.busy) return state;
    // opGeneration is captured synchronously, before the first await of this flow.
    const { opGeneration, client } = ctx.captureOp();
    setState({ busy: true, notice: null, lastAbortReason: null });
    try {
      let vaultKeyId = ctx.vaultKeyId;
      if (!vaultKeyId) {
        const loaded = await ctx.reloadVaultMeta();
        vaultKeyId = loaded?.vault_key_id ?? null;
      }
      if (!vaultKeyId) {
        await refresh();
        setState({ lastAbortReason: 'vault_absent' });
        return state;
      }
      const res = await rememberDevice({
        client,
        opGeneration,
        userId: ctx.userId,
        vaultKeyId,
        env: options.env,
        testHooks: options.testHooks,
      });
      if (res.status === 'remembered') {
        setState({ status: 'ready', remembered: true, meta: res.meta, lastAbortReason: null });
        return state;
      }
      if (res.status === 'unavailable') {
        // Private mode / blocked storage / no Web Locks: no crash, the passphrase path keeps working.
        setState({ status: 'unavailable', remembered: false, lastAbortReason: 'unavailable' });
        return state;
      }
      // Aborted: reset the toggle to the DB truth, never to what the user clicked.
      const read = await readDeviceRememberedState(ctx.userId, vaultKeyId, options.env);
      setState({
        status: 'ready',
        remembered: read.remembered,
        meta: read.meta,
        lastAbortReason: res.reason,
        notice: NOTICE_ABORT_REASONS[res.reason] ? 'device_state_changed' : null,
      });
      if (res.reason === 'vault_absent' || res.reason === 'vault_mismatch') {
        // Let the provider reconcile (lock + key-scoped purge) now that the device lock is released.
        await ctx.reloadVaultMeta().catch(() => undefined);
      }
      return state;
    } finally {
      setState({ busy: false });
    }
  };

  const forget = async (): Promise<RememberDeviceState> => {
    const ctx = options.getContext();
    if (!ctx || state.busy) return state;
    setState({ busy: true, notice: null });
    try {
      const res = await forgetDevice(ctx.userId, options.env);
      if (res.status === 'unavailable') {
        setState({ status: 'unavailable' });
        return state;
      }
      await refresh();
      return state;
    } finally {
      setState({ busy: false });
    }
  };

  const start = (): (() => void) => {
    const reread = () => {
      void refresh();
    };
    const unsubPurge = subscribeDevicePurge(reread);
    const unsubDevice = subscribeDeviceStateChange(reread);
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') reread();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', reread);
      window.addEventListener('focus', reread);
    }
    reread();
    return () => {
      unsubPurge();
      unsubDevice();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (typeof window !== 'undefined') {
        window.removeEventListener('pageshow', reread);
        window.removeEventListener('focus', reread);
      }
      readSeq += 1;
    };
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    remember,
    forget,
    dismissNotice: () => setState({ notice: null }),
    start,
  };
}
