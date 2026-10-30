'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '@/features/auth/session-provider';
import { useVault } from '@/features/vault/vault-provider';
import type { ReauthAction } from '@/lib/api/auth';
import { createIdempotencyKey, fetchPasskeyRegisterOptions, registerPasskey } from '@/lib/api/vault';
import { grantStillValid } from '@/lib/auth/audit-catalog';
import {
  runPasskeyRegistration,
  type PasskeyGrantPort,
  type PasskeyRegisterOutcome,
} from './register-flow';

const REGISTER_ACTION: ReauthAction = 'vault.passkey_register';

export interface UsePasskeyRegisterOptions {
  /** Where an OAuth re-auth returns to (it navigates the whole page, which drops the Worker and the VK). */
  returnPath: string;
  onRegistered?: (outcome: Extract<PasskeyRegisterOutcome, { ok: true }>) => void;
}

export interface UsePasskeyRegisterResult {
  pending: boolean;
  /** True while the post-wrap grant renewal is waiting for the user's password in place (never a full-page OAuth redirect). */
  renewing: boolean;
  /** Last failed outcome (`stale` is never surfaced), cleared when a new attempt starts. */
  failure: Extract<PasskeyRegisterOutcome, { ok: false }> | null;
  /** Presses "Add passkey": takes the grant first, then runs plan §2.5 steps 2-6. */
  register: (name: string) => Promise<PasskeyRegisterOutcome>;
  clearFailure: () => void;
}

/**
 * "Add passkey" logic behind `PasskeyAddDialog` (placement belongs to T20B / T16B). The re-auth prompt itself is the
 * session's `reauth` state (`pendingAction === 'vault.passkey_register'`), rendered by the dialog.
 */
export function usePasskeyRegister(options: UsePasskeyRegisterOptions): UsePasskeyRegisterResult {
  const vault = useVault();
  const { reauth } = useSession();
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const reauthRef = useRef(reauth);
  reauthRef.current = reauth;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [pending, setPending] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const [failure, setFailure] = useState<UsePasskeyRegisterResult['failure']>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const register = useCallback(async (name: string): Promise<PasskeyRegisterOutcome> => {
    if (pendingRef.current) return { ok: false, error: 'register_failed', orphan: false };
    pendingRef.current = true;
    setPending(true);
    setFailure(null);

    const { returnPath } = optionsRef.current;
    const grants: PasskeyGrantPort = {
      acquire: async () => {
        const current = reauthRef.current.grant;
        if (current && current.action === REGISTER_ACTION && grantStillValid(current.expires_at)) {
          return current;
        }
        return reauthRef.current.begin(REGISTER_ACTION, returnPath);
      },
      renewInPlace: async () => {
        // OAuth re-auth navigates the whole page and would destroy the Worker: only password users renew in place.
        if (!reauthRef.current.capabilities.hasPassword) return null;
        if (mountedRef.current) setRenewing(true);
        try {
          return await reauthRef.current.begin(REGISTER_ACTION, returnPath);
        } finally {
          if (mountedRef.current) setRenewing(false);
        }
      },
    };

    try {
      const outcome = await runPasskeyRegistration(
        {
          client: vaultRef.current.getClient(),
          grants,
          api: {
            fetchRegisterOptions: () => fetchPasskeyRegisterOptions(),
            registerPasskey: (body, opts) => registerPasskey(body, opts),
          },
          credentials: navigator.credentials,
          createIdempotencyKey,
        },
        { name },
      );
      if (mountedRef.current) {
        if (!outcome.ok && outcome.error !== 'stale') {
          setFailure(outcome);
          if (outcome.error === 'network_unknown') {
            // advisor-dec-057: an unknown POST may have committed on the server; refresh the passkey list in place.
            void vaultRef.current.reloadVaultMeta?.().catch(() => undefined);
          }
        }
        if (outcome.ok) optionsRef.current.onRegistered?.(outcome);
      }
      return outcome;
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }, []);

  const clearFailure = useCallback(() => setFailure(null), []);

  return { pending, renewing, failure, register, clearFailure };
}
