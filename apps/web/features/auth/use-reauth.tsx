'use client';

import { ProblemError } from '@engram/shared-types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
        const message =
          e instanceof ProblemError ? e.problem.detail ?? e.problem.title : 'Không xác thực được.';
        setError(message);
        throw e;
      } finally {
        setSubmitting(false);
      }
    },
    [pendingAction, completeWithGrant],
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
        const message =
          e instanceof ProblemError ? e.problem.detail ?? e.problem.title : 'Không xác thực được.';
        setError(message);
        throw e;
      } finally {
        setSubmitting(false);
      }
    },
    [completeWithGrant],
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
