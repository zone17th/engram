import {
  captureUnconfirmedSaveClearGeneration,
  clearAllUnconfirmedSaves,
  dismissUnconfirmedSave,
  getUnconfirmedSavesSnapshot,
  reconcileUnconfirmedSavesUser,
  recordUnconfirmedSave,
  subscribeUnconfirmedSaves,
  useUnconfirmedSavesForUser,
  type UnconfirmedSaveRecord,
} from '@/features/entries/unconfirmed-save-store';
import { getKnownDeviceSessionUserId } from '@/features/vault';
import { subscribeSessionBroadcast } from '@/lib/auth/broadcast';
import { subscribeUserChanged } from '@/lib/auth/user-changed';

export {
  captureUnconfirmedSaveClearGeneration,
  clearAllUnconfirmedSaves,
  dismissUnconfirmedSave,
  getUnconfirmedSavesSnapshot,
  reconcileUnconfirmedSavesUser,
  recordUnconfirmedSave,
  subscribeUnconfirmedSaves,
  useUnconfirmedSavesForUser,
  type UnconfirmedSaveRecord,
};

type Listener = () => void;

/**
 * In-memory, user-scoped store for the post-unlock "draft cleared on lock" notice
 * (`content.omnibox.lockClearedDraftNotice` / `content.omnibox.lockClearedPlanNotice`,
 * plan §2.10, §2.11 step 5, P4FE1-12, HM18B-R1-4).
 *
 * SECURITY & PRIVACY INVARIANTS:
 * - Held ONLY in tab memory (never `localStorage`, `sessionStorage`, IndexedDB, or `QueryCache`).
 * - Stores ONLY `{ userId, kind: 'draft' | 'plan' }` (never plaintext entry body, item name, or ciphertext).
 * - Bound to `userId`: rendered ONLY when the active authenticated session belongs to the same `userId`
 *   and the vault is unlocked — surviving Omnibox unmount/remount across `/app/unlock` route navigation.
 * - Cleared immediately when switching to a different `userId`, on voluntary logout, on manual dismiss,
 *   when the user starts typing or submitting a new save, or on full page reload.
 */
export type LockClearedNoticeKind = 'draft' | 'plan';

export interface LockClearedNoticeRecord {
  readonly userId: string | null;
  readonly kind: LockClearedNoticeKind;
}

let currentLockNoticeRecord: LockClearedNoticeRecord | null = null;
let lastSeenLockNoticeUserId: string | null = null;
const lockNoticeListeners = new Set<Listener>();

let lockNoticeBroadcastUnsubscribe: (() => void) | null = null;
let lockNoticeUserChangedUnsubscribe: (() => void) | null = null;
function ensureLockNoticeSubscriptions(): void {
  if (typeof window === 'undefined') return;
  if (!lockNoticeBroadcastUnsubscribe) {
    lockNoticeBroadcastUnsubscribe = subscribeSessionBroadcast((message) => {
      if (message.type === 'signed_out') {
        clearLockClearedNotice();
        return;
      }
      if (message.type === 'session_changed') {
        const knownUserId = getKnownDeviceSessionUserId();
        if (knownUserId) {
          reconcileLockClearedNoticeUser(knownUserId);
        }
      }
    });
  }
  if (!lockNoticeUserChangedUnsubscribe) {
    lockNoticeUserChangedUnsubscribe = subscribeUserChanged((_prevUserId, nextUserId) => {
      clearLockClearedNotice();
      lastSeenLockNoticeUserId = nextUserId;
    });
  }
}

function emitLockNoticeChange(): void {
  for (const listener of [...lockNoticeListeners]) {
    listener();
  }
}
/**
 * Records a pending post-unlock "draft cleared on lock" notice (`userId` may be `null` if unknown at lock time;
 * any subsequent change to a known `userId` or `signed_out` broadcast drops a `userId: null` notice rather than
 * adopting it — HM18B-R2-6, HM18-R3-4, advisor-dec-120).
 */
export function recordLockClearedNotice(record: LockClearedNoticeRecord): void {
  ensureLockNoticeSubscriptions();
  const rawUserId = typeof record.userId === 'string' ? record.userId.trim() : '';
  const userId = rawUserId.length > 0 ? rawUserId : null;
  if (record.kind !== 'draft' && record.kind !== 'plan') {
    return;
  }
  if (userId) {
    lastSeenLockNoticeUserId = userId;
  }
  currentLockNoticeRecord = Object.freeze({ userId, kind: record.kind });
  emitLockNoticeChange();
}

/**
 * Clears the in-memory lock-cleared notice (on dismiss, new input/save, any `signed_out`, or test reset).
 */
export function clearLockClearedNotice(): void {
  lastSeenLockNoticeUserId = null;
  if (currentLockNoticeRecord === null) {
    return;
  }
  currentLockNoticeRecord = null;
  emitLockNoticeChange();
}

/**
 * Reconciles the stored lock-cleared notice against the active session's `userId` (HM18B-R1-4, HM18-R3-4, advisor-dec-120):
 * - Never adopts a `userId === null` notice into a newly discovered `activeUserId` (drops it on user/session change so
 *   User B can never see a notice recorded before User B's ID became known).
 * - If another user signs in (`activeUserId` is non-empty and differs from `currentLockNoticeRecord.userId`),
 *   the notice is immediately cleared so User B never sees User A's lock notice.
 */
export function reconcileLockClearedNoticeUser(activeUserId: string | null | undefined): void {
  ensureLockNoticeSubscriptions();
  const normalizedActive = typeof activeUserId === 'string' ? activeUserId.trim() : '';
  if (!normalizedActive) {
    return;
  }
  if (lastSeenLockNoticeUserId !== null && lastSeenLockNoticeUserId !== normalizedActive) {
    lastSeenLockNoticeUserId = normalizedActive;
    if (currentLockNoticeRecord !== null) {
      currentLockNoticeRecord = null;
      emitLockNoticeChange();
    }
    return;
  }
  lastSeenLockNoticeUserId = normalizedActive;
  if (!currentLockNoticeRecord) {
    return;
  }
  if (currentLockNoticeRecord.userId === null || normalizedActive !== currentLockNoticeRecord.userId) {
    currentLockNoticeRecord = null;
    emitLockNoticeChange();
  }
}

/**
 * Returns the raw in-memory lock-cleared notice snapshot (for `useSyncExternalStore`).
 */
export function getLockClearedNoticeSnapshot(): LockClearedNoticeRecord | null {
  return currentLockNoticeRecord;
}

/**
 * Subscribes to changes in the lock-cleared notice store (for `useSyncExternalStore`).
 */
export function subscribeLockClearedNotice(listener: Listener): () => void {
  ensureLockNoticeSubscriptions();
  lockNoticeListeners.add(listener);
  return () => {
    lockNoticeListeners.delete(listener);
  };
}
