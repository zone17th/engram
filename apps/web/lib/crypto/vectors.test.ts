import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeBase64UrlStrict, encodeBase64Url } from './b64url';
import {
  buildEntryAad,
  canonicalizeEnvelopeJcs,
  EnvelopeError,
  openEntryPayload,
  parseJsonRejectingDuplicateKeys,
  sealEntryPayload,
  validateEntryEnvelope,
  type EntryEnvelopeV1,
} from './envelope';
import {
  deriveKek,
  KDF_ALG,
  KDF_MEM_MIN,
  KDF_OPS_MIN,
  KDF_PARALLELISM,
  KdfError,
  validateKdfParams,
} from './kdf';
import {
  deriveRecoveryLookupHash,
  deriveRecoveryWrapKey,
  generateRecoveryKey,
  normalizeRecoveryKey,
} from './recovery';
import { getSodium, toLocalBytes, type Sodium } from './sodium';
import {
  buildWrapAad,
  openWrap,
  packPrivateKeySeeds,
  PRIV_WRAP_BYTES,
  sealWrap,
  unpackPrivateKeySeeds,
  validateWrap,
  VK_WRAP_BYTES,
  WRAP_LABELS,
  WRAP_VERSION,
  WrapError,
  type WrapKind,
  type WrapLabel,
} from './wrap';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const JS_VECTORS_PATH = resolve(
  __dirname,
  '../../../../packages/crypto-vectors/vectors/js-v1.json',
);
export const GO_VECTORS_PATH = resolve(
  __dirname,
  '../../../../packages/crypto-vectors/vectors/go-v1.json',
);

const utf8Encoder = new TextEncoder();

export type VectorErrorClass = 'validation' | 'aead' | 'kdf_params';

export interface WrapVectorEntry {
  kind: WrapKind;
  label: WrapLabel;
  version: 1;
  aad_hex: string;
  nonce_hex: string;
  length_bytes: 73 | 105;
  wrap_hex: string;
  wrap_b64u: string;
}

export interface DerivedEntryVector {
  entry_id: string;
  jcs_utf8: string;
  jcs_hex: string;
  aad_hex: string;
  ciphertext_hex: string;
  ciphertext_b64u: string;
}

export interface NegativeEnvelopeCase {
  id: string;
  description: string;
  raw_json: string;
  entry_id: string;
  ciphertext_b64u: string;
  expected_error: 'validation' | 'aead';
}

export interface NegativeWrapCase {
  id: string;
  description: string;
  kind: WrapKind;
  wrap_b64u: string;
  key_hex: string;
  validator_error: 'validation' | null;
  open_error: 'validation' | 'aead';
}

export interface NegativeKdfCase {
  id: string;
  description: string;
  raw_json: string;
  expected_error: 'kdf_params';
}

export interface CryptoVectorSuiteV1 {
  schema: 'engram-crypto-vectors-v1';
  producer: 'js' | 'go';
  inputs: {
    vk_hex: string;
    vk_b64u: string;
    vault_key_id: string;
    passphrase_utf8: string;
    passphrase_hex: string;
    kdf_salt_hex: string;
    kdf_salt_b64u: string;
    kdf: {
      alg: typeof KDF_ALG;
      ops: number;
      mem: number;
      parallelism: 1;
      salt: string;
    };
    rk_slot: number;
    rk_entropy_hex: string;
    rk_display: string;
    rk_norm: string;
    pwk_hex: string;
    pwk_b64u: string;
    x25519_seed_hex: string;
    x25519_public_hex: string;
    x25519_public_b64u: string;
    ed25519_seed_hex: string;
    ed25519_public_hex: string;
    ed25519_public_b64u: string;
    nonces: {
      kek_wrap_nonce_hex: string;
      rk_wrap_nonce_hex: string;
      prf_wrap_nonce_hex: string;
      priv_wrap_nonce_hex: string;
    };
    entries: {
      text: {
        entry_id: string;
        nonce_hex: string;
        nonce_b64u: string;
        plaintext_utf8: string;
        plaintext_hex: string;
        envelope: EntryEnvelopeV1;
        reordered_envelope_raw_json: string[];
      };
      json: {
        entry_id: string;
        nonce_hex: string;
        nonce_b64u: string;
        plaintext_utf8: string;
        plaintext_hex: string;
        envelope: EntryEnvelopeV1;
        reordered_envelope_raw_json: string[];
      };
    };
  };
  derived: {
    kek_hex: string;
    kek_b64u: string;
    rk_lookup_hash_hex: string;
    rk_lookup_hash_b64u: string;
    rk_wrap_key_hex: string;
    rk_wrap_key_b64u: string;
    priv_plaintext_hex: string;
    wraps: {
      kek: WrapVectorEntry;
      rk: WrapVectorEntry;
      prf: WrapVectorEntry;
      priv: WrapVectorEntry;
    };
    entries: {
      text: DerivedEntryVector;
      json: DerivedEntryVector;
    };
  };
  negative: {
    envelope: NegativeEnvelopeCase[];
    wrap: NegativeWrapCase[];
    kdf: NegativeKdfCase[];
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Deterministic generator for `packages/crypto-vectors/vectors/js-v1.json`.
 * Uses ONLY fixed test inputs (no randomness) and calls the real `apps/web/lib/crypto`
 * primitives (`deriveKek`, `sealWrap`, `sealEntryPayload`, `generateRecoveryKey`, etc.).
 */
export async function buildJsCryptoVectorSuite(sodium: Sodium): Promise<CryptoVectorSuiteV1> {
  // 1. Fixed inputs (deterministic test fixtures — NO real secrets)
  const vkHex = '101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f';
  const vk = hexToBytes(vkHex);
  const vaultKeyId = 'vk:7f3a9b2c4d5e6f7a8b9c0d';

  const passphraseUtf8 = 'correct-horse-battery-staple-engram-js-v1';
  const passphraseBytes = toLocalBytes(utf8Encoder.encode(passphraseUtf8));
  const kdfSaltHex = 'a0a1a2a3a4a5a6a7a8a9aaabacadaeaf';
  const kdfSaltBytes = hexToBytes(kdfSaltHex);
  const kdfSaltB64u = encodeBase64Url(kdfSaltBytes);

  const kdf = {
    alg: KDF_ALG,
    ops: KDF_OPS_MIN,
    mem: KDF_MEM_MIN,
    parallelism: KDF_PARALLELISM,
    salt: kdfSaltB64u,
  } as const;

  // RK fixed slot 1 & 16-byte entropy
  const rkSlot = 1;
  const rkEntropyHex = '0123456789abcdef0123456789abcdef';
  const rkEntropyBytes = hexToBytes(rkEntropyHex);
  const generatedRk = generateRecoveryKey(sodium, rkSlot, rkEntropyBytes);

  // PWK (32-byte PRF output)
  const pwkHex = '303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f';
  const pwkBytes = hexToBytes(pwkHex);

  // X25519 & Ed25519 seeds (32 bytes each)
  const x25519SeedHex = '505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f';
  const ed25519SeedHex = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
  const x25519Seed = hexToBytes(x25519SeedHex);
  const ed25519Seed = hexToBytes(ed25519SeedHex);

  const x25519Kp = sodium.crypto_box_seed_keypair(x25519Seed, 'uint8array');
  const ed25519Kp = sodium.crypto_sign_seed_keypair(ed25519Seed, 'uint8array');

  // Fixed 24-byte nonces for the 4 wraps
  const kekWrapNonceHex = 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7';
  const rkWrapNonceHex = 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7';
  const prfWrapNonceHex = 'd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7';
  const privWrapNonceHex = 'e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7';

  // Derive KEK via real Argon2id v1.3 (ops=3, mem=64 MiB, p=1)
  const kekBytes = await deriveKek(sodium, passphraseBytes, kdf);

  // Derive RK lookup_hash & wrap_key via BLAKE2b-256
  const rkLookupHash = deriveRecoveryLookupHash(sodium, generatedRk.display);
  const rkWrapKey = deriveRecoveryWrapKey(sodium, generatedRk.display);

  // Pack private key seeds (64 bytes)
  const privPlaintext = packPrivateKeySeeds(x25519Seed, ed25519Seed);

  // Seal the 4 server wraps
  const kekWrapBytes = sealWrap(sodium, 'kek', vk, kekBytes, hexToBytes(kekWrapNonceHex));
  const rkWrapBytes = sealWrap(sodium, 'rk', vk, rkWrapKey, hexToBytes(rkWrapNonceHex));
  const prfWrapBytes = sealWrap(sodium, 'prf', vk, pwkBytes, hexToBytes(prfWrapNonceHex));
  const privWrapBytes = sealWrap(
    sodium,
    'priv',
    privPlaintext,
    vk,
    hexToBytes(privWrapNonceHex),
  );

  // Entries: text and JSON
  const textEntryId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const textNonceHex = '0102030405060708090a0b0c0d0e0f101112131415161718';
  const textNonceBytes = hexToBytes(textNonceHex);
  const textPlaintextUtf8 = 'wifi-office: WPA2-Enterprise secret_key_2026!';
  const sealedText = sealEntryPayload(sodium, {
    entryId: textEntryId,
    keyId: vaultKeyId,
    plaintext: textPlaintextUtf8,
    vk,
    nonce: textNonceBytes,
  });

  const jsonEntryId = '8b4e2a10-9c3d-4e5f-a1b2-c3d4e5f60718';
  const jsonNonceHex = '2122232425262728292a2b2c2d2e2f303132333435363738';
  const jsonNonceBytes = hexToBytes(jsonNonceHex);
  const jsonPlaintextUtf8 =
    '{"service":"postgres-prod","port":5432,"big_id":9007199254740993,"tags":["db","primary"]}';
  const sealedJson = sealEntryPayload(sodium, {
    entryId: jsonEntryId,
    keyId: vaultKeyId,
    plaintext: jsonPlaintextUtf8,
    vk,
    nonce: jsonNonceBytes,
  });

  // Negative cases
  const mutatedVersionKekWrap = new Uint8Array(kekWrapBytes);
  mutatedVersionKekWrap[0] = 0x02;

  const tamperedTagKekWrap = new Uint8Array(kekWrapBytes);
  tamperedTagKekWrap[tamperedTagKekWrap.length - 1] ^= 0xff;

  const mutatedVersionPrivWrap = new Uint8Array(privWrapBytes);
  mutatedVersionPrivWrap[0] = 0x00;

  const negativeEnvelope: NegativeEnvelopeCase[] = [
    {
      id: 'env_missing_ct_enc',
      description: 'Missing required field ct_enc must be rejected (never auto-repaired)',
      raw_json: JSON.stringify({
        v: 1,
        alg: 'xchacha20poly1305-ietf',
        key_id: vaultKeyId,
        nonce: sealedText.envelope.nonce,
      }),
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_duplicate_key_direct',
      description: 'Direct duplicate key ct_enc in raw JSON must be rejected before map/jsonb',
      raw_json: `{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"${vaultKeyId}","nonce":"${sealedText.envelope.nonce}","ct_enc":"utf8","ct_enc":"utf8"}`,
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_duplicate_key_unicode_escaped_underscore',
      description: 'Unicode-escaped duplicate key ("ct_enc" and "ct\\u005fenc") must be rejected',
      raw_json: `{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"${vaultKeyId}","nonce":"${sealedText.envelope.nonce}","ct_enc":"utf8","ct\\u005fenc":"utf8"}`,
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_duplicate_key_unicode_escaped_c',
      description: 'Unicode-escaped duplicate key ("ct_enc" and "\\u0063t_enc") must be rejected',
      raw_json: `{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"${vaultKeyId}","nonce":"${sealedText.envelope.nonce}","ct_enc":"utf8","\\u0063t_enc":"utf8"}`,
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_extra_field',
      description: 'Extra field ("type":"text") in envelope must be rejected',
      raw_json: JSON.stringify({
        ...sealedText.envelope,
        type: 'text',
      }),
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_wrong_version_2',
      description: 'Unsupported envelope version v=2 must be rejected',
      raw_json: JSON.stringify({
        ...sealedText.envelope,
        v: 2,
      }),
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_float_version',
      description: 'Floating-point version v=1.0 in raw JSON must be rejected',
      raw_json: `{"v":1.0,"alg":"xchacha20poly1305-ietf","key_id":"${vaultKeyId}","nonce":"${sealedText.envelope.nonce}","ct_enc":"utf8"}`,
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_wrong_alg',
      description: 'Unsupported algorithm aes-256-gcm must be rejected',
      raw_json: JSON.stringify({
        ...sealedText.envelope,
        alg: 'aes-256-gcm',
      }),
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_invalid_key_id',
      description: 'Malformed key_id not matching ^(vk|sk):[A-Za-z0-9_-]{22}$ must be rejected',
      raw_json: JSON.stringify({
        ...sealedText.envelope,
        key_id: 'vk:too-short',
      }),
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_nonce_wrong_length_16b',
      description: 'Envelope nonce of 16 bytes instead of 24 bytes must be rejected',
      raw_json: JSON.stringify({
        ...sealedText.envelope,
        nonce: kdfSaltB64u,
      }),
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_nonce_padded_base64',
      description: 'Envelope nonce with = padding must be rejected',
      raw_json: JSON.stringify({
        ...sealedText.envelope,
        nonce: `${sealedText.envelope.nonce.slice(0, 31)}=`,
      }),
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_wrong_ct_enc',
      description: 'Unsupported ct_enc="gzip" must be rejected',
      raw_json: JSON.stringify({
        ...sealedText.envelope,
        ct_enc: 'gzip',
      }),
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_invalid_entry_id_uppercase',
      description: 'Uppercase UUID entry_id must be rejected by validator',
      raw_json: JSON.stringify(sealedText.envelope),
      entry_id: textEntryId.toUpperCase(),
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'validation',
    },
    {
      id: 'env_tampered_entry_id_aead',
      description: 'Different valid UUID entry_id causes AAD mismatch and AEAD failure',
      raw_json: JSON.stringify(sealedText.envelope),
      entry_id: '00000000-0000-4000-8000-000000000001',
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'aead',
    },
    {
      id: 'env_tampered_key_id_aead',
      description: 'Different valid key_id in envelope causes JCS AAD mismatch and AEAD failure',
      raw_json: JSON.stringify({
        ...sealedText.envelope,
        key_id: 'vk:0000000000000000000000',
      }),
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'aead',
    },
    {
      id: 'env_tampered_nonce_aead',
      description: 'Different valid 24-byte nonce in envelope causes AEAD failure',
      raw_json: JSON.stringify({
        ...sealedText.envelope,
        nonce: encodeBase64Url(jsonNonceBytes),
      }),
      entry_id: textEntryId,
      ciphertext_b64u: sealedText.ciphertext,
      expected_error: 'aead',
    },
  ];

  const negativeWrap: NegativeWrapCase[] = [
    {
      id: 'wrap_kek_version_mutated_0x02',
      description: 'Mutating leading version byte to 0x02 fails validator (validation) and fails openWrap (aead via AAD binding)',
      kind: 'kek',
      wrap_b64u: encodeBase64Url(mutatedVersionKekWrap),
      key_hex: bytesToHex(kekBytes),
      validator_error: 'validation',
      open_error: 'aead',
    },
    {
      id: 'wrap_priv_version_mutated_0x00',
      description: 'Mutating leading version byte of priv wrap to 0x00 fails validator (validation) and fails openWrap (aead)',
      kind: 'priv',
      wrap_b64u: encodeBase64Url(mutatedVersionPrivWrap),
      key_hex: vkHex,
      validator_error: 'validation',
      open_error: 'aead',
    },
    {
      id: 'wrap_kek_tampered_tag',
      description: 'Tampered Poly1305 tag passes structural validator but fails openWrap with aead',
      kind: 'kek',
      wrap_b64u: encodeBase64Url(tamperedTagKekWrap),
      key_hex: bytesToHex(kekBytes),
      validator_error: null,
      open_error: 'aead',
    },
    {
      id: 'wrap_wrong_domain_rk_as_prf',
      description: 'Opening an RK wrap under PRF kind (wrong AAD label) passes validator but fails openWrap with aead',
      kind: 'prf',
      wrap_b64u: encodeBase64Url(rkWrapBytes),
      key_hex: bytesToHex(rkWrapKey),
      validator_error: null,
      open_error: 'aead',
    },
    {
      id: 'wrap_kek_short_72b',
      description: '72-byte VK wrap (1 byte short) fails both validator and openWrap with validation',
      kind: 'kek',
      wrap_b64u: encodeBase64Url(kekWrapBytes.subarray(0, 72)),
      key_hex: bytesToHex(kekBytes),
      validator_error: 'validation',
      open_error: 'validation',
    },
    {
      id: 'wrap_kek_long_74b',
      description: '74-byte VK wrap (1 byte long) fails both validator and openWrap with validation',
      kind: 'kek',
      wrap_b64u: encodeBase64Url(new Uint8Array(74).fill(0x01)),
      key_hex: bytesToHex(kekBytes),
      validator_error: 'validation',
      open_error: 'validation',
    },
    {
      id: 'wrap_priv_wrong_len_73b',
      description: '73-byte blob passed as priv wrap (expected 105 B) fails with validation',
      kind: 'priv',
      wrap_b64u: encodeBase64Url(kekWrapBytes),
      key_hex: vkHex,
      validator_error: 'validation',
      open_error: 'validation',
    },
    {
      id: 'wrap_kek_base64url_padding',
      description: 'Base64url string with = padding character fails strict decoder with validation',
      kind: 'kek',
      wrap_b64u: `${encodeBase64Url(kekWrapBytes)}=`,
      key_hex: bytesToHex(kekBytes),
      validator_error: 'validation',
      open_error: 'validation',
    },
  ];

  const negativeKdf: NegativeKdfCase[] = [
    {
      id: 'kdf_ops_below_min_2',
      description: 'Argon2id ops=2 (< 3) must be rejected before allocation',
      raw_json: JSON.stringify({ ...kdf, ops: 2 }),
      expected_error: 'kdf_params',
    },
    {
      id: 'kdf_ops_above_max_11',
      description: 'Argon2id ops=11 (> 10) must be rejected before allocation',
      raw_json: JSON.stringify({ ...kdf, ops: 11 }),
      expected_error: 'kdf_params',
    },
    {
      id: 'kdf_mem_below_64mib',
      description: 'Argon2id mem=67108863 (64 MiB - 1) must be rejected',
      raw_json: JSON.stringify({ ...kdf, mem: 67_108_863 }),
      expected_error: 'kdf_params',
    },
    {
      id: 'kdf_mem_above_256mib',
      description: 'Argon2id mem=268435457 (256 MiB + 1) must be rejected',
      raw_json: JSON.stringify({ ...kdf, mem: 268_435_457 }),
      expected_error: 'kdf_params',
    },
    {
      id: 'kdf_parallelism_not_1',
      description: 'Argon2id parallelism=2 (!== 1) must be rejected',
      raw_json: JSON.stringify({ ...kdf, parallelism: 2 }),
      expected_error: 'kdf_params',
    },
    {
      id: 'kdf_wrong_alg',
      description: 'Unsupported KDF alg="argon2i13" must be rejected',
      raw_json: JSON.stringify({ ...kdf, alg: 'argon2i13' }),
      expected_error: 'kdf_params',
    },
    {
      id: 'kdf_salt_wrong_len_15b',
      description: 'KDF salt of 15 bytes instead of 16 bytes must be rejected',
      raw_json: JSON.stringify({
        ...kdf,
        salt: encodeBase64Url(kdfSaltBytes.subarray(0, 15)),
      }),
      expected_error: 'kdf_params',
    },
    {
      id: 'kdf_extra_field',
      description: 'KDF object with extra field must be rejected',
      raw_json: JSON.stringify({ ...kdf, extra: 1 }),
      expected_error: 'kdf_params',
    },
    {
      id: 'kdf_duplicate_key',
      description: 'KDF raw JSON with duplicate key ops must be rejected',
      raw_json: `{"alg":"argon2id13","ops":3,"ops":3,"mem":67108864,"parallelism":1,"salt":"${kdfSaltB64u}"}`,
      expected_error: 'kdf_params',
    },
  ];

  return {
    schema: 'engram-crypto-vectors-v1',
    producer: 'js',
    inputs: {
      vk_hex: vkHex,
      vk_b64u: encodeBase64Url(vk),
      vault_key_id: vaultKeyId,
      passphrase_utf8: passphraseUtf8,
      passphrase_hex: bytesToHex(passphraseBytes),
      kdf_salt_hex: kdfSaltHex,
      kdf_salt_b64u: kdfSaltB64u,
      kdf,
      rk_slot: rkSlot,
      rk_entropy_hex: rkEntropyHex,
      rk_display: generatedRk.display,
      rk_norm: generatedRk.normalized,
      pwk_hex: pwkHex,
      pwk_b64u: encodeBase64Url(pwkBytes),
      x25519_seed_hex: x25519SeedHex,
      x25519_public_hex: bytesToHex(x25519Kp.publicKey),
      x25519_public_b64u: encodeBase64Url(x25519Kp.publicKey),
      ed25519_seed_hex: ed25519SeedHex,
      ed25519_public_hex: bytesToHex(ed25519Kp.publicKey),
      ed25519_public_b64u: encodeBase64Url(ed25519Kp.publicKey),
      nonces: {
        kek_wrap_nonce_hex: kekWrapNonceHex,
        rk_wrap_nonce_hex: rkWrapNonceHex,
        prf_wrap_nonce_hex: prfWrapNonceHex,
        priv_wrap_nonce_hex: privWrapNonceHex,
      },
      entries: {
        text: {
          entry_id: textEntryId,
          nonce_hex: textNonceHex,
          nonce_b64u: encodeBase64Url(textNonceBytes),
          plaintext_utf8: textPlaintextUtf8,
          plaintext_hex: bytesToHex(utf8Encoder.encode(textPlaintextUtf8)),
          envelope: sealedText.envelope,
          reordered_envelope_raw_json: [
            `{"ct_enc":"utf8","nonce":"${sealedText.envelope.nonce}","key_id":"${vaultKeyId}","alg":"xchacha20poly1305-ietf","v":1}`,
            `{\n  "nonce": "${sealedText.envelope.nonce}",\n  "v": 1,\n  "alg": "xchacha20poly1305-ietf",\n  "ct_enc": "utf8",\n  "key_id": "${vaultKeyId}"\n}`,
          ],
        },
        json: {
          entry_id: jsonEntryId,
          nonce_hex: jsonNonceHex,
          nonce_b64u: encodeBase64Url(jsonNonceBytes),
          plaintext_utf8: jsonPlaintextUtf8,
          plaintext_hex: bytesToHex(utf8Encoder.encode(jsonPlaintextUtf8)),
          envelope: sealedJson.envelope,
          reordered_envelope_raw_json: [
            `{"key_id":"${vaultKeyId}","v":1,"ct_enc":"utf8","alg":"xchacha20poly1305-ietf","nonce":"${sealedJson.envelope.nonce}"}`,
            `{\n  "ct_enc": "utf8",\n  "key_id": "${vaultKeyId}",\n  "nonce": "${sealedJson.envelope.nonce}",\n  "v": 1,\n  "alg": "xchacha20poly1305-ietf"\n}`,
          ],
        },
      },
    },
    derived: {
      kek_hex: bytesToHex(kekBytes),
      kek_b64u: encodeBase64Url(kekBytes),
      rk_lookup_hash_hex: bytesToHex(rkLookupHash),
      rk_lookup_hash_b64u: encodeBase64Url(rkLookupHash),
      rk_wrap_key_hex: bytesToHex(rkWrapKey),
      rk_wrap_key_b64u: encodeBase64Url(rkWrapKey),
      priv_plaintext_hex: bytesToHex(privPlaintext),
      wraps: {
        kek: {
          kind: 'kek',
          label: WRAP_LABELS.kek,
          version: WRAP_VERSION,
          aad_hex: bytesToHex(buildWrapAad(WRAP_LABELS.kek, WRAP_VERSION)),
          nonce_hex: kekWrapNonceHex,
          length_bytes: VK_WRAP_BYTES,
          wrap_hex: bytesToHex(kekWrapBytes),
          wrap_b64u: encodeBase64Url(kekWrapBytes),
        },
        rk: {
          kind: 'rk',
          label: WRAP_LABELS.rk,
          version: WRAP_VERSION,
          aad_hex: bytesToHex(buildWrapAad(WRAP_LABELS.rk, WRAP_VERSION)),
          nonce_hex: rkWrapNonceHex,
          length_bytes: VK_WRAP_BYTES,
          wrap_hex: bytesToHex(rkWrapBytes),
          wrap_b64u: encodeBase64Url(rkWrapBytes),
        },
        prf: {
          kind: 'prf',
          label: WRAP_LABELS.prf,
          version: WRAP_VERSION,
          aad_hex: bytesToHex(buildWrapAad(WRAP_LABELS.prf, WRAP_VERSION)),
          nonce_hex: prfWrapNonceHex,
          length_bytes: VK_WRAP_BYTES,
          wrap_hex: bytesToHex(prfWrapBytes),
          wrap_b64u: encodeBase64Url(prfWrapBytes),
        },
        priv: {
          kind: 'priv',
          label: WRAP_LABELS.priv,
          version: WRAP_VERSION,
          aad_hex: bytesToHex(buildWrapAad(WRAP_LABELS.priv, WRAP_VERSION)),
          nonce_hex: privWrapNonceHex,
          length_bytes: PRIV_WRAP_BYTES,
          wrap_hex: bytesToHex(privWrapBytes),
          wrap_b64u: encodeBase64Url(privWrapBytes),
        },
      },
      entries: {
        text: {
          entry_id: textEntryId,
          jcs_utf8: sealedText.jcs,
          jcs_hex: bytesToHex(utf8Encoder.encode(sealedText.jcs)),
          aad_hex: bytesToHex(sealedText.aad),
          ciphertext_hex: bytesToHex(sealedText.ciphertextBytes),
          ciphertext_b64u: sealedText.ciphertext,
        },
        json: {
          entry_id: jsonEntryId,
          jcs_utf8: sealedJson.jcs,
          jcs_hex: bytesToHex(utf8Encoder.encode(sealedJson.jcs)),
          aad_hex: bytesToHex(sealedJson.aad),
          ciphertext_hex: bytesToHex(sealedJson.ciphertextBytes),
          ciphertext_b64u: sealedJson.ciphertext,
        },
      },
    },
    negative: {
      envelope: negativeEnvelope,
      wrap: negativeWrap,
      kdf: negativeKdf,
    },
  };
}

/**
 * Verifies a full `CryptoVectorSuiteV1` (either `js-v1.json` or `go-v1.json`) using
 * the TypeScript crypto implementation (`libsodium-wrappers-sumo` 0.8.4 + `canonicalize` 5.1.0).
 */
export async function verifyVectorSuiteInTs(
  sodium: Sodium,
  suite: CryptoVectorSuiteV1,
): Promise<void> {
  expect(suite.schema).toBe('engram-crypto-vectors-v1');

  const vk = hexToBytes(suite.inputs.vk_hex);
  expect(encodeBase64Url(vk)).toBe(suite.inputs.vk_b64u);

  // 1. KDF validation + Argon2id derivation
  const validatedKdf = validateKdfParams(suite.inputs.kdf);
  expect(bytesToHex(validatedKdf.saltBytes)).toBe(suite.inputs.kdf_salt_hex);
  const passphraseBytes = hexToBytes(suite.inputs.passphrase_hex);
  const derivedKek = await deriveKek(sodium, passphraseBytes, suite.inputs.kdf);
  expect(bytesToHex(derivedKek)).toBe(suite.derived.kek_hex);
  expect(encodeBase64Url(derivedKek)).toBe(suite.derived.kek_b64u);

  // 2. Recovery key generation, normalization, lookup_hash & wrap_key
  const rkGen = generateRecoveryKey(
    sodium,
    suite.inputs.rk_slot,
    hexToBytes(suite.inputs.rk_entropy_hex),
  );
  expect(rkGen.display).toBe(suite.inputs.rk_display);
  expect(rkGen.normalized).toBe(suite.inputs.rk_norm);
  expect(normalizeRecoveryKey(suite.inputs.rk_display)).toBe(suite.inputs.rk_norm);

  const rkLookup = deriveRecoveryLookupHash(sodium, suite.inputs.rk_display);
  const rkWrapKey = deriveRecoveryWrapKey(sodium, suite.inputs.rk_display);
  expect(bytesToHex(rkLookup)).toBe(suite.derived.rk_lookup_hash_hex);
  expect(encodeBase64Url(rkLookup)).toBe(suite.derived.rk_lookup_hash_b64u);
  expect(bytesToHex(rkWrapKey)).toBe(suite.derived.rk_wrap_key_hex);
  expect(encodeBase64Url(rkWrapKey)).toBe(suite.derived.rk_wrap_key_b64u);

  // 3. Seed -> public key derivation (X25519 + Ed25519)
  const xSeed = hexToBytes(suite.inputs.x25519_seed_hex);
  const edSeed = hexToBytes(suite.inputs.ed25519_seed_hex);
  const xKp = sodium.crypto_box_seed_keypair(xSeed, 'uint8array');
  const edKp = sodium.crypto_sign_seed_keypair(edSeed, 'uint8array');
  expect(bytesToHex(xKp.publicKey)).toBe(suite.inputs.x25519_public_hex);
  expect(encodeBase64Url(xKp.publicKey)).toBe(suite.inputs.x25519_public_b64u);
  expect(bytesToHex(edKp.publicKey)).toBe(suite.inputs.ed25519_public_hex);
  expect(encodeBase64Url(edKp.publicKey)).toBe(suite.inputs.ed25519_public_b64u);

  // 4. All four wraps (validate + open + re-seal check)
  const pwk = hexToBytes(suite.inputs.pwk_hex);
  const wrapKeys: Record<WrapKind, Uint8Array> = {
    kek: derivedKek,
    rk: rkWrapKey,
    prf: pwk,
    priv: vk,
  };
  const expectedPlaintexts: Record<WrapKind, Uint8Array> = {
    kek: vk,
    rk: vk,
    prf: vk,
    priv: hexToBytes(suite.derived.priv_plaintext_hex),
  };

  for (const kind of ['kek', 'rk', 'prf', 'priv'] as const) {
    const wVec = suite.derived.wraps[kind];
    expect(wVec.kind).toBe(kind);
    expect(wVec.label).toBe(WRAP_LABELS[kind]);
    expect(wVec.version).toBe(1);
    expect(wVec.length_bytes).toBe(kind === 'priv' ? 105 : 73);

    const validatedBytes = validateWrap(wVec.wrap_b64u, kind);
    expect(bytesToHex(validatedBytes)).toBe(wVec.wrap_hex);
    expect(validatedBytes.byteLength).toBe(wVec.length_bytes);

    const openedPt = openWrap(sodium, kind, wVec.wrap_b64u, wrapKeys[kind]);
    expect(bytesToHex(openedPt)).toBe(bytesToHex(expectedPlaintexts[kind]));

    if (kind === 'priv') {
      const unpacked = unpackPrivateKeySeeds(openedPt);
      expect(bytesToHex(unpacked.x25519Seed)).toBe(suite.inputs.x25519_seed_hex);
      expect(bytesToHex(unpacked.ed25519Seed)).toBe(suite.inputs.ed25519_seed_hex);
    }

    const resealed = sealWrap(
      sodium,
      kind,
      expectedPlaintexts[kind],
      wrapKeys[kind],
      hexToBytes(wVec.nonce_hex),
    );
    expect(bytesToHex(resealed)).toBe(wVec.wrap_hex);
  }

  // 5. Entries (text and json) + reordered envelope JSON
  for (const entryType of ['text', 'json'] as const) {
    const inEntry = suite.inputs.entries[entryType];
    const derEntry = suite.derived.entries[entryType];

    const validatedEnv = validateEntryEnvelope(inEntry.envelope);
    const jcsStr = canonicalizeEnvelopeJcs(validatedEnv);
    expect(jcsStr).toBe(derEntry.jcs_utf8);
    expect(bytesToHex(utf8Encoder.encode(jcsStr))).toBe(derEntry.jcs_hex);

    const aad = buildEntryAad(validatedEnv, inEntry.entry_id);
    expect(bytesToHex(aad)).toBe(derEntry.aad_hex);

    const opened = openEntryPayload(sodium, {
      entryId: inEntry.entry_id,
      envelope: inEntry.envelope,
      ciphertext: derEntry.ciphertext_b64u,
      vk,
    });
    expect(opened.plaintext).toBe(inEntry.plaintext_utf8);
    expect(bytesToHex(opened.plaintextBytes)).toBe(inEntry.plaintext_hex);

    // Reordered raw JSON representations of the envelope must also validate and open
    for (const rawReordered of inEntry.reordered_envelope_raw_json) {
      const openedReordered = openEntryPayload(sodium, {
        entryId: inEntry.entry_id,
        envelope: rawReordered,
        ciphertext: derEntry.ciphertext_b64u,
        vk,
      });
      expect(openedReordered.plaintext).toBe(inEntry.plaintext_utf8);
    }
  }

  // 6. Negative envelope cases
  for (const negEnv of suite.negative.envelope) {
    let actualError: VectorErrorClass | null = null;
    try {
      openEntryPayload(sodium, {
        entryId: negEnv.entry_id,
        envelope: negEnv.raw_json,
        ciphertext: negEnv.ciphertext_b64u,
        vk,
      });
    } catch (err) {
      if (err instanceof EnvelopeError) {
        actualError = 'validation';
      } else if (err instanceof WrapError && err.code === 'AEAD_DECRYPT_FAILED') {
        actualError = 'aead';
      } else {
        throw err;
      }
    }
    expect(actualError, `Envelope negative case ${negEnv.id}`).toBe(negEnv.expected_error);
  }

  // 7. Negative wrap cases
  for (const negWrap of suite.negative.wrap) {
    let validatorVerdict: 'validation' | null = null;
    try {
      validateWrap(negWrap.wrap_b64u, negWrap.kind);
    } catch (err) {
      if (err instanceof WrapError && err.code === 'WRAP_INVALID') {
        validatorVerdict = 'validation';
      } else {
        throw err;
      }
    }
    expect(validatorVerdict, `Wrap validator case ${negWrap.id}`).toBe(negWrap.validator_error);

    let openVerdict: 'validation' | 'aead' | null = null;
    try {
      openWrap(sodium, negWrap.kind, negWrap.wrap_b64u, hexToBytes(negWrap.key_hex));
    } catch (err) {
      if (err instanceof WrapError) {
        openVerdict = err.code === 'WRAP_INVALID' ? 'validation' : 'aead';
      } else {
        throw err;
      }
    }
    expect(openVerdict, `Wrap open case ${negWrap.id}`).toBe(negWrap.open_error);
  }

  // 8. Negative KDF cases
  for (const negKdf of suite.negative.kdf) {
    let kdfVerdict: 'kdf_params' | null = null;
    try {
      const parsed = parseJsonRejectingDuplicateKeys(negKdf.raw_json);
      validateKdfParams(parsed);
    } catch (err) {
      if (err instanceof KdfError && err.code === 'KDF_PARAMS_INVALID') {
        kdfVerdict = 'kdf_params';
      } else if (err instanceof EnvelopeError) {
        // Duplicate key or malformed JSON in KDF object
        kdfVerdict = 'kdf_params';
      } else {
        throw err;
      }
    }
    expect(kdfVerdict, `KDF negative case ${negKdf.id}`).toBe(negKdf.expected_error);
  }
}

describe('P03-T6 Cross-Language Crypto Vectors (js-v1.json & go-v1.json)', () => {
  it('generates (when GEN_CRYPTO_VECTORS=1) and verifies byte-identical packages/crypto-vectors/vectors/js-v1.json', async () => {
    const sodium = await getSodium();
    const suite = await buildJsCryptoVectorSuite(sodium);
    const serialized = `${JSON.stringify(suite, null, 2)}\n`;

    if (process.env.GEN_CRYPTO_VECTORS === '1') {
      mkdirSync(dirname(JS_VECTORS_PATH), { recursive: true });
      writeFileSync(JS_VECTORS_PATH, serialized, 'utf8');
    }

    expect(existsSync(JS_VECTORS_PATH)).toBe(true);
    const committedText = readFileSync(JS_VECTORS_PATH, 'utf8');
    expect(committedText).toBe(serialized);

    const sha256 = createHash('sha256').update(committedText, 'utf8').digest('hex');
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('opens and validates every positive and negative vector in committed js-v1.json', async () => {
    const sodium = await getSodium();
    const committedText = readFileSync(JS_VECTORS_PATH, 'utf8');
    const suite = JSON.parse(committedText) as CryptoVectorSuiteV1;
    expect(suite.producer).toBe('js');
    await verifyVectorSuiteInTs(sodium, suite);
    expect(decodeBase64UrlStrict(suite.inputs.x25519_public_b64u, 32).byteLength).toBe(32);
    expect(decodeBase64UrlStrict(suite.inputs.ed25519_public_b64u, 32).byteLength).toBe(32);
  }, 30_000);

  it('opens and validates every positive and negative vector in committed go-v1.json (TS opens Go vectors)', async () => {
    expect(existsSync(GO_VECTORS_PATH)).toBe(true);
    const sodium = await getSodium();
    const committedText = readFileSync(GO_VECTORS_PATH, 'utf8');
    const suite = JSON.parse(committedText) as CryptoVectorSuiteV1;
    expect(suite.producer).toBe('go');
    await verifyVectorSuiteInTs(sodium, suite);

    expect(decodeBase64UrlStrict(suite.inputs.x25519_public_b64u, 32).byteLength).toBe(32);
    expect(decodeBase64UrlStrict(suite.inputs.ed25519_public_b64u, 32).byteLength).toBe(32);
  }, 30_000);
});
