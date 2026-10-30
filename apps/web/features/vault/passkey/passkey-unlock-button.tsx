'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { PasskeyUnlockOutcome } from './unlock-flow';
import { usePasskeyUnlock } from './use-passkey-unlock';

export interface PasskeyUnlockButtonProps {
  /** Called after the Worker accepted the PWK and the vault is unlocked. */
  onUnlocked?: () => void;
  className?: string;
}

/**
 * "Unlock with passkey". Renders nothing when the user has no passkey (or the browser has no WebAuthn). Not mounted
 * anywhere yet: T17B places it on the unlock screen.
 */
export function PasskeyUnlockButton({ onUnlocked, className }: PasskeyUnlockButtonProps) {
  const t = useTranslations('vault.passkey');
  const tState = useTranslations('vault.state');
  const { available, pending, error, unlock } = usePasskeyUnlock();

  if (!available) return null;

  const run = async () => {
    const outcome: PasskeyUnlockOutcome = await unlock();
    if (outcome.ok) onUnlocked?.();
  };

  let message: string | null = null;
  if (error === 'busy') message = tState('busy');
  else if (error === 'recovering') message = tState('recoveringSwitchHint');
  else if (error) message = t(error);

  return (
    <div className={className}>
      <Button variant="secondary" onClick={() => void run()} disabled={pending} aria-busy={pending}>
        {pending ? t('unlock.pending') : t('unlock.button')}
      </Button>
      {message && (
        <p role="alert" className="mt-2 text-[13px] text-body">
          {message}
        </p>
      )}
    </div>
  );
}
