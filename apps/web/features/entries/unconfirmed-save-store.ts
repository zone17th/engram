import { useSyncExternalStore } from 'react';

/**
 * In-memory store for unconfirmed saves that hit a terminal logout boundary
 * (`session_invalid`, `forbidden`, or `unauthenticated` without successful refresh)
 * after an uncertain network send (SPEC §3.4, §3.7, advisor-dec-119/120, CFE5-1, CFE5-2).
 *
 * - Never persists to localStorage/sessionStorage/IndexedDB.
 * - Never holds decrypted entry body plaintext — only `userId`, `itemId`, and `itemName` (already plaintext on server).
 * - Renders only for the matching `userId`.
 * - Cleared when a different user logs in, on explicit logout, on dismiss, or on full page reload.
 */
export interface UnconfirmedSaveRecord {
  readonly userId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly source: 'entry' | 'omnibox';
  readonly recordedAt: number;
}

let records: UnconfirmedSaveRecord[] = [];
let lastSeenUserId: string | null = null;
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeUnconfirmedSaves(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUnconfirmedSavesSnapshot(): readonly UnconfirmedSaveRecord[] {
  return records;
}

export function recordUnconfirmedSave(record: {
  readonly userId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly source?: 'entry' | 'omnibox';
}): void {
  if (!record.userId || !record.itemId) return;
  lastSeenUserId = record.userId;
  const filtered = records.filter(
    (existing) =>
      existing.userId === record.userId &&
      !(existing.itemId === record.itemId && existing.source === (record.source ?? 'entry')),
  );
  records = [
    ...filtered,
    Object.freeze({
      userId: record.userId,
      itemId: record.itemId,
      itemName: record.itemName,
      source: record.source ?? 'entry',
      recordedAt: Date.now(),
    }),
  ];
  emitChange();
}

export function dismissUnconfirmedSave(params: {
  readonly userId: string;
  readonly itemId?: string;
}): void {
  const next = records.filter((existing) => {
    if (existing.userId !== params.userId) return true;
    if (params.itemId !== undefined && existing.itemId !== params.itemId) return true;
    return false;
  });
  if (next.length !== records.length) {
    records = next;
    emitChange();
  }
}

export function clearAllUnconfirmedSaves(): void {
  lastSeenUserId = null;
  if (records.length > 0) {
    records = [];
    emitChange();
  }
}

export function reconcileUnconfirmedSavesUser(activeUserId: string | null | undefined): void {
  if (!activeUserId) {
    return;
  }
  if (lastSeenUserId !== null && lastSeenUserId !== activeUserId) {
    lastSeenUserId = activeUserId;
    if (records.length > 0) {
      records = [];
      emitChange();
    }
    return;
  }
  lastSeenUserId = activeUserId;
  const filtered = records.filter((existing) => existing.userId === activeUserId);
  if (filtered.length !== records.length) {
    records = filtered;
    emitChange();
  }
}

export function useUnconfirmedSavesForUser(
  userId: string | null | undefined,
  itemId?: string,
): readonly UnconfirmedSaveRecord[] {
  const all = useSyncExternalStore(
    subscribeUnconfirmedSaves,
    getUnconfirmedSavesSnapshot,
    getUnconfirmedSavesSnapshot,
  );
  if (!userId) return [];
  return all.filter(
    (record) => record.userId === userId && (itemId === undefined || record.itemId === itemId),
  );
}
