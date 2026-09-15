import { Logo } from '@/components/landing/logo';
import { Kbd } from '@/components/ui/kbd';
import { VaultPill } from '@/components/ui/vault-pill';

/** Header dính, nền mờ, cao 68px — chép từ mockups/index.html. */
export function AppHeader({ vault }: { vault: { state: 'open' | 'locked'; minutesLeft?: number } }) {
  return (
    <header className="sticky top-0 z-30 h-[68px] border-b border-line bg-surface/80 backdrop-blur">
      <div className="mx-auto flex h-full max-w-container items-center justify-between px-5">
        <Logo />
        <div className="flex items-center gap-3">
          <VaultPill state={vault.state} minutesLeft={vault.minutesLeft} />
          <Kbd>Ctrl K</Kbd>
        </div>
      </div>
    </header>
  );
}
