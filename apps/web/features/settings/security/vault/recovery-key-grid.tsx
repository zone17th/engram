'use client';

// DEDUPE(T16A): Lane `vaultweb` (T16A) is building the onboarding recovery-key grid in parallel.
// After the Advisor syncs `vaultweb` into `phase03/vault`, deduplicate this grid with the onboarding
// recovery-key grid component if `vaultweb` exports a shared one.

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import type { RecoveryKeyItemResult } from '@/lib/crypto/protocol';

const CLIPBOARD_WIPE_MS = 30_000;

export interface RecoveryKeyGridProps {
  /** Newly generated recovery key items (`{ slot, display, lookup_hash, wrap }`). Never stored RK. */
  keys: ReadonlyArray<Pick<RecoveryKeyItemResult, 'slot' | 'display'>>;
  /** Suggested `.txt` filename for download. */
  filename?: string;
  /** Optional callback fired when the user downloads or copies keys (e.g. for toast feedback). */
  onNotice?: (message: string) => void;
}

export function RecoveryKeyGrid({
  keys,
  filename = 'engram-recovery-keys.txt',
  onNotice,
}: RecoveryKeyGridProps) {
  const t = useTranslations('settings.vaultSecurity.recoveryKeys.grid');
  const clipboardTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      window.clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = undefined;
    };
  }, []);

  const formatPlaintextContent = useCallback(() => {
    return keys.map((item) => item.display).join('\n') + '\n';
  }, [keys]);

  const handleDownloadTxt = useCallback(() => {
    if (keys.length === 0 || typeof document === 'undefined') return;
    const text = formatPlaintextContent();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      onNotice?.(t('downloadedToast'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [filename, formatPlaintextContent, keys.length, onNotice, t]);

  const handlePrint = useCallback(() => {
    if (keys.length === 0 || typeof window === 'undefined') return;
    if (typeof window.print === 'function') {
      window.print();
    }
  }, [keys.length]);

  const handleCopy = useCallback(async () => {
    if (keys.length === 0 || typeof navigator === 'undefined') return;
    const text = keys.map((item) => item.display).join('\n');
    try {
      await navigator.clipboard?.writeText(text);
      onNotice?.(t('copiedToast'));
      window.clearTimeout(clipboardTimerRef.current);
      clipboardTimerRef.current = window.setTimeout(() => {
        void navigator.clipboard?.writeText('').catch(() => undefined);
      }, CLIPBOARD_WIPE_MS);
    } catch {
      // Clipboard API may be unavailable in non-secure test contexts; ignore
    }
  }, [keys, onNotice, t]);

  if (keys.length === 0) return null;

  return (
    <div data-testid="recovery-key-grid-container">
      <div className="mb-4 rounded-md bg-paleOrange p-3.5">
        <p className="m-0 text-[13px] text-body">{t('shownOnceWarning')}</p>
      </div>

      <div className="card mb-4 p-4">
        <div
          role="list"
          aria-label="Recovery keys"
          data-testid="recovery-key-grid"
          className="grid gap-1.5 sm:grid-cols-2"
        >
          {keys.map((item) => (
            <code
              key={item.slot}
              role="listitem"
              data-slot={item.slot}
              className="mono rounded-md bg-surface px-2 py-2 text-[11px] text-body"
            >
              {item.display}
            </code>
          ))}
        </div>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={handleDownloadTxt}>
          {t('downloadTxt')}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={handlePrint}>
          {t('print')}
        </Button>
        <Button type="button" variant="tertiary" size="sm" onClick={() => void handleCopy()}>
          {t('copy')}
        </Button>
      </div>
    </div>
  );
}
