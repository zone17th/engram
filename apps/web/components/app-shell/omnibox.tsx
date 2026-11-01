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
} from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Kbd } from '@/components/ui/kbd';
import { useOptionalUndoToast } from '@/components/ui/undo-toast';
import { getVaultSecretInputProps } from '@/features/entries/secret-input-props';
import {
  CONTENT_ITEMS_QUERY_KEY_PREFIX,
  CONTENT_ITEM_QUERY_KEY_PREFIX,
  CONTENT_LOOKUP_QUERY_KEY_PREFIX,
  CONTENT_TAGS_QUERY_KEY_PREFIX,
  contentQueryKeys,
  type ContentItemsQueryKey,
} from '@/features/items/query-keys';
import { parseQuickAdd } from '@/features/omnibox/quick-add-parse';
import {
  filterCachedTagsByPrefix,
  parseTagFilterInput,
  splitMarkedPrefix,
} from '@/features/omnibox/search-helpers';
import { trimUnicodeWhiteSpace } from '@/features/omnibox/normalize';
import { useOptionalVault } from '@/features/vault/vault-provider';
import {
  createIdempotencyKey,
  getContentErrorI18nKey,
  itemCreate,
  itemDelete,
  itemsList,
  tagsList,
  type ContentErrorCode,
  type ItemList,
  type ItemSummary,
  type Tag,
  type TagList,
} from '@/lib/api/content';
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
 * Checks whether a query key in `QueryCache` is an omnibox search key:
 * - `['content', 'items', { q }]` where `q` is a non-empty string
 * - `['content', 'tags', { q }]` where `q` is a non-empty string
 */
function isOmniboxSearchQueryKey(queryKey: readonly unknown[]): boolean {
  if (queryKey.length < 3 || queryKey[0] !== 'content') {
    return false;
  }
  const kind = queryKey[1];
  if (kind !== 'items' && kind !== 'tags') {
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
  const tErrors = useTranslations('content.errors');
  const router = useRouter();
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

  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const optionRefs = useRef<Record<string, HTMLElement | null>>({});
  const searchAbortRef = useRef<AbortController | null>(null);
  const createPendingRef = useRef(false);

  const [inputValue, setInputValue] = useState('');
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

  const parsed = useMemo(() => parseQuickAdd(inputValue), [inputValue]);
  const trimmedInput = useMemo(() => trimUnicodeWhiteSpace(inputValue), [inputValue]);
  const hasNonEmptyInput = trimmedInput.length > 0;

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

  // Register synchronous vault lock / logout / user-switch / reset cleanup (plan §2.10, P4FE3-5, P4FE4-8).
  useEffect(() => {
    if (!vault?.registerSecretFormReset) return;
    return vault.registerSecretFormReset(() => {
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      if (textareaRef.current) {
        textareaRef.current.value = '';
        textareaRef.current.style.height = '';
        textareaRef.current.style.overflowY = 'hidden';
      }
      setInputValue('');
      setListOpen(false);
      setListKind(null);
      setActiveIndex(-1);
      setSearchResults(null);
      setTagFilterState(null);
      setLiveMessage('');
      setGuardKind(null);
      setActionErrorCode(null);
      removeOmniboxSearchQueries();
    });
  }, [removeOmniboxSearchQueries, vault]);

  useEffect(() => {
    return () => {
      searchAbortRef.current?.abort();
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

  const invalidateItemMetadataCaches = useCallback(async () => {
    if (!queryClient) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: CONTENT_ITEMS_QUERY_KEY_PREFIX }),
      queryClient.invalidateQueries({ queryKey: CONTENT_ITEM_QUERY_KEY_PREFIX }),
      queryClient.invalidateQueries({ queryKey: CONTENT_LOOKUP_QUERY_KEY_PREFIX }),
    ]);
  }, [queryClient]);

  const createEmptyItemWithName = useCallback(
    async (rawName: string) => {
      const nameToCreate = trimUnicodeWhiteSpace(rawName);
      if (!nameToCreate || createPendingRef.current) return;
      createPendingRef.current = true;
      setActionErrorCode(null);
      const idempotencyKey = createIdempotencyKey();

      try {
        const created = await itemCreate({ name: nameToCreate }, { idempotencyKey });
        closeListbox(false);
        setInputValue('');
        if (textareaRef.current) {
          textareaRef.current.value = '';
          syncTextareaHeight(textareaRef.current);
        }
        await invalidateItemMetadataCaches();

        undoToast?.pushUndoToast({
          message: tOmni('createdEmptyItemToast', { name: created.name }),
          actionLabel: tOmni('undoAction'),
          returnFocusTo: () => textareaRef.current,
          onUndo: async () => {
            await itemDelete(created.id, { idempotencyKey: createIdempotencyKey() });
            await invalidateItemMetadataCaches();
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
        const code = getContentErrorI18nKey(error).replace(
          /^content\.errors\./,
          '',
        ) as ContentErrorCode;
        setActionErrorCode(code);
      } finally {
        createPendingRef.current = false;
      }
    },
    [closeListbox, invalidateItemMetadataCaches, syncTextareaHeight, tOmni, undoToast],
  );

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
    const nextValue = event.target.value;
    setInputValue(nextValue);
    setGuardKind(null);
    setActionErrorCode(null);
    syncTextareaHeight(event.target);

    // Always cancel any in-flight search or server tag request when the user edits the input (HM18A-R1-6).
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

    // Add / add-invalid mode stub for 18a: no request, no hint (18b adds preview/lookup/save).
    closeListbox(true);
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
        event.preventDefault();
        searchAbortRef.current?.abort();
        searchAbortRef.current = null;
        setInputValue('');
        setGuardKind(null);
        setActionErrorCode(null);
        if (textareaRef.current) {
          textareaRef.current.value = '';
          syncTextareaHeight(textareaRef.current);
        }
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
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={tOmni('placeholder')}
          data-omnibox-input=""
          aria-label={tOmni('ariaLabel')}
          aria-describedby={hintId}
          aria-controls={listOpen && hasOptionChildren ? listboxId : undefined}
          aria-activedescendant={activeDescendantId}
          aria-invalid={isSearchInvalid || guardKind !== null ? true : undefined}
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
                    return (
                      <div
                        key={option.id}
                        ref={(el) => {
                          optionRefs.current[option.id] = el;
                        }}
                        id={option.id}
                        role="option"
                        aria-label={`${option.item.name} — ${tOmni('searchEntryCount', { count: option.item.entry_count })}`}
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
    </div>
  );
}
