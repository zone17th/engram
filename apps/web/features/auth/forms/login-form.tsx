'use client';

import { ProblemError } from '@engram/shared-types';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthStatus, Field, focusFirstInvalidField } from '@/components/ui/field';
import { AuthErrorCard } from '@/features/auth/auth-error';
import { AuthExplainerAside, AuthExplainerCompact } from '@/features/auth/auth-explainer';
import { useSession } from '@/features/auth/session-provider';
import { TurnstileWidget } from '@/features/auth/turnstile-widget';
import { oauthLoginStartUrl } from '@/lib/api/auth';
import { sanitizeReturnTo } from '@/lib/auth/return-to';
import { normalizeRetryAfter } from '@/lib/auth/retry-after';
import { useRetryCountdown } from '@/lib/auth/use-retry-countdown';
import { useHydrated } from '@/lib/use-hydrated';

function validateEmail(email: string): string | undefined {
  if (!email.trim()) return 'required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'invalid';
  return undefined;
}

function validatePassword(password: string): string | undefined {
  if (Array.from(password).length < 12) return 'short';
  if (new TextEncoder().encode(password).length > 1024) return 'tooLong';
  return undefined;
}

type LoginAlert =
  | { kind: 'submitting' }
  | { kind: 'invalid_credentials' }
  | { kind: 'captcha_required' }
  | { kind: 'rate_limited'; seconds: number }
  | { kind: 'session_revoked' }
  | { kind: 'session_expired' }
  | { kind: 'network' }
  | { kind: 'generic' };

export function LoginForm() {
  const t = useTranslations('auth');
  const { login, config, lastSessionEndReason, webLocksAvailable } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const returnTo = sanitizeReturnTo(params.get('returnTo'));

  const [resetDone, setResetDone] = useState<boolean>(() => {
    if (params.get('reset') === 'done') return true;
    if (typeof window !== 'undefined') {
      return new URLSearchParams(window.location.search).get('reset') === 'done';
    }
    return false;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const current = new URLSearchParams(window.location.search);
    if (current.get('reset') === 'done') {
      current.delete('reset');
      const qs = current.toString();
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
      );
    }
  }, []);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const [captchaResetSignal, setCaptchaResetSignal] = useState(0);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [alert, setAlert] = useState<LoginAlert | null>(() => {
    if (lastSessionEndReason === 'revoked') return { kind: 'session_revoked' };
    if (lastSessionEndReason === 'expired') return { kind: 'session_expired' };
    return null;
  });
  const [submitting, setSubmitting] = useState(false);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const retrySeconds = useRetryCountdown(retryUntil);
  const hydrated = useHydrated();

  const providers = config?.oauth_providers ?? [];
  const captchaSiteKey = config?.captcha_site_key ?? null;

  const onToken = useCallback((token: string) => {
    setCaptchaToken(token);
  }, []);
  const onExpire = useCallback(() => {
    setCaptchaToken(undefined);
  }, []);

  const resetCaptcha = useCallback(() => {
    setCaptchaToken(undefined);
    setCaptchaResetSignal((value) => value + 1);
  }, []);

  useEffect(() => {
    if (retryUntil === null || retrySeconds !== 0) return;
    setRetryUntil(null);
    setAlert((current) => (current?.kind === 'rate_limited' ? null : current));
  }, [retrySeconds, retryUntil]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (retrySeconds > 0) return;
      const emailErr = validateEmail(email);
      const passwordErr = validatePassword(password);
      if (emailErr || passwordErr) {
        setFieldErrors({
          email: emailErr ? t(`validation.email.${emailErr}`) : undefined,
          password: passwordErr ? t(`validation.password.${passwordErr}`) : undefined,
        });
        focusFirstInvalidField(formRef.current ?? document);
        return;
      }
      setFieldErrors({});
      setResetDone(false);
      setSubmitting(true);
      setAlert({ kind: 'submitting' });
      setRetryUntil(null);
      const submittedCaptchaToken = captchaToken;
      try {
        await login({ email: email.trim(), password, captcha_token: captchaToken });
        router.replace(returnTo);
      } catch (err) {
        if (submittedCaptchaToken) resetCaptcha();
        if (err instanceof ProblemError) {
          if (err.problem.code === 'invalid_credentials') {
            setAlert({ kind: 'invalid_credentials' });
          } else if (err.problem.code === 'rate_limited') {
            const seconds = normalizeRetryAfter(err.problem.retry_after);
            setRetryUntil(Date.now() + seconds * 1000);
            setAlert({ kind: 'rate_limited', seconds });
            if (err.problem.captcha_required) {
              setShowCaptcha(true);
            }
          } else if (err.problem.code === 'captcha_required' || err.problem.captcha_required) {
            setShowCaptcha(true);
            setCaptchaToken(undefined);
            setAlert({ kind: 'captcha_required' });
          } else if (err.problem.code === 'session_invalid' && err.problem.reason === 'revoked') {
            setAlert({ kind: 'session_revoked' });
          } else if (err.problem.code === 'session_invalid' || err.problem.code === 'access_expired') {
            setAlert({ kind: 'session_expired' });
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
    [captchaToken, email, login, password, resetCaptcha, retrySeconds, returnTo, router, t],
  );

  const alertNode = useMemo(() => {
    if (!alert) return null;
    if (alert.kind === 'submitting') {
      return <AuthStatus tone="loading">{t('login.submitting')}</AuthStatus>;
    }
    if (alert.kind === 'invalid_credentials') {
      return (
        <AuthErrorCard title={t('errors.invalidCredentialsTitle')}>
          <p className="m-0">{t('errors.invalidCredentials')}</p>
        </AuthErrorCard>
      );
    }
    if (alert.kind === 'captcha_required') {
      return (
        <AuthErrorCard title={t('errors.captchaRequiredTitle')} warning>
          <p className="m-0 mb-3 text-muted">{t('errors.captchaHint')}</p>
        </AuthErrorCard>
      );
    }
    if (alert.kind === 'rate_limited') {
      return (
        <AuthErrorCard title={t('errors.lockoutTitle')} warning>
          <p className="m-0 mb-2 text-muted">
            {t('errors.rateLimited', { seconds: retrySeconds })}
          </p>
          <p className="m-0 text-[12px] text-muted">{t('errors.lockoutHint')}</p>
        </AuthErrorCard>
      );
    }
    if (alert.kind === 'session_revoked') {
      return (
        <AuthErrorCard title={t('errors.sessionRevokedTitle')}>
          <p className="m-0">{t('errors.sessionRevoked')}</p>
        </AuthErrorCard>
      );
    }
    if (alert.kind === 'session_expired') {
      return (
        <AuthErrorCard title={t('errors.sessionExpiredTitle')}>
          <p className="m-0">{t('errors.sessionExpired')}</p>
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
    <section id="auth-login">
      <AuthExplainerCompact />

      <div className="grid items-start gap-8 md:grid-cols-[minmax(0,1fr)_340px] lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)]">
        <div className="min-w-0">
          <h1 className="t-title-lg mb-2">{t('login.title')}</h1>
          <p className="t-body-lg mb-6 text-muted">{t('login.subtitle')}</p>

          {resetDone && (
            <div
              className="card mb-4 p-5"
              id="login-reset-success-banner"
              data-testid="login-reset-banner"
            >
              <AuthStatus tone="sent" className="mb-3">
                <p className="m-0 font-semibold text-[14px]">{t('login.resetSuccessTitle')}</p>
              </AuthStatus>
              <div
                className="rounded-md border border-line p-3.5"
                style={{ background: 'var(--pale-orange)' }}
              >
                <p className="m-0 text-[13px] text-body">{t('login.resetSuccessBody')}</p>
              </div>
            </div>
          )}

          <form
            ref={formRef}
            onSubmit={onSubmit}
            className="card mb-4 p-6"
            noValidate
            data-hydrated={hydrated ? 'true' : 'false'}
          >
            {providers.includes('google') && (
              <a
                href={oauthLoginStartUrl('google')}
                className="btn btn-secondary mb-3 w-full !justify-center no-underline"
              >
                {t('oauth.google')}
              </a>
            )}
            {providers.includes('github') && (
              <a
                href={oauthLoginStartUrl('github')}
                className="btn btn-secondary mb-3 w-full !justify-center no-underline"
              >
                {t('oauth.github')}
              </a>
            )}
            {(providers.includes('google') || providers.includes('github')) && (
              <div className="mb-4 flex items-center gap-3">
                <hr className="rule m-0 flex-1" />
                <span className="t-caption text-muted">{t('login.or')}</span>
                <hr className="rule m-0 flex-1" />
              </div>
            )}

            <Field
              label={t('fields.email')}
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email}
              disabled={submitting || !hydrated}
              wrapperClassName="mb-4"
            />
            <div className="mb-5">
              <Field
                label={t('fields.password')}
                type="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                error={fieldErrors.password}
                disabled={submitting || !hydrated}
              />
              <div className="mt-1.5 flex justify-end">
                <Link
                  href="/app/auth/forgot-password"
                  id="login-forgot-link"
                  className="text-[13px] text-link underline"
                >
                  {t('login.forgotPassword')}
                </Link>
              </div>
            </div>

            {alertNode && <div className="mb-4">{alertNode}</div>}

            {showCaptcha && (
              <div className="mb-4">
                <TurnstileWidget
                  siteKey={captchaSiteKey}
                  onToken={onToken}
                  onExpire={onExpire}
                  resetSignal={captchaResetSignal}
                />
              </div>
            )}

            <Button
              type="submit"
              className="mb-4 w-full !justify-center"
              disabled={submitting || !hydrated || retrySeconds > 0}
              aria-busy={submitting}
            >
              {submitting ? t('login.submittingButton') : t('login.submit')}
            </Button>

            <p className="m-0 border-t border-line pt-3 text-center text-[13.5px] text-muted">
              {t('login.noAccount')}{' '}
              <Link
                href="/app/auth/signup"
                id="login-to-signup-link"
                className="font-semibold text-link underline"
              >
                {t('login.createAccountLink')}
              </Link>
            </p>
          </form>

          {!webLocksAvailable && (
            <p className="t-caption mb-3 text-muted">{t('errors.webLocksDegraded')}</p>
          )}
          <p className="t-caption m-0 text-body">{t('login.passwordHint')}</p>
        </div>

        <AuthExplainerAside mode="login" />
      </div>
    </section>
  );
}
