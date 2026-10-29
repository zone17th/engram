import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('P03-T7 Worker Recovery Key Integration (createVault, makeRecoveryKeys, unlockRecovery, resumeRecovery, confirmRecovery)', () => {
  const activeShims: ShimmedWorkerInstance[] = [];

  afterEach(() => {
    while (activeShims.length > 0) {
      activeShims.pop()?.close();
    }
  });

  it('createVault generates 10 recovery keys with slots 1..10, first char in 0..7, normalization round-trip, and valid sabk.vk.rk.v1 wraps of VK, wiping source BLAKE2b hash buffers', async () => {
    const sodium = await getSodium();
    const zeroedKinds: string[] = [];

    // Spy on sodium.crypto_generichash to verify source BLAKE2b output buffers are wiped (BE1-7, BE1-18, BE1-29)
    const capturedHashBuffers: Uint8Array[] = [];
    const origGenericHash = sodium.crypto_generichash.bind(sodium);
    const genericHashSpy = vi
      .spyOn(sodium, 'crypto_generichash')
      .mockImplementation(((
        hashLength: number,
        message: string | Uint8Array,
        key?: string | Uint8Array | null,
      ) => {
        const out = origGenericHash(hashLength, message, key ?? null, 'uint8array');
        capturedHashBuffers.push(out);
        return out;
      }) as typeof sodium.crypto_generichash);

    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      onKeyZeroed: (kind) => zeroedKinds.push(kind),
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    let created;
    try {
      created = await client.createVault({
        passphrase: 'onboarding-passphrase-for-rk-test',
        opGeneration: client.captureGeneration(),
      });
    } finally {
      genericHashSpy.mockRestore();
    }

    // All BLAKE2b hash allocations produced during createVault (1 KEK + 10 lookup_hash + 10 wrap_key) must be zeroed
    expect(capturedHashBuffers.length).toBeGreaterThanOrEqual(21);
    for (const buf of capturedHashBuffers) {
      expect(buf.every((b) => b === 0)).toBe(true);
    }

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
    expect(zeroedKinds.filter((k) => k === 'rk').length).toBeGreaterThanOrEqual(20);
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
      opGeneration: client.captureGeneration(),
    });

    const vk = shim.core.inspectClosureVkForTest()!;
    expect(vk.byteLength).toBe(VK_BYTES);

    // 1. Regenerate subset of empty slots (e.g. slots [2, 5, 10])
    const regen = await client.makeRecoveryKeys({
      slots: [2, 5, 10],
      opGeneration: client.captureGeneration(),
    });
    expect(regen.recovery_keys.map((r) => r.slot)).toEqual([2, 5, 10]);

    for (const rk of regen.recovery_keys) {
      const wrapKey = deriveRecoveryWrapKey(sodium, rk.display);
      const openedVk = openWrap(sodium, 'rk', rk.wrap, wrapKey);
      expect(openedVk).toEqual(vk);
    }

    // 2. Rotate all 10 slots (default 1..10)
    const rotated = await client.makeRecoveryKeys({
      opGeneration: client.captureGeneration(),
    });
    expect(rotated.recovery_keys).toHaveLength(10);
    expect(rotated.recovery_keys.map((r) => r.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    for (const rk of rotated.recovery_keys) {
      const wrapKey = deriveRecoveryWrapKey(sodium, rk.display);
      const openedVk = openWrap(sodium, 'rk', rk.wrap, wrapKey);
      expect(openedVk).toEqual(vk);
    }
  });

  it('keeps recovery restricted after local rewrap until confirmRecovery, and supports the one-entry lookup -> resumeRecovery -> rewrap -> confirmRecovery flow (BE1-12, BE1-13, BE1-26, FE1-1)', async () => {
    const sodium = await getSodium();
    const zeroedKinds: string[] = [];
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      onKeyZeroed: (kind) => zeroedKinds.push(kind),
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const created = await client.createVault({
      passphrase: 'initial-passphrase-before-loss',
      opGeneration: client.captureGeneration(),
    });
    const originalVk = shim.core.inspectClosureVkForTest()!;

    // Seal an entry before locking so we can verify recovery restrictions and post-confirmation access
    const entryId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    const keyId = 'vk:7f3a9b2c4d5e6f7a8b9c0d';
    const sealedEntry = await client.sealEntry({
      entryId,
      keyId,
      plaintext: 'secret-entry-locked-behind-recovery-fence',
      opGeneration: client.captureGeneration(),
    });

    const targetRk = created.recovery_keys[3]!; // slot 4 (`rk4_...`)
    await client.lock();
    expect(client.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();

    // Build re-typed variant of the onboarding display string:
    // - lowercase prefix and body, '-' separator instead of '_', no hyphens in body, spaces + NBSP + zero-width space
    const rawBody = targetRk.display.slice('rk4_'.length).replace(/-/g, '');
    const lowerBodyWithAliases = rawBody
      .toLowerCase()
      .replace(/0/g, 'O')
      .replace(/1/g, 'l');
    const pastedVariant1 = `  RK4-${lowerBodyWithAliases.slice(0, 8)}\u00A0${lowerBodyWithAliases.slice(8, 16)}\u200B\u2011${lowerBodyWithAliases.slice(16)} \n`;

    // Capture source BLAKE2b allocations during lookup + resumeRecovery (BE1-7, BE1-18, BE1-29)
    const capturedHashBuffers: Uint8Array[] = [];
    const origGenericHash = sodium.crypto_generichash.bind(sodium);
    const genericHashSpy = vi
      .spyOn(sodium, 'crypto_generichash')
      .mockImplementation(((
        hashLength: number,
        message: string | Uint8Array,
        key?: string | Uint8Array | null,
      ) => {
        const out = origGenericHash(hashLength, message, key ?? null, 'uint8array');
        capturedHashBuffers.push(out);
        return out;
      }) as typeof sodium.crypto_generichash);

    try {
      // Step 1 of one-entry recovery flow: lookup-only unlockRecovery transfers the SOLE RK buffer
      const recoveryGen = client.captureGeneration();
      const lookupBuf = new Uint8Array(utf8Encoder.encode(pastedVariant1));
      expect(lookupBuf.buffer.byteLength).toBeGreaterThan(0);

      const lookupOnly = await client.unlockRecovery({
        recoveryKey: lookupBuf,
        opGeneration: recoveryGen,
      });
      // Transferred buffer is detached on main thread; caller never needs to retain or re-send plaintext RK
      expect(lookupBuf.buffer.byteLength).toBe(0);
      expect(lookupBuf.byteLength).toBe(0);
      expect(lookupOnly.lookup_hash).toBe(targetRk.lookup_hash);
      expect(lookupOnly.recovering).toBeUndefined();
      expect(client.getState()).toBe('locked');

      // Source BLAKE2b buffers from deriveRecoveryLookupHash and deriveRecoveryWrapKey were zeroed (pendingRecovery keeps its own internal copy)
      expect(capturedHashBuffers.length).toBeGreaterThanOrEqual(2);
      for (const buf of capturedHashBuffers) {
        expect(buf.every((b) => b === 0)).toBe(true);
      }

      // Step 2 of one-entry recovery flow: server returns wrap -> resumeRecovery opens it WITHOUT resending plaintext RK (BE1-13)
      zeroedKinds.length = 0;
      const resumed = await client.resumeRecovery({
        wrap: targetRk.wrap,
        privateKeysWrapped: created.private_keys_wrapped,
        opGeneration: recoveryGen,
      });
      expect(resumed.lookup_hash).toBe(targetRk.lookup_hash);
      expect(resumed.recovering).toBe(true);
      expect(client.getState()).toBe('recovering');
      expect(shim.core.getState()).toBe('recovering');
      expect(shim.core.inspectClosureVkForTest()).toEqual(originalVk);
      // Pending wrapKey was memzeroed upon resume
      expect(zeroedKinds.filter((k) => k === 'rk').length).toBeGreaterThanOrEqual(1);

      // Calling resumeRecovery a second time fails because the continuation was one-shot and wiped
      await expect(
        client.resumeRecovery({
          wrap: targetRk.wrap,
          opGeneration: recoveryGen,
        }),
      ).rejects.toMatchObject({
        code: 'RECOVERY_CONTINUATION_MISSING',
      });

      // Step 3: While in 'recovering' mode BEFORE rewrap, non-rewrap commands reject with VAULT_RECOVERING
      const devKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      await expect(
        client.openEntry({
          entryId,
          envelope: sealedEntry.envelope,
          ciphertext: sealedEntry.ciphertext,
          opGeneration: recoveryGen,
        }),
      ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });
      await expect(
        client.sealEntry({
          entryId,
          keyId,
          plaintext: 'blocked',
          opGeneration: recoveryGen,
        }),
      ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });
      await expect(
        client.makeRecoveryKeys({ slots: [1], opGeneration: recoveryGen }),
      ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });
      await expect(
        client.wrapForPasskey({
          pwk: new Uint8Array(32).fill(0x22),
          opGeneration: recoveryGen,
        }),
      ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });
      await expect(
        client.wrapForDevice({
          devKey,
          userId: '11111111-1111-4111-8111-111111111111',
          vaultKeyId: keyId,
          opGeneration: recoveryGen,
        }),
      ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });

      // Step 4: Local rewrap produces the new KEK wrap for POST /vault/recover/complete,
      // BUT MUST KEEP state as 'recovering' until server 200 is confirmed (BE1-12, BE1-26, FE1-1)!
      const rewrapped = await client.rewrap({
        passphrase: 'new-passphrase-after-rk-recovery',
        currentKdf: created.kdf,
        opGeneration: recoveryGen,
      });
      expect(rewrapped.kdf.salt).not.toBe(created.kdf.salt);
      expect(client.getState()).toBe('recovering');
      expect(shim.core.getState()).toBe('recovering');
      expect(shim.core.inspectClosureVkForTest()).toEqual(originalVk);

      // Even AFTER local rewrap, all non-rewrap commands STILL reject with VAULT_RECOVERING!
      await expect(
        client.openEntry({
          entryId,
          envelope: sealedEntry.envelope,
          ciphertext: sealedEntry.ciphertext,
          opGeneration: recoveryGen,
        }),
      ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });
      await expect(
        client.sealEntry({
          entryId,
          keyId,
          plaintext: 'still-blocked-after-local-rewrap',
          opGeneration: recoveryGen,
        }),
      ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });
      await expect(
        client.makeRecoveryKeys({ slots: [1], opGeneration: recoveryGen }),
      ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });
      await expect(
        client.wrapForPasskey({
          pwk: new Uint8Array(32).fill(0x22),
          opGeneration: recoveryGen,
        }),
      ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });
      await expect(
        client.wrapForDevice({
          devKey,
          userId: '11111111-1111-4111-8111-111111111111',
          vaultKeyId: keyId,
          opGeneration: recoveryGen,
        }),
      ).rejects.toMatchObject({ code: 'VAULT_RECOVERING' });

      // Stale generation on confirmRecovery is rejected without unlocking
      await expect(
        client.confirmRecovery({ opGeneration: recoveryGen + 99 }),
      ).rejects.toMatchObject({ code: 'STALE_GENERATION' });
      expect(client.getState()).toBe('recovering');
      expect(shim.core.getState()).toBe('recovering');

      // Step 5: Explicit confirmRecovery after simulated POST /vault/recover/complete 200 lifts restrictions
      const confirmed = await client.confirmRecovery({ opGeneration: recoveryGen });
      expect(confirmed.unlocked).toBe(true);
      expect(client.getState()).toBe('unlocked');
      expect(shim.core.getState()).toBe('unlocked');

      // Now openEntry and makeRecoveryKeys succeed
      const openedEntry = await client.openEntry({
        entryId,
        envelope: sealedEntry.envelope,
        ciphertext: sealedEntry.ciphertext,
        opGeneration: recoveryGen,
      });
      expect(openedEntry.plaintext).toBe('secret-entry-locked-behind-recovery-fence');

      // Calling confirmRecovery again when already unlocked rejects with VAULT_NOT_RECOVERING
      await expect(
        client.confirmRecovery({ opGeneration: recoveryGen }),
      ).rejects.toMatchObject({ code: 'VAULT_NOT_RECOVERING' });

      // Verify new KEK wrap opens with the new passphrase to the same VK
      await client.lock();
      await client.unlockPassphrase({
        passphrase: 'new-passphrase-after-rk-recovery',
        kdf: rewrapped.kdf,
        vaultKeyWrappedByKek: rewrapped.vault_key_wrapped_by_kek,
        opGeneration: client.captureGeneration(),
      });
      expect(client.getState()).toBe('unlocked');
      expect(shim.core.inspectClosureVkForTest()).toEqual(originalVk);
    } finally {
      genericHashSpy.mockRestore();
    }
  });

  it('invalidates and wipes pending recovery continuation on lock, failure, or stale generation (BE1-13)', async () => {
    const zeroedKinds: string[] = [];
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
      onKeyZeroed: (kind) => zeroedKinds.push(kind),
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const created = await client.createVault({
      passphrase: 'passphrase-for-continuation-wipe',
      opGeneration: client.captureGeneration(),
    });
    const rk0 = created.recovery_keys[0]!;
    const rk1 = created.recovery_keys[1]!;
    await client.lock();

    // 1. Lock between lookup-only unlockRecovery and resumeRecovery wipes the pending continuation
    const gen1 = client.captureGeneration();
    await client.unlockRecovery({
      recoveryKey: rk0.display,
      opGeneration: gen1,
    });
    zeroedKinds.length = 0;
    await client.lock();
    expect(zeroedKinds).toContain('rk');

    await expect(
      client.resumeRecovery({
        wrap: rk0.wrap,
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'RECOVERY_CONTINUATION_MISSING',
    });

    // 2. Wrong wrap on resumeRecovery fails with AEAD_DECRYPT_FAILED and wipes the pending continuation
    const gen2 = client.captureGeneration();
    await client.unlockRecovery({
      recoveryKey: rk0.display,
      opGeneration: gen2,
    });
    await expect(
      client.resumeRecovery({
        wrap: rk1.wrap,
        opGeneration: gen2,
      }),
    ).rejects.toMatchObject({
      code: 'AEAD_DECRYPT_FAILED',
    });
    expect(client.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();

    // Subsequent resumeRecovery must reject with RECOVERY_CONTINUATION_MISSING
    await expect(
      client.resumeRecovery({
        wrap: rk0.wrap,
        opGeneration: gen2,
      }),
    ).rejects.toMatchObject({
      code: 'RECOVERY_CONTINUATION_MISSING',
    });

    // 3. Cancellation / lock during recovering mode (after rewrap, before server 200) wipes VK
    const gen3 = client.captureGeneration();
    await client.unlockRecovery({
      recoveryKey: rk0.display,
      wrap: rk0.wrap,
      opGeneration: gen3,
    });
    expect(client.getState()).toBe('recovering');
    await client.rewrap({
      passphrase: 'new-passphrase-aborted-commit',
      currentKdf: created.kdf,
      opGeneration: gen3,
    });
    expect(client.getState()).toBe('recovering');
    await client.lock();
    expect(client.getState()).toBe('locked');
    expect(shim.core.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();
  });

  it('unlockRecovery rejects invalid recovery keys with RECOVERY_KEY_INVALID without echoing input chars, and wrong wraps with AEAD_DECRYPT_FAILED (FE1-5)', async () => {
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
    });
    activeShims.push(shim);
    const client = new CryptoClient({ createWorker: () => shim.port });

    const created = await client.createVault({
      passphrase: 'passphrase-for-negative-rk',
      opGeneration: client.captureGeneration(),
    });
    await client.lock();

    // Invalid recovery key strings -> RECOVERY_KEY_INVALID, and error.message NEVER contains input characters (FE1-5)
    const badInputs = [
      { rk: 'rk01_3F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4', forbidden: ['rk01', '3F8K'] },
      { rk: 'rk1_9F8K-9M2P-4Q7R-6T1V-8W5X-2Y9Z-C4', forbidden: ['9F8K', "'9'"] },
      { rk: 'rk1_3F8K-9M2P-4Q7R-6T1U-8W5X-2Y9Z-C4', forbidden: ["'U'", '6T1U'] },
    ];
    for (const tc of badInputs) {
      let caught: Error | null = null;
      try {
        await client.unlockRecovery({
          recoveryKey: tc.rk,
          opGeneration: client.captureGeneration(),
        });
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toMatchObject({ code: 'RECOVERY_KEY_INVALID' });
      for (const token of tc.forbidden) {
        expect(caught!.message).not.toContain(token);
      }
    }

    // Valid RK #1 paired with RK #2's wrap -> AEAD_DECRYPT_FAILED, remains locked
    await expect(
      client.unlockRecovery({
        recoveryKey: created.recovery_keys[0]!.display,
        wrap: created.recovery_keys[1]!.wrap,
        opGeneration: client.captureGeneration(),
      }),
    ).rejects.toMatchObject({
      code: 'AEAD_DECRYPT_FAILED',
    });
    expect(client.getState()).toBe('locked');
    expect(shim.core.inspectClosureVkForTest()).toBeNull();
  });
});
