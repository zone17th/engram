'use client';

import { useTranslations } from 'next-intl';
import { useOptionalVault, type VaultStateMachineMode } from '@/features/vault/vault-provider';
import { cn } from '@/lib/cn';

export type VaultPillState = 'open' | 'locked' | 'absent';

/** The pill's single mapping from the provider's public state machine mode (plan §2.6) to what the pill shows. */
export function vaultModeToPillState(mode: VaultStateMachineMode): VaultPillState {
  if (mode === 'no_vault' || mode === 'onboarding') return 'absent';
  if (mode === 'unlocked' || mode === 'rewrapping') return 'open';
  return 'locked';
}

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
 *
 * Without an explicit `state` the pill reads the provider's public state (`useVault().state`, the same
 * `useSyncExternalStore` snapshot that gates decrypted bodies), so it can never disagree with the surface under it;
 * outside a provider it falls back to `locked`. `data-vault-state` exposes the resolved state to tests.
 */
export function VaultPill({
  state,
  minutesLeft,
  className,
}: {
  state?: VaultPillState;
  minutesLeft?: number;
  className?: string;
}) {
  const t = useTranslations('vault');
  const vault = useOptionalVault();
  const resolved: VaultPillState = state ?? (vault ? vaultModeToPillState(vault.state) : 'locked');
  const resolvedMinutesLeft = minutesLeft ?? (resolved === 'open' ? vault?.minutesLeft : undefined);

  if (resolved === 'absent') {
    return (
      <span
        className={cn('vault-pill vault-shut', className)}
        aria-disabled="true"
        data-vault-state="absent"
      >
        <span aria-hidden="true">🔒</span>
        <span>{t('state.noVault')}</span>
      </span>
    );
  }

  const open = resolved === 'open';
  return (
    <span
      className={cn('vault-pill', open ? 'vault-open' : 'vault-shut', className)}
      data-vault-state={open ? 'unlocked' : 'locked'}
    >
      <span aria-hidden="true">{open ? '🔓' : '🔒'}</span>
      <span>{open ? t('state.unlocked') : t('state.locked')}</span>
      {open && resolvedMinutesLeft !== undefined && (
        <span>{t('pill.minutesLeft', { minutes: resolvedMinutesLeft })}</span>
      )}
    </span>
  );
}
