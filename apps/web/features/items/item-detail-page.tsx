'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import { AppHeader } from '@/components/app-shell/app-header';
import {
  ImportJsonDialog,
  JsonEntryCard,
  NewJsonEntryComposer,
} from '@/features/json-table';
import { useOptionalUndoToast } from '@/components/ui/undo-toast';
import { useSession } from '@/features/auth/session-provider';
import {
  dismissUnconfirmedSave,
  loadRealEntryBody,
  reconcileUnconfirmedSavesUser,
  useUnconfirmedSavesForUser,
} from '@/features/entries';
import {
  isEntryCardKeptMounted,
  subscribeActiveEntryCards,
} from '@/features/entries/changes-sync';
import { type EntryBodyLoader } from '@/features/items/entry-body';
import { ItemHeader } from '@/features/items/item-header';
import { LockedBanner } from '@/features/items/locked-banner';
import { contentQueryKeys } from '@/features/items/query-keys';
import {
  NewTextEntryComposer,
  TextEntryCard,
} from '@/features/items/text-entry-card';
import {
  useOptionalVault,
  vaultBodyQueryKey,
} from '@/features/vault/vault-provider';
import {
  classifyContentMutationError,
  createIdempotencyKey,
  entryDelete,
  entryRestore,
  itemDelete,
  itemEntriesList,
  itemEntriesReorder,
  itemGet,
  itemRestore,
  type ContentErrorI18nKey,
  type EntryMeta,
  type EntryMetaList,
  type ItemSummary,
} from '@/lib/api/content';

export const ITEM_MAX_ENTRIES = 200;
export const ENTRIES_RENDER_BATCH_SIZE = 20;
export const REORDER_DEBOUNCE_MS = 400;

interface LastReorderMove {
  readonly movedId: string;
  readonly targetId: string;
  readonly direction: 'up' | 'down' | 'drag';
  readonly targetIndex: number;
}

function sortEntriesByPosition(entries: readonly EntryMeta[]): EntryMeta[] {
  return [...entries].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id),
  );
}

function applySingleMoveToEntries(
  entries: readonly EntryMeta[],
  move: LastReorderMove,
): EntryMeta[] | null {
  const fromIdx = entries.findIndex((e) => e.id === move.movedId);
  const targetIdx = entries.findIndex((e) => e.id === move.targetId);
  if (fromIdx === -1 || targetIdx === -1) {
    return null;
  }

  const copy = [...entries];
  if (move.direction === 'up') {
    if (fromIdx <= 0) return copy;
    const [removed] = copy.splice(fromIdx, 1);
    copy.splice(fromIdx - 1, 0, removed);
  } else if (move.direction === 'down') {
    if (fromIdx >= copy.length - 1) return copy;
    const [removed] = copy.splice(fromIdx, 1);
    copy.splice(fromIdx + 1, 0, removed);
  } else {
    const [removed] = copy.splice(fromIdx, 1);
    const boundedTarget = Math.max(0, Math.min(copy.length, move.targetIndex));
    copy.splice(boundedTarget, 0, removed);
  }
  return copy.map((entry, idx) => ({ ...entry, position: idx }));
}

export interface ItemDetailPageProps {
  readonly itemId: string;
  readonly load?: EntryBodyLoader;
  readonly lazyCards?: boolean;
}

export function ItemDetailPage({
  itemId,
  load = loadRealEntryBody,
  lazyCards = true,
}: ItemDetailPageProps) {
  const tItem = useTranslations('content.item');
  const tEntry = useTranslations('content.entry');
  const tJson = useTranslations('content.json');
  const tErrors = useTranslations('content.errors');
  const router = useRouter();
  const queryClient = useQueryClient();
  const undoToast = useOptionalUndoToast();
  const vault = useOptionalVault();
  const { me } = useSession();

  const unlocked = vault?.state === 'unlocked';

  // Reconcile unconfirmed-save store with current user (advisor-dec-120, CFE5-1)
  useEffect(() => {
    reconcileUnconfirmedSavesUser(me?.user?.id);
  }, [me?.user?.id]);

  const unconfirmedNotices = useUnconfirmedSavesForUser(me?.user?.id, itemId);

  const translateContentError = useCallback(
    (key: ContentErrorI18nKey): string => {
      const code = key.replace(/^content\.errors\./, '');
      return tErrors(code as Parameters<typeof tErrors>[0]);
    },
    [tErrors],
  );

  // Live region announcements
  const [liveMessage, setLiveMessage] = useState<string>('');
  const announce = useCallback((message: string) => {
    setLiveMessage(message);
  }, []);

  // Draft cleared on lock notice (Q15: shown after unlock if a draft was wiped on lock)
  const hadDraftClearedOnLockRef = useRef<boolean>(false);
  const [showDraftClearedNotice, setShowDraftClearedNotice] = useState<boolean>(false);

  const handleDraftClearedOnLock = useCallback(() => {
    hadDraftClearedOnLockRef.current = true;
    setShowDraftClearedNotice(false);
  }, []);

  useEffect(() => {
    if (unlocked && hadDraftClearedOnLockRef.current) {
      hadDraftClearedOnLockRef.current = false;
      setShowDraftClearedNotice(true);
    }
  }, [unlocked]);

  // Queries: itemGet and itemEntriesList (<= 200 metadata once)
  const itemQuery = useQuery({
    queryKey: contentQueryKeys.item(itemId),
    queryFn: ({ signal }) => itemGet(itemId, { signal }),
    retry: false,
  });

  const entriesQuery = useQuery({
    queryKey: contentQueryKeys.entries(itemId),
    queryFn: ({ signal }) => itemEntriesList(itemId, { limit: ITEM_MAX_ENTRIES, signal }),
    enabled: itemQuery.isSuccess,
    retry: false,
  });

  const serverEntries = useMemo(() => {
    const raw = entriesQuery.data;
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : (raw.items ?? []);
    return sortEntriesByPosition(list);
  }, [entriesQuery.data]);

  // Local ordered entries state for optimistic immediate reorder
  const [orderedEntries, setOrderedEntries] = useState<EntryMeta[]>([]);
  const orderedEntriesRef = useRef<EntryMeta[]>([]);
  orderedEntriesRef.current = orderedEntries;

  // Pending reorder state (P4FE1-9)
  const pendingReorderTimerRef = useRef<number | undefined>(undefined);
  const pendingReorderDirtiedRef = useRef<boolean>(false);
  const lastMoveRef = useRef<LastReorderMove | null>(null);
  const reorderInFlightRef = useRef<boolean>(false);
  const [reorderMismatchBanner, setReorderMismatchBanner] = useState<string | null>(null);

  // Sync serverEntries into orderedEntries when no local reorder is pending, retaining any dirty/in-flight card (advisor-dec-211)
  const mergeServerAndKeptEntries = useCallback(
    (nextServer: readonly EntryMeta[], prevOrdered: readonly EntryMeta[]): EntryMeta[] => {
      if (!unlocked || prevOrdered.length === 0) {
        return [...nextServer];
      }
      const serverIds = new Set(nextServer.map((e) => e.id));
      const retained = prevOrdered.filter(
        (e) => !serverIds.has(e.id) && isEntryCardKeptMounted(itemId, e.id),
      );
      if (retained.length === 0) {
        return [...nextServer];
      }
      return sortEntriesByPosition([...nextServer, ...retained]);
    },
    [itemId, unlocked],
  );

  useEffect(() => {
    if (!pendingReorderDirtiedRef.current && !reorderInFlightRef.current) {
      setOrderedEntries((prev) => mergeServerAndKeptEntries(serverEntries, prev));
    }
  }, [mergeServerAndKeptEntries, serverEntries]);

  useEffect(() => {
    return subscribeActiveEntryCards(() => {
      if (!pendingReorderDirtiedRef.current && !reorderInFlightRef.current) {
        setOrderedEntries((prev) => mergeServerAndKeptEntries(serverEntries, prev));
      }
    });
  }, [mergeServerAndKeptEntries, serverEntries]);

  // Batch rendering while scrolling: 20 cards per batch
  const [visibleBatchCount, setVisibleBatchCount] = useState<number>(ENTRIES_RENDER_BATCH_SIZE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setVisibleBatchCount(ENTRIES_RENDER_BATCH_SIZE);
  }, [itemId]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    if (visibleBatchCount >= orderedEntries.length) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting || entry.intersectionRatio > 0) {
            setVisibleBatchCount((prev) =>
              Math.min(orderedEntries.length, prev + ENTRIES_RENDER_BATCH_SIZE),
            );
            break;
          }
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [orderedEntries.length, visibleBatchCount]);

  // Card element registry for focus management after Delete / Undo / Create (IP15-FE1-5)
  const cardElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const addTextBtnRef = useRef<HTMLButtonElement | null>(null);
  const addJsonBtnRef = useRef<HTMLButtonElement | null>(null);
  const importJsonBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const pendingFocusIdRef = useRef<string | null>(null);

  const tryFocusCardDom = useCallback((card: HTMLElement) => {
    const focusable = card.querySelector<HTMLElement>(
      '[data-card-menu-trigger], button:not(:disabled)',
    );
    if (focusable) {
      focusable.focus();
    } else {
      card.focus();
    }
  }, []);

  const registerCardElement = useCallback(
    (entryId: string, el: HTMLElement | null) => {
      if (el) {
        cardElementsRef.current.set(entryId, el);
        if (pendingFocusIdRef.current === entryId) {
          pendingFocusIdRef.current = null;
          tryFocusCardDom(el);
        }
      } else {
        cardElementsRef.current.delete(entryId);
      }
    },
    [tryFocusCardDom],
  );

  const focusEntryCard = useCallback(
    (entryId: string) => {
      const card = cardElementsRef.current.get(entryId);
      if (card) {
        pendingFocusIdRef.current = null;
        setPendingFocusId(null);
        tryFocusCardDom(card);
        return;
      }
      pendingFocusIdRef.current = entryId;
      setPendingFocusId(entryId);
    },
    [tryFocusCardDom],
  );

  useEffect(() => {
    if (!pendingFocusId) return;
    const card = cardElementsRef.current.get(pendingFocusId);
    if (card) {
      pendingFocusIdRef.current = null;
      setPendingFocusId(null);
      tryFocusCardDom(card);
    }
  }, [orderedEntries, pendingFocusId, tryFocusCardDom, visibleBatchCount]);
  // Reorder flush implementation (P4FE1-9)
  const flushPendingReorder = useCallback(
    async (allowMismatchRetry = true) => {
      clearTimeout(pendingReorderTimerRef.current);
      pendingReorderTimerRef.current = undefined;
      if (!pendingReorderDirtiedRef.current) {
        return;
      }
      // Single-flight reorder (IP15-BE1-6, IP15-FE1-3): if a PATCH is already in flight,
      // leave pendingReorderDirtiedRef = true and flush the latest permutation from finally.
      if (reorderInFlightRef.current) {
        return;
      }

      pendingReorderDirtiedRef.current = false;
      reorderInFlightRef.current = true;
      const snapshotIds = orderedEntriesRef.current.map((e) => e.id);
      const capturedMove = lastMoveRef.current;

      try {
        const res = await itemEntriesReorder(
          itemId,
          { entry_ids: snapshotIds },
          { idempotencyKey: createIdempotencyKey() },
        );
        if (!pendingReorderDirtiedRef.current) {
          const posMap = new Map(res.entries.map((p) => [p.id, p.position]));
          queryClient.setQueryData<EntryMetaList | undefined>(
            contentQueryKeys.entries(itemId),
            (prev) => {
              if (!prev || !Array.isArray(prev.items)) return prev;
              const nextItems = prev.items
                .map((e) => ({
                  ...e,
                  position: posMap.get(e.id) ?? e.position,
                }))
                .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
              return { ...prev, items: nextItems };
            },
          );
        }
      } catch (err) {
        const classified = classifyContentMutationError(err);
        if (classified.kind === 'reorder_mismatch') {
          // 409 reorder_mismatch -> refetch list, re-apply last move once if both entries still exist, else show notice
          try {
            const freshList = await itemEntriesList(itemId, { limit: ITEM_MAX_ENTRIES });
            const freshSorted = sortEntriesByPosition(freshList.items ?? []);
            queryClient.setQueryData<EntryMetaList>(
              contentQueryKeys.entries(itemId),
              freshList,
            );

            if (allowMismatchRetry && capturedMove && !pendingReorderDirtiedRef.current) {
              const reapplied = applySingleMoveToEntries(freshSorted, capturedMove);
              if (reapplied) {
                setOrderedEntries(reapplied);
                orderedEntriesRef.current = reapplied;
                try {
                  const retryRes = await itemEntriesReorder(
                    itemId,
                    { entry_ids: reapplied.map((e) => e.id) },
                    { idempotencyKey: createIdempotencyKey() },
                  );
                  if (!pendingReorderDirtiedRef.current) {
                    const retryPosMap = new Map(
                      retryRes.entries.map((p) => [p.id, p.position]),
                    );
                    const committed = reapplied
                      .map((e) => ({
                        ...e,
                        position: retryPosMap.get(e.id) ?? e.position,
                      }))
                      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
                    setOrderedEntries(committed);
                    orderedEntriesRef.current = committed;
                    queryClient.setQueryData<EntryMetaList>(
                      contentQueryKeys.entries(itemId),
                      { ...freshList, items: committed },
                    );
                  }
                  return;
                } catch {
                  // Fall through to mismatch notice
                }
              }
            }

            if (!pendingReorderDirtiedRef.current) {
              setOrderedEntries(freshSorted);
              orderedEntriesRef.current = freshSorted;
              const mismatchMsg = tItem('reorderMismatchNotice');
              setReorderMismatchBanner(mismatchMsg);
              announce(mismatchMsg);
            }
          } catch {
            if (!pendingReorderDirtiedRef.current) {
              const mismatchMsg = tItem('reorderMismatchNotice');
              setReorderMismatchBanner(mismatchMsg);
              announce(mismatchMsg);
            }
          }
        } else if (!pendingReorderDirtiedRef.current) {
          const msg = translateContentError(classified.i18nKey);
          setReorderMismatchBanner(msg);
          announce(msg);
        }
      } finally {
        reorderInFlightRef.current = false;
        if (pendingReorderDirtiedRef.current) {
          clearTimeout(pendingReorderTimerRef.current);
          pendingReorderTimerRef.current = undefined;
          void flushPendingReorder(true);
        }
      }
    },
    [announce, itemId, queryClient, tItem, translateContentError],
  );

  const scheduleReorderFlush = useCallback(() => {
    pendingReorderDirtiedRef.current = true;
    clearTimeout(pendingReorderTimerRef.current);
    pendingReorderTimerRef.current = window.setTimeout(() => {
      pendingReorderTimerRef.current = undefined;
      void flushPendingReorder(true);
    }, REORDER_DEBOUNCE_MS);
  }, [flushPendingReorder]);

  // Flush pending reorder immediately on page leave (unmount / pagehide), visibilitychange, or before vault lock
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && pendingReorderDirtiedRef.current) {
        void flushPendingReorder(true);
      }
    };
    const handlePageHide = () => {
      if (pendingReorderDirtiedRef.current) {
        void flushPendingReorder(true);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);

    const unregisterLock = vault?.registerSecretFormReset
      ? vault.registerSecretFormReset(() => {
          if (pendingReorderDirtiedRef.current) {
            void flushPendingReorder(true);
          }
        })
      : undefined;

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      unregisterLock?.();
      if (pendingReorderDirtiedRef.current) {
        void flushPendingReorder(true);
      }
    };
  }, [flushPendingReorder, vault]);

  // Full metadata loaded check for enabling reorder
  const fullMetadataLoaded =
    entriesQuery.isSuccess &&
    !entriesQuery.isFetching &&
    (entriesQuery.data?.next_cursor === null ||
      entriesQuery.data?.next_cursor === undefined);
  const canReorder = fullMetadataLoaded && orderedEntries.length > 1;

  const handleMoveUp = useCallback(
    (entryId: string, restoreFocusEl?: HTMLElement | null) => {
      if (!canReorder) return;
      setReorderMismatchBanner(null);

      const current = orderedEntriesRef.current;
      const idx = current.findIndex((e) => e.id === entryId);
      if (idx <= 0) return;

      const targetEntry = current[idx - 1];
      const next = [...current];
      const [moved] = next.splice(idx, 1);
      next.splice(idx - 1, 0, moved);
      const reindexed = next.map((e, i) => ({ ...e, position: i }));

      lastMoveRef.current = {
        movedId: entryId,
        targetId: targetEntry.id,
        direction: 'up',
        targetIndex: idx - 1,
      };
      orderedEntriesRef.current = reindexed;
      setOrderedEntries(reindexed);

      announce(
        tItem('reorderMovedUp', {
          pos: idx,
          total: reindexed.length,
        }),
      );
      scheduleReorderFlush();

      if (restoreFocusEl) {
        queueMicrotask(() => {
          restoreFocusEl.focus();
        });
      }
    },
    [announce, canReorder, scheduleReorderFlush, tItem],
  );

  const handleMoveDown = useCallback(
    (entryId: string, restoreFocusEl?: HTMLElement | null) => {
      if (!canReorder) return;
      setReorderMismatchBanner(null);

      const current = orderedEntriesRef.current;
      const idx = current.findIndex((e) => e.id === entryId);
      if (idx < 0 || idx >= current.length - 1) return;

      const targetEntry = current[idx + 1];
      const next = [...current];
      const [moved] = next.splice(idx, 1);
      next.splice(idx + 1, 0, moved);
      const reindexed = next.map((e, i) => ({ ...e, position: i }));

      lastMoveRef.current = {
        movedId: entryId,
        targetId: targetEntry.id,
        direction: 'down',
        targetIndex: idx + 1,
      };
      orderedEntriesRef.current = reindexed;
      setOrderedEntries(reindexed);

      announce(
        tItem('reorderMovedDown', {
          pos: idx + 2,
          total: reindexed.length,
        }),
      );
      scheduleReorderFlush();

      if (restoreFocusEl) {
        queueMicrotask(() => {
          restoreFocusEl.focus();
        });
      }
    },
    [announce, canReorder, scheduleReorderFlush, tItem],
  );

  // Desktop drag and drop reorder
  const dragSourceIndexRef = useRef<number | null>(null);

  const handleDragStart = useCallback(
    (index: number, e: DragEvent<HTMLElement>) => {
      if (!canReorder) return;
      dragSourceIndexRef.current = index;
      try {
        e.dataTransfer?.setData('text/plain', String(index));
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
        }
      } catch {
        // Ignore in synthetic test environments without full DataTransfer
      }
    },
    [canReorder],
  );

  const handleDragOver = useCallback(
    (_index: number, e: DragEvent<HTMLElement>) => {
      if (!canReorder || dragSourceIndexRef.current === null) return;
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
    },
    [canReorder],
  );

  const handleDrop = useCallback(
    (targetIndex: number, e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      if (!canReorder) return;
      const fromIndex = dragSourceIndexRef.current;
      dragSourceIndexRef.current = null;
      if (fromIndex === null || fromIndex === targetIndex) return;

      const current = orderedEntriesRef.current;
      if (
        fromIndex < 0 ||
        fromIndex >= current.length ||
        targetIndex < 0 ||
        targetIndex >= current.length
      ) {
        return;
      }

      const movedEntry = current[fromIndex];
      const targetEntry = current[targetIndex];
      const next = [...current];
      const [removed] = next.splice(fromIndex, 1);
      next.splice(targetIndex, 0, removed);
      const reindexed = next.map((item, i) => ({ ...item, position: i }));

      lastMoveRef.current = {
        movedId: movedEntry.id,
        targetId: targetEntry.id,
        direction: 'drag',
        targetIndex,
      };
      orderedEntriesRef.current = reindexed;
      setOrderedEntries(reindexed);

      announce(
        tItem('reorderMovedTo', {
          pos: targetIndex + 1,
          total: reindexed.length,
        }),
      );
      scheduleReorderFlush();
    },
    [announce, canReorder, scheduleReorderFlush, tItem],
  );

  const handleDragEnd = useCallback(() => {
    dragSourceIndexRef.current = null;
  }, []);

  // Delete entry + Undo toast + focus management (plan Task 15 item 4)
  const handleDeleteEntry = useCallback(
    async (entry: EntryMeta, index: number) => {
      // Flush any pending reorder before deleting
      if (pendingReorderDirtiedRef.current) {
        await flushPendingReorder(false);
      }

      const current = orderedEntriesRef.current;
      const nextNeighbor = current[index + 1] ?? current[index - 1] ?? null;
      const nextList = current.filter((e) => e.id !== entry.id);

      orderedEntriesRef.current = nextList;
      setOrderedEntries(nextList);

      // Update query caches
      queryClient.removeQueries({ queryKey: vaultBodyQueryKey(entry.id) });
      queryClient.setQueryData<EntryMetaList | undefined>(
        contentQueryKeys.entries(itemId),
        (prev) =>
          prev
            ? {
                ...prev,
                items: (prev.items ?? []).filter((e) => e.id !== entry.id),
              }
            : prev,
      );
      queryClient.setQueryData<ItemSummary | undefined>(
        contentQueryKeys.item(itemId),
        (prev) =>
          prev
            ? { ...prev, entry_count: Math.max(0, prev.entry_count - 1) }
            : prev,
      );

      // Focus next card (or previous if last, or "+ Text" button if empty)
      if (nextNeighbor) {
        focusEntryCard(nextNeighbor.id);
      } else {
        addTextBtnRef.current?.focus();
      }

      try {
        await entryDelete(entry.id, {
          idempotencyKey: createIdempotencyKey(),
        });

        undoToast?.pushUndoToast({
          message: tEntry('deletedToast'),
          actionLabel: tItem('undoAction'),
          returnFocusTo: () =>
            cardElementsRef.current.get(entry.id) ?? addTextBtnRef.current,
          onUndo: async () => {
            const restored = await entryRestore(entry.id, {
              idempotencyKey: createIdempotencyKey(),
            });

            // Re-insert restored entry at its restored position, shifting live rows with position >= restored.position by +1 (advisor-dec-160)
            const cur = orderedEntriesRef.current.filter((e) => e.id !== restored.id);
            const hasCollision = cur.some((e) => e.position === restored.position);
            const shifted = hasCollision
              ? cur.map((e) =>
                  e.position >= restored.position
                    ? { ...e, position: e.position + 1 }
                    : e,
                )
              : cur;
            const withRestored = sortEntriesByPosition([...shifted, restored]);

            orderedEntriesRef.current = withRestored;
            setOrderedEntries(withRestored);

            queryClient.setQueryData<EntryMetaList | undefined>(
              contentQueryKeys.entries(itemId),
              (prev) => ({
                items: withRestored,
                next_cursor: prev?.next_cursor ?? null,
              }),
            );
            queryClient.setQueryData<ItemSummary | undefined>(
              contentQueryKeys.item(itemId),
              (prev) =>
                prev ? { ...prev, entry_count: prev.entry_count + 1 } : prev,
            );

            // Ensure batch window includes the restored card
            const restoredIdx = withRestored.findIndex((e) => e.id === restored.id);
            if (restoredIdx >= visibleBatchCount) {
              setVisibleBatchCount(restoredIdx + 1);
            }

            announce(tEntry('restoredNotice'));
            focusEntryCard(restored.id);
          },
        });
      } catch (err) {
        // Restore local state on delete failure
        void entriesQuery.refetch();
        void itemQuery.refetch();
        const classified = classifyContentMutationError(err);
        announce(translateContentError(classified.i18nKey));
      }
    },
    [
      announce,
      entriesQuery,
      flushPendingReorder,
      focusEntryCard,
      itemId,
      itemQuery,
      queryClient,
      tEntry,
      tItem,
      translateContentError,
      undoToast,
      visibleBatchCount,
    ],
  );

  // Add new text entry state
  const [creatingText, setCreatingText] = useState(false);
  const [creatingJson, setCreatingJson] = useState(false);
  const [importJsonOpen, setImportJsonOpen] = useState(false);

  useEffect(() => {
    if (!unlocked) {
      if (creatingText) setCreatingText(false);
      if (creatingJson) setCreatingJson(false);
      if (importJsonOpen) setImportJsonOpen(false);
    }
  }, [creatingJson, creatingText, importJsonOpen, unlocked]);

  const handleCancelCreatingText = useCallback(() => {
    setCreatingText(false);
    queueMicrotask(() => {
      addTextBtnRef.current?.focus();
    });
  }, []);

  const handleCancelCreatingJson = useCallback(() => {
    setCreatingJson(false);
    queueMicrotask(() => {
      addJsonBtnRef.current?.focus();
    });
  }, []);

  const handleCreatedEntry = useCallback(
    (created: EntryMeta) => {
      setCreatingText(false);
      setCreatingJson(false);
      setImportJsonOpen(false);
      const nextList = sortEntriesByPosition([
        ...orderedEntriesRef.current.filter((e) => e.id !== created.id),
        created,
      ]);
      orderedEntriesRef.current = nextList;
      setOrderedEntries(nextList);

      queryClient.setQueryData<ItemSummary | undefined>(
        contentQueryKeys.item(itemId),
        (prev) =>
          prev ? { ...prev, entry_count: prev.entry_count + 1 } : prev,
      );

      if (nextList.length > visibleBatchCount) {
        setVisibleBatchCount(nextList.length);
      }

      focusEntryCard(created.id);
    },
    [focusEntryCard, itemId, queryClient, visibleBatchCount],
  );

  // Delete entire item + Undo toast
  const handleDeleteItem = useCallback(async () => {
    const currentItem = itemQuery.data;
    if (!currentItem) return;

    try {
      await itemDelete(currentItem.id, {
        idempotencyKey: createIdempotencyKey(),
      });
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.itemsAll() });

      undoToast?.pushUndoToast({
        message: tItem('itemDeletedToast', { name: currentItem.name }),
        actionLabel: tItem('undoAction'),
        onUndo: async () => {
          const restored = await itemRestore(currentItem.id, {
            idempotencyKey: createIdempotencyKey(),
          });
          queryClient.setQueryData(contentQueryKeys.item(currentItem.id), restored);
          void queryClient.invalidateQueries({
            queryKey: contentQueryKeys.entries(currentItem.id),
          });
          void queryClient.invalidateQueries({
            queryKey: contentQueryKeys.itemsAll(),
          });
          router.push(`/app/items/${encodeURIComponent(currentItem.id)}`);
        },
      });

      router.push('/app');
    } catch (err) {
      const classified = classifyContentMutationError(err);
      announce(translateContentError(classified.i18nKey));
    }
  }, [announce, itemQuery.data, queryClient, router, tItem, translateContentError, undoToast]);

  // Determine 404 state
  const isItemNotFound = useMemo(() => {
    if (!itemQuery.isError) return false;
    const classified = classifyContentMutationError(itemQuery.error);
    return classified.kind === 'not_found' || classified.status === 404;
  }, [itemQuery.error, itemQuery.isError]);

  const totalEntriesCount = orderedEntries.length || (itemQuery.data?.entry_count ?? 0);
  const atEntryLimit = totalEntriesCount >= ITEM_MAX_ENTRIES;
  const visibleEntries = useMemo(
    () => orderedEntries.slice(0, visibleBatchCount),
    [orderedEntries, visibleBatchCount],
  );

  return (
    <>
      <AppHeader showSearch />
      <LockedBanner />

      <main className="mx-auto max-w-container px-5 pb-28 pt-8">
        {/* Live region for saving / saved / error / reorder announcements */}
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="item-page-live-region"
          className="sr-only"
        >
          {liveMessage}
        </div>

        {/* Unconfirmed save notice from a prior session boundary (SPEC §3.4, §3.7, advisor-dec-120) */}
        {unconfirmedNotices.map((notice) => (
          <div
            key={`${notice.source}-${notice.itemId}`}
            role="status"
            data-testid="entry-save-unconfirmed-banner"
            className="auth-status mb-4 flex flex-wrap items-center justify-between gap-2"
          >
            <span>{tEntry('saveUnconfirmed', { name: notice.itemName })}</span>
            <button
              type="button"
              data-testid="entry-save-unconfirmed-dismiss"
              className="btn btn-tertiary btn-sm"
              onClick={() => {
                if (me?.user?.id) {
                  dismissUnconfirmedSave({
                    userId: me.user.id,
                    itemId: notice.itemId,
                  });
                }
              }}
            >
              {tEntry('dismissNotice')}
            </button>
          </div>
        ))}

        {/* Draft cleared on lock notice (Q15: shown after unlock) */}
        {unlocked && showDraftClearedNotice ? (
          <div
            role="status"
            data-testid="draft-cleared-on-lock-banner"
            className="auth-status mb-4 flex flex-wrap items-center justify-between gap-2"
          >
            <span>{tEntry('draftClearedOnLock')}</span>
            <button
              type="button"
              data-testid="draft-cleared-on-lock-dismiss"
              className="btn btn-tertiary btn-sm"
              onClick={() => setShowDraftClearedNotice(false)}
            >
              {tEntry('dismissNotice')}
            </button>
          </div>
        ) : null}

        {/* Reorder mismatch banner */}
        {reorderMismatchBanner ? (
          <div
            role="alert"
            data-testid="reorder-mismatch-banner"
            className="auth-alert mb-4 flex flex-wrap items-center justify-between gap-2"
          >
            <span>{reorderMismatchBanner}</span>
            <button
              type="button"
              className="btn btn-tertiary btn-sm"
              onClick={() => setReorderMismatchBanner(null)}
            >
              {tEntry('dismissNotice')}
            </button>
          </div>
        ) : null}

        {isItemNotFound ? (
          <div className="card p-6" data-testid="item-not-found">
            <h1 className="t-title-sm mb-2 text-ink">{tItem('notFoundTitle')}</h1>
            <p className="t-body mb-4 text-muted">{tItem('notFoundBody')}</p>
            <Link
              href="/app"
              data-testid="item-not-found-back"
              className="btn btn-tertiary btn-sm no-underline"
            >
              {tItem('backToList')}
            </Link>
          </div>
        ) : itemQuery.isError ? (
          <div className="card card-error p-6" role="alert" data-testid="item-load-error">
            <h1 className="t-title-sm mb-2 text-ink">{tItem('loadErrorTitle')}</h1>
            <p className="t-body mb-4 text-muted">{tItem('loadErrorBody')}</p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                void itemQuery.refetch();
              }}
            >
              {tItem('retry')}
            </button>
          </div>
        ) : itemQuery.isPending || !itemQuery.data ? (
          <div className="card p-6" role="status" data-testid="item-loading">
            <p className="t-body m-0 text-muted">{tItem('loading')}</p>
          </div>
        ) : (
          <>
            <ItemHeader
              item={itemQuery.data}
              entryCount={totalEntriesCount}
              onAnnounce={announce}
            />

            {/* Entry composer toolbar: "+ Text", "+ JSON / table", and "Import JSON…" */}
            <div
              id="entry-composer"
              data-testid="entry-composer"
              className="mb-5 flex flex-wrap items-center gap-2"
            >
              <button
                ref={addTextBtnRef}
                type="button"
                id="btn-add-text"
                data-testid="btn-add-text"
                className="btn btn-primary btn-sm"
                disabled={atEntryLimit || !unlocked || !entriesQuery.isSuccess}
                title={atEntryLimit ? tItem('entryLimitHint') : undefined}
                aria-describedby={atEntryLimit ? 'entry-limit-hint' : undefined}
                onClick={() => {
                  if (atEntryLimit || !unlocked || !entriesQuery.isSuccess) return;
                  setCreatingJson(false);
                  setCreatingText(true);
                }}
              >
                {tItem('addTextCta')}
              </button>

              <button
                ref={addJsonBtnRef}
                type="button"
                id="btn-add-json"
                data-testid="btn-add-json"
                className="btn btn-secondary btn-sm"
                disabled={atEntryLimit || !unlocked || !entriesQuery.isSuccess}
                title={atEntryLimit ? tItem('entryLimitHint') : undefined}
                aria-describedby={atEntryLimit ? 'entry-limit-hint' : undefined}
                onClick={() => {
                  if (atEntryLimit || !unlocked || !entriesQuery.isSuccess) return;
                  setCreatingText(false);
                  setCreatingJson(true);
                }}
              >
                {tJson('addJsonCta')}
              </button>

              <button
                ref={importJsonBtnRef}
                type="button"
                id="btn-import-json"
                data-testid="btn-import-json"
                className="btn btn-tertiary btn-sm"
                disabled={atEntryLimit || !unlocked || !entriesQuery.isSuccess}
                title={atEntryLimit ? tItem('entryLimitHint') : undefined}
                aria-describedby={atEntryLimit ? 'entry-limit-hint' : undefined}
                onClick={() => {
                  if (atEntryLimit || !unlocked || !entriesQuery.isSuccess) return;
                  setImportJsonOpen(true);
                }}
              >
                {tJson('importJsonCta')}
              </button>

              <button
                type="button"
                id="btn-delete-item"
                data-testid="btn-delete-item"
                className="btn btn-danger btn-sm ml-auto"
                onClick={() => {
                  void handleDeleteItem();
                }}
              >
                {tItem('deleteItemCta')}
              </button>
            </div>

            {atEntryLimit ? (
              <p
                id="entry-limit-hint"
                data-testid="entry-limit-hint"
                className="m-0 mb-5 text-[13px] text-muted"
              >
                {tItem('entryLimitHint')}
              </p>
            ) : null}

            <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_248px]">
              <div
                id="entry-card-list"
                data-testid="entry-card-list"
                className="flex min-w-0 flex-col gap-3"
              >
                {creatingText && unlocked ? (
                  <NewTextEntryComposer
                    itemId={itemId}
                    itemName={itemQuery.data.name}
                    onSaved={handleCreatedEntry}
                    onCancel={handleCancelCreatingText}
                    onAnnounce={announce}
                    onDraftClearedOnLock={handleDraftClearedOnLock}
                  />
                ) : null}

                {creatingJson && unlocked ? (
                  <NewJsonEntryComposer
                    itemId={itemId}
                    itemName={itemQuery.data.name}
                    onSaved={handleCreatedEntry}
                    onCancel={handleCancelCreatingJson}
                    onAnnounce={announce}
                    onDraftClearedOnLock={handleDraftClearedOnLock}
                  />
                ) : null}


                {entriesQuery.isError ? (
                  <div
                    className="card card-error p-6"
                    role="alert"
                    data-testid="item-entries-load-error"
                  >
                    <h2 className="t-title-sm mb-2 text-ink">{tItem('loadErrorTitle')}</h2>
                    <p className="t-body mb-4 text-muted">
                      {translateContentError(
                        classifyContentMutationError(entriesQuery.error).i18nKey,
                      )}
                    </p>
                    <button
                      type="button"
                      data-testid="item-entries-retry-btn"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        void entriesQuery.refetch();
                      }}
                    >
                      {tItem('retry')}
                    </button>
                  </div>
                ) : entriesQuery.isPending && orderedEntries.length === 0 ? (
                  <div className="card p-6" role="status" data-testid="item-entries-loading">
                    <p className="t-body m-0 text-muted">{tItem('loading')}</p>
                  </div>
                ) : null}
                {orderedEntries.length === 0 &&
                !creatingText &&
                !creatingJson &&
                entriesQuery.isSuccess ? (
                  <div className="card p-6 text-center" data-testid="item-entries-empty">
                    <h2 className="t-title-sm mb-2 text-ink">{tItem('emptyTitle')}</h2>
                    <p className="t-body mb-4 text-muted">{tItem('emptyBody')}</p>
                    {unlocked && !atEntryLimit ? (
                      <div className="flex flex-wrap justify-center gap-2">
                        <button
                          type="button"
                          data-testid="empty-add-text-btn"
                          className="btn btn-primary btn-sm"
                          onClick={() => {
                            setCreatingJson(false);
                            setCreatingText(true);
                          }}
                        >
                          {tItem('emptyAddTextCta')}
                        </button>
                        <button
                          type="button"
                          data-testid="empty-add-json-btn"
                          className="btn btn-secondary btn-sm"
                          onClick={() => {
                            setCreatingText(false);
                            setCreatingJson(true);
                          }}
                        >
                          {tJson('addJsonCta')}
                        </button>
                        <button
                          type="button"
                          data-testid="empty-import-json-btn"
                          className="btn btn-tertiary btn-sm"
                          onClick={() => {
                            setImportJsonOpen(true);
                          }}
                        >
                          {tJson('importJsonCta')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {visibleEntries.map((entry, idx) =>
                  entry.type === 'json' ? (
                    <JsonEntryCard
                      key={entry.id}
                      entry={entry}
                      itemId={itemId}
                      itemName={itemQuery.data.name}
                      index={idx}
                      total={orderedEntries.length}
                      canReorder={canReorder}
                      load={load}
                      lazy={lazyCards}
                      onMoveUp={handleMoveUp}
                      onMoveDown={handleMoveDown}
                      onDelete={handleDeleteEntry}
                      onDragStart={handleDragStart}
                      onDragOver={handleDragOver}
                      onDrop={handleDrop}
                      onDragEnd={handleDragEnd}
                      onAnnounce={announce}
                      onDraftClearedOnLock={handleDraftClearedOnLock}
                      registerCardElement={registerCardElement}
                    />
                  ) : (
                    <TextEntryCard
                      key={entry.id}
                      entry={entry}
                      itemId={itemId}
                      itemName={itemQuery.data.name}
                      index={idx}
                      total={orderedEntries.length}
                      canReorder={canReorder}
                      load={load}
                      lazy={lazyCards}
                      onMoveUp={handleMoveUp}
                      onMoveDown={handleMoveDown}
                      onDelete={handleDeleteEntry}
                      onDragStart={handleDragStart}
                      onDragOver={handleDragOver}
                      onDrop={handleDrop}
                      onDragEnd={handleDragEnd}
                      onAnnounce={announce}
                      onDraftClearedOnLock={handleDraftClearedOnLock}
                      registerCardElement={registerCardElement}
                    />
                  ),
                )}

                {visibleBatchCount < orderedEntries.length ? (
                  <div
                    ref={sentinelRef}
                    data-testid="entries-batch-sentinel"
                    className="flex justify-center py-3"
                  >
                    <button
                      type="button"
                      data-testid="entries-load-more-btn"
                      className="btn btn-tertiary btn-sm"
                      onClick={() =>
                        setVisibleBatchCount((prev) =>
                          Math.min(
                            orderedEntries.length,
                            prev + ENTRIES_RENDER_BATCH_SIZE,
                          ),
                        )
                      }
                    >
                      {tItem('loadMoreEntries', {
                        shown: visibleEntries.length,
                        total: orderedEntries.length,
                      })}
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Shortcuts sidebar (mockups/item.html) */}
              <aside className="flex min-w-0 flex-col gap-4">
                <div className="card p-4" data-testid="item-shortcuts-panel">
                  <p className="t-label mb-2 text-body">{tItem('shortcutsTitle')}</p>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px] text-body">
                    <li className="flex items-center justify-between gap-2">
                      <span>{tItem('shortcutSave')}</span>
                      <span className="kbd">Ctrl+S</span>
                    </li>
                    <li className="flex items-center justify-between gap-2">
                      <span>{tItem('shortcutCancel')}</span>
                      <span className="kbd">Esc</span>
                    </li>
                    <li className="flex items-center justify-between gap-2">
                      <span>{tItem('shortcutUndo')}</span>
                      <span className="kbd">Ctrl+Z</span>
                    </li>
                    <li className="flex items-center justify-between gap-2">
                      <span>{tItem('shortcutLock')}</span>
                      <span className="kbd">L</span>
                    </li>
                  </ul>
                </div>
              </aside>
            </div>

            <ImportJsonDialog
              open={importJsonOpen}
              itemId={itemId}
              itemName={itemQuery.data.name}
              isCurrentItem
              entryCount={totalEntriesCount}
              onClose={() => setImportJsonOpen(false)}
              onSaved={(created) => handleCreatedEntry(created)}
              onAnnounce={announce}
              onDraftClearedOnLock={handleDraftClearedOnLock}
              restoreFocusRef={importJsonBtnRef}
            />
          </>
        )}
      </main>
    </>
  );
}
