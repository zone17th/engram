'use client';

/**
 * `useRememberDevice()`: the "Remember this device" API that T16B (onboarding step 3), T17B (unlock) and T20B
 * (settings) consume. It renders no UI. `remember()` needs the vault UNLOCKED in this tab (the Worker seals VK with the
 * new DevKey). Default is OFF. See `remember-store.ts` for the toggle semantics (DB re-read, neutral notice).
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useSession } from '@/features/auth/session-provider';
import { useVault } from '@/features/vault/vault-provider';
import type { DeviceEnvironment, RememberTestHooks } from '@/lib/crypto/device';
import {
  createRememberDeviceStore,
  type RememberDeviceContext,
  type RememberDeviceState,
} from './remember-store';

export interface UseRememberDeviceOptions {
  /** Custom IndexedDB / Web Locks environment (unit tests). */
  env?: DeviceEnvironment;
  /** Test-only hooks (ignored in production builds on a non-loopback host). */
  testHooks?: RememberTestHooks;
}

export interface UseRememberDeviceResult extends RememberDeviceState {
  /** `true` when the toggle can be shown: a user is signed in and the vault metadata is known. */
  available: boolean;
  remember: () => Promise<RememberDeviceState>;
  forget: () => Promise<RememberDeviceState>;
  refresh: () => Promise<void>;
  dismissNotice: () => void;
}

const SERVER_STATE: RememberDeviceState = {
  status: 'loading',
  remembered: false,
  busy: false,
  notice: null,
  lastAbortReason: null,
  meta: null,
};

export function useRememberDevice(options: UseRememberDeviceOptions = {}): UseRememberDeviceResult {
  const vault = useVault();
  const { me } = useSession();
  const userId = me?.user.id ?? null;
  const vaultKeyId = vault.vaultMeta?.vault_key_id ?? null;

  const contextRef = useRef<RememberDeviceContext | null>(null);
  contextRef.current = userId
    ? {
        userId,
        vaultKeyId,
        captureOp: () => {
          const client = vault.getClient();
          return { opGeneration: client.captureGeneration(), client };
        },
        reloadVaultMeta: vault.reloadVaultMeta,
      }
    : null;

  const envRef = useRef(options.env);
  const testHooksRef = useRef(options.testHooks);
  const store = useMemo(
    () =>
      createRememberDeviceStore({
        getContext: () => contextRef.current,
        env: envRef.current,
        testHooks: testHooksRef.current,
      }),
    [],
  );

  useEffect(() => store.start(), [store]);
  useEffect(() => {
    void store.refresh();
  }, [store, userId, vaultKeyId]);

  const state = useSyncExternalStore(store.subscribe, store.getState, () => SERVER_STATE);
  const remember = useCallback(() => store.remember(), [store]);
  const forget = useCallback(() => store.forget(), [store]);
  return {
    ...state,
    available: userId !== null && vaultKeyId !== null,
    remember,
    forget,
    refresh: store.refresh,
    dismissNotice: store.dismissNotice,
  };
}
