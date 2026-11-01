import { describe, expect, it } from 'vitest';
import {
  JSON_MAX_UTF8_BYTES,
  JsonUtf8Error,
  assertUtf8ByteLimit,
  decodeUtf8FileStrict,
  encodeUtf8Bytes,
  isWellFormedUtf16,
  measureUtf8Bytes,
  stripSingleLeadingBom,
  validatePastedTextStrict,
} from './utf8';

const encoder = new TextEncoder();

describe('lib/json/utf8', () => {
  it('checks UTF-16 well-formedness without String.prototype.isWellFormed', () => {
    expect(isWellFormedUtf16('')).toBe(true);
    expect(isWellFormedUtf16('café 😀 Việt Nam')).toBe(true);
    // Valid surrogate pair U+1F600 (D83D DE00)
    expect(isWellFormedUtf16('\ud83d\ude00')).toBe(true);
    // Lone high surrogate at end or before ASCII
    expect(isWellFormedUtf16('\ud800')).toBe(false);
    expect(isWellFormedUtf16('abc\ud800def')).toBe(false);
    expect(isWellFormedUtf16('\udbff')).toBe(false);
    // Lone low surrogate at start or after ASCII
    expect(isWellFormedUtf16('\udc00')).toBe(false);
    expect(isWellFormedUtf16('abc\udfffdef')).toBe(false);
    // Reversed surrogates
    expect(isWellFormedUtf16('\ude00\ud83d')).toBe(false);
    // Two high surrogates
    expect(isWellFormedUtf16('\ud800\ud800')).toBe(false);
  });

  it('strips at most one leading U+FEFF BOM', () => {
    expect(stripSingleLeadingBom('{"a":1}')).toEqual({
      text: '{"a":1}',
      hadBom: false,
    });
    expect(stripSingleLeadingBom('\uFEFF{"a":1}')).toEqual({
      text: '{"a":1}',
      hadBom: true,
    });
    // Two leading BOMs -> strips first, keeps second U+FEFF
    expect(stripSingleLeadingBom('\uFEFF\uFEFF{"a":1}')).toEqual({
      text: '\uFEFF{"a":1}',
      hadBom: true,
    });
  });

  it('decodes valid UTF-8 and strips exactly one leading UTF-8 BOM', () => {
    const bodyBytes = encoder.encode('{"hello":"world"}');
    const plainRes = decodeUtf8FileStrict(bodyBytes);
    expect(plainRes.ok).toBe(true);
    if (plainRes.ok) {
      expect(plainRes.hadBom).toBe(false);
      expect(plainRes.text).toBe('{"hello":"world"}');
      expect(plainRes.byteLength).toBe(bodyBytes.byteLength);
      expect(plainRes.rawByteLength).toBe(bodyBytes.byteLength);
    }

    const oneBomBytes = new Uint8Array(3 + bodyBytes.byteLength);
    oneBomBytes.set([0xef, 0xbb, 0xbf], 0);
    oneBomBytes.set(bodyBytes, 3);
    const oneBomRes = decodeUtf8FileStrict(oneBomBytes);
    expect(oneBomRes.ok).toBe(true);
    if (oneBomRes.ok) {
      expect(oneBomRes.hadBom).toBe(true);
      expect(oneBomRes.text).toBe('{"hello":"world"}');
      expect(oneBomRes.byteLength).toBe(bodyBytes.byteLength);
      expect(oneBomRes.rawByteLength).toBe(bodyBytes.byteLength + 3);
    }

    const twoBomBytes = new Uint8Array(6 + bodyBytes.byteLength);
    twoBomBytes.set([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf], 0);
    twoBomBytes.set(bodyBytes, 6);
    const twoBomRes = decodeUtf8FileStrict(twoBomBytes);
    expect(twoBomRes.ok).toBe(true);
    if (twoBomRes.ok) {
      expect(twoBomRes.hadBom).toBe(true);
      expect(twoBomRes.text.charCodeAt(0)).toBe(0xfeff);
      expect(twoBomRes.text.slice(1)).toBe('{"hello":"world"}');
      expect(twoBomRes.byteLength).toBe(bodyBytes.byteLength + 3);
    }
  });

  it('rejects malformed UTF-8 byte sequences without producing U+FFFD (P04-A7)', () => {
    const cases: { name: string; bytes: Uint8Array }[] = [
      {
        name: 'invalid 2-byte continuation 0xC3 0x28',
        bytes: new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
      },
      {
        name: 'overlong 2-byte slash 0xC0 0xAF',
        bytes: new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d]),
      },
      {
        name: 'CESU-8 encoded high surrogate 0xED 0xA0 0x80',
        bytes: new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xed, 0xa0, 0x80, 0x22, 0x7d]),
      },
      {
        name: 'CESU-8 encoded low surrogate 0xED 0xBF 0xBF',
        bytes: new Uint8Array([0xed, 0xbf, 0xbf]),
      },
      {
        name: 'truncated 3-byte sequence 0xE2 0x82',
        bytes: new Uint8Array([0xe2, 0x82]),
      },
      {
        name: 'standalone continuation byte 0x80',
        bytes: new Uint8Array([0x80]),
      },
    ];

    for (const tc of cases) {
      const res = decodeUtf8FileStrict(tc.bytes);
      expect(res.ok, tc.name).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('INVALID_UTF8');
        expect('text' in res).toBe(false);
        expect(Object.keys(res)).toEqual(['ok', 'error']);
      }
    }
  });

  it('accepts exactly 262144 UTF-8 bytes and rejects 262145 UTF-8 bytes (P04-A7)', () => {
    // Pure ASCII: 262144 bytes
    const exactAscii = `"${'a'.repeat(JSON_MAX_UTF8_BYTES - 2)}"`;
    const exactBytes = encoder.encode(exactAscii);
    expect(exactBytes.byteLength).toBe(JSON_MAX_UTF8_BYTES);

    const okFile = decodeUtf8FileStrict(exactBytes);
    expect(okFile.ok).toBe(true);
    if (okFile.ok) {
      expect(okFile.byteLength).toBe(JSON_MAX_UTF8_BYTES);
    }

    const okPaste = validatePastedTextStrict(exactAscii);
    expect(okPaste.ok).toBe(true);
    expect(assertUtf8ByteLimit(exactAscii)).toBe(JSON_MAX_UTF8_BYTES);

    // 262144 bytes after stripping 3-byte UTF-8 BOM -> also accepted
    const exactWithBom = new Uint8Array(3 + exactBytes.byteLength);
    exactWithBom.set([0xef, 0xbb, 0xbf], 0);
    exactWithBom.set(exactBytes, 3);
    const okBomFile = decodeUtf8FileStrict(exactWithBom);
    expect(okBomFile.ok).toBe(true);
    if (okBomFile.ok) {
      expect(okBomFile.byteLength).toBe(JSON_MAX_UTF8_BYTES);
      expect(okBomFile.hadBom).toBe(true);
    }

    // 262145 UTF-8 bytes -> rejected
    const overAscii = `"${'a'.repeat(JSON_MAX_UTF8_BYTES - 1)}"`;
    const overBytes = encoder.encode(overAscii);
    expect(overBytes.byteLength).toBe(JSON_MAX_UTF8_BYTES + 1);

    const failFile = decodeUtf8FileStrict(overBytes);
    expect(failFile.ok).toBe(false);
    if (!failFile.ok) {
      expect(failFile.error.code).toBe('BYTE_LIMIT_EXCEEDED');
      expect(failFile.error.byteLength).toBe(JSON_MAX_UTF8_BYTES + 1);
      expect(failFile.error.limitBytes).toBe(JSON_MAX_UTF8_BYTES);
    }

    const failPaste = validatePastedTextStrict(overAscii);
    expect(failPaste.ok).toBe(false);
    if (!failPaste.ok) {
      expect(failPaste.error.code).toBe('BYTE_LIMIT_EXCEEDED');
    }
    let thrownLimitErr: unknown;
    try {
      assertUtf8ByteLimit(overAscii);
    } catch (err) {
      thrownLimitErr = err;
    }
    expect(thrownLimitErr).toBeInstanceOf(JsonUtf8Error);
    if (thrownLimitErr instanceof JsonUtf8Error) {
      expect(thrownLimitErr.code).toBe('BYTE_LIMIT_EXCEEDED');
      expect(thrownLimitErr.byteLength).toBe(JSON_MAX_UTF8_BYTES + 1);
      expect(thrownLimitErr.limitBytes).toBe(JSON_MAX_UTF8_BYTES);
    }

    // Multi-byte UTF-8: UTF-16 length is well below 262144, but UTF-8 byte length is 262145
    // Each 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes.
    // 131071 * 2 = 262142 bytes + 3 ASCII ('"a"') = 262145 UTF-8 bytes (only 131074 UTF-16 units)
    const multiByteOver = `"a${'é'.repeat(131_071)}"`;
    expect(multiByteOver.length).toBe(131_074);
    expect(measureUtf8Bytes(multiByteOver)).toBe(JSON_MAX_UTF8_BYTES + 1);
    const multiRes = validatePastedTextStrict(multiByteOver);
    expect(multiRes.ok).toBe(false);
    if (!multiRes.ok) {
      expect(multiRes.error.code).toBe('BYTE_LIMIT_EXCEEDED');
    }
  });

  it('rejects ill-formed UTF-16 strings in validatePastedTextStrict and encodeUtf8Bytes without echoing body text', () => {
    const sentinel = 'sentinel-secret-\ud800-payload';
    const badRes = validatePastedTextStrict(`{"a":"${sentinel}"}`);
    expect(badRes.ok).toBe(false);
    if (!badRes.ok) {
      expect(badRes.error.code).toBe('ILL_FORMED_UTF16');
      expect('text' in badRes).toBe(false);
      expect(badRes.error.message).not.toContain('sentinel-secret');
    }
    let thrownEncodeErr: unknown;
    try {
      encodeUtf8Bytes(`bad\udc00-Ω-${sentinel}`);
    } catch (err) {
      thrownEncodeErr = err;
    }
    expect(thrownEncodeErr).toBeInstanceOf(JsonUtf8Error);
    if (thrownEncodeErr instanceof JsonUtf8Error) {
      expect(thrownEncodeErr.code).toBe('ILL_FORMED_UTF16');
      expect(thrownEncodeErr.message).not.toContain('sentinel-secret');
      expect(thrownEncodeErr.message).not.toContain('Ω');
    }

    const overLimitSentinel = `sentinel-secret-${'x'.repeat(300)}`;
    const overRes = validatePastedTextStrict(overLimitSentinel, { limitBytes: 64 });
    expect(overRes.ok).toBe(false);
    if (!overRes.ok) {
      expect(overRes.error.code).toBe('BYTE_LIMIT_EXCEEDED');
      expect(overRes.error.byteLength).toBe(overLimitSentinel.length);
      expect(overRes.error.limitBytes).toBe(64);
      expect(overRes.error.message).not.toContain('sentinel-secret');
      expect('text' in overRes).toBe(false);
    }
  });
});
