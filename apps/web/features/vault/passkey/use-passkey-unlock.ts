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

  // A fresh page load on /app/unlock has no vault metadata (only the passphrase submit used to fetch it), so the
  // passkey list is unknown and the button would never show. Load it once; a failure leaves the button hidden.
  const metaMissing = vault.vaultMeta === null;
  useEffect(() => {
    if (!supported || !metaMissing) return;
    void vaultRef.current.reloadVaultMeta().catch(() => undefined);
  }, [supported, metaMissing]);

  const unlock = useCallback(async (): Promise<PasskeyUnlockOutcome> => {
    if (pendingRef.current) return { ok: false, error: 'busy' };
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const v = vaultRef.current;
    let opGeneration: number | null = null;
    try {
      const outcome = await runPasskeyUnlock({
        // beginOp() captures opGeneration and the lockEpoch baseline synchronously (ADR 0002 §10.2, ADR 0003 §8.4).
        client: {
          captureGeneration: () => {
            opGeneration = v.beginOp().opGeneration;
            return opGeneration;
          },
          getGeneration: () => v.getClient().getGeneration(),
        },
        api: { fetchUnlockOptions: () => fetchPasskeyUnlockOptions() },
        loadVaultMeta: () => v.reloadVaultMeta(),
        unlockPrf: (params) => {
          // Stop before admitting a Worker unlock when the screen is already gone; the PWK is wiped in finally.
          if (!mountedRef.current) return Promise.reject({ code: 'STALE_GENERATION' });
          return v.unlockPrf(params);
        },
        credentials: navigator.credentials,
        isBusy: () => v.inFlight,
      });
      if (!mountedRef.current) {
        // Only clean up when this abandoned intent still owns the generation: never clobber a newer flow's state.
        if (opGeneration !== null && v.getClient().getGeneration() === opGeneration) {
          void v.lock({ broadcast: false, reason: 'passkey_unlock_abandoned' });
        }
        return { ok: false, error: 'abandoned' };
      }
      if (!outcome.ok && outcome.error === 'none_registered') setNoPasskey(true);
      if (!outcome.ok && outcome.error !== 'stale' && outcome.error !== 'abandoned') setError(outcome.error);
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
