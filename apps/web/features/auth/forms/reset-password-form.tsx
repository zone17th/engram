'use client';

import { ProblemError } from '@engram/shared-types';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthStatus, Field, focusFirstInvalidField } from '@/components/ui/field';
import { AuthErrorCard } from '@/features/auth/auth-error';
import { PasswordStrengthMeter } from '@/features/auth/password-strength-meter';
import { authPasswordReset, bootstrapCsrf } from '@/lib/api/auth';
import { ensureCsrf } from '@/lib/api/auth-fetch';
import { postSessionBroadcast } from '@/lib/auth/broadcast';
import { normalizeRetryAfter } from '@/lib/auth/retry-after';
import { useRetryCountdown } from '@/lib/auth/use-retry-countdown';
import { useHydrated } from '@/lib/use-hydrated';

const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function extractResetTokenFromHash(hash: string): string | null {
  const match = hash.match(/(?:^#|&)token=([^&]*)/);
  if (!match?.[1]) return null;
  try {
    const decoded = decodeURIComponent(match[1]);
    return RESET_TOKEN_PATTERN.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function hardNavigate(url: string) {
  if (typeof window !== 'undefined') {
    window.location.assign(url);
  }
}

function validatePassword(password: string): string | undefined {
  if (Array.from(password).length < 12) return 'short';
  if (new TextEncoder().encode(password).length > 1024) return 'tooLong';
  return undefined;
}

type ResetAlert =
  | { kind: 'submitting' }
  | { kind: 'rate_limited'; seconds: number }
  | { kind: 'dependency_unavailable' }
  | { kind: 'network' }
  | { kind: 'generic' };

export function ResetPasswordForm() {
  const t = useTranslations('auth');
  const [token, setToken] = useState<string | null>(null);
  const [fragmentHandled, setFragmentHandled] = useState(false);
  const [tokenInvalidatedByServer, setTokenInvalidatedByServer] = useState(false);
  const [completed, setCompleted] = useState(false);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ newPassword?: string; confirmPassword?: string }>({});
  const [alert, setAlert] = useState<ResetAlert | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const meterNoteId = useId();
  const retrySeconds = useRetryCountdown(retryUntil);
  const hydrated = useHydrated();

  useLayoutEffect(() => {
    const takeTokenFromHash = () => {
      const hash = window.location.hash;
      if (hash) {
        const extracted = extractResetTokenFromHash(hash);
        setToken(extracted);
        setTokenInvalidatedByServer(false);
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      setFragmentHandled(true);
    };

    takeTokenFromHash();
    window.addEventListener('hashchange', takeTokenFromHash);
    return () => window.removeEventListener('hashchange', takeTokenFromHash);
  }, []);

  useEffect(() => {
    if (retryUntil === null || retrySeconds !== 0) return;
    setRetryUntil(null);
    setAlert((current) =>
      current?.kind === 'rate_limited' || current?.kind === 'dependency_unavailable' ? null : current,
    );
  }, [retrySeconds, retryUntil]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (retrySeconds > 0 || !token) return;
      const passwordErr = validatePassword(newPassword);
      const confirmErr = confirmPassword !== newPassword ? t('validation.password.mismatch') : undefined;
      if (passwordErr || confirmErr) {
        setFieldErrors({
          newPassword: passwordErr ? t(`validation.password.${passwordErr}`) : undefined,
          confirmPassword: confirmErr,
        });
        focusFirstInvalidField(formRef.current ?? document);
        return;
      }
      setFieldErrors({});
      setSubmitting(true);
      setAlert({ kind: 'submitting' });
      setRetryUntil(null);

      const sendRequest = () =>
        authPasswordReset({
          token,
          new_password: newPassword,
        });

      try {
        try {
          await sendRequest();
        } catch (firstErr) {
          if (firstErr instanceof ProblemError && firstErr.problem.code === 'csrf_invalid') {
            await ensureCsrf();
            await sendRequest();
          } else {
            throw firstErr;
          }
        }
        setCompleted(true);
        setToken(null);
        setNewPassword('');
        setConfirmPassword('');
        postSessionBroadcast({ type: 'signed_out', reason: 'logout' });
        try {
          const timeout = Promise.withResolvers<void>();
          const timer = setTimeout(timeout.resolve, 1500);
          try {
            await Promise.race([bootstrapCsrf(), timeout.promise]);
          } finally {
            clearTimeout(timer);
          }
        } catch {
          // Next document load runs bootstrapCsrf in SessionProvider; never block navigation (AU2-FE3-4).
        }
        hardNavigate('/app/auth/login?reset=done');
      } catch (err) {
        if (err instanceof ProblemError) {
          if (err.problem.code === 'reset_token_invalid') {
            setToken(null);
            setAlert(null);
            setTokenInvalidatedByServer(true);
          } else if (err.problem.code === 'password_weak') {
            setAlert(null);
            setFieldErrors({ newPassword: t('validation.password.weak') });
            focusFirstInvalidField(formRef.current ?? document);
          } else if (err.problem.code === 'rate_limited') {
            const seconds = normalizeRetryAfter(err.problem.retry_after);
            setRetryUntil(Date.now() + seconds * 1000);
            setAlert({ kind: 'rate_limited', seconds });
          } else if (err.problem.code === 'dependency_unavailable') {
            const seconds = normalizeRetryAfter(err.problem.retry_after ?? 1);
            setRetryUntil(Date.now() + seconds * 1000);
            setAlert({ kind: 'dependency_unavailable' });
          } else {
            setAlert({ kind: 'generic' });
          }
        } else {
          setAlert({ kind: 'network' });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [confirmPassword, newPassword, retrySeconds, t, token],
  );

  const alertNode = useMemo(() => {
    if (!alert) return null;
    if (alert.kind === 'submitting') {
      return <AuthStatus tone="loading">{t('reset.submitting')}</AuthStatus>;
    }
    if (alert.kind === 'rate_limited') {
      return (
        <AuthErrorCard title={t('errors.rateLimitedTitle')} warning>
          <p className="m-0">{t('errors.rateLimited', { seconds: retrySeconds })}</p>
        </AuthErrorCard>
      );
    }
    if (alert.kind === 'dependency_unavailable') {
      return (
        <AuthErrorCard title={t('errors.genericTitle')} warning>
          <p className="m-0">{t('errors.genericBody')}</p>
        </AuthErrorCard>
      );
    }
    if (alert.kind === 'network') {
      return (
        <AuthErrorCard title={t('errors.networkTitle')}>
          <p className="m-0">{t('errors.network')}</p>
        </AuthErrorCard>
      );
    }
    return (
      <AuthErrorCard title={t('errors.genericTitle')}>
        <p className="m-0">{t('errors.genericBody')}</p>
      </AuthErrorCard>
    );
  }, [alert, retrySeconds, t]);

  return (
    <section id="auth-reset">
      <h1 className="t-title-lg mb-2">{t('reset.title')}</h1>
      <p className="t-body-lg mb-6 text-muted">{t('reset.subtitle')}</p>

      {(!fragmentHandled || completed) && (
        <div className="card mb-4 p-6" data-testid={completed ? 'reset-completed-redirecting' : undefined}>
          <AuthStatus tone="loading">{completed ? t('reset.submitting') : t('guard.loading')}</AuthStatus>
        </div>
      )}

      {fragmentHandled && !completed && token === null && (
        <div
          className="card mb-4 border-error p-5"
          id="forgot-invalid"
          data-testid="reset-invalid-token"
        >
          <div role="alert" className="auth-alert mb-4">
            <p className="m-0 mb-1 text-[14px] font-semibold text-body">
              {tokenInvalidatedByServer ? t('reset.invalidTokenTitle') : t('reset.missingTokenTitle')}
            </p>
            <p className="m-0 text-[13px] text-body">
              {tokenInvalidatedByServer ? t('reset.invalidTokenBody') : t('reset.missingTokenBody')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- ADR 0006 §6.2 requires hard navigation on /app/auth/reset-password */}
            <a
              href="/app/auth/forgot-password"
              className="btn btn-primary btn-sm no-underline"
              onClick={(e) => {
                e.preventDefault();
                hardNavigate('/app/auth/forgot-password');
              }}
            >
              {t('reset.requestNewLink')}
            </a>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- ADR 0006 §6.2 requires hard navigation on /app/auth/reset-password */}
            <a
              href="/app/auth/login"
              className="btn btn-tertiary btn-sm no-underline"
              onClick={(e) => {
                e.preventDefault();
                hardNavigate('/app/auth/login');
              }}
            >
              {t('reset.backToLogin')}
            </a>
          </div>
        </div>
      )}

      {fragmentHandled && token !== null && (
        <div id="forgot-reset">
          <div
            className="mb-4 rounded-md border border-line p-4"
            id="forgot-reset-vault-notice"
            style={{ background: 'var(--pale-orange)' }}
          >
            <p className="m-0 text-[13px] text-body">{t('reset.vaultNotice')}</p>
          </div>

          <form
            ref={formRef}
            onSubmit={onSubmit}
            className="card mb-4 p-6"
            noValidate
            data-hydrated={hydrated ? 'true' : 'false'}
          >
            <p className="m-0 mb-4 text-[13px] text-body">{t('reset.singleUseNote')}</p>

            <Field
              id="reset-new-password"
              label={t('fields.newLoginPassword')}
              type="password"
              name="newPassword"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              error={fieldErrors.newPassword}
              hint={!fieldErrors.newPassword ? t('validation.password.resetHint') : undefined}
              disabled={submitting || !hydrated}
              wrapperClassName="mb-3"
            />

            <PasswordStrengthMeter
              password={newPassword}
              id="reset-password-meter"
              noteId={meterNoteId}
            />

            <Field
              id="reset-confirm-password"
              label={t('fields.confirmNewPassword')}
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              error={fieldErrors.confirmPassword}
              disabled={submitting || !hydrated}
              wrapperClassName="mb-5"
            />

            {alertNode && <div className="mb-4">{alertNode}</div>}

            <Button
              type="submit"
              className="mb-4 w-full !justify-center !whitespace-normal"
              disabled={submitting || !hydrated || retrySeconds > 0}
              aria-busy={submitting}
            >
              <span>
                {submitting
                  ? t('reset.submittingButton')
                  : retrySeconds > 0
                    ? t('reset.submitCountdown', { seconds: retrySeconds })
                    : t('reset.submit')}
              </span>
            </Button>

            <div className="border-t border-line pt-3 text-center">
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- ADR 0006 §6.2 requires hard navigation on /app/auth/reset-password */}
              <a
                href="/app/auth/login"
                className="text-[13.5px] font-semibold text-link underline"
                onClick={(e) => {
                  e.preventDefault();
                  hardNavigate('/app/auth/login');
                }}
              >
                {t('reset.backToLogin')}
              </a>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
