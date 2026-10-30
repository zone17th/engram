import { toLocalBytes, type Sodium } from './sodium';

export const RK_SLOT_MIN = 1;
export const RK_SLOT_MAX = 10;
export const RK_ENTROPY_BYTES = 16;
export const RK_BODY_LENGTH = 26;
export const RK_HASH_BYTES = 32;
export const RK_LOOKUP_DOMAIN = 'sabk.rk.lookup.v1' as const;
export const RK_WRAP_DOMAIN = 'sabk.rk.wrap.v1' as const;

export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const;

const CROCKFORD_CHAR_MAP: Record<string, true> = {
  '0': true,
  '1': true,
  '2': true,
  '3': true,
  '4': true,
  '5': true,
  '6': true,
  '7': true,
  '8': true,
  '9': true,
  A: true,
  B: true,
  C: true,
  D: true,
  E: true,
  F: true,
  G: true,
  H: true,
  J: true,
  K: true,
  M: true,
  N: true,
  P: true,
  Q: true,
  R: true,
  S: true,
  T: true,
  V: true,
  W: true,
  X: true,
  Y: true,
  Z: true,
};
const FIRST_CHAR_MAP: Record<string, true> = {
  '0': true,
  '1': true,
  '2': true,
  '3': true,
  '4': true,
  '5': true,
  '6': true,
  '7': true,
};

export type RecoveryKeyErrorCode = 'RECOVERY_KEY_INVALID';

export class RecoveryKeyError extends Error {
  readonly code: RecoveryKeyErrorCode;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RecoveryKeyError';
    this.code = 'RECOVERY_KEY_INVALID';
  }
}

export interface GeneratedRecoveryKey {
  slot: number;
  display: string;
  normalized: string;
}

export interface RecoveryKeyAdapter {
  generateRecoveryKey: (
    sodium: Sodium,
    slot: number,
    rawEntropy16?: Uint8Array,
  ) => GeneratedRecoveryKey;
  formatRecoveryKeyDisplay: (slot: number, body26: string) => string;
  normalizeRecoveryKey: (input: string) => string;
  deriveRecoveryLookupHash: (sodium: Sodium, normalizedOrRaw: string) => Uint8Array;
  deriveRecoveryWrapKey: (sodium: Sodium, normalizedOrRaw: string) => Uint8Array;
}

const utf8Encoder = new TextEncoder();

// Step 1 regexes: Unicode White_Space (including U+00A0), Format Cf (including U+00AD, U+200B-U+200D, U+2060, U+FEFF),
// and Unicode dashes U+2010..U+2015 and U+2212 -> ASCII '-'.
const UNICODE_WHITESPACE_AND_CF_RE = /[\p{White_Space}\p{Cf}]+/gu;
const UNICODE_DASH_RE = /[\u2010-\u2015\u2212]/gu;

// Step 2: Any remaining non-ASCII (> 0x7F) must be rejected immediately.
const NON_ASCII_RE = /[^\x00-\x7F]/;

// Step 3: Prefix ^rk(10|[1-9])[_-] case-insensitive for "rk", no leading zero, separator '_' or '-' required.
const RK_PREFIX_RE = /^[rR][kK](10|[1-9])[_-]/;

function assertValidSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < RK_SLOT_MIN || slot > RK_SLOT_MAX) {
    throw new RecoveryKeyError(
      `Recovery key slot must be an integer in ${RK_SLOT_MIN}..${RK_SLOT_MAX}`,
    );
  }
}

/**
 * Encodes 16 bytes (128 bits big-endian) with 2 zero bits left-padded on the MSB side (130 bits total)
 * into 26 uppercase Crockford Base32 characters. Because the top 2 bits of the first 5-bit group are 00,
 * the first character is guaranteed to be in '0'..'7'.
 */
export function encodeCrockford128LeftPad2(entropy16: Uint8Array): string {
  const bytes = toLocalBytes(entropy16);
  if (bytes.byteLength !== RK_ENTROPY_BYTES) {
    throw new RecoveryKeyError(`Recovery key entropy must be exactly ${RK_ENTROPY_BYTES} bytes`);
  }

  // Extract 26 groups of 5 bits from the 130-bit stream (2 zero bits on MSB + 128 bits of `bytes`).
  const chars = new Array<string>(RK_BODY_LENGTH);
  let bitBuffer = 0;
  let bitsInBuffer = 2; // 2 leading zero bits on MSB
  let outIdx = 0;

  for (let i = 0; i < RK_ENTROPY_BYTES; i++) {
    bitBuffer = (bitBuffer << 8) | bytes[i]!;
    bitsInBuffer += 8;
    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5;
      const idx = (bitBuffer >>> bitsInBuffer) & 0x1f;
      chars[outIdx++] = CROCKFORD_ALPHABET[idx]!;
    }
  }

  return chars.join('');
}

/**
 * Formats a slot `1..10` and a 26-character Crockford Base32 body into the display string:
 * `rk{n}_XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`.
 */
export function formatRecoveryKeyDisplay(slot: number, body26: string): string {
  assertValidSlot(slot);
  if (typeof body26 !== 'string' || body26.length !== RK_BODY_LENGTH) {
    throw new RecoveryKeyError(`Recovery key body must be ${RK_BODY_LENGTH} characters`);
  }
  const rawDisplay = `rk${slot}_${body26.slice(0, 4)}-${body26.slice(4, 8)}-${body26.slice(8, 12)}-${body26.slice(12, 16)}-${body26.slice(16, 20)}-${body26.slice(20, 24)}-${body26.slice(24, 26)}`;
  // Validate via the single canonical normalization function so invalid bodies / first char outside 0-7 fail closed.
  const norm = normalizeRecoveryKey(rawDisplay);
  const normBody = norm.slice(norm.indexOf('_') + 1);
  return `rk${slot}_${normBody.slice(0, 4)}-${normBody.slice(4, 8)}-${normBody.slice(8, 12)}-${normBody.slice(12, 16)}-${normBody.slice(16, 20)}-${normBody.slice(20, 24)}-${normBody.slice(24, 26)}`;
}

/**
 * Single canonical normalization function (5 steps of ADR 0002 §7 / plan mục 2.2 / SPEC §5.9):
 * 1. Unicode NFKC; strip all `\p{White_Space}` (incl. U+00A0) and `\p{Cf}` (incl. U+00AD, U+200B-U+200D, U+2060, U+FEFF);
 *    replace U+2010..U+2015 and U+2212 with ASCII `-`.
 * 2. Reject if any non-ASCII character (`> 0x7F`) remains.
 * 3. Match prefix `^rk(10|[1-9])[_-]` (case-insensitive `rk`, no leading zero, `_` or `-` required) -> normalize to `rk{n}_`.
 * 4. On remaining body: remove `-`, ASCII uppercase, map `O->0`, `I->1`, `L->1`, reject `U` and any non-Crockford character.
 * 5. Reject if body length !== 26 or first body character is outside `'0'..'7'`.
 */
export function normalizeRecoveryKey(input: string): string {
  if (typeof input !== 'string') {
    throw new RecoveryKeyError('Recovery key must be a string');
  }

  // Step 1: NFKC, strip Unicode White_Space and Cf, convert Unicode dashes/minus to '-'
  const step1 = input
    .normalize('NFKC')
    .replace(UNICODE_WHITESPACE_AND_CF_RE, '')
    .replace(UNICODE_DASH_RE, '-');

  // Step 2: Reject any non-ASCII remaining (> 0x7F)
  if (NON_ASCII_RE.test(step1)) {
    throw new RecoveryKeyError('Recovery key contains non-ASCII characters after NFKC');
  }

  // Step 3: Prefix ^rk(10|[1-9])[_-] case-insensitive
  const prefixMatch = RK_PREFIX_RE.exec(step1);
  if (!prefixMatch) {
    throw new RecoveryKeyError('Recovery key has invalid or missing rk{1..10}_ prefix');
  }

  const slotStr = prefixMatch[1]!;
  const rawBody = step1.slice(prefixMatch[0].length);

  // Step 4: Drop '-', ASCII uppercase, alias O->0, I/L->1, reject U and any non-Crockford char
  const bodyChars: string[] = [];
  for (let i = 0; i < rawBody.length; i++) {
    const ch = rawBody[i]!;
    if (ch === '-') {
      continue;
    }
    const code = ch.charCodeAt(0);
    // ASCII lowercase a-z -> A-Z
    const upper =
      code >= 0x61 && code <= 0x7a ? String.fromCharCode(code - 0x20) : ch;

    let mapped: string;
    if (upper === 'O') {
      mapped = '0';
    } else if (upper === 'I' || upper === 'L') {
      mapped = '1';
    } else {
      mapped = upper;
    }

    if (!CROCKFORD_CHAR_MAP[mapped]) {
      throw new RecoveryKeyError('Recovery key contains an invalid character');
    }
    bodyChars.push(mapped);
  }

  const body = bodyChars.join('');

  // Step 5: Length must be 26 and first char in '0'..'7'
  if (body.length !== RK_BODY_LENGTH) {
    throw new RecoveryKeyError('Recovery key body length is invalid');
  }
  if (!FIRST_CHAR_MAP[body[0]!]) {
    throw new RecoveryKeyError('Recovery key first character is invalid');
  }
  return `rk${slotStr}_${body}`;
}

/**
 * Generates a recovery key for slot `1..10` (`rk{n}_XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX`).
 * Both `display` and `normalized` pass through `normalizeRecoveryKey`.
 */
export function generateRecoveryKey(
  sodium: Sodium,
  slot: number,
  rawEntropy16?: Uint8Array,
): GeneratedRecoveryKey {
  assertValidSlot(slot);
  const ownsEntropy = !rawEntropy16;
  const entropy = rawEntropy16
    ? toLocalBytes(rawEntropy16)
    : sodium.randombytes_buf(RK_ENTROPY_BYTES);
  try {
    if (entropy.byteLength !== RK_ENTROPY_BYTES) {
      throw new RecoveryKeyError(`Recovery key entropy must be ${RK_ENTROPY_BYTES} bytes`);
    }

    const body26 = encodeCrockford128LeftPad2(entropy);
    const display = formatRecoveryKeyDisplay(slot, body26);
    const normalized = normalizeRecoveryKey(display);

    return {
      slot,
      display,
      normalized,
    };
  } finally {
    if (ownsEntropy) {
      sodium.memzero(entropy);
    }
  }
}

function deriveDomainSeparatedBlake2b256(
  sodium: Sodium,
  domain: string,
  normalizedOrRaw: string,
): Uint8Array {
  // Always normalize through the single canonical 5-step normalization function.
  const rkNorm = normalizeRecoveryKey(normalizedOrRaw);
  const inputBytes = toLocalBytes(utf8Encoder.encode(`${domain}${rkNorm}`));
  try {
    return sodium.crypto_generichash(RK_HASH_BYTES, inputBytes, null, 'uint8array');
  } finally {
    sodium.memzero(inputBytes);
  }
}

/**
 * Derives 32-byte `lookup_hash = BLAKE2b-256(UTF8("sabk.rk.lookup.v1") || UTF8(rk_norm))`.
 */
export function deriveRecoveryLookupHash(
  sodium: Sodium,
  normalizedOrRaw: string,
): Uint8Array {
  return deriveDomainSeparatedBlake2b256(sodium, RK_LOOKUP_DOMAIN, normalizedOrRaw);
}

/**
 * Derives 32-byte `wrap_key = BLAKE2b-256(UTF8("sabk.rk.wrap.v1") || UTF8(rk_norm))`.
 */
export function deriveRecoveryWrapKey(
  sodium: Sodium,
  normalizedOrRaw: string,
): Uint8Array {
  return deriveDomainSeparatedBlake2b256(sodium, RK_WRAP_DOMAIN, normalizedOrRaw);
}
