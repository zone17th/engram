'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useVault } from '@/features/vault/vault-provider';
import { fetchPasskeyUnlockOptions } from '@/lib/api/vault';
import {
  runPasskeyUnlock,
  type PasskeyUnlockErrorCode,
  type PasskeyUnlockOutcome,
} from './unlock-flow';

export interface UsePasskeyUnlockResult {
  /** True only when the browser supports WebAuthn and the user has at least one passkey (else render no button). */
  available: boolean;
  /** This hook's own unlock is running (authenticator prompt or Worker unlock). */
  pending: boolean;
  /** Another state-changing vault operation (passphrase unlock, rewrap, ...) is in flight: do not start. */
  inFlight: boolean;
  /** Last failure; `stale` (lock/logout mid-flow) is never surfaced. */
  error: PasskeyUnlockErrorCode | null;
  unlock: () => Promise<PasskeyUnlockOutcome>;
  clearError: () => void;
}

function browserSupportsWebAuthn(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.get === 'function'
  );
}

/**
 * Passkey unlock for the unlock screen. `404 passkey_not_found` flips the hook to the "no passkey" state, which
 * hides the button until the passkey list changes.
 */
export function usePasskeyUnlock(): UsePasskeyUnlockResult {
  const vault = useVault();
  const vaultRef = useRef(vault);
  vaultRef.current = vault;

  const [supported, setSupported] = useState(false);
  const [noPasskey, setNoPasskey] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<PasskeyUnlockErrorCode | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setSupported(browserSupportsWebAuthn());
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const listedCount = vault.vaultMeta?.passkeys?.length ?? 0;
  useEffect(() => {
    setNoPasskey(false);
  }, [listedCount]);

  const unlock = useCallback(async (): Promise<PasskeyUnlockOutcome> => {
    if (pendingRef.current) return { ok: false, error: 'busy' };
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const v = vaultRef.current;
    try {
      const outcome = await runPasskeyUnlock({
        // beginOp() captures opGeneration and the lockEpoch baseline synchronously (ADR 0002 §10.2, ADR 0003 §8.4).
        client: {
          captureGeneration: () => v.beginOp().opGeneration,
          getGeneration: () => v.getClient().getGeneration(),
        },
        api: { fetchUnlockOptions: () => fetchPasskeyUnlockOptions() },
        loadVaultMeta: () => v.reloadVaultMeta(),
        unlockPrf: (params) => v.unlockPrf(params),
        credentials: navigator.credentials,
        isBusy: () => v.inFlight,
      });
      if (mountedRef.current) {
        if (!outcome.ok && outcome.error === 'none_registered') setNoPasskey(true);
        if (!outcome.ok && outcome.error !== 'stale') setError(outcome.error);
      } else if (outcome.ok) {
        // The user left the unlock screen while the prompt was open: do not leave the vault unlocked behind them
        // (same rule as the passphrase flow's unmount cleanup).
        void v.lock({ broadcast: false, reason: 'passkey_unlock_abandoned' });
      }
      return outcome;
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    available: supported && !noPasskey && listedCount > 0,
    pending,
    inFlight: vault.inFlight,
    error,
    unlock,
    clearError,
  };
}
