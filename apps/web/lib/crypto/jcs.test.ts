import { describe, expect, it } from 'vitest';
import { canonicalizeJcs, canonicalizeJcsBytes, JcsError } from './jcs';

describe('P03-T6 JCS RFC 8785 (canonicalize 5.1.0)', () => {
  it('canonicalizes key order lexicographically by UTF-16 code units and strips whitespace', () => {
    const input = {
      v: 1,
      nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_',
      key_id: 'vk:0123456789abcdefghijkl',
      ct_enc: 'utf8',
      alg: 'xchacha20poly1305-ietf',
    };

    const expected =
      '{"alg":"xchacha20poly1305-ietf","ct_enc":"utf8","key_id":"vk:0123456789abcdefghijkl","nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_","v":1}';

    expect(canonicalizeJcs(input)).toBe(expected);
    expect(new TextDecoder().decode(canonicalizeJcsBytes(input))).toBe(expected);
  });

  it('produces identical canonical output regardless of property insertion order', () => {
    const orderA = {
      v: 1,
      alg: 'xchacha20poly1305-ietf',
      key_id: 'vk:7f3a9b2c4d5e6f7a8b9c0d',
      nonce: '0123456789abcdef0123456789abcdef',
      ct_enc: 'utf8',
    };
    const orderB = {
      ct_enc: 'utf8',
      nonce: '0123456789abcdef0123456789abcdef',
      key_id: 'vk:7f3a9b2c4d5e6f7a8b9c0d',
      alg: 'xchacha20poly1305-ietf',
      v: 1,
    };

    expect(canonicalizeJcs(orderA)).toBe(canonicalizeJcs(orderB));
  });

  it('rejects non-JSON-serializable values and lone surrogates with JcsError (ENVELOPE_INVALID)', () => {
    expect(() => canonicalizeJcs(undefined)).toThrowError(JcsError);
    expect(() => canonicalizeJcs(Number.NaN)).toThrowError(JcsError);
    expect(() => canonicalizeJcs(Number.POSITIVE_INFINITY)).toThrowError(JcsError);
    expect(() => canonicalizeJcs({ bad: '\ud800' })).toThrowError(JcsError);
  });
});
