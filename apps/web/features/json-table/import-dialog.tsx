'use client';

import { QueryClientContext } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { useOptionalUndoToast } from '@/components/ui/undo-toast';
import {
  ENTRY_MAX_PLAINTEXT_BYTES,
  ENTRY_NEAR_CAP_BYTES,
  EntrySealError,
  VAULT_SECRET_INPUT_PROPS,
  applyCommittedEntryMetaToCache,
  captureUnconfirmedSaveClearGeneration,
  mutateSealedEntryCreate,
  mutateSealedEntryImportJson,
  recordUnconfirmedSave,
  sealEntryImportJson,
  sealNewEntry,
  toEntryCreateVariables,
  toEntryImportJsonVariables,
  type SealedImportJsonEntryPayload,
  type SealedNewEntryPayload,
} from '@/features/entries';
import {
  CONTENT_ENTRIES_QUERY_KEY_PREFIX,
  CONTENT_ITEMS_QUERY_KEY_PREFIX,
  CONTENT_ITEM_QUERY_KEY_PREFIX,
  CONTENT_LOOKUP_QUERY_KEY_PREFIX,
  CONTENT_TAGS_QUERY_KEY_PREFIX,
  contentQueryKeys,
} from '@/features/items/query-keys';
import {
  getJsonImportHandoffSnapshot,
  reconcileJsonImportHandoffUser,
  subscribeJsonImportHandoff,
  wipeJsonImportHandoff,
  type JsonImportHandoffRecord,
} from '@/features/json-table/import-handoff-store';
import { JsonTreeGrid } from '@/features/json-table/json-tree-grid';
import { DupPickerDialog, type DupPickerSelection } from '@/features/omnibox/dup-picker-dialog';
import { normalizeTag } from '@/features/omnibox/normalize';
import { checkTargetTagCap } from '@/features/omnibox/save-plan';
import { getKnownDeviceSessionUserId } from '@/features/vault/device-store';
import { useOptionalVault } from '@/features/vault/vault-provider';
import {
  classifyContentMutationError,
  createIdempotencyKey,
  entryCreate,
  entryDelete,
  entryImportJson,
  itemCreate,
  itemTagsAdd,
  itemsLookupExact,
  tagUpsert,
  type ClassifiedContentMutationError,
  type ContentErrorI18nKey,
  type EntryMeta,
  type EntryMetaList,
  type ItemSummary,
  type Tag,
} from '@/lib/api/content';
import type { Me } from '@/lib/api/auth';
import { subscribeSessionBroadcast } from '@/lib/auth/broadcast';
import {
  JSON_FORMAT_MAX_DEPTH,
  decodeUtf8FileStrict,
  formatJsonStrict,
  isWellFormedUtf16,
  lineColumnToOffset,
  measureUtf8Bytes,
  normalizeEolToLf,
  parseJsonStrict,
  type JsonDocument,
  type JsonParseError,
} from '@/lib/json';

const ITEM_MAX_ENTRIES = 200;
const FILE_PRE_READ_SIZE_CAP_BYTES = 4 * 1024 * 1024;
export type EntryImportJsonSource = 'paste' | 'file';

export type JsonImportPreviewMode = 'table' | 'raw';

export interface JsonImportPlaintextHolder {
  draftText: string;
  submittedText: string;
}

let jsonImportPlaintextHolderTestHookRef: { current: JsonImportPlaintextHolder } | null = null;

export const importDialogTesting = {
  setJsonImportPlaintextHolderForTests(
    holderRef: { current: JsonImportPlaintextHolder } | null,
  ): void {
    jsonImportPlaintextHolderTestHookRef = holderRef;
  },
};

export interface ImportJsonDialogProps {
  readonly open?: boolean;
  readonly itemId?: string;
  readonly itemName?: string;
  readonly tags?: readonly string[];
  readonly isCurrentItem?: boolean;
  readonly entryCount?: number;
  readonly initialText?: string;
  readonly initialSource?: EntryImportJsonSource;
  readonly onClose?: () => void;
  readonly onSaved?: (created: EntryMeta, itemId: string, itemName: string) => void;
  readonly onAnnounce?: (message: string) => void;
  readonly onDraftClearedOnLock?: () => void;
  readonly restoreFocusRef?: { readonly current: HTMLElement | null };
  readonly listenToHandoff?: boolean;
}

interface PendingMultiStepImportPlan {
  readonly mode: 'json' | 'text';
  readonly source: EntryImportJsonSource;
  readonly userId: string | null;
  readonly itemId: string;
  readonly itemName: string;
  readonly isNewItem: boolean;
  readonly itemCreateIdempotencyKey?: string;
  itemCreateUncertainSend: boolean;
  itemCreated?: ItemSummary;
  readonly tagTasks: Array<{
    readonly display: string;
    readonly idempotencyKey: string;
    upsertedTag?: Tag;
    uncertainSend: boolean;
  }>;
  readonly assignTagsIdempotencyKey?: string;
  assignTagsUncertainSend: boolean;
  readonly sealedJson?: SealedImportJsonEntryPayload;
  readonly sealedText?: SealedNewEntryPayload;
  entryUncertainSend: boolean;
  readonly clearGeneration: number;
}

export function ImportJsonDialog({
  open: openProp = false,
  itemId: itemIdProp,
  itemName: itemNameProp = '',
  tags: tagsProp,
  isCurrentItem: isCurrentItemProp = true,
  entryCount: entryCountProp = 0,
  initialText = '',
  initialSource = 'paste',
  onClose,
  onSaved,
  onAnnounce,
  onDraftClearedOnLock,
  restoreFocusRef,
  listenToHandoff = false,
}: ImportJsonDialogProps) {
  const tJson = useTranslations('content.json');
  const tEntry = useTranslations('content.entry');
  const tErrors = useTranslations('content.errors');
  const tOmni = useTranslations('content.omnibox');
  const format = useFormatter();
  const queryClient = useContext(QueryClientContext);
  const vault = useOptionalVault();
  const undoToast = useOptionalUndoToast();

  const handoffSnapshot = useSyncExternalStore(
    listenToHandoff ? subscribeJsonImportHandoff : () => () => {},
    listenToHandoff ? getJsonImportHandoffSnapshot : () => null,
    () => null,
  );

  const subscribeAuthMeUserId = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (!queryClient) {
        return () => {};
      }
      return queryClient.getQueryCache().subscribe((event) => {
        const key = event.query?.queryKey;
        if (Array.isArray(key) && key[0] === 'auth' && key[1] === 'me') {
          onStoreChange();
        }
      });
    },
    [queryClient],
  );
  const getAuthMeUserIdSnapshot = useCallback((): string | null => {
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
  }, [queryClient]);
  const activeUserId = useSyncExternalStore(
    subscribeAuthMeUserId,
    getAuthMeUserIdSnapshot,
    () => null,
  );
  const activeUserIdRef = useRef<string | null>(activeUserId);
  activeUserIdRef.current = activeUserId;

  useEffect(() => {
    if (listenToHandoff) {
      reconcileJsonImportHandoffUser(activeUserId);
    }
  }, [activeUserId, listenToHandoff]);

  const unlocked = vault ? vault.state === 'unlocked' : true;

  const activeHandoff: JsonImportHandoffRecord | null =
    listenToHandoff &&
    unlocked &&
    handoffSnapshot !== null &&
    (handoffSnapshot.userId === null ||
      activeUserId === null ||
      handoffSnapshot.userId === activeUserId)
      ? handoffSnapshot
      : null;

  const isOpen = openProp || activeHandoff !== null;
  const effectiveItemId = activeHandoff ? activeHandoff.itemId : itemIdProp;
  const effectiveItemName = activeHandoff ? activeHandoff.name : itemNameProp;
  const effectiveTags = useMemo(
    () => (activeHandoff ? activeHandoff.tags : (tagsProp ?? [])),
    [activeHandoff, tagsProp],
  );
  const effectiveIsCurrentItem = activeHandoff
    ? activeHandoff.isCurrentItem && Boolean(activeHandoff.itemId)
    : isCurrentItemProp && Boolean(itemIdProp);

  const cachedItemEntryCount = useMemo(() => {
    if (!effectiveItemId || !queryClient) return undefined;
    const entriesList = queryClient.getQueryData<EntryMetaList>(
      contentQueryKeys.entries(effectiveItemId),
    );
    if (entriesList?.items) {
      return entriesList.items.length;
    }
    const itemSummary = queryClient.getQueryData<ItemSummary>(
      contentQueryKeys.item(effectiveItemId),
    );
    return itemSummary?.entry_count;
  }, [effectiveItemId, queryClient]);

  const effectiveEntryCount =
    activeHandoff?.entryCount ?? cachedItemEntryCount ?? entryCountProp;
  const atEntryLimit = effectiveEntryCount >= ITEM_MAX_ENTRIES;

  const translateContentError = useCallback(
    (key: ContentErrorI18nKey): string => {
      const code = key.replace(/^content\.errors\./, '');
      return tErrors(code as Parameters<typeof tErrors>[0]);
    },
    [tErrors],
  );

  const translateParseError = useCallback(
    (error: JsonParseError): string => {
      const key = `parseError.${error.code}` as Parameters<typeof tJson>[0];
      return tJson(key);
    },
    [tJson],
  );

  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  const [draftText, setDraftText] = useState<string>('');
  const [exactSourceText, setExactSourceText] = useState<string>('');
  const [sourceKind, setSourceKind] = useState<EntryImportJsonSource>('paste');
  const [hasLoadedFile, setHasLoadedFile] = useState<boolean>(false);
  const [utf8FileError, setUtf8FileError] = useState<boolean>(false);
  const [fileSizeOverCapBytes, setFileSizeOverCapBytes] = useState<number | null>(null);
  const [formatBeforeSave, setFormatBeforeSave] = useState<boolean>(false);
  const [formatWarning, setFormatWarning] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<JsonImportPreviewMode>('table');
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [pageByPath, setPageByPath] = useState<ReadonlyMap<string, number>>(
    () => new Map<string, number>(),
  );

  const [savingInFlight, setSavingInFlight] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [targetTagLimitCount, setTargetTagLimitCount] = useState<number | null>(null);
  const [unconfirmedSaveState, setUnconfirmedSaveState] = useState<{
    readonly plan: PendingMultiStepImportPlan;
    readonly errorMessage: string;
  } | null>(null);
  const [dupPickerState, setDupPickerState] = useState<{
    readonly mode: 'json' | 'text';
    readonly name: string;
    readonly tags: readonly string[];
    readonly initialItems: readonly ItemSummary[];
    readonly total: number;
    readonly nextCursor: string | null;
  } | null>(null);

  const internalHolderRef = useRef<JsonImportPlaintextHolder>({
    draftText: '',
    submittedText: '',
  });
  const holderRef = jsonImportPlaintextHolderTestHookRef ?? internalHolderRef;
  holderRef.current.draftText = exactSourceText;

  const lockEpochRef = useRef<number>(0);
  const saveOwnerIdRef = useRef<number>(0);
  const nextSaveOwnerIdRef = useRef<number>(0);
  const saveLockRef = useRef<boolean>(false);
  const activePlanRef = useRef<PendingMultiStepImportPlan | null>(null);
  const lastOpenedSessionKeyRef = useRef<string | null>(null);

  const wipeInternalBuffers = useCallback(() => {
    lockEpochRef.current += 1;
    saveOwnerIdRef.current = 0;
    saveLockRef.current = false;
    const currentPlan = activePlanRef.current;
    if (currentPlan) {
      currentPlan.sealedJson?.op.dispose?.();
      currentPlan.sealedText?.op.dispose?.();
      activePlanRef.current = null;
    }
    holderRef.current.draftText = '';
    holderRef.current.submittedText = '';
    if (textareaRef.current) {
      textareaRef.current.value = '';
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    setDraftText('');
    setExactSourceText('');
    setSourceKind('paste');
    setHasLoadedFile(false);
    setUtf8FileError(false);
    setFileSizeOverCapBytes(null);
    setFormatBeforeSave(false);
    setFormatWarning(null);
    setPreviewMode('table');
    setExpandedPaths(new Set());
    setPageByPath(new Map());
    setSavingInFlight(false);
    setSaveError(null);
    setTargetTagLimitCount(null);
    setUnconfirmedSaveState(null);
    setDupPickerState(null);
  }, [holderRef]);

  const handleClose = useCallback(
    (options?: { readonly skipFocusRestore?: boolean }) => {
      const handoffRestore = activeHandoff?.onRestoreFocus;
      wipeInternalBuffers();
      if (listenToHandoff) {
        wipeJsonImportHandoff();
      }
      onClose?.();
      if (!options?.skipFocusRestore) {
        queueMicrotask(() => {
          if (handoffRestore) {
            handoffRestore();
          } else {
            restoreFocusRef?.current?.focus();
          }
        });
      }
    },
    [activeHandoff, listenToHandoff, onClose, restoreFocusRef, wipeInternalBuffers],
  );

  // Initialize state when dialog opens for a new session or handoff
  useEffect(() => {
    if (!isOpen) {
      lastOpenedSessionKeyRef.current = null;
      return;
    }
    const sessionKey = activeHandoff
      ? `handoff:${activeHandoff.id}`
      : `prop:${effectiveItemId ?? ''}:${initialSource}:${initialText}`;
    if (lastOpenedSessionKeyRef.current === sessionKey) {
      return;
    }
    lastOpenedSessionKeyRef.current = sessionKey;
    const rawToLoad = activeHandoff ? activeHandoff.bodyHolder.text : initialText;
    const displayToLoad = normalizeEolToLf(rawToLoad);
    const sourceToLoad: EntryImportJsonSource = activeHandoff ? 'paste' : initialSource;
    holderRef.current.draftText = rawToLoad;
    holderRef.current.submittedText = '';
    setExactSourceText(rawToLoad);
    setDraftText(displayToLoad);
    setSourceKind(sourceToLoad);
    setHasLoadedFile(sourceToLoad === 'file');
    setUtf8FileError(false);
    setFileSizeOverCapBytes(null);
    setFormatBeforeSave(false);
    setFormatWarning(null);
    setPreviewMode('table');
    setExpandedPaths(new Set());
    setPageByPath(new Map());
    setSavingInFlight(false);
    setSaveError(null);
    setTargetTagLimitCount(null);
    setUnconfirmedSaveState(null);
    setDupPickerState(null);
  }, [
    activeHandoff,
    effectiveItemId,
    holderRef,
    initialSource,
    initialText,
    isOpen,
  ]);

  // Open / close native <dialog> element and focus first control
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;

    if (isOpen && unlocked) {
      if (!dlg.open && typeof dlg.showModal === 'function') {
        try {
          dlg.showModal();
        } catch {
          dlg.setAttribute('open', '');
        }
      } else if (!dlg.open) {
        dlg.setAttribute('open', '');
      }
      queueMicrotask(() => {
        if (atEntryLimit) {
          closeBtnRef.current?.focus();
        } else {
          textareaRef.current?.focus();
        }
      });
    } else if (dlg.open) {
      if (typeof dlg.close === 'function') {
        try {
          dlg.close();
        } catch {
          dlg.removeAttribute('open');
        }
      } else {
        dlg.removeAttribute('open');
      }
    }
  }, [atEntryLimit, isOpen, unlocked]);

  const isDirtyRef = useRef<boolean>(false);
  isDirtyRef.current =
    isOpen &&
    (draftText.length > 0 ||
      hasLoadedFile ||
      utf8FileError ||
      unconfirmedSaveState !== null ||
      activeHandoff !== null);

  // Register secret form reset on vault lock / logout / user switch (plan §2.10, dec-209)
  useEffect(() => {
    if (!vault?.registerSecretFormReset) return;
    return vault.registerSecretFormReset(() => {
      const hadNonEmptyDraft = isDirtyRef.current;
      wipeInternalBuffers();
      if (listenToHandoff) {
        wipeJsonImportHandoff({ bumpLockEpoch: true });
      }
      if (hadNonEmptyDraft) {
        onDraftClearedOnLock?.();
      }
      onClose?.();
    });
  }, [listenToHandoff, onClose, onDraftClearedOnLock, vault, wipeInternalBuffers]);

  // Subscribe to session broadcast for explicit logout
  useEffect(() => {
    return subscribeSessionBroadcast((message) => {
      if (message.type === 'signed_out') {
        wipeInternalBuffers();
        if (listenToHandoff) {
          wipeJsonImportHandoff({ bumpLockEpoch: true });
        }
        onClose?.();
      }
    });
  }, [listenToHandoff, onClose, wipeInternalBuffers]);

  // Unmount cleanup
  useEffect(() => {
    const holder = holderRef;
    return () => {
      lockEpochRef.current += 1;
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      holder.current.draftText = '';
      holder.current.submittedText = '';
      if (listenToHandoff) {
        wipeJsonImportHandoff();
      }
    };
  }, [holderRef, listenToHandoff]);

  const utf8ByteLength = useMemo(
    () =>
      utf8FileError
        ? 0
        : (fileSizeOverCapBytes ?? measureUtf8Bytes(exactSourceText)),
    [exactSourceText, fileSizeOverCapBytes, utf8FileError],
  );
  const isNearCap = !utf8FileError && utf8ByteLength >= ENTRY_NEAR_CAP_BYTES;
  const isOverCap = !utf8FileError && utf8ByteLength > ENTRY_MAX_PLAINTEXT_BYTES;
  const wellFormedUtf16 = useMemo(
    () => isWellFormedUtf16(exactSourceText),
    [exactSourceText],
  );

  const parseResult = useMemo(() => {
    if (utf8FileError || isOverCap || exactSourceText.trim().length === 0) {
      return null;
    }
    if (!wellFormedUtf16) {
      return {
        ok: false as const,
        error: {
          code: 'INVALID_UNICODE_ESCAPE' as const,
          offset: 0,
          line: 1,
          column: 1,
          message: 'Input contains lone UTF-16 surrogate',
        },
      };
    }
    return parseJsonStrict(exactSourceText);
  }, [exactSourceText, isOverCap, utf8FileError, wellFormedUtf16]);
  const validDoc: JsonDocument | null =
    parseResult && parseResult.ok ? parseResult.document : null;
  const parseError: JsonParseError | null =
    parseResult && !parseResult.ok ? parseResult.error : null;

  const formattedBytesPreview = useMemo(() => {
    if (!formatBeforeSave || !validDoc) {
      return null;
    }
    if (validDoc.maxDepth > JSON_FORMAT_MAX_DEPTH) {
      return {
        ok: false as const,
        reason: 'depth' as const,
      };
    }
    const res = formatJsonStrict(exactSourceText);
    if (!res.ok) {
      if (res.error.code === 'BYTE_LIMIT_EXCEEDED') {
        return {
          ok: false as const,
          reason: 'byte_limit' as const,
        };
      }
      if (res.error.code === 'DEPTH_LIMIT_EXCEEDED') {
        return {
          ok: false as const,
          reason: 'depth' as const,
        };
      }
      return {
        ok: false as const,
        reason: 'format_error' as const,
      };
    }
    return {
      ok: true as const,
      text: res.text,
      bytes: res.byteLength,
    };
  }, [exactSourceText, formatBeforeSave, validDoc]);

  const effectiveSubmitText =
    formatBeforeSave && formattedBytesPreview?.ok
      ? formattedBytesPreview.text
      : exactSourceText;
  const canSubmitJson =
    !atEntryLimit &&
    !utf8FileError &&
    !isOverCap &&
    validDoc !== null &&
    (!formatBeforeSave || (formattedBytesPreview !== null && formattedBytesPreview.ok)) &&
    !savingInFlight &&
    unconfirmedSaveState === null;

  const canSaveAsText =
    !atEntryLimit &&
    !utf8FileError &&
    !isOverCap &&
    wellFormedUtf16 &&
    parseError !== null &&
    exactSourceText.trim().length > 0 &&
    !savingInFlight &&
    unconfirmedSaveState === null;

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

  const handleTextareaChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      if (savingInFlight || atEntryLimit || unconfirmedSaveState !== null) return;
      const next = e.target.value;
      setUtf8FileError(false);
      setFileSizeOverCapBytes(null);
      if (!hasLoadedFile) {
        setSourceKind('paste');
      }
      setFormatWarning(null);
      setSaveError(null);
      setTargetTagLimitCount(null);
      holderRef.current.draftText = next;
      setExactSourceText(next);
      setDraftText(next);
    },
    [atEntryLimit, hasLoadedFile, holderRef, savingInFlight, unconfirmedSaveState],
  );

  // Rule 3 paste handler (`clipboardData.getData('text/plain')` as exact source when pasting over whole field,
  // preserving CR if the browser returns it; P4FE2-6)
  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (savingInFlight || atEntryLimit || unconfirmedSaveState !== null) return;
      const clipboardText = e.clipboardData?.getData('text/plain');
      if (typeof clipboardText !== 'string') return;
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart ?? draftText.length;
      const end = el.selectionEnd ?? draftText.length;
      const normalizedClip = normalizeEolToLf(clipboardText);
      const nextDisplayValue =
        draftText.slice(0, start) + normalizedClip + draftText.slice(end);
      const isFullReplace =
        draftText.length === 0 || (start === 0 && end === draftText.length);
      const nextExactSource = isFullReplace ? clipboardText : nextDisplayValue;
      const nextCursor = start + normalizedClip.length;
      setUtf8FileError(false);
      setFileSizeOverCapBytes(null);
      if (!hasLoadedFile) {
        setSourceKind('paste');
      }
      setFormatWarning(null);
      setSaveError(null);
      setTargetTagLimitCount(null);
      holderRef.current.draftText = nextExactSource;
      setExactSourceText(nextExactSource);
      setDraftText(nextDisplayValue);
      queueMicrotask(() => {
        if (textareaRef.current) {
          textareaRef.current.setSelectionRange(nextCursor, nextCursor);
        }
      });
    },
    [atEntryLimit, draftText, hasLoadedFile, holderRef, savingInFlight, unconfirmedSaveState],
  );

  // Choose `.json` file -> `arrayBuffer()` -> `decodeUtf8FileStrict` (fatal TextDecoder, BOM stripped, <= 262,144 B)
  const handleFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || savingInFlight || atEntryLimit || unconfirmedSaveState !== null) return;

      // IP17-R1-8: Reject files far over cap by checking `file.size` before calling `file.arrayBuffer()`.
      if (typeof file.size === 'number' && file.size > FILE_PRE_READ_SIZE_CAP_BYTES) {
        holderRef.current.draftText = '';
        setExactSourceText('');
        setDraftText('');
        setFormatWarning(null);
        setSaveError(null);
        setTargetTagLimitCount(null);
        setSourceKind('file');
        setHasLoadedFile(true);
        setUtf8FileError(false);
        setFileSizeOverCapBytes(file.size);
        return;
      }

      const capturedEpoch = lockEpochRef.current;
      try {
        const buffer = await file.arrayBuffer();
        if (lockEpochRef.current !== capturedEpoch) {
          return;
        }
        const bytes = new Uint8Array(buffer);
        const result = decodeUtf8FileStrict(bytes, {
          limitBytes: ENTRY_MAX_PLAINTEXT_BYTES,
        });

        setFormatWarning(null);
        setSaveError(null);
        setTargetTagLimitCount(null);
        setSourceKind('file');
        setHasLoadedFile(true);
        setFileSizeOverCapBytes(null);
        if (!result.ok) {
          if (
            result.error.code === 'ILL_FORMED_UTF16' ||
            result.error.code === 'INVALID_UTF8' ||
            result.error.code === 'INVALID_INPUT'
          ) {
            holderRef.current.draftText = '';
            setExactSourceText('');
            setDraftText('');
            setUtf8FileError(true);
            return;
          }
          // BYTE_LIMIT_EXCEEDED: decode with fatal UTF-8 without byte cap so the over-cap state
          // can display the exact byte count while still rejecting invalid UTF-8 sequences.
          const uncapped = decodeUtf8FileStrict(bytes, {
            limitBytes: Math.max(bytes.byteLength, ENTRY_MAX_PLAINTEXT_BYTES + 1),
          });
          if (!uncapped.ok) {
            holderRef.current.draftText = '';
            setExactSourceText('');
            setDraftText('');
            setUtf8FileError(true);
            return;
          }
          const normalized = normalizeEolToLf(uncapped.text);
          holderRef.current.draftText = uncapped.text;
          setUtf8FileError(false);
          setExactSourceText(uncapped.text);
          setDraftText(normalized);
          return;
        }

        // Rule 3 byte-exact file import: preserve `result.text` (CRLF/CR/LF minus at most 1 BOM)
        // in `exactSourceText` and `holderRef.current.draftText`, while normalizing to LF only
        // for `<textarea>` display.
        const normalized = normalizeEolToLf(result.text);
        holderRef.current.draftText = result.text;
        setUtf8FileError(false);
        setExactSourceText(result.text);
        setDraftText(normalized);
      } catch {
        if (lockEpochRef.current !== capturedEpoch) return;
        holderRef.current.draftText = '';
        setExactSourceText('');
        setDraftText('');
        setSourceKind('file');
        setHasLoadedFile(true);
        setFileSizeOverCapBytes(null);
        setUtf8FileError(true);
      }
    },
    [atEntryLimit, holderRef, savingInFlight, unconfirmedSaveState],
  );

  const handleClearFile = useCallback(() => {
    if (savingInFlight || unconfirmedSaveState !== null) return;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    holderRef.current.draftText = '';
    setExactSourceText('');
    setDraftText('');
    setSourceKind('paste');
    setHasLoadedFile(false);
    setUtf8FileError(false);
    setFileSizeOverCapBytes(null);
    setFormatBeforeSave(false);
    setFormatWarning(null);
    setSaveError(null);
    setTargetTagLimitCount(null);
    textareaRef.current?.focus();
  }, [holderRef, savingInFlight, unconfirmedSaveState]);

  const handleToggleFormatBeforeSave = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (savingInFlight || atEntryLimit || unconfirmedSaveState !== null) return;
      const checked = e.target.checked;
      setFormatWarning(null);
      if (!checked) {
        setFormatBeforeSave(false);
        return;
      }
      if (!validDoc) {
        return;
      }
      if (validDoc.maxDepth > JSON_FORMAT_MAX_DEPTH) {
        setFormatBeforeSave(false);
        setFormatWarning(
          tJson('formatRefusedDepth', { maxDepth: JSON_FORMAT_MAX_DEPTH }),
        );
        return;
      }
      const res = formatJsonStrict(exactSourceText);
      if (!res.ok) {
        setFormatBeforeSave(false);
        if (res.error.code === 'BYTE_LIMIT_EXCEEDED') {
          const b = res.error.byteLength ?? ENTRY_MAX_PLAINTEXT_BYTES + 1;
          setFormatWarning(
            tJson('formatRefusedBytes', { bytes: format.number(b) }),
          );
        } else if (res.error.code === 'DEPTH_LIMIT_EXCEEDED') {
          setFormatWarning(
            tJson('formatRefusedDepth', {
              maxDepth: res.error.maxDepth ?? JSON_FORMAT_MAX_DEPTH,
            }),
          );
        } else {
          setFormatWarning(tJson('formatRefusedInvalid'));
        }
        return;
      }
      setFormatBeforeSave(true);
    },
    [atEntryLimit, exactSourceText, format, savingInFlight, tJson, unconfirmedSaveState, validDoc],
  );

  const handleFocusErrorLine = useCallback(() => {
    const el = textareaRef.current;
    if (!el || !parseError) return;
    const offset = lineColumnToOffset(draftText, parseError.line, parseError.column);
    el.focus();
    el.setSelectionRange(offset, offset);
  }, [draftText, parseError]);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handlePageChange = useCallback((path: string, nextPage: number) => {
    setPageByPath((prev) => {
      const next = new Map(prev);
      next.set(path, nextPage);
      return next;
    });
  }, []);

  const executePlan = useCallback(
    async (plan: PendingMultiStepImportPlan, ownerId: number, capturedEpoch: number) => {
      const op = plan.mode === 'json' ? plan.sealedJson!.op : plan.sealedText!.op;
      const isStale = (): boolean =>
        lockEpochRef.current !== capturedEpoch ||
        saveOwnerIdRef.current !== ownerId ||
        !op.isCurrent();

      let currentStepHadUncertainSend = true;
      try {
        // Step 1: Create new item if needed
        if (plan.isNewItem && !plan.itemCreated) {
          currentStepHadUncertainSend = plan.itemCreateUncertainSend;
          plan.itemCreateUncertainSend = true;
          const createdItem = await itemCreate(
            {
              id: plan.itemId,
              name: plan.itemName,
            },
            {
              idempotencyKey: plan.itemCreateIdempotencyKey!,
            },
          );
          if (isStale()) return;
          plan.itemCreated = createdItem;
          plan.itemCreateUncertainSend = false;
        }

        // Step 2: Upsert tags if needed
        if (plan.tagTasks.length > 0) {
          for (const task of plan.tagTasks) {
            if (task.upsertedTag) continue;
            currentStepHadUncertainSend = task.uncertainSend;
            task.uncertainSend = true;
            const upserted = await tagUpsert(
              { display: task.display },
              { idempotencyKey: task.idempotencyKey },
            );
            if (isStale()) return;
            task.upsertedTag = upserted;
            task.uncertainSend = false;
          }

          // Step 3: Assign tags to item
          const tagIds = plan.tagTasks
            .map((t) => t.upsertedTag?.id)
            .filter((id): id is string => Boolean(id));
          if (tagIds.length > 0 && plan.assignTagsIdempotencyKey) {
            currentStepHadUncertainSend = plan.assignTagsUncertainSend;
            plan.assignTagsUncertainSend = true;
            await itemTagsAdd(
              plan.itemId,
              { tag_ids: tagIds },
              { idempotencyKey: plan.assignTagsIdempotencyKey },
            );
            if (isStale()) return;
            plan.assignTagsUncertainSend = false;
          }
        }

        // Step 4: Entry mutation (`entryImportJson` or `entryCreate`)
        currentStepHadUncertainSend = plan.entryUncertainSend;
        plan.entryUncertainSend = true;

        let committedMeta: EntryMeta;
        if (plan.mode === 'json' && plan.sealedJson) {
          if (queryClient) {
            const res = await mutateSealedEntryImportJson(
              queryClient,
              toEntryImportJsonVariables(plan.sealedJson, {
                uncertainPriorSend: currentStepHadUncertainSend,
              }),
            );
            committedMeta = res.meta;
          } else {
            const vars = toEntryImportJsonVariables(plan.sealedJson, {
              uncertainPriorSend: currentStepHadUncertainSend,
            });
            committedMeta = await entryImportJson(vars.itemId, vars.requestBody, {
              idempotencyKey: vars.idempotencyKey,
            });
          }
        } else {
          const sealedText = plan.sealedText!;
          if (queryClient) {
            const res = await mutateSealedEntryCreate(
              queryClient,
              toEntryCreateVariables(sealedText, {
                uncertainPriorSend: currentStepHadUncertainSend,
              }),
            );
            committedMeta = res.meta;
          } else {
            const vars = toEntryCreateVariables(sealedText, {
              uncertainPriorSend: currentStepHadUncertainSend,
            });
            committedMeta = await entryCreate(vars.itemId, vars.requestBody, {
              idempotencyKey: vars.idempotencyKey,
            });
          }
        }

        if (isStale()) return;

        if (queryClient && op.isCurrent()) {
          applyCommittedEntryMetaToCache({
            queryClient,
            entryId: committedMeta.id,
            itemId: plan.itemId,
            meta: committedMeta,
            op,
          });
        }

        const savedEntryId = committedMeta.id;
        const savedItemName = plan.itemName;
        const savedItemId = plan.itemId;
        const toastMsg =
          plan.mode === 'json'
            ? tJson('importSavedToast', { name: savedItemName })
            : tJson('importSavedTextToast', { name: savedItemName });

        onAnnounce?.(toastMsg);
        undoToast?.pushUndoToast({
          message: toastMsg,
          detail: activeHandoff ? tOmni('savedUndoDetail') : undefined,
          actionLabel: tOmni('undoAction'),
          returnFocusTo: () => restoreFocusRef?.current ?? null,
          onUndo: async () => {
            await entryDelete(savedEntryId, {
              idempotencyKey: createIdempotencyKey(),
            });
            await invalidateAllContentMetadataCaches();
          },
        });

        void invalidateAllContentMetadataCaches();
        activeHandoff?.onSavedEntry?.({
          itemId: savedItemId,
          itemName: savedItemName,
          entryId: savedEntryId,
        });
        onSaved?.(committedMeta, savedItemId, savedItemName);
        handleClose({ skipFocusRestore: Boolean(onSaved) });
      } catch (err) {
        const classified: ClassifiedContentMutationError = classifyContentMutationError(
          err,
          { hadUncertainSend: currentStepHadUncertainSend },
        );

        if (classified.isLogoutBoundary) {
          const userId = plan.userId ?? activeUserIdRef.current;
          if (userId) {
            recordUnconfirmedSave({
              userId,
              itemId: plan.itemId,
              itemName: plan.itemName || plan.itemId,
              source: 'entry',
              clearGeneration: plan.clearGeneration,
            });
          }
          wipeInternalBuffers();
          if (listenToHandoff) {
            wipeJsonImportHandoff({ bumpLockEpoch: true });
          }
          onClose?.();
          return;
        }

        if (isStale()) return;
        saveOwnerIdRef.current = 0;
        saveLockRef.current = false;
        setSavingInFlight(false);
        if (
          classified.kind === 'entry_key_mismatch' ||
          classified.kind === 'vault_absent'
        ) {
          plan.sealedJson?.op.dispose?.();
          plan.sealedText?.op.dispose?.();
          activePlanRef.current = null;
          setUnconfirmedSaveState(null);
          void vault?.reloadVaultMeta?.();
          const msg = translateContentError(classified.i18nKey);
          setSaveError(msg);
          onAnnounce?.(msg);
          return;
        }

        const msg = translateContentError(classified.i18nKey);
        if (classified.canRetrySameBytes) {
          setUnconfirmedSaveState({
            plan,
            errorMessage: msg,
          });
          setSaveError(null);
        } else {
          plan.sealedJson?.op.dispose?.();
          plan.sealedText?.op.dispose?.();
          activePlanRef.current = null;
          setUnconfirmedSaveState(null);
          setSaveError(msg);
        }
        onAnnounce?.(msg);
      }
    },
    [
      activeHandoff,
      handleClose,
      invalidateAllContentMetadataCaches,
      listenToHandoff,
      onAnnounce,
      onClose,
      onSaved,
      queryClient,
      restoreFocusRef,
      tJson,
      tOmni,
      translateContentError,
      undoToast,
      vault,
      wipeInternalBuffers,
    ],
  );

  const startImportForResolvedTarget = useCallback(
    async (params: {
      readonly mode: 'json' | 'text';
      readonly targetItem: ItemSummary | null;
      readonly isNewItem: boolean;
    }) => {
      if (!vault || !unlocked || saveLockRef.current) return;
      const { mode, targetItem, isNewItem } = params;

      if (!isNewItem && targetItem && effectiveTags.length > 0) {
        const capCheck = checkTargetTagCap(targetItem.tags ?? [], effectiveTags);
        if (!capCheck.allowed) {
          setTargetTagLimitCount(capCheck.existingTagCount);
          setSaveError(null);
          return;
        }
      }

      const resolvedItemId =
        !isNewItem && targetItem
          ? targetItem.id
          : effectiveItemId ?? crypto.randomUUID().toLowerCase();
      const resolvedItemName =
        !isNewItem && targetItem
          ? targetItem.name
          : effectiveItemName || resolvedItemId;

      saveLockRef.current = true;
      const ownerId = nextSaveOwnerIdRef.current + 1;
      nextSaveOwnerIdRef.current = ownerId;
      saveOwnerIdRef.current = ownerId;
      const capturedEpoch = lockEpochRef.current;
      const capturedClearGen = captureUnconfirmedSaveClearGeneration();

      setSavingInFlight(true);
      setSaveError(null);
      setTargetTagLimitCount(null);
      onAnnounce?.(tEntry('saving'));

      try {
        let plan = unconfirmedSaveState?.plan ?? null;
        if (!plan) {
          // IP16-FE1-2 / advisor-dec-200: Do not hold any plaintext local across an await.
          // sealEntryImportJson / sealNewEntry reload vaultMeta themselves when null and invoke
          // getText() synchronously AFTER any reloadVaultMeta await and op-token check.
          if (
            lockEpochRef.current !== capturedEpoch ||
            saveOwnerIdRef.current !== ownerId ||
            (vault.state !== undefined && vault.state !== 'unlocked')
          ) {
            saveOwnerIdRef.current = 0;
            saveLockRef.current = false;
            setSavingInFlight(false);
            return;
          }

          const readPlaintextForSeal = (): string => {
            if (
              lockEpochRef.current !== capturedEpoch ||
              saveOwnerIdRef.current !== ownerId ||
              (vault.state !== undefined && vault.state !== 'unlocked')
            ) {
              return '';
            }
            const currentRawSource = holderRef.current.draftText;
            const payloadText =
              mode === 'json' && formatBeforeSave && formattedBytesPreview?.ok
                ? formattedBytesPreview.text
                : currentRawSource;
            holderRef.current.submittedText = payloadText;
            return payloadText;
          };

          const entryId = crypto.randomUUID().toLowerCase();
          const entryIdempotencyKey = createIdempotencyKey();

          let sealedJson: SealedImportJsonEntryPayload | undefined;
          let sealedText: SealedNewEntryPayload | undefined;
          if (mode === 'json') {
            sealedJson = await sealEntryImportJson({
              getText: readPlaintextForSeal,
              itemId: resolvedItemId,
              entryId,
              source: sourceKind,
              idempotencyKey: entryIdempotencyKey,
              vault,
            });
          } else {
            sealedText = await sealNewEntry({
              getText: readPlaintextForSeal,
              itemId: resolvedItemId,
              entryId,
              type: 'text',
              idempotencyKey: entryIdempotencyKey,
              vault,
            });
          }

          const op = sealedJson ? sealedJson.op : sealedText!.op;
          if (
            lockEpochRef.current !== capturedEpoch ||
            saveOwnerIdRef.current !== ownerId ||
            !op.isCurrent()
          ) {
            op.dispose?.();
            saveOwnerIdRef.current = 0;
            saveLockRef.current = false;
            setSavingInFlight(false);
            return;
          }

          const dedupedTags: string[] = [];
          const seenNorm = new Set<string>();
          for (const rawTag of effectiveTags) {
            const norm = normalizeTag(rawTag);
            const key = norm.ok ? norm.normalized : rawTag.toLowerCase();
            if (!seenNorm.has(key)) {
              seenNorm.add(key);
              dedupedTags.push(rawTag);
            }
          }

          plan = {
            mode,
            source: sourceKind,
            userId: activeUserIdRef.current ?? activeHandoff?.userId ?? null,
            itemId: resolvedItemId,
            itemName: resolvedItemName,
            isNewItem,
            ...(isNewItem ? { itemCreateIdempotencyKey: createIdempotencyKey() } : {}),
            itemCreateUncertainSend: false,
            tagTasks: dedupedTags.map((display) => ({
              display,
              idempotencyKey: createIdempotencyKey(),
              uncertainSend: false,
            })),
            ...(dedupedTags.length > 0
              ? { assignTagsIdempotencyKey: createIdempotencyKey() }
              : {}),
            assignTagsUncertainSend: false,
            ...(sealedJson ? { sealedJson } : {}),
            ...(sealedText ? { sealedText } : {}),
            entryUncertainSend: false,
            clearGeneration: capturedClearGen,
          };
          activePlanRef.current = plan;
        }

        await executePlan(plan, ownerId, capturedEpoch);
      } catch (err) {
        if (
          lockEpochRef.current !== capturedEpoch ||
          saveOwnerIdRef.current !== ownerId ||
          (vault.state !== undefined && vault.state !== 'unlocked')
        ) {
          if (saveOwnerIdRef.current === ownerId) {
            saveOwnerIdRef.current = 0;
            saveLockRef.current = false;
            setSavingInFlight(false);
          }
          return;
        }
        saveOwnerIdRef.current = 0;
        saveLockRef.current = false;
        setSavingInFlight(false);
        if (err instanceof EntrySealError) {
          if (err.code === 'STALE_GENERATION' || err.code === 'VAULT_LOCKED') {
            return;
          }
          const i18nKey: ContentErrorI18nKey =
            err.code === 'ENTRY_TOO_LARGE'
              ? 'content.errors.entry_too_large'
              : 'content.errors.entry_invalid';
          const msg = translateContentError(i18nKey);
          setSaveError(msg);
          onAnnounce?.(msg);
          return;
        }
        const classified = classifyContentMutationError(err);
        const msg = translateContentError(classified.i18nKey);
        setSaveError(msg);
        onAnnounce?.(msg);
      }
    },
    [
      activeHandoff?.userId,
      effectiveItemId,
      effectiveItemName,
      effectiveTags,
      executePlan,
      formatBeforeSave,
      formattedBytesPreview,
      holderRef,
      onAnnounce,
      sourceKind,
      tEntry,
      translateContentError,
      unconfirmedSaveState,
      unlocked,
      vault,
    ],
  );

  const handleSubmit = useCallback(
    async (mode: 'json' | 'text', forceCreateNew = false) => {
      if (!vault || !unlocked || saveLockRef.current) return;
      if (mode === 'json' && !canSubmitJson && !unconfirmedSaveState) return;
      if (mode === 'text' && !canSaveAsText && !unconfirmedSaveState) return;

      // Retry existing in-memory plan directly with identical idempotency keys & ciphertext
      if (unconfirmedSaveState) {
        saveLockRef.current = true;
        const ownerId = nextSaveOwnerIdRef.current + 1;
        nextSaveOwnerIdRef.current = ownerId;
        saveOwnerIdRef.current = ownerId;
        const capturedEpoch = lockEpochRef.current;
        setSavingInFlight(true);
        setSaveError(null);
        await executePlan(unconfirmedSaveState.plan, ownerId, capturedEpoch);
        return;
      }

      // If opened on a specific existing item page (`effectiveItemId` known), import directly into it
      if (effectiveItemId) {
        await startImportForResolvedTarget({
          mode,
          targetItem: {
            id: effectiveItemId,
            name: effectiveItemName,
            hint: null,
            tags: [],
            entry_count: effectiveEntryCount,
            version: 1,
            created_at: '',
            updated_at: '',
            last_used_at: '',
          },
          isNewItem: false,
        });
        return;
      }

      // Omnibox handoff without a known `itemId`: resolve item name via `GET /items/lookup?name=`
      if (forceCreateNew) {
        await startImportForResolvedTarget({
          mode,
          targetItem: null,
          isNewItem: true,
        });
        return;
      }

      const capturedEpoch = lockEpochRef.current;
      try {
        const lookupKey = contentQueryKeys.lookup(effectiveItemName);
        const lookupRes = queryClient
          ? await queryClient.fetchQuery({
              queryKey: lookupKey,
              queryFn: ({ signal }) =>
                itemsLookupExact({ name: effectiveItemName, signal }),
              gcTime: 0,
              staleTime: 0,
            })
          : await itemsLookupExact({ name: effectiveItemName });

        if (lockEpochRef.current !== capturedEpoch) return;

        const matchedItems = lookupRes.items ?? [];
        const total = lookupRes.total ?? matchedItems.length;

        if (total === 0 || matchedItems.length === 0) {
          await startImportForResolvedTarget({
            mode,
            targetItem: null,
            isNewItem: true,
          });
          return;
        }

        if (total === 1 && matchedItems.length === 1) {
          await startImportForResolvedTarget({
            mode,
            targetItem: matchedItems[0]!,
            isNewItem: false,
          });
          return;
        }

        setDupPickerState({
          mode,
          name: effectiveItemName,
          tags: effectiveTags,
          initialItems: matchedItems,
          total,
          nextCursor: lookupRes.next_cursor ?? null,
        });
      } catch (err) {
        if (lockEpochRef.current !== capturedEpoch) return;
        const classified = classifyContentMutationError(err);
        setSaveError(translateContentError(classified.i18nKey));
      }
    },
    [
      canSaveAsText,
      canSubmitJson,
      effectiveEntryCount,
      effectiveItemId,
      effectiveItemName,
      effectiveTags,
      executePlan,
      queryClient,
      startImportForResolvedTarget,
      translateContentError,
      unconfirmedSaveState,
      unlocked,
      vault,
    ],
  );

  const handleDupPickerPick = useCallback(
    (selection: DupPickerSelection) => {
      const pending = dupPickerState;
      setDupPickerState(null);
      if (!pending) return;
      if (selection.kind === 'create-new') {
        void startImportForResolvedTarget({
          mode: pending.mode,
          targetItem: null,
          isNewItem: true,
        });
      } else {
        void startImportForResolvedTarget({
          mode: pending.mode,
          targetItem: selection.item,
          isNewItem: false,
        });
      }
    },
    [dupPickerState, startImportForResolvedTarget],
  );

  const handleDupPickerCancel = useCallback(() => {
    setDupPickerState(null);
    textareaRef.current?.focus();
  }, []);

  const handleDialogKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDialogElement>) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (e.key === 'Tab') {
        const dlg = dialogRef.current;
        if (dlg) {
          const focusables = Array.from(
            dlg.querySelectorAll<HTMLElement>(
              'button:not(:disabled), textarea:not(:disabled), input:not(:disabled):not(.sr-only), select:not(:disabled), [tabindex]:not([tabindex="-1"]):not(:disabled)',
            ),
          );
          if (focusables.length > 0) {
            const first = focusables[0]!;
            const last = focusables[focusables.length - 1]!;
            const active = document.activeElement as HTMLElement | null;
            if (e.shiftKey) {
              if (!active || active === first || !dlg.contains(active)) {
                e.preventDefault();
                last.focus();
              }
            } else if (!active || active === last || !dlg.contains(active)) {
              e.preventDefault();
              first.focus();
            }
          }
        }
        return;
      }
      const lower = (e.key || '').toLowerCase();
      if ((lower === 's' || e.key === 'Enter') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (canSubmitJson) {
          void handleSubmit('json', e.key === 'Enter' && !effectiveItemId);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!savingInFlight) {
          handleClose();
        }
      }
    },
    [canSubmitJson, effectiveItemId, handleClose, handleSubmit, savingInFlight],
  );

  if (!isOpen || !unlocked) {
    return null;
  }

  const formattedByteCount = format.number(utf8ByteLength);

  // Source badge text (`#importSourceBadge` in mockups/item.html)
  const sourceBadgeText = utf8FileError
    ? tJson('importSourceBadgeUtf8Error')
    : sourceKind === 'file'
      ? tJson('importSourceBadgeFile', { bytes: formattedByteCount })
      : tJson('importSourceBadgePaste', { bytes: formattedByteCount });

  // Live status line (`#importStatusLine` in mockups/item.html)
  let statusLineText: string;
  let statusLineClass = 'text-muted';
  if (atEntryLimit) {
    statusLineText = tJson('importStatusLimit200');
    statusLineClass = 'font-medium text-warning';
  } else if (utf8FileError) {
    statusLineText = tJson('importStatusUtf8Error');
    statusLineClass = 'font-medium text-danger';
  } else if (isOverCap) {
    statusLineText = tJson('importStatusOverCap', { bytes: formattedByteCount });
    statusLineClass = 'font-medium text-danger';
  } else if (parseError) {
    statusLineText = tJson('importStatusParseError', {
      line: parseError.line,
      column: parseError.column,
    });
    statusLineClass = 'font-medium text-danger';
  } else if (validDoc) {
    statusLineClass = 'font-medium text-success-ink';
    if (validDoc.root.kind === 'object') {
      statusLineText = tJson('importStatusValidObject', {
        count: validDoc.root.properties.length,
      });
    } else if (validDoc.root.kind === 'array') {
      statusLineText = tJson('importStatusValidArray', {
        count: validDoc.root.elements.length,
      });
    } else {
      statusLineText = tJson('importStatusValidScalar', {
        kind: validDoc.root.kind,
      });
    }
  } else {
    statusLineText = tJson('importStatusEmpty');
  }

  return (
    <>
      <dialog
        ref={dialogRef}
        id="importDlg"
        data-testid="import-json-dialog"
        aria-modal="true"
        aria-labelledby="importTitle"
        onKeyDown={handleDialogKeyDown}
        onCancel={(e) => {
          e.preventDefault();
          if (!savingInFlight) {
            handleClose();
          }
        }}
      >
        <div className="panel import-panel flex max-h-[calc(100dvh-24px)] w-[min(720px,94vw)] flex-col overflow-hidden p-0">
          <div className="min-h-0 flex-1 overflow-y-auto p-5 pb-4 sm:p-6 sm:pb-4">
            {/* Header */}
          <div className="mb-1 flex items-start justify-between gap-2">
            <h2 id="importTitle" className="t-title-sm m-0">
              {tJson('importTitle', { name: effectiveItemName })}
              <span className="phase-badge">{tJson('importBadge')}</span>
            </h2>
            <button
              ref={closeBtnRef}
              type="button"
              data-testid="import-json-close-btn"
              className="btn btn-tertiary btn-sm"
              disabled={savingInFlight}
              onClick={() => handleClose()}
            >
              {tEntry('cancel')}
            </button>
          </div>

          <p id="importSubtitle" className="t-body mb-1.5 text-muted">
            {tJson('importSubtitle')}
          </p>
          <p
            id="importDestination"
            data-testid="import-json-destination"
            className="mb-3 text-[13px] text-body"
          >
            {effectiveIsCurrentItem
              ? tJson('importDestCurrent', { name: effectiveItemName })
              : tJson('importDestResolved', { name: effectiveItemName })}
          </p>

          {/* 1. Limit 200 entries callout (`#importLimit200Notice`) */}
          {atEntryLimit ? (
            <div
              id="importLimit200Notice"
              role="alert"
              data-testid="import-json-limit-notice"
              className="card-warn mb-3 rounded-md p-3.5"
            >
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <p className="m-0 text-[13px] font-semibold text-body">
                  {tJson('importLimitTitle')}
                </p>
                <span className="mono text-[11px] text-muted">
                  {tJson('importLimitBadge')}
                </span>
              </div>
              <p className="m-0 text-[13px] text-muted">
                {tJson('importLimitBody', { name: effectiveItemName })}
              </p>
            </div>
          ) : null}

          {/* 2. Fatal UTF-8 decode error callout (`#importUtf8Error`) */}
          {!atEntryLimit && utf8FileError ? (
            <div
              id="importUtf8Error"
              role="alert"
              data-testid="import-json-utf8-error"
              className="card-error mb-3 rounded-md p-3.5"
            >
              <p className="m-0 mb-1 text-[13px] font-semibold text-danger">
                {tJson('importUtf8ErrorTitle')}
              </p>
              <p className="m-0 text-[13px] text-body">{tJson('importUtf8ErrorBody')}</p>
            </div>
          ) : null}

          {/* 3. > 256 KiB over-cap error callout */}
          {!atEntryLimit && !utf8FileError && isOverCap ? (
            <div
              role="alert"
              data-testid="import-json-over-cap-error"
              className="card-error mb-3 rounded-md p-3.5"
            >
              <p className="m-0 mb-1 text-[13px] font-semibold text-danger">
                {tJson('importOverCapTitle')}
              </p>
              <p className="m-0 text-[13px] text-body">{tJson('importOverCapBody')}</p>
            </div>
          ) : null}

          {/* 4. Parse error callout (`#importParseError`) with "Save as text" escape hatch */}
          {!atEntryLimit && !utf8FileError && !isOverCap && parseError ? (
            <div
              id="importParseError"
              role="alert"
              data-testid="import-json-parse-error"
              className="card-error mb-3 rounded-md p-3.5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-[200px] flex-1">
                  <button
                    type="button"
                    data-testid="import-json-parse-error-jump"
                    className="m-0 mb-1 cursor-pointer border-0 bg-transparent p-0 text-left text-[13px] font-semibold text-danger underline"
                    onClick={handleFocusErrorLine}
                  >
                    {tJson('importParseErrorTitle', {
                      line: parseError.line,
                      column: parseError.column,
                    })}
                    {': '}
                  </button>
                  <p className="m-0 text-[13px] text-body">
                    {tJson('importParseErrorBody', {
                      detail: translateParseError(parseError),
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  id="importSaveAsTextBtn"
                  data-testid="import-json-save-as-text-btn"
                  className="btn btn-secondary btn-sm shrink-0"
                  disabled={!canSaveAsText}
                  onClick={() => {
                    void handleSubmit('text');
                  }}
                >
                  {tJson('importSaveAsTextBtn')}
                </button>
              </div>
            </div>
          ) : null}

          {/* Target 20-tag cap alert when importing from omnibox handoff */}
          {targetTagLimitCount !== null ? (
            <div
              role="alert"
              data-testid="import-json-tag-limit-error"
              className="auth-alert mb-3"
            >
              {tOmni('addErrorTargetTagLimit', { count: targetTagLimitCount })}
            </div>
          ) : null}

          {/* Format warning (depth > 20 or formatted > 256 KiB) */}
          {formatWarning ? (
            <div
              role="alert"
              data-testid="import-json-format-warning"
              className="auth-alert mb-3"
            >
              {formatWarning}
            </div>
          ) : null}

          {/* Save error / retryable unconfirmed save banner */}
          {unconfirmedSaveState ? (
            <div
              role="alert"
              data-testid="import-json-retry-banner"
              className="auth-alert mb-3 flex flex-wrap items-center justify-between gap-2"
            >
              <span>{unconfirmedSaveState.errorMessage}</span>
              <button
                type="button"
                data-testid="import-json-retry-btn"
                className="btn btn-secondary btn-sm"
                disabled={savingInFlight}
                onClick={() => {
                  void handleSubmit(unconfirmedSaveState.plan.mode);
                }}
              >
                {tEntry('retry')}
              </button>
            </div>
          ) : saveError ? (
            <div role="alert" data-testid="import-json-save-error" className="auth-alert mb-3">
              {saveError}
            </div>
          ) : null}

          {/* Source controls + textarea */}
          <div className="mb-3">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="importSource" className="field-label m-0">
                {tJson('importSourceLabel')}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  id="importFileInput"
                  data-testid="import-json-file-input"
                  accept=".json,application/json"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  disabled={atEntryLimit || savingInFlight || unconfirmedSaveState !== null}
                  onChange={(e) => {
                    void handleFileChange(e);
                  }}
                />
                <button
                  type="button"
                  id="importChooseFileBtn"
                  data-testid="import-json-choose-file-btn"
                  className="btn btn-secondary btn-sm"
                  disabled={atEntryLimit || savingInFlight || unconfirmedSaveState !== null}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {tJson('importChooseFileBtn')}
                </button>
                {hasLoadedFile ? (
                  <button
                    type="button"
                    id="importClearFileBtn"
                    data-testid="import-json-clear-file-btn"
                    className="btn btn-tertiary btn-sm"
                    disabled={savingInFlight || unconfirmedSaveState !== null}
                    onClick={handleClearFile}
                  >
                    {tJson('importClearFileBtn')}
                  </button>
                ) : null}
                <span
                  id="importSourceBadge"
                  data-testid="import-json-source-badge"
                  className={
                    isOverCap || utf8FileError
                      ? 'mono text-[12px] font-semibold text-danger'
                      : isNearCap
                        ? 'mono text-[12px] font-semibold text-warning'
                        : 'mono text-[12px] text-muted'
                  }
                >
                  {sourceBadgeText}
                </span>
              </div>
            </div>

            <textarea
              ref={textareaRef}
              id="importSource"
              data-testid="import-json-source-textarea"
              rows={5}
              value={draftText}
              disabled={atEntryLimit || savingInFlight || unconfirmedSaveState !== null}
              readOnly={unconfirmedSaveState !== null}
              aria-invalid={utf8FileError || isOverCap || parseError !== null}
              placeholder={tJson('importSourcePlaceholder')}
              className="field-input raw-json-editor"
              onChange={handleTextareaChange}
              onPaste={handlePaste}
              {...VAULT_SECRET_INPUT_PROPS}
            />

            <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
              <span
                id="importStatusLine"
                role="status"
                aria-live="polite"
                data-testid="import-json-status-line"
                className={statusLineClass}
              >
                {statusLineText}
              </span>
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-body">
                <input
                  type="checkbox"
                  id="importFormatBeforeSave"
                  data-testid="import-json-format-checkbox"
                  checked={formatBeforeSave}
                  disabled={
                    atEntryLimit ||
                    savingInFlight ||
                    unconfirmedSaveState !== null ||
                    !validDoc
                  }
                  onChange={handleToggleFormatBeforeSave}
                  className="accent-[var(--accent)]"
                />
                <span>{tJson('importFormatBeforeSave')}</span>
                {formatBeforeSave && formattedBytesPreview?.ok ? (
                  <span
                    data-testid="import-json-formatted-byte-badge"
                    className="mono text-[11px] text-muted"
                  >
                    ({format.number(formattedBytesPreview.bytes)} B)
                  </span>
                ) : null}
              </label>
            </div>
            <p
              data-testid="import-json-paste-exact-hint"
              className="m-0 mt-1 text-[12px] text-muted"
            >
              {tJson('pasteExactHint')}
            </p>
          </div>

          {/* Preview section (read-only Table / Raw preview via JsonTreeGrid) */}
          <div className="mb-4">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <span className="t-label text-muted">{tJson('importPreviewLabel')}</span>
              <div
                role="group"
                aria-label={tJson('importPreviewModeAria')}
                data-testid="import-json-preview-mode-switcher"
                className="seg"
              >
                <button
                  type="button"
                  data-testid="import-json-preview-tab-table"
                  aria-pressed={previewMode === 'table'}
                  disabled={!validDoc}
                  className="seg-btn"
                  onClick={() => setPreviewMode('table')}
                >
                  {tJson('tabTable')}
                </button>
                <button
                  type="button"
                  data-testid="import-json-preview-tab-raw"
                  aria-pressed={previewMode === 'raw'}
                  disabled={!validDoc}
                  className="seg-btn"
                  onClick={() => setPreviewMode('raw')}
                >
                  {tJson('tabRaw')}
                </button>
              </div>
            </div>

            <div
              id="importPreviewHost"
              data-testid="import-json-preview-host"
              className="max-h-[220px] overflow-auto rounded-md border border-line bg-canvas"
            >
              {validDoc ? (
                previewMode === 'table' ? (
                  <JsonTreeGrid
                    entryId="import-preview"
                    document={validDoc}
                    readOnly
                    expandedPaths={expandedPaths}
                    pageByPath={pageByPath}
                    onToggleExpand={handleToggleExpand}
                    onPageChange={handlePageChange}
                    onApplyEdit={() => true}
                  />
                ) : (
                  <pre
                    aria-label={tJson('importPreviewRawAria')}
                    data-testid="import-json-preview-raw"
                    className="mono m-0 whitespace-pre-wrap break-words p-3 text-[13px] text-body"
                    {...VAULT_SECRET_INPUT_PROPS}
                  >
                    {effectiveSubmitText}
                  </pre>
                )
              ) : (
                <div
                  id="importPreviewPlaceholder"
                  data-testid="import-json-preview-placeholder"
                  className="p-4 text-[13px] text-muted"
                >
                  {parseError || utf8FileError || isOverCap
                    ? tJson('importPreviewInvalid')
                    : tJson('importPreviewEmpty')}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
          <div className="import-foot flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-5 py-3.5 sm:px-6">
            <span className="mono text-[12px] text-muted">
              {tJson('importFooterNote')} · <span className="kbd">Ctrl+S</span>
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="import-json-cancel-btn"
                className="btn btn-tertiary btn-sm"
                disabled={savingInFlight}
                onClick={() => handleClose()}
              >
                {tEntry('cancel')}
              </button>
              <button
                type="button"
                id="importSubmitBtn"
                data-testid="import-json-submit-btn"
                className="btn btn-primary btn-sm"
                disabled={!canSubmitJson}
                aria-busy={savingInFlight || undefined}
                onClick={() => {
                  void handleSubmit('json');
                }}
              >
                {savingInFlight ? tJson('importSubmittingBtn') : tJson('importSubmitBtn')}
              </button>
            </div>
          </div>
        </div>
      </dialog>

      <DupPickerDialog
        open={dupPickerState !== null}
        name={dupPickerState?.name ?? ''}
        initialItems={dupPickerState?.initialItems ?? []}
        total={dupPickerState?.total ?? 0}
        initialNextCursor={dupPickerState?.nextCursor ?? null}
        onPick={handleDupPickerPick}
        onCancel={handleDupPickerCancel}
      />
    </>
  );
}
