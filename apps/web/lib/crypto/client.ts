import {
  CryptoWorkerError,
  type CreateVaultResult,
  type CryptoWorkerErrorCode,
  type DeriveRecoveryLookupResult,
  type LockResult,
  type MakeRecoveryKeysResult,
  type OpenEntryResult,
  type RewrapResult,
  type SealEntryResult,
  type WorkerCommandPayload,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
  type WrapForDeviceResult,
  type WrapForPasskeyResult,
} from './worker-core';

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
  opGeneration?: number;
  skipRecoveryKeys?: boolean;
  beforePostMessage?: () => Promise<void> | void;
}

export interface UnlockPassphraseClientParams {
  passphrase: string | Uint8Array;
  kdf: unknown;
  vaultKeyWrappedByKek: string;
  privateKeysWrapped?: string;
  opGeneration?: number;
  beforePostMessage?: () => Promise<void> | void;
}

export interface UnlockRecoveryClientParams {
  recoveryKey: string | Uint8Array;
  wrap?: string;
  opGeneration?: number;
  beforePostMessage?: () => Promise<void> | void;
}

export interface UnlockPrfClientParams {
  pwk: Uint8Array | ArrayBuffer;
  vkWrap: string;
  privateKeysWrapped?: string;
  opGeneration?: number;
  beforePostMessage?: () => Promise<void> | void;
}

export interface UnlockDevKeyClientParams {
  devKey: CryptoKey;
  wrappedVk: Uint8Array | string;
  userId: string;
  vaultKeyId: string;
  privateKeysWrapped?: string;
  opGeneration?: number;
  beforePostMessage?: () => Promise<void> | void;
}

export interface RewrapClientParams {
  passphrase: string | Uint8Array;
  currentKdf: unknown;
  opGeneration?: number;
  beforePostMessage?: () => Promise<void> | void;
}

export interface MakeRecoveryKeysClientParams {
  slots?: number[];
  opGeneration?: number;
  beforePostMessage?: () => Promise<void> | void;
}

export interface WrapForPasskeyClientParams {
  pwk: Uint8Array | ArrayBuffer;
  opGeneration?: number;
  beforePostMessage?: () => Promise<void> | void;
}

export interface WrapForDeviceClientParams {
  devKey: CryptoKey;
  userId: string;
  vaultKeyId: string;
  opGeneration?: number;
  beforePostMessage?: () => Promise<void> | void;
}

export interface SealEntryClientParams {
  entryId: string;
  keyId: string;
  plaintext: string | Uint8Array;
  opGeneration?: number;
  beforePostMessage?: () => Promise<void> | void;
}

export interface OpenEntryClientParams {
  entryId: string;
  envelope: unknown;
  ciphertext: string | Uint8Array;
  opGeneration?: number;
  beforePostMessage?: () => Promise<void> | void;
}

interface PendingRequest {
  id: number;
  opGeneration: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

const utf8Encoder = new TextEncoder();

/**
 * Prepares a transferable `Uint8Array` backed by a standalone `ArrayBuffer`.
 * If the caller passed a `Uint8Array` whose `.buffer` is whole (`byteOffset === 0 && byteLength === buffer.byteLength`),
 * the caller's exact `ArrayBuffer` is transferred so `input.buffer.byteLength === 0` after `postMessage`.
 * If the caller passed a sub-view (`byteOffset > 0` or `byteLength < buffer.byteLength`),
 * copies into a fresh standalone `Uint8Array` and zeroes the caller's sub-view in place.
 */
function toTransferableBytes(input: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof input === 'string') {
    return utf8Encoder.encode(input);
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (input instanceof Uint8Array) {
    if (input.byteOffset === 0 && input.byteLength === input.buffer.byteLength) {
      return input;
    }
    const copy = new Uint8Array(input.byteLength);
    copy.set(input);
    input.fill(0);
    return copy;
  }
  throw new CryptoClientError('SECRET_DETACHED_OR_EMPTY', 'Invalid secret buffer type');
}

function defaultWorkerFactory(): CryptoWorkerPort {
  return new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as CryptoWorkerPort;
}

export class CryptoClient {
  private worker: CryptoWorkerPort | null = null;
  private currentGeneration = 0;
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
   * per ADR 0002 §10.
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

  private setState(nextState: VaultClientState): void {
    this.state = nextState;
    this.onStateChange?.(nextState, this.currentGeneration);
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
      this.bindWorker(w);
      this.worker = w;
    }
    return this.worker;
  }

  private bindWorker(w: CryptoWorkerPort): void {
    w.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg.id !== 'number') return;
      const req = this.pending.get(msg.id);
      if (!req) return;
      this.pending.delete(msg.id);

      if (!msg.ok) {
        req.reject(new CryptoClientError(msg.error.code, msg.error.message));
        return;
      }

      if (req.opGeneration !== this.currentGeneration) {
        req.reject(
          new CryptoClientError(
            'STALE_GENERATION',
            'Worker result discarded due to intervening lock or generation bump',
          ),
        );
        return;
      }

      req.resolve(msg.result);
    };

    w.onerror = () => {
      this.handleWorkerDeath('Crypto Worker encountered an unhandled error');
    };

    w.onmessageerror = () => {
      this.handleWorkerDeath('Crypto Worker encountered a message deserialization error');
    };
  }

  /**
   * Simulates or handles Worker crash/error: transitions client to `error` state,
   * bumps `currentGeneration`, terminates dead worker reference, and rejects all in-flight requests.
   */
  handleWorkerDeath(reason = 'Crypto Worker terminated unexpectedly'): void {
    this.currentGeneration += 1;
    const prevWorker = this.worker;
    this.worker = null;
    try {
      prevWorker?.terminate?.();
    } catch {
      // Ignore termination errors on dead worker
    }
    this.setState('error');

    const err = new CryptoClientError('WORKER_CRASHED', reason);
    for (const [, req] of this.pending) {
      req.reject(err);
    }
    this.pending.clear();
  }

  private resetWorkerAfterErrorIfUnlocking(): void {
    if (this.state === 'error' && !this.worker) {
      this.state = 'locked';
    }
  }

  private assertGenerationOrWipe(opGeneration: number, secretBuf?: Uint8Array): void {
    if (opGeneration !== this.currentGeneration) {
      if (secretBuf && secretBuf.byteLength > 0) {
        secretBuf.fill(0);
      }
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
  ): Promise<T> {
    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    const message: WorkerRequestMessage = {
      ...payload,
      id,
      generation: opGeneration,
    };

    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.pending.set(id, {
      id,
      opGeneration,
      resolve: resolve as (value: unknown) => void,
      reject,
    });

    try {
      worker.postMessage(message, transfer);
    } catch (err) {
      this.pending.delete(id);
      reject(
        new CryptoClientError(
          'WORKER_INTERNAL_ERROR',
          err instanceof Error ? err.message : 'Failed to postMessage to Crypto Worker',
          { cause: err },
        ),
      );
    }
    return promise;
  }

  async createVault(params: CreateVaultClientParams): Promise<CreateVaultResult> {
    const opGeneration = params.opGeneration ?? this.captureGeneration();
    this.resetWorkerAfterErrorIfUnlocking();
    const passBytes = toTransferableBytes(params.passphrase);

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
    );

    this.assertGenerationOrWipe(opGeneration);
    this.setState('unlocked');
    return res;
  }

  async unlockPassphrase(params: UnlockPassphraseClientParams): Promise<{ unlocked: true }> {
    const opGeneration = params.opGeneration ?? this.captureGeneration();
    this.resetWorkerAfterErrorIfUnlocking();
    const passBytes = toTransferableBytes(params.passphrase);

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
    );

    this.assertGenerationOrWipe(opGeneration);
    this.setState('unlocked');
    return res;
  }

  async unlockRecovery(
    params: UnlockRecoveryClientParams,
  ): Promise<DeriveRecoveryLookupResult & { recovering?: boolean }> {
    const opGeneration = params.opGeneration ?? this.captureGeneration();
    this.resetWorkerAfterErrorIfUnlocking();
    const rkBytes = toTransferableBytes(params.recoveryKey);

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
      },
      [rkBytes.buffer as ArrayBuffer],
    );

    this.assertGenerationOrWipe(opGeneration);
    if (params.wrap) {
      this.setState('recovering');
    }
    return res;
  }

  async unlockPrf(params: UnlockPrfClientParams): Promise<{ unlocked: true }> {
    const opGeneration = params.opGeneration ?? this.captureGeneration();
    this.resetWorkerAfterErrorIfUnlocking();
    const pwkBytes = toTransferableBytes(params.pwk);

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
    );

    this.assertGenerationOrWipe(opGeneration);
    this.setState('unlocked');
    return res;
  }

  async unlockDevKey(params: UnlockDevKeyClientParams): Promise<{ unlocked: true }> {
    const opGeneration = params.opGeneration ?? this.captureGeneration();
    this.resetWorkerAfterErrorIfUnlocking();

    if (params.beforePostMessage) {
      await params.beforePostMessage();
    }
    this.assertGenerationOrWipe(opGeneration);

    const res = await this.sendToWorker<{ unlocked: true }>(opGeneration, {
      type: 'unlockDevKey',
      devKey: params.devKey,
      wrappedVk: params.wrappedVk,
      userId: params.userId,
      vaultKeyId: params.vaultKeyId,
      privateKeysWrapped: params.privateKeysWrapped,
    });

    this.assertGenerationOrWipe(opGeneration);
    this.setState('unlocked');
    return res;
  }

  async rewrap(params: RewrapClientParams): Promise<RewrapResult> {
    const opGeneration = params.opGeneration ?? this.captureGeneration();
    const passBytes = toTransferableBytes(params.passphrase);

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
    );

    this.assertGenerationOrWipe(opGeneration);
    this.setState('unlocked');
    return res;
  }

  async makeRecoveryKeys(params: MakeRecoveryKeysClientParams = {}): Promise<MakeRecoveryKeysResult> {
    const opGeneration = params.opGeneration ?? this.captureGeneration();

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

  async wrapForPasskey(params: WrapForPasskeyClientParams): Promise<WrapForPasskeyResult> {
    const opGeneration = params.opGeneration ?? this.captureGeneration();
    const pwkBytes = toTransferableBytes(params.pwk);

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
    );

    this.assertGenerationOrWipe(opGeneration);
    return res;
  }

  async wrapForDevice(params: WrapForDeviceClientParams): Promise<WrapForDeviceResult> {
    const opGeneration = params.opGeneration ?? this.captureGeneration();

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

  async sealEntry(params: SealEntryClientParams): Promise<SealEntryResult> {
    const opGeneration = params.opGeneration ?? this.captureGeneration();

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

  async openEntry(params: OpenEntryClientParams): Promise<OpenEntryResult> {
    const opGeneration = params.opGeneration ?? this.captureGeneration();

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

  async lock(): Promise<LockResult> {
    this.currentGeneration += 1;
    const lockGen = this.currentGeneration;
    if (this.state !== 'error') {
      this.setState('locked');
    }

    // In-flight requests retain their older `req.opGeneration` and will be rejected
    // by the Worker (`STALE_GENERATION`) or by `bindWorker` / `assertGenerationOrWipe`
    // when their response arrives.

    if (!this.worker) {
      return { generation: this.currentGeneration };
    }

    return this.sendToWorker<LockResult>(lockGen, {
      type: 'lock',
    });
  }

  terminate(): void {
    this.currentGeneration += 1;
    const prev = this.worker;
    this.worker = null;
    this.setState('locked');
    try {
      prev?.terminate?.();
    } catch {
      // Ignore
    }
    const err = new CryptoClientError('STALE_GENERATION', 'Crypto client terminated');
    for (const [, req] of this.pending) {
      req.reject(err);
    }
    this.pending.clear();
  }
}

export {
  CryptoWorkerError,
  type CreateVaultResult,
  type CryptoWorkerErrorCode,
  type DeriveRecoveryLookupResult,
  type LockResult,
  type MakeRecoveryKeysResult,
  type OpenEntryResult,
  type RewrapResult,
  type SealEntryResult,
  type WrapForDeviceResult,
  type WrapForPasskeyResult,
};
