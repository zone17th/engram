'use client';

import { ProblemError } from '@engram/shared-types';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { AuthErrorCard } from '@/features/auth/auth-error';
import { AuthExplainerAside, AuthExplainerCompact } from '@/features/auth/auth-explainer';
import { PasswordStrengthMeter } from '@/features/auth/password-strength-meter';
import { useSession } from '@/features/auth/session-provider';
import { oauthLoginStartUrl } from '@/lib/api/auth';
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

export function SignupForm() {
  const t = useTranslations('auth');
  const { signup, config } = useSession();
  const router = useRouter();
  const locale = useLocale() as 'en' | 'vi';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
    confirm?: string;
    terms?: string;
  }>({});
  const [alert, setAlert] = useState<
    | { kind: 'email_taken' }
    | { kind: 'rate_limited' }
    | { kind: 'network' }
    | { kind: 'generic' }
    | null
  >(null);
  const [submitting, setSubmitting] = useState(false);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const termsInputRef = useRef<HTMLInputElement>(null);
  const termsCheckboxId = useId();
  const termsErrorId = `${termsCheckboxId}-error`;
  const meterNoteId = `${termsCheckboxId}-meter-note`;
  const retrySeconds = useRetryCountdown(retryUntil);
  const hydrated = useHydrated();

  const providers = config?.oauth_providers ?? [];
  const verifyRequired = config?.email_verification_required ?? false;
  const termsHref = locale === 'vi' ? '/vi/terms' : '/terms';
  const privacyHref = locale === 'vi' ? '/vi/privacy' : '/privacy';

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
      const confirmErr = confirmPassword !== password ? t('validation.password.mismatch') : undefined;
      const termsErr = !accepted ? t('signup.termsRequired') : undefined;
      if (emailErr || passwordErr || confirmErr || termsErr) {
        setFieldErrors({
          email: emailErr ? t(`validation.email.${emailErr}`) : undefined,
          password: passwordErr ? t(`validation.password.${passwordErr}`) : undefined,
          confirm: confirmErr,
          terms: termsErr,
        });
        const root = formRef.current ?? document;
        const firstInvalid = root.querySelector<HTMLElement>('[aria-invalid="true"]');
        if (firstInvalid) {
          firstInvalid.focus();
        } else if (termsErr) {
          termsInputRef.current?.focus();
        }
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
            setFieldErrors({ password: t('validation.password.weak') });
          } else if (err.problem.code === 'rate_limited') {
            const seconds = normalizeRetryAfter(err.problem.retry_after);
            setRetryUntil(Date.now() + seconds * 1000);
            setAlert({ kind: 'rate_limited' });
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
    [accepted, confirmPassword, email, locale, password, retrySeconds, router, signup, t, verifyRequired],
  );

  return (
    <section id="auth-signup">
      <AuthExplainerCompact />

      <div className="grid items-start gap-8 md:grid-cols-[minmax(0,1fr)_340px] lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)]">
        <div className="min-w-0">
          <h1 className="t-title-lg mb-2">{t('signup.title')}</h1>
          <p className="t-body-lg mb-6 text-muted">{t('signup.subtitle')}</p>

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
            <Field
              label={t('fields.password')}
              type="password"
              name="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
              hint={!fieldErrors.password ? t('validation.password.hint') : undefined}
              disabled={submitting || !hydrated}
              wrapperClassName="mb-3"
            />

            <PasswordStrengthMeter
              password={password}
              id="signup-password-meter"
              noteId={meterNoteId}
            />

            <Field
              label={t('fields.confirmPassword')}
              type="password"
              name="confirmPassword"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              error={fieldErrors.confirm}
              disabled={submitting || !hydrated}
              wrapperClassName="mb-4"
            />

            <div
              className="mb-4 rounded-md p-3.5"
              id="signup-passphrase-note"
              style={{ background: 'var(--pale-accent)' }}
            >
              <p className="m-0 text-[13px] text-body">
                <strong>{t('signup.passphraseNoteStrong')}</strong> {t('signup.passphraseNoteBody')}
              </p>
            </div>

            <div className="mb-5">
              <label
                className="flex cursor-pointer items-start gap-3"
                htmlFor={termsCheckboxId}
              >
                <input
                  ref={termsInputRef}
                  id={termsCheckboxId}
                  type="checkbox"
                  className="mt-1"
                  checked={accepted}
                  onChange={(e) => {
                    setAccepted(e.target.checked);
                    if (e.target.checked && fieldErrors.terms) {
                      setFieldErrors((prev) => ({ ...prev, terms: undefined }));
                    }
                  }}
                  disabled={submitting || !hydrated}
                  aria-invalid={fieldErrors.terms ? true : undefined}
                  aria-describedby={fieldErrors.terms ? termsErrorId : undefined}
                />
                <span className="text-[14px]">
                  {t('signup.termsPrefix')}
                  <Link
                    href={termsHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-link underline"
                  >
                    {t('signup.termsLink')}
                  </Link>
                  {t('signup.termsMiddle')}
                  <Link
                    href={privacyHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-link underline"
                  >
                    {t('signup.privacyLink')}
                  </Link>
                  {t('signup.termsSuffix')}
                </span>
              </label>
              {fieldErrors.terms && (
                <span
                  id={termsErrorId}
                  className="field-error mt-1.5 block"
                  style={{ color: 'var(--error-ink)' }}
                  role="alert"
                >
                  {fieldErrors.terms}
                </span>
              )}
            </div>

            {alert?.kind === 'email_taken' && (
              <div className="mb-4">
                <AuthErrorCard title={t('errors.emailTakenTitle')}>
                  <p className="m-0">{t('errors.emailTaken')}</p>
                </AuthErrorCard>
              </div>
            )}
            {alert?.kind === 'rate_limited' && (
              <div className="mb-4">
                <AuthErrorCard title={t('errors.rateLimitedTitle')} warning>
                  <p className="m-0">{t('errors.rateLimited', { seconds: retrySeconds })}</p>
                </AuthErrorCard>
              </div>
            )}
            {alert?.kind === 'network' && (
              <div className="mb-4">
                <AuthErrorCard title={t('errors.networkTitle')}>
                  <p className="m-0">{t('errors.network')}</p>
                </AuthErrorCard>
              </div>
            )}
            {alert?.kind === 'generic' && (
              <div className="mb-4">
                <AuthErrorCard title={t('errors.genericTitle')}>
                  <p className="m-0">{t('errors.genericBody')}</p>
                </AuthErrorCard>
              </div>
            )}

            <Button
              type="submit"
              className="mb-4 w-full !justify-center"
              disabled={submitting || !hydrated || retrySeconds > 0}
              aria-busy={submitting}
            >
              {submitting ? t('signup.submitting') : t('signup.submit')}
            </Button>

            <p className="m-0 border-t border-line pt-3 text-center text-[13.5px] text-muted">
              {t('signup.haveAccount')}{' '}
              <Link
                href="/app/auth/login"
                id="signup-to-login-link"
                className="font-semibold text-link underline"
              >
                {t('signup.signInLink')}
              </Link>
            </p>
          </form>

          <div className="rounded-md bg-surface p-4">
            <p className="m-0 text-[13px] text-body">{t('signup.privacyNote')}</p>
          </div>
        </div>

        <AuthExplainerAside mode="signup" />
      </div>
    </section>
  );
}
