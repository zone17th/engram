/**
 * In-memory, user-scoped store for the "save unconfirmed" notice (`content.omnibox.saveUnconfirmed`)
 * per SPEC §3.4 / §3.7, advisor-dec-098, advisor-dec-119, advisor-dec-120 (CFE5-1, CFE5-2).
 *
 * SECURITY & PRIVACY INVARIANTS:
 * - Held ONLY in tab memory (never `localStorage`, `sessionStorage`, IndexedDB, or `QueryCache`).
 * - Stores ONLY `{ userId, itemName }` (never plaintext entry body or ciphertext).
 * - Bound to `userId`: rendered ONLY when the active authenticated session belongs to the same `userId`.
 * - Cleared immediately when switching to a different `userId`, on voluntary logout, on manual dismiss,
 *   or on full page reload.
 */

export interface SaveUnconfirmedRecord {
  readonly userId: string;
  readonly itemName: string;
}

type Listener = () => void;

let currentRecord: SaveUnconfirmedRecord | null = null;
const listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

/**
 * Records an unconfirmed save notice for `userId` and `itemName` after a mutation step that
 * previously had an uncertain send outcome hits a terminal authentication/session boundary
 * (`session_invalid`, `forbidden`, or `unauthenticated` without refresh — SPEC §3.4 case b).
 */
export function recordSaveUnconfirmed(record: SaveUnconfirmedRecord): void {
  const userId = record.userId.trim();
  const itemName = record.itemName.trim();
  if (!userId || !itemName) {
    return;
  }
  currentRecord = Object.freeze({ userId, itemName });
  emitChange();
}

/**
 * Clears the in-memory unconfirmed save notice (on dismiss, voluntary logout, or test reset).
 */
export function clearSaveUnconfirmed(): void {
  if (currentRecord === null) {
    return;
  }
  currentRecord = null;
  emitChange();
}

/**
 * Reconciles the stored notice against the active session's `userId` (advisor-dec-120, CFE5-1):
 * - If another user signs in (`activeUserId` is non-empty and differs from `currentRecord.userId`),
 *   the notice is immediately cleared so User B never sees User A's item name.
 */
export function reconcileSaveUnconfirmedUser(activeUserId: string | null | undefined): void {
  if (!currentRecord) {
    return;
  }
  if (typeof activeUserId === 'string' && activeUserId.length > 0 && activeUserId !== currentRecord.userId) {
    currentRecord = null;
    emitChange();
  }
}

/**
 * Returns the unconfirmed save record ONLY if `activeUserId` matches `record.userId`.
 */
export function getSaveUnconfirmedForUser(
  activeUserId: string | null | undefined,
): SaveUnconfirmedRecord | null {
  if (!currentRecord || !activeUserId) {
    return null;
  }
  return currentRecord.userId === activeUserId ? currentRecord : null;
}

/**
 * Returns the raw in-memory snapshot (for `useSyncExternalStore`).
 */
export function getSaveUnconfirmedSnapshot(): SaveUnconfirmedRecord | null {
  return currentRecord;
}

/**
 * Subscribes to changes in the unconfirmed save store (for `useSyncExternalStore`).
 */
export function subscribeSaveUnconfirmed(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
