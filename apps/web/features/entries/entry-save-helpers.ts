import type { VaultContextValue } from '@/features/vault/vault-provider';

export const ENTRY_NEAR_CAP_BYTES = 240_000;

export interface EditorPlaintextHolder {
  originalSource: string;
  draftValue: string;
  submittedCandidateSource?: string;
  tableSource?: string;
}

export interface EntrySaveOpGuard {
  readonly isStillCurrent: () => boolean;
}

/**
 * Captures the current lock epoch and vault operation generation BEFORE an async
 * boundary (e.g., fallback `GET /entries/{id}` in 412 Keep mine) so any continuation
 * can verify that neither the component's lock epoch nor the vault generation has
 * changed before reading the resettable plaintext holder or sealing (IP15-BE1-1, BE2-1).
 */
export function captureEntrySaveOpGuard(
  vault: Pick<VaultContextValue, 'beginOp' | 'captureOpGeneration' | 'getClient'> | null | undefined,
  lockEpochRef: { readonly current: number },
): EntrySaveOpGuard {
  const capturedEpoch = lockEpochRef.current;
  const startedOp =
    vault && typeof vault.beginOp === 'function' ? vault.beginOp() : null;
  const capturedGen =
    startedOp?.opGeneration ??
    (vault && typeof vault.captureOpGeneration === 'function'
      ? vault.captureOpGeneration()
      : undefined);

  return {
    isStillCurrent: () => {
      if (lockEpochRef.current !== capturedEpoch) return false;
      if (startedOp && !startedOp.isCurrent()) return false;
      if (
        capturedGen !== undefined &&
        vault &&
        typeof vault.getClient === 'function' &&
        vault.getClient().getGeneration() !== capturedGen
      ) {
        return false;
      }
      return true;
    },
  };
}

/**
 * Copies plaintext to the OS clipboard via `navigator.clipboard.writeText` without
 * auto-clearing (SPEC §7.3, Q16, advisor-dec-114).
 */
export async function copyEntryPlaintextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
