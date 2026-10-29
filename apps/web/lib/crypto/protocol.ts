export const KDF_ALG = 'argon2id13' as const;
export const KDF_OPS_MIN = 3;
export const KDF_OPS_MAX = 10;
export const KDF_MEM_MIN = 67_108_864; // 64 MiB
export const KDF_MEM_MAX = 268_435_456; // 256 MiB
export const KDF_PARALLELISM = 1 as const;
export const KDF_SALT_BYTES = 16;
export const KEK_BYTES = 32;

export interface VaultKdfParams {
  alg: typeof KDF_ALG;
  ops: number;
  mem: number;
  parallelism: typeof KDF_PARALLELISM;
  salt: string;
}

export const ENVELOPE_VERSION = 1 as const;
export const ENVELOPE_ALG = 'xchacha20poly1305-ietf' as const;
export const ENVELOPE_CT_ENC = 'utf8' as const;
export const ENVELOPE_AAD_LABEL = 'sabk.entry.v1' as const;
export const ENTRY_PLAINTEXT_MAX_BYTES = 262_144; // 256 KiB
export const ENTRY_CIPHERTEXT_MAX_BYTES = 263_168; // 256 KiB + AEAD slack
export const ENTRY_AEAD_TAG_BYTES = 16;

export interface EntryEnvelopeV1 {
  v: typeof ENVELOPE_VERSION;
  alg: typeof ENVELOPE_ALG;
  key_id: string;
  nonce: string;
  ct_enc: typeof ENVELOPE_CT_ENC;
}

export type CryptoWorkerErrorCode =
  | 'STALE_GENERATION'
  | 'VAULT_LOCKED'
  | 'VAULT_RECOVERING'
  | 'VAULT_NOT_RECOVERING'
  | 'KDF_PARAMS_INVALID'
  | 'KDF_ALLOCATION_FAILED'
  | 'KDF_DERIVE_FAILED'
  | 'AEAD_DECRYPT_FAILED'
  | 'PRIVATE_KEYS_WRAP_INVALID'
  | 'WRAP_INVALID'
  | 'WRAP_SELF_CHECK_FAILED'
  | 'RECOVERY_KEY_INVALID'
  | 'RECOVERY_CONTINUATION_MISSING'
  | 'ENVELOPE_INVALID'
  | 'NOT_IMPLEMENTED'
  | 'WORKER_INIT_FAILED'
  | 'WORKER_INTERNAL_ERROR'
  // Produced only by CryptoClient (never by the Worker): a second state-changing call was made
  // while one is already in flight (ADR 0002 §10 rule 6).
  | 'CLIENT_BUSY';

export class CryptoWorkerError extends Error {
  readonly code: CryptoWorkerErrorCode;

  constructor(code: CryptoWorkerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CryptoWorkerError';
    this.code = code;
  }
}

export interface RecoveryKeyItemResult {
  slot: number;
  display: string;
  lookup_hash: string;
  wrap: string;
}

export interface CreateVaultResult {
  kdf: VaultKdfParams;
  vault_key_wrapped_by_kek: string;
  x25519_public: string;
  ed25519_public: string;
  private_keys_wrapped: string;
  recovery_keys: RecoveryKeyItemResult[];
}

export interface RewrapResult {
  kdf: VaultKdfParams;
  vault_key_wrapped_by_kek: string;
}

export interface MakeRecoveryKeysResult {
  recovery_keys: RecoveryKeyItemResult[];
}

export interface WrapForPasskeyResult {
  vk_wrap: string;
}

export interface WrapForDeviceResult {
  wrapped_vk: Uint8Array;
}

export interface SealEntryResult {
  envelope: EntryEnvelopeV1;
  ciphertext: string;
}

export interface OpenEntryResult {
  plaintext: string;
}

export interface DeriveRecoveryLookupResult {
  lookup_hash: string;
}

export interface ResumeRecoveryResult {
  lookup_hash: string;
  recovering: true;
}

export interface ConfirmRecoveryResult {
  unlocked: true;
}

export interface LockResult {
  generation: number;
}

export type WorkerCommandPayload =
  | {
      type: 'createVault';
      passphraseBuffer: ArrayBuffer;
      skipRecoveryKeys?: boolean;
    }
  | {
      type: 'unlockPassphrase';
      passphraseBuffer: ArrayBuffer;
      kdf: unknown;
      vaultKeyWrappedByKek: string;
      privateKeysWrapped?: string;
    }
  | {
      type: 'unlockRecovery';
      recoveryKeyBuffer: ArrayBuffer;
      wrap?: string;
      privateKeysWrapped?: string;
    }
  | {
      type: 'resumeRecovery';
      wrap: string;
      privateKeysWrapped?: string;
    }
  | {
      type: 'confirmRecovery';
    }
  | {
      type: 'unlockPrf';
      pwkBuffer: ArrayBuffer;
      vkWrap: string;
      privateKeysWrapped?: string;
    }
  | {
      type: 'unlockDevKey';
      devKey: CryptoKey;
      wrappedVk: Uint8Array | string;
      userId: string;
      vaultKeyId: string;
      privateKeysWrapped?: string;
    }
  | {
      type: 'rewrap';
      passphraseBuffer: ArrayBuffer;
      currentKdf: unknown;
    }
  | {
      type: 'makeRecoveryKeys';
      slots?: number[];
    }
  | {
      type: 'wrapForPasskey';
      pwkBuffer: ArrayBuffer;
    }
  | {
      type: 'wrapForDevice';
      devKey: CryptoKey;
      userId: string;
      vaultKeyId: string;
    }
  | {
      type: 'sealEntry';
      entryId: string;
      keyId: string;
      plaintext: string | Uint8Array;
    }
  | {
      type: 'openEntry';
      entryId: string;
      envelope: unknown;
      ciphertext: string | Uint8Array;
    }
  | {
      type: 'lock';
    };

export type WorkerRequestMessage = WorkerCommandPayload & {
  id: number;
  generation: number;
};

export type WorkerCommandType = WorkerCommandPayload['type'];

export type VaultMode = 'locked' | 'unlocked' | 'recovering';

/**
 * Authoritative Worker state `{mode, generation, epoch}` captured synchronously when a reply is built.
 * Every reply, success or error, carries it; the client adopts it and never infers state itself.
 */
export interface WorkerStateReport {
  mode: VaultMode;
  generation: number;
  epoch: number;
}

export interface WorkerSuccessResponse<T = unknown> {
  id: number;
  generation: number;
  state: WorkerStateReport;
  ok: true;
  result: T;
}

export interface WorkerErrorResponse {
  id: number;
  generation: number;
  state: WorkerStateReport;
  ok: false;
  error: {
    code: CryptoWorkerErrorCode;
    message: string;
  };
}

export type WorkerResponseMessage<T = unknown> =
  | WorkerSuccessResponse<T>
  | WorkerErrorResponse;
