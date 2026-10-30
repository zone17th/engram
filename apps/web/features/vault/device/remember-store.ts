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
  readDeviceSnapshot,
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
  let opSeq = 0;
  let activeOpContext: { userId: string; vaultKeyId: string | null } | null = null;

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

  const isContextStillOwned = (
    capturedUserId: string,
    capturedVaultKeyId: string | null,
  ): boolean => {
    const live = options.getContext();
    if (!live || live.userId !== capturedUserId) return false;
    if (capturedVaultKeyId !== null && live.vaultKeyId !== null && live.vaultKeyId !== capturedVaultKeyId) {
      return false;
    }
    return true;
  };

  const refresh = async (): Promise<void> => {
    const ctx = options.getContext();
    if (!ctx || !ctx.vaultKeyId) return;
    const capturedUserId = ctx.userId;
    const capturedVaultKeyId = ctx.vaultKeyId;
    const seq = ++readSeq;
    if (
      activeOpContext &&
      !isContextStillOwned(activeOpContext.userId, activeOpContext.vaultKeyId)
    ) {
      opSeq += 1;
      activeOpContext = null;
      setState({ busy: false, notice: null, lastAbortReason: null });
    }
    try {
      const snapshot = await readDeviceSnapshot(capturedUserId, options.env);
      if (seq !== readSeq || !isContextStillOwned(capturedUserId, capturedVaultKeyId)) return;
      const own = snapshot.entries.find((e) => e.vaultKeyId === capturedVaultKeyId);
      setState({
        status: 'ready',
        remembered: own?.record != null,
        meta: snapshot.meta,
      });
    } catch {
      if (seq !== readSeq || !isContextStillOwned(capturedUserId, capturedVaultKeyId)) return;
      setState({
        status: 'unavailable',
        remembered: false,
        meta: null,
      });
    }
  };

  const remember = async (): Promise<RememberDeviceState> => {
    const ctx = options.getContext();
    if (!ctx) return state;
    if (
      state.busy &&
      activeOpContext &&
      isContextStillOwned(activeOpContext.userId, activeOpContext.vaultKeyId)
    ) {
      return state;
    }
    const capturedUserId = ctx.userId;
    const initialVaultKeyId = ctx.vaultKeyId;
    const currentOpSeq = ++opSeq;
    activeOpContext = { userId: capturedUserId, vaultKeyId: initialVaultKeyId };
    readSeq += 1;
    // opGeneration is captured synchronously, before the first await of this flow.
    const { opGeneration, client } = ctx.captureOp();
    setState({ busy: true, notice: null, lastAbortReason: null });
    try {
      let vaultKeyId = initialVaultKeyId;
      if (!vaultKeyId) {
        const loaded = await ctx.reloadVaultMeta();
        if (currentOpSeq === opSeq && isContextStillOwned(capturedUserId, initialVaultKeyId)) {
          vaultKeyId = loaded?.vault_key_id ?? null;
          activeOpContext = { userId: capturedUserId, vaultKeyId };
        }
      }
      if (currentOpSeq === opSeq && isContextStillOwned(capturedUserId, vaultKeyId)) {
        if (!vaultKeyId) {
          await refresh();
          if (currentOpSeq === opSeq && isContextStillOwned(capturedUserId, null)) {
            setState({ lastAbortReason: 'vault_absent' });
          }
        } else {
          const res = await rememberDevice({
            client,
            opGeneration,
            userId: capturedUserId,
            vaultKeyId,
            env: options.env,
            testHooks: options.testHooks,
          });
          if (currentOpSeq === opSeq && isContextStillOwned(capturedUserId, vaultKeyId)) {
            if (res.status === 'remembered') {
              readSeq += 1;
              setState({ status: 'ready', remembered: true, meta: res.meta, lastAbortReason: null });
            } else if (res.status === 'unavailable') {
              // Private mode / blocked storage / no Web Locks: no crash, the passphrase path keeps working.
              readSeq += 1;
              setState({ status: 'unavailable', remembered: false, meta: null, lastAbortReason: 'unavailable' });
            } else {
              // Aborted: reset the toggle to the DB truth, never to what the user clicked.
              try {
                const snapshot = await readDeviceSnapshot(capturedUserId, options.env);
                if (currentOpSeq === opSeq && isContextStillOwned(capturedUserId, vaultKeyId)) {
                  const own = snapshot.entries.find((e) => e.vaultKeyId === vaultKeyId);
                  readSeq += 1;
                  setState({
                    status: 'ready',
                    remembered: own?.record != null,
                    meta: snapshot.meta,
                    lastAbortReason: res.reason,
                    notice: NOTICE_ABORT_REASONS[res.reason] ? 'device_state_changed' : null,
                  });
                }
              } catch {
                if (currentOpSeq === opSeq && isContextStillOwned(capturedUserId, vaultKeyId)) {
                  readSeq += 1;
                  setState({
                    status: 'unavailable',
                    remembered: false,
                    meta: null,
                    lastAbortReason: res.reason,
                    notice: NOTICE_ABORT_REASONS[res.reason] ? 'device_state_changed' : null,
                  });
                }
              }
              if (
                (res.reason === 'vault_absent' || res.reason === 'vault_mismatch') &&
                currentOpSeq === opSeq &&
                isContextStillOwned(capturedUserId, vaultKeyId)
              ) {
                // Let the provider reconcile (lock + key-scoped purge) now that the device lock is released.
                await ctx.reloadVaultMeta().catch(() => undefined);
              }
            }
          }
        }
      }
    } finally {
      if (currentOpSeq === opSeq) {
        activeOpContext = null;
        setState({ busy: false });
      }
    }
    return state;
  };

  const forget = async (): Promise<RememberDeviceState> => {
    const ctx = options.getContext();
    if (!ctx) return state;
    if (
      state.busy &&
      activeOpContext &&
      isContextStillOwned(activeOpContext.userId, activeOpContext.vaultKeyId)
    ) {
      return state;
    }
    const capturedUserId = ctx.userId;
    const capturedVaultKeyId = ctx.vaultKeyId;
    const currentOpSeq = ++opSeq;
    activeOpContext = { userId: capturedUserId, vaultKeyId: capturedVaultKeyId };
    readSeq += 1;
    setState({ busy: true, notice: null });
    try {
      const res = await forgetDevice(capturedUserId, options.env);
      if (currentOpSeq === opSeq && isContextStillOwned(capturedUserId, capturedVaultKeyId)) {
        if (res.status === 'unavailable') {
          readSeq += 1;
          setState({ status: 'unavailable', remembered: false, meta: null });
        } else {
          await refresh();
        }
      }
    } finally {
      if (currentOpSeq === opSeq) {
        activeOpContext = null;
        setState({ busy: false });
      }
    }
    return state;
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
