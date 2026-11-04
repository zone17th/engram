'use client';

import { Omnibox } from '@/components/app-shell/omnibox';
import { ThemeToggle } from '@/components/app-shell/theme-toggle';
import { Logo } from '@/components/landing/logo';
import { useVaultPillLabel, VaultPill, type VaultPillState, vaultModeToPillState } from '@/components/ui/vault-pill';
import { AppShellLogoutButton } from '@/features/auth/route-guard';
import { unlockUrl } from '@/features/auth/guard-redirect';
import { unlockOrNavigate } from '@/features/vault/unlock/recovery-notice';
import { useOptionalVault } from '@/features/vault/vault-provider';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
/**
 * Header dính, nền mờ, cao 68px — chép từ mockups/index.html.
 *
 * advisor-dec-186 (UIA-9/18): every app route shows the same header actions in the same order and at one size
 * (the mockup's `btn btn-tertiary`, 38px / 15px): vault pill, Settings, theme toggle, Sign out. Sign out takes the
 * mockup avatar slot at the end.
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
  const vaultCtx = useOptionalVault();
  const pathname = usePathname() ?? '/app';
  const router = useRouter();
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
    const res = await unlockOrNavigate(vaultCtx, unlockUrl(pathname), (url) => router.push(url));
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
    <header className="sticky top-0 z-30 h-[68px] border-b border-line bg-surface/80 backdrop-blur">
      <div className="mx-auto flex h-full min-w-0 max-w-container items-center gap-2 px-5 sm:gap-4">
        <Link href="/app" className="touch-target min-w-0 shrink-0 no-underline" aria-label={tHeader('logoLabel')}>
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
              className="touch-target grid h-[38px] w-[38px] cursor-pointer place-items-center rounded-pill border-0 bg-surfaceAlt text-[16px] sm:hidden [@media(pointer:coarse)]:h-[44px] [@media(pointer:coarse)]:w-[44px]"
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
              className="touch-target grid h-[38px] w-[38px] cursor-pointer place-items-center rounded-pill border-0 bg-surfaceAlt text-[16px] sm:hidden [@media(pointer:coarse)]:h-[44px] [@media(pointer:coarse)]:w-[44px]"
              aria-label={tHeader('lockedAndUnlock')}
              title={tHeader('lockedAndUnlock')}
            >
              🔒
            </button>
          ) : (
            <span
              className="grid h-[38px] w-[38px] place-items-center rounded-pill bg-surfaceAlt text-[16px] sm:hidden [@media(pointer:coarse)]:h-[44px] [@media(pointer:coarse)]:w-[44px]"
              aria-label={mobilePillLabel}
              title={mobilePillLabel}
            >
              {effectivePillState === 'open' ? '🔓' : '🔒'}
            </span>
          )}
          <Link
            href={settingsActive ? '/app' : '/app/settings'}
            className="btn btn-tertiary touch-target no-underline !text-body"
            aria-current={settingsActive ? 'page' : undefined}
          >
            {settingsActive ? tHeader('settingsDone') : tHeader('settings')}
          </Link>
          <ThemeToggle />
          {showLogout ? <AppShellLogoutButton size="md" /> : null}
        </div>
      </div>
    </header>
  );
}
