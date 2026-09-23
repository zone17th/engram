'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthStatus, Field } from '@/components/ui/field';
import { useSession } from '@/features/auth/session-provider';
import type { ReauthAction } from '@/lib/api/auth';
import { sanitizeReturnTo } from '@/lib/auth/return-to';

function actionLabel(action: ReauthAction | null, t: (key: string) => string): string {
  if (!action) return t('reauth.pending');
  return t(`reauth.actions.${action.replace(/\./g, '_')}`);
}

export function ReauthForm() {
  const t = useTranslations('auth');
  const { reauth, me } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const action = (params.get('action') as ReauthAction | null) ?? reauth.pendingAction;
  const returnPath = sanitizeReturnTo(params.get('returnTo') ?? '/app/settings');

  const [password, setPassword] = useState('');

  useEffect(() => {
    if (action && !reauth.pendingAction) {
      void reauth.begin(action, returnPath);
    }
  }, [action, reauth, returnPath]);

  const onPassword = useCallback(async () => {
    try {
      await reauth.submitPassword(password);
      setPassword('');
      router.replace(returnPath);
    } catch {
      /* error shown via reauth.error */
    }
  }, [password, reauth, returnPath, router]);

  if (!me) return null;

  const label = actionLabel(action, t);

  return (
    <section>
      <h1 className="t-title-lg mb-2">{t('reauth.title')}</h1>
      <p className="t-body-lg mb-7 text-muted">{t('reauth.subtitle')}</p>

      <div className="card p-6 mb-4">
        <p className="t-label mb-3 text-muted">{t('reauth.pending')} · {label}</p>

        {reauth.capabilities.hasPassword && (
          <>
            <Field
              label={t('fields.password')}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={reauth.submitting}
              wrapperClassName="mb-4"
            />
            {reauth.error && (
              <AuthStatus tone="error" className="mb-4">
                {reauth.error}
              </AuthStatus>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="tertiary" onClick={() => reauth.cancel()}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void onPassword()} disabled={reauth.submitting}>
                {reauth.submitting ? t('reauth.submitting') : t('reauth.confirm')}
              </Button>
            </div>
          </>
        )}

        {!reauth.capabilities.hasPassword && reauth.capabilities.passwordEnrollmentAvailable && (
          <div>
            <p className="mb-4 text-[13px] text-body">{t('reauth.oauthOnlyHint')}</p>
            <Link href="/app/auth/password-enroll" className="btn btn-secondary btn-sm no-underline">
              {t('reauth.enrollCta')}
            </Link>
          </div>
        )}

        {reauth.capabilities.oauthReauthProviders.includes('google') && (
          <Button
            variant="secondary"
            className="mt-4 w-full !justify-center"
            onClick={() => void reauth.startOauthReauth('google', returnPath)}
            disabled={reauth.submitting}
          >
            {t('reauth.google')}
          </Button>
        )}
      </div>

      <p className="t-caption m-0 text-muted">{t('reauth.grantHint')}</p>
    </section>
  );
}
