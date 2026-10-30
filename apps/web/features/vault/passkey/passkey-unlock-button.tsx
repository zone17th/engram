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
  const { available, metaLoadFailed, metaLoading, pending, inFlight, error, unlock, retryLoadMeta } =
    usePasskeyUnlock();
  const mountedRef = useRef(true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const focusAfterRetryRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // PKW-R3-4: after a user-initiated Retry settles, restore focus to the Retry button on repeated failure
  // or hand focus to the newly discovered Unlock with passkey button on success.
  useEffect(() => {
    if (!focusAfterRetryRef.current || metaLoading) return;
    if (available) {
      focusAfterRetryRef.current = false;
      rootRef.current?.querySelector<HTMLButtonElement>('[data-testid="unlock-passkey-button"]')?.focus();
      return;
    }
    if (metaLoadFailed) {
      focusAfterRetryRef.current = false;
      rootRef.current?.querySelector<HTMLButtonElement>('[data-testid="unlock-passkey-retry-button"]')?.focus();
      return;
    }
    focusAfterRetryRef.current = false;
  }, [available, metaLoadFailed, metaLoading]);

  if (!available) {
    if (!metaLoadFailed) return null;
    return (
      <div
        ref={rootRef}
        className={cn('card mb-4 p-4', className)}
        role="status"
        data-testid="unlock-passkey-load-error"
      >
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 flex-1 text-[13px]" style={{ color: 'var(--body)' }}>
            {t('unlock.loadFailed')}
          </p>
          <Button
            variant="tertiary"
            size="sm"
            className="ml-auto"
            onClick={() => {
              if (metaLoading || inFlight) return;
              focusAfterRetryRef.current = true;
              void retryLoadMeta();
            }}
            aria-disabled={metaLoading || inFlight || undefined}
            aria-busy={metaLoading}
            data-testid="unlock-passkey-retry-button"
          >
            {t('unlock.retryLoad')}
          </Button>
        </div>
      </div>
    );
  }
  const run = async () => {
    const outcome: PasskeyUnlockOutcome = await unlock();
    if (outcome.ok && mountedRef.current) onUnlocked?.();
  };

  let message: string | null = null;
  if (error === 'busy') message = tState('busy');
  else if (error === 'recovering') message = tState('recoveringSwitchHint');
  else if (error && error !== 'stale' && error !== 'abandoned') message = t(error);
  return (
    <div ref={rootRef} className={cn('card mb-4 p-6', className)} data-testid="unlock-passkey-section">
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
