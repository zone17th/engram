'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { useOptionalUndoToast } from '@/components/ui/undo-toast';
import { useSession } from '@/features/auth/session-provider';
import {
  ENTRY_MAX_PLAINTEXT_BYTES,
  ENTRY_NEAR_CAP_BYTES,
  VAULT_SECRET_INPUT_PROPS,
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
import { toSuperscriptNumber } from '@/features/json-table/json-tree-grid';
import { useOptionalVault } from '@/features/vault/vault-provider';
import {
  classifyContentMutationError,
  type ContentErrorI18nKey,
  type EntryMeta,
} from '@/lib/api/content';
import {
  detectEol,
  escapeJsonStringMinimal,
  isValidJsonNumberLexeme,
  measureUtf8Bytes,
  normalizeEolToLf,
  parseJsonStrict,
  type JsonNode,
} from '@/lib/json';

export type JsonCardMode = 'table' | 'raw';

export type JsonNewPresetId = 'empty-object' | 'empty-array';

export const JSON_NEW_PRESETS: Readonly<Record<JsonNewPresetId, string>> = {
  'empty-object': '{}',
  'empty-array': '[]',
};

export type KvRowValueType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
export type KvContainerKind = 'object' | 'array';

export interface KvRow {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly type: KvRowValueType;
  readonly placeholder: boolean;
  readonly fromRaw: boolean;
  readonly occurrenceIndex: number;
  readonly rawKeyLiteral: string | null;
  readonly rawValueLiteral: string | null;
  readonly hasCarriageReturn: boolean;
  readonly hasLoneSurrogate: boolean;
  readonly keyHasUnsafeChars: boolean;
  readonly expanded: boolean;
  readonly children: readonly KvRow[];
}

export interface KvRowErrorItem {
  readonly code: 'EMPTY_KEY' | 'DUPLICATE_KEY' | 'INVALID_NUMBER';
  readonly message: string;
}

export interface KvRowError {
  readonly key?: KvRowErrorItem;
  readonly value?: KvRowErrorItem;
}

export interface KvFocusDescriptor {
  readonly kind: 'key' | 'val' | 'type' | 'menu' | 'type-menu-item' | 'row-menu-item' | 'root-menu-btn';
  readonly rowId?: string;
  readonly select?: boolean;
}

export type KvInlinePromptState =
  | {
      readonly kind: 'switch-root';
      readonly nextKind: KvContainerKind;
      readonly count: number;
      readonly restoreFocusDesc: KvFocusDescriptor;
    }
  | {
      readonly kind: 'switch-row-type';
      readonly rowId: string;
      readonly prevType: KvRowValueType;
      readonly nextType: KvRowValueType;
      readonly count: number;
      readonly restoreFocusDesc: KvFocusDescriptor;
    }
  | {
      readonly kind: 'paste-mismatch';
      readonly pastedRawText: string;
      readonly pastedRoot: JsonNode;
      readonly targetRowId: string;
      readonly restoreFocusDesc: KvFocusDescriptor;
    };

export interface KvEditorSnapshot {
  readonly rootKind: KvContainerKind;
  readonly rows: readonly KvRow[];
  readonly canonicalRawText: string | null;
  readonly rawDraftValue: string;
  readonly rawEditedSinceSwitch: boolean;
  readonly rawSettledIssue: RawValidationIssue | null;
  readonly switchBlockedError: string | null;
}

export type ParsedKvPaste =
  | { readonly kind: 'json'; readonly root: JsonNode; readonly rawText: string }
  | { readonly kind: 'pairs'; readonly pairs: ReadonlyArray<{ readonly key: string; readonly value: string }> }
  | { readonly kind: 'lines'; readonly items: readonly string[] };

export function hasLoneSurrogateInStr(str: string): boolean {
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 < s.length) {
        const lo = s.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          i++;
          continue;
        }
      }
      return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function formatReadOnlyStringSafe(str: string): string {
  return Array.from(String(str || ''))
    .map((ch) => {
      const c = ch.charCodeAt(0);
      if (c === 0x0d) return '\\r';
      if (c === 0x0a) return '\\n';
      if (c >= 0xd800 && c <= 0xdfff) return `\\u${c.toString(16).padStart(4, '0')}`;
      return ch;
    })
    .join('');
}

export function isRowCompletelyBlank(r: KvRow, parentKind: KvContainerKind): boolean {
  if (r.type !== 'string') return false;
  if (parentKind === 'object') return r.key === '' && r.value === '';
  return r.value === '';
}

export function isEffectivePlaceholderRow(
  r: KvRow,
  idx: number,
  list: readonly KvRow[],
  parentKind: KvContainerKind,
): boolean {
  if (r.placeholder) return true;
  if (r.fromRaw) return false;
  // RFD-21: In object containers, any table-authored completely blank string row (any position) is a placeholder
  if (parentKind === 'object' && isRowCompletelyBlank(r, 'object')) {
    return true;
  }
  if (idx === list.length - 1 && isRowCompletelyBlank(r, parentKind)) {
    return true;
  }
  return false;
}

export function parseMultiLineKeyValuePaste(
  text: string,
  targetParentKind: KvContainerKind,
  isValueInput: boolean,
): ParsedKvPaste | null {
  const raw = String(text || '');
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // RFD-32 (advisor-dec-373): Paste into a value field is ALWAYS verbatim (multi-line text stays in that value).
  // Key-value line parser and JSON container parser only run when pasting into an empty Key field (or empty Array item when editor is blank).
  if (isValueInput) {
    return null;
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseJsonStrict(trimmed);
    if (
      parsed.ok &&
      (parsed.document.root.kind === 'object' || parsed.document.root.kind === 'array')
    ) {
      return { kind: 'json', root: parsed.document.root, rawText: trimmed };
    }
  }

  const rawLines = raw.split(/\r?\n/);
  const nonEmptyLines = rawLines.filter((l) => l.trim() !== '');
  if (nonEmptyLines.length < 1) return null;

  // RFD-19 & L2: On key inputs, single-line pair paste requires explicit 'key: value' (colon + space) or
  // 'key=value' where key is an identifier-like token (`^[A-Za-z_][A-Za-z0-9_.-]*$`) and value does not start
  // with `=` or contain only trailing `=` padding (so base64 `dGVzdA==` is never split into key `dGVzdA`).
  function parseSingleKeyValuePairLine(
    line: string,
  ): { readonly key: string; readonly value: string } | null {
    const mColon = /^([^:=\s][^:=]*?)\s*:\s+(.+)$/.exec(line);
    if (mColon && mColon[1]!.trim() && !/^https?$/i.test(mColon[1]!.trim())) {
      return { key: mColon[1]!.trim(), value: mColon[2]! };
    }
    const mEq = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*([^=].*)$/.exec(line);
    if (mEq && mEq[1]!.trim()) {
      return { key: mEq[1]!.trim(), value: mEq[2]! };
    }
    return null;
  }

  if (nonEmptyLines.length === 1) {
    const pair = parseSingleKeyValuePairLine(nonEmptyLines[0]!);
    return pair ? { kind: 'pairs', pairs: [pair] } : null;
  }

  const pairs: Array<{ readonly key: string; readonly value: string }> = [];
  let allPairs = nonEmptyLines.length >= 2;
  for (let i = 0; i < nonEmptyLines.length; i++) {
    const pair = parseSingleKeyValuePairLine(nonEmptyLines[i]!);
    if (!pair) {
      allPairs = false;
      break;
    }
    pairs.push(pair);
  }
  if (allPairs && pairs.length >= 2) {
    return { kind: 'pairs', pairs };
  }
  if (targetParentKind === 'array' && nonEmptyLines.length >= 2) {
    return { kind: 'lines', items: nonEmptyLines };
  }
  return null;
}

function serializeNodeValue(r: KvRow, indent: string): string {
  if (r.type === 'string') {
    if (r.rawValueLiteral) return r.rawValueLiteral;
    return escapeJsonStringMinimal(r.value);
  }
  if (r.type === 'number') {
    return r.value.trim();
  }
  if (r.type === 'boolean') {
    return r.value === 'false' ? 'false' : 'true';
  }
  if (r.type === 'null') {
    return 'null';
  }
  if (r.type === 'object') {
    return serializeContainer(r.children, 'object', indent);
  }
  if (r.type === 'array') {
    return serializeContainer(r.children, 'array', indent);
  }
  return '""';
}

export function serializeContainer(
  list: readonly KvRow[],
  kind: KvContainerKind,
  indent = '',
): string {
  const childIndent = indent + '  ';
  if (kind === 'object') {
    const active = list.filter((r, idx) => !isEffectivePlaceholderRow(r, idx, list, 'object'));
    if (active.length === 0) return '{}';
    const lines = active.map((r) => {
      const keyJson = r.rawKeyLiteral || escapeJsonStringMinimal(r.key);
      return `${childIndent}${keyJson}: ${serializeNodeValue(r, childIndent)}`;
    });
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  const active = list.filter((r, idx) => !isEffectivePlaceholderRow(r, idx, list, 'array'));
  if (active.length === 0) return '[]';
  const lines = active.map((r) => `${childIndent}${serializeNodeValue(r, childIndent)}`);
  return `[\n${lines.join(',\n')}\n${indent}]`;
}

interface FoundRowContext {
  readonly row: KvRow;
  readonly list: readonly KvRow[];
  readonly index: number;
  readonly parentKind: KvContainerKind;
  readonly parentRow: KvRow | null;
}

function findRowAndParent(
  list: readonly KvRow[],
  targetId: string,
  parentKind: KvContainerKind,
  parentRow: KvRow | null = null,
): FoundRowContext | null {
  for (let i = 0; i < list.length; i++) {
    const r = list[i]!;
    if (r.id === targetId) {
      return { row: r, list, index: i, parentKind, parentRow };
    }
    if ((r.type === 'object' || r.type === 'array') && r.children.length > 0) {
      const found = findRowAndParent(r.children, targetId, r.type, r);
      if (found) return found;
    }
  }
  return null;
}

function updateRowListById(
  list: readonly KvRow[],
  parentRowId: string | null,
  rootMatch: boolean,
  updater: (currentList: readonly KvRow[]) => readonly KvRow[],
): readonly KvRow[] {
  if (rootMatch && (parentRowId === null || parentRowId === 'root')) {
    return updater(list);
  }
  return list.map((r) => {
    if (r.id === parentRowId) {
      return {
        ...r,
        children: updater(r.children),
      };
    }
    if ((r.type === 'object' || r.type === 'array') && r.children.length > 0) {
      const nextChildren = updateRowListById(r.children, parentRowId, false, updater);
      if (nextChildren !== r.children) {
        return {
          ...r,
          children: nextChildren,
        };
      }
    }
    return r;
  });
}

function updateRowById(
  list: readonly KvRow[],
  rowId: string,
  updater: (row: KvRow) => KvRow,
): readonly KvRow[] {
  return list.map((r) => {
    if (r.id === rowId) {
      return updater(r);
    }
    if ((r.type === 'object' || r.type === 'array') && r.children.length > 0) {
      const nextChildren = updateRowById(r.children, rowId, updater);
      if (nextChildren !== r.children) {
        return {
          ...r,
          children: nextChildren,
        };
      }
    }
    return r;
  });
}

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
  const tOmni = useTranslations('content.omnibox');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const vault = useOptionalVault();
  const undoToast = useOptionalUndoToast();
  const { me } = useSession();

  const translateContentError = useCallback(
    (key: ContentErrorI18nKey): string => {
      const code = key.replace(/^content\.errors\./, '');
      return tErrors(code as Parameters<typeof tErrors>[0]);
    },
    [tErrors],
  );

  const nextRowIdRef = useRef<number>(1);

  const makeRow = useCallback(
    function makeRowFn(partial?: {
      readonly id?: string;
      readonly key?: string;
      readonly value?: string;
      readonly type?: KvRowValueType;
      readonly placeholder?: boolean;
      readonly fromRaw?: boolean;
      readonly occurrenceIndex?: number;
      readonly rawKeyLiteral?: string | null;
      readonly rawValueLiteral?: string | null;
      readonly hasCarriageReturn?: boolean;
      readonly hasLoneSurrogate?: boolean;
      readonly keyHasUnsafeChars?: boolean;
      readonly expanded?: boolean;
      readonly children?: readonly KvRow[];
    }): KvRow {
      const p = partial ?? {};
      const type: KvRowValueType = p.type ?? 'string';
      const val =
        p.value != null
          ? String(p.value)
          : type === 'boolean'
            ? 'true'
            : type === 'null'
              ? 'null'
              : '';
      const k = p.key != null ? String(p.key) : '';
      return {
        id: p.id ?? `r${nextRowIdRef.current++}`,
        key: k,
        value: val,
        type,
        placeholder: Boolean(p.placeholder),
        fromRaw: Boolean(p.fromRaw),
        occurrenceIndex: p.occurrenceIndex ?? 0,
        rawKeyLiteral: p.rawKeyLiteral ?? null,
        rawValueLiteral: p.rawValueLiteral ?? null,
        hasCarriageReturn: Boolean(p.hasCarriageReturn) || val.includes('\r'),
        hasLoneSurrogate: Boolean(p.hasLoneSurrogate) || hasLoneSurrogateInStr(val),
        keyHasUnsafeChars:
          Boolean(p.keyHasUnsafeChars) ||
          k.includes('\r') ||
          k.includes('\n') ||
          hasLoneSurrogateInStr(k),
        expanded: p.expanded !== undefined ? Boolean(p.expanded) : true,
        children: Array.isArray(p.children)
          ? p.children
          : type === 'object' || type === 'array'
            ? [makeRowFn({ type: 'string', placeholder: true })]
            : [],
      };
    },
    [],
  );

  const astNodeToRow = useCallback(
    function astNodeToRowFn(
      node: JsonNode | undefined,
      keyStr: string,
      propMeta?: { readonly occurrenceIndex?: number; readonly rawKeyLiteral?: string | null },
    ): KvRow {
      const meta = propMeta ?? {};
      const k = keyStr != null ? String(keyStr) : '';
      const base = {
        key: k,
        placeholder: false,
        fromRaw: true,
        occurrenceIndex: meta.occurrenceIndex ?? 0,
        rawKeyLiteral: meta.rawKeyLiteral ?? null,
        keyHasUnsafeChars:
          k.includes('\r') || k.includes('\n') || hasLoneSurrogateInStr(k),
      };
      if (!node) return makeRow({ ...base, value: '', type: 'string' });
      if (node.kind === 'string') {
        return makeRow({
          ...base,
          value: node.value,
          type: 'string',
          rawValueLiteral: node.raw || null,
          hasCarriageReturn: Boolean(node.hasCarriageReturn),
          hasLoneSurrogate: Boolean(node.hasLoneSurrogate),
        });
      }
      if (node.kind === 'number') {
        return makeRow({
          ...base,
          value: node.lexeme,
          type: 'number',
          rawValueLiteral: node.lexeme,
        });
      }
      if (node.kind === 'boolean') {
        return makeRow({
          ...base,
          value: node.value ? 'true' : 'false',
          type: 'boolean',
          rawValueLiteral: node.raw,
        });
      }
      if (node.kind === 'null') {
        return makeRow({
          ...base,
          value: 'null',
          type: 'null',
          rawValueLiteral: 'null',
        });
      }
      if (node.kind === 'object') {
        const children = node.properties.map((p) =>
          astNodeToRowFn(p.valueNode, p.key, {
            occurrenceIndex: p.occurrenceIndex ?? 0,
            rawKeyLiteral: p.keyNode ? p.keyNode.raw : null,
          }),
        );
        return makeRow({
          ...base,
          value: '',
          type: 'object',
          expanded: true,
          children,
        });
      }
      if (node.kind === 'array') {
        const children = node.elements.map((el) => astNodeToRowFn(el, ''));
        return makeRow({
          ...base,
          value: '',
          type: 'array',
          expanded: true,
          children,
        });
      }
      return makeRow({ ...base, value: '', type: 'string' });
    },
    [makeRow],
  );

  const initialRootKind: KvContainerKind = initialPreset === 'empty-array' ? 'array' : 'object';
  const [rootKind, setRootKind] = useState<KvContainerKind>(initialRootKind);
  const [rows, setRows] = useState<readonly KvRow[]>(() => [
    makeRow({ key: '', value: '', type: 'string', placeholder: true }),
  ]);
  const [canonicalRawText, setCanonicalRawText] = useState<string | null>(null);
  const [mode, setMode] = useState<JsonCardMode>('table');
  const [rawDraftValue, setRawDraftValue] = useState<string>(
    () => JSON_NEW_PRESETS[initialPreset],
  );
  const [rawEditedSinceSwitch, setRawEditedSinceSwitch] = useState<boolean>(false);
  const [rawSettledIssue, setRawSettledIssue] = useState<RawValidationIssue | null>(null);

  const [openRootMenu, setOpenRootMenu] = useState<boolean>(false);
  const [openTypeMenuRowId, setOpenTypeMenuRowId] = useState<string | null>(null);
  const [openRowMenuRowId, setOpenRowMenuRowId] = useState<string | null>(null);
  const [inlinePrompt, setInlinePrompt] = useState<KvInlinePromptState | null>(null);
  const [expandedMultilineRows, setExpandedMultilineRows] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const [discardConfirmOpen, setDiscardConfirmOpen] = useState<boolean>(false);
  const [switchBlockedError, setSwitchBlockedError] = useState<string | null>(null);
  const [savingInFlight, setSavingInFlight] = useState<boolean>(false);
  const [unconfirmedCreate, setUnconfirmedCreate] = useState<{
    readonly sealed: SealedNewEntryPayload;
    readonly errorMessage: string;
  } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [liveErrorAnnouncement, setLiveErrorAnnouncement] = useState<string>('');

  const cardRef = useRef<HTMLElement | null>(null);
  const kvHostRef = useRef<HTMLDivElement | null>(null);
  const rootMenuBtnRef = useRef<HTMLButtonElement | null>(null);
  const rootMenuPopRef = useRef<HTMLDivElement | null>(null);
  const inlinePromptRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusRef = useRef<KvFocusDescriptor | null>(null);
  const didAutoFocusInitialRef = useRef<boolean>(false);
  const lastErrorSignatureRef = useRef<string>('');
  const liveAnnounceTimerRef = useRef<number | null>(null);

  const saveLockRef = useRef<boolean>(false);
  const saveOwnerIdRef = useRef<number>(0);
  const nextSaveOwnerIdRef = useRef<number>(0);
  const lockEpochRef = useRef<number>(0);

  // Compute validation errors and duplicate occurrence indices across the row tree
  const validationResult = useMemo(() => {
    const errorsMap = new Map<string, KvRowError>();
    const occurrenceMap = new Map<string, number>();

    function walk(list: readonly KvRow[], parentKind: KvContainerKind) {
      const keyCounts = new Map<string, number>();
      const keySeenSoFar = new Map<string, number>();

      if (parentKind === 'object') {
        list.forEach((r, idx) => {
          if (isEffectivePlaceholderRow(r, idx, list, 'object')) return;
          const k = r.key;
          keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
        });
      }

      list.forEach((r, idx) => {
        const isPh = isEffectivePlaceholderRow(r, idx, list, parentKind);
        if (isPh) {
          occurrenceMap.set(r.id, 0);
          return;
        }

        let keyErr: KvRowErrorItem | undefined;
        let valErr: KvRowErrorItem | undefined;

        if (parentKind === 'object') {
          const k = r.key;
          const occ = keySeenSoFar.get(k) ?? 0;
          keySeenSoFar.set(k, occ + 1);
          occurrenceMap.set(r.id, (keyCounts.get(k) ?? 0) > 1 ? occ : 0);

          const hasNonDefaultContent = r.value !== '' || r.type !== 'string';
          if (k === '' && !r.fromRaw && hasNonDefaultContent) {
            keyErr = {
              code: 'EMPTY_KEY',
              message: tJson('kvErrEmptyKey'),
            };
          } else if ((keyCounts.get(k) ?? 0) > 1 && !r.fromRaw) {
            keyErr = {
              code: 'DUPLICATE_KEY',
              message: tJson('kvErrDuplicateKey', { key: k }),
            };
          }
        } else {
          occurrenceMap.set(r.id, 0);
        }

        if (r.type === 'number') {
          const v = r.value.trim();
          if (v === '' || !isValidJsonNumberLexeme(v)) {
            valErr = {
              code: 'INVALID_NUMBER',
              message: tJson('kvErrInvalidNumber'),
            };
          }
        }

        if (keyErr || valErr) {
          errorsMap.set(r.id, { key: keyErr, value: valErr });
        }

        if ((r.type === 'object' || r.type === 'array') && r.children.length > 0) {
          walk(r.children, r.type);
        }
      });
    }

    walk(rows, rootKind);
    return { errorsMap, occurrenceMap };
  }, [rootKind, rows, tJson]);

  const { errorsMap, occurrenceMap } = validationResult;

  const hasAnyCommittedRow = useMemo(() => {
    if (canonicalRawText !== null) return true;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (!isEffectivePlaceholderRow(r, i, rows, rootKind)) return true;
    }
    return false;
  }, [canonicalRawText, rootKind, rows]);

  const tableSerializedSource = useMemo(() => {
    if (canonicalRawText !== null) {
      return canonicalRawText;
    }
    return serializeContainer(rows, rootKind, '');
  }, [canonicalRawText, rootKind, rows]);

  const candidateSource =
    mode === 'raw' && rawEditedSinceSwitch ? rawDraftValue : tableSerializedSource;

  const isDirty =
    hasAnyCommittedRow ||
    (mode === 'raw' && rawEditedSinceSwitch && rawDraftValue !== JSON_NEW_PRESETS[rootKind === 'array' ? 'empty-array' : 'empty-object']);

  const internalComposerHolderRef = useRef<JsonComposerPlaintextHolder>({
    candidateSource: JSON_NEW_PRESETS[initialPreset],
  });
  const composerHolderRef = jsonComposerPlaintextHolderTestHookRef ?? internalComposerHolderRef;
  composerHolderRef.current.candidateSource = candidateSource;

  const composerDirtyRef = useRef<boolean>(false);
  composerDirtyRef.current = isDirty || unconfirmedCreate !== null;

  // Focus first key/value input on initial mount (advisor-dec-371)
  useEffect(() => {
    if (didAutoFocusInitialRef.current) return;
    didAutoFocusInitialRef.current = true;
    const firstRow = rows[0];
    if (!firstRow) return;
    const host = kvHostRef.current;
    if (!host) return;
    const selector =
      rootKind === 'array'
        ? `[data-kv-val-input="${firstRow.id}"]`
        : `[data-kv-key-input="${firstRow.id}"]`;
    const el = host.querySelector<HTMLElement>(selector);
    el?.focus();
  }, [rootKind, rows]);

  // Execute pending focus descriptor after state transition
  useEffect(() => {
    const desc = pendingFocusRef.current;
    if (!desc) return;
    pendingFocusRef.current = null;

    if (desc.kind === 'root-menu-btn') {
      rootMenuBtnRef.current?.focus();
      return;
    }

    const host = kvHostRef.current;
    if (!host) return;
    let targetEl: HTMLElement | null = null;
    if (desc.kind === 'key' && desc.rowId) {
      targetEl = host.querySelector<HTMLElement>(`[data-kv-key-input="${desc.rowId}"]`);
    } else if (desc.kind === 'val' && desc.rowId) {
      targetEl =
        host.querySelector<HTMLElement>(`[data-kv-val-input="${desc.rowId}"]`) ??
        host.querySelector<HTMLElement>(
          `[data-kv-act="toggle-type-menu"][data-row-id="${desc.rowId}"]`,
        );
    } else if (desc.kind === 'type' && desc.rowId) {
      targetEl = host.querySelector<HTMLElement>(
        `[data-kv-act="toggle-type-menu"][data-row-id="${desc.rowId}"]`,
      );
    } else if (desc.kind === 'menu' && desc.rowId) {
      targetEl = host.querySelector<HTMLElement>(
        `[data-kv-act="toggle-row-menu"][data-row-id="${desc.rowId}"]`,
      );
    } else if (desc.kind === 'type-menu-item' && desc.rowId) {
      const pop = host.querySelector<HTMLElement>(
        `[data-kv-menu-pop="type"][data-row-id="${desc.rowId}"]`,
      );
      if (pop) {
        targetEl =
          pop.querySelector<HTMLElement>('[aria-checked="true"]') ??
          pop.querySelector<HTMLElement>('[role^="menuitem"]');
      }
    } else if (desc.kind === 'row-menu-item' && desc.rowId) {
      const pop = host.querySelector<HTMLElement>(
        `[data-kv-menu-pop="row"][data-row-id="${desc.rowId}"]`,
      );
      if (pop) {
        const items = Array.from(pop.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'));
        targetEl = items.find((el) => !el.disabled) ?? null;
      }
    }

    if (targetEl && typeof targetEl.focus === 'function') {
      targetEl.focus();
      if (
        desc.select &&
        'select' in targetEl &&
        typeof (targetEl as HTMLInputElement).select === 'function'
      ) {
        (targetEl as HTMLInputElement).select();
      }
    }
  });

  // Focus first button when inline prompt opens
  useEffect(() => {
    if (!inlinePrompt) return;
    const promptEl = inlinePromptRef.current;
    if (!promptEl) return;
    const firstBtn = promptEl.querySelector<HTMLButtonElement>('button[data-kv-prompt-act]');
    firstBtn?.focus();
  }, [inlinePrompt]);

  // Focus checked item when root menu opens
  useEffect(() => {
    if (!openRootMenu) return;
    const pop = rootMenuPopRef.current;
    if (!pop) return;
    const checked =
      pop.querySelector<HTMLElement>('[aria-checked="true"]') ??
      pop.querySelector<HTMLElement>('[role^="menuitem"]');
    checked?.focus();
  }, [openRootMenu]);

  // Outside click closes open popovers
  useEffect(() => {
    if (!openRootMenu && !openTypeMenuRowId && !openRowMenuRowId) return;
    const handleDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (
        (openTypeMenuRowId || openRowMenuRowId) &&
        kvHostRef.current &&
        !kvHostRef.current.contains(target)
      ) {
        setOpenTypeMenuRowId(null);
        setOpenRowMenuRowId(null);
      }
      if (openRootMenu && cardRef.current && !cardRef.current.contains(target)) {
        setOpenRootMenu(false);
      }
    };
    document.addEventListener('click', handleDocClick);
    return () => {
      document.removeEventListener('click', handleDocClick);
    };
  }, [openRootMenu, openRowMenuRowId, openTypeMenuRowId]);

  // RFD-33 (advisor-dec-373): Single polite live region per editor, updated only when error signature changes (debounced 300ms)
  const latestErrorsMapRef = useRef<Map<string, KvRowError>>(errorsMap);
  latestErrorsMapRef.current = errorsMap;

  useEffect(() => {
    const entries: string[] = [];
    errorsMap.forEach((err, rowId) => {
      const item = err.key ?? err.value;
      if (item) entries.push(`${rowId}:${item.code}`);
    });
    const sig = entries.join('|');
    if (sig === lastErrorSignatureRef.current) return;
    lastErrorSignatureRef.current = sig;

    if (liveAnnounceTimerRef.current !== null) {
      window.clearTimeout(liveAnnounceTimerRef.current);
      liveAnnounceTimerRef.current = null;
    }

    if (!sig) {
      setLiveErrorAnnouncement('');
      return;
    }

    liveAnnounceTimerRef.current = window.setTimeout(() => {
      liveAnnounceTimerRef.current = null;
      const currentErrors = latestErrorsMapRef.current;
      const firstErr = currentErrors.values().next().value as KvRowError | undefined;
      const msg = firstErr ? (firstErr.key ?? firstErr.value)?.message : null;
      const count = currentErrors.size;
      if (msg) {
        setLiveErrorAnnouncement(
          count > 1 ? tJson('kvLiveErrorsMulti', { count, message: msg }) : msg,
        );
      }
    }, 300);
  }, [errorsMap, tJson]);

  // Vault lock reset registration
  useEffect(() => {
    if (!vault?.registerSecretFormReset) return;
    return vault.registerSecretFormReset(() => {
      const hadNonEmptyDraft = composerDirtyRef.current;
      lockEpochRef.current += 1;
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      composerHolderRef.current.candidateSource = '';
      // Synchronously wipe any mounted key/value DOM inputs inside kvHostRef
      if (kvHostRef.current) {
        kvHostRef.current
          .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
          .forEach((el) => {
            el.value = '';
          });
      }
      const nextKind = initialPreset === 'empty-array' ? 'array' : 'object';
      setRootKind(nextKind);
      setRows([makeRow({ key: '', value: '', type: 'string', placeholder: true })]);
      setCanonicalRawText(null);
      setRawDraftValue(JSON_NEW_PRESETS[initialPreset]);
      setRawEditedSinceSwitch(false);
      setRawSettledIssue(null);
      setOpenRootMenu(false);
      setOpenTypeMenuRowId(null);
      setOpenRowMenuRowId(null);
      setInlinePrompt(null);
      setExpandedMultilineRows(new Set());
      setDiscardConfirmOpen(false);
      setSwitchBlockedError(null);
      setSavingInFlight(false);
      setUnconfirmedCreate(null);
      setSaveError(null);
      setLiveErrorAnnouncement('');
      if (hadNonEmptyDraft) {
        onDraftClearedOnLock?.();
      }
      onCancel();
    });
  }, [composerHolderRef, initialPreset, makeRow, onCancel, onDraftClearedOnLock, vault]);

  // Unmount cleanup (IP16-FE1-3 / IP15-BE3-2): synchronously wipe composer holder and invalidate save ownership
  useEffect(() => {
    const holderToWipe = composerHolderRef;
    const hostEl = kvHostRef.current;
    return () => {
      lockEpochRef.current += 1;
      saveOwnerIdRef.current = 0;
      saveLockRef.current = false;
      holderToWipe.current.candidateSource = '';
      if (hostEl) {
        hostEl
          .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
          .forEach((el) => {
            el.value = '';
          });
      }
      if (liveAnnounceTimerRef.current !== null) {
        window.clearTimeout(liveAnnounceTimerRef.current);
        liveAnnounceTimerRef.current = null;
      }
    };
  }, [composerHolderRef]);

  const captureSnapshot = useCallback((): KvEditorSnapshot => {
    return {
      rootKind,
      rows,
      canonicalRawText,
      rawDraftValue,
      rawEditedSinceSwitch,
      rawSettledIssue,
      switchBlockedError,
    };
  }, [
    canonicalRawText,
    rawDraftValue,
    rawEditedSinceSwitch,
    rawSettledIssue,
    rootKind,
    rows,
    switchBlockedError,
  ]);

  const restoreSnapshot = useCallback((snap: KvEditorSnapshot) => {
    setRootKind(snap.rootKind);
    setRows(snap.rows);
    setCanonicalRawText(snap.canonicalRawText);
    setRawDraftValue(snap.rawDraftValue);
    setRawEditedSinceSwitch(snap.rawEditedSinceSwitch);
    setRawSettledIssue(snap.rawSettledIssue);
    setSwitchBlockedError(snap.switchBlockedError);
    setInlinePrompt(null);
  }, []);

  const pushEditorUndoToast = useCallback(
    (message: string, snap: KvEditorSnapshot, returnFocusTo?: HTMLElement | null) => {
      onAnnounce?.(message);
      undoToast?.pushUndoToast({
        message,
        actionLabel: tOmni('undoAction'),
        returnFocusTo: returnFocusTo ?? kvHostRef.current,
        onUndo: () => {
          restoreSnapshot(snap);
        },
      });
    },
    [onAnnounce, restoreSnapshot, tOmni, undoToast],
  );

  const loadFromJsonString = useCallback(
    (
      jsonStr: string,
      opts?: { readonly preserveRawSource?: boolean; readonly markFromRaw?: boolean },
    ):
      | { readonly ok: true; readonly nextKind: KvContainerKind; readonly nextRows: readonly KvRow[] }
      | { readonly ok: false; readonly reason: 'parse' | 'scalar'; readonly scalarKind?: string } => {
      const parsed = parseJsonStrict(jsonStr);
      if (!parsed.ok) {
        return { ok: false, reason: 'parse' };
      }
      const root = parsed.document.root;
      if (root.kind !== 'object' && root.kind !== 'array') {
        return { ok: false, reason: 'scalar', scalarKind: root.kind };
      }
      const markRaw = opts?.markFromRaw ?? true;
      function clearFromRawTree(list: readonly KvRow[]): readonly KvRow[] {
        return list.map((r) => ({
          ...r,
          fromRaw: false,
          children: r.children.length > 0 ? clearFromRawTree(r.children) : [],
        }));
      }
      let builtRows: readonly KvRow[];
      const nextKind: KvContainerKind = root.kind === 'array' ? 'array' : 'object';
      if (root.kind === 'array') {
        builtRows = root.elements.map((el) => astNodeToRow(el, ''));
      } else {
        builtRows = root.properties.map((p) =>
          astNodeToRow(p.valueNode, p.key, {
            occurrenceIndex: p.occurrenceIndex ?? 0,
            rawKeyLiteral: p.keyNode ? p.keyNode.raw : null,
          }),
        );
      }
      if (!markRaw) {
        builtRows = clearFromRawTree(builtRows);
      }
      if (builtRows.length === 0) {
        builtRows = [makeRow({ key: '', value: '', type: 'string', placeholder: true })];
      }
      setRootKind(nextKind);
      setRows(builtRows);
      setCanonicalRawText(opts?.preserveRawSource ? jsonStr : null);
      return { ok: true, nextKind, nextRows: builtRows };
    },
    [astNodeToRow, makeRow],
  );

  const utf8ByteLength = useMemo(
    () => measureUtf8Bytes(candidateSource),
    [candidateSource],
  );
  const formattedBytes = format.number(utf8ByteLength);
  const isOverCap = utf8ByteLength > ENTRY_MAX_PLAINTEXT_BYTES;
  const isNearCap = !isOverCap && utf8ByteLength >= ENTRY_NEAR_CAP_BYTES;
  const hasRowErrors = mode === 'table' && errorsMap.size > 0;
  const isBlankInTable = mode === 'table' && !hasAnyCommittedRow;

  // Compute footer save disable reason (RFD-10 / RFD-24 / RFD-33)
  const saveDisableInfo = useMemo((): {
    readonly disabled: boolean;
    readonly text: string;
    readonly isErrorStyle: boolean;
  } => {
    if (mode === 'raw' && rawSettledIssue !== null) {
      if (rawSettledIssue.parseError) {
        return {
          disabled: true,
          text: tJson('kvCannotSaveRawSyntax', {
            line: rawSettledIssue.parseError.line,
            column: rawSettledIssue.parseError.column,
          }),
          isErrorStyle: true,
        };
      }
      if (rawSettledIssue.kind === 'over_cap') {
        return {
          disabled: true,
          text: tJson('kvCannotSaveOverCap'),
          isErrorStyle: true,
        };
      }
      return {
        disabled: true,
        text: tJson('rawInvalidUnicode'),
        isErrorStyle: true,
      };
    }
    if (isOverCap) {
      return {
        disabled: true,
        text: tJson('kvCannotSaveOverCap'),
        isErrorStyle: true,
      };
    }
    if (hasRowErrors) {
      const firstErr = errorsMap.values().next().value as KvRowError | undefined;
      const msg = (firstErr?.key ?? firstErr?.value)?.message ?? '';
      const count = errorsMap.size;
      return {
        disabled: true,
        text:
          count > 1
            ? tJson('kvCannotSaveRowErrorsMulti', { count, message: msg })
            : tJson('kvCannotSaveRowErrorSingle', { message: msg }),
        isErrorStyle: true,
      };
    }
    if (isBlankInTable) {
      return {
        disabled: true,
        text:
          rootKind === 'array'
            ? tJson('kvSaveReasonEmptyArray')
            : tJson('kvSaveReasonEmptyObject'),
        isErrorStyle: false,
      };
    }
    if (utf8ByteLength === 0) {
      return {
        disabled: true,
        text: tJson('kvSaveReasonEmptyObject'),
        isErrorStyle: false,
      };
    }
    return {
      disabled: false,
      text: tJson('kvFooterReadyHint'),
      isErrorStyle: false,
    };
  }, [
    errorsMap,
    hasRowErrors,
    isBlankInTable,
    isOverCap,
    mode,
    rawSettledIssue,
    rootKind,
    tJson,
    utf8ByteLength,
  ]);

  const saveDisabled =
    saveDisableInfo.disabled || savingInFlight || unconfirmedCreate !== null;

  const applyRootKindSwitch = useCallback(
    (nextKind: KvContainerKind, withUndo: boolean) => {
      const snap = captureSnapshot();
      setCanonicalRawText(null);
      setSwitchBlockedError(null);
      setDiscardConfirmOpen(false);
      setInlinePrompt(null);
      setRootKind(nextKind);
      setRows((prevRows) => {
        // RFD-20: Clear fromRaw and rawKeyLiteral on direct children when root container kind changes
        const updated = prevRows.map((r) => ({
          ...r,
          fromRaw: false,
          rawKeyLiteral: null,
          key: nextKind === 'array' ? '' : r.key,
        }));
        if (updated.length === 0) {
          return [makeRow({ key: '', value: '', type: 'string', placeholder: true })];
        }
        return updated;
      });
      setRawDraftValue(JSON_NEW_PRESETS[nextKind === 'array' ? 'empty-array' : 'empty-object']);
      setRawEditedSinceSwitch(false);
      setRawSettledIssue(null);
      const firstId = rows[0]?.id;
      if (firstId) {
        pendingFocusRef.current = {
          kind: nextKind === 'array' ? 'val' : 'key',
          rowId: firstId,
        };
      }
      if (withUndo) {
        pushEditorUndoToast(
          nextKind === 'array'
            ? tJson('toastSwitchedRootArray')
            : tJson('toastSwitchedRootObject'),
          snap,
          rootMenuBtnRef.current,
        );
      }
    },
    [captureSnapshot, makeRow, pushEditorUndoToast, rows, tJson],
  );

  const handleRequestRootSwitch = useCallback(
    (nextKind: KvContainerKind, viaPresetBtn = false) => {
      setOpenRootMenu(false);
      if (nextKind === rootKind) {
        if (!viaPresetBtn) {
          rootMenuBtnRef.current?.focus();
        }
        return;
      }
      // RFD-13 & RFD-20: Confirm inline in both directions when switching root container kind with committed items
      if (rootKind === 'object' && nextKind === 'array') {
        const keysWithNames = rows.filter(
          (r, idx) => !isEffectivePlaceholderRow(r, idx, rows, 'object') && r.key !== '',
        );
        if (keysWithNames.length > 0) {
          setInlinePrompt({
            kind: 'switch-root',
            nextKind: 'array',
            count: keysWithNames.length,
            restoreFocusDesc: { kind: 'root-menu-btn' },
          });
          return;
        }
      } else if (rootKind === 'array' && nextKind === 'object') {
        const committedItems = rows.filter(
          (r, idx) => !isEffectivePlaceholderRow(r, idx, rows, 'array'),
        );
        if (committedItems.length > 0) {
          setInlinePrompt({
            kind: 'switch-root',
            nextKind: 'object',
            count: committedItems.length,
            restoreFocusDesc: { kind: 'root-menu-btn' },
          });
          return;
        }
      }
      applyRootKindSwitch(nextKind, !viaPresetBtn);
    },
    [applyRootKindSwitch, rootKind, rows],
  );

  const applyRowTypeChange = useCallback(
    (rowId: string, prevType: KvRowValueType, nextType: KvRowValueType, withUndo: boolean) => {
      const snap = captureSnapshot();
      setCanonicalRawText(null);
      setSwitchBlockedError(null);
      setDiscardConfirmOpen(false);
      setInlinePrompt(null);

      let createdChildId: string | null = null;
      setRows((prevRows) =>
        updateRowById(prevRows, rowId, (r) => {
          let nextValue = r.value;
          let nextChildren = r.children;
          let nextExpanded = r.expanded;

          if (nextType === 'boolean') {
            if (nextValue !== 'true' && nextValue !== 'false') nextValue = 'true';
            nextChildren = [];
          } else if (nextType === 'null') {
            nextValue = 'null';
            nextChildren = [];
          } else if (nextType === 'number') {
            if (!isValidJsonNumberLexeme(nextValue.trim())) {
              nextValue = nextValue.trim() || '0';
            }
            nextChildren = [];
          } else if (nextType === 'object' || nextType === 'array') {
            nextExpanded = true;
            if (r.children.length === 0) {
              const childRow = makeRow({
                key: '',
                value: '',
                type: 'string',
                placeholder: true,
              });
              createdChildId = childRow.id;
              nextChildren = [childRow];
            } else {
              // RFD-20: Clear fromRaw and rawKeyLiteral on direct children when container kind changes
              createdChildId = r.children[0]!.id;
              nextChildren = r.children.map((c) => ({
                ...c,
                fromRaw: false,
                rawKeyLiteral: null,
                key: nextType === 'array' ? '' : c.key,
              }));
            }
          } else if (nextType === 'string') {
            if (prevType === 'null' && nextValue === 'null') nextValue = '';
            nextChildren = [];
          }

          return {
            ...r,
            type: nextType,
            value: nextValue,
            expanded: nextExpanded,
            children: nextChildren,
            placeholder: false,
            fromRaw: false,
            rawKeyLiteral: null,
            rawValueLiteral: null,
          };
        }),
      );

      if (nextType === 'object' || nextType === 'array') {
        const found = findRowAndParent(rows, rowId, rootKind);
        const firstChildId = createdChildId ?? found?.row.children[0]?.id;
        if (firstChildId) {
          pendingFocusRef.current = {
            kind: nextType === 'array' ? 'val' : 'key',
            rowId: firstChildId,
          };
        }
      } else {
        pendingFocusRef.current = { kind: 'val', rowId };
      }

      if (withUndo) {
        pushEditorUndoToast(tJson('toastChangedRowType'), snap);
      }
    },
    [captureSnapshot, makeRow, pushEditorUndoToast, rootKind, rows, tJson],
  );

  const handlePickRowType = useCallback(
    (rowId: string, nextType: KvRowValueType) => {
      setOpenTypeMenuRowId(null);
      const found = findRowAndParent(rows, rowId, rootKind);
      if (!found) return;
      const r = found.row;
      const prevType = r.type;
      if (prevType === nextType) {
        pendingFocusRef.current = { kind: 'type', rowId: r.id };
        return;
      }

      const prevChildren = r.children;
      const committedChildren =
        prevType === 'object' || prevType === 'array'
          ? prevChildren.filter((c, cIdx) =>
              !isEffectivePlaceholderRow(c, cIdx, prevChildren, prevType),
            )
          : [];

      // RFD-23: Confirm when changing a container row with >=1 committed child to a scalar type
      if (
        (prevType === 'object' || prevType === 'array') &&
        nextType !== 'object' &&
        nextType !== 'array' &&
        committedChildren.length > 0
      ) {
        setInlinePrompt({
          kind: 'switch-row-type',
          rowId: r.id,
          prevType,
          nextType,
          count: committedChildren.length,
          restoreFocusDesc: { kind: 'type', rowId: r.id },
        });
        return;
      }

      // RFD-20 / RFD-13: Confirm when switching a nested container between Object and Array with committed children
      if (prevType === 'object' && nextType === 'array') {
        const keysWithNames = committedChildren.filter((c) => c.key !== '');
        if (keysWithNames.length > 0) {
          setInlinePrompt({
            kind: 'switch-row-type',
            rowId: r.id,
            prevType,
            nextType,
            count: keysWithNames.length,
            restoreFocusDesc: { kind: 'type', rowId: r.id },
          });
          return;
        }
      } else if (prevType === 'array' && nextType === 'object') {
        if (committedChildren.length > 0) {
          setInlinePrompt({
            kind: 'switch-row-type',
            rowId: r.id,
            prevType,
            nextType,
            count: committedChildren.length,
            restoreFocusDesc: { kind: 'type', rowId: r.id },
          });
          return;
        }
      }

      applyRowTypeChange(r.id, prevType, nextType, false);
    },
    [applyRowTypeChange, rootKind, rows],
  );

  const handleSwitchMode = useCallback(
    (targetMode: JsonCardMode) => {
      if (targetMode === mode) return;
      if (targetMode === 'raw') {
        const nextRaw = normalizeEolToLf(tableSerializedSource);
        setRawDraftValue(nextRaw);
        setRawEditedSinceSwitch(false);
        const issue = validateRawJsonText(nextRaw);
        setRawSettledIssue(issue);
        setSwitchBlockedError(null);
        setMode('raw');
        return;
      }

      // Switching Raw -> Table
      // RFD-22: Only block Raw -> Table on syntax error if the user actually edited Raw since switching from Table
      if (!rawEditedSinceSwitch) {
        setRawSettledIssue(null);
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

      const res = loadFromJsonString(rawDraftValue, {
        preserveRawSource: true,
        markFromRaw: true,
      });
      if (!res.ok) {
        if (res.reason === 'scalar') {
          setSwitchBlockedError(
            tJson('kvScalarRootBlocked', { kind: res.scalarKind ?? 'primitive' }),
          );
          return;
        }
        setSwitchBlockedError(tJson('switchBlockedInvalidError'));
        return;
      }

      setRawEditedSinceSwitch(false);
      setRawSettledIssue(null);
      setSwitchBlockedError(null);
      setMode('table');
    },
    [
      loadFromJsonString,
      mode,
      rawDraftValue,
      rawEditedSinceSwitch,
      tJson,
      tableSerializedSource,
    ],
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
    if (mode === 'table' && (hasRowErrors || isBlankInTable)) return;
    if (isOverCap || utf8ByteLength === 0 || !vault) return;

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
    hasRowErrors,
    isBlankInTable,
    isOverCap,
    itemId,
    mode,
    onAnnounce,
    savingInFlight,
    translateContentError,
    unconfirmedCreate,
    utf8ByteLength,
    vault,
  ]);

  const handleRetryNew = useCallback(async () => {
    if (!unconfirmedCreate || saveLockRef.current || savingInFlight) return;
    const ownerId = ++nextSaveOwnerIdRef.current;
    saveOwnerIdRef.current = ownerId;
    saveLockRef.current = true;
    await executeCreate(unconfirmedCreate.sealed, true, ownerId);
  }, [executeCreate, savingInFlight, unconfirmedCreate]);

  // Menu keyboard handler (RFD-7 / RFD-26: ArrowDown, ArrowUp, Home, End, Escape, Tab, typeahead)
  const handleMenuKeyDown = useCallback(
    (
      e: KeyboardEvent<HTMLElement>,
      popEl: HTMLElement | null,
      closeAndRestoreFn: (restoreFocus: boolean) => void,
    ): boolean => {
      if (!popEl) return false;
      const items = Array.from(
        popEl.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'),
      ).filter((el) => !el.disabled);
      if (items.length === 0) return false;
      const cur = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        items[(cur + 1) % items.length]?.focus();
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        items[(cur - 1 + items.length) % items.length]?.focus();
        return true;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        e.stopPropagation();
        items[0]?.focus();
        return true;
      }
      if (e.key === 'End') {
        e.preventDefault();
        e.stopPropagation();
        items[items.length - 1]?.focus();
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeAndRestoreFn(true);
        return true;
      }
      if (e.key === 'Tab') {
        // RFD-26: Focus the trigger synchronously before native Tab runs so sequential focus continues from the trigger
        closeAndRestoreFn(true);
        return true;
      }
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const ch = e.key.toLowerCase();
        const match =
          items.find(
            (item, idx) =>
              idx > cur && (item.textContent || '').trim().toLowerCase().startsWith(ch),
          ) ??
          items.find((item) =>
            (item.textContent || '').trim().toLowerCase().startsWith(ch),
          );
        if (match) {
          e.preventDefault();
          e.stopPropagation();
          match.focus();
          return true;
        }
      }
      return false;
    },
    [],
  );

  const handleRowKeyChange = useCallback((rowId: string, nextKey: string) => {
    setCanonicalRawText(null);
    setSwitchBlockedError(null);
    setDiscardConfirmOpen(false);
    setRows((prevRows) =>
      updateRowById(prevRows, rowId, (r) => ({
        ...r,
        key: nextKey,
        placeholder: false,
        fromRaw: false,
        rawKeyLiteral: null,
        keyHasUnsafeChars:
          nextKey.includes('\r') ||
          nextKey.includes('\n') ||
          hasLoneSurrogateInStr(nextKey),
      })),
    );
  }, []);

  const handleRowValueChange = useCallback((rowId: string, nextVal: string) => {
    setCanonicalRawText(null);
    setSwitchBlockedError(null);
    setDiscardConfirmOpen(false);
    setRows((prevRows) =>
      updateRowById(prevRows, rowId, (r) => ({
        ...r,
        value: nextVal,
        placeholder: false,
        rawValueLiteral: null,
        hasCarriageReturn: nextVal.includes('\r'),
        hasLoneSurrogate: hasLoneSurrogateInStr(nextVal),
      })),
    );
  }, []);

  const handleAddRowToParent = useCallback(
    (parentRowId: string | null) => {
      setOpenTypeMenuRowId(null);
      setOpenRowMenuRowId(null);
      setCanonicalRawText(null);
      const created = makeRow({ key: '', value: '', type: 'string', placeholder: true });
      if (!parentRowId || parentRowId === 'root') {
        setRows((prev) => [...prev, created]);
        pendingFocusRef.current = {
          kind: rootKind === 'array' ? 'val' : 'key',
          rowId: created.id,
        };
      } else {
        const found = findRowAndParent(rows, parentRowId, rootKind);
        if (found && (found.row.type === 'object' || found.row.type === 'array')) {
          const targetKind = found.row.type;
          setRows((prev) =>
            updateRowById(prev, parentRowId, (r) => ({
              ...r,
              expanded: true,
              children: [...r.children, created],
            })),
          );
          pendingFocusRef.current = {
            kind: targetKind === 'array' ? 'val' : 'key',
            rowId: created.id,
          };
        }
      }
    },
    [makeRow, rootKind, rows],
  );

  const handleInsertRowBelow = useCallback(
    (rowId: string) => {
      setOpenRowMenuRowId(null);
      const found = findRowAndParent(rows, rowId, rootKind);
      if (!found) return;
      setCanonicalRawText(null);
      const created = makeRow({ key: '', value: '', type: 'string', placeholder: true });
      const parentId = found.parentRow?.id ?? null;
      setRows((prev) =>
        updateRowListById(prev, parentId, parentId === null, (list) => {
          const next = [...list];
          next.splice(found.index + 1, 0, created);
          return next;
        }),
      );
      pendingFocusRef.current = {
        kind: found.parentKind === 'array' ? 'val' : 'key',
        rowId: created.id,
      };
    },
    [makeRow, rootKind, rows],
  );

  const handleMoveRow = useCallback(
    (rowId: string, direction: -1 | 1) => {
      setOpenRowMenuRowId(null);
      const found = findRowAndParent(rows, rowId, rootKind);
      if (!found) return;
      const targetIdx = found.index + direction;
      if (targetIdx < 0 || targetIdx >= found.list.length) return;
      setCanonicalRawText(null);
      const parentId = found.parentRow?.id ?? null;
      setRows((prev) =>
        updateRowListById(prev, parentId, parentId === null, (list) => {
          const next = [...list];
          const [moved] = next.splice(found.index, 1);
          if (moved) {
            next.splice(targetIdx, 0, moved);
          }
          return next;
        }),
      );
      pendingFocusRef.current = { kind: 'menu', rowId };
    },
    [rootKind, rows],
  );

  const handleDeleteRow = useCallback(
    (rowId: string) => {
      setOpenRowMenuRowId(null);
      const found = findRowAndParent(rows, rowId, rootKind);
      if (!found) return;
      setCanonicalRawText(null);
      const parentId = found.parentRow?.id ?? null;
      if (found.list.length <= 1) {
        const replacement = makeRow({ key: '', value: '', type: 'string', placeholder: true });
        setRows((prev) =>
          updateRowListById(prev, parentId, parentId === null, () => [replacement]),
        );
        pendingFocusRef.current = {
          kind: found.parentKind === 'array' ? 'val' : 'key',
          rowId: replacement.id,
        };
      } else {
        const nextIdx = Math.max(0, Math.min(found.index, found.list.length - 2));
        const nextTarget = found.list.filter((_, idx) => idx !== found.index)[nextIdx];
        setRows((prev) =>
          updateRowListById(prev, parentId, parentId === null, (list) =>
            list.filter((_, idx) => idx !== found.index),
          ),
        );
        if (nextTarget) {
          pendingFocusRef.current = {
            kind: found.parentKind === 'array' ? 'val' : 'key',
            rowId: nextTarget.id,
          };
        }
      }
    },
    [makeRow, rootKind, rows],
  );

  const handleSuggestNumber = useCallback(
    (rowId: string) => {
      const found = findRowAndParent(rows, rowId, rootKind);
      if (!found) return;
      setCanonicalRawText(null);
      setRows((prev) =>
        updateRowById(prev, rowId, (r) => ({
          ...r,
          type: 'number',
          value: r.value.trim(),
          placeholder: false,
          fromRaw: false,
          rawValueLiteral: null,
        })),
      );
      pendingFocusRef.current = { kind: 'val', rowId };
      onAnnounce?.(tJson('toastSwitchedToNumber'));
    },
    [onAnnounce, rootKind, rows, tJson],
  );

  // Paste handler (RFD-4, RFD-16, RFD-19, RFD-25, RFD-27, RFD-32)
  const handleRowPaste = useCallback(
    (e: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>, rowId: string, isValueInput: boolean) => {
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;

      const found = findRowAndParent(rows, rowId, rootKind);
      if (!found) return;

      // RFD-32 (advisor-dec-373): Paste into a value field is ALWAYS verbatim (multi-line text stays in that value).
      // Key-value line parser and JSON container parser only run when pasting into an empty Key field
      // (or into an empty Array item value when the entire editor is blank and the paste is JSON/multi-line).
      const targetEl = e.currentTarget;
      if (targetEl.value !== '') {
        // Non-empty input: let browser paste verbatim into the field
        return;
      }

      if (isValueInput && found.parentKind === 'object') {
        // Pasting into an Object row's Value field is always verbatim per RFD-32
        return;
      }

      const trimmed = text.trim();
      if (
        !text.includes('\n') &&
        !text.includes(':') &&
        !text.includes('=') &&
        !trimmed.startsWith('{') &&
        !trimmed.startsWith('[')
      ) {
        return;
      }
      // RF-6: In an Array container, only split/intercept paste into an empty value when the editor is blank
      // or the row is the trailing placeholder row; cleared middle items keep verbatim multi-line paste.
      const isTrailingArrayPlaceholder =
        found.parentKind === 'array' &&
        found.index === found.list.length - 1 &&
        isEffectivePlaceholderRow(found.row, found.index, found.list, 'array');
      if (isValueInput && found.parentKind === 'array' && hasAnyCommittedRow && !isTrailingArrayPlaceholder) {
        return;
      }

      // For an empty Array trailing placeholder (or blank editor), allow multi-line / JSON array paste
      const parsedPaste = parseMultiLineKeyValuePaste(text, found.parentKind, false);
      if (!parsedPaste) return;

      // In an Array container, do not intercept key:value pairs into an item value
      if (isValueInput && found.parentKind === 'array' && parsedPaste.kind === 'pairs') {
        return;
      }
      const snap = captureSnapshot();
      const isEditorBlank = !hasAnyCommittedRow;

      const insertRowsAtFound = (newRows: readonly KvRow[]) => {
        const parentId = found.parentRow?.id ?? null;
        const replaceCurrent =
          isEffectivePlaceholderRow(found.row, found.index, found.list, found.parentKind) &&
          isRowCompletelyBlank(found.row, found.parentKind);
        setRows((prev) =>
          updateRowListById(prev, parentId, parentId === null, (list) => {
            const next = [...list];
            if (replaceCurrent) {
              next.splice(found.index, 1, ...newRows);
            } else {
              next.splice(found.index + 1, 0, ...newRows);
            }
            return next;
          }),
        );
      };

      if (parsedPaste.kind === 'json') {
        e.preventDefault();
        const pastedRoot = parsedPaste.root;
        if (isEditorBlank) {
          const loaded = loadFromJsonString(parsedPaste.rawText, {
            preserveRawSource: false,
            markFromRaw: false,
          });
          if (loaded.ok && loaded.nextRows[0]) {
            pendingFocusRef.current = {
              kind: loaded.nextKind === 'array' ? 'val' : 'key',
              rowId: loaded.nextRows[0].id,
            };
          }
          pushEditorUndoToast(tJson('toastFilledFromJson'), snap);
          return;
        }

        if (pastedRoot.kind === found.parentKind) {
          const newRows =
            pastedRoot.kind === 'object'
              ? pastedRoot.properties.map((p) => ({
                  ...astNodeToRow(p.valueNode, p.key),
                  fromRaw: false,
                }))
              : pastedRoot.elements.map((el) => ({
                  ...astNodeToRow(el, ''),
                  fromRaw: false,
                }));
          if (newRows.length === 0) return;
          setCanonicalRawText(null);
          insertRowsAtFound(newRows);
          const lastInserted = newRows[newRows.length - 1]!;
          pendingFocusRef.current = {
            kind: found.parentKind === 'array' ? 'val' : 'key',
            rowId: lastInserted.id,
          };
          pushEditorUndoToast(
            tJson('toastInsertedRowsFromJson', { count: newRows.length }),
            snap,
          );
          return;
        }

        // Shape mismatch on non-empty editor: ask inline instead of clobbering (RFD-25, RFD-27)
        setInlinePrompt({
          kind: 'paste-mismatch',
          pastedRawText: parsedPaste.rawText,
          pastedRoot,
          targetRowId: found.row.id,
          restoreFocusDesc: { kind: isValueInput ? 'val' : 'key', rowId: found.row.id },
        });
        return;
      }

      if (parsedPaste.kind === 'pairs' && found.parentKind === 'object') {
        e.preventDefault();
        setCanonicalRawText(null);
        const newRows = parsedPaste.pairs.map((pair) =>
          makeRow({
            key: pair.key,
            value: pair.value,
            type: 'string',
            placeholder: false,
          }),
        );
        insertRowsAtFound(newRows);
        const lastInserted = newRows[newRows.length - 1]!;
        pendingFocusRef.current = { kind: 'val', rowId: lastInserted.id };
        pushEditorUndoToast(tJson('toastFilledRowsFromPaste', { count: newRows.length }), snap);
        return;
      }

      if (parsedPaste.kind === 'lines' && found.parentKind === 'array') {
        e.preventDefault();
        setCanonicalRawText(null);
        const newRows = parsedPaste.items.map((item) =>
          makeRow({
            key: '',
            value: item,
            type: 'string',
            placeholder: false,
          }),
        );
        insertRowsAtFound(newRows);
        const lastInserted = newRows[newRows.length - 1]!;
        pendingFocusRef.current = { kind: 'val', rowId: lastInserted.id };
        pushEditorUndoToast(
          tJson('toastFilledItemsFromPaste', { count: newRows.length }),
          snap,
        );
      }
    },
    [
      astNodeToRow,
      captureSnapshot,
      hasAnyCommittedRow,
      loadFromJsonString,
      makeRow,
      pushEditorUndoToast,
      rootKind,
      rows,
      tJson,
    ],
  );

  // Keydown inside kvHost (Enter row nav, Shift+Enter newline in value, Backspace empty row, Alt+ArrowDown type menu, menu nav)
  const handleKvHostKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;

      const host = kvHostRef.current;
      if (host && (openTypeMenuRowId || openRowMenuRowId)) {
        const openPop = host.querySelector<HTMLElement>('[data-kv-menu-pop]');
        if (openPop) {
          const isType = Boolean(openTypeMenuRowId);
          const rId = (openTypeMenuRowId ?? openRowMenuRowId)!;
          const handled = handleMenuKeyDown(e, openPop, (restoreFocus) => {
            setOpenTypeMenuRowId(null);
            setOpenRowMenuRowId(null);
            if (restoreFocus) {
              const selector = isType
                ? `[data-kv-act="toggle-type-menu"][data-row-id="${rId}"]`
                : `[data-kv-act="toggle-row-menu"][data-row-id="${rId}"]`;
              host.querySelector<HTMLElement>(selector)?.focus();
            }
          });
          if (handled) return;
        }
      }

      const target = e.target as HTMLElement | null;
      if (!target) return;
      const keyInp = target.closest<HTMLInputElement>('[data-kv-key-input]');
      const valInp = target.closest<HTMLInputElement | HTMLTextAreaElement>('[data-kv-val-input]');
      const typeTrigger = target.closest<HTMLButtonElement>('[data-kv-act="toggle-type-menu"]');
      const rowMenuTrigger = target.closest<HTMLButtonElement>('[data-kv-act="toggle-row-menu"]');

      if (
        (e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
        !e.altKey &&
        (typeTrigger || rowMenuTrigger)
      ) {
        e.preventDefault();
        const rId = (typeTrigger ?? rowMenuTrigger)!.dataset.rowId;
        if (!rId) return;
        if (typeTrigger) {
          setOpenRowMenuRowId(null);
          setOpenRootMenu(false);
          setOpenTypeMenuRowId(rId);
          pendingFocusRef.current = { kind: 'type-menu-item', rowId: rId };
        } else {
          setOpenTypeMenuRowId(null);
          setOpenRootMenu(false);
          setOpenRowMenuRowId(rId);
          pendingFocusRef.current = { kind: 'row-menu-item', rowId: rId };
        }
        return;
      }

      // Alt+ArrowDown from key or value input opens the row's Type menu directly (RFD-6)
      if (e.altKey && e.key === 'ArrowDown' && (keyInp || valInp)) {
        e.preventDefault();
        const rId = keyInp ? keyInp.dataset.kvKeyInput : valInp?.dataset.kvValInput;
        if (!rId) return;
        setOpenRowMenuRowId(null);
        setOpenRootMenu(false);
        setOpenTypeMenuRowId(rId);
        pendingFocusRef.current = { kind: 'type-menu-item', rowId: rId };
        return;
      }

      if (keyInp) {
        const rId = keyInp.dataset.kvKeyInput;
        if (!rId) return;
        const found = findRowAndParent(rows, rId, rootKind);
        if (!found) return;

        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          // RFD-28: On an untouched blank placeholder row in a nested container, Enter outdents to a new row after the parent
          if (
            found.index === found.list.length - 1 &&
            isRowCompletelyBlank(found.row, 'object') &&
            found.parentRow
          ) {
            const parentFound = findRowAndParent(rows, found.parentRow.id, rootKind);
            if (parentFound) {
              const outdentedRow = makeRow({
                key: '',
                value: '',
                type: 'string',
                placeholder: true,
              });
              const nestedParentId = found.parentRow.id;
              const grandParentId = parentFound.parentRow?.id ?? null;
              setRows((prev) => {
                let next = prev;
                if (found.list.length > 1) {
                  next = updateRowListById(next, nestedParentId, false, (list) =>
                    list.filter((_, idx) => idx !== found.index),
                  );
                }
                next = updateRowListById(
                  next,
                  grandParentId,
                  grandParentId === null,
                  (list) => {
                    const copy = [...list];
                    copy.splice(parentFound.index + 1, 0, outdentedRow);
                    return copy;
                  },
                );
                return next;
              });
              pendingFocusRef.current = {
                kind: parentFound.parentKind === 'array' ? 'val' : 'key',
                rowId: outdentedRow.id,
              };
              return;
            }
          }
          pendingFocusRef.current = { kind: 'val', rowId: rId, select: true };
          // Trigger re-render or focus directly if no state changed
          const valEl =
            host?.querySelector<HTMLElement>(`[data-kv-val-input="${rId}"]`) ??
            host?.querySelector<HTMLElement>(
              `[data-kv-act="toggle-type-menu"][data-row-id="${rId}"]`,
            );
          if (valEl) {
            pendingFocusRef.current = null;
            valEl.focus();
            if ('select' in valEl && typeof (valEl as HTMLInputElement).select === 'function') {
              (valEl as HTMLInputElement).select();
            }
          }
          return;
        }

        // RFD-11: Only delete row on Backspace when the entire row is a blank string row
        if (
          e.key === 'Backspace' &&
          keyInp.value === '' &&
          isRowCompletelyBlank(found.row, 'object') &&
          found.list.length > 1
        ) {
          e.preventDefault();
          const prevIdx = Math.max(0, found.index - 1);
          const targetRow = found.list.filter((_, idx) => idx !== found.index)[prevIdx];
          const parentId = found.parentRow?.id ?? null;
          setRows((prev) =>
            updateRowListById(prev, parentId, parentId === null, (list) =>
              list.filter((_, idx) => idx !== found.index),
            ),
          );
          if (targetRow) {
            pendingFocusRef.current = { kind: 'val', rowId: targetRow.id };
          }
          return;
        }
      }

      if (valInp) {
        const rId = valInp.dataset.kvValInput;
        if (!rId) return;
        const found = findRowAndParent(rows, rId, rootKind);
        if (!found) return;
        const isTextarea = valInp.tagName === 'TEXTAREA';

        // RFD-32 (advisor-dec-373): Shift+Enter inserts a newline in string value textarea; plain Enter navigates rows
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
          if (isTextarea && e.shiftKey && found.row.type === 'string') {
            // Allow native Shift+Enter newline insertion in the auto-growing textarea
            return;
          }
          e.preventDefault();
          if (found.index < found.list.length - 1) {
            const nextRow = found.list[found.index + 1]!;
            const nextKind = found.parentKind === 'array' ? 'val' : 'key';
            const nextSelector =
              nextKind === 'val'
                ? `[data-kv-val-input="${nextRow.id}"]`
                : `[data-kv-key-input="${nextRow.id}"]`;
            const nextEl = host?.querySelector<HTMLElement>(nextSelector);
            if (nextEl) {
              nextEl.focus();
              if ('select' in nextEl && typeof (nextEl as HTMLInputElement).select === 'function') {
                (nextEl as HTMLInputElement).select();
              }
            } else {
              pendingFocusRef.current = { kind: nextKind, rowId: nextRow.id, select: true };
            }
          } else if (isRowCompletelyBlank(found.row, found.parentKind) && !found.row.fromRaw) {
            // RFD-28: Do not pile up extra blank placeholder rows on repeated Enter; outdent if inside a nested container
            if (found.parentRow) {
              const parentFound = findRowAndParent(rows, found.parentRow.id, rootKind);
              if (parentFound) {
                const outdentedRow = makeRow({
                  key: '',
                  value: '',
                  type: 'string',
                  placeholder: true,
                });
                const nestedParentId = found.parentRow.id;
                const grandParentId = parentFound.parentRow?.id ?? null;
                setRows((prev) => {
                  let next = prev;
                  if (found.list.length > 1) {
                    next = updateRowListById(next, nestedParentId, false, (list) =>
                      list.filter((_, idx) => idx !== found.index),
                    );
                  }
                  next = updateRowListById(
                    next,
                    grandParentId,
                    grandParentId === null,
                    (list) => {
                      const copy = [...list];
                      copy.splice(parentFound.index + 1, 0, outdentedRow);
                      return copy;
                    },
                  );
                  return next;
                });
                pendingFocusRef.current = {
                  kind: parentFound.parentKind === 'array' ? 'val' : 'key',
                  rowId: outdentedRow.id,
                };
                return;
              }
            }
            const selfSelector =
              found.parentKind === 'array'
                ? `[data-kv-val-input="${found.row.id}"]`
                : `[data-kv-key-input="${found.row.id}"]`;
            host?.querySelector<HTMLElement>(selfSelector)?.focus();
          } else {
            const created = makeRow({ key: '', value: '', type: 'string', placeholder: true });
            const parentId = found.parentRow?.id ?? null;
            setRows((prev) =>
              updateRowListById(prev, parentId, parentId === null, (list) => [...list, created]),
            );
            pendingFocusRef.current = {
              kind: found.parentKind === 'array' ? 'val' : 'key',
              rowId: created.id,
            };
          }
          return;
        }

        // RFD-6: Leave Tab native so focus visits Số? -> Type chip -> Row menu -> next row
        if (
          e.key === 'Backspace' &&
          valInp.value === '' &&
          isRowCompletelyBlank(found.row, found.parentKind) &&
          found.list.length > 1
        ) {
          e.preventDefault();
          const prevIdx = Math.max(0, found.index - 1);
          const targetRow = found.list.filter((_, idx) => idx !== found.index)[prevIdx];
          const parentId = found.parentRow?.id ?? null;
          setRows((prev) =>
            updateRowListById(prev, parentId, parentId === null, (list) =>
              list.filter((_, idx) => idx !== found.index),
            ),
          );
          if (targetRow) {
            pendingFocusRef.current = {
              kind: found.parentKind === 'array' ? 'val' : 'key',
              rowId: targetRow.id,
            };
          }
        }
      }
    },
    [handleMenuKeyDown, makeRow, openRowMenuRowId, openTypeMenuRowId, rootKind, rows],
  );

  // Handle inline confirmation prompt actions
  const handlePromptAction = useCallback(
    (act: 'confirm-root-switch' | 'confirm-row-type' | 'paste-replace' | 'paste-nest' | 'dismiss') => {
      if (!inlinePrompt) return;
      const st = inlinePrompt;
      setInlinePrompt(null);

      if (act === 'confirm-root-switch' && st.kind === 'switch-root') {
        applyRootKindSwitch(st.nextKind, true);
        return;
      }
      if (act === 'confirm-row-type' && st.kind === 'switch-row-type') {
        applyRowTypeChange(st.rowId, st.prevType, st.nextType, true);
        return;
      }
      if (act === 'paste-replace' && st.kind === 'paste-mismatch') {
        const snap = captureSnapshot();
        const loaded = loadFromJsonString(st.pastedRawText, {
          preserveRawSource: false,
          markFromRaw: false,
        });
        if (loaded.ok && loaded.nextRows[0]) {
          pendingFocusRef.current = {
            kind: loaded.nextKind === 'array' ? 'val' : 'key',
            rowId: loaded.nextRows[0].id,
          };
        }
        pushEditorUndoToast(tJson('toastReplacedWithJson'), snap);
        return;
      }
      if (act === 'paste-nest' && st.kind === 'paste-mismatch') {
        const snap = captureSnapshot();
        const found = findRowAndParent(rows, st.targetRowId, rootKind);
        if (found) {
          setCanonicalRawText(null);
          // RFD-27: Preserve the row's existing key verbatim (even if empty, so EMPTY_KEY flags it instead of inventing 'data')
          const preservedKey = found.parentKind === 'object' ? found.row.key : '';
          const built = astNodeToRow(st.pastedRoot, preservedKey);
          const nestedRow: KvRow = {
            ...built,
            fromRaw: false,
            rawKeyLiteral: null,
            children: built.children.map((c) => ({ ...c, fromRaw: false })),
          };
          const parentId = found.parentRow?.id ?? null;
          setRows((prev) =>
            updateRowListById(prev, parentId, parentId === null, (list) => {
              const copy = [...list];
              copy.splice(found.index, 1, nestedRow);
              return copy;
            }),
          );
          const focusKind =
            found.parentKind === 'object' && preservedKey === ''
              ? 'key'
              : found.parentKind === 'array'
                ? 'val'
                : 'key';
          pendingFocusRef.current = { kind: focusKind, rowId: nestedRow.id };
          pushEditorUndoToast(tJson('toastReplacedRowWithJson'), snap);
        }
        return;
      }
      if (act === 'dismiss') {
        pendingFocusRef.current = st.restoreFocusDesc;
      }
    },
    [
      applyRootKindSwitch,
      applyRowTypeChange,
      astNodeToRow,
      captureSnapshot,
      inlinePrompt,
      loadFromJsonString,
      pushEditorUndoToast,
      rootKind,
      rows,
      tJson,
    ],
  );

  // Card-level keyboard shortcuts (Ctrl/⌘+S save, Escape layered dismissal)
  const handleComposerKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const keyLower = (e.key || '').toLowerCase();
    if (keyLower === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!saveDisabled) {
        void handleSaveNew();
      }
      return;
    }
    if (e.key === 'Escape') {
      if (openRootMenu) {
        e.preventDefault();
        e.stopPropagation();
        setOpenRootMenu(false);
        rootMenuBtnRef.current?.focus();
        return;
      }
      if (openTypeMenuRowId || openRowMenuRowId) {
        e.preventDefault();
        e.stopPropagation();
        const restoreTypeId = openTypeMenuRowId;
        const restoreMenuId = openRowMenuRowId;
        setOpenTypeMenuRowId(null);
        setOpenRowMenuRowId(null);
        pendingFocusRef.current = restoreTypeId
          ? { kind: 'type', rowId: restoreTypeId }
          : { kind: 'menu', rowId: restoreMenuId ?? undefined };
        return;
      }
      if (inlinePrompt) {
        e.preventDefault();
        e.stopPropagation();
        const restore = inlinePrompt.restoreFocusDesc;
        setInlinePrompt(null);
        pendingFocusRef.current = restore;
        return;
      }
      if (discardConfirmOpen) {
        e.preventDefault();
        e.stopPropagation();
        setDiscardConfirmOpen(false);
        return;
      }
      if (mode === 'table') {
        e.preventDefault();
        e.stopPropagation();
        requestCancel();
      }
    }
  };

  const renderTypeChipLabel = (t: KvRowValueType): string => {
    switch (t) {
      case 'number':
        return tJson('kvTypeChipNumber');
      case 'boolean':
        return tJson('kvTypeChipBoolean');
      case 'null':
        return tJson('kvTypeChipNull');
      case 'object':
        return tJson('kvTypeChipObject');
      case 'array':
        return tJson('kvTypeChipArray');
      default:
        return tJson('kvTypeChipString');
    }
  };

  const renderRowsList = (
    list: readonly KvRow[],
    parentKind: KvContainerKind,
    depth: number,
    parentRowId: string,
    pathPrefix: string,
  ): React.ReactNode => {
    const isArr = parentKind === 'array';
    const isRootLevel = depth === 0;
    const addBtnLabel =
      depth > 0
        ? isArr
          ? tJson('kvAddArrayItemNestedBtn')
          : tJson('kvAddObjectRowNestedBtn')
        : isArr
          ? tJson('kvAddArrayItemRootBtn')
          : tJson('kvAddObjectRowRootBtn');

    const colHeader = isRootLevel ? (
      <div
        className={`kv-col-head ${isArr ? 'kv-col-head-arr' : ''}`}
        aria-hidden="true"
      >
        <span>{isArr ? tJson('colIndex') : tJson('colField')}</span>
        <span>{tJson('colValue')}</span>
        <span>{tJson('kvColType')}</span>
        <span className="sr-only">Menu</span>
      </div>
    ) : null;

    if (list.length === 0) {
      return (
        <div key={`empty-${parentRowId}`}>
          {colHeader}
          <div className="kv-empty-container">
            <span className="mono">
              {isArr ? tJson('emptyArray') : tJson('emptyObject')}
            </span>
            <button
              type="button"
              disabled={savingInFlight}
              data-testid={`json-open-add-field-${parentRowId}`}
              data-kv-act="add-row"
              data-parent-id={parentRowId}
              className="btn btn-tertiary btn-sm"
              onClick={() => handleAddRowToParent(parentRowId)}
            >
              {addBtnLabel}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div key={`list-${parentRowId}`}>
        {colHeader}
        <ul
          className="kv-rows"
          role="list"
          aria-label={
            isRootLevel
              ? isArr
                ? tJson('kvArrayItemsListAria')
                : tJson('kvObjectFieldsListAria')
              : tJson('kvNestedRowsListAria')
          }
        >
          {list.map((r, idx) => {
            const rowNum = idx + 1;
            const err = errorsMap.get(r.id);
            const keyErr = err?.key ?? null;
            const valErr = err?.value ?? null;
            const keyErrId = keyErr ? `kv-err-key-${r.id}` : undefined;
            const valErrId = valErr ? `kv-err-val-${r.id}` : undefined;
            const isInvalid = Boolean(keyErr || valErr);

            const ctxPrefix = pathPrefix ? `${pathPrefix} › ` : '';
            const rowLabelText = isArr
              ? `${ctxPrefix}${tJson('kvRowGroupArrayAria', { row: rowNum })}`
              : r.key
                ? `${ctxPrefix}${tJson('kvRowGroupObjectNamedAria', { row: rowNum, key: r.key })}`
                : `${ctxPrefix}${tJson('kvRowGroupObjectAria', { row: rowNum })}`;

            const occIdx = occurrenceMap.get(r.id) ?? 0;
            const hasOccBadge = !isArr && occIdx >= 1;
            const keyWarnId = `kv-warn-key-${r.id}`;
            const hasKeySpaceWarn =
              !isArr && !keyErr && r.key !== '' && r.key !== r.key.trim();
            const keyDescribedBy = keyErr
              ? keyErrId
              : hasKeySpaceWarn
                ? keyWarnId
                : undefined;

            const hasNumberSuggest =
              r.type === 'string' &&
              !r.hasCarriageReturn &&
              !r.hasLoneSurrogate &&
              !r.value.includes('\n') &&
              r.value.trim() !== '' &&
              isValidJsonNumberLexeme(r.value.trim());

            const isTypeOpen = openTypeMenuRowId === r.id;
            const isRowMenuOpen = openRowMenuRowId === r.id;

            const multilineLines =
              r.type === 'string' && r.value.includes('\n')
                ? r.value.split('\n')
                : null;
            const isLongMultiline = Boolean(multilineLines && multilineLines.length > 3);
            const isMultilineExpanded = expandedMultilineRows.has(r.id);
            const textareaRows = multilineLines
              ? isLongMultiline && !isMultilineExpanded
                ? 3
                : Math.min(8, Math.max(2, multilineLines.length))
              : 1;

            const isFirstRootRow = isRootLevel && idx === 0;

            return (
              <li
                key={r.id}
                data-kv-row={r.id}
                data-testid={`kv-row-${r.id}`}
                role="group"
                aria-label={rowLabelText}
                className={`kv-row ${isInvalid ? 'is-invalid' : ''}`}
              >
                <div className={`kv-row-grid ${isArr ? 'kv-row-grid-arr' : ''}`}>
                  {/* Column 1: Key input or Array index */}
                  {isArr ? (
                    <div className="kv-idx" aria-hidden="true">
                      {rowNum}
                    </div>
                  ) : r.keyHasUnsafeChars ? (
                    <div className="kv-cell kv-cell-key">
                      <div
                        className="kv-readonly-cell"
                        tabIndex={0}
                        role="textbox"
                        aria-readonly="true"
                        aria-label={`${ctxPrefix}${tJson('kvKeyReadOnlyAria', { row: rowNum })}`}
                      >
                        <span>{formatReadOnlyStringSafe(r.key)}</span>
                        <span className="badge-type badge-ok text-[10px]">
                          {tJson('kvReadOnlyBadge')}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="kv-cell kv-cell-key">
                      <div className={`kv-key-wrap ${hasOccBadge ? 'has-occ' : ''}`}>
                        <input
                          id={`kv-key-${r.id}`}
                          type="text"
                          disabled={savingInFlight}
                          data-kv-key-input={r.id}
                          data-testid={
                            isFirstRootRow ? 'json-new-key-input-root' : `kv-key-input-${r.id}`
                          }
                          value={r.key}
                          placeholder={tJson('kvKeyPlaceholder')}
                          aria-label={`${ctxPrefix}${tJson('kvKeyInputAria', { row: rowNum })}`}
                          aria-invalid={keyErr ? 'true' : undefined}
                          aria-describedby={keyDescribedBy}
                          className="kv-input kv-input-key"
                          {...VAULT_SECRET_INPUT_PROPS}
                          onChange={(e) => handleRowKeyChange(r.id, e.target.value)}
                          onPaste={(e) => handleRowPaste(e, r.id, false)}
                        />
                        {hasOccBadge ? (
                          <span
                            className="kv-occ-badge"
                            aria-label={tJson('duplicateKeyAria', { index: occIdx + 1 })}
                            title={tJson('duplicateKeyTitle', { index: occIdx + 1 })}
                          >
                            {`⁽${toSuperscriptNumber(occIdx + 1)}⁾`}
                          </span>
                        ) : null}
                      </div>
                      {hasKeySpaceWarn ? (
                        <p
                          id={keyWarnId}
                          data-testid={`kv-warn-key-${r.id}`}
                          className="m-0 mt-0.5 text-[11px] text-warning-ink"
                        >
                          {tJson('kvKeySpaceWarning')}
                        </p>
                      ) : null}
                      {keyErr ? (
                        <p
                          id={keyErrId}
                          data-testid={`kv-err-key-${r.id}`}
                          className="kv-row-err"
                        >
                          {keyErr.message}
                        </p>
                      ) : null}
                    </div>
                  )}

                  {/* Column 2: Value control */}
                  <div className="kv-cell kv-cell-val">
                    {r.type === 'string' && (r.hasCarriageReturn || r.hasLoneSurrogate) ? (
                      <div
                        className="kv-readonly-cell"
                        tabIndex={0}
                        role="textbox"
                        aria-readonly="true"
                        aria-label={`${ctxPrefix}${tJson('kvValReadOnlyAria', { row: rowNum })}`}
                        aria-describedby={`kv-ro-note-${r.id}`}
                      >
                        <span>{formatReadOnlyStringSafe(r.value)}</span>
                        <span
                          id={`kv-ro-note-${r.id}`}
                          className="badge-type badge-ok text-[10px]"
                        >
                          {tJson('kvReadOnlyReasonBadge')}
                        </span>
                      </div>
                    ) : r.type === 'string' ? (
                      <div>
                        <div
                          className={`kv-val-adorn-wrap ${hasNumberSuggest ? 'has-suggest' : ''}`}
                        >
                          <textarea
                            id={`kv-val-${r.id}`}
                            rows={textareaRows}
                            disabled={savingInFlight}
                            data-kv-val-input={r.id}
                            data-testid={
                              isFirstRootRow
                                ? 'json-new-val-input-root'
                                : `kv-val-input-${r.id}`
                            }
                            value={r.value}
                            placeholder={
                              isArr
                                ? tJson('kvValArrayPlaceholder', { row: rowNum })
                                : tJson('kvValPlaceholder')
                            }
                            aria-label={`${ctxPrefix}${tJson('kvValInputAria', { row: rowNum })}`}
                            aria-invalid={valErr ? 'true' : undefined}
                            aria-describedby={valErrId}
                            className="kv-input"
                            {...VAULT_SECRET_INPUT_PROPS}
                            onChange={(e) => handleRowValueChange(r.id, e.target.value)}
                            onPaste={(e) => handleRowPaste(e, r.id, true)}
                          />
                          {hasNumberSuggest ? (
                            <button
                              type="button"
                              disabled={savingInFlight}
                              data-kv-act="suggest-number"
                              data-row-id={r.id}
                              data-testid={`kv-num-suggest-${r.id}`}
                              aria-label={`${ctxPrefix}${tJson('kvSuggestNumberAria', { row: rowNum })}`}
                              title={tJson('kvSuggestNumberTitle')}
                              className="kv-num-suggest"
                              onClick={() => handleSuggestNumber(r.id)}
                            >
                              {tJson('kvSuggestNumberChip')}
                            </button>
                          ) : null}
                        </div>
                        {isLongMultiline ? (
                          <button
                            type="button"
                            data-testid={`kv-multiline-toggle-${r.id}`}
                            className="link-btn mt-0.5 block text-[11px]"
                            onClick={() =>
                              setExpandedMultilineRows((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.id)) next.delete(r.id);
                                else next.add(r.id);
                                return next;
                              })
                            }
                          >
                            {isMultilineExpanded
                              ? tJson('multilineCollapseBtn')
                              : tJson('multilineExpandBtn', { count: multilineLines!.length })}
                          </button>
                        ) : null}
                      </div>
                    ) : r.type === 'number' ? (
                      <div className="kv-val-adorn-wrap">
                        <input
                          id={`kv-val-${r.id}`}
                          type="text"
                          disabled={savingInFlight}
                          data-kv-val-input={r.id}
                          data-testid={
                            isFirstRootRow ? 'json-new-val-input-root' : `kv-val-input-${r.id}`
                          }
                          value={r.value}
                          placeholder={tJson('kvValNumberPlaceholder')}
                          aria-label={`${ctxPrefix}${tJson('kvValInputAria', { row: rowNum })}`}
                          aria-invalid={valErr ? 'true' : undefined}
                          aria-describedby={valErrId}
                          className="kv-input kv-input-num"
                          {...VAULT_SECRET_INPUT_PROPS}
                          onChange={(e) => handleRowValueChange(r.id, e.target.value)}
                        />
                      </div>
                    ) : r.type === 'boolean' ? (
                      <div
                        className="kv-bool-seg"
                        role="group"
                        aria-label={`${ctxPrefix}${tJson('kvBoolGroupAria', { row: rowNum })}`}
                      >
                        <button
                          type="button"
                          disabled={savingInFlight}
                          data-kv-act="set-bool"
                          data-row-id={r.id}
                          data-bool-val="true"
                          data-testid={`kv-bool-true-${r.id}`}
                          aria-pressed={r.value !== 'false'}
                          onClick={() => handleRowValueChange(r.id, 'true')}
                        >
                          true
                        </button>
                        <button
                          type="button"
                          disabled={savingInFlight}
                          data-kv-act="set-bool"
                          data-row-id={r.id}
                          data-bool-val="false"
                          data-testid={`kv-bool-false-${r.id}`}
                          aria-pressed={r.value === 'false'}
                          onClick={() => handleRowValueChange(r.id, 'false')}
                        >
                          false
                        </button>
                      </div>
                    ) : r.type === 'null' ? (
                      <div className="kv-null-pill" role="note">
                        <span aria-hidden="true">null</span>
                        <span className="sr-only">
                          {`${ctxPrefix}${tJson('kvNullPillSr', { row: rowNum })}`}
                        </span>
                      </div>
                    ) : r.type === 'object' || r.type === 'array' ? (
                      (() => {
                        const nonBlankCount = r.children.filter(
                          (c, cIdx) =>
                            !isEffectivePlaceholderRow(
                              c,
                              cIdx,
                              r.children,
                              r.type as KvContainerKind,
                            ),
                        ).length;
                        return (
                          <button
                            type="button"
                            disabled={savingInFlight}
                            data-kv-act="toggle-expand"
                            data-row-id={r.id}
                            data-testid={`kv-container-pill-${r.id}`}
                            aria-expanded={r.expanded}
                            aria-label={
                              r.type === 'object'
                                ? `${ctxPrefix}${tJson('kvContainerObjectSummary', { count: nonBlankCount })}`
                                : `${ctxPrefix}${tJson('kvContainerArraySummary', { count: nonBlankCount })}`
                            }
                            className="kv-container-pill"
                            onClick={() =>
                              setRows((prev) =>
                                updateRowById(prev, r.id, (row) => ({
                                  ...row,
                                  expanded: !row.expanded,
                                })),
                              )
                            }
                          >
                            <span className="caret" aria-hidden="true">
                              ›
                            </span>
                            <span className="kv-pill-full">
                              {r.type === 'object'
                                ? tJson('kvContainerObjectSummary', { count: nonBlankCount })
                                : tJson('kvContainerArraySummary', { count: nonBlankCount })}
                            </span>
                            <span className="kv-pill-compact" aria-hidden="true">
                              {r.type === 'object'
                                ? tJson('kvContainerObjectCompact', { count: nonBlankCount })
                                : tJson('kvContainerArrayCompact', { count: nonBlankCount })}
                            </span>
                          </button>
                        );
                      })()
                    ) : null}
                    {valErr ? (
                      <p
                        id={valErrId}
                        data-testid={`kv-err-val-${r.id}`}
                        className="kv-row-err"
                      >
                        {valErr.message}
                      </p>
                    ) : null}
                  </div>

                  {/* Column 3: Type chip & menu */}
                  <div className="kv-type-col">
                    <button
                      type="button"
                      disabled={savingInFlight}
                      data-kv-act="toggle-type-menu"
                      data-row-id={r.id}
                      data-kv-type={r.type}
                      data-testid={
                        isFirstRootRow ? 'json-new-type-select-root' : `kv-type-chip-${r.id}`
                      }
                      aria-haspopup="menu"
                      aria-expanded={isTypeOpen}
                      aria-label={`${ctxPrefix}${tJson('kvTypeChipAria', { row: rowNum })}`}
                      title={tJson('kvTypeChipTitle')}
                      className="kv-type-chip"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenRowMenuRowId(null);
                        setOpenRootMenu(false);
                        const willOpen = openTypeMenuRowId !== r.id;
                        setOpenTypeMenuRowId(willOpen ? r.id : null);
                        pendingFocusRef.current = {
                          kind: willOpen ? 'type-menu-item' : 'type',
                          rowId: r.id,
                        };
                      }}
                    >
                      <span className="truncate">{renderTypeChipLabel(r.type)}</span>
                      <span className="shrink-0 text-[11px] text-muted" aria-hidden="true">
                        ▾
                      </span>
                    </button>

                    {isTypeOpen ? (
                      <div
                        role="menu"
                        data-kv-menu-pop="type"
                        data-row-id={r.id}
                        data-testid={`kv-type-menu-${r.id}`}
                        aria-label={`${ctxPrefix}${tJson('kvTypeMenuAria', { row: rowNum })}`}
                        className="popover menu-pop menu-pop-right"
                      >
                        {(
                          [
                            ['string', tJson('typeOptionString')],
                            ['number', tJson('typeOptionNumber')],
                            ['boolean', 'true / false'],
                            ['null', tJson('typeOptionNull')],
                            ['object', tJson('typeOptionObject')],
                            ['array', tJson('typeOptionArray')],
                          ] as const
                        ).map(([typeOpt, label]) => (
                          <button
                            key={typeOpt}
                            type="button"
                            role="menuitemradio"
                            aria-checked={r.type === typeOpt}
                            data-kv-act="pick-type"
                            data-row-id={r.id}
                            data-type={typeOpt}
                            data-testid={`kv-pick-type-${r.id}-${typeOpt}`}
                            className="menu-item"
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePickRowType(r.id, typeOpt);
                            }}
                          >
                            <span>{label}</span>
                            {r.type === typeOpt ? (
                              <span className="mono text-accent" aria-hidden="true">
                                ✓
                              </span>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {/* Column 4: Row actions menu (⋯) */}
                  <div className="kv-act-col">
                    <button
                      type="button"
                      disabled={savingInFlight}
                      data-kv-act="toggle-row-menu"
                      data-row-id={r.id}
                      data-testid={`kv-row-menu-btn-${r.id}`}
                      aria-haspopup="menu"
                      aria-expanded={isRowMenuOpen}
                      aria-label={`${ctxPrefix}${tJson('kvRowMenuBtnAria', { row: rowNum })}`}
                      className="kv-menu-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenTypeMenuRowId(null);
                        setOpenRootMenu(false);
                        const willOpen = openRowMenuRowId !== r.id;
                        setOpenRowMenuRowId(willOpen ? r.id : null);
                        pendingFocusRef.current = {
                          kind: willOpen ? 'row-menu-item' : 'menu',
                          rowId: r.id,
                        };
                      }}
                    >
                      ⋯
                    </button>

                    {isRowMenuOpen ? (
                      <div
                        role="menu"
                        data-kv-menu-pop="row"
                        data-row-id={r.id}
                        data-testid={`kv-row-menu-${r.id}`}
                        aria-label={`${ctxPrefix}${tJson('kvRowMenuAria', { row: rowNum })}`}
                        className="popover menu-pop menu-pop-right"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          data-kv-act="insert-below"
                          data-row-id={r.id}
                          data-testid={`kv-insert-below-${r.id}`}
                          className="menu-item"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleInsertRowBelow(r.id);
                          }}
                        >
                          <span>{tJson('kvRowInsertBelow')}</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={idx <= 0}
                          data-kv-act="move-row-up"
                          data-row-id={r.id}
                          data-testid={`kv-move-up-${r.id}`}
                          className="menu-item"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveRow(r.id, -1);
                          }}
                        >
                          <span>{tJson('kvRowMoveUp')}</span>
                          <span className="mono text-[12px] text-muted" aria-hidden="true">
                            ↑
                          </span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={idx >= list.length - 1}
                          data-kv-act="move-row-down"
                          data-row-id={r.id}
                          data-testid={`kv-move-down-${r.id}`}
                          className="menu-item"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMoveRow(r.id, 1);
                          }}
                        >
                          <span>{tJson('kvRowMoveDown')}</span>
                          <span className="mono text-[12px] text-muted" aria-hidden="true">
                            ↓
                          </span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          data-kv-act="delete-row"
                          data-row-id={r.id}
                          data-testid={`kv-delete-row-${r.id}`}
                          className="menu-item menu-item-danger"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteRow(r.id);
                          }}
                        >
                          <span>{tJson('kvRowDelete')}</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Nested children container */}
                {(r.type === 'object' || r.type === 'array') && r.expanded ? (
                  (() => {
                    // L5: Localize unnamed ancestor row label via messages/*.json
                    const childName =
                      r.key ||
                      (isArr ? `#${rowNum}` : tJson('kvUnnamedRowLabel', { row: rowNum }));
                    const childPath = pathPrefix ? `${pathPrefix} › ${childName}` : childName;
                    const nestLabel =
                      r.type === 'object'
                        ? tJson('kvNestedObjectAria', { name: childName })
                        : tJson('kvNestedArrayAria', { name: childName });
                    return (
                      <div
                        className="kv-nest"
                        role="group"
                        aria-label={nestLabel}
                        data-testid={`kv-nest-${r.id}`}
                      >
                        {renderRowsList(r.children, r.type, depth + 1, r.id, childPath)}
                      </div>
                    );
                  })()
                ) : null}
              </li>
            );
          })}
        </ul>

        <div className="kv-add-bar">
          <button
            type="button"
            disabled={savingInFlight}
            data-testid={`json-open-add-field-${parentRowId}`}
            data-kv-act="add-row"
            data-parent-id={parentRowId}
            className="btn btn-tertiary btn-sm"
            onClick={() => handleAddRowToParent(parentRowId)}
          >
            {addBtnLabel}
          </button>
          {isRootLevel ? (
            <span className="text-[12px] text-muted">
              {isArr ? tJson('kvPasteHintArray') : tJson('kvPasteHintObject')}
            </span>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <article
      ref={cardRef}
      data-testid="new-json-entry-composer"
      onKeyDown={handleComposerKeyDown}
      className={`card min-w-0 overflow-hidden ${
        unconfirmedCreate || saveError ? 'card-error' : ''
      }`}
    >
      <div className="card-head flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5">
        <span className="badge-type badge-json">json</span>
        <span className="text-[14px] font-semibold text-body">
          {savingInFlight ? tEntry('saving') : tJson('newJsonTitle')}
        </span>
        <span
          data-kv-bytes=""
          data-testid="new-json-bytes"
          className={`mono text-[12px] ${
            isOverCap ? 'font-semibold text-error-ink' : 'text-muted'
          }`}
        >
          {isOverCap
            ? tEntry('byteCounterOver', { bytes: formattedBytes })
            : isNearCap
              ? tEntry('byteCounterNear', { bytes: formattedBytes })
              : tEntry('byteCounter', { bytes: formattedBytes })}
        </span>

        <div className="relative ml-auto flex flex-wrap items-center gap-1.5">
          {/* Table / Raw JSON switcher */}
          <div
            role="group"
            aria-label={tJson('viewModeAria')}
            data-testid="new-json-mode-switcher"
            data-kv-mode-seg=""
            className="seg"
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

          {/* Root container structure dropdown (Gốc: Object ▾ / Gốc: Mảng ▾) */}
          <div className="relative">
            <button
              ref={rootMenuBtnRef}
              type="button"
              disabled={savingInFlight}
              data-kv-root-menu-btn=""
              data-testid="new-json-root-menu-btn"
              aria-haspopup="menu"
              aria-expanded={openRootMenu}
              aria-label={tJson('kvRootMenuBtnAria')}
              className="btn btn-tertiary btn-sm !px-2.5"
              onClick={(e) => {
                e.stopPropagation();
                setOpenTypeMenuRowId(null);
                setOpenRowMenuRowId(null);
                setOpenRootMenu((prev) => !prev);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  setOpenTypeMenuRowId(null);
                  setOpenRowMenuRowId(null);
                  setOpenRootMenu(true);
                }
              }}
            >
              <span data-kv-root-badge="">
                {rootKind === 'array'
                  ? tJson('kvRootBadgeArray')
                  : tJson('kvRootBadgeObject')}
              </span>
              <span className="text-[11px] text-muted" aria-hidden="true">
                ▾
              </span>
            </button>

            <div
              ref={rootMenuPopRef}
              role="menu"
              aria-label={tJson('kvRootMenuAria')}
              data-kv-root-menu-pop=""
              data-testid="new-json-preset-group"
              hidden={!openRootMenu}
              className="popover menu-pop menu-pop-right"
              onKeyDown={(e) => {
                handleMenuKeyDown(e, rootMenuPopRef.current, (restoreFocus) => {
                  setOpenRootMenu(false);
                  if (restoreFocus) rootMenuBtnRef.current?.focus();
                });
              }}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={rootKind === 'object'}
                data-kv-root-choice="object"
                data-testid="new-json-preset-object"
                className="menu-item"
                onClick={() => handleRequestRootSwitch('object', false)}
              >
                <span>{tJson('kvRootOptionObject')}</span>
                {rootKind === 'object' ? (
                  <span className="mono text-accent" data-kv-root-check="">
                    ✓
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={rootKind === 'array'}
                data-kv-root-choice="array"
                data-testid="new-json-preset-array"
                className="menu-item"
                onClick={() => handleRequestRootSwitch('array', false)}
              >
                <span>{tJson('kvRootOptionArray')}</span>
                {rootKind === 'array' ? (
                  <span className="mono text-accent" data-kv-root-check="">
                    ✓
                  </span>
                ) : null}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div>
        {/* RFD-33: Single polite live region per editor, updated only when error signature changes (debounced) */}
        <div
          data-kv-live-region=""
          data-testid="new-json-live-region"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {liveErrorAnnouncement}
        </div>

        {/* Inline confirmation prompt banner (RFD-13, RFD-20, RFD-23, RFD-25, RFD-27) */}
        {inlinePrompt ? (
          <div
            ref={inlinePromptRef}
            role="region"
            aria-label={tJson('kvConfirmRegionAria')}
            data-kv-inline-prompt=""
            data-testid="new-json-inline-prompt"
            className="kv-inline-prompt"
          >
            <div className="min-w-0" role="alert">
              <p className="m-0 text-[13px] font-semibold text-body">
                {inlinePrompt.kind === 'switch-root'
                  ? inlinePrompt.nextKind === 'array'
                    ? tJson('kvPromptObjectToArrayTitle', { count: inlinePrompt.count })
                    : tJson('kvPromptArrayToObjectTitle', { count: inlinePrompt.count })
                  : inlinePrompt.kind === 'switch-row-type'
                    ? inlinePrompt.nextType !== 'object' && inlinePrompt.nextType !== 'array'
                      ? inlinePrompt.prevType === 'object'
                        ? tJson('kvPromptContainerToScalarObjectTitle', {
                            count: inlinePrompt.count,
                          })
                        : tJson('kvPromptContainerToScalarArrayTitle', {
                            count: inlinePrompt.count,
                          })
                      : inlinePrompt.nextType === 'array'
                        ? tJson('kvPromptNestedObjectToArrayTitle', {
                            count: inlinePrompt.count,
                          })
                        : tJson('kvPromptArrayToObjectTitle', { count: inlinePrompt.count })
                    : inlinePrompt.pastedRoot.kind === 'array'
                      ? tJson('kvPromptPasteMismatchArrayTitle')
                      : tJson('kvPromptPasteMismatchObjectTitle')}
              </p>
              <p className="m-0 mt-0.5 text-[12px] text-muted">
                {inlinePrompt.kind === 'switch-root'
                  ? inlinePrompt.nextKind === 'array'
                    ? tJson('kvPromptObjectToArrayBody')
                    : tJson('kvPromptArrayToObjectBody')
                  : inlinePrompt.kind === 'switch-row-type'
                    ? inlinePrompt.nextType !== 'object' && inlinePrompt.nextType !== 'array'
                      ? tJson('kvPromptContainerToScalarBody')
                      : inlinePrompt.nextType === 'array'
                        ? tJson('kvPromptObjectToArrayBody')
                        : tJson('kvPromptArrayToObjectBody')
                    : tJson('kvPromptPasteMismatchBody')}
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {inlinePrompt.kind === 'switch-root' ? (
                <>
                  <button
                    type="button"
                    data-kv-prompt-act="confirm-root-switch"
                    data-testid="new-json-prompt-confirm"
                    className={`btn btn-sm ${
                      inlinePrompt.nextKind === 'array' ? 'btn-danger' : 'btn-secondary'
                    }`}
                    onClick={() => handlePromptAction('confirm-root-switch')}
                  >
                    {inlinePrompt.nextKind === 'array'
                      ? tJson('kvPromptSwitchToArrayBtn')
                      : tJson('kvPromptSwitchToObjectBtn')}
                  </button>
                  <button
                    type="button"
                    data-kv-prompt-act="dismiss"
                    data-testid="new-json-prompt-dismiss"
                    className="btn btn-tertiary btn-sm"
                    onClick={() => handlePromptAction('dismiss')}
                  >
                    {inlinePrompt.nextKind === 'array'
                      ? tJson('kvPromptKeepObjectBtn')
                      : tJson('kvPromptKeepArrayBtn')}
                  </button>
                </>
              ) : inlinePrompt.kind === 'switch-row-type' ? (
                <>
                  <button
                    type="button"
                    data-kv-prompt-act="confirm-row-type"
                    data-testid="new-json-prompt-confirm"
                    className={`btn btn-sm ${
                      inlinePrompt.nextType === 'object' ? 'btn-secondary' : 'btn-danger'
                    }`}
                    onClick={() => handlePromptAction('confirm-row-type')}
                  >
                    {inlinePrompt.nextType !== 'object' && inlinePrompt.nextType !== 'array'
                      ? tJson('kvPromptSwitchRemoveChildrenBtn')
                      : inlinePrompt.nextType === 'array'
                        ? tJson('kvPromptSwitchToArrayBtn')
                        : tJson('kvPromptSwitchToObjectBtn')}
                  </button>
                  <button
                    type="button"
                    data-kv-prompt-act="dismiss"
                    data-testid="new-json-prompt-dismiss"
                    className="btn btn-tertiary btn-sm"
                    onClick={() => handlePromptAction('dismiss')}
                  >
                    {inlinePrompt.nextType !== 'object' && inlinePrompt.nextType !== 'array'
                      ? tEntry('cancel')
                      : inlinePrompt.nextType === 'array'
                        ? tJson('kvPromptKeepObjectBtn')
                        : tJson('kvPromptKeepArrayBtn')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    data-kv-prompt-act="paste-nest"
                    data-testid="new-json-prompt-paste-nest"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handlePromptAction('paste-nest')}
                  >
                    {tJson('kvPromptPasteReplaceRowBtn')}
                  </button>
                  <button
                    type="button"
                    data-kv-prompt-act="paste-replace"
                    data-testid="new-json-prompt-paste-replace"
                    className="btn btn-danger btn-sm"
                    onClick={() => handlePromptAction('paste-replace')}
                  >
                    {tJson('kvPromptPasteReplaceAllBtn')}
                  </button>
                  <button
                    type="button"
                    data-kv-prompt-act="dismiss"
                    data-testid="new-json-prompt-dismiss"
                    className="btn btn-tertiary btn-sm"
                    onClick={() => handlePromptAction('dismiss')}
                  >
                    {tEntry('cancel')}
                  </button>
                </>
              )}
            </div>
          </div>
        ) : null}

        {mode === 'table' ? (
          <div
            ref={kvHostRef}
            data-testid="json-table-host-new-json"
            className="min-w-0"
            onKeyDown={handleKvHostKeyDown}
          >
            <div className="kv-editor">
              {renderRowsList(rows, rootKind, 0, 'root', '')}
            </div>
          </div>
        ) : (
          <JsonRawEditor
            entryId="new-json"
            positionNumber={1}
            draftValue={rawDraftValue}
            sourceEol={detectEol(tableSerializedSource)}
            prospectiveByteLength={utf8ByteLength}
            isOverCap={isOverCap}
            isDirty={isDirty}
            savingInFlight={savingInFlight}
            hasBlockingState={unconfirmedCreate !== null}
            externalError={switchBlockedError}
            parseDebounceMs={rawParseDebounceMs}
            showSaveActions={false}
            rawLabelText={tJson('kvRawSyncedLabel')}
            onValidationSettled={setRawSettledIssue}
            onDraftChange={(nextVal: string) => {
              composerHolderRef.current.candidateSource = nextVal;
              setRawDraftValue(nextVal);
              setRawEditedSinceSwitch(true);
              setSwitchBlockedError(null);
              if (discardConfirmOpen) setDiscardConfirmOpen(false);
              const parsed = parseJsonStrict(nextVal);
              if (parsed.ok) {
                if (
                  parsed.document.root.kind === 'object' ||
                  parsed.document.root.kind === 'array'
                ) {
                  loadFromJsonString(nextVal, {
                    preserveRawSource: true,
                    markFromRaw: true,
                  });
                } else {
                  setCanonicalRawText(nextVal);
                }
              }
            }}
            onSave={() => {
              void handleSaveNew();
            }}
            onRequestCancel={requestCancel}
          />
        )}

        <div className="card-foot kv-foot border-t border-line bg-surface px-4 py-3">
          {unconfirmedCreate ? (
            <div
              role="alert"
              data-testid="new-json-retry-box"
              className="auth-alert mb-3 w-full"
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
            <p
              role="alert"
              data-testid="new-json-save-error"
              className="field-error mb-3 mt-0 w-full"
            >
              {saveError}
            </p>
          ) : null}

          <span
            id="new-json-save-reason"
            data-kv-save-reason=""
            data-testid="new-json-save-reason"
            className={
              saveDisableInfo.isErrorStyle ? 'kv-save-reason' : 'text-[12px] text-muted'
            }
          >
            {saveDisableInfo.text}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="new-json-cancel-btn"
              data-kv-cancel-btn=""
              className="btn btn-tertiary btn-sm"
              disabled={savingInFlight}
              onClick={requestCancel}
            >
              <span>{tEntry('cancel')}</span>
              <kbd className="kbd">Esc</kbd>
            </button>
            <button
              type="button"
              data-testid="new-json-save-btn"
              data-kv-save-btn=""
              className="btn btn-primary btn-sm"
              disabled={saveDisabled}
              aria-busy={savingInFlight || undefined}
              aria-describedby="new-json-save-reason"
              onClick={() => {
                void handleSaveNew();
              }}
            >
              {savingInFlight ? (
                tEntry('savingButton')
              ) : (
                <>
                  <span>{tEntry('save')}</span>
                  <kbd className="kbd">Ctrl+S</kbd>
                </>
              )}
            </button>
          </div>

          {discardConfirmOpen ? (
            <div
              data-testid="new-json-discard-confirm"
              data-kv-discard-confirm=""
              role="alert"
              className="auth-status mb-0 mt-2 flex w-full flex-wrap items-center justify-between gap-3"
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
                  data-kv-keep-btn=""
                  className="btn btn-tertiary btn-sm"
                  onClick={() => setDiscardConfirmOpen(false)}
                >
                  {tEntry('keepEditing')}
                </button>
                <button
                  type="button"
                  data-testid="new-json-discard-btn"
                  data-kv-discard-btn=""
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
      </div>
    </article>
  );
}
