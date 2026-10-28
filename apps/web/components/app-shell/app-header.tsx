import { Omnibox } from '@/components/app-shell/omnibox';
import { ThemeToggle } from '@/components/app-shell/theme-toggle';
import { Logo } from '@/components/landing/logo';
import { VaultPill, type VaultPillState } from '@/components/ui/vault-pill';
import { AppShellLogoutButton } from '@/features/auth/route-guard';
import Link from 'next/link';

/** Header dính, nền mờ, cao 68px — chép từ mockups/index.html. */
export function AppHeader({
  vault,
  showSearch = false,
  settingsActive = false,
  showLogout = false,
}: {
  vault: { state: VaultPillState; minutesLeft?: number };
  showSearch?: boolean;
  settingsActive?: boolean;
  showLogout?: boolean;
}) {
  return (
    <header className="sticky top-0 z-30 h-[68px] border-b border-line bg-surface/80 backdrop-blur">
      <div className="mx-auto flex h-full min-w-0 max-w-container items-center gap-2 px-5 sm:gap-4">
        <Link href="/app" className="min-w-0 shrink-0 no-underline" aria-label="engram — Mục gần đây">
          <Logo wordmarkClassName="hidden min-[480px]:inline" />
        </Link>
        {showSearch ? <Omnibox compact className="hidden max-w-[420px] md:flex" /> : null}
        <div className="ml-auto flex min-w-0 max-w-full items-center justify-end gap-1 sm:gap-2">
          <VaultPill
            state={vault.state}
            minutesLeft={vault.minutesLeft}
            className="hidden sm:inline-flex"
          />
          <span
            className="grid h-9 w-9 place-items-center rounded-pill bg-surfaceAlt text-[16px] sm:hidden"
            aria-label={
              vault.state === 'open'
                ? 'Vault mở'
                : vault.state === 'absent'
                  ? 'Chưa tạo kho'
                  : 'Vault đang khoá'
            }
            title={
              vault.state === 'open'
                ? 'Vault mở'
                : vault.state === 'absent'
                  ? 'Chưa tạo kho'
                  : 'Vault đang khoá'
            }
          >
            {vault.state === 'open' ? '🔓' : '🔒'}
          </span>
          <Link
            href={settingsActive ? '/app' : '/app/settings'}
            className="btn btn-tertiary no-underline !text-body"
            aria-current={settingsActive ? 'page' : undefined}
          >
            {settingsActive ? 'Xong' : 'Cài đặt'}
          </Link>
          {showLogout ? <AppShellLogoutButton /> : null}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
