# `@engram/crypto-vectors` — Cross-Language Crypto Vector Schema (v1)

Deterministic test vectors shared between TypeScript (`apps/web/lib/crypto/**`, powered by `libsodium-wrappers-sumo` 0.8.4 + `canonicalize` 5.1.0) and Go (`apps/api/internal/vault/**`, powered by `golang.org/x/crypto` v0.56.0 + `github.com/gowebpki/jcs` v1.0.2 + `golang.org/x/text` v0.41.0).

All values are fixed, deterministic test fixtures (**no real secrets**). Vector files are committed under `packages/crypto-vectors/vectors/` and **never regenerated at test time**. Re-running a generator with the same fixed inputs must produce a byte-identical JSON file (verified via SHA-256).

---

## 1. Vector Files

| File | Producer | Consumers | Scope |
|---|---|---|---|
| `vectors/js-v1.json` | TypeScript (`@engram/web`) | TypeScript & Go (`internal/vault/vectors_test.go`) | KDF, X25519/Ed25519 keypairs, 4 wrap types, JCS & entry envelope + AEAD, negative validation/AEAD/KDF cases |
| `vectors/go-v1.json` | Go (`apps/api/internal/vault`) | Go & TypeScript (`apps/web/lib/crypto/vectors.test.ts`) | Same schema as `js-v1.json`, generated with distinct deterministic Go test inputs |
| `vectors/rk-v1.json` | TypeScript (`@engram/web`) | TypeScript & Go (`internal/vault/recovery_test.go`) | Recovery key generation, 5-step Unicode/Crockford normalization, BLAKE2b-256 `lookup_hash` & `wrap_key`, positive & negative cases |

---

## 2. Encoding Conventions

1. **Raw byte fields (`*_hex`)**: lowercase hexadecimal string (even length, `0-9a-f`).
2. **API wire fields (`*_b64u` or API JSON object fields like `salt`, `nonce`)**: RFC 4648 §5 **base64url without padding (`=`)** (`A-Za-z0-9-_`).
3. **JSON formatting**: 2-space indented UTF-8 JSON with a trailing newline (`\n`). In `rk-v1.json`, non-ASCII characters in `input` strings are escaped as `\uXXXX` so the file stays pure ASCII and immune to editor encoding drift.
4. **Error classes (`expected_error`)**:
   - `"validation"` — structural, format, length, version byte (at validator layer), base64url, duplicate key, missing/extra field, or schema violation.
   - `"aead"` — AEAD authentication tag failure (`XChaCha20-Poly1305` decryption failure, including mutated leading `version` byte when passed to `openWrap`, tampered ciphertext/tag, wrong key, wrong AAD label, or tampered `entry_id` / envelope field during `openEntry`).
   - `"kdf_params"` — KDF parameter validation failure (`alg`, `ops` outside `3..10`, `mem` outside `64 MiB..256 MiB`, `parallelism != 1`, invalid `salt`, missing/extra/duplicate fields).

---

## 3. Schema for `vectors/js-v1.json` and `vectors/go-v1.json`

```ts
export type VectorErrorClass = "validation" | "aead" | "kdf_params";
export type WrapKind = "kek" | "rk" | "prf" | "priv";

export interface CryptoVectorSuiteV1 {
  /** Schema identifier, always "engram-crypto-vectors-v1" */
  schema: "engram-crypto-vectors-v1";
  /** Producer identifier: "js" for js-v1.json, "go" for go-v1.json */
  producer: "js" | "go";

  /** Fixed deterministic inputs */
  inputs: {
    /** 32-byte Vault Key (hex & base64url) */
    vk_hex: string;
    vk_b64u: string;

    /** Vault key identifier matching ^vk:[A-Za-z0-9_-]{22}$ */
    vault_key_id: string;

    /** UTF-8 passphrase string and its raw UTF-8 hex */
    passphrase_utf8: string;
    passphrase_hex: string;

    /** 16-byte Argon2id salt (hex & base64url) and full vault.kdf JSON object */
    kdf_salt_hex: string;
    kdf_salt_b64u: string;
    kdf: {
      alg: "argon2id13";
      ops: number;
      mem: number;
      parallelism: 1;
      salt: string; // base64url (no padding) of 16 bytes
    };

    /** Canonical recovery key string (`rk{n}_<26 Crockford chars>`) and its 16-byte raw entropy */
    rk_slot: number;
    rk_entropy_hex: string;
    rk_display: string;
    rk_norm: string;

    /** 32-byte WebAuthn PRF output (PWK) */
    pwk_hex: string;
    pwk_b64u: string;

    /** 32-byte seeds and derived 32-byte public keys (ADR 0002 §2) */
    x25519_seed_hex: string;
    x25519_public_hex: string;
    x25519_public_b64u: string;
    ed25519_seed_hex: string;
    ed25519_public_hex: string;
    ed25519_public_b64u: string;

    /** Fixed 24-byte nonces for the 4 server wraps */
    nonces: {
      kek_wrap_nonce_hex: string;
      rk_wrap_nonce_hex: string;
      prf_wrap_nonce_hex: string;
      priv_wrap_nonce_hex: string;
    };

    /** Entry inputs (text and json) */
    entries: {
      text: {
        entry_id: string;
        nonce_hex: string;
        nonce_b64u: string;
        plaintext_utf8: string;
        plaintext_hex: string;
        envelope: {
          v: 1;
          alg: "xchacha20poly1305-ietf";
          key_id: string;
          nonce: string;
          ct_enc: "utf8";
        };
        /** Alternative raw JSON representations of the same envelope (e.g. reordered keys / whitespace) that must canonicalize identically and open */
        reordered_envelope_raw_json: string[];
      };
      json: {
        entry_id: string;
        nonce_hex: string;
        nonce_b64u: string;
        plaintext_utf8: string;
        plaintext_hex: string;
        envelope: {
          v: 1;
          alg: "xchacha20poly1305-ietf";
          key_id: string;
          nonce: string;
          ct_enc: "utf8";
        };
        reordered_envelope_raw_json: string[];
      };
    };
  };

  /** Derived cryptographic values */
  derived: {
    /** 32-byte KEK derived via Argon2id v1.3 (ops=3, mem=64 MiB, p=1) */
    kek_hex: string;
    kek_b64u: string;

    /** 32-byte BLAKE2b-256("sabk.rk.lookup.v1" || rk_norm) and BLAKE2b-256("sabk.rk.wrap.v1" || rk_norm) */
    rk_lookup_hash_hex: string;
    rk_lookup_hash_b64u: string;
    rk_wrap_key_hex: string;
    rk_wrap_key_b64u: string;

    /** 64-byte concatenated seeds: x25519_seed(32) || ed25519_seed(32) */
    priv_plaintext_hex: string;

    /** The four server wraps (layout: 0x01 || nonce(24) || ciphertext || tag(16)) */
    wraps: {
      kek: WrapVectorEntry;
      rk: WrapVectorEntry;
      prf: WrapVectorEntry;
      priv: WrapVectorEntry;
    };

    /** Entry JCS, AAD, and XChaCha20-Poly1305 ciphertext */
    entries: {
      text: DerivedEntryVector;
      json: DerivedEntryVector;
    };
  };

  /** Negative test cases where both TS and Go must reject with the same error class */
  negative: {
    envelope: NegativeEnvelopeCase[];
    wrap: NegativeWrapCase[];
    kdf: NegativeKdfCase[];
  };
}

export interface WrapVectorEntry {
  kind: WrapKind;
  label: "sabk.vk.kek.v1" | "sabk.vk.rk.v1" | "sabk.vk.prf.v1" | "sabk.priv.v1";
  version: 1;
  aad_hex: string;
  nonce_hex: string;
  length_bytes: 73 | 105;
  wrap_hex: string;
  wrap_b64u: string;
}

export interface DerivedEntryVector {
  entry_id: string;
  /** Exact RFC 8785 JCS string and its UTF-8 hex */
  jcs_utf8: string;
  jcs_hex: string;
  /** UTF8("sabk.entry.v1") || 0x00 || UTF8(JCS(envelope)) || 0x00 || ASCII(entry_id) */
  aad_hex: string;
  /** Raw XChaCha20-Poly1305 output (ciphertext_body || tag(16)), no version/nonce prefix */
  ciphertext_hex: string;
  ciphertext_b64u: string;
}

export interface NegativeEnvelopeCase {
  id: string;
  description: string;
  /** Raw JSON string passed to envelope validator/parser */
  raw_json: string;
  /** Entry ID used when opening (may be mutated in tamper cases) */
  entry_id: string;
  /** Base64url ciphertext (used when envelope passes validation but fails AEAD on open) */
  ciphertext_b64u: string;
  expected_error: "validation" | "aead";
}

export interface NegativeWrapCase {
  id: string;
  description: string;
  kind: WrapKind;
  /** Base64url input string (may be malformed base64url, wrong length, mutated version byte, or tampered tag) */
  wrap_b64u: string;
  /** Key in hex (32 bytes) to use when attempting openWrap */
  key_hex: string;
  /** Expected verdict of the structural validator (`validateWrap` / `ValidateWrap`) */
  validator_error: "validation" | null;
  /** Expected verdict when attempting full decrypt (`openWrap` / `OpenWrap`):
   *  - Mutating byte 0 (`version`) causes `openWrap` to fail with `"aead"` because `version` is bound in AAD,
   *    while `validateWrap` rejects it with `"validation"`.
   *  - Malformed base64url or wrong byte length fails with `"validation"`.
   */
  open_error: "validation" | "aead";
}

export interface NegativeKdfCase {
  id: string;
  description: string;
  /** Raw JSON string of the candidate vault.kdf object */
  raw_json: string;
  expected_error: "kdf_params";
}
```

---

## 4. Schema for `vectors/rk-v1.json` (Task 7 Recovery Keys)

```ts
export interface RecoveryKeyVectorSuiteV1 {
  /** Schema identifier, always "engram-rk-vectors-v1" */
  schema: "engram-rk-vectors-v1";
  producer: "js";

  /** Deterministic generation vectors (16-byte raw entropy -> display + rk_norm + hashes) */
  generation: Array<{
    id: string;
    slot: number;
    entropy_hex: string;
    display: string;
    rk_norm: string;
    lookup_hash_hex: string;
    lookup_hash_b64u: string;
    wrap_key_hex: string;
    wrap_key_b64u: string;
  }>;

  /** Normalization + domain-separated hash cases (positive and negative) */
  cases: Array<{
    id: string;
    description: string;
    /** Raw input string (non-ASCII escaped as \uXXXX in the JSON file) */
    input: string;
    /** True if normalization succeeds, false if rejected */
    valid: boolean;
    /** Present when valid === true: canonical `rk{n}_<26 Crockford chars>` */
    rk_norm: string | null;
    /** Present when valid === true: lowercase hex of 32-byte BLAKE2b-256("sabk.rk.lookup.v1" || rk_norm) */
    lookup_hash_hex: string | null;
    /** Present when valid === true: lowercase hex of 32-byte BLAKE2b-256("sabk.rk.wrap.v1" || rk_norm) */
    wrap_key_hex: string | null;
    /** Present when valid === false: always "validation" */
    expected_error: "validation" | null;
  }>;
}
```
