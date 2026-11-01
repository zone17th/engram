'use client';

import { ProblemError } from '@engram/shared-types';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthStatus, Field, focusFirstInvalidField } from '@/components/ui/field';
import { AuthErrorCard } from '@/features/auth/auth-error';
import { useSession } from '@/features/auth/session-provider';
import { TurnstileWidget } from '@/features/auth/turnstile-widget';
import { authPasswordForgot } from '@/lib/api/auth';
import { ensureCsrf } from '@/lib/api/auth-fetch';
import { normalizeRetryAfter } from '@/lib/auth/retry-after';
import { useRetryCountdown } from '@/lib/auth/use-retry-countdown';
import { useHydrated } from '@/lib/use-hydrated';

function validateEmail(email: string): string | undefined {
  if (!email.trim()) return 'required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'invalid';
  return undefined;
}

type ForgotAlert =
  | { kind: 'submitting' }
  | { kind: 'captcha_required' }
  | { kind: 'rate_limited'; seconds: number }
  | { kind: 'dependency_unavailable' }
  | { kind: 'network' }
  | { kind: 'generic' };

export function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const locale = useLocale() as 'en' | 'vi';
  const { config, configLoading, configError, bootstrapComplete, status } = useSession();

  const [email, setEmail] = useState('');
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const [captchaResetSignal, setCaptchaResetSignal] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string }>({});
  const [alert, setAlert] = useState<ForgotAlert | null>(null);
  const [view, setView] = useState<'form' | 'sent' | 'mail_unavailable'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const retrySeconds = useRetryCountdown(retryUntil);
  const hydrated = useHydrated();

  const isConfigLoading =
    config === null && (!bootstrapComplete || Boolean(configLoading)) && !configError && status !== 'unavailable';
  const isConfigError = Boolean(configError) || (config === null && status === 'unavailable');
  const mailDeliveryAvailable = config?.mail_delivery_available === true;
  const captchaSiteKey = config?.captcha_site_key ?? null;
  const hasOauthProviders = (config?.oauth_providers?.length ?? 0) > 0;
  const contactHref = locale === 'vi' ? '/vi/privacy#contact' : '/privacy#contact';

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
    setAlert((current) =>
      current?.kind === 'rate_limited' || current?.kind === 'dependency_unavailable' ? null : current,
    );
  }, [retrySeconds, retryUntil]);

  const onTryAnotherEmail = useCallback(() => {
    resetCaptcha();
    setAlert(null);
    setFieldErrors({});
    setView('form');
  }, [resetCaptcha]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (retrySeconds > 0 || !mailDeliveryAvailable) return;
      const emailErr = validateEmail(email);
      if (emailErr) {
        setFieldErrors({ email: t(`validation.email.${emailErr}`) });
        focusFirstInvalidField(formRef.current ?? document);
        return;
      }
      if (captchaSiteKey && !captchaToken) {
        resetCaptcha();
        setAlert({ kind: 'captcha_required' });
        return;
      }
      setFieldErrors({});
      setSubmitting(true);
      setAlert({ kind: 'submitting' });
      setRetryUntil(null);

      const sendRequest = () =>
        authPasswordForgot({
          email: email.trim(),
          captcha_token: captchaToken,
          locale,
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
        setAlert(null);
        setView('sent');
      } catch (err) {
        resetCaptcha();
        if (err instanceof ProblemError) {
          if (err.problem.code === 'invalid_request') {
            setAlert(null);
            setFieldErrors({ email: t('validation.email.invalid') });
            focusFirstInvalidField(formRef.current ?? document);
          } else if (err.problem.code === 'mail_delivery_unavailable') {
            setAlert(null);
            setView('mail_unavailable');
          } else if (err.problem.code === 'captcha_required' || err.problem.captcha_required) {
            setAlert({ kind: 'captcha_required' });
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
    [captchaSiteKey, captchaToken, email, locale, mailDeliveryAvailable, resetCaptcha, retrySeconds, t],
  );

  const alertNode = useMemo(() => {
    if (!alert) return null;
    if (alert.kind === 'submitting') {
      return <AuthStatus tone="loading">{t('forgot.submitting')}</AuthStatus>;
    }
    if (alert.kind === 'captcha_required') {
      return (
        <AuthErrorCard title={t('errors.captchaRequiredTitle')} warning>
          <p className="m-0">{t('errors.captchaRequired')}</p>
        </AuthErrorCard>
      );
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
    <section id="auth-forgot">
      <h1 className="t-title-lg mb-2">{t('forgot.title')}</h1>
      <p className="t-body-lg mb-6 text-muted">{t('forgot.subtitle')}</p>

      {isConfigLoading && (
        <div className="card mb-4 p-6" data-testid="forgot-loading-skeleton">
          <AuthStatus tone="loading">{t('guard.loading')}</AuthStatus>
        </div>
      )}

      {!isConfigLoading && isConfigError && (
        <div className="mb-4" data-testid="forgot-config-error">
          <AuthErrorCard title={t('errors.networkTitle')}>
            <p className="m-0">{t('errors.network')}</p>
          </AuthErrorCard>
        </div>
      )}

      {!isConfigLoading && !isConfigError && (!mailDeliveryAvailable || view === 'mail_unavailable') && (
        <div
          className="card mb-4 p-6"
          id="forgot-unavailable"
          data-testid="forgot-unavailable"
        >
          <div role="status" className="auth-status mb-4">
            <p className="m-0 font-semibold text-[14px] text-body">{t('forgot.mailUnavailableTitle')}</p>
          </div>
          <p className="m-0 mb-2 text-[13px] text-body">{t('forgot.mailUnavailableBody')}</p>
          <p className="m-0 mb-4 text-[13px] text-body">
            {t('forgot.mailUnavailableHelpPrefix')}
            <Link href={contactHref} className="font-semibold text-link underline">
              {t('forgot.mailUnavailableContactLink')}
            </Link>
            {t('forgot.mailUnavailableHelpSuffix')}
          </p>
          {hasOauthProviders && (
            <p className="m-0 mb-4 text-[13px] text-muted">{t('forgot.mailUnavailableOauthHint')}</p>
          )}
          <div className="border-t border-line pt-3">
            <Link href="/app/auth/login" className="text-[13.5px] font-semibold text-link underline">
              {t('forgot.backToLogin')}
            </Link>
          </div>
        </div>
      )}

      {!isConfigLoading && !isConfigError && mailDeliveryAvailable && view === 'sent' && (
        <div className="card mb-4 p-6" id="forgot-sent" data-testid="forgot-sent">
          <div role="status" className="auth-status mb-4">
            <p className="m-0 font-semibold text-[14px] text-body">{t('forgot.sentTitle')}</p>
          </div>
          <p className="m-0 mb-5 text-[13px] text-body">{t('forgot.sentBody')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onTryAnotherEmail}>
              {t('forgot.tryAnotherEmail')}
            </Button>
            <Link href="/app/auth/login" className="btn btn-tertiary btn-sm no-underline">
              {t('forgot.backToLogin')}
            </Link>
          </div>
        </div>
      )}

      {!isConfigLoading && !isConfigError && mailDeliveryAvailable && view === 'form' && (
        <>
          <form
            ref={formRef}
            onSubmit={onSubmit}
            className="card mb-4 p-6"
            id="forgot-request"
            noValidate
            data-hydrated={hydrated ? 'true' : 'false'}
          >
            <p className="m-0 mb-4 text-[13.5px] text-body">{t('forgot.intro')}</p>

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

            {alertNode && <div className="mb-4">{alertNode}</div>}

            {captchaSiteKey !== null && (
              <div className="mb-4" id="forgot-request-captcha-slot">
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
              className="mb-4 w-full !justify-center !whitespace-normal"
              disabled={submitting || !hydrated || retrySeconds > 0}
              aria-busy={submitting}
            >
              <span>
                {submitting
                  ? t('forgot.submittingButton')
                  : retrySeconds > 0
                    ? t('forgot.submitCountdown', { seconds: retrySeconds })
                    : t('forgot.submit')}
              </span>
            </Button>

            <p className="m-0 border-t border-line pt-3 text-center text-[13.5px] text-muted">
              {t('forgot.rememberedPrompt')}{' '}
              <Link href="/app/auth/login" className="font-semibold text-link underline">
                {t('forgot.backToLogin')}
              </Link>
            </p>
          </form>

          <div className="rounded-md bg-surface p-4">
            <p className="m-0 text-[13px] text-body">
              <strong>{t('forgot.vaultForgotStrong')}</strong> {t('forgot.vaultForgotBody')}
              <Link href="/app/recovery" className="text-link underline">
                {t('forgot.vaultRecoveryLink')}
              </Link>
              {t('forgot.vaultForgotSuffix')}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
