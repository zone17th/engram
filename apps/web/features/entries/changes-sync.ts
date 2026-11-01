'use client';

import { ProblemError } from '@engram/shared-types';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useSession } from '@/features/auth/session-provider';
import {
  CONTENT_ENTRIES_QUERY_KEY_PREFIX,
  CONTENT_ITEM_QUERY_KEY_PREFIX,
  CONTENT_ITEMS_QUERY_KEY_PREFIX,
  CONTENT_TAGS_QUERY_KEY_PREFIX,
  contentQueryKeys,
} from '@/features/items/query-keys';
import {
  VAULT_BODY_QUERY_KEY_PREFIX,
  useOptionalVault,
  vaultBodyQueryKey,
} from '@/features/vault/vault-provider';
import {
  entriesChanges,
  type EntriesChangesParams,
  type EntryChange,
  type EntryChangesPage,
  type EntryMeta,
  type EntryMetaList,
} from '@/lib/api/content';
import { subscribeSessionBroadcast } from '@/lib/auth/broadcast';
import { subscribeUserChanged } from '@/lib/auth/user-changed';

/**
 * Overlap window subtracted from the stored feed watermark on subsequent requests (120 seconds, plan §2.9).
 */
export const CHANGES_OVERLAP_WINDOW_MS = 120_000;

/**
 * Safety bound on pagination depth within a single feed cycle to prevent an infinite loop on malformed cursors.
 */
export const MAX_CHANGES_PAGES_PER_CYCLE = 250;

const RFC3339_NANO_REGEX =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Subtracts `overlapMs` (default 120 s) from an RFC3339 / RFC3339Nano timestamp while preserving sub-millisecond
 * fractional digits (`RFC3339Nano` format accepted by `time.Parse(time.RFC3339Nano, ...)` in `apps/api`).
 * Returns `undefined` if `watermark` cannot be parsed.
 */
export function computeChangesSince(
  watermark: string | null | undefined,
  overlapMs: number = CHANGES_OVERLAP_WINDOW_MS,
): string | undefined {
  if (typeof watermark !== 'string' || watermark.length === 0) {
    return undefined;
  }
  const match = RFC3339_NANO_REGEX.exec(watermark.trim());
  if (!match) {
    const fallbackMs = Date.parse(watermark);
    if (!Number.isFinite(fallbackMs)) {
      return undefined;
    }
    return new Date(fallbackMs - overlapMs).toISOString();
  }

  const [, dateTimeHead, rawFraction, tzSuffix] = match;
  const fractionPadded = (rawFraction ?? '').padEnd(9, '0');
  const millisPart = fractionPadded.slice(0, 3);
  const subMillisPart = fractionPadded.slice(3); // 6 digits (microseconds + nanoseconds)

  const isoWithMillis = `${dateTimeHead}.${millisPart}${tzSuffix}`;
  const baseMs = Date.parse(isoWithMillis);
  if (!Number.isFinite(baseMs)) {
    return undefined;
  }

  const shiftedDate = new Date(baseMs - overlapMs);
  const shiftedIso = shiftedDate.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  const trimmedSubMillis = subMillisPart.replace(/0+$/, '');
  if (trimmedSubMillis.length > 0) {
    return `${shiftedIso.slice(0, -1)}${trimmedSubMillis}Z`;
  }
  const baseWithoutZ = shiftedIso.slice(0, -1);
  const trimmedMillis = baseWithoutZ.replace(/\.?0+$/, '');
  return `${trimmedMillis}Z`;
}

// ---------------------------------------------------------------------------
// In-memory watermark & remote-tombstone stores (never persisted to storage)
// ---------------------------------------------------------------------------

let watermarkState: { userId: string | null; watermark: string | null } = {
  userId: null,
  watermark: null,
};

const remoteTombstoneIds = new Set<string>();
const tombstoneListeners = new Set<() => void>();
let tombstoneSnapshotVersion = 0;

const activeCardTrackerByItem = new Map<string, Map<string, Set<symbol>>>();
const activeCardListeners = new Set<() => void>();

let globalSubscriptionsInstalled = false;
let syncEpoch = 0;
let reloadEpoch = 0;
let maxChangesPagesPerCycleOverride: number | null = null;
function emitTombstoneChange(): void {
  tombstoneSnapshotVersion += 1;
  for (const listener of [...tombstoneListeners]) {
    try {
      listener();
    } catch {
      // Never let a subscriber error break sync or lock cleanup
    }
  }
}

function emitActiveCardChange(): void {
  for (const listener of [...activeCardListeners]) {
    try {
      listener();
    } catch {
      // Ignore subscriber errors
    }
  }
}

/**
 * Clears the in-memory feed watermark (scoped to user, never written to storage).
 */
export function clearChangesWatermark(): void {
  syncEpoch += 1;
  watermarkState = { userId: null, watermark: null };
}

/**
 * Bumps the sync lifecycle epoch and clears the in-memory remote-tombstone ID set, notifying subscribers.
 */
export function clearRemoteTombstones(): void {
  syncEpoch += 1;
  if (remoteTombstoneIds.size === 0) {
    return;
  }
  remoteTombstoneIds.clear();
  emitTombstoneChange();
}

/**
 * Clears both the feed watermark and remote-tombstone store (used on logout, user switch, and vault reset).
 */
export function clearAllChangesSyncState(): void {
  clearChangesWatermark();
  clearRemoteTombstones();
}

function getWatermarkForUser(userId: string | null | undefined): string | null {
  if (!userId) return null;
  if (watermarkState.userId !== userId) {
    return null;
  }
  return watermarkState.watermark;
}

function setWatermarkForUser(userId: string, watermark: string): void {
  if (!userId || !watermark) return;
  watermarkState = {
    userId,
    watermark,
  };
}

function publishRemoteTombstones(entryIds: Iterable<string>): void {
  let mutated = false;
  for (const id of entryIds) {
    if (typeof id === 'string' && id.length > 0 && !remoteTombstoneIds.has(id)) {
      remoteTombstoneIds.add(id);
      mutated = true;
    }
  }
  if (mutated) {
    emitTombstoneChange();
  }
}

function clearRemoteTombstoneForEntry(entryId: string): void {
  if (remoteTombstoneIds.delete(entryId)) {
    emitTombstoneChange();
  }
}

function ensureGlobalSyncLifecycleSubscriptions(): void {
  if (typeof window === 'undefined' || globalSubscriptionsInstalled) {
    return;
  }
  globalSubscriptionsInstalled = true;

  subscribeUserChanged((_prevUserId, nextUserId) => {
    reloadEpoch += 1;
    clearAllChangesSyncState();
    watermarkState = { userId: nextUserId, watermark: null };
  });

  subscribeSessionBroadcast((message) => {
    if (message.type === 'signed_out') {
      reloadEpoch += 1;
      clearAllChangesSyncState();
    }
  });
}

/**
 * Subscribes to changes in the in-memory remote-tombstone entry ID store.
 */
export function subscribeRemoteTombstones(listener: () => void): () => void {
  ensureGlobalSyncLifecycleSubscriptions();
  tombstoneListeners.add(listener);
  return () => {
    tombstoneListeners.delete(listener);
  };
}

/**
 * Returns `true` if `entryId` has been observed as remotely deleted (`deleted_at != null`) in the current unlocked session.
 */
export function isEntryRemotelyDeleted(entryId: string): boolean {
  if (!entryId) return false;
  return remoteTombstoneIds.has(entryId);
}

/**
 * React hook (`useSyncExternalStore`) returning `true` when `entryId` was remotely deleted on another device.
 * Stores entry IDs only — never plaintext. Cleared on lock, logout, user switch, and vault reset.
 */
export function useEntryRemotelyDeleted(entryId: string): boolean {
  const getSnapshot = useCallback(
    () => (entryId ? remoteTombstoneIds.has(entryId) : false),
    [entryId],
  );
  return useSyncExternalStore(subscribeRemoteTombstones, getSnapshot, () => false);
}

// ---------------------------------------------------------------------------
// Active/dirty card retention registry (advisor-dec-211)
// ---------------------------------------------------------------------------

/**
 * Marks a card (`entryId` under `itemId`) as having an active editor, unsaved draft, or in-flight save so
 * `ItemDetailPage` keeps the card mounted even after its `EntryMeta` leaves `['content', 'entries', itemId]`.
 * Holds metadata IDs only — never plaintext.
 */
export function setEntryCardKeepMounted(
  itemId: string,
  entryId: string,
  token: symbol,
  keepMounted: boolean,
): void {
  if (!itemId || !entryId) return;
  let byEntry = activeCardTrackerByItem.get(itemId);
  const hadBefore = Boolean(byEntry?.get(entryId)?.size);

  if (keepMounted) {
    if (!byEntry) {
      byEntry = new Map();
      activeCardTrackerByItem.set(itemId, byEntry);
    }
    let tokens = byEntry.get(entryId);
    if (!tokens) {
      tokens = new Set();
      byEntry.set(entryId, tokens);
    }
    tokens.add(token);
  } else if (byEntry) {
    const tokens = byEntry.get(entryId);
    if (tokens) {
      tokens.delete(token);
      if (tokens.size === 0) {
        byEntry.delete(entryId);
      }
    }
    if (byEntry.size === 0) {
      activeCardTrackerByItem.delete(itemId);
    }
  }

  const hasAfter = Boolean(activeCardTrackerByItem.get(itemId)?.get(entryId)?.size);
  if (hadBefore !== hasAfter) {
    emitActiveCardChange();
  }
}

export function isEntryCardKeptMounted(itemId: string, entryId: string): boolean {
  return Boolean(activeCardTrackerByItem.get(itemId)?.get(entryId)?.size);
}

export function subscribeActiveEntryCards(listener: () => void): () => void {
  activeCardListeners.add(listener);
  return () => {
    activeCardListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Cache invalidation & feed reconciliation helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when at least one `['content', 'entries', itemId]` query currently has an active
 * `useQuery` observer mounted in `queryClient` (i.e. an item page is open).
 */
export function hasActiveContentEntriesQuery(queryClient: QueryClient): boolean {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: CONTENT_ENTRIES_QUERY_KEY_PREFIX, type: 'active' })
    .some((query) => query.getObserversCount() > 0);
}

/**
 * Refetches active canonical metadata sources on wake (plan §2.9, Task 20 item 1):
 * invalidates active `['content', 'entries', *]`, `['content', 'item', *]`, `['content', 'items', *]`, and `['content', 'tags', *]`.
 * Uses `refetchType: 'active'` so no network request is triggered when nothing is mounted.
 */
export async function refetchCanonicalContentSources(queryClient: QueryClient): Promise<void> {
  await Promise.allSettled([
    queryClient.invalidateQueries({
      queryKey: CONTENT_ENTRIES_QUERY_KEY_PREFIX,
      refetchType: 'active',
    }),
    queryClient.invalidateQueries({
      queryKey: CONTENT_ITEM_QUERY_KEY_PREFIX,
      refetchType: 'active',
    }),
    queryClient.invalidateQueries({
      queryKey: CONTENT_ITEMS_QUERY_KEY_PREFIX,
      refetchType: 'active',
    }),
    queryClient.invalidateQueries({
      queryKey: CONTENT_TAGS_QUERY_KEY_PREFIX,
      refetchType: 'active',
    }),
  ]);
}

function getCachedEntryMetaVersion(
  queryClient: QueryClient,
  itemId: string,
  entryId: string,
): number | undefined {
  const cached = queryClient.getQueryData<EntryMetaList | EntryMeta[] | undefined>(
    contentQueryKeys.entries(itemId),
  );
  if (!cached) return undefined;
  const list = Array.isArray(cached) ? cached : Array.isArray(cached.items) ? cached.items : [];
  const found = list.find((item) => item.id === entryId);
  return found?.version;
}

function removeEntryFromEntriesCache(
  queryClient: QueryClient,
  itemId: string,
  entryId: string,
): void {
  queryClient.setQueryData<EntryMetaList | EntryMeta[] | undefined>(
    contentQueryKeys.entries(itemId),
    (prev) => {
      if (!prev) return prev;
      if (Array.isArray(prev)) {
        const filtered = prev.filter((e) => e.id !== entryId);
        return filtered.length === prev.length ? prev : filtered;
      }
      if (Array.isArray(prev.items)) {
        const filtered = prev.items.filter((e) => e.id !== entryId);
        if (filtered.length === prev.items.length) return prev;
        return {
          ...prev,
          items: filtered,
        };
      }
      return prev;
    },
  );
}

function removeOlderEntryBodyQueries(
  queryClient: QueryClient,
  entryId: string,
  newVersion: number,
): boolean {
  const prefix = vaultBodyQueryKey(entryId);
  const matchingQueries = queryClient.getQueryCache().findAll({ queryKey: prefix });
  let hadOlderBody = false;

  for (const query of matchingQueries) {
    const key = query.queryKey;
    // Key shape: ['vault', 'body', entryId] or ['vault', 'body', entryId, version]
    const keyVersion = key.length >= 4 ? key[3] : undefined;
    if (typeof keyVersion !== 'number' || keyVersion < newVersion) {
      hadOlderBody = true;
      queryClient.removeQueries({ queryKey: key, exact: true });
    }
  }
  return hadOlderBody;
}

/**
 * Deduplicates feed changes by `(id, updated_at)` across the overlap window while preserving order.
 */
export function dedupEntryChanges(changes: readonly EntryChange[]): EntryChange[] {
  const seen = new Set<string>();
  const result: EntryChange[] = [];
  for (const change of changes) {
    if (!change || typeof change.id !== 'string' || typeof change.updated_at !== 'string') {
      continue;
    }
    const key = `${change.id}\u0000${change.updated_at}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(change);
  }
  return result;
}

/**
 * Applies a batch of deduplicated `EntryChange` records to the TanStack Query cache and remote-tombstone store (plan §2.9, Task 20):
 * - Tombstone (`deleted_at != null`): removes the entry from `['content', 'entries', item_id]`, removes all
 *   `vaultBodyQueryKey(entryId)` queries, and publishes `id` to the remote-tombstone store.
 * - Live change (`deleted_at == null`): clears any prior tombstone for `id`; when `change.version` is newer than
 *   the cached `EntryMeta.version` (or an older body query exists), removes older body queries for `entryId` and
 *   invalidates `['content', 'entries', item_id]`.
 */
export function applyEntryChangesBatch(
  queryClient: QueryClient,
  changes: readonly EntryChange[],
): void {
  const deduped = dedupEntryChanges(changes);
  const tombstonesToPublish = new Set<string>();
  const itemsToInvalidate = new Set<string>();

  // Track the latest change per entryId in (updated_at, id) order:
  // a later live observation cancels an earlier tombstone in the same batch (and clears any previously published one);
  // a later tombstone wins over an earlier live observation.
  for (const change of deduped) {
    const { id: entryId, item_id: itemId, version, deleted_at: deletedAt } = change;
    if (!entryId || !itemId) continue;

    if (deletedAt !== null && deletedAt !== undefined) {
      removeEntryFromEntriesCache(queryClient, itemId, entryId);
      queryClient.removeQueries({ queryKey: vaultBodyQueryKey(entryId) });
      tombstonesToPublish.add(entryId);
      continue;
    }

    // Live entry (created, updated, or restored): cancel any earlier tombstone in this batch and in the store
    tombstonesToPublish.delete(entryId);
    clearRemoteTombstoneForEntry(entryId);

    const cachedVersion = getCachedEntryMetaVersion(queryClient, itemId, entryId);
    const removedOlderBody = removeOlderEntryBodyQueries(queryClient, entryId, version);
    const isNewerThanCachedMeta = cachedVersion !== undefined && version > cachedVersion;
    const isMissingFromCachedItem =
      cachedVersion === undefined &&
      queryClient.getQueryData(contentQueryKeys.entries(itemId)) !== undefined;

    if (isNewerThanCachedMeta || removedOlderBody || isMissingFromCachedItem) {
      itemsToInvalidate.add(itemId);
    }
  }

  if (tombstonesToPublish.size > 0) {
    publishRemoteTombstones(tombstonesToPublish);
  }

  for (const itemId of itemsToInvalidate) {
    void queryClient.invalidateQueries({ queryKey: contentQueryKeys.entries(itemId) });
  }
}

export interface RunChangesFeedCycleOptions {
  readonly queryClient: QueryClient;
  readonly userId: string;
  readonly isUnlockedAndCurrent: () => boolean;
  readonly fetchChanges?: (params: EntriesChangesParams) => Promise<EntryChangesPage>;
  readonly limit?: number;
}

/**
 * Reads all pages from `GET /entries/changes` before committing the new watermark (plan §2.9, Task 20):
 * - First call when no watermark is held for `userId` omits `since`: `apps/api/internal/entry/entryhttp/changes.go:80-97`
 *   treats no-`since` + no-`cursor` as an O(1) `ContentClockNow` bootstrap returning `{ changes: [], next_cursor: null, watermark }`
 *   without scanning the `entry` table.
 * - Subsequent calls pass `since = watermark - 120 s` (`RFC3339Nano`) and follow `next_cursor` across all pages.
 * - If any page fails, the old watermark is preserved so the next wake re-reads from the start.
 * - On `410 changes_window_expired`, drops the watermark and relies on the canonical refetch.
 * - Page-cap exhaustion (`maxPages` pages read while `next_cursor` is still pending) is treated like a failed cycle:
 *   the previous watermark is KEPT and nothing from the partial batch is applied. The next wake therefore re-reads from
 *   the same `since` until a terminal page is reached (watermark advances) or the server answers `410` (watermark dropped).
 *   Why: a partial apply could publish tombstones/updates from an incomplete window and then advance the watermark past
 *   unread changes; and the canonical entries refetch that follows every wake already converges the visible list, so
 *   skipping the apply costs correctness nothing.
 */
export async function runChangesFeedCycle(options: RunChangesFeedCycleOptions): Promise<void> {
  const {
    queryClient,
    userId,
    isUnlockedAndCurrent,
    fetchChanges = entriesChanges,
    limit,
  } = options;

  if (!userId || !isUnlockedAndCurrent()) {
    return;
  }

  const cycleEpoch = syncEpoch;
  const maxPages =
    maxChangesPagesPerCycleOverride !== null && maxChangesPagesPerCycleOverride > 0
      ? maxChangesPagesPerCycleOverride
      : MAX_CHANGES_PAGES_PER_CYCLE;
  const previousWatermark = getWatermarkForUser(userId);
  const since = computeChangesSince(previousWatermark);

  const accumulatedChanges: EntryChange[] = [];
  let cursor: string | undefined = undefined;
  let candidateWatermark: string | null = null;
  let pageCount = 0;
  let reachedTerminalPage = false;

  try {
    while (pageCount < maxPages) {
      if (!isUnlockedAndCurrent() || syncEpoch !== cycleEpoch) {
        return;
      }

      const page = await fetchChanges({
        ...(since !== undefined ? { since } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });

      if (!isUnlockedAndCurrent() || syncEpoch !== cycleEpoch) {
        return;
      }

      if (pageCount === 0 && typeof page.watermark === 'string' && page.watermark.length > 0) {
        candidateWatermark = page.watermark;
      } else if (
        candidateWatermark === null &&
        typeof page.watermark === 'string' &&
        page.watermark.length > 0
      ) {
        candidateWatermark = page.watermark;
      }

      if (Array.isArray(page.changes) && page.changes.length > 0) {
        accumulatedChanges.push(...page.changes);
      }

      pageCount += 1;

      if (typeof page.next_cursor === 'string' && page.next_cursor.length > 0) {
        cursor = page.next_cursor;
      } else {
        reachedTerminalPage = true;
        break;
      }
    }

    if (!reachedTerminalPage || !isUnlockedAndCurrent() || syncEpoch !== cycleEpoch) {
      // On cap exhaustion (cursor still pending after maxPages) or lifecycle invalidation:
      // keep the OLD watermark and apply nothing from the partial batch.
      return;
    }

    if (accumulatedChanges.length > 0) {
      applyEntryChangesBatch(queryClient, accumulatedChanges);
    }

    if (candidateWatermark !== null) {
      setWatermarkForUser(userId, candidateWatermark);
    }
  } catch (err) {
    if (
      err instanceof ProblemError &&
      (err.problem.status === 410 || err.problem.code === 'changes_window_expired')
    ) {
      if (syncEpoch === cycleEpoch && isUnlockedAndCurrent()) {
        watermarkState = { userId, watermark: null };
      }
      return;
    }
    // Any other error (network, 5xx on page 1 or page 2, etc.): keep the OLD watermark, no retry loop, no UI error.
  }
}

/**
 * Purges entry metadata cache (`['content', 'entries']`), decrypted entry bodies (`['vault', 'body']`),
 * the feed watermark, and the remote-tombstone store on vault reset or `vault_key_id` change (plan §2.10, Task 20).
 * Keeps `['content', 'items']`, `['content', 'item']`, and `['content', 'tags']` intact.
 */
export function purgeEntriesCacheOnVaultReset(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: CONTENT_ENTRIES_QUERY_KEY_PREFIX });
  queryClient.removeQueries({ queryKey: VAULT_BODY_QUERY_KEY_PREFIX });
  clearAllChangesSyncState();
}

export interface UseContentChangesSyncOptions {
  readonly fetchChanges?: (params: EntriesChangesParams) => Promise<EntryChangesPage>;
}

/**
 * App-wide multi-device content sync and client-side vault reset reconciliation hook (plan Task 20, §2.9, §2.10).
 * Mounted once inside `<VaultProvider>` via `<ContentChangesSync />`.
 */
export function useContentChangesSync(options?: UseContentChangesSyncOptions): void {
  const queryClient = useQueryClient();
  const { me, status: sessionStatus } = useSession();
  const vault = useOptionalVault();
  const fetchChangesRef = useRef(options?.fetchChanges);
  fetchChangesRef.current = options?.fetchChanges;

  const userId = me?.user?.id ?? null;
  const isAuthenticated =
    Boolean(userId) &&
    (sessionStatus === 'authenticated_with_vault' ||
      sessionStatus === 'authenticated_without_vault');
  const serverVaultStatus = me?.vault?.status ?? null;
  const vaultState = vault?.state ?? 'locked';
  const vaultMeta = vault?.vaultMeta;
  const hasVaultContext = vault !== null;
  const vaultKeyId = vaultMeta?.vault_key_id ?? null;
  const reloadVaultMeta = vault?.reloadVaultMeta;
  const isAuthenticatedRef = useRef(isAuthenticated);
  isAuthenticatedRef.current = isAuthenticated;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const vaultStateRef = useRef(vaultState);
  vaultStateRef.current = vaultState;
  const reloadVaultMetaRef = useRef(reloadVaultMeta);
  reloadVaultMetaRef.current = reloadVaultMeta;

  useEffect(() => {
    ensureGlobalSyncLifecycleSubscriptions();
  }, []);

  const prevVaultStateRef = useRef(vaultState);
  useEffect(() => {
    const prev = prevVaultStateRef.current;
    prevVaultStateRef.current = vaultState;
    const prevEligible = prev === 'unlocked' || prev === 'unlocking';
    const nextEligible = vaultState === 'unlocked' || vaultState === 'unlocking';
    if (prevEligible !== nextEligible) {
      syncEpoch += 1;
    }
    if (!nextEligible) {
      clearRemoteTombstones();
    }
  }, [vaultState]);

  // User switch or logout reconciliation
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prevUser = prevUserIdRef.current;
    if (sessionStatus === 'signed_out' || !userId) {
      if (prevUser !== null) {
        reloadEpoch += 1;
      }
      if (prevUser !== null || watermarkState.watermark !== null || remoteTombstoneIds.size > 0) {
        clearAllChangesSyncState();
      }
      prevUserIdRef.current = null;
      return;
    }
    if (prevUser !== null && prevUser !== userId) {
      reloadEpoch += 1;
      clearAllChangesSyncState();
    }
    prevUserIdRef.current = userId;
    if (watermarkState.userId !== null && watermarkState.userId !== userId) {
      reloadEpoch += 1;
      clearAllChangesSyncState();
    }
  }, [sessionStatus, userId]);

  // Vault reset / vault_key_id replacement / vault absent detection (plan §2.10).
  // Remember the last NON-NULL vault_key_id per user (never overwrite it with null) AND whether a non-null
  // vaultMeta was observed so a provider reset transition that clears vaultMeta to null (404 on reloadVaultMeta,
  // vault_changed reset broadcast, or key-mismatch intermediate null before replacement) purges immediately.
  const lastSeenVaultByUserRef = useRef<{
    userId: string;
    lastNonNullVaultKeyId: string | null;
    hadPresentVault: boolean;
    hadNonNullVaultMeta: boolean;
  } | null>(null);

  useEffect(() => {
    if (sessionStatus === 'signed_out') {
      lastSeenVaultByUserRef.current = null;
      return;
    }
    if (!isAuthenticated || !userId) {
      // Preserve lastSeenVaultByUserRef across transient non-authenticated states
      // (e.g. sessionStatus === 'loading' when remote session_changed bumps sessionEpoch
      // or 'unavailable' during a transient /auth/me failure) so the remembered
      // lastNonNullVaultKeyId is not lost when the same user remains signed in.
      return;
    }

    const prev = lastSeenVaultByUserRef.current;
    const isPresent = serverVaultStatus === 'present' && vaultState !== 'no_vault';
    const hasNonNullMeta = vaultKeyId !== null;

    if (!prev || prev.userId !== userId) {
      lastSeenVaultByUserRef.current = {
        userId,
        lastNonNullVaultKeyId: vaultKeyId,
        hadPresentVault: isPresent || hasNonNullMeta,
        hadNonNullVaultMeta: hasNonNullMeta,
      };
      if (serverVaultStatus === 'absent' || vaultState === 'no_vault') {
        purgeEntriesCacheOnVaultReset(queryClient);
      }
      return;
    }

    const keyChanged =
      prev.lastNonNullVaultKeyId !== null &&
      vaultKeyId !== null &&
      prev.lastNonNullVaultKeyId !== vaultKeyId;
    const becameAbsent =
      (prev.hadPresentVault || prev.lastNonNullVaultKeyId !== null) &&
      (serverVaultStatus === 'absent' || vaultState === 'no_vault');
    const vaultMetaClearedAfterPresent =
      hasVaultContext && prev.hadNonNullVaultMeta && vaultMeta === null;

    if (keyChanged || becameAbsent || vaultMetaClearedAfterPresent) {
      purgeEntriesCacheOnVaultReset(queryClient);
    }

    lastSeenVaultByUserRef.current = {
      userId,
      lastNonNullVaultKeyId: vaultKeyId ?? prev.lastNonNullVaultKeyId,
      hadPresentVault: prev.hadPresentVault || isPresent || hasNonNullMeta,
      hadNonNullVaultMeta: hasNonNullMeta,
    };
  }, [
    hasVaultContext,
    isAuthenticated,
    queryClient,
    serverVaultStatus,
    sessionStatus,
    userId,
    vaultKeyId,
    vaultMeta,
    vaultState,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    let disposed = false;
    let inFlightPromise: Promise<void> | null = null;
    let scheduledBeforeRun = false;
    let rerunRequested = false;

    const executeWakeCycle = async (): Promise<void> => {
      if (disposed || !isAuthenticatedRef.current || !userIdRef.current) {
        return;
      }
      const activeUserId = userIdRef.current;
      const wakeEpoch = syncEpoch;
      const wakeSessionEpoch = reloadEpoch;
      const hasActiveEntries = hasActiveContentEntriesQuery(queryClient);
      const keyAtWakeStart = lastSeenVaultByUserRef.current?.lastNonNullVaultKeyId ?? null;
      const wasUnlockedAtWakeStart =
        vaultStateRef.current === 'unlocked' || vaultStateRef.current === 'unlocking';

      // 1. Always refetch active canonical metadata sources on wake regardless of vault lock state or feed result.
      //    Uses refetchType: 'active', which makes no request when nothing is mounted.
      const refetchPromise = refetchCanonicalContentSources(queryClient);

      // 2. Reconcile GET /vault metadata on wake ONLY when the vault is unlocked AND an entries query is active
      //    so non-item pages never issue an unexpected GET /vault request.
      const shouldReloadVaultMeta =
        hasActiveEntries &&
        wasUnlockedAtWakeStart &&
        typeof reloadVaultMetaRef.current === 'function';

      const reloadPromise = shouldReloadVaultMeta
        ? reloadVaultMetaRef
            .current!()
            .then((freshMeta) => {
              if (
                disposed ||
                !isAuthenticatedRef.current ||
                userIdRef.current !== activeUserId ||
                lastSeenVaultByUserRef.current?.userId !== activeUserId
              ) {
                return freshMeta;
              }
              const rememberedKey =
                lastSeenVaultByUserRef.current?.lastNonNullVaultKeyId ?? keyAtWakeStart;
              const keyMismatched =
                freshMeta !== null &&
                ((keyAtWakeStart !== null && freshMeta.vault_key_id !== keyAtWakeStart) ||
                  (rememberedKey !== null && freshMeta.vault_key_id !== rememberedKey));
              const sameSessionAbsent =
                freshMeta === null && reloadEpoch === wakeSessionEpoch;
              if (keyMismatched || sameSessionAbsent) {
                purgeEntriesCacheOnVaultReset(queryClient);
              }
              return freshMeta;
            })
            .catch(() => null)
        : Promise.resolve(null);

      await Promise.allSettled([refetchPromise, reloadPromise]);

      // 3. Run the changes feed ONLY on a wake event, ONLY when the session is authenticated,
      //    the vault was unlocked on wake (and did not lock or change generation during verification),
      //    AND at least one ['content','entries',itemId] query is currently active/observed.
      if (
        disposed ||
        syncEpoch !== wakeEpoch ||
        !isAuthenticatedRef.current ||
        userIdRef.current !== activeUserId ||
        !wasUnlockedAtWakeStart ||
        (vaultStateRef.current !== 'unlocked' && vaultStateRef.current !== 'unlocking') ||
        !hasActiveContentEntriesQuery(queryClient)
      ) {
        return;
      }

      await runChangesFeedCycle({
        queryClient,
        userId: activeUserId,
        isUnlockedAndCurrent: () =>
          !disposed &&
          syncEpoch === wakeEpoch &&
          isAuthenticatedRef.current &&
          userIdRef.current === activeUserId &&
          (vaultStateRef.current === 'unlocked' || vaultStateRef.current === 'unlocking') &&
          hasActiveContentEntriesQuery(queryClient),
        fetchChanges: fetchChangesRef.current,
      });
    };

    const triggerCoalescedWakeCycle = (): Promise<void> => {
      if (disposed || !isAuthenticatedRef.current || !userIdRef.current) {
        return Promise.resolve();
      }
      // Coalesce overlapping or synchronous burst wake events (focus + visibilitychange + online) into one cycle;
      // if a wake arrives after the in-flight cycle has already started, queue at most ONE trailing cycle.
      if (inFlightPromise) {
        if (!scheduledBeforeRun) {
          rerunRequested = true;
        }
        return inFlightPromise;
      }
      scheduledBeforeRun = true;
      const runDrainLoop = async (): Promise<void> => {
        await Promise.resolve();
        scheduledBeforeRun = false;
        if (disposed) {
          return;
        }
        await executeWakeCycle();
        while (rerunRequested && !disposed) {
          rerunRequested = false;
          await executeWakeCycle();
        }
      };
      const p = runDrainLoop().finally(() => {
        inFlightPromise = null;
        scheduledBeforeRun = false;
        rerunRequested = false;
      });
      inFlightPromise = p;
      return p;
    };

    const onFocus = () => {
      void triggerCoalescedWakeCycle();
    };
    const onOnline = () => {
      void triggerCoalescedWakeCycle();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void triggerCoalescedWakeCycle();
      }
    };

    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      disposed = true;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [queryClient]);
}

/**
 * Tiny client component mounted inside `<VaultProvider>` in `app/app/layout.tsx` next to `<LocaleThemeSync />`.
 */
export function ContentChangesSync(): null {
  useContentChangesSync();
  return null;
}

export const __testing = {
  getWatermarkForUser(userId: string): string | null {
    return getWatermarkForUser(userId);
  },
  setWatermarkForUser(userId: string, watermark: string): void {
    setWatermarkForUser(userId, watermark);
  },
  getRemoteTombstoneIds(): ReadonlySet<string> {
    return remoteTombstoneIds;
  },
  publishRemoteTombstonesForTests(entryIds: Iterable<string>): void {
    publishRemoteTombstones(entryIds);
  },
  getTombstoneSnapshotVersion(): number {
    return tombstoneSnapshotVersion;
  },
  setMaxChangesPagesPerCycleForTests(maxPages: number | null): void {
    maxChangesPagesPerCycleOverride = maxPages;
  },
  resetAllForTests(): void {
    maxChangesPagesPerCycleOverride = null;
    reloadEpoch += 1;
    clearAllChangesSyncState();
    activeCardTrackerByItem.clear();
  },
};
