import { decodeBase64UrlStrict, encodeBase64Url } from './b64url';
import {
  buildEntryAad,
  canonicalizeEnvelopeJcs,
  ENVELOPE_ALG,
  ENVELOPE_CT_ENC,
  ENVELOPE_VERSION,
  EnvelopeError,
  validateEntryEnvelope,
  type EnvelopeAdapter,
  type EntryEnvelopeV1,
} from './envelope';
import {
  deriveKek,
  KdfError,
  makeBaselineKdfParams,
  makeRewrapKdfParams,
  type DeriveKekFn,
  type VaultKdfParams,
} from './kdf';
import {
  deriveRecoveryLookupHash,
  deriveRecoveryWrapKey,
  formatRecoveryKeyDisplay,
  generateRecoveryKey,
  normalizeRecoveryKey,
  RecoveryKeyError,
  RK_SLOT_MAX,
  RK_SLOT_MIN,
  type RecoveryKeyAdapter,
} from './recovery';
import { getSodium, toLocalBytes, type Sodium } from './sodium';
import {
  openDevKeyWrap,
  openWrap,
  packPrivateKeySeeds,
  sealDevKeyWrap,
  sealWrap,
  SEED_BYTES,
  unpackPrivateKeySeeds,
  VK_BYTES,
  WRAP_NONCE_BYTES,
  WrapError,
  type WrapKind,
} from './wrap';

export type CryptoWorkerErrorCode =
  | 'STALE_GENERATION'
  | 'VAULT_LOCKED'
  | 'VAULT_RECOVERING'
  | 'KDF_PARAMS_INVALID'
  | 'KDF_ALLOCATION_FAILED'
  | 'KDF_DERIVE_FAILED'
  | 'AEAD_DECRYPT_FAILED'
  | 'WRAP_INVALID'
  | 'WRAP_SELF_CHECK_FAILED'
  | 'RECOVERY_KEY_INVALID'
  | 'ENVELOPE_INVALID'
  | 'NOT_IMPLEMENTED'
  | 'WORKER_INTERNAL_ERROR';

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

export interface WorkerSuccessResponse<T = unknown> {
  id: number;
  generation: number;
  ok: true;
  result: T;
}

export interface WorkerErrorResponse {
  id: number;
  generation: number;
  ok: false;
  error: {
    code: CryptoWorkerErrorCode;
    message: string;
  };
}

export type WorkerResponseMessage<T = unknown> =
  | WorkerSuccessResponse<T>
  | WorkerErrorResponse;

export type SealHookFn = (
  sodium: Sodium,
  kind: WrapKind,
  plaintext: Uint8Array,
  key: Uint8Array,
) => Uint8Array;

export type SealDevKeyHookFn = (
  sodium: Sodium,
  vk: Uint8Array,
  devKey: CryptoKey,
  userId: string,
  vaultKeyId: string,
) => Promise<Uint8Array>;

export interface WorkerCoreHooks {
  deriveKek?: DeriveKekFn;
  sealWrap?: SealHookFn;
  sealDevKeyWrap?: SealDevKeyHookFn;
  recovery?: Partial<RecoveryKeyAdapter>;
  envelope?: Partial<EnvelopeAdapter>;
  onKeyZeroed?: (kind: 'vk' | 'kek' | 'pwk' | 'rk' | 'seed' | 'plaintext') => void;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const utf8Encoder = new TextEncoder();

function safeMemzero(
  sodium: Sodium | null,
  buf: Uint8Array | null | undefined,
  hook?: (kind: 'vk' | 'kek' | 'pwk' | 'rk' | 'seed' | 'plaintext') => void,
  kind?: 'vk' | 'kek' | 'pwk' | 'rk' | 'seed' | 'plaintext',
): void {
  if (!buf || buf.byteLength === 0) return;
  if (sodium) {
    sodium.memzero(toLocalBytes(buf));
  } else {
    buf.fill(0);
  }
  if (hook && kind) {
    hook(kind);
  }
}

function bytesEqual(sodium: Sodium, a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return sodium.memcmp(toLocalBytes(a), toLocalBytes(b));
}

const DEFAULT_SLOTS_1_TO_10 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

function validateSlots(slots: number[]): void {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 10) {
    throw new CryptoWorkerError('RECOVERY_KEY_INVALID', 'Recovery key slots must contain 1..10 items');
  }
  const seen: Record<number, true> = {};
  for (const s of slots) {
    if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < RK_SLOT_MIN || s > RK_SLOT_MAX) {
      throw new CryptoWorkerError('RECOVERY_KEY_INVALID', `Invalid recovery key slot: ${String(s)}`);
    }
    if (seen[s]) {
      throw new CryptoWorkerError('RECOVERY_KEY_INVALID', `Duplicate recovery key slot: ${s}`);
    }
    seen[s] = true;
  }
}

export interface CryptoWorkerCore {
  handleMessage: (msg: WorkerRequestMessage) => Promise<WorkerResponseMessage>;
  getGeneration: () => number;
  getState: () => 'locked' | 'unlocked' | 'recovering';
  /** For white-box testing of VK isolation only (never exposed over postMessage). */
  inspectClosureVkForTest: () => Uint8Array | null;
}

export function createWorkerCore(hooks: WorkerCoreHooks = {}): CryptoWorkerCore {
  let workerGeneration = 0;
  let currentVk: Uint8Array | null = null;
  let currentX25519Seed: Uint8Array | null = null;
  let currentEd25519Seed: Uint8Array | null = null;
  let vaultMode: 'locked' | 'unlocked' | 'recovering' = 'locked';

  const recoveryAdapter: RecoveryKeyAdapter = {
    generateRecoveryKey: hooks.recovery?.generateRecoveryKey ?? generateRecoveryKey,
    formatRecoveryKeyDisplay: hooks.recovery?.formatRecoveryKeyDisplay ?? formatRecoveryKeyDisplay,
    normalizeRecoveryKey: hooks.recovery?.normalizeRecoveryKey ?? normalizeRecoveryKey,
    deriveRecoveryLookupHash: hooks.recovery?.deriveRecoveryLookupHash ?? deriveRecoveryLookupHash,
    deriveRecoveryWrapKey: hooks.recovery?.deriveRecoveryWrapKey ?? deriveRecoveryWrapKey,
  };

  const envelopeAdapter: EnvelopeAdapter = {
    validateEntryEnvelope: hooks.envelope?.validateEntryEnvelope ?? validateEntryEnvelope,
    canonicalizeEnvelopeJcs: hooks.envelope?.canonicalizeEnvelopeJcs ?? canonicalizeEnvelopeJcs,
    buildEntryAad: hooks.envelope?.buildEntryAad ?? buildEntryAad,
  };

  const doSealWrap: SealHookFn = hooks.sealWrap ?? ((s, kind, pt, key) => sealWrap(s, kind, pt, key));
  const doSealDevKeyWrap: SealDevKeyHookFn =
    hooks.sealDevKeyWrap ??
    ((s, vk, devKey, userId, vaultKeyId) => sealDevKeyWrap(s, vk, devKey, userId, vaultKeyId));

  function wipeClosureKeys(sodium: Sodium | null): void {
    if (currentVk) {
      safeMemzero(sodium, currentVk, hooks.onKeyZeroed, 'vk');
      currentVk = null;
    }
    if (currentX25519Seed) {
      safeMemzero(sodium, currentX25519Seed, hooks.onKeyZeroed, 'seed');
      currentX25519Seed = null;
    }
    if (currentEd25519Seed) {
      safeMemzero(sodium, currentEd25519Seed, hooks.onKeyZeroed, 'seed');
      currentEd25519Seed = null;
    }
    vaultMode = 'locked';
  }

  function assignClosureKeys(
    sodium: Sodium,
    vk: Uint8Array,
    mode: 'unlocked' | 'recovering',
    x25519Seed?: Uint8Array | null,
    ed25519Seed?: Uint8Array | null,
  ): void {
    wipeClosureKeys(sodium);
    currentVk = new Uint8Array(vk);
    if (x25519Seed) {
      currentX25519Seed = new Uint8Array(x25519Seed);
    }
    if (ed25519Seed) {
      currentEd25519Seed = new Uint8Array(ed25519Seed);
    }
    vaultMode = mode;
  }

  function assertGeneration(cmdGen: number): void {
    if (cmdGen !== workerGeneration) {
      throw new CryptoWorkerError('STALE_GENERATION', 'Operation cancelled by intervening lock');
    }
  }

  function requireUnlockedVk(allowRecovering: boolean): Uint8Array {
    if (!currentVk || vaultMode === 'locked') {
      throw new CryptoWorkerError('VAULT_LOCKED', 'Vault is locked');
    }
    if (vaultMode === 'recovering' && !allowRecovering) {
      throw new CryptoWorkerError(
        'VAULT_RECOVERING',
        'Vault is in recovering mode; only rewrap is allowed until recovery completes',
      );
    }
    return currentVk;
  }

  function buildAndVerifyRecoveryKeys(
    sodium: Sodium,
    vk: Uint8Array,
    slots: number[],
  ): RecoveryKeyItemResult[] {
    validateSlots(slots);
    const items: RecoveryKeyItemResult[] = [];
    for (const slot of slots) {
      const generated = recoveryAdapter.generateRecoveryKey(sodium, slot);
      const norm = recoveryAdapter.normalizeRecoveryKey(generated.display);
      const lookupHashBytes = recoveryAdapter.deriveRecoveryLookupHash(sodium, norm);
      const wrapKey = recoveryAdapter.deriveRecoveryWrapKey(sodium, norm);
      let reopenedVk: Uint8Array | null = null;
      try {
        const wrapBytes = doSealWrap(sodium, 'rk', vk, wrapKey);
        try {
          reopenedVk = openWrap(sodium, 'rk', wrapBytes, wrapKey);
        } catch (err) {
          throw new CryptoWorkerError(
            'WRAP_SELF_CHECK_FAILED',
            `Recovery key wrap self-check decrypt failed for slot ${slot}`,
            { cause: err },
          );
        }
        if (!bytesEqual(sodium, reopenedVk, vk)) {
          throw new CryptoWorkerError(
            'WRAP_SELF_CHECK_FAILED',
            `Recovery key wrap self-check mismatch for slot ${slot}`,
          );
        }
        items.push({
          slot,
          display: generated.display,
          lookup_hash: encodeBase64Url(lookupHashBytes),
          wrap: encodeBase64Url(wrapBytes),
        });
      } finally {
        safeMemzero(sodium, wrapKey, hooks.onKeyZeroed, 'rk');
        safeMemzero(sodium, reopenedVk, hooks.onKeyZeroed, 'vk');
      }
    }
    return items;
  }

  function openAndVerifyPrivateKeys(
    sodium: Sodium,
    vk: Uint8Array,
    privateKeysWrapped?: string,
  ): { x25519Seed: Uint8Array | null; ed25519Seed: Uint8Array | null } {
    if (!privateKeysWrapped) {
      return { x25519Seed: null, ed25519Seed: null };
    }
    const combined = openWrap(sodium, 'priv', privateKeysWrapped, vk);
    try {
      const { x25519Seed, ed25519Seed } = unpackPrivateKeySeeds(combined);
      return { x25519Seed, ed25519Seed };
    } finally {
      safeMemzero(sodium, combined, hooks.onKeyZeroed, 'seed');
    }
  }

  async function executeCommand(sodium: Sodium, msg: WorkerRequestMessage): Promise<unknown> {
    if (msg.type === 'lock') {
      workerGeneration = Math.max(workerGeneration + 1, msg.generation);
      wipeClosureKeys(sodium);
      return { generation: workerGeneration } satisfies LockResult;
    }

    const cmdGen = msg.generation;
    if (vaultMode === 'locked' && !currentVk && cmdGen > workerGeneration) {
      workerGeneration = cmdGen;
    }
    switch (msg.type) {
      case 'createVault': {
        const passphraseBytes = new Uint8Array(msg.passphraseBuffer);
        let vk: Uint8Array | null = null;
        let kek: Uint8Array | null = null;
        let x25519Seed: Uint8Array | null = null;
        let ed25519Seed: Uint8Array | null = null;
        let combinedSeeds: Uint8Array | null = null;
        let x25519Priv: Uint8Array | null = null;
        let ed25519Priv: Uint8Array | null = null;
        let reopenedVk: Uint8Array | null = null;
        let reopenedPriv: Uint8Array | null = null;
        let reopenedXSeed: Uint8Array | null = null;
        let reopenedEdSeed: Uint8Array | null = null;
        let reopenedXPriv: Uint8Array | null = null;
        let reopenedEdPriv: Uint8Array | null = null;

        try {
          assertGeneration(cmdGen);

          const kdf = makeBaselineKdfParams(sodium);
          kek = await deriveKek(sodium, passphraseBytes, kdf, hooks.deriveKek);
          assertGeneration(cmdGen);

          vk = sodium.randombytes_buf(VK_BYTES);
          x25519Seed = sodium.randombytes_buf(SEED_BYTES);
          ed25519Seed = sodium.randombytes_buf(SEED_BYTES);

          const x25519Kp = sodium.crypto_box_seed_keypair(x25519Seed);
          x25519Priv = x25519Kp.privateKey;
          const ed25519Kp = sodium.crypto_sign_seed_keypair(ed25519Seed);
          ed25519Priv = ed25519Kp.privateKey;

          const wrapKBytes = doSealWrap(sodium, 'kek', vk, kek);
          try {
            reopenedVk = openWrap(sodium, 'kek', wrapKBytes, kek);
          } catch (err) {
            throw new CryptoWorkerError(
              'WRAP_SELF_CHECK_FAILED',
              'VK wrap by KEK self-check failed to decrypt',
              { cause: err },
            );
          }
          if (!bytesEqual(sodium, reopenedVk, vk)) {
            throw new CryptoWorkerError(
              'WRAP_SELF_CHECK_FAILED',
              'VK wrap by KEK self-check plaintext mismatch',
            );
          }

          combinedSeeds = packPrivateKeySeeds(x25519Seed, ed25519Seed);
          const privWrapBytes = doSealWrap(sodium, 'priv', combinedSeeds, vk);
          try {
            reopenedPriv = openWrap(sodium, 'priv', privWrapBytes, vk);
          } catch (err) {
            throw new CryptoWorkerError(
              'WRAP_SELF_CHECK_FAILED',
              'Private keys wrap self-check failed to decrypt',
              { cause: err },
            );
          }
          if (!bytesEqual(sodium, reopenedPriv, combinedSeeds)) {
            throw new CryptoWorkerError(
              'WRAP_SELF_CHECK_FAILED',
              'Private keys wrap self-check seed mismatch',
            );
          }

          const unpacked = unpackPrivateKeySeeds(reopenedPriv);
          reopenedXSeed = unpacked.x25519Seed;
          reopenedEdSeed = unpacked.ed25519Seed;
          const checkXKp = sodium.crypto_box_seed_keypair(reopenedXSeed);
          reopenedXPriv = checkXKp.privateKey;
          const checkEdKp = sodium.crypto_sign_seed_keypair(reopenedEdSeed);
          reopenedEdPriv = checkEdKp.privateKey;

          if (
            !bytesEqual(sodium, checkXKp.publicKey, x25519Kp.publicKey) ||
            !bytesEqual(sodium, checkEdKp.publicKey, ed25519Kp.publicKey)
          ) {
            throw new CryptoWorkerError(
              'WRAP_SELF_CHECK_FAILED',
              'Derived public keys from reopened private key wrap did not match',
            );
          }

          const recoveryKeys = msg.skipRecoveryKeys
            ? []
            : buildAndVerifyRecoveryKeys(sodium, vk, [...DEFAULT_SLOTS_1_TO_10]);

          assertGeneration(cmdGen);
          assignClosureKeys(sodium, vk, 'unlocked', x25519Seed, ed25519Seed);

          return {
            kdf,
            vault_key_wrapped_by_kek: encodeBase64Url(wrapKBytes),
            x25519_public: encodeBase64Url(x25519Kp.publicKey),
            ed25519_public: encodeBase64Url(ed25519Kp.publicKey),
            private_keys_wrapped: encodeBase64Url(privWrapBytes),
            recovery_keys: recoveryKeys,
          } satisfies CreateVaultResult;
        } finally {
          safeMemzero(sodium, passphraseBytes, hooks.onKeyZeroed, 'plaintext');
          safeMemzero(sodium, kek, hooks.onKeyZeroed, 'kek');
          safeMemzero(sodium, vk, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, x25519Seed, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, ed25519Seed, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, combinedSeeds, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, x25519Priv, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, ed25519Priv, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, reopenedVk, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, reopenedPriv, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, reopenedXSeed, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, reopenedEdSeed, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, reopenedXPriv, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, reopenedEdPriv, hooks.onKeyZeroed, 'seed');
        }
      }

      case 'unlockPassphrase': {
        const passphraseBytes = new Uint8Array(msg.passphraseBuffer);
        let kek: Uint8Array | null = null;
        let vk: Uint8Array | null = null;
        let x25519Seed: Uint8Array | null = null;
        let ed25519Seed: Uint8Array | null = null;

        try {
          assertGeneration(cmdGen);
          kek = await deriveKek(sodium, passphraseBytes, msg.kdf, hooks.deriveKek);
          assertGeneration(cmdGen);

          vk = openWrap(sodium, 'kek', msg.vaultKeyWrappedByKek, kek);
          const seeds = openAndVerifyPrivateKeys(sodium, vk, msg.privateKeysWrapped);
          x25519Seed = seeds.x25519Seed;
          ed25519Seed = seeds.ed25519Seed;

          assertGeneration(cmdGen);
          assignClosureKeys(sodium, vk, 'unlocked', x25519Seed, ed25519Seed);

          return { unlocked: true };
        } finally {
          safeMemzero(sodium, passphraseBytes, hooks.onKeyZeroed, 'plaintext');
          safeMemzero(sodium, kek, hooks.onKeyZeroed, 'kek');
          safeMemzero(sodium, vk, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, x25519Seed, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, ed25519Seed, hooks.onKeyZeroed, 'seed');
        }
      }

      case 'unlockRecovery': {
        const rkBytes = new Uint8Array(msg.recoveryKeyBuffer);
        let wrapKey: Uint8Array | null = null;
        let vk: Uint8Array | null = null;

        try {
          assertGeneration(cmdGen);
          let rkText: string;
          try {
            rkText = utf8Decoder.decode(rkBytes);
          } catch (err) {
            throw new CryptoWorkerError('RECOVERY_KEY_INVALID', 'Invalid UTF-8 in recovery key', {
              cause: err,
            });
          }

          const rkNorm = recoveryAdapter.normalizeRecoveryKey(rkText);
          const lookupHashBytes = recoveryAdapter.deriveRecoveryLookupHash(sodium, rkNorm);
          const lookupHashB64 = encodeBase64Url(lookupHashBytes);

          if (!msg.wrap) {
            assertGeneration(cmdGen);
            return { lookup_hash: lookupHashB64 } satisfies DeriveRecoveryLookupResult;
          }

          wrapKey = recoveryAdapter.deriveRecoveryWrapKey(sodium, rkNorm);
          vk = openWrap(sodium, 'rk', msg.wrap, wrapKey);

          assertGeneration(cmdGen);
          assignClosureKeys(sodium, vk, 'recovering');

          return {
            lookup_hash: lookupHashB64,
            recovering: true,
          };
        } finally {
          safeMemzero(sodium, rkBytes, hooks.onKeyZeroed, 'rk');
          safeMemzero(sodium, wrapKey, hooks.onKeyZeroed, 'rk');
          safeMemzero(sodium, vk, hooks.onKeyZeroed, 'vk');
        }
      }

      case 'unlockPrf': {
        const pwkBytes = new Uint8Array(msg.pwkBuffer);
        let vk: Uint8Array | null = null;
        let x25519Seed: Uint8Array | null = null;
        let ed25519Seed: Uint8Array | null = null;

        try {
          assertGeneration(cmdGen);
          if (pwkBytes.byteLength !== VK_BYTES) {
            throw new CryptoWorkerError('WRAP_INVALID', 'PRF output (PWK) must be 32 bytes');
          }

          vk = openWrap(sodium, 'prf', msg.vkWrap, pwkBytes);
          const seeds = openAndVerifyPrivateKeys(sodium, vk, msg.privateKeysWrapped);
          x25519Seed = seeds.x25519Seed;
          ed25519Seed = seeds.ed25519Seed;

          assertGeneration(cmdGen);
          assignClosureKeys(sodium, vk, 'unlocked', x25519Seed, ed25519Seed);

          return { unlocked: true };
        } finally {
          safeMemzero(sodium, pwkBytes, hooks.onKeyZeroed, 'pwk');
          safeMemzero(sodium, vk, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, x25519Seed, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, ed25519Seed, hooks.onKeyZeroed, 'seed');
        }
      }

      case 'unlockDevKey': {
        let vk: Uint8Array | null = null;
        let x25519Seed: Uint8Array | null = null;
        let ed25519Seed: Uint8Array | null = null;

        try {
          assertGeneration(cmdGen);
          vk = await openDevKeyWrap(msg.wrappedVk, msg.devKey, msg.userId, msg.vaultKeyId);
          assertGeneration(cmdGen);

          const seeds = openAndVerifyPrivateKeys(sodium, vk, msg.privateKeysWrapped);
          x25519Seed = seeds.x25519Seed;
          ed25519Seed = seeds.ed25519Seed;

          assertGeneration(cmdGen);
          assignClosureKeys(sodium, vk, 'unlocked', x25519Seed, ed25519Seed);

          return { unlocked: true };
        } finally {
          safeMemzero(sodium, vk, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, x25519Seed, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, ed25519Seed, hooks.onKeyZeroed, 'seed');
        }
      }

      case 'rewrap': {
        const passphraseBytes = new Uint8Array(msg.passphraseBuffer);
        let kek: Uint8Array | null = null;
        let vkCopy: Uint8Array | null = null;
        let reopenedVk: Uint8Array | null = null;

        try {
          assertGeneration(cmdGen);
          const activeVk = requireUnlockedVk(true);
          vkCopy = new Uint8Array(activeVk);

          const newKdf = makeRewrapKdfParams(sodium, msg.currentKdf);
          kek = await deriveKek(sodium, passphraseBytes, newKdf, hooks.deriveKek);
          assertGeneration(cmdGen);

          const activeVkAfter = requireUnlockedVk(true);
          if (!bytesEqual(sodium, activeVkAfter, vkCopy)) {
            throw new CryptoWorkerError('STALE_GENERATION', 'Vault key changed during rewrap');
          }

          const wrapKBytes = doSealWrap(sodium, 'kek', vkCopy, kek);
          try {
            reopenedVk = openWrap(sodium, 'kek', wrapKBytes, kek);
          } catch (err) {
            throw new CryptoWorkerError(
              'WRAP_SELF_CHECK_FAILED',
              'Rewrap KEK self-check failed to decrypt',
              { cause: err },
            );
          }
          if (!bytesEqual(sodium, reopenedVk, vkCopy)) {
            throw new CryptoWorkerError(
              'WRAP_SELF_CHECK_FAILED',
              'Rewrap KEK self-check plaintext mismatch',
            );
          }

          assertGeneration(cmdGen);
          if (vaultMode === 'recovering') {
            vaultMode = 'unlocked';
          }

          return {
            kdf: newKdf,
            vault_key_wrapped_by_kek: encodeBase64Url(wrapKBytes),
          } satisfies RewrapResult;
        } finally {
          safeMemzero(sodium, passphraseBytes, hooks.onKeyZeroed, 'plaintext');
          safeMemzero(sodium, kek, hooks.onKeyZeroed, 'kek');
          safeMemzero(sodium, vkCopy, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, reopenedVk, hooks.onKeyZeroed, 'vk');
        }
      }

      case 'makeRecoveryKeys': {
        let vkCopy: Uint8Array | null = null;
        try {
          assertGeneration(cmdGen);
          const activeVk = requireUnlockedVk(false);
          vkCopy = new Uint8Array(activeVk);

          const slots = msg.slots ?? [...DEFAULT_SLOTS_1_TO_10];
          const recoveryKeys = buildAndVerifyRecoveryKeys(sodium, vkCopy, slots);

          assertGeneration(cmdGen);
          return { recovery_keys: recoveryKeys } satisfies MakeRecoveryKeysResult;
        } finally {
          safeMemzero(sodium, vkCopy, hooks.onKeyZeroed, 'vk');
        }
      }

      case 'wrapForPasskey': {
        const pwkBytes = new Uint8Array(msg.pwkBuffer);
        let vkCopy: Uint8Array | null = null;
        let reopenedVk: Uint8Array | null = null;

        try {
          assertGeneration(cmdGen);
          if (pwkBytes.byteLength !== VK_BYTES) {
            throw new CryptoWorkerError('WRAP_INVALID', 'PRF output (PWK) must be 32 bytes');
          }
          const activeVk = requireUnlockedVk(false);
          vkCopy = new Uint8Array(activeVk);

          const vkWrapBytes = doSealWrap(sodium, 'prf', vkCopy, pwkBytes);
          try {
            reopenedVk = openWrap(sodium, 'prf', vkWrapBytes, pwkBytes);
          } catch (err) {
            throw new CryptoWorkerError(
              'WRAP_SELF_CHECK_FAILED',
              'Passkey PRF wrap self-check failed to decrypt',
              { cause: err },
            );
          }
          if (!bytesEqual(sodium, reopenedVk, vkCopy)) {
            throw new CryptoWorkerError(
              'WRAP_SELF_CHECK_FAILED',
              'Passkey PRF wrap self-check plaintext mismatch',
            );
          }

          assertGeneration(cmdGen);
          return { vk_wrap: encodeBase64Url(vkWrapBytes) } satisfies WrapForPasskeyResult;
        } finally {
          safeMemzero(sodium, pwkBytes, hooks.onKeyZeroed, 'pwk');
          safeMemzero(sodium, vkCopy, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, reopenedVk, hooks.onKeyZeroed, 'vk');
        }
      }

      case 'wrapForDevice': {
        let vkCopy: Uint8Array | null = null;
        let reopenedVk: Uint8Array | null = null;

        try {
          assertGeneration(cmdGen);
          const activeVk = requireUnlockedVk(false);
          vkCopy = new Uint8Array(activeVk);

          const wrappedVk = await doSealDevKeyWrap(
            sodium,
            vkCopy,
            msg.devKey,
            msg.userId,
            msg.vaultKeyId,
          );
          assertGeneration(cmdGen);

          try {
            reopenedVk = await openDevKeyWrap(
              wrappedVk,
              msg.devKey,
              msg.userId,
              msg.vaultKeyId,
            );
          } catch (err) {
            throw new CryptoWorkerError(
              'WRAP_SELF_CHECK_FAILED',
              'DevKey wrap self-check failed to decrypt',
              { cause: err },
            );
          }
          if (!bytesEqual(sodium, reopenedVk, vkCopy)) {
            throw new CryptoWorkerError(
              'WRAP_SELF_CHECK_FAILED',
              'DevKey wrap self-check plaintext mismatch',
            );
          }

          assertGeneration(cmdGen);
          return { wrapped_vk: wrappedVk } satisfies WrapForDeviceResult;
        } finally {
          safeMemzero(sodium, vkCopy, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, reopenedVk, hooks.onKeyZeroed, 'vk');
        }
      }

      case 'sealEntry': {
        let vkCopy: Uint8Array | null = null;
        let ptBytes: Uint8Array | null = null;

        try {
          assertGeneration(cmdGen);
          const activeVk = requireUnlockedVk(false);
          vkCopy = new Uint8Array(activeVk);

          ptBytes =
            typeof msg.plaintext === 'string'
              ? toLocalBytes(utf8Encoder.encode(msg.plaintext))
              : toLocalBytes(msg.plaintext);

          const nonceBytes = sodium.randombytes_buf(WRAP_NONCE_BYTES);
          const candidateEnvelope: EntryEnvelopeV1 = {
            v: ENVELOPE_VERSION,
            alg: ENVELOPE_ALG,
            key_id: msg.keyId,
            nonce: encodeBase64Url(nonceBytes),
            ct_enc: ENVELOPE_CT_ENC,
          };

          const validatedEnvelope = envelopeAdapter.validateEntryEnvelope(candidateEnvelope);
          void envelopeAdapter.canonicalizeEnvelopeJcs(validatedEnvelope);
          const aad = envelopeAdapter.buildEntryAad(validatedEnvelope, msg.entryId);

          const ctBytes = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
            ptBytes,
            toLocalBytes(aad),
            null,
            toLocalBytes(nonceBytes),
            vkCopy,
            'uint8array',
          );

          assertGeneration(cmdGen);
          return {
            envelope: validatedEnvelope,
            ciphertext: encodeBase64Url(ctBytes),
          } satisfies SealEntryResult;
        } finally {
          safeMemzero(sodium, vkCopy, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, ptBytes, hooks.onKeyZeroed, 'plaintext');
        }
      }

      case 'openEntry': {
        let vkCopy: Uint8Array | null = null;
        let ptBytes: Uint8Array | null = null;

        try {
          assertGeneration(cmdGen);
          const activeVk = requireUnlockedVk(false);
          vkCopy = new Uint8Array(activeVk);

          const validatedEnvelope = envelopeAdapter.validateEntryEnvelope(msg.envelope);
          void envelopeAdapter.canonicalizeEnvelopeJcs(validatedEnvelope);
          const aad = envelopeAdapter.buildEntryAad(validatedEnvelope, msg.entryId);
          const nonceBytes = decodeBase64UrlStrict(validatedEnvelope.nonce, WRAP_NONCE_BYTES);
          const ctBytes =
            typeof msg.ciphertext === 'string'
              ? decodeBase64UrlStrict(msg.ciphertext)
              : msg.ciphertext;

          try {
            ptBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
              null,
              toLocalBytes(ctBytes),
              toLocalBytes(aad),
              toLocalBytes(nonceBytes),
              vkCopy,
              'uint8array',
            );
          } catch (err) {
            throw new WrapError('AEAD_DECRYPT_FAILED', 'Entry AEAD decryption failed', {
              cause: err,
            });
          }

          assertGeneration(cmdGen);
          const plaintext = utf8Decoder.decode(ptBytes);
          return { plaintext } satisfies OpenEntryResult;
        } finally {
          safeMemzero(sodium, vkCopy, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, ptBytes, hooks.onKeyZeroed, 'plaintext');
        }
      }
    }
  }

  function mapError(err: unknown): { code: CryptoWorkerErrorCode; message: string } {
    if (err instanceof CryptoWorkerError) {
      return { code: err.code, message: err.message };
    }
    if (err instanceof KdfError) {
      return { code: err.code, message: err.message };
    }
    if (err instanceof WrapError) {
      return { code: err.code, message: err.message };
    }
    if (err instanceof RecoveryKeyError) {
      return { code: err.code, message: err.message };
    }
    if (err instanceof EnvelopeError) {
      return { code: err.code, message: err.message };
    }
    if (err instanceof Error) {
      if (err.message.startsWith('NOT_IMPLEMENTED:')) {
        return { code: 'NOT_IMPLEMENTED', message: err.message };
      }
      return { code: 'WORKER_INTERNAL_ERROR', message: err.message };
    }
    return { code: 'WORKER_INTERNAL_ERROR', message: 'Unknown crypto worker error' };
  }

  return {
    async handleMessage(msg: WorkerRequestMessage): Promise<WorkerResponseMessage> {
      try {
        const sodium = await getSodium();
        const result = await executeCommand(sodium, msg);
        return {
          id: msg.id,
          generation: msg.type === 'lock' ? workerGeneration : msg.generation,
          ok: true,
          result,
        };
      } catch (err) {
        const mapped = mapError(err);
        return {
          id: msg.id,
          generation: msg.generation,
          ok: false,
          error: mapped,
        };
      }
    },
    getGeneration(): number {
      return workerGeneration;
    },
    getState() {
      return vaultMode;
    },
    inspectClosureVkForTest(): Uint8Array | null {
      return currentVk ? new Uint8Array(currentVk) : null;
    },
  };
}

export interface MessagePortLike {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<WorkerRequestMessage>) => void) | null;
}

/**
 * Attaches a `CryptoWorkerCore` instance to a `DedicatedWorkerGlobalScope` or `MessagePort`.
 */
export function attachWorkerCore(
  scope: MessagePortLike,
  core: CryptoWorkerCore = createWorkerCore(),
): CryptoWorkerCore {
  scope.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
    void core.handleMessage(event.data).then((response) => {
      scope.postMessage(response);
    });
  };
  return core;
}
