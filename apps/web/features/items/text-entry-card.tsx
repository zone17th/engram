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
import {
  ENTRY_MAX_PLAINTEXT_BYTES,
  ENTRY_NEAR_CAP_BYTES,
  VAULT_SECRET_INPUT_PROPS,
  captureEntrySaveOpGuard,
  copyEntryPlaintextToClipboard,
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
import { useSession } from '@/features/auth/session-provider';
import {
  useOptionalVault,
  vaultBodyQueryKey,
} from '@/features/vault/vault-provider';
import {
  classifyContentMutationError,
  entryGet,
  type ContentErrorI18nKey,
  type EntryMeta,
} from '@/lib/api/content';
import {
  applyTextareaEol,
  detectEol,
  normalizeEolToLf,
} from '@/lib/json/eol';

export type { EditorPlaintextHolder };

const utf8Encoder = new TextEncoder();

let editorPlaintextHolderTestHookRef: { current: EditorPlaintextHolder } | null = null;

/**
 * Module-scoped test hook to observe the plaintext holder without exposing a public component prop (IP15-FE3-7a).
 */
export function setEditorPlaintextHolderForTests(
  holderRef: { current: EditorPlaintextHolder } | null,
): void {
  editorPlaintextHolderTestHookRef = holderRef;
}

export interface TextEntryCardProps {
  readonly entry: EntryMeta;
  readonly itemId: string;
  readonly itemName?: string;
  readonly index: number;
  readonly total: number;
  readonly canReorder: boolean;
  readonly load?: EntryBodyLoader;
  readonly lazy?: boolean;
  readonly defaultEditing?: boolean;
  readonly onMoveUp: (entryId: string, restoreFocusEl?: HTMLElement | null) => void;
  readonly onMoveDown: (entryId: string, restoreFocusEl?: HTMLElement | null) => void;
  readonly onDelete: (entry: EntryMeta, index: number) => void;
  readonly onDragStart?: (index: number, e: DragEvent<HTMLElement>) => void;
  readonly onDragOver?: (index: number, e: DragEvent<HTMLElement>) => void;
  readonly onDrop?: (index: number, e: DragEvent<HTMLElement>) => void;
  readonly onDragEnd?: () => void;
  readonly onAnnounce?: (message: string) => void;
  readonly onDraftClearedOnLock?: () => void;
  readonly registerCardElement?: (entryId: string, element: HTMLElement | null) => void;
}

export function TextEntryCard({
  entry,
  itemId,
  itemName = '',
  index,
  total,
  canReorder,
  load = loadRealEntryBody,
  lazy = true,
  defaultEditing = false,
  onMoveUp,
  onMoveDown,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onAnnounce,
  onDraftClearedOnLock,
  registerCardElement,
}: TextEntryCardProps) {
  const tEntry = useTranslations('content.entry');
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
    body,
    pending,
    failed,
    oldKey,
    decryptFailed,
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
  // Editor state — holds plaintext ONLY while editing and unlocked; wiped on lock via registerSecretFormReset
  const [editing, setEditing] = useState(defaultEditing);
  const [originalSource, setOriginalSource] = useState<string>('');
  const [draftValue, setDraftValue] = useState<string>('');
  const internalPlaintextHolderRef = useRef<EditorPlaintextHolder>({
    originalSource: '',
    draftValue: '',
    submittedCandidateSource: '',
  });
  const plaintextHolderRef = editorPlaintextHolderTestHookRef ?? internalPlaintextHolderRef;
  plaintextHolderRef.current.originalSource = originalSource;
  plaintextHolderRef.current.draftValue = draftValue;

  const clearEditorPlaintextHolderSync = useCallback(() => {
    plaintextHolderRef.current.originalSource = '';
    plaintextHolderRef.current.draftValue = '';
    plaintextHolderRef.current.submittedCandidateSource = '';
    if (textareaRef.current) {
      textareaRef.current.value = '';
    }
    setOriginalSource('');
    setDraftValue('');
  }, [plaintextHolderRef]);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [mixedEolWarningTarget, setMixedEolWarningTarget] = useState<string | null>(null);

  // Save state (P4FE1-13: at most one unconfirmed save per entry)
  const [savingInFlight, setSavingInFlight] = useState(false);
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
  const [deletedRemotely, setDeletedRemotely] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);

  // Menu state
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuPopRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editBtnRef = useRef<HTMLButtonElement | null>(null);
  const saveLockRef = useRef<boolean>(false);
  const saveOwnerIdRef = useRef<number>(0);
  const nextSaveOwnerIdRef = useRef<number>(0);
  const releaseSaveGuardIfOwner = useCallback((ownerId: number) => {
    if (saveOwnerIdRef.current === ownerId) {
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      setSavingInFlight(false);
    }
  }, []);
  const pendingFocusEditBtnRef = useRef<boolean>(false);

  const lockEpochRef = useRef<number>(0);
  const editorRevisionRef = useRef<number>(0);
  const editingActiveRef = useRef<boolean>(false);
  editingActiveRef.current =
    editing ||
    draftValue.length > 0 ||
    originalSource.length > 0 ||
    unconfirmedSave !== null ||
    conflictState !== null;

  // Register secret form reset on vault lock/logout/user switch/reset (plan §2.10, Q15)
  useEffect(() => {
    if (!vault?.registerSecretFormReset) return;
    return vault.registerSecretFormReset(() => {
      const hadActiveEditorOrDraft = editingActiveRef.current;
      lockEpochRef.current += 1;
      editorRevisionRef.current = 0;
      setCommittedVersion(null);
      clearEditorPlaintextHolderSync();
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      pendingFocusEditBtnRef.current = false;
      setEditing(false);
      setDiscardConfirmOpen(false);
      setMixedEolWarningTarget(null);
      setSavingInFlight(false);
      setUnconfirmedSave(null);
      setConflictState(null);
      setDeletedRemotely(false);
      setSaveError(null);
      setMenuOpen(false);
      if (hadActiveEditorOrDraft) {
        onDraftClearedOnLock?.();
      }
    });
  }, [clearEditorPlaintextHolderSync, onDraftClearedOnLock, vault]);

  // Also clear immediately if `unlocked` flips to false
  useEffect(() => {
    if (!unlocked && editingActiveRef.current) {
      lockEpochRef.current += 1;
      editorRevisionRef.current = 0;
      setCommittedVersion(null);
      clearEditorPlaintextHolderSync();
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      pendingFocusEditBtnRef.current = false;
      setEditing(false);
      setDiscardConfirmOpen(false);
      setMixedEolWarningTarget(null);
      setSavingInFlight(false);
      setUnconfirmedSave(null);
      setConflictState(null);
      setDeletedRemotely(false);
      setSaveError(null);
      setMenuOpen(false);
    }
  }, [clearEditorPlaintextHolderSync, unlocked]);

  // Unmount cleanup (IP15-BE3-2): synchronously wipe every plaintext holder field and invalidate
  // card op/save ownership on unmount, independent of the reset-registration effect, so navigating
  // away while a fallback GET is held never leaves plaintext in the holder or allows a stale completion.
  useEffect(() => {
    const holderToWipe = plaintextHolderRef;
    const textareaRefToWipe = textareaRef;
    return () => {
      lockEpochRef.current += 1;
      editorRevisionRef.current = 0;
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      pendingFocusEditBtnRef.current = false;
      holderToWipe.current.originalSource = '';
      holderToWipe.current.draftValue = '';
      holderToWipe.current.submittedCandidateSource = '';
      if (textareaRefToWipe.current) {
        textareaRefToWipe.current.value = '';
      }
    };
  }, [plaintextHolderRef]);

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

  const sourceEol = useMemo(() => detectEol(originalSource), [originalSource]);
  const savePlan = useMemo(
    () => applyTextareaEol(originalSource, draftValue, sourceEol),
    [draftValue, originalSource, sourceEol],
  );

  // Measure UTF-8 bytes of the prospective output text
  const utf8ByteLength = useMemo(
    () => utf8Encoder.encode(savePlan.text).byteLength,
    [savePlan.text],
  );
  const isOverCap = utf8ByteLength > ENTRY_MAX_PLAINTEXT_BYTES;
  const isNearCap = !isOverCap && utf8ByteLength >= ENTRY_NEAR_CAP_BYTES;
  const isEmpty = utf8ByteLength === 0;
  const isDirty = savePlan.changed;

  // Save is disabled when empty, over 256 KiB cap, or while a PUT is in-flight or in "Thử lại" (P4FE1-13)
  const saveDisabled =
    isEmpty ||
    isOverCap ||
    savingInFlight ||
    unconfirmedSave !== null ||
    conflictState !== null ||
    deletedRemotely;

  const formattedBytes = useMemo(() => {
    try {
      return format.number(utf8ByteLength);
    } catch {
      return String(utf8ByteLength);
    }
  }, [format, utf8ByteLength]);

  const startEditing = useCallback(() => {
    if (!unlocked || body === undefined) return;
    editorRevisionRef.current = 0;
    const normalizedDraft = normalizeEolToLf(body);
    plaintextHolderRef.current.originalSource = body;
    plaintextHolderRef.current.draftValue = normalizedDraft;
    plaintextHolderRef.current.submittedCandidateSource = '';
    setOriginalSource(body);
    setDraftValue(normalizedDraft);
    setDiscardConfirmOpen(false);
    setMixedEolWarningTarget(null);
    setConflictState(null);
    setDeletedRemotely(false);
    setSaveError(null);
    setSavedFlash(false);
    setEditing(true);
    queueMicrotask(() => {
      textareaRef.current?.focus();
    });
  }, [body, plaintextHolderRef, unlocked]);

  const focusEditOrMenuTrigger = useCallback(() => {
    if (editBtnRef.current) {
      editBtnRef.current.focus();
    } else if (menuTriggerRef.current) {
      menuTriggerRef.current.focus();
    } else {
      cardEl?.focus();
    }
  }, [cardEl]);

  useEffect(() => {
    if (!editing && pendingFocusEditBtnRef.current) {
      if (editBtnRef.current || (!pending && body !== undefined) || !unlocked) {
        pendingFocusEditBtnRef.current = false;
        focusEditOrMenuTrigger();
      }
    }
  }, [body, editing, focusEditOrMenuTrigger, pending, unlocked]);

  // Rebase originalSource when useEntryBody resolves the authoritative body for committedVersion while editing stays open (IP15-BE2-3)
  useEffect(() => {
    if (
      editing &&
      unlocked &&
      body !== undefined &&
      committedVersion !== null &&
      currentVersion === committedVersion &&
      originalSource !== body
    ) {
      plaintextHolderRef.current.originalSource = body;
      setOriginalSource(body);
    }
  }, [body, committedVersion, currentVersion, editing, originalSource, plaintextHolderRef, unlocked]);

  const closeEditorCleanly = useCallback(() => {
    clearEditorPlaintextHolderSync();
    saveOwnerIdRef.current = 0;
    saveLockRef.current = false;
    editorRevisionRef.current = 0;
    pendingFocusEditBtnRef.current = true;
    setEditing(false);
    setDiscardConfirmOpen(false);
    setMixedEolWarningTarget(null);
    setUnconfirmedSave(null);
    setConflictState(null);
    setDeletedRemotely(false);
    setSaveError(null);
  }, [clearEditorPlaintextHolderSync]);

  const requestCancelEdit = useCallback(() => {
    if (savingInFlight) return;
    if (!isDirty && unconfirmedSave === null && conflictState === null) {
      closeEditorCleanly();
      return;
    }
    setDiscardConfirmOpen(true);
  }, [closeEditorCleanly, conflictState, isDirty, savingInFlight, unconfirmedSave]);

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

        // P4BE2-1 / IP15-BE2-4 / FE3-8: Never update state or release a successor's guard if stale or not owner;
        // if ownerId still matches, release our own guard before returning.
        if (saveOwnerIdRef.current !== ownerId) {
          return;
        }
        releaseSaveGuardIfOwner(ownerId);
        if (!applied || !sealed.isCurrent()) {
          return;
        }
        setUnconfirmedSave(null);
        setConflictState(null);
        setDeletedRemotely(false);
        setDiscardConfirmOpen(false);
        setMixedEolWarningTarget(null);
        setCommittedVersion(meta.version);

        if (editorRevisionRef.current === submittedRevision) {
          clearEditorPlaintextHolderSync();
          setEditing(false);
          pendingFocusEditBtnRef.current = true;
        } else {
          // IP15-BE2-3: Rebase dirty/EOL comparison onto the newly committed body via the resettable holder
          // so reverting to the pre-save body while PUT was in flight still sees savePlan.changed === true
          const committedCandidate = plaintextHolderRef.current.submittedCandidateSource ?? '';
          plaintextHolderRef.current.submittedCandidateSource = '';
          if (committedCandidate.length > 0) {
            plaintextHolderRef.current.originalSource = committedCandidate;
            setOriginalSource(committedCandidate);
          }
        }
        setSavedFlash(true);
        onAnnounce?.(tEntry('savedAnnounce'));

        // Trigger the loader for the new version so the updated card decrypts via loader
        void queryClient.invalidateQueries({
          queryKey: vaultBodyQueryKey(entry.id, meta.version),
        });
      } catch (err) {
        if (saveOwnerIdRef.current !== ownerId) {
          return;
        }
        releaseSaveGuardIfOwner(ownerId);
        if (!sealed.isCurrent()) {
          return;
        }
        const classified = classifyContentMutationError(err, {
          hadUncertainSend: true,
        });

        // Case (b): terminal logout boundary after uncertain send (SPEC §3.7, advisor-dec-119/120)
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
          setEditing(false);
          setUnconfirmedSave(null);
          setConflictState(null);
          return;
        }

        // 412 version_mismatch -> conflict state (keep draft, offer 3 actions)
        if (classified.kind === 'version_mismatch') {
          setUnconfirmedSave(null);
          setConflictState({
            currentVersion: classified.currentVersion,
            reloadConfirmOpen: false,
          });
          onAnnounce?.(tEntry('conflictTitle'));
          return;
        }

        // 409 entry_key_mismatch -> vault key changed elsewhere; lock vault
        if (classified.kind === 'entry_key_mismatch') {
          setUnconfirmedSave(null);
          void vault?.reloadVaultMeta();
          return;
        }

        // 404 not_found -> entry was deleted on another device; keep draft + offer "Save as new entry"
        if (classified.kind === 'not_found') {
          setUnconfirmedSave(null);
          setDeletedRemotely(true);
          onAnnounce?.(tEntry('deletedRemotelyTitle'));
          return;
        }

        // 400 entry_nonce_reused -> deterministic 400: end the flow with its localized error and keep the draft in the editor;
        // never capture plaintext in executePut or automatically reseal (IP15-BE1-1, BE1-7, FE1-6).

        const msg = translateContentError(classified.i18nKey);
        if (classified.canRetrySameBytes) {
          // Keep exact sealed payload + Idempotency-Key for Retry (P4FE1-13)
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

      // EOL rule (plan §2.10 rule 2): if unchanged after normalization, keep originalSource and do NOT send PUT
      if (!savePlan.changed) {
        closeEditorCleanly();
        return;
      }

      // Mixed / lone CR EOL requires confirmation warning before saving
      if (savePlan.requiresWarning && !bypassMixedEolWarning) {
        const targetLabel =
          savePlan.targetEol === 'crlf'
            ? 'CRLF'
            : savePlan.targetEol === 'cr'
              ? 'CR'
              : 'LF';
        setMixedEolWarningTarget(targetLabel);
        return;
      }

      const submittedRevision = editorRevisionRef.current;
      const ownerId = ++nextSaveOwnerIdRef.current;
      saveOwnerIdRef.current = ownerId;
      setMixedEolWarningTarget(null);
      saveLockRef.current = true;
      setSavingInFlight(true);
      setSaveError(null);

      try {
        const sealed = await sealEntryUpdate({
          entryId: entry.id,
          itemId,
          version: effectiveVersion,
          getText: () => {
            const currentHolder = plaintextHolderRef.current;
            const candidate = applyTextareaEol(
              currentHolder.originalSource,
              currentHolder.draftValue,
            ).text;
            plaintextHolderRef.current.submittedCandidateSource = candidate;
            return candidate;
          },
          vault,
        });
        if (!sealed.isCurrent() || saveOwnerIdRef.current !== ownerId) {
          releaseSaveGuardIfOwner(ownerId);
          return;
        }
        await executePut(sealed, effectiveVersion, false, submittedRevision, ownerId);
      } catch (err) {
        if (saveOwnerIdRef.current !== ownerId) {
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
      closeEditorCleanly,
      conflictState,
      deletedRemotely,
      effectiveVersion,
      entry.id,
      executePut,
      isEmpty,
      isOverCap,
      itemId,
      onAnnounce,
      plaintextHolderRef,
      releaseSaveGuardIfOwner,
      savePlan,
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

  // 412 action 1: Giữ bản của tôi (Keep mine) -> fetch latest version if needed, re-seal draft with fresh nonce, PUT with new If-Match + new Idempotency-Key
  const handleConflictKeepMine = useCallback(async () => {
    if (!vault || saveLockRef.current || savingInFlight || isEmpty || isOverCap) return;
    const guard = captureEntrySaveOpGuard(vault, lockEpochRef);
    const isOpStillCurrent = guard.isStillCurrent;

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
        if (!isOpStillCurrent() || saveOwnerIdRef.current !== ownerId) {
          releaseSaveGuardIfOwner(ownerId);
          return;
        }
        targetVersion = latestEntry.version;
      } else if (!isOpStillCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }

      // IP15-FE3-6: Re-read editorRevisionRef after the fallback GET. If the user edited the textarea
      // while the GET was in flight, abort back to the conflict banner (with the resolved version) so
      // Keep mine only seals what was confirmed at click.
      if (editorRevisionRef.current !== submittedRevision) {
        releaseSaveGuardIfOwner(ownerId);
        setConflictState({
          currentVersion: targetVersion,
          reloadConfirmOpen: false,
        });
        return;
      }

      // IP15-BE2-1 / FE3-7b: Read the draft synchronously from the resettable holder AFTER the fallback GET
      // and AFTER the op-token/owner/revision checks, immediately before sealing. Note that in JS/V8, closures
      // created in the same render can share a lexical context with sibling handlers; the effective security
      // guarantees are the synchronous op-token/epoch/owner check, synchronous holder + DOM wipe on reset/unmount,
      // and the absence of any network/cache/DOM/storage sink after reset.
      const resealed = await sealEntryUpdate({
        entryId: entry.id,
        itemId,
        version: targetVersion,
        getText: () => {
          const currentHolder = plaintextHolderRef.current;
          const candidate = applyTextareaEol(
            currentHolder.originalSource,
            currentHolder.draftValue,
          ).text;
          plaintextHolderRef.current.submittedCandidateSource = candidate;
          return candidate;
        },
        vault,
      });

      if (!isOpStillCurrent() || !resealed.isCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }
      setConflictState(null);
      await executePut(resealed, targetVersion, false, submittedRevision, ownerId);
    } catch (err) {
      if (!isOpStillCurrent() || saveOwnerIdRef.current !== ownerId) {
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
    onAnnounce,
    plaintextHolderRef,
    releaseSaveGuardIfOwner,
    savingInFlight,
    translateContentError,
    vault,
  ]);

  // 412 action 2: Tải bản mới (Load latest) after inline confirmation -> drop draft and load latest version
  const handleConflictConfirmDiscardAndLoad = useCallback(async () => {
    const nextVer = conflictState?.currentVersion;
    closeEditorCleanly();
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
  }, [closeEditorCleanly, conflictState?.currentVersion, entry.id, itemId, queryClient, refetch]);

  // 412 action 3: Chép bản của tôi (Copy mine)
  const handleConflictCopyMine = useCallback(async () => {
    await copyEntryPlaintextToClipboard(savePlan.text);
    onAnnounce?.(tEntry('copiedMine'));
  }, [onAnnounce, savePlan.text, tEntry]);

  // 404 action: Save as new entry
  const handleSaveAsNewEntry = useCallback(async () => {
    if (!vault || saveLockRef.current || savingInFlight || isEmpty || isOverCap) return;
    const ownerId = ++nextSaveOwnerIdRef.current;
    saveOwnerIdRef.current = ownerId;
    saveLockRef.current = true;
    setSavingInFlight(true);
    setSaveError(null);

    try {
      const sealedNew = await sealNewEntry({
        itemId,
        type: 'text',
        getText: () => {
          const currentHolder = plaintextHolderRef.current;
          return applyTextareaEol(currentHolder.originalSource, currentHolder.draftValue).text;
        },
        vault,
      });
      if (!sealedNew.isCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }
      const { applied } = await mutateSealedEntryCreate(
        queryClient,
        toEntryCreateVariables(sealedNew),
      );
      if (!applied || !sealedNew.isCurrent() || saveOwnerIdRef.current !== ownerId) {
        releaseSaveGuardIfOwner(ownerId);
        return;
      }
      closeEditorCleanly();
      void queryClient.invalidateQueries({ queryKey: contentQueryKeys.entries(itemId) });
      onAnnounce?.(tEntry('savedAnnounce'));
    } catch (err) {
      if (saveOwnerIdRef.current !== ownerId) {
        return;
      }
      releaseSaveGuardIfOwner(ownerId);
      const classified = classifyContentMutationError(err);
      const msg = translateContentError(classified.i18nKey);
      setSaveError(msg);
      onAnnounce?.(msg);
    }
  }, [
    closeEditorCleanly,
    isEmpty,
    isOverCap,
    itemId,
    onAnnounce,
    plaintextHolderRef,
    queryClient,
    releaseSaveGuardIfOwner,
    savingInFlight,
    tEntry,
    translateContentError,
    vault,
  ]);

  const handleCopyBody = useCallback(async () => {
    if (!unlocked || body === undefined) return;
    await copyEntryPlaintextToClipboard(body);
    onAnnounce?.(tEntry('copied'));
  }, [body, onAnnounce, tEntry, unlocked]);

  const handleTextareaKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const keyLower = (e.key || '').toLowerCase();
    if (keyLower === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestCancelEdit();
    }
  };

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

  const positionNumber = index + 1;
  const moveUpDisabled = !canReorder || index <= 0;
  const moveDownDisabled = !canReorder || index >= total - 1;
  const hasCardError = Boolean(conflictState || unconfirmedSave || saveError || failed);

  return (
    <article
      ref={handleCardRef}
      tabIndex={-1}
      aria-label={tEntry('cardLabel', { pos: positionNumber })}
      data-testid={`entry-card-${entry.id}`}
      data-entry-card={entry.id}
      onDragOver={(e) => onDragOver?.(index, e)}
      onDrop={(e) => onDrop?.(index, e)}
      className={`card min-w-0 ${hasCardError ? 'card-error' : ''}`}
    >
      {/* Card Header: no entry title and no edit date per Q19 / SPEC §7.3 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5 rounded-t-[calc(var(--r-xl)-1px)]">
        <span
          draggable={canReorder && !editing}
          onDragStart={(e) => onDragStart?.(index, e)}
          onDragEnd={() => onDragEnd?.()}
          data-testid={`entry-drag-handle-${entry.id}`}
          aria-hidden="true"
          className={`mono select-none text-muted ${
            canReorder && !editing ? 'cursor-grab' : 'cursor-default opacity-50'
          }`}
        >
          ⠿
        </span>
        <span className="badge-type badge-text">text</span>
        <span
          className="mono text-[12px] text-muted"
          data-entry-pos
          data-testid={`entry-pos-${entry.id}`}
        >
          #{positionNumber}
        </span>

        {editing ? (
          <>
            <span className="text-[14px] font-semibold text-body">
              {conflictState
                ? tEntry('conflictTitle')
                : savingInFlight
                  ? tEntry('saving')
                  : tEntry('editingTitle')}
            </span>
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
            <span
              id={`entry-byte-counter-${entry.id}`}
              data-testid={`entry-byte-counter-${entry.id}`}
              className={`mono ml-auto text-[12px] ${
                isOverCap ? 'font-semibold text-error-ink' : 'text-body'
              }`}
            >
              {isOverCap
                ? tEntry('byteCounterOver', { bytes: formattedBytes })
                : isNearCap
                  ? tEntry('byteCounterNear', { bytes: formattedBytes })
                  : tEntry('byteCounter', { bytes: formattedBytes })}
            </span>
          </>
        ) : (
          <>
            {savedFlash ? (
              <span role="status" className="badge-type badge-ok" data-testid="entry-saved-badge">
                {tEntry('savedBadge')}
              </span>
            ) : null}

            <div className="relative ml-auto flex items-center gap-1" data-card-menu-host>
              {unlocked && body !== undefined && !oldKey && !failed ? (
                <>
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
                  <button
                    ref={editBtnRef}
                    type="button"
                    className="btn btn-tertiary btn-sm"
                    data-testid={`entry-edit-btn-${entry.id}`}
                    onClick={startEditing}
                  >
                    {tEntry('edit')}
                  </button>
                </>
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
                      startEditing();
                    }}
                  >
                    <span>{tEntry('edit')}</span>
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
          </>
        )}
      </div>

      {/* Card Body */}
      <div className="p-4">
        {!unlocked ? (
          <LockMask />
        ) : editing ? (
          <div data-testid={`entry-editor-${entry.id}`}>
            <label htmlFor={`entry-edit-textarea-${entry.id}`} className="field-label">
              {tEntry('contentLabel')}
            </label>
            <textarea
              ref={textareaRef}
              id={`entry-edit-textarea-${entry.id}`}
              data-testid={`entry-edit-textarea-${entry.id}`}
              rows={5}
              value={draftValue}
              aria-invalid={isOverCap || undefined}
              aria-describedby={`entry-byte-counter-${entry.id} entry-edit-shortcuts-${entry.id}`}
              className="field-input mono resize-y text-[14px] leading-relaxed"
              {...VAULT_SECRET_INPUT_PROPS}
              onChange={(e) => {
                plaintextHolderRef.current.draftValue = e.target.value;
                setDraftValue(e.target.value);
                editorRevisionRef.current += 1;
                if (discardConfirmOpen) setDiscardConfirmOpen(false);
                if (mixedEolWarningTarget) setMixedEolWarningTarget(null);
              }}
              onKeyDown={handleTextareaKeyDown}
            />

            <div
              id={`entry-edit-shortcuts-${entry.id}`}
              className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted"
            >
              <span>{tEntry('shortcutsHint')}</span>
              <span>
                {savingInFlight ? tEntry('singleInFlightHint') : tEntry('maxBytesHint')}
              </span>
            </div>

            {isOverCap ? (
              <p
                role="alert"
                data-testid={`entry-overcap-error-${entry.id}`}
                className="field-error mb-0 mt-3"
              >
                {tEntry('overCapAlert')}
              </p>
            ) : null}

            {/* Mixed / lone CR EOL warning before save (plan §2.10 rule 2) */}
            {mixedEolWarningTarget ? (
              <div
                role="alert"
                data-testid={`entry-mixed-eol-warning-${entry.id}`}
                className="auth-status mb-0 mt-3 flex flex-wrap items-center justify-between gap-3"
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
                className="auth-alert mb-0 mt-3"
              >
                <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                  {tEntry('saveFailedTitle')}
                </p>
                <p className="m-0 text-[13px] text-body">{unconfirmedSave.errorMessage}</p>
                <p className="m-0 mt-1 text-[12px] text-muted">{tEntry('saveFailedRetryBody')}</p>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    data-testid={`entry-discard-unconfirmed-${entry.id}`}
                    className="btn btn-tertiary btn-sm"
                    onClick={closeEditorCleanly}
                  >
                    {tEntry('discardDraft')}
                  </button>
                  <button
                    type="button"
                    data-testid={`entry-retry-save-${entry.id}`}
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

            {/* Deterministic save error */}
            {saveError && !unconfirmedSave ? (
              <p
                role="alert"
                data-testid={`entry-save-error-${entry.id}`}
                className="field-error mb-0 mt-3"
              >
                {saveError}
              </p>
            ) : null}

            {/* 412 conflict banner: Load latest / Keep mine / Copy mine */}
            {conflictState ? (
              <div
                data-testid={`entry-conflict-412-${entry.id}`}
                className="mt-3"
              >
                <div role="alert" className="auth-alert mb-3">
                  <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                    {tEntry('conflictTitle')}
                  </p>
                  <p className="m-0 text-[13px] text-body">{tEntry('conflictBody')}</p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid={`entry-conflict-load-latest-${entry.id}`}
                    className="btn btn-secondary btn-sm"
                    disabled={savingInFlight}
                    onClick={() =>
                      setConflictState((prev) =>
                        prev ? { ...prev, reloadConfirmOpen: true } : null,
                      )
                    }
                  >
                    {tEntry('loadLatest')}
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
                    {tEntry('keepMine')}
                  </button>
                  <button
                    type="button"
                    data-testid={`entry-conflict-copy-mine-${entry.id}`}
                    className="btn btn-tertiary btn-sm"
                    onClick={() => {
                      void handleConflictCopyMine();
                    }}
                  >
                    {tEntry('copyMine')}
                  </button>
                </div>

                {conflictState.reloadConfirmOpen ? (
                  <div
                    data-testid={`entry-conflict-reload-confirm-${entry.id}`}
                    className="auth-status mb-0 mt-3 flex flex-wrap items-center justify-between gap-3"
                  >
                    <p className="m-0 text-[13px] font-semibold text-body">
                      {tEntry('reloadConfirmPrompt')}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        data-testid={`entry-conflict-reload-cancel-${entry.id}`}
                        className="btn btn-tertiary btn-sm"
                        onClick={() =>
                          setConflictState((prev) =>
                            prev ? { ...prev, reloadConfirmOpen: false } : null,
                          )
                        }
                      >
                        {tEntry('cancel')}
                      </button>
                      <button
                        type="button"
                        data-testid={`entry-conflict-reload-confirm-btn-${entry.id}`}
                        className="btn btn-danger btn-sm"
                        onClick={() => {
                          void handleConflictConfirmDiscardAndLoad();
                        }}
                      >
                        {tEntry('discardAndLoad')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* 404 deleted remotely while editing */}
            {deletedRemotely ? (
              <div
                role="alert"
                data-testid={`entry-deleted-remotely-${entry.id}`}
                className="auth-alert mb-0 mt-3"
              >
                <p className="m-0 mb-1 text-[14px] font-semibold text-body">
                  {tEntry('deletedRemotelyTitle')}
                </p>
                <p className="m-0 text-[13px] text-body">{tEntry('deletedRemotelyBody')}</p>
                <div className="mt-3 flex flex-wrap gap-2">
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
                  <button
                    type="button"
                    className="btn btn-tertiary btn-sm"
                    onClick={closeEditorCleanly}
                  >
                    {tEntry('discardDraft')}
                  </button>
                </div>
              </div>
            ) : null}

            {/* Primary Save / Cancel bar */}
            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                id={`entry-cancel-btn-${entry.id}`}
                data-testid={`entry-cancel-btn-${entry.id}`}
                className="btn btn-tertiary btn-sm"
                disabled={savingInFlight}
                onClick={requestCancelEdit}
              >
                {tEntry('cancel')} (<span className="mono">Esc</span>)
              </button>
              <button
                type="button"
                id={`entry-save-btn-${entry.id}`}
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

            {/* Inline confirm when Esc / Cancel pressed on dirty editor (plan §2.10) */}
            {discardConfirmOpen ? (
              <div
                id={`entry-discard-confirm-${entry.id}`}
                data-testid={`entry-discard-confirm-${entry.id}`}
                role="alert"
                className="auth-status mb-0 mt-4 flex flex-wrap items-center justify-between gap-3"
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
                    onClick={() => {
                      setDiscardConfirmOpen(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    {tEntry('keepEditing')}
                  </button>
                  <button
                    type="button"
                    data-testid={`entry-discard-btn-${entry.id}`}
                    className="btn btn-danger btn-sm"
                    onClick={closeEditorCleanly}
                  >
                    {tEntry('discardChanges')}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
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
          /* Plaintext rendered ONLY as a React text node with whitespace/newlines preserved; NO innerHTML, NO autolink (Q19) */
          <p
            data-testid="entry-body"
            data-vault-decrypted=""
            className="mono m-0 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-body"
          >
            {body}
          </p>
        )}
      </div>
    </article>
  );
}

export interface NewTextEntryComposerProps {
  readonly itemId: string;
  readonly itemName?: string;
  readonly onSaved: (created: EntryMeta) => void;
  readonly onCancel: () => void;
  readonly onAnnounce?: (message: string) => void;
  readonly onDraftClearedOnLock?: () => void;
}

export function NewTextEntryComposer({
  itemId,
  itemName = '',
  onSaved,
  onCancel,
  onAnnounce,
  onDraftClearedOnLock,
}: NewTextEntryComposerProps) {
  const tEntry = useTranslations('content.entry');
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

  const [draftValue, setDraftValue] = useState('');
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [savingInFlight, setSavingInFlight] = useState(false);
  const [unconfirmedCreate, setUnconfirmedCreate] = useState<{
    readonly sealed: SealedNewEntryPayload;
    readonly errorMessage: string;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const saveLockRef = useRef<boolean>(false);
  const saveOwnerIdRef = useRef<number>(0);
  const nextSaveOwnerIdRef = useRef<number>(0);
  const lockEpochRef = useRef<number>(0);
  const composerHolderRef = useRef<{ draftValue: string }>({ draftValue: '' });
  composerHolderRef.current.draftValue = draftValue;
  const composerDirtyRef = useRef<boolean>(false);
  composerDirtyRef.current = draftValue.length > 0 || unconfirmedCreate !== null;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!vault?.registerSecretFormReset) return;
    return vault.registerSecretFormReset(() => {
      const hadNonEmptyDraft = composerDirtyRef.current;
      lockEpochRef.current += 1;
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      composerHolderRef.current.draftValue = '';
      if (textareaRef.current) {
        textareaRef.current.value = '';
      }
      setDraftValue('');
      setDiscardConfirmOpen(false);
      setSavingInFlight(false);
      setUnconfirmedCreate(null);
      setSaveError(null);
      if (hadNonEmptyDraft) {
        onDraftClearedOnLock?.();
      }
      onCancel();
    });
  }, [onCancel, onDraftClearedOnLock, vault]);

  // Unmount cleanup (IP15-BE3-2): synchronously wipe composer holder and invalidate save ownership on unmount.
  useEffect(() => {
    const holderToWipe = composerHolderRef;
    const textareaRefToWipe = textareaRef;
    return () => {
      lockEpochRef.current += 1;
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      holderToWipe.current.draftValue = '';
      if (textareaRefToWipe.current) {
        textareaRefToWipe.current.value = '';
      }
    };
  }, []);

  const utf8ByteLength = useMemo(
    () => utf8Encoder.encode(draftValue).byteLength,
    [draftValue],
  );
  const isOverCap = utf8ByteLength > ENTRY_MAX_PLAINTEXT_BYTES;
  const isNearCap = !isOverCap && utf8ByteLength >= ENTRY_NEAR_CAP_BYTES;
  const isEmpty = utf8ByteLength === 0;
  const isDirty = draftValue.length > 0;
  const saveDisabled =
    isEmpty || isOverCap || savingInFlight || unconfirmedCreate !== null;

  const formattedBytes = useMemo(() => {
    try {
      return format.number(utf8ByteLength);
    } catch {
      return String(utf8ByteLength);
    }
  }, [format, utf8ByteLength]);

  const requestCancel = useCallback(() => {
    if (savingInFlight) return;
    if (!isDirty && unconfirmedCreate === null) {
      if (textareaRef.current) {
        textareaRef.current.value = '';
      }
      onCancel();
      return;
    }
    setDiscardConfirmOpen(true);
  }, [isDirty, onCancel, savingInFlight, unconfirmedCreate]);

  const executeCreate = useCallback(
    async (sealed: SealedNewEntryPayload, hadPriorUncertainSend: boolean, ownerId: number) => {
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

        if (!applied || !sealed.isCurrent() || saveOwnerIdRef.current !== ownerId) {
          if (saveOwnerIdRef.current === ownerId) {
            saveOwnerIdRef.current = 0;
            saveLockRef.current = false;
            setSavingInFlight(false);
          }
          return;
        }

        composerHolderRef.current.draftValue = '';
        if (textareaRef.current) {
          textareaRef.current.value = '';
        }
        saveOwnerIdRef.current = 0;
        saveLockRef.current = false;
        setSavingInFlight(false);
        setUnconfirmedCreate(null);
        setDraftValue('');
        onAnnounce?.(tEntry('savedAnnounce'));
        onSaved(meta);
      } catch (err) {
        if (saveOwnerIdRef.current !== ownerId) {
          return;
        }
        saveOwnerIdRef.current = 0;
        saveLockRef.current = false;
        setSavingInFlight(false);
        if (!sealed.isCurrent()) {
          return;
        }

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
          if (textareaRef.current) {
            textareaRef.current.value = '';
          }
          setDraftValue('');
          setUnconfirmedCreate(null);
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

    const ownerId = ++nextSaveOwnerIdRef.current;
    saveOwnerIdRef.current = ownerId;
    saveLockRef.current = true;
    setSavingInFlight(true);
    setSaveError(null);

    try {
      const sealed = await sealNewEntry({
        itemId,
        type: 'text',
        getText: () => composerHolderRef.current.draftValue,
        vault,
      });
      if (!sealed.isCurrent() || saveOwnerIdRef.current !== ownerId) {
        if (saveOwnerIdRef.current === ownerId) {
          saveOwnerIdRef.current = 0;
          saveLockRef.current = false;
          setSavingInFlight(false);
        }
        return;
      }
      await executeCreate(sealed, false, ownerId);
    } catch (err) {
      if (saveOwnerIdRef.current !== ownerId) return;
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      setSavingInFlight(false);
      const classified = classifyContentMutationError(err);
      const msg = translateContentError(classified.i18nKey);
      setSaveError(msg);
      onAnnounce?.(msg);
    }
  }, [
    executeCreate,
    isEmpty,
    isOverCap,
    itemId,
    onAnnounce,
    savingInFlight,
    translateContentError,
    unconfirmedCreate,
    vault,
  ]);

  const handleRetryNew = useCallback(async () => {
    if (!unconfirmedCreate || saveLockRef.current || savingInFlight) return;
    const ownerId = ++nextSaveOwnerIdRef.current;
    saveOwnerIdRef.current = ownerId;
    saveLockRef.current = true;
    await executeCreate(unconfirmedCreate.sealed, true, ownerId);
  }, [executeCreate, savingInFlight, unconfirmedCreate]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const keyLower = (e.key || '').toLowerCase();
    if (keyLower === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSaveNew();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      requestCancel();
    }
  };

  return (
    <article
      data-testid="new-text-entry-composer"
      className={`card overflow-hidden ${unconfirmedCreate || saveError ? 'card-error' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <span className="badge-type badge-text">text</span>
        <span className="text-[14px] font-semibold text-body">
          {savingInFlight ? tEntry('saving') : tEntry('creatingTitle')}
        </span>
        <span
          id="new-entry-byte-counter"
          data-testid="new-entry-byte-counter"
          className={`mono ml-auto text-[12px] ${
            isOverCap ? 'font-semibold text-error-ink' : 'text-body'
          }`}
        >
          {isOverCap
            ? tEntry('byteCounterOver', { bytes: formattedBytes })
            : isNearCap
              ? tEntry('byteCounterNear', { bytes: formattedBytes })
              : tEntry('byteCounter', { bytes: formattedBytes })}
        </span>
      </div>

      <div className="p-4">
        <label htmlFor="new-entry-textarea" className="field-label">
          {tEntry('contentLabel')}
        </label>
        <textarea
          ref={textareaRef}
          id="new-entry-textarea"
          data-testid="new-entry-textarea"
          rows={5}
          value={draftValue}
          placeholder={tEntry('contentPlaceholder')}
          aria-invalid={isOverCap || undefined}
          aria-describedby="new-entry-byte-counter new-entry-shortcuts"
          className="field-input mono resize-y text-[14px] leading-relaxed"
          {...VAULT_SECRET_INPUT_PROPS}
          onChange={(e) => {
            setDraftValue(e.target.value);
            if (discardConfirmOpen) setDiscardConfirmOpen(false);
          }}
          onKeyDown={handleKeyDown}
        />

        <div
          id="new-entry-shortcuts"
          className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted"
        >
          <span>{tEntry('shortcutsHint')}</span>
          <span>{tEntry('maxBytesHint')}</span>
        </div>

        {isOverCap ? (
          <p role="alert" data-testid="new-entry-overcap-error" className="field-error mb-0 mt-3">
            {tEntry('overCapAlert')}
          </p>
        ) : null}

        {unconfirmedCreate ? (
          <div
            role="alert"
            data-testid="new-entry-retry-box"
            className="auth-alert mb-0 mt-3"
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
                data-testid="new-entry-retry-btn"
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
          <p role="alert" data-testid="new-entry-save-error" className="field-error mb-0 mt-3">
            {saveError}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            data-testid="new-entry-cancel-btn"
            className="btn btn-tertiary btn-sm"
            disabled={savingInFlight}
            onClick={requestCancel}
          >
            {tEntry('cancel')} (<span className="mono">Esc</span>)
          </button>
          <button
            type="button"
            data-testid="new-entry-save-btn"
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
            data-testid="new-entry-discard-confirm"
            role="alert"
            className="auth-status mb-0 mt-4 flex flex-wrap items-center justify-between gap-3"
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
                data-testid="new-entry-keep-editing-btn"
                className="btn btn-tertiary btn-sm"
                onClick={() => {
                  setDiscardConfirmOpen(false);
                  textareaRef.current?.focus();
                }}
              >
                {tEntry('keepEditing')}
              </button>
              <button
                type="button"
                data-testid="new-entry-discard-btn"
                className="btn btn-danger btn-sm"
                onClick={() => {
                  if (textareaRef.current) {
                    textareaRef.current.value = '';
                  }
                  onCancel();
                }}
              >
                {tEntry('discardChanges')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}
