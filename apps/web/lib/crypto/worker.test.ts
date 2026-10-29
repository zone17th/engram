import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Base64UrlError, decodeBase64UrlStrict, encodeBase64Url } from './b64url';
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
import { JcsError } from './jcs';
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
  isAllocationFailure,
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
import { getSodium, resetSodiumForTest, sodium as rawSodium, type Sodium } from './sodium';
import { createWorkerShim, type ShimmedWorkerInstance } from './test/worker-shim';
import { attachWorkerCore, createWorkerCore, type WorkerRequestMessage } from './worker-core';
import {
  DEVKEY_WRAP_BYTES,
  PRIV_WRAP_BYTES,
  VK_BYTES,
  VK_WRAP_BYTES,
  WRAP_VERSION,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
 * can be exercised for Worker generation/detach/self-check behavior.
 */
const testRecoveryAdapter: RecoveryKeyAdapter = {
  generateRecoveryKey(sodium: Sodium, slot: number) {
    const raw = sodium.randombytes_buf(16);
    try {
      const hex = sodium.to_hex(raw).toUpperCase().slice(0, 25);
      const body26 = `0${hex}`;
      const display = `rk${slot}_${body26.slice(0, 4)}-${body26.slice(4, 8)}-${body26.slice(8, 12)}-${body26.slice(12, 16)}-${body26.slice(16, 20)}-${body26.slice(20, 24)}-${body26.slice(24, 26)}`;
      return {
        slot,
        display,
        normalized: `rk${slot}_${body26}`,
      };
    } finally {
      sodium.memzero(raw);
    }
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
 * generation/closure checks.
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
    const jcs = testEnvelopeAdapter.canonicalizeEnvelopeJcs(env);
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

/**
 * Recursively scans outbound Worker payloads for any secret byte sequence (`VK`, `KEK`,
 * `x25519Seed`, `ed25519Seed`, `rkWrapKey`, `PWK`) represented as:
 * - raw `Uint8Array` or `ArrayBuffer` or `ArrayBufferView`
 * - hex string or base64url string (including substrings and decoded base64url content)
 * - `number[]` byte arrays (T-1)
 */
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
    if (ArrayBuffer.isView(node)) {
      return containsSubsequence(new Uint8Array(node.buffer, node.byteOffset, node.byteLength), secret);
    }
    if (Array.isArray(node)) {
      if (
        node.length >= secret.byteLength &&
        node.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)
      ) {
        if (containsSubsequence( Uint8Array.from(node as number[]), secret )) {
          return true;
        }
      }
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
      opGeneration: client.captureGeneration(),
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
      opGeneration: client.captureGeneration(),
    });
    expect(unlocked.unlocked).toBe(true);
    expect(client.getState()).toBe('unlocked');
  }, 30_000);

  it('rejects KDF params below and above bounds for every field BEFORE allocation on both default and custom derive paths (FE1-27)', async () => {
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
      // 1. Default derive path (NO customDerive passed -> would call sodium.crypto_pwhash if not rejected before allocation, FE1-27)
      expect(
        () => deriveKek(sodium, new Uint8Array([1, 2, 3]), tc.input),
        `${tc.label} (default derive)`,
      ).toThrowError(
        expect.objectContaining({
          code: 'KDF_PARAMS_INVALID',
        }),
      );
      // 2. Custom derive path
      expect(
        () => deriveKek(sodium, new Uint8Array([1, 2, 3]), tc.input, customDeriveSpy),
        `${tc.label} (custom derive)`,
      ).toThrowError(
        expect.objectContaining({
          code: 'KDF_PARAMS_INVALID',
        }),
      );
    }

    // Prove neither customDerive nor sodium.crypto_pwhash was ever invoked on invalid params
    expect(customDeriveSpy).not.toHaveBeenCalled();
    expect(pwhashSpy).not.toHaveBeenCalled();

    // Also verify Worker unlockPassphrase on the DEFAULT derive path rejects invalid KDF params before calling crypto_pwhash
    const defaultShim = createWorkerShim();
    activeShims.push(defaultShim);
    const defaultClient = new CryptoClient({ createWorker: () => defaultShim.port });

    await expect(
      defaultClient.unlockPassphrase({
        passphrase: 'test-passphrase',
        kdf: { ...baseValid, mem: KDF_MEM_MAX + 1024 },
        vaultKeyWrappedByKek: encodeBase64Url(new Uint8Array(VK_WRAP_BYTES)),
        opGeneration: defaultClient.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'KDF_PARAMS_INVALID',
    });
    expect(pwhashSpy).not.toHaveBeenCalled();
    pwhashSpy.mockRestore();
  });

  it('classifies KDF allocation failures by error type/errno (not message substring) and NEVER reports derive/allocation failures as AEAD_DECRYPT_FAILED (FE1-14)', async () => {
    // Unit-check isAllocationFailure directly: substring 'memory'/'room'/'zoom' on generic Error must NOT match (FE1-14)
    expect(isAllocationFailure(new RangeError('WebAssembly.Memory(): could not allocate memory'))).toBe(true);
    if (typeof WebAssembly !== 'undefined' && typeof WebAssembly.RuntimeError === 'function') {
      expect(isAllocationFailure(new WebAssembly.RuntimeError('unreachable'))).toBe(true);
    }
    expect(isAllocationFailure(Object.assign(new Error('alloc failed'), { errno: 12 }))).toBe(true);
    expect(isAllocationFailure(Object.assign(new Error('alloc failed'), { code: 'ENOMEM' }))).toBe(true);
    expect(isAllocationFailure(new Error('room zoom memory text on generic Error'))).toBe(false);
    expect(isAllocationFailure(new Error('invalid usage'))).toBe(false);

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
        opGeneration: oomClient.captureGeneration(),
      });
    } catch (err) {
      caughtOom = err as CryptoClientError;
    }

    expect(caughtOom).toBeInstanceOf(CryptoClientError);
    expect(caughtOom?.code).toBe('KDF_ALLOCATION_FAILED');
    expect(caughtOom?.code).not.toBe('AEAD_DECRYPT_FAILED');

    const genericDeriveFailShim = createWorkerShim({
      deriveKek: () => {
        throw new Error('Unexpected crypto_pwhash failure in room memory');
      },
    });
    activeShims.push(genericDeriveFailShim);
    const deriveFailClient = new CryptoClient({ createWorker: () => genericDeriveFailShim.port });

    await expect(
      deriveFailClient.unlockPassphrase({
        passphrase: 'any-passphrase',
        kdf: validKdf,
        vaultKeyWrappedByKek: encodeBase64Url(new Uint8Array(VK_WRAP_BYTES)),
        opGeneration: deriveFailClient.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'KDF_DERIVE_FAILED',
    });
  });

  it('reports wrong passphrase as AEAD_DECRYPT_FAILED, zeroes derived KEK on failure (BE1-25), distinguishes PRIVATE_KEYS_WRAP_INVALID (FE1-23), and enforces wrap layout', async () => {
    const sodium = await getSodium();
    const derivedKekBuffers: Uint8Array[] = [];
    const trackingDeriveKek: DeriveKekFn = (s, passphrase, params) => {
      const out = fastTestDeriveKek(s, passphrase, params) as Uint8Array;
      derivedKekBuffers.push(out);
      return out;
    };

    const shim = createWorkerShim({
      deriveKek: trackingDeriveKek,
      recovery: testRecoveryAdapter,
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const created = await client.createVault({
      passphrase: 'correct-passphrase-12345',
      opGeneration: client.captureGeneration(),
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

    // Wrong passphrase -> AEAD_DECRYPT_FAILED, AND the actual derived KEK buffer must be wiped to all zeroes (BE1-25)
    await client.lock();
    derivedKekBuffers.length = 0;
    await expect(
      client.unlockPassphrase({
        passphrase: 'wrong-passphrase-99999',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'AEAD_DECRYPT_FAILED',
    });
    expect(derivedKekBuffers).toHaveLength(1);
    expect(derivedKekBuffers[0]!.every((b) => b === 0)).toBe(true);

    // Corrupt privateKeysWrapped AFTER VK opens -> PRIVATE_KEYS_WRAP_INVALID, NEVER AEAD_DECRYPT_FAILED (FE1-23)
    const tamperedPrivWrap = new Uint8Array(privWrapBytes);
    tamperedPrivWrap[tamperedPrivWrap.length - 1] ^= 0xff;
    await expect(
      client.unlockPassphrase({
        passphrase: 'correct-passphrase-12345',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        privateKeysWrapped: encodeBase64Url(tamperedPrivWrap),
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'PRIVATE_KEYS_WRAP_INVALID',
    });
    expect(client.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();

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

  it('detaches passphrase, recovery key, and PWK ArrayBuffers (including raw ArrayBuffer and subarray views) on the main thread after postMessage (BE1-23, FE1-27)', async () => {
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
      opGeneration: client.captureGeneration(),
    });
    expect(createPassBuf.buffer.byteLength).toBe(0);
    expect(createPassBuf.byteLength).toBe(0);

    // 1. Wrap for passkey detaches Uint8Array PWK buffer
    const pwkForWrap = new Uint8Array(32).fill(0x5a);
    expect(pwkForWrap.buffer.byteLength).toBe(32);
    const { vk_wrap } = await client.wrapForPasskey({
      pwk: pwkForWrap,
      opGeneration: client.captureGeneration(),
    });
    expect(pwkForWrap.buffer.byteLength).toBe(0);
    expect(pwkForWrap.byteLength).toBe(0);

    // 2. Wrap for passkey detaches raw ArrayBuffer PWK directly (what WebAuthn PRF returns, BE1-23, FE1-27)
    const rawPwkBufferForWrap = new Uint8Array(32).fill(0x5a).buffer;
    expect(rawPwkBufferForWrap.byteLength).toBe(32);
    const { vk_wrap: vkWrapFromRawAb } = await client.wrapForPasskey({
      pwk: rawPwkBufferForWrap,
      opGeneration: client.captureGeneration(),
    });
    expect(rawPwkBufferForWrap.byteLength).toBe(0);

    // 3. Sub-view Uint8Array (byteOffset > 0 or byteLength < buffer.byteLength) copies and zeroes the caller's sub-view in place (FE1-27)
    const backing = new Uint8Array(64).fill(0x11);
    const subView = backing.subarray(16, 48);
    subView.fill(0x5a);
    await client.wrapForPasskey({
      pwk: subView,
      opGeneration: client.captureGeneration(),
    });
    expect(subView.every((b) => b === 0)).toBe(true);
    // Surrounding bytes outside the sub-view remain untouched
    expect(backing.subarray(0, 16).every((b) => b === 0x11)).toBe(true);
    expect(backing.subarray(48, 64).every((b) => b === 0x11)).toBe(true);

    // Lock and test unlockPassphrase detach
    await client.lock();
    const unlockPassBuf = new Uint8Array(utf8Encoder.encode('passphrase-for-create'));
    expect(unlockPassBuf.buffer.byteLength).toBeGreaterThan(0);
    await client.unlockPassphrase({
      passphrase: unlockPassBuf,
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      opGeneration: client.captureGeneration(),
    });
    expect(unlockPassBuf.buffer.byteLength).toBe(0);

    // Lock and test unlockPrf detach with Uint8Array
    await client.lock();
    const pwkForUnlock = new Uint8Array(32).fill(0x5a);
    expect(pwkForUnlock.buffer.byteLength).toBe(32);
    await client.unlockPrf({
      pwk: pwkForUnlock,
      vkWrap: vk_wrap,
      opGeneration: client.captureGeneration(),
    });
    expect(pwkForUnlock.buffer.byteLength).toBe(0);

    // Lock and test unlockPrf detach with raw ArrayBuffer (BE1-23, FE1-27)
    await client.lock();
    const rawPwkBufferForUnlock = new Uint8Array(32).fill(0x5a).buffer;
    expect(rawPwkBufferForUnlock.byteLength).toBe(32);
    await client.unlockPrf({
      pwk: rawPwkBufferForUnlock,
      vkWrap: vkWrapFromRawAb,
      opGeneration: client.captureGeneration(),
    });
    expect(rawPwkBufferForUnlock.byteLength).toBe(0);

    // Lock and test unlockRecovery detach
    await client.lock();
    const rk0 = created.recovery_keys[0]!;
    const rkBuf = new Uint8Array(utf8Encoder.encode(rk0.display));
    expect(rkBuf.buffer.byteLength).toBeGreaterThan(0);
    const rkGen = client.captureGeneration();
    const rkRes = await client.unlockRecovery({
      recoveryKey: rkBuf,
      wrap: rk0.wrap,
      opGeneration: rkGen,
    });
    expect(rkBuf.buffer.byteLength).toBe(0);
    expect(rkRes.recovering).toBe(true);
    expect(client.getState()).toBe('recovering');

    // Rewrap detaches new passphrase buffer and preserves current (ops, mem) with a new salt, while staying in 'recovering' until confirmRecovery (BE1-12, FE1-1)
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
      opGeneration: rkGen,
    });
    expect(rewrapPassBuf.buffer.byteLength).toBe(0);
    expect(rewrapped.kdf.ops).toBe(5);
    expect(rewrapped.kdf.mem).toBe(134_217_728);
    expect(rewrapped.kdf.salt).not.toBe(created.kdf.salt);
    expect(client.getState()).toBe('recovering');

    await client.confirmRecovery({ opGeneration: rkGen });
    expect(client.getState()).toBe('unlocked');
  });

  it('never includes VK, KEK, private key seeds, or RK wrap key in any postMessage response (including error responses and number[] form, with positive control) (BE1-24, FE1-26, T-1, T-2)', async () => {
    const sodium = await getSodium();

    // Positive control for scanPayloadForSecretBytes (T-1): verify it detects planted secrets in Uint8Array, hex, base64url, and number[]
    const plantedSecret = sodium.randombytes_buf(32);
    expect(scanPayloadForSecretBytes({ ok: true, result: { buf: new Uint8Array(plantedSecret) } }, plantedSecret)).toBe(true);
    expect(scanPayloadForSecretBytes({ ok: true, result: { b64: encodeBase64Url(plantedSecret) } }, plantedSecret)).toBe(true);
    expect(scanPayloadForSecretBytes({ ok: true, result: { hex: sodium.to_hex(plantedSecret) } }, plantedSecret)).toBe(true);
    expect(scanPayloadForSecretBytes({ ok: true, result: { dbg: Array.from(plantedSecret) } }, plantedSecret)).toBe(true);

    const capturedKeks: Uint8Array[] = [];
    const shim = createWorkerShim({
      deriveKek: (s, passphrase, params) => {
        const kek = fastTestDeriveKek(s, passphrase, params) as Uint8Array;
        capturedKeks.push(new Uint8Array(kek));
        return kek;
      },
      recovery: testRecoveryAdapter,
      envelope: testEnvelopeAdapter,
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const created = await client.createVault({
      passphrase: 'secret-vault-passphrase',
      opGeneration: client.captureGeneration(),
    });

    const vkInClosure = shim.core.inspectClosureVkForTest();
    expect(vkInClosure).not.toBeNull();
    expect(vkInClosure!.byteLength).toBe(VK_BYTES);

    // Reopen private_keys_wrapped with the known VK to extract both real private seeds and verify public keys match (BE1-24)
    const openedPriv = openWrap(sodium, 'priv', created.private_keys_wrapped, vkInClosure!);
    const { x25519Seed, ed25519Seed } = unpackPrivateKeySeeds(openedPriv);
    const expectedXPub = encodeBase64Url(sodium.crypto_box_seed_keypair(x25519Seed).publicKey);
    const expectedEdPub = encodeBase64Url(sodium.crypto_sign_seed_keypair(ed25519Seed).publicKey);
    expect(created.x25519_public).toBe(expectedXPub);
    expect(created.ed25519_public).toBe(expectedEdPub);

    // Capture RK wrap_key for RK #0
    const rk0 = created.recovery_keys[0]!;
    const rkWrapKey = testRecoveryAdapter.deriveRecoveryWrapKey(
      sodium,
      testRecoveryAdapter.normalizeRecoveryKey(rk0.display),
    );

    const pwk = new Uint8Array(32).fill(0x33);
    const { vk_wrap } = await client.wrapForPasskey({
      pwk: new Uint8Array(pwk),
      opGeneration: client.captureGeneration(),
    });

    const devKey = await generateTestDevKey();
    const userId = '11111111-1111-4111-8111-111111111111';
    const vaultKeyId = 'vk:0123456789abcdefghijkl';
    const { wrapped_vk } = await client.wrapForDevice({
      devKey,
      userId,
      vaultKeyId,
      opGeneration: client.captureGeneration(),
    });
    expect(wrapped_vk.byteLength).toBe(DEVKEY_WRAP_BYTES);

    await client.makeRecoveryKeys({
      slots: [1, 2],
      opGeneration: client.captureGeneration(),
    });

    const sealed = await client.sealEntry({
      entryId: '22222222-2222-4222-8222-222222222222',
      keyId: vaultKeyId,
      plaintext: 'top-secret-entry-body',
      opGeneration: client.captureGeneration(),
    });
    const opened = await client.openEntry({
      entryId: '22222222-2222-4222-8222-222222222222',
      envelope: sealed.envelope,
      ciphertext: sealed.ciphertext,
      opGeneration: client.captureGeneration(),
    });
    expect(opened.plaintext).toBe('top-secret-entry-body');

    await client.rewrap({
      passphrase: 'second-passphrase-secret',
      currentKdf: created.kdf,
      opGeneration: client.captureGeneration(),
    });

    // Also exercise lock, unlockPassphrase, unlockPrf, unlockDevKey, unlockRecovery, resumeRecovery, confirmRecovery, and an error response (FE1-26)
    await client.lock();
    await client.unlockPassphrase({
      passphrase: 'secret-vault-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      privateKeysWrapped: created.private_keys_wrapped,
      opGeneration: client.captureGeneration(),
    });

    await client.lock();
    await client.unlockPrf({
      pwk: new Uint8Array(pwk),
      vkWrap: vk_wrap,
      privateKeysWrapped: created.private_keys_wrapped,
      opGeneration: client.captureGeneration(),
    });

    await client.lock();
    await client.unlockDevKey({
      devKey,
      wrappedVk: wrapped_vk,
      userId,
      vaultKeyId,
      privateKeysWrapped: created.private_keys_wrapped,
      opGeneration: client.captureGeneration(),
    });

    await client.lock();
    const recGen = client.captureGeneration();
    await client.unlockRecovery({
      recoveryKey: rk0.display,
      opGeneration: recGen,
    });
    await client.resumeRecovery({
      wrap: rk0.wrap,
      privateKeysWrapped: created.private_keys_wrapped,
      opGeneration: recGen,
    });
    await client.confirmRecovery({ opGeneration: recGen });

    // Trigger an error response (wrong passphrase) and ensure no secret appears in error responses either
    await client.lock();
    await expect(
      client.unlockPassphrase({
        passphrase: 'wrong-passphrase-for-error-scan',
        kdf: created.kdf,
        vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({ code: 'AEAD_DECRYPT_FAILED' });

    const allSecretsToScan: Array<{ name: string; bytes: Uint8Array }> = [
      { name: 'vk', bytes: vkInClosure! },
      { name: 'x25519Seed', bytes: x25519Seed },
      { name: 'ed25519Seed', bytes: ed25519Seed },
      { name: 'rkWrapKey', bytes: rkWrapKey },
      { name: 'pwk', bytes: pwk },
      ...capturedKeks.map((k, idx) => ({ name: `kek_${idx}`, bytes: k })),
    ];

    expect(shim.workerPostMessageCalls).toHaveLength(19);
    for (const msg of shim.workerPostMessageCalls) {
      for (const secret of allSecretsToScan) {
        expect(
          scanPayloadForSecretBytes(msg, secret.bytes),
          `Secret ${secret.name} leaked in message ${JSON.stringify(msg)}`,
        ).toBe(false);
      }
    }
  });

  it('cancels stale results when lock occurs mid-flight, including async DevKey, PRF, passphrase, synchronous derive back-to-back lock, and Worker-side stale generation checks (FE1-11)', async () => {
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
      opGeneration: client.captureGeneration(),
    });
    const pwk = new Uint8Array(32).fill(0x77);
    const { vk_wrap } = await client.wrapForPasskey({
      pwk: new Uint8Array(pwk),
      opGeneration: client.captureGeneration(),
    });
    const devKey = await generateTestDevKey();
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const vaultKeyId = 'vk:abcdefghijklmnopqrstuv';
    const { wrapped_vk } = await client.wrapForDevice({
      devKey,
      userId,
      vaultKeyId,
      opGeneration: client.captureGeneration(),
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
      opGeneration: client.captureGeneration(),
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

    // 4. Synchronous derive back-to-back unlockPassphrase + lock(): unlock rejects STALE_GENERATION, VK null after lock reply, lock() resolves (FE1-11b)
    const syncGen = client.captureGeneration();
    const syncUnlockPromise = client.unlockPassphrase({
      passphrase: 'initial-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      opGeneration: syncGen,
    });
    const syncLockPromise = client.lock();
    const [syncUnlockOutcome, syncLockRes] = await Promise.allSettled([
      syncUnlockPromise,
      syncLockPromise,
    ]);
    expect(syncUnlockOutcome.status).toBe('rejected');
    if (syncUnlockOutcome.status === 'rejected') {
      expect(syncUnlockOutcome.reason).toMatchObject({ code: 'STALE_GENERATION' });
    }
    expect(syncLockRes.status).toBe('fulfilled');
    expect(client.getState()).toBe('locked');
    expect(shim.core.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();

    // 5. Stale error reply (wrong passphrase + mid-flight lock) is surfaced as STALE_GENERATION, not AEAD_DECRYPT_FAILED (FE1-16)
    const staleErrGen = client.captureGeneration();
    const wrongPassUnlockPromise = client.unlockPassphrase({
      passphrase: 'wrong-passphrase-during-lock',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      opGeneration: staleErrGen,
    });
    const staleErrLockPromise = client.lock();
    const [wrongPassOutcome] = await Promise.allSettled([
      wrongPassUnlockPromise,
      staleErrLockPromise,
    ]);
    expect(wrongPassOutcome.status).toBe('rejected');
    if (wrongPassOutcome.status === 'rejected') {
      expect(wrongPassOutcome.reason).toMatchObject({
        code: 'STALE_GENERATION',
      });
    }

    // 6. Core-level direct Worker stale-generation checks for unlockPrf, unlockRecovery, unlockPassphrase, sealEntry, openEntry (FE1-11a)
    const currentWorkerGen = shim.core.getGeneration();
    const bumpedGen = currentWorkerGen + 5;
    const lockMsgRes = await shim.core.handleMessage({
      id: 9000,
      generation: bumpedGen,
      type: 'lock',
    });
    expect(lockMsgRes.ok).toBe(true);
    expect(shim.core.getGeneration()).toBe(bumpedGen);

    const staleGen = bumpedGen - 1;
    const stalePrfBuf = new Uint8Array(pwk);
    const stalePrfRes = await shim.core.handleMessage({
      id: 9001,
      generation: staleGen,
      type: 'unlockPrf',
      pwkBuffer: stalePrfBuf.buffer,
      vkWrap: vk_wrap,
    });
    expect(stalePrfRes).toMatchObject({
      ok: false,
      error: { code: 'STALE_GENERATION' },
    });
    expect(shim.core.inspectClosureVkForTest()).toBeNull();
    expect(stalePrfBuf.every((b) => b === 0)).toBe(true);

    const staleRkBuf = new Uint8Array(utf8Encoder.encode('rk1_0000-0000-0000-0000-0000-0000-00'));
    const staleRkRes = await shim.core.handleMessage({
      id: 9002,
      generation: staleGen,
      type: 'unlockRecovery',
      recoveryKeyBuffer: staleRkBuf.buffer,
    });
    expect(staleRkRes).toMatchObject({
      ok: false,
      error: { code: 'STALE_GENERATION' },
    });
    expect(shim.core.inspectClosureVkForTest()).toBeNull();
    expect(staleRkBuf.every((b) => b === 0)).toBe(true);

    const stalePassBuf = new Uint8Array(utf8Encoder.encode('initial-passphrase'));
    const stalePassRes = await shim.core.handleMessage({
      id: 9003,
      generation: staleGen,
      type: 'unlockPassphrase',
      passphraseBuffer: stalePassBuf.buffer,
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
    });
    expect(stalePassRes).toMatchObject({
      ok: false,
      error: { code: 'STALE_GENERATION' },
    });
    expect(shim.core.inspectClosureVkForTest()).toBeNull();
    expect(stalePassBuf.every((b) => b === 0)).toBe(true);

    const staleSealRes = await shim.core.handleMessage({
      id: 9004,
      generation: staleGen,
      type: 'sealEntry',
      entryId: '22222222-2222-4222-8222-222222222222',
      keyId: vaultKeyId,
      plaintext: 'stale-entry',
    });
    expect(staleSealRes).toMatchObject({
      ok: false,
      error: { code: 'STALE_GENERATION' },
    });

    const staleOpenRes = await shim.core.handleMessage({
      id: 9005,
      generation: staleGen,
      type: 'openEntry',
      entryId: '22222222-2222-4222-8222-222222222222',
      envelope: {},
      ciphertext: 'AA',
    });
    expect(staleOpenRes).toMatchObject({
      ok: false,
      error: { code: 'STALE_GENERATION' },
    });
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
      client.createVault({
        passphrase: 'test-passphrase',
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });
    expect(brokenShim.core.inspectClosureVkForTest()).toBeNull();

    // 1b. createVault fails when private_keys_wrapped re-open mismatches public keys / seeds
    corruptKind = 'priv';
    await expect(
      client.createVault({
        passphrase: 'test-passphrase',
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });
    expect(brokenShim.core.inspectClosureVkForTest()).toBeNull();

    // 1c. createVault fails when RK wrap re-open mismatches VK
    corruptKind = 'rk';
    await expect(
      client.createVault({
        passphrase: 'test-passphrase',
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });
    expect(brokenShim.core.inspectClosureVkForTest()).toBeNull();

    // Allow createVault to succeed so we can test rewrap, makeRecoveryKeys, wrapForPasskey, wrapForDevice
    corruptKind = null;
    const created = await client.createVault({
      passphrase: 'test-passphrase',
      opGeneration: client.captureGeneration(),
    });

    // 2. rewrap fails on broken KEK wrap
    corruptKind = 'kek';
    await expect(
      client.rewrap({
        passphrase: 'new-passphrase',
        currentKdf: created.kdf,
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });

    // 3. makeRecoveryKeys fails on broken RK wrap
    corruptKind = 'rk';
    await expect(
      client.makeRecoveryKeys({
        slots: [1],
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });

    // 4. wrapForPasskey fails on broken PRF wrap
    corruptKind = 'prf';
    await expect(
      client.wrapForPasskey({
        pwk: new Uint8Array(32).fill(0x11),
        opGeneration: client.captureGeneration(),
      }),
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
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'WRAP_SELF_CHECK_FAILED',
    });

    void sodium;
  });

  it('transitions client to error state on Worker crash (including in-flight requests and onmessageerror), notifies reset to locked on retry, and ignores events from replaced Workers (BE1-9, FE1-12, FE1-20)', async () => {
    let pauseDerive = false;
    const deriveEntered = Promise.withResolvers<void>();

    const firstShim = createWorkerShim({
      deriveKek: async (s, pass, params) => {
        if (pauseDerive) {
          deriveEntered.resolve();
          // Hang until crash
          await new Promise(() => {});
        }
        return fastTestDeriveKek(s, pass, params);
      },
      recovery: testRecoveryAdapter,
    });
    activeShims.push(firstShim);
    let currentShim = firstShim;

    const states: string[] = [];
    const client = new CryptoClient({
      createWorker: () => currentShim.port,
      onStateChange: (st) => states.push(st),
    });

    const created = await client.createVault({
      passphrase: 'crash-test-passphrase',
      opGeneration: client.captureGeneration(),
    });
    expect(client.getState()).toBe('unlocked');

    // Start an in-flight request and simulate crash while it is pending (FE1-12)
    pauseDerive = true;
    const inFlightRewrap = client.rewrap({
      passphrase: 'in-flight-passphrase',
      currentKdf: created.kdf,
      opGeneration: client.captureGeneration(),
    });
    await deriveEntered.promise;

    currentShim.simulateCrash();
    await expect(inFlightRewrap).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });
    expect(client.getState()).toBe('error');
    expect(states.at(-1)).toBe('error');

    // Non-unlock commands must fail while in error state
    await expect(
      client.makeRecoveryKeys({
        slots: [1],
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });

    // Prepare fresh Worker instance for a lookup-only recovery retry after crash:
    // subscriber state MUST agree with client.getState() === 'locked' (BE1-9)
    pauseDerive = false;
    const secondShim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      recovery: testRecoveryAdapter,
    });
    activeShims.push(secondShim);
    currentShim = secondShim;

    const rk0 = created.recovery_keys[0]!;
    const lookupRes = await client.unlockRecovery({
      recoveryKey: rk0.display,
      opGeneration: client.captureGeneration(),
    });
    expect(lookupRes.lookup_hash).toBe(rk0.lookup_hash);
    expect(client.getState()).toBe('locked');
    expect(states.at(-1)).toBe('locked');

    // Late onerror / onmessageerror from the already-replaced firstShim must be ignored and NOT kill secondShim (FE1-20)
    const genBeforeStaleCrash = client.getGeneration();
    firstShim.simulateCrash();
    firstShim.simulateMessageError();
    expect(client.getState()).toBe('locked');
    expect(client.getGeneration()).toBe(genBeforeStaleCrash);

    // Unlock on secondShim succeeds
    await client.unlockPassphrase({
      passphrase: 'crash-test-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      opGeneration: client.captureGeneration(),
    });
    expect(client.getState()).toBe('unlocked');

    // Simulate onmessageerror crash on active Worker (FE1-12)
    secondShim.simulateMessageError();
    expect(client.getState()).toBe('error');
  });

  it('delivers lock/terminate/handleWorkerDeath teardown BEFORE notifying state observers, catches observer exceptions in setState, and makes lock() total including postMessage delivery failure (BE1-8, FE1-2, FE1-21, FE2-6, FE2-11a, FE2-11b, FE2-11h)', async () => {
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      recovery: testRecoveryAdapter,
    });
    activeShims.push(shim);

    let throwOnObserver = false;
    const client = new CryptoClient({
      createWorker: () => shim.port,
      onStateChange: () => {
        if (throwOnObserver) {
          throw new Error('Observer boom');
        }
      },
    });

    // 0. Throwing observer on createVault / unlock success path is caught inside setState so createVault does NOT reject or lose recovery keys (FE2-6)
    throwOnObserver = true;
    const created = await client.createVault({
      passphrase: 'observer-safety-passphrase',
      skipRecoveryKeys: true,
      opGeneration: client.captureGeneration(),
    });
    expect(created.kdf.ops).toBe(3);
    expect(client.getState()).toBe('unlocked');
    expect(shim.core.inspectClosureVkForTest()).not.toBeNull();

    // 1. Throwing onStateChange during lock() MUST NOT prevent lock command delivery or Worker VK wipe, and lock() must resolve (BE1-8, FE1-2)
    const lockRes = await client.lock();
    expect(lockRes.generation).toBeGreaterThan(0);
    expect(client.getState()).toBe('locked');
    expect(shim.core.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();
    throwOnObserver = false;

    // 2. Concurrent back-to-back lock() calls both resolve to the exact final generation and never reject with STALE_GENERATION (FE1-2, FE2-11h)
    await client.unlockPassphrase({
      passphrase: 'observer-safety-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      opGeneration: client.captureGeneration(),
    });
    const genBeforeConcurrentLock = client.getGeneration();
    const [l1, l2] = await Promise.all([client.lock(), client.lock()]);
    expect(l1.generation).toBe(genBeforeConcurrentLock + 2);
    expect(l2.generation).toBe(genBeforeConcurrentLock + 2);
    expect(shim.core.inspectClosureVkForTest()).toBeNull();

    // 3. Throwing onStateChange during terminate() and handleWorkerDeath() is caught by setState, still terminates the Worker, and settles pending requests (BE1-8, FE1-21, FE2-6, FE2-11b)
    let pauseDerive = true;
    let deriveStarted = Promise.withResolvers<void>();
    const termShim = createWorkerShim({
      deriveKek: async (s, pass, params) => {
        if (pauseDerive) {
          deriveStarted.resolve();
          await new Promise(() => {});
        }
        return fastTestDeriveKek(s, pass, params);
      },
    });
    activeShims.push(termShim);
    let terminatedCalled = false;
    const origTerminate = termShim.port.terminate?.bind(termShim.port);
    termShim.port.terminate = () => {
      terminatedCalled = true;
      origTerminate?.();
    };

    const termClient = new CryptoClient({
      createWorker: () => termShim.port,
      onStateChange: () => {
        if (throwOnObserver) {
          throw new Error('Teardown observer boom');
        }
      },
    });

    const pendingUnlock = termClient.unlockPassphrase({
      passphrase: 'observer-safety-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      opGeneration: termClient.captureGeneration(),
    });
    await deriveStarted.promise;

    throwOnObserver = true;
    expect(() => termClient.terminate()).not.toThrow();
    expect(termClient.getState()).toBe('locked');
    expect(terminatedCalled).toBe(true);
    await expect(pendingUnlock).rejects.toMatchObject({
      code: 'STALE_GENERATION',
    });

    // 3b. Throwing observer during handleWorkerDeath (FE2-11b)
    deriveStarted = Promise.withResolvers<void>();
    const deathShim = createWorkerShim({
      deriveKek: async (s, pass, params) => {
        if (pauseDerive) {
          deriveStarted.resolve();
          await new Promise(() => {});
        }
        return fastTestDeriveKek(s, pass, params);
      },
    });
    activeShims.push(deathShim);
    let deathTerminated = false;
    const origDeathTerminate = deathShim.port.terminate?.bind(deathShim.port);
    deathShim.port.terminate = () => {
      deathTerminated = true;
      origDeathTerminate?.();
    };
    const deathClient = new CryptoClient({
      createWorker: () => deathShim.port,
      onStateChange: () => {
        if (throwOnObserver) {
          throw new Error('Death observer boom');
        }
      },
    });
    throwOnObserver = false;
    const pendingDeathUnlock = deathClient.unlockPassphrase({
      passphrase: 'observer-safety-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      opGeneration: deathClient.captureGeneration(),
    });
    await deriveStarted.promise;
    throwOnObserver = true;
    expect(() => deathShim.simulateCrash()).not.toThrow();
    throwOnObserver = false;
    expect(deathTerminated).toBe(true);
    expect(deathClient.getState()).toBe('error');
    await expect(pendingDeathUnlock).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });

    // 4. lock() delivery-failure branch (client.ts:949-973): when activeWorker.postMessage throws during lock(),
    //    terminates worker, settles in-flight requests with WORKER_CRASHED, transitions to 'error', and resolves lock() (FE2-11a)
    deriveStarted = Promise.withResolvers<void>();
    const lockFailShim = createWorkerShim({
      deriveKek: async (s, pass, params) => {
        if (pauseDerive) {
          deriveStarted.resolve();
          await new Promise(() => {});
        }
        return fastTestDeriveKek(s, pass, params);
      },
    });
    activeShims.push(lockFailShim);
    let lockFailTerminated = false;
    const origLockFailTerminate = lockFailShim.port.terminate?.bind(lockFailShim.port);
    lockFailShim.port.terminate = () => {
      lockFailTerminated = true;
      origLockFailTerminate?.();
    };
    const lockFailClient = new CryptoClient({
      createWorker: () => lockFailShim.port,
      onStateChange: () => {
        if (throwOnObserver) {
          throw new Error('Lock fail observer boom');
        }
      },
    });
    const inFlightBeforeLockFail = lockFailClient.unlockPassphrase({
      passphrase: 'observer-safety-passphrase',
      kdf: created.kdf,
      vaultKeyWrappedByKek: created.vault_key_wrapped_by_kek,
      opGeneration: lockFailClient.captureGeneration(),
    });
    await deriveStarted.promise;

    // Force postMessage to throw on the next call (the lock command)
    lockFailShim.port.postMessage = () => {
      throw new Error('Port closed before lock delivery');
    };
    throwOnObserver = true;
    const lockFailResult = await lockFailClient.lock();
    throwOnObserver = false;
    pauseDerive = false;

    expect(lockFailResult.generation).toBeGreaterThan(0);
    expect(lockFailTerminated).toBe(true);
    expect(lockFailClient.getState()).toBe('error');
    await expect(inFlightBeforeLockFail).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });
  });

  it('wipes caller secret buffers on every failure path (rejected beforePostMessage, Worker constructor throw, postMessage DataCloneError) and rejects empty/detached secrets with SECRET_DETACHED_OR_EMPTY (BE1-6, BE1-16, BE1-28, FE1-9)', async () => {
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      recovery: testRecoveryAdapter,
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    // 1. Empty string, empty Uint8Array, empty ArrayBuffer, and already-detached Uint8Array -> SECRET_DETACHED_OR_EMPTY
    await expect(
      client.createVault({
        passphrase: '',
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({ code: 'SECRET_DETACHED_OR_EMPTY' });

    await expect(
      client.createVault({
        passphrase: new Uint8Array(0),
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({ code: 'SECRET_DETACHED_OR_EMPTY' });

    await expect(
      client.unlockPrf({
        pwk: new ArrayBuffer(0),
        vkWrap: 'AA',
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({ code: 'SECRET_DETACHED_OR_EMPTY' });

    // Create a genuinely detached ArrayBuffer via MessageChannel transfer
    const { port1 } = new MessageChannel();
    const detachedSource = new Uint8Array([1, 2, 3, 4]);
    port1.postMessage(detachedSource.buffer, [detachedSource.buffer]);
    port1.close();
    expect(detachedSource.buffer.byteLength).toBe(0);

    await expect(
      client.unlockRecovery({
        recoveryKey: detachedSource,
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({ code: 'SECRET_DETACHED_OR_EMPTY' });

    // 2. Rejected beforePostMessage wipes caller's passphrase, RK, and PWK buffers in place (BE1-6, BE1-16, BE1-28)
    const abortErr = new DOMException('Aborted by user', 'AbortError');
    const passBufAbort = new Uint8Array([10, 20, 30, 40]);
    await expect(
      client.createVault({
        passphrase: passBufAbort,
        opGeneration: client.captureGeneration(),
        beforePostMessage: async () => {
          throw abortErr;
        },
      }),
    ).rejects.toBe(abortErr);
    expect(passBufAbort.every((b) => b === 0)).toBe(true);

    const rkBufAbort = new Uint8Array([50, 60, 70, 80]);
    await expect(
      client.unlockRecovery({
        recoveryKey: rkBufAbort,
        opGeneration: client.captureGeneration(),
        beforePostMessage: async () => {
          throw abortErr;
        },
      }),
    ).rejects.toBe(abortErr);
    expect(rkBufAbort.every((b) => b === 0)).toBe(true);

    const pwkBufAbort = new Uint8Array(32).fill(0xaa);
    await expect(
      client.unlockPrf({
        pwk: pwkBufAbort,
        vkWrap: 'AA',
        opGeneration: client.captureGeneration(),
        beforePostMessage: async () => {
          throw abortErr;
        },
      }),
    ).rejects.toBe(abortErr);
    expect(pwkBufAbort.every((b) => b === 0)).toBe(true);

    // 2b. Also verify the remaining 3 secret-taking methods (unlockPassphrase, rewrap, wrapForPasskey) wipe buffers on rejected beforePostMessage (FE2-11d),
    //     and unlockPassphraseNow({ beforePostMessage: () => client.lock() }) rejects with STALE_GENERATION and wipes the buffer (FE2-1)
    const unlockPassAbortBuf = new Uint8Array([1, 2, 3, 4, 5]);
    await expect(
      client.unlockPassphrase({
        passphrase: unlockPassAbortBuf,
        kdf: {},
        vaultKeyWrappedByKek: 'AA',
        opGeneration: client.captureGeneration(),
        beforePostMessage: async () => {
          throw abortErr;
        },
      }),
    ).rejects.toBe(abortErr);
    expect(unlockPassAbortBuf.every((b) => b === 0)).toBe(true);

    const rewrapAbortBuf = new Uint8Array([6, 7, 8, 9, 10]);
    await expect(
      client.rewrap({
        passphrase: rewrapAbortBuf,
        currentKdf: {},
        opGeneration: client.captureGeneration(),
        beforePostMessage: async () => {
          throw abortErr;
        },
      }),
    ).rejects.toBe(abortErr);
    expect(rewrapAbortBuf.every((b) => b === 0)).toBe(true);

    const wrapPwkAbortBuf = new Uint8Array(32).fill(0xcd);
    await expect(
      client.wrapForPasskey({
        pwk: wrapPwkAbortBuf,
        opGeneration: client.captureGeneration(),
        beforePostMessage: async () => {
          throw abortErr;
        },
      }),
    ).rejects.toBe(abortErr);
    expect(wrapPwkAbortBuf.every((b) => b === 0)).toBe(true);

    const nowLockPassBuf = new Uint8Array([91, 92, 93, 94]);
    await expect(
      client.unlockPassphraseNow({
        passphrase: nowLockPassBuf,
        kdf: {},
        vaultKeyWrappedByKek: 'AA',
        beforePostMessage: async () => {
          await client.lock();
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_GENERATION' });
    expect(nowLockPassBuf.every((b) => b === 0)).toBe(true);

    // 3. Worker constructor throw wipes caller secret buffer
    const throwingFactoryClient = new CryptoClient({
      createWorker: () => {
        throw new Error('CSP blocked Worker creation');
      },
    });
    const passBufCtorFail = new Uint8Array([11, 22, 33, 44]);
    await expect(
      throwingFactoryClient.createVault({
        passphrase: passBufCtorFail,
        opGeneration: throwingFactoryClient.captureGeneration(),
      }),
    ).rejects.toMatchObject({ code: 'WORKER_INTERNAL_ERROR' });
    expect(passBufCtorFail.every((b) => b === 0)).toBe(true);

    // 4. postMessage synchronous throw (DataCloneError / transfer failure) wipes caller secret buffer and maps DataCloneError to SECRET_DETACHED_OR_EMPTY
    const throwingPostMessageClient = new CryptoClient({
      createWorker: () => ({
        postMessage: () => {
          const err = new Error('ArrayBuffer could not be cloned');
          err.name = 'DataCloneError';
          throw err;
        },
        onmessage: null,
      }),
    });
    const pwkBufCloneFail = new Uint8Array(32).fill(0xbb);
    await expect(
      throwingPostMessageClient.wrapForPasskey({
        pwk: pwkBufCloneFail,
        opGeneration: throwingPostMessageClient.captureGeneration(),
      }),
    ).rejects.toMatchObject({ code: 'SECRET_DETACHED_OR_EMPTY' });
    expect(pwkBufCloneFail.every((b) => b === 0)).toBe(true);
  });

  it('wipes incoming secret buffers in the Worker when sodium.ready rejects once, retries getSodium() without resetSodiumForTest, and transitions CryptoClient to error on WORKER_INIT_FAILED before spawning a fresh Worker (BE1-17, FE1-8, FE2-4, T-r2-1)', async () => {
    const realSodium = await getSodium();
    const origReady = rawSodium.ready;

    // 1. Real sodium.ready reject-once-then-resolve test WITHOUT calling resetSodiumForTest between failure and retry (FE2-4, T-r2-1).
    //    If `.catch(() => { readyPromise = null; ... })` is removed from sodium.ts, the second getSodium() call will fail!
    resetSodiumForTest();
    let readyAccessCount = 0;
    Object.defineProperty(rawSodium, 'ready', {
      configurable: true,
      get() {
        readyAccessCount += 1;
        if (readyAccessCount === 1) {
          return Promise.reject(new Error('Simulated transient WASM instantiate OOM'));
        }
        return origReady;
      },
    });

    try {
      const zeroedKinds: string[] = [];
      const core = createWorkerCore({
        deriveKek: fastTestDeriveKek,
        onKeyZeroed: (kind) => zeroedKinds.push(kind),
      });

      const incomingPwk = new Uint8Array(32).fill(0xcc);
      const failRes = await core.handleMessage({
        id: 1,
        generation: 0,
        type: 'unlockPrf',
        pwkBuffer: incomingPwk.buffer,
        vkWrap: 'AA',
      });

      expect(failRes).toMatchObject({
        ok: false,
        error: { code: 'WORKER_INIT_FAILED' },
      });
      expect(incomingPwk.every((b) => b === 0)).toBe(true);
      expect(zeroedKinds).toContain('pwk');

      // Retry getSodium() directly WITHOUT calling resetSodiumForTest() — proves sodium.ts cleared readyPromise in .catch
      const sAfterRetry = await getSodium();
      expect(sAfterRetry).toBe(realSodium);
      expect(readyAccessCount).toBe(2);
    } finally {
      Object.defineProperty(rawSodium, 'ready', {
        configurable: true,
        writable: true,
        value: origReady,
      });
    }

    // 2. Client test for WORKER_INIT_FAILED: Worker reply transitions client to 'error', rejects request with WORKER_INIT_FAILED,
    //    terminates the failed Worker, and spawns a fresh Worker on the next unlock (FE2-4)
    resetSodiumForTest();
    let clientReadyAccess = 0;
    Object.defineProperty(rawSodium, 'ready', {
      configurable: true,
      get() {
        clientReadyAccess += 1;
        if (clientReadyAccess === 1) {
          return Promise.reject(new Error('Worker init failed on first spawn'));
        }
        return origReady;
      },
    });

    try {
      const createdShims: ShimmedWorkerInstance[] = [];
      const observedStates: string[] = [];
      const initFailClient = new CryptoClient({
        createWorker: () => {
          const s = createWorkerShim({
            deriveKek: fastTestDeriveKek,
            recovery: testRecoveryAdapter,
          });
          activeShims.push(s);
          createdShims.push(s);
          return s.port;
        },
        onStateChange: (st) => observedStates.push(st),
      });

      const passBuf = new Uint8Array(utf8Encoder.encode('init-fail-passphrase'));
      await expect(
        initFailClient.createVault({
          passphrase: passBuf,
          skipRecoveryKeys: true,
          opGeneration: initFailClient.captureGeneration(),
        }),
      ).rejects.toMatchObject({
        code: 'WORKER_INIT_FAILED',
      });
      expect(initFailClient.getState()).toBe('error');
      expect(observedStates).toContain('error');
      expect(createdShims).toHaveLength(1);

      // Next unlock/createVault spawns a fresh Worker (createdShims.length === 2) and succeeds
      const createdAfterRetry = await initFailClient.createVault({
        passphrase: 'init-retry-passphrase',
        skipRecoveryKeys: true,
        opGeneration: initFailClient.captureGeneration(),
      });
      expect(createdAfterRetry.kdf.ops).toBe(3);
      expect(createdShims).toHaveLength(2);
      expect(initFailClient.getState()).toBe('unlocked');
    } finally {
      Object.defineProperty(rawSodium, 'ready', {
        configurable: true,
        writable: true,
        value: origReady,
      });
    }
  });

  it('correlates overlapping concurrent commands when replies arrive out-of-order, guards wrapForDevice against concurrent VK swap, and handles unknown commands/malformed generations (FE1-12, FE1-17, FE1-18, FE1-22, FE2-11c)', async () => {
    const sodium = await getSodium();
    let gateFirstDevKey = false;
    const firstSealEntered = Promise.withResolvers<void>();
    const releaseFirstSeal = Promise.withResolvers<void>();

    let delayFirstOpen = false;
    const firstOpenParked = Promise.withResolvers<void>();
    const releaseFirstOpen = Promise.withResolvers<void>();

    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      recovery: testRecoveryAdapter,
      sealDevKeyWrap: async (s, vk, devKey, userId, vaultKeyId) => {
        if (gateFirstDevKey) {
          gateFirstDevKey = false;
          firstSealEntered.resolve();
          await releaseFirstSeal.promise;
        }
        return sealDevKeyWrap(s, vk, devKey, userId, vaultKeyId);
      },
    });
    activeShims.push(shim);

    // Wrap workerScope.postMessage to hold the first openEntry response until after the second openEntry response is sent,
    // proving true out-of-order request-ID correlation rather than FIFO matching (FE2-11c)
    const origWorkerPost = shim.port;
    void origWorkerPost;
    const replyOrder: number[] = [];
    let heldResponse: (() => void) | null = null;
    const customClientPort: typeof shim.port = {
      postMessage: (msg, transfer) => shim.port.postMessage(msg, transfer),
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminate: () => shim.port.terminate?.(),
    };
    shim.port.onmessage = (ev) => {
      if (delayFirstOpen && !heldResponse) {
        delayFirstOpen = false;
        firstOpenParked.resolve();
        heldResponse = () => {
          replyOrder.push(ev.data.id);
          customClientPort.onmessage?.(ev);
        };
        void releaseFirstOpen.promise.then(() => {
          heldResponse?.();
        });
        return;
      }
      replyOrder.push(ev.data.id);
      customClientPort.onmessage?.(ev);
    };

    const client = new CryptoClient({ createWorker: () => customClientPort });

    await client.createVault({
      passphrase: 'overlap-passphrase-1',
      skipRecoveryKeys: true,
      opGeneration: client.captureGeneration(),
    });

    const entryId1 = '11111111-1111-4111-8111-111111111111';
    const entryId2 = '22222222-2222-4222-8222-222222222222';
    const keyId = 'vk:0123456789abcdefghijkl';

    const [s1, s2] = await Promise.all([
      client.sealEntryNow({ entryId: entryId1, keyId, plaintext: 'payload-one' }),
      client.sealEntryNow({ entryId: entryId2, keyId, plaintext: 'payload-two' }),
    ]);

    // 1. Out-of-order replies: request 1 is parked while request 2 replies first; both resolve to their exact callers (FE1-12, FE2-11c)
    replyOrder.length = 0;
    delayFirstOpen = true;
    const pOpen1 = client.openEntryNow({
      entryId: entryId1,
      envelope: s1.envelope,
      ciphertext: s1.ciphertext,
    });
    await firstOpenParked.promise;
    const o2 = await client.openEntryNow({
      entryId: entryId2,
      envelope: s2.envelope,
      ciphertext: s2.ciphertext,
    });
    expect(o2.plaintext).toBe('payload-two');
    releaseFirstOpen.resolve();
    const o1 = await pOpen1;
    expect(o1.plaintext).toBe('payload-one');
    // Reply for request 2 arrived BEFORE reply for request 1
    expect(replyOrder).toHaveLength(2);
    expect(replyOrder[0]).toBeGreaterThan(replyOrder[1]!);

    // 2. wrapForDevice re-checks active VK after await so a concurrent unlock replacing VK mid-await is rejected (FE1-22)
    const devKey = await generateTestDevKey();
    gateFirstDevKey = true;
    const wrapDevPromise = client.wrapForDeviceNow({
      devKey,
      userId: entryId1,
      vaultKeyId: keyId,
    });
    await firstSealEntered.promise;

    // Concurrent createVault at the same generation replaces closure VK while wrapForDevice is parked at await
    await client.createVaultNow({
      passphrase: 'overlap-passphrase-2',
      skipRecoveryKeys: true,
    });
    releaseFirstSeal.resolve();

    await expect(wrapDevPromise).rejects.toMatchObject({
      code: 'STALE_GENERATION',
    });
    // 3. Unknown command type -> NOT_IMPLEMENTED; non-integer generation -> STALE_GENERATION (FE1-18)
    const unknownRes = await shim.core.handleMessage({
      id: 777,
      generation: shim.core.getGeneration(),
      type: 'unknownCommand' as unknown as 'lock',
    });
    expect(unknownRes).toMatchObject({
      ok: false,
      error: { code: 'NOT_IMPLEMENTED' },
    });

    const nanGenRes = await shim.core.handleMessage({
      id: 778,
      generation: Number.NaN,
      type: 'makeRecoveryKeys',
    });
    expect(nanGenRes).toMatchObject({
      ok: false,
      error: { code: 'STALE_GENERATION' },
    });

    // 4. attachWorkerCore catches a throwing scope.postMessage and falls back to an error response without unhandled rejection (FE1-17)
    const postedResponses: unknown[] = [];
    const fallbackPosted = Promise.withResolvers<void>();
    let throwFirstPost = true;
    const mockScope = {
      onmessage: null as ((ev: MessageEvent<WorkerRequestMessage>) => void) | null,
      postMessage(msg: unknown) {
        if (throwFirstPost) {
          throwFirstPost = false;
          throw new Error('Clone failed on response');
        }
        postedResponses.push(msg);
        fallbackPosted.resolve();
      },
    };
    attachWorkerCore(mockScope, shim.core);
    mockScope.onmessage?.({
      data: { id: 888, generation: shim.core.getGeneration(), type: 'lock' },
    } as MessageEvent<WorkerRequestMessage>);
    await fallbackPosted.promise;
    expect(postedResponses).toHaveLength(1);
    expect(postedResponses[0]).toMatchObject({
      id: 888,
      ok: false,
      error: { code: 'WORKER_INTERNAL_ERROR' },
    });

    void sodium;
  });

  it('enforces strict import allowlist on client.ts and protocol.ts, works without Promise.withResolvers, and requires opGeneration in TypeScript on all 13 command params (FE1-3, FE1-4, FE1-6, FE1-19, FE2-1, FE2-7)', async () => {
    // 1. Strict import allowlist on client.ts and protocol.ts (FE2-7):
    //    - protocol.ts must contain ZERO import/export-from statements and zero dynamic import()/require() calls.
    //    - client.ts static import/export-from specifiers must ONLY be './protocol', and dynamic new URL(...) only './worker.ts'.
    const clientSource = readFileSync(resolve(__dirname, './client.ts'), 'utf8');
    const protocolSource = readFileSync(resolve(__dirname, './protocol.ts'), 'utf8');

    const extractSpecifiers = (src: string): string[] => {
      const specs: string[] = [];
      const fromRe = /^(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gm;
      const sideEffectImportRe = /^import\s*['"]([^'"]+)['"]/gm;
      const dynamicImportRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      for (const re of [fromRe, sideEffectImportRe, dynamicImportRe]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          specs.push(m[1]!);
        }
      }
      return specs;
    };

    expect(extractSpecifiers(protocolSource)).toEqual([]);
    expect(extractSpecifiers(clientSource)).toEqual(['./protocol']);

    // Verify removed *Now methods do not exist on CryptoClient prototype (FE2-1)
    expect('confirmRecoveryNow' in CryptoClient.prototype).toBe(false);
    expect('resumeRecoveryNow' in CryptoClient.prototype).toBe(false);
    expect('unlockPrfNow' in CryptoClient.prototype).toBe(false);
    expect('unlockDevKeyNow' in CryptoClient.prototype).toBe(false);
    expect('wrapForPasskeyNow' in CryptoClient.prototype).toBe(false);

    // 2. Dynamic import intentionally exercises module loading boundary of worker.ts in a main-thread/jsdom environment where window exists (FE1-19)
    const prevWindowOnMessage = globalThis.onmessage;
    await import('./worker');
    expect(globalThis.onmessage).toBe(prevWindowOnMessage);

    // 3. CryptoClient works when Promise.withResolvers is absent (iOS Safari < 17.4, FE1-6)
    const origWithResolvers = Promise.withResolvers;
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      recovery: testRecoveryAdapter,
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    try {
      // @ts-expect-error Simulating pre-ES2024 browser without Promise.withResolvers
      Promise.withResolvers = undefined;
      const created = await client.createVault({
        passphrase: 'no-with-resolvers-passphrase',
        skipRecoveryKeys: true,
        opGeneration: client.captureGeneration(),
      });
      expect(created.kdf.ops).toBe(3);
    } finally {
      Promise.withResolvers = origWithResolvers;
    }

    // 4. Type-level proof that opGeneration is required on ALL 13 *ClientParams interfaces, and makeRecoveryKeysNow has no {} default (FE1-3, FE2-1)
    if (false as boolean) {
      const dummyDevKey = {} as CryptoKey;
      // @ts-expect-error opGeneration is required on createVault
      await client.createVault({ passphrase: 'missing-op-generation' });
      // @ts-expect-error opGeneration is required on unlockPassphrase
      await client.unlockPassphrase({
        passphrase: 'missing-op-generation',
        kdf: {},
        vaultKeyWrappedByKek: 'AA',
      });
      // @ts-expect-error opGeneration is required on unlockRecovery
      await client.unlockRecovery({ recoveryKey: 'rk1_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4' });
      // @ts-expect-error opGeneration is required on resumeRecovery
      await client.resumeRecovery({ wrap: 'AA' });
      // @ts-expect-error opGeneration is required on confirmRecovery
      await client.confirmRecovery({});
      // @ts-expect-error opGeneration is required on unlockPrf
      await client.unlockPrf({ pwk: new Uint8Array(32), vkWrap: 'AA' });
      // @ts-expect-error opGeneration is required on unlockDevKey
      await client.unlockDevKey({
        devKey: dummyDevKey,
        wrappedVk: 'AA',
        userId: 'u1',
        vaultKeyId: 'vk:1',
      });
      // @ts-expect-error opGeneration is required on rewrap
      await client.rewrap({ passphrase: 'new', currentKdf: {} });
      // @ts-expect-error opGeneration is required on makeRecoveryKeys
      await client.makeRecoveryKeys({ slots: [1] });
      // @ts-expect-error makeRecoveryKeysNow requires params object (no {} default)
      await client.makeRecoveryKeysNow();
      // @ts-expect-error opGeneration is required on wrapForPasskey
      await client.wrapForPasskey({ pwk: new Uint8Array(32) });
      // @ts-expect-error opGeneration is required on wrapForDevice
      await client.wrapForDevice({ devKey: dummyDevKey, userId: 'u1', vaultKeyId: 'vk:1' });
      // @ts-expect-error opGeneration is required on sealEntry
      await client.sealEntry({ entryId: 'e1', keyId: 'vk:1', plaintext: 'pt' });
      // @ts-expect-error opGeneration is required on openEntry
      await client.openEntry({ entryId: 'e1', envelope: {}, ciphertext: 'AA' });
    }
  });

  it('verifies default recovery.ts and envelope.ts adapters and scopes TypeError mapping to sealEntry/openEntry while testing each mapError class (FE1-23, FE2-9)', async () => {
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

    // Exercise each mapError class separately: Base64UrlError -> ENVELOPE_INVALID, JcsError -> ENVELOPE_INVALID,
    // TypeError on openEntry/sealEntry -> ENVELOPE_INVALID, TypeError on non-entry commands -> WORKER_INTERNAL_ERROR (FE2-9)
    let mode: 'b64' | 'jcs' | 'type' = 'b64';
    const errCore = createWorkerCore({
      deriveKek: fastTestDeriveKek,
      envelope: {
        validateEntryEnvelope: (input) => {
          if (mode === 'b64') {
            throw new Base64UrlError('bad base64url');
          }
          if (mode === 'type') {
            throw new TypeError('bad envelope type');
          }
          return validateEntryEnvelope(input);
        },
        canonicalizeEnvelopeJcs: () => {
          throw new JcsError('bad jcs');
        },
      },
      sealDevKeyWrap: async () => {
        throw new TypeError('Invalid CryptoKey provided to WebCrypto');
      },
    });
    await errCore.handleMessage({
      id: 1,
      generation: 0,
      type: 'createVault',
      passphraseBuffer: utf8Encoder.encode('pass').buffer,
      skipRecoveryKeys: true,
    });

    // 1. Base64UrlError -> ENVELOPE_INVALID
    mode = 'b64';
    const b64ErrRes = await errCore.handleMessage({
      id: 2,
      generation: 0,
      type: 'openEntry',
      entryId: '00000000-0000-4000-8000-000000000000',
      envelope: validEnv,
      ciphertext: 'AA',
    });
    expect(b64ErrRes).toMatchObject({
      ok: false,
      error: { code: 'ENVELOPE_INVALID', message: 'bad base64url' },
    });

    // 2. JcsError -> ENVELOPE_INVALID
    mode = 'jcs';
    const jcsErrRes = await errCore.handleMessage({
      id: 3,
      generation: 0,
      type: 'openEntry',
      entryId: '00000000-0000-4000-8000-000000000000',
      envelope: validEnv,
      ciphertext: 'AA',
    });
    expect(jcsErrRes).toMatchObject({
      ok: false,
      error: { code: 'ENVELOPE_INVALID', message: 'bad jcs' },
    });

    // 3. TypeError on openEntry / sealEntry -> ENVELOPE_INVALID
    mode = 'type';
    const typeEntryErrRes = await errCore.handleMessage({
      id: 4,
      generation: 0,
      type: 'sealEntry',
      entryId: '00000000-0000-4000-8000-000000000000',
      keyId: 'vk:0123456789abcdefghijkl',
      plaintext: 'hello',
    });
    expect(typeEntryErrRes).toMatchObject({
      ok: false,
      error: { code: 'ENVELOPE_INVALID' },
    });

    // 4. TypeError on a non-entry command (wrapForDevice / unlockDevKey) -> WORKER_INTERNAL_ERROR, NOT ENVELOPE_INVALID (FE2-9)
    const devKey = await generateTestDevKey();
    const typeNonEntryErrRes = await errCore.handleMessage({
      id: 5,
      generation: 0,
      type: 'wrapForDevice',
      devKey,
      userId: '00000000-0000-4000-8000-000000000000',
      vaultKeyId: 'vk:0123456789abcdefghijkl',
    });
    expect(typeNonEntryErrRes).toMatchObject({
      ok: false,
      error: { code: 'WORKER_INTERNAL_ERROR' },
    });
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
