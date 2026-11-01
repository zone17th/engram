import { describe, expect, it } from 'vitest';
import {
  JSON_FORMAT_MAX_DEPTH,
  areNonWhitespaceTokensIdentical,
  formatJsonStrict,
} from './format';
import { JSON_MAX_UTF8_BYTES } from './utf8';

describe('lib/json/format', () => {
function stripWhitespaceOutsideStringsOracle(input: string): string {
  return input.replace(/"(?:\\.|[^"\\])*"|\s+/g, (match) =>
    match.startsWith('"') ? match : '',
  );
}

  it('pretty-prints with 2-space indentation while keeping non-whitespace tokens identical (P04-A7)', () => {
    const compact =
      '{"10":1,"2":2,"dup":"first","dup":"second","big":9007199254740993,"exp":1e400,"negZero":-0,"dec":0.10,"esc":"caf\\u00e9 \\/ 😀","emptyArr":[],"emptyObj":{}}';

    const res = formatJsonStrict(compact);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(areNonWhitespaceTokensIdentical(compact, res.text)).toBe(true);
    expect(stripWhitespaceOutsideStringsOracle(res.text)).toBe(
      stripWhitespaceOutsideStringsOracle(compact),
    );
    expect(res.text).toContain('"10": 1,\n  "2": 2,\n  "dup": "first",\n  "dup": "second"');
    expect(res.text).toContain('"big": 9007199254740993');
    expect(res.text).toContain('"exp": 1e400');
    expect(res.text).toContain('"negZero": -0');
    expect(res.text).toContain('"dec": 0.10');
    expect(res.text).toContain('"esc": "caf\\u00e9 \\/ 😀"');
    expect(res.text).toContain('"emptyArr": []');
    expect(res.text).toContain('"emptyObj": {}');
  });

  it('preserves document majority EOL (CRLF) when formatting', () => {
    const crlfInput = '{"a":1,\r\n"b":[1,2]}';
    const res = formatJsonStrict(crlfInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.text).toBe('{\r\n  "a": 1,\r\n  "b": [\r\n    1,\r\n    2\r\n  ]\r\n}');
    expect(areNonWhitespaceTokensIdentical(crlfInput, res.text)).toBe(true);
    expect(stripWhitespaceOutsideStringsOracle(res.text)).toBe(
      stripWhitespaceOutsideStringsOracle(crlfInput),
    );
  });

  it('rejects formatting when nesting depth exceeds 1000 (including 10000-deep input)', () => {
    const depth1000 = '['.repeat(JSON_FORMAT_MAX_DEPTH) + '0' + ']'.repeat(JSON_FORMAT_MAX_DEPTH);
    const ok1000 = formatJsonStrict(depth1000, { maxBytes: 10_000_000 });
    expect(ok1000.ok).toBe(true);

    const depth1001 =
      '['.repeat(JSON_FORMAT_MAX_DEPTH + 1) + '0' + ']'.repeat(JSON_FORMAT_MAX_DEPTH + 1);
    const fail1001 = formatJsonStrict(depth1001, { maxBytes: 10_000_000 });
    expect(fail1001.ok).toBe(false);
    if (!fail1001.ok) {
      expect(fail1001.error.code).toBe('DEPTH_LIMIT_EXCEEDED');
    }

    const depth10000 = '['.repeat(10_000) + '0' + ']'.repeat(10_000);
    const fail10000 = formatJsonStrict(depth10000);
    expect(fail10000.ok).toBe(false);
    if (!fail10000.ok) {
      expect(fail10000.error.code).toBe('DEPTH_LIMIT_EXCEEDED');
    }

    const depth10000Obj = '{"a":'.repeat(10_000) + '0' + '}'.repeat(10_000);
    const fail10000Obj = formatJsonStrict(depth10000Obj);
    expect(fail10000Obj.ok).toBe(false);
    if (!fail10000Obj.ok) {
      expect(fail10000Obj.error.code).toBe('DEPTH_LIMIT_EXCEEDED');
      expect(fail10000Obj.error.depth).toBe(10_000);
      expect(fail10000Obj.error.maxDepth).toBe(JSON_FORMAT_MAX_DEPTH);
    }
  });

  it('precomputes formatted byte length and rejects when output exceeds 262144 B (P04-A7)', () => {
    // Compact array of 60,000 numbers is ~120 KB unformatted, but with '\n  ' per element
    // it expands past 262,144 B.
    const elements = Array.from({ length: 60_000 }, () => '0').join(',');
    const compact = `[${elements}]`;
    expect(compact.length).toBeLessThan(JSON_MAX_UTF8_BYTES);

    const res = formatJsonStrict(compact);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('BYTE_LIMIT_EXCEEDED');
      expect(res.error.limitBytes).toBe(JSON_MAX_UTF8_BYTES);
      expect(res.error.byteLength).toBeGreaterThan(JSON_MAX_UTF8_BYTES);
      // No hardcoded Vietnamese text in library error message (JL1-13)
      expect(res.error.message).not.toContain('Định dạng');
      expect(res.error.message).not.toContain('256 KiB');
    }

    // Never embeds body text in PARSE_ERROR on format (JL1-3)
    const sentinel = 'hunter2-format-secret';
    const badFormat = formatJsonStrict(`{"secret": ${sentinel}}`);
    expect(badFormat.ok).toBe(false);
    if (!badFormat.ok) {
      expect(badFormat.error.code).toBe('PARSE_ERROR');
      expect(badFormat.error.message).not.toContain(sentinel);
      expect(JSON.stringify(badFormat.error)).not.toContain(sentinel);
    }
  });
});
