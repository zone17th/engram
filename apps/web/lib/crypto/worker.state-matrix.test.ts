import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CryptoClient, CryptoClientError } from './client';
import type { VaultKdfParams, WorkerCommandType } from './protocol';
import {
  deriveRecoveryLookupHash,
  deriveRecoveryWrapKey,
  formatRecoveryKeyDisplay,
  generateRecoveryKey,
  normalizeRecoveryKey,
  type RecoveryKeyAdapter,
} from './recovery';
import { getSodium, type Sodium } from './sodium';
import { createWorkerShim, type ShimmedWorkerInstance } from './test/worker-shim';
import { sealDevKeyWrap } from './wrap';

const utf8Encoder = new TextEncoder();

function fastDeriveKek(sodium: Sodium, passphrase: Uint8Array, params: VaultKdfParams): Uint8Array {
  const input = new Uint8Array(passphrase.byteLength + params.salt.length);
  input.set(passphrase, 0);
  input.set(utf8Encoder.encode(params.salt), passphrase.byteLength);
  return sodium.crypto_generichash(32, input, null, 'uint8array');
}

function makeDeterministicRecoveryAdapter(): RecoveryKeyAdapter {
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

type StartMode =
  | 'locked'
  | 'pending-continuation'
  | 'recovering'
  | 'recovering-after-rewrap'
  | 'unlocked';

type ModeChange = 'lock' | 'enterRecovering' | 'confirmRecovery' | 'ordinaryUnlock';

type Timing = 'issued-before-paused' | 'issued-during' | 'issued-after';

function readErrorCode(reason: unknown): string | undefined {
  if (reason instanceof CryptoClientError) {
    return reason.code;
  }
  if (
    typeof reason === 'object' &&
    reason !== null &&
    'code' in reason &&
    typeof reason.code === 'string'
  ) {
    return reason.code;
  }
  return undefined;
}

interface MatrixCaseSpec {
  name: string;
  command: WorkerCommandType;
  startMode: StartMode;
  modeChange: ModeChange;
  timing: Timing;
}

const ALL_COMMANDS: readonly WorkerCommandType[] = [
  'createVault',
  'unlockPassphrase',
  'unlockRecovery',
  'resumeRecovery',
  'confirmRecovery',
  'unlockPrf',
  'unlockDevKey',
  'rewrap',
  'makeRecoveryKeys',
  'wrapForPasskey',
  'wrapForDevice',
  'sealEntry',
  'openEntry',
  'lock',
] as const;

const ALL_START_MODES: readonly StartMode[] = [
  'locked',
  'pending-continuation',
  'recovering',
  'recovering-after-rewrap',
  'unlocked',
] as const;

const ALL_TIMINGS: readonly Timing[] = [
  'issued-before-paused',
  'issued-during',
  'issued-after',
] as const;

function modeChangesForStartMode(startMode: StartMode): readonly ModeChange[] {
  switch (startMode) {
    case 'locked':
    case 'pending-continuation':
      return ['lock', 'enterRecovering', 'ordinaryUnlock'];
    case 'recovering':
    case 'recovering-after-rewrap':
      return ['lock', 'confirmRecovery'];
    case 'unlocked':
      return ['lock', 'enterRecovering', 'ordinaryUnlock'];
  }
}

function buildMatrixSpecs(): MatrixCaseSpec[] {
  const specs: MatrixCaseSpec[] = [];
  for (const command of ALL_COMMANDS) {
    for (const startMode of ALL_START_MODES) {
      const modeChanges = modeChangesForStartMode(startMode);
      for (const modeChange of modeChanges) {
        for (const timing of ALL_TIMINGS) {
          specs.push({
            name: `cmd=${command} | start=${startMode} | change=${modeChange} | timing=${timing}`,
            command,
            startMode,
            modeChange,
            timing,
          });
        }
      }
    }
  }
  return specs;
}

const MATRIX_SPECS = buildMatrixSpecs();

interface VaultArtifacts {
  sodium: Sodium;
  kdf: VaultKdfParams;
  vaultKeyWrappedByKek: string;
  privateKeysWrapped: string;
  rk0: { slot: number; display: string; lookup_hash: string; wrap: string };
  rk1: { slot: number; display: string; lookup_hash: string; wrap: string };
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

describe('P03-T5 Structural State-Commit Matrix (14 commands × 5 start modes × mode changes × 3 timings)', () => {
  let shared: VaultArtifacts;
  const activeShims: ShimmedWorkerInstance[] = [];
  const executedCaseNames: string[] = [];

  beforeAll(async () => {
    const sodium = await getSodium();
    const setupShim = createWorkerShim({
      deriveKek: fastDeriveKek,
      recovery: makeDeterministicRecoveryAdapter(),
    });
    const setupClient = new CryptoClient({ createWorker: () => setupShim.port });

    const created = await setupClient.createVault({
      passphrase: 'matrix-baseline-passphrase',
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
      plaintext: 'matrix-entry-secret-payload',
      opGeneration: setupClient.captureGeneration(),
    });

    setupClient.terminate();
    setupShim.close();

    shared = {
      sodium,
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      privateKeysWrapped: created.private_keys_wrapped,
      rk0: created.recovery_keys[0]!,
      rk1: created.recovery_keys[1]!,
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (activeShims.length > 0) {
      activeShims.pop()?.close();
    }
  });

  afterAll(() => {
    const devVaultDir = 'D:/my-project/.engram-dev/p03-vault';
    const accidentalDir = 'D:/orca/.engram-dev';
    try {
      if (existsSync(accidentalDir)) {
        rmSync(accidentalDir, { recursive: true, force: true });
      }
      if (existsSync(devVaultDir)) {
        const outPath = resolve(devVaultDir, 'reports/crypto/fix3/matrix-cases.log');
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(
          outPath,
          `${executedCaseNames.map((n, i) => `${String(i + 1).padStart(3, '0')}. ${n}`).join('\n')}\n`,
          'utf8',
        );
      }
    } catch {
      // Ignore if outside standard dev layout
    }
  });

  it.each(MATRIX_SPECS)('$name', async (spec) => {
    executedCaseNames.push(spec.name);
    const { command, startMode, modeChange, timing } = spec;

    // Track temporary allocations derived inside Worker
    const trackedTempAllocs: Uint8Array[] = [];
    let pauseNextDerive = false;
    const deriveParked = Promise.withResolvers<void>();
    const releaseDerive = Promise.withResolvers<void>();

    let pauseNextSealDevKey = false;
    const sealDevKeyParked = Promise.withResolvers<void>();
    const releaseSealDevKey = Promise.withResolvers<void>();

    let pauseNextLookupHash = false;
    const lookupHashParked = Promise.withResolvers<void>();
    const releaseLookupHash = Promise.withResolvers<void>();

    const detRecovery = makeDeterministicRecoveryAdapter();
    const shim = createWorkerShim({
      deriveKek: async (s, pass, params) => {
        if (pauseNextDerive) {
          pauseNextDerive = false;
          deriveParked.resolve();
          await releaseDerive.promise;
        }
        const out = fastDeriveKek(s, pass, params);
        trackedTempAllocs.push(out);
        return out;
      },
      sealDevKeyWrap: async (s, vk, dk, uid, vkid) => {
        if (pauseNextSealDevKey) {
          pauseNextSealDevKey = false;
          sealDevKeyParked.resolve();
          await releaseSealDevKey.promise;
        }
        return sealDevKeyWrap(s, vk, dk, uid, vkid);
      },
      recovery: {
        ...detRecovery,
        deriveRecoveryLookupHash: (s, norm) => {
          const out = detRecovery.deriveRecoveryLookupHash(s, norm);
          if (pauseNextLookupHash) {
            pauseNextLookupHash = false;
            lookupHashParked.resolve();
          }
          return out;
        },
      },
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    // Establish startMode and ensure Worker instance is spawned (`ensureWorker` via initial lock or startMode setup)
    if (startMode === 'locked') {
      const initGen = client.captureGeneration();
      await client.unlockRecovery({
        recoveryKey: shared.rk0.display,
        opGeneration: initGen,
      });
      await client.lock();
    } else if (startMode === 'pending-continuation') {
      const g = client.captureGeneration();
      await client.unlockRecovery({
        recoveryKey: shared.rk0.display,
        opGeneration: g,
      });
      expect(client.getState()).toBe('locked');
      expect(shim.core.getStateSnapshot().hasPendingContinuation).toBe(true);
    } else if (startMode === 'recovering' || startMode === 'recovering-after-rewrap') {
      const g = client.captureGeneration();
      await client.unlockRecovery({
        recoveryKey: shared.rk0.display,
        opGeneration: g,
      });
      await client.resumeRecovery({
        wrap: shared.rk0.wrap,
        privateKeysWrapped: shared.privateKeysWrapped,
        opGeneration: g,
      });
      if (startMode === 'recovering-after-rewrap') {
        await client.rewrap({
          passphrase: 'rewrapped-in-recovering',
          currentKdf: shared.kdf,
          opGeneration: g,
        });
      }
      expect(client.getState()).toBe('recovering');
      expect(shim.core.getState()).toBe('recovering');
    } else if (startMode === 'unlocked') {
      const g = client.captureGeneration();
      await client.unlockPassphrase({
        passphrase: 'matrix-baseline-passphrase',
        kdf: shared.kdf,
        vaultKeyWrappedByKek: shared.vaultKeyWrappedByKek,
        privateKeysWrapped: shared.privateKeysWrapped,
        opGeneration: g,
      });
      expect(client.getState()).toBe('unlocked');
      expect(shim.core.getState()).toBe('unlocked');
    } else {
      expect(client.getState()).toBe('locked');
      expect(shim.core.getState()).toBe('locked');
    }

    trackedTempAllocs.length = 0;

    // Helper to invoke the target command with captured generation `opGen`
    let beforePostGate = false;
    const beforePostParked = Promise.withResolvers<void>();
    const releaseBeforePost = Promise.withResolvers<void>();

    const invokeCommand = (opGen: number): Promise<unknown> => {
      const beforePostMessage = beforePostGate
        ? async () => {
            beforePostGate = false;
            beforePostParked.resolve();
            await releaseBeforePost.promise;
          }
        : undefined;

      switch (command) {
        case 'createVault': {
          const buf = new Uint8Array(utf8Encoder.encode('cmd-create-passphrase'));
          trackedTempAllocs.push(buf);
          return client.createVault({
            passphrase: buf,
            skipRecoveryKeys: true,
            opGeneration: opGen,
            beforePostMessage,
          });
        }
        case 'unlockPassphrase': {
          const buf = new Uint8Array(utf8Encoder.encode('matrix-baseline-passphrase'));
          trackedTempAllocs.push(buf);
          return client.unlockPassphrase({
            passphrase: buf,
            kdf: shared.kdf,
            vaultKeyWrappedByKek: shared.vaultKeyWrappedByKek,
            privateKeysWrapped: shared.privateKeysWrapped,
            opGeneration: opGen,
            beforePostMessage,
          });
        }
        case 'unlockRecovery': {
          const buf = new Uint8Array(utf8Encoder.encode(shared.rk1.display));
          trackedTempAllocs.push(buf);
          return client.unlockRecovery({
            recoveryKey: buf,
            opGeneration: opGen,
            beforePostMessage,
          });
        }
        case 'resumeRecovery':
          return client.resumeRecovery({
            wrap: shared.rk0.wrap,
            privateKeysWrapped: shared.privateKeysWrapped,
            opGeneration: opGen,
            beforePostMessage,
          });
        case 'confirmRecovery':
          return client.confirmRecovery({
            opGeneration: opGen,
            beforePostMessage,
          });
        case 'unlockPrf': {
          const buf = new Uint8Array(shared.pwk);
          trackedTempAllocs.push(buf);
          return client.unlockPrf({
            pwk: buf,
            vkWrap: shared.vkWrap,
            privateKeysWrapped: shared.privateKeysWrapped,
            opGeneration: opGen,
            beforePostMessage,
          });
        }
        case 'unlockDevKey':
          return client.unlockDevKey({
            devKey: shared.devKey,
            wrappedVk: shared.wrappedVk,
            userId: shared.userId,
            vaultKeyId: shared.vaultKeyId,
            privateKeysWrapped: shared.privateKeysWrapped,
            opGeneration: opGen,
            beforePostMessage,
          });
        case 'rewrap': {
          const buf = new Uint8Array(utf8Encoder.encode('cmd-rewrap-passphrase'));
          trackedTempAllocs.push(buf);
          return client.rewrap({
            passphrase: buf,
            currentKdf: shared.kdf,
            opGeneration: opGen,
            beforePostMessage,
          });
        }
        case 'makeRecoveryKeys':
          return client.makeRecoveryKeys({
            slots: [1],
            opGeneration: opGen,
            beforePostMessage,
          });
        case 'wrapForPasskey': {
          const buf = new Uint8Array(shared.pwk);
          trackedTempAllocs.push(buf);
          return client.wrapForPasskey({
            pwk: buf,
            opGeneration: opGen,
            beforePostMessage,
          });
        }
        case 'wrapForDevice':
          return client.wrapForDevice({
            devKey: shared.devKey,
            userId: shared.userId,
            vaultKeyId: shared.vaultKeyId,
            opGeneration: opGen,
            beforePostMessage,
          });
        case 'sealEntry': {
          const buf = new Uint8Array(utf8Encoder.encode('cmd-seal-entry-bytes'));
          return client.sealEntry({
            entryId: shared.entryId,
            keyId: shared.vaultKeyId,
            plaintext: buf,
            opGeneration: opGen,
            beforePostMessage,
          });
        }
        case 'openEntry':
          return client.openEntry({
            entryId: shared.entryId,
            envelope: shared.sealedEntry.envelope,
            ciphertext: shared.sealedEntry.ciphertext,
            opGeneration: opGen,
            beforePostMessage,
          });
        case 'lock':
          return client.lock();
      }
    };

    // Helper to execute the modeChange at the current generation
    const runModeChange = async (): Promise<void> => {
      switch (modeChange) {
        case 'lock': {
          await client.lock();
          return;
        }
        case 'enterRecovering': {
          const g = client.captureGeneration();
          await client.unlockRecovery({
            recoveryKey: shared.rk0.display,
            opGeneration: g,
          });
          await client.resumeRecovery({
            wrap: shared.rk0.wrap,
            privateKeysWrapped: shared.privateKeysWrapped,
            opGeneration: g,
          });
          return;
        }
        case 'confirmRecovery': {
          const g = client.captureGeneration();
          await client.confirmRecovery({ opGeneration: g });
          return;
        }
        case 'ordinaryUnlock': {
          const g = client.captureGeneration();
          await client.unlockPrf({
            pwk: new Uint8Array(shared.pwk),
            vkWrap: shared.vkWrap,
            privateKeysWrapped: shared.privateKeysWrapped,
            opGeneration: g,
          });
          return;
        }
      }
    };

    const expectedTargetModeAfterChange = (): 'locked' | 'recovering' | 'unlocked' => {
      switch (modeChange) {
        case 'lock':
          return 'locked';
        case 'enterRecovering':
          return 'recovering';
        case 'confirmRecovery':
        case 'ordinaryUnlock':
          return 'unlocked';
      }
    };

    if (timing === 'issued-before-paused') {
      const startGen = client.captureGeneration();
      // Configure deterministic pause at the command's last await (or beforePostMessage for sync-worker commands)
      let releasePausedCommand: (() => void) | null = null;
      let waitForCommandPause: Promise<void> = Promise.resolve();

      const canPauseInsideWorker =
        command === 'createVault' ||
        command === 'unlockPassphrase' ||
        (command === 'rewrap' &&
          (startMode === 'recovering' ||
            startMode === 'recovering-after-rewrap' ||
            startMode === 'unlocked')) ||
        (command === 'wrapForDevice' && startMode === 'unlocked') ||
        (command === 'unlockDevKey' &&
          startMode !== 'recovering' &&
          startMode !== 'recovering-after-rewrap');

      let decryptSpy: MockInstance | null = null;
      if (canPauseInsideWorker) {
        if (command === 'createVault' || command === 'unlockPassphrase' || command === 'rewrap') {
          pauseNextDerive = true;
          waitForCommandPause = deriveParked.promise;
          releasePausedCommand = () => releaseDerive.resolve();
        } else if (command === 'wrapForDevice') {
          pauseNextSealDevKey = true;
          waitForCommandPause = sealDevKeyParked.promise;
          releasePausedCommand = () => releaseSealDevKey.resolve();
        } else if (command === 'unlockDevKey') {
          const decParked = Promise.withResolvers<void>();
          const decRelease = Promise.withResolvers<void>();
          const origDec = crypto.subtle.decrypt.bind(crypto.subtle);
          decryptSpy = vi
            .spyOn(crypto.subtle, 'decrypt')
            .mockImplementationOnce(async (alg, key, data) => {
              const out = await origDec(alg, key, data);
              const u8 = new Uint8Array(out);
              trackedTempAllocs.push(u8);
              decParked.resolve();
              await decRelease.promise;
              return u8.buffer;
            });
          waitForCommandPause = decParked.promise;
          releasePausedCommand = () => decRelease.resolve();
        }
      } else if (command !== 'lock') {
        beforePostGate = true;
        waitForCommandPause = beforePostParked.promise;
        releasePausedCommand = () => releaseBeforePost.resolve();
      }

      try {
        const cmdPromise = invokeCommand(startGen);
        await waitForCommandPause;
        const [changeSettlement] = await Promise.allSettled([runModeChange()]);
        releasePausedCommand?.();
        const [settlement] = await Promise.allSettled([cmdPromise]);

        if (command === 'lock') {
          expect(settlement.status).toBe('fulfilled');
          if (modeChange === 'confirmRecovery') {
            // lock ran before confirmRecovery -> confirmRecovery rejects with VAULT_LOCKED and vault stays locked
            expect(changeSettlement.status).toBe('rejected');
            expect(client.getState()).toBe('locked');
            expect(shim.core.getState()).toBe('locked');
          }
        } else {
          expect(changeSettlement.status).toBe('fulfilled');
          const targetAfterChange = expectedTargetModeAfterChange();
          if (modeChange === 'lock') {
            expect(settlement.status).toBe('rejected');
            if (settlement.status === 'rejected') {
              expect(readErrorCode(settlement.reason)).toBe('STALE_GENERATION');
            }
            expect(client.getState()).toBe('locked');
            expect(shim.core.getState()).toBe('locked');
          } else if (modeChange === 'enterRecovering') {
            if (canPauseInsideWorker) {
              expect(settlement.status).toBe('rejected');
              if (settlement.status === 'rejected') {
                expect(readErrorCode(settlement.reason)).toMatch(
                  /^(VAULT_RECOVERING|STALE_GENERATION)$/,
                );
              }
              expect(client.getState()).toBe('recovering');
              expect(shim.core.getState()).toBe('recovering');
            } else {
              // Issued after beforePostMessage released (while already in recovering)
              if (command === 'rewrap') {
                expect(settlement.status).toBe('fulfilled');
                expect(client.getState()).toBe('recovering');
                expect(shim.core.getState()).toBe('recovering');
              } else if (command === 'confirmRecovery') {
                expect(settlement.status).toBe('fulfilled');
                expect(client.getState()).toBe('unlocked');
                expect(shim.core.getState()).toBe('unlocked');
              } else {
                expect(settlement.status).toBe('rejected');
                if (settlement.status === 'rejected') {
                  expect(readErrorCode(settlement.reason)).toBe('VAULT_RECOVERING');
                }
                expect(client.getState()).toBe('recovering');
                expect(shim.core.getState()).toBe('recovering');
              }
            }
          } else if (canPauseInsideWorker) {
            // Paused inside Worker across confirmRecovery or ordinaryUnlock -> epoch/mode changed -> STALE_GENERATION
            expect(settlement.status).toBe('rejected');
            if (settlement.status === 'rejected') {
              expect(readErrorCode(settlement.reason)).toBe('STALE_GENERATION');
            }
            expect(client.getState()).toBe(targetAfterChange);
            expect(shim.core.getState()).toBe(targetAfterChange);
          }
        }
      } finally {
        decryptSpy?.mockRestore();
      }
    } else if (timing === 'issued-during') {
      const startGen = client.captureGeneration();
      let changePromise: Promise<void>;
      let cmdPromise: Promise<unknown>;

      if (modeChange === 'enterRecovering') {
        // Deterministically issue the command BETWEEN step 1 (lookup-only unlockRecovery) and step 2 (resumeRecovery)
        // or right after enterRecovering starts so the command is genuinely issued during the recovery flow.
        pauseNextLookupHash = true;
        const g = client.captureGeneration();
        const lookupP = client.unlockRecovery({
          recoveryKey: shared.rk0.display,
          opGeneration: g,
        });
        await lookupHashParked.promise;
        await lookupP;
        const resumeP = client.resumeRecovery({
          wrap: shared.rk0.wrap,
          privateKeysWrapped: shared.privateKeysWrapped,
          opGeneration: g,
        });
        cmdPromise = invokeCommand(startGen);
        changePromise = resumeP.then(() => undefined);
        void releaseLookupHash;
      } else {
        changePromise = runModeChange();
        cmdPromise = invokeCommand(startGen);
      }

      const [, settlement] = await Promise.allSettled([changePromise, cmdPromise]);

      if (command === 'lock') {
        expect(settlement.status).toBe('fulfilled');
        expect(client.getState()).toBe('locked');
        expect(shim.core.getState()).toBe('locked');
      } else if (modeChange === 'lock') {
        expect(settlement.status).toBe('rejected');
        if (settlement.status === 'rejected') {
          expect(readErrorCode(settlement.reason)).toBe('STALE_GENERATION');
        }
        expect(client.getState()).toBe('locked');
        expect(shim.core.getState()).toBe('locked');
      } else if (modeChange === 'enterRecovering') {
        // Because resumeRecovery was dispatched just before invokeCommand(startGen),
        // Worker is in 'recovering' when invokeCommand arrives.
        // Only confirmRecovery may unlock it; rewrap stays recovering; all other commands reject with VAULT_RECOVERING!
        if (command === 'confirmRecovery') {
          expect(settlement.status).toBe('fulfilled');
          expect(client.getState()).toBe('unlocked');
          expect(shim.core.getState()).toBe('unlocked');
        } else if (command === 'rewrap') {
          expect(settlement.status).toBe('fulfilled');
          expect(client.getState()).toBe('recovering');
          expect(shim.core.getState()).toBe('recovering');
        } else {
          expect(settlement.status).toBe('rejected');
          if (settlement.status === 'rejected') {
            expect(readErrorCode(settlement.reason)).toBe('VAULT_RECOVERING');
          }
          expect(client.getState()).toBe('recovering');
          expect(shim.core.getState()).toBe('recovering');
        }
      }
    } else {
      // timing === 'issued-after'
      await runModeChange();
      const postChangeMode = expectedTargetModeAfterChange();
      const postChangeGen = client.captureGeneration();
      const [settlement] = await Promise.allSettled([invokeCommand(postChangeGen)]);

      if (command === 'lock') {
        expect(settlement.status).toBe('fulfilled');
        expect(client.getState()).toBe('locked');
        expect(shim.core.getState()).toBe('locked');
      } else if (postChangeMode === 'locked') {
        if (
          command === 'createVault' ||
          command === 'unlockPassphrase' ||
          command === 'unlockPrf' ||
          command === 'unlockDevKey'
        ) {
          expect(settlement.status).toBe('fulfilled');
          expect(client.getState()).toBe('unlocked');
          expect(shim.core.getState()).toBe('unlocked');
        } else if (command === 'unlockRecovery') {
          expect(settlement.status).toBe('fulfilled');
          expect(client.getState()).toBe('locked');
          expect(shim.core.getState()).toBe('locked');
        } else if (command === 'resumeRecovery') {
          expect(settlement.status).toBe('rejected');
          if (settlement.status === 'rejected') {
            expect(readErrorCode(settlement.reason)).toBe(
              'RECOVERY_CONTINUATION_MISSING',
            );
          }
          expect(client.getState()).toBe('locked');
          expect(shim.core.getState()).toBe('locked');
        } else {
          expect(settlement.status).toBe('rejected');
          if (settlement.status === 'rejected') {
            expect(readErrorCode(settlement.reason)).toBe('VAULT_LOCKED');
          }
          expect(client.getState()).toBe('locked');
          expect(shim.core.getState()).toBe('locked');
        }
      } else if (postChangeMode === 'recovering') {
        if (command === 'rewrap') {
          expect(settlement.status).toBe('fulfilled');
          expect(client.getState()).toBe('recovering');
          expect(shim.core.getState()).toBe('recovering');
        } else if (command === 'confirmRecovery') {
          expect(settlement.status).toBe('fulfilled');
          expect(client.getState()).toBe('unlocked');
          expect(shim.core.getState()).toBe('unlocked');
        } else {
          expect(settlement.status).toBe('rejected');
          if (settlement.status === 'rejected') {
            expect(readErrorCode(settlement.reason)).toBe('VAULT_RECOVERING');
          }
          expect(client.getState()).toBe('recovering');
          expect(shim.core.getState()).toBe('recovering');
        }
      } else if (postChangeMode === 'unlocked') {
        if (command === 'confirmRecovery') {
          expect(settlement.status).toBe('rejected');
          if (settlement.status === 'rejected') {
            expect(readErrorCode(settlement.reason)).toBe('VAULT_NOT_RECOVERING');
          }
          expect(client.getState()).toBe('unlocked');
          expect(shim.core.getState()).toBe('unlocked');
        } else if (command === 'resumeRecovery') {
          expect(settlement.status).toBe('rejected');
          if (settlement.status === 'rejected') {
            expect(readErrorCode(settlement.reason)).toBe(
              'RECOVERY_CONTINUATION_MISSING',
            );
          }
          expect(client.getState()).toBe('unlocked');
          expect(shim.core.getState()).toBe('unlocked');
        } else {
          expect(settlement.status).toBe('fulfilled');
          expect(client.getState()).toBe('unlocked');
          expect(shim.core.getState()).toBe('unlocked');
        }
      }
    }

    // Universal post-conditions on every matrix cell:
    // 1. Client and Worker (mode, generation) agree
    expect(client.getState()).toBe(shim.core.getState());
    expect(client.getGeneration()).toBe(shim.core.getGeneration());

    // 2. All temporary secret/derived allocations tracked during the command are zeroed
    for (const alloc of trackedTempAllocs) {
      if (alloc.byteLength > 0) {
        expect(alloc.every((b) => b === 0)).toBe(true);
      }
    }

    // 3. Entry accessibility matches the final mode
    const finalMode = client.getState();
    const checkGen = client.captureGeneration();
    if (finalMode === 'locked') {
      await expect(
        client.openEntry({
          entryId: shared.entryId,
          envelope: shared.sealedEntry.envelope,
          ciphertext: shared.sealedEntry.ciphertext,
          opGeneration: checkGen,
        }),
      ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
    } else if (finalMode === 'recovering') {
      await expect(
        client.openEntry({
          entryId: shared.entryId,
          envelope: shared.sealedEntry.envelope,
          ciphertext: shared.sealedEntry.ciphertext,
          opGeneration: checkGen,
        }),
      ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });
    } else if (finalMode === 'unlocked') {
      // Only check shared.sealedEntry if the vault wasn't replaced by createVault with a brand-new random VK
      const currentVk = shim.core.inspectClosureVkForTest()!;
      expect(currentVk).not.toBeNull();
      if (shared.sodium.memcmp(currentVk, shared.originalVk)) {
        const opened = await client.openEntry({
          entryId: shared.entryId,
          envelope: shared.sealedEntry.envelope,
          ciphertext: shared.sealedEntry.ciphertext,
          opGeneration: checkGen,
        });
        expect(opened.plaintext).toBe('matrix-entry-secret-payload');
      }
    }
  });
});
