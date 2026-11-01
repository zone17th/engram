'use client';

import { Omnibox } from '@/components/app-shell/omnibox';
import { ThemeToggle } from '@/components/app-shell/theme-toggle';
import { Logo } from '@/components/landing/logo';
import { useVaultPillLabel, VaultPill, type VaultPillState, vaultModeToPillState } from '@/components/ui/vault-pill';
import { AppShellLogoutButton } from '@/features/auth/route-guard';
import { useOptionalVault } from '@/features/vault/vault-provider';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

/** Header dính, nền mờ, cao 68px — chép từ mockups/index.html. */
export function AppHeader({
  vault,
  showSearch = false,
  settingsActive = false,
  showLogout = false,
}: {
  vault?: { state: VaultPillState; minutesLeft?: number };
  showSearch?: boolean;
  settingsActive?: boolean;
  showLogout?: boolean;
}) {
  const tHeader = useTranslations('app.header');
  const tVault = useTranslations('vault.state');
  const vaultCtx = useOptionalVault();
  const effectivePillState: VaultPillState = vaultCtx
    ? vaultModeToPillState(vaultCtx.state)
    : (vault?.state ?? 'locked');
  const effectiveMinutesLeft = vault?.minutesLeft ?? vaultCtx?.minutesLeft;
  const canLockNow = effectivePillState === 'open' && Boolean(vaultCtx);
  // FE1-1: the accessible name of the lock button must contain the pill's visible text ("Vault open · N min").
  const pillLabel = useVaultPillLabel(effectivePillState, effectiveMinutesLeft);
  const lockNowName = tHeader('lockNowNamed', { state: pillLabel });

  const handleLockClick = () => {
    if (!vaultCtx) return;
    void vaultCtx.lockNow();
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
        <Link href="/app" className="min-w-0 shrink-0 no-underline" aria-label={tHeader('logoLabel')}>
          <Logo wordmarkClassName="hidden min-[480px]:inline" />
        </Link>
        {showSearch ? <Omnibox compact className="hidden max-w-[420px] md:flex" /> : null}
        <div className="ml-auto flex min-w-0 max-w-full items-center justify-end gap-1 sm:gap-2">
          {canLockNow ? (
            <button
              type="button"
              data-vault=""
              data-testid="vault-lock-button"
              onClick={handleLockClick}
              aria-label={lockNowName}
              aria-keyshortcuts="L"
              title={tHeader('lockNow')}
              className="hidden cursor-pointer border-0 bg-transparent p-0 sm:inline-flex"
            >
              <VaultPill state={effectivePillState} minutesLeft={effectiveMinutesLeft} />
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
              type="button"
              data-testid="vault-lock-button-mobile"
              onClick={handleLockClick}
              className="grid h-9 w-9 cursor-pointer place-items-center rounded-pill border-0 bg-surfaceAlt text-[16px] sm:hidden"
              aria-label={tHeader('openAndLockNow')}
              title={tHeader('openAndLockNow')}
            >
              🔓
            </button>
          ) : (
            <span
              className="grid h-9 w-9 place-items-center rounded-pill bg-surfaceAlt text-[16px] sm:hidden"
              aria-label={mobilePillLabel}
              title={mobilePillLabel}
            >
              {effectivePillState === 'open' ? '🔓' : '🔒'}
            </span>
          )}
          <Link
            href={settingsActive ? '/app' : '/app/settings'}
            className="btn btn-tertiary no-underline !text-body"
            aria-current={settingsActive ? 'page' : undefined}
          >
            {settingsActive ? tHeader('settingsDone') : tHeader('settings')}
          </Link>
          {showLogout ? <AppShellLogoutButton /> : null}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
