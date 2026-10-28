'use client';

import { ProblemError } from '@engram/shared-types';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthStatus, Field, focusFirstInvalidField } from '@/components/ui/field';
import { AuthErrorCard } from '@/features/auth/auth-error';
import { useSession } from '@/features/auth/session-provider';
import { oauthLoginStartUrl } from '@/lib/api/auth';
import { normalizeRetryAfter } from '@/lib/auth/retry-after';
import { useRetryCountdown } from '@/lib/auth/use-retry-countdown';

function validateEmail(email: string): string | undefined {
  if (!email.trim()) return 'required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'invalid';
  return undefined;
}

function validatePassword(password: string): string | undefined {
  if (password.length < 12) return 'short';
  return undefined;
}

export function SignupForm() {
  const t = useTranslations('auth');
  const { signup, config } = useSession();
  const router = useRouter();
  const locale = useLocale() as 'en' | 'vi';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string; terms?: string }>({});
  const [alert, setAlert] = useState<
    | { kind: 'email_taken' }
    | { kind: 'rate_limited' }
    | { kind: 'network' }
    | { kind: 'generic'; message: string }
    | null
  >(null);
  const [submitting, setSubmitting] = useState(false);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const retrySeconds = useRetryCountdown(retryUntil);

  const providers = config?.oauth_providers ?? [];
  const verifyRequired = config?.email_verification_required ?? false;

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
      const termsErr = !accepted ? t('signup.termsRequired') : undefined;
      if (emailErr || passwordErr || termsErr) {
        setFieldErrors({
          email: emailErr ? t(`validation.email.${emailErr}`) : undefined,
          password: passwordErr ? t('validation.password.short') : undefined,
          terms: termsErr,
        });
        focusFirstInvalidField(formRef.current ?? document);
        return;
      }
      setFieldErrors({});
      setSubmitting(true);
      setAlert(null);
      setRetryUntil(null);
      try {
        await signup({ email: email.trim(), password, locale });
        if (verifyRequired) {
          router.replace('/app/auth/verify-email');
        } else {
          router.replace('/app/onboarding');
        }
      } catch (err) {
        if (err instanceof ProblemError) {
          if (err.problem.code === 'email_taken') {
            setAlert({ kind: 'email_taken' });
          } else if (err.problem.code === 'password_weak') {
            setFieldErrors({ password: t('validation.password.short') });
          } else if (err.problem.code === 'rate_limited') {
            const seconds = normalizeRetryAfter(err.problem.retry_after);
            setRetryUntil(Date.now() + seconds * 1000);
            setAlert({ kind: 'rate_limited' });
          } else {
            setAlert({ kind: 'generic', message: err.problem.detail ?? err.problem.title });
          }
        } else {
          setAlert({ kind: 'network' });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [accepted, email, locale, password, retrySeconds, router, signup, t, verifyRequired],
  );

  return (
    <section>
      <h1 className="t-title-lg mb-2">{t('signup.title')}</h1>
      <p className="t-body-lg mb-7 text-muted">{t('signup.subtitle')}</p>

      <form ref={formRef} onSubmit={onSubmit} className="card mb-4 p-6" noValidate>
        {providers.includes('google') && (
          <a
            href={oauthLoginStartUrl('google')}
            className="btn btn-secondary mb-4 w-full !justify-center no-underline"
          >
            {t('oauth.google')}
          </a>
        )}
        {providers.includes('github') && (
          <a
            href={oauthLoginStartUrl('github')}
            className="btn btn-secondary mb-4 w-full !justify-center no-underline"
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
          disabled={submitting}
          className="mb-4"
        />
        <Field
          label={t('fields.password')}
          type="password"
          name="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
          hint={!fieldErrors.password ? t('validation.password.hint') : undefined}
          disabled={submitting}
          wrapperClassName="mb-4"
        />

        <label className="mb-5 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            disabled={submitting}
          />
          <span className="text-[14px]">{t('signup.terms')}</span>
        </label>
        {fieldErrors.terms && (
          <AuthStatus tone="error" className="mb-4">
            {fieldErrors.terms}
          </AuthStatus>
        )}

        {alert?.kind === 'email_taken' && (
          <AuthErrorCard title={t('errors.emailTakenTitle')}>
            <p className="m-0">{t('errors.emailTaken')}</p>
          </AuthErrorCard>
        )}
        {alert?.kind === 'rate_limited' && (
          <AuthErrorCard title={t('errors.lockoutTitle')} warning>
            <p className="m-0">{t('errors.rateLimited', { seconds: retrySeconds })}</p>
          </AuthErrorCard>
        )}
        {alert?.kind === 'network' && (
          <AuthErrorCard title={t('errors.networkTitle')}>
            <p className="m-0">{t('errors.network')}</p>
          </AuthErrorCard>
        )}
        {alert?.kind === 'generic' && (
          <AuthErrorCard title={t('errors.genericTitle')}>
            <p className="m-0">{alert.message}</p>
          </AuthErrorCard>
        )}

        <Button
          type="submit"
          className="mt-4 w-full !justify-center"
          disabled={submitting || retrySeconds > 0}
          aria-busy={submitting}
        >
          {submitting ? t('signup.submitting') : t('signup.submit')}
        </Button>
      </form>

      <div className="rounded-md bg-surface p-4">
        <p className="m-0 text-[13px] text-body">{t('signup.privacyNote')}</p>
      </div>
    </section>
  );
}
