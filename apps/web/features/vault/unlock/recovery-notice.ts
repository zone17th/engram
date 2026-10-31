/**
 * Non-secret hand-off between the recovery flow and the unlock page (FE1-7): when a recovery commits on the server while
 * this tab locked, the recovery route navigates to `/app/unlock`. The notice must outlive that real route change, so it
 * lives in `sessionStorage` (tab-scoped, no passphrase / key material) instead of component-local state.
 */
const RECOVERY_NOTICE_STORAGE_KEY = 'engram.vault.recoveryCompletedNotice';
const RECOVERY_NOTICE_TTL_MS = 30 * 60_000;

interface StoredRecoveryNotice {
  userId: string | null;
  at: number;
}

export function rememberRecoveryCompletedNotice(userId: string | null): void {
  try {
    const payload: StoredRecoveryNotice = { userId, at: Date.now() };
    window.sessionStorage.setItem(RECOVERY_NOTICE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage can be unavailable (private mode); the notice is a courtesy, never a requirement.
  }
}

/** True when a fresh notice for this user is pending. Does not consume it: reloads of the unlock page keep showing it. */
export function hasRecoveryCompletedNotice(userId: string | null): boolean {
  try {
    const raw = window.sessionStorage.getItem(RECOVERY_NOTICE_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<StoredRecoveryNotice> | null;
    if (!parsed || typeof parsed.at !== 'number') return false;
    if (Date.now() - parsed.at > RECOVERY_NOTICE_TTL_MS) {
      window.sessionStorage.removeItem(RECOVERY_NOTICE_STORAGE_KEY);
      return false;
    }
    // A notice written for another account must never be shown to this one.
    if (parsed.userId !== null && parsed.userId !== undefined && parsed.userId !== userId) return false;
    return true;
  } catch {
    return false;
  }
}

export function clearRecoveryCompletedNotice(): void {
  try {
    window.sessionStorage.removeItem(RECOVERY_NOTICE_STORAGE_KEY);
  } catch {
    // ignore
  }
}
