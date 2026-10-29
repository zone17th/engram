'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AppHeader } from '@/components/app-shell/app-header';

export function ForgotPassphraseView() {
  const t = useTranslations('forgotPassphrase');

  return (
    <>
      <AppHeader vault={{ state: 'locked' }} showLogout />
      <main
        className="mx-auto max-w-[640px] px-5 pt-10 pb-24"
        data-testid="forgot-passphrase-page"
      >
        <section data-view="s1">
          <h1 className="t-title-lg mb-2 text-ink">{t('title')}</h1>
          <p className="t-body-lg mb-6" style={{ color: 'var(--muted)' }}>
            {t('lead')}
          </p>

          <div className="mb-6 flex flex-col gap-2">
            <div
              className="card flex flex-wrap items-center gap-3 p-4"
              style={{ borderColor: 'var(--accent)' }}
              data-testid="forgot-path-recovery-key"
            >
              <span
                className="mono w-6 text-center"
                style={{ color: 'var(--accent)' }}
              >
                {t('paths.recoveryKeyStep')}
              </span>
              <div className="min-w-0 flex-1 basis-[200px]">
                <div className="text-[14px] font-semibold text-body">
                  {t('paths.recoveryKeyTitle')}
                </div>
                <div className="text-[13px]" style={{ color: 'var(--muted)' }}>
                  {t('paths.recoveryKeyBody')}
                </div>
              </div>
              <Link
                href="/app/recovery"
                className="btn btn-primary btn-sm no-underline"
                data-testid="forgot-use-recovery-key-cta"
              >
                {t('paths.recoveryKeyCta')}
              </Link>
            </div>

            <div
              className="card flex flex-wrap items-center gap-3 p-4"
              data-testid="forgot-path-passkey-device"
            >
              <span
                className="mono w-6 text-center"
                style={{ color: 'var(--muted)' }}
              >
                {t('paths.passkeyStep')}
              </span>
              <div className="min-w-0 flex-1 basis-[200px]">
                <div className="text-[14px] font-semibold text-body">
                  {t('paths.passkeyTitle')}
                </div>
                <div className="text-[13px]" style={{ color: 'var(--muted)' }}>
                  {t('paths.passkeyBody')}
                </div>
              </div>
              <Link
                href="/app/unlock"
                className="btn btn-secondary btn-sm no-underline"
                data-testid="forgot-back-to-unlock-cta"
              >
                {t('paths.passkeyCta')}
              </Link>
            </div>
          </div>

          <div
            className="card mb-6 p-5"
            id="recovery-reauth-start"
            data-testid="forgot-reauth-note"
          >
            <p className="t-label mb-2" style={{ color: 'var(--muted)' }}>
              {t('reauthNote.badge')}
            </p>
            <p className="m-0 mb-1 text-[14px] font-semibold text-body">
              {t('reauthNote.title')}
            </p>
            <p className="m-0 text-[13px]" style={{ color: 'var(--muted)' }}>
              {t('reauthNote.body')}
            </p>
          </div>

          <div
            className="mb-6 rounded-md p-4"
            style={{ background: 'var(--surface)' }}
            data-testid="forgot-last-resort-note"
          >
            <p
              className="m-0 mb-2 text-[13px] font-semibold"
              style={{ color: 'var(--body)' }}
            >
              {t('lastResort.title')}
            </p>
            <p className="m-0 text-[13px]" style={{ color: 'var(--muted)' }}>
              {t('lastResort.body')}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link
              href="/app/settings#baomat"
              className="btn btn-danger no-underline"
              data-testid="forgot-reset-vault-link"
            >
              {t('lastResort.resetCta')}
            </Link>
            <Link
              href="/app/unlock"
              className="btn btn-tertiary no-underline"
              data-testid="forgot-bottom-back-link"
            >
              {t('lastResort.backToUnlock')}
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
