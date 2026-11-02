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
import { ProblemError } from '@engram/shared-types';
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
} from '@/features/items/query-keys';
import { ImportJsonDialog } from '@/features/json-table/import-dialog';
import { openJsonImportFromHandoff } from '@/features/json-table/import-handoff-store';
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
  QUICK_ADD_TARGET_TAG_CAP,
  type QuickAddSavePlan,
  type SavePlanStepKey,
  type SavePlanStepStatus,
} from '@/features/omnibox/save-plan';
import {
  filterCachedTagsByPrefix,
  parseTagFilterInput,
} from '@/features/omnibox/search-helpers';
import {
  createInitialMergeState,
  getRowKey,
  suggestMergeReducer,
  type SuggestMergeAction,
  type SuggestMergeState,
  type SuggestRow,
} from '@/features/omnibox/suggest/merge';
import {
  buildSearchQueryKey,
  buildSuggestQueryKey,
  isCacheableSearchResponse,
  isSearchQueryKeyPrefix,
  SEARCH_QUERY_CACHE_OPTIONS,
} from '@/features/omnibox/suggest/query-keys';
import {
  SEARCH_DEFAULT_LIMIT,
  SUGGEST_DEFAULT_LIMIT,
  SUGGEST_MOBILE_LIMIT,
} from '@/features/omnibox/suggest/quota';
import {
  buildSuggestListModel,
  getSuggestOptionDomId,
  SuggestList,
  type SuggestListKey,
} from '@/features/omnibox/suggest/suggest-list';
import {
  createSendGate,
  resolveOmniboxHelpTextKey,
  SUGGEST_DEBOUNCE_MS,
  type KeystrokeSendDecision,
  type SendGateController,
} from '@/features/omnibox/suggest/send-gate';
import { useSemanticSuggestSetting } from '@/features/omnibox/suggest/use-semantic-suggest-setting';
import {
  captureUnconfirmedSaveClearGeneration,
  dismissUnconfirmedSave,
  reconcileUnconfirmedSavesUser,
  recordUnconfirmedSave,
  useUnconfirmedSavesForUser,
} from '@/features/entries/unconfirmed-save-store';
import {
  clearLockClearedNotice,
  getLockClearedNoticeSnapshot,
  reconcileLockClearedNoticeUser,
  recordLockClearedNotice,
  subscribeLockClearedNotice,
} from '@/features/omnibox/unconfirmed-save-store';
import { getKnownDeviceSessionUserId, subscribeDevicePurge } from '@/features/vault/device-store';
import { useOptionalVault } from '@/features/vault/vault-provider';
import {
  createIdempotencyKey,
  entryDelete,
  getContentErrorI18nKey,
  itemCreate,
  itemDelete,
  itemsLookupExact,
  type ContentErrorCode,
  type ItemSummary,
  type Tag,
  type TagList,
  type TagRef,
} from '@/lib/api/content';
import { type Me } from '@/lib/api/auth';
import {
  search as fetchSearch,
  suggest as fetchSuggest,
  type SearchResponse,
  type SearchScope,
  type SemanticParam,
  type SuggestLimit,
  type SuggestResponse,
} from '@/lib/api/search';
import { subscribeSessionBroadcast } from '@/lib/auth/broadcast';
import { subscribeUserChanged } from '@/lib/auth/user-changed';
import { cn } from '@/lib/cn';

const MAX_TEXTAREA_HEIGHT_PX = 132;
/** Longest `Retry-After` the omnibox waits for its single automatic retry (plan 2.6: at most one retry). */
const MAX_SUGGEST_RETRY_AFTER_SECONDS = 30;
/** Delay before the live region reads "N suggestions" after the last keystroke (plan 2.8 rule 6). */
const SUGGEST_LIVE_ANNOUNCE_MS = 500;
/** Delay before the first-query skeleton shows (plan 2.10 pending state). */
const SUGGEST_SKELETON_DELAY_MS = 150;

/** Item chosen with Tab: the next `name: body` save targets this item id instead of an exact-name lookup (OQ-2). */
interface PinnedItem {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly TagRef[];
  readonly tagTotal: number;
}

interface SuggestLegParams {
  readonly decision: KeystrokeSendDecision;
  readonly semanticFlag: SemanticParam;
  readonly gen: number;
  readonly limit: SuggestLimit;
  readonly userId: string;
  readonly epoch: number;
  readonly expectSemantic: boolean;
  readonly isRetry: boolean;
}

function isActionKey(key: SuggestListKey): key is 'action:more' | 'action:create' {
  return key === 'action:more' || key === 'action:create';
}

/** `Retry-After` seconds of a `429 rate_limited` problem, `null` for any other failure. */
function getRateLimitRetryAfterSeconds(error: unknown): number | null {
  if (
    error instanceof ProblemError &&
    (error.problem.status === 429 || error.problem.code === 'rate_limited')
  ) {
    const retryAfter = error.problem.retry_after;
    return typeof retryAfter === 'number' && retryAfter > 0 ? Math.ceil(retryAfter) : 1;
  }
  return null;
}

/** Everything a cursor page ("load more") must repeat from the first `/search` page. Memory only, never logged. */
interface SearchCursorContext {
  readonly q: string;
  readonly scope: SearchScope;
}

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
  if (isSearchQueryKeyPrefix(queryKey)) {
    return true;
  }
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
  const tSearchHelp = useTranslations('search.help');
  const tSearchTab = useTranslations('search.tab');
  const tSearchState = useTranslations('search.state');
  const tSearchLive = useTranslations('search.live');
  const tSearchToggle = useTranslations('search.toggle');
  const tSearchListbox = useTranslations('search.listbox');
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
  // `#omni-pop` (advisor-dec-327): layout/a11y only. `popScrollable` mirrors "the popover overflows".
  const popRef = useRef<HTMLDivElement>(null);
  const [popScrollable, setPopScrollable] = useState(false);
  const retryPlanBtnRef = useRef<HTMLButtonElement>(null);
  const unlockToSaveBtnRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Record<string, HTMLElement | null>>({});
  const searchAbortRef = useRef<AbortController | null>(null);
  const suggestAbortControllersRef = useRef<Set<AbortController>>(new Set());
  const suggestDebounceTimerRef = useRef<number | null>(null);
  // At most one automatic retry per query generation after a 429 `Retry-After` (plan 2.6).
  const suggestRetryTimersRef = useRef<Set<number>>(new Set());
  const retriedLegsRef = useRef<Set<string>>(new Set());
  const sendSuggestLegRef = useRef<((params: SuggestLegParams) => void) | null>(null);
  // Generation whose lexical leg failed (429 / network / 5xx): keep the rows, drop `aria-busy`, no toast (dec-287).
  const [lexicalFailedGen, setLexicalFailedGen] = useState(-1);
  const pinnedItemRef = useRef<PinnedItem | null>(null);
  const searchCursorRef = useRef<SearchCursorContext | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const liveAnnounceTimerRef = useRef<number | null>(null);
  const liveAnnouncedRef = useRef<{ gen: number; nearCount: number; degraded: boolean }>({
    gen: -1,
    nearCount: 0,
    degraded: false,
  });
  // Set by the native `input` listener (observe-only), consumed by `handleInputChange` (see native listener effect).
  const nativeInputPendingRef = useRef(false);
  const nativeInputFlagTimerRef = useRef<number | null>(null);
  const compositionDeferTimerRef = useRef<number | null>(null);
  const gateRef = useRef<SendGateController | null>(null);
  if (!gateRef.current) {
    gateRef.current = createSendGate('');
  }
  const mergeStateRef = useRef<SuggestMergeState>(createInitialMergeState());
  const [, setMergeStateTick] = useState(0);
  const [, setGateRenderTick] = useState(0);
  const [tabCannotFill, setTabCannotFill] = useState(false);
  const planAbortRef = useRef<AbortController | null>(null);
  const createPendingRef = useRef(false);
  const createAbortRef = useRef<AbortController | null>(null);
  const lookupPendingRef = useRef(false);
  const savePlanStartingRef = useRef(false);
  const savePlanStartAbortRef = useRef<AbortController | null>(null);
  const resetEpochRef = useRef(0);
  const inputValueRef = useRef('');
  const activePlanRef = useRef<QuickAddSavePlan | null>(null);
  const submittedDraftRef = useRef<string | null>(null);
  const activeUserIdRef = useRef<string | null>(null);
  const hadDupPickerOpenRef = useRef(false);
  const [inputValue, setInputValue] = useState('');
  inputValueRef.current = inputValue;

  const dispatchMerge = useCallback((action: SuggestMergeAction): SuggestMergeState => {
    const next = suggestMergeReducer(mergeStateRef.current, action);
    mergeStateRef.current = next;
    setMergeStateTick((prev) => prev + 1);
    return next;
  }, []);

  const clearSuggestDebounceTimer = useCallback(() => {
    if (suggestDebounceTimerRef.current !== null) {
      window.clearTimeout(suggestDebounceTimerRef.current);
      suggestDebounceTimerRef.current = null;
    }
  }, []);

  const clearLiveAnnounceTimer = useCallback(() => {
    if (liveAnnounceTimerRef.current !== null) {
      window.clearTimeout(liveAnnounceTimerRef.current);
      liveAnnounceTimerRef.current = null;
    }
  }, []);

  // Cancels the two macrotask timers armed by the native input / composition listeners and drops the hand-off flag
  // (RV-T17-1-FE2-6: a lock / logout / user switch must not leave a late callback re-render or re-send for the old draft).
  const clearNativeEditTimers = useCallback(() => {
    if (nativeInputFlagTimerRef.current !== null) {
      window.clearTimeout(nativeInputFlagTimerRef.current);
      nativeInputFlagTimerRef.current = null;
    }
    if (compositionDeferTimerRef.current !== null) {
      window.clearTimeout(compositionDeferTimerRef.current);
      compositionDeferTimerRef.current = null;
    }
    nativeInputPendingRef.current = false;
  }, []);

  // Aborts the debounce timer, the pending `Retry-After` retries and every in-flight suggest request. Pure refs: it never
  // schedules a React update, so the native `input` listener may call it (RV-T17-1-FE2-4).
  const abortAllSuggestRequests = useCallback(() => {
    clearSuggestDebounceTimer();
    for (const timerId of suggestRetryTimersRef.current) {
      window.clearTimeout(timerId);
    }
    suggestRetryTimersRef.current.clear();
    for (const controller of suggestAbortControllersRef.current) {
      controller.abort();
    }
    suggestAbortControllersRef.current.clear();
  }, [clearSuggestDebounceTimer]);

  const {
    semanticSuggest,
    semanticAvailable,
    semanticExternal,
    setSemanticSuggest,
    isPending: semanticTogglePending,
    isSemanticUnavailableError,
    clearError: clearSemanticError,
  } = useSemanticSuggestSetting();
  const semanticSuggestRef = useRef(semanticSuggest);
  semanticSuggestRef.current = semanticSuggest;
  const semanticAvailableRef = useRef(semanticAvailable);
  semanticAvailableRef.current = semanticAvailable;
  const [actionActiveKey, setActionActiveKey] = useState<'action:more' | 'action:create' | null>(null);
  const [localNoMatch, setLocalNoMatch] = useState<{ readonly query: string } | null>(null);
  const [rateLimitedSeconds, setRateLimitedSeconds] = useState<number | null>(null);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [loadMoreBusy, setLoadMoreBusy] = useState(false);
  const [liveMessage, setLiveMessage] = useState('');
  const [guardKind, setGuardKind] = useState<'search' | 'tag' | null>(null);
  const [actionErrorCode, setActionErrorCode] = useState<ContentErrorCode | null>(null);

  // 18b quick-add state
  const [activePlan, setActivePlan] = useState<QuickAddSavePlan | null>(null);
  activePlanRef.current = activePlan;
  const [, setPlanRenderTick] = useState(0);
  const [targetTagLimitCount, setTargetTagLimitCount] = useState<number | null>(null);
  const [dupPickerState, setDupPickerState] = useState<DupPickerModalState | null>(null);
  const lockNoticeSnapshot = useSyncExternalStore(
    subscribeLockClearedNotice,
    getLockClearedNoticeSnapshot,
    () => null,
  );

  const isVaultUnlocked = vault ? vault.state === 'unlocked' : true;
  const isVaultLocked = !isVaultUnlocked;

  // Resolve active user ID reactively via `subscribeUserChanged` (advisor-dec-199, advisor-dec-205, FU7),
  // session/device broadcasts, and QueryClient's `['auth', 'me', ...]` cache so both user-switch commits
  // and initial `null -> knownUserId` session resolutions immediately reconcile/hide user-scoped notices
  // without requiring an unmount or parent rerender (advisor-dec-120, HM18B-R1-5, HM18-R3-4, HM18-CI-10).
  const subscribeActiveUserId = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const unsubUserChanged = subscribeUserChanged(() => {
        onStoreChange();
      });
      const unsubBroadcast = subscribeSessionBroadcast(() => {
        onStoreChange();
      });
      const unsubPurge = subscribeDevicePurge(() => {
        onStoreChange();
      });
      const unsubCache = queryClient
        ? queryClient.getQueryCache().subscribe((event) => {
            const key = event.query?.queryKey;
            if (Array.isArray(key) && key[0] === 'auth' && key[1] === 'me') {
              onStoreChange();
            }
          })
        : () => {};
      return () => {
        unsubUserChanged();
        unsubBroadcast();
        unsubPurge();
        unsubCache();
      };
    },
    [queryClient],
  );
  // Note (RV-C-FE-3): preferring `getKnownDeviceSessionUserId()` before `['auth', 'me']` depends on the restored
  // QueryCache subscription above, because `login()`/`signup()` call `commitAuthenticatedUser` before `setKnownDeviceSessionUserId`.
  const getActiveUserIdSnapshot = useCallback((): string | null => {
    const knownUserId = getKnownDeviceSessionUserId();
    if (knownUserId) {
      return knownUserId;
    }
    if (queryClient) {
      const meQueries = queryClient.getQueriesData<Me | null>({ queryKey: ['auth', 'me'] });
      for (let i = meQueries.length - 1; i >= 0; i -= 1) {
        const data = meQueries[i]?.[1];
        if (data?.user?.id) {
          return data.user.id;
        }
      }
    }
    return null;
  }, [queryClient]);
  const activeUserId = useSyncExternalStore(
    subscribeActiveUserId,
    getActiveUserIdSnapshot,
    () => null,
  );
  activeUserIdRef.current = activeUserId;

  const unconfirmedSaves = useUnconfirmedSavesForUser(activeUserId);

  useEffect(() => {
    reconcileUnconfirmedSavesUser(activeUserId);
    reconcileLockClearedNoticeUser(activeUserId);
  }, [activeUserId]);

  // RV-T9-FE3-2: synchronize `semanticEnabled` in merge state from `Me.settings.semantic_suggest` on user switch / Me cache updates.
  useEffect(() => {
    dispatchMerge({
      type: 'sync_semantic_enabled',
      enabled: semanticSuggest,
    });
  }, [activeUserId, dispatchMerge, semanticSuggest]);

  const visibleUnconfirmedRecord =
    isVaultUnlocked && unconfirmedSaves.length > 0
      ? unconfirmedSaves[unconfirmedSaves.length - 1]!
      : null;
  const visibleLockClearedNoticeKind =
    isVaultUnlocked &&
    lockNoticeSnapshot !== null &&
    ((lockNoticeSnapshot.userId === null && activeUserId === null) ||
      (lockNoticeSnapshot.userId !== null && lockNoticeSnapshot.userId === activeUserId))
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

  /**
   * Single helper for all omnibox-owned programmatic writes (`setDraft(value)` — plan section 2.1 rule 1 & 3, M4/FE-21):
   * writes `setInputValue` + `inputValueRef` + `textareaRef.current.value`, then calls `gate.syncOwnWrite(value)`.
   */
  const setDraft = useCallback(
    (value: string) => {
      setInputValue(value);
      inputValueRef.current = value;
      if (textareaRef.current) {
        textareaRef.current.value = value;
        syncTextareaHeight(textareaRef.current);
      }
      if (value === '') {
        // A cleared draft (save done, Esc, reset) can no longer target a Tab-pinned item.
        pinnedItemRef.current = null;
      }
      gateRef.current?.syncOwnWrite(value);
      setTabCannotFill(false);
      setGateRenderTick((prev) => prev + 1);
    },
    [syncTextareaHeight],
  );

  const resolveSuggestLimit = useCallback((): SuggestLimit => {
    if (typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 768) {
      return SUGGEST_MOBILE_LIMIT;
    }
    return SUGGEST_DEFAULT_LIMIT;
  }, []);

  /** Closes the dropdown and forgets every row, in-flight request and transient status line (plan 2.24 item 2). */
  const closeListbox = useCallback(
    (clearLive: boolean) => {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
      searchCursorRef.current = null;
      abortAllSuggestRequests();
      clearLiveAnnounceTimer();
      dispatchMerge({ type: 'close_gate', keepLocalTagCache: false });
      setActionActiveKey(null);
      setLocalNoMatch(null);
      setRateLimitedSeconds(null);
      setLoadMoreBusy(false);
      setShowSkeleton(false);
      clearSemanticError();
      if (clearLive) {
        setLiveMessage('');
      }
    },
    [abortAllSuggestRequests, clearLiveAnnounceTimer, clearSemanticError, dispatchMerge],
  );

  const getSemanticContext = useCallback(
    () => ({
      semanticAvailable: semanticAvailableRef.current,
      semanticSuggest: semanticSuggestRef.current,
    }),
    [],
  );

  /**
   * Sends ONE `/suggest` leg (`semantic=0` or `semantic=1`) for generation `gen`.
   * - A response of a stale generation / reset epoch / other user / aborted request is dropped without any state change.
   * - 429 keeps the rows and retries at most once after `Retry-After`, re-running the gate at send time; other failures
   *   keep the rows too. Never a toast, never red text while typing (plan 2.6, dec-287).
   */
  const sendSuggestLeg = useCallback(
    (params: SuggestLegParams) => {
      const { decision, semanticFlag, gen, limit, userId, epoch, expectSemantic, isRetry } = params;
      const controller = new AbortController();
      suggestAbortControllersRef.current.add(controller);
      const isStale = () =>
        controller.signal.aborted ||
        resetEpochRef.current !== epoch ||
        activeUserIdRef.current !== userId ||
        mergeStateRef.current.queryGen !== gen;

      void (async () => {
        try {
          const res: SuggestResponse = await fetchSuggest(
            {
              ...(decision.q !== undefined ? { q: decision.q } : {}),
              scope: decision.scope,
              limit,
              semantic: semanticFlag,
            },
            { signal: controller.signal },
          );
          if (isStale()) {
            return;
          }

          if (queryClient && isCacheableSearchResponse(res)) {
            const cacheKey = buildSuggestQueryKey({
              userId,
              scope: decision.scope,
              limit,
              requestMode: decision.requestMode,
              semanticSuggestSetting: semanticSuggestRef.current,
              generationId: res.generation,
              qn: decision.qn,
            });
            if (cacheKey) {
              queryClient.setQueryDefaults(cacheKey, SEARCH_QUERY_CACHE_OPTIONS);
              queryClient.setQueryData(cacheKey, res, {
                updatedAt: Date.now(),
              });
            }
          }

          dispatchMerge({
            type: 'receive_suggest',
            gen,
            qn: decision.qn,
            response: res,
            expectSemantic,
          });
        } catch (error) {
          if (isStale()) {
            return;
          }
          const retryAfter = getRateLimitRetryAfterSeconds(error);
          const legKey = `${gen}:${semanticFlag}`;
          if (
            retryAfter !== null &&
            !isRetry &&
            retryAfter <= MAX_SUGGEST_RETRY_AFTER_SECONDS &&
            !retriedLegsRef.current.has(legKey)
          ) {
            retriedLegsRef.current.add(legKey);
            const timerId = window.setTimeout(() => {
              suggestRetryTimersRef.current.delete(timerId);
              if (
                resetEpochRef.current !== epoch ||
                activeUserIdRef.current !== userId ||
                mergeStateRef.current.queryGen !== gen
              ) {
                return;
              }
              // Re-run the gate at send time: the draft may have changed or become unclean (2.24 item 8).
              const fresh = gateRef.current?.decideKeystroke(
                getSemanticContext(),
                textareaRef.current?.value ?? inputValueRef.current,
              );
              if (
                fresh === undefined ||
                !fresh.canSend ||
                fresh.qn !== decision.qn ||
                fresh.scope !== decision.scope ||
                !fresh.semanticFlags.includes(semanticFlag)
              ) {
                if (semanticFlag === 0) setLexicalFailedGen(gen);
                return;
              }
              sendSuggestLegRef.current?.({ ...params, decision: fresh, isRetry: true });
            }, Math.max(1, retryAfter) * 1000);
            suggestRetryTimersRef.current.add(timerId);
            return;
          }
          if (semanticFlag === 1) {
            dispatchMerge({ type: 'semantic_leg_failed', gen, aborted: false });
          } else {
            setLexicalFailedGen(gen);
          }
        } finally {
          suggestAbortControllersRef.current.delete(controller);
        }
      })();
    },
    [dispatchMerge, getSemanticContext, queryClient],
  );
  sendSuggestLegRef.current = sendSuggestLeg;

  const executeSuggestTick = useCallback(
    (decisionOverride?: KeystrokeSendDecision) => {
      const gate = gateRef.current;
      if (!gate) return;
      const currentDomVal = textareaRef.current?.value ?? inputValueRef.current;
      const decision =
        decisionOverride ?? gate.decideKeystroke(getSemanticContext(), currentDomVal);

      if (!decision.canSend) {
        if (decision.gateClosed) {
          abortAllSuggestRequests();
          dispatchMerge({
            type: 'close_gate',
            keepLocalTagCache: decision.keepLocalTagCacheRows,
          });
        }
        return;
      }

      const userId = activeUserIdRef.current;
      if (!userId) {
        return;
      }

      abortAllSuggestRequests();
      const limit = resolveSuggestLimit();
      const expectSemantic = decision.allowSemantic && decision.semanticFlags.includes(1);
      const startedState = dispatchMerge({
        type: 'start_query',
        qn: decision.qn,
        scope: decision.scope,
        limit,
        expectSemantic,
      });
      const gen = startedState.queryGen;
      const epoch = resetEpochRef.current;

      for (const semanticFlag of decision.semanticFlags) {
        sendSuggestLeg({
          decision,
          semanticFlag,
          gen,
          limit,
          userId,
          epoch,
          expectSemantic,
          isRetry: false,
        });
      }
    },
    [
      abortAllSuggestRequests,
      dispatchMerge,
      getSemanticContext,
      resolveSuggestLimit,
      sendSuggestLeg,
    ],
  );

  const scheduleKeystrokeSuggest = useCallback(() => {
    const gate = gateRef.current;
    if (!gate) return;
    const currentDomVal = textareaRef.current?.value ?? inputValueRef.current;
    const decision = gate.decideKeystroke(getSemanticContext(), currentDomVal);

    if (!decision.canSend) {
      clearSuggestDebounceTimer();
      if (decision.gateClosed) {
        abortAllSuggestRequests();
        dispatchMerge({
          type: 'close_gate',
          keepLocalTagCache: decision.keepLocalTagCacheRows,
        });
      }
      return;
    }

    // Rule 6: the empty draft sends `recent` only on focus. Clearing the draft drops the rows of the old query.
    if (decision.mode === 'recent') {
      abortAllSuggestRequests();
      dispatchMerge({ type: 'close_gate', keepLocalTagCache: false });
      return;
    }

    clearSuggestDebounceTimer();
    suggestDebounceTimerRef.current = window.setTimeout(() => {
      suggestDebounceTimerRef.current = null;
      executeSuggestTick();
    }, SUGGEST_DEBOUNCE_MS);
  }, [
    abortAllSuggestRequests,
    clearSuggestDebounceTimer,
    dispatchMerge,
    executeSuggestTick,
    getSemanticContext,
  ]);

  /**
   * Enter without an active row: `GET /search` page 1 into the listbox (plan 2.9, 2.24 items 1/8/9, FE-C25).
   * - Normalised-empty `q` (`!!!`, lone `#`) -> local no-match, no request (FE-17).
   * - A draft the keystroke gate would not send (tainted, colon, `#`) goes out as `semantic=0` (decided by the gate).
   */
  const runEnterSearch = useCallback(() => {
    const gate = gateRef.current;
    if (!gate) return;
    const draft = textareaRef.current?.value ?? inputValueRef.current;
    const decision = gate.decideEnterSearch(getSemanticContext(), draft);

    if (decision.isLocalEmptyMatch) {
      abortAllSuggestRequests();
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
      searchCursorRef.current = null;
      dispatchMerge({ type: 'close_gate', keepLocalTagCache: false });
      setActionActiveKey(null);
      setRateLimitedSeconds(null);
      const shown = trimUnicodeWhiteSpace(draft);
      setLocalNoMatch({ query: shown });
      setLiveMessage(tSearchLive('noMatch', { query: shown }));
      return;
    }
    if (!decision.canSearch) {
      closeListbox(true);
      return;
    }
    const userId = activeUserIdRef.current;
    if (!userId) {
      return;
    }

    abortAllSuggestRequests();
    searchAbortRef.current?.abort();
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const epoch = resetEpochRef.current;
    setActionErrorCode(null);
    setLocalNoMatch(null);
    setRateLimitedSeconds(null);
    setActionActiveKey(null);
    setLoadMoreBusy(false);
    searchCursorRef.current = { q: decision.q, scope: decision.scope };

    // RV-T9-FE3-1: always pass `expectSemantic` explicitly on the first `/search` page (default false).
    const expectSemantic = decision.semantic === 1;
    const startedState = dispatchMerge({
      type: 'start_query',
      qn: decision.qn,
      scope: decision.scope,
      limit: SEARCH_DEFAULT_LIMIT,
      expectSemantic,
    });
    const gen = startedState.queryGen;
    const isStale = () =>
      controller.signal.aborted ||
      resetEpochRef.current !== epoch ||
      activeUserIdRef.current !== userId ||
      mergeStateRef.current.queryGen !== gen;

    void (async () => {
      try {
        const res: SearchResponse = await fetchSearch(
          {
            q: decision.q,
            scope: decision.scope,
            limit: SEARCH_DEFAULT_LIMIT,
            semantic: decision.semantic,
          },
          { signal: controller.signal },
        );
        if (isStale()) {
          return;
        }
        if (queryClient && isCacheableSearchResponse(res)) {
          const cacheKey = buildSearchQueryKey({
            userId,
            scope: decision.scope,
            limit: SEARCH_DEFAULT_LIMIT,
            requestMode: decision.requestMode,
            semanticSuggestSetting: semanticSuggestRef.current,
            generationId: res.generation,
            qn: decision.qn,
          });
          if (cacheKey) {
            queryClient.setQueryDefaults(cacheKey, SEARCH_QUERY_CACHE_OPTIONS);
            queryClient.setQueryData(cacheKey, res, { updatedAt: Date.now() });
          }
        }
        dispatchMerge({
          type: 'receive_search_first_page',
          gen,
          qn: decision.qn,
          response: res,
          expectSemantic,
        });
      } catch (error) {
        if (isStale()) {
          return;
        }
        setLexicalFailedGen(gen);
        const retryAfter = getRateLimitRetryAfterSeconds(error);
        if (retryAfter !== null) {
          // Plan 2.6: Enter while rate limited -> muted line, rows kept, no toast.
          setRateLimitedSeconds(retryAfter);
          return;
        }
        const code = getContentErrorI18nKey(error).replace(
          /^content\.errors\./,
          '',
        ) as ContentErrorCode;
        setActionErrorCode(code);
      } finally {
        if (searchAbortRef.current === controller) {
          searchAbortRef.current = null;
        }
      }
    })();
  }, [
    abortAllSuggestRequests,
    closeListbox,
    dispatchMerge,
    getSemanticContext,
    queryClient,
    tSearchLive,
  ]);

  /** "Load more": next `/search` cursor page, always lexical (`semantic=0`, 2.24 item 8), appended with `(kind,id)` dedupe. */
  const loadMoreResults = useCallback(() => {
    const snapshot = mergeStateRef.current.snapshot;
    const cursorContext = searchCursorRef.current;
    const userId = activeUserIdRef.current;
    if (
      !snapshot ||
      snapshot.source !== 'search' ||
      snapshot.nextCursor === null ||
      cursorContext === null ||
      userId === null ||
      loadMoreAbortRef.current !== null
    ) {
      return;
    }
    const gen = snapshot.gen;
    const cursor = snapshot.nextCursor;
    const epoch = resetEpochRef.current;
    const controller = new AbortController();
    loadMoreAbortRef.current = controller;
    setLoadMoreBusy(true);
    setRateLimitedSeconds(null);
    setActionErrorCode(null);
    const isStale = () =>
      controller.signal.aborted ||
      resetEpochRef.current !== epoch ||
      activeUserIdRef.current !== userId ||
      mergeStateRef.current.queryGen !== gen;

    void (async () => {
      try {
        const res: SearchResponse = await fetchSearch(
          {
            q: cursorContext.q,
            scope: cursorContext.scope,
            limit: SEARCH_DEFAULT_LIMIT,
            cursor,
            semantic: 0,
          },
          { signal: controller.signal },
        );
        if (isStale()) {
          return;
        }
        dispatchMerge({ type: 'receive_search_cursor_page', gen, response: res });
      } catch (error) {
        if (isStale()) {
          return;
        }
        const retryAfter = getRateLimitRetryAfterSeconds(error);
        if (retryAfter !== null) {
          setRateLimitedSeconds(retryAfter);
          return;
        }
        const code = getContentErrorI18nKey(error).replace(
          /^content\.errors\./,
          '',
        ) as ContentErrorCode;
        setActionErrorCode(code);
      } finally {
        if (loadMoreAbortRef.current === controller) {
          loadMoreAbortRef.current = null;
          setLoadMoreBusy(false);
        }
      }
    })();
  }, [dispatchMerge]);


  const removeOmniboxSearchQueries = useCallback(() => {
    if (!queryClient) return;
    queryClient.removeQueries({
      predicate: (query) => isOmniboxSearchQueryKey(query.queryKey),
    });
  }, [queryClient]);

  const abortAndClearSavePlan = useCallback(() => {
    savePlanStartAbortRef.current?.abort();
    savePlanStartAbortRef.current = null;
    savePlanStartingRef.current = false;
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
  const resetOmniboxOnLockOrUserChange = useCallback(
    (opts: { readonly recordLockNotice: boolean }) => {
      resetEpochRef.current += 1;
      abortAllSuggestRequests();
      clearNativeEditTimers();
      clearLiveAnnounceTimer();
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      loadMoreAbortRef.current?.abort();
      loadMoreAbortRef.current = null;
      searchCursorRef.current = null;
      pinnedItemRef.current = null;
      retriedLegsRef.current.clear();
      createAbortRef.current?.abort();
      createAbortRef.current = null;
      createPendingRef.current = false;
      savePlanStartAbortRef.current?.abort();
      savePlanStartAbortRef.current = null;
      savePlanStartingRef.current = false;
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

      if (opts.recordLockNotice && hadDraftOrPlan) {
        recordLockClearedNotice({
          userId: activeUserIdRef.current,
          kind: hadCommittedMeta ? 'plan' : 'draft',
        });
      }
      setDraft('');
      gateRef.current?.reset();
      dispatchMerge({ type: 'reset' });
      setActionActiveKey(null);
      setLocalNoMatch(null);
      setRateLimitedSeconds(null);
      setLoadMoreBusy(false);
      setShowSkeleton(false);
      setLexicalFailedGen(-1);
      clearSemanticError();
      liveAnnouncedRef.current = { gen: -1, nearCount: 0, degraded: false };
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
    },
    [
      abortAllSuggestRequests,
      clearLiveAnnounceTimer,
      clearNativeEditTimers,
      clearSemanticError,
      dispatchMerge,
      removeOmniboxSearchQueries,
      setDraft,
      undoToast,
    ],
  );

  useEffect(() => {
    if (!vault?.registerSecretFormReset) return;
    return vault.registerSecretFormReset(() => {
      resetOmniboxOnLockOrUserChange({ recordLockNotice: true });
    });
  }, [resetOmniboxOnLockOrUserChange, vault]);

  useEffect(() => {
    return subscribeUserChanged(() => {
      resetOmniboxOnLockOrUserChange({ recordLockNotice: false });
    });
  }, [resetOmniboxOnLockOrUserChange]);

  useEffect(() => {
    return () => {
      abortAllSuggestRequests();
      searchAbortRef.current?.abort();
      // RV-T17-2-FE1-8: a late "load more" page must not dispatch / set state after unmount, and the delayed live
      // announcement must not fire on a dead instance.
      loadMoreAbortRef.current?.abort();
      clearLiveAnnounceTimer();
      createAbortRef.current?.abort();
      savePlanStartAbortRef.current?.abort();
      planAbortRef.current?.abort();
    };
  }, [abortAllSuggestRequests, clearLiveAnnounceTimer]);

  // Native `beforeinput`, `input`, `compositionstart`, and `compositionend` listeners on the textarea ref
  // (plan section 2.1 rules 1–2, L3, FE-5a: never React's synthetic `onBeforeInput`).
  useEffect(() => {
    const el = textareaRef.current;
    const gate = gateRef.current;
    if (!el || !gate) return;

    // CI-41431143632-E2E-QA402 / CI-41431143632-SMOKE-LOCKED: these native listeners must only OBSERVE (mutate the
    // gate's own ref state) and must never call a React state setter or dispatch to the merge reducer. In a real
    // browser the native `input` event reaches the textarea listener BEFORE React's root `onChange` listener, and
    // React 19 flushes a sync-lane update scheduled from a native listener in a microtask that runs between the two
    // listeners. That render re-applies the stale controlled `value={inputValue}` to the DOM, wiping the typed /
    // `fill()`ed text before `onChange` can read it (jsdom's script `dispatchEvent` never exposes this).
    // Render ticks and the debounced `/suggest` are therefore driven from `handleInputChange` (React's own event
    // dispatch, after the controlled state is committed) or from a macrotask for composition events.
    const clearNativeInputFlagTimer = () => {
      if (nativeInputFlagTimerRef.current !== null) {
        window.clearTimeout(nativeInputFlagTimerRef.current);
        nativeInputFlagTimerRef.current = null;
      }
    };
    const deferComposition = (fn: () => void) => {
      if (compositionDeferTimerRef.current !== null) {
        window.clearTimeout(compositionDeferTimerRef.current);
      }
      compositionDeferTimerRef.current = window.setTimeout(() => {
        compositionDeferTimerRef.current = null;
        fn();
      }, 0);
    };

    const onNativeBeforeInput = (event: Event) => {
      if (activePlanRef.current?.running) return;
      const inputEvt = event as InputEvent;
      gate.handleBeforeInput({
        inputType: typeof inputEvt.inputType === 'string' ? inputEvt.inputType : undefined,
        data: 'data' in inputEvt ? inputEvt.data : undefined,
        isComposing: 'isComposing' in inputEvt ? Boolean(inputEvt.isComposing) : undefined,
        currentDomValue: el.value,
      });
    };

    const onNativeInput = (event: Event) => {
      if (activePlanRef.current?.running) return;
      const inputEvt = event as InputEvent;
      gate.handleInput({
        inputType: typeof inputEvt.inputType === 'string' ? inputEvt.inputType : undefined,
        data: 'data' in inputEvt ? inputEvt.data : undefined,
        isComposing: 'isComposing' in inputEvt ? Boolean(inputEvt.isComposing) : undefined,
        value: el.value,
      });
      // RV-T17-1-FE2-4: whatever happens next, the old draft's in-flight suggest requests are stale. Aborting only touches
      // refs (no React update), so it is safe inside this native listener.
      abortAllSuggestRequests();
      // Hand off to `handleInputChange` (React `onChange`) which renders + schedules `/suggest` for this edit. If React
      // never fires `onChange` for this event (value unchanged / tracker skipped it), a macrotask fallback re-renders and
      // re-evaluates the gate itself. It runs after the whole event dispatch, so it cannot wipe the controlled value.
      nativeInputPendingRef.current = true;
      clearNativeInputFlagTimer();
      nativeInputFlagTimerRef.current = window.setTimeout(() => {
        nativeInputFlagTimerRef.current = null;
        if (!nativeInputPendingRef.current) return;
        nativeInputPendingRef.current = false;
        // `onChange` never ran for this edit. Adopt the DOM value into the controlled state BEFORE re-rendering, otherwise the
        // render would re-apply the stale controlled value and wipe the typed text (same hazard as CI-41431143632-E2E-QA402).
        // This runs in a macrotask, after the whole event dispatch, so it cannot race React's own onChange.
        const domValue = el.value;
        if (domValue !== inputValueRef.current) {
          inputValueRef.current = domValue;
          setInputValue(domValue);
        }
        setGateRenderTick((prev) => prev + 1);
        scheduleKeystrokeSuggest();
      }, 0);
    };

    const onNativeCompositionStart = () => {
      if (activePlanRef.current?.running) return;
      clearSuggestDebounceTimer();
      gate.handleCompositionStart(el.value);
      deferComposition(() => {
        setGateRenderTick((prev) => prev + 1);
      });
    };

    const onNativeCompositionEnd = (event: Event) => {
      if (activePlanRef.current?.running) return;
      const compEvt = event as CompositionEvent;
      gate.handleCompositionEnd({
        value: el.value,
        data: typeof compEvt.data === 'string' ? compEvt.data : undefined,
      });
      deferComposition(() => {
        setGateRenderTick((prev) => prev + 1);
        scheduleKeystrokeSuggest();
      });
    };

    el.addEventListener('beforeinput', onNativeBeforeInput);
    el.addEventListener('input', onNativeInput);
    el.addEventListener('compositionstart', onNativeCompositionStart);
    el.addEventListener('compositionend', onNativeCompositionEnd);

    return () => {
      el.removeEventListener('beforeinput', onNativeBeforeInput);
      el.removeEventListener('input', onNativeInput);
      el.removeEventListener('compositionstart', onNativeCompositionStart);
      el.removeEventListener('compositionend', onNativeCompositionEnd);
      clearNativeInputFlagTimer();
      nativeInputPendingRef.current = false;
      if (compositionDeferTimerRef.current !== null) {
        window.clearTimeout(compositionDeferTimerRef.current);
        compositionDeferTimerRef.current = null;
      }
    };
  }, [abortAllSuggestRequests, clearSuggestDebounceTimer, scheduleKeystrokeSuggest]);

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

  // Dropdown model derived from the merge snapshot (plan 2.8): visual order === keyboard order === `navKeys`.
  const mergeState = mergeStateRef.current;
  const snapshot = mergeState.snapshot;
  const tagToken = parsed.mode === 'tag-filter' ? parseTagFilterInput(inputValue).token : '';
  const displayQuery = parsed.mode === 'tag-filter' ? `#${tagToken}` : trimmedInput;
  const suggestModel = buildSuggestListModel({
    snapshot,
    localNoMatchQuery: localNoMatch?.query ?? null,
    displayQuery,
    allowMore: true,
    waiting: mergeState.isBusy && lexicalFailedGen !== mergeState.queryGen,
  });
  const listOpen = suggestModel !== null;
  const hasOptionChildren = suggestModel !== null && suggestModel.navKeys.length > 0;
  const candidateActiveKey: SuggestListKey | null = actionActiveKey ?? mergeState.activeKey;
  const activeKey: SuggestListKey | null =
    suggestModel !== null && candidateActiveKey !== null && suggestModel.navKeys.includes(candidateActiveKey)
      ? candidateActiveKey
      : null;
  const activeDescendantId =
    hasOptionChildren && activeKey !== null ? getSuggestOptionDomId(baseId, activeKey) : undefined;
  const listBusy = mergeState.isBusy && lexicalFailedGen !== mergeState.queryGen;
  const waitingForFirstRows = mergeState.isBusy && snapshot === null;
  const semanticEnable409Visible = isSemanticUnavailableError;
  const popoverVisible =
    listOpen ||
    (showSkeleton && waitingForFirstRows && localNoMatch === null) ||
    semanticEnable409Visible ||
    rateLimitedSeconds !== null;

  // advisor-dec-327 (RV-T22-1-FE1-3 / FE1-6), `#omni-pop` only; no send-gate, draft, request or cache logic.
  // (O1b) axe `scrollable-region-focusable` needs a tab-order node on an overflowing region, so the popover gets
  //   tabIndex=0 + role=region + a label ONLY while scrollHeight > clientHeight (a real region that can be scrolled
  //   with the keyboard once it has focus). The textarea keeps focus while typing / arrowing and keeps its
  //   implicit textbox role (dec-152); `aria-activedescendant` is untouched.
  // (P1) at <=639px the popover is bounded to the visual viewport above the undo-toast stack, so the action row
  //   stays reachable (FU10). `--undo-stack-h` is published on <html> by UndoToastProvider while a toast shows.
  useEffect(() => {
    const pop = popRef.current;
    if (!popoverVisible || pop === null || typeof window === 'undefined') {
      setPopScrollable(false);
      return;
    }

    const NARROW_MAX_WIDTH_PX = 639;
    const POP_MAX_HEIGHT_PX = 440;
    const POP_MIN_HEIGHT_PX = 160;
    const POP_BOTTOM_GAP_PX = 24;
    const htmlEl = document.documentElement;

    const measure = () => {
      const el = popRef.current;
      if (el === null) {
        return;
      }
      const narrow = window.innerWidth <= NARROW_MAX_WIDTH_PX;
      if (narrow) {
        const vv = window.visualViewport;
        const viewportH = vv?.height ?? window.innerHeight;
        const viewportTop = vv?.offsetTop ?? 0;
        const popTop = el.getBoundingClientRect().top - viewportTop;
        const stackH = Number.parseFloat(htmlEl.style.getPropertyValue('--undo-stack-h')) || 0;
        const bound = Math.min(
          POP_MAX_HEIGHT_PX,
          viewportH - popTop - stackH - POP_BOTTOM_GAP_PX,
        );
        el.style.maxHeight = `${Math.max(POP_MIN_HEIGHT_PX, Math.floor(bound))}px`;
      } else {
        el.style.removeProperty('max-height');
      }

      const overflowing = el.scrollHeight > el.clientHeight;
      if (!overflowing && document.activeElement === el) {
        // The region is about to lose its tab stop: hand focus back to the textarea first.
        textareaRef.current?.focus();
      }
      setPopScrollable(overflowing);
    };

    measure();
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    resizeObserver?.observe(pop);
    for (const child of Array.from(pop.children)) {
      resizeObserver?.observe(child);
    }
    const mutationObserver =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => measure());
    // Rows arrive / disappear inside the popover, and the toast stack publishes its height on <html>.
    mutationObserver?.observe(pop, { childList: true, subtree: true });
    mutationObserver?.observe(htmlEl, {
      attributes: true,
      attributeFilter: ['style', 'data-undo-stack-active'],
    });
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
      pop.style.removeProperty('max-height');
    };
  }, [popoverVisible]);

  useEffect(() => {
    if (activeKey !== null) {
      const optEl = optionRefs.current[activeKey];
      if (optEl && typeof optEl.scrollIntoView === 'function') {
        optEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [activeKey]);

  // Plan 2.10 pending state: first query, no rows yet -> skeleton rows after 150 ms.
  useEffect(() => {
    if (!waitingForFirstRows) {
      setShowSkeleton(false);
      return;
    }
    const timerId = window.setTimeout(() => {
      setShowSkeleton(true);
    }, SUGGEST_SKELETON_DELAY_MS);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [waitingForFirstRows]);

  // Spoken text only (plan 2.8 rule 6, FE-23): "N suggestions" 500 ms after the rows settle, "added N similar-meaning" when near
  // arrives, degraded once per session. The visible status lines live in `SuggestList`, outside this live region.
  const latestSnapshotRef = useRef(snapshot);
  latestSnapshotRef.current = snapshot;
  useEffect(() => {
    if (snapshot === null) {
      return;
    }
    const last = liveAnnouncedRef.current;
    const total = snapshot.lexical.length + snapshot.near.length;

    if (snapshot.scope === 'tag') {
      const token = parseTagFilterInput(inputValueRef.current).token;
      setLiveMessage(
        total > 0
          ? tOmni('tagLiveCount', { count: total, query: token })
          : tOmni('tagEmptyTitle', { query: token }),
      );
      liveAnnouncedRef.current = { ...last, gen: snapshot.gen, nearCount: 0 };
      return;
    }

    // Reads the LATEST snapshot when the 500 ms timer fires, so a near zone that landed in between is counted too.
    const announceBase = () => {
      const latest = latestSnapshotRef.current ?? snapshot;
      const totalNow = latest.lexical.length + latest.near.length;
      return totalNow > 0
        ? snapshot.source === 'search'
          ? tSearchState('resultCount', { count: totalNow })
          : tSearchLive('suggestionsCount', { count: totalNow })
        : tSearchLive('noMatch', { query: trimUnicodeWhiteSpace(inputValueRef.current) });
    };

    if (last.gen !== snapshot.gen) {
      liveAnnouncedRef.current = { ...last, gen: snapshot.gen, nearCount: snapshot.near.length };
      clearLiveAnnounceTimer();
      if (snapshot.source === 'search') {
        setLiveMessage(announceBase());
      } else {
        liveAnnounceTimerRef.current = window.setTimeout(() => {
          liveAnnounceTimerRef.current = null;
          setLiveMessage(announceBase());
        }, SUGGEST_LIVE_ANNOUNCE_MS);
      }
    } else if (snapshot.near.length > last.nearCount) {
      // While the 500 ms 'N suggestions' timer is still pending it announces the combined total; speak 'added N' only afterwards.
      if (liveAnnounceTimerRef.current === null) {
        setLiveMessage(tSearchLive('nearAppended', { count: snapshot.near.length - last.nearCount }));
      }
      liveAnnouncedRef.current = { ...last, nearCount: snapshot.near.length };
    } else if (snapshot.near.length < last.nearCount) {
      liveAnnouncedRef.current = { ...last, nearCount: snapshot.near.length };
    }

    const afterNear = liveAnnouncedRef.current;
    if (snapshot.nearState === 'degraded' && !afterNear.degraded) {
      liveAnnouncedRef.current = { ...afterNear, degraded: true };
      setLiveMessage(tSearchState('degraded'));
    }
  }, [clearLiveAnnounceTimer, snapshot, tOmni, tSearchLive, tSearchState]);


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
        setDraft('');
        textareaRef.current?.focus();
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
    [closeListbox, invalidateAllContentMetadataCaches, setDraft, tOmni, undoToast],
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
      const capturedClearGeneration = captureUnconfirmedSaveClearGeneration();
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
          setDraft('');
          textareaRef.current?.focus();
          // Mark omnibox as just cleared by save so immediate Ctrl+Z / ⌘Z triggers Undo (plan §2.11 step 4, SPEC §7.8).
          undoToast?.markOmniboxJustCleared(textareaRef.current);
        } else {
          setDraft(currentVal);
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
            recordUnconfirmedSave({
              userId: activeUserId,
              itemId: plan.itemId,
              itemName: plan.itemName,
              source: 'omnibox',
              clearGeneration: capturedClearGeneration,
            });
          }
          plan.op.dispose?.();
          activePlanRef.current = null;
          setActivePlan(null);
          setTargetTagLimitCount(null);
          submittedDraftRef.current = null;
          setDraft('');
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
          setDraft('');
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
      setDraft,
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
      /** Item chosen with Tab: the plan targets this id, no exact-name lookup (plan 2.9, OQ-2). */
      readonly pinnedItem?: PinnedItem | null;
    }) => {
      if (savePlanStartingRef.current || activePlanRef.current?.running) {
        return;
      }
      const { name, tags, body, targetItem, isNewItem } = params;
      const pinnedItem = params.pinnedItem ?? null;

      // Pre-check 20-tag cap before building plan or sending any write request (SPEC §3.4 step 2, plan §2.11 step 2).
      if (!isNewItem && targetItem) {
        const capCheck = checkTargetTagCap(targetItem.tags ?? [], tags);
        if (!capCheck.allowed) {
          setTargetTagLimitCount(capCheck.existingTagCount);
          setActionErrorCode(null);
          return;
        }
      } else if (!isNewItem && pinnedItem) {
        // The suggest row may carry only some of the item's tags (`tag_total`): count the rest as occupied. Tags the
        // item already has but the row hides are counted as new here, so this can only over-block, never under-block.
        const capCheck = checkTargetTagCap(pinnedItem.tags, tags);
        const existingCount = Math.max(pinnedItem.tagTotal, pinnedItem.tags.length);
        if (existingCount + capCheck.newUnassignedCount > QUICK_ADD_TARGET_TAG_CAP) {
          setTargetTagLimitCount(existingCount);
          setActionErrorCode(null);
          return;
        }
      }

      setTargetTagLimitCount(null);
      setActionErrorCode(null);

      if (!vault) {
        return;
      }

      const startResetEpoch = resetEpochRef.current;
      const startUserId = activeUserIdRef.current;
      const startController = new AbortController();
      savePlanStartAbortRef.current = startController;
      savePlanStartingRef.current = true;

      const isStartStale = (): boolean =>
        startController.signal.aborted ||
        resetEpochRef.current !== startResetEpoch ||
        (startUserId !== null && activeUserIdRef.current !== startUserId);

      try {
        let effectiveVault = vault;
        if (!vault.vaultMeta?.vault_key_id && typeof vault.reloadVaultMeta === 'function') {
          const loadedMeta = await vault.reloadVaultMeta();
          if (isStartStale()) {
            return;
          }
          if (!loadedMeta?.vault_key_id) {
            // If reloadVaultMeta resolves without a vault key (e.g. session signed out, user changed, or provider 404 locked the vault), return silently (HM18-R3-2, HM18-R4-4).
            return;
          }
          effectiveVault = { ...vault, vaultMeta: loadedMeta };
        }

        if (isStartStale()) {
          return;
        }

        const plan = await createQuickAddSavePlan({
          name,
          tags,
          body,
          targetItem,
          isNewItem,
          pinnedItemId: !isNewItem && targetItem === null ? (pinnedItem?.id ?? null) : null,
          vault: effectiveVault,
        });

        if (isStartStale() || !plan.op.isCurrent()) {
          plan.op.dispose?.();
          return;
        }

        submittedDraftRef.current = textareaRef.current?.value ?? inputValueRef.current;
        activePlanRef.current = plan;
        setActivePlan(plan);
        await runPlanExecution(plan);
      } catch (error) {
        if (isStartStale()) {
          return;
        }
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
      } finally {
        if (savePlanStartAbortRef.current === startController) {
          savePlanStartAbortRef.current = null;
          savePlanStartingRef.current = false;
        }
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
        unlockToSaveBtnRef.current?.focus();
        return;
      }
      if (
        lookupPendingRef.current ||
        savePlanStartingRef.current ||
        activePlanRef.current?.running
      ) {
        return;
      }

      if (activeUserId) {
        dismissUnconfirmedSave({ userId: activeUserId, source: 'omnibox' });
      }
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

      // An item picked with Tab is pinned by id: save to it directly, no lookup (plan 2.9, OQ-2). Editing the name part of
      // the draft drops the pin (`handleInputChange`), so this only matches an untouched `name:` prefix.
      const pinnedItem = pinnedItemRef.current;
      if (pinnedItem !== null && pinnedItem.name === currentParsed.name) {
        await startSavePlanForTarget({
          name: currentParsed.name,
          tags: currentParsed.tags,
          body: currentParsed.body,
          targetItem: null,
          isNewItem: false,
          pinnedItem,
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
    [activeUserId, isVaultUnlocked, queryClient, startSavePlanForTarget],
  );

  const handleDupPickerPick = useCallback(
    (selection: DupPickerSelection) => {
      const pending = dupPickerState;
      setDupPickerState(null);
      textareaRef.current?.focus();
      if (!pending) return;
      if (
        lookupPendingRef.current ||
        savePlanStartingRef.current ||
        activePlanRef.current?.running
      ) {
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

  /** Click / Enter on an option: open the item or tag, create an empty item, or load the next page. */
  const executeKey = useCallback(
    (key: SuggestListKey) => {
      if (key === 'action:create') {
        void createEmptyItemWithName(textareaRef.current?.value ?? inputValueRef.current);
        return;
      }
      if (key === 'action:more') {
        loadMoreResults();
        return;
      }
      const snap = mergeStateRef.current.snapshot;
      const row: SuggestRow | undefined = snap
        ? [...snap.lexical, ...snap.near].find((candidate) => getRowKey(candidate) === key)
        : undefined;
      if (!row) {
        return;
      }
      if (row.kind === 'item') {
        closeListbox(false);
        router?.push(`/app/items/${row.id}`);
        return;
      }
      closeListbox(false);
      setDraft('');
      router?.push(`/app?tag=${encodeURIComponent(row.id)}`);
    },
    [closeListbox, createEmptyItemWithName, loadMoreResults, router, setDraft],
  );


  const handleTextareaFocus = () => {
    if (activePlanRef.current?.running) return;
    const gate = gateRef.current;
    if (!gate) return;
    const currentDomVal = textareaRef.current?.value ?? inputValueRef.current;
    if (trimUnicodeWhiteSpace(currentDomVal) === '') {
      const decision = gate.decideKeystroke(getSemanticContext(), currentDomVal);
      if (decision.canSend && decision.mode === 'recent') {
        executeSuggestTick(decision);
      }
    }
  };

  const handleInputChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    // Prevent silent data loss or draft/plan divergence while a save plan is actively running (HM18B-R1-3).
    if (activePlanRef.current?.running) {
      setDraft(inputValueRef.current);
      return;
    }
    const nextValue = event.target.value;
    setInputValue(nextValue);
    inputValueRef.current = nextValue;
    // Reconcile non-native/synthetic changes (e.g. fireEvent.change in tests or browser autofill without native input)
    // inside the event handler so render stays pure (RV-T17-1-FE1-8).
    gateRef.current?.decideKeystroke(getSemanticContext(), nextValue);
    setTabCannotFill(false);
    // Native `input` only observed this edit; the render and the debounced `/suggest` are driven from here (React's own
    // event dispatch) so no React update is ever scheduled between the native listener and `onChange` (CI-41431143632-E2E-QA402).
    nativeInputPendingRef.current = false;
    setGateRenderTick((prev) => prev + 1);
    setGuardKind(null);
    setActionErrorCode(null);
    clearLockClearedNotice();
    setTargetTagLimitCount(null);
    undoToast?.clearOmniboxJustCleared();
    if (activePlanRef.current && !activePlanRef.current.running) {
      abortAndClearSavePlan();
    }

    syncTextareaHeight(event.target);

    // Any edit invalidates a pending Enter search, "load more" page and transient status line (HM18A-R1-6, HM18A-R2-4).
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
    searchCursorRef.current = null;
    clearLiveAnnounceTimer();
    setLocalNoMatch(null);
    setRateLimitedSeconds(null);
    setActionActiveKey(null);
    setLoadMoreBusy(false);
    clearSemanticError();

    const nextParsed = parseQuickAdd(nextValue);
    // The Tab-pinned item only survives while the name part of the draft is unchanged (plan 2.9).
    const pinned = pinnedItemRef.current;
    if (
      pinned !== null &&
      !((nextParsed.mode === 'add' || nextParsed.mode === 'add-invalid') && nextParsed.name === pinned.name)
    ) {
      pinnedItemRef.current = null;
    }

    // Rows of an Enter search belong to the previous draft; the next suggest response opens a fresh dropdown.
    if (mergeStateRef.current.snapshot?.source === 'search') {
      dispatchMerge({ type: 'close_gate', keepLocalTagCache: false });
    }

    if (nextParsed.mode === 'tag-filter') {
      // Plan 2.8 rule 7: cached tag rows show instantly with the first row active; the server response replaces them.
      const { token } = parseTagFilterInput(nextValue);
      dispatchMerge({
        type: 'seed_tag_cache',
        qn: token,
        tags: filterCachedTagsByPrefix(getCachedTags(), token),
      });
    }
    scheduleKeystrokeSuggest();
  };

  const setActiveByKey = (key: SuggestListKey) => {
    if (isActionKey(key)) {
      setActionActiveKey(key);
      dispatchMerge({ type: 'set_active_key', activeKey: null });
      return;
    }
    setActionActiveKey(null);
    dispatchMerge({ type: 'set_active_key', activeKey: key });
  };

  const moveActive = (direction: 1 | -1) => {
    if (!suggestModel || suggestModel.navKeys.length === 0) return;
    const keys = suggestModel.navKeys;
    const current = activeKey !== null ? keys.indexOf(activeKey) : -1;
    const nextIndex =
      current < 0
        ? direction === 1
          ? 0
          : keys.length - 1
        : (current + direction + keys.length) % keys.length;
    const nextKey = keys[nextIndex];
    if (nextKey !== undefined) {
      setActiveByKey(nextKey);
    }
  };

  const handleEnterKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const isCtrl = event.ctrlKey || event.metaKey;

    if (parsed.mode === 'tag-filter') {
      // Ctrl+Enter in #… mode is ignored (plan §2.11, P4FE5-7).
      if (isCtrl) return;

      const { searchable } = parseTagFilterInput(inputValue);
      if (!searchable) {
        closeListbox(false);
        setGuardKind('tag');
        setLiveMessage(tOmni('tagGuardTitle'));
        return;
      }

      setGuardKind(null);
      // The active row (the first cached / server tag in `#` mode) opens; otherwise `GET /search?scope=tag&semantic=0`
      // (plan 2.8 rule 7, 2.24 item 9, FE-C25). No more `GET /tags?q=` on Enter.
      if (activeKey !== null) {
        executeKey(activeKey);
        return;
      }
      runEnterSearch();
      return;
    }

    if (parsed.mode === 'search') {
      // An active row (also in the `recent` list of an empty draft) opens/executes before any search.
      if (!isCtrl && activeKey !== null) {
        executeKey(activeKey);
        return;
      }

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

      runEnterSearch();
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
    abortAllSuggestRequests();
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    abortAndClearSavePlan();
    setDraft('');
    closeListbox(true);
    setGuardKind(null);
    setActionErrorCode(null);
    textareaRef.current?.focus();
  };

  const handleTabFillKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    // Plan section 2.9 (RV-T17-1-FE1-5): Tab is intercepted only when the listbox is open and a ROW (not an action) is
    // active; otherwise Tab keeps default browser focus navigation.
    if (activeKey === null || isActionKey(activeKey)) {
      return false;
    }
    const snap = mergeStateRef.current.snapshot;
    const row: SuggestRow | undefined = snap
      ? [...snap.lexical, ...snap.near].find((candidate) => getRowKey(candidate) === activeKey)
      : undefined;
    if (!row) {
      return false;
    }

    event.preventDefault();

    if (row.kind === 'tag') {
      const disp = row.display;
      if (disp === '' || /[\s#:：]/u.test(disp)) {
        setTabCannotFill(true);
        setLiveMessage(tSearchTab('cannotFill'));
        return true;
      }
      const cur = textareaRef.current?.value ?? inputValueRef.current;
      const replaced = cur.replace(/^(\s*)#[^\s:：]*\s*/, `$1#${disp} `);
      const nextDraft = replaced !== cur ? replaced : `#${disp} `;
      setDraft(nextDraft);
      scheduleKeystrokeSuggest();
      return true;
    }

    // Item: `name: ` (add mode, plan 2.9). Names with `:`/`：`, a leading `#` or a line break cannot be typed back as a
    // `name:` prefix, so Tab does nothing but say so. Whitespace inside the name is fine (`wifi guest: `).
    const itemName = row.name;
    if (
      itemName === '' ||
      itemName.includes(':') ||
      itemName.includes('：') ||
      itemName.startsWith('#') ||
      /[\r\n]/.test(itemName)
    ) {
      setTabCannotFill(true);
      setLiveMessage(tSearchTab('cannotFill'));
      return true;
    }
    setDraft(`${itemName}: `);
    // Pin AFTER `setDraft` (which unpins on an empty draft): the save targets this item id, no exact-name lookup (OQ-2).
    pinnedItemRef.current = {
      id: row.id,
      name: itemName,
      tags: row.tags,
      tagTotal: row.tag_total,
    };
    scheduleKeystrokeSuggest();
    return true;
  };

  /** Toggle ≈ on a clean draft re-sends `semantic=1` for the current generation (2.24 item 8: unclean -> PATCH only). */
  const reissueSemanticLeg = () => {
    const gate = gateRef.current;
    const snap = mergeStateRef.current.snapshot;
    const userId = activeUserIdRef.current;
    if (!gate || !snap || !userId || snap.source !== 'suggest') return;
    const draft = textareaRef.current?.value ?? inputValueRef.current;
    const context = { semanticAvailable: semanticAvailableRef.current, semanticSuggest: true };
    if (!gate.decideSemanticReissue(context, draft).canSendSemantic) return;
    const decision = gate.decideKeystroke(context, draft);
    if (!decision.canSend || !decision.semanticFlags.includes(1)) return;
    dispatchMerge({ type: 'toggle_semantic_on_pending' });
    sendSuggestLeg({
      decision,
      semanticFlag: 1,
      gen: mergeStateRef.current.queryGen,
      limit: snap.limit as SuggestLimit,
      userId,
      epoch: resetEpochRef.current,
      expectSemantic: true,
      isRetry: false,
    });
  };

  const handleToggleSemantic = async () => {
    const turnOn = !semanticSuggest;
    if (!turnOn) {
      const hadNear = (mergeStateRef.current.snapshot?.near.length ?? 0) > 0;
      const ok = await setSemanticSuggest(false);
      if (ok && hadNear) {
        setLiveMessage(tSearchLive('nearHidden'));
      }
      return;
    }
    // 409 `semantic_unavailable` -> the hook exposes `isSemanticUnavailableError` and the muted line shows in the dropdown.
    const ok = await setSemanticSuggest(true);
    if (ok) {
      reissueSemanticLeg();
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(event)) {
      return;
    }
    if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (handleTabFillKey(event)) {
        return;
      }
    }

    if (event.key === 'ArrowDown') {
      if (!suggestModel || suggestModel.navKeys.length === 0) return;
      event.preventDefault();
      moveActive(1);
      return;
    }

    if (event.key === 'ArrowUp') {
      if (!suggestModel || suggestModel.navKeys.length === 0) return;
      event.preventDefault();
      moveActive(-1);
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
      if (popoverVisible) {
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
  const helpTextKey = gateRef.current
    ? resolveOmniboxHelpTextKey(gateRef.current.getState(), {
        semanticExternal,
        currentValue: inputValue,
      })
    : 'search.help.sentToServerExternal';
  const showSearchHint =
    parsed.mode === 'search' && (hasNonEmptyInput || tabCannotFill) && guardKind === null;
  const showTagHint =
    parsed.mode === 'tag-filter' && (hasNonEmptyInput || tabCannotFill) && guardKind === null;
  const showHint = !isAddLike && (showSearchHint || showTagHint);
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
          onFocus={handleTextareaFocus}
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
        {semanticAvailable ? (
          <button
            type="button"
            data-omni-sem-toggle=""
            data-testid="omnibox-semantic-toggle"
            aria-pressed={semanticSuggest}
            aria-label={tSearchToggle('semanticAriaLabel')}
            disabled={semanticTogglePending}
            // RV-T17-2-FE1-5: WebKit does not focus a clicked <button>; without this the textarea blurs with a null
            // relatedTarget, `handleRootBlur` closes the listbox and the re-issue finds no snapshot.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              void handleToggleSemantic();
            }}
            className="omni-sem-btn mono"
          >
            <span aria-hidden="true">≈</span>
          </button>
        ) : null}
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
                onClick={() => {
                  if (activeUserId) {
                    dismissUnconfirmedSave({
                      userId: activeUserId,
                      itemId: visibleUnconfirmedRecord.itemId,
                    });
                  }
                }}
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
          {tabCannotFill
            ? tSearchTab('cannotFill')
            : helpTextKey === 'content.omnibox.tagHint'
              ? tOmni('tagHint')
              : helpTextKey === 'search.help.enterToSearch'
                ? tSearchHelp('enterToSearch')
                : helpTextKey === 'search.help.sentToServer'
                  ? tSearchHelp.rich('sentToServer', {
                      mono: (chunks) => <span className="mono">{chunks}</span>,
                    })
                  : tSearchHelp.rich('sentToServerExternal', {
                      mono: (chunks) => <span className="mono">{chunks}</span>,
                    })}
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
                  {pinnedItemRef.current !== null && pinnedItemRef.current.name === parsed.name ? (
                    <span
                      data-testid="omnibox-add-dest-pinned"
                      title={tSearchTab('pinned')}
                      className="ml-1 text-accent"
                    >
                      <span aria-hidden="true">✓</span>
                      <span className="sr-only">{tSearchTab('pinned')}</span>
                    </span>
                  ) : null}
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
                  ref={unlockToSaveBtnRef}
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
                <button
                  type="button"
                  data-omni-open-json="1"
                  data-testid="omnibox-json-banner-action"
                  className="btn btn-secondary btn-sm shrink-0"
                  onClick={() => {
                    if (parsed.mode !== 'add') return;
                    if (!isVaultUnlocked) {
                      unlockToSaveBtnRef.current?.focus();
                      return;
                    }
                    openJsonImportFromHandoff({
                      name: parsed.name,
                      tags: parsed.tags,
                      body: parsed.body,
                      userId: activeUserId,
                      onSavedEntry: () => {
                        setDraft('');
                        textareaRef.current?.focus();
                        undoToast?.markOmniboxJustCleared(textareaRef.current);
                      },
                      onRestoreFocus: () => {
                        textareaRef.current?.focus();
                      },
                    });
                  }}
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

      {popoverVisible ? (
        <div
          ref={popRef}
          id={popId}
          data-pop=""
          // advisor-dec-327 (O1b): a tab-order region ONLY while it overflows, so axe `scrollable-region-focusable`
          // passes without a permanent extra Tab stop. The label is static copy (never the draft).
          tabIndex={popScrollable ? 0 : undefined}
          role={popScrollable ? 'region' : undefined}
          aria-label={popScrollable ? tSearchListbox('regionAriaLabel') : undefined}
          onKeyDown={(event) => {
            // Only reachable while the region itself has focus (the textarea handles its own keys).
            if (event.target === event.currentTarget && event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              // Focus first: `handleRootBlur` sees a relatedTarget inside the root and does not close early.
              textareaRef.current?.focus();
              closeListbox(false);
            }
          }}
          onMouseDown={(event) => {
            // Keep focus on the textarea when clicking inside the popover so `handleRootBlur`
            // does not close the listbox before `onClick` fires (HM18A-R1-2).
            event.preventDefault();
          }}
          className="popover absolute left-0 right-0 top-[calc(100%+8px)] z-30 max-h-[440px] overflow-auto"
        >
          <SuggestList
            baseId={baseId}
            listboxId={listboxId}
            model={suggestModel}
            activeKey={activeKey}
            busy={listBusy || loadMoreBusy}
            showSkeleton={showSkeleton}
            rateLimitedSeconds={rateLimitedSeconds}
            enable409={semanticEnable409Visible}
            onActivate={executeKey}
            onOptionRef={(key, el) => {
              optionRefs.current[key] = el;
            }}
          />
        </div>
      ) : null}


      {/* RV-T17-2-FE1-3: mount the picker only while it has state. It seeds its item list from `initialItems` at
          mount, so an always-mounted dialog painted one frame with items=[] (create option only) before its passive
          effect filled them. */}
      {dupPickerState !== null ? (
        <DupPickerDialog
          open
          name={dupPickerState.name}
          initialItems={dupPickerState.initialItems}
          total={dupPickerState.total}
          initialNextCursor={dupPickerState.nextCursor ?? null}
          onPick={handleDupPickerPick}
          onCancel={handleDupPickerCancel}
        />
      ) : null}
      <ImportJsonDialog listenToHandoff />
    </div>
  );
}
