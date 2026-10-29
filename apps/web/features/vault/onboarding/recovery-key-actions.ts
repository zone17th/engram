import type { RecoveryKeyItemResult } from '@/lib/crypto/protocol';

export const RECOVERY_KEYS_FILENAME = 'engram-recovery-keys.txt';
export const CLIPBOARD_CLEAR_DELAY_MS = 30_000;

/**
 * Formats the 10 display recovery keys into a plain-text offline backup document.
 * Never logs or persists the keys to any browser storage.
 */
export function formatRecoveryKeysTextFile(
  keys: ReadonlyArray<Pick<RecoveryKeyItemResult, 'slot' | 'display'>>,
  accountEmail?: string | null,
): string {
  const headerLines = [
    'engram — 10 single-use recovery keys',
    ...(accountEmail ? [`Account: ${accountEmail}`] : []),
    '',
    'IMPORTANT:',
    '- Each key unlocks your vault on its own without your passphrase.',
    '- Consuming a key deletes it on the live server.',
    '- Store this file offline in a safe place and delete any temporary copies.',
    '',
  ];

  const keyLines = [...keys]
    .sort((a, b) => a.slot - b.slot)
    .map((item) => item.display);

  return [...headerLines, ...keyLines, ''].join('\n');
}

/**
 * Triggers a client-side `.txt` file download using an ephemeral `Blob` and revokes the object URL.
 */
export function downloadRecoveryKeysTxt(
  keys: ReadonlyArray<Pick<RecoveryKeyItemResult, 'slot' | 'display'>>,
  accountEmail?: string | null,
): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const text = formatRecoveryKeysTextFile(keys, accountEmail);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = RECOVERY_KEYS_FILENAME;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    document.body.removeChild(anchor);
    setTimeout(() => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // Ignore revoke errors in non-browser test environments
      }
    }, 0);
  }
}

/**
 * Triggers the browser print dialog for the current recovery key sheet.
 */
export function printRecoveryKeysSheet(): void {
  if (typeof window === 'undefined' || typeof window.print !== 'function') return;
  window.print();
}

/**
 * Copies the 10 recovery keys to the system clipboard and schedules a best-effort clear after 30s.
 * Returns a cleanup function that cancels the timer.
 */
export async function copyRecoveryKeysToClipboard(
  keys: ReadonlyArray<Pick<RecoveryKeyItemResult, 'slot' | 'display'>>,
): Promise<() => void> {
  const payload = [...keys]
    .sort((a, b) => a.slot - b.slot)
    .map((k) => k.display)
    .join('\n');

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(payload);
  }

  const timer = setTimeout(() => {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText('').catch(() => undefined);
    }
  }, CLIPBOARD_CLEAR_DELAY_MS);

  return () => {
    clearTimeout(timer);
  };
}
