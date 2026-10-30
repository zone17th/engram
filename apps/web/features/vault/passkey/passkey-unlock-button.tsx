'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { PasskeyUnlockOutcome } from './unlock-flow';
import { usePasskeyUnlock } from './use-passkey-unlock';

export interface PasskeyUnlockButtonProps {
  /** Called after the Worker accepted the PWK and the vault is unlocked. */
  onUnlocked?: () => void;
  className?: string;
}

/**
 * "Unlock with passkey" card (mockups/unlock.html view B: passkey first, passphrase below). Renders nothing when the
 * user has no passkey (`404 passkey_not_found`, empty list) or the browser has no WebAuthn.
 */
export function PasskeyUnlockButton({ onUnlocked, className }: PasskeyUnlockButtonProps) {
  const t = useTranslations('vault.passkey');
  const tState = useTranslations('vault.state');
  const { available, pending, inFlight, error, unlock } = usePasskeyUnlock();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  if (!available) return null;

  const run = async () => {
    const outcome: PasskeyUnlockOutcome = await unlock();
    if (outcome.ok && mountedRef.current) onUnlocked?.();
  };

  let message: string | null = null;
  if (error === 'busy') message = tState('busy');
  else if (error === 'recovering') message = tState('recoveringSwitchHint');
  else if (error && error !== 'stale' && error !== 'abandoned') message = t(error);
  return (
    <div className={cn('card mb-4 p-6', className)} data-testid="unlock-passkey-section">
      <Button
        variant="primary"
        className="w-full !justify-center"
        onClick={() => void run()}
        disabled={pending || inFlight}
        aria-busy={pending}
        data-testid="unlock-passkey-button"
      >
        {pending ? t('unlock.pending') : t('unlock.button')}
      </Button>
      <p className="t-caption mt-3 mb-0 text-center" style={{ color: 'var(--muted)' }}>
        {t('unlock.caption')}
      </p>
      {message && (
        <p
          role="alert"
          className="m-0 mt-4 text-[13px]"
          style={{ color: 'var(--body)' }}
          data-testid="unlock-passkey-error"
        >
          {message}
        </p>
      )}
    </div>
  );
}
