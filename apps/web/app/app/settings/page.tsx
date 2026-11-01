'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { AppHeader } from '@/components/app-shell/app-header';
import { AuthStatus } from '@/components/ui/field';
import { AccountPanel } from '@/features/settings/account/account-panel';
import {
  AccountDialogs,
  useAccountDialogs,
  type AccountNotice,
} from '@/features/settings/account/account-dialogs';
import { SecuritySection } from '@/features/settings/security/sessions-panel';
import { useSession } from '@/features/auth/session-provider';
import { useOptionalVault } from '@/features/vault/vault-provider';

export default function SettingsPage() {
  const t = useTranslations('settings');
  const { me, reauth } = useSession();
  const vault = useOptionalVault();
  const vaultState =
    vault?.state === 'unlocked' || vault?.state === 'rewrapping'
      ? 'open'
      : me?.vault.status === 'present'
        ? 'locked'
        : 'absent';
  const dialogs = useAccountDialogs();
  const [notice, setNotice] = useState<AccountNotice | null>(null);

  const sections = [
    { id: 'taikhoan', label: t('page.nav.account') },
    { id: 'baomat', label: t('page.nav.security') },
    { id: 'timkiem', label: t('page.nav.search') },
    { id: 'dulieu', label: t('page.nav.data') },
  ];

  return (
    <>
      <AppHeader vault={{ state: vaultState }} settingsActive showLogout />
      <main className="mx-auto grid min-w-0 max-w-container items-start gap-12 px-5 pb-28 pt-10 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label={t('page.navLabel')} className="sticky top-[92px] hidden flex-col gap-0.5 lg:flex">
          {sections.map((section, index) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={`rounded-md px-3 py-2 text-[15px] no-underline ${index === 0 ? 'bg-surfaceAlt font-semibold text-body' : 'text-body hover:bg-surface'}`}
            >
              {section.label}
            </a>
          ))}
        </nav>

        <div className="flex min-w-0 max-w-[720px] flex-col gap-12">
          <h1 className="t-title-lg text-ink">{t('page.title')}</h1>

          {reauth.grant && (
            <AuthStatus tone="sent">{t('reauth.resume')}</AuthStatus>
          )}

          <AccountPanel dialogs={dialogs} notice={notice} />
          <SecuritySection onOpenRevokeDialog={() => dialogs.open('revokeSessionsDlg')} />

          <section id="timkiem" aria-labelledby="search-heading">
            <h2 id="search-heading" className="t-title-md mb-5 text-ink">
              {t('page.searchHeading')}
            </h2>
            <div className="card p-5 control-disabled" aria-disabled="true">
              <div className="text-[15px] font-semibold text-body">
                {t('page.searchTitle')} <span className="phase-badge">{t('page.comingLater')}</span>
              </div>
              <p className="t-body mt-1 m-0 text-muted">{t('page.searchBody')}</p>
            </div>
          </section>

          <section id="dulieu" aria-labelledby="data-heading">
            <h2 id="data-heading" className="t-title-md mb-5 text-ink">
              {t('page.dataHeading')}
            </h2>
            <div className="card p-5 control-disabled" aria-disabled="true">
              <div className="text-[15px] font-semibold text-body">{t('page.dataTitle')}</div>
              <p className="t-body mt-1 m-0 text-muted">{t('page.dataBody')}</p>
            </div>
          </section>
        </div>
      </main>

      <AccountDialogs
        active={dialogs.active}
        context={dialogs.context}
        close={dialogs.close}
        open={dialogs.open}
        onNotice={setNotice}
      />
    </>
  );
}
