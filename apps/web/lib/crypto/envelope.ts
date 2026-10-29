import { decodeBase64UrlStrict, encodeBase64Url } from './b64url';
import { canonicalizeJcs, JcsError } from './jcs';
import { toLocalBytes, type Sodium } from './sodium';
import { VK_BYTES, WRAP_NONCE_BYTES, WrapError } from './wrap';

export const ENVELOPE_VERSION = 1 as const;
export const ENVELOPE_ALG = 'xchacha20poly1305-ietf' as const;
export const ENVELOPE_CT_ENC = 'utf8' as const;
export const ENVELOPE_AAD_LABEL = 'sabk.entry.v1' as const;
export const ENTRY_PLAINTEXT_MAX_BYTES = 262_144; // 256 KiB
export const ENTRY_CIPHERTEXT_MAX_BYTES = 263_168; // 256 KiB + AEAD slack
export const ENTRY_AEAD_TAG_BYTES = 16;

export interface EntryEnvelopeV1 {
  v: typeof ENVELOPE_VERSION;
  alg: typeof ENVELOPE_ALG;
  key_id: string;
  nonce: string;
  ct_enc: typeof ENVELOPE_CT_ENC;
}

export interface EnvelopeAdapter {
  validateEntryEnvelope: (input: unknown) => EntryEnvelopeV1;
  canonicalizeEnvelopeJcs: (envelope: EntryEnvelopeV1) => string;
  buildEntryAad: (envelope: EntryEnvelopeV1, entryId: string) => Uint8Array;
}

export type EnvelopeErrorCode = 'ENVELOPE_INVALID';

export class EnvelopeError extends Error {
  readonly code: EnvelopeErrorCode = 'ENVELOPE_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EnvelopeError';
  }
}

/**
 * Matches server-generated `vault_key_id` (`vk:` + 22 base64url chars, ADR 0002 §3)
 * or future item share keys (`sk:` + 22 base64url chars, SPEC §5.3).
 */
export const KEY_ID_REGEX = /^(?:vk|sk):[A-Za-z0-9_-]{22}$/;

/**
 * Matches lowercase hyphenated UUID (`8-4-4-4-12` hex, SPEC §5.5 & ADR 0002 §3).
 */
export const ENTRY_ID_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const REQUIRED_ENVELOPE_KEYS: Record<keyof EntryEnvelopeV1, true> = {
  v: true,
  alg: true,
  key_id: true,
  nonce: true,
  ct_enc: true,
};

const utf8Encoder = new TextEncoder();
const utf8DecoderFatal = new TextDecoder('utf-8', { fatal: true });

function isWellFormedString(value: string): boolean {
  if (typeof value.isWellFormed === 'function') {
    return value.isWellFormed();
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

/**
 * Strict RFC 8259 JSON tokenizer that decodes string escapes and rejects duplicate
 * object keys BEFORE building a JS object/map (SPEC §5.5, ADR 0002 §3, plan Task 6).
 *
 * Ensures that e.g. `{"ct_enc":"utf8","ct\u005fenc":"utf8"}` is rejected as a duplicate key.
 */
export function parseJsonRejectingDuplicateKeys(rawInput: string | Uint8Array): unknown {
  let text: string;
  if (typeof rawInput === 'string') {
    if (!isWellFormedString(rawInput)) {
      throw new EnvelopeError('Envelope JSON contains lone UTF-16 surrogate');
    }
    text = rawInput;
  } else if (rawInput instanceof Uint8Array || ArrayBuffer.isView(rawInput)) {
    try {
      text = utf8DecoderFatal.decode(toLocalBytes(rawInput));
    } catch (err) {
      throw new EnvelopeError('Envelope JSON contains invalid UTF-8 bytes', { cause: err });
    }
  } else {
    throw new EnvelopeError('Raw JSON input must be a string or Uint8Array');
  }

  const len = text.length;
  let pos = 0;

  function skipWhitespace(): void {
    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        pos++;
      } else {
        break;
      }
    }
  }

  function readHex4(): number {
    if (pos + 4 > len) {
      throw new EnvelopeError(`Incomplete \\uXXXX escape at position ${pos}`);
    }
    let val = 0;
    for (let i = 0; i < 4; i++) {
      const code = text.charCodeAt(pos + i);
      if (!isHexDigit(code)) {
        throw new EnvelopeError(`Invalid hex digit in \\uXXXX escape at position ${pos + i}`);
      }
      val = (val << 4) | (code <= 0x39 ? code - 0x30 : (code & ~0x20) - 0x37);
    }
    pos += 4;
    return val;
  }

  function parseStringToken(): string {
    if (pos >= len || text.charCodeAt(pos) !== 0x22 /* " */) {
      throw new EnvelopeError(`Expected '"' at position ${pos}`);
    }
    pos++; // consume opening '"'
    let out = '';

    while (pos < len) {
      const ch = text.charCodeAt(pos);
      if (ch === 0x22 /* " */) {
        pos++;
        if (!isWellFormedString(out)) {
          throw new EnvelopeError('Unescaped JSON string contains lone surrogate');
        }
        return out;
      }
      if (ch < 0x20) {
        throw new EnvelopeError(`Unescaped control character 0x${ch.toString(16)} in JSON string`);
      }
      if (ch === 0x5c /* \ */) {
        pos++;
        if (pos >= len) {
          throw new EnvelopeError('Unterminated escape sequence in JSON string');
        }
        const esc = text.charCodeAt(pos++);
        switch (esc) {
          case 0x22: // "
            out += '"';
            break;
          case 0x5c: // \
            out += '\\';
            break;
          case 0x2f: // /
            out += '/';
            break;
          case 0x62: // b
            out += '\b';
            break;
          case 0x66: // f
            out += '\f';
            break;
          case 0x6e: // n
            out += '\n';
            break;
          case 0x72: // r
            out += '\r';
            break;
          case 0x74: // t
            out += '\t';
            break;
          case 0x75: {
            // uXXXX
            const unit = readHex4();
            if (unit >= 0xd800 && unit <= 0xdbff) {
              // High surrogate must be immediately followed by \uDC00..\uDFFF
              if (
                pos + 2 > len ||
                text.charCodeAt(pos) !== 0x5c ||
                text.charCodeAt(pos + 1) !== 0x75
              ) {
                throw new EnvelopeError('High surrogate not followed by low surrogate in JSON string');
              }
              pos += 2;
              const low = readHex4();
              if (low < 0xdc00 || low > 0xdfff) {
                throw new EnvelopeError('Invalid low surrogate in JSON string escape');
              }
              out += String.fromCharCode(unit, low);
            } else if (unit >= 0xdc00 && unit <= 0xdfff) {
              throw new EnvelopeError('Unexpected lone low surrogate in JSON string escape');
            } else {
              out += String.fromCharCode(unit);
            }
            break;
          }
          default:
            throw new EnvelopeError(`Invalid escape character in JSON string at position ${pos - 1}`);
        }
      } else {
        out += text[pos]!;
        pos++;
      }
    }

    throw new EnvelopeError('Unterminated JSON string');
  }

  function parseNumberToken(): number {
    const start = pos;
    if (pos < len && text.charCodeAt(pos) === 0x2d /* - */) {
      pos++;
    }
    if (pos >= len) {
      throw new EnvelopeError(`Invalid number at position ${start}`);
    }
    const firstDigit = text.charCodeAt(pos);
    if (firstDigit === 0x30 /* 0 */) {
      pos++;
      if (pos < len) {
        const next = text.charCodeAt(pos);
        if (next >= 0x30 && next <= 0x39) {
          throw new EnvelopeError(`Leading zero in JSON number at position ${start}`);
        }
      }
    } else if (firstDigit >= 0x31 && firstDigit <= 0x39) {
      pos++;
      while (pos < len) {
        const d = text.charCodeAt(pos);
        if (d >= 0x30 && d <= 0x39) {
          pos++;
        } else {
          break;
        }
      }
    } else {
      throw new EnvelopeError(`Invalid number at position ${start}`);
    }

    if (pos < len && text.charCodeAt(pos) === 0x2e /* . */) {
      pos++;
      if (pos >= len || text.charCodeAt(pos) < 0x30 || text.charCodeAt(pos) > 0x39) {
        throw new EnvelopeError(`Invalid fractional number at position ${start}`);
      }
      while (pos < len) {
        const d = text.charCodeAt(pos);
        if (d >= 0x30 && d <= 0x39) {
          pos++;
        } else {
          break;
        }
      }
    }

    if (pos < len) {
      const expCh = text.charCodeAt(pos);
      if (expCh === 0x65 /* e */ || expCh === 0x45 /* E */) {
        pos++;
        if (pos < len) {
          const sign = text.charCodeAt(pos);
          if (sign === 0x2b /* + */ || sign === 0x2d /* - */) {
            pos++;
          }
        }
        if (pos >= len || text.charCodeAt(pos) < 0x30 || text.charCodeAt(pos) > 0x39) {
          throw new EnvelopeError(`Invalid exponent in number at position ${start}`);
        }
        while (pos < len) {
          const d = text.charCodeAt(pos);
          if (d >= 0x30 && d <= 0x39) {
            pos++;
          } else {
            break;
          }
        }
      }
    }

    const lexeme = text.slice(start, pos);
    // Reject float/exponent representations for integers like 1.0 or 1e0 when validating strict integer v
    if (lexeme.includes('.') || lexeme.includes('e') || lexeme.includes('E')) {
      throw new EnvelopeError(`Floating-point or exponential number "${lexeme}" is not allowed in envelope`);
    }
    const num = Number(lexeme);
    if (!Number.isSafeInteger(num)) {
      throw new EnvelopeError(`Unsafe integer "${lexeme}" in envelope JSON`);
    }
    return num;
  }

  function parseObject(): Record<string, unknown> {
    pos++; // consume '{'
    skipWhitespace();
    const obj: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const seenKeys = new Set<string>();

    if (pos < len && text.charCodeAt(pos) === 0x7d /* } */) {
      pos++;
      return obj;
    }

    while (pos < len) {
      skipWhitespace();
      if (pos >= len || text.charCodeAt(pos) !== 0x22 /* " */) {
        throw new EnvelopeError(`Expected object key string at position ${pos}`);
      }
      const key = parseStringToken();
      if (seenKeys.has(key)) {
        throw new EnvelopeError(`Duplicate JSON object key "${key}"`);
      }
      seenKeys.add(key);

      skipWhitespace();
      if (pos >= len || text.charCodeAt(pos) !== 0x3a /* : */) {
        throw new EnvelopeError(`Expected ':' after key "${key}" at position ${pos}`);
      }
      pos++; // consume ':'

      skipWhitespace();
      const val = parseValue();
      obj[key] = val;

      skipWhitespace();
      if (pos >= len) {
        throw new EnvelopeError('Unterminated JSON object');
      }
      const sep = text.charCodeAt(pos);
      if (sep === 0x7d /* } */) {
        pos++;
        return obj;
      }
      if (sep === 0x2c /* , */) {
        pos++;
        skipWhitespace();
        if (pos < len && text.charCodeAt(pos) === 0x7d /* } */) {
          throw new EnvelopeError(`Trailing comma in JSON object at position ${pos}`);
        }
        continue;
      }
      throw new EnvelopeError(`Expected ',' or '}' in JSON object at position ${pos}`);
    }

    throw new EnvelopeError('Unterminated JSON object');
  }

  function parseArray(): unknown[] {
    pos++; // consume '['
    skipWhitespace();
    const arr: unknown[] = [];

    if (pos < len && text.charCodeAt(pos) === 0x5d /* ] */) {
      pos++;
      return arr;
    }

    while (pos < len) {
      skipWhitespace();
      arr.push(parseValue());
      skipWhitespace();
      if (pos >= len) {
        throw new EnvelopeError('Unterminated JSON array');
      }
      const sep = text.charCodeAt(pos);
      if (sep === 0x5d /* ] */) {
        pos++;
        return arr;
      }
      if (sep === 0x2c /* , */) {
        pos++;
        skipWhitespace();
        if (pos < len && text.charCodeAt(pos) === 0x5d /* ] */) {
          throw new EnvelopeError(`Trailing comma in JSON array at position ${pos}`);
        }
        continue;
      }
      throw new EnvelopeError(`Expected ',' or ']' in JSON array at position ${pos}`);
    }

    throw new EnvelopeError('Unterminated JSON array');
  }

  function parseLiteral(expected: string, value: unknown): unknown {
    if (text.startsWith(expected, pos)) {
      pos += expected.length;
      return value;
    }
    throw new EnvelopeError(`Unexpected token at position ${pos}`);
  }

  function parseValue(): unknown {
    skipWhitespace();
    if (pos >= len) {
      throw new EnvelopeError('Unexpected end of JSON input');
    }
    const ch = text.charCodeAt(pos);
    switch (ch) {
      case 0x7b: // {
        return parseObject();
      case 0x5b: // [
        return parseArray();
      case 0x22: // "
        return parseStringToken();
      case 0x74: // t
        return parseLiteral('true', true);
      case 0x66: // f
        return parseLiteral('false', false);
      case 0x6e: // n
        return parseLiteral('null', null);
      default:
        if (ch === 0x2d || (ch >= 0x30 && ch <= 0x39)) {
          return parseNumberToken();
        }
        throw new EnvelopeError(`Unexpected character at position ${pos}`);
    }
  }

  const root = parseValue();
  skipWhitespace();
  if (pos !== len) {
    throw new EnvelopeError(`Unexpected trailing content at position ${pos}`);
  }
  return root;
}

/**
 * Validates `entry.envelope` v1 per SPEC §5.5 and ADR 0002 §3:
 * - Accepts raw JSON string/bytes (tokenized first to reject duplicate keys incl. escaped duplicates)
 *   or an already parsed object.
 * - Exactly 5 required fields (`v`, `alg`, `key_id`, `nonce`, `ct_enc`); no missing or extra fields;
 *   never auto-fills `ct_enc`.
 * - `v === 1` (integer)
 * - `alg === "xchacha20poly1305-ietf"`
 * - `key_id` matches `^(?:vk|sk):[A-Za-z0-9_-]{22}$`
 * - `nonce` is strict base64url (no padding) decoding to exactly 24 bytes
 * - `ct_enc === "utf8"`
 *
 * Exported for reuse by P04 entry handlers/clients.
 */
export function validateEntryEnvelope(input: unknown): EntryEnvelopeV1 {
  const parsed =
    typeof input === 'string' || input instanceof Uint8Array || ArrayBuffer.isView(input)
      ? parseJsonRejectingDuplicateKeys(input as string | Uint8Array)
      : input;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnvelopeError('Entry envelope must be a non-null JSON object');
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 5) {
    throw new EnvelopeError(`Entry envelope must have exactly 5 fields, got ${keys.length}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(REQUIRED_ENVELOPE_KEYS, key)) {
      throw new EnvelopeError(`Unexpected entry envelope field: ${key}`);
    }
  }

  const record = parsed as Record<string, unknown>;
  const { v, alg, key_id, nonce, ct_enc } = record;

  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v !== ENVELOPE_VERSION) {
    throw new EnvelopeError(`Unsupported envelope version: ${String(v)}`);
  }

  if (alg !== ENVELOPE_ALG) {
    throw new EnvelopeError(`Unsupported envelope algorithm: ${String(alg)}`);
  }

  if (typeof key_id !== 'string' || !isWellFormedString(key_id) || !KEY_ID_REGEX.test(key_id)) {
    throw new EnvelopeError('Invalid envelope key_id');
  }

  if (typeof nonce !== 'string') {
    throw new EnvelopeError('Envelope nonce must be a base64url string');
  }
  try {
    decodeBase64UrlStrict(nonce, WRAP_NONCE_BYTES);
  } catch (err) {
    throw new EnvelopeError('Envelope nonce must be valid 24-byte base64url without padding', {
      cause: err,
    });
  }

  if (ct_enc !== ENVELOPE_CT_ENC) {
    throw new EnvelopeError(`Unsupported envelope ct_enc: ${String(ct_enc)}`);
  }

  return {
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    key_id,
    nonce,
    ct_enc: ENVELOPE_CT_ENC,
  };
}

/**
 * Validates `entry_id` as a lowercase hyphenated UUID (`8-4-4-4-12` hex, SPEC §5.5).
 */
export function validateEntryId(entryId: unknown): string {
  if (typeof entryId !== 'string' || !ENTRY_ID_UUID_REGEX.test(entryId)) {
    throw new EnvelopeError('entry_id must be a lowercase hyphenated UUID (8-4-4-4-12)');
  }
  return entryId;
}

/**
 * Canonicalizes a validated `EntryEnvelopeV1` per RFC 8785 (JCS) using `canonicalize` 5.1.0.
 */
export function canonicalizeEnvelopeJcs(envelope: EntryEnvelopeV1): string {
  const validated = validateEntryEnvelope(envelope);
  try {
    return canonicalizeJcs(validated);
  } catch (err) {
    if (err instanceof JcsError) {
      throw new EnvelopeError(err.message, { cause: err });
    }
    throw err;
  }
}

/**
 * Builds the entry AEAD AAD per SPEC §5.5 and ADR 0002 §1, §3:
 * `UTF8("sabk.entry.v1") || 0x00 || UTF8(JCS(envelope)) || 0x00 || ASCII(entry_id)`
 */
export function buildEntryAad(envelope: EntryEnvelopeV1, entryId: string): Uint8Array {
  const validatedEntryId = validateEntryId(entryId);
  const jcs = canonicalizeEnvelopeJcs(envelope);
  const labelBytes = toLocalBytes(utf8Encoder.encode(ENVELOPE_AAD_LABEL));
  const jcsBytes = toLocalBytes(utf8Encoder.encode(jcs));
  const idBytes = toLocalBytes(utf8Encoder.encode(validatedEntryId));

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
}

export interface SealEntryParams {
  entryId: string;
  keyId: string;
  plaintext: string | Uint8Array;
  vk: Uint8Array;
  nonce?: Uint8Array;
}

export interface SealedEntryPayload {
  envelope: EntryEnvelopeV1;
  jcs: string;
  aad: Uint8Array;
  ciphertextBytes: Uint8Array;
  ciphertext: string;
}

/**
 * Seals an entry body (UTF-8 string or bytes, max 256 KiB) with `XChaCha20-Poly1305 IETF`
 * under `vk` using AAD `sabk.entry.v1 || 0x00 || JCS(envelope) || 0x00 || entry_id`.
 * Ciphertext is pure AEAD output (`ciphertext_body || tag(16)`), with no version or nonce prefix.
 */
export function sealEntryPayload(sodium: Sodium, params: SealEntryParams): SealedEntryPayload {
  const entryId = validateEntryId(params.entryId);
  if (params.vk.byteLength !== VK_BYTES) {
    throw new WrapError('WRAP_INVALID', 'Entry VK must be 32 bytes');
  }

  let ptBytes: Uint8Array;
  if (typeof params.plaintext === 'string') {
    if (!isWellFormedString(params.plaintext)) {
      throw new EnvelopeError('Entry plaintext contains lone UTF-16 surrogate');
    }
    ptBytes = toLocalBytes(utf8Encoder.encode(params.plaintext));
  } else if (params.plaintext instanceof Uint8Array || ArrayBuffer.isView(params.plaintext)) {
    ptBytes = toLocalBytes(params.plaintext);
    // Verify valid UTF-8 per SPEC §5.5 (ct_enc="utf8")
    try {
      utf8DecoderFatal.decode(ptBytes);
    } catch (err) {
      throw new EnvelopeError('Entry plaintext bytes must be valid UTF-8', { cause: err });
    }
  } else {
    throw new EnvelopeError('Entry plaintext must be a string or Uint8Array');
  }

  if (ptBytes.byteLength > ENTRY_PLAINTEXT_MAX_BYTES) {
    throw new EnvelopeError(
      `Entry plaintext exceeds max size of ${ENTRY_PLAINTEXT_MAX_BYTES} bytes (got ${ptBytes.byteLength})`,
    );
  }

  const nonceBytes = params.nonce ?? sodium.randombytes_buf(WRAP_NONCE_BYTES);
  if (nonceBytes.byteLength !== WRAP_NONCE_BYTES) {
    throw new EnvelopeError('Entry nonce must be 24 bytes');
  }

  const envelope = validateEntryEnvelope({
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    key_id: params.keyId,
    nonce: encodeBase64Url(nonceBytes),
    ct_enc: ENVELOPE_CT_ENC,
  });

  const jcs = canonicalizeEnvelopeJcs(envelope);
  const aad = buildEntryAad(envelope, entryId);

  const ciphertextBytes = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    ptBytes,
    toLocalBytes(aad),
    null,
    toLocalBytes(nonceBytes),
    toLocalBytes(params.vk),
    'uint8array',
  );

  return {
    envelope,
    jcs,
    aad,
    ciphertextBytes,
    ciphertext: encodeBase64Url(ciphertextBytes),
  };
}

export interface OpenEntryParams {
  entryId: string;
  envelope: unknown;
  ciphertext: string | Uint8Array;
  vk: Uint8Array;
  expectedKeyId?: string;
}

/**
 * Validates `envelope` (including duplicate-key rejection when raw JSON is passed),
 * canonicalizes via JCS, builds AAD, decrypts `ciphertext` with `XChaCha20-Poly1305 IETF`,
 * and decodes strict UTF-8 plaintext.
 */
export function openEntryPayload(
  sodium: Sodium,
  params: OpenEntryParams,
): { envelope: EntryEnvelopeV1; plaintextBytes: Uint8Array; plaintext: string } {
  const entryId = validateEntryId(params.entryId);
  if (params.vk.byteLength !== VK_BYTES) {
    throw new WrapError('WRAP_INVALID', 'Entry VK must be 32 bytes');
  }

  const validatedEnvelope = validateEntryEnvelope(params.envelope);
  if (params.expectedKeyId !== undefined && validatedEnvelope.key_id !== params.expectedKeyId) {
    throw new EnvelopeError(
      `Envelope key_id "${validatedEnvelope.key_id}" does not match expected "${params.expectedKeyId}"`,
    );
  }

  const aad = buildEntryAad(validatedEnvelope, entryId);
  const nonceBytes = decodeBase64UrlStrict(validatedEnvelope.nonce, WRAP_NONCE_BYTES);

  let ctBytes: Uint8Array;
  if (typeof params.ciphertext === 'string') {
    try {
      ctBytes = decodeBase64UrlStrict(params.ciphertext);
    } catch (err) {
      throw new EnvelopeError('Invalid entry ciphertext base64url', { cause: err });
    }
  } else if (params.ciphertext instanceof Uint8Array || ArrayBuffer.isView(params.ciphertext)) {
    ctBytes = toLocalBytes(params.ciphertext);
  } else {
    throw new EnvelopeError('Entry ciphertext must be a base64url string or Uint8Array');
  }

  if (ctBytes.byteLength < ENTRY_AEAD_TAG_BYTES || ctBytes.byteLength > ENTRY_CIPHERTEXT_MAX_BYTES) {
    throw new EnvelopeError(
      `Invalid entry ciphertext byte length: ${ctBytes.byteLength}`,
    );
  }

  let plaintextBytes: Uint8Array;
  try {
    plaintextBytes = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      toLocalBytes(ctBytes),
      toLocalBytes(aad),
      toLocalBytes(nonceBytes),
      toLocalBytes(params.vk),
      'uint8array',
    );
  } catch (err) {
    throw new WrapError('AEAD_DECRYPT_FAILED', 'Entry AEAD decryption failed', { cause: err });
  }

  if (plaintextBytes.byteLength > ENTRY_PLAINTEXT_MAX_BYTES) {
    sodium.memzero(plaintextBytes);
    throw new EnvelopeError('Decrypted entry plaintext exceeds 256 KiB limit');
  }

  let plaintext: string;
  try {
    plaintext = utf8DecoderFatal.decode(plaintextBytes);
  } catch (err) {
    sodium.memzero(plaintextBytes);
    throw new EnvelopeError('Decrypted entry plaintext is not valid UTF-8', { cause: err });
  }

  return {
    envelope: validatedEnvelope,
    plaintextBytes,
    plaintext,
  };
}
