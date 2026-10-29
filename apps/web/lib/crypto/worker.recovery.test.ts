import { afterEach, describe, expect, it } from 'vitest';
import { decodeBase64UrlStrict, encodeBase64Url } from './b64url';
import { CryptoClient } from './client';
import {
  KEK_BYTES,
  type DeriveKekFn,
  type ValidatedKdfParams,
} from './kdf';
import {
  CROCKFORD_ALPHABET,
  deriveRecoveryLookupHash,
  deriveRecoveryWrapKey,
  normalizeRecoveryKey,
} from './recovery';
import { getSodium, type Sodium } from './sodium';
import { createWorkerShim, type ShimmedWorkerInstance } from './test/worker-shim';
import { openWrap, VK_BYTES, VK_WRAP_BYTES, WRAP_VERSION } from './wrap';

const utf8Encoder = new TextEncoder();

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

describe('P03-T7 Worker Recovery Key Integration (createVault, makeRecoveryKeys, unlockRecovery)', () => {
  const activeShims: ShimmedWorkerInstance[] = [];

  afterEach(() => {
    while (activeShims.length > 0) {
      activeShims.pop()?.close();
    }
  });

  it('createVault generates 10 recovery keys with slots 1..10, first char in 0..7, normalization round-trip, and valid sabk.vk.rk.v1 wraps of VK', async () => {
    const sodium = await getSodium();
    const zeroedKinds: string[] = [];
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      onKeyZeroed: (kind) => zeroedKinds.push(kind),
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const created = await client.createVault({
      passphrase: 'onboarding-passphrase-for-rk-test',
    });

    const vk = shim.core.inspectClosureVkForTest();
    expect(vk).not.toBeNull();
    expect(vk!.byteLength).toBe(VK_BYTES);

    expect(created.recovery_keys).toHaveLength(10);
    const seenSlots = new Set<number>();
    const seenLookupHashes = new Set<string>();

    for (let i = 0; i < 10; i++) {
      const item = created.recovery_keys[i]!;
      const expectedSlot = i + 1;
      expect(item.slot).toBe(expectedSlot);
      seenSlots.add(item.slot);

      // Display format rk{n}_XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX
      const prefix = `rk${expectedSlot}_`;
      expect(item.display.startsWith(prefix)).toBe(true);
      const groups = item.display.slice(prefix.length).split('-');
      expect(groups.map((g) => g.length)).toEqual([4, 4, 4, 4, 4, 4, 2]);

      const body26 = groups.join('');
      expect(body26).toHaveLength(26);
      expect(['0', '1', '2', '3', '4', '5', '6', '7']).toContain(body26[0]);
      for (const ch of body26) {
        expect(CROCKFORD_ALPHABET.includes(ch)).toBe(true);
      }

      // Normalization round-trip
      const rkNorm = normalizeRecoveryKey(item.display);
      expect(rkNorm).toBe(`${prefix}${body26}`);
      expect(normalizeRecoveryKey(rkNorm)).toBe(rkNorm);

      // Verify lookup_hash matches BLAKE2b-256("sabk.rk.lookup.v1" || rk_norm)
      const expectedLookup = encodeBase64Url(deriveRecoveryLookupHash(sodium, item.display));
      expect(item.lookup_hash).toBe(expectedLookup);
      seenLookupHashes.add(item.lookup_hash);

      // Verify wrap opens with BLAKE2b-256("sabk.rk.wrap.v1" || rk_norm) and AAD sabk.vk.rk.v1 to the exact same VK
      const wrapBytes = decodeBase64UrlStrict(item.wrap);
      expect(wrapBytes.byteLength).toBe(VK_WRAP_BYTES); // 73 B
      expect(wrapBytes[0]).toBe(WRAP_VERSION); // 0x01

      const wrapKey = deriveRecoveryWrapKey(sodium, item.display);
      const openedVk = openWrap(sodium, 'rk', wrapBytes, wrapKey);
      expect(openedVk).toEqual(vk);
    }

    expect(seenSlots.size).toBe(10);
    expect(seenLookupHashes.size).toBe(10);
    // Worker memzeroed each wrap_key ('rk') and temporary VK buffer ('vk') after sealing
    expect(zeroedKinds.filter((k) => k === 'rk').length).toBeGreaterThanOrEqual(10);
  });

  it('makeRecoveryKeys generates and re-opens each RK wrap to the same VK for both full rotation (1..10) and partial regeneration (empty slots)', async () => {
    const sodium = await getSodium();
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    await client.createVault({
      passphrase: 'vault-passphrase-for-make-rk',
      skipRecoveryKeys: true,
    });

    const vk = shim.core.inspectClosureVkForTest()!;
    expect(vk.byteLength).toBe(VK_BYTES);

    // 1. Regenerate subset of empty slots (e.g. slots [2, 5, 10])
    const regen = await client.makeRecoveryKeys({ slots: [2, 5, 10] });
    expect(regen.recovery_keys.map((r) => r.slot)).toEqual([2, 5, 10]);

    for (const rk of regen.recovery_keys) {
      const wrapKey = deriveRecoveryWrapKey(sodium, rk.display);
      const openedVk = openWrap(sodium, 'rk', rk.wrap, wrapKey);
      expect(openedVk).toEqual(vk);
    }

    // 2. Rotate all 10 slots (default 1..10)
    const rotated = await client.makeRecoveryKeys();
    expect(rotated.recovery_keys).toHaveLength(10);
    expect(rotated.recovery_keys.map((r) => r.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    for (const rk of rotated.recovery_keys) {
      const wrapKey = deriveRecoveryWrapKey(sodium, rk.display);
      const openedVk = openWrap(sodium, 'rk', rk.wrap, wrapKey);
      expect(openedVk).toEqual(vk);
    }
  });

  it('unlockRecovery detaches transferred buffer, derives identical lookup_hash for re-typed variants, enters recovering mode, and allows rewrap to complete recovery', async () => {
    const zeroedKinds: string[] = [];
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      onKeyZeroed: (kind) => zeroedKinds.push(kind),
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const created = await client.createVault({
      passphrase: 'initial-passphrase-before-loss',
    });
    const originalVk = shim.core.inspectClosureVkForTest()!;

    // Seal an entry before locking so we can verify the same VK is recovered
    const targetRk = created.recovery_keys[3]!; // slot 4 (`rk4_...`)
    await client.lock();
    expect(client.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();

    // Build re-typed variants of the onboarding display string:
    // - lowercase prefix and body, '-' separator instead of '_', no hyphens in body, spaces + NBSP + zero-width space
    const rawBody = targetRk.display.slice('rk4_'.length).replace(/-/g, '');
    const lowerBodyWithAliases = rawBody
      .toLowerCase()
      .replace(/0/g, 'O')
      .replace(/1/g, 'l');
    const pastedVariant1 = `  RK4-${lowerBodyWithAliases.slice(0, 8)}\u00A0${lowerBodyWithAliases.slice(8, 16)}\u200B\u2011${lowerBodyWithAliases.slice(16)} \n`;

    // Step 1 of recovery flow: derive lookup_hash only (no wrap yet), passing a Uint8Array to verify transfer detach
    const lookupBuf = new Uint8Array(utf8Encoder.encode(pastedVariant1));
    expect(lookupBuf.buffer.byteLength).toBeGreaterThan(0);

    const lookupOnly = await client.unlockRecovery({
      recoveryKey: lookupBuf,
    });
    // Transferred buffer must be detached on main thread
    expect(lookupBuf.buffer.byteLength).toBe(0);
    expect(lookupBuf.byteLength).toBe(0);
    expect(lookupOnly.lookup_hash).toBe(targetRk.lookup_hash);
    expect(lookupOnly.recovering).toBeUndefined();
    expect(client.getState()).toBe('locked');

    // Step 2 of recovery flow: server returns wrap -> unlockRecovery with wrap opens VK and transitions to 'recovering'
    zeroedKinds.length = 0;
    const unlockBuf = new Uint8Array(utf8Encoder.encode(pastedVariant1));
    expect(unlockBuf.buffer.byteLength).toBeGreaterThan(0);

    const recovered = await client.unlockRecovery({
      recoveryKey: unlockBuf,
      wrap: targetRk.wrap,
    });
    expect(unlockBuf.buffer.byteLength).toBe(0);
    expect(unlockBuf.byteLength).toBe(0);
    expect(recovered.lookup_hash).toBe(targetRk.lookup_hash);
    expect(recovered.recovering).toBe(true);
    expect(client.getState()).toBe('recovering');
    expect(shim.core.getState()).toBe('recovering');
    expect(shim.core.inspectClosureVkForTest()).toEqual(originalVk);
    // Worker memzeroed the RK bytes and wrap_key after opening the wrap
    expect(zeroedKinds.filter((k) => k === 'rk').length).toBeGreaterThanOrEqual(2);

    // While in 'recovering' mode, non-rewrap operations (e.g. makeRecoveryKeys) must be rejected with VAULT_RECOVERING
    await expect(client.makeRecoveryKeys({ slots: [1] })).rejects.toMatchObject({
      code: 'VAULT_RECOVERING',
    });

    // Step 3: rewrap to a new passphrase completes recovery and transitions to 'unlocked' while preserving VK
    const rewrapped = await client.rewrap({
      passphrase: 'new-passphrase-after-rk-recovery',
      currentKdf: created.kdf,
    });
    expect(client.getState()).toBe('unlocked');
    expect(shim.core.getState()).toBe('unlocked');
    expect(shim.core.inspectClosureVkForTest()).toEqual(originalVk);
    expect(rewrapped.kdf.salt).not.toBe(created.kdf.salt);

    // Verify new KEK wrap opens with the new passphrase to the same VK
    await client.lock();
    await client.unlockPassphrase({
      passphrase: 'new-passphrase-after-rk-recovery',
      kdf: rewrapped.kdf,
      vaultKeyWrappedByKek: rewrapped.vault_key_wrapped_by_kek,
    });
    expect(client.getState()).toBe('unlocked');
    expect(shim.core.inspectClosureVkForTest()).toEqual(originalVk);
  });

  it('unlockRecovery rejects invalid recovery keys with RECOVERY_KEY_INVALID and wrong wraps with AEAD_DECRYPT_FAILED', async () => {
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const created = await client.createVault({
      passphrase: 'passphrase-for-negative-rk',
    });
    await client.lock();

    // Invalid recovery key string -> RECOVERY_KEY_INVALID
    await expect(
      client.unlockRecovery({
        recoveryKey: 'rk01_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4', // leading zero in slot
      }),
    ).rejects.toMatchObject({
      code: 'RECOVERY_KEY_INVALID',
    });

    // Valid RK #1 paired with RK #2's wrap -> AEAD_DECRYPT_FAILED, remains locked
    await expect(
      client.unlockRecovery({
        recoveryKey: created.recovery_keys[0]!.display,
        wrap: created.recovery_keys[1]!.wrap,
      }),
    ).rejects.toMatchObject({
      code: 'AEAD_DECRYPT_FAILED',
    });
    expect(client.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();
  });
});
