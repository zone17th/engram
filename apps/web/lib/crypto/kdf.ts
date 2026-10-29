import { decodeBase64UrlStrict, encodeBase64Url } from './b64url';
import { toLocalBytes, type Sodium } from './sodium';

import {
  KDF_ALG,
  KDF_MEM_MAX,
  KDF_MEM_MIN,
  KDF_OPS_MAX,
  KDF_OPS_MIN,
  KDF_PARALLELISM,
  KDF_SALT_BYTES,
  KEK_BYTES,
  type VaultKdfParams,
} from './protocol';

export {
  KDF_ALG,
  KDF_MEM_MAX,
  KDF_MEM_MIN,
  KDF_OPS_MAX,
  KDF_OPS_MIN,
  KDF_PARALLELISM,
  KDF_SALT_BYTES,
  KEK_BYTES,
  type VaultKdfParams,
};

export interface ValidatedKdfParams extends VaultKdfParams {
  saltBytes: Uint8Array;
}

export type KdfErrorCode =
  | 'KDF_PARAMS_INVALID'
  | 'KDF_ALLOCATION_FAILED'
  | 'KDF_DERIVE_FAILED';

export class KdfError extends Error {
  readonly code: KdfErrorCode;

  constructor(code: KdfErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KdfError';
    this.code = code;
  }
}

const REQUIRED_KDF_KEYS: Record<string, true> = {
  alg: true,
  ops: true,
  mem: true,
  parallelism: true,
  salt: true,
};

/**
 * Validates `vault.kdf` BEFORE any WASM memory allocation or derivation.
 * Enforces ADR 0002 §4:
 * - Exactly 5 fields (`alg`, `ops`, `mem`, `parallelism`, `salt`)
 * - `alg === 'argon2id13'`
 * - Integer `ops` in [3, 10]
 * - Integer `mem` in [67108864 (64 MiB), 268435456 (256 MiB)]
 * - Integer `parallelism === 1`
 * - `salt` is strict base64url (no padding) decoding to exactly 16 bytes
 */
export function validateKdfParams(input: unknown): ValidatedKdfParams {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new KdfError('KDF_PARAMS_INVALID', 'KDF params must be a non-null JSON object');
  }

  const keys = Object.keys(input);
  if (keys.length !== 5) {
    throw new KdfError(
      'KDF_PARAMS_INVALID',
      `KDF params must have exactly 5 fields, got ${keys.length}`,
    );
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(REQUIRED_KDF_KEYS, key)) {
      throw new KdfError('KDF_PARAMS_INVALID', `Unexpected KDF param field: ${key}`);
    }
  }

  const record = input as Record<string, unknown>;
  const { alg, ops, mem, parallelism, salt } = record;

  if (alg !== KDF_ALG) {
    throw new KdfError('KDF_PARAMS_INVALID', `Unsupported KDF algorithm: ${String(alg)}`);
  }

  if (typeof ops !== 'number' || !Number.isSafeInteger(ops) || ops < KDF_OPS_MIN || ops > KDF_OPS_MAX) {
    throw new KdfError(
      'KDF_PARAMS_INVALID',
      `KDF ops must be an integer between ${KDF_OPS_MIN} and ${KDF_OPS_MAX}`,
    );
  }

  if (typeof mem !== 'number' || !Number.isSafeInteger(mem) || mem < KDF_MEM_MIN || mem > KDF_MEM_MAX) {
    throw new KdfError(
      'KDF_PARAMS_INVALID',
      `KDF mem must be an integer between ${KDF_MEM_MIN} and ${KDF_MEM_MAX}`,
    );
  }

  if (typeof parallelism !== 'number' || !Number.isSafeInteger(parallelism) || parallelism !== KDF_PARALLELISM) {
    throw new KdfError('KDF_PARAMS_INVALID', `KDF parallelism must be ${KDF_PARALLELISM}`);
  }

  if (typeof salt !== 'string') {
    throw new KdfError('KDF_PARAMS_INVALID', 'KDF salt must be a base64url string');
  }

  let saltBytes: Uint8Array;
  try {
    saltBytes = decodeBase64UrlStrict(salt, KDF_SALT_BYTES);
  } catch (err) {
    throw new KdfError('KDF_PARAMS_INVALID', 'KDF salt must be valid 16-byte base64url without padding', {
      cause: err,
    });
  }

  return {
    alg: KDF_ALG,
    ops,
    mem,
    parallelism: KDF_PARALLELISM,
    salt,
    saltBytes,
  };
}

/**
 * Generates baseline KDF params for a new vault (`ops=3, mem=64 MiB, p=1` + 16 B CSPRNG salt).
 */
export function makeBaselineKdfParams(sodium: Sodium): VaultKdfParams {
  const saltBytes = sodium.randombytes_buf(KDF_SALT_BYTES);
  return {
    alg: KDF_ALG,
    ops: KDF_OPS_MIN,
    mem: KDF_MEM_MIN,
    parallelism: KDF_PARALLELISM,
    salt: encodeBase64Url(saltBytes),
  };
}

/**
 * Produces new KDF params for rewrap/recovery by validating `currentKdf`,
 * preserving `(ops, mem, parallelism)` without lowering (ADR 0002 §4-§5, advisor-dec-004),
 * and generating a fresh 16-byte salt guaranteed to differ from `currentKdf.salt`.
 */
export function makeRewrapKdfParams(sodium: Sodium, currentKdf: unknown): VaultKdfParams {
  const validated = validateKdfParams(currentKdf);
  let newSalt: string;
  do {
    const newSaltBytes = sodium.randombytes_buf(KDF_SALT_BYTES);
    newSalt = encodeBase64Url(newSaltBytes);
  } while (newSalt === validated.salt);

  return {
    alg: KDF_ALG,
    ops: validated.ops,
    mem: validated.mem,
    parallelism: validated.parallelism,
    salt: newSalt,
  };
}

export type DeriveKekFn = (
  sodium: Sodium,
  passphrase: Uint8Array,
  params: ValidatedKdfParams,
) => Uint8Array | Promise<Uint8Array>;

const ENOMEM = 12;

/**
 * Classifies WASM/Argon2id memory allocation failures by error type or errno
 * (`RangeError`, `WebAssembly.RuntimeError`, or `errno === 12` / `code === 'ENOMEM'`),
 * never by substring matching on arbitrary error messages (FE1-14).
 */
export function isAllocationFailure(err: unknown): boolean {
  if (err instanceof RangeError) return true;
  if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) {
    return true;
  }
  if (typeof err === 'object' && err !== null) {
    if ('errno' in err && err.errno === ENOMEM) {
      return true;
    }
    if ('code' in err && err.code === 'ENOMEM') {
      return true;
    }
  }
  return false;
}

/**
 * Default Argon2id v1.3 KEK derivation using `libsodium-wrappers-sumo` `crypto_pwhash`.
 * Validates `kdfParams` BEFORE calling `crypto_pwhash`.
 * Maps WASM memory/derive failures to `KDF_ALLOCATION_FAILED` or `KDF_DERIVE_FAILED`,
 * distinct from `AEAD_DECRYPT_FAILED` (ADR 0002 §6).
 */
export function deriveKek(
  sodium: Sodium,
  passphrase: Uint8Array,
  kdfParams: unknown,
  customDerive?: DeriveKekFn,
): Uint8Array | Promise<Uint8Array> {
  const validated = validateKdfParams(kdfParams);
  const localPass = toLocalBytes(passphrase);
  try {
    if (customDerive) {
      const result = customDerive(sodium, localPass, validated);
      if (result instanceof Promise) {
        return result.catch((err: unknown) => {
          if (err instanceof KdfError) throw err;
          const code: KdfErrorCode = isAllocationFailure(err)
            ? 'KDF_ALLOCATION_FAILED'
            : 'KDF_DERIVE_FAILED';
          throw new KdfError(
            code,
            err instanceof Error ? err.message : 'Argon2id derivation failed',
            { cause: err },
          );
        });
      }
      return result;
    }

    return sodium.crypto_pwhash(
      KEK_BYTES,
      localPass,
      toLocalBytes(validated.saltBytes),
      validated.ops,
      validated.mem,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
      'uint8array',
    );
  } catch (err) {
    if (err instanceof KdfError) throw err;
    const code: KdfErrorCode = isAllocationFailure(err)
      ? 'KDF_ALLOCATION_FAILED'
      : 'KDF_DERIVE_FAILED';
    throw new KdfError(
      code,
      err instanceof Error ? err.message : 'Argon2id derivation failed',
      { cause: err },
    );
  }
}
