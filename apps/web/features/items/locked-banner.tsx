'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { unlockUrl } from '@/features/auth/guard-redirect';
import { useOptionalVault } from '@/features/vault/vault-provider';

/**
 * U5 banner (mockups `data-locked-banner`): shown while the vault holds no key. Names, tags and the list stay on the
 * page; only entry bodies are masked, and there is no create/edit control to hide because none is rendered while locked.
 */
export function LockedBanner() {
  const t = useTranslations('vault.locked');
  const tItem = useTranslations('content.item');
  const vault = useOptionalVault();
  const pathname = usePathname();
  const mode = vault?.state;
  if (mode !== 'locked' && mode !== 'error') return null;

  return (
    <div
      role="status"
      data-testid="vault-locked-banner"
      className="locked-banner vault-shut border-b border-line"
    >
      <div className="mx-auto flex max-w-container flex-wrap items-center gap-3 px-5 py-3">
        <p className="t-body m-0 min-w-0 flex-1">
          <strong>{t('bannerTitle')}.</strong>{' '}
          <span className="sm:hidden" data-testid="vault-locked-banner-body-short">
            {tItem('lockedBannerBodyShort')}
          </span>
          <span className="hidden sm:inline" data-testid="vault-locked-banner-body-full">
            {t('bannerBody')}
          </span>
        </p>
        <Link
          href={unlockUrl(pathname ?? '/app')}
          data-testid="vault-locked-unlock-cta"
          className="btn btn-primary btn-sm ml-auto no-underline"
        >
          {t('unlockCta')}
        </Link>
      </div>
    </div>
  );
}
