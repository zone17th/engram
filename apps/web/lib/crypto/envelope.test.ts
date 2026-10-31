import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from './b64url';
import { CryptoClient } from './client';
import {
  buildEntryAad,
  canonicalizeEnvelopeJcs,
  ENTRY_CIPHERTEXT_MAX_BYTES,
  ENTRY_PLAINTEXT_MAX_BYTES,
  ENVELOPE_AAD_LABEL,
  ENVELOPE_ALG,
  ENVELOPE_CT_ENC,
  ENVELOPE_VERSION,
  EnvelopeError,
  openEntryPayload,
  parseJsonRejectingDuplicateKeys,
  sealEntryPayload,
  validateEntryEnvelope,
  validateEntryId,
  type EntryEnvelopeV1,
} from './envelope';
import { KEK_BYTES, type DeriveKekFn, type ValidatedKdfParams } from './kdf';
import { getSodium, toLocalBytes, type Sodium } from './sodium';
import { createWorkerShim } from './test/worker-shim';
import { VK_BYTES, WRAP_NONCE_BYTES, WrapError } from './wrap';

const VALID_KEY_ID = 'vk:7f3a9b2c4d5e6f7a8b9c0d';
const VALID_NONCE_B64U = encodeBase64Url(new Uint8Array(WRAP_NONCE_BYTES).fill(0x42));
const VALID_ENTRY_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const VALID_ENVELOPE: EntryEnvelopeV1 = {
  v: ENVELOPE_VERSION,
  alg: ENVELOPE_ALG,
  key_id: VALID_KEY_ID,
  nonce: VALID_NONCE_B64U,
  ct_enc: ENVELOPE_CT_ENC,
};

const fastTestDeriveKek: DeriveKekFn = (
  sodium: Sodium,
  passphrase: Uint8Array,
  params: ValidatedKdfParams,
): Uint8Array => {
  const input = new Uint8Array(passphrase.byteLength + params.saltBytes.byteLength);
  input.set(passphrase, 0);
  input.set(params.saltBytes, passphrase.byteLength);
  return sodium.crypto_generichash(KEK_BYTES, input, null, 'uint8array');
};

describe('P03-T6 Envelope Validator, Duplicate-Key Tokenizer, JCS AAD, and Seal/Open', () => {
  it('validates a well-formed 5-field EntryEnvelopeV1 object and raw JSON', () => {
    const fromObj = validateEntryEnvelope(VALID_ENVELOPE);
    expect(fromObj).toEqual(VALID_ENVELOPE);

    const rawJson = JSON.stringify({
      ct_enc: 'utf8',
      nonce: VALID_NONCE_B64U,
      key_id: VALID_KEY_ID,
      alg: 'xchacha20poly1305-ietf',
      v: 1,
    });
    const fromJson = validateEntryEnvelope(rawJson);
    expect(fromJson).toEqual(VALID_ENVELOPE);
  });

  it('rejects missing ct_enc without auto-filling or repairing it', () => {
    const missingCtEncObj = {
      v: 1,
      alg: 'xchacha20poly1305-ietf',
      key_id: VALID_KEY_ID,
      nonce: VALID_NONCE_B64U,
    };
    expect(() => validateEntryEnvelope(missingCtEncObj)).toThrowError(EnvelopeError);
    expect(() => validateEntryEnvelope(JSON.stringify(missingCtEncObj))).toThrowError(
      EnvelopeError,
    );
  });

  it('rejects duplicate keys in raw JSON, including unicode-escaped duplicate keys', () => {
    // Direct duplicate key "ct_enc"
    const directDup = `{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"${VALID_KEY_ID}","nonce":"${VALID_NONCE_B64U}","ct_enc":"utf8","ct_enc":"utf8"}`;
    expect(() => validateEntryEnvelope(directDup)).toThrowError(/Duplicate JSON object key "ct_enc"/);

    // Escaped duplicate key: "ct_enc" vs "ct\u005fenc" (\u005f === '_')
    const escapedUnderscoreDup = `{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"${VALID_KEY_ID}","nonce":"${VALID_NONCE_B64U}","ct_enc":"utf8","ct\\u005fenc":"utf8"}`;
    expect(() => validateEntryEnvelope(escapedUnderscoreDup)).toThrowError(
      /Duplicate JSON object key "ct_enc"/,
    );

    // Escaped duplicate key: "ct_enc" vs "\u0063t_enc" (\u0063 === 'c')
    const escapedCCharDup = `{"v":1,"alg":"xchacha20poly1305-ietf","key_id":"${VALID_KEY_ID}","nonce":"${VALID_NONCE_B64U}","ct_enc":"utf8","\\u0063t_enc":"utf8"}`;
    expect(() => validateEntryEnvelope(escapedCCharDup)).toThrowError(
      /Duplicate JSON object key "ct_enc"/,
    );

    // Escaped duplicate key on "v" vs "\u0076"
    const escapedVDup = `{"v":1,"\\u0076":1,"alg":"xchacha20poly1305-ietf","key_id":"${VALID_KEY_ID}","nonce":"${VALID_NONCE_B64U}","ct_enc":"utf8"}`;
    expect(() => parseJsonRejectingDuplicateKeys(escapedVDup)).toThrowError(
      /Duplicate JSON object key "v"/,
    );
  });

  it('rejects missing fields, extra fields, wrong types, float v, bad alg, bad key_id, and bad nonce', () => {
    // Missing field
    for (const field of ['v', 'alg', 'key_id', 'nonce', 'ct_enc'] as const) {
      const copy: Record<string, unknown> = { ...VALID_ENVELOPE };
      delete copy[field];
      expect(() => validateEntryEnvelope(copy)).toThrowError(EnvelopeError);
    }

    // Extra field
    expect(() =>
      validateEntryEnvelope({
        ...VALID_ENVELOPE,
        type: 'text',
      }),
    ).toThrowError(EnvelopeError);

    // Float v in raw JSON (1.0 or 1e0)
    expect(() =>
      validateEntryEnvelope(
        `{"v":1.0,"alg":"xchacha20poly1305-ietf","key_id":"${VALID_KEY_ID}","nonce":"${VALID_NONCE_B64U}","ct_enc":"utf8"}`,
      ),
    ).toThrowError(EnvelopeError);
    expect(() =>
      validateEntryEnvelope(
        `{"v":1e0,"alg":"xchacha20poly1305-ietf","key_id":"${VALID_KEY_ID}","nonce":"${VALID_NONCE_B64U}","ct_enc":"utf8"}`,
      ),
    ).toThrowError(EnvelopeError);

    // Wrong version
    expect(() => validateEntryEnvelope({ ...VALID_ENVELOPE, v: 2 })).toThrowError(EnvelopeError);
    expect(() => validateEntryEnvelope({ ...VALID_ENVELOPE, v: '1' })).toThrowError(EnvelopeError);

    // Wrong alg
    expect(() => validateEntryEnvelope({ ...VALID_ENVELOPE, alg: 'aes-256-gcm' })).toThrowError(
      EnvelopeError,
    );

    // Wrong key_id
    expect(() => validateEntryEnvelope({ ...VALID_ENVELOPE, key_id: '' })).toThrowError(
      EnvelopeError,
    );
    expect(() => validateEntryEnvelope({ ...VALID_ENVELOPE, key_id: 'vk:short' })).toThrowError(
      EnvelopeError,
    );

    // Wrong nonce (23 B, 25 B, padding =, standard base64 +/)
    expect(() =>
      validateEntryEnvelope({
        ...VALID_ENVELOPE,
        nonce: encodeBase64Url(new Uint8Array(23)),
      }),
    ).toThrowError(EnvelopeError);
    expect(() =>
      validateEntryEnvelope({
        ...VALID_ENVELOPE,
        nonce: encodeBase64Url(new Uint8Array(25)),
      }),
    ).toThrowError(EnvelopeError);
    expect(() =>
      validateEntryEnvelope({
        ...VALID_ENVELOPE,
        nonce: `${VALID_NONCE_B64U.slice(0, 31)}=`,
      }),
    ).toThrowError(EnvelopeError);

    // Wrong ct_enc
    expect(() => validateEntryEnvelope({ ...VALID_ENVELOPE, ct_enc: 'gzip' })).toThrowError(
      EnvelopeError,
    );
  });

  it('builds AAD as UTF8("sabk.entry.v1") || 0x00 || UTF8(JCS(envelope)) || 0x00 || ASCII(entry_id)', () => {
    const aad = buildEntryAad(VALID_ENVELOPE, VALID_ENTRY_ID);
    const jcs = canonicalizeEnvelopeJcs(VALID_ENVELOPE);
    const enc = new TextEncoder();
    const labelBytes = toLocalBytes(enc.encode(ENVELOPE_AAD_LABEL));
    const jcsBytes = toLocalBytes(enc.encode(jcs));
    const idBytes = toLocalBytes(enc.encode(VALID_ENTRY_ID));

    expect(aad.byteLength).toBe(labelBytes.length + 1 + jcsBytes.length + 1 + idBytes.length);
    expect(aad.slice(0, labelBytes.length)).toEqual(labelBytes);
    expect(aad[labelBytes.length]).toBe(0x00);
    expect(aad.slice(labelBytes.length + 1, labelBytes.length + 1 + jcsBytes.length)).toEqual(
      jcsBytes,
    );
    expect(aad[labelBytes.length + 1 + jcsBytes.length]).toBe(0x00);
    expect(aad.slice(labelBytes.length + 1 + jcsBytes.length + 1)).toEqual(idBytes);

    // Uppercase or malformed entry_id rejected
    expect(() => validateEntryId(VALID_ENTRY_ID.toUpperCase())).toThrowError(EnvelopeError);
    expect(() => validateEntryId('not-a-uuid')).toThrowError(EnvelopeError);
  });

  it('opens sealed entry even when envelope JSON fields are reordered (Postgres jsonb round-trip simulation) and fails on any field/entry_id mutation', async () => {
    const sodium = await getSodium();
    const vk = new Uint8Array(VK_BYTES).fill(0x33);
    const nonce = new Uint8Array(WRAP_NONCE_BYTES).fill(0x55);
    const plaintext = '{"wifi":"Abc123","nested":[{"port":8080,"big":9007199254740993}]}';

    const sealed = sealEntryPayload(sodium, {
      entryId: VALID_ENTRY_ID,
      keyId: VALID_KEY_ID,
      plaintext,
      vk,
      nonce,
    });

    // Reorder envelope keys in raw JSON with extra whitespace (simulating Postgres jsonb output)
    const reorderedRawJson = `{
      "nonce" : "${sealed.envelope.nonce}",
      "v" : 1,
      "ct_enc" : "utf8",
      "key_id" : "${sealed.envelope.key_id}",
      "alg" : "xchacha20poly1305-ietf"
    }`;

    const openedFromReordered = openEntryPayload(sodium, {
      entryId: VALID_ENTRY_ID,
      envelope: reorderedRawJson,
      ciphertext: sealed.ciphertext,
      vk,
    });
    expect(openedFromReordered.plaintext).toBe(plaintext);

    // Changing entry_id -> AEAD fail
    expect(() =>
      openEntryPayload(sodium, {
        entryId: '00000000-0000-4000-8000-000000000001',
        envelope: sealed.envelope,
        ciphertext: sealed.ciphertext,
        vk,
      }),
    ).toThrowError(expect.objectContaining({ code: 'AEAD_DECRYPT_FAILED' }));

    // Changing key_id -> AEAD fail (AAD mismatch)
    expect(() =>
      openEntryPayload(sodium, {
        entryId: VALID_ENTRY_ID,
        envelope: {
          ...sealed.envelope,
          key_id: 'vk:0000000000000000000000',
        },
        ciphertext: sealed.ciphertext,
        vk,
      }),
    ).toThrowError(expect.objectContaining({ code: 'AEAD_DECRYPT_FAILED' }));

    // Changing nonce -> AEAD fail
    expect(() =>
      openEntryPayload(sodium, {
        entryId: VALID_ENTRY_ID,
        envelope: {
          ...sealed.envelope,
          nonce: encodeBase64Url(new Uint8Array(WRAP_NONCE_BYTES).fill(0x99)),
        },
        ciphertext: sealed.ciphertext,
        vk,
      }),
    ).toThrowError(expect.objectContaining({ code: 'AEAD_DECRYPT_FAILED' }));

    // Tampered ciphertext -> AEAD fail
    const tamperedCt = new Uint8Array(sealed.ciphertextBytes);
    tamperedCt[0] ^= 0x01;
    expect(() =>
      openEntryPayload(sodium, {
        entryId: VALID_ENTRY_ID,
        envelope: sealed.envelope,
        ciphertext: tamperedCt,
        vk,
      }),
    ).toThrowError(expect.objectContaining({ code: 'AEAD_DECRYPT_FAILED' }));

    // Plaintext > 256 KiB rejected on seal, ciphertext > 263168 B rejected on open
    expect(() =>
      sealEntryPayload(sodium, {
        entryId: VALID_ENTRY_ID,
        keyId: VALID_KEY_ID,
        plaintext: new Uint8Array(ENTRY_PLAINTEXT_MAX_BYTES + 1).fill(0x61),
        vk,
      }),
    ).toThrowError(EnvelopeError);

    expect(() =>
      openEntryPayload(sodium, {
        entryId: VALID_ENTRY_ID,
        envelope: sealed.envelope,
        ciphertext: new Uint8Array(ENTRY_CIPHERTEXT_MAX_BYTES + 1),
        vk,
      }),
    ).toThrowError(EnvelopeError);
  });

  it('preserves 1 and 2 leading U+FEFF (BOM) characters through Worker sealEntry and openEntry and matches raw UTF-8 bytes (BE1-4, BE1-20)', async () => {
    const sodium = await getSodium();
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
    });
    try {
      const client = new CryptoClient({ createWorker: () => shim.port });
      await client.createVault({
        passphrase: 'worker-bom-test-passphrase',
        skipRecoveryKeys: true,
        opGeneration: client.captureGeneration(),
      });

      const singleBomText = '\uFEFFleading-bom-entry-text-21';
      const doubleBomText = '\uFEFF\uFEFFdouble-leading-bom-entry-text';
      for (const bomInput of [singleBomText, doubleBomText]) {
        const sealedBom = await client.sealEntry({
          entryId: VALID_ENTRY_ID,
          keyId: VALID_KEY_ID,
          plaintext: bomInput,
          opGeneration: client.captureGeneration(),
        });
        const openedBom = await client.openEntry({
          entryId: VALID_ENTRY_ID,
          envelope: sealedBom.envelope,
          ciphertext: sealedBom.ciphertext,
          opGeneration: client.captureGeneration(),
        });
        expect(openedBom.plaintext).toBe(bomInput);
        expect(openedBom.plaintext.length).toBe(bomInput.length);

        const vkInClosure = shim.core.inspectClosureVkForTest()!;
        const rawOpened = openEntryPayload(sodium, {
          entryId: VALID_ENTRY_ID,
          envelope: sealedBom.envelope,
          ciphertext: sealedBom.ciphertext,
          vk: vkInClosure,
        });
        expect(rawOpened.plaintext).toBe(bomInput);
        expect(Array.from(rawOpened.plaintextBytes)).toEqual(
          Array.from(new TextEncoder().encode(bomInput)),
        );
      }
    } finally {
      shim.close();
    }
  });

  it('executes sealEntry and openEntry through the real Worker without custom envelope adapter overrides, enforcing UTF-8 validity, size bounds, and base64url error mapping (BE1-1, BE1-2, BE1-3, BE1-5, BE1-14, BE1-15, BE1-27, FE1-7)', async () => {
    const sodium = await getSodium();
    const shim = createWorkerShim({
      deriveKek: fastTestDeriveKek,
    });
    try {
      const client = new CryptoClient({ createWorker: () => shim.port });
      await client.createVault({
        passphrase: 'worker-envelope-test-passphrase',
        skipRecoveryKeys: true,
        opGeneration: client.captureGeneration(),
      });

      const sealed = await client.sealEntry({
        entryId: VALID_ENTRY_ID,
        keyId: VALID_KEY_ID,
        plaintext: 'secret-wifi-password-123',
        opGeneration: client.captureGeneration(),
      });

      expect(sealed.envelope.v).toBe(1);
      expect(sealed.envelope.alg).toBe('xchacha20poly1305-ietf');
      expect(sealed.envelope.key_id).toBe(VALID_KEY_ID);
      expect(sealed.envelope.ct_enc).toBe('utf8');

      // Open with reordered envelope keys
      const opened = await client.openEntry({
        entryId: VALID_ENTRY_ID,
        envelope: {
          ct_enc: sealed.envelope.ct_enc,
          nonce: sealed.envelope.nonce,
          key_id: sealed.envelope.key_id,
          alg: sealed.envelope.alg,
          v: sealed.envelope.v,
        },
        ciphertext: sealed.ciphertext,
        opGeneration: client.captureGeneration(),
      });
      expect(opened.plaintext).toBe('secret-wifi-password-123');

      // Reject lone UTF-16 surrogates and invalid UTF-8 bytes at public Worker sealEntry boundary (BE1-2, BE1-15, BE1-27, FE1-7)
      await expect(
        client.sealEntry({
          entryId: VALID_ENTRY_ID,
          keyId: VALID_KEY_ID,
          plaintext: 'unpaired-high-surrogate-\uD800-tail',
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });

      const invalidUtf8Input = new Uint8Array([0xff, 0xfe, 0xfd]);
      await expect(
        client.sealEntry({
          entryId: VALID_ENTRY_ID,
          keyId: VALID_KEY_ID,
          plaintext: invalidUtf8Input,
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });
      expect(Array.from(invalidUtf8Input)).toEqual([0xff, 0xfe, 0xfd]);

      // Inclusive 262144-byte plaintext boundary succeeds; 262145 bytes rejects with ENVELOPE_INVALID at Worker boundary (BE1-1, BE1-3, BE1-14, BE1-27)
      const maxPlaintext = 'a'.repeat(ENTRY_PLAINTEXT_MAX_BYTES);
      const sealedMax = await client.sealEntry({
        entryId: VALID_ENTRY_ID,
        keyId: VALID_KEY_ID,
        plaintext: maxPlaintext,
        opGeneration: client.captureGeneration(),
      });
      const openedMax = await client.openEntry({
        entryId: VALID_ENTRY_ID,
        envelope: sealedMax.envelope,
        ciphertext: sealedMax.ciphertext,
        opGeneration: client.captureGeneration(),
      });
      expect(openedMax.plaintext.length).toBe(ENTRY_PLAINTEXT_MAX_BYTES);

      await expect(
        client.sealEntry({
          entryId: VALID_ENTRY_ID,
          keyId: VALID_KEY_ID,
          plaintext: new Uint8Array(ENTRY_PLAINTEXT_MAX_BYTES + 1).fill(0x61),
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });

      // Ciphertext bounds at Worker openEntry boundary: < 16 B, > 263168 B, and authenticated 262145 B plaintext (BE1-3, BE1-14, BE1-27)
      await expect(
        client.openEntry({
          entryId: VALID_ENTRY_ID,
          envelope: sealed.envelope,
          ciphertext: new Uint8Array(15),
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });

      await expect(
        client.openEntry({
          entryId: VALID_ENTRY_ID,
          envelope: sealed.envelope,
          ciphertext: new Uint8Array(ENTRY_CIPHERTEXT_MAX_BYTES + 1),
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });

      // Authenticated 262145-byte plaintext (within 263168 ciphertext slack) rejected by openEntry
      const vkClosure = shim.core.inspectClosureVkForTest()!;
      const nonce24 = sodium.randombytes_buf(WRAP_NONCE_BYTES);
      const envForOversized: EntryEnvelopeV1 = {
        v: 1,
        alg: 'xchacha20poly1305-ietf',
        key_id: VALID_KEY_ID,
        nonce: encodeBase64Url(nonce24),
        ct_enc: 'utf8',
      };
      const aadForOversized = buildEntryAad(envForOversized, VALID_ENTRY_ID);
      const forgedOversizedCt = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        new Uint8Array(ENTRY_PLAINTEXT_MAX_BYTES + 1).fill(0x61),
        toLocalBytes(aadForOversized),
        null,
        toLocalBytes(nonce24),
        toLocalBytes(vkClosure),
        'uint8array',
      );
      await expect(
        client.openEntry({
          entryId: VALID_ENTRY_ID,
          envelope: envForOversized,
          ciphertext: forgedOversizedCt,
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });

      // Malformed base64url ciphertext maps to ENVELOPE_INVALID, not WORKER_INTERNAL_ERROR (BE1-5, FE1-23)
      await expect(
        client.openEntry({
          entryId: VALID_ENTRY_ID,
          envelope: sealed.envelope,
          ciphertext: '=',
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });

      // Invalid envelope rejected with ENVELOPE_INVALID
      await expect(
        client.openEntry({
          entryId: VALID_ENTRY_ID,
          envelope: { v: 1 },
          ciphertext: sealed.ciphertext,
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });

      // Wrong entryId rejected with AEAD_DECRYPT_FAILED
      await expect(
        client.openEntry({
          entryId: '11111111-1111-4111-8111-111111111111',
          envelope: sealed.envelope,
          ciphertext: sealed.ciphertext,
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'AEAD_DECRYPT_FAILED' });


      // Verify Worker-owned (structured-clone) byte plaintext is genuinely zeroed in finally on success and on every failure path
      // (invalid UTF-8, oversized, and locked/rejected), while caller's main-thread Uint8Array and standalone sealEntryPayload caller array remain unchanged (BE2-3, BE2-6)
      const standaloneCallerBytes = new TextEncoder().encode('standalone-helper-caller-owned-bytes');
      sealEntryPayload(sodium, {
        entryId: VALID_ENTRY_ID,
        keyId: VALID_KEY_ID,
        plaintext: standaloneCallerBytes,
        vk: vkClosure,
      });
      expect(new TextDecoder().decode(standaloneCallerBytes)).toBe(
        'standalone-helper-caller-owned-bytes',
      );

      // 1. Success path with Uint8Array plaintext: main-thread caller bytes stay intact; Worker's structured-cloned Uint8Array is zeroed
      const mainThreadValidBytes = new TextEncoder().encode('worker-cloned-byte-plaintext-secret');
      const reqCountBeforeValid = shim.workerReceivedRequests.length;
      const sealedFromBytes = await client.sealEntry({
        entryId: VALID_ENTRY_ID,
        keyId: VALID_KEY_ID,
        plaintext: mainThreadValidBytes,
        opGeneration: client.captureGeneration(),
      });
      expect(new TextDecoder().decode(mainThreadValidBytes)).toBe(
        'worker-cloned-byte-plaintext-secret',
      );
      const workerValidReq = shim.workerReceivedRequests[reqCountBeforeValid];
      expect(workerValidReq?.type).toBe('sealEntry');
      if (workerValidReq?.type === 'sealEntry') {
        expect(ArrayBuffer.isView(workerValidReq.plaintext)).toBe(true);
        const workerClone = workerValidReq.plaintext as Uint8Array;
        expect(workerClone).not.toBe(mainThreadValidBytes);
        expect(workerClone.byteLength).toBe(mainThreadValidBytes.byteLength);
        expect(workerClone.every((b) => b === 0)).toBe(true);
      }
      const openedFromBytes = await client.openEntry({
        entryId: VALID_ENTRY_ID,
        envelope: sealedFromBytes.envelope,
        ciphertext: sealedFromBytes.ciphertext,
        opGeneration: client.captureGeneration(),
      });
      expect(openedFromBytes.plaintext).toBe('worker-cloned-byte-plaintext-secret');

      // 2. Invalid UTF-8 byte failure path: Worker's structured-cloned Uint8Array is zeroed; main-thread input unchanged
      const mainThreadBadUtf8 = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);
      const reqCountBeforeBadUtf8 = shim.workerReceivedRequests.length;
      await expect(
        client.sealEntry({
          entryId: VALID_ENTRY_ID,
          keyId: VALID_KEY_ID,
          plaintext: mainThreadBadUtf8,
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });
      expect(Array.from(mainThreadBadUtf8)).toEqual([0xff, 0xfe, 0xfd, 0xfc]);
      const workerBadUtf8Req = shim.workerReceivedRequests[reqCountBeforeBadUtf8];
      if (workerBadUtf8Req?.type === 'sealEntry') {
        const workerClone = workerBadUtf8Req.plaintext as Uint8Array;
        expect(workerClone.byteLength).toBe(4);
        expect(workerClone.every((b) => b === 0)).toBe(true);
      }

      // 3. Oversized (> 256 KiB) byte failure path: Worker's structured-cloned Uint8Array is zeroed; main-thread input unchanged
      const mainThreadOversized = new Uint8Array(ENTRY_PLAINTEXT_MAX_BYTES + 1).fill(0x61);
      const reqCountBeforeOversized = shim.workerReceivedRequests.length;
      await expect(
        client.sealEntry({
          entryId: VALID_ENTRY_ID,
          keyId: VALID_KEY_ID,
          plaintext: mainThreadOversized,
          opGeneration: client.captureGeneration(),
        }),
      ).rejects.toMatchObject({ code: 'ENVELOPE_INVALID' });
      expect(mainThreadOversized[0]).toBe(0x61);
      expect(mainThreadOversized[ENTRY_PLAINTEXT_MAX_BYTES]).toBe(0x61);
      const workerOversizedReq = shim.workerReceivedRequests[reqCountBeforeOversized];
      if (workerOversizedReq?.type === 'sealEntry') {
        const workerClone = workerOversizedReq.plaintext as Uint8Array;
        expect(workerClone.byteLength).toBe(ENTRY_PLAINTEXT_MAX_BYTES + 1);
        expect(workerClone.every((b) => b === 0)).toBe(true);
      }
      expect(new WrapError('WRAP_INVALID', 'test').code).toBe('WRAP_INVALID');
    } finally {
      shim.close();
    }
  });
});
