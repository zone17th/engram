'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';

export type VaultPillState = 'open' | 'locked' | 'absent';

/** The pill's visible text as one string, so a control wrapping the pill can include it in its accessible name (WCAG 2.5.3). */
export function useVaultPillLabel(state: VaultPillState, minutesLeft?: number): string {
  const t = useTranslations('vault');
  if (state === 'absent') return t('state.noVault');
  if (state === 'locked') return t('state.locked');
  const base = t('state.unlocked');
  return minutesLeft !== undefined ? `${base} ${t('pill.minutesLeft', { minutes: minutesLeft })}` : base;
}

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
