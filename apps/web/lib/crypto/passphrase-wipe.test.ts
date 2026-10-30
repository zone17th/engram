import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CryptoClient } from './client';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from './kdf';
import type { Sodium } from './sodium';
import { createWorkerShim, type ShimmedWorkerInstance } from './test/worker-shim';

// P03-T5 r6 fix-5b (BE6-1 = FE6-1, T-r6-1 M4f / M4g): the Worker-normalized passphrase KDF buffer is its OWN
// allocation (`passphraseToKdfBytes` encodes into a new Uint8Array), so zeroing the received buffer never zeroes
// it. These tests retain the exact allocation `passphraseToKdfBytes` returns (it is the object `deriveKek` hands
// to the KDF hook, and it is produced by `TextEncoder.encode`) and assert it is all zero after every exit of
// createVault / unlockPassphrase / rewrap, and that rewrap does no normalization work before its locked check.

const probe = vi.hoisted(() => ({
  attempts: 0,
  buffers: [] as Uint8Array[],
  birthHex: [] as string[],
}));

vi.mock('./passphrase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./passphrase')>();
  return {
    ...actual,
    passphraseToKdfBytes: (incoming: Uint8Array): Uint8Array => {
      probe.attempts += 1;
      const out = actual.passphraseToKdfBytes(incoming);
      probe.buffers.push(out);
      probe.birthHex.push(Buffer.from(out).toString('hex'));
      return out;
    },
  };
});

const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const isZero = (b: Uint8Array): boolean => b.every((x) => x === 0);
/** Same bytes in memory (the KDF hook may see a view onto the allocation when the realms' Uint8Array differ). */
const sameMemory = (a: Uint8Array, b: Uint8Array): boolean =>
  a.buffer === b.buffer && a.byteOffset === b.byteOffset && a.byteLength === b.byteLength;

const VI_NFC = 'Mật khẩu';
const VI_NFD = VI_NFC.normalize('NFD');
const NFC_HEX = hex(enc.encode(VI_NFC));

/** Mutable KDF hook: records every buffer (the actual object, not a copy) and can be told to fail. */
const kdf = {
  calls: 0,
  received: [] as Uint8Array[],
  failWith: null as unknown,
};
const derive: DeriveKekFn = (sodium: Sodium, pass: Uint8Array, p: ValidatedKdfParams) => {
  kdf.calls += 1;
  kdf.received.push(pass);
  if (kdf.failWith) throw kdf.failWith;
  const input = new Uint8Array(pass.byteLength + p.saltBytes.byteLength);
  input.set(pass, 0);
  input.set(p.saltBytes, pass.byteLength);
  return sodium.crypto_generichash(KEK_BYTES, input, null, 'uint8array');
};

function resetProbe(): void {
  probe.attempts = 0;
  probe.buffers.length = 0;
  probe.birthHex.length = 0;
  kdf.calls = 0;
  kdf.received.length = 0;
  kdf.failWith = null;
}

type StartMode = 'locked' | 'unlocked' | 'recovering';

describe('P03-T5 normalized passphrase KDF buffer is zeroed on every path (BE6-1, FE6-1)', () => {
  const shims: ShimmedWorkerInstance[] = [];
  const clients: CryptoClient[] = [];

  beforeEach(() => resetProbe());
  afterEach(() => {
    vi.restoreAllMocks();
    while (clients.length > 0) clients.pop()?.terminate();
    while (shims.length > 0) shims.pop()?.close();
  });

  function makeClient() {
    const shim = createWorkerShim({ deriveKek: derive });
    shims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });
    clients.push(client);
    return { shim, client };
  }

  /** Brings a fresh client to `mode`; the vault passphrase is VI_NFD (so NFC normalization is observable). */
  async function bootstrap(mode: StartMode) {
    const { shim, client } = makeClient();
    const created = await client.createVault({
      passphrase: VI_NFD,
      skipRecoveryKeys: mode !== 'recovering',
      opGeneration: client.captureGeneration(),
    });
    if (mode === 'unlocked') {
      resetProbe();
      return { shim, client, created };
    }
    await client.lock();
    if (mode === 'recovering') {
      const rk = created.recovery_keys[0]!;
      const gen = client.captureGeneration();
      await client.unlockRecovery({ recoveryKey: rk.display, opGeneration: gen });
      await client.resumeRecovery({
        wrap: rk.wrap,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: gen,
      });
      expect(client.getState()).toBe('recovering');
    }
    resetProbe();
    return { shim, client, created };
  }

  type Ctx = Awaited<ReturnType<typeof bootstrap>>;

  interface PathCase {
    name: string;
    start: StartMode;
    run: (ctx: Ctx, passphrase: string, currentKdf?: unknown) => Promise<unknown>;
  }

  const PATHS: PathCase[] = [
    {
      name: 'createVault',
      start: 'locked',
      run: ({ client }, passphrase) =>
        client.createVault({
          passphrase,
          skipRecoveryKeys: true,
          opGeneration: client.captureGeneration(),
        }),
    },
    {
      name: 'unlockPassphrase',
      start: 'locked',
      run: ({ client, created }, passphrase, kdfParams) =>
        client.unlockPassphrase({
          passphrase,
          kdf: (kdfParams ?? created.kdf) as typeof created.kdf,
          vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
          privateKeysWrapped: created.private_keys_wrapped,
          opGeneration: client.captureGeneration(),
        }),
    },
    {
      name: 'rewrap (unlocked)',
      start: 'unlocked',
      run: ({ client, created }, passphrase, kdfParams) =>
        client.rewrap({
          passphrase,
          currentKdf: kdfParams ?? created.kdf,
          opGeneration: client.captureGeneration(),
        }),
    },
    {
      name: 'rewrap (recovering)',
      start: 'recovering',
      run: ({ client, created }, passphrase, kdfParams) =>
        client.rewrap({
          passphrase,
          currentKdf: kdfParams ?? created.kdf,
          opGeneration: client.captureGeneration(),
        }),
    },
  ];

  /**
   * Exactly one normalized buffer was allocated, it held the NFC bytes when it was born (so "zero now" is a real
   * wipe, not an empty or never-filled buffer), and it is all zero now. `reachedKdf` also pins that the very object
   * `deriveKek` received is that allocation and was produced by `TextEncoder.encode`.
   */
  function expectNormalizedBufferWiped(label: string, reachedKdf: boolean): void {
    expect(probe.attempts, `${label}: one normalization`).toBe(1);
    expect(probe.buffers, `${label}: one retained allocation`).toHaveLength(1);
    const buf = probe.buffers[0]!;
    expect(probe.birthHex[0], `${label}: born holding the NFC bytes`).toBe(NFC_HEX);
    expect(buf.byteLength, `${label}: length`).toBeGreaterThan(0);
    expect(isZero(buf), `${label}: normalized KDF buffer zeroed`).toBe(true);
    if (reachedKdf) {
      expect(kdf.received, `${label}: one KDF call`).toHaveLength(1);
      expect(sameMemory(kdf.received[0]!, buf), `${label}: the KDF received the allocation itself`).toBe(
        true,
      );
    } else {
      expect(kdf.calls, `${label}: KDF not reached`).toBe(0);
    }
  }

  for (const path of PATHS) {
    describe(path.name, () => {
      it('success: the normalized buffer the KDF received is zero afterwards', async () => {
        const ctx = await bootstrap(path.start);
        await path.run(ctx, VI_NFD);
        expectNormalizedBufferWiped(`${path.name} success`, true);
      });

      it('KDF derive failure: the normalized buffer is zero afterwards', async () => {
        const ctx = await bootstrap(path.start);
        kdf.failWith = new Error('simulated derive failure');
        await expect(path.run(ctx, VI_NFD)).rejects.toMatchObject({ code: 'KDF_DERIVE_FAILED' });
        expectNormalizedBufferWiped(`${path.name} derive failure`, true);
      });

      it('KDF allocation failure: the normalized buffer is zero afterwards', async () => {
        const ctx = await bootstrap(path.start);
        kdf.failWith = new RangeError('simulated Argon2id allocation failure');
        await expect(path.run(ctx, VI_NFD)).rejects.toMatchObject({
          code: 'KDF_ALLOCATION_FAILED',
        });
        expectNormalizedBufferWiped(`${path.name} allocation failure`, true);
      });

      if (path.name !== 'createVault') {
        it('invalid KDF params (rejected after normalization, before the KDF runs): the normalized buffer is zero afterwards', async () => {
          const ctx = await bootstrap(path.start);
          await expect(path.run(ctx, VI_NFD, { alg: 'argon2id13' })).rejects.toMatchObject({
            code: 'KDF_PARAMS_INVALID',
          });
          expectNormalizedBufferWiped(`${path.name} invalid params`, false);
        });
      }
    });
  }

  it('unlockPassphrase with the wrong passphrase (AEAD failure after the KDF): the normalized buffer is zero afterwards', async () => {
    const ctx = await bootstrap('locked');
    await expect(PATHS[1]!.run(ctx, `${VI_NFD}!`)).rejects.toMatchObject({
      code: 'AEAD_DECRYPT_FAILED',
    });
    expect(probe.buffers).toHaveLength(1);
    expect(probe.birthHex[0]).toBe(hex(enc.encode(`${VI_NFC}!`)));
    expect(isZero(probe.buffers[0]!)).toBe(true);
  });

  it('the KDF input is the TextEncoder allocation itself (retained at the producing call), zeroed after rewrap success and failure', async () => {
    const encoded: Uint8Array[] = [];
    const realEncode = TextEncoder.prototype.encode;
    vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
      this: TextEncoder,
      input?: string,
    ) {
      const out = realEncode.call(this, input);
      encoded.push(out);
      return out;
    });
    const ctx = await bootstrap('unlocked');
    encoded.length = 0;

    await PATHS[2]!.run(ctx, VI_NFD);
    expect(kdf.received).toHaveLength(1);
    expect(encoded.some((e) => sameMemory(e, kdf.received[0]!))).toBe(true);
    expect(isZero(kdf.received[0]!)).toBe(true);

    kdf.failWith = new Error('simulated derive failure');
    await expect(PATHS[2]!.run(ctx, VI_NFD)).rejects.toMatchObject({ code: 'KDF_DERIVE_FAILED' });
    expect(kdf.received).toHaveLength(2);
    expect(encoded.some((e) => sameMemory(e, kdf.received[1]!))).toBe(true);
    expect(isZero(kdf.received[1]!)).toBe(true);
  });

  describe('rewrap: locked / stale / precedence rejections do no normalization or KDF work (M4g)', () => {
    // Bytes that would be PASSPHRASE_INVALID if the Worker normalized (decoded) them first.
    const invalidUtf8 = () => Uint8Array.of(0x73, 0x65, 0x63, 0xc3, 0x28, 0x72, 0x65, 0x74);
    const validBytes = () => enc.encode(VI_NFD);

    function spyNormalize() {
      return vi.spyOn(String.prototype, 'normalize');
    }

    function expectNoNormalizationWork(
      shim: ShimmedWorkerInstance,
      normalizeSpy: { mock: { calls: unknown[] } },
      label: string,
    ): void {
      expect(probe.attempts, `${label}: passphraseToKdfBytes not called`).toBe(0);
      expect(probe.buffers, `${label}: nothing allocated`).toHaveLength(0);
      expect(normalizeSpy.mock.calls, `${label}: String.prototype.normalize not called`).toHaveLength(0);
      expect(kdf.calls, `${label}: deriveKek not called`).toBe(0);
      // the Worker still wiped the passphrase bytes it received
      const received = shim.workerReceivedRequests.filter((m) => m.type === 'rewrap');
      expect(received.length, `${label}: request reached the Worker`).toBeGreaterThan(0);
      for (const m of received) {
        const buf = new Uint8Array((m as unknown as { passphraseBuffer: ArrayBuffer }).passphraseBuffer);
        expect(isZero(buf), `${label}: received passphrase wiped`).toBe(true);
      }
    }

    for (const [inputName, makeInput] of [
      ['invalid UTF-8', invalidUtf8],
      ['valid NFD', validBytes],
    ] as const) {
      it(`a never-unlocked (locked) Worker rejects VAULT_LOCKED for ${inputName}`, async () => {
        const { shim, client } = makeClient();
        const g = client.captureGeneration();
        const normalizeSpy = spyNormalize();
        await expect(
          client.rewrap({
            passphrase: makeInput(),
            currentKdf: { alg: 'argon2id13' },
            opGeneration: g,
          }),
        ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
        expectNoNormalizationWork(shim, normalizeSpy, 'never-unlocked');
      });

      it(`a vault locked after use rejects VAULT_LOCKED for ${inputName}`, async () => {
        const { shim, client, created } = await bootstrap('unlocked');
        await client.lock();
        resetProbe();
        const normalizeSpy = spyNormalize();
        await expect(
          client.rewrap({
            passphrase: makeInput(),
            currentKdf: created.kdf,
            opGeneration: client.captureGeneration(),
          }),
        ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
        expectNoNormalizationWork(shim, normalizeSpy, 'locked-after-use');
      });

      it(`a locked Worker with a pending recovery lookup rejects VAULT_LOCKED for ${inputName}`, async () => {
        const { shim, client, created } = await bootstrap('recovering');
        await client.lock();
        const rk = created.recovery_keys[0]!;
        await client.unlockRecovery({
          recoveryKey: rk.display,
          opGeneration: client.captureGeneration(),
        });
        expect(client.getState()).toBe('locked');
        resetProbe();
        const normalizeSpy = spyNormalize();
        await expect(
          client.rewrap({
            passphrase: makeInput(),
            currentKdf: created.kdf,
            opGeneration: client.captureGeneration(),
          }),
        ).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
        expectNoNormalizationWork(shim, normalizeSpy, 'pending-continuation');
      });

      it(`a stale-generation Worker request rejects STALE_GENERATION for ${inputName} (raw message, Worker level)`, async () => {
        const { shim, client, created } = await bootstrap('unlocked');
        const staleGen = client.captureGeneration();
        await client.lock();
        resetProbe();
        const normalizeSpy = spyNormalize();
        const passphraseBuffer = makeInput().slice().buffer as ArrayBuffer;
        const reply = await shim.core.handleMessage({
          type: 'rewrap',
          id: 987_654,
          generation: staleGen,
          passphraseBuffer,
          currentKdf: created.kdf,
        } as unknown as Parameters<typeof shim.core.handleMessage>[0]);
        expect(reply.ok).toBe(false);
        expect((reply as { error: { code: string } }).error.code).toBe('STALE_GENERATION');
        expect(probe.attempts).toBe(0);
        expect(normalizeSpy.mock.calls).toHaveLength(0);
        expect(kdf.calls).toBe(0);
        expect(isZero(new Uint8Array(passphraseBuffer))).toBe(true);
      });
    }

    it('control: the same invalid UTF-8 bytes on an UNLOCKED vault do reach normalization and give PASSPHRASE_INVALID (the check is not vacuous)', async () => {
      const { client, created } = await bootstrap('unlocked');
      await expect(
        client.rewrap({
          passphrase: invalidUtf8(),
          currentKdf: created.kdf,
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'PASSPHRASE_INVALID' });
      expect(probe.attempts).toBe(1);
      expect(kdf.calls).toBe(0);
    });
  });
});
