import { decodeBase64UrlStrict, encodeBase64Url } from './b64url';
import { toLocalBytes, type Sodium } from './sodium';

export const WRAP_VERSION = 0x01;
export const WRAP_NONCE_BYTES = 24;
export const WRAP_TAG_BYTES = 16;

export const VK_BYTES = 32;
export const SEED_BYTES = 32;
export const PRIV_PLAINTEXT_BYTES = 64; // x25519_seed(32) || ed25519_seed(32)

export const VK_WRAP_BYTES = 73; // 1 + 24 + 32 + 16
export const PRIV_WRAP_BYTES = 105; // 1 + 24 + 64 + 16

export const DEVKEY_IV_BYTES = 12;
export const DEVKEY_WRAP_BYTES = 60; // 12 + 32 + 16

export const WRAP_LABELS = {
  kek: 'sabk.vk.kek.v1',
  rk: 'sabk.vk.rk.v1',
  prf: 'sabk.vk.prf.v1',
  priv: 'sabk.priv.v1',
} as const;

export const DEVKEY_LABEL = 'sabk.devkey.v1' as const;

export type WrapKind = keyof typeof WRAP_LABELS;
export type WrapLabel = (typeof WRAP_LABELS)[WrapKind];

const EXPECTED_WRAP_LEN_BY_KIND: Record<WrapKind, number> = {
  kek: VK_WRAP_BYTES,
  rk: VK_WRAP_BYTES,
  prf: VK_WRAP_BYTES,
  priv: PRIV_WRAP_BYTES,
};

const EXPECTED_PLAINTEXT_LEN_BY_KIND: Record<WrapKind, number> = {
  kek: VK_BYTES,
  rk: VK_BYTES,
  prf: VK_BYTES,
  priv: PRIV_PLAINTEXT_BYTES,
};

export type WrapErrorCode =
  | 'WRAP_INVALID'
  | 'AEAD_DECRYPT_FAILED'
  | 'WRAP_SELF_CHECK_FAILED';

export class WrapError extends Error {
  readonly code: WrapErrorCode;

  constructor(code: WrapErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WrapError';
    this.code = code;
  }
}

const utf8Encoder = new TextEncoder();

/**
 * Builds AAD for server-stored wraps (ADR 0002 §1, plan mục 2.1):
 * `UTF8(label) || 0x00 || version(1)`
 */
export function buildWrapAad(label: WrapLabel, version: number = WRAP_VERSION): Uint8Array {
  const labelBytes = toLocalBytes(utf8Encoder.encode(label));
  const aad = new Uint8Array(labelBytes.length + 2);
  aad.set(labelBytes, 0);
  aad[labelBytes.length] = 0x00;
  aad[labelBytes.length + 1] = version & 0xff;
  return aad;
}

/**
 * Builds AAD for WebCrypto AES-GCM DevKey wrap (ADR 0002 §1, ADR 0003 §6):
 * `UTF8("sabk.devkey.v1") || 0x00 || UTF8(user_id) || 0x00 || UTF8(vault_key_id)`
 */
export function buildDevKeyAad(userId: string, vaultKeyId: string): Uint8Array {
  if (!userId || !vaultKeyId) {
    throw new WrapError('WRAP_INVALID', 'user_id and vault_key_id are required for DevKey AAD');
  }
  const prefix = toLocalBytes(utf8Encoder.encode(DEVKEY_LABEL));
  const userBytes = toLocalBytes(utf8Encoder.encode(userId));
  const vkIdBytes = toLocalBytes(utf8Encoder.encode(vaultKeyId));
  const aad = new Uint8Array(prefix.length + 1 + userBytes.length + 1 + vkIdBytes.length);
  let offset = 0;
  aad.set(prefix, offset);
  offset += prefix.length;
  aad[offset++] = 0x00;
  aad.set(userBytes, offset);
  offset += userBytes.length;
  aad[offset++] = 0x00;
  aad.set(vkIdBytes, offset);
  return aad;
}

/**
 * Validates wrap length and leading version byte (`0x01`).
 * Accepts either raw `Uint8Array` or strict base64url string.
 */
export function validateWrap(input: Uint8Array | string, kind: WrapKind): Uint8Array {
  const expectedLen = EXPECTED_WRAP_LEN_BY_KIND[kind];
  let bytes: Uint8Array;

  if (typeof input === 'string') {
    try {
      bytes = decodeBase64UrlStrict(input, expectedLen);
    } catch (err) {
      throw new WrapError('WRAP_INVALID', `Invalid ${kind} wrap base64url or byte length`, {
        cause: err,
      });
    }
  } else if (input instanceof Uint8Array || ArrayBuffer.isView(input)) {
    const view = toLocalBytes(input);
    if (view.byteLength !== expectedLen) {
      throw new WrapError(
        'WRAP_INVALID',
        `Expected ${expectedLen} bytes for ${kind} wrap, got ${view.byteLength}`,
      );
    }
    bytes = view;
  } else {
    throw new WrapError('WRAP_INVALID', 'Wrap input must be a Uint8Array or base64url string');
  }

  if (bytes[0] !== WRAP_VERSION) {
    throw new WrapError(
      'WRAP_INVALID',
      `Unsupported wrap version 0x${(bytes[0] ?? 0).toString(16).padStart(2, '0')}`,
    );
  }

  return bytes;
}

/**
 * Seals plaintext (`32 B` VK or `64 B` private seeds) with XChaCha20-Poly1305 IETF:
 * `version(1)=0x01 || nonce(24) || ciphertext || tag(16)`
 */
export function sealWrap(
  sodium: Sodium,
  kind: WrapKind,
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce?: Uint8Array,
): Uint8Array {
  const expectedPtLen = EXPECTED_PLAINTEXT_LEN_BY_KIND[kind];
  if (plaintext.byteLength !== expectedPtLen) {
    throw new WrapError(
      'WRAP_INVALID',
      `Plaintext for ${kind} wrap must be ${expectedPtLen} bytes, got ${plaintext.byteLength}`,
    );
  }
  if (key.byteLength !== VK_BYTES) {
    throw new WrapError('WRAP_INVALID', `Key for ${kind} wrap must be 32 bytes`);
  }

  const n = nonce ?? sodium.randombytes_buf(WRAP_NONCE_BYTES);
  if (n.byteLength !== WRAP_NONCE_BYTES) {
    throw new WrapError('WRAP_INVALID', 'Wrap nonce must be 24 bytes');
  }

  const aad = buildWrapAad(WRAP_LABELS[kind], WRAP_VERSION);
  const ctAndTag = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    toLocalBytes(plaintext),
    aad,
    null,
    toLocalBytes(n),
    toLocalBytes(key),
    'uint8array',
  );

  const out = new Uint8Array(1 + WRAP_NONCE_BYTES + ctAndTag.byteLength);
  out[0] = WRAP_VERSION;
  out.set(n, 1);
  out.set(ctAndTag, 1 + WRAP_NONCE_BYTES);
  return out;
}

/**
 * Opens a wrap (`73 B` for VK, `105 B` for private keys) with XChaCha20-Poly1305 IETF.
 * Notice: the leading `version` byte from the blob is placed into the AAD (`label || 0x00 || version`)
 * so that if version is mutated, AEAD authentication fails (`AEAD_DECRYPT_FAILED`).
 * When `strictVersionCheck` is true (default for general validator), non-0x01 versions also fail.
 */
export function openWrap(
  sodium: Sodium,
  kind: WrapKind,
  wrapInput: Uint8Array | string,
  key: Uint8Array,
): Uint8Array {
  const expectedLen = EXPECTED_WRAP_LEN_BY_KIND[kind];
  let wrapBytes: Uint8Array;

  if (typeof wrapInput === 'string') {
    try {
      wrapBytes = decodeBase64UrlStrict(wrapInput, expectedLen);
    } catch (err) {
      throw new WrapError('WRAP_INVALID', `Invalid ${kind} wrap base64url or byte length`, {
        cause: err,
      });
    }
  } else if (wrapInput instanceof Uint8Array || ArrayBuffer.isView(wrapInput)) {
    const view = toLocalBytes(wrapInput);
    if (view.byteLength !== expectedLen) {
      throw new WrapError(
        'WRAP_INVALID',
        `Expected ${expectedLen} bytes for ${kind} wrap, got ${view.byteLength}`,
      );
    }
    wrapBytes = view;
  } else {
    throw new WrapError('WRAP_INVALID', 'Wrap input must be a Uint8Array or base64url string');
  }

  if (key.byteLength !== VK_BYTES) {
    throw new WrapError('WRAP_INVALID', `Key for ${kind} wrap must be 32 bytes`);
  }

  const versionByte = wrapBytes[0]!;
  const nonce = wrapBytes.subarray(1, 1 + WRAP_NONCE_BYTES);
  const ctAndTag = wrapBytes.subarray(1 + WRAP_NONCE_BYTES);
  const aad = buildWrapAad(WRAP_LABELS[kind], versionByte);

  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      toLocalBytes(ctAndTag),
      aad,
      toLocalBytes(nonce),
      toLocalBytes(key),
      'uint8array',
    );
  } catch (err) {
    throw new WrapError('AEAD_DECRYPT_FAILED', `AEAD decryption failed for ${kind} wrap`, {
      cause: err,
    });
  }

  if (versionByte !== WRAP_VERSION) {
    sodium.memzero(plaintext);
    throw new WrapError('AEAD_DECRYPT_FAILED', `Unsupported wrap version 0x${versionByte.toString(16)}`);
  }

  return plaintext;
}

export function sealWrapBase64Url(
  sodium: Sodium,
  kind: WrapKind,
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce?: Uint8Array,
): string {
  return encodeBase64Url(sealWrap(sodium, kind, plaintext, key, nonce));
}

/**
 * Packs `x25519Seed(32) || ed25519Seed(32)` into a 64-byte buffer.
 */
export function packPrivateKeySeeds(x25519Seed: Uint8Array, ed25519Seed: Uint8Array): Uint8Array {
  if (x25519Seed.byteLength !== SEED_BYTES || ed25519Seed.byteLength !== SEED_BYTES) {
    throw new WrapError('WRAP_INVALID', 'X25519 and Ed25519 seeds must each be 32 bytes');
  }
  const combined = new Uint8Array(PRIV_PLAINTEXT_BYTES);
  combined.set(x25519Seed, 0);
  combined.set(ed25519Seed, SEED_BYTES);
  return combined;
}

/**
 * Unpacks a 64-byte plaintext buffer into copied `x25519Seed(32)` and `ed25519Seed(32)`.
 */
export function unpackPrivateKeySeeds(combined: Uint8Array): {
  x25519Seed: Uint8Array;
  ed25519Seed: Uint8Array;
} {
  if (combined.byteLength !== PRIV_PLAINTEXT_BYTES) {
    throw new WrapError('WRAP_INVALID', 'Combined private key seeds must be 64 bytes');
  }
  return {
    x25519Seed: combined.slice(0, SEED_BYTES),
    ed25519Seed: combined.slice(SEED_BYTES, PRIV_PLAINTEXT_BYTES),
  };
}

/**
 * Wraps a 32-byte VK under a WebCrypto AES-GCM-256 `CryptoKey` (`DevKey`):
 * `iv(12) || ciphertext_and_tag(48)` (60 B total), AAD `sabk.devkey.v1 || 0x00 || user_id || 0x00 || vault_key_id`.
 */
export async function sealDevKeyWrap(
  sodium: Sodium,
  vk: Uint8Array,
  devKey: CryptoKey,
  userId: string,
  vaultKeyId: string,
  iv?: Uint8Array,
): Promise<Uint8Array> {
  if (vk.byteLength !== VK_BYTES) {
    throw new WrapError('WRAP_INVALID', 'VK must be 32 bytes');
  }
  const ivBytes = iv ?? sodium.randombytes_buf(DEVKEY_IV_BYTES);
  if (ivBytes.byteLength !== DEVKEY_IV_BYTES) {
    throw new WrapError('WRAP_INVALID', 'DevKey IV must be 12 bytes');
  }
  const aad = buildDevKeyAad(userId, vaultKeyId);
  const ctBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: ivBytes as Uint8Array<ArrayBuffer>,
      additionalData: aad as Uint8Array<ArrayBuffer>,
      tagLength: 128,
    },
    devKey,
    vk as Uint8Array<ArrayBuffer>,
  );
  const ctBytes = new Uint8Array(ctBuffer);
  const out = new Uint8Array(DEVKEY_IV_BYTES + ctBytes.byteLength);
  out.set(ivBytes, 0);
  out.set(ctBytes, DEVKEY_IV_BYTES);
  return out;
}

/**
 * Unwraps a 60-byte DevKey wrap (`iv(12) || ct+tag(48)`) using WebCrypto AES-GCM-256.
 */
export async function openDevKeyWrap(
  wrapInput: Uint8Array | string,
  devKey: CryptoKey,
  userId: string,
  vaultKeyId: string,
): Promise<Uint8Array> {
  let wrapBytes: Uint8Array;
  if (typeof wrapInput === 'string') {
    try {
      wrapBytes = decodeBase64UrlStrict(wrapInput, DEVKEY_WRAP_BYTES);
    } catch (err) {
      throw new WrapError('WRAP_INVALID', 'Invalid DevKey wrap base64url or length', { cause: err });
    }
  } else if (wrapInput instanceof Uint8Array || ArrayBuffer.isView(wrapInput)) {
    const view = toLocalBytes(wrapInput);
    if (view.byteLength !== DEVKEY_WRAP_BYTES) {
      throw new WrapError(
        'WRAP_INVALID',
        `Expected ${DEVKEY_WRAP_BYTES} bytes for DevKey wrap, got ${view.byteLength}`,
      );
    }
    wrapBytes = view;
  } else {
    throw new WrapError('WRAP_INVALID', 'DevKey wrap input must be Uint8Array or base64url string');
  }

  const iv = wrapBytes.slice(0, DEVKEY_IV_BYTES);
  const ctAndTag = wrapBytes.slice(DEVKEY_IV_BYTES);
  const aad = buildDevKeyAad(userId, vaultKeyId);

  try {
    const ptBuffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as Uint8Array<ArrayBuffer>,
        additionalData: aad as Uint8Array<ArrayBuffer>,
        tagLength: 128,
      },
      devKey,
      ctAndTag as Uint8Array<ArrayBuffer>,
    );
    return new Uint8Array(ptBuffer);
  } catch (err) {
    throw new WrapError('AEAD_DECRYPT_FAILED', 'DevKey AES-GCM decryption failed', { cause: err });
  }
}
