'use client';

import { ProblemError } from '@engram/shared-types';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  type Me,
  type ReauthAction,
  type ReauthGrant,
  oauthReauthStart,
  reauthOauth,
  reauthPassword,
} from '@/lib/api/auth';
import { grantStillValid } from '@/lib/auth/audit-catalog';
import { sanitizeReturnTo } from '@/lib/auth/return-to';

export type ReauthMessagesSlice = {
  reauth?: { failed?: string };
  errors?: {
    invalidCredentialsTitle?: string;
    rateLimitedTitle?: string;
    genericTitle?: string;
    network?: string;
  };
};

/**
 * Optional context carrying only the `auth` message slice needed by `useReauth`.
 * `use-intl` 4.14.5 does not export `IntlContext` from `use-intl/react`, and calling
 * `useMessages()` without a provider throws before any fallback (`features/vault/vault-provider.test.tsx`
 * is under the crypto gate and mounts `SessionProvider` without `NextIntlClientProvider`).
 * Reading this standard React context via `useContext` is rules-of-hooks-safe, never throws
 * without a provider, and imports no message catalogs into the client bundle.
 */
const ReauthMessagesContext = createContext<ReauthMessagesSlice | null>(null);

export function ReauthMessagesProvider({
  auth,
  children,
}: {
  auth: ReauthMessagesSlice | null | undefined;
  children: ReactNode;
}) {
  return <ReauthMessagesContext.Provider value={auth ?? null}>{children}</ReauthMessagesContext.Provider>;
}

function useReauthCopy() {
  const auth = useContext(ReauthMessagesContext);
  // Without ReauthMessagesProvider (test-only; production /app/layout.tsx always mounts it), fallback strings are ''.
  return useMemo(
    () => ({
      failed: auth?.reauth?.failed ?? '',
      invalidCredentials: auth?.errors?.invalidCredentialsTitle ?? '',
      rateLimited: auth?.errors?.rateLimitedTitle ?? '',
      generic: auth?.errors?.genericTitle ?? '',
      network: auth?.errors?.network ?? '',
    }),
    [auth],
  );
}

const REAUTH_STORAGE_KEY = 'sabk.reauth.pending';

type PendingReauth = {
  action: ReauthAction;
  returnPath: string;
};

export type ReauthCapabilities = {
  hasPassword: boolean;
  oauthReauthProviders: Me['features']['oauth_reauth_providers'];
  passwordEnrollmentAvailable: boolean;
};

export function useReauth(me: Me | null) {
  const [grant, setGrant] = useState<ReauthGrant | null>(null);
  const [pendingAction, setPendingAction] = useState<ReauthAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const resolverRef = useRef<((value: ReauthGrant) => void) | null>(null);
  const rejectRef = useRef<((reason?: unknown) => void) | null>(null);
  const copy = useReauthCopy();

  const capabilities: ReauthCapabilities = useMemo(
    () => ({
      hasPassword: me?.identities.some((i) => i.provider === 'password') ?? false,
      oauthReauthProviders: me?.features.oauth_reauth_providers ?? [],
      passwordEnrollmentAvailable: me?.features.password_enrollment_available ?? false,
    }),
    [me],
  );

  const rejectPending = useCallback((reason: Error) => {
    rejectRef.current?.(reason);
    resolverRef.current = null;
    rejectRef.current = null;
  }, []);

  const clearPending = useCallback(() => {
    setPendingAction(null);
    setError(null);
    setSubmitting(false);
    resolverRef.current = null;
    rejectRef.current = null;
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(REAUTH_STORAGE_KEY);
    }
  }, []);

  const cancel = useCallback(() => {
    rejectPending(new Error('reauth_cancelled'));
    clearPending();
    setGrant(null);
  }, [clearPending, rejectPending]);

  useEffect(() => {
    return () => {
      rejectPending(new Error('reauth_unmounted'));
    };
  }, [rejectPending]);

  const begin = useCallback(
    (action: ReauthAction, returnPath?: string) => {
      rejectPending(new Error('reauth_replaced'));
      setPendingAction(action);
      setGrant(null);
      setError(null);
      if (typeof sessionStorage !== 'undefined' && returnPath) {
        sessionStorage.setItem(
          REAUTH_STORAGE_KEY,
          JSON.stringify({
            action,
            returnPath: sanitizeReturnTo(returnPath),
          } satisfies PendingReauth),
        );
      }
      return new Promise<ReauthGrant>((resolve, reject) => {
        resolverRef.current = resolve;
        rejectRef.current = reject;
      });
    },
    [rejectPending],
  );

  const completeWithGrant = useCallback(
    (next: ReauthGrant) => {
      setGrant(next);
      resolverRef.current?.(next);
      resolverRef.current = null;
      rejectRef.current = null;
      setPendingAction(null);
      setError(null);
      setSubmitting(false);
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(REAUTH_STORAGE_KEY);
      }
    },
    [],
  );

  const submitPassword = useCallback(
    async (password: string): Promise<ReauthGrant> => {
      if (!pendingAction) throw new Error('no pending action');
      setSubmitting(true);
      setError(null);
      try {
        const result = await reauthPassword(pendingAction, password);
        completeWithGrant(result);
        return result;
      } catch (e) {
        let message = copy.failed;
        if (e instanceof ProblemError) {
          if (e.problem.code === 'invalid_credentials') {
            message = copy.invalidCredentials;
          } else if (e.problem.code === 'rate_limited') {
            message = copy.rateLimited;
          } else {
            message = copy.generic;
          }
        } else {
          message = copy.network;
        }
        setError(message);
        throw e;
      } finally {
        setSubmitting(false);
      }
    },
    [pendingAction, completeWithGrant, copy],
  );

  const startOauthReauth = useCallback(
    async (provider: 'google', returnPath?: string) => {
      if (!pendingAction) return;
      const safeReturn = sanitizeReturnTo(
        returnPath ?? (typeof window !== 'undefined' ? window.location.pathname : '/app'),
      );
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(
          REAUTH_STORAGE_KEY,
          JSON.stringify({ action: pendingAction, returnPath: safeReturn } satisfies PendingReauth),
        );
      }
      const { authorization_url } = await oauthReauthStart(provider, pendingAction);
      window.location.assign(authorization_url);
    },
    [pendingAction],
  );

  const consumeOauthReceipt = useCallback(
    async (action: ReauthAction, provider: 'google') => {
      setSubmitting(true);
      setError(null);
      try {
        const result = await reauthOauth(action, provider);
        completeWithGrant(result);
        return result;
      } catch (e) {
        let message = copy.failed;
        if (e instanceof ProblemError) {
          message = copy.generic;
        } else {
          message = copy.network;
        }
        setError(message);
        throw e;
      } finally {
        setSubmitting(false);
      }
    },
    [completeWithGrant, copy],
  );

  const readStoredPending = useCallback((): PendingReauth | null => {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(REAUTH_STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as PendingReauth;
      if (parsed.action && parsed.returnPath) return parsed;
    } catch {
      /* ignore */
    }
    return null;
  }, []);

  const clearGrant = useCallback(() => setGrant(null), []);

  const hasUsableGrant = useCallback(
    (action: ReauthAction) => Boolean(grant && grant.action === action && grantStillValid(grant.expires_at)),
    [grant],
  );

  return useMemo(
    () => ({
      grant,
      pendingAction,
      error,
      submitting,
      capabilities,
      begin,
      cancel,
      submitPassword,
      startOauthReauth,
      consumeOauthReceipt,
      readStoredPending,
      clearGrant,
      clearPending,
      hasUsableGrant,
    }),
    [
      grant,
      pendingAction,
      error,
      submitting,
      capabilities,
      begin,
      cancel,
      submitPassword,
      startOauthReauth,
      consumeOauthReceipt,
      readStoredPending,
      clearGrant,
      clearPending,
      hasUsableGrant,
    ],
  );
}

export type UseReauthReturn = ReturnType<typeof useReauth>;
