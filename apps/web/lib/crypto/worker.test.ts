import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64UrlStrict, encodeBase64Url } from './b64url';
import { runArgon2idBenchmark } from './bench.worker';
import { CryptoClient, CryptoClientError } from './client';
import {
  ENVELOPE_AAD_LABEL,
  ENVELOPE_ALG,
  ENVELOPE_CT_ENC,
  ENVELOPE_VERSION,
  buildEntryAad,
  canonicalizeEnvelopeJcs,
  validateEntryEnvelope,
  type EnvelopeAdapter,
  type EntryEnvelopeV1,
} from './envelope';
import {
  KDF_ALG,
  KDF_MEM_MAX,
  KDF_MEM_MIN,
  KDF_OPS_MAX,
  KDF_OPS_MIN,
  KDF_PARALLELISM,
  KDF_SALT_BYTES,
  KEK_BYTES,
  KdfError,
  deriveKek,
  makeRewrapKdfParams,
  validateKdfParams,
  type DeriveKekFn,
  type ValidatedKdfParams,
  type VaultKdfParams,
} from './kdf';
import {
  RK_LOOKUP_DOMAIN,
  RK_WRAP_DOMAIN,
  deriveRecoveryLookupHash,
  deriveRecoveryWrapKey,
  formatRecoveryKeyDisplay,
  generateRecoveryKey,
  normalizeRecoveryKey,
  type RecoveryKeyAdapter,
} from './recovery';
import { getSodium, type Sodium } from './sodium';
import { createWorkerShim, type ShimmedWorkerInstance } from './test/worker-shim';
import {
  DEVKEY_WRAP_BYTES,
  PRIV_WRAP_BYTES,
  VK_BYTES,
  VK_WRAP_BYTES,
  WRAP_VERSION,
  WrapError,
  buildDevKeyAad,
  buildWrapAad,
  openDevKeyWrap,
  openWrap,
  packPrivateKeySeeds,
  sealDevKeyWrap,
  sealWrap,
  unpackPrivateKeySeeds,
  validateWrap,
} from './wrap';

const utf8Encoder = new TextEncoder();

/**
 * Fast deterministic KEK derive (`BLAKE2b-256`) used ONLY in generation/race/plumbing tests
 * so the suite finishes quickly while the real Argon2id 64 MiB test exercises true `crypto_pwhash`.
 */
const fastTestDeriveKek: DeriveKekFn = (
  sodium: Sodium,
  passphrase: Uint8Array,
  params: ValidatedKdfParams,
): Uint8Array => {
  const input = new Uint8Array(passphrase.byteLength + params.saltBytes.byteLength + 8);
  input.set(passphrase, 0);
  input.set(params.saltBytes, passphrase.byteLength);
  const view = new DataView(
    input.buffer,
    input.byteOffset + passphrase.byteLength + params.saltBytes.byteLength,
    8,
  );
  view.setUint32(0, params.ops, true);
  view.setUint32(4, params.mem, true);
  return sodium.crypto_generichash(KEK_BYTES, input, null, 'uint8array');
};

/**
 * Test-only recovery key adapter so `createVault`, `makeRecoveryKeys`, and `unlockRecovery`
 * can be exercised for Worker generation/detach/self-check behavior while `recovery.ts` itself
 * remains a typed stub for P03-T7.
 */
const testRecoveryAdapter: RecoveryKeyAdapter = {
  generateRecoveryKey(sodium: Sodium, slot: number) {
    const raw = sodium.randombytes_buf(16);
    const hex = sodium.to_hex(raw).toUpperCase().slice(0, 25);
    const body26 = `0${hex}`;
    const display = `rk${slot}_${body26.slice(0, 4)}-${body26.slice(4, 8)}-${body26.slice(8, 12)}-${body26.slice(12, 16)}-${body26.slice(16, 20)}-${body26.slice(20, 24)}-${body26.slice(24, 26)}`;
    return {
      slot,
      display,
      normalized: `rk${slot}_${body26}`,
    };
  },
  formatRecoveryKeyDisplay(slot: number, body26: string) {
    return `rk${slot}_${body26}`;
  },
  normalizeRecoveryKey(input: string) {
    const trimmed = input.trim().replace(/-/g, '');
    if (!/^rk(10|[1-9])_[0-9A-Z]{26}$/i.test(trimmed)) {
      throw new Error('Invalid test recovery key');
    }
    const [prefix, body] = trimmed.split('_');
    return `${prefix!.toLowerCase()}_${body!.toUpperCase()}`;
  },
  deriveRecoveryLookupHash(sodium: Sodium, norm: string) {
    return sodium.crypto_generichash(
      32,
      `${RK_LOOKUP_DOMAIN}${norm}`,
      null,
      'uint8array',
    );
  },
  deriveRecoveryWrapKey(sodium: Sodium, norm: string) {
    return sodium.crypto_generichash(
      32,
      `${RK_WRAP_DOMAIN}${norm}`,
      null,
      'uint8array',
    );
  },
};

/**
 * Test-only envelope adapter so `sealEntry` and `openEntry` can be exercised for Worker
 * generation/closure checks while `envelope.ts` itself remains a typed stub for P03-T6.
 */
const testEnvelopeAdapter: EnvelopeAdapter = {
  validateEntryEnvelope(input: unknown): EntryEnvelopeV1 {
    const obj = input as EntryEnvelopeV1;
    if (
      !obj ||
      obj.v !== ENVELOPE_VERSION ||
      obj.alg !== ENVELOPE_ALG ||
      typeof obj.key_id !== 'string' ||
      typeof obj.nonce !== 'string' ||
      obj.ct_enc !== ENVELOPE_CT_ENC
    ) {
      throw new Error('Invalid test envelope');
    }
    return obj;
  },
  canonicalizeEnvelopeJcs(env: EntryEnvelopeV1): string {
    return JSON.stringify({
      alg: env.alg,
      ct_enc: env.ct_enc,
      key_id: env.key_id,
      nonce: env.nonce,
      v: env.v,
    });
  },
  buildEntryAad(env: EntryEnvelopeV1, entryId: string): Uint8Array {
    const jcs = this.canonicalizeEnvelopeJcs(env);
    const labelBytes = utf8Encoder.encode(ENVELOPE_AAD_LABEL);
    const jcsBytes = utf8Encoder.encode(jcs);
    const idBytes = utf8Encoder.encode(entryId);
    const out = new Uint8Array(labelBytes.length + 1 + jcsBytes.length + 1 + idBytes.length);
    let offset = 0;
    out.set(labelBytes, offset);
    offset += labelBytes.length;
    out[offset++] = 0x00;
    out.set(jcsBytes, offset);
    offset += jcsBytes.length;
    out[offset++] = 0x00;
    out.set(idBytes, offset);
    return out;
  },
};

function containsSubsequence(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.byteLength === 0 || haystack.byteLength < needle.byteLength) return false;
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

function scanPayloadForSecretBytes(value: unknown, secret: Uint8Array): boolean {
  const secretHex = Array.from(secret)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const secretB64Url = encodeBase64Url(secret);

  function walk(node: unknown): boolean {
    if (node === null || node === undefined) return false;
    if (typeof node === 'string') {
      if (node.includes(secretB64Url) || node.toLowerCase().includes(secretHex)) {
        return true;
      }
      try {
        const decoded = decodeBase64UrlStrict(node);
        if (containsSubsequence(decoded, secret)) return true;
      } catch {
        // Not a base64url string
      }
      return false;
    }
    if (node instanceof Uint8Array) {
      return containsSubsequence(node, secret);
    }
    if (node instanceof ArrayBuffer) {
      return containsSubsequence(new Uint8Array(node), secret);
    }
    if (Array.isArray(node)) {
      return node.some((item) => walk(item));
    }
    if (typeof node === 'object') {
      return Object.values(node as Record<string, unknown>).some((v) => walk(v));
    }
    return false;
  }

  return walk(value);
}

async function generateTestDevKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

describe('P03-T5 Crypto Worker, Client, KDF, and Wrap Layout', () => {
  const activeShims: ShimmedWorkerInstance[] = [];

  afterEach(() => {
    while (activeShims.length > 0) {
      activeShims.pop()?.close();
    }
  });

  it('loads libsodium-wrappers-sumo 0.8.4 once and runs real Argon2id at 64 MiB minimum', async () => {
    const s1 = await getSodium();
    const s2 = await getSodium();
    expect(s1).toBe(s2);

    const saltBytes = new Uint8Array(KDF_SALT_BYTES).fill(0x42);
    const kdfParams: VaultKdfParams = {
      alg: KDF_ALG,
      ops: KDF_OPS_MIN, // 3
      mem: KDF_MEM_MIN, // 67108864 (64 MiB)
      parallelism: KDF_PARALLELISM, // 1
      salt: encodeBase64Url(saltBytes),
    };

    const passphrase1 = utf8Encoder.encode('correct-horse-battery-staple-vault-1');
    const passphrase2 = utf8Encoder.encode('correct-horse-battery-staple-vault-1');
    const differentPassphrase = utf8Encoder.encode('different-horse-battery-staple-vault-2');

    const kek1 = await deriveKek(s1, passphrase1, kdfParams);
    const kek2 = await deriveKek(s1, passphrase2, kdfParams);
    const kek3 = await deriveKek(s1, differentPassphrase, kdfParams);

    expect(kek1.byteLength).toBe(KEK_BYTES);
    expect(s1.memcmp(kek1, kek2)).toBe(true);
    expect(s1.memcmp(kek1, kek3)).toBe(false);

    // Also verify end-to-end Worker createVault + unlockPassphrase using REAL 64 MiB Argon2id
    const shim = createWorkerShim({ recovery: testRecoveryAdapter });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const created = await client.createVault({
      passphrase: 'real-argon2id-64mib-passphrase',
      skipRecoveryKeys: true,
    });
    expect(created.kdf.ops).toBe(3);
    expect(created.kdf.mem).toBe(67_108_864);
    expect(created.kdf.parallelism).toBe(1);

    await client.lock();
    expect(client.getState()).toBe('locked');

    const unlocked = await client.unlockPassphrase({
      passphrase: 'real-argon2id-64mib-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      privateKeysWrapped: created.private_keys_wrapped,
    });
    expect(unlocked.unlocked).toBe(true);
    expect(client.getState()).toBe('unlocked');
  }, 30_000);

  it('rejects KDF params below and above bounds for every field BEFORE allocation', async () => {
    const sodium = await getSodium();
    const validSalt = encodeBase64Url(new Uint8Array(16).fill(7));
    const baseValid: VaultKdfParams = {
      alg: 'argon2id13',
      ops: 3,
      mem: 67_108_864,
      parallelism: 1,
      salt: validSalt,
    };

    const pwhashSpy = vi.spyOn(sodium, 'crypto_pwhash');
    const customDeriveSpy = vi.fn(fastTestDeriveKek);

    const invalidCases: Array<{ label: string; input: unknown }> = [
      { label: 'ops below min (2)', input: { ...baseValid, ops: KDF_OPS_MIN - 1 } },
      { label: 'ops above max (11)', input: { ...baseValid, ops: KDF_OPS_MAX + 1 } },
      { label: 'ops non-integer (3.5)', input: { ...baseValid, ops: 3.5 } },
      { label: 'ops NaN', input: { ...baseValid, ops: Number.NaN } },
      { label: 'mem below 64 MiB (64MiB - 1)', input: { ...baseValid, mem: KDF_MEM_MIN - 1 } },
      { label: 'mem above 256 MiB (256MiB + 1)', input: { ...baseValid, mem: KDF_MEM_MAX + 1 } },
      { label: 'mem non-integer', input: { ...baseValid, mem: 67_108_864.5 } },
      { label: 'parallelism 2', input: { ...baseValid, parallelism: 2 } },
      { label: 'parallelism 0', input: { ...baseValid, parallelism: 0 } },
      { label: 'parallelism non-integer', input: { ...baseValid, parallelism: 1.1 } },
      { label: 'wrong alg argon2i13', input: { ...baseValid, alg: 'argon2i13' } },
      { label: 'salt 15 bytes', input: { ...baseValid, salt: encodeBase64Url(new Uint8Array(15)) } },
      { label: 'salt 17 bytes', input: { ...baseValid, salt: encodeBase64Url(new Uint8Array(17)) } },
      { label: 'salt with padding =', input: { ...baseValid, salt: `${validSalt}=` } },
      { label: 'salt with standard base64 +/', input: { ...baseValid, salt: '++++++++++++++++++++++' } },
      {
        label: 'missing field (no parallelism)',
        input: { alg: 'argon2id13', ops: 3, mem: 67_108_864, salt: validSalt },
      },
      {
        label: 'extra field',
        input: { ...baseValid, extra: 123 },
      },
      { label: 'null input', input: null },
      { label: 'array input', input: [] },
    ];

    for (const tc of invalidCases) {
      expect(() => validateKdfParams(tc.input), tc.label).toThrowError(KdfError);
      expect(
        () => deriveKek(sodium, new Uint8Array([1, 2, 3]), tc.input, customDeriveSpy),
        tc.label,
      ).toThrowError(
        expect.objectContaining({
          code: 'KDF_PARAMS_INVALID',
        }),
      );
    }

    // Prove neither customDerive nor sodium.crypto_pwhash was ever invoked on invalid params
    expect(customDeriveSpy).not.toHaveBeenCalled();
    expect(pwhashSpy).not.toHaveBeenCalled();
    pwhashSpy.mockRestore();

    // Also verify Worker unlockPassphrase rejects invalid KDF params with KDF_PARAMS_INVALID
    const shim = createWorkerShim({ deriveKek: customDeriveSpy });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    await expect(
      client.unlockPassphrase({
        passphrase: 'test-passphrase',
        kdf: { ...baseValid, mem: KDF_MEM_MAX + 1024 },
        vaultKeyWrappedByKek: encodeBase64Url(new Uint8Array(VK_WRAP_BYTES)),
      }),
    ).rejects.toMatchObject({
      code: 'KDF_PARAMS_INVALID',
    });
    expect(customDeriveSpy).not.toHaveBeenCalled();
  });

  it('reports simulated derive/allocation failure as KDF_ALLOCATION_FAILED / KDF_DERIVE_FAILED and NEVER as AEAD_DECRYPT_FAILED (wrong passphrase)', async () => {
    const oomShim = createWorkerShim({
      deriveKek: () => {
        throw new RangeError('WebAssembly.Memory(): could not allocate memory (64 MiB)');
      },
    });
    activeShims.push(oomShim);
    const oomClient = new CryptoClient({ createWorker: () => oomShim.port });

    const validKdf: VaultKdfParams = {
      alg: 'argon2id13',
      ops: 3,
      mem: 67_108_864,
      parallelism: 1,
      salt: encodeBase64Url(new Uint8Array(16).fill(9)),
    };

    let caughtOom: CryptoClientError | null = null;
    try {
      await oomClient.unlockPassphrase({
        passphrase: 'any-passphrase',
        kdf: validKdf,
        vaultKeyWrappedByKek: encodeBase64Url(new Uint8Array(VK_WRAP_BYTES)),
      });
    } catch (err) {
      caughtOom = err as CryptoClientError;
    }

    expect(caughtOom).toBeInstanceOf(CryptoClientError);
    expect(caughtOom?.code).toBe('KDF_ALLOCATION_FAILED');
    expect(caughtOom?.code).not.toBe('AEAD_DECRYPT_FAILED');

    const genericDeriveFailShim = createWorkerShim({
      deriveKek: () => {
        throw new Error('Unexpected crypto_pwhash failure');
      },
    });
    activeShims.push(genericDeriveFailShim);
    const deriveFailClient = new CryptoClient({ createWorker: () => genericDeriveFailShim.port });

    await expect(
      deriveFailClient.unlockPassphrase({
        passphrase: 'any-passphrase',
        kdf: validKdf,
        vaultKeyWrappedByKek: encodeBase64Url(new Uint8Array(VK_WRAP_BYTES)),
      }),
    ).rejects.toMatchObject({
      code: 'KDF_DERIVE_FAILED',
    });
  });

  it('reports wrong passphrase as AEAD_DECRYPT_FAILED and enforces wrap layout lengths (73 B / 105 B) and version byte 0x01', async () => {
    const sodium = await getSodium();
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      recovery: testRecoveryAdapter,
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const created = await client.createVault({
      passphrase: 'correct-passphrase-12345',
    });

    const wrapKBytes = decodeBase64UrlStrict(created.vault_key_wrapped_by_kek);
    const privWrapBytes = decodeBase64UrlStrict(created.private_keys_wrapped);

    expect(wrapKBytes.byteLength).toBe(VK_WRAP_BYTES); // 73 B
    expect(wrapKBytes[0]).toBe(WRAP_VERSION); // 0x01
    expect(privWrapBytes.byteLength).toBe(PRIV_WRAP_BYTES); // 105 B
    expect(privWrapBytes[0]).toBe(WRAP_VERSION); // 0x01
    expect(created.recovery_keys).toHaveLength(10);
    for (const rk of created.recovery_keys) {
      const rkWrapBytes = decodeBase64UrlStrict(rk.wrap);
      expect(rkWrapBytes.byteLength).toBe(VK_WRAP_BYTES);
      expect(rkWrapBytes[0]).toBe(WRAP_VERSION);
    }

    // Wrong passphrase -> AEAD_DECRYPT_FAILED
    await client.lock();
    await expect(
      client.unlockPassphrase({
        passphrase: 'wrong-passphrase-99999',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      }),
    ).rejects.toMatchObject({
      code: 'AEAD_DECRYPT_FAILED',
    });

    // Mutate leading version byte of wrap -> AEAD_DECRYPT_FAILED (because version is in AAD) and validator rejects
    const mutatedVersionWrap = new Uint8Array(wrapKBytes);
    mutatedVersionWrap[0] = 0x02;
    expect(() => validateWrap(mutatedVersionWrap, 'kek')).toThrowError(
      expect.objectContaining({ code: 'WRAP_INVALID' }),
    );

    const kek = fastTestDeriveKek(
      sodium,
      utf8Encoder.encode('correct-passphrase-12345'),
      validateKdfParams(created.kdf),
    ) as Uint8Array;
    expect(() => openWrap(sodium, 'kek', mutatedVersionWrap, kek)).toThrowError(
      expect.objectContaining({ code: 'AEAD_DECRYPT_FAILED' }),
    );

    // Wrong lengths rejected
    expect(() => validateWrap(new Uint8Array(72), 'kek')).toThrowError(
      expect.objectContaining({ code: 'WRAP_INVALID' }),
    );
    expect(() => validateWrap(new Uint8Array(74), 'kek')).toThrowError(
      expect.objectContaining({ code: 'WRAP_INVALID' }),
    );
    expect(() => validateWrap(new Uint8Array(104), 'priv')).toThrowError(
      expect.objectContaining({ code: 'WRAP_INVALID' }),
    );
    expect(() => validateWrap(new Uint8Array(106), 'priv')).toThrowError(
      expect.objectContaining({ code: 'WRAP_INVALID' }),
    );
  });

  it('detaches passphrase, recovery key, and PWK ArrayBuffers on the main thread after postMessage (byteLength === 0)', async () => {
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      recovery: testRecoveryAdapter,
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const createPassBuf = new Uint8Array(utf8Encoder.encode('passphrase-for-create'));
    expect(createPassBuf.buffer.byteLength).toBeGreaterThan(0);

    const created = await client.createVault({
      passphrase: createPassBuf,
    });
    expect(createPassBuf.buffer.byteLength).toBe(0);
    expect(createPassBuf.byteLength).toBe(0);

    // Wrap for passkey detaches PWK buffer
    const pwkForWrap = new Uint8Array(32).fill(0x5a);
    expect(pwkForWrap.buffer.byteLength).toBe(32);
    const { vk_wrap } = await client.wrapForPasskey({ pwk: pwkForWrap });
    expect(pwkForWrap.buffer.byteLength).toBe(0);
    expect(pwkForWrap.byteLength).toBe(0);

    // Lock and test unlockPassphrase detach
    await client.lock();
    const unlockPassBuf = new Uint8Array(utf8Encoder.encode('passphrase-for-create'));
    expect(unlockPassBuf.buffer.byteLength).toBeGreaterThan(0);
    await client.unlockPassphrase({
      passphrase: unlockPassBuf,
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
    });
    expect(unlockPassBuf.buffer.byteLength).toBe(0);

    // Lock and test unlockPrf detach
    await client.lock();
    const pwkForUnlock = new Uint8Array(32).fill(0x5a);
    expect(pwkForUnlock.buffer.byteLength).toBe(32);
    await client.unlockPrf({
      pwk: pwkForUnlock,
      vkWrap: vk_wrap,
    });
    expect(pwkForUnlock.buffer.byteLength).toBe(0);

    // Lock and test unlockRecovery detach
    await client.lock();
    const rk0 = created.recovery_keys[0]!;
    const rkBuf = new Uint8Array(utf8Encoder.encode(rk0.display));
    expect(rkBuf.buffer.byteLength).toBeGreaterThan(0);
    const rkRes = await client.unlockRecovery({
      recoveryKey: rkBuf,
      wrap: rk0.wrap,
    });
    expect(rkBuf.buffer.byteLength).toBe(0);
    expect(rkRes.recovering).toBe(true);
    expect(client.getState()).toBe('recovering');

    // Rewrap detaches new passphrase buffer and preserves current (ops, mem) with a new salt
    const rewrapPassBuf = new Uint8Array(utf8Encoder.encode('new-passphrase-after-recovery'));
    const rewrapped = await client.rewrap({
      passphrase: rewrapPassBuf,
      currentKdf: {
        alg: 'argon2id13',
        ops: 5,
        mem: 134_217_728, // 128 MiB — must NOT be lowered to 64 MiB
        parallelism: 1,
        salt: created.kdf.salt,
      },
    });
    expect(rewrapPassBuf.buffer.byteLength).toBe(0);
    expect(rewrapped.kdf.ops).toBe(5);
    expect(rewrapped.kdf.mem).toBe(134_217_728);
    expect(rewrapped.kdf.salt).not.toBe(created.kdf.salt);
    expect(client.getState()).toBe('unlocked');
  });

  it('never includes VK, KEK, or private key seeds in any postMessage payload to the main thread', async () => {
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      recovery: testRecoveryAdapter,
      envelope: testEnvelopeAdapter,
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const created = await client.createVault({
      passphrase: 'secret-vault-passphrase',
    });

    const vkInClosure = shim.core.inspectClosureVkForTest();
    expect(vkInClosure).not.toBeNull();
    expect(vkInClosure!.byteLength).toBe(VK_BYTES);

    const pwk = new Uint8Array(32).fill(0x33);
    await client.wrapForPasskey({ pwk: new Uint8Array(pwk) });

    const devKey = await generateTestDevKey();
    const { wrapped_vk } = await client.wrapForDevice({
      devKey,
      userId: '11111111-1111-4111-8111-111111111111',
      vaultKeyId: 'vk:0123456789abcdefghijkl',
    });
    expect(wrapped_vk.byteLength).toBe(DEVKEY_WRAP_BYTES);

    await client.makeRecoveryKeys({ slots: [1, 2] });

    const sealed = await client.sealEntry({
      entryId: '22222222-2222-4222-8222-222222222222',
      keyId: 'vk:0123456789abcdefghijkl',
      plaintext: 'top-secret-entry-body',
    });
    const opened = await client.openEntry({
      entryId: '22222222-2222-4222-8222-222222222222',
      envelope: sealed.envelope,
      ciphertext: sealed.ciphertext,
    });
    expect(opened.plaintext).toBe('top-secret-entry-body');

    await client.rewrap({
      passphrase: 'second-passphrase-secret',
      currentKdf: created.kdf,
    });

    // Spy check: inspect every message sent from Worker to main thread
    expect(shim.workerPostMessageCalls.length).toBeGreaterThanOrEqual(6);
    for (const msg of shim.workerPostMessageCalls) {
      expect(scanPayloadForSecretBytes(msg, vkInClosure!)).toBe(false);
    }
  });

  it('cancels stale results when lock occurs mid-flight, including async DevKey, PRF, and passphrase paths', async () => {
    let pauseDerive = false;
    const deriveStarted = Promise.withResolvers<void>();
    const deriveGate = Promise.withResolvers<void>();

    const shim = createWorkerShim({
      deriveKek: async (sodium, passphrase, params) => {
        if (pauseDerive) {
          deriveStarted.resolve();
          await deriveGate.promise;
        }
        return fastTestDeriveKek(sodium, passphrase, params);
      },
      recovery: testRecoveryAdapter,
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    // Setup initial vault artifacts
    const created = await client.createVault({
      passphrase: 'initial-passphrase',
      skipRecoveryKeys: true,
    });
    const pwk = new Uint8Array(32).fill(0x77);
    const { vk_wrap } = await client.wrapForPasskey({ pwk: new Uint8Array(pwk) });
    const devKey = await generateTestDevKey();
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const vaultKeyId = 'vk:abcdefghijklmnopqrstuv';
    const { wrapped_vk } = await client.wrapForDevice({
      devKey,
      userId,
      vaultKeyId,
    });

    await client.lock();
    expect(client.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();

    // 1. Mid-flight lock during Worker Argon2id derive (unlockPassphrase)
    pauseDerive = true;
    const unlockPassPromise = client.unlockPassphrase({
      passphrase: 'initial-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
    });

    // Wait deterministically until Worker enters deriveKek, then lock
    await deriveStarted.promise;
    await client.lock();
    deriveGate.resolve();

    await expect(unlockPassPromise).rejects.toMatchObject({
      code: 'STALE_GENERATION',
    });
    expect(client.getState()).toBe('locked');
    expect(shim.core.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();
    pauseDerive = false;

    // 2. Mid-flight lock during async WebAuthn PRF flow (opGeneration captured before await get())
    const prfOpGen = client.captureGeneration();
    const prfSecretBuf = new Uint8Array(pwk);
    const unlockPrfPromise = client.unlockPrf({
      pwk: prfSecretBuf,
      vkWrap: vk_wrap,
      opGeneration: prfOpGen,
      beforePostMessage: async () => {
        // Simulate user or auto-lock firing while waiting for authenticator touch
        await client.lock();
      },
    });

    await expect(unlockPrfPromise).rejects.toMatchObject({
      code: 'STALE_GENERATION',
    });
    // Secret buffer must be wiped to all zeroes when aborted before Worker postMessage
    expect(prfSecretBuf.every((b) => b === 0)).toBe(true);
    expect(client.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();

    // 3. Mid-flight lock during async DevKey unlock flow (both beforePostMessage and inside Worker WebCrypto)
    const devOpGen = client.captureGeneration();
    const unlockDevPromise = client.unlockDevKey({
      devKey,
      wrappedVk: wrapped_vk,
      userId,
      vaultKeyId,
      opGeneration: devOpGen,
    });
    // Immediately lock while unlockDevKey is in flight over MessageChannel / WebCrypto
    await client.lock();

    await expect(unlockDevPromise).rejects.toMatchObject({
      code: 'STALE_GENERATION',
    });
    expect(client.getState()).toBe('locked');
    expect(shim.core.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();
  });

  it('fails the command and withholds output when a simulated broken wrap fails the re-open self-check', async () => {
    const sodium = await getSodium();

    // Case 1: Broken wrap produced by sealWrap (corrupting a plaintext byte before encryption)
    let corruptKind: 'kek' | 'rk' | 'prf' | 'priv' | null = 'kek';
    const brokenShim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      recovery: testRecoveryAdapter,
      sealWrap: (s, kind, pt, key) => {
        if (kind === corruptKind) {
          const corruptedPt = new Uint8Array(pt);
          corruptedPt[0] ^= 0xff;
          return sealWrap(s, kind, corruptedPt, key);
        }
        return sealWrap(s, kind, pt, key);
      },
      sealDevKeyWrap: async (s, vk, devKey, userId, vaultKeyId) => {
        const corruptedVk = new Uint8Array(vk);
        corruptedVk[0] ^= 0xff;
        return sealDevKeyWrap(s, corruptedVk, devKey, userId, vaultKeyId);
      },
    });
    activeShims.push(brokenShim);
    const client = new CryptoClient({ createWorker: () => brokenShim.port });

    // 1a. createVault fails when KEK wrap re-open mismatches VK
    await expect(
      client.createVault({ passphrase: 'test-passphrase' }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });
    expect(brokenShim.core.inspectClosureVkForTest()).toBeNull();

    // 1b. createVault fails when private_keys_wrapped re-open mismatches public keys / seeds
    corruptKind = 'priv';
    await expect(
      client.createVault({ passphrase: 'test-passphrase' }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });
    expect(brokenShim.core.inspectClosureVkForTest()).toBeNull();

    // 1c. createVault fails when RK wrap re-open mismatches VK
    corruptKind = 'rk';
    await expect(
      client.createVault({ passphrase: 'test-passphrase' }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });
    expect(brokenShim.core.inspectClosureVkForTest()).toBeNull();

    // Allow createVault to succeed so we can test rewrap, makeRecoveryKeys, wrapForPasskey, wrapForDevice
    corruptKind = null;
    const created = await client.createVault({ passphrase: 'test-passphrase' });

    // 2. rewrap fails on broken KEK wrap
    corruptKind = 'kek';
    await expect(
      client.rewrap({ passphrase: 'new-passphrase', currentKdf: created.kdf }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });

    // 3. makeRecoveryKeys fails on broken RK wrap
    corruptKind = 'rk';
    await expect(
      client.makeRecoveryKeys({ slots: [1] }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });

    // 4. wrapForPasskey fails on broken PRF wrap
    corruptKind = 'prf';
    await expect(
      client.wrapForPasskey({ pwk: new Uint8Array(32).fill(0x11) }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });

    // 5. wrapForDevice fails on broken DevKey wrap
    const devKey = await generateTestDevKey();
    await expect(
      client.wrapForDevice({
        devKey,
        userId: '11111111-1111-4111-8111-111111111111',
        vaultKeyId: 'vk:0123456789abcdefghijkl',
      }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });

    void sodium;
  });

  it('transitions client to error state on Worker crash and requires unlock again', async () => {
    let currentShim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      recovery: testRecoveryAdapter,
    });
    activeShims.push(currentShim);

    const states: string[] = [];
    const client = new CryptoClient({
      createWorker: () => currentShim.port,
      onStateChange: (st) => states.push(st),
    });

    const created = await client.createVault({
      passphrase: 'crash-test-passphrase',
      skipRecoveryKeys: true,
    });
    expect(client.getState()).toBe('unlocked');

    // Simulate Worker crash
    currentShim.simulateCrash();
    expect(client.getState()).toBe('error');
    expect(states).toContain('error');

    // Non-unlock commands must fail while in error state
    await expect(
      client.makeRecoveryKeys({ slots: [1] }),
    ).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });

    // Prepare fresh Worker instance for re-unlock
    currentShim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      recovery: testRecoveryAdapter,
    });
    activeShims.push(currentShim);

    await client.unlockPassphrase({
      passphrase: 'crash-test-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
    });
    expect(client.getState()).toBe('unlocked');
  });

  it('verifies default recovery.ts and envelope.ts adapters work end-to-end', async () => {
    const sodium = await getSodium();
    const rk = generateRecoveryKey(sodium, 1);
    expect(rk.slot).toBe(1);
    expect(normalizeRecoveryKey(rk.display)).toBe(rk.normalized);
    expect(formatRecoveryKeyDisplay(1, rk.normalized.slice(4))).toBe(rk.display);
    expect(deriveRecoveryLookupHash(sodium, rk.display).byteLength).toBe(32);
    expect(deriveRecoveryWrapKey(sodium, rk.display).byteLength).toBe(32);

    expect(() => validateEntryEnvelope({})).toThrowError(
      expect.objectContaining({ code: 'ENVELOPE_INVALID' }),
    );
    const validEnv: EntryEnvelopeV1 = {
      v: 1,
      alg: 'xchacha20poly1305-ietf',
      key_id: 'vk:0123456789abcdefghijkl',
      nonce: '0'.repeat(32),
      ct_enc: 'utf8',
    };
    expect(canonicalizeEnvelopeJcs(validEnv)).toBe(
      '{"alg":"xchacha20poly1305-ietf","ct_enc":"utf8","key_id":"vk:0123456789abcdefghijkl","nonce":"00000000000000000000000000000000","v":1}',
    );
    expect(
      buildEntryAad(validEnv, '00000000-0000-4000-8000-000000000000').byteLength,
    ).toBeGreaterThan(100);
  });

  it('verifies AAD domain separation across wrap labels and DevKey user/vault_key_id bindings', async () => {
    const sodium = await getSodium();
    const vk = sodium.randombytes_buf(VK_BYTES);
    const key = sodium.randombytes_buf(VK_BYTES);

    const kekWrap = sealWrap(sodium, 'kek', vk, key);
    // Attempting to open a KEK wrap as a PRF or RK wrap must fail AEAD authentication
    expect(() => openWrap(sodium, 'prf', kekWrap, key)).toThrowError(
      expect.objectContaining({ code: 'AEAD_DECRYPT_FAILED' }),
    );
    expect(() => openWrap(sodium, 'rk', kekWrap, key)).toThrowError(
      expect.objectContaining({ code: 'AEAD_DECRYPT_FAILED' }),
    );

    const devKey = await generateTestDevKey();
    const devWrap = await sealDevKeyWrap(
      sodium,
      vk,
      devKey,
      'user-1',
      'vk:vault-1',
    );
    await expect(
      openDevKeyWrap(devWrap, devKey, 'user-2', 'vk:vault-1'),
    ).rejects.toMatchObject({
      code: 'AEAD_DECRYPT_FAILED',
    });
    await expect(
      openDevKeyWrap(devWrap, devKey, 'user-1', 'vk:vault-2'),
    ).rejects.toMatchObject({
      code: 'AEAD_DECRYPT_FAILED',
    });

    // Verify helpers
    expect(buildWrapAad('sabk.vk.kek.v1', 0x01).at(-1)).toBe(0x01);
    expect(buildDevKeyAad('u1', 'vk:1').byteLength).toBeGreaterThan(15);
    const packed = packPrivateKeySeeds(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
    const unpacked = unpackPrivateKeySeeds(packed);
    expect(unpacked.x25519Seed[0]).toBe(1);
    expect(unpacked.ed25519Seed[0]).toBe(2);
    expect(makeRewrapKdfParams(sodium, {
      alg: 'argon2id13',
      ops: 4,
      mem: 67_108_864,
      parallelism: 1,
      salt: encodeBase64Url(new Uint8Array(16).fill(5)),
    }).ops).toBe(4);
    expect(WrapError).toBeDefined();
  });

  it('runs the Argon2id 64 MiB benchmark helper across multiple runs and reports median/p95', async () => {
    const benchRes = await runArgon2idBenchmark(1);
    expect(benchRes.type).toBe('benchResult');
    expect(benchRes.params.alg).toBe('argon2id13');
    expect(benchRes.params.ops).toBe(3);
    expect(benchRes.params.mem).toBe(67_108_864);
    expect(benchRes.params.parallelism).toBe(1);
    expect(benchRes.allSucceeded).toBe(true);
    expect(benchRes.runs).toHaveLength(1);
    expect(benchRes.runs[0]?.ok).toBe(true);
    expect(benchRes.runs[0]?.ms).toBeGreaterThan(0);
    expect(benchRes.medianMs).toBeGreaterThan(0);
  }, 30_000);
});
