'use client';

import { Omnibox } from '@/components/app-shell/omnibox';
import { SkipLink } from '@/components/app-shell/skip-link';
import { ThemeToggle } from '@/components/app-shell/theme-toggle';
import { Logo } from '@/components/landing/logo';
import { useVaultPillLabel, VaultPill, type VaultPillState, vaultModeToPillState } from '@/components/ui/vault-pill';
import { AppShellLogoutButton } from '@/features/auth/route-guard';
import { unlockUrl } from '@/features/auth/guard-redirect';
import { unlockOrNavigate, useOptionalRouterPush } from '@/features/vault/unlock/recovery-notice';
import { useOptionalVault } from '@/features/vault/vault-provider';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
/**
 * Header dính, nền mờ, cao 68px — chép từ mockups/index.html.
 *
 * advisor-dec-186 (UIA-9/18): every app route shows the same header actions in the same order and at one size
 * (the mockup's `btn btn-tertiary`, 38px / 15px): vault pill, Settings, theme toggle, Sign out. Sign out takes the
 * mockup avatar slot at the end.
 *
 * V-1 (FU-T26-390-OVERFLOW): below `sm` the row uses `px-3 gap-1` (not `px-5 gap-2`) so logo + lock + Settings + ? + theme + Sign out
 * (all >= 44px) fit in 390px in vi and en; from `sm` up nothing changes (header stays 68px).
 *
 * R4-L2 (advisor ruling, 360px): below `sm` the Settings link is an icon-only 44px target (the text stays in the DOM as
 * `sr-only`, so the accessible name and the link are unchanged) and Sign out uses `px-2`; every target is still >= 44px,
 * Sign out stays visible, and from `sm` up the header is exactly as before. While on /app/settings the short "Done"
 * label keeps its text, with `px-1.5` below `sm` (W-3: vi "Xong" + full-width padding overflowed 360px by 5px). tester_visual proves the real `scrollWidth <= 360` (vi + en); jsdom cannot measure layout.
 *
 * `showLogout` defaults to `true` so every route (including the item page, which passes no flag) shows Sign out.
 * The prop stays in the API only as an opt-out for isolated renders without a SessionProvider (unit tests); app routes
 * must not pass `false`.
 */
export function AppHeader({
  vault,
  showSearch = false,
  settingsActive = false,
  showLogout = true,
}: {
  vault?: { state: VaultPillState; minutesLeft?: number };
  showSearch?: boolean;
  settingsActive?: boolean;
  /** Defaults to true (dec-186). Opt-out only for renders outside SessionProvider. */
  showLogout?: boolean;
}) {
  const tHeader = useTranslations('app.header');
  const tVault = useTranslations('vault.state');
  const tNav = useTranslations('nav');
  const locale = useLocale();
  const docsHref = locale === 'vi' ? '/vi/docs' : '/docs';
  const vaultCtx = useOptionalVault();
  const pathname = usePathname() ?? '/app';
  const routerPush = useOptionalRouterPush();
  const effectivePillState: VaultPillState = vaultCtx
    ? vaultModeToPillState(vaultCtx.state)
    : (vault?.state ?? 'locked');
  const effectiveMinutesLeft = vault?.minutesLeft ?? vaultCtx?.minutesLeft;
  const canLockNow = effectivePillState === 'open' && Boolean(vaultCtx);
  const canUnlockNow = effectivePillState === 'locked';
  // FE1-1: the accessible name of the lock/unlock button must contain the pill's visible text ("Vault open · N min" / "Vault locked").
  const pillLabel = useVaultPillLabel(effectivePillState, effectiveMinutesLeft);
  const lockNowName = tHeader('lockNowNamed', { state: pillLabel });
  const unlockNowName = tHeader('unlockVaultNamed', { state: pillLabel });

  const lockButtonRef = useRef<HTMLButtonElement>(null);
  const mobileLockButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusTargetRef = useRef<'desktop' | 'mobile' | null>(null);

  useEffect(() => {
    if (!canLockNow || restoreFocusTargetRef.current === null) return;
    const target = restoreFocusTargetRef.current;
    restoreFocusTargetRef.current = null;
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
    if (
      activeEl === null ||
      activeEl === document.body ||
      activeEl === document.documentElement
    ) {
      if (target === 'mobile') {
        mobileLockButtonRef.current?.focus();
      } else {
        lockButtonRef.current?.focus();
      }
    }
  }, [canLockNow]);

  const handleLockClick = () => {
    if (!vaultCtx) return;
    void vaultCtx.lockNow();
  };

  const handleUnlockClick = async (variant: 'desktop' | 'mobile') => {
    restoreFocusTargetRef.current = variant;
    const res = await unlockOrNavigate(vaultCtx, unlockUrl(pathname), routerPush);
    if (res?.status !== 'unlocked') {
      restoreFocusTargetRef.current = null;
    }
  };
  const mobilePillLabel =
    effectivePillState === 'open'
      ? tVault('unlocked')
      : effectivePillState === 'absent'
        ? tVault('noVault')
        : tVault('locked');

  return (
    <>
    <SkipLink />
    <header className="sticky top-0 z-30 h-[68px] border-b border-line bg-surface/80 backdrop-blur">
      <div className="mx-auto flex h-full min-w-0 max-w-container items-center gap-1 px-3 sm:gap-4 sm:px-5" data-testid="app-header-row">
        <Link href="/app" className="touch-target inline-flex min-h-11 min-w-11 shrink-0 items-center no-underline" aria-label={tHeader('logoLabel')}>
          <Logo wordmarkClassName="hidden min-[480px]:inline" />
        </Link>
        {showSearch ? <Omnibox compact className="hidden min-w-0 max-w-[420px] md:block" /> : null}
        <div className="ml-auto flex min-w-0 max-w-full shrink-0 items-center justify-end gap-1 sm:gap-2">
          {canLockNow ? (
            <button
              ref={lockButtonRef}
              type="button"
              data-vault=""
              data-testid="vault-lock-button"
              onClick={handleLockClick}
              aria-label={lockNowName}
              aria-keyshortcuts="L"
              title={tHeader('lockNow')}
              className="touch-target hidden cursor-pointer items-center border-0 bg-transparent p-0 sm:inline-flex [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]"
            >
              <VaultPill state={effectivePillState} minutesLeft={effectiveMinutesLeft} className="[@media(pointer:coarse)]:min-h-[44px]" />
            </button>
          ) : canUnlockNow ? (
            <button
              type="button"
              data-vault=""
              data-testid="vault-unlock-button"
              onClick={() => void handleUnlockClick('desktop')}
              disabled={vaultCtx?.inFlight}
              aria-label={unlockNowName}
              title={tHeader('unlockVault')}
              className="touch-target hidden cursor-pointer items-center border-0 bg-transparent p-0 sm:inline-flex [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]"
            >
              <VaultPill state={effectivePillState} minutesLeft={effectiveMinutesLeft} className="[@media(pointer:coarse)]:min-h-[44px]" />
            </button>
          ) : (
            <VaultPill
              state={effectivePillState}
              minutesLeft={effectiveMinutesLeft}
              className="hidden sm:inline-flex"
            />
          )}
          {canLockNow ? (
            <button
              ref={mobileLockButtonRef}
              type="button"
              data-testid="vault-lock-button-mobile"
              onClick={handleLockClick}
              className="touch-target grid h-11 w-11 cursor-pointer place-items-center rounded-pill border-0 bg-surfaceAlt text-[16px] sm:hidden"
              aria-label={tHeader('openAndLockNow')}
              title={tHeader('openAndLockNow')}
            >
              🔓
            </button>
          ) : canUnlockNow ? (
            <button
              type="button"
              data-testid="vault-unlock-button-mobile"
              onClick={() => void handleUnlockClick('mobile')}
              disabled={vaultCtx?.inFlight}
              className="touch-target grid h-11 w-11 cursor-pointer place-items-center rounded-pill border-0 bg-surfaceAlt text-[16px] sm:hidden"
              aria-label={tHeader('lockedAndUnlock')}
              title={tHeader('lockedAndUnlock')}
            >
              🔒
            </button>
          ) : (
            <span
              className="grid h-11 w-11 place-items-center rounded-pill bg-surfaceAlt text-[16px] sm:hidden"
              aria-label={mobilePillLabel}
              title={mobilePillLabel}
            >
              {effectivePillState === 'open' ? '🔓' : '🔒'}
            </span>
          )}
          <Link
            href={settingsActive ? '/app' : '/app/settings'}
            className={`btn btn-tertiary touch-target min-h-11 no-underline !text-body${settingsActive ? ' max-sm:!px-1.5' : ' max-sm:min-w-11 max-sm:!px-0'}`}
            aria-current={settingsActive ? 'page' : undefined}
            data-testid="header-settings-link"
          >
            {settingsActive ? (
              tHeader('settingsDone')
            ) : (
              <>
                <span aria-hidden="true" className="text-[16px] leading-none sm:hidden" data-testid="header-settings-icon">
                  ⚙
                </span>
                <span className="max-sm:sr-only">{tHeader('settings')}</span>
              </>
            )}
          </Link>
          <Link
            href={docsHref}
            className="btn btn-tertiary btn-icon touch-target min-h-11 min-w-11 !px-0 no-underline !text-body"
            aria-label={tNav('help')}
            title={tNav('help')}
            data-testid="header-help-link"
          >
            ?
          </Link>
          <ThemeToggle />
          {showLogout ? <AppShellLogoutButton size="md" /> : null}
        </div>
      </div>
    </header>
    </>
  );
}
