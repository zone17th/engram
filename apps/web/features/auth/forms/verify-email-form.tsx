'use client';

import { ProblemError } from '@engram/shared-types';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthStatus } from '@/components/ui/field';
import { AppShellLogoutButton } from '@/features/auth/route-guard';
import { useSession } from '@/features/auth/session-provider';
import { verifyEmailConfirm, verifyEmailSend } from '@/lib/api/auth';
import { loginUrl } from '@/lib/auth/return-to';

let pendingVerificationToken: string | null = null;

export function clearPendingVerificationToken() {
  pendingVerificationToken = null;
}

function tokenFromHash(hash: string): string | null {
  const match = hash.match(/(?:^#|&)token=([^&]*)/);
  if (!match?.[1]) return null;
  try {
    const decoded = decodeURIComponent(match[1]);
    return decoded || null;
  } catch {
    return null;
  }
}

export function VerifyEmailForm() {
  const t = useTranslations('auth');
  const { me, status, refetchMe } = useSession();
  const router = useRouter();
  const [token, setToken] = useState<string | null>(() => pendingVerificationToken);
  const [fragmentHandled, setFragmentHandled] = useState(false);
  const [alert, setAlert] = useState<{ tone: 'error' | 'sent' | 'loading'; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);

  useLayoutEffect(() => {
    const takeTokenFromHash = () => {
      const hash = window.location.hash;
      if (hash) {
        const nextToken = tokenFromHash(hash);
        setToken(nextToken);
        pendingVerificationToken = nextToken;
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      setFragmentHandled(true);
    };

    takeTokenFromHash();
    window.addEventListener('hashchange', takeTokenFromHash);
    return () => window.removeEventListener('hashchange', takeTokenFromHash);
  }, []);

  useEffect(() => {
    const authenticated = status === 'authenticated_without_vault' || status === 'authenticated_with_vault';
    if (fragmentHandled && authenticated && token) {
      clearPendingVerificationToken();
    }
  }, [fragmentHandled, status, token]);

  useEffect(() => {
    const authenticated = status === 'authenticated_without_vault' || status === 'authenticated_with_vault';
    if (!fragmentHandled || !authenticated) return;
    if (me?.user.email_verified && !token) {
      router.replace('/app/onboarding');
    }
  }, [fragmentHandled, me, router, status, token]);

  const onConfirm = useCallback(async () => {
    if (!token) return;
    if (status === 'signed_out') {
      router.replace(loginUrl('/app/auth/verify-email'));
      return;
    }
    setSubmitting(true);
    setAlert({ tone: 'loading', message: t('verify.confirming') });
    try {
      await verifyEmailConfirm(token);
      clearPendingVerificationToken();
      await refetchMe();
      router.replace('/app/onboarding');
    } catch (err) {
      const message =
        err instanceof ProblemError
          ? t('verify.invalidToken')
          : t('errors.network');
      if (err instanceof ProblemError) clearPendingVerificationToken();
      setAlert({ tone: 'error', message });
    } finally {
      setSubmitting(false);
    }
  }, [refetchMe, router, status, t, token]);

  const onResend = useCallback(async () => {
    setResending(true);
    try {
      await verifyEmailSend();
      setAlert({ tone: 'sent', message: t('verify.sent', { email: me?.user.email ?? '' }) });
    } catch (err) {
      const message =
        err instanceof ProblemError
          ? err.problem.detail ?? err.problem.title
          : t('errors.network');
      setAlert({ tone: 'error', message });
    } finally {
      setResending(false);
    }
  }, [me?.user.email, t]);

  if (status === 'signed_out') {
    return (
      <section>
        <h1 className="t-title-lg mb-2">{t('verify.title')}</h1>
        <div className="card p-6">
          <AuthStatus tone="error">{t('verify.signInRequired')}</AuthStatus>
          <Button variant="tertiary" size="sm" className="mt-4" onClick={() => router.push(loginUrl('/app/auth/verify-email'))}>
            {t('login.submit')}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h1 className="t-title-lg mb-2">{t('verify.title')}</h1>
      <p className="t-body-lg mb-7 text-muted">{t('verify.subtitle')}</p>

      <div className="card p-6 mb-4">
        {alert && (
          <AuthStatus tone={alert.tone === 'error' ? 'error' : alert.tone === 'loading' ? 'loading' : 'sent'}>
            {alert.message}
          </AuthStatus>
        )}
        {!alert && me && (
          <AuthStatus tone="sent">{t('verify.sent', { email: me.user.email })}</AuthStatus>
        )}
        <p className="mb-4 mt-4 text-[13px] text-muted">{t('verify.resendHint')}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => void onResend()} disabled={resending}>
            {t('verify.resend')}
          </Button>
          <AppShellLogoutButton />
        </div>
      </div>

      {token && (
        <div className="card p-6">
          <p className="mb-4 text-[14px] text-body">{t('verify.confirmPrompt')}</p>
          <Button onClick={() => void onConfirm()} disabled={submitting} aria-busy={submitting}>
            {submitting ? t('verify.confirming') : t('verify.confirm')}
          </Button>
        </div>
      )}
    </section>
  );
}
