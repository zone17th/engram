export const JSON_MAX_UTF8_BYTES = 262_144;

export type Utf8ErrorCode =
  | 'INVALID_UTF8'
  | 'ILL_FORMED_UTF16'
  | 'BYTE_LIMIT_EXCEEDED'
  | 'INVALID_INPUT';

export class JsonUtf8Error extends Error {
  readonly code: Utf8ErrorCode;
  readonly byteLength?: number;
  readonly limitBytes?: number;

  constructor(
    code: Utf8ErrorCode,
    message: string,
    details?: { byteLength?: number; limitBytes?: number; cause?: unknown },
  ) {
    super(message, details?.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = 'JsonUtf8Error';
    this.code = code;
    this.byteLength = details?.byteLength;
    this.limitBytes = details?.limitBytes;
  }
}

export type DecodedUtf8Result =
  | {
      ok: true;
      text: string;
      byteLength: number;
      hadBom: boolean;
      rawByteLength: number;
    }
  | {
      ok: false;
      error: JsonUtf8Error;
    };

export type ValidatedPasteTextResult =
  | {
      ok: true;
      text: string;
      byteLength: number;
    }
  | {
      ok: false;
      error: JsonUtf8Error;
    };

const utf8Encoder = new TextEncoder();
const utf8DecoderFatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Checks whether a JavaScript UTF-16 string contains any lone surrogates
 * (`0xD800..0xDBFF` not followed by `0xDC00..0xDFFF`, or an unpaired `0xDC00..0xDFFF`).
 *
 * Implemented explicitly without calling `String.prototype.isWellFormed` so behavior
 * is identical across runtimes (including older Safari/WebKit).
 */
export function isWellFormedUtf16(value: string): boolean {
  const len = value.length;
  for (let i = 0; i < len; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= len) {
        return false;
      }
      const next = value.charCodeAt(i + 1);
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

/**
 * Strips at most ONE leading U+FEFF (UTF-8 BOM decoded as a UTF-16 code unit).
 * Any second U+FEFF remains in the returned string so the strict JSON parser rejects
 * it as non-whitespace while "Save as text" preserves the second BOM verbatim (Q8).
 */
export function stripSingleLeadingBom(text: string): { text: string; hadBom: boolean } {
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    return { text: text.slice(1), hadBom: true };
  }
  return { text, hadBom: false };
}

/**
 * Encodes a well-formed UTF-16 string to UTF-8 bytes.
 * Throws `JsonUtf8Error('ILL_FORMED_UTF16')` if the string contains a lone surrogate
 * (never silently emits U+FFFD replacement bytes).
 */
export function encodeUtf8Bytes(text: string): Uint8Array {
  if (!isWellFormedUtf16(text)) {
    throw new JsonUtf8Error(
      'ILL_FORMED_UTF16',
      'String contains an unpaired UTF-16 surrogate',
    );
  }
  return utf8Encoder.encode(text);
}

/**
 * Measures the UTF-8 byte length of a string via `TextEncoder`.
 * Note: for strings that may come from decoded JSON literals containing `\ud800`,
 * measuring via `TextEncoder` still works (each lone surrogate would be 3 UTF-8 bytes,
 * matching the raw JSON text's UTF-8 byte count where the literal is ASCII `\ud800`).
 */
export function measureUtf8Bytes(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

/**
 * Asserts that a string's UTF-8 byte length does not exceed `limitBytes` (default 262144 B).
 * Returns the measured UTF-8 byte length.
 */
export function assertUtf8ByteLimit(
  text: string,
  limitBytes: number = JSON_MAX_UTF8_BYTES,
): number {
  const byteLength = utf8Encoder.encode(text).byteLength;
  if (byteLength > limitBytes) {
    throw new JsonUtf8Error(
      'BYTE_LIMIT_EXCEEDED',
      `UTF-8 byte length ${byteLength} exceeds limit of ${limitBytes} bytes`,
      { byteLength, limitBytes },
    );
  }
  return byteLength;
}

function toUint8Array(input: Uint8Array | ArrayBuffer): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new JsonUtf8Error('INVALID_INPUT', 'Expected Uint8Array or ArrayBuffer');
}

/**
 * Strict UTF-8 file decoder for JSON import and raw entry loading (SPEC §3.6, Task 12):
 * 1. Decodes using `TextDecoder('utf-8', { fatal: true, ignoreBOM: true })` so invalid
 *    UTF-8 byte sequences (`0xC3 0x28`, overlong `0xC0 0xAF`, CESU-8 surrogates `0xED 0xA0 0x80`,
 *    truncated sequences) are rejected instead of producing U+FFFD.
 * 2. Strips **at most one** leading U+FEFF (`EF BB BF` in UTF-8). If the file had a 3-byte
 *    BOM, the effective byte length is `rawByteLength - 3`.
 * 3. Enforces the 262,144-byte UTF-8 size limit on the post-BOM text (`262144` accepted,
 *    `262145` rejected).
 */
export function decodeUtf8FileStrict(
  input: Uint8Array | ArrayBuffer,
  options?: { limitBytes?: number },
): DecodedUtf8Result {
  const limitBytes = options?.limitBytes ?? JSON_MAX_UTF8_BYTES;
  let bytes: Uint8Array;
  try {
    bytes = toUint8Array(input);
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof JsonUtf8Error
          ? err
          : new JsonUtf8Error('INVALID_INPUT', 'Invalid byte buffer input', { cause: err }),
    };
  }

  let decoded: string;
  try {
    decoded = utf8DecoderFatal.decode(bytes);
  } catch (err) {
    return {
      ok: false,
      error: new JsonUtf8Error('INVALID_UTF8', 'Input contains invalid UTF-8 byte sequence', {
        cause: err,
      }),
    };
  }

  const { text, hadBom } = stripSingleLeadingBom(decoded);
  const rawByteLength = bytes.byteLength;
  const byteLength = hadBom ? rawByteLength - 3 : rawByteLength;

  if (byteLength > limitBytes) {
    return {
      ok: false,
      error: new JsonUtf8Error(
        'BYTE_LIMIT_EXCEEDED',
        `UTF-8 byte length ${byteLength} exceeds limit of ${limitBytes} bytes`,
        { byteLength, limitBytes },
      ),
    };
  }

  return {
    ok: true,
    text,
    byteLength,
    hadBom,
    rawByteLength,
  };
}

/**
 * Validates pasted/in-memory text using the custom UTF-16 well-formed check
 * (rejecting lone surrogates without calling `String.prototype.isWellFormed`)
 * and checks the UTF-8 byte limit via `TextEncoder`.
 */
export function validatePastedTextStrict(
  text: string,
  options?: { limitBytes?: number },
): ValidatedPasteTextResult {
  const limitBytes = options?.limitBytes ?? JSON_MAX_UTF8_BYTES;
  if (typeof text !== 'string') {
    return {
      ok: false,
      error: new JsonUtf8Error('INVALID_INPUT', 'Expected string input'),
    };
  }
  if (!isWellFormedUtf16(text)) {
    return {
      ok: false,
      error: new JsonUtf8Error(
        'ILL_FORMED_UTF16',
        'Pasted text contains an unpaired UTF-16 surrogate',
      ),
    };
  }
  const byteLength = utf8Encoder.encode(text).byteLength;
  if (byteLength > limitBytes) {
    return {
      ok: false,
      error: new JsonUtf8Error(
        'BYTE_LIMIT_EXCEEDED',
        `UTF-8 byte length ${byteLength} exceeds limit of ${limitBytes} bytes`,
        { byteLength, limitBytes },
      ),
    };
  }
  return {
    ok: true,
    text,
    byteLength,
  };
}
