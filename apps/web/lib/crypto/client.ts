import {
  CryptoWorkerError,
  hasLoneSurrogate,
  PASSPHRASE_INVALID_MESSAGE,
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
} from './protocol';

export type VaultClientState = 'locked' | 'unlocked' | 'recovering' | 'error';

export type CryptoClientErrorCode =
  | CryptoWorkerErrorCode
  | 'WORKER_CRASHED'
  | 'SECRET_DETACHED_OR_EMPTY';

export class CryptoClientError extends Error {
  readonly code: CryptoClientErrorCode;

  constructor(code: CryptoClientErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CryptoClientError';
    this.code = code;
  }
}

export interface CryptoWorkerPort {
  postMessage: (message: WorkerRequestMessage, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<WorkerResponseMessage>) => void) | null;
  onerror?: ((event: ErrorEvent | Event) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
  terminate?: () => void;
}

export interface CryptoClientOptions {
  createWorker?: () => CryptoWorkerPort;
  onStateChange?: (state: VaultClientState, generation: number) => void;
}

export interface CreateVaultClientParams {
  passphrase: string | Uint8Array;
  opGeneration: number;
  skipRecoveryKeys?: boolean;
  beforePostMessage?: () => Promise<void> | void;
}

export type CreateVaultNowClientParams = Omit<CreateVaultClientParams, 'opGeneration'>;

export interface UnlockPassphraseClientParams {
  passphrase: string | Uint8Array;
  kdf: unknown;
  vaultKeyWrappedByKek: string;
  privateKeysWrapped?: string;
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}

export type UnlockPassphraseNowClientParams = Omit<UnlockPassphraseClientParams, 'opGeneration'>;

export interface UnlockRecoveryClientParams {
  recoveryKey: string | Uint8Array;
  wrap?: string;
  privateKeysWrapped?: string;
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}

export type UnlockRecoveryNowClientParams = Omit<UnlockRecoveryClientParams, 'opGeneration'>;

export interface ResumeRecoveryClientParams {
  wrap: string;
  privateKeysWrapped?: string;
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}
export interface ConfirmRecoveryClientParams {
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}
export interface UnlockPrfClientParams {
  pwk: Uint8Array | ArrayBuffer;
  vkWrap: string;
  privateKeysWrapped?: string;
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}
export interface UnlockDevKeyClientParams {
  devKey: CryptoKey;
  wrappedVk: Uint8Array | string;
  userId: string;
  vaultKeyId: string;
  privateKeysWrapped?: string;
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}
export interface RewrapClientParams {
  passphrase: string | Uint8Array;
  currentKdf: unknown;
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}

export type RewrapNowClientParams = Omit<RewrapClientParams, 'opGeneration'>;

export interface MakeRecoveryKeysClientParams {
  slots?: number[];
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}

export type MakeRecoveryKeysNowClientParams = Omit<MakeRecoveryKeysClientParams, 'opGeneration'>;

export interface WrapForPasskeyClientParams {
  pwk: Uint8Array | ArrayBuffer;
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}
export interface WrapForDeviceClientParams {
  devKey: CryptoKey;
  userId: string;
  vaultKeyId: string;
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}

export type WrapForDeviceNowClientParams = Omit<WrapForDeviceClientParams, 'opGeneration'>;

export interface SealEntryClientParams {
  entryId: string;
  keyId: string;
  plaintext: string | Uint8Array;
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}

export type SealEntryNowClientParams = Omit<SealEntryClientParams, 'opGeneration'>;

export interface OpenEntryClientParams {
  entryId: string;
  envelope: unknown;
  ciphertext: string | Uint8Array;
  opGeneration: number;
  beforePostMessage?: () => Promise<void> | void;
}

export type OpenEntryNowClientParams = Omit<OpenEntryClientParams, 'opGeneration'>;

interface PendingRequest {
  id: number;
  kind: WorkerCommandType;
  opGeneration: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}
const utf8Encoder = new TextEncoder();

const VAULT_MODES: ReadonlySet<string> = new Set<VaultMode>(['locked', 'unlocked', 'recovering']);

function isWorkerStateReport(value: unknown): value is WorkerStateReport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.mode === 'string' &&
    VAULT_MODES.has(v.mode) &&
    typeof v.generation === 'number' &&
    Number.isSafeInteger(v.generation) &&
    typeof v.epoch === 'number' &&
    Number.isSafeInteger(v.epoch)
  );
}

/**
 * Local replacement for `Promise.withResolvers` to support iOS Safari < 17.4 / Chrome < 119 (FE1-6).
 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function isArrayBufferLike(value: unknown): value is ArrayBuffer {
  return (
    value instanceof ArrayBuffer ||
    (typeof value === 'object' &&
      value !== null &&
      Object.prototype.toString.call(value) === '[object ArrayBuffer]')
  );
}

type SecretInput =
  | { kind: 'string'; value: string }
  | { kind: 'bytes'; view: Uint8Array }
  | { kind: 'detached' }
  | { kind: 'invalid' };

/**
 * ONE classifier for every supported secret input form, used by the normal path (`toTransferableBytes`) and by
 * the CLIENT_BUSY wipe, so both recognize exactly the same inputs: strings, `ArrayBuffer`s and typed arrays /
 * views, including cross-realm ones (object tag / `ArrayBuffer.isView`, never `instanceof` alone). An empty or
 * already-detached buffer is `detached` and never throws.
 */
function classifySecretInput(input: unknown): SecretInput {
  if (typeof input === 'string') return { kind: 'string', value: input };
  try {
    if (isArrayBufferLike(input)) {
      return input.byteLength === 0
        ? { kind: 'detached' }
        : { kind: 'bytes', view: new Uint8Array(input) };
    }
    if (ArrayBuffer.isView(input)) {
      if (input.byteLength === 0 || input.buffer.byteLength === 0) return { kind: 'detached' };
      return {
        kind: 'bytes',
        view: new Uint8Array(input.buffer as ArrayBuffer, input.byteOffset, input.byteLength),
      };
    }
  } catch {
    return { kind: 'detached' };
  }
  return { kind: 'invalid' };
}

/** Best-effort in-place zeroing of a caller-owned secret input of any supported form. */
function wipeSecretInput(input: unknown): void {
  const classified = classifySecretInput(input);
  if (classified.kind === 'bytes') wipeAttachedBytes(classified.view);
}

function wipeAttachedBytes(buf: Uint8Array | null | undefined): void {
  if (!buf) return;
  try {
    if (buf.byteLength > 0) {
      buf.fill(0);
    }
  } catch {
    // Already detached or inaccessible
  }
}

/**
 * Prepares a transferable `Uint8Array` backed by a standalone `ArrayBuffer`.
 * Rejects empty or already-detached secret inputs with `SECRET_DETACHED_OR_EMPTY` (FE1-9).
 * If the caller passed a `Uint8Array` whose `.buffer` is whole (`byteOffset === 0 && byteLength === buffer.byteLength`),
 * the caller's exact `ArrayBuffer` is transferred so `input.buffer.byteLength === 0` after `postMessage`.
 * If the caller passed a sub-view (`byteOffset > 0` or `byteLength < buffer.byteLength`),
 * copies into a fresh standalone `Uint8Array` and zeroes the caller's sub-view in place.
 */
function toTransferableBytes(input: string | Uint8Array | ArrayBuffer): Uint8Array {
  const classified = classifySecretInput(input);
  switch (classified.kind) {
    case 'string': {
      const encoded = utf8Encoder.encode(classified.value);
      if (encoded.byteLength === 0) {
        throw new CryptoClientError('SECRET_DETACHED_OR_EMPTY', 'Secret string must not be empty');
      }
      return encoded;
    }
    case 'detached':
      throw new CryptoClientError(
        'SECRET_DETACHED_OR_EMPTY',
        isArrayBufferLike(input)
          ? 'Secret ArrayBuffer is detached or empty'
          : 'Secret Uint8Array is detached or empty',
      );
    case 'invalid':
      throw new CryptoClientError('SECRET_DETACHED_OR_EMPTY', 'Invalid secret buffer type');
    case 'bytes': {
      const { view } = classified;
      if (isArrayBufferLike(input)) return view;
      if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
        return view;
      }
      const copy = new Uint8Array(view.byteLength);
      copy.set(view);
      view.fill(0);
      return copy;
    }
  }
}

/**
 * Passphrase input (user-dec-003, FE1-13): a string with an unpaired surrogate is rejected `PASSPHRASE_INVALID`
 * BEFORE encoding, so `TextEncoder` never substitutes U+FFFD. The message never echoes the input. NFC
 * normalization and strict UTF-8 validation of the bytes happen in the Worker (`passphraseToKdfBytes`).
 */
function toPassphraseBytes(input: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof input === 'string' && hasLoneSurrogate(input)) {
    throw new CryptoClientError('PASSPHRASE_INVALID', PASSPHRASE_INVALID_MESSAGE);
  }
  return toTransferableBytes(input);
}

function isDataCloneError(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'DataCloneError') {
    return true;
  }
  if (err instanceof Error) {
    if (err.name === 'DataCloneError') return true;
    const msg = err.message.toLowerCase();
    if (msg.includes('datacloneerror') || msg.includes('detached') || msg.includes('could not be cloned')) {
      return true;
    }
  }
  return false;
}

function defaultWorkerFactory(): CryptoWorkerPort {
  return new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as CryptoWorkerPort;
}

export class CryptoClient {
  private worker: CryptoWorkerPort | null = null;
  private currentGeneration = 0;
  /** Highest Worker epoch adopted from a reply for the current Worker instance (-1 = none yet). */
  private adoptedEpoch = -1;
  /** Token of the single in-flight state-changing call, if any. */
  private stateSlot: object | null = null;
  private nextRequestId = 1;
  private state: VaultClientState = 'locked';
  private readonly pending = new Map<number, PendingRequest>();
  private readonly createWorkerFn: () => CryptoWorkerPort;
  private readonly onStateChange?: (state: VaultClientState, generation: number) => void;

  constructor(options: CryptoClientOptions = {}) {
    this.createWorkerFn = options.createWorker ?? defaultWorkerFactory;
    this.onStateChange = options.onStateChange;
  }

  /**
   * Captures the immutable `opGeneration` BEFORE the first `await` of a multi-step async flow
   * (e.g., before `fetch('/api/v1/vault')`, `navigator.credentials.get()`, or IndexedDB reads)
   * per ADR 0002 §10.2.
   */
  captureGeneration(): number {
    return this.currentGeneration;
  }

  getGeneration(): number {
    return this.currentGeneration;
  }

  getState(): VaultClientState {
    return this.state;
  }
  /** Last Worker epoch adopted from an authoritative reply (-1 before the first reply). */
  getEpoch(): number {
    return this.adoptedEpoch;
  }

  private setState(nextState: VaultClientState): void {
    this.state = nextState;
    try {
      this.onStateChange?.(nextState, this.currentGeneration);
    } catch {
      // Observer exceptions must never abort command completion or teardown (FE2-6)
    }
  }

  private ensureWorker(): CryptoWorkerPort {
    if (this.state === 'error' && !this.worker) {
      throw new CryptoClientError(
        'WORKER_CRASHED',
        'Crypto Worker is in error state; unlock again to reinitialize',
      );
    }
    if (!this.worker) {
      const w = this.createWorkerFn();
      this.adoptedEpoch = -1;
      this.bindWorker(w);
      this.worker = w;
    }
    return this.worker;
  }

  private bindWorker(w: CryptoWorkerPort): void {
    w.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
      if (this.worker !== w) return;
      const msg = event?.data;
      if (!msg || typeof msg.id !== 'number') return;
      const req = this.pending.get(msg.id);
      if (!req) return;
      this.pending.delete(msg.id);

      // Every Worker reply, success or error, carries the authoritative {mode, generation, epoch}.
      // A reply without it is a protocol violation: the Worker state is unknown, so fail closed.
      if (!isWorkerStateReport(msg.state)) {
        try {
          this.handleWorkerDeath('Crypto Worker reply is missing its authoritative state');
        } finally {
          req.reject(
            new CryptoClientError(
              'WORKER_INTERNAL_ERROR',
              'Crypto Worker reply is missing its authoritative state',
            ),
          );
        }
        return;
      }
      this.adoptWorkerState(msg.state);

      // Lock replies never fail on generation skew (FE1-2)
      if (req.kind === 'lock') {
        req.resolve({ generation: this.currentGeneration } satisfies LockResult);
        return;
      }

      // Check generation first for both success AND error replies so stale errors
      // (e.g. a wrong-passphrase error arriving after the user locked) are reported as STALE_GENERATION (FE1-16).
      if (req.opGeneration !== this.currentGeneration || msg.generation !== this.currentGeneration) {
        req.reject(
          new CryptoClientError(
            'STALE_GENERATION',
            'Worker result discarded due to intervening lock or generation bump',
          ),
        );
        return;
      }

      if (!msg.ok) {
        const clientErr = new CryptoClientError(msg.error.code, msg.error.message);
        if (msg.error.code === 'WORKER_INIT_FAILED') {
          try {
            this.handleWorkerDeath(msg.error.message);
          } finally {
            req.reject(clientErr);
          }
          return;
        }
        req.reject(clientErr);
        return;
      }

      req.resolve(msg.result);
    };

    w.onerror = () => {
      if (this.worker !== w) return;
      this.handleWorkerDeath('Crypto Worker encountered an unhandled error');
    };

    w.onmessageerror = () => {
      if (this.worker !== w) return;
      this.handleWorkerDeath('Crypto Worker encountered a message deserialization error');
    };
  }

  /**
   * Handles Worker crash/error: bumps `currentGeneration`, terminates the dead worker reference,
   * settles all in-flight requests BEFORE notifying `onStateChange` so an observer exception
   * can never skip teardown or leave promises hanging (BE1-8, FE1-12, FE1-21).
   */
  handleWorkerDeath(reason = 'Crypto Worker terminated unexpectedly'): void {
    this.currentGeneration += 1;
    this.stateSlot = null;
    const prevWorker = this.worker;
    this.worker = null;
    try {
      prevWorker?.terminate?.();
    } catch {
      // Ignore termination errors on dead worker
    }

    const inFlight = [...this.pending.values()];
    this.pending.clear();
    const err = new CryptoClientError('WORKER_CRASHED', reason);
    for (const req of inFlight) {
      if (req.kind === 'lock') {
        req.resolve({ generation: this.currentGeneration } satisfies LockResult);
      } else {
        req.reject(err);
      }
    }

    this.setState('error');
  }

  /**
   * Adopts the Worker's authoritative state. Only a report from the client's current generation whose
   * epoch has not regressed is adopted; the client never infers `mode` from its own bookkeeping.
   */
  private adoptWorkerState(report: WorkerStateReport): void {
    if (report.generation !== this.currentGeneration || report.epoch < this.adoptedEpoch) return;
    this.adoptedEpoch = report.epoch;
    if (report.mode !== this.state) {
      this.setState(report.mode);
    }
  }

  /**
   * Single-flight gate for the state-changing calls (createVault, unlock*, unlockRecovery, resumeRecovery,
   * confirmRecovery, rewrap): at most one is in flight; another rejects `CLIENT_BUSY` before any Worker
   * contact and its secret inputs are wiped (ADR 0002 §10 rule 6).
   */
  private acquireStateSlot(secrets: ReadonlyArray<unknown>): object {
    if (this.stateSlot) {
      // CLIENT_BUSY wins over input validation: wipe whatever supported form was passed (a detached or
      // foreign-realm buffer included) and reject with the busy code, never an uncoded TypeError.
      for (const secret of secrets) wipeSecretInput(secret);
      throw new CryptoClientError(
        'CLIENT_BUSY',
        'Another state-changing crypto call is already in flight; wait for it or call lock()',
      );
    }
    const slot = {};
    this.stateSlot = slot;
    return slot;
  }

  private releaseStateSlot(slot: object): void {
    if (this.stateSlot === slot) {
      this.stateSlot = null;
    }
  }

  private resetWorkerAfterErrorIfUnlocking(): void {
    if (this.state === 'error' && !this.worker) {
      this.setState('locked');
    }
  }

  private assertGenerationOrWipe(opGeneration: number, secretBuf?: Uint8Array): void {
    if (
      typeof opGeneration !== 'number' ||
      !Number.isSafeInteger(opGeneration) ||
      opGeneration !== this.currentGeneration
    ) {
      wipeAttachedBytes(secretBuf);
      throw new CryptoClientError(
        'STALE_GENERATION',
        'Operation aborted before Worker dispatch due to intervening lock',
      );
    }
  }

  private sendToWorker<T>(
    opGeneration: number,
    payload: WorkerCommandPayload,
    transfer: Transferable[] = [],
    secretBuf?: Uint8Array,
  ): Promise<T> {
    let worker: CryptoWorkerPort;
    try {
      worker = this.ensureWorker();
    } catch (err) {
      wipeAttachedBytes(secretBuf);
      if (err instanceof CryptoClientError) {
        return Promise.reject(err);
      }
      return Promise.reject(
        new CryptoClientError(
          'WORKER_INTERNAL_ERROR',
          err instanceof Error ? err.message : 'Failed to create Crypto Worker',
          { cause: err },
        ),
      );
    }

    const id = this.nextRequestId++;
    const message: WorkerRequestMessage = {
      ...payload,
      id,
      generation: opGeneration,
    };

    const { promise, resolve, reject } = createDeferred<T>();
    this.pending.set(id, {
      id,
      kind: payload.type,
      opGeneration,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    try {
      worker.postMessage(message, transfer);
    } catch (err) {
      this.pending.delete(id);
      wipeAttachedBytes(secretBuf);
      const code: CryptoClientErrorCode = isDataCloneError(err)
        ? 'SECRET_DETACHED_OR_EMPTY'
        : 'WORKER_INTERNAL_ERROR';
      reject(
        new CryptoClientError(
          code,
          err instanceof Error ? err.message : 'Failed to postMessage to Crypto Worker',
          { cause: err },
        ),
      );
    }
    return promise;
  }

  async createVault(params: CreateVaultClientParams): Promise<CreateVaultResult> {
    const opGeneration = params.opGeneration;
    const slot = this.acquireStateSlot([params.passphrase]);
    let passBytes: Uint8Array | null = null;
    try {
      passBytes = toPassphraseBytes(params.passphrase);
      this.resetWorkerAfterErrorIfUnlocking();

      if (params.beforePostMessage) {
        await params.beforePostMessage();
      }
      this.assertGenerationOrWipe(opGeneration, passBytes);

      const res = await this.sendToWorker<CreateVaultResult>(
        opGeneration,
        {
          type: 'createVault',
          passphraseBuffer: passBytes.buffer as ArrayBuffer,
          skipRecoveryKeys: params.skipRecoveryKeys,
        },
        [passBytes.buffer as ArrayBuffer],
        passBytes,
      );

      this.assertGenerationOrWipe(opGeneration);
      return res;
    } finally {
      wipeAttachedBytes(passBytes);
      this.releaseStateSlot(slot);
    }
  }

  async createVaultNow(params: CreateVaultNowClientParams): Promise<CreateVaultResult> {
    return this.createVault({
      ...params,
      opGeneration: this.captureGeneration(),
    });
  }

  async unlockPassphrase(params: UnlockPassphraseClientParams): Promise<{ unlocked: true }> {
    const opGeneration = params.opGeneration;
    const slot = this.acquireStateSlot([params.passphrase]);
    let passBytes: Uint8Array | null = null;
    try {
      passBytes = toPassphraseBytes(params.passphrase);
      this.resetWorkerAfterErrorIfUnlocking();

      if (params.beforePostMessage) {
        await params.beforePostMessage();
      }
      this.assertGenerationOrWipe(opGeneration, passBytes);

      const res = await this.sendToWorker<{ unlocked: true }>(
        opGeneration,
        {
          type: 'unlockPassphrase',
          passphraseBuffer: passBytes.buffer as ArrayBuffer,
          kdf: params.kdf,
          vaultKeyWrappedByKek: params.vaultKeyWrappedByKek,
          privateKeysWrapped: params.privateKeysWrapped,
        },
        [passBytes.buffer as ArrayBuffer],
        passBytes,
      );

      this.assertGenerationOrWipe(opGeneration);
      return res;
    } finally {
      wipeAttachedBytes(passBytes);
      this.releaseStateSlot(slot);
    }
  }

  async unlockPassphraseNow(params: UnlockPassphraseNowClientParams): Promise<{ unlocked: true }> {
    return this.unlockPassphrase({
      ...params,
      opGeneration: this.captureGeneration(),
    });
  }

  async unlockRecovery(
    params: UnlockRecoveryClientParams,
  ): Promise<DeriveRecoveryLookupResult & { recovering?: boolean }> {
    const opGeneration = params.opGeneration;
    const slot = this.acquireStateSlot([params.recoveryKey]);
    let rkBytes: Uint8Array | null = null;
    try {
      rkBytes = toTransferableBytes(params.recoveryKey);
      this.resetWorkerAfterErrorIfUnlocking();

      if (params.beforePostMessage) {
        await params.beforePostMessage();
      }
      this.assertGenerationOrWipe(opGeneration, rkBytes);

      const res = await this.sendToWorker<DeriveRecoveryLookupResult & { recovering?: boolean }>(
        opGeneration,
        {
          type: 'unlockRecovery',
          recoveryKeyBuffer: rkBytes.buffer as ArrayBuffer,
          wrap: params.wrap,
          privateKeysWrapped: params.privateKeysWrapped,
        },
        [rkBytes.buffer as ArrayBuffer],
        rkBytes,
      );

      this.assertGenerationOrWipe(opGeneration);
      return res;
    } finally {
      wipeAttachedBytes(rkBytes);
      this.releaseStateSlot(slot);
    }
  }

  async unlockRecoveryNow(
    params: UnlockRecoveryNowClientParams,
  ): Promise<DeriveRecoveryLookupResult & { recovering?: boolean }> {
    return this.unlockRecovery({
      ...params,
      opGeneration: this.captureGeneration(),
    });
  }

  async resumeRecovery(params: ResumeRecoveryClientParams): Promise<ResumeRecoveryResult> {
    const opGeneration = params.opGeneration;
    const slot = this.acquireStateSlot([]);
    try {
      this.resetWorkerAfterErrorIfUnlocking();

      if (params.beforePostMessage) {
        await params.beforePostMessage();
      }
      this.assertGenerationOrWipe(opGeneration);

      const res = await this.sendToWorker<ResumeRecoveryResult>(
        opGeneration,
        {
          type: 'resumeRecovery',
          wrap: params.wrap,
          privateKeysWrapped: params.privateKeysWrapped,
        },
        [],
      );

      this.assertGenerationOrWipe(opGeneration);
      return res;
    } finally {
      this.releaseStateSlot(slot);
    }
  }

  async confirmRecovery(params: ConfirmRecoveryClientParams): Promise<ConfirmRecoveryResult> {
    const opGeneration = params.opGeneration;
    const slot = this.acquireStateSlot([]);
    try {
      if (params.beforePostMessage) {
        await params.beforePostMessage();
      }
      this.assertGenerationOrWipe(opGeneration);

      const res = await this.sendToWorker<ConfirmRecoveryResult>(
        opGeneration,
        {
          type: 'confirmRecovery',
        },
        [],
      );

      this.assertGenerationOrWipe(opGeneration);
      return res;
    } finally {
      this.releaseStateSlot(slot);
    }
  }

  async unlockPrf(params: UnlockPrfClientParams): Promise<{ unlocked: true }> {
    const opGeneration = params.opGeneration;
    const slot = this.acquireStateSlot([params.pwk]);
    let pwkBytes: Uint8Array | null = null;
    try {
      pwkBytes = toTransferableBytes(params.pwk);
      this.resetWorkerAfterErrorIfUnlocking();

      if (params.beforePostMessage) {
        await params.beforePostMessage();
      }
      this.assertGenerationOrWipe(opGeneration, pwkBytes);

      const res = await this.sendToWorker<{ unlocked: true }>(
        opGeneration,
        {
          type: 'unlockPrf',
          pwkBuffer: pwkBytes.buffer as ArrayBuffer,
          vkWrap: params.vkWrap,
          privateKeysWrapped: params.privateKeysWrapped,
        },
        [pwkBytes.buffer as ArrayBuffer],
        pwkBytes,
      );

      this.assertGenerationOrWipe(opGeneration);
      return res;
    } finally {
      wipeAttachedBytes(pwkBytes);
      this.releaseStateSlot(slot);
    }
  }

  async unlockDevKey(params: UnlockDevKeyClientParams): Promise<{ unlocked: true }> {
    const opGeneration = params.opGeneration;
    const slot = this.acquireStateSlot([]);
    try {
      this.resetWorkerAfterErrorIfUnlocking();

      if (params.beforePostMessage) {
        await params.beforePostMessage();
      }
      this.assertGenerationOrWipe(opGeneration);

      const res = await this.sendToWorker<{ unlocked: true }>(
        opGeneration,
        {
          type: 'unlockDevKey',
          devKey: params.devKey,
          wrappedVk: params.wrappedVk,
          userId: params.userId,
          vaultKeyId: params.vaultKeyId,
          privateKeysWrapped: params.privateKeysWrapped,
        },
        [],
      );

      this.assertGenerationOrWipe(opGeneration);
      return res;
    } finally {
      this.releaseStateSlot(slot);
    }
  }

  async rewrap(params: RewrapClientParams): Promise<RewrapResult> {
    const opGeneration = params.opGeneration;
    const slot = this.acquireStateSlot([params.passphrase]);
    let passBytes: Uint8Array | null = null;
    try {
      passBytes = toPassphraseBytes(params.passphrase);

      if (params.beforePostMessage) {
        await params.beforePostMessage();
      }
      this.assertGenerationOrWipe(opGeneration, passBytes);

      const res = await this.sendToWorker<RewrapResult>(
        opGeneration,
        {
          type: 'rewrap',
          passphraseBuffer: passBytes.buffer as ArrayBuffer,
          currentKdf: params.currentKdf,
        },
        [passBytes.buffer as ArrayBuffer],
        passBytes,
      );

      this.assertGenerationOrWipe(opGeneration);
      return res;
    } finally {
      wipeAttachedBytes(passBytes);
      this.releaseStateSlot(slot);
    }
  }

  async rewrapNow(params: RewrapNowClientParams): Promise<RewrapResult> {
    return this.rewrap({
      ...params,
      opGeneration: this.captureGeneration(),
    });
  }

  async makeRecoveryKeys(params: MakeRecoveryKeysClientParams): Promise<MakeRecoveryKeysResult> {
    const opGeneration = params.opGeneration;

    if (params.beforePostMessage) {
      await params.beforePostMessage();
    }
    this.assertGenerationOrWipe(opGeneration);

    const res = await this.sendToWorker<MakeRecoveryKeysResult>(opGeneration, {
      type: 'makeRecoveryKeys',
      slots: params.slots,
    });

    this.assertGenerationOrWipe(opGeneration);
    return res;
  }

  async makeRecoveryKeysNow(
    params: MakeRecoveryKeysNowClientParams,
  ): Promise<MakeRecoveryKeysResult> {
    return this.makeRecoveryKeys({
      ...params,
      opGeneration: this.captureGeneration(),
    });
  }

  async wrapForPasskey(params: WrapForPasskeyClientParams): Promise<WrapForPasskeyResult> {
    const opGeneration = params.opGeneration;
    let pwkBytes: Uint8Array | null = null;
    try {
      pwkBytes = toTransferableBytes(params.pwk);

      if (params.beforePostMessage) {
        await params.beforePostMessage();
      }
      this.assertGenerationOrWipe(opGeneration, pwkBytes);

      const res = await this.sendToWorker<WrapForPasskeyResult>(
        opGeneration,
        {
          type: 'wrapForPasskey',
          pwkBuffer: pwkBytes.buffer as ArrayBuffer,
        },
        [pwkBytes.buffer as ArrayBuffer],
        pwkBytes,
      );

      this.assertGenerationOrWipe(opGeneration);
      return res;
    } finally {
      wipeAttachedBytes(pwkBytes);
    }
  }

  async wrapForDevice(params: WrapForDeviceClientParams): Promise<WrapForDeviceResult> {
    const opGeneration = params.opGeneration;

    if (params.beforePostMessage) {
      await params.beforePostMessage();
    }
    this.assertGenerationOrWipe(opGeneration);

    const res = await this.sendToWorker<WrapForDeviceResult>(opGeneration, {
      type: 'wrapForDevice',
      devKey: params.devKey,
      userId: params.userId,
      vaultKeyId: params.vaultKeyId,
    });

    this.assertGenerationOrWipe(opGeneration);
    return res;
  }

  async wrapForDeviceNow(params: WrapForDeviceNowClientParams): Promise<WrapForDeviceResult> {
    return this.wrapForDevice({
      ...params,
      opGeneration: this.captureGeneration(),
    });
  }

  async sealEntry(params: SealEntryClientParams): Promise<SealEntryResult> {
    const opGeneration = params.opGeneration;

    if (params.beforePostMessage) {
      await params.beforePostMessage();
    }
    this.assertGenerationOrWipe(opGeneration);

    const res = await this.sendToWorker<SealEntryResult>(opGeneration, {
      type: 'sealEntry',
      entryId: params.entryId,
      keyId: params.keyId,
      plaintext: params.plaintext,
    });

    this.assertGenerationOrWipe(opGeneration);
    return res;
  }

  async sealEntryNow(params: SealEntryNowClientParams): Promise<SealEntryResult> {
    return this.sealEntry({
      ...params,
      opGeneration: this.captureGeneration(),
    });
  }

  async openEntry(params: OpenEntryClientParams): Promise<OpenEntryResult> {
    const opGeneration = params.opGeneration;

    if (params.beforePostMessage) {
      await params.beforePostMessage();
    }
    this.assertGenerationOrWipe(opGeneration);

    const res = await this.sendToWorker<OpenEntryResult>(opGeneration, {
      type: 'openEntry',
      entryId: params.entryId,
      envelope: params.envelope,
      ciphertext: params.ciphertext,
    });

    this.assertGenerationOrWipe(opGeneration);
    return res;
  }

  async openEntryNow(params: OpenEntryNowClientParams): Promise<OpenEntryResult> {
    return this.openEntry({
      ...params,
      opGeneration: this.captureGeneration(),
    });
  }

  /**
   * Total lock operation: bumps `currentGeneration`, dispatches the `lock` command to the Worker
   * (or terminates/marks dead if dispatch fails) BEFORE notifying `onStateChange`, and NEVER rejects (BE1-8, FE1-2, FE1-21).
   */
  async lock(): Promise<LockResult> {
    this.currentGeneration += 1;
    const lockGen = this.currentGeneration;
    const activeWorker = this.worker;
    // lock() is always allowed and preempts: it frees the single-flight slot for the next unlock. In-flight
    // state-changing calls settle STALE_GENERATION when their Worker reply arrives (generation mismatch).
    this.stateSlot = null;

    let lockPromise: Promise<LockResult> = Promise.resolve({ generation: lockGen });

    if (activeWorker) {
      const id = this.nextRequestId++;
      const message: WorkerRequestMessage = {
        type: 'lock',
        id,
        generation: lockGen,
      };
      const { promise, resolve, reject } = createDeferred<LockResult>();
      this.pending.set(id, {
        id,
        kind: 'lock',
        opGeneration: lockGen,
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      try {
        activeWorker.postMessage(message);
        lockPromise = promise.then(
          () => ({ generation: this.currentGeneration }),
          () => ({ generation: this.currentGeneration }),
        );
      } catch {
        this.pending.delete(id);
        this.worker = null;
        try {
          activeWorker.terminate?.();
        } catch {
          // Ignore termination errors
        }
        const inFlight = [...this.pending.values()];
        this.pending.clear();
        const crashErr = new CryptoClientError('WORKER_CRASHED', 'Failed to deliver lock command to Worker');
        for (const req of inFlight) {
          if (req.kind === 'lock') {
            req.resolve({ generation: this.currentGeneration } satisfies LockResult);
          } else {
            req.reject(crashErr);
          }
        }
        try {
          this.setState('error');
        } catch {
          // Total lock() never rejects even if observer throws
        }
        return { generation: this.currentGeneration };
      }
    }

    try {
      this.setState('locked');
    } catch {
      // Total lock() never rejects even if observer throws; Worker lock command was already dispatched above.
    }

    return lockPromise;
  }

  /**
   * Terminates the Worker and settles all pending requests BEFORE notifying `onStateChange`
   * so an observer exception cannot skip teardown (BE1-8, FE1-21).
   */
  terminate(): void {
    this.currentGeneration += 1;
    this.stateSlot = null;
    const prev = this.worker;
    this.worker = null;
    try {
      prev?.terminate?.();
    } catch {
      // Ignore
    }

    const inFlight = [...this.pending.values()];
    this.pending.clear();
    const err = new CryptoClientError('STALE_GENERATION', 'Crypto client terminated');
    for (const req of inFlight) {
      if (req.kind === 'lock') {
        req.resolve({ generation: this.currentGeneration } satisfies LockResult);
      } else {
        req.reject(err);
      }
    }

    this.setState('locked');
  }
}

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
  type WorkerCommandPayload,
  type WorkerCommandType,
  type WorkerErrorResponse,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
  type WorkerSuccessResponse,
  type WrapForDeviceResult,
  type WrapForPasskeyResult,
};
