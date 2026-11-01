import {
  createIdempotencyKey,
  type EntryCreateRequest,
  type EntryEnvelopeV1,
  type EntryImportJsonRequest,
  type EntryType,
  type EntryUpdateRequest,
  type PlaintextLenBucket,
} from '@/lib/api/content';
import type { CryptoClient } from '@/lib/crypto/client';
import {
  ENTRY_ID_UUID_REGEX,
  ENTRY_PLAINTEXT_MAX_BYTES,
  KEY_ID_REGEX,
} from '@/lib/crypto/envelope';
import { hasLoneSurrogate } from '@/lib/crypto/protocol';

export const ENTRY_MAX_PLAINTEXT_BYTES = ENTRY_PLAINTEXT_MAX_BYTES; // 262_144
export const ENTRY_BUCKET_STEP_BYTES = 256;

const utf8Encoder = new TextEncoder();

export type EntrySealErrorCode =
  | 'ENTRY_EMPTY'
  | 'ENTRY_TOO_LARGE'
  | 'ENTRY_INVALID_UNICODE'
  | 'ENTRY_ID_INVALID'
  | 'ENTRY_TYPE_INVALID'
  | 'VAULT_LOCKED'
  | 'VAULT_KEY_MISSING'
  | 'STALE_GENERATION';

/**
 * Typed client-side validation/lifecycle error thrown by `sealNewEntry` / `sealEntryUpdate`
 * BEFORE or after calling the crypto Worker. Never includes or echoes the plaintext string.
 */
export class EntrySealError extends Error {
  readonly code: EntrySealErrorCode;
  readonly byteLength?: number;

  constructor(
    code: EntrySealErrorCode,
    message: string,
    options?: ErrorOptions & { byteLength?: number },
  ) {
    super(message, options);
    this.name = 'EntrySealError';
    this.code = code;
    if (options?.byteLength !== undefined) {
      this.byteLength = options.byteLength;
    }
  }
}

/**
 * Minimal subset of `VaultContextValue` needed to seal an entry so callers can pass `useVault()`
 * directly or a minimal structural handle in tests.
 */
export interface EntrySealVaultContext {
  readonly state?: string;
  readonly vaultMeta: { readonly vault_key_id: string } | null;
  readonly beginOp?: () => {
    readonly opGeneration: number;
    readonly isCurrent: () => boolean;
    readonly client: CryptoClient;
  };
  readonly getClient?: () => CryptoClient;
  readonly captureOpGeneration?: () => number;
}

export interface EntryOpHandle {
  readonly opGeneration: number;
  readonly isCurrent: () => boolean;
}

/**
 * Computes `plaintext_len_bucket = ceil(bytes / 256) * 256` for `1 <= bytes <= 262144`
 * (SPEC §5.5, plan §2.3, §2.6).
 */
export function computePlaintextLenBucket(byteLength: number): PlaintextLenBucket {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new EntrySealError('ENTRY_EMPTY', 'Entry content cannot be empty (0 bytes).', {
      byteLength: 0,
    });
  }
  if (byteLength > ENTRY_MAX_PLAINTEXT_BYTES) {
    throw new EntrySealError(
      'ENTRY_TOO_LARGE',
      `Entry content exceeds ${ENTRY_MAX_PLAINTEXT_BYTES} UTF-8 bytes.`,
      { byteLength },
    );
  }
  return Math.ceil(byteLength / ENTRY_BUCKET_STEP_BYTES) * ENTRY_BUCKET_STEP_BYTES;
}

/**
 * Validates `text` (must be well-formed UTF-16, 1..262144 UTF-8 bytes) BEFORE any Worker call.
 * Returns the UTF-8 byte length and bucket. Never stores `text` on error instances.
 */
export function validateAndMeasureEntryText(text: string): {
  readonly byteLength: number;
  readonly plaintextLenBucket: PlaintextLenBucket;
} {
  if (typeof text !== 'string') {
    throw new EntrySealError('ENTRY_EMPTY', 'Entry content must be a string.');
  }
  if (text.length === 0) {
    throw new EntrySealError('ENTRY_EMPTY', 'Entry content cannot be empty (0 bytes).', {
      byteLength: 0,
    });
  }
  if (hasLoneSurrogate(text)) {
    throw new EntrySealError(
      'ENTRY_INVALID_UNICODE',
      'Entry content contains an unpaired UTF-16 surrogate.',
    );
  }
  const encoded = utf8Encoder.encode(text);
  const byteLength = encoded.byteLength;
  encoded.fill(0);
  if (byteLength === 0) {
    throw new EntrySealError('ENTRY_EMPTY', 'Entry content cannot be empty (0 bytes).', {
      byteLength: 0,
    });
  }
  if (byteLength > ENTRY_MAX_PLAINTEXT_BYTES) {
    throw new EntrySealError(
      'ENTRY_TOO_LARGE',
      `Entry content exceeds ${ENTRY_MAX_PLAINTEXT_BYTES} UTF-8 bytes.`,
      { byteLength },
    );
  }
  const plaintextLenBucket = computePlaintextLenBucket(byteLength);
  return { byteLength, plaintextLenBucket };
}

function resolveOpFromVault(vault: EntrySealVaultContext): {
  readonly client: CryptoClient;
  readonly opGeneration: number;
  readonly isCurrent: () => boolean;
  readonly keyId: string;
} {
  if (vault.state !== undefined && vault.state !== 'unlocked') {
    throw new EntrySealError('VAULT_LOCKED', 'Vault must be unlocked before sealing an entry.');
  }
  const keyId = vault.vaultMeta?.vault_key_id;
  if (typeof keyId !== 'string' || !KEY_ID_REGEX.test(keyId)) {
    throw new EntrySealError(
      'VAULT_KEY_MISSING',
      'Vault metadata (vault_key_id) is missing or invalid.',
    );
  }
  if (typeof vault.beginOp === 'function') {
    const started = vault.beginOp();
    return {
      client: started.client,
      opGeneration: started.opGeneration,
      isCurrent: () =>
        (vault.state === undefined || vault.state === 'unlocked') &&
        vault.vaultMeta?.vault_key_id === keyId &&
        started.isCurrent(),
      keyId,
    };
  }
  if (typeof vault.getClient === 'function') {
    const client = vault.getClient();
    const opGeneration =
      typeof vault.captureOpGeneration === 'function'
        ? vault.captureOpGeneration()
        : client.captureGeneration();
    return {
      client,
      opGeneration,
      isCurrent: () =>
        (vault.state === undefined || vault.state === 'unlocked') &&
        vault.vaultMeta?.vault_key_id === keyId &&
        client.getState() === 'unlocked' &&
        client.getGeneration() === opGeneration,
      keyId,
    };
  }
  throw new EntrySealError('VAULT_LOCKED', 'Vault client is unavailable.');
}

function generateEntryUuidOnce(entryIdOverride?: string): string {
  const id = (entryIdOverride ?? crypto.randomUUID()).toLowerCase();
  if (!ENTRY_ID_UUID_REGEX.test(id)) {
    throw new EntrySealError('ENTRY_ID_INVALID', 'Entry ID must be a lowercase hyphenated UUID.');
  }
  return id;
}

export interface SealNewEntryInput {
  readonly text: string;
  readonly itemId: string;
  readonly vault: EntrySealVaultContext;
  readonly type?: EntryType;
  readonly entryId?: string;
  readonly idempotencyKey?: string;
}

/**
 * Sealed payload for `POST /items/{id}/entries`.
 * Never holds or closes over the original `text` string (plan §2.6, §2.10, user-dec-016).
 */
export interface SealedNewEntryPayload {
  readonly itemId: string;
  readonly entryId: string;
  readonly type: EntryType;
  readonly idempotencyKey: string;
  readonly envelope: EntryEnvelopeV1;
  readonly ciphertext: string;
  readonly plaintextLenBucket: PlaintextLenBucket;
  readonly requestBody: EntryCreateRequest;
  /** Request body serialized ONCE into a JSON string for deterministic replay. */
  readonly serializedBody: string;
  readonly op: EntryOpHandle;
  readonly opGeneration: number;
  readonly isCurrent: () => boolean;
}

/**
 * Seals a new entry (plan Task 14 item 1, §2.6):
 * 1. Measures UTF-8 bytes and rejects empty (0 B) or > 262144 B BEFORE any Worker call.
 * 2. Generates `entryId = crypto.randomUUID()` once and `idempotencyKey` once.
 * 3. Captures `beginOp()` (`opGeneration`) synchronously before the first `await`.
 * 4. Calls `client.sealEntry({ entryId, keyId: vaultMeta.vault_key_id, plaintext, opGeneration })` once.
 * 5. Computes `plaintext_len_bucket = ceil(bytes / 256) * 256` and serializes the request body ONCE.
 * 6. Returns an immutable payload that does NOT retain the plaintext string.
 */
export async function sealNewEntry(input: SealNewEntryInput): Promise<SealedNewEntryPayload> {
  const entryType: EntryType = input.type ?? 'text';
  if (entryType !== 'text' && entryType !== 'json') {
    throw new EntrySealError('ENTRY_TYPE_INVALID', 'Entry type must be "text" or "json".');
  }

  // Step 1: validate and measure BEFORE touching the Worker
  const { plaintextLenBucket } = validateAndMeasureEntryText(input.text);
  const entryId = generateEntryUuidOnce(input.entryId);
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey();
  const itemId = input.itemId;

  // Step 2: capture opGeneration BEFORE the first await
  const { client, opGeneration, isCurrent, keyId } = resolveOpFromVault(input.vault);

  // Step 3: seal once in the Worker
  const sealed = await client.sealEntry({
    entryId,
    keyId,
    plaintext: input.text,
    opGeneration,
  });

  if (!isCurrent()) {
    throw new EntrySealError(
      'STALE_GENERATION',
      'Vault locked or changed while sealing entry.',
    );
  }

  const envelope: EntryEnvelopeV1 = Object.freeze({
    v: sealed.envelope.v,
    alg: sealed.envelope.alg,
    key_id: sealed.envelope.key_id,
    nonce: sealed.envelope.nonce,
    ct_enc: sealed.envelope.ct_enc,
  });

  const requestBody: EntryCreateRequest = Object.freeze({
    id: entryId,
    type: entryType,
    envelope,
    ciphertext: sealed.ciphertext,
    plaintext_len_bucket: plaintextLenBucket,
  });

  const serializedBody = JSON.stringify(requestBody);
  const op: EntryOpHandle = Object.freeze({
    opGeneration,
    isCurrent,
  });

  return Object.freeze({
    itemId,
    entryId,
    type: entryType,
    idempotencyKey,
    envelope,
    ciphertext: sealed.ciphertext,
    plaintextLenBucket,
    requestBody,
    serializedBody,
    op,
    opGeneration,
    isCurrent,
  });
}

export interface SealEntryImportJsonInput {
  readonly text: string;
  readonly itemId: string;
  readonly source: 'paste' | 'file';
  readonly vault: EntrySealVaultContext;
  readonly entryId?: string;
  readonly idempotencyKey?: string;
}

export interface SealedImportJsonEntryPayload {
  readonly itemId: string;
  readonly entryId: string;
  readonly type: 'json';
  readonly source: 'paste' | 'file';
  readonly idempotencyKey: string;
  readonly envelope: EntryEnvelopeV1;
  readonly ciphertext: string;
  readonly plaintextLenBucket: PlaintextLenBucket;
  readonly requestBody: EntryImportJsonRequest;
  readonly serializedBody: string;
  readonly op: EntryOpHandle;
  readonly opGeneration: number;
  readonly isCurrent: () => boolean;
}

/**
 * Seals a JSON import entry (`POST /items/{id}/entries/import-json`, Task 17)
 * using the exact same single-UUID, pre-seal byte check, and single-serialization guarantees.
 */
export async function sealEntryImportJson(
  input: SealEntryImportJsonInput,
): Promise<SealedImportJsonEntryPayload> {
  const { plaintextLenBucket } = validateAndMeasureEntryText(input.text);
  const entryId = generateEntryUuidOnce(input.entryId);
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey();
  const itemId = input.itemId;
  const source = input.source;

  const { client, opGeneration, isCurrent, keyId } = resolveOpFromVault(input.vault);

  const sealed = await client.sealEntry({
    entryId,
    keyId,
    plaintext: input.text,
    opGeneration,
  });

  if (!isCurrent()) {
    throw new EntrySealError(
      'STALE_GENERATION',
      'Vault locked or changed while sealing imported JSON entry.',
    );
  }

  const envelope: EntryEnvelopeV1 = Object.freeze({
    v: sealed.envelope.v,
    alg: sealed.envelope.alg,
    key_id: sealed.envelope.key_id,
    nonce: sealed.envelope.nonce,
    ct_enc: sealed.envelope.ct_enc,
  });

  const requestBody: EntryImportJsonRequest = Object.freeze({
    id: entryId,
    type: 'json',
    envelope,
    ciphertext: sealed.ciphertext,
    plaintext_len_bucket: plaintextLenBucket,
    source,
  });

  const serializedBody = JSON.stringify(requestBody);
  const op: EntryOpHandle = Object.freeze({
    opGeneration,
    isCurrent,
  });

  return Object.freeze({
    itemId,
    entryId,
    type: 'json',
    source,
    idempotencyKey,
    envelope,
    ciphertext: sealed.ciphertext,
    plaintextLenBucket,
    requestBody,
    serializedBody,
    op,
    opGeneration,
    isCurrent,
  });
}

export interface SealEntryUpdateInput {
  readonly entryId: string;
  readonly text: string;
  readonly vault: EntrySealVaultContext;
  readonly itemId?: string;
  readonly version?: number;
  readonly idempotencyKey?: string;
}

/**
 * Sealed payload for `PUT /entries/{id}`.
 * Never holds or closes over the original `text` string (plan §2.6, §2.10, user-dec-016).
 */
export interface SealedEntryUpdatePayload {
  readonly entryId: string;
  readonly itemId?: string;
  readonly version?: number;
  readonly idempotencyKey: string;
  readonly envelope: EntryEnvelopeV1;
  readonly ciphertext: string;
  readonly plaintextLenBucket: PlaintextLenBucket;
  readonly requestBody: EntryUpdateRequest;
  /** Request body serialized ONCE into a JSON string for deterministic replay. */
  readonly serializedBody: string;
  readonly op: EntryOpHandle;
  readonly opGeneration: number;
  readonly isCurrent: () => boolean;
}

/**
 * Seals an update to an existing entry (plan Task 14 item 1, §2.6):
 * - Keeps the same `entryId` (validated lowercase UUID) and generates a fresh random 24 B nonce in the Worker.
 * - Measures UTF-8 bytes and rejects empty (0 B) or > 262144 B BEFORE calling the Worker.
 * - Captures `beginOp()` (`opGeneration`) synchronously before the first `await`.
 * - Returns `{ envelope, ciphertext, plaintext_len_bucket }` serialized ONCE + `entryId` + `idempotencyKey` + `op`.
 * - Never retains the plaintext string on the returned object.
 */
export async function sealEntryUpdate(
  input: SealEntryUpdateInput,
): Promise<SealedEntryUpdatePayload> {
  const { plaintextLenBucket } = validateAndMeasureEntryText(input.text);
  const entryId = generateEntryUuidOnce(input.entryId);
  const idempotencyKey = input.idempotencyKey ?? createIdempotencyKey();
  const itemId = input.itemId;
  const version = input.version;

  const { client, opGeneration, isCurrent, keyId } = resolveOpFromVault(input.vault);

  const sealed = await client.sealEntry({
    entryId,
    keyId,
    plaintext: input.text,
    opGeneration,
  });

  if (!isCurrent()) {
    throw new EntrySealError(
      'STALE_GENERATION',
      'Vault locked or changed while sealing entry update.',
    );
  }

  const envelope: EntryEnvelopeV1 = Object.freeze({
    v: sealed.envelope.v,
    alg: sealed.envelope.alg,
    key_id: sealed.envelope.key_id,
    nonce: sealed.envelope.nonce,
    ct_enc: sealed.envelope.ct_enc,
  });

  const requestBody: EntryUpdateRequest = Object.freeze({
    envelope,
    ciphertext: sealed.ciphertext,
    plaintext_len_bucket: plaintextLenBucket,
  });

  const serializedBody = JSON.stringify(requestBody);
  const op: EntryOpHandle = Object.freeze({
    opGeneration,
    isCurrent,
  });

  return Object.freeze({
    entryId,
    ...(itemId !== undefined ? { itemId } : {}),
    ...(version !== undefined ? { version } : {}),
    idempotencyKey,
    envelope,
    ciphertext: sealed.ciphertext,
    plaintextLenBucket,
    requestBody,
    serializedBody,
    op,
    opGeneration,
    isCurrent,
  });
}
