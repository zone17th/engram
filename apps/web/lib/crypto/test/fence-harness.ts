import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect } from 'vitest';
import { CryptoClient } from '../client';
import type { VaultKdfParams, WorkerRequestMessage, WorkerResponseMessage } from '../protocol';
import {
  deriveRecoveryLookupHash,
  deriveRecoveryWrapKey,
  formatRecoveryKeyDisplay,
  generateRecoveryKey,
  normalizeRecoveryKey,
  type RecoveryKeyAdapter,
} from '../recovery';
import { getSodium, type Sodium } from '../sodium';
import { sealDevKeyWrap } from '../wrap';
import type { MatrixCaseSpec, MatrixCommand, MatrixStartMode, QueueCaseSpec } from './matrix-specs';
import { WorkerModel, type ModelMode, type ModelOutcome, type VaultId } from './fence-model';
import { createWorkerShim, type ShimmedWorkerInstance } from './worker-shim';

const utf8Encoder = new TextEncoder();

export function fastDeriveKek(sodium: Sodium, passphrase: Uint8Array, params: VaultKdfParams): Uint8Array {
  const input = new Uint8Array(passphrase.byteLength + params.salt.length);
  input.set(passphrase, 0);
  input.set(utf8Encoder.encode(params.salt), passphrase.byteLength);
  return sodium.crypto_generichash(32, input, null, 'uint8array');
}

export function makeDeterministicRecoveryAdapter(): RecoveryKeyAdapter {
  let counter = 1;
  return {
    generateRecoveryKey: (sodium: Sodium, slot: number) => {
      const raw16 = new Uint8Array(16);
      raw16[0] = slot & 0xff;
      raw16[1] = (counter >> 8) & 0xff;
      raw16[2] = counter & 0xff;
      counter++;
      for (let i = 3; i < 16; i++) {
        raw16[i] = (slot * 19 + i * 11 + counter) & 0xff;
      }
      return generateRecoveryKey(sodium, slot, raw16);
    },
    formatRecoveryKeyDisplay,
    normalizeRecoveryKey,
    deriveRecoveryLookupHash,
    deriveRecoveryWrapKey,
  };
}

// ---------------------------------------------------------------------------------------------
// Shared vault artifacts
// ---------------------------------------------------------------------------------------------

export interface PersistedVault {
  passphrase: string;
  kdf: VaultKdfParams;
  vaultKeyWrappedByKek: string;
  privateKeysWrapped: string;
}

export interface SharedArtifacts {
  sodium: Sodium;
  vault: PersistedVault;
  rk0: { slot: number; display: string; lookup_hash: string; wrap: string };
  pwk: Uint8Array;
  vkWrap: string;
  devKey: CryptoKey;
  wrappedVk: Uint8Array;
  userId: string;
  vaultKeyId: string;
  entryId: string;
  sealedEntry: { envelope: unknown; ciphertext: string };
  originalVk: Uint8Array;
}

export const BASELINE_PASSPHRASE = 'matrix-baseline-passphrase';
export const CREATE_PASSPHRASE = 'cmd-create-passphrase';
export const REWRAP_PASSPHRASE = 'cmd-rewrap-passphrase';
export const ENTRY_PLAINTEXT = 'matrix-entry-secret-payload';

export async function buildSharedArtifacts(): Promise<SharedArtifacts> {
  const sodium = await getSodium();
  const setupShim = createWorkerShim({
    deriveKek: fastDeriveKek,
    recovery: makeDeterministicRecoveryAdapter(),
  });
  const setupClient = new CryptoClient({ createWorker: () => setupShim.port });
  const created = await setupClient.createVault({
    passphrase: BASELINE_PASSPHRASE,
    opGeneration: setupClient.captureGeneration(),
  });
  const originalVk = setupShim.core.inspectClosureVkForTest()!;
  const pwk = new Uint8Array(32).fill(0x3c);
  const { vk_wrap: vkWrap } = await setupClient.wrapForPasskey({
    pwk: new Uint8Array(pwk),
    opGeneration: setupClient.captureGeneration(),
  });
  const devKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const userId = '11111111-1111-4111-8111-111111111111';
  const vaultKeyId = 'vk:7f3a9b2c4d5e6f7a8b9c0d';
  const { wrapped_vk: wrappedVk } = await setupClient.wrapForDevice({
    devKey,
    userId,
    vaultKeyId,
    opGeneration: setupClient.captureGeneration(),
  });
  const entryId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const sealedEntry = await setupClient.sealEntry({
    entryId,
    keyId: vaultKeyId,
    plaintext: ENTRY_PLAINTEXT,
    opGeneration: setupClient.captureGeneration(),
  });
  setupClient.terminate();
  setupShim.close();
  return {
    sodium,
    vault: {
      passphrase: BASELINE_PASSPHRASE,
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      privateKeysWrapped: created.private_keys_wrapped,
    },
    rk0: created.recovery_keys[0]!,
    pwk,
    vkWrap,
    devKey,
    wrappedVk,
    userId,
    vaultKeyId,
    entryId,
    sealedEntry,
    originalVk,
  };
}

// ---------------------------------------------------------------------------------------------
// Gates and the Worker-owned secret tracker
// ---------------------------------------------------------------------------------------------

/** One-shot gate: the next command that reaches the armed point parks until `release()`. */
export class Gate {
  armed = false;
  parked = false;
  private parkedWaiters: Array<() => void> = [];
  private releaseWaiter: (() => void) | null = null;
  private releaseP: Promise<void> | null = null;

  arm(): void {
    expect(this.armed || this.parked).toBe(false);
    this.armed = true;
  }

  async maybePark(): Promise<void> {
    if (!this.armed) return;
    this.armed = false;
    this.parked = true;
    this.releaseP = new Promise<void>((resolve) => {
      this.releaseWaiter = resolve;
    });
    for (const w of this.parkedWaiters.splice(0)) w();
    await this.releaseP;
  }

  release(): void {
    this.armed = false;
    if (!this.parked) return;
    this.parked = false;
    this.releaseWaiter?.();
    this.releaseWaiter = null;
  }
}

export interface TrackedAllocation {
  kind: string;
  buf: Uint8Array;
}

export interface SecretTracker {
  allocations: TrackedAllocation[];
  track(kind: string, buf: Uint8Array): void;
  /** Non-zero allocations; the live closure key group (latest `closure-vk` + its seeds) is exempt unless locked. */
  nonZero(mode?: string): TrackedAllocation[];
  kinds(): Record<string, number>;
  uninstall(): void;
}

/**
 * Records the ACTUAL Worker-owned secret allocations (VK / seeds from libsodium, AEAD plaintext, recovery
 * wrap keys and lookup hashes, private keys, WebCrypto DevKey plaintext) by wrapping the producing primitives,
 * so a missing `memzero` on any of them is visible (T-r4-2). Caller-side buffers are NOT tracked here.
 */
export function installSecretTracker(sodium: Sodium, decryptGate: Gate): SecretTracker {
  const allocations: TrackedAllocation[] = [];
  const restore: Array<() => void> = [];
  const record = (kind: string, buf: unknown): void => {
    if (buf instanceof Uint8Array) allocations.push({ kind, buf });
  };
  const patch = <T extends object>(
    target: T,
    key: string,
    wrap: (orig: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
  ): void => {
    const holder = target as unknown as Record<string, (...args: unknown[]) => unknown>;
    const orig = holder[key]!;
    holder[key] = wrap(orig.bind(target));
    restore.push(() => {
      holder[key] = orig;
    });
  };

  patch(sodium, 'randombytes_buf', (orig) => (...args) => {
    const out = orig(...args);
    if (args[0] === 32) record('random32', out);
    return out;
  });
  patch(sodium, 'crypto_aead_xchacha20poly1305_ietf_decrypt', (orig) => (...args) => {
    const out = orig(...args);
    record('aead-plaintext', out);
    return out;
  });
  patch(sodium, 'crypto_generichash', (orig) => (...args) => {
    const out = orig(...args);
    if (args[0] === 32) record('hash32', out);
    return out;
  });
  for (const fn of ['crypto_box_seed_keypair', 'crypto_sign_seed_keypair']) {
    patch(sodium, fn, (orig) => (...args) => {
      const out = orig(...args) as { privateKey?: Uint8Array };
      record(fn, out.privateKey);
      return out;
    });
  }
  patch(crypto.subtle, 'decrypt', (orig) => async (...args) => {
    const out = (await orig(...args)) as ArrayBuffer;
    record('subtle-plaintext', new Uint8Array(out));
    await decryptGate.maybePark();
    return out;
  });

  return {
    allocations,
    track: (kind, buf) => record(kind, buf),
    nonZero: (mode = 'locked') => {
      const live = new Set<Uint8Array>();
      if (mode !== 'locked') {
        let last = -1;
        allocations.forEach((a, i) => {
          if (a.kind === 'closure-vk') last = i;
        });
        for (let i = last; last >= 0 && i < allocations.length; i += 1) {
          if (allocations[i]!.kind.startsWith('closure')) live.add(allocations[i]!.buf);
        }
      }
      return allocations.filter((a) => !live.has(a.buf) && a.buf.some((b) => b !== 0));
    },
    kinds: () => {
      const out: Record<string, number> = {};
      for (const a of allocations) out[a.kind] = (out[a.kind] ?? 0) + 1;
      return out;
    },
    uninstall: () => {
      for (const r of restore.splice(0).reverse()) r();
    },
  };
}

/** Worker-side copies of incoming secrets (structured-clone targets) must be zero once the command settled. */
export function nonZeroInboundSecrets(shim: ShimmedWorkerInstance): string[] {
  const bad: string[] = [];
  for (const req of shim.workerReceivedRequests) {
    const r = req as unknown as Record<string, unknown>;
    for (const field of ['passphraseBuffer', 'recoveryKeyBuffer', 'pwkBuffer']) {
      const v = r[field];
      if (v instanceof ArrayBuffer || Object.prototype.toString.call(v) === '[object ArrayBuffer]') {
        if (new Uint8Array(v as ArrayBuffer).some((b) => b !== 0)) bad.push(`${req.type}.${field}`);
      }
    }
    if (req.type === 'sealEntry' && ArrayBuffer.isView(r.plaintext)) {
      const pt = r.plaintext as Uint8Array;
      if (new Uint8Array(pt.buffer, pt.byteOffset, pt.byteLength).some((b) => b !== 0)) {
        bad.push('sealEntry.plaintext');
      }
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------------------------
// Drivers: the same schedule is executed through the public CryptoClient or raw Worker messages
// ---------------------------------------------------------------------------------------------

export type Normalized = { ok: true; value: unknown } | { ok: false; code: string };

export interface Driver {
  readonly level: 'client' | 'worker';
  gen(): number;
  call(cmd: MatrixCommand, gen: number): Promise<Normalized>;
  unlockWith(vault: PersistedVault, gen: number): Promise<Normalized>;
  seal(plaintext: string, gen: number): Promise<Normalized>;
  open(sealed: { envelope: unknown; ciphertext: string }, gen: number): Promise<Normalized>;
  /** Mirror state of the client (client level only). */
  mirror(): { mode: string; epoch: number; generation: number } | null;
  /** Number of messages this driver has posted to the Worker (client-busy and stale calls must not post). */
  posted(): number;
  close(): void;
}

function normalizeError(err: unknown): Normalized {
  const code =
    typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
      ? err.code
      : `UNCODED:${String(err)}`;
  return { ok: false, code };
}

function normalize(p: Promise<unknown>): Promise<Normalized> {
  return p.then(
    (value) => ({ ok: true, value }),
    (err: unknown) => normalizeError(err),
  );
}

export function createClientDriver(shared: SharedArtifacts, shim: ShimmedWorkerInstance): Driver {
  const client = new CryptoClient({ createWorker: () => shim.port });
  const enc = (s: string): Uint8Array => new Uint8Array(utf8Encoder.encode(s));
  return {
    level: 'client',
    gen: () => client.captureGeneration(),
    call(cmd, gen) {
      switch (cmd) {
        case 'createVault':
          return normalize(
            client.createVault({
              passphrase: enc(CREATE_PASSPHRASE),
              skipRecoveryKeys: true,
              opGeneration: gen,
            }),
          );
        case 'unlockPassphrase':
          return normalize(
            client.unlockPassphrase({
              passphrase: enc(shared.vault.passphrase),
              kdf: shared.vault.kdf,
              vaultKeyWrappedByKek: shared.vault.vaultKeyWrappedByKek,
              privateKeysWrapped: shared.vault.privateKeysWrapped,
              opGeneration: gen,
            }),
          );
        case 'unlockRecovery':
          return normalize(
            client.unlockRecovery({ recoveryKey: enc(shared.rk0.display), opGeneration: gen }),
          );
        case 'unlockRecoveryWrap':
          return normalize(
            client.unlockRecovery({
              recoveryKey: enc(shared.rk0.display),
              wrap: shared.rk0.wrap,
              privateKeysWrapped: shared.vault.privateKeysWrapped,
              opGeneration: gen,
            }),
          );
        case 'resumeRecovery':
          return normalize(
            client.resumeRecovery({
              wrap: shared.rk0.wrap,
              privateKeysWrapped: shared.vault.privateKeysWrapped,
              opGeneration: gen,
            }),
          );
        case 'confirmRecovery':
          return normalize(client.confirmRecovery({ opGeneration: gen }));
        case 'unlockPrf':
          return normalize(
            client.unlockPrf({
              pwk: new Uint8Array(shared.pwk),
              vkWrap: shared.vkWrap,
              privateKeysWrapped: shared.vault.privateKeysWrapped,
              opGeneration: gen,
            }),
          );
        case 'unlockDevKey':
          return normalize(
            client.unlockDevKey({
              devKey: shared.devKey,
              wrappedVk: shared.wrappedVk,
              userId: shared.userId,
              vaultKeyId: shared.vaultKeyId,
              privateKeysWrapped: shared.vault.privateKeysWrapped,
              opGeneration: gen,
            }),
          );
        case 'rewrap':
          return normalize(
            client.rewrap({
              passphrase: enc(REWRAP_PASSPHRASE),
              currentKdf: shared.vault.kdf,
              opGeneration: gen,
            }),
          );
        case 'makeRecoveryKeys':
          return normalize(client.makeRecoveryKeys({ slots: [1], opGeneration: gen }));
        case 'wrapForPasskey':
          return normalize(
            client.wrapForPasskey({ pwk: new Uint8Array(shared.pwk), opGeneration: gen }),
          );
        case 'wrapForDevice':
          return normalize(
            client.wrapForDevice({
              devKey: shared.devKey,
              userId: shared.userId,
              vaultKeyId: shared.vaultKeyId,
              opGeneration: gen,
            }),
          );
        case 'sealEntry':
          return normalize(
            client.sealEntry({
              entryId: shared.entryId,
              keyId: shared.vaultKeyId,
              plaintext: enc('cmd-seal-entry-bytes'),
              opGeneration: gen,
            }),
          );
        case 'openEntry':
          return normalize(
            client.openEntry({
              entryId: shared.entryId,
              envelope: shared.sealedEntry.envelope,
              ciphertext: shared.sealedEntry.ciphertext,
              opGeneration: gen,
            }),
          );
        case 'lock':
          return normalize(client.lock());
      }
    },
    unlockWith: (vault, gen) =>
      normalize(
        client.unlockPassphrase({
          passphrase: enc(vault.passphrase),
          kdf: vault.kdf,
          vaultKeyWrappedByKek: vault.vaultKeyWrappedByKek,
          privateKeysWrapped: vault.privateKeysWrapped,
          opGeneration: gen,
        }),
      ),
    seal: (plaintext, gen) =>
      normalize(
        client.sealEntry({
          entryId: shared.entryId,
          keyId: shared.vaultKeyId,
          plaintext: enc(plaintext),
          opGeneration: gen,
        }),
      ),
    open: (sealed, gen) =>
      normalize(
        client.openEntry({
          entryId: shared.entryId,
          envelope: sealed.envelope,
          ciphertext: sealed.ciphertext,
          opGeneration: gen,
        }),
      ),
    mirror: () => ({
      mode: client.getState(),
      epoch: client.getEpoch(),
      generation: client.getGeneration(),
    }),
    posted: () => shim.clientPostMessageCalls.length,
    close: () => client.terminate(),
  };
}

export function createWorkerDriver(shared: SharedArtifacts, shim: ShimmedWorkerInstance): Driver {
  let gen = 0;
  let nextId = 1_000_000;
  let postedCount = 0;
  const waiting = new Map<number, (r: WorkerResponseMessage) => void>();
  shim.port.onmessage = (ev) => {
    const reply = ev.data;
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  };
  const enc = (s: string): ArrayBuffer => utf8Encoder.encode(s).buffer as ArrayBuffer;

  function send(payload: Record<string, unknown>, transfer: ArrayBuffer[], msgGen: number): Promise<Normalized> {
    const id = nextId++;
    const message = { ...payload, id, generation: msgGen } as unknown as WorkerRequestMessage;
    return new Promise<Normalized>((resolve) => {
      waiting.set(id, (reply) =>
        resolve(reply.ok ? { ok: true, value: reply.result } : { ok: false, code: reply.error.code }),
      );
      postedCount += 1;
      shim.port.postMessage(message, transfer);
    });
  }
  const passphraseMsg = (type: string, passphrase: string, extra: Record<string, unknown>, g: number) => {
    const buf = enc(passphrase);
    return send({ type, passphraseBuffer: buf, ...extra }, [buf], g);
  };

  return {
    level: 'worker',
    gen: () => gen,
    call(cmd, g) {
      switch (cmd) {
        case 'createVault':
          return passphraseMsg('createVault', CREATE_PASSPHRASE, { skipRecoveryKeys: true }, g);
        case 'unlockPassphrase':
          return passphraseMsg(
            'unlockPassphrase',
            shared.vault.passphrase,
            {
              kdf: shared.vault.kdf,
              vaultKeyWrappedByKek: shared.vault.vaultKeyWrappedByKek,
              privateKeysWrapped: shared.vault.privateKeysWrapped,
            },
            g,
          );
        case 'unlockRecovery':
        case 'unlockRecoveryWrap': {
          const buf = enc(shared.rk0.display);
          return send(
            {
              type: 'unlockRecovery',
              recoveryKeyBuffer: buf,
              ...(cmd === 'unlockRecoveryWrap'
                ? { wrap: shared.rk0.wrap, privateKeysWrapped: shared.vault.privateKeysWrapped }
                : {}),
            },
            [buf],
            g,
          );
        }
        case 'resumeRecovery':
          return send(
            {
              type: 'resumeRecovery',
              wrap: shared.rk0.wrap,
              privateKeysWrapped: shared.vault.privateKeysWrapped,
            },
            [],
            g,
          );
        case 'confirmRecovery':
          return send({ type: 'confirmRecovery' }, [], g);
        case 'unlockPrf': {
          const buf = new Uint8Array(shared.pwk).buffer as ArrayBuffer;
          return send(
            {
              type: 'unlockPrf',
              pwkBuffer: buf,
              vkWrap: shared.vkWrap,
              privateKeysWrapped: shared.vault.privateKeysWrapped,
            },
            [buf],
            g,
          );
        }
        case 'unlockDevKey':
          return send(
            {
              type: 'unlockDevKey',
              devKey: shared.devKey,
              wrappedVk: shared.wrappedVk,
              userId: shared.userId,
              vaultKeyId: shared.vaultKeyId,
              privateKeysWrapped: shared.vault.privateKeysWrapped,
            },
            [],
            g,
          );
        case 'rewrap':
          return passphraseMsg('rewrap', REWRAP_PASSPHRASE, { currentKdf: shared.vault.kdf }, g);
        case 'makeRecoveryKeys':
          return send({ type: 'makeRecoveryKeys', slots: [1] }, [], g);
        case 'wrapForPasskey': {
          const buf = new Uint8Array(shared.pwk).buffer as ArrayBuffer;
          return send({ type: 'wrapForPasskey', pwkBuffer: buf }, [buf], g);
        }
        case 'wrapForDevice':
          return send(
            {
              type: 'wrapForDevice',
              devKey: shared.devKey,
              userId: shared.userId,
              vaultKeyId: shared.vaultKeyId,
            },
            [],
            g,
          );
        case 'sealEntry':
          return send(
            {
              type: 'sealEntry',
              entryId: shared.entryId,
              keyId: shared.vaultKeyId,
              plaintext: utf8Encoder.encode('cmd-seal-entry-bytes'),
            },
            [],
            g,
          );
        case 'openEntry':
          return send(
            {
              type: 'openEntry',
              entryId: shared.entryId,
              envelope: shared.sealedEntry.envelope,
              ciphertext: shared.sealedEntry.ciphertext,
            },
            [],
            g,
          );
        case 'lock':
          gen += 1;
          return send({ type: 'lock' }, [], gen);
      }
    },
    unlockWith: (vault, g) =>
      passphraseMsg(
        'unlockPassphrase',
        vault.passphrase,
        {
          kdf: vault.kdf,
          vaultKeyWrappedByKek: vault.vaultKeyWrappedByKek,
          privateKeysWrapped: vault.privateKeysWrapped,
        },
        g,
      ),
    seal: (plaintext, g) =>
      send(
        {
          type: 'sealEntry',
          entryId: shared.entryId,
          keyId: shared.vaultKeyId,
          plaintext: utf8Encoder.encode(plaintext),
        },
        [],
        g,
      ),
    open: (sealed, g) =>
      send(
        {
          type: 'openEntry',
          entryId: shared.entryId,
          envelope: sealed.envelope,
          ciphertext: sealed.ciphertext,
        },
        [],
        g,
      ),
    mirror: () => null,
    posted: () => postedCount,
    close: () => undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// World: shim + gates + tracker + driver + model for one case
// ---------------------------------------------------------------------------------------------

export interface World {
  shared: SharedArtifacts;
  shim: ShimmedWorkerInstance;
  derive: Gate;
  decrypt: Gate;
  tracker: SecretTracker;
  driver: Driver;
  persisted: Record<VaultId, PersistedVault | undefined>;
  close(): void;
}

export function createWorld(shared: SharedArtifacts, level: 'client' | 'worker'): World {
  const derive = new Gate();
  const decrypt = new Gate();
  const tracker = installSecretTracker(shared.sodium, decrypt);
  const detRecovery = makeDeterministicRecoveryAdapter();
  const shim = createWorkerShim({
    deriveKek: async (s, pass, params) => {
      await derive.maybePark();
      const out = fastDeriveKek(s, pass, params);
      tracker.track('kek', out);
      return out;
    },
    sealDevKeyWrap: (s, vk, dk, uid, vkid) => sealDevKeyWrap(s, vk, dk, uid, vkid),
    recovery: detRecovery,
    onSecretAllocated: (kind, buf) => tracker.track(kind, buf),
  });
  const driver =
    level === 'client' ? createClientDriver(shared, shim) : createWorkerDriver(shared, shim);
  return {
    shared,
    shim,
    derive,
    decrypt,
    tracker,
    driver,
    persisted: { orig: shared.vault, created: undefined },
    close() {
      derive.release();
      decrypt.release();
      driver.close();
      shim.close();
      tracker.uninstall();
    },
  };
}

export function expectOk(r: Normalized, what: string): unknown {
  expect(r, what).toMatchObject({ ok: true });
  return (r as { ok: true; value: unknown }).value;
}

/** Establishes a start mode through the driver, one awaited command at a time. */
export async function establishStartMode(world: World, start: MatrixStartMode): Promise<{
  mode: ModelMode;
  pending: boolean;
  vk: VaultId | null;
}> {
  const d = world.driver;
  const g = d.gen();
  switch (start) {
    case 'locked':
      // A harmless read-only call spawns the (lazy) Worker so a later lock() reaches it.
      expect(await d.call('sealEntry', g)).toEqual({ ok: false, code: 'VAULT_LOCKED' });
      return { mode: 'locked', pending: false, vk: null };
    case 'pending-continuation':
      expectOk(await d.call('unlockRecovery', g), 'setup lookup');
      return { mode: 'locked', pending: true, vk: null };
    case 'recovering':
    case 'recovering-after-rewrap': {
      expectOk(await d.call('unlockRecovery', g), 'setup lookup');
      expectOk(await d.call('resumeRecovery', g), 'setup resume');
      if (start === 'recovering-after-rewrap') {
        const res = expectOk(await d.call('rewrap', g), 'setup rewrap') as {
          kdf: VaultKdfParams;
          vault_key_wrapped_by_kek: string;
        };
        world.persisted.orig = {
          passphrase: REWRAP_PASSPHRASE,
          kdf: res.kdf,
          vaultKeyWrappedByKek: res.vault_key_wrapped_by_kek,
          privateKeysWrapped: world.shared.vault.privateKeysWrapped,
        };
      }
      return { mode: 'recovering', pending: false, vk: 'orig' };
    }
    case 'unlocked':
      expectOk(await d.call('unlockPassphrase', g), 'setup unlock');
      return { mode: 'unlocked', pending: false, vk: 'orig' };
  }
}

// ---------------------------------------------------------------------------------------------
// Lock-step execution: every step is applied to the model and the real system, then compared
// ---------------------------------------------------------------------------------------------

interface Tracked {
  cmd: MatrixCommand;
  settled: boolean;
  outcome?: Normalized;
  promise: Promise<Normalized>;
}

const DECRYPT_GATED: ReadonlySet<MatrixCommand> = new Set<MatrixCommand>(['unlockDevKey', 'wrapForDevice']);

export class LockstepRun {
  readonly model: WorkerModel;
  readonly posts = new Map<string, Tracked>();

  constructor(
    private readonly world: World,
    initial: { mode: ModelMode; pending: boolean; vk: VaultId | null },
  ) {
    this.model = new WorkerModel(initial, { level: world.driver.level });
  }

  /** Posts `cmd` at generation `gen` (hold = park at its last Worker await when it can). */
  async post(id: string, cmd: MatrixCommand, gen: number, hold: boolean): Promise<void> {
    const { driver, derive, decrypt } = this.world;
    const holds = hold && this.model.predictHold(cmd, gen);
    if (holds) {
      (DECRYPT_GATED.has(cmd) ? decrypt : derive).arm();
    }
    const postedBefore = driver.posted();
    const promise = driver.call(cmd, gen);
    const tracked: Tracked = { cmd, settled: false, promise };
    this.posts.set(id, tracked);
    void promise.then((outcome) => {
      tracked.settled = true;
      tracked.outcome = outcome;
    });
    this.model.post(id, cmd, gen, holds);
    await this.sync(`after post ${id}=${cmd}`);
    const immediate = this.model.settled.get(id);
    if (
      driver.level === 'client' &&
      immediate &&
      !immediate.ok &&
      (immediate.code === 'CLIENT_BUSY' || immediate.code === 'STALE_GENERATION')
    ) {
      // CLIENT_BUSY and pre-dispatch STALE_GENERATION never contact the Worker
      expect(driver.posted(), `${id}=${cmd} (${immediate.code}) must not reach the Worker`).toBe(postedBefore);
    }
  }

  async release(id: string): Promise<void> {
    const item = this.model.heldItems().find((h) => h.id === id);
    expect(item, `model holds ${id}`).toBeDefined();
    const gate = DECRYPT_GATED.has(item!.cmd) ? this.world.decrypt : this.world.derive;
    this.model.release(id);
    gate.release();
    await this.sync(`after release ${id}`);
  }

  async releaseAll(): Promise<void> {
    for (let guard = 0; guard < 8; guard += 1) {
      const next = this.model.heldItems()[0];
      if (!next) return;
      await this.release(next.id);
    }
    throw new Error('releaseAll did not converge');
  }

  private realSettled(): string[] {
    return [...this.posts.entries()].filter(([, t]) => t.settled).map(([id]) => id).sort();
  }

  private expectedGates(): { derive: boolean; decrypt: boolean } {
    const held = this.model.heldItems();
    return {
      derive: held.some((h) => !DECRYPT_GATED.has(h.cmd)),
      decrypt: held.some((h) => DECRYPT_GATED.has(h.cmd)),
    };
  }

  private async sync(label: string): Promise<void> {
    const expectedSettled = [...this.model.settled.keys()].sort();
    const matches = (): boolean => {
      const gates = this.expectedGates();
      return (
        JSON.stringify(this.realSettled()) === JSON.stringify(expectedSettled) &&
        this.world.derive.parked === gates.derive &&
        this.world.decrypt.parked === gates.decrypt
      );
    };
    let ticks = 0;
    while (!matches() && ticks < 2000) {
      await nextTurn();
      ticks += 1;
    }
    // Negative check: nothing else may settle or park while the model says it must not.
    for (let i = 0; i < 4; i += 1) await nextTurn();
    const gates = this.expectedGates();
    expect(this.realSettled(), `${label}: settled set`).toEqual(expectedSettled);
    expect(
      { derive: this.world.derive.parked, decrypt: this.world.decrypt.parked },
      `${label}: parked gates`,
    ).toEqual(gates);
  }

  /** Awaits every promise and asserts its exact settlement against the model. Returns real values. */
  async settleAll(): Promise<Map<string, Normalized>> {
    const results = new Map<string, Normalized>();
    for (const [id, tracked] of this.posts) {
      const outcome = await tracked.promise;
      results.set(id, outcome);
      const expected: ModelOutcome | undefined = this.model.settled.get(id);
      expect(expected, `model settled ${id}`).toBeDefined();
      if (expected!.ok) {
        expect(outcome, `${id}=${tracked.cmd}`).toMatchObject({ ok: true });
      } else {
        expect(outcome, `${id}=${tracked.cmd}`).toEqual({ ok: false, code: expected!.code });
      }
    }
    return results;
  }
}

/** Applies the model's persisted-vault events using the real values of the commands that settled ok. */
export function applyPersistEvents(
  world: World,
  run: LockstepRun,
  results: Map<string, Normalized>,
): void {
  for (const ev of run.model.persistEvents) {
    const res = results.get(ev.id);
    expect(res).toMatchObject({ ok: true });
    const value = (res as { ok: true; value: unknown }).value as {
      kdf: VaultKdfParams;
      vault_key_wrapped_by_kek: string;
      private_keys_wrapped?: string;
    };
    if (ev.kind === 'create') {
      world.persisted.created = {
        passphrase: CREATE_PASSPHRASE,
        kdf: value.kdf,
        vaultKeyWrappedByKek: value.vault_key_wrapped_by_kek,
        privateKeysWrapped: value.private_keys_wrapped!,
      };
    } else {
      const base = world.persisted[ev.vault]!;
      world.persisted[ev.vault] = {
        passphrase: REWRAP_PASSPHRASE,
        kdf: value.kdf,
        vaultKeyWrappedByKek: value.vault_key_wrapped_by_kek,
        privateKeysWrapped: base.privateKeysWrapped,
      };
    }
  }
}

/** Final-state assertions shared by every generated case (state, authority of replies, zeroing). */
export function assertFinalState(world: World, run: LockstepRun): void {
  const { shim, shared, driver } = world;
  const m = run.model.state;
  const snap = shim.core.getStateSnapshot();
  expect({ mode: snap.mode, pending: snap.hasPendingContinuation, generation: snap.generation }).toEqual({
    mode: m.mode,
    pending: m.pending,
    generation: m.gen,
  });
  const vk = shim.core.inspectClosureVkForTest();
  if (m.vk === null) {
    expect(vk).toBeNull();
  } else {
    expect(vk).not.toBeNull();
    const isOrig = shared.sodium.memcmp(vk!, shared.originalVk);
    expect(isOrig, `Worker VK identity must be ${m.vk}`).toBe(m.vk === 'orig');
  }

  // Every reply carries the authoritative state; epochs never go backwards and the last reply matches the end state.
  let lastEpoch = -1;
  for (const reply of shim.workerPostMessageCalls) {
    expect(reply.state, `reply ${reply.id} state`).toBeDefined();
    expect(reply.state.epoch).toBeGreaterThanOrEqual(lastEpoch);
    lastEpoch = reply.state.epoch;
  }
  const lastReply = shim.workerPostMessageCalls[shim.workerPostMessageCalls.length - 1];
  if (lastReply) expect(lastReply.state).toEqual(shim.core.getStateReport());

  const mirror = driver.mirror();
  if (mirror) {
    expect(mirror.mode).toBe(snap.mode);
    expect(mirror.generation).toBe(snap.generation);
    expect(mirror.epoch).toBe(snap.epoch);
  }
}

/**
 * Every tracked Worker-owned allocation must be zero, except the wrap key of a LIVE pending recovery
 * continuation (`livePending`), which is the one secret the Worker legitimately still holds.
 */
export function assertSecretsZeroed(world: World, livePending = false, mode = 'locked'): void {
  const bad = world.tracker.nonZero(mode);
  const expected = livePending ? ['hash32'] : [];
  expect(
    bad.map((b) => b.kind),
    `non-zero Worker-owned secret allocations (tracked ${JSON.stringify(world.tracker.kinds())})`,
  ).toEqual(expected);
  expect(nonZeroInboundSecrets(world.shim)).toEqual([]);
}

/**
 * seal -> lock -> unlock from the PERSISTED vault -> open, with no skip when the VK changed: a Worker key that
 * differs from the persisted vault's key makes the final open fail.
 */
export async function roundTrip(world: World, run: LockstepRun): Promise<void> {
  const { driver, persisted } = world;
  const active = run.model.state.active;
  const vault = persisted[active];
  expect(vault, `persisted vault ${active}`).toBeDefined();
  let mode = run.model.state.mode;
  const some = { envelope: world.shared.sealedEntry.envelope, ciphertext: world.shared.sealedEntry.ciphertext };

  if (mode === 'recovering') {
    expect(await driver.seal('x', driver.gen())).toEqual({ ok: false, code: 'VAULT_RECOVERING' });
    expect(await driver.open(some, driver.gen())).toEqual({ ok: false, code: 'VAULT_RECOVERING' });
    expectOk(await driver.call('confirmRecovery', driver.gen()), 'confirmRecovery');
    mode = 'unlocked';
  }
  if (mode === 'locked') {
    expect(await driver.seal('x', driver.gen())).toEqual({ ok: false, code: 'VAULT_LOCKED' });
    expectOk(await driver.unlockWith(vault!, driver.gen()), 'unlock persisted (from locked)');
  }
  const plaintext = 'round-trip-entry-payload';
  const sealed = expectOk(await driver.seal(plaintext, driver.gen()), 'seal') as {
    envelope: unknown;
    ciphertext: string;
  };
  expectOk(await driver.call('lock', driver.gen()), 'lock');
  expect(await driver.open(sealed, driver.gen())).toEqual({ ok: false, code: 'VAULT_LOCKED' });
  expectOk(await driver.unlockWith(vault!, driver.gen()), 'unlock persisted');
  const opened = expectOk(await driver.open(sealed, driver.gen()), 'open after persisted unlock') as {
    plaintext: string;
  };
  expect(opened.plaintext).toBe(plaintext);
  expectOk(await driver.call('lock', driver.gen()), 'final lock');
}

// ---------------------------------------------------------------------------------------------
// Generated case runners
// ---------------------------------------------------------------------------------------------


async function finishCase(world: World, run: LockstepRun): Promise<void> {
  await run.releaseAll();
  const results = await run.settleAll();
  applyPersistEvents(world, run, results);
  assertFinalState(world, run);
  assertSecretsZeroed(world, run.model.state.pending, run.model.state.mode);
  await roundTrip(world, run);
  // roundTrip ends locked: every closure key, seed copy and pending wrap key allocation must now be zero
  assertSecretsZeroed(world);
  expect(world.derive.parked || world.decrypt.parked).toBe(false);
}

export async function runMatrixCase(shared: SharedArtifacts, spec: MatrixCaseSpec): Promise<void> {
  const world = createWorld(shared, spec.level);
  try {
    const run = new LockstepRun(world, await establishStartMode(world, spec.startMode));
    const startGen = world.driver.gen();
    const C = spec.command;
    const during = spec.timing === 'issued-during';
    const xSteps: Array<{ cmd: MatrixCommand; hold: boolean }> = (() => {
      switch (spec.modeChange) {
        case 'lock':
          return [{ cmd: 'lock', hold: false }];
        case 'enterRecovering':
          return [{ cmd: 'unlockRecoveryWrap', hold: false }];
        case 'confirmRecovery':
          return [{ cmd: 'confirmRecovery', hold: false }];
        case 'ordinaryUnlock':
          return during
            ? [{ cmd: 'unlockPassphrase', hold: true }]
            : [{ cmd: 'unlockPrf', hold: false }];
      }
    })();

    if (spec.timing === 'issued-before-paused') {
      await run.post('C', C, startGen, true);
      for (const [i, x] of xSteps.entries()) await run.post(`X${i}`, x.cmd, startGen, x.hold);
    } else if (during) {
      if (spec.modeChange === 'enterRecovering') {
        // between the lookup step and the resume step of a two-step recovery entry
        await run.post('X0', 'unlockRecovery', startGen, false);
        await run.post('C', C, startGen, true);
        await run.post('X1', 'resumeRecovery', startGen, false);
      } else {
        for (const [i, x] of xSteps.entries()) await run.post(`X${i}`, x.cmd, startGen, x.hold);
        await run.post('C', C, startGen, true);
      }
    } else {
      for (const [i, x] of xSteps.entries()) await run.post(`X${i}`, x.cmd, startGen, x.hold);
      await run.post('C', C, world.driver.gen(), false);
    }
    await finishCase(world, run);
  } finally {
    world.close();
  }
}

export async function runQueueCase(shared: SharedArtifacts, spec: QueueCaseSpec): Promise<void> {
  const world = createWorld(shared, 'worker');
  try {
    const run = new LockstepRun(world, await establishStartMode(world, spec.startMode));
    const startGen = world.driver.gen();
    await run.post('A', spec.first, startGen, true);
    await run.post('B', spec.second, startGen, false);
    if (spec.variant === 'lock-while-held') {
      await run.post('L', 'lock', startGen, false);
    }
    await finishCase(world, run);
  } finally {
    world.close();
  }
}
