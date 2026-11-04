export {
  JSON_NEW_PRESETS,
  JsonEntryCard,
  NewJsonEntryComposer,
  __testing,
  type JsonCardMode,
  type JsonComposerPlaintextHolder,
  type JsonEntryCardProps,
  type JsonNewPresetId,
  type NewJsonEntryComposerProps,
} from '@/features/json-table/json-entry-card';

export {
  formatReadOnlyStringSafe,
  hasLoneSurrogateInStr,
  isEffectivePlaceholderRow,
  isRowCompletelyBlank,
  parseMultiLineKeyValuePaste,
  serializeContainer,
  type KvContainerKind,
  type KvEditorSnapshot,
  type KvFocusDescriptor,
  type KvInlinePromptState,
  type KvRow,
  type KvRowError,
  type KvRowErrorItem,
  type KvRowValueType,
  type ParsedKvPaste,
} from '@/features/json-table/json-new-entry-composer';

export {
  JsonRawEditor,
  RAW_PARSE_DEBOUNCE_MS,
  validateRawJsonText,
  type JsonRawEditorProps,
  type RawValidationIssue,
} from '@/features/json-table/json-raw-editor';

export {
  JsonTreeGrid,
  formatReadOnlyDisplayText,
  toSuperscriptNumber,
  type ActiveAddFieldState,
  type ActiveCellEditState,
  type JsonTreeGridCommitControlRef,
  type JsonTreeGridProps,
} from '@/features/json-table/json-tree-grid';

export {
  ImportJsonDialog,
  importDialogTesting,
  type ImportJsonDialogProps,
  type JsonImportPlaintextHolder,
  type JsonImportPreviewMode,
} from '@/features/json-table/import-dialog';

export {
  getJsonImportHandoffLockEpoch,
  getJsonImportHandoffSnapshot,
  openJsonImportFromHandoff,
  reconcileJsonImportHandoffUser,
  subscribeJsonImportHandoff,
  wipeJsonImportHandoff,
  type JsonImportHandoffInput,
  type JsonImportHandoffRecord,
} from '@/features/json-table/import-handoff-store';
