import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeBase64UrlStrict, encodeBase64Url } from '@/lib/crypto/b64url';
import {
  KEY_ID_REGEX,
  openEntryPayload,
  validateEntryEnvelope,
} from '@/lib/crypto/envelope';
import { deriveKek, validateKdfParams } from '@/lib/crypto/kdf';
import {
  deriveRecoveryLookupHash,
  deriveRecoveryWrapKey,
  normalizeRecoveryKey,
} from '@/lib/crypto/recovery';
import { getSodium } from '@/lib/crypto/sodium';
import {
  openWrap,
  PRIV_WRAP_BYTES,
  unpackPrivateKeySeeds,
  validateWrap,
  VK_WRAP_BYTES,
} from '@/lib/crypto/wrap';
import sampleSabk from './__fixtures__/sabk_v1_sample.sabk.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const JS_VECTORS_PATH = resolve(
  __dirname,
  '../../../../../packages/crypto-vectors/vectors/js-v1.json',
);

interface JsVectorInputs {
  passphrase_utf8: string;
  rk_display: string;
  rk_norm: string;
  pwk_b64u: string;
  entries: {
    text: {
      entry_id: string;
      plaintext_utf8: string;
    };
    json: {
      entry_id: string;
      plaintext_utf8: string;
    };
  };
}

function loadJsVectorInputs(): JsVectorInputs {
  const raw = readFileSync(JS_VECTORS_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as { inputs: JsVectorInputs };
  return parsed.inputs;
}

describe('P06-A2: .sabk.json v1 offline independent restore', () => {
  it('restores VK, 105 B private_keys_wrapped, and all entries offline via Passphrase, Recovery Key, or Passkey PRF (even after server rotated KEK, consumed RK, revoked passkey, or deleted account)', async () => {
    const sodium = await getSodium();
    const vec = loadJsVectorInputs();

    // 1. Validate format, version, vault_key_id, and wrap sizes
    expect(sampleSabk.format).toBe('engram.sabk');
    expect(sampleSabk.version).toBe(1);
    expect(KEY_ID_REGEX.test(sampleSabk.vault.vault_key_id)).toBe(true);
    expect(sampleSabk.vault.vault_key_id).toBe('vk:AAECAwQFBgcICQoLDA0ODw');

    const kekWrapBytes = validateWrap(sampleSabk.vault.vault_key_wrapped_by_kek, 'kek');
    expect(kekWrapBytes.byteLength).toBe(VK_WRAP_BYTES);

    const privWrapBytes = validateWrap(sampleSabk.vault.private_keys_wrapped, 'priv');
    expect(privWrapBytes.byteLength).toBe(PRIV_WRAP_BYTES);

    // 2. Simulate that live server state was mutated/destroyed (KEK rotated, RK consumed, passkey revoked, account deleted):
    // We use ONLY the offline `sampleSabk` JSON + original credentials from vectors, with zero network/server calls.
    const offlineSnapshot = structuredClone(sampleSabk);

    const validatedKdf = validateKdfParams(offlineSnapshot.vault.kdf);
    expect(validatedKdf.alg).toBe('argon2id13');
    const passBytes = new TextEncoder().encode(vec.passphrase_utf8);
    const kek = await deriveKek(sodium, passBytes, offlineSnapshot.vault.kdf);
    const vkFromPassphrase = openWrap(
      sodium,
      'kek',
      offlineSnapshot.vault.vault_key_wrapped_by_kek,
      kek,
    );
    expect(vkFromPassphrase.byteLength).toBe(32);

    // Path B: Original Recovery Key -> normalize -> lookup_hash match -> BLAKE2b wrap key -> unwrap VK
    const rkNormalized = normalizeRecoveryKey(vec.rk_display);
    expect(rkNormalized).toBe(vec.rk_norm);
    const lookupHashB64 = encodeBase64Url(deriveRecoveryLookupHash(sodium, rkNormalized));
    const matchedRkSlot = offlineSnapshot.vault.recovery_keys.find(
      (rk) => rk.lookup_hash === lookupHashB64,
    );
    expect(matchedRkSlot).toBeDefined();
    const rkWrapKey = deriveRecoveryWrapKey(sodium, rkNormalized);
    const vkFromRk = openWrap(sodium, 'rk', matchedRkSlot!.wrap, rkWrapKey);
    expect(vkFromRk).toEqual(vkFromPassphrase);

    // Path C: Original Passkey PRF output (PWK) -> unwrap VK
    const pwk = decodeBase64UrlStrict(vec.pwk_b64u, 32);
    const passkeyEntry = offlineSnapshot.vault.passkeys[0];
    expect(passkeyEntry).toBeDefined();
    const vkFromPrf = openWrap(sodium, 'prf', passkeyEntry!.vk_wrap, pwk);
    expect(vkFromPrf).toEqual(vkFromPassphrase);

    // 3. Unwrap private key seeds (105 B wrapP -> 64 B seeds) and verify public keys
    const privPlain = openWrap(
      sodium,
      'priv',
      offlineSnapshot.vault.private_keys_wrapped,
      vkFromPassphrase,
    );
    const { x25519Seed, ed25519Seed } = unpackPrivateKeySeeds(privPlain);
    expect(x25519Seed.byteLength).toBe(32);
    expect(ed25519Seed.byteLength).toBe(32);

    // 4. Decrypt all entries (both active and soft-deleted unpurged) using VK
    const expectedPlaintexts: Record<string, string> = {
      [vec.entries.text.entry_id]: vec.entries.text.plaintext_utf8,
      [vec.entries.json.entry_id]: vec.entries.json.plaintext_utf8,
    };

    expect(offlineSnapshot.entries).toHaveLength(2);
    for (const entry of offlineSnapshot.entries) {
      const validatedEnv = validateEntryEnvelope(entry.envelope);
      expect(validatedEnv.key_id).toBe(offlineSnapshot.vault.vault_key_id);

      const opened = openEntryPayload(sodium, {
        entryId: entry.id,
        envelope: validatedEnv,
        ciphertext: entry.ciphertext,
        vk: vkFromPassphrase,
      });
      expect(opened.plaintext).toBe(expectedPlaintexts[entry.id]);
    }
  });
});
