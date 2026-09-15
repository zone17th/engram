import { Omnibox } from '@/components/app-shell/omnibox';
import { ThemeToggle } from '@/components/app-shell/theme-toggle';
import { Logo } from '@/components/landing/logo';
import { VaultPill } from '@/components/ui/vault-pill';
import Link from 'next/link';

/** Header dính, nền mờ, cao 68px — chép từ mockups/index.html. */
export function AppHeader({
  vault,
  showSearch = false,
  settingsActive = false,
}: {
  vault: { state: 'open' | 'locked'; minutesLeft?: number };
  showSearch?: boolean;
  settingsActive?: boolean;
}) {
  return (
    <header className="sticky top-0 z-30 h-[68px] border-b border-line bg-surface/80 backdrop-blur">
      <div className="mx-auto flex h-full max-w-container items-center gap-2 px-5 sm:gap-4">
        <Link href="/app" className="shrink-0 no-underline" aria-label="engram — Mục gần đây">
          <Logo />
        </Link>
        {showSearch ? <Omnibox compact className="hidden max-w-[420px] md:flex" /> : null}
        <div className="ml-auto flex items-center gap-2">
          <VaultPill
            state={vault.state}
            minutesLeft={vault.minutesLeft}
            className="hidden sm:inline-flex"
          />
          <span
            className="grid h-9 w-9 place-items-center rounded-pill bg-surfaceAlt text-[16px] sm:hidden"
            aria-label={vault.state === 'open' ? 'Vault mở' : 'Vault đang khoá'}
            title={vault.state === 'open' ? 'Vault mở' : 'Vault đang khoá'}
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
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
