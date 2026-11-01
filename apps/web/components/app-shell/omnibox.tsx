'use client';

import {
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Kbd } from '@/components/ui/kbd';
import { useOptionalUndoToast } from '@/components/ui/undo-toast';
import { unlockUrl } from '@/features/auth/guard-redirect';
import { EntrySealError } from '@/features/entries/seal';
import { getVaultSecretInputProps } from '@/features/entries/secret-input-props';
import {
  CONTENT_ENTRIES_QUERY_KEY_PREFIX,
  CONTENT_ITEMS_QUERY_KEY_PREFIX,
  CONTENT_ITEM_QUERY_KEY_PREFIX,
  CONTENT_LOOKUP_QUERY_KEY_PREFIX,
  CONTENT_TAGS_QUERY_KEY_PREFIX,
  contentQueryKeys,
  type ContentItemsQueryKey,
} from '@/features/items/query-keys';
import {
  DupPickerDialog,
  type DupPickerSelection,
} from '@/features/omnibox/dup-picker-dialog';
import { trimUnicodeWhiteSpace } from '@/features/omnibox/normalize';
import { parseQuickAdd, type QuickAddParseResult } from '@/features/omnibox/quick-add-parse';
import {
  checkTargetTagCap,
  createQuickAddSavePlan,
  executeQuickAddSavePlan,
  hasPlanCommittedMetadata,
  type QuickAddSavePlan,
  type SavePlanStepKey,
  type SavePlanStepStatus,
} from '@/features/omnibox/save-plan';
import {
  filterCachedTagsByPrefix,
  parseTagFilterInput,
  splitMarkedPrefix,
} from '@/features/omnibox/search-helpers';
import {
  clearLockClearedNotice,
  clearSaveUnconfirmed,
  getLockClearedNoticeSnapshot,
  getSaveUnconfirmedSnapshot,
  reconcileLockClearedNoticeUser,
  reconcileSaveUnconfirmedUser,
  recordLockClearedNotice,
  recordSaveUnconfirmed,
  subscribeLockClearedNotice,
  subscribeSaveUnconfirmed,
} from '@/features/omnibox/unconfirmed-save-store';
import { getKnownDeviceSessionUserId } from '@/features/vault/device-store';
import { useOptionalVault } from '@/features/vault/vault-provider';
import {
  createIdempotencyKey,
  entryDelete,
  getContentErrorI18nKey,
  itemCreate,
  itemDelete,
  itemsList,
  itemsLookupExact,
  tagsList,
  type ContentErrorCode,
  type ItemList,
  type ItemSummary,
  type Tag,
  type TagList,
} from '@/lib/api/content';
import { type Me } from '@/lib/api/auth';
import { subscribeSessionBroadcast } from '@/lib/auth/broadcast';
import { cn } from '@/lib/cn';

const MAX_TEXTAREA_HEIGHT_PX = 132;
const MAX_VISIBLE_OPTION_TAG_CHIPS = 3;

export type OmniboxOption =
  | {
      readonly id: string;
      readonly kind: 'item';
      readonly item: ItemSummary;
      readonly query: string;
    }
  | {
      readonly id: string;
      readonly kind: 'create';
      readonly query: string;
    }
  | {
      readonly id: string;
      readonly kind: 'tag';
      readonly tag: Tag;
      readonly query: string;
    };

interface DupPickerModalState {
  readonly name: string;
  readonly tags: readonly string[];
  readonly initialItems: readonly ItemSummary[];
  readonly total: number;
  readonly nextCursor: string | null;
}

function SearchIcon({ compact }: { readonly compact: boolean }) {
  return (
    <svg
      width={compact ? 18 : 20}
      height={compact ? 18 : 20}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <circle cx="8.5" cy="8.5" r="5.5" stroke="var(--muted)" strokeWidth="1.8" />
      <path d="M12.8 12.8 17 17" stroke="var(--muted)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function MarkedPrefixText({ text, query }: { readonly text: string; readonly query: string }) {
  const parts = splitMarkedPrefix(text, query);
  return (
    <>
      {parts.before}
      {parts.match ? <mark>{parts.match}</mark> : null}
      {parts.after}
    </>
  );
}

function isImeComposing(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  const native = event.nativeEvent;
  const isComposing = 'isComposing' in native && Boolean(native.isComposing);
  const keyCode = 'keyCode' in native ? native.keyCode : undefined;
  return isComposing || keyCode === 229;
}

/**
 * Checks whether a query key in `QueryCache` is an omnibox search or lookup key:
 * - `['content', 'items', { q }]` where `q` is a non-empty string
 * - `['content', 'tags', { q }]` where `q` is a non-empty string
 * - `['content', 'lookup', name]`
 */
function isOmniboxSearchQueryKey(queryKey: readonly unknown[]): boolean {
  if (queryKey.length < 2 || queryKey[0] !== 'content') {
    return false;
  }
  const kind = queryKey[1];
  if (kind === 'lookup') {
    return true;
  }
  if (queryKey.length < 3 || (kind !== 'items' && kind !== 'tags')) {
    return false;
  }
  const params = queryKey[2];
  if (typeof params !== 'object' || params === null || !('q' in params)) {
    return false;
  }
  const qVal = params.q;
  return typeof qVal === 'string' && qVal.length > 0;
}

export function Omnibox({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const tOmni = useTranslations('content.omnibox');
  const tPrivacy = useTranslations('content.privacy');
  const tErrors = useTranslations('content.errors');
  const router = useRouter();
  const pathname = usePathname() ?? '/app';
  const queryClient = useContext(QueryClientContext);
  const vault = useOptionalVault();
  const undoToast = useOptionalUndoToast();

  const reactId = useId().replace(/:/g, '');
  const baseId = compact ? `omni-compact-${reactId}` : 'omni';
  const popId = `${baseId}-pop`;
  const listboxId = `${baseId}-listbox`;
  const hintId = `${baseId}-hint`;
  const liveId = `${baseId}-live`;
  const guardAlertId = `${baseId}-guard-alert`;
  const emptyBoxId = `${baseId}-search-empty`;
  const lockClearedNoticeId = `${baseId}-lock-cleared-notice`;
  const saveUnconfirmedNoticeId = `${baseId}-save-unconfirmed-notice`;
  const addPreviewId = `${baseId}-add-preview`;
  const addErrorId = `${baseId}-add-error`;
  const addPrivacyId = `${baseId}-add-privacy`;
  const jsonBannerId = `${baseId}-json-banner`;
  const savePlanId = `${baseId}-save-plan`;
  const planErrorId = `${baseId}-plan-error`;
  const unlockToSaveBtnId = `${baseId}-unlock-to-save-btn`;

  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const retryPlanBtnRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Record<string, HTMLElement | null>>({});
  const searchAbortRef = useRef<AbortController | null>(null);
  const planAbortRef = useRef<AbortController | null>(null);
  const createPendingRef = useRef(false);
  const createAbortRef = useRef<AbortController | null>(null);
  const lookupPendingRef = useRef(false);
  const inputValueRef = useRef('');
  const activePlanRef = useRef<QuickAddSavePlan | null>(null);
  const submittedDraftRef = useRef<string | null>(null);
  const activeUserIdRef = useRef<string | null>(null);
  const hadDupPickerOpenRef = useRef(false);
  const [inputValue, setInputValue] = useState('');
  inputValueRef.current = inputValue;

  const [listOpen, setListOpen] = useState(false);
  const [listKind, setListKind] = useState<'search' | 'tag-filter' | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [liveMessage, setLiveMessage] = useState('');
  const [guardKind, setGuardKind] = useState<'search' | 'tag' | null>(null);
  const [actionErrorCode, setActionErrorCode] = useState<ContentErrorCode | null>(null);

  const [searchResults, setSearchResults] = useState<{
    readonly query: string;
    readonly items: readonly ItemSummary[];
  } | null>(null);

  const [tagFilterState, setTagFilterState] = useState<{
    readonly token: string;
    readonly tags: readonly Tag[];
    readonly fromServer: boolean;
  } | null>(null);

  // 18b quick-add state
  const [activePlan, setActivePlan] = useState<QuickAddSavePlan | null>(null);
  activePlanRef.current = activePlan;
  const [, setPlanRenderTick] = useState(0);
  const [targetTagLimitCount, setTargetTagLimitCount] = useState<number | null>(null);
  const [dupPickerState, setDupPickerState] = useState<DupPickerModalState | null>(null);
  const unconfirmedSnapshot = useSyncExternalStore(
    subscribeSaveUnconfirmed,
    getSaveUnconfirmedSnapshot,
    () => null,
  );

  const lockNoticeSnapshot = useSyncExternalStore(
    subscribeLockClearedNotice,
    getLockClearedNoticeSnapshot,
    () => null,
  );

  const isVaultUnlocked = vault ? vault.state === 'unlocked' : true;
  const isVaultLocked = !isVaultUnlocked;

  // Resolve active user ID from QueryClient's `['auth', 'me', ...]` cache or `getKnownDeviceSessionUserId()`.
  // Never fall back to a shared constant (advisor-dec-120, HM18B-R1-5).
  const activeUserId = ((): string | null => {
    if (queryClient) {
      const meQueries = queryClient.getQueriesData<Me | null>({ queryKey: ['auth', 'me'] });
      for (let i = meQueries.length - 1; i >= 0; i -= 1) {
        const data = meQueries[i]?.[1];
        if (data?.user?.id) {
          return data.user.id;
        }
      }
    }
    return getKnownDeviceSessionUserId() ?? null;
  })();
  activeUserIdRef.current = activeUserId;

  useEffect(() => {
    reconcileSaveUnconfirmedUser(activeUserId);
    reconcileLockClearedNoticeUser(activeUserId);
  }, [activeUserId]);

  useEffect(() => {
    return subscribeSessionBroadcast((message) => {
      if (message.type === 'signed_out') {
        clearLockClearedNotice();
        if (!message.reason || message.reason === 'logout') {
          clearSaveUnconfirmed();
        }
      }
    });
  }, []);

  const visibleUnconfirmedRecord =
    isVaultUnlocked &&
    activeUserId !== null &&
    unconfirmedSnapshot?.userId === activeUserId
      ? unconfirmedSnapshot
      : null;

  const visibleLockClearedNoticeKind =
    isVaultUnlocked &&
    lockNoticeSnapshot !== null &&
    (lockNoticeSnapshot.userId === null || lockNoticeSnapshot.userId === activeUserId)
      ? lockNoticeSnapshot.kind
      : null;
  const parsed = useMemo(() => parseQuickAdd(inputValue), [inputValue]);
  const trimmedInput = useMemo(() => trimUnicodeWhiteSpace(inputValue), [inputValue]);
  const hasNonEmptyInput = trimmedInput.length > 0;

  // Restore focus to the omnibox textarea after the U9 duplicate picker dialog closes and unmounts (HM18B-R1-2).
  useEffect(() => {
    if (dupPickerState !== null) {
      hadDupPickerOpenRef.current = true;
      return;
    }
    if (!hadDupPickerOpenRef.current) {
      return;
    }
    hadDupPickerOpenRef.current = false;
    textareaRef.current?.focus();
    const rafId = requestAnimationFrame(() => {
      if (
        document.activeElement === document.body ||
        document.activeElement === null ||
        document.activeElement === textareaRef.current
      ) {
        textareaRef.current?.focus();
      }
    });
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [dupPickerState]);
  // Read cached tags from the rail's `['content', 'tags', ...]` cache without firing any network request.
  const getCachedTags = useCallback((): Tag[] => {
    if (!queryClient) return [];
    const exactRecent = queryClient.getQueryData<TagList>(
      contentQueryKeys.tags({ sort: 'recent' }),
    );
    if (exactRecent?.items) {
      return [...exactRecent.items];
    }
    const queries = queryClient.getQueriesData<TagList>({
      queryKey: CONTENT_TAGS_QUERY_KEY_PREFIX,
    });
    const seen = new Set<string>();
    const collected: Tag[] = [];
    for (const [, data] of queries) {
      if (!data?.items) continue;
      for (const tag of data.items) {
        if (!seen.has(tag.id)) {
          seen.add(tag.id);
          collected.push(tag);
        }
      }
    }
    return collected;
  }, [queryClient]);

  const syncTextareaHeight = useCallback((el?: HTMLTextAreaElement | null) => {
    const target = el ?? textareaRef.current;
    if (!target) return;
    if (!target.value) {
      target.style.height = '';
      target.style.overflowY = 'hidden';
      return;
    }
    target.style.height = 'auto';
    const sh = target.scrollHeight;
    if (sh > 0) {
      target.style.height = `${Math.min(sh, MAX_TEXTAREA_HEIGHT_PX)}px`;
      target.style.overflowY = sh > MAX_TEXTAREA_HEIGHT_PX ? 'auto' : 'hidden';
    }
  }, []);

  const closeListbox = useCallback((clearLive: boolean) => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setListOpen(false);
    setListKind(null);
    setActiveIndex(-1);
    setSearchResults(null);
    setTagFilterState(null);
    if (clearLive) {
      setLiveMessage('');
    }
  }, []);

  const removeOmniboxSearchQueries = useCallback(() => {
    if (!queryClient) return;
    queryClient.removeQueries({
      predicate: (query) => isOmniboxSearchQueryKey(query.queryKey),
    });
  }, [queryClient]);

  const abortAndClearSavePlan = useCallback(() => {
    planAbortRef.current?.abort();
    planAbortRef.current = null;
    if (activePlanRef.current) {
      activePlanRef.current.op.dispose?.();
      activePlanRef.current = null;
    }
    setActivePlan(null);
    setTargetTagLimitCount(null);
    setDupPickerState(null);
    submittedDraftRef.current = null;
    lookupPendingRef.current = false;
  }, []);

  // Register synchronous vault lock / logout / user-switch / reset cleanup (plan §2.10, §2.11 step 5, P4FE1-12, P4FE3-5, P4FE4-8).
  useEffect(() => {
    if (!vault?.registerSecretFormReset) return;
    return vault.registerSecretFormReset(() => {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      createAbortRef.current?.abort();
      createAbortRef.current = null;
      createPendingRef.current = false;
      planAbortRef.current?.abort();
      planAbortRef.current = null;

      const currentText = trimUnicodeWhiteSpace(
        textareaRef.current?.value ?? inputValueRef.current,
      );
      const currentPlan = activePlanRef.current;
      const hadDraftOrPlan = currentText.length > 0 || currentPlan !== null;
      const hadCommittedMeta = hasPlanCommittedMetadata(currentPlan);

      if (currentPlan) {
        currentPlan.op.dispose?.();
        activePlanRef.current = null;
      }

      if (hadDraftOrPlan) {
        recordLockClearedNotice({
          userId: activeUserIdRef.current,
          kind: hadCommittedMeta ? 'plan' : 'draft',
        });
      }
      if (textareaRef.current) {
        textareaRef.current.value = '';
        textareaRef.current.style.height = '';
        textareaRef.current.style.overflowY = 'hidden';
      }
      inputValueRef.current = '';
      setInputValue('');
      setListOpen(false);
      setListKind(null);
      setActiveIndex(-1);
      setSearchResults(null);
      setTagFilterState(null);
      setLiveMessage('');
      setGuardKind(null);
      setActionErrorCode(null);
      setActivePlan(null);
      setTargetTagLimitCount(null);
      setDupPickerState(null);
      submittedDraftRef.current = null;
      lookupPendingRef.current = false;
      undoToast?.clearOmniboxJustCleared();
      removeOmniboxSearchQueries();
    });
  }, [removeOmniboxSearchQueries, undoToast, vault]);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
      createAbortRef.current?.abort();
      planAbortRef.current?.abort();
    };
  }, []);

  // Global keyboard shortcuts (`Ctrl+K` / `⌘K` and `/` when focus is not in an input/textarea) + outside click.
  useEffect(() => {
    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      const key = event.key ?? '';
      const isCtrlK = (event.ctrlKey || event.metaKey) && key.toLowerCase() === 'k';
      const activeTag = (document.activeElement as HTMLElement | null)?.tagName ?? '';
      const isEditable =
        activeTag === 'INPUT' ||
        activeTag === 'TEXTAREA' ||
        activeTag === 'SELECT' ||
        Boolean((document.activeElement as HTMLElement | null)?.isContentEditable);
      const isSlashShortcut =
        key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isEditable;

      if (isCtrlK || isSlashShortcut) {
        // When both main and compact omniboxes exist on a page, let the primary visible one win.
        if (compact && document.getElementById('omni')) {
          return;
        }
        event.preventDefault();
        textareaRef.current?.focus();
        textareaRef.current?.select();
      }
    };

    const handleOutsideMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        closeListbox(false);
      }
    };

    const handleResize = () => {
      syncTextareaHeight();
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    document.addEventListener('mousedown', handleOutsideMouseDown);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown);
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [closeListbox, compact, syncTextareaHeight]);

  // Build the active options list for the open listbox.
  const options: readonly OmniboxOption[] = useMemo(() => {
    if (!listOpen) return [];
    if (listKind === 'search' && searchResults) {
      if (searchResults.items.length > 0) {
        return searchResults.items.map((item, idx) => ({
          id: `${baseId}-opt-item-${item.id}-${idx}`,
          kind: 'item' as const,
          item,
          query: searchResults.query,
        }));
      }
      return [
        {
          id: `${baseId}-opt-create`,
          kind: 'create' as const,
          query: searchResults.query,
        },
      ];
    }
    if (listKind === 'tag-filter' && tagFilterState) {
      return tagFilterState.tags.map((tag, idx) => ({
        id: `${baseId}-opt-tag-${idx}`,
        kind: 'tag' as const,
        tag,
        query: tagFilterState.token,
      }));
    }
    return [];
  }, [baseId, listKind, listOpen, searchResults, tagFilterState]);

  useEffect(() => {
    if (activeIndex >= 0 && options[activeIndex]) {
      const optEl = optionRefs.current[options[activeIndex].id];
      if (optEl && typeof optEl.scrollIntoView === 'function') {
        optEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [activeIndex, options]);

  const activeDescendantId =
    listOpen && activeIndex >= 0 && options[activeIndex] ? options[activeIndex].id : undefined;

  const invalidateAllContentMetadataCaches = useCallback(async () => {
    if (!queryClient) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: CONTENT_ITEMS_QUERY_KEY_PREFIX }),
      queryClient.invalidateQueries({ queryKey: CONTENT_ITEM_QUERY_KEY_PREFIX }),
      queryClient.invalidateQueries({ queryKey: CONTENT_LOOKUP_QUERY_KEY_PREFIX }),
      queryClient.invalidateQueries({ queryKey: CONTENT_TAGS_QUERY_KEY_PREFIX }),
      queryClient.invalidateQueries({ queryKey: CONTENT_ENTRIES_QUERY_KEY_PREFIX }),
    ]);
  }, [queryClient]);

  const createEmptyItemWithName = useCallback(
    async (rawName: string) => {
      const nameToCreate = trimUnicodeWhiteSpace(rawName);
      if (!nameToCreate || createPendingRef.current) return;
      createPendingRef.current = true;
      const controller = new AbortController();
      createAbortRef.current = controller;
      setActionErrorCode(null);
      const idempotencyKey = createIdempotencyKey();

      try {
        const created = await itemCreate(
          { name: nameToCreate },
          { idempotencyKey, signal: controller.signal },
        );
        if (controller.signal.aborted || createAbortRef.current !== controller) {
          return;
        }
        closeListbox(false);
        setInputValue('');
        inputValueRef.current = '';
        if (textareaRef.current) {
          textareaRef.current.value = '';
          syncTextareaHeight(textareaRef.current);
          textareaRef.current.focus();
        }
        undoToast?.markOmniboxJustCleared(textareaRef.current);
        void invalidateAllContentMetadataCaches();

        undoToast?.pushUndoToast({
          message: tOmni('createdEmptyItemToast', { name: created.name }),
          actionLabel: tOmni('undoAction'),
          returnFocusTo: () => textareaRef.current,
          onUndo: async () => {
            await itemDelete(created.id, { idempotencyKey: createIdempotencyKey() });
            await invalidateAllContentMetadataCaches();
            textareaRef.current?.focus();
          },
          onError: (err) => {
            const code = getContentErrorI18nKey(err).replace(
              /^content\.errors\./,
              '',
            ) as ContentErrorCode;
            setActionErrorCode(code);
          },
        });
      } catch (error) {
        if (controller.signal.aborted || createAbortRef.current !== controller) {
          return;
        }
        const code = getContentErrorI18nKey(error).replace(
          /^content\.errors\./,
          '',
        ) as ContentErrorCode;
        setActionErrorCode(code);
      } finally {
        if (createAbortRef.current === controller) {
          createAbortRef.current = null;
          createPendingRef.current = false;
        }
      }
    },
    [closeListbox, invalidateAllContentMetadataCaches, syncTextareaHeight, tOmni, undoToast],
  );

  const getStepLocalizedLabel = useCallback(
    (stepKey: SavePlanStepKey, plan: QuickAddSavePlan): string => {
      switch (stepKey) {
        case 'item':
          return tOmni('savePlanStepItem', { name: plan.itemName });
        case 'tags':
          return tOmni('savePlanStepTags', { count: plan.tagTasks.length });
        case 'assign':
          return tOmni('savePlanStepAssign');
        case 'entry':
          return tOmni('savePlanStepEntry');
      }
    },
    [tOmni],
  );

  const runPlanExecution = useCallback(
    async (plan: QuickAddSavePlan) => {
      planAbortRef.current?.abort();
      const controller = new AbortController();
      planAbortRef.current = controller;
      setActionErrorCode(null);

      const runningStep = plan.steps.find((s) => s.status !== 'done') ?? plan.steps[0];
      if (runningStep) {
        setLiveMessage(
          tOmni('savePlanLiveRunning', {
            step: getStepLocalizedLabel(runningStep.key, plan),
          }),
        );
      }

      const outcome = await executeQuickAddSavePlan({
        plan,
        queryClient,
        signal: controller.signal,
        onStepUpdate: () => {
          setPlanRenderTick((prev) => prev + 1);
          const currentRunning = plan.steps.find((s) => s.status === 'running');
          if (currentRunning) {
            setLiveMessage(
              tOmni('savePlanLiveRunning', {
                step: getStepLocalizedLabel(currentRunning.key, plan),
              }),
            );
          }
        },
      });

      if (controller.signal.aborted || !plan.op.isCurrent()) {
        return;
      }

      if (outcome.status === 'completed') {
        const savedItemName = outcome.itemName;
        const savedEntryId = outcome.entryMeta.id;

        plan.op.dispose?.();
        activePlanRef.current = null;
        setActivePlan(null);
        setTargetTagLimitCount(null);
        setActionErrorCode(null);
        setLiveMessage('');
        const currentVal = textareaRef.current?.value ?? inputValueRef.current;
        const submittedVal = submittedDraftRef.current;
        submittedDraftRef.current = null;

        if (submittedVal === null || currentVal === submittedVal) {
          setInputValue('');
          inputValueRef.current = '';
          if (textareaRef.current) {
            textareaRef.current.value = '';
            syncTextareaHeight(textareaRef.current);
            textareaRef.current.focus();
          }
          // Mark omnibox as just cleared by save so immediate Ctrl+Z / ⌘Z triggers Undo (plan §2.11 step 4, SPEC §7.8).
          undoToast?.markOmniboxJustCleared(textareaRef.current);
        } else {
          setInputValue(currentVal);
          inputValueRef.current = currentVal;
          if (textareaRef.current) {
            textareaRef.current.value = currentVal;
            syncTextareaHeight(textareaRef.current);
          }
        }
        // Push Undo toast ONLY after entry 201 commit; Undo deletes ONLY the entry (Q18, dec-116, P4BE1-2, P4FE2-13).
        undoToast?.pushUndoToast({
          message: tOmni('savedToastMessage', { name: savedItemName }),
          detail: tOmni('savedUndoDetail'),
          actionLabel: tOmni('undoAction'),
          returnFocusTo: () => textareaRef.current,
          onUndo: async () => {
            await entryDelete(savedEntryId, {
              idempotencyKey: createIdempotencyKey(),
            });
            await invalidateAllContentMetadataCaches();
            textareaRef.current?.focus();
          },
          onError: (err) => {
            const code = getContentErrorI18nKey(err).replace(
              /^content\.errors\./,
              '',
            ) as ContentErrorCode;
            setActionErrorCode(code);
          },
        });

        void invalidateAllContentMetadataCaches();
        return;
      }

      if (outcome.status === 'failed') {
        const { classifiedError, stepKey, priorUncertain } = outcome;

        // Case (b) pre-lookup terminal logout boundary (`session_invalid`, `forbidden`, or unrefreshed `unauthenticated`)
        // -> drop plan and draft, never replay; record `saveUnconfirmed` bound to `user_id` ONLY when the failing step
        // had an uncertain prior send (`priorUncertain === true`) and a real `activeUserId` is known
        // (SPEC §3.4, advisor-dec-119, advisor-dec-120, HM18B-R1-5).
        if (
          classifiedError.isLogoutBoundary ||
          classifiedError.preLookupRecovery === 'terminal_logout_boundary'
        ) {
          if (priorUncertain && activeUserId) {
            recordSaveUnconfirmed({
              userId: activeUserId,
              itemName: plan.itemName,
            });
          }
          plan.op.dispose?.();
          activePlanRef.current = null;
          setActivePlan(null);
          setTargetTagLimitCount(null);
          submittedDraftRef.current = null;
          setInputValue('');
          inputValueRef.current = '';
          if (textareaRef.current) {
            textareaRef.current.value = '';
            syncTextareaHeight(textareaRef.current);
          }
          const code = classifiedError.i18nKey.replace(
            /^content\.errors\./,
            '',
          ) as ContentErrorCode;
          setActionErrorCode(code);
          return;
        }

        // `409 entry_key_mismatch` or `404 vault_absent`: vault reset or key change on another device
        // -> drop plan and draft, never resend old ciphertext (SPEC §3.4 step 3 & 6).
        if (
          classifiedError.kind === 'entry_key_mismatch' ||
          classifiedError.kind === 'vault_absent'
        ) {
          plan.op.dispose?.();
          activePlanRef.current = null;
          setActivePlan(null);
          setTargetTagLimitCount(null);
          submittedDraftRef.current = null;
          setInputValue('');
          inputValueRef.current = '';
          if (textareaRef.current) {
            textareaRef.current.value = '';
            syncTextareaHeight(textareaRef.current);
          }
          const code = classifiedError.i18nKey.replace(
            /^content\.errors\./,
            '',
          ) as ContentErrorCode;
          setActionErrorCode(code);
          if (vault?.reloadVaultMeta) {
            void vault.reloadVaultMeta();
          }
          return;
        }

        // Retryable failure (network, timeout, 5xx, 429, 409 idempotency_in_progress, recoverable_auth) ->
        // keep draft and plan so Retry resumes from the failed step with the exact same keys + bytes (A3).
        if (classifiedError.canRetrySameBytes) {
          setPlanRenderTick((prev) => prev + 1);
          setLiveMessage(
            tOmni('savePlanLiveFailed', {
              step: getStepLocalizedLabel(stepKey, plan),
            }),
          );
          const code = classifiedError.i18nKey.replace(
            /^content\.errors\./,
            '',
          ) as ContentErrorCode;
          setActionErrorCode(code);
          requestAnimationFrame(() => {
            if (document.activeElement === document.body) {
              retryPlanBtnRef.current?.focus();
            }
          });
          return;
        }

        // Deterministic 4xx (e.g. `item_tag_limit`, `item_entry_limit`, `not_found`, validation):
        // plan ends, draft is preserved, UI surfaces error code; next Enter builds a fresh plan (SPEC §3.4 step 3).
        plan.op.dispose?.();
        activePlanRef.current = null;
        setActivePlan(null);
        submittedDraftRef.current = null;
        const code = classifiedError.i18nKey.replace(
          /^content\.errors\./,
          '',
        ) as ContentErrorCode;
        setActionErrorCode(code);
      }
    },
    [
      activeUserId,
      getStepLocalizedLabel,
      invalidateAllContentMetadataCaches,
      queryClient,
      syncTextareaHeight,
      tOmni,
      undoToast,
      vault,
    ],
  );

  const startSavePlanForTarget = useCallback(
    async (params: {
      readonly name: string;
      readonly tags: readonly string[];
      readonly body: string;
      readonly targetItem: ItemSummary | null;
      readonly isNewItem: boolean;
    }) => {
      const { name, tags, body, targetItem, isNewItem } = params;

      // Pre-check 20-tag cap before building plan or sending any write request (SPEC §3.4 step 2, plan §2.11 step 2).
      if (!isNewItem && targetItem) {
        const capCheck = checkTargetTagCap(targetItem.tags ?? [], tags);
        if (!capCheck.allowed) {
          setTargetTagLimitCount(capCheck.existingTagCount);
          setActionErrorCode(null);
          return;
        }
      }

      setTargetTagLimitCount(null);
      setActionErrorCode(null);

      if (!vault) {
        return;
      }

      try {
        let effectiveVault = vault;
        if (!vault.vaultMeta?.vault_key_id && typeof vault.reloadVaultMeta === 'function') {
          const loadedMeta = await vault.reloadVaultMeta();
          if (!loadedMeta?.vault_key_id) {
            setActionErrorCode('vault_absent');
            return;
          }
          effectiveVault = { ...vault, vaultMeta: loadedMeta };
        }

        const plan = await createQuickAddSavePlan({
          name,
          tags,
          body,
          targetItem,
          isNewItem,
          vault: effectiveVault,
        });

        if (!plan.op.isCurrent()) {
          plan.op.dispose?.();
          return;
        }

        submittedDraftRef.current = textareaRef.current?.value ?? inputValueRef.current;
        activePlanRef.current = plan;
        setActivePlan(plan);
        await runPlanExecution(plan);
      } catch (error) {
        if (error instanceof EntrySealError) {
          if (error.code === 'STALE_GENERATION' || error.code === 'VAULT_LOCKED') {
            return;
          }
          if (error.code === 'ENTRY_TOO_LARGE') {
            setActionErrorCode('entry_too_large');
            return;
          }
          setActionErrorCode('entry_invalid');
          return;
        }
        const code = getContentErrorI18nKey(error).replace(
          /^content\.errors\./,
          '',
        ) as ContentErrorCode;
        setActionErrorCode(code);
      }
    },
    [runPlanExecution, vault],
  );

  const submitQuickAdd = useCallback(
    async (forceCreateNew: boolean, currentParsed: QuickAddParseResult) => {
      if (currentParsed.mode !== 'add') {
        return;
      }
      if (!isVaultUnlocked) {
        return;
      }
      if (lookupPendingRef.current || activePlanRef.current?.running) {
        return;
      }

      clearSaveUnconfirmed();
      clearLockClearedNotice();
      setTargetTagLimitCount(null);
      setActionErrorCode(null);

      // Ctrl+Enter in add mode always creates a new item with the entry, skipping exact lookup (SPEC §3.4).
      if (forceCreateNew) {
        await startSavePlanForTarget({
          name: currentParsed.name,
          tags: currentParsed.tags,
          body: currentParsed.body,
          targetItem: null,
          isNewItem: true,
        });
        return;
      }

      // Exact lookup GET /items/lookup?name= ONLY on Enter (advisor-dec-098).
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      lookupPendingRef.current = true;

      try {
        const lookupKey = contentQueryKeys.lookup(currentParsed.name);
        const lookupRes = queryClient
          ? await queryClient.fetchQuery({
              queryKey: lookupKey,
              queryFn: ({ signal }) =>
                itemsLookupExact({ name: currentParsed.name, signal }),
              gcTime: 0,
              staleTime: 0,
            })
          : await itemsLookupExact({
              name: currentParsed.name,
              signal: controller.signal,
            });

        if (controller.signal.aborted) {
          return;
        }

        const matchedItems = lookupRes.items ?? [];
        const total = lookupRes.total ?? matchedItems.length;

        if (total === 0 || matchedItems.length === 0) {
          await startSavePlanForTarget({
            name: currentParsed.name,
            tags: currentParsed.tags,
            body: currentParsed.body,
            targetItem: null,
            isNewItem: true,
          });
          return;
        }

        if (total === 1 && matchedItems.length === 1) {
          await startSavePlanForTarget({
            name: currentParsed.name,
            tags: currentParsed.tags,
            body: currentParsed.body,
            targetItem: matchedItems[0]!,
            isNewItem: false,
          });
          return;
        }

        // >= 2 matches -> open U9 duplicate picker dialog (do not copy plaintext body into modal state — HM18B-R1-8).
        setDupPickerState({
          name: currentParsed.name,
          tags: currentParsed.tags,
          initialItems: matchedItems,
          total,
          nextCursor: lookupRes.next_cursor ?? null,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        const code = getContentErrorI18nKey(error).replace(
          /^content\.errors\./,
          '',
        ) as ContentErrorCode;
        setActionErrorCode(code);
      } finally {
        lookupPendingRef.current = false;
      }
    },
    [isVaultUnlocked, queryClient, startSavePlanForTarget],
  );

  const handleDupPickerPick = useCallback(
    (selection: DupPickerSelection) => {
      const pending = dupPickerState;
      setDupPickerState(null);
      textareaRef.current?.focus();
      if (!pending) return;
      if (lookupPendingRef.current || activePlanRef.current?.running) {
        return;
      }

      // Read the draft from the textarea / ref at pick time rather than storing body in modal state (HM18B-R1-8).
      const latestDraft = textareaRef.current?.value ?? inputValueRef.current;
      const latestParsed = parseQuickAdd(latestDraft);
      if (latestParsed.mode !== 'add' || !latestParsed.body) {
        return;
      }

      if (selection.kind === 'create-new') {
        void startSavePlanForTarget({
          name: pending.name,
          tags: pending.tags,
          body: latestParsed.body,
          targetItem: null,
          isNewItem: true,
        });
      } else {
        void startSavePlanForTarget({
          name: pending.name,
          tags: pending.tags,
          body: latestParsed.body,
          targetItem: selection.item,
          isNewItem: false,
        });
      }
    },
    [dupPickerState, startSavePlanForTarget],
  );

  const handleDupPickerCancel = useCallback(() => {
    setDupPickerState(null);
    textareaRef.current?.focus();
  }, []);

  const executeOption = useCallback(
    (option: OmniboxOption) => {
      if (option.kind === 'item') {
        closeListbox(false);
        router?.push(`/app/items/${option.item.id}`);
        return;
      }
      if (option.kind === 'create') {
        void createEmptyItemWithName(option.query);
        return;
      }
      if (option.kind === 'tag') {
        closeListbox(false);
        setInputValue('');
        inputValueRef.current = '';
        if (textareaRef.current) {
          textareaRef.current.value = '';
          syncTextareaHeight(textareaRef.current);
        }
        router?.push(`/app?tag=${encodeURIComponent(option.tag.id)}`);
      }
    },
    [closeListbox, createEmptyItemWithName, router, syncTextareaHeight],
  );

  const runPrefixSearch = useCallback(
    async (rawQuery: string) => {
      const q = trimUnicodeWhiteSpace(rawQuery);
      if (!q) {
        closeListbox(true);
        return;
      }

      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setActionErrorCode(null);

      const searchKey: ContentItemsQueryKey = contentQueryKeys.items({
        sort: 'alpha',
        q,
      });

      try {
        const data: ItemList = queryClient
          ? await queryClient.fetchQuery({
              queryKey: searchKey,
              queryFn: ({ signal }) => itemsList({ sort: 'alpha', q, signal }),
              gcTime: 0,
              staleTime: 0,
            })
          : await itemsList({ sort: 'alpha', q, signal: controller.signal });

        if (controller.signal.aborted || searchAbortRef.current !== controller) return;
        const items = data.items ?? [];
        setSearchResults({ query: q, items });
        setListKind('search');
        setListOpen(true);
        // After Enter search, NO option is active (plan §2.11, dec-156).
        setActiveIndex(-1);
        setLiveMessage(
          items.length > 0
            ? tOmni('searchLiveCount', { count: items.length })
            : tOmni('searchEmptyTitle', { query: q }),
        );
      } catch (error) {
        if (controller.signal.aborted || searchAbortRef.current !== controller) return;
        const code = getContentErrorI18nKey(error).replace(
          /^content\.errors\./,
          '',
        ) as ContentErrorCode;
        setActionErrorCode(code);
      }
    },
    [closeListbox, queryClient, tOmni],
  );

  const runServerTagLookup = useCallback(
    async (token: string) => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setActionErrorCode(null);

      const tagSearchKey = contentQueryKeys.tags({
        sort: 'alpha',
        q: token || undefined,
      });

      try {
        const data: TagList = queryClient
          ? await queryClient.fetchQuery({
              queryKey: tagSearchKey,
              queryFn: ({ signal }) =>
                tagsList({ sort: 'alpha', q: token || undefined, signal }),
              gcTime: 0,
              staleTime: 0,
            })
          : await tagsList({
              sort: 'alpha',
              q: token || undefined,
              signal: controller.signal,
            });

        if (controller.signal.aborted || searchAbortRef.current !== controller) return;
        const matched = data.items ?? [];
        setTagFilterState({
          token,
          tags: matched,
          fromServer: true,
        });
        setListKind('tag-filter');
        setListOpen(true);
        setActiveIndex(matched.length > 0 ? 0 : -1);
        setLiveMessage(
          matched.length > 0
            ? tOmni('tagLiveCount', { count: matched.length, query: token })
            : tOmni('tagEmptyTitle', { query: token }),
        );
      } catch (error) {
        if (controller.signal.aborted || searchAbortRef.current !== controller) return;
        const code = getContentErrorI18nKey(error).replace(
          /^content\.errors\./,
          '',
        ) as ContentErrorCode;
        setActionErrorCode(code);
      }
    },
    [queryClient, tOmni],
  );

  const handleInputChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    // Prevent silent data loss or draft/plan divergence while a save plan is actively running (HM18B-R1-3).
    if (activePlanRef.current?.running) {
      if (textareaRef.current) {
        textareaRef.current.value = inputValueRef.current;
      }
      return;
    }
    const nextValue = event.target.value;
    setInputValue(nextValue);
    inputValueRef.current = nextValue;
    setGuardKind(null);
    setActionErrorCode(null);
    clearLockClearedNotice();
    setTargetTagLimitCount(null);
    undoToast?.clearOmniboxJustCleared();
    if (activePlanRef.current && !activePlanRef.current.running) {
      abortAndClearSavePlan();
    }

    syncTextareaHeight(event.target);

    // Always discard any in-flight search or server tag lookup result when the user edits the input (HM18A-R1-6, HM18A-R2-4).
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;

    const nextParsed = parseQuickAdd(nextValue);
    if (nextParsed.mode === 'tag-filter') {
      const { token } = parseTagFilterInput(nextValue);
      const cached = filterCachedTagsByPrefix(getCachedTags(), token);
      setSearchResults(null);
      setTagFilterState({
        token,
        tags: cached,
        fromServer: false,
      });
      setListKind('tag-filter');
      setListOpen(true);
      setActiveIndex(cached.length > 0 ? 0 : -1);
      setLiveMessage(
        cached.length > 0
          ? tOmni('tagLiveCount', { count: cached.length, query: token })
          : tOmni('tagEmptyTitle', { query: token }),
      );
      return;
    }

    // Editing the input while search results are open closes the listbox immediately (plan §2.11).
    if (listOpen) {
      closeListbox(true);
    }
  };

  const handleEnterKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const isCtrl = event.ctrlKey || event.metaKey;

    if (parsed.mode === 'tag-filter') {
      // Ctrl+Enter in #… mode is ignored (plan §2.11, P4FE5-7).
      if (isCtrl) return;

      const { token, searchable } = parseTagFilterInput(inputValue);
      if (!searchable) {
        closeListbox(false);
        setGuardKind('tag');
        setLiveMessage(tOmni('tagGuardTitle'));
        return;
      }

      setGuardKind(null);
      if (listOpen && listKind === 'tag-filter' && activeIndex >= 0 && options[activeIndex]) {
        executeOption(options[activeIndex]);
        return;
      }

      const cached = filterCachedTagsByPrefix(getCachedTags(), token);
      if (cached.length > 0) {
        executeOption({
          id: `${baseId}-opt-tag-0`,
          kind: 'tag',
          tag: cached[0]!,
          query: token,
        });
        return;
      }

      // Not in cache -> Enter sends GET /tags?q=<token> (one token <= 50 runes).
      void runServerTagLookup(token);
      return;
    }

    if (parsed.mode === 'search') {
      if (!hasNonEmptyInput) {
        closeListbox(true);
        return;
      }

      if (!parsed.searchable) {
        closeListbox(false);
        setGuardKind('search');
        setLiveMessage(tOmni('guardTitle'));
        return;
      }

      setGuardKind(null);

      // Ctrl+Enter (single line, <= 200 runes) creates an item with that name and no entry.
      if (isCtrl) {
        void createEmptyItemWithName(trimmedInput);
        return;
      }

      // Enter with an active option opens/executes it; without one searches (or searches again).
      if (listOpen && listKind === 'search' && activeIndex >= 0 && options[activeIndex]) {
        executeOption(options[activeIndex]);
        return;
      }

      void runPrefixSearch(trimmedInput);
      return;
    }

    if (parsed.mode === 'add-invalid') {
      closeListbox(true);
      return;
    }

    if (parsed.mode === 'add') {
      closeListbox(true);
      const currentPlan = activePlanRef.current;
      if (currentPlan) {
        if (currentPlan.running) {
          return;
        }
        if (currentPlan.steps.some((s) => s.status === 'failed')) {
          void runPlanExecution(currentPlan);
          return;
        }
      }
      void submitQuickAdd(isCtrl, parsed);
    }
  };

  const handleDiscardDraft = () => {
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    abortAndClearSavePlan();
    setInputValue('');
    inputValueRef.current = '';
    setGuardKind(null);
    setActionErrorCode(null);
    setLiveMessage('');
    if (textareaRef.current) {
      textareaRef.current.value = '';
      syncTextareaHeight(textareaRef.current);
      textareaRef.current.focus();
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(event)) {
      return;
    }

    if (event.key === 'ArrowDown') {
      if (!listOpen || options.length === 0) return;
      event.preventDefault();
      setActiveIndex((prev) => (prev < 0 ? 0 : (prev + 1) % options.length));
      return;
    }

    if (event.key === 'ArrowUp') {
      if (!listOpen || options.length === 0) return;
      event.preventDefault();
      setActiveIndex((prev) => (prev <= 0 ? options.length - 1 : prev - 1));
      return;
    }

    if (event.key === 'Enter') {
      // Shift+Enter inserts a newline in the auto-growing textarea (advisor-dec-152).
      if (event.shiftKey && !event.ctrlKey && !event.metaKey) {
        requestAnimationFrame(() => syncTextareaHeight());
        return;
      }
      event.preventDefault();
      handleEnterKey(event);
      return;
    }

    if (event.key === 'Escape') {
      if (listOpen) {
        event.preventDefault();
        closeListbox(false);
        return;
      }
      if (inputValue.length > 0) {
        if (activePlanRef.current?.running) {
          return;
        }
        event.preventDefault();
        handleDiscardDraft();
      }
    }
  };

  const handleRootBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (!nextTarget || !rootRef.current?.contains(nextTarget)) {
      closeListbox(false);
    }
  };

  const isAddLike = parsed.mode === 'add' || parsed.mode === 'add-invalid';
  const showSearchHint = parsed.mode === 'search' && hasNonEmptyInput && guardKind === null;
  const showTagHint = parsed.mode === 'tag-filter' && hasNonEmptyInput && guardKind === null;
  const showHint = showSearchHint || showTagHint;
  const isSearchInvalid = parsed.mode === 'search' && hasNonEmptyInput && !parsed.searchable;

  const hasGrammarErr = parsed.mode === 'add-invalid';
  const isSoftAddHint =
    hasGrammarErr &&
    (parsed.error === 'body_empty' || (parsed.error === 'name_empty' && !parsed.name));
  const hasHardAddErr =
    (hasGrammarErr && !isSoftAddHint) || targetTagLimitCount !== null;
  const hasFailedPlanStep = Boolean(
    activePlan && activePlan.steps.some((s) => s.status === 'failed'),
  );
  const isPlanRunning = Boolean(activePlan?.running);

  const addErrorMessage = useMemo((): string | null => {
    if (hasGrammarErr) {
      switch (parsed.error) {
        case 'body_empty':
          return tOmni('addErrorBodyEmpty');
        case 'name_empty':
          return tOmni('addErrorNameEmpty');
        case 'name_invalid':
          return tOmni('addErrorNameInvalid');
        case 'tag_has_space':
          return tOmni('addErrorTagHasSpace');
        case 'tag_display_invalid':
          return tOmni('addErrorTagDisplayInvalid');
        case 'tag_limit':
          return tOmni('addErrorTagLimit', { count: parsed.tags.length });
        default:
          return tOmni('addErrorNameInvalid');
      }
    }
    if (targetTagLimitCount !== null) {
      return tOmni('addErrorTargetTagLimit', { count: targetTagLimitCount });
    }
    return null;
  }, [hasGrammarErr, parsed.error, parsed.tags.length, tOmni, targetTagLimitCount]);

  const getStepStatusBadge = (
    status: SavePlanStepStatus,
  ): { readonly badgeClass: string; readonly label: string } => {
    switch (status) {
      case 'done':
        return { badgeClass: 'badge-text', label: tOmni('savePlanStatusDone') };
      case 'running':
        return { badgeClass: 'badge-warn', label: tOmni('savePlanStatusRunning') };
      case 'failed':
        return { badgeClass: 'badge-err', label: tOmni('savePlanStatusFailed') };
      case 'pending':
      default:
        return { badgeClass: 'badge-ok', label: tOmni('savePlanStatusPending') };
    }
  };

  const failedStep = activePlan?.steps.find((s) => s.status === 'failed') ?? null;
  const hasOptionChildren = options.length > 0;

  return (
    <div
      ref={rootRef}
      id={baseId}
      data-omnibox=""
      onBlur={handleRootBlur}
      className={cn('relative', compact ? 'flex-1 md:block' : 'w-full', className)}
    >
      <label
        className={cn(
          'omnibox-shell',
          compact && '!px-3.5 !py-2.5',
          isAddLike && 'is-add',
        )}
      >
        <SearchIcon compact={compact} />
        <textarea
          ref={textareaRef}
          rows={1}
          value={inputValue}
          readOnly={isPlanRunning}
          aria-busy={isPlanRunning || undefined}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={tOmni('placeholder')}
          data-omnibox-input=""
          aria-label={tOmni('ariaLabel')}
          aria-describedby={hintId}
          aria-controls={listOpen && hasOptionChildren ? listboxId : undefined}
          aria-activedescendant={activeDescendantId}
          aria-invalid={
            isSearchInvalid || guardKind !== null || hasHardAddErr ? true : undefined
          }
          className={cn(
            'omnibox-input m-0 block max-h-[132px] resize-none overflow-y-hidden p-0 leading-[1.4]',
            compact && '!text-[15px]',
          )}
          {...getVaultSecretInputProps()}
        />
        <Kbd>Ctrl K</Kbd>
      </label>

      <div
        data-omni-aux="1"
        className={cn(
          'omni-aux flex flex-col gap-2',
          compact ? 'mt-1.5' : 'mt-2',
        )}
      >
        {visibleLockClearedNoticeKind !== null ? (
          <div
            id={lockClearedNoticeId}
            role="status"
            data-omni-lock-notice="1"
            data-testid="omnibox-lock-cleared-notice"
            className="omni-lock-notice rounded-md border border-line bg-surface px-3.5 py-3 text-[13px] leading-[1.45] text-body"
          >
            <div className="omni-lock-notice-inner flex flex-wrap items-center justify-between gap-2.5">
              <p className="m-0 text-[13px] font-semibold text-body">
                {visibleLockClearedNoticeKind === 'plan'
                  ? tOmni('lockClearedPlanNotice')
                  : tOmni('lockClearedDraftNotice')}
              </p>
              <button
                type="button"
                data-dismiss-lock-notice="1"
                data-testid="omnibox-lock-notice-dismiss"
                onClick={() => clearLockClearedNotice()}
                className="btn btn-tertiary btn-sm"
              >
                {tOmni('lockNoticeDismiss')}
              </button>
            </div>
          </div>
        ) : null}

        {visibleUnconfirmedRecord !== null ? (
          <div
            id={saveUnconfirmedNoticeId}
            role="status"
            data-testid="omnibox-save-unconfirmed-notice"
            className="omni-lock-notice rounded-md border border-warning bg-surface px-3.5 py-3 text-[13px] leading-[1.45] text-body"
          >
            <div className="omni-lock-notice-inner flex flex-wrap items-center justify-between gap-2.5">
              <p className="m-0 text-[13px] font-semibold text-body">
                {tOmni('saveUnconfirmed', { name: visibleUnconfirmedRecord.itemName })}
              </p>
              <button
                type="button"
                data-testid="omnibox-save-unconfirmed-dismiss"
                onClick={() => clearSaveUnconfirmed()}
                className="btn btn-tertiary btn-sm"
              >
                {tOmni('saveUnconfirmedDismiss')}
              </button>
            </div>
          </div>
        ) : null}

        <div
          id={hintId}
          hidden={!showHint}
          data-testid="omnibox-hint"
          className={cn(
            'omni-hint-line text-[12px] leading-[1.45] text-muted',
            !showHint && 'hidden',
          )}
        >
          {showSearchHint
            ? tOmni.rich('searchHint', {
                mono: (chunks) => <span className="mono">{chunks}</span>,
              })
            : showTagHint
              ? tOmni('tagHint')
              : ''}
        </div>

        <div
          id={liveId}
          role="status"
          aria-live="polite"
          data-testid="omnibox-live"
          className="sr-only"
        >
          {liveMessage}
        </div>

        <div
          id={guardAlertId}
          role="alert"
          hidden={guardKind === null}
          data-omni-guard="1"
          data-testid="omnibox-guard-alert"
          className={cn(
            'omni-guard-alert rounded-md border border-warning bg-surface p-3 text-[13px] leading-[1.45] text-body',
            guardKind === null && 'hidden',
          )}
        >
          {guardKind === 'search' ? (
            <>
              <p className="m-0 text-[13px] font-semibold text-body">{tOmni('guardTitle')}</p>
              <p className="m-0 mt-0.5 text-[12px] text-muted">{tOmni('guardBody')}</p>
            </>
          ) : guardKind === 'tag' ? (
            <p className="m-0 text-[13px] font-semibold text-body">{tOmni('tagGuardTitle')}</p>
          ) : null}
        </div>

        {isAddLike ? (
          <div
            id={addPreviewId}
            data-omni-add-panel="1"
            data-testid="omnibox-add-preview"
            className="omni-add-panel rounded-lg border border-line bg-canvas px-4 py-3.5 shadow-card"
          >
            <div className="omni-add-header flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <div className="omni-add-dest flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
                <span className="badge-type badge-text">{tOmni('addBadge')}</span>
                <span
                  data-part="dest-label"
                  data-testid="omnibox-add-dest-label"
                  className="text-[14px] text-body"
                >
                  {tOmni.rich('addDestLabel', {
                    name: parsed.name || '…',
                  })}
                </span>
                <span
                  data-part="dest-tags"
                  data-testid="omnibox-add-dest-tags"
                  className="omni-add-tags inline-flex flex-wrap items-center gap-1"
                >
                  {parsed.tags.length > 0 ? (
                    parsed.tags.map((tagDisplay) => (
                      <span
                        key={tagDisplay}
                        className="chip dup-chip inline-block max-w-full truncate !px-2 !py-0.5 !text-[12px]"
                      >
                        #{tagDisplay}
                      </span>
                    ))
                  ) : (
                    <span className="text-[12px] text-muted">{tOmni('addNoTags')}</span>
                  )}
                </span>
              </div>

              {isVaultLocked ? (
                <button
                  type="button"
                  id={unlockToSaveBtnId}
                  data-omni-unlock-save="1"
                  data-testid="omnibox-unlock-to-save-btn"
                  onClick={() => {
                    router?.push(unlockUrl(pathname));
                  }}
                  className="btn btn-primary btn-sm"
                >
                  <span aria-hidden="true">🔒</span> {tOmni('addUnlockToSave')}
                </button>
              ) : (
                <div
                  data-part="save-wrap"
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="text-[12px] text-muted">{tOmni('addSaveShortcut')}</span>
                  <button
                    type="button"
                    data-omni-save-now="1"
                    data-testid="omnibox-save-now-btn"
                    disabled={
                      hasGrammarErr ||
                      targetTagLimitCount !== null ||
                      isPlanRunning ||
                      hasFailedPlanStep
                    }
                    onClick={() => {
                      textareaRef.current?.focus();
                      void submitQuickAdd(false, parsed);
                    }}
                    className="btn btn-primary btn-sm"
                  >
                    {tOmni('addSaveNow')}
                  </button>
                </div>
              )}
            </div>

            <p className="omni-add-local-note m-0 mt-1.5 text-[12px] text-muted">
              {tOmni('addLocalNote')}
            </p>

            {addErrorMessage !== null ? (
              <div
                id={addErrorId}
                role={isSoftAddHint ? 'status' : 'alert'}
                data-testid="omnibox-add-error"
                className="auth-alert !mb-0 mt-3"
              >
                <p className="m-0 text-[13px] font-semibold text-body">{addErrorMessage}</p>
              </div>
            ) : null}

            {parsed.mode === 'add' && parsed.jsonCandidate ? (
              <div
                id={jsonBannerId}
                data-testid="omnibox-json-banner"
                className="omni-json-banner mt-3 flex flex-wrap items-center justify-between gap-2.5 rounded-md border border-warning bg-surfaceAlt px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="m-0 text-[13px] font-semibold text-body">
                    {tOmni('jsonBannerTitle')}
                  </p>
                  <p className="m-0 text-[12px] text-muted">{tOmni('jsonBannerBody')}</p>
                </div>
                {/* Milestone rule (JSON/Import button hidden until Milestone C, plan header & brief item 1):
                    Task 17 import dialog is not merged yet; keep the action button hidden until Task 17 wires it. */}
                <button
                  type="button"
                  hidden
                  data-omni-open-json="1"
                  data-testid="omnibox-json-banner-action"
                  className="btn btn-secondary btn-sm hidden shrink-0"
                >
                  {tOmni('jsonBannerAction')}
                </button>
              </div>
            ) : null}

            {activePlan && activePlan.steps.length > 0 ? (
              <div
                id={savePlanId}
                role="region"
                aria-label={tOmni('savePlanRegionAriaLabel')}
                aria-busy={isPlanRunning}
                data-testid="omnibox-save-plan"
                className="omni-plan-box mt-3 rounded-md border border-line bg-surface px-3.5 py-3"
              >
                <p className="t-label m-0 mb-2 text-[12px] text-muted">
                  {tOmni('savePlanHeading')}
                </p>
                <ol
                  data-part="step-list"
                  className="omni-step-list m-0 flex list-none flex-col gap-1.5 p-0"
                >
                  {activePlan.steps.map((step) => {
                    const badge = getStepStatusBadge(step.status);
                    return (
                      <li
                        key={step.key}
                        data-step-key={step.key}
                        data-step-status={step.status}
                        className="omni-step-item flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-sm border border-line bg-canvas px-2 py-1.5"
                      >
                        <span className="mono text-[12px]">{step.apiLabel}</span>
                        <span className="text-[13px] text-body">
                          {getStepLocalizedLabel(step.key, activePlan)}
                        </span>
                        <span className={cn('badge-type ml-auto', badge.badgeClass)}>
                          {badge.label}
                        </span>
                      </li>
                    );
                  })}
                </ol>

                {failedStep ? (
                  <div
                    id={planErrorId}
                    role="alert"
                    data-testid="omnibox-plan-error"
                    className="auth-alert !mb-0 mt-3"
                  >
                    <p
                      data-part="fail-title"
                      className="m-0 text-[13px] font-semibold text-body"
                    >
                      {tOmni('savePlanErrorTitle', {
                        step: getStepLocalizedLabel(failedStep.key, activePlan),
                      })}
                    </p>
                    <p className="m-0 mt-0.5 text-[12px] text-body">
                      {tOmni('savePlanErrorBody')}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        ref={retryPlanBtnRef}
                        type="button"
                        data-omni-retry-plan="1"
                        data-testid="omnibox-retry-plan-btn"
                        onClick={() => {
                          textareaRef.current?.focus();
                          void runPlanExecution(activePlan);
                        }}
                        className="btn btn-primary btn-sm"
                      >
                        {tOmni('savePlanRetry')}
                      </button>
                      <button
                        type="button"
                        data-testid="omnibox-discard-draft-btn"
                        onClick={handleDiscardDraft}
                        className="btn btn-tertiary btn-sm"
                      >
                        {tOmni('savePlanDiscardDraft')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div
              id={addPrivacyId}
              data-testid="omnibox-add-privacy"
              className="omni-add-privacy border-top-line mt-2.5 border-t border-line pt-2.5"
            >
              <p className="m-0 text-[12px] text-body">{tPrivacy('notice')}</p>
            </div>
          </div>
        ) : null}

        {actionErrorCode !== null ? (
          <div
            role="alert"
            data-testid="omnibox-action-error"
            className="auth-alert !mb-0"
          >
            {tErrors(actionErrorCode)}
          </div>
        ) : null}
      </div>

      {listOpen ? (
        <div
          id={popId}
          data-pop=""
          onMouseDown={(event) => {
            // Keep focus on the textarea when clicking inside the popover so `handleRootBlur`
            // does not close the listbox before `onClick` fires (HM18A-R1-2).
            event.preventDefault();
          }}
          className="popover absolute left-0 right-0 top-[calc(100%+8px)] z-30 max-h-[440px] overflow-auto"
        >
          {listKind === 'search' && searchResults ? (
            <>
              {searchResults.items.length > 0 ? (
                <div className="sugg-group" aria-hidden="true">
                  {tOmni('searchGroupHeader', {
                    count: searchResults.items.length,
                    query: searchResults.query,
                  })}
                </div>
              ) : (
                <div
                  id={emptyBoxId}
                  aria-hidden="true"
                  data-testid="omnibox-search-empty"
                  className="omni-empty-box border-b border-line bg-surface px-4 py-4"
                >
                  <p className="t-label mb-1 text-muted">{tOmni('searchEmptyEyebrow')}</p>
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {tOmni('searchEmptyTitle', { query: searchResults.query })}
                  </p>
                  <p className="m-0 text-[12px] text-muted">{tOmni('searchEmptyBody')}</p>
                </div>
              )}

              <div
                id={listboxId}
                role="listbox"
                aria-label={tOmni('searchListboxAriaLabel')}
                className="omni-listbox"
              >
                {options.map((option, index) => {
                  const isSelected = activeIndex === index;
                  if (option.kind === 'item') {
                    const shownTags = option.item.tags.slice(0, MAX_VISIBLE_OPTION_TAG_CHIPS);
                    const extraTags = Math.max(
                      0,
                      option.item.tags.length - MAX_VISIBLE_OPTION_TAG_CHIPS,
                    );
                    const shownTagChipsLabel = shownTags
                      .map((tag) => `#${tag.display}`)
                      .join(' ');
                    const extraTagsLabel =
                      extraTags > 0
                        ? tOmni('searchMoreTagsAria', { count: extraTags })
                        : '';
                    const optionMainLabel = [
                      option.item.name,
                      shownTagChipsLabel,
                      extraTagsLabel,
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <div
                        key={option.id}
                        ref={(el) => {
                          optionRefs.current[option.id] = el;
                        }}
                        id={option.id}
                        role="option"
                        aria-label={`${optionMainLabel} — ${tOmni('searchEntryCount', { count: option.item.entry_count })}`}
                        aria-selected={isSelected}
                        data-opt-idx={index}
                        onMouseMove={() => {
                          if (activeIndex !== index) {
                            setActiveIndex(index);
                          }
                        }}
                        onClick={() => executeOption(option)}
                        className="sugg-row"
                      >
                        <span className="omni-opt-main flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                          <span className="omni-opt-title font-semibold text-ink [overflow-wrap:anywhere]">
                            <MarkedPrefixText text={option.item.name} query={option.query} />
                          </span>
                          {shownTags.map((tag) => (
                            <span
                              key={tag.id}
                              className="chip dup-chip inline-block max-w-full truncate !px-2 !py-0.5 !text-[12px]"
                            >
                              #{tag.display}
                            </span>
                          ))}
                          {extraTags > 0 ? (
                            <>
                              <span aria-hidden="true" className="mono text-[12px] text-muted">
                                +{extraTags}
                              </span>
                              <span className="sr-only">
                                {tOmni('searchMoreTagsAria', { count: extraTags })}
                              </span>
                            </>
                          ) : null}
                        </span>
                        <span className="sugg-meta mono">
                          {tOmni('searchEntryCount', { count: option.item.entry_count })}
                        </span>
                      </div>
                    );
                  }

                  if (option.kind === 'create') {
                    return (
                      <div
                        key={option.id}
                        ref={(el) => {
                          optionRefs.current[option.id] = el;
                        }}
                        id={option.id}
                        role="option"
                        aria-selected={isSelected}
                        data-opt-idx={index}
                        onMouseMove={() => {
                          if (activeIndex !== index) {
                            setActiveIndex(index);
                          }
                        }}
                        onClick={() => executeOption(option)}
                        className="sugg-row omni-create-option border-t border-dashed border-line bg-canvas px-4 py-3.5"
                      >
                        <span className="mono text-accent">+</span>
                        <span className="!whitespace-normal !overflow-visible">
                          <strong>{tOmni('createItemOption', { query: option.query })}</strong>
                        </span>
                        <span className="sugg-meta">
                          <Kbd>Enter</Kbd>
                        </span>
                      </div>
                    );
                  }

                  return null;
                })}
              </div>
            </>
          ) : null}

          {listKind === 'tag-filter' && tagFilterState ? (
            <>
              <div className="sugg-group" aria-hidden="true">
                {tagFilterState.fromServer
                  ? tOmni('tagGroupServer', { count: tagFilterState.tags.length })
                  : tOmni('tagGroupCache', { count: tagFilterState.tags.length })}
              </div>

              {tagFilterState.tags.length === 0 ? (
                <div
                  aria-hidden="true"
                  data-testid="omnibox-tag-empty"
                  className="omni-empty-box border-b border-line bg-surface px-4 py-4"
                >
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {tOmni('tagEmptyTitle', { query: tagFilterState.token })}
                  </p>
                  <p className="m-0 text-[12px] text-muted">
                    {tagFilterState.fromServer
                      ? tOmni('tagEmptyServerBody')
                      : tOmni('tagEmptyCacheBody')}
                  </p>
                </div>
              ) : null}

              {options.length > 0 ? (
                <div
                  id={listboxId}
                  role="listbox"
                  aria-label={tOmni('tagListboxAriaLabel')}
                  className="omni-listbox"
                >
                  {options.map((option, index) => {
                    if (option.kind !== 'tag') return null;
                    const isSelected = activeIndex === index;
                    return (
                      <div
                        key={option.id}
                        ref={(el) => {
                          optionRefs.current[option.id] = el;
                        }}
                        id={option.id}
                        role="option"
                        aria-label={`#${option.tag.display} — ${tOmni('tagItemCount', { count: option.tag.item_count })}`}
                        aria-selected={isSelected}
                        data-opt-idx={index}
                        onMouseMove={() => {
                          if (activeIndex !== index) {
                            setActiveIndex(index);
                          }
                        }}
                        onClick={() => executeOption(option)}
                        className="sugg-row"
                      >
                        <span className="mono text-accent">#</span>
                        <span>
                          <MarkedPrefixText text={option.tag.display} query={option.query} />
                        </span>
                        <span className="sugg-meta mono">
                          {tOmni('tagItemCount', { count: option.tag.item_count })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <DupPickerDialog
        open={dupPickerState !== null}
        name={dupPickerState?.name ?? ''}
        initialItems={dupPickerState?.initialItems ?? []}
        total={dupPickerState?.total ?? 0}
        initialNextCursor={dupPickerState?.nextCursor ?? null}
        onPick={handleDupPickerPick}
        onCancel={handleDupPickerCancel}
      />
    </div>
  );
}
