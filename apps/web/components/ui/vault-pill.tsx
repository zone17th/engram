'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';

export type VaultPillState = 'open' | 'locked' | 'absent';

/**
 * P02: absent = chưa tạo vault (Me.vault.status). locked/open là P03 crypto state.
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
  const t = useTranslations('vault');

  if (state === 'absent') {
    return (
      <span className={cn('vault-pill vault-shut', className)} aria-disabled="true">
        <span aria-hidden="true">🔒</span>
        <span>{t('state.noVault')}</span>
      </span>
    );
  }

  const open = state === 'open';
  return (
    <span className={cn('vault-pill', open ? 'vault-open' : 'vault-shut', className)}>
      <span aria-hidden="true">{open ? '🔓' : '🔒'}</span>
      <span>{open ? t('state.unlocked') : t('state.locked')}</span>
      {open && minutesLeft !== undefined && (
        <span>{t('pill.minutesLeft', { minutes: minutesLeft })}</span>
      )}
    </span>
  );
}
