'use client';

import { useTranslations } from 'next-intl';

export function AuthExplainerCompact() {
  const t = useTranslations('auth.explainer');
  return (
    <div
      className="mb-6 rounded-lg border border-line bg-surface p-4 md:hidden"
      data-testid="auth-explainer-compact"
    >
      <p className="m-0 mb-1.5 text-[13px] font-semibold text-ink">{t('compactTitle')}</p>
      <p className="m-0 mb-1.5 text-[12.5px] text-body">
        {t('compactEncrypted')} <strong className="font-semibold">{t('compactPlaintext')}</strong>
      </p>
      <p className="mono m-0 text-[12px] text-body">{t('compactSteps')}</p>
    </div>
  );
}

export function AuthExplainerAside({ mode }: { mode: 'login' | 'signup' }) {
  const t = useTranslations('auth.explainer');
  return (
    <aside
      className="panel sticky top-6 hidden p-6 md:block lg:p-7"
      aria-label={t('ariaLabel')}
      data-testid="auth-explainer-aside"
    >
      <p className="t-label mb-2 text-accent">{t('kicker')}</p>
      <h2 className="t-title-sm mb-3">{t('heading')}</h2>
      <p className="m-0 mb-5 text-[14px] text-body">{t('lead')}</p>

      <div className="mb-5 flex flex-col gap-2.5">
        <div className="rounded-md border border-line bg-canvas p-3.5">
          <p className="t-label mb-1" style={{ color: 'var(--success-ink)' }}>{t('encryptedBadge')}</p>
          <p className="m-0 text-[13px] text-body">{t('encryptedBody')}</p>
        </div>

        <div
          className="rounded-md border border-line p-3.5"
          style={{ background: 'var(--pale-orange)' }}
        >
          <p className="t-label mb-1 text-body">{t('plaintextBadge')}</p>
          <p className="m-0 text-[13px] text-body">
            <strong>{t('plaintextStrong')}</strong>
            {t('plaintextBody')}
          </p>
        </div>
      </div>

      <p className="t-label mb-2.5 text-muted">{t('stepsHeading')}</p>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0 text-[13px]">
        <li className="flex items-start gap-2.5">
          <span
            className="mono rounded-sm px-1.5 py-0.5 text-[12px] font-semibold"
            style={
              mode === 'signup'
                ? { background: 'var(--pale-accent)', color: 'var(--accent)' }
                : { background: 'var(--surface-alt)', color: 'var(--body)' }
            }
          >
            1
          </span>
          <div>
            <strong className="text-body">
              {mode === 'signup' ? t('step1CurrentTitle') : t('step1Title')}
            </strong>
            <span className="block text-muted">{t('step1Body')}</span>
          </div>
        </li>
        <li className="flex items-start gap-2.5">
          <span
            className="mono rounded-sm px-1.5 py-0.5 text-[12px] font-semibold"
            style={{ background: 'var(--surface-alt)', color: 'var(--body)' }}
          >
            2
          </span>
          <div>
            <strong className="text-body">{t('step2Title')}</strong>
            <span className="block text-muted">{t('step2Body')}</span>
          </div>
        </li>
        <li className="flex items-start gap-2.5">
          <span
            className="mono rounded-sm px-1.5 py-0.5 text-[12px] font-semibold"
            style={{ background: 'var(--surface-alt)', color: 'var(--body)' }}
          >
            3
          </span>
          <div>
            <strong className="text-body">{t('step3Title')}</strong>
            <span className="block text-muted">{t('step3Body')}</span>
          </div>
        </li>
      </ol>
    </aside>
  );
}
