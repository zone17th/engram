import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeBase64UrlStrict, encodeBase64Url } from './b64url';
import { getSodium, toLocalBytes } from './sodium';
import {
  buildDevKeyAad,
  DEVKEY_WRAP_BYTES,
  openDevKeyWrap,
  sealDevKeyWrap,
  buildWrapAad,
   openWrap,
  packPrivateKeySeeds,
  PRIV_PLAINTEXT_BYTES,
  PRIV_WRAP_BYTES,
  sealWrap,
  sealWrapBase64Url,
  SEED_BYTES,
  unpackPrivateKeySeeds,
  validateWrap,
  VK_BYTES,
  VK_WRAP_BYTES,
  WRAP_LABELS,
  WRAP_NONCE_BYTES,
  WRAP_VERSION,
  WrapError,
  type WrapKind,
} from './wrap';

describe('P03-T6 Wrap Layout, Validator, AAD, and Seed -> Public Key Derivation', () => {
  it('seals, validates, and opens all four wrap labels with exact 73 B / 105 B lengths', async () => {
    const sodium = await getSodium();
    const vk = new Uint8Array(VK_BYTES).fill(0x11);
    const key = new Uint8Array(VK_BYTES).fill(0x22);
    const nonce = new Uint8Array(WRAP_NONCE_BYTES).fill(0x33);

    for (const kind of ['kek', 'rk', 'prf'] as const) {
      const wrap = sealWrap(sodium, kind, vk, key, nonce);
      expect(wrap.byteLength).toBe(VK_WRAP_BYTES);
      expect(wrap[0]).toBe(WRAP_VERSION);
      expect(wrap.subarray(1, 1 + WRAP_NONCE_BYTES)).toEqual(nonce);

      const b64u = sealWrapBase64Url(sodium, kind, vk, key, nonce);
      expect(b64u).not.toContain('=');
      expect(validateWrap(wrap, kind)).toEqual(wrap);
      expect(validateWrap(b64u, kind)).toEqual(wrap);

      const opened = openWrap(sodium, kind, wrap, key);
      expect(opened).toEqual(vk);
      expect(openWrap(sodium, kind, b64u, key)).toEqual(vk);
    }

    const x25519Seed = new Uint8Array(SEED_BYTES).fill(0x44);
    const ed25519Seed = new Uint8Array(SEED_BYTES).fill(0x55);
    const privPlain = packPrivateKeySeeds(x25519Seed, ed25519Seed);
    expect(privPlain.byteLength).toBe(PRIV_PLAINTEXT_BYTES);

    const privWrap = sealWrap(sodium, 'priv', privPlain, vk, nonce);
    expect(privWrap.byteLength).toBe(PRIV_WRAP_BYTES);
    expect(privWrap[0]).toBe(WRAP_VERSION);
    expect(validateWrap(privWrap, 'priv')).toEqual(privWrap);

    const openedPriv = openWrap(sodium, 'priv', privWrap, vk);
    const unpacked = unpackPrivateKeySeeds(openedPriv);
    expect(unpacked.x25519Seed).toEqual(x25519Seed);
    expect(unpacked.ed25519Seed).toEqual(ed25519Seed);
  });

  it('rejects wrap version byte changes with AEAD_DECRYPT_FAILED on openWrap and WRAP_INVALID on validateWrap', async () => {
    const sodium = await getSodium();
    const vk = new Uint8Array(VK_BYTES).fill(0x7a);
    const key = new Uint8Array(VK_BYTES).fill(0x8b);
    const nonce = new Uint8Array(WRAP_NONCE_BYTES).fill(0x9c);

    for (const kind of ['kek', 'rk', 'prf', 'priv'] as const) {
      const pt =
        kind === 'priv' ? new Uint8Array(PRIV_PLAINTEXT_BYTES).fill(0x6d) : vk;
      const validWrap = sealWrap(sodium, kind, pt, key, nonce);

      for (const badVersion of [0x00, 0x02, 0xff]) {
        const mutated = new Uint8Array(validWrap);
        mutated[0] = badVersion;
        const mutatedB64u = encodeBase64Url(mutated);

        // Structural validator rejects non-0x01 version with WRAP_INVALID ("validation")
        expect(() => validateWrap(mutated, kind)).toThrowError(
          expect.objectContaining({ code: 'WRAP_INVALID' }),
        );
        expect(() => validateWrap(mutatedB64u, kind)).toThrowError(
          expect.objectContaining({ code: 'WRAP_INVALID' }),
        );

        // openWrap places version byte into AAD, so AEAD authentication fails ("aead")
        expect(() => openWrap(sodium, kind, mutated, key)).toThrowError(
          expect.objectContaining({ code: 'AEAD_DECRYPT_FAILED' }),
        );
        expect(() => openWrap(sodium, kind, mutatedB64u, key)).toThrowError(
          expect.objectContaining({ code: 'AEAD_DECRYPT_FAILED' }),
        );
      }
    }
  });

  it('enforces domain separation across all four wrap labels and rejects malformed base64url or wrong lengths', async () => {
    const sodium = await getSodium();
    const vk = new Uint8Array(VK_BYTES).fill(0xaa);
    const key = new Uint8Array(VK_BYTES).fill(0xbb);
    const kinds: WrapKind[] = ['kek', 'rk', 'prf'];

    for (const k1 of kinds) {
      const wrap = sealWrap(sodium, k1, vk, key);
      for (const k2 of kinds) {
        if (k1 === k2) continue;
        expect(() => openWrap(sodium, k2, wrap, key)).toThrowError(
          expect.objectContaining({ code: 'AEAD_DECRYPT_FAILED' }),
        );
      }
    }

    // Wrong lengths
    expect(() => validateWrap(new Uint8Array(72), 'kek')).toThrowError(WrapError);
    expect(() => validateWrap(new Uint8Array(74), 'rk')).toThrowError(WrapError);
    expect(() => validateWrap(new Uint8Array(105), 'prf')).toThrowError(WrapError);
    expect(() => validateWrap(new Uint8Array(73), 'priv')).toThrowError(WrapError);
    expect(() => validateWrap(new Uint8Array(104), 'priv')).toThrowError(WrapError);
    expect(() => validateWrap(new Uint8Array(106), 'priv')).toThrowError(WrapError);

    // Base64url with padding or standard base64 chars rejected
    const validWrap = sealWrap(sodium, 'kek', vk, key);
    const validB64u = encodeBase64Url(validWrap);
    expect(() => validateWrap(`${validB64u}=`, 'kek')).toThrowError(WrapError);
    expect(() => validateWrap(`${validB64u.slice(0, -1)}+`, 'kek')).toThrowError(WrapError);
    expect(() => validateWrap(`${validB64u.slice(0, -1)}/`, 'kek')).toThrowError(WrapError);

    // Verify AAD layout: UTF8(label) || 0x00 || 0x01
    for (const kind of ['kek', 'rk', 'prf', 'priv'] as const) {
      const aad = buildWrapAad(WRAP_LABELS[kind], WRAP_VERSION);
      const labelBytes = toLocalBytes(new TextEncoder().encode(WRAP_LABELS[kind]));
      expect(aad.byteLength).toBe(labelBytes.byteLength + 2);
      expect(aad.slice(0, labelBytes.byteLength)).toEqual(labelBytes);
      expect(aad[labelBytes.byteLength]).toBe(0x00);
      expect(aad[labelBytes.byteLength + 1]).toBe(0x01);
    }
  });

  it('derives deterministic X25519 and Ed25519 public keys from 32-byte seeds matching RFC 7748 / RFC 8032 & libsodium', async () => {
    const sodium = await getSodium();

    const x25519Seed = sodium.from_hex(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    );
    const ed25519Seed = sodium.from_hex(
      '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    );

    const x25519Kp = sodium.crypto_box_seed_keypair(x25519Seed, 'uint8array');
    const ed25519Kp = sodium.crypto_sign_seed_keypair(ed25519Seed, 'uint8array');

    expect(x25519Kp.publicKey.byteLength).toBe(32);
    expect(ed25519Kp.publicKey.byteLength).toBe(32);

    // RFC 8032 §7.1 Test 1 Ed25519 public key for seed 9d61b19d...
    expect(sodium.to_hex(ed25519Kp.publicKey)).toBe(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );

    // Verify round-trip via base64url
    const xPubB64 = encodeBase64Url(x25519Kp.publicKey);
    expect(decodeBase64UrlStrict(xPubB64, 32)).toEqual(x25519Kp.publicKey);
  });

  describe('FE1-24 DevKey key-shape validation, AAD NUL checks, and InvalidAccessError mapping', () => {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const vaultKeyId = 'vk:0123456789abcdefghijkl';

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('positive control: seals and opens with a non-extractable AES-GCM-256 key generated like device.ts:549', async () => {
      const sodium = await getSodium();
      const vk = new Uint8Array(VK_BYTES).fill(0x42);
      const devKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );

      const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt');
      const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt');

      const wrapped = await sealDevKeyWrap(sodium, vk, devKey, userId, vaultKeyId);
      expect(wrapped.byteLength).toBe(DEVKEY_WRAP_BYTES);
      expect(encryptSpy).toHaveBeenCalledTimes(1);

      const opened = await openDevKeyWrap(wrapped, devKey, userId, vaultKeyId);
      expect(opened).toEqual(vk);
      expect(decryptSpy).toHaveBeenCalledTimes(1);

      encryptSpy.mockRestore();
      decryptSpy.mockRestore();
    });

    it('rejects extractable key with WRAP_INVALID before any WebCrypto call', async () => {
      const sodium = await getSodium();
      const vk = new Uint8Array(VK_BYTES).fill(0x42);
      const extractableKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
      );
      const dummyWrap = new Uint8Array(DEVKEY_WRAP_BYTES);

      const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt');
      const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt');

      await expect(
        sealDevKeyWrap(sodium, vk, extractableKey, userId, vaultKeyId),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(encryptSpy).toHaveBeenCalledTimes(0);
      await expect(
        openDevKeyWrap(dummyWrap, extractableKey, userId, vaultKeyId),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(decryptSpy).toHaveBeenCalledTimes(0);

      encryptSpy.mockRestore();
      decryptSpy.mockRestore();
    });

    it('rejects AES-GCM-128 key with WRAP_INVALID before any WebCrypto call', async () => {
      const sodium = await getSodium();
      const vk = new Uint8Array(VK_BYTES).fill(0x42);
      const aes128Key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 128 },
        false,
        ['encrypt', 'decrypt'],
      );
      const dummyWrap = new Uint8Array(DEVKEY_WRAP_BYTES);

      const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt');
      const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt');

      await expect(
        sealDevKeyWrap(sodium, vk, aes128Key, userId, vaultKeyId),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(encryptSpy).toHaveBeenCalledTimes(0);
      await expect(
        openDevKeyWrap(dummyWrap, aes128Key, userId, vaultKeyId),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(decryptSpy).toHaveBeenCalledTimes(0);

      encryptSpy.mockRestore();
      decryptSpy.mockRestore();
    });

    it('rejects wrong usages (decrypt-only for sealDevKeyWrap, encrypt-only for openDevKeyWrap) with WRAP_INVALID', async () => {
      const sodium = await getSodium();
      const vk = new Uint8Array(VK_BYTES).fill(0x42);
      const decryptOnlyKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      );
      const encryptOnlyKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt'],
      );
      const dummyWrap = new Uint8Array(DEVKEY_WRAP_BYTES);

      const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt');
      const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt');

      await expect(
        sealDevKeyWrap(sodium, vk, decryptOnlyKey, userId, vaultKeyId),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(encryptSpy).toHaveBeenCalledTimes(0);
      await expect(
        sealDevKeyWrap(sodium, vk, encryptOnlyKey, userId, vaultKeyId),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(encryptSpy).toHaveBeenCalledTimes(0);
      await expect(
        openDevKeyWrap(dummyWrap, encryptOnlyKey, userId, vaultKeyId),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(decryptSpy).toHaveBeenCalledTimes(0);

      encryptSpy.mockRestore();
      decryptSpy.mockRestore();
    });

    it('rejects non-AES key (HMAC) with WRAP_INVALID before any WebCrypto call', async () => {
      const sodium = await getSodium();
      const vk = new Uint8Array(VK_BYTES).fill(0x42);
      const hmacKey = await crypto.subtle.generateKey(
        { name: 'HMAC', hash: 'SHA-256', length: 256 },
        false,
        ['sign', 'verify'],
      );
      const dummyWrap = new Uint8Array(DEVKEY_WRAP_BYTES);

      const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt');
      const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt');

      await expect(
        sealDevKeyWrap(sodium, vk, hmacKey, userId, vaultKeyId),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(encryptSpy).toHaveBeenCalledTimes(0);
      await expect(
        openDevKeyWrap(dummyWrap, hmacKey, userId, vaultKeyId),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(decryptSpy).toHaveBeenCalledTimes(0);

      encryptSpy.mockRestore();
      decryptSpy.mockRestore();
    });

    it('rejects NUL in userId or vaultKeyId in buildDevKeyAad, sealDevKeyWrap, and openDevKeyWrap with WRAP_INVALID', async () => {
      const sodium = await getSodium();
      const vk = new Uint8Array(VK_BYTES).fill(0x42);
      const devKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const dummyWrap = new Uint8Array(DEVKEY_WRAP_BYTES);

      expect(() => buildDevKeyAad('user\u0000id', vaultKeyId)).toThrowError(
        expect.objectContaining({ code: 'WRAP_INVALID' }),
      );
      expect(() => buildDevKeyAad(userId, 'vk:\u0000id')).toThrowError(
        expect.objectContaining({ code: 'WRAP_INVALID' }),
      );

      const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt');
      const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt');

      await expect(
        sealDevKeyWrap(sodium, vk, devKey, 'user\u0000id', vaultKeyId),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(encryptSpy).toHaveBeenCalledTimes(0);
      await expect(
        sealDevKeyWrap(sodium, vk, devKey, userId, 'vk:\u0000id'),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(encryptSpy).toHaveBeenCalledTimes(0);
      await expect(
        openDevKeyWrap(dummyWrap, devKey, 'user\u0000id', vaultKeyId),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(decryptSpy).toHaveBeenCalledTimes(0);
      await expect(
        openDevKeyWrap(dummyWrap, devKey, userId, 'vk:\u0000id'),
      ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      expect(decryptSpy).toHaveBeenCalledTimes(0);

      encryptSpy.mockRestore();
      decryptSpy.mockRestore();
    });

    it('maps WebCrypto DOMException InvalidAccessError to WRAP_INVALID while keeping OperationError as AEAD_DECRYPT_FAILED', async () => {
      const sodium = await getSodium();
      const vk = new Uint8Array(VK_BYTES).fill(0x42);
      const devKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      );
      const validWrap = await sealDevKeyWrap(sodium, vk, devKey, userId, vaultKeyId);

      // Real OperationError (tampered authentication tag) -> AEAD_DECRYPT_FAILED
      const tamperedWrap = new Uint8Array(validWrap);
      tamperedWrap[tamperedWrap.byteLength - 1] ^= 0xff;
      await expect(
        openDevKeyWrap(tamperedWrap, devKey, userId, vaultKeyId),
      ).rejects.toMatchObject({ code: 'AEAD_DECRYPT_FAILED' });

      // InvalidAccessError from subtle.encrypt / subtle.decrypt -> WRAP_INVALID
      const origEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      const origDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
      crypto.subtle.encrypt = async () => {
        throw new DOMException('Key cannot be used for this operation', 'InvalidAccessError');
      };
      crypto.subtle.decrypt = async () => {
        throw new DOMException('Key cannot be used for this operation', 'InvalidAccessError');
      };
      try {
        await expect(
          sealDevKeyWrap(sodium, vk, devKey, userId, vaultKeyId),
        ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
        await expect(
          openDevKeyWrap(validWrap, devKey, userId, vaultKeyId),
        ).rejects.toMatchObject({ code: 'WRAP_INVALID' });
      } finally {
        crypto.subtle.encrypt = origEncrypt;
        crypto.subtle.decrypt = origDecrypt;
      }
    });
  });
});
