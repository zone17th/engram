export {
  ENTRY_BUCKET_STEP_BYTES,
  ENTRY_KEY_ID_REGEX,
  ENTRY_MAX_PLAINTEXT_BYTES,
  ENTRY_UUID_REGEX,
  EntrySealError,
  computePlaintextLenBucket,
  sealEntryImportJson,
  sealEntryUpdate,
  sealNewEntry,
  validateAndMeasureEntryText,
  type EntryOpHandle,
  type EntrySealErrorCode,
  type EntrySealStartedOp,
  type EntrySealVaultContext,
  type SealEntryImportJsonInput,
  type SealEntryUpdateInput,
  type SealNewEntryInput,
  type SealedEntryUpdatePayload,
  type SealedImportJsonEntryPayload,
  type SealedNewEntryPayload,
} from '@/features/entries/seal';

export {
  applyCommittedEntryMetaToCache,
  mutateSealedEntryCreate,
  mutateSealedEntryImportJson,
  mutateSealedEntryUpdate,
  toEntryCreateVariables,
  toEntryImportJsonVariables,
  toEntryUpdateVariables,
  useCreateEntryMutation,
  useImportJsonEntryMutation,
  useUpdateEntryMutation,
  type EntryMutationCallbacks,
  type SealedEntryCreateVariables,
  type SealedEntryImportJsonVariables,
  type SealedEntryUpdateVariables,
} from '@/features/entries/mutations';

export {
  EntryBodyOpenError,
  classifyEntryOpenError,
  createRealEntryBodyLoader,
  loadRealEntryBody,
  type CreateRealEntryBodyLoaderOptions,
  type EntryOpenErrorKind,
} from '@/features/entries/real-body-loader';

export {
  MAX_CONCURRENT_ENTRY_BODY_LOADS,
  createConcurrencyLimiter,
  entryBodyLoadLimiter,
  resetEntryBodyLoadLimiterForTests,
  type ConcurrencyLimiter,
} from '@/features/entries/concurrency-limiter';

export {
  VAULT_SECRET_INPUT_PROPS,
  assertVaultSecretElementAttributes,
  findVaultSecretAttributeViolations,
  getVaultSecretInputProps,
  type SecretElementAttributeViolation,
  type VaultSecretInputProps,
} from '@/features/entries/secret-input-props';

export {
  clearAllUnconfirmedSaves,
  dismissUnconfirmedSave,
  getUnconfirmedSavesSnapshot,
  peekUnconfirmedSavesForTests,
  reconcileUnconfirmedSavesUser,
  recordUnconfirmedSave,
  subscribeUnconfirmedSaves,
  useUnconfirmedSavesForUser,
  type UnconfirmedSaveRecord,
} from '@/features/entries/unconfirmed-save-store';
