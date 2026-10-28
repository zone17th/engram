import { cn } from '@/lib/cn';

export type VaultPillState = 'open' | 'locked' | 'absent';

/**
 * P02: absent = chưa tạo kho (Me.vault.status). locked/open là P03 crypto state.
 */
export function VaultPill({
  state,
  minutesLeft,
  className,
}: {
  state: VaultPillState;
  minutesLeft?: number;
  className?: string;
}) {
  if (state === 'absent') {
    return (
      <span className={cn('vault-pill vault-shut', className)} aria-disabled="true">
        <span aria-hidden="true">🔒</span>
        <span>Chưa tạo kho</span>
      </span>
    );
  }

  const open = state === 'open';
  return (
    <span className={cn('vault-pill', open ? 'vault-open' : 'vault-shut', className)}>
      <span aria-hidden="true">{open ? '🔓' : '🔒'}</span>
      <span>{open ? 'Vault mở' : 'Vault đang khoá'}</span>
      {open && minutesLeft !== undefined && <span>· {minutesLeft} phút</span>}
    </span>
  );
}
