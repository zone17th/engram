import { Base64UrlError, encodeBase64Url } from './b64url';
import {
  buildEntryAad,
  canonicalizeEnvelopeJcs,
  EnvelopeError,
  openEntryPayload,
  sealEntryPayload,
  validateEntryEnvelope,
  type EnvelopeAdapter,
  type EntryEnvelopeV1,
} from './envelope';
import { JcsError } from './jcs';
import {
  deriveKek,
  KdfError,
  makeBaselineKdfParams,
  makeRewrapKdfParams,
  type DeriveKekFn,
  type VaultKdfParams,
} from './kdf';
import {
  CryptoWorkerError,
  type ConfirmRecoveryResult,
  type CreateVaultResult,
  type CryptoWorkerErrorCode,
  type DeriveRecoveryLookupResult,
  type LockResult,
  type MakeRecoveryKeysResult,
  type OpenEntryResult,
  type RecoveryKeyItemResult,
  type ResumeRecoveryResult,
  type RewrapResult,
  type SealEntryResult,
  type VaultMode,
  type WorkerCommandPayload,
  type WorkerCommandType,
  type WorkerErrorResponse,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
  type WorkerStateReport,
  type WorkerSuccessResponse,
  type WrapForDeviceResult,
  type WrapForPasskeyResult,
} from './protocol';
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
  WrapError,
  type WrapKind,
} from './wrap';

export {
  CryptoWorkerError,
  type ConfirmRecoveryResult,
  type CreateVaultResult,
  type CryptoWorkerErrorCode,
  type DeriveRecoveryLookupResult,
  type EntryEnvelopeV1,
  type LockResult,
  type MakeRecoveryKeysResult,
  type OpenEntryResult,
  type RecoveryKeyItemResult,
  type ResumeRecoveryResult,
  type RewrapResult,
  type SealEntryResult,
  type VaultKdfParams,
  type VaultMode,
  type WorkerCommandPayload,
  type WorkerCommandType,
  type WorkerErrorResponse,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
  type WorkerStateReport,
  type WorkerSuccessResponse,
  type WrapForDeviceResult,
  type WrapForPasskeyResult,
};

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
  /**
   * Test-only: called with every Worker-owned secret COPY the core allocates itself (libsodium/WebCrypto
   * outputs are tracked by wrapping those primitives), so tests can assert the actual allocation is zeroed.
   */
  onSecretAllocated?: (kind: SecretAllocationKind, buf: Uint8Array) => void;
}

export type SecretAllocationKind =
  | 'vk-copy'
  | 'wrap-key-copy'
  | 'seed-copy'
  | 'closure-vk'
  | 'closure-seed';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

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

function isCrossRealmArrayBuffer(val: unknown): val is ArrayBuffer {
  if (!val || typeof val !== 'object') return false;
  if (val instanceof ArrayBuffer) return true;
  return Object.prototype.toString.call(val) === '[object ArrayBuffer]';
}

function wipeIncomingMessageSecrets(
  sodium: Sodium | null,
  msg: unknown,
  hook?: (kind: 'vk' | 'kek' | 'pwk' | 'rk' | 'seed' | 'plaintext') => void,
): void {
  if (typeof msg !== 'object' || msg === null) return;
  if ('passphraseBuffer' in msg && isCrossRealmArrayBuffer(msg.passphraseBuffer)) {
    safeMemzero(sodium, new Uint8Array(msg.passphraseBuffer), hook, 'plaintext');
  }
  if ('recoveryKeyBuffer' in msg && isCrossRealmArrayBuffer(msg.recoveryKeyBuffer)) {
    safeMemzero(sodium, new Uint8Array(msg.recoveryKeyBuffer), hook, 'rk');
  }
  if ('pwkBuffer' in msg && isCrossRealmArrayBuffer(msg.pwkBuffer)) {
    safeMemzero(sodium, new Uint8Array(msg.pwkBuffer), hook, 'pwk');
  }
  if (
    'type' in msg &&
    msg.type === 'sealEntry' &&
    'plaintext' in msg &&
    ArrayBuffer.isView(msg.plaintext)
  ) {
    safeMemzero(
      sodium,
      new Uint8Array(msg.plaintext.buffer, msg.plaintext.byteOffset, msg.plaintext.byteLength),
      hook,
      'plaintext',
    );
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
      throw new CryptoWorkerError('RECOVERY_KEY_INVALID', 'Invalid recovery key slot');
    }
    if (seen[s]) {
      throw new CryptoWorkerError('RECOVERY_KEY_INVALID', 'Duplicate recovery key slot');
    }
    seen[s] = true;
  }
}

/**
 * State-changing commands. They run strictly one at a time in the Worker's serial queue
 * (ADR 0002 §10 rule 4); `lock` is exempt and preempts; the rest are read-only against committed state.
 */
const STATE_COMMANDS: ReadonlySet<WorkerCommandType> = new Set<WorkerCommandType>([
  'createVault',
  'unlockPassphrase',
  'unlockRecovery',
  'resumeRecovery',
  'confirmRecovery',
  'unlockPrf',
  'unlockDevKey',
  'rewrap',
]);

export interface WorkerStateSnapshot {
  mode: VaultMode;
  generation: number;
  epoch: number;
  hasPendingContinuation: boolean;
}

interface PendingRecoveryState {
  wrapKey: Uint8Array;
  lookupHash: string;
  generation: number;
}

type TransitionAction =
  | { kind: 'lock'; nextGeneration: number }
  | { kind: 'adoptGeneration'; generation: number; disposeContinuation: boolean }
  | { kind: 'disposeContinuation' }
  | { kind: 'installContinuation'; pending: PendingRecoveryState }
  | {
      kind: 'enterRecovering';
      vk: Uint8Array;
      x25519Seed?: Uint8Array | null;
      ed25519Seed?: Uint8Array | null;
    }
  | { kind: 'rewrapInRecovering' }
  | { kind: 'confirmRecovery' }
  | {
      kind: 'unlock';
      vk: Uint8Array;
      x25519Seed?: Uint8Array | null;
      ed25519Seed?: Uint8Array | null;
    }
  | {
      kind: 'createVault';
      vk: Uint8Array;
      x25519Seed?: Uint8Array | null;
      ed25519Seed?: Uint8Array | null;
    };

export interface CryptoWorkerCore {
  handleMessage: (msg: WorkerRequestMessage) => Promise<WorkerResponseMessage>;
  getGeneration: () => number;
  getEpoch: () => number;
  getState: () => VaultMode;
  getStateSnapshot: () => WorkerStateSnapshot;
  getStateReport: () => WorkerStateReport;
  /** For white-box testing of VK isolation only (never exposed over postMessage). */
  inspectClosureVkForTest: () => Uint8Array | null;
}

export function createWorkerCore(hooks: WorkerCoreHooks = {}): CryptoWorkerCore {
  let workerGeneration = 0;
  let workerEpoch = 0;
  let currentVk: Uint8Array | null = null;
  let currentX25519Seed: Uint8Array | null = null;
  let currentEd25519Seed: Uint8Array | null = null;
  let pendingRecovery: PendingRecoveryState | null = null;
  let vaultMode: VaultMode = 'locked';

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

  function stateReport(): WorkerStateReport {
    return { mode: vaultMode, generation: workerGeneration, epoch: workerEpoch };
  }

  function captureStateSnapshot(): WorkerStateSnapshot {
    return {
      mode: vaultMode,
      generation: workerGeneration,
      epoch: workerEpoch,
      hasPendingContinuation: pendingRecovery !== null,
    };
  }

  /**
   * Single structural state-commit helper (r4 fix-3).
   * Every state transition, key installation, or continuation install/disposal
   * goes through this helper, which re-checks the captured `(mode, generation, epoch)`
   * triple against the current state and the recovering whitelist before mutating
   * closure keys/mode/continuation, and increments `workerEpoch` on every transition.
   */
  function commitTransition(
    sodium: Sodium | null,
    captured: WorkerStateSnapshot | null,
    cmdType: WorkerCommandType,
    action: TransitionAction,
  ): void {
    function wipePendingInternal(): void {
      if (pendingRecovery) {
        safeMemzero(sodium, pendingRecovery.wrapKey, hooks.onKeyZeroed, 'rk');
        pendingRecovery = null;
      }
    }

    function wipeClosureInternal(): void {
      wipePendingInternal();
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

    function assignClosureInternal(
      vk: Uint8Array,
      nextMode: 'unlocked' | 'recovering',
      x25519Seed?: Uint8Array | null,
      ed25519Seed?: Uint8Array | null,
    ): void {
      wipeClosureInternal();
      currentVk = new Uint8Array(vk);
      hooks.onSecretAllocated?.('closure-vk', currentVk);
      if (x25519Seed) {
        currentX25519Seed = new Uint8Array(x25519Seed);
        hooks.onSecretAllocated?.('closure-seed', currentX25519Seed);
      }
      if (ed25519Seed) {
        currentEd25519Seed = new Uint8Array(ed25519Seed);
        hooks.onSecretAllocated?.('closure-seed', currentEd25519Seed);
      }
      vaultMode = nextMode;
    }

    if (action.kind === 'lock') {
      workerGeneration = action.nextGeneration;
      wipeClosureInternal();
      workerEpoch += 1;
      return;
    }

    if (action.kind === 'adoptGeneration') {
      if (action.disposeContinuation) {
        wipePendingInternal();
      }
      workerGeneration = action.generation;
      workerEpoch += 1;
      return;
    }

    if (action.kind === 'disposeContinuation') {
      if (pendingRecovery) {
        wipePendingInternal();
        workerEpoch += 1;
      }
      return;
    }

    if (!captured) {
      throw new CryptoWorkerError('STALE_GENERATION', 'Missing captured state snapshot');
    }

    if (
      vaultMode === 'recovering' &&
      cmdType !== 'rewrap' &&
      cmdType !== 'confirmRecovery' &&
      cmdType !== 'lock'
    ) {
      throw new CryptoWorkerError(
        'VAULT_RECOVERING',
        'Vault is in recovering mode; only rewrap, confirmRecovery, and lock are allowed (call lock() first to switch flows)',
      );
    }

    if (
      captured.generation !== workerGeneration ||
      captured.mode !== vaultMode ||
      captured.epoch !== workerEpoch
    ) {
      throw new CryptoWorkerError(
        'STALE_GENERATION',
        'Worker state (mode, generation, epoch) changed before commit',
      );
    }

    switch (action.kind) {
      case 'installContinuation': {
        wipePendingInternal();
        pendingRecovery = action.pending;
        workerEpoch += 1;
        return;
      }
      case 'enterRecovering': {
        assignClosureInternal(action.vk, 'recovering', action.x25519Seed, action.ed25519Seed);
        workerEpoch += 1;
        return;
      }
      case 'rewrapInRecovering': {
        workerEpoch += 1;
        return;
      }
      case 'confirmRecovery': {
        if (!currentVk || vaultMode === 'locked') {
          throw new CryptoWorkerError('VAULT_LOCKED', 'Vault is locked');
        }
        if (vaultMode !== 'recovering') {
          throw new CryptoWorkerError(
            'VAULT_NOT_RECOVERING',
            'Vault is not in recovering mode',
          );
        }
        vaultMode = 'unlocked';
        workerEpoch += 1;
        return;
      }
      case 'unlock':
      case 'createVault': {
        assignClosureInternal(action.vk, 'unlocked', action.x25519Seed, action.ed25519Seed);
        workerEpoch += 1;
        return;
      }
    }
  }

  function assertReadOnlyStart(
    allowRecovering: boolean,
  ): { captured: WorkerStateSnapshot; vk: Uint8Array } {
    if (vaultMode === 'recovering' && !allowRecovering) {
      throw new CryptoWorkerError(
        'VAULT_RECOVERING',
        'Vault is in recovering mode; only rewrap and confirmRecovery are allowed until recovery completes',
      );
    }
    if (!currentVk || vaultMode === 'locked') {
      throw new CryptoWorkerError('VAULT_LOCKED', 'Vault is locked');
    }
    return {
      captured: captureStateSnapshot(),
      vk: currentVk,
    };
  }

  function assertReadOnlyBeforeReturn(
    sodium: Sodium,
    captured: WorkerStateSnapshot,
    vkCopy: Uint8Array,
    allowRecovering: boolean,
  ): void {
    if (vaultMode === 'recovering' && !allowRecovering) {
      throw new CryptoWorkerError(
        'VAULT_RECOVERING',
        'Vault is in recovering mode; only rewrap and confirmRecovery are allowed until recovery completes',
      );
    }
    if (
      captured.generation !== workerGeneration ||
      captured.mode !== vaultMode ||
      captured.epoch !== workerEpoch ||
      !currentVk ||
      !bytesEqual(sodium, currentVk, vkCopy)
    ) {
      throw new CryptoWorkerError(
        'STALE_GENERATION',
        'Worker state changed before read-only command completed',
      );
    }
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
      let lookupHashBytes: Uint8Array | null = null;
      let wrapKey: Uint8Array | null = null;
      let reopenedVk: Uint8Array | null = null;
      try {
        lookupHashBytes = recoveryAdapter.deriveRecoveryLookupHash(sodium, norm);
        wrapKey = recoveryAdapter.deriveRecoveryWrapKey(sodium, norm);
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
        safeMemzero(sodium, lookupHashBytes, hooks.onKeyZeroed, 'rk');
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
    let combined: Uint8Array;
    try {
      combined = openWrap(sodium, 'priv', privateKeysWrapped, vk);
    } catch (err) {
      if (err instanceof WrapError && err.code === 'AEAD_DECRYPT_FAILED') {
        throw new CryptoWorkerError(
          'PRIVATE_KEYS_WRAP_INVALID',
          'Private keys wrap AEAD authentication failed after vault key opened',
          { cause: err },
        );
      }
      throw err;
    }
    try {
      const { x25519Seed, ed25519Seed } = unpackPrivateKeySeeds(combined);
      hooks.onSecretAllocated?.('seed-copy', x25519Seed);
      hooks.onSecretAllocated?.('seed-copy', ed25519Seed);
      return { x25519Seed, ed25519Seed };
    } finally {
      safeMemzero(sodium, combined, hooks.onKeyZeroed, 'seed');
    }
  }

  /** Routed through `commitTransition`, the only writer of Worker state (BE4-5, T-r4-1). */
  function disposePendingContinuation(sodium: Sodium | null): void {
    commitTransition(sodium, null, 'lock', { kind: 'disposeContinuation' });
  }

  function cleanupCommandOnReject(sodium: Sodium | null, msg: unknown): void {
    wipeIncomingMessageSecrets(sodium, msg, hooks.onKeyZeroed);
    if (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      (msg.type === 'resumeRecovery' || msg.type === 'unlockRecovery')
    ) {
      disposePendingContinuation(sodium);
    }
  }

  async function executeCommand(sodium: Sodium, msg: WorkerRequestMessage): Promise<unknown> {
    if (msg.type === 'lock') {
      const incomingGen =
        typeof msg.generation === 'number' && Number.isSafeInteger(msg.generation) && msg.generation >= 0
          ? msg.generation
          : workerGeneration + 1;
      const nextGen = Math.max(workerGeneration + 1, incomingGen);
      commitTransition(sodium, null, 'lock', { kind: 'lock', nextGeneration: nextGen });
      return { generation: workerGeneration } satisfies LockResult;
    }

    const cmdGen = msg.generation;
    if (typeof cmdGen !== 'number' || !Number.isSafeInteger(cmdGen) || cmdGen < 0) {
      cleanupCommandOnReject(sodium, msg);
      throw new CryptoWorkerError('STALE_GENERATION', 'Invalid command generation');
    }

    if (vaultMode === 'locked' && !currentVk && cmdGen > workerGeneration) {
      commitTransition(sodium, null, msg.type, {
        kind: 'adoptGeneration',
        generation: cmdGen,
        disposeContinuation: msg.type !== 'resumeRecovery',
      });
    }

    if (cmdGen !== workerGeneration) {
      cleanupCommandOnReject(sodium, msg);
      throw new CryptoWorkerError('STALE_GENERATION', 'Operation cancelled by intervening lock');
    }

    // Start-time whitelist (BE4-4): a non-whitelisted state command in `recovering` is rejected BEFORE any
    // KDF or key work. The commit point re-checks it for commands that were already in flight.
    if (
      vaultMode === 'recovering' &&
      STATE_COMMANDS.has(msg.type) &&
      msg.type !== 'rewrap' &&
      msg.type !== 'confirmRecovery'
    ) {
      cleanupCommandOnReject(sodium, msg);
      throw new CryptoWorkerError(
        'VAULT_RECOVERING',
        'Vault is in recovering mode; only rewrap, confirmRecovery, and lock are allowed (call lock() first to switch flows)',
      );
    }
    switch (msg.type) {
      case 'createVault': {
        const captured = captureStateSnapshot();
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
          const kdf = makeBaselineKdfParams(sodium);
          kek = await deriveKek(sodium, passphraseBytes, kdf, hooks.deriveKek);

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

          commitTransition(sodium, captured, 'createVault', {
            kind: 'createVault',
            vk,
            x25519Seed,
            ed25519Seed,
          });

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
        const captured = captureStateSnapshot();
        const passphraseBytes = new Uint8Array(msg.passphraseBuffer);
        let kek: Uint8Array | null = null;
        let vk: Uint8Array | null = null;
        let x25519Seed: Uint8Array | null = null;
        let ed25519Seed: Uint8Array | null = null;

        try {
          kek = await deriveKek(sodium, passphraseBytes, msg.kdf, hooks.deriveKek);
          if (vaultMode !== 'recovering') {
            vk = openWrap(sodium, 'kek', msg.vaultKeyWrappedByKek, kek);
            const seeds = openAndVerifyPrivateKeys(sodium, vk, msg.privateKeysWrapped);
            x25519Seed = seeds.x25519Seed;
            ed25519Seed = seeds.ed25519Seed;
          }

          commitTransition(sodium, captured, 'unlockPassphrase', {
            kind: 'unlock',
            vk: vk!,
            x25519Seed,
            ed25519Seed,
          });
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
        let lookupHashBytes: Uint8Array | null = null;
        let wrapKey: Uint8Array | null = null;
        let vk: Uint8Array | null = null;
        let x25519Seed: Uint8Array | null = null;
        let ed25519Seed: Uint8Array | null = null;

        try {
          disposePendingContinuation(sodium);
          const captured = captureStateSnapshot();
          let lookupHashB64 = '';

          if (vaultMode !== 'recovering') {
            let rkText: string;
            try {
              rkText = utf8Decoder.decode(rkBytes);
            } catch (err) {
              throw new CryptoWorkerError('RECOVERY_KEY_INVALID', 'Invalid UTF-8 in recovery key', {
                cause: err,
              });
            }

            const rkNorm = recoveryAdapter.normalizeRecoveryKey(rkText);
            lookupHashBytes = recoveryAdapter.deriveRecoveryLookupHash(sodium, rkNorm);
            lookupHashB64 = encodeBase64Url(lookupHashBytes);
            wrapKey = recoveryAdapter.deriveRecoveryWrapKey(sodium, rkNorm);

            if (msg.wrap) {
              vk = openWrap(sodium, 'rk', msg.wrap, wrapKey);
              const seeds = openAndVerifyPrivateKeys(sodium, vk, msg.privateKeysWrapped);
              x25519Seed = seeds.x25519Seed;
              ed25519Seed = seeds.ed25519Seed;
            }
          }

          commitTransition(
            sodium,
            captured,
            'unlockRecovery',
            msg.wrap
              ? {
                  kind: 'enterRecovering',
                  vk: vk!,
                  x25519Seed,
                  ed25519Seed,
                }
              : {
                  kind: 'installContinuation',
                  pending: {
                    wrapKey: wrapKey!,
                    lookupHash: lookupHashB64,
                    generation: cmdGen,
                  },
                },
          );
          if (!msg.wrap) {
            wrapKey = null;
            return { lookup_hash: lookupHashB64 } satisfies DeriveRecoveryLookupResult;
          }

          return {
            lookup_hash: lookupHashB64,
            recovering: true,
          };
        } finally {
          safeMemzero(sodium, rkBytes, hooks.onKeyZeroed, 'rk');
          safeMemzero(sodium, lookupHashBytes, hooks.onKeyZeroed, 'rk');
          safeMemzero(sodium, wrapKey, hooks.onKeyZeroed, 'rk');
          safeMemzero(sodium, vk, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, x25519Seed, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, ed25519Seed, hooks.onKeyZeroed, 'seed');
        }
      }

      case 'resumeRecovery': {
        let vk: Uint8Array | null = null;
        let x25519Seed: Uint8Array | null = null;
        let ed25519Seed: Uint8Array | null = null;
        let wrapKeyCopy: Uint8Array | null = null;

        try {
          let lookupHash = '';
          let captured = captureStateSnapshot();
          if (vaultMode !== 'recovering') {
            if (!pendingRecovery) {
              throw new CryptoWorkerError(
                'RECOVERY_CONTINUATION_MISSING',
                'No pending recovery key continuation is available',
              );
            }
            if (pendingRecovery.generation !== cmdGen) {
              disposePendingContinuation(sodium);
              throw new CryptoWorkerError(
                'STALE_GENERATION',
                'Pending recovery continuation belongs to a different generation',
              );
            }

            lookupHash = pendingRecovery.lookupHash;
            wrapKeyCopy = new Uint8Array(pendingRecovery.wrapKey);
            hooks.onSecretAllocated?.('wrap-key-copy', wrapKeyCopy);
            disposePendingContinuation(sodium);
            captured = captureStateSnapshot();

            vk = openWrap(sodium, 'rk', msg.wrap, wrapKeyCopy);
            const seeds = openAndVerifyPrivateKeys(sodium, vk, msg.privateKeysWrapped);
            x25519Seed = seeds.x25519Seed;
            ed25519Seed = seeds.ed25519Seed;
          }

          commitTransition(sodium, captured, 'resumeRecovery', {
            kind: 'enterRecovering',
            vk: vk!,
            x25519Seed,
            ed25519Seed,
          });

          return {
            lookup_hash: lookupHash,
            recovering: true,
          } satisfies ResumeRecoveryResult;
        } finally {
          disposePendingContinuation(sodium);
          safeMemzero(sodium, wrapKeyCopy, hooks.onKeyZeroed, 'rk');
          safeMemzero(sodium, vk, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, x25519Seed, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, ed25519Seed, hooks.onKeyZeroed, 'seed');
        }
      }

      case 'confirmRecovery': {
        const captured = captureStateSnapshot();
        commitTransition(sodium, captured, 'confirmRecovery', { kind: 'confirmRecovery' });
        return { unlocked: true } satisfies ConfirmRecoveryResult;
      }

      case 'unlockPrf': {
        const captured = captureStateSnapshot();
        const pwkBytes = new Uint8Array(msg.pwkBuffer);
        let vk: Uint8Array | null = null;
        let x25519Seed: Uint8Array | null = null;
        let ed25519Seed: Uint8Array | null = null;

        try {
          if (vaultMode !== 'recovering') {
            if (pwkBytes.byteLength !== VK_BYTES) {
              throw new CryptoWorkerError('WRAP_INVALID', 'PRF output (PWK) must be 32 bytes');
            }

            vk = openWrap(sodium, 'prf', msg.vkWrap, pwkBytes);
            const seeds = openAndVerifyPrivateKeys(sodium, vk, msg.privateKeysWrapped);
            x25519Seed = seeds.x25519Seed;
            ed25519Seed = seeds.ed25519Seed;
          }

          commitTransition(sodium, captured, 'unlockPrf', {
            kind: 'unlock',
            vk: vk!,
            x25519Seed,
            ed25519Seed,
          });

          return { unlocked: true };
        } finally {
          safeMemzero(sodium, pwkBytes, hooks.onKeyZeroed, 'pwk');
          safeMemzero(sodium, vk, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, x25519Seed, hooks.onKeyZeroed, 'seed');
          safeMemzero(sodium, ed25519Seed, hooks.onKeyZeroed, 'seed');
        }
      }

      case 'unlockDevKey': {
        const captured = captureStateSnapshot();
        let vk: Uint8Array | null = null;
        let x25519Seed: Uint8Array | null = null;
        let ed25519Seed: Uint8Array | null = null;

        try {
          if (captured.mode !== 'recovering') {
            vk = await openDevKeyWrap(msg.wrappedVk, msg.devKey, msg.userId, msg.vaultKeyId);
            if (vaultMode !== 'recovering') {
              const seeds = openAndVerifyPrivateKeys(sodium, vk, msg.privateKeysWrapped);
              x25519Seed = seeds.x25519Seed;
              ed25519Seed = seeds.ed25519Seed;
            }
          }
          commitTransition(sodium, captured, 'unlockDevKey', {
            kind: 'unlock',
            vk: vk!,
            x25519Seed,
            ed25519Seed,
          });

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
          const { captured, vk: activeVk } = assertReadOnlyStart(true);
          vkCopy = new Uint8Array(activeVk);
          hooks.onSecretAllocated?.('vk-copy', vkCopy);

          const newKdf = makeRewrapKdfParams(sodium, msg.currentKdf);
          kek = await deriveKek(sodium, passphraseBytes, newKdf, hooks.deriveKek);

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

          assertReadOnlyBeforeReturn(sodium, captured, vkCopy, true);
          if (captured.mode === 'recovering') {
            commitTransition(sodium, captured, 'rewrap', { kind: 'rewrapInRecovering' });
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
          const { captured, vk: activeVk } = assertReadOnlyStart(false);
          vkCopy = new Uint8Array(activeVk);
          hooks.onSecretAllocated?.('vk-copy', vkCopy);

          const slots = msg.slots ?? [...DEFAULT_SLOTS_1_TO_10];
          const recoveryKeys = buildAndVerifyRecoveryKeys(sodium, vkCopy, slots);

          assertReadOnlyBeforeReturn(sodium, captured, vkCopy, false);
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
          const { captured, vk: activeVk } = assertReadOnlyStart(false);
          if (pwkBytes.byteLength !== VK_BYTES) {
            throw new CryptoWorkerError('WRAP_INVALID', 'PRF output (PWK) must be 32 bytes');
          }
          vkCopy = new Uint8Array(activeVk);
          hooks.onSecretAllocated?.('vk-copy', vkCopy);

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

          assertReadOnlyBeforeReturn(sodium, captured, vkCopy, false);
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
          const { captured, vk: activeVk } = assertReadOnlyStart(false);
          vkCopy = new Uint8Array(activeVk);
          hooks.onSecretAllocated?.('vk-copy', vkCopy);

          const wrappedVk = await doSealDevKeyWrap(
            sodium,
            vkCopy,
            msg.devKey,
            msg.userId,
            msg.vaultKeyId,
          );
          assertReadOnlyBeforeReturn(sodium, captured, vkCopy, false);

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

          assertReadOnlyBeforeReturn(sodium, captured, vkCopy, false);
          return { wrapped_vk: wrappedVk } satisfies WrapForDeviceResult;
        } finally {
          safeMemzero(sodium, vkCopy, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, reopenedVk, hooks.onKeyZeroed, 'vk');
        }
      }

      case 'sealEntry': {
        let vkCopy: Uint8Array | null = null;
        const incomingPtBytes = ArrayBuffer.isView(msg.plaintext)
          ? new Uint8Array(
              msg.plaintext.buffer,
              msg.plaintext.byteOffset,
              msg.plaintext.byteLength,
            )
          : null;

        try {
          const { captured, vk: activeVk } = assertReadOnlyStart(false);
          vkCopy = new Uint8Array(activeVk);
          hooks.onSecretAllocated?.('vk-copy', vkCopy);

          const sealed = sealEntryPayload(sodium, {
            entryId: msg.entryId,
            keyId: msg.keyId,
            plaintext: incomingPtBytes ?? msg.plaintext,
            vk: vkCopy,
            adapter: envelopeAdapter,
          });
          if (!incomingPtBytes) {
            hooks.onKeyZeroed?.('plaintext');
          }

          assertReadOnlyBeforeReturn(sodium, captured, vkCopy, false);
          return {
            envelope: sealed.envelope,
            ciphertext: sealed.ciphertext,
          } satisfies SealEntryResult;
        } finally {
          safeMemzero(sodium, incomingPtBytes, hooks.onKeyZeroed, 'plaintext');
          safeMemzero(sodium, vkCopy, hooks.onKeyZeroed, 'vk');
        }
      }

      case 'openEntry': {
        let vkCopy: Uint8Array | null = null;
        let ptBytes: Uint8Array | null = null;

        try {
          const { captured, vk: activeVk } = assertReadOnlyStart(false);
          vkCopy = new Uint8Array(activeVk);
          hooks.onSecretAllocated?.('vk-copy', vkCopy);

          const opened = openEntryPayload(sodium, {
            entryId: msg.entryId,
            envelope: msg.envelope,
            ciphertext: msg.ciphertext,
            vk: vkCopy,
            adapter: envelopeAdapter,
          });
          ptBytes = opened.plaintextBytes;

          assertReadOnlyBeforeReturn(sodium, captured, vkCopy, false);
          return { plaintext: opened.plaintext } satisfies OpenEntryResult;
        } finally {
          safeMemzero(sodium, vkCopy, hooks.onKeyZeroed, 'vk');
          safeMemzero(sodium, ptBytes, hooks.onKeyZeroed, 'plaintext');
        }
      }

      default: {
        throw new CryptoWorkerError('NOT_IMPLEMENTED', 'Unknown crypto worker command');
      }
    }
  }
  function mapError(
    err: unknown,
    cmdType?: unknown,
  ): { code: CryptoWorkerErrorCode; message: string } {
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
      // Fixed generic message to prevent any recovery-key input character from reaching main thread (FE1-5)
      return { code: 'RECOVERY_KEY_INVALID', message: 'Invalid recovery key' };
    }
    if (err instanceof EnvelopeError || err instanceof JcsError || err instanceof Base64UrlError) {
      return { code: 'ENVELOPE_INVALID', message: err.message };
    }
    if (
      err instanceof TypeError &&
      (cmdType === 'sealEntry' || cmdType === 'openEntry')
    ) {
      return { code: 'ENVELOPE_INVALID', message: 'Invalid input encoding or type' };
    }
    if (err instanceof Error) {
      if (err.message.startsWith('NOT_IMPLEMENTED:')) {
        return { code: 'NOT_IMPLEMENTED', message: err.message };
      }
      return { code: 'WORKER_INTERNAL_ERROR', message: 'Crypto worker internal error' };
    }
    return { code: 'WORKER_INTERNAL_ERROR', message: 'Unknown crypto worker error' };
  }

  function errorReply(
    reqId: number,
    reqGen: number,
    err: unknown,
    cmdType: unknown,
  ): WorkerErrorResponse {
    return {
      id: reqId,
      generation: reqGen,
      state: stateReport(),
      ok: false,
      error: mapError(err, cmdType),
    };
  }

  /**
   * Runs one command and builds its reply. The reply's `state` is captured synchronously after the command
   * settled, so it is authoritative for the client (ADR 0002 §10 rule 5).
   */
  async function runCommand(
    sodium: Sodium,
    msg: WorkerRequestMessage,
    reqId: number,
    reqGen: number,
  ): Promise<WorkerResponseMessage> {
    try {
      const result = await executeCommand(sodium, msg);
      return {
        id: reqId,
        generation: msg.type === 'lock' ? workerGeneration : reqGen,
        state: stateReport(),
        ok: true,
        result,
      };
    } catch (err) {
      cleanupCommandOnReject(sodium, msg);
      const cmdType = msg && typeof msg === 'object' && 'type' in msg ? msg.type : undefined;
      return errorReply(reqId, reqGen, err, cmdType);
    }
  }

  interface QueuedStateCommand {
    sodium: Sodium;
    msg: WorkerRequestMessage;
    reqId: number;
    reqGen: number;
    settle: (response: WorkerResponseMessage) => void;
  }

  const stateQueue: QueuedStateCommand[] = [];
  let stateRunning: QueuedStateCommand | null = null;

  function pumpStateQueue(): void {
    if (stateRunning) return;
    const next = stateQueue.shift();
    if (!next) return;
    stateRunning = next;
    void runCommand(next.sodium, next.msg, next.reqId, next.reqGen)
      .then((response) => {
        next.settle(response);
      })
      .finally(() => {
        stateRunning = null;
        pumpStateQueue();
      });
  }

  function enqueueStateCommand(
    sodium: Sodium,
    msg: WorkerRequestMessage,
    reqId: number,
    reqGen: number,
  ): Promise<WorkerResponseMessage> {
    return new Promise<WorkerResponseMessage>((resolve) => {
      stateQueue.push({ sodium, msg, reqId, reqGen, settle: resolve });
      pumpStateQueue();
    });
  }

  /**
   * `lock` preempts: it never waits behind the queue. It commits immediately (wiping closure keys and any
   * continuation, bumping generation and epoch), then every queued state command settles
   * `STALE_GENERATION` without running and with its incoming secrets wiped. The one command already running
   * cannot be aborted mid-KDF; its commit is rejected by the structural (mode, generation, epoch) rule.
   */
  function preemptWithLock(
    sodium: Sodium,
    msg: WorkerRequestMessage,
    reqId: number,
    reqGen: number,
  ): Promise<WorkerResponseMessage> {
    // `executeCommand` runs the lock commit synchronously, so the queue is cancelled in the same turn:
    // no queued command can start between the lock commit and its cancellation.
    const response = runCommand(sodium, msg, reqId, reqGen);
    const cancelled = stateQueue.splice(0, stateQueue.length);
    for (const entry of cancelled) {
      cleanupCommandOnReject(entry.sodium, entry.msg);
      entry.settle(
        errorReply(
          entry.reqId,
          entry.reqGen,
          new CryptoWorkerError('STALE_GENERATION', 'Operation cancelled by intervening lock'),
          entry.msg.type,
        ),
      );
    }
    return response;
  }

  return {
    async handleMessage(msg: WorkerRequestMessage): Promise<WorkerResponseMessage> {
      const reqId = typeof msg?.id === 'number' ? msg.id : -1;
      const reqGen =
        typeof msg?.generation === 'number' && Number.isSafeInteger(msg.generation)
          ? msg.generation
          : workerGeneration;

      let sodium: Sodium;
      try {
        sodium = await getSodium();
      } catch (err) {
        cleanupCommandOnReject(null, msg);
        return errorReply(
          reqId,
          reqGen,
          new CryptoWorkerError(
            'WORKER_INIT_FAILED',
            'Failed to initialize libsodium in Crypto Worker',
            { cause: err },
          ),
          undefined,
        );
      }

      if (!msg || typeof msg !== 'object') {
        return errorReply(
          reqId,
          reqGen,
          new CryptoWorkerError('WORKER_INTERNAL_ERROR', 'Malformed worker request message'),
          undefined,
        );
      }
      if (msg.type === 'lock') {
        return preemptWithLock(sodium, msg, reqId, reqGen);
      }
      if (STATE_COMMANDS.has(msg.type)) {
        return enqueueStateCommand(sodium, msg, reqId, reqGen);
      }
      return runCommand(sodium, msg, reqId, reqGen);
    },
    getGeneration(): number {
      return workerGeneration;
    },
    getEpoch(): number {
      return workerEpoch;
    },
    getState() {
      return vaultMode;
    },
    getStateSnapshot(): WorkerStateSnapshot {
      return captureStateSnapshot();
    },
    getStateReport(): WorkerStateReport {
      return stateReport();
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
    const data = event?.data;
    const reqId = typeof data?.id === 'number' ? data.id : -1;
    const reqGen =
      typeof data?.generation === 'number' && Number.isSafeInteger(data.generation)
        ? data.generation
        : core.getGeneration();

    void core
      .handleMessage(data)
      .then((response) => {
        try {
          scope.postMessage(response);
        } catch {
          try {
            scope.postMessage({
              id: reqId,
              generation: reqGen,
              state: core.getStateReport(),
              ok: false,
              error: {
                code: 'WORKER_INTERNAL_ERROR',
                message: 'Failed to serialize worker response',
              },
            } satisfies WorkerErrorResponse);
          } catch {
            // Unrecoverable port state
          }
        }
      })
      .catch(() => {
        try {
          scope.postMessage({
            id: reqId,
            generation: reqGen,
            state: core.getStateReport(),
            ok: false,
            error: {
              code: 'WORKER_INTERNAL_ERROR',
              message: 'Unhandled worker command failure',
            },
          } satisfies WorkerErrorResponse);
        } catch {
          // Unrecoverable port state
        }
      });
  };
  return core;
}
