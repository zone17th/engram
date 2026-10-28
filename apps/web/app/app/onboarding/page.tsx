'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AppHeader } from '@/components/app-shell/app-header';
import { useSession } from '@/features/auth/session-provider';

export default function OnboardingPlaceholderPage() {
  const t = useTranslations('onboarding');
  const { me } = useSession();
  const vaultAbsent = me?.vault.status !== 'present';

  return (
    <>
      <AppHeader vault={{ state: 'absent' }} showLogout />
      <main className="mx-auto max-w-[720px] px-5 py-10">
        <h1 className="t-title-lg mb-2 text-ink">{t('title')}</h1>
        <p className="t-body-lg mb-6 text-muted">{t('body')}</p>
        <div className="card p-6">
          <p className="mb-4 text-[15px] text-body">{vaultAbsent ? t('absent') : t('present')}</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/app/settings" className="btn btn-secondary no-underline">
              {t('settings')}
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
