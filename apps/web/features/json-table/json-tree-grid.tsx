'use client';

import { useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import {
  ENTRY_MAX_PLAINTEXT_BYTES,
  VAULT_SECRET_INPUT_PROPS,
} from '@/features/entries';
import {
  JSON_TABLE_PAGE_SIZE,
  buildRootTableView,
  changeCellType,
  insertField,
  insertRow,
  measureUtf8Bytes,
  removeField,
  removeRow,
  setValue,
  type JsonArrayOfArraysTableView,
  type JsonArrayOfObjectsColumnRowView,
  type JsonArrayOfObjectsTableView,
  type JsonCellValueKind,
  type JsonContainerCellView,
  type JsonDocument,
  type JsonEditOutcome,
  type JsonExtraFieldsView,
  type JsonFieldRowView,
  type JsonMissingCellView,
  type JsonNodeRef,
  type JsonObjectTableView,
  type JsonPrimitiveArrayTableView,
  type JsonPrimitiveCellView,
  type JsonRootPrimitiveTableView,
  type JsonTableCellView,
  type JsonTableView,
} from '@/lib/json';

const SUP_DIGITS = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹'];

export function toSuperscriptNumber(n: number): string {
  return String(n)
    .split('')
    .map((d) => SUP_DIGITS[d.charCodeAt(0) - 48] ?? d)
    .join('');
}

export function formatReadOnlyDisplayText(cell: JsonPrimitiveCellView): string {
  if (cell.readOnlyReason === 'lone_surrogate') {
    return cell.rawLexeme;
  }
  if (cell.readOnlyReason === 'carriage_return') {
    return cell.displayText.replace(/\r/g, '\\r');
  }
  return cell.displayText;
}

export interface ActiveCellEditState {
  readonly cellKey: string;
  readonly nodeRef: JsonNodeRef;
  readonly isKeyCell: boolean;
  readonly valueType: 'string' | 'number' | 'boolean' | 'null';
  readonly multiline: boolean;
  readonly initialText: string;
  readonly draftText: string;
  readonly error: string | null;
}

export interface ActiveAddFieldState {
  readonly containerPath: string;
  readonly containerRef: JsonNodeRef;
  readonly newKey: string;
  readonly newType: JsonCellValueKind;
  readonly error: string | null;
}

export interface JsonTreeGridCommitControlRef {
  commitOrFlushPendingEdit: () => boolean;
}

export interface JsonTreeGridProps {
  readonly entryId: string;
  readonly document: JsonDocument | null;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly expandedPaths: ReadonlySet<string>;
  readonly pageByPath: ReadonlyMap<string, number>;
  readonly onToggleExpand: (path: string) => void;
  readonly onPageChange: (path: string, nextPage: number) => void;
  readonly onApplyEdit: (outcome: JsonEditOutcome & { readonly ok: true }) => boolean;
  readonly resetEpoch?: number;
  readonly commitControlRef?: { current: JsonTreeGridCommitControlRef | null };
}

export function JsonTreeGrid({
  entryId,
  document: doc,
  readOnly = false,
  disabled = false,
  expandedPaths,
  pageByPath,
  onToggleExpand,
  onPageChange,
  onApplyEdit,
  resetEpoch = 0,
  commitControlRef,
}: JsonTreeGridProps) {
  const tJson = useTranslations('content.json');

  const hostRef = useRef<HTMLDivElement | null>(null);
  const editInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const addFieldInputRef = useRef<HTMLInputElement | null>(null);
  const skipBlurCommitRef = useRef<boolean>(false);
  const pendingFocusKeyRef = useRef<string | null>(null);
  const [activeCellEdit, setActiveCellEdit] = useState<ActiveCellEditState | null>(null);
  const [activeAddField, setActiveAddField] = useState<ActiveAddFieldState | null>(null);

  // Clear any active inline editor or add-field form when resetEpoch bumps (e.g., on vault lock)
  useEffect(() => {
    if (editInputRef.current) {
      editInputRef.current.value = '';
    }
    if (addFieldInputRef.current) {
      addFieldInputRef.current.value = '';
    }
    setActiveCellEdit(null);
    setActiveAddField(null);
    pendingFocusKeyRef.current = null;
  }, [resetEpoch]);

  const activeCellEditKey = activeCellEdit?.cellKey ?? null;
  const activeAddFieldPath = activeAddField?.containerPath ?? null;

  // Focus the cell edit input when it opens
  useEffect(() => {
    if (activeCellEditKey && editInputRef.current) {
      editInputRef.current.focus();
      if ('select' in editInputRef.current && typeof editInputRef.current.select === 'function') {
        editInputRef.current.select();
      }
    }
  }, [activeCellEditKey]);

  // Focus the add-field input when it opens
  useEffect(() => {
    if (activeAddFieldPath && addFieldInputRef.current) {
      addFieldInputRef.current.focus();
    }
  }, [activeAddFieldPath]);

  // Restore focus after commit / cancel / expand / page change without depending on CSS.escape (IP16-FE1-1)
  useEffect(() => {
    const key = pendingFocusKeyRef.current;
    if (!key || !hostRef.current) return;
    pendingFocusKeyRef.current = null;
    const candidates = hostRef.current.querySelectorAll<HTMLElement>('[data-json-focus-key]');
    let target: HTMLElement | null = null;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i]!;
      if (el.getAttribute('data-json-focus-key') === key) {
        target = el;
        break;
      }
    }
    if (target && !target.hasAttribute('disabled')) {
      target.focus();
    }
  });
  const translateEditError = useCallback(
    (code: string): string => {
      switch (code) {
        case 'KEY_EXISTS':
          return tJson('editErrorKeyExists');
        case 'INVALID_NUMBER_LEXEME':
          return tJson('editErrorInvalidNumber');
        case 'INVALID_BOOLEAN_LEXEME':
          return tJson('editErrorInvalidBoolean');
        case 'INVALID_NULL_LEXEME':
          return tJson('editErrorInvalidNull');
        case 'READ_ONLY_CELL':
          return tJson('editErrorReadOnly');
        case 'INVALID_STRING_VALUE':
          return tJson('editErrorInvalidUnicode');
        default:
          return tJson('editErrorInvalidNumber');
      }
    },
    [tJson],
  );

  const rootPage = pageByPath.get('root') ?? 1;
  const rootView = useMemo(() => {
    if (!doc) return null;
    return buildRootTableView(doc, { page: rootPage, pageSize: JSON_TABLE_PAGE_SIZE });
  }, [doc, rootPage]);

  // Track whether ANY rendered view (root or expanded children) has read-only cells
  let renderedHasReadOnlyCells = false;
  const readOnlyNoteId = `json-ro-note-${entryId}`;

  const commitActiveCellEdit = useCallback(
    (editState: ActiveCellEditState, focusAfterKey?: string | null): boolean => {
      if (!doc) return false;
      const outcome = setValue(doc, editState.nodeRef, editState.draftText);
      if (!outcome.ok) {
        setActiveCellEdit({
          ...editState,
          error: translateEditError(outcome.error.code),
        });
        if (focusAfterKey === editState.cellKey) {
          queueMicrotask(() => {
            editInputRef.current?.focus();
          });
        }
        return false;
      }
      if (!outcome.changed) {
        // Rule 2: No-op commit produces no splice (preserves original escapes like \u00e9 or \/)
        if (editInputRef.current) {
          editInputRef.current.value = '';
        }
        setActiveCellEdit(null);
        if (focusAfterKey !== undefined) {
          pendingFocusKeyRef.current = focusAfterKey;
        }
        return true;
      }

      const byteLen = measureUtf8Bytes(outcome.source);
      if (byteLen > ENTRY_MAX_PLAINTEXT_BYTES) {
        setActiveCellEdit({
          ...editState,
          error: tJson('editErrorOverCap'),
        });
        if (focusAfterKey === editState.cellKey) {
          queueMicrotask(() => {
            editInputRef.current?.focus();
          });
        }
        return false;
      }

      const applied = onApplyEdit(outcome);
      if (!applied) {
        setActiveCellEdit({
          ...editState,
          error: tJson('editErrorOverCap'),
        });
        return false;
      }

      if (editInputRef.current) {
        editInputRef.current.value = '';
      }
      setActiveCellEdit(null);
      if (focusAfterKey !== undefined) {
        pendingFocusKeyRef.current = focusAfterKey;
      }
      return true;
    },
    [doc, onApplyEdit, tJson, translateEditError],
  );

  useEffect(() => {
    if (!commitControlRef) return;
    commitControlRef.current = {
      commitOrFlushPendingEdit: () => {
        if (!activeCellEdit) return true;
        return commitActiveCellEdit(activeCellEdit, activeCellEdit.cellKey);
      },
    };
    return () => {
      commitControlRef.current = null;
    };
  }, [activeCellEdit, commitActiveCellEdit, commitControlRef]);
  const handleCancelCellEdit = useCallback((cellKey: string) => {
    skipBlurCommitRef.current = true;
    if (editInputRef.current) {
      editInputRef.current.value = '';
    }
    setActiveCellEdit(null);
    pendingFocusKeyRef.current = cellKey;
    queueMicrotask(() => {
      skipBlurCommitRef.current = false;
    });
  }, []);

  const handleOpenCellEdit = useCallback(
    (
      cellKey: string,
      cell: JsonPrimitiveCellView,
      isKeyCell: boolean,
    ) => {
      if (readOnly || disabled || cell.readOnly) return;
      if (activeCellEdit && activeCellEdit.cellKey !== cellKey) {
        const ok = commitActiveCellEdit(activeCellEdit, null);
        if (!ok) return;
      }
      setActiveCellEdit({
        cellKey,
        nodeRef: cell.nodeRef,
        isKeyCell,
        valueType: cell.valueType,
        multiline: cell.multiline,
        initialText: cell.displayText,
        draftText: cell.displayText,
        error: null,
      });
    },
    [activeCellEdit, commitActiveCellEdit, disabled, readOnly],
  );

  const handleChangeCellType = useCallback(
    (editState: ActiveCellEditState, targetType: JsonCellValueKind) => {
      if (!doc) return;
      skipBlurCommitRef.current = true;

      // If user typed something into the input before switching to string or number, let edit.ts handle or apply changeCellType
      const outcome = changeCellType(doc, editState.nodeRef, targetType);
      queueMicrotask(() => {
        skipBlurCommitRef.current = false;
      });

      if (!outcome.ok) {
        setActiveCellEdit({
          ...editState,
          error: translateEditError(outcome.error.code),
        });
        return;
      }

      if (!outcome.changed) {
        return;
      }

      const byteLen = measureUtf8Bytes(outcome.source);
      if (byteLen > ENTRY_MAX_PLAINTEXT_BYTES) {
        setActiveCellEdit({
          ...editState,
          error: tJson('editErrorOverCap'),
        });
        return;
      }

      const applied = onApplyEdit(outcome);
      if (applied) {
        if (editInputRef.current) {
          editInputRef.current.value = '';
        }
        setActiveCellEdit(null);
        pendingFocusKeyRef.current = editState.cellKey;
      }
    },
    [doc, onApplyEdit, tJson, translateEditError],
  );

  const handleInitMissingCell = useCallback(
    (missingCell: JsonMissingCellView, focusKey: string) => {
      if (!doc || readOnly || disabled) return;
      if (activeCellEdit) {
        const ok = commitActiveCellEdit(activeCellEdit, null);
        if (!ok) return;
      }
      const outcome = insertField(doc, missingCell.rowObjectRef, missingCell.columnKey, {
        initialValueLexeme: '""',
      });
      if (!outcome.ok) return;
      if (measureUtf8Bytes(outcome.source) > ENTRY_MAX_PLAINTEXT_BYTES) return;
      if (onApplyEdit(outcome)) {
        pendingFocusKeyRef.current = focusKey;
      }
    },
    [activeCellEdit, commitActiveCellEdit, disabled, doc, onApplyEdit, readOnly],
  );

  const handleConfirmAddField = useCallback(
    (formState: ActiveAddFieldState) => {
      if (!doc) return;
      const trimmedKey = formState.newKey.trim();
      if (trimmedKey.length === 0) {
        setActiveAddField({
          ...formState,
          error: tJson('addFieldEmptyKeyError'),
        });
        addFieldInputRef.current?.focus();
        return;
      }

      const initialValueLexeme =
        formState.newType === 'string'
          ? '""'
          : formState.newType === 'number'
            ? '0'
            : formState.newType === 'true'
              ? 'true'
              : formState.newType === 'false'
                ? 'false'
                : 'null';

      const outcome = insertField(doc, formState.containerRef, trimmedKey, {
        initialValueLexeme,
      });

      if (!outcome.ok) {
        setActiveAddField({
          ...formState,
          error: translateEditError(outcome.error.code),
        });
        addFieldInputRef.current?.focus();
        return;
      }

      if (measureUtf8Bytes(outcome.source) > ENTRY_MAX_PLAINTEXT_BYTES) {
        setActiveAddField({
          ...formState,
          error: tJson('editErrorOverCap'),
        });
        addFieldInputRef.current?.focus();
        return;
      }

      if (onApplyEdit(outcome)) {
        if (addFieldInputRef.current) {
          addFieldInputRef.current.value = '';
        }
        setActiveAddField(null);
        pendingFocusKeyRef.current = `${formState.containerPath}:open-add-field`;
      }
    },
    [doc, onApplyEdit, tJson, translateEditError],
  );

  const handleRemoveField = useCallback(
    (containerPath: string, row: JsonFieldRowView, totalRows: number) => {
      if (!doc || readOnly || disabled) return;
      if (activeCellEdit) {
        setActiveCellEdit(null);
      }
      const outcome = removeField(doc, row.propertyRef);
      if (!outcome.ok) return;
      if (onApplyEdit(outcome)) {
        const nextRowIdx = Math.max(0, Math.min(row.propertyIndex, totalRows - 2));
        pendingFocusKeyRef.current =
          totalRows > 1
            ? `${containerPath}:remove-field:${nextRowIdx}`
            : `${containerPath}:open-add-field`;
      }
    },
    [activeCellEdit, disabled, doc, onApplyEdit, readOnly],
  );

  const handleAddRow = useCallback(
    (containerPath: string, containerRef: JsonNodeRef) => {
      if (!doc || readOnly || disabled) return;
      if (activeCellEdit) {
        const ok = commitActiveCellEdit(activeCellEdit, null);
        if (!ok) return;
      }
      const outcome = insertRow(doc, containerRef);
      if (!outcome.ok) return;
      if (measureUtf8Bytes(outcome.source) > ENTRY_MAX_PLAINTEXT_BYTES) return;
      if (onApplyEdit(outcome)) {
        pendingFocusKeyRef.current = `${containerPath}:add-row`;
      }
    },
    [activeCellEdit, commitActiveCellEdit, disabled, doc, onApplyEdit, readOnly],
  );

  const handleRemoveRow = useCallback(
    (containerPath: string, containerRef: JsonNodeRef, rowIndex: number, totalRows: number) => {
      if (!doc || readOnly || disabled) return;
      if (activeCellEdit) {
        setActiveCellEdit(null);
      }
      const outcome = removeRow(doc, containerRef, rowIndex);
      if (!outcome.ok) return;
      if (onApplyEdit(outcome)) {
        const nextRowIdx = Math.max(0, Math.min(rowIndex, totalRows - 2));
        pendingFocusKeyRef.current =
          totalRows > 1
            ? `${containerPath}:remove-row:${nextRowIdx}`
            : `${containerPath}:add-row`;
      }
    },
    [activeCellEdit, disabled, doc, onApplyEdit, readOnly],
  );

  // Keyboard arrow navigation between interactive grid cells (Task 16 item 6, IP16-FE1-16)
  const handleHostKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (!target || !hostRef.current) return;

      // Do not intercept arrow keys while typing inside an input/textarea/select
      const tag = target.tagName.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }

      if (
        e.key !== 'ArrowRight' &&
        e.key !== 'ArrowLeft' &&
        e.key !== 'ArrowDown' &&
        e.key !== 'ArrowUp'
      ) {
        return;
      }

      const navElements = Array.from(
        hostRef.current.querySelectorAll<HTMLElement>('[data-json-grid-nav]:not(:disabled)'),
      );
      const currentIdx = navElements.indexOf(target);
      if (currentIdx === -1) return;

      e.preventDefault();
      if (e.key === 'ArrowRight') {
        const next = navElements[Math.min(navElements.length - 1, currentIdx + 1)];
        next?.focus();
        return;
      }
      if (e.key === 'ArrowLeft') {
        const prev = navElements[Math.max(0, currentIdx - 1)];
        prev?.focus();
        return;
      }

      // ArrowDown / ArrowUp: prefer the cell at the same column in the next/previous row of the same table
      const currentCell = target.closest('td');
      const currentRow = target.closest('tr');
      const currentTable = currentRow?.closest('table');
      if (currentCell && currentRow && currentTable) {
        const rowCells = Array.from(currentRow.children);
        const colIdx = rowCells.indexOf(currentCell);
        const tbody = currentRow.parentElement;
        if (tbody && colIdx !== -1) {
          const rows = Array.from(tbody.children).filter(
            (el): el is HTMLTableRowElement => el.tagName.toUpperCase() === 'TR',
          );
          const rowIdx = rows.indexOf(currentRow);
          const candidateRow =
            e.key === 'ArrowDown' ? rows[rowIdx + 1] : rows[rowIdx - 1];
          if (candidateRow) {
            const candidateTd = candidateRow.children[colIdx] as HTMLElement | undefined;
            const candidateNav = candidateTd?.querySelector<HTMLElement>(
              '[data-json-grid-nav]:not(:disabled)',
            );
            if (candidateNav) {
              candidateNav.focus();
              return;
            }
          }
        }
      }

      if (e.key === 'ArrowDown') {
        const next = navElements[Math.min(navElements.length - 1, currentIdx + 1)];
        next?.focus();
      } else {
        const prev = navElements[Math.max(0, currentIdx - 1)];
        prev?.focus();
      }
    },
    [],
  );

  const renderPrimitiveCell = (
    cell: JsonPrimitiveCellView,
    cellKey: string,
    opts: {
      readonly rowNum: number;
      readonly colNum: number;
      readonly isKeyCell?: boolean;
    },
  ) => {
    const posLabel = tJson('posCellAria', { row: opts.rowNum, col: opts.colNum });
    const isKeyCell = opts.isKeyCell === true;

    if (cell.readOnly) {
      renderedHasReadOnlyCells = true;
      const safeText = formatReadOnlyDisplayText(cell);
      return (
        <span
          tabIndex={0}
          role="textbox"
          aria-readonly="true"
          aria-label={posLabel}
          aria-describedby={readOnlyNoteId}
          data-testid={`json-readonly-cell-${cellKey}`}
          data-json-focus-key={cellKey}
          data-json-grid-nav=""
          className="json-cell-readonly inline-block rounded px-1.5 py-0.5 opacity-75"
        >
          {safeText}
        </span>
      );
    }

    if (!readOnly && !disabled && activeCellEdit?.cellKey === cellKey) {
      const handleEditorBlur = (e: FocusEvent<HTMLDivElement>) => {
        if (skipBlurCommitRef.current) return;
        const related = e.relatedTarget as Node | null;
        if (related && e.currentTarget.contains(related)) {
          return;
        }
        const nextFocusKey =
          related instanceof HTMLElement
            ? (related.getAttribute('data-json-focus-key') ?? null)
            : null;
        commitActiveCellEdit(activeCellEdit, nextFocusKey);
      };

      const handleInputKeyDown = (
        e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          handleCancelCellEdit(cellKey);
        } else if (e.key === 'Enter') {
          if (activeCellEdit.multiline && e.shiftKey) {
            // Shift+Enter inserts a newline in multiline string cells (plan §2.10 rule 6)
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          commitActiveCellEdit(activeCellEdit, cellKey);
        }
      };

      const currentSelectType: JsonCellValueKind =
        activeCellEdit.valueType === 'boolean'
          ? activeCellEdit.draftText === 'false'
            ? 'false'
            : 'true'
          : activeCellEdit.valueType;

      return (
        <div
          data-testid={`json-active-editor-${cellKey}`}
          data-json-active-editor={cellKey}
          className="json-cell-edit-wrap"
          onBlur={handleEditorBlur}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {activeCellEdit.multiline ? (
              <textarea
                ref={(el) => {
                  editInputRef.current = el;
                }}
                rows={2}
                value={activeCellEdit.draftText}
                aria-label={posLabel}
                aria-invalid={activeCellEdit.error ? 'true' : undefined}
                data-testid={`json-cell-input-${cellKey}`}
                data-json-edit-input={cellKey}
                className="field-input json-cell-input px-2 py-1 text-[13px]"
                {...VAULT_SECRET_INPUT_PROPS}
                onChange={(e) =>
                  setActiveCellEdit((prev) =>
                    prev && prev.cellKey === cellKey
                      ? { ...prev, draftText: e.target.value, error: null }
                      : prev,
                  )
                }
                onKeyDown={handleInputKeyDown}
              />
            ) : (
              <input
                ref={(el) => {
                  editInputRef.current = el;
                }}
                type="text"
                value={activeCellEdit.draftText}
                aria-label={posLabel}
                aria-invalid={activeCellEdit.error ? 'true' : undefined}
                data-testid={`json-cell-input-${cellKey}`}
                data-json-edit-input={cellKey}
                className="field-input json-cell-input px-2 py-1 text-[13px]"
                {...VAULT_SECRET_INPUT_PROPS}
                onChange={(e) =>
                  setActiveCellEdit((prev) =>
                    prev && prev.cellKey === cellKey
                      ? { ...prev, draftText: e.target.value, error: null }
                      : prev,
                  )
                }
                onKeyDown={handleInputKeyDown}
              />
            )}

            {!isKeyCell ? (
              <label className="inline-flex items-center gap-1 text-[12px] text-muted">
                <span>{tJson('typeLabel')}</span>
                <select
                  value={currentSelectType}
                  aria-label={tJson('typeSelectAria')}
                  data-testid={`json-type-select-${cellKey}`}
                  data-json-type-select={cellKey}
                  className="json-type-btn rounded border border-line bg-surface px-1.5 py-0.5 text-[12px]"
                  onMouseDown={() => {
                    skipBlurCommitRef.current = true;
                    window.setTimeout(() => {
                      skipBlurCommitRef.current = false;
                    }, 0);
                  }}
                  onChange={(e) => {
                    handleChangeCellType(
                      activeCellEdit,
                      e.target.value as JsonCellValueKind,
                    );
                  }}
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                  <option value="null">null</option>
                </select>
              </label>
            ) : null}

            <button
              type="button"
              data-testid={`json-commit-cell-${cellKey}`}
              className="btn btn-primary btn-sm"
              onMouseDown={() => {
                skipBlurCommitRef.current = true;
                window.setTimeout(() => {
                  skipBlurCommitRef.current = false;
                }, 0);
              }}
              onClick={() => {
                commitActiveCellEdit(activeCellEdit, cellKey);
              }}
            >
              {tJson('cellCommitBtn')}
            </button>
            <button
              type="button"
              data-testid={`json-cancel-cell-${cellKey}`}
              className="btn btn-tertiary btn-sm"
              onMouseDown={() => {
                skipBlurCommitRef.current = true;
                window.setTimeout(() => {
                  skipBlurCommitRef.current = false;
                }, 0);
              }}
              onClick={() => {
                handleCancelCellEdit(cellKey);
              }}
            >
              {tJson('cellCancelBtn')}
            </button>
          </div>

          {activeCellEdit.error ? (
            <p
              role="alert"
              data-testid={`json-cell-error-${cellKey}`}
              className="field-error mb-0 mt-1 text-[12px]"
            >
              {activeCellEdit.error}
            </p>
          ) : null}
        </div>
      );
    }

    const valueNode =
      cell.valueType === 'number' ? (
        <span className="v-num">{cell.displayText}</span>
      ) : cell.valueType === 'boolean' ? (
        <span className="v-bool">{cell.displayText}</span>
      ) : cell.valueType === 'null' ? (
        <span className="v-null">null</span>
      ) : (
        <span className="whitespace-pre-wrap break-words">{cell.displayText}</span>
      );

    if (readOnly) {
      return valueNode;
    }

    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={posLabel}
        title={tJson('editCellTitle')}
        data-testid={`json-cell-btn-${cellKey}`}
        data-json-focus-key={cellKey}
        data-json-grid-nav=""
        className="json-cell-btn rounded border border-transparent bg-transparent px-1.5 py-0.5 text-left"
        onClick={() => handleOpenCellEdit(cellKey, cell, isKeyCell)}
      >
        {valueNode}
      </button>
    );
  };

  const renderContainerToggleAndChild = (
    cell: JsonContainerCellView,
    containerPath: string,
    level: number,
    customLabel?: string,
  ) => {
    const isExpanded = expandedPaths.has(containerPath);
    const labelText =
      customLabel ??
      (cell.containerKind === 'array'
        ? tJson('arraySummary', { count: cell.childCount })
        : tJson('objectSummary', { count: cell.childCount }));

    // Lazy chevron: child table view and DOM are ONLY built when isExpanded is true (Task 16 item 2)
    const childPage = pageByPath.get(containerPath) ?? 1;
    const childView = isExpanded
      ? cell.expand({ page: childPage, pageSize: JSON_TABLE_PAGE_SIZE })
      : null;

    return (
      <div>
        <button
          type="button"
          aria-expanded={isExpanded}
          data-testid={`json-toggle-${containerPath}`}
          data-json-focus-key={`toggle:${containerPath}`}
          data-json-grid-nav=""
          className="json-toggle"
          onClick={() => {
            pendingFocusKeyRef.current = `toggle:${containerPath}`;
            onToggleExpand(containerPath);
          }}
        >
          <span className="caret" aria-hidden="true">
            ›
          </span>
          <span>{labelText}</span>
        </button>
        {isExpanded && childView ? (
          <div className="json-nest" data-testid={`json-nest-${containerPath}`}>
            {renderTableView(childView, containerPath, level + 1)}
          </div>
        ) : null}
      </div>
    );
  };

  const renderExtraFieldsCell = (
    extraFields: JsonExtraFieldsView,
    extraPath: string,
    level: number,
  ) => {
    const isExpanded = expandedPaths.has(extraPath);
    const childPage = pageByPath.get(extraPath) ?? 1;
    const extraView = isExpanded
      ? extraFields.expand({ page: childPage, pageSize: JSON_TABLE_PAGE_SIZE })
      : null;

    return (
      <div>
        <button
          type="button"
          aria-expanded={isExpanded}
          data-testid={`json-extra-toggle-${extraPath}`}
          data-json-focus-key={`toggle:${extraPath}`}
          data-json-grid-nav=""
          className="json-toggle"
          onClick={() => {
            pendingFocusKeyRef.current = `toggle:${extraPath}`;
            onToggleExpand(extraPath);
          }}
        >
          <span className="caret" aria-hidden="true">
            ›
          </span>
          <span>{tJson('extraFieldsToggle', { count: extraFields.count })}</span>
        </button>
        {isExpanded && extraView ? (
          <div className="json-nest" data-testid={`json-extra-nest-${extraPath}`}>
            {renderObjectTable(extraView, extraPath, level + 1, { hideToolbar: true })}
          </div>
        ) : null}
      </div>
    );
  };

  const renderPaginationBar = (
    containerPath: string,
    totalRows: number,
    page: number,
    totalPages: number,
  ) => {
    if (totalRows <= JSON_TABLE_PAGE_SIZE) return null;
    const startRow = (page - 1) * JSON_TABLE_PAGE_SIZE + 1;
    const endRow = Math.min(totalRows, page * JSON_TABLE_PAGE_SIZE);

    return (
      <div
        data-testid={`json-pagination-${containerPath}`}
        data-json-pagination={containerPath}
        className="json-page-bar"
      >
        <span>
          {tJson('paginationSummary', {
            start: startRow,
            end: endRow,
            total: totalRows,
          })}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={page <= 1}
            data-testid={`json-page-prev-${containerPath}`}
            data-json-focus-key={`${containerPath}:page-prev`}
            className="btn btn-tertiary btn-sm"
            onClick={() => {
              pendingFocusKeyRef.current = `${containerPath}:page-prev`;
              onPageChange(containerPath, Math.max(1, page - 1));
            }}
          >
            {tJson('pagePrev')}
          </button>
          <span
            className="mono"
            data-testid={`json-page-indicator-${containerPath}`}
          >
            {tJson('pageIndicator', { page, totalPages })}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            data-testid={`json-page-next-${containerPath}`}
            data-json-focus-key={`${containerPath}:page-next`}
            className="btn btn-tertiary btn-sm"
            onClick={() => {
              pendingFocusKeyRef.current = `${containerPath}:page-next`;
              onPageChange(containerPath, Math.min(totalPages, page + 1));
            }}
          >
            {tJson('pageNext')}
          </button>
        </div>
      </div>
    );
  };

  const renderObjectToolbar = (containerPath: string, containerRef: JsonNodeRef) => {
    if (readOnly || disabled) return null;

    if (activeAddField?.containerPath === containerPath) {
      return (
        <div
          data-testid={`json-add-field-form-${containerPath}`}
          className="json-table-toolbar"
        >
          <input
            ref={addFieldInputRef}
            type="text"
            value={activeAddField.newKey}
            placeholder={tJson('addFieldKeyPlaceholder')}
            aria-label={tJson('addFieldKeyPlaceholder')}
            aria-invalid={activeAddField.error ? 'true' : undefined}
            data-testid={`json-new-key-input-${containerPath}`}
            className="field-input json-cell-input shrink-0 px-2 py-1 text-[13px]"
            {...VAULT_SECRET_INPUT_PROPS}
            onChange={(e) =>
              setActiveAddField((prev) =>
                prev && prev.containerPath === containerPath
                  ? { ...prev, newKey: e.target.value, error: null }
                  : prev,
              )
            }
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (addFieldInputRef.current) {
                  addFieldInputRef.current.value = '';
                }
                setActiveAddField(null);
                pendingFocusKeyRef.current = `${containerPath}:open-add-field`;
              } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                handleConfirmAddField(activeAddField);
              }
            }}
          />
          <select
            value={activeAddField.newType}
            aria-label={tJson('addFieldTypeAria')}
            data-testid={`json-new-type-select-${containerPath}`}
            className="json-type-btn rounded border border-line bg-surface px-1.5 py-1 text-[12px]"
            onChange={(e) =>
              setActiveAddField((prev) =>
                prev && prev.containerPath === containerPath
                  ? { ...prev, newType: e.target.value as JsonCellValueKind }
                  : prev,
              )
            }
          >
            <option value="string">string (&quot;&quot;)</option>
            <option value="number">number (0)</option>
            <option value="true">true</option>
            <option value="false">false</option>
            <option value="null">null</option>
          </select>
          <button
            type="button"
            data-testid={`json-confirm-add-field-${containerPath}`}
            className="btn btn-primary btn-sm"
            onClick={() => handleConfirmAddField(activeAddField)}
          >
            {tJson('addFieldConfirmBtn')}
          </button>
          <button
            type="button"
            data-testid={`json-cancel-add-field-${containerPath}`}
            className="btn btn-tertiary btn-sm"
            onClick={() => {
              if (addFieldInputRef.current) {
                addFieldInputRef.current.value = '';
              }
              setActiveAddField(null);
              pendingFocusKeyRef.current = `${containerPath}:open-add-field`;
            }}
          >
            {tJson('addFieldCancelBtn')}
          </button>
          {activeAddField.error ? (
            <span
              role="alert"
              data-testid={`json-add-field-error-${containerPath}`}
              className="text-[12px] font-medium text-error-ink"
            >
              {activeAddField.error}
            </span>
          ) : null}
        </div>
      );
    }

    return (
      <div className="json-table-toolbar">
        <button
          type="button"
          data-testid={`json-open-add-field-${containerPath}`}
          data-json-focus-key={`${containerPath}:open-add-field`}
          className="btn btn-tertiary btn-sm"
          onClick={() => {
            if (activeCellEdit) {
              const ok = commitActiveCellEdit(activeCellEdit, null);
              if (!ok) return;
            }
            setActiveAddField({
              containerPath,
              containerRef,
              newKey: '',
              newType: 'null',
              error: null,
            });
          }}
        >
          {tJson('addFieldBtn')}
        </button>
      </div>
    );
  };

  const renderArrayToolbar = (containerPath: string, containerRef: JsonNodeRef) => {
    if (readOnly || disabled) return null;
    return (
      <div className="json-table-toolbar">
        <button
          type="button"
          data-testid={`json-add-row-${containerPath}`}
          data-json-focus-key={`${containerPath}:add-row`}
          className="btn btn-tertiary btn-sm"
          onClick={() => handleAddRow(containerPath, containerRef)}
        >
          {tJson('addRowBtn')}
        </button>
      </div>
    );
  };

  const renderObjectTable = (
    view: JsonObjectTableView,
    containerPath: string,
    level: number,
    opts?: { readonly hideToolbar?: boolean },
  ) => {
    if (view.hasReadOnlyCells) {
      renderedHasReadOnlyCells = true;
    }

    const isRootLevel = level === 1;
    const tableRoleProps = isRootLevel
      ? ({ role: 'treegrid', 'aria-label': tJson('treegridAria') } as const)
      : ({ role: 'treegrid' } as const);

    if (view.totalRows === 0) {
      return (
        <div>
          <table className="json-table" {...tableRoleProps}>
            <tbody role="presentation">
              <tr role="row" aria-level={level}>
                <td role="gridcell" className="mono p-3 text-[13px] text-muted">
                  {tJson('emptyObject')}
                </td>
              </tr>
            </tbody>
          </table>
          {!opts?.hideToolbar
            ? renderObjectToolbar(containerPath, view.containerRef)
            : null}
        </div>
      );
    }

    return (
      <div>
        <table className="json-table" {...tableRoleProps}>
          <thead role="presentation">
            <tr role="row">
              <th role="columnheader">{tJson('colField')}</th>
              <th role="columnheader">{tJson('colValue')}</th>
              {!readOnly && !disabled && !opts?.hideToolbar ? (
                <th
                  role="columnheader"
                  className="json-col-idx"
                  aria-label={tJson('colActions')}
                />
              ) : null}
            </tr>
          </thead>
          <tbody role="presentation">
            {view.rows.map((row) => {
              const rowNum = row.propertyIndex + 1;
              const keyCellKey = `${containerPath}.k${row.propertyIndex}`;
              const valCellKey = `${containerPath}.p${row.propertyIndex}`;
              const isContainerValue = row.valueCell.kind === 'container';
              const isRowExpanded = isContainerValue
                ? expandedPaths.has(valCellKey)
                : undefined;

              return (
                <tr
                  key={row.propertyId}
                  role="row"
                  aria-level={level}
                  aria-expanded={isRowExpanded}
                  aria-label={tJson('posRowAria', { row: rowNum })}
                >
                  <td role="gridcell" className="k">
                    {renderPrimitiveCell(row.keyCell, keyCellKey, {
                      rowNum,
                      colNum: 1,
                      isKeyCell: true,
                    })}
                    {row.isDuplicateKey ? (
                      <span
                        className="k-occ ml-1"
                        data-testid={`json-dup-occ-${keyCellKey}`}
                      >
                        <span className="sr-only">
                          {tJson('occurrenceAria', {
                            occ: row.occurrenceIndex + 1,
                          })}
                        </span>
                        <span aria-hidden="true">
                          {`(#${row.occurrenceIndex + 1}) ⁽${toSuperscriptNumber(
                            row.occurrenceIndex + 1,
                          )}⁾`}
                        </span>
                      </span>
                    ) : null}
                  </td>
                  <td role="gridcell">
                    {row.valueCell.kind === 'container'
                      ? renderContainerToggleAndChild(
                          row.valueCell,
                          valCellKey,
                          level,
                        )
                      : renderPrimitiveCell(row.valueCell, valCellKey, {
                          rowNum,
                          colNum: 2,
                        })}
                  </td>
                  {!readOnly && !disabled && !opts?.hideToolbar ? (
                    <td
                      role="gridcell"
                      className="json-col-act json-col-idx text-right"
                    >
                      <button
                        type="button"
                        aria-label={tJson('removeRowAria', { row: rowNum })}
                        title={tJson('removeRowTitle')}
                        data-testid={`json-remove-field-${containerPath}-${row.propertyIndex}`}
                        data-json-focus-key={`${containerPath}:remove-field:${row.propertyIndex}`}
                        className="btn btn-tertiary btn-sm px-2 py-0.5 text-muted"
                        onClick={() =>
                          handleRemoveField(containerPath, row, view.totalRows)
                        }
                      >
                        ×
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {renderPaginationBar(
          containerPath,
          view.totalRows,
          view.page,
          view.totalPages,
        )}
        {!opts?.hideToolbar
          ? renderObjectToolbar(containerPath, view.containerRef)
          : null}
      </div>
    );
  };

  const renderArrayOfObjectsTable = (
    view: JsonArrayOfObjectsTableView,
    containerPath: string,
    level: number,
  ) => {
    if (view.hasReadOnlyCells) {
      renderedHasReadOnlyCells = true;
    }

    const isRootLevel = level === 1;
    const tableRoleProps = isRootLevel
      ? ({ role: 'treegrid', 'aria-label': tJson('treegridAria') } as const)
      : ({ role: 'treegrid' } as const);

    const overflowColCount = Math.max(0, view.totalDistinctKeys - view.columns.length);

    return (
      <div>
        <table className="json-table" {...tableRoleProps}>
          <thead role="presentation">
            <tr role="row">
              <th role="columnheader" className="json-col-idx">
                {tJson('colIndex')}
              </th>
              {view.columns.map((colKey, colIdx) => (
                <th
                  key={`col-${colIdx}`}
                  role="columnheader"
                  data-testid={`json-col-header-${containerPath}-${colIdx}`}
                >
                  {colKey}
                </th>
              ))}
              {view.hasExtraFieldsColumn ? (
                <th
                  role="columnheader"
                  data-testid={`json-extra-col-header-${containerPath}`}
                >
                  {tJson('colExtraFields', { count: Math.max(1, overflowColCount) })}
                </th>
              ) : null}
              {!readOnly && !disabled ? (
                <th
                  role="columnheader"
                  className="json-col-idx"
                  aria-label={tJson('colActions')}
                />
              ) : null}
            </tr>
          </thead>
          <tbody role="presentation">
            {view.rows.map((row) => {
              const rowNum = row.rowIndex + 1;
              const rowPath = `${containerPath}.e${row.rowIndex}`;

              if (row.kind === 'duplicate-fallback') {
                const colSpan = Math.max(
                  1,
                  view.columns.length + (view.hasExtraFieldsColumn ? 1 : 0),
                );
                return (
                  <tr
                    key={`row-${row.rowIndex}`}
                    role="row"
                    aria-level={level}
                    aria-expanded={true}
                    aria-label={tJson('posRowAria', { row: rowNum })}
                  >
                    <td role="gridcell" className="k">
                      {rowNum}
                    </td>
                    <td role="gridcell" colSpan={colSpan}>
                      <div className="json-dup-row-note mb-1.5 text-[12px] text-muted">
                        <span className="badge-type badge-warn mr-1.5">
                          {tJson('duplicateRowBadge')}
                        </span>
                        <span>{tJson('duplicateRowNote', { row: rowNum })}</span>
                      </div>
                      <div className="json-nest">
                        {renderObjectTable(
                          row.fallbackTable,
                          rowPath,
                          level + 1,
                        )}
                      </div>
                    </td>
                    {!readOnly && !disabled ? (
                      <td
                        role="gridcell"
                        className="json-col-act json-col-idx text-right"
                      >
                        <button
                          type="button"
                          aria-label={tJson('removeRowAria', { row: rowNum })}
                          title={tJson('removeRowTitle')}
                          data-testid={`json-remove-row-${containerPath}-${row.rowIndex}`}
                          data-json-focus-key={`${containerPath}:remove-row:${row.rowIndex}`}
                          className="btn btn-tertiary btn-sm px-2 py-0.5 text-muted"
                          onClick={() =>
                            handleRemoveRow(
                              containerPath,
                              view.containerRef,
                              row.rowIndex,
                              view.totalRows,
                            )
                          }
                        >
                          ×
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
              }

              // Standard columns row
              const colRow: JsonArrayOfObjectsColumnRowView = row;
              let rowHasContainer = false;
              let rowAnyExpanded = false;
              for (let c = 0; c < view.columns.length; c++) {
                const cell = colRow.cells.get(view.columns[c]!);
                if (cell?.kind === 'container') {
                  rowHasContainer = true;
                  if (expandedPaths.has(`${rowPath}.c${c}`)) {
                    rowAnyExpanded = true;
                  }
                }
              }
              if (colRow.extraFields) {
                rowHasContainer = true;
                if (expandedPaths.has(`${rowPath}.extra`)) {
                  rowAnyExpanded = true;
                }
              }

              return (
                <tr
                  key={`row-${row.rowIndex}`}
                  role="row"
                  aria-level={level}
                  aria-expanded={rowHasContainer ? rowAnyExpanded : undefined}
                  aria-label={tJson('posRowAria', { row: rowNum })}
                >
                  <td role="gridcell" className="k">
                    {rowNum}
                  </td>
                  {view.columns.map((colKey, colIdx) => {
                    const colNum = colIdx + 1;
                    const cellKey = `${rowPath}.c${colIdx}`;
                    const cell: JsonTableCellView | undefined = colRow.cells.get(colKey);

                    if (!cell || cell.kind === 'missing') {
                      const posLabel = tJson('posCellAria', {
                        row: rowNum,
                        col: colNum,
                      });
                      return (
                        <td key={`cell-${colIdx}`} role="gridcell">
                          {!readOnly && !disabled && cell?.kind === 'missing' ? (
                            <button
                              type="button"
                              aria-label={posLabel}
                              title={tJson('missingCellInitTitle')}
                              data-testid={`json-missing-cell-${cellKey}`}
                              data-json-focus-key={cellKey}
                              data-json-grid-nav=""
                              className="json-cell-btn v-null rounded border border-transparent bg-transparent px-1.5 py-0.5"
                              onClick={() => handleInitMissingCell(cell, cellKey)}
                            >
                              —
                            </button>
                          ) : (
                            <span className="v-null">—</span>
                          )}
                        </td>
                      );
                    }

                    if (cell.kind === 'container') {
                      return (
                        <td key={`cell-${colIdx}`} role="gridcell">
                          {renderContainerToggleAndChild(cell, cellKey, level)}
                        </td>
                      );
                    }

                    return (
                      <td key={`cell-${colIdx}`} role="gridcell">
                        {renderPrimitiveCell(cell, cellKey, { rowNum, colNum })}
                      </td>
                    );
                  })}

                  {view.hasExtraFieldsColumn ? (
                    <td role="gridcell">
                      {colRow.extraFields ? (
                        renderExtraFieldsCell(
                          colRow.extraFields,
                          `${rowPath}.extra`,
                          level,
                        )
                      ) : (
                        <span className="v-null">—</span>
                      )}
                    </td>
                  ) : null}

                  {!readOnly && !disabled ? (
                    <td
                      role="gridcell"
                      className="json-col-act json-col-idx text-right"
                    >
                      <button
                        type="button"
                        aria-label={tJson('removeRowAria', { row: rowNum })}
                        title={tJson('removeRowTitle')}
                        data-testid={`json-remove-row-${containerPath}-${row.rowIndex}`}
                        data-json-focus-key={`${containerPath}:remove-row:${row.rowIndex}`}
                        className="btn btn-tertiary btn-sm px-2 py-0.5 text-muted"
                        onClick={() =>
                          handleRemoveRow(
                            containerPath,
                            view.containerRef,
                            row.rowIndex,
                            view.totalRows,
                          )
                        }
                      >
                        ×
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {renderPaginationBar(
          containerPath,
          view.totalRows,
          view.page,
          view.totalPages,
        )}
        {renderArrayToolbar(containerPath, view.containerRef)}
      </div>
    );
  };

  const renderPrimitiveArrayTable = (
    view: JsonPrimitiveArrayTableView,
    containerPath: string,
    level: number,
  ) => {
    if (view.hasReadOnlyCells) {
      renderedHasReadOnlyCells = true;
    }

    const isRootLevel = level === 1;
    const tableRoleProps = isRootLevel
      ? ({ role: 'treegrid', 'aria-label': tJson('treegridAria') } as const)
      : ({ role: 'treegrid' } as const);

    if (view.totalRows === 0) {
      return (
        <div>
          <table className="json-table" {...tableRoleProps}>
            <thead role="presentation">
              <tr role="row">
                <th role="columnheader" className="json-col-idx">
                  {tJson('colIndex')}
                </th>
                <th role="columnheader">{tJson('colValue')}</th>
              </tr>
            </thead>
            <tbody role="presentation">
              <tr role="row" aria-level={level}>
                <td
                  role="gridcell"
                  colSpan={2}
                  className="text-[13px] text-muted"
                >
                  {tJson('emptyArray')}
                </td>
              </tr>
            </tbody>
          </table>
          {renderArrayToolbar(containerPath, view.containerRef)}
        </div>
      );
    }

    return (
      <div>
        <table className="json-table" {...tableRoleProps}>
          <thead role="presentation">
            <tr role="row">
              <th role="columnheader" className="json-col-idx">
                {tJson('colIndex')}
              </th>
              <th role="columnheader">{tJson('colValue')}</th>
              {!readOnly && !disabled ? (
                <th
                  role="columnheader"
                  className="json-col-idx"
                  aria-label={tJson('colActions')}
                />
              ) : null}
            </tr>
          </thead>
          <tbody role="presentation">
            {view.rows.map((row) => {
              const rowNum = row.index + 1;
              const elPath = `${containerPath}.e${row.index}`;
              const isContainer = row.valueCell.kind === 'container';
              const isExpanded = isContainer
                ? expandedPaths.has(elPath)
                : undefined;

              return (
                <tr
                  key={`elem-${row.index}`}
                  role="row"
                  aria-level={level}
                  aria-expanded={isExpanded}
                  aria-label={tJson('posRowAria', { row: rowNum })}
                >
                  <td role="gridcell" className="k">
                    {rowNum}
                  </td>
                  <td role="gridcell">
                    {row.valueCell.kind === 'container'
                      ? renderContainerToggleAndChild(row.valueCell, elPath, level)
                      : renderPrimitiveCell(row.valueCell, elPath, {
                          rowNum,
                          colNum: 1,
                        })}
                  </td>
                  {!readOnly && !disabled ? (
                    <td
                      role="gridcell"
                      className="json-col-act json-col-idx text-right"
                    >
                      <button
                        type="button"
                        aria-label={tJson('removeRowAria', { row: rowNum })}
                        title={tJson('removeRowTitle')}
                        data-testid={`json-remove-row-${containerPath}-${row.index}`}
                        data-json-focus-key={`${containerPath}:remove-row:${row.index}`}
                        className="btn btn-tertiary btn-sm px-2 py-0.5 text-muted"
                        onClick={() =>
                          handleRemoveRow(
                            containerPath,
                            view.containerRef,
                            row.index,
                            view.totalRows,
                          )
                        }
                      >
                        ×
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {renderPaginationBar(
          containerPath,
          view.totalRows,
          view.page,
          view.totalPages,
        )}
        {renderArrayToolbar(containerPath, view.containerRef)}
      </div>
    );
  };

  const renderArrayOfArraysTable = (
    view: JsonArrayOfArraysTableView,
    containerPath: string,
    level: number,
  ) => {
    const isRootLevel = level === 1;
    const tableRoleProps = isRootLevel
      ? ({ role: 'treegrid', 'aria-label': tJson('treegridAria') } as const)
      : ({ role: 'treegrid' } as const);

    return (
      <div>
        <table className="json-table" {...tableRoleProps}>
          <thead role="presentation">
            <tr role="row">
              <th role="columnheader" className="json-col-idx">
                {tJson('colIndex')}
              </th>
              <th role="columnheader">{tJson('colValue')}</th>
              {!readOnly && !disabled ? (
                <th
                  role="columnheader"
                  className="json-col-idx"
                  aria-label={tJson('colActions')}
                />
              ) : null}
            </tr>
          </thead>
          <tbody role="presentation">
            {view.rows.map((row) => {
              const rowNum = row.index + 1;
              const elPath = `${containerPath}.e${row.index}`;
              const isExpanded = expandedPaths.has(elPath);

              return (
                <tr
                  key={`arr-${row.index}`}
                  role="row"
                  aria-level={level}
                  aria-expanded={isExpanded}
                  aria-label={tJson('posRowAria', { row: rowNum })}
                >
                  <td role="gridcell" className="k">
                    {rowNum}
                  </td>
                  <td role="gridcell">
                    {renderContainerToggleAndChild(
                      row.cell,
                      elPath,
                      level,
                      tJson('arrayOfArraysLabel', { count: row.cell.childCount }),
                    )}
                  </td>
                  {!readOnly && !disabled ? (
                    <td
                      role="gridcell"
                      className="json-col-act json-col-idx text-right"
                    >
                      <button
                        type="button"
                        aria-label={tJson('removeRowAria', { row: rowNum })}
                        title={tJson('removeRowTitle')}
                        data-testid={`json-remove-row-${containerPath}-${row.index}`}
                        data-json-focus-key={`${containerPath}:remove-row:${row.index}`}
                        className="btn btn-tertiary btn-sm px-2 py-0.5 text-muted"
                        onClick={() =>
                          handleRemoveRow(
                            containerPath,
                            view.containerRef,
                            row.index,
                            view.totalRows,
                          )
                        }
                      >
                        ×
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
        {renderPaginationBar(
          containerPath,
          view.totalRows,
          view.page,
          view.totalPages,
        )}
        {renderArrayToolbar(containerPath, view.containerRef)}
      </div>
    );
  };

  const renderRootPrimitiveTable = (
    view: JsonRootPrimitiveTableView,
    containerPath: string,
    level: number,
  ) => {
    if (view.hasReadOnlyCells) {
      renderedHasReadOnlyCells = true;
    }

    return (
      <table
        className="json-table"
        role="treegrid"
        aria-label={tJson('treegridAria')}
      >
        <thead role="presentation">
          <tr role="row">
            <th role="columnheader">{tJson('colRootPrimitive')}</th>
          </tr>
        </thead>
        <tbody role="presentation">
          <tr
            role="row"
            aria-level={level}
            aria-label={tJson('posRowAria', { row: 1 })}
          >
            <td role="gridcell">
              {renderPrimitiveCell(view.cell, containerPath, {
                rowNum: 1,
                colNum: 1,
              })}
            </td>
          </tr>
        </tbody>
      </table>
    );
  };

  function renderTableView(
    view: JsonTableView,
    containerPath: string,
    level: number,
  ) {
    switch (view.kind) {
      case 'object':
        return renderObjectTable(view, containerPath, level);
      case 'array-of-objects':
        return renderArrayOfObjectsTable(view, containerPath, level);
      case 'primitive-array':
        return renderPrimitiveArrayTable(view, containerPath, level);
      case 'array-of-arrays':
        return renderArrayOfArraysTable(view, containerPath, level);
      case 'root-primitive':
        return renderRootPrimitiveTable(view, containerPath, level);
    }
  }

  if (!doc || !rootView) {
    return (
      <div
        data-testid={`json-table-invalid-${entryId}`}
        className="p-4 text-[13px] text-error-ink"
      >
        {tJson('tableInvalidJsonNotice')}
      </div>
    );
  }

  const renderedTree = renderTableView(rootView, 'root', 1);

  return (
    <div
      ref={hostRef}
      data-testid={`json-table-host-${entryId}`}
      className="overflow-x-auto"
      onKeyDown={handleHostKeyDown}
    >
      {renderedTree}
      {renderedHasReadOnlyCells ? (
        <p
          id={readOnlyNoteId}
          data-testid={`json-readonly-note-${entryId}`}
          className="json-readonly-note"
        >
          {tJson('cellReadOnly')}
        </p>
      ) : null}
    </div>
  );
}
