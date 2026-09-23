'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthStatus } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { useSession } from '@/features/auth/session-provider';
import { patchSettings, type Locale, type OauthProvider, type Theme } from '@/lib/api/auth';
import { setPreferenceCookies } from '@/lib/preferences/cookies';
import { useTheme } from '@/components/theme-provider';
import type { AccountNotice, useAccountDialogs } from '@/features/settings/account/account-dialogs';

function initials(email: string): string {
  const local = email.split('@', 1)[0] ?? '';
  return local.slice(0, 2).toLowerCase();
}

function formatJoined(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function providerLabel(provider: string): string {
  if (provider === 'github') return 'GitHub';
  if (provider === 'google') return 'Google';
  return provider;
}

export function AccountPanel({
  dialogs,
  notice,
}: {
  dialogs: ReturnType<typeof useAccountDialogs>;
  notice?: AccountNotice | null;
}) {
  const t = useTranslations('settings');
  const { me, refetchMe } = useSession();
  const { setTheme } = useTheme();
  const router = useRouter();
  const [patchError, setPatchError] = useState<string | null>(null);

  if (!me) return null;

  const hasPassword = me.identities.some((i) => i.provider === 'password');
  const linked = new Set(me.identities.map((i) => i.provider));
  const oauthProviders: OauthProvider[] = me.features.oauth_providers;
  const canUnlink = me.identities.length > 1;

  const patchLocale = async (locale: Locale) => {
    setPatchError(null);
    try {
      const updated = await patchSettings({ locale });
      setPreferenceCookies(updated.settings.locale, updated.settings.theme);
      await refetchMe();
      router.refresh();
    } catch {
      setPatchError(t('account.patchFailed'));
    }
  };

  const patchThemePref = async (theme: Theme) => {
    setPatchError(null);
    try {
      const updated = await patchSettings({ theme });
      setTheme(updated.settings.theme);
      setPreferenceCookies(updated.settings.locale, updated.settings.theme);
      await refetchMe();
    } catch {
      setPatchError(t('account.patchFailed'));
    }
  };

  return (
    <section id="taikhoan" aria-labelledby="account-heading">
      <h2 id="account-heading" className="t-title-md mb-6 text-ink">
        {t('account.heading')}
      </h2>
      {notice && (
        <AuthStatus tone={notice.tone === 'error' ? 'error' : 'sent'} className="mb-4">
          {notice.message}
        </AuthStatus>
      )}
      {patchError && (
        <AuthStatus tone="error" className="mb-4">
          {patchError}
        </AuthStatus>
      )}
      <div className="card">
        <div className="flex flex-wrap items-center gap-4 p-5">
          <span className="grid h-11 w-11 place-items-center rounded-pill bg-paleAccent mono text-[15px] text-accent">
            {initials(me.user.email)}
          </span>
          <div className="min-w-0 max-w-full">
            <div className="break-all text-[15px] font-semibold text-body">{me.user.email}</div>
            <div className="text-[13px] text-muted">
              {me.user.email_verified ? t('account.verified') : t('account.unverified')} ·{' '}
              {t('account.joined', { date: formatJoined(me.user.created_at, me.settings.locale) })}
            </div>
          </div>
          <Button variant="tertiary" className="ml-auto" onClick={() => dialogs.open('emailChangeDlg')}>
            {t('account.changeEmail')}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-line p-5">
          <div className="min-w-0 flex-1 basis-[240px]">
            <div className="mb-1 text-[15px] font-semibold">{t('account.passwordTitle')}</div>
            <p className="m-0 text-[13px] text-muted">{t('account.passwordBody')}</p>
          </div>
          <Button
            variant="tertiary"
            className="ml-auto"
            onClick={() =>
              hasPassword ? dialogs.open('passwordChangeDlg') : router.push('/app/auth/password-enroll')
            }
          >
            {hasPassword ? t('account.changePassword') : t('account.setPassword')}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-line p-5">
          <div className="min-w-0 flex-1 basis-[240px]">
            <div className="mb-1 text-[15px] font-semibold">{t('account.identitiesTitle')}</div>
            <div className="mb-2 flex flex-wrap gap-2">
              {(['google', 'github'] as const).map((provider) => (
                <span key={provider} className={`chip ${linked.has(provider) ? '' : 'border-dashed text-muted'}`}>
                  {providerLabel(provider)} · {linked.has(provider) ? t('account.linked') : t('account.notLinked')}
                </span>
              ))}
            </div>
          </div>
          <div className="ml-auto flex flex-col gap-2">
            {oauthProviders
              .filter((provider) => !linked.has(provider))
              .map((provider) => (
                <Button
                  key={`link-${provider}`}
                  variant="tertiary"
                  size="sm"
                  onClick={() => dialogs.open('linkProviderDlg', { provider })}
                >
                  {provider === 'google' ? t('account.linkGoogle') : t('account.linkGithub')}
                </Button>
              ))}
            {canUnlink &&
              me.identities
                .filter((identity) => identity.provider !== 'password')
                .map((identity) => (
                  <Button
                    key={`unlink-${identity.provider}`}
                    variant="tertiary"
                    size="sm"
                    onClick={() => dialogs.open('unlinkProviderDlg', { provider: identity.provider })}
                  >
                    {identity.provider === 'google' ? t('account.unlinkGoogle') : t('account.unlinkGithub')}
                  </Button>
                ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-line p-5">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold">{t('account.localeTitle')}</div>
            <div className="text-[13px] text-muted">{t('account.localeBody')}</div>
          </div>
          <Segmented
            className="ml-auto max-w-full"
            ariaLabel={t('account.localeTitle')}
            value={me.settings.locale}
            onChange={(v) => void patchLocale(v as Locale)}
            options={[
              { value: 'vi', label: 'Tiếng Việt' },
              { value: 'en', label: 'English' },
            ]}
          />
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-line p-5">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold">{t('account.themeTitle')}</div>
            <div className="text-[13px] text-muted">{t('account.themeBody')}</div>
          </div>
          <Segmented
            className="ml-auto max-w-full"
            ariaLabel={t('account.themeTitle')}
            value={me.settings.theme}
            onChange={(v) => void patchThemePref(v as Theme)}
            options={[
              { value: 'system', label: t('account.themeSystem') },
              { value: 'light', label: t('account.themeLight') },
              { value: 'dark', label: t('account.themeDark') },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
