'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { MouseEvent } from 'react';
import { unlockUrl } from '@/features/auth/guard-redirect';
import { unlockOrNavigate, useOptionalRouterPush } from '@/features/vault/unlock/recovery-notice';
import { useOptionalVault } from '@/features/vault/vault-provider';

/**
 * U5 banner (mockups `data-locked-banner`): shown while the vault holds no key. Names, tags and the list stay on the
 * page; only entry bodies are masked, and there is no create/edit control to hide because none is rendered while locked.
 */
export function LockedBanner() {
  // F-26 (U5, #vault-locked-broadcast): locking is a normal state, not an error. One neutral sentence; the unlock
  // call to action stays the single primary action.
  const t = useTranslations('states');
  const vault = useOptionalVault();
  const pathname = usePathname();
  const routerPush = useOptionalRouterPush();
  const mode = vault?.state;
  if (mode !== 'locked' && mode !== 'error') return null;

  const targetUrl = unlockUrl(pathname ?? '/app');

  const handleUnlockCtaClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!vault || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    void unlockOrNavigate(vault, targetUrl, routerPush);
  };

  return (
    <div
      role="status"
      data-testid="vault-locked-banner"
      className="locked-banner"
    >
      <div className="mx-auto flex max-w-container flex-wrap items-center gap-3 px-5 py-3">
        <p className="t-body m-0 min-w-0 flex-1" data-testid="vault-locked-banner-body">
          {t('vaultLocked')}
        </p>
        <Link
          href={targetUrl}
          onClick={handleUnlockCtaClick}
          data-testid="vault-locked-unlock-cta"
          className="btn btn-primary btn-sm ml-auto no-underline"
        >
          {t('vaultLockedCta')}
        </Link>
      </div>
    </div>
  );
}
