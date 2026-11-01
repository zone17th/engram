'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useSession } from '@/features/auth/session-provider';
import {
  ENTRY_MAX_PLAINTEXT_BYTES,
  captureUnconfirmedSaveClearGeneration,
  mutateSealedEntryCreate,
  recordUnconfirmedSave,
  sealNewEntry,
  toEntryCreateVariables,
  type SealedNewEntryPayload,
} from '@/features/entries';
import {
  JsonRawEditor,
  validateRawJsonText,
  type RawValidationIssue,
} from '@/features/json-table/json-raw-editor';
import {
  JsonTreeGrid,
  type JsonTreeGridCommitControlRef,
} from '@/features/json-table/json-tree-grid';
import { useOptionalVault } from '@/features/vault/vault-provider';
import {
  classifyContentMutationError,
  type ContentErrorI18nKey,
  type EntryMeta,
} from '@/lib/api/content';
import {
  detectEol,
  measureUtf8Bytes,
  normalizeEolToLf,
  parseJsonStrict,
} from '@/lib/json';

export type JsonCardMode = 'table' | 'raw';

export type JsonNewPresetId = 'empty-object' | 'empty-array';

export const JSON_NEW_PRESETS: Readonly<Record<JsonNewPresetId, string>> = {
  'empty-object': '{}',
  'empty-array': '[]',
};

export interface JsonComposerPlaintextHolder {
  candidateSource: string;
}

let jsonComposerPlaintextHolderTestHookRef: { current: JsonComposerPlaintextHolder } | null =
  null;

/**
 * Module-scoped test hook to observe the JSON composer plaintext holder without exposing a public prop (IP16-FE1-3).
 */
export const __testing = {
  setJsonComposerPlaintextHolderForTests(
    holderRef: { current: JsonComposerPlaintextHolder } | null,
  ): void {
    jsonComposerPlaintextHolderTestHookRef = holderRef;
  },
};

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
  const [rawSettledIssue, setRawSettledIssue] = useState<RawValidationIssue | null>(null);
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
  const saveOwnerIdRef = useRef<number>(0);
  const nextSaveOwnerIdRef = useRef<number>(0);
  const lockEpochRef = useRef<number>(0);
  const gridCommitControlRef = useRef<JsonTreeGridCommitControlRef | null>(null);

  const candidateSource = mode === 'raw' && rawEditedSinceSwitch ? rawDraftValue : tableSource;
  const isDirty = candidateSource !== JSON_NEW_PRESETS[preset];

  const internalComposerHolderRef = useRef<JsonComposerPlaintextHolder>({
    candidateSource: JSON_NEW_PRESETS[initialPreset],
  });
  const composerHolderRef = jsonComposerPlaintextHolderTestHookRef ?? internalComposerHolderRef;
  composerHolderRef.current.candidateSource = candidateSource;

  const composerDirtyRef = useRef<boolean>(false);
  composerDirtyRef.current = isDirty || unconfirmedCreate !== null;

  useEffect(() => {
    if (!vault?.registerSecretFormReset) return;
    return vault.registerSecretFormReset(() => {
      const hadNonEmptyDraft = composerDirtyRef.current;
      lockEpochRef.current += 1;
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      composerHolderRef.current.candidateSource = '';
      setTableSource(JSON_NEW_PRESETS[initialPreset]);
      setRawDraftValue(JSON_NEW_PRESETS[initialPreset]);
      setRawEditedSinceSwitch(false);
      setRawSettledIssue(null);
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
  }, [composerHolderRef, initialPreset, onCancel, onDraftClearedOnLock, vault]);

  // Unmount cleanup (IP16-FE1-3 / IP15-BE3-2): synchronously wipe composer holder and invalidate
  // save ownership on unmount, independent of the reset-registration effect.
  useEffect(() => {
    const holderToWipe = composerHolderRef;
    return () => {
      lockEpochRef.current += 1;
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      holderToWipe.current.candidateSource = '';
    };
  }, [composerHolderRef]);

  const parsedDocResult = useMemo(() => parseJsonStrict(tableSource), [tableSource]);
  const currentDoc = parsedDocResult.ok ? parsedDocResult.document : null;

  const utf8ByteLength = useMemo(
    () => measureUtf8Bytes(candidateSource),
    [candidateSource],
  );
  const isOverCap = utf8ByteLength > ENTRY_MAX_PLAINTEXT_BYTES;
  const isEmpty = utf8ByteLength === 0;
  const saveDisabled =
    isEmpty ||
    isOverCap ||
    (mode === 'raw' && rawSettledIssue !== null) ||
    (mode === 'table' && !currentDoc) ||
    savingInFlight ||
    unconfirmedCreate !== null;

  const handleSelectPreset = useCallback((nextPreset: JsonNewPresetId) => {
    const template = JSON_NEW_PRESETS[nextPreset];
    setPreset(nextPreset);
    setTableSource(template);
    setRawDraftValue(template);
    setRawEditedSinceSwitch(false);
    setRawSettledIssue(null);
    setExpandedPaths(new Set());
    setPageByPath(new Map());
    setSwitchBlockedError(null);
    setDiscardConfirmOpen(false);
  }, []);

  const handleSwitchMode = useCallback(
    (targetMode: JsonCardMode) => {
      if (targetMode === mode) return;
      if (targetMode === 'raw') {
        if (gridCommitControlRef.current && !gridCommitControlRef.current.commitOrFlushPendingEdit()) {
          return;
        }
        const latestTable = composerHolderRef.current.candidateSource || tableSource;
        setRawDraftValue(normalizeEolToLf(latestTable));
        setRawEditedSinceSwitch(false);
        setRawSettledIssue(null);
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
        setRawSettledIssue(issue);
        setSwitchBlockedError(tJson('switchBlockedInvalidError'));
        return;
      }

      setTableSource(rawDraftValue);
      setRawEditedSinceSwitch(false);
      setRawSettledIssue(null);
      setSwitchBlockedError(null);
      setMode('table');
    },
    [composerHolderRef, mode, rawDraftValue, rawEditedSinceSwitch, tJson, tableSource],
  );

  const requestCancel = useCallback(() => {
    if (savingInFlight) return;
    if (!isDirty && unconfirmedCreate === null) {
      composerHolderRef.current.candidateSource = '';
      onCancel();
      return;
    }
    setDiscardConfirmOpen(true);
  }, [composerHolderRef, isDirty, onCancel, savingInFlight, unconfirmedCreate]);

  const executeCreate = useCallback(
    async (
      sealed: SealedNewEntryPayload,
      hadPriorUncertainSend: boolean,
      ownerId: number,
    ) => {
      setSavingInFlight(true);
      setSaveError(null);
      onAnnounce?.(tEntry('saving'));
      const capturedClearGeneration = captureUnconfirmedSaveClearGeneration();

      try {
        const { meta, applied } = await mutateSealedEntryCreate(
          queryClient,
          toEntryCreateVariables(sealed, {
            uncertainPriorSend: hadPriorUncertainSend,
          }),
        );

        if (saveOwnerIdRef.current !== ownerId) {
          return;
        }
        saveOwnerIdRef.current = 0;
        saveLockRef.current = false;
        setSavingInFlight(false);
        if (!applied || !sealed.isCurrent()) {
          return;
        }

        composerHolderRef.current.candidateSource = '';
        setUnconfirmedCreate(null);
        onAnnounce?.(tEntry('savedAnnounce'));
        onSaved(meta);
      } catch (err) {
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
              clearGeneration: capturedClearGeneration,
            });
          }
          if (saveOwnerIdRef.current === ownerId) {
            saveOwnerIdRef.current = 0;
            saveLockRef.current = false;
            setSavingInFlight(false);
          }
          composerHolderRef.current.candidateSource = '';
          setUnconfirmedCreate(null);
          onCancel();
          return;
        }

        if (saveOwnerIdRef.current !== ownerId) {
          return;
        }
        saveOwnerIdRef.current = 0;
        saveLockRef.current = false;
        setSavingInFlight(false);
        if (!sealed.isCurrent()) {
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
      composerHolderRef,
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
    if (mode === 'table' && gridCommitControlRef.current) {
      if (!gridCommitControlRef.current.commitOrFlushPendingEdit()) {
        return;
      }
    }
    if (isEmpty || isOverCap || !vault) return;

    const currentCandidate = composerHolderRef.current.candidateSource;
    if (mode === 'raw') {
      const issue = validateRawJsonText(currentCandidate);
      if (issue !== null) {
        setRawSettledIssue(issue);
        return;
      }
    }
    if (!parseJsonStrict(currentCandidate).ok) return;

    const capturedEpoch = lockEpochRef.current;
    const ownerId = ++nextSaveOwnerIdRef.current;
    saveOwnerIdRef.current = ownerId;
    saveLockRef.current = true;
    setSavingInFlight(true);
    setSaveError(null);

    try {
      // IP16-FE1-2 / advisor-dec-200: sealNewEntry reloads vaultMeta itself when null and invokes
      // getText() only AFTER any async reloadVaultMeta and op-token check, so no plaintext local is
      // held across an await.
      const sealed = await sealNewEntry({
        itemId,
        type: 'json',
        getText: () => {
          if (lockEpochRef.current !== capturedEpoch || saveOwnerIdRef.current !== ownerId) {
            return '';
          }
          const textFromHolder = composerHolderRef.current.candidateSource;
          if (measureUtf8Bytes(textFromHolder) === 0 || !parseJsonStrict(textFromHolder).ok) {
            return '';
          }
          return textFromHolder;
        },
        vault,
      });
      if (
        lockEpochRef.current !== capturedEpoch ||
        !sealed.isCurrent() ||
        saveOwnerIdRef.current !== ownerId
      ) {
        if (saveOwnerIdRef.current === ownerId) {
          saveOwnerIdRef.current = 0;
          saveLockRef.current = false;
          setSavingInFlight(false);
        }
        return;
      }
      await executeCreate(sealed, false, ownerId);
    } catch (err) {
      if (lockEpochRef.current !== capturedEpoch || saveOwnerIdRef.current !== ownerId) {
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
      const classified = classifyContentMutationError(err);
      const msg = translateContentError(classified.i18nKey);
      setSaveError(msg);
      onAnnounce?.(msg);
    }
  }, [
    composerHolderRef,
    executeCreate,
    isEmpty,
    isOverCap,
    itemId,
    mode,
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

  const handleComposerKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const keyLower = (e.key || '').toLowerCase();
    if (keyLower === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSaveNew();
    } else if (e.key === 'Escape' && mode === 'table') {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      e.stopPropagation();
      requestCancel();
    }
  };

  return (
    <article
      data-testid="new-json-entry-composer"
      onKeyDown={handleComposerKeyDown}
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
            className="btn btn-tertiary btn-sm px-2 py-0.5 text-[12px]"
            onClick={() => handleSelectPreset('empty-object')}
          >
            <span className="mono">{'{}'}</span> · {tJson('newJsonPresetEmptyObject')}
          </button>
          <button
            type="button"
            aria-pressed={preset === 'empty-array'}
            data-testid="new-json-preset-array"
            className="btn btn-tertiary btn-sm px-2 py-0.5 text-[12px]"
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
            commitControlRef={gridCommitControlRef}
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
              composerHolderRef.current.candidateSource = outcome.source;
              setTableSource(outcome.source);
              setRawDraftValue(normalizeEolToLf(outcome.source));
              setRawEditedSinceSwitch(false);
              setRawSettledIssue(null);
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
            onValidationSettled={setRawSettledIssue}
            onDraftChange={(nextVal: string) => {
              composerHolderRef.current.candidateSource = nextVal;
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

        {mode === 'table' || unconfirmedCreate !== null || saveError !== null || discardConfirmOpen ? (
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
                    onClick={() => {
                      composerHolderRef.current.candidateSource = '';
                      onCancel();
                    }}
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

            {mode === 'table' ? (
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
            ) : null}

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
                    onClick={() => {
                      composerHolderRef.current.candidateSource = '';
                      onCancel();
                    }}
                  >
                    {tEntry('discardChanges')}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
