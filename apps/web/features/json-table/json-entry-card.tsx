'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { useSession } from '@/features/auth/session-provider';
import {
  ENTRY_MAX_PLAINTEXT_BYTES,
  ENTRY_NEAR_CAP_BYTES,
  captureEntrySaveOpGuard,
  copyEntryPlaintextToClipboard,
  ensureVaultForEntrySeal,
  loadRealEntryBody,
  mutateSealedEntryCreate,
  mutateSealedEntryUpdate,
  recordUnconfirmedSave,
  sealEntryUpdate,
  sealNewEntry,
  toEntryCreateVariables,
  toEntryUpdateVariables,
  type EditorPlaintextHolder,
  type SealedEntryUpdatePayload,
  type SealedNewEntryPayload,
} from '@/features/entries';
import {
  LockMask,
  useEntryBody,
  useEntryInViewport,
  type EntryBodyLoader,
} from '@/features/items/entry-body';
import { contentQueryKeys } from '@/features/items/query-keys';
import {
  JsonRawEditor,
  validateRawJsonText,
} from '@/features/json-table/json-raw-editor';
import { JsonTreeGrid } from '@/features/json-table/json-tree-grid';
import { useOptionalVault, vaultBodyQueryKey } from '@/features/vault/vault-provider';
import {
  classifyContentMutationError,
  entryGet,
  type ContentErrorI18nKey,
  type EntryMeta,
} from '@/lib/api/content';
import {
  applyTextareaEol,
  detectEol,
  measureUtf8Bytes,
  normalizeEolToLf,
  parseJsonStrict,
  type JsonEditOutcome,
} from '@/lib/json';

export type JsonCardMode = 'table' | 'raw';

export type JsonNewPresetId = 'empty-object' | 'empty-array';

export const JSON_NEW_PRESETS: Readonly<Record<JsonNewPresetId, string>> = {
  'empty-object': '{}',
  'empty-array': '[]',
};

export interface JsonEntryCardProps {
  readonly entry: EntryMeta;
  readonly itemId: string;
  readonly itemName?: string;
  readonly index: number;
  readonly total: number;
  readonly canReorder: boolean;
  readonly load?: EntryBodyLoader;
  readonly lazy?: boolean;
  readonly onMoveUp: (entryId: string, restoreFocusEl?: HTMLElement | null) => void;
  readonly onMoveDown: (entryId: string, restoreFocusEl?: HTMLElement | null) => void;
  readonly onDelete: (entry: EntryMeta, index: number) => void;
  readonly onAnnounce?: (message: string) => void;
  readonly onDraftClearedOnLock?: () => void;
  readonly registerCardElement?: (entryId: string, el: HTMLElement | null) => void;
  readonly onDragStart?: (index: number, e: DragEvent<HTMLElement>) => void;
  readonly onDragOver?: (index: number, e: DragEvent<HTMLElement>) => void;
  readonly onDrop?: (index: number, e: DragEvent<HTMLElement>) => void;
  readonly onDragEnd?: () => void;
  readonly rawParseDebounceMs?: number;
  readonly editorPlaintextHolderRef?: { current: EditorPlaintextHolder };
}

export function JsonEntryCard({
  entry,
  itemId,
  itemName = '',
  index,
  total,
  canReorder,
  load = loadRealEntryBody,
  lazy = true,
  onMoveUp,
  onMoveDown,
  onDelete,
  onAnnounce,
  onDraftClearedOnLock,
  registerCardElement,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  rawParseDebounceMs,
  editorPlaintextHolderRef,
}: JsonEntryCardProps) {
  const tEntry = useTranslations('content.entry');
  const tJson = useTranslations('content.json');
  const tLocked = useTranslations('vault.locked');
  const tErrors = useTranslations('content.errors');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const vault = useOptionalVault();
  const { me } = useSession();

  const translateContentError = useCallback(
    (key: ContentErrorI18nKey): string => {
      const code = key.replace(/^content\.errors\./, '');
      return tErrors(code as Parameters<typeof tErrors>[0]);
    },
    [tErrors],
  );

  const [cardEl, setCardEl] = useState<HTMLElement | null>(null);
  const handleCardRef = useCallback(
    (el: HTMLElement | null) => {
      setCardEl(el);
      registerCardElement?.(entry.id, el);
    },
    [entry.id, registerCardElement],
  );

  const inViewport = useEntryInViewport(cardEl, { disabled: !lazy });

  const {
    unlocked,
    pending,
    body,
    oldKey,
    decryptFailed,
    failed,
    errorKind,
    resolvedVersion,
    refetch,
  } = useEntryBody(entry.id, entry.version, load, {
    enabled: inViewport,
    itemId,
  });

  const currentVersion = resolvedVersion ?? entry.version;
  const [committedVersion, setCommittedVersion] = useState<number | null>(null);
  const effectiveVersion =
    committedVersion !== null && committedVersion > currentVersion
      ? committedVersion
      : currentVersion;

  useEffect(() => {
    if (committedVersion !== null && currentVersion >= committedVersion) {
      setCommittedVersion(null);
    }
  }, [committedVersion, currentVersion]);

  // Mode: 'table' | 'raw'
  const [mode, setMode] = useState<JsonCardMode>('table');

  // Authoritative base JSON string (last loaded / saved body)
  const [originalSource, setOriginalSource] = useState<string>('');
  // Current table working source (reflects inline table edits losslessly)
  const [tableSource, setTableSource] = useState<string>('');
  // Current raw textarea draft (LF-normalized while in raw mode)
  const [rawDraftValue, setRawDraftValue] = useState<string>('');
  // Track whether rawDraftValue has been edited since entering raw mode
  const [rawEditedSinceSwitch, setRawEditedSinceSwitch] = useState<boolean>(false);

  // Treegrid UI state (expanded containers and pagination per container path)
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [pageByPath, setPageByPath] = useState<ReadonlyMap<string, number>>(
    () => new Map<string, number>(),
  );

  const [discardConfirmOpen, setDiscardConfirmOpen] = useState<boolean>(false);
  const [mixedEolWarningTarget, setMixedEolWarningTarget] = useState<string | null>(null);
  const [switchBlockedError, setSwitchBlockedError] = useState<string | null>(null);
  const [savingInFlight, setSavingInFlight] = useState<boolean>(false);
  const [unconfirmedSave, setUnconfirmedSave] = useState<{
    readonly sealed: SealedEntryUpdatePayload;
    readonly ifMatch: number;
    readonly errorMessage: string;
    readonly submittedRevision: number;
  } | null>(null);
  const [conflictState, setConflictState] = useState<{
    readonly currentVersion?: number;
    readonly reloadConfirmOpen: boolean;
  } | null>(null);
  const [deletedRemotely, setDeletedRemotely] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState<boolean>(false);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [resetEpoch, setResetEpoch] = useState<number>(0);

  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuPopRef = useRef<HTMLDivElement | null>(null);
  const tabTableBtnRef = useRef<HTMLButtonElement | null>(null);
  const tabRawBtnRef = useRef<HTMLButtonElement | null>(null);
  const saveLockRef = useRef<boolean>(false);
  const saveOwnerIdRef = useRef<number>(0);
  const nextSaveOwnerIdRef = useRef<number>(0);
  const lockEpochRef = useRef<number>(0);
  const editorRevisionRef = useRef<number>(0);

  // Resettable holder so Keep mine / Retry / async callbacks never capture stale plaintext in closures (IP15-BE2-1)
  const internalPlaintextHolderRef = useRef<EditorPlaintextHolder>({
    originalSource: '',
    draftValue: '',
    submittedCandidateSource: '',
    tableSource: '',
  });
  const plaintextHolderRef = editorPlaintextHolderRef ?? internalPlaintextHolderRef;
  const clearEditorPlaintextHolderSync = useCallback(() => {
    plaintextHolderRef.current.originalSource = '';
    plaintextHolderRef.current.draftValue = '';
    plaintextHolderRef.current.submittedCandidateSource = '';
    plaintextHolderRef.current.tableSource = '';
    setOriginalSource('');
    setTableSource('');
    setRawDraftValue('');
    setRawEditedSinceSwitch(false);
  }, [plaintextHolderRef]);

  const releaseSaveGuardIfOwner = useCallback((ownerId: number) => {
    if (saveOwnerIdRef.current !== ownerId) return;
    saveOwnerIdRef.current = 0;
    saveLockRef.current = false;
    setSavingInFlight(false);
  }, []);

  // Initialize or rebase originalSource & tableSource when decrypted body arrives and card is clean
  useEffect(() => {
    if (!unlocked || body === undefined) return;
    const hasUnsavedWork =
      (originalSource !== '' && tableSource !== originalSource) ||
      rawEditedSinceSwitch ||
      unconfirmedSave !== null ||
      conflictState !== null ||
      savingInFlight;

    if (!hasUnsavedWork && originalSource !== body) {
      const normalized = normalizeEolToLf(body);
      plaintextHolderRef.current.originalSource = body;
      plaintextHolderRef.current.tableSource = body;
      plaintextHolderRef.current.draftValue = normalized;
      setOriginalSource(body);
      setTableSource(body);
      setRawDraftValue(normalized);
      setRawEditedSinceSwitch(false);
    }
  }, [
    body,
    conflictState,
    originalSource,
    plaintextHolderRef,
    rawEditedSinceSwitch,
    savingInFlight,
    tableSource,
    unconfirmedSave,
    unlocked,
  ]);

  // Rebase originalSource when useEntryBody resolves authoritative body for committedVersion while user kept editing (IP15-BE2-3)
  useEffect(() => {
    if (
      unlocked &&
      body !== undefined &&
      committedVersion !== null &&
      currentVersion === committedVersion &&
      originalSource !== body
    ) {
      plaintextHolderRef.current.originalSource = body;
      setOriginalSource(body);
    }
  }, [body, committedVersion, currentVersion, originalSource, plaintextHolderRef, unlocked]);

  // Compute current candidate JSON source and EOL plan
  const baseForRawEol = tableSource || originalSource || body || '{}';
  const rawEolInfo = useMemo(() => detectEol(baseForRawEol), [baseForRawEol]);
  const rawSavePlan = useMemo(
    () => applyTextareaEol(baseForRawEol, rawDraftValue, rawEolInfo),
    [baseForRawEol, rawDraftValue, rawEolInfo],
  );

  // If in raw mode and user edited raw textarea, candidate is rawSavePlan.text; otherwise tableSource
  const candidateSource = useMemo(() => {
    if (mode === 'raw' && rawEditedSinceSwitch) {
      return rawSavePlan.text;
    }
    return tableSource;
  }, [mode, rawEditedSinceSwitch, rawSavePlan.text, tableSource]);

  // Keep holder in sync with latest candidate
  plaintextHolderRef.current.originalSource = originalSource;
  plaintextHolderRef.current.tableSource = tableSource;
  plaintextHolderRef.current.draftValue =
    mode === 'raw' && rawEditedSinceSwitch ? rawDraftValue : normalizeEolToLf(tableSource);

  const isDirty = useMemo(() => {
    if (!unlocked || originalSource === '') return false;
    return candidateSource !== originalSource;
  }, [candidateSource, originalSource, unlocked]);

  const hasActiveDraftOrStateRef = useRef<boolean>(false);
  hasActiveDraftOrStateRef.current =
    isDirty ||
    mode === 'raw' ||
    unconfirmedSave !== null ||
    conflictState !== null ||
    deletedRemotely;

  // Register secret form reset on vault lock / auto-lock / user switch / logout (plan §2.10, P4FE1-8)
  useEffect(() => {
    if (!vault?.registerSecretFormReset) return;
    return vault.registerSecretFormReset(() => {
      const hadActiveDraft = hasActiveDraftOrStateRef.current;
      lockEpochRef.current += 1;
      editorRevisionRef.current = 0;
      setCommittedVersion(null);
      clearEditorPlaintextHolderSync();
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      setMode('table');
      setExpandedPaths(new Set());
      setPageByPath(new Map());
      setDiscardConfirmOpen(false);
      setMixedEolWarningTarget(null);
      setSwitchBlockedError(null);
      setSavingInFlight(false);
      setUnconfirmedSave(null);
      setConflictState(null);
      setDeletedRemotely(false);
      setSaveError(null);
      setMenuOpen(false);
      setResetEpoch((prev) => prev + 1);
      if (hadActiveDraft) {
        onDraftClearedOnLock?.();
      }
    });
  }, [clearEditorPlaintextHolderSync, onDraftClearedOnLock, vault]);

  // Also clear immediately if `unlocked` flips to false
  useEffect(() => {
    if (!unlocked) {
      lockEpochRef.current += 1;
      editorRevisionRef.current = 0;
      setCommittedVersion(null);
      clearEditorPlaintextHolderSync();
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      setMode('table');
      setExpandedPaths(new Set());
      setPageByPath(new Map());
      setDiscardConfirmOpen(false);
      setMixedEolWarningTarget(null);
      setSwitchBlockedError(null);
      setSavingInFlight(false);
      setUnconfirmedSave(null);
      setConflictState(null);
      setDeletedRemotely(false);
      setSaveError(null);
      setMenuOpen(false);
      setResetEpoch((prev) => prev + 1);
    }
  }, [clearEditorPlaintextHolderSync, unlocked]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handleDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        !menuPopRef.current?.contains(target) &&
        !menuTriggerRef.current?.contains(target)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('click', handleDocClick);
    return () => {
      document.removeEventListener('click', handleDocClick);
    };
  }, [menuOpen]);

  // Focus first enabled menu item when menu opens
  useEffect(() => {
    if (!menuOpen) return;
    const firstItem = menuPopRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    );
    firstItem?.focus();
  }, [menuOpen]);

  // Parse the tableSource into a JsonDocument
  const parsedTableDocResult = useMemo(() => {
    if (!unlocked || !tableSource) return null;
    return parseJsonStrict(tableSource);
  }, [tableSource, unlocked]);

  const currentDoc =
    parsedTableDocResult && parsedTableDocResult.ok ? parsedTableDocResult.document : null;

  // Validate candidateSource when in raw mode
  const rawValidationIssue = useMemo(() => {
    if (mode !== 'raw') return null;
    return validateRawJsonText(rawDraftValue);
  }, [mode, rawDraftValue]);

  const utf8ByteLength = useMemo(
    () => (candidateSource ? measureUtf8Bytes(candidateSource) : 0),
    [candidateSource],
  );
  const isOverCap = utf8ByteLength > ENTRY_MAX_PLAINTEXT_BYTES;
  const isNearCap = !isOverCap && utf8ByteLength >= ENTRY_NEAR_CAP_BYTES;
  const isEmpty = utf8ByteLength === 0;

  const formattedBytes = useMemo(() => {
    try {
      return format.number(utf8ByteLength);
    } catch {
      return String(utf8ByteLength);
    }
  }, [format, utf8ByteLength]);

  const showEditControls =
    mode === 'raw' ||
    isDirty ||
    savingInFlight ||
    unconfirmedSave !== null ||
    conflictState !== null ||
    deletedRemotely ||
    saveError !== null;

  const saveDisabled =
    isEmpty ||
    isOverCap ||
    (mode === 'raw' && rawValidationIssue !== null) ||
    (mode === 'table' && !currentDoc) ||
    savingInFlight ||
    unconfirmedSave !== null ||
    conflictState !== null ||
    deletedRemotely;

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

  const handleApplyTableEdit = useCallback(
    (outcome: JsonEditOutcome & { readonly ok: true }): boolean => {
      if (measureUtf8Bytes(outcome.source) > ENTRY_MAX_PLAINTEXT_BYTES) {
        return false;
      }
      editorRevisionRef.current += 1;
      plaintextHolderRef.current.tableSource = outcome.source;
      plaintextHolderRef.current.draftValue = normalizeEolToLf(outcome.source);
      setTableSource(outcome.source);
      setRawDraftValue(normalizeEolToLf(outcome.source));
      setRawEditedSinceSwitch(false);
      setSavedFlash(false);
      if (discardConfirmOpen) setDiscardConfirmOpen(false);
      if (mixedEolWarningTarget) setMixedEolWarningTarget(null);
      return true;
    },
    [discardConfirmOpen, mixedEolWarningTarget, plaintextHolderRef],
  );

  // Switch between Table and Raw JSON (Task 16 item 5)
  const handleSwitchMode = useCallback(
    (targetMode: JsonCardMode) => {
      if (targetMode === mode) return;
      if ( targetMode === 'raw') {
        // Table -> Raw: populate raw textarea with LF-normalized tableSource; keep exact bytes via applyTextareaEol if no edit occurs
        setRawDraftValue(normalizeEolToLf(tableSource));
        setRawEditedSinceSwitch(false);
        setSwitchBlockedError(null);
        setMode('raw');
        return;
      }

      // Raw -> Table: if no raw edits occurred, return to tableSource byte-identically
      if (!rawEditedSinceSwitch || !rawSavePlan.changed) {
        setSwitchBlockedError(null);
        setMode('table');
        return;
      }

      // Validate rawDraftValue before allowing switch to Table
      const issue = validateRawJsonText(rawDraftValue);
      if (issue !== null) {
        setSwitchBlockedError(tJson('switchBlockedInvalidError'));
        onAnnounce?.(tJson('switchBlockedInvalidError'));
        return;
      }

      // Valid raw JSON edit -> update tableSource with EOL-preserved rawSavePlan.text and switch to Table
      const nextSource = rawSavePlan.text;
      plaintextHolderRef.current.tableSource = nextSource;
      setTableSource(nextSource);
      setRawEditedSinceSwitch(false);
      setSwitchBlockedError(null);
      setMode('table');
    },
    [
      mode,
      onAnnounce,
      plaintextHolderRef,
      rawDraftValue,
      rawEditedSinceSwitch,
      rawSavePlan.changed,
      rawSavePlan.text,
      tJson,
      tableSource,
    ],
  );

  const resetDraftToOriginal = useCallback(() => {
    const base = body ?? originalSource;
    const normalized = normalizeEolToLf(base);
    plaintextHolderRef.current.originalSource = base;
    plaintextHolderRef.current.tableSource = base;
    plaintextHolderRef.current.draftValue = normalized;
    plaintextHolderRef.current.submittedCandidateSource = '';
    saveOwnerIdRef.current = 0;
    saveLockRef.current = false;
    editorRevisionRef.current = 0;
    setOriginalSource(base);
    setTableSource(base);
    setRawDraftValue(normalized);
    setRawEditedSinceSwitch(false);
    setMode('table');
    setDiscardConfirmOpen(false);
    setMixedEolWarningTarget(null);
    setSwitchBlockedError(null);
    setUnconfirmedSave(null);
    setConflictState(null);
    setDeletedRemotely(false);
    setSaveError(null);
    setResetEpoch((prev) => prev + 1);
  }, [body, originalSource, plaintextHolderRef]);

  const requestCancelEdit = useCallback(() => {
    if (savingInFlight) return;
    if (!isDirty && unconfirmedSave === null && conflictState === null) {
      resetDraftToOriginal();
      return;
    }
    setDiscardConfirmOpen(true);
  }, [conflictState, isDirty, resetDraftToOriginal, savingInFlight, unconfirmedSave]);

  const executePut = useCallback(
    async (
      sealed: SealedEntryUpdatePayload,
      ifMatchVersion: number,
      hadPriorUncertainSend: boolean,
      submittedRevision: number,
      ownerId: number,
    ) => {
      setSavingInFlight(true);
      setSaveError(null);
      onAnnounce?.(tEntry('saving'));

      try {
        const { meta, applied } = await mutateSealedEntryUpdate(
          queryClient,
          toEntryUpdateVariables(sealed, ifMatchVersion, {
            itemId,
            uncertainPriorSend: hadPriorUncertainSend,
          }),
        );

        if (!applied || !sealed.isCurrent() || saveOwnerIdRef.current !== ownerId) {
          return;
        }

        releaseSaveGuardIfOwner(ownerId);
        setUnconfirmedSave(null);
        setConflictState(null);
        setDeletedRemotely(false);
        setDiscardConfirmOpen(false);
        setMixedEolWarningTarget(null);
        setSwitchBlockedError(null);
        setCommittedVersion(meta.version);

        const committedCandidate =
          plaintextHolderRef.current.submittedCandidateSource ?? '';
        plaintextHolderRef.current.submittedCandidateSource = '';

        if (editorRevisionRef.current === submittedRevision) {
          if (committedCandidate.length > 0) {
            const normalized = normalizeEolToLf(committedCandidate);
            plaintextHolderRef.current.originalSource = committedCandidate;
            plaintextHolderRef.current.tableSource = committedCandidate;
            plaintextHolderRef.current.draftValue = normalized;
            setOriginalSource(committedCandidate);
            setTableSource(committedCandidate);
            setRawDraftValue(normalized);
            setRawEditedSinceSwitch(false);
          }
          setMode('table');
        } else if (committedCandidate.length > 0) {
          // User kept editing while PUT was in flight -> rebase comparison base (IP15-BE2-3)
          plaintextHolderRef.current.originalSource = committedCandidate;
          setOriginalSource(committedCandidate);
        }

        setSavedFlash(true);
        onAnnounce?.(tEntry('savedAnnounce'));

        void queryClient.invalidateQueries({
          queryKey: vaultBodyQueryKey(entry.id, meta.version),
        });
      } catch (err) {
        if (!sealed.isCurrent() || saveOwnerIdRef.current !== ownerId) {
          return;
        }

        releaseSaveGuardIfOwner(ownerId);
        const classified = classifyContentMutationError(err, {
          hadUncertainSend: true,
        });

        if (classified.isLogoutBoundary) {
          if (me?.user?.id) {
            recordUnconfirmedSave({
              userId: me.user.id,
              itemId,
              itemName: itemName || itemId,
              source: 'entry',
            });
          }
          clearEditorPlaintextHolderSync();
          setMode('table');
          setUnconfirmedSave(null);
          setConflictState(null);
          return;
        }

        if (classified.kind === 'version_mismatch') {
          setUnconfirmedSave(null);
          setConflictState({
            currentVersion: classified.currentVersion,
            reloadConfirmOpen: false,
          });
          onAnnounce?.(tEntry('conflictTitle'));
          return;
        }

        if (classified.kind === 'entry_key_mismatch') {
          setUnconfirmedSave(null);
          void vault?.reloadVaultMeta();
          return;
        }

        if (classified.kind === 'not_found') {
          setUnconfirmedSave(null);
          setDeletedRemotely(true);
          const msg = translateContentError(classified.i18nKey);
          setSaveError(msg);
          onAnnounce?.(msg);
          return;
        }

        const msg = translateContentError(classified.i18nKey);
        if (classified.canRetrySameBytes) {
          setUnconfirmedSave({
            sealed,
            ifMatch: ifMatchVersion,
            errorMessage: msg,
            submittedRevision,
          });
          onAnnounce?.(msg);
          return;
        }

        setUnconfirmedSave(null);
        setSaveError(msg);
        onAnnounce?.(msg);
      }
    },
    [
      clearEditorPlaintextHolderSync,
      entry.id,
      itemId,
      itemName,
      me?.user?.id,
      onAnnounce,
      plaintextHolderRef,
      queryClient,
      releaseSaveGuardIfOwner,
      tEntry,
      translateContentError,
      vault,
    ],
  );

  const handleSave = useCallback(
    async (bypassMixedEolWarning = false) => {
      if (
        saveLockRef.current ||
        savingInFlight ||
        unconfirmedSave !== null ||
        conflictState !== null ||
        deletedRemotely
      ) {
        return;
      }
      if (isEmpty || isOverCap || !vault) {
        return;
      }

      // If in raw mode, ensure JSON is strictly valid before sealing
      if (mode === 'raw') {
        const issue = validateRawJsonText(rawDraftValue);
        if (issue !== null) {
          return;
        }
      }

      const textToSave = candidateSource;
      const checkParse = parseJsonStrict(textToSave);
      if (!checkParse.ok) {
        return;
      }

      // No-op round-trip rule: if bytes are identical to originalSource, do NOT send PUT
      if (textToSave === originalSource) {
        if (mode === 'raw') {
          setRawEditedSinceSwitch(false);
          setSwitchBlockedError(null);
          setMode('table');
        }
        return;
      }

      // Mixed / lone CR EOL warning when saving from Raw JSON textarea (plan §2.10 rule 2)
      if (
        mode === 'raw' &&
        rawEditedSinceSwitch &&
        rawSavePlan.requiresWarning &&
        !bypassMixedEolWarning
      ) {
        const targetLabel =
          rawSavePlan.targetEol === 'crlf'
            ? 'CRLF'
            : rawSavePlan.targetEol === 'cr'
              ? 'CR'
              : 'LF';
        setMixedEolWarningTarget(targetLabel);
        return;
      }

      const submittedRevision = editorRevisionRef.current;
      const ownerId = ++nextSaveOwnerIdRef.current;
      saveOwnerIdRef.current = ownerId;
      const guard = captureEntrySaveOpGuard(vault, lockEpochRef);
      setMixedEolWarningTarget(null);
      saveLockRef.current = true;
      setSavingInFlight(true);
      setSaveError(null);

      try {
        const readyVault = await ensureVaultForEntrySeal(vault, guard);
        if (!readyVault || !guard.isStillCurrent() || saveOwnerIdRef.current !== ownerId) {
          releaseSaveGuardIfOwner(ownerId);
          return;
        }
        const currentHolder = plaintextHolderRef.current;
        const currentTextToSeal =
          mode === 'raw' && rawEditedSinceSwitch
            ? applyTextareaEol(
                currentHolder.tableSource || currentHolder.originalSource,
                currentHolder.draftValue,
              ).text
            : currentHolder.tableSource || textToSave;
        if (measureUtf8Bytes(currentTextToSeal) === 0 || !parseJsonStrict(currentTextToSeal).ok) {
          releaseSaveGuardIfOwner(ownerId);
          return;
        }
        plaintextHolderRef.current.submittedCandidateSource = currentTextToSeal;

        const sealed = await sealEntryUpdate({
          entryId: entry.id,
          itemId,
          version: effectiveVersion,
          text: currentTextToSeal,
          vault: readyVault,
        });
        if (!guard.isStillCurrent() || !sealed.isCurrent() || saveOwnerIdRef.current !== ownerId) {
          releaseSaveGuardIfOwner(ownerId);
          return;
        }
        await executePut(sealed, effectiveVersion, false, submittedRevision, ownerId);
      } catch (err) {
        if (!guard.isStillCurrent() || saveOwnerIdRef.current !== ownerId) {
          releaseSaveGuardIfOwner(ownerId);
          return;
        }
        releaseSaveGuardIfOwner(ownerId);
        const classified = classifyContentMutationError(err);
        const msg = translateContentError(classified.i18nKey);
        setSaveError(msg);
        onAnnounce?.(msg);
      }
    },
    [
      candidateSource,
      conflictState,
      deletedRemotely,
      effectiveVersion,
      entry.id,
      executePut,
      isEmpty,
      isOverCap,
      itemId,
      mode,
      onAnnounce,
      originalSource,
      plaintextHolderRef,
      rawDraftValue,
      rawEditedSinceSwitch,
      rawSavePlan.requiresWarning,
      rawSavePlan.targetEol,
      releaseSaveGuardIfOwner,
      savingInFlight,
      translateContentError,
      unconfirmedSave,
      vault,
    ],
  );

  const handleRetrySameBytes = useCallback(async () => {
    if (!unconfirmedSave || saveLockRef.current || savingInFlight) return;
    const ownerId = ++nextSaveOwnerIdRef.current;
    saveOwnerIdRef.current = ownerId;
    saveLockRef.current = true;
    await executePut(
      unconfirmedSave.sealed,
      unconfirmedSave.ifMatch,
      true,
      unconfirmedSave.submittedRevision,
      ownerId,
    );
  }, [executePut, savingInFlight, unconfirmedSave]);

  // 412 action 1: Keep mine
  const handleConflictKeepMine = useCallback(async () => {
    if (!vault || saveLockRef.current || savingInFlight || isEmpty || isOverCap) return;
    const guard = captureEntrySaveOpGuard(vault, lockEpochRef);

    const submittedRevision = editorRevisionRef.current;
    const ownerId = ++nextSaveOwnerIdRef.current;
    saveOwnerIdRef.current = ownerId;
    saveLockRef.current = true;
    setSavingInFlight(true);
    setSaveError(null);

    try {
      let targetVersion = conflictState?.currentVersion;
      if (targetVersion === undefined) {
        const latestEntry = await entryGet(entry.id);
        if (!guard.isStillCurrent() || saveOwnerIdRef.current !== ownerId) {
          releaseSaveGuardIfOwner(ownerId);
          return;
        }
        targetVersion = latestEntry.version;
      } else if (!guard.isStillCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }
      const readyVault = await ensureVaultForEntrySeal(vault, guard);
      if (!readyVault || !guard.isStillCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }

      // Read draft synchronously from the resettable holder AFTER fallback GET, reloadVaultMeta, and op-token check (IP15-BE2-1, advisor-dec-200)
      const currentHolder = plaintextHolderRef.current;
      const textToSeal =
        mode === 'raw' && rawEditedSinceSwitch
          ? applyTextareaEol(
              currentHolder.tableSource || currentHolder.originalSource,
              currentHolder.draftValue,
            ).text
          : currentHolder.tableSource || '';

      if (measureUtf8Bytes(textToSeal) === 0 || !parseJsonStrict(textToSeal).ok) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }
      plaintextHolderRef.current.submittedCandidateSource = textToSeal;

      const resealed = await sealEntryUpdate({
        entryId: entry.id,
        itemId,
        version: targetVersion,
        text: textToSeal,
        vault: readyVault,
      });
      if (!guard.isStillCurrent() || !resealed.isCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }

      setConflictState(null);
      await executePut(resealed, targetVersion, false, submittedRevision, ownerId);
    } catch (err) {
      if (!guard.isStillCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }
      releaseSaveGuardIfOwner(ownerId);
      const classified = classifyContentMutationError(err);
      const msg = translateContentError(classified.i18nKey);
      setSaveError(msg);
      onAnnounce?.(msg);
    }
  }, [
    conflictState?.currentVersion,
    entry.id,
    executePut,
    isEmpty,
    isOverCap,
    itemId,
    mode,
    onAnnounce,
    plaintextHolderRef,
    rawEditedSinceSwitch,
    releaseSaveGuardIfOwner,
    savingInFlight,
    translateContentError,
    vault,
  ]);

  // 412 action 2: Load latest after inline confirmation
  const handleConflictConfirmDiscardAndLoad = useCallback(async () => {
    const nextVer = conflictState?.currentVersion;
    clearEditorPlaintextHolderSync();
    saveOwnerIdRef.current = 0;
    saveLockRef.current = false;
    editorRevisionRef.current = 0;
    setMode('table');
    setDiscardConfirmOpen(false);
    setMixedEolWarningTarget(null);
    setSwitchBlockedError(null);
    setUnconfirmedSave(null);
    setConflictState(null);
    setDeletedRemotely(false);
    setSaveError(null);

    queryClient.removeQueries({ queryKey: vaultBodyQueryKey(entry.id) });
    if (nextVer !== undefined) {
      queryClient.setQueryData(
        contentQueryKeys.entries(itemId),
        (prev: { items?: EntryMeta[] } | EntryMeta[] | undefined) => {
          if (!prev) return prev;
          if (Array.isArray(prev)) {
            return prev.map((e) => (e.id === entry.id ? { ...e, version: nextVer } : e));
          }
          if (Array.isArray(prev.items)) {
            return {
              ...prev,
              items: prev.items.map((e) => (e.id === entry.id ? { ...e, version: nextVer } : e)),
            };
          }
          return prev;
        },
      );
    }
    void queryClient.invalidateQueries({ queryKey: contentQueryKeys.entries(itemId) });
    await refetch();
  }, [
    clearEditorPlaintextHolderSync,
    conflictState?.currentVersion,
    entry.id,
    itemId,
    queryClient,
    refetch,
  ]);

  // 412 action 3: Copy mine
  const handleConflictCopyMine = useCallback(async () => {
    await copyEntryPlaintextToClipboard(candidateSource);
    onAnnounce?.(tEntry('copiedMine'));
  }, [candidateSource, onAnnounce, tEntry]);

  // 404 action: Save as new entry (type: 'json')
  const handleSaveAsNewEntry = useCallback(async () => {
    if (!vault || saveLockRef.current || savingInFlight || isEmpty || isOverCap) return;
    if (!parseJsonStrict(candidateSource).ok) return;

    const ownerId = ++nextSaveOwnerIdRef.current;
    saveOwnerIdRef.current = ownerId;
    const guard = captureEntrySaveOpGuard(vault, lockEpochRef);
    saveLockRef.current = true;
    setSavingInFlight(true);
    setSaveError(null);

    try {
      const readyVault = await ensureVaultForEntrySeal(vault, guard);
      if (!readyVault || !guard.isStillCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }
      const currentHolder = plaintextHolderRef.current;
      const textToSeal =
        mode === 'raw' && rawEditedSinceSwitch
          ? applyTextareaEol(
              currentHolder.tableSource || currentHolder.originalSource,
              currentHolder.draftValue,
            ).text
          : currentHolder.tableSource || '';
      if (measureUtf8Bytes(textToSeal) === 0 || !parseJsonStrict(textToSeal).ok) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }

      const sealedNew = await sealNewEntry({
        itemId,
        type: 'json',
        text: textToSeal,
        vault: readyVault,
      });
      if (!guard.isStillCurrent() || !sealedNew.isCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }
      const { applied } = await mutateSealedEntryCreate(
        queryClient,
        toEntryCreateVariables(sealedNew),
      );
      if (!applied || !guard.isStillCurrent() || !sealedNew.isCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }
      resetDraftToOriginal();
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.entries(itemId) });
      onAnnounce?.(tEntry('savedAnnounce'));
    } catch (err) {
      if (!guard.isStillCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }
      releaseSaveGuardIfOwner(ownerId);
      const classified = classifyContentMutationError(err);
      const msg = translateContentError(classified.i18nKey);
      setSaveError(msg);
      onAnnounce?.(msg);
    }
  }, [
    candidateSource,
    isEmpty,
    isOverCap,
    itemId,
    mode,
    onAnnounce,
    plaintextHolderRef,
    queryClient,
    rawEditedSinceSwitch,
    releaseSaveGuardIfOwner,
    resetDraftToOriginal,
    savingInFlight,
    tEntry,
    translateContentError,
    vault,
  ]);

  const handleCopyBody = useCallback(async () => {
    if (!unlocked || body === undefined) return;
    await copyEntryPlaintextToClipboard(candidateSource || body);
    onAnnounce?.(tEntry('copied'));
  }, [body, candidateSource, onAnnounce, tEntry, unlocked]);

  const handleMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuPopRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ??
        [],
    );
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(currentIndex + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(currentIndex - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
      menuTriggerRef.current?.focus();
    }
  };

  const handleCardKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const keyLower = (e.key || '').toLowerCase();
    if (keyLower === 's' && (e.ctrlKey || e.metaKey) && isDirty) {
      e.preventDefault();
      void handleSave();
    }
  };

  const positionNumber = index + 1;
  const moveUpDisabled = !canReorder || index <= 0;
  const moveDownDisabled = !canReorder || index >= total - 1;
  const hasCardError = Boolean(
    conflictState ||
      unconfirmedSave ||
      saveError ||
      failed ||
      switchBlockedError ||
      (mode === 'raw' && rawValidationIssue !== null),
  );

  return (
    <article
      ref={handleCardRef}
      tabIndex={-1}
      aria-label={tEntry('cardLabel', { pos: positionNumber })}
      data-testid={`entry-card-${entry.id}`}
      data-entry-card={entry.id}
      data-entry-type="json"
      onDragOver={(e) => onDragOver?.(index, e)}
      onDrop={(e) => onDrop?.(index, e)}
      onKeyDown={handleCardKeyDown}
      className={`card min-w-0 ${hasCardError ? 'card-error' : ''}`}
    >
      {/* Card Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5 rounded-t-[calc(var(--r-xl)-1px)]">
        <span
          draggable={canReorder && !showEditControls}
          onDragStart={(e) => onDragStart?.(index, e)}
          onDragEnd={() => onDragEnd?.()}
          data-testid={`entry-drag-handle-${entry.id}`}
          aria-hidden="true"
          className={`mono select-none text-muted ${
            canReorder && !showEditControls ? 'cursor-grab' : 'cursor-default opacity-50'
          }`}
        >
          ⠿
        </span>
        <span className="badge-type badge-json">json</span>
        <span
          className="mono text-[12px] text-muted"
          data-entry-pos
          data-testid={`entry-pos-${entry.id}`}
        >
          #{positionNumber}
        </span>

        {/* Table / Raw JSON segmented switcher (Task 16 item 5, hidden when locked or error) */}
        {unlocked && body !== undefined && !oldKey && !failed ? (
          <div
            role="group"
            aria-label={tJson('viewModeAria')}
            data-testid={`json-mode-switcher-${entry.id}`}
            className="seg ml-1"
          >
            <button
              ref={tabTableBtnRef}
              type="button"
              aria-pressed={mode === 'table'}
              data-testid={`json-tab-table-${entry.id}`}
              className="seg-btn"
              onClick={() => handleSwitchMode('table')}
            >
              {tJson('tabTable')}
            </button>
            <button
              ref={tabRawBtnRef}
              type="button"
              aria-pressed={mode === 'raw'}
              data-testid={`json-tab-raw-${entry.id}`}
              className="seg-btn"
              onClick={() => handleSwitchMode('raw')}
            >
              {tJson('tabRaw')}
            </button>
          </div>
        ) : null}

        {conflictState ? (
          <span className="badge-type badge-conflict" data-testid="entry-conflict-badge">
            412 version_mismatch
          </span>
        ) : null}
        {unconfirmedSave || saveError ? (
          <span className="badge-type badge-err" data-testid="entry-save-failed-badge">
            {tEntry('saveFailedBadge')}
          </span>
        ) : null}
        {savedFlash && !isDirty ? (
          <span role="status" className="badge-type badge-ok" data-testid="entry-saved-badge">
            {tEntry('savedBadge')}
          </span>
        ) : null}

        <div className="relative ml-auto flex items-center gap-1.5" data-card-menu-host>
          {showEditControls && mode === 'table' ? (
            <span
              id={`entry-byte-counter-${entry.id}`}
              data-testid={`entry-byte-counter-${entry.id}`}
              className={`mono mr-1 text-[12px] ${
                isOverCap ? 'font-semibold text-error-ink' : 'text-body'
              }`}
            >
              {isOverCap
                ? tEntry('byteCounterOver', { bytes: formattedBytes })
                : isNearCap
                  ? tEntry('byteCounterNear', { bytes: formattedBytes })
                  : tEntry('byteCounter', { bytes: formattedBytes })}
            </span>
          ) : null}

          {unlocked && body !== undefined && !oldKey && !failed ? (
            <button
              type="button"
              className="btn btn-tertiary btn-sm"
              data-testid={`entry-copy-btn-${entry.id}`}
              onClick={() => {
                void handleCopyBody();
              }}
            >
              {tEntry('copy')}
            </button>
          ) : null}

          <button
            ref={menuTriggerRef}
            type="button"
            id={`card-menu-btn-${entry.id}`}
            data-testid={`entry-menu-trigger-${entry.id}`}
            data-card-menu-trigger={entry.id}
            aria-label={tEntry('actionsMenuAria', { pos: positionNumber })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? `card-menu-pop-${entry.id}` : undefined}
            className="btn btn-tertiary btn-sm btn-icon"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((prev) => !prev);
            }}
          >
            ⋯
          </button>

          {menuOpen ? (
            <div
              ref={menuPopRef}
              id={`card-menu-pop-${entry.id}`}
              data-testid={`entry-menu-pop-${entry.id}`}
              role="menu"
              aria-label={tEntry('actionsMenuLabel')}
              className="popover menu-pop menu-pop-right"
              onKeyDown={handleMenuKeyDown}
            >
              <button
                type="button"
                role="menuitem"
                data-testid={`entry-menu-copy-${entry.id}`}
                data-card-act="copy"
                className="menu-item"
                disabled={!unlocked || body === undefined || oldKey || failed}
                onClick={() => {
                  setMenuOpen(false);
                  void handleCopyBody();
                  menuTriggerRef.current?.focus();
                }}
              >
                <span>{tEntry('copy')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid={`entry-menu-edit-${entry.id}`}
                data-card-act="edit"
                className="menu-item"
                disabled={!unlocked || body === undefined || oldKey || failed}
                onClick={() => {
                  setMenuOpen(false);
                  handleSwitchMode('raw');
                }}
              >
                <span>{tJson('tabRaw')}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid={`entry-menu-up-${entry.id}`}
                data-card-act="up"
                className="menu-item"
                disabled={moveUpDisabled}
                onClick={() => {
                  const trigger = menuTriggerRef.current;
                  setMenuOpen(false);
                  onMoveUp(entry.id, trigger);
                }}
              >
                <span>{tEntry('moveUp')}</span>
                <span className="mono text-[12px] text-muted" aria-hidden="true">
                  ↑
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid={`entry-menu-down-${entry.id}`}
                data-card-act="down"
                className="menu-item"
                disabled={moveDownDisabled}
                onClick={() => {
                  const trigger = menuTriggerRef.current;
                  setMenuOpen(false);
                  onMoveDown(entry.id, trigger);
                }}
              >
                <span>{tEntry('moveDown')}</span>
                <span className="mono text-[12px] text-muted" aria-hidden="true">
                  ↓
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid={`entry-menu-delete-${entry.id}`}
                data-card-act="delete"
                className="menu-item menu-item-danger"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete(entry, index);
                }}
              >
                <span>{tEntry('delete')}</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* Card Body */}
      <div className={mode === 'table' && unlocked && body !== undefined && !oldKey && !failed ? '' : 'p-4'}>
        {!unlocked ? (
          <LockMask />
        ) : oldKey ? (
          <div
            role="alert"
            data-testid="entry-body-old-key"
            className="auth-status mb-0 flex flex-col gap-1"
          >
            <span className="badge-type badge-warn self-start">{tEntry('oldKeyBadge')}</span>
            <p className="m-0 text-[14px] font-semibold text-body">{tEntry('oldKeyTitle')}</p>
            <p className="m-0 text-[13px] text-muted">{tEntry('oldKeyBody')}</p>
          </div>
        ) : failed ? (
          <div
            role="alert"
            data-testid="entry-body-error"
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <div className="min-w-0">
              <p className="t-caption m-0 font-semibold text-body">
                {(errorKind ?? (decryptFailed ? 'decrypt_failed' : 'other')) === 'decrypt_failed'
                  ? tEntry('decryptFailedTitle')
                  : errorKind === 'network'
                    ? tEntry('networkFailedTitle')
                    : errorKind === 'not_found'
                      ? tEntry('notFoundTitle')
                      : tEntry('loadFailedTitle')}
              </p>
              <p className="t-caption m-0 text-muted">
                {(errorKind ?? (decryptFailed ? 'decrypt_failed' : 'other')) === 'decrypt_failed'
                  ? tEntry('decryptFailedBody')
                  : errorKind === 'network'
                    ? tEntry('networkFailedBody')
                    : errorKind === 'not_found'
                      ? tEntry('notFoundBody')
                      : tEntry('loadFailedBody')}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm shrink-0"
              data-testid="entry-body-retry"
              onClick={() => {
                void refetch();
              }}
            >
              {tEntry('retry')}
            </button>
          </div>
        ) : !inViewport || pending || body === undefined ? (
          <p role="status" data-testid="entry-body-loading" className="t-caption m-0 text-muted">
            {tLocked('bodyLoading')}
          </p>
        ) : (
          <div data-testid="entry-body" data-vault-decrypted="">
            {mode === 'table' ? (
              <JsonTreeGrid
                entryId={entry.id}
                document={currentDoc}
                disabled={savingInFlight}
                expandedPaths={expandedPaths}
                pageByPath={pageByPath}
                onToggleExpand={handleToggleExpand}
                onPageChange={handlePageChange}
                onApplyEdit={handleApplyTableEdit}
                resetEpoch={resetEpoch}
              />
            ) : (
              <JsonRawEditor
                entryId={entry.id}
                positionNumber={positionNumber}
                draftValue={rawDraftValue}
                sourceEol={rawEolInfo}
                prospectiveByteLength={utf8ByteLength}
                isOverCap={isOverCap}
                isDirty={isDirty}
                savingInFlight={savingInFlight}
                hasBlockingState={
                  unconfirmedSave !== null || conflictState !== null || deletedRemotely
                }
                externalError={switchBlockedError}
                parseDebounceMs={rawParseDebounceMs}
                onDraftChange={(nextVal: string) => {
                  editorRevisionRef.current += 1;
                  setRawDraftValue(nextVal);
                  setRawEditedSinceSwitch(true);
                  setSwitchBlockedError(null);
                  setSavedFlash(false);
                  if (discardConfirmOpen) setDiscardConfirmOpen(false);
                  if (mixedEolWarningTarget) setMixedEolWarningTarget(null);
                }}
                onSave={() => {
                  void handleSave();
                }}
                onRequestCancel={requestCancelEdit}
              />
            )}

            {/* Shared Save / Cancel / Conflict / Retry footer when dirty or in raw mode */}
            {showEditControls ? (
              <div
                data-testid={`entry-editor-${entry.id}`}
                className="border-t border-line bg-surface px-4 py-3"
              >
                {/* Mixed / lone CR EOL warning before save (plan §2.10 rule 2) */}
                {mixedEolWarningTarget ? (
                  <div
                    role="alert"
                    data-testid={`entry-mixed-eol-warning-${entry.id}`}
                    className="auth-status mb-3 flex flex-wrap items-center justify-between gap-3"
                  >
                    <p className="m-0 text-[13px] text-body">
                      {tEntry('mixedEolWarning', { target: mixedEolWarningTarget })}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn btn-tertiary btn-sm"
                        onClick={() => setMixedEolWarningTarget(null)}
                      >
                        {tEntry('cancel')}
                      </button>
                      <button
                        type="button"
                        data-testid={`entry-confirm-mixed-eol-save-${entry.id}`}
                        className="btn btn-primary btn-sm"
                        onClick={() => {
                          void handleSave(true);
                        }}
                      >
                        {tEntry('confirmMixedEolSave')}
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* Save error with Retry (same bytes + same Idempotency-Key, P4FE1-13) */}
                {unconfirmedSave ? (
                  <div
                    role="alert"
                    data-testid={`entry-save-retry-box-${entry.id}`}
                    className="auth-alert mb-3"
                  >
                    <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                      {tEntry('saveFailedTitle')}
                    </p>
                    <p className="m-0 text-[13px] text-body">{unconfirmedSave.errorMessage}</p>
                    <p className="m-0 mt-1 text-[12px] text-muted">
                      {tEntry('saveFailedRetryBody')}
                    </p>
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        data-testid={`entry-discard-draft-btn-${entry.id}`}
                        className="btn btn-tertiary btn-sm"
                        onClick={resetDraftToOriginal}
                      >
                        {tEntry('discardDraft')}
                      </button>
                      <button
                        type="button"
                        data-testid={`entry-retry-save-btn-${entry.id}`}
                        className="btn btn-primary btn-sm"
                        disabled={savingInFlight}
                        onClick={() => {
                          void handleRetrySameBytes();
                        }}
                      >
                        {tEntry('retry')}
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* 412 version_mismatch conflict panel */}
                {conflictState ? (
                  <div
                    role="alert"
                    data-testid={`entry-conflict-box-${entry.id}`}
                    className="auth-alert mb-3"
                  >
                    <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                      {tEntry('conflictHeading')}
                    </p>
                    <p className="m-0 text-[13px] text-body">{tEntry('conflictBody')}</p>
                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                      <button
                        type="button"
                        data-testid={`entry-conflict-copy-mine-${entry.id}`}
                        className="btn btn-tertiary btn-sm"
                        onClick={() => {
                          void handleConflictCopyMine();
                        }}
                      >
                        {tEntry('conflictCopyMine')}
                      </button>
                      <button
                        type="button"
                        data-testid={`entry-conflict-load-latest-${entry.id}`}
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          setConflictState((prev) =>
                            prev ? { ...prev, reloadConfirmOpen: true } : null,
                          )
                        }
                      >
                        {tEntry('conflictLoadLatest')}
                      </button>
                      <button
                        type="button"
                        data-testid={`entry-conflict-keep-mine-${entry.id}`}
                        className="btn btn-primary btn-sm"
                        disabled={savingInFlight || isEmpty || isOverCap}
                        onClick={() => {
                          void handleConflictKeepMine();
                        }}
                      >
                        {tEntry('conflictKeepMine')}
                      </button>
                    </div>

                    {conflictState.reloadConfirmOpen ? (
                      <div
                        data-testid={`entry-conflict-reload-confirm-${entry.id}`}
                        className="mt-3 border-t border-line pt-2.5 flex flex-wrap items-center justify-between gap-2"
                      >
                        <span className="text-[13px] text-body">
                          {tEntry('conflictLoadLatestConfirm')}
                        </span>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            className="btn btn-tertiary btn-sm"
                            onClick={() =>
                              setConflictState((prev) =>
                                prev ? { ...prev, reloadConfirmOpen: false } : null,
                              )
                            }
                          >
                            {tEntry('keepEditing')}
                          </button>
                          <button
                            type="button"
                            data-testid={`entry-conflict-confirm-discard-${entry.id}`}
                            className="btn btn-danger btn-sm"
                            onClick={() => {
                              void handleConflictConfirmDiscardAndLoad();
                            }}
                          >
                            {tEntry('discardAndLoadLatest')}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* 404 deleted remotely */}
                {deletedRemotely ? (
                  <div
                    role="alert"
                    data-testid={`entry-deleted-remotely-${entry.id}`}
                    className="auth-alert mb-3"
                  >
                    <p className="m-0 text-[13px] text-body">{tEntry('deletedRemotelyBody')}</p>
                    <div className="mt-2.5 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        className="btn btn-tertiary btn-sm"
                        onClick={resetDraftToOriginal}
                      >
                        {tEntry('cancel')}
                      </button>
                      <button
                        type="button"
                        data-testid={`entry-save-as-new-${entry.id}`}
                        className="btn btn-primary btn-sm"
                        disabled={savingInFlight || isEmpty || isOverCap}
                        onClick={() => {
                          void handleSaveAsNewEntry();
                        }}
                      >
                        {tEntry('saveAsNewEntry')}
                      </button>
                    </div>
                  </div>
                ) : null}

                {saveError && !unconfirmedSave && !deletedRemotely ? (
                  <p
                    role="alert"
                    data-testid={`entry-save-error-${entry.id}`}
                    className="field-error mb-3 mt-0"
                  >
                    {saveError}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    data-testid={`entry-cancel-edit-btn-${entry.id}`}
                    className="btn btn-tertiary btn-sm"
                    disabled={savingInFlight}
                    onClick={requestCancelEdit}
                  >
                    {tEntry('cancel')} (<span className="mono">Esc</span>)
                  </button>
                  <button
                    type="button"
                    data-testid={`entry-save-btn-${entry.id}`}
                    className="btn btn-primary btn-sm"
                    disabled={saveDisabled}
                    aria-busy={savingInFlight || undefined}
                    onClick={() => {
                      void handleSave();
                    }}
                  >
                    {savingInFlight ? (
                      tEntry('savingButton')
                    ) : (
                      <>
                        {tEntry('save')} (<span className="mono">Ctrl+S</span>)
                      </>
                    )}
                  </button>
                </div>

                {/* Inline discard confirmation */}
                {discardConfirmOpen ? (
                  <div
                    data-testid={`entry-discard-confirm-${entry.id}`}
                    role="alert"
                    className="auth-status mb-0 mt-3 flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <p className="m-0 text-[14px] font-semibold text-body">
                        {tEntry('discardConfirmTitle')}
                      </p>
                      <p className="m-0 mt-0.5 text-[13px] text-muted">
                        {tEntry('discardConfirmBody')}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        data-testid={`entry-keep-editing-btn-${entry.id}`}
                        className="btn btn-tertiary btn-sm"
                        onClick={() => setDiscardConfirmOpen(false)}
                      >
                        {tEntry('keepEditing')}
                      </button>
                      <button
                        type="button"
                        data-testid={`entry-discard-btn-${entry.id}`}
                        className="btn btn-danger btn-sm"
                        onClick={resetDraftToOriginal}
                      >
                        {tEntry('discardChanges')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}

export interface NewJsonEntryComposerProps {
  readonly itemId: string;
  readonly itemName?: string;
  readonly initialPreset?: JsonNewPresetId;
  readonly onSaved: (created: EntryMeta) => void;
  readonly onCancel: () => void;
  readonly onAnnounce?: (message: string) => void;
  readonly onDraftClearedOnLock?: () => void;
  readonly rawParseDebounceMs?: number;
}

export function NewJsonEntryComposer({
  itemId,
  itemName = '',
  initialPreset = 'empty-object',
  onSaved,
  onCancel,
  onAnnounce,
  onDraftClearedOnLock,
  rawParseDebounceMs,
}: NewJsonEntryComposerProps) {
  const tEntry = useTranslations('content.entry');
  const tJson = useTranslations('content.json');
  const tErrors = useTranslations('content.errors');
  const queryClient = useQueryClient();
  const vault = useOptionalVault();
  const { me } = useSession();

  const translateContentError = useCallback(
    (key: ContentErrorI18nKey): string => {
      const code = key.replace(/^content\.errors\./, '');
      return tErrors(code as Parameters<typeof tErrors>[0]);
    },
    [tErrors],
  );

  const [preset, setPreset] = useState<JsonNewPresetId>(initialPreset);
  const [mode, setMode] = useState<JsonCardMode>('table');
  const [tableSource, setTableSource] = useState<string>(() => JSON_NEW_PRESETS[initialPreset]);
  const [rawDraftValue, setRawDraftValue] = useState<string>(
    () => JSON_NEW_PRESETS[initialPreset],
  );
  const [rawEditedSinceSwitch, setRawEditedSinceSwitch] = useState<boolean>(false);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [pageByPath, setPageByPath] = useState<ReadonlyMap<string, number>>(
    () => new Map<string, number>(),
  );

  const [discardConfirmOpen, setDiscardConfirmOpen] = useState<boolean>(false);
  const [switchBlockedError, setSwitchBlockedError] = useState<string | null>(null);
  const [savingInFlight, setSavingInFlight] = useState<boolean>(false);
  const [unconfirmedCreate, setUnconfirmedCreate] = useState<{
    readonly sealed: SealedNewEntryPayload;
    readonly errorMessage: string;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resetEpoch, setResetEpoch] = useState<number>(0);

  const saveLockRef = useRef<boolean>(false);
  const lockEpochRef = useRef<number>(0);
  const candidateSource = mode === 'raw' && rawEditedSinceSwitch ? rawDraftValue : tableSource;
  const isDirty = candidateSource !== JSON_NEW_PRESETS[preset];

  const composerHolderRef = useRef<{ candidateSource: string }>({
    candidateSource: JSON_NEW_PRESETS[initialPreset],
  });
  composerHolderRef.current.candidateSource = candidateSource;

  const composerDirtyRef = useRef<boolean>(false);
  composerDirtyRef.current = isDirty || unconfirmedCreate !== null;

  useEffect(() => {
    if (!vault?.registerSecretFormReset) return;
    return vault.registerSecretFormReset(() => {
      const hadNonEmptyDraft = composerDirtyRef.current;
      lockEpochRef.current += 1;
      composerHolderRef.current.candidateSource = '';
      saveLockRef.current = false;
      setTableSource(JSON_NEW_PRESETS[initialPreset]);
      setRawDraftValue(JSON_NEW_PRESETS[initialPreset]);
      setRawEditedSinceSwitch(false);
      setDiscardConfirmOpen(false);
      setSwitchBlockedError(null);
      setSavingInFlight(false);
      setUnconfirmedCreate(null);
      setSaveError(null);
      setResetEpoch((prev) => prev + 1);
      if (hadNonEmptyDraft) {
        onDraftClearedOnLock?.();
      }
      onCancel();
    });
  }, [initialPreset, onCancel, onDraftClearedOnLock, vault]);

  const parsedDocResult = useMemo(() => parseJsonStrict(tableSource), [tableSource]);
  const currentDoc = parsedDocResult.ok ? parsedDocResult.document : null;

  const rawValidationIssue = useMemo(() => {
    if (mode !== 'raw') return null;
    return validateRawJsonText(rawDraftValue);
  }, [mode, rawDraftValue]);

  const utf8ByteLength = useMemo(
    () => measureUtf8Bytes(candidateSource),
    [candidateSource],
  );
  const isOverCap = utf8ByteLength > ENTRY_MAX_PLAINTEXT_BYTES;
  const isEmpty = utf8ByteLength === 0;
  const saveDisabled =
    isEmpty ||
    isOverCap ||
    (mode === 'raw' && rawValidationIssue !== null) ||
    (mode === 'table' && !currentDoc) ||
    savingInFlight ||
    unconfirmedCreate !== null;

  const handleSelectPreset = useCallback((nextPreset: JsonNewPresetId) => {
    const template = JSON_NEW_PRESETS[nextPreset];
    setPreset(nextPreset);
    setTableSource(template);
    setRawDraftValue(template);
    setRawEditedSinceSwitch(false);
    setExpandedPaths(new Set());
    setPageByPath(new Map());
    setSwitchBlockedError(null);
    setDiscardConfirmOpen(false);
  }, []);

  const handleSwitchMode = useCallback(
    (targetMode: JsonCardMode) => {
      if (targetMode === mode) return;
      if (targetMode === 'raw') {
        setRawDraftValue(normalizeEolToLf(tableSource));
        setRawEditedSinceSwitch(false);
        setSwitchBlockedError(null);
        setMode('raw');
        return;
      }

      if (!rawEditedSinceSwitch) {
        setSwitchBlockedError(null);
        setMode('table');
        return;
      }

      const issue = validateRawJsonText(rawDraftValue);
      if (issue !== null) {
        setSwitchBlockedError(tJson('switchBlockedInvalidError'));
        return;
      }

      setTableSource(rawDraftValue);
      setRawEditedSinceSwitch(false);
      setSwitchBlockedError(null);
      setMode('table');
    },
    [mode, rawDraftValue, rawEditedSinceSwitch, tJson, tableSource],
  );

  const requestCancel = useCallback(() => {
    if (savingInFlight) return;
    if (!isDirty && unconfirmedCreate === null) {
      onCancel();
      return;
    }
    setDiscardConfirmOpen(true);
  }, [isDirty, onCancel, savingInFlight, unconfirmedCreate]);

  const executeCreate = useCallback(
    async (sealed: SealedNewEntryPayload, hadPriorUncertainSend: boolean) => {
      setSavingInFlight(true);
      setSaveError(null);
      onAnnounce?.(tEntry('saving'));

      try {
        const { meta, applied } = await mutateSealedEntryCreate(
          queryClient,
          toEntryCreateVariables(sealed, {
            uncertainPriorSend: hadPriorUncertainSend,
          }),
        );

        if (!applied || !sealed.isCurrent()) {
          saveLockRef.current = false;
          setSavingInFlight(false);
          return;
        }

        saveLockRef.current = false;
        setSavingInFlight(false);
        setUnconfirmedCreate(null);
        onAnnounce?.(tEntry('savedAnnounce'));
        onSaved(meta);
      } catch (err) {
        if (!sealed.isCurrent()) {
          saveLockRef.current = false;
          setSavingInFlight(false);
          return;
        }
        saveLockRef.current = false;
        setSavingInFlight(false);

        const classified = classifyContentMutationError(err, {
          hadUncertainSend: true,
        });

        if (classified.isLogoutBoundary) {
          if (me?.user?.id) {
            recordUnconfirmedSave({
              userId: me.user.id,
              itemId,
              itemName: itemName || itemId,
              source: 'entry',
            });
          }
          onCancel();
          return;
        }

        if (classified.kind === 'entry_key_mismatch') {
          setUnconfirmedCreate(null);
          void vault?.reloadVaultMeta();
          return;
        }

        const msg = translateContentError(classified.i18nKey);
        if (classified.canRetrySameBytes) {
          setUnconfirmedCreate({
            sealed,
            errorMessage: msg,
          });
          onAnnounce?.(msg);
          return;
        }

        setUnconfirmedCreate(null);
        setSaveError(msg);
        onAnnounce?.(msg);
      }
    },
    [
      itemId,
      itemName,
      me?.user?.id,
      onAnnounce,
      onCancel,
      onSaved,
      queryClient,
      tEntry,
      translateContentError,
      vault,
    ],
  );

  const handleSaveNew = useCallback(async () => {
    if (saveLockRef.current || savingInFlight || unconfirmedCreate !== null) return;
    if (isEmpty || isOverCap || !vault) return;
    if (mode === 'raw' && validateRawJsonText(rawDraftValue) !== null) return;
    if (!parseJsonStrict(candidateSource).ok) return;

    const guard = captureEntrySaveOpGuard(vault, lockEpochRef);
    saveLockRef.current = true;
    setSavingInFlight(true);
    setSaveError(null);

    try {
      const readyVault = await ensureVaultForEntrySeal(vault, guard);
      if (!readyVault || !guard.isStillCurrent()) {
        saveLockRef.current = false;
        setSavingInFlight(false);
        return;
      }
      const textToSeal = composerHolderRef.current.candidateSource;
      if (measureUtf8Bytes(textToSeal) === 0 || !parseJsonStrict(textToSeal).ok) {
        saveLockRef.current = false;
        setSavingInFlight(false);
        return;
      }
      const sealed = await sealNewEntry({
        itemId,
        type: 'json',
        text: textToSeal,
        vault: readyVault,
      });
      if (!guard.isStillCurrent() || !sealed.isCurrent()) {
        saveLockRef.current = false;
        setSavingInFlight(false);
        return;
      }
      await executeCreate(sealed, false);
    } catch (err) {
      if (!guard.isStillCurrent()) {
        saveLockRef.current = false;
        setSavingInFlight(false);
        return;
      }
      saveLockRef.current = false;
      setSavingInFlight(false);
      const classified = classifyContentMutationError(err);
      const msg = translateContentError(classified.i18nKey);
      setSaveError(msg);
      onAnnounce?.(msg);
    }
  }, [
    candidateSource,
    executeCreate,
    isEmpty,
    isOverCap,
    itemId,
    mode,
    onAnnounce,
    rawDraftValue,
    savingInFlight,
    translateContentError,
    unconfirmedCreate,
    vault,
  ]);

  const handleRetryNew = useCallback(async () => {
    if (!unconfirmedCreate || saveLockRef.current || savingInFlight) return;
    saveLockRef.current = true;
    await executeCreate(unconfirmedCreate.sealed, true);
  }, [executeCreate, savingInFlight, unconfirmedCreate]);

  return (
    <article
      data-testid="new-json-entry-composer"
      className={`card overflow-hidden ${unconfirmedCreate || saveError ? 'card-error' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <span className="badge-type badge-json">json</span>
        <span className="text-[14px] font-semibold text-body">
          {savingInFlight ? tEntry('saving') : tJson('newJsonTitle')}
        </span>

        {/* Preset chooser: Empty object {} vs Empty array [] (Task 16 item 7) */}
        <div
          role="group"
          aria-label={tJson('newJsonPresetGroupAria')}
          data-testid="new-json-preset-group"
          className="ml-2 flex flex-wrap items-center gap-1.5"
        >
          <span className="text-[12px] text-muted">{tJson('newJsonPresetLabel')}</span>
          <button
            type="button"
            aria-pressed={preset === 'empty-object'}
            data-testid="new-json-preset-object"
            className="btn btn-tertiary btn-sm !px-2 !py-0.5 text-[12px]"
            onClick={() => handleSelectPreset('empty-object')}
          >
            <span className="mono">{'{}'}</span> · {tJson('newJsonPresetEmptyObject')}
          </button>
          <button
            type="button"
            aria-pressed={preset === 'empty-array'}
            data-testid="new-json-preset-array"
            className="btn btn-tertiary btn-sm !px-2 !py-0.5 text-[12px]"
            onClick={() => handleSelectPreset('empty-array')}
          >
            <span className="mono">{'[]'}</span> · {tJson('newJsonPresetEmptyArray')}
          </button>
        </div>

        {/* Table / Raw JSON switcher */}
        <div
          role="group"
          aria-label={tJson('viewModeAria')}
          data-testid="new-json-mode-switcher"
          className="seg ml-auto"
        >
          <button
            type="button"
            aria-pressed={mode === 'table'}
            data-testid="new-json-tab-table"
            className="seg-btn"
            onClick={() => handleSwitchMode('table')}
          >
            {tJson('tabTable')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'raw'}
            data-testid="new-json-tab-raw"
            className="seg-btn"
            onClick={() => handleSwitchMode('raw')}
          >
            {tJson('tabRaw')}
          </button>
        </div>
      </div>

      <div>
        {mode === 'table' ? (
          <JsonTreeGrid
            entryId="new-json"
            document={currentDoc}
            disabled={savingInFlight}
            expandedPaths={expandedPaths}
            pageByPath={pageByPath}
            onToggleExpand={(p) =>
              setExpandedPaths((prev) => {
                const next = new Set(prev);
                if (next.has(p)) next.delete(p);
                else next.add(p);
                return next;
              })
            }
            onPageChange={(p, nextPage) =>
              setPageByPath((prev) => {
                const next = new Map(prev);
                next.set(p, nextPage);
                return next;
              })
            }
            onApplyEdit={(outcome) => {
              if (measureUtf8Bytes(outcome.source) > ENTRY_MAX_PLAINTEXT_BYTES) return false;
              setTableSource(outcome.source);
              setRawDraftValue(normalizeEolToLf(outcome.source));
              setRawEditedSinceSwitch(false);
              if (discardConfirmOpen) setDiscardConfirmOpen(false);
              return true;
            }}
            resetEpoch={resetEpoch}
          />
        ) : (
          <JsonRawEditor
            entryId="new-json"
            positionNumber={1}
            draftValue={rawDraftValue}
            sourceEol={detectEol(tableSource)}
            prospectiveByteLength={utf8ByteLength}
            isOverCap={isOverCap}
            isDirty={isDirty}
            savingInFlight={savingInFlight}
            hasBlockingState={unconfirmedCreate !== null}
            externalError={switchBlockedError}
            parseDebounceMs={rawParseDebounceMs}
            onDraftChange={(nextVal: string) => {
              setRawDraftValue(nextVal);
              setRawEditedSinceSwitch(true);
              setSwitchBlockedError(null);
              if (discardConfirmOpen) setDiscardConfirmOpen(false);
            }}
            onSave={() => {
              void handleSaveNew();
            }}
            onRequestCancel={requestCancel}
          />
        )}

        <div className="border-t border-line bg-surface px-4 py-3">
          {unconfirmedCreate ? (
            <div
              role="alert"
              data-testid="new-json-retry-box"
              className="auth-alert mb-3"
            >
              <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                {tEntry('saveFailedTitle')}
              </p>
              <p className="m-0 text-[13px] text-body">{unconfirmedCreate.errorMessage}</p>
              <p className="m-0 mt-1 text-[12px] text-muted">{tEntry('saveFailedRetryBody')}</p>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-tertiary btn-sm"
                  onClick={onCancel}
                >
                  {tEntry('discardDraft')}
                </button>
                <button
                  type="button"
                  data-testid="new-json-retry-btn"
                  className="btn btn-primary btn-sm"
                  disabled={savingInFlight}
                  onClick={() => {
                    void handleRetryNew();
                  }}
                >
                  {tEntry('retry')}
                </button>
              </div>
            </div>
          ) : null}

          {saveError && !unconfirmedCreate ? (
            <p role="alert" data-testid="new-json-save-error" className="field-error mb-3 mt-0">
              {saveError}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              data-testid="new-json-cancel-btn"
              className="btn btn-tertiary btn-sm"
              disabled={savingInFlight}
              onClick={requestCancel}
            >
              {tEntry('cancel')} (<span className="mono">Esc</span>)
            </button>
            <button
              type="button"
              data-testid="new-json-save-btn"
              className="btn btn-primary btn-sm"
              disabled={saveDisabled}
              aria-busy={savingInFlight || undefined}
              onClick={() => {
                void handleSaveNew();
              }}
            >
              {savingInFlight ? (
                tEntry('savingButton')
              ) : (
                <>
                  {tEntry('save')} (<span className="mono">Ctrl+S</span>)
                </>
              )}
            </button>
          </div>

          {discardConfirmOpen ? (
            <div
              data-testid="new-json-discard-confirm"
              role="alert"
              className="auth-status mb-0 mt-3 flex flex-wrap items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <p className="m-0 text-[14px] font-semibold text-body">
                  {tEntry('discardConfirmTitle')}
                </p>
                <p className="m-0 mt-0.5 text-[13px] text-muted">
                  {tEntry('discardConfirmBody')}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="new-json-keep-editing-btn"
                  className="btn btn-tertiary btn-sm"
                  onClick={() => setDiscardConfirmOpen(false)}
                >
                  {tEntry('keepEditing')}
                </button>
                <button
                  type="button"
                  data-testid="new-json-discard-btn"
                  className="btn btn-danger btn-sm"
                  onClick={onCancel}
                >
                  {tEntry('discardChanges')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
