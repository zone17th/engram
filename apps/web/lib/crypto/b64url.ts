const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const DECODE_TABLE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  DECODE_TABLE[ALPHABET.charCodeAt(i)] = i;
}

export class Base64UrlError extends Error {
  readonly code = 'BASE64URL_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'Base64UrlError';
  }
}

/**
 * Encodes raw bytes to RFC 4648 §5 base64url without `=` padding.
 */
export function encodeBase64Url(bytes: Uint8Array): string {
  const len = bytes.length;
  let out = '';
  let i = 0;

  while (i + 2 < len) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      ALPHABET[(n >>> 18) & 0x3f]! +
      ALPHABET[(n >>> 12) & 0x3f]! +
      ALPHABET[(n >>> 6) & 0x3f]! +
      ALPHABET[n & 0x3f]!;
    i += 3;
  }

  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i]! << 4;
    out += ALPHABET[(n >>> 6) & 0x3f]! + ALPHABET[n & 0x3f]!;
  } else if (rem === 2) {
    const n = (bytes[i]! << 10) | (bytes[i + 1]! << 2);
    out +=
      ALPHABET[(n >>> 12) & 0x3f]! +
      ALPHABET[(n >>> 6) & 0x3f]! +
      ALPHABET[n & 0x3f]!;
  }

  return out;
}

/**
 * Strict RFC 4648 §5 base64url decoder (unpadded).
 * Rejects `=`, standard base64 `+`/`/`, whitespace, non-ASCII, invalid remainder length (mod 4 === 1),
 * non-zero trailing bits, or decoded byte length mismatch when `expectedBytes` is provided.
 */
export function decodeBase64UrlStrict(input: string, expectedBytes?: number): Uint8Array {
  if (typeof input !== 'string') {
    throw new Base64UrlError('Input must be a string');
  }

  const len = input.length;
  const rem = len & 3;
  if (rem === 1) {
    throw new Base64UrlError('Invalid base64url string length');
  }

  for (let i = 0; i < len; i++) {
    const code = input.charCodeAt(i);
    if (code >= 128 || DECODE_TABLE[code] === -1) {
      throw new Base64UrlError(`Invalid base64url character at index ${i}`);
    }
  }

  const outLen = ((len >> 2) * 3) + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
  if (expectedBytes !== undefined && outLen !== expectedBytes) {
    throw new Base64UrlError(`Expected ${expectedBytes} bytes, got ${outLen}`);
  }

  const out = new Uint8Array(outLen);
  let inIdx = 0;
  let outIdx = 0;

  while (inIdx + 3 < len) {
    const c0 = DECODE_TABLE[input.charCodeAt(inIdx)]!;
    const c1 = DECODE_TABLE[input.charCodeAt(inIdx + 1)]!;
    const c2 = DECODE_TABLE[input.charCodeAt(inIdx + 2)]!;
    const c3 = DECODE_TABLE[input.charCodeAt(inIdx + 3)]!;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[outIdx++] = (n >>> 16) & 0xff;
    out[outIdx++] = (n >>> 8) & 0xff;
    out[outIdx++] = n & 0xff;
    inIdx += 4;
  }

  if (rem === 2) {
    const c0 = DECODE_TABLE[input.charCodeAt(inIdx)]!;
    const c1 = DECODE_TABLE[input.charCodeAt(inIdx + 1)]!;
    if ((c1 & 0x0f) !== 0) {
      throw new Base64UrlError('Non-zero trailing bits in 2-character base64url tail');
    }
    out[outIdx] = (c0 << 2) | (c1 >>> 4);
  } else if (rem === 3) {
    const c0 = DECODE_TABLE[input.charCodeAt(inIdx)]!;
    const c1 = DECODE_TABLE[input.charCodeAt(inIdx + 1)]!;
    const c2 = DECODE_TABLE[input.charCodeAt(inIdx + 2)]!;
    if ((c2 & 0x03) !== 0) {
      throw new Base64UrlError('Non-zero trailing bits in 3-character base64url tail');
    }
    const n = (c0 << 10) | (c1 << 4) | (c2 >>> 2);
    out[outIdx++] = (n >>> 8) & 0xff;
    out[outIdx] = n & 0xff;
  }

  return out;
}
