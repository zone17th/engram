'use client';

import { ProblemError } from '@engram/shared-types';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthStatus, Field, focusFirstInvalidField } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import { changePassword, passwordEnrollSend } from '@/lib/api/auth';
import { loginUrl } from '@/lib/auth/return-to';

let pendingPasswordEnrollmentToken: string | null = null;

export function clearPendingPasswordEnrollmentToken() {
  pendingPasswordEnrollmentToken = null;
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

export function PasswordEnrollForm() {
  const t = useTranslations('auth');
  const { me, status, refetchMe } = useSession();
  const router = useRouter();

  const [token, setToken] = useState<string | null>(() => pendingPasswordEnrollmentToken);
  const [fragmentHandled, setFragmentHandled] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [view, setView] = useState<'form' | 'sent'>('form');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useLayoutEffect(() => {
    const takeTokenFromHash = () => {
      const hash = window.location.hash;
      if (hash) {
        const nextToken = tokenFromHash(hash);
        setToken(nextToken);
        pendingPasswordEnrollmentToken = nextToken;
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
      clearPendingPasswordEnrollmentToken();
    }
  }, [fragmentHandled, status, token]);

  const sendEnrollment = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await passwordEnrollSend();
      setView('sent');
    } catch (err) {
      setError(err instanceof ProblemError ? err.problem.detail ?? err.problem.title : t('errors.network'));
    } finally {
      setSubmitting(false);
    }
  }, [t]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (password.length < 12) {
        setError(t('validation.password.short'));
        focusFirstInvalidField(formRef.current ?? document);
        return;
      }
      if (password !== confirm) {
        setError(t('enroll.mismatch'));
        return;
      }
      if (!token) {
        setError(t('enroll.noToken'));
        return;
      }
      if (status === 'signed_out') {
        router.replace(loginUrl('/app/auth/password-enroll'));
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        await changePassword({ new_password: password, enrollment_token: token });
        clearPendingPasswordEnrollmentToken();
        await refetchMe();
        router.replace('/app/settings');
      } catch (err) {
        if (err instanceof ProblemError) {
          if (err.problem.code === 'verification_invalid') {
            setError(t('enroll.invalidToken'));
            clearPendingPasswordEnrollmentToken();
          } else {
            setError(err.problem.detail ?? err.problem.title);
          }
        } else {
          setError(t('errors.network'));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [confirm, password, refetchMe, router, status, t, token],
  );

  if (status === 'signed_out') {
    return (
      <section>
        <h1 className="t-title-lg mb-2">{t('enroll.title')}</h1>
        <div className="card p-6">
          <AuthStatus tone="error">{t('enroll.signInRequired')}</AuthStatus>
        </div>
      </section>
    );
  }

  if (view === 'sent' && !token) {
    return (
      <section>
        <h1 className="t-title-lg mb-2">{t('enroll.title')}</h1>
        <div className="card p-6">
          <AuthStatus tone="sent">{t('enroll.sent', { email: me?.user.email ?? '' })}</AuthStatus>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h1 className="t-title-lg mb-2">{t('enroll.title')}</h1>
      <p className="t-body-lg mb-4 text-muted">{t('enroll.subtitle')}</p>

      {!token && (
        <div className="card mb-4 p-6">
          <p className="mb-4 text-[13px] text-muted">{t('enroll.sendHint')}</p>
          <Button onClick={() => void sendEnrollment()} disabled={submitting}>
            {t('enroll.sendEmail')}
          </Button>
        </div>
      )}

      {token && (
        <form ref={formRef} onSubmit={onSubmit} className="card p-6" noValidate>
          <Field
            label={t('fields.newPassword')}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={t('validation.password.hint')}
            disabled={submitting}
            wrapperClassName="mb-4"
          />
          <Field
            label={t('fields.confirmPassword')}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={submitting}
            wrapperClassName="mb-5"
          />
          {error && (
            <AuthStatus tone="error" className="mb-4">
              {error}
            </AuthStatus>
          )}
          <Button type="submit" className="w-full !justify-center" disabled={submitting}>
            {submitting ? t('enroll.submitting') : t('enroll.submit')}
          </Button>
        </form>
      )}
    </section>
  );
}
