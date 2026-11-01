'use client';

import { ProblemError } from '@engram/shared-types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  type Me,
  bootstrapCsrf,
  fetchAuthConfig,
  fetchMe,
  signup as apiSignup,
  login as apiLogin,
  oauthComplete,
} from '@/lib/api/auth';
import {
  bumpSessionEpoch,
  getSessionEpoch,
  resetSessionEpoch,
  signOut as apiSignOut,
  type SessionEndReason,
} from '@/lib/api/auth-fetch';
import { subscribeSessionBroadcast } from '@/lib/auth/broadcast';
import { hasWebLocks } from '@/lib/auth/session-lock';
import { useReauth, type UseReauthReturn } from '@/features/auth/use-reauth';
import {
  getKnownDeviceSessionUserId,
  purgeDeviceKeysOnRevoked,
  setKnownDeviceSessionUserId,
} from '@/features/vault/device-store';

export type SessionStatus =
  | 'loading'
  | 'signed_out'
  | 'authenticated_without_vault'
  | 'authenticated_with_vault'
  | 'unavailable';

export type SessionState = {
  status: SessionStatus;
  me: Me | null;
  config: Awaited<ReturnType<typeof fetchAuthConfig>> | null;
  configLoading: boolean;
  configError: boolean;
  bootstrapComplete: boolean;
  sessionEpoch: number;
  webLocksAvailable: boolean;
  lastSessionEndReason: SessionEndReason | null;
};

type SessionContextValue = SessionState & {
  refetchMe: () => Promise<void>;
  signup: typeof apiSignup;
  login: typeof apiLogin;
  completeOAuthLogin: typeof oauthComplete;
  signOut: (reason?: SessionEndReason) => Promise<void>;
  clearPrivateCache: () => void;
  reauth: UseReauthReturn;
};

const SessionContext = createContext<SessionContextValue | null>(null);

function meToStatus(me: Me | null | undefined): SessionStatus {
  if (!me) return 'signed_out';
  return me.vault.status === 'present' ? 'authenticated_with_vault' : 'authenticated_without_vault';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [bootstrapComplete, setBootstrapComplete] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [lastSessionEndReason, setLastSessionEndReason] = useState<SessionEndReason | null>(null);
  const [sessionEpoch, setSessionEpochState] = useState(getSessionEpoch());
  const terminalCleanupReason = useRef<SessionEndReason | null>(null);

  const configQuery = useQuery({
    queryKey: ['auth', 'config'],
    queryFn: fetchAuthConfig,
    enabled: bootstrapComplete,
    staleTime: 60_000,
  });

  const meQuery = useQuery({
    queryKey: ['auth', 'me', sessionEpoch],
    queryFn: async () => {
      const requestEpoch = getSessionEpoch();
      try {
        return await fetchMe();
      } catch (e) {
        if (
          e instanceof ProblemError &&
          (e.problem.code === 'unauthenticated' ||
            e.problem.code === 'session_invalid' ||
            e.problem.code === 'access_expired')
        ) {
          const isCurrentRequest = requestEpoch === getSessionEpoch();
          if (isCurrentRequest && e.problem.code === 'session_invalid') {
            setLastSessionEndReason(e.problem.reason ?? 'invalid');
          }
          if (isCurrentRequest && e.problem.code === 'access_expired') {
            setLastSessionEndReason('expired');
          }
          return null;
        }
        throw e;
      }
    },
    enabled: bootstrapComplete,
    retry: false,
    staleTime: 30_000,
  });

  const me = meQuery.data ?? null;
  const reauth = useReauth(me);

  useEffect(() => {
    if (me?.user.id) {
      setKnownDeviceSessionUserId(me.user.id);
    }
  }, [me?.user.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await bootstrapCsrf();
        if (!cancelled) setBootstrapComplete(true);
      } catch {
        if (!cancelled) {
          setUnavailable(true);
          setBootstrapComplete(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const clearPrivateCache = useCallback(() => {
    queryClient.removeQueries({ queryKey: ['auth', 'me'] });
    queryClient.removeQueries({ queryKey: ['auth', 'sessions'] });
    queryClient.removeQueries({ queryKey: ['auth', 'audit'] });
    queryClient.removeQueries({ queryKey: ['auth', 'notifications'] });
    queryClient.removeQueries({ queryKey: ['vault', 'body'] });
    queryClient.removeQueries({ queryKey: ['vault', 'meta'] });
    reauth.clearGrant();
    reauth.clearPending();
  }, [queryClient, reauth]);
  const refetchMe = useCallback(async () => {
    await meQuery.refetch();
  }, [meQuery]);

  const signOut = useCallback(
    async (reason: SessionEndReason = 'logout') => {
      await apiSignOut(reason);
      setLastSessionEndReason(reason);
      // Voluntary logout keeps DevKey records untouched; clear known user pointer after sign-out.
      setKnownDeviceSessionUserId(null);
      clearPrivateCache();
      resetSessionEpoch();
      setSessionEpochState(getSessionEpoch());
      await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    },
    [clearPrivateCache, queryClient],
  );

  const signup = useCallback(
    async (...args: Parameters<typeof apiSignup>) => {
      const result = await apiSignup(...args);
      setKnownDeviceSessionUserId(result.user.id);
      bumpSessionEpoch();
      setSessionEpochState(getSessionEpoch());
      clearPrivateCache();
      queryClient.setQueryData(['auth', 'me', getSessionEpoch()], result);
      return result;
    },
    [clearPrivateCache, queryClient],
  );

  const login = useCallback(
    async (...args: Parameters<typeof apiLogin>) => {
      const result = await apiLogin(...args);
      setKnownDeviceSessionUserId(result.user.id);
      bumpSessionEpoch();
      setSessionEpochState(getSessionEpoch());
      clearPrivateCache();
      queryClient.setQueryData(['auth', 'me', getSessionEpoch()], result);
      return result;
    },
    [clearPrivateCache, queryClient],
  );

  const completeOAuthLogin = useCallback(async () => {
    const result = await oauthComplete();
    bumpSessionEpoch();
    setKnownDeviceSessionUserId(result.user.id);
    setSessionEpochState(getSessionEpoch());
    clearPrivateCache();
    queryClient.setQueryData(['auth', 'me', getSessionEpoch()], result);
    return result;
  }, [clearPrivateCache, queryClient]);

  useEffect(() => {
    return subscribeSessionBroadcast((message, origin) => {
      if (message.type === 'session_changed') {
        if (origin === 'remote') bumpSessionEpoch();
        const nextEpoch = getSessionEpoch();
        // A local session_changed means this tab replaced its own session
        // (password change, silent refresh): same user, new cookies. Carry the
        // snapshot into the new epoch key and revalidate, otherwise the re-keyed
        // query starts empty, RouteGuard swaps the page for the loading frame and
        // transient state such as the account success notice is lost. A remote
        // change may belong to another account, so that one starts empty.
        const carried = origin === 'remote' ? null : queryClient.getQueryData(['auth', 'me', sessionEpoch]);
        if (carried) {
          queryClient.setQueryData(['auth', 'me', nextEpoch], carried);
          void queryClient.invalidateQueries({ queryKey: ['auth', 'me', nextEpoch] });
        }
        setSessionEpochState(nextEpoch);
        void meQuery.refetch();
      }
      if (message.type === 'signed_out') {
        const reason = message.reason ?? 'logout';
        if (reason === 'revoked' && origin === 'remote') {
          void purgeDeviceKeysOnRevoked(me?.user.id ?? getKnownDeviceSessionUserId());
        }
        setKnownDeviceSessionUserId(null);
        setLastSessionEndReason(reason);
        clearPrivateCache();
        resetSessionEpoch();
        setSessionEpochState(getSessionEpoch());
        void queryClient.setQueryData(['auth', 'me', getSessionEpoch()], null);
      }
    });
  }, [clearPrivateCache, me?.user.id, meQuery, queryClient, sessionEpoch]);

  useEffect(() => {
    if (meQuery.isError) {
      setUnavailable(true);
    } else if (meQuery.isSuccess) {
      setUnavailable(false);
    }
  }, [meQuery.isError, meQuery.isSuccess, me]);

  useEffect(() => {
    if (me) {
      terminalCleanupReason.current = null;
    } else if (
      meQuery.isSuccess &&
      lastSessionEndReason &&
      terminalCleanupReason.current !== lastSessionEndReason
    ) {
      // A terminal session response must not leave private query data or a
      // remembered re-auth grant available while the login screen is shown.
      terminalCleanupReason.current = lastSessionEndReason;
      clearPrivateCache();
    }
  }, [clearPrivateCache, lastSessionEndReason, me, meQuery.isSuccess]);

  const status: SessionStatus = useMemo(() => {
    if (!bootstrapComplete || meQuery.isLoading) return 'loading';
    if (unavailable) return 'unavailable';
    return meToStatus(me);
  }, [bootstrapComplete, meQuery.isLoading, unavailable, me]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      me,
      config: configQuery.data ?? null,
      configLoading: configQuery.isLoading,
      configError: configQuery.isError,
      bootstrapComplete,
      sessionEpoch,
      webLocksAvailable: hasWebLocks(),
      lastSessionEndReason,
      refetchMe,
      signup,
      login,
      completeOAuthLogin,
      signOut,
      clearPrivateCache,
      reauth,
    }),
    [
      status,
      me,
      configQuery.data,
      configQuery.isLoading,
      configQuery.isError,
      bootstrapComplete,
      sessionEpoch,
      lastSessionEndReason,
      refetchMe,
      signup,
      login,
      completeOAuthLogin,
      signOut,
      clearPrivateCache,
      reauth,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within SessionProvider');
  return ctx;
}
