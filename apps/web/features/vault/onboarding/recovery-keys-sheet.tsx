'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { RecoveryKeyItemResult } from '@/lib/crypto/protocol';
import {
  copyRecoveryKeysToClipboard,
  downloadRecoveryKeysTxt,
  printRecoveryKeysSheet,
} from './recovery-key-actions';

export interface RecoveryKeyDisplayItem {
  slot: number;
  display: string;
}

export interface RecoveryKeysSheetLabels {
  gridLabel: string;
  slotLabel: (slot: number) => string;
  gridCaption?: string;
  screenshotWarningStrong?: string;
  screenshotWarningBody?: string;
  downloadTxt: string;
  print: string;
  copyAll: string;
  downloadedStatus: string;
  printedStatus: string;
  copiedStatus: string;
  confirmSavedLabel: string;
}

export interface RecoveryKeysSheetProps {
  /** The recovery keys to display (1..10 for onboarding/rotate, or replacement subset for regenerate). */
  keys: ReadonlyArray<Pick<RecoveryKeyItemResult, 'slot' | 'display'>>;
  /** Optional account email included in the header of the downloaded `.txt` file. */
  accountEmail?: string | null;
  /** Controlled confirmation checkbox value. */
  confirmedSaved: boolean;
  /** Called when the confirmation checkbox is toggled. */
  onConfirmedSavedChange: (checked: boolean) => void;
  /** Disables the confirmation checkbox while a mutation is in flight. */
  disabled?: boolean;
  /** Whether to show the one-time no-screenshot warning banner above the grid (defaults to `true`). */
  showScreenshotWarning?: boolean;
  /** Localized labels for the grid, action buttons, status messages, and confirmation checkbox. */
  labels: RecoveryKeysSheetLabels;
  /** Optional custom checkbox id. */
  checkboxId?: string;
}

/**
 * Reusable recovery keys display grid + Download `.txt` / Print / Copy actions + mandatory save confirmation checkbox.
 * Shared across Onboarding U3 step 2 (T16A), Recovery step 4 regenerate (T17A), and Settings security dialogs (T20B).
 */
export function RecoveryKeysSheet({
  keys,
  accountEmail,
  confirmedSaved,
  onConfirmedSavedChange,
  disabled = false,
  showScreenshotWarning = true,
  labels,
  checkboxId,
}: RecoveryKeysSheetProps) {
  const generatedId = useId();
  const effectiveCheckboxId = checkboxId ?? generatedId;

  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const clipboardCleanupRef = useRef<((options?: { clearNow?: boolean }) => void) | null>(null);

  useEffect(() => {
    return () => {
      // Preserve the scheduled 30-second best-effort clipboard expiry across sheet unmount
      // (e.g. completing onboarding, pressing Back, or locking within 30s — BE1-4).
      clipboardCleanupRef.current = null;
    };
  }, []);
  const handleDownloadTxt = useCallback(() => {
    downloadRecoveryKeysTxt(keys, accountEmail);
    setActionStatus(labels.downloadedStatus);
  }, [accountEmail, keys, labels.downloadedStatus]);

  const handlePrint = useCallback(() => {
    setActionStatus(labels.printedStatus);
    printRecoveryKeysSheet();
  }, [labels.printedStatus]);

  const handleCopyAll = useCallback(async () => {
    if (clipboardCleanupRef.current) {
      clipboardCleanupRef.current();
      clipboardCleanupRef.current = null;
    }
    try {
      const cleanup = await copyRecoveryKeysToClipboard(keys);
      clipboardCleanupRef.current = cleanup;
      setActionStatus(labels.copiedStatus);
    } catch {
      // Browser clipboard permission denied: fail gracefully without throwing or recording keys
    }
  }, [keys, labels.copiedStatus]);

  const sortedKeys = [...keys].sort((a, b) => a.slot - b.slot);

  return (
    <div>
      {showScreenshotWarning &&
      (labels.screenshotWarningStrong || labels.screenshotWarningBody) ? (
        <div
          className="mb-5 rounded-md p-4"
          style={{ background: 'var(--pale-orange)' }}
          role="note"
          data-testid="onboarding-screenshot-warning"
        >
          <p className="m-0 text-[13px]" style={{ color: 'var(--body)' }}>
            {labels.screenshotWarningStrong ? (
              <strong>{labels.screenshotWarningStrong} </strong>
            ) : null}
            {labels.screenshotWarningBody}
          </p>
        </div>
      ) : null}

      <div className="card mb-4 p-4 sm:p-5">
        <ol
          aria-label={labels.gridLabel}
          className="m-0 grid list-none gap-1.5 p-0 sm:grid-cols-2"
          data-testid="recovery-keys-grid"
        >
          {sortedKeys.map((item) => (
            <li
              key={item.slot}
              aria-label={labels.slotLabel(item.slot)}
              className="m-0 p-0"
            >
              <code
                tabIndex={0}
                data-testid={`recovery-key-slot-${item.slot}`}
                className="mono block rounded-md px-2 py-2 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                style={{ background: 'var(--surface)', color: 'var(--body)' }}
              >
                {item.display}
              </code>
            </li>
          ))}
        </ol>
        {labels.gridCaption ? (
          <p className="t-caption mt-3 mb-0" style={{ color: 'var(--muted)' }}>
            {labels.gridCaption}
          </p>
        ) : null}
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={handleDownloadTxt}
          data-testid="recovery-keys-download"
        >
          {labels.downloadTxt}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={handlePrint}
          data-testid="recovery-keys-print"
        >
          {labels.print}
        </Button>
        <Button
          type="button"
          variant="tertiary"
          onClick={() => void handleCopyAll()}
          data-testid="recovery-keys-copy"
        >
          {labels.copyAll}
        </Button>
      </div>

      {actionStatus ? (
        <p
          role="status"
          aria-live="polite"
          className="mb-4 text-[13px]"
          style={{ color: 'var(--muted)' }}
          data-testid="recovery-keys-action-status"
        >
          {actionStatus}
        </p>
      ) : null}

      <label
        htmlFor={effectiveCheckboxId}
        className="mb-6 flex cursor-pointer items-start gap-3"
      >
        <input
          id={effectiveCheckboxId}
          type="checkbox"
          className="mt-1"
          checked={confirmedSaved}
          disabled={disabled}
          onChange={(e) => onConfirmedSavedChange(e.target.checked)}
          data-testid="recovery-keys-confirm-checkbox"
        />
        <span className="text-[14px] text-body">{labels.confirmSavedLabel}</span>
      </label>
    </div>
  );
}
