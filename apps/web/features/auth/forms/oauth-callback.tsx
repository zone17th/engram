'use client';

import { ProblemError } from '@engram/shared-types';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AuthStatus } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import type { OauthCallbackStatus, OauthProvider } from '@/lib/api/auth';
import { sanitizeReturnTo } from '@/lib/auth/return-to';

const ALLOWED_STATUS: OauthCallbackStatus[] = [
  'login_ready',
  'linked',
  'reauth_ready',
  'cancelled',
  'identity_conflict',
  'invalid_flow',
  'provider_error',
  'reauth_unavailable',
];

const ALLOWED_PROVIDERS: OauthProvider[] = ['google', 'github'];

export function OAuthCallbackView({ provider }: { provider: string }) {
  const t = useTranslations('auth');
  const { completeOAuthLogin, refetchMe, reauth, bootstrapComplete } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const status = params.get('status') as OauthCallbackStatus | null;
  const started = useRef(false);

  const [phase, setPhase] = useState<'loading' | 'error' | 'reauth_done'>('loading');
  const [message, setMessage] = useState<string | null>(null);

  const validProvider = ALLOWED_PROVIDERS.includes(provider as OauthProvider);
  const validStatus = !!status && ALLOWED_STATUS.includes(status);

  useEffect(() => {
    if (!bootstrapComplete) return;
    if (started.current) return;
    if (!validProvider || !validStatus || !status) {
      setPhase('error');
      setMessage(t('oauthCallback.invalidFlow'));
      return;
    }

    if (
      status === 'cancelled' ||
      status === 'identity_conflict' ||
      status === 'provider_error' ||
      status === 'invalid_flow' ||
      status === 'reauth_unavailable'
    ) {
      setPhase('error');
      return;
    }

    started.current = true;

    if (status === 'login_ready') {
      void completeOAuthLogin()
        .then(() => router.replace(sanitizeReturnTo('/app/onboarding')))
        .catch((err) => {
          setPhase('error');
          if (err instanceof ProblemError) {
            if (err.problem.code === 'oauth_state_invalid') {
              setMessage(t('oauthCallback.invalidFlow'));
            } else if (err.problem.code === 'email_taken') {
              setMessage(t('errors.emailTaken'));
            } else if (err.problem.code === 'rate_limited') {
              setMessage(t('errors.rateLimitedTitle'));
            } else {
              setMessage(t('errors.genericTitle'));
            }
          } else {
            setMessage(t('errors.network'));
          }
        });
      return;
    }

    if (status === 'reauth_ready') {
      const pending = reauth.readStoredPending();
      if (!pending) {
        setPhase('error');
        setMessage(t('oauthCallback.reauthLost'));
        return;
      }
      void reauth
        .consumeOauthReceipt(pending.action, 'google')
        .then(() => {
          setPhase('reauth_done');
          router.replace(pending.returnPath);
        })
        .catch((err) => {
          setPhase('error');
          if (err instanceof ProblemError) {
            if (err.problem.code === 'oauth_state_invalid') {
              setMessage(t('oauthCallback.invalidFlow'));
            } else {
              setMessage(t('errors.genericTitle'));
            }
          } else {
            setMessage(t('errors.network'));
          }
        });
      return;
    }

    if (status === 'linked') {
      void refetchMe().then(() => router.replace('/app/settings'));
    }
  }, [bootstrapComplete, completeOAuthLogin, reauth, refetchMe, router, status, t, validProvider, validStatus]);

  if (status === 'cancelled') {
    return (
      <div className="card p-5">
        <p className="mb-1 text-[14px] font-semibold">{t('oauthCallback.cancelledTitle')}</p>
        <p className="mb-3 text-[13px] text-muted">{t('oauthCallback.cancelledBody')}</p>
        <Link href="/app/auth/login" className="btn btn-tertiary btn-sm no-underline">
          {t('oauthCallback.retry')}
        </Link>
      </div>
    );
  }

  if (status === 'identity_conflict') {
    return (
      <div className="card border-error p-5">
        <p className="mb-1 text-[14px] font-semibold text-error">{t('oauthCallback.conflictTitle')}</p>
        <p className="mb-3 text-[13px] text-muted">{t('oauthCallback.conflictBody')}</p>
        {/* Retrying the same provider always conflicts again; the only way out is
            signing in as the owning account. */}
        <Link href="/app/auth/login" className="btn btn-tertiary btn-sm no-underline">
          {t('oauthCallback.backToLogin')}
        </Link>
      </div>
    );
  }

  if (phase === 'loading' && (status === 'login_ready' || status === 'reauth_ready' || status === 'linked')) {
    return (
      <div className="card p-6 text-center">
        <AuthStatus tone="loading">{t('oauthCallback.completing')}</AuthStatus>
      </div>
    );
  }

  if (phase === 'reauth_done') {
    return (
      <div className="card p-6">
        <AuthStatus tone="sent">{t('oauthCallback.reauthResume')}</AuthStatus>
      </div>
    );
  }

  if (phase === 'error' || status === 'provider_error' || status === 'invalid_flow' || status === 'reauth_unavailable') {
    return (
      <div className="card border-error p-5">
        <p className="mb-1 text-[14px] font-semibold text-error">{t('oauthCallback.errorTitle')}</p>
        <p className="mb-3 text-[13px] text-muted">{message ?? t('oauthCallback.errorBody')}</p>
        <Link href="/app/auth/login" className="btn btn-tertiary btn-sm no-underline">
          {t('oauthCallback.backToLogin')}
        </Link>
      </div>
    );
  }

  return null;
}
