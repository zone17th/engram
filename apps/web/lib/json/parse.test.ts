import { describe, expect, it } from 'vitest';
import {
  isValidJsonNumberLexeme,
  lineColumnToOffset,
  offsetToLineColumn,
  parseJsonStrict,
  type JsonErrorCode,
} from './parse';

describe('lib/json/parse', () => {
  it('parses strict RFC 8259 primitives, objects, and arrays with exact UTF-16 spans', () => {
    const src = '{\n  "a": 9007199254740993,\n  "b": "caf\\u00e9 😀",\n  "a": -0\n}';
    const res = parseJsonStrict(src);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const root = res.document.root;
    expect(root.kind).toBe('object');
    expect(root.span).toEqual({ start: 0, end: src.length });
    if (root.kind !== 'object') return;

    expect(root.hasDuplicateKeys).toBe(true);
    expect(root.properties).toHaveLength(3);

    const [p0, p1, p2] = root.properties;
    expect(p0?.key).toBe('a');
    expect(p0?.occurrenceIndex).toBe(0);
    expect(p0?.valueNode.kind).toBe('number');
    if (p0?.valueNode.kind === 'number') {
      expect(p0.valueNode.lexeme).toBe('9007199254740993');
      expect(src.slice(p0.valueNode.span.start, p0.valueNode.span.end)).toBe('9007199254740993');
    }

    expect(p1?.key).toBe('b');
    expect(p1?.occurrenceIndex).toBe(0);
    expect(p1?.valueNode.kind).toBe('string');
    if (p1?.valueNode.kind === 'string') {
      expect(p1.valueNode.value).toBe('café 😀');
      expect(p1.valueNode.raw).toBe('"caf\\u00e9 😀"');
      expect(p1.valueNode.hasLoneSurrogate).toBe(false);
    }

    expect(p2?.key).toBe('a');
    expect(p2?.occurrenceIndex).toBe(1);
    expect(p2?.valueNode.kind).toBe('number');
    if (p2?.valueNode.kind === 'number') {
      expect(p2.valueNode.lexeme).toBe('-0');
    }
  });

  it('rejects non-RFC-8259 syntax with structured {offset, line, column, code}', () => {
    const invalidCases: { input: string; code: JsonErrorCode; line: number; col: number }[] = [
      { input: '', code: 'EMPTY_DOCUMENT', line: 1, col: 1 },
      { input: '   \r\n\t  ', code: 'EMPTY_DOCUMENT', line: 2, col: 4 },
      { input: '// comment\n{"a":1}', code: 'COMMENT_NOT_ALLOWED', line: 1, col: 1 },
      { input: '{\n  /* block */ "a": 1\n}', code: 'COMMENT_NOT_ALLOWED', line: 2, col: 3 },
      { input: '{"a": 1,}', code: 'TRAILING_COMMA', line: 1, col: 8 },
      { input: '[1, 2, ]', code: 'TRAILING_COMMA', line: 1, col: 6 },
      { input: '{"a": 1} {"b": 2}', code: 'TRAILING_CONTENT', line: 1, col: 10 },
      { input: '01', code: 'INVALID_NUMBER', line: 1, col: 1 },
      { input: '-01', code: 'INVALID_NUMBER', line: 1, col: 1 },
      { input: '.5', code: 'INVALID_NUMBER', line: 1, col: 1 },
      { input: '+1', code: 'INVALID_NUMBER', line: 1, col: 1 },
      { input: '1.', code: 'INVALID_NUMBER', line: 1, col: 1 },
      { input: '1e', code: 'INVALID_NUMBER', line: 1, col: 1 },
      { input: '1e+', code: 'INVALID_NUMBER', line: 1, col: 1 },
      { input: '"bad\\x20escape"', code: 'INVALID_ESCAPE', line: 1, col: 5 },
      { input: '"bad\\u12G4"', code: 'INVALID_UNICODE_ESCAPE', line: 1, col: 5 },
      { input: '"short\\u12"', code: 'INVALID_UNICODE_ESCAPE', line: 1, col: 7 },
      { input: '"raw\nnewline"', code: 'UNESCAPED_CONTROL_CHAR', line: 1, col: 5 },
      { input: '"raw\ttab"', code: 'UNESCAPED_CONTROL_CHAR', line: 1, col: 5 },
      { input: '"raw\u0000nul"', code: 'UNESCAPED_CONTROL_CHAR', line: 1, col: 5 },
      { input: '\uFEFF{"a":1}', code: 'BOM_NOT_WHITESPACE', line: 1, col: 1 },
      { input: '{\uFEFF"a":1}', code: 'BOM_NOT_WHITESPACE', line: 1, col: 2 },
      { input: '{a: 1}', code: 'EXPECTED_PROPERTY_KEY', line: 1, col: 2 },
      { input: '{"a" 1}', code: 'EXPECTED_COLON', line: 1, col: 6 },
      { input: '{"a": 1 "b": 2}', code: 'EXPECTED_COMMA_OR_END', line: 1, col: 9 },
      { input: '[1 2]', code: 'EXPECTED_COMMA_OR_END', line: 1, col: 4 },
      { input: '"unterminated', code: 'UNTERMINATED_STRING', line: 1, col: 1 },
    ];

    for (const tc of invalidCases) {
      const res = parseJsonStrict(tc.input);
      expect(res.ok, `Expected failure for: ${JSON.stringify(tc.input)}`).toBe(false);
      if (!res.ok) {
        expect(res.error.code, `Code for ${JSON.stringify(tc.input)}`).toBe(tc.code);
        expect(res.error.line, `Line for ${JSON.stringify(tc.input)}`).toBe(tc.line);
        expect(res.error.column, `Col for ${JSON.stringify(tc.input)}`).toBe(tc.col);
      }
    }
  });

  it('never embeds source body text into any JsonParseError field (JL1-3)', () => {
    const sentinel = 'hunter2-secret-token';
    const failingInputs = [
      `{"pw": ${sentinel}}`,
      `{"pw": "bad\\q${sentinel}"}`,
      `{"pw": "ctrl\u0007${sentinel}"}`,
      `{"pw": "bad\\u12G4${sentinel}"}`,
      `{"pw": "${sentinel}`,
      `{"pw": 0123} ${sentinel}`,
      `{${sentinel}: 1}`,
      `{"${sentinel}" 1}`,
      `{"a": 1 "${sentinel}": 2}`,
      `// ${sentinel}\n{"a":1}`,
    ];

    for (const input of failingInputs) {
      const res = parseJsonStrict(input);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        const serialized = JSON.stringify(res.error);
        expect(res.error.message).not.toContain(sentinel);
        expect(res.error.message).not.toContain('hunter2');
        expect(serialized).not.toContain(sentinel);
        expect(serialized).not.toContain('hunter2');
      }
    }
  });

  it('assigns monotonically increasing default revisions across parses (JL1-9)', () => {
    const first = parseJsonStrict('[1, 2]');
    const second = parseJsonStrict('[1, 9]');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.document.revision).toBeGreaterThan(first.document.revision);
    }
  });

  it('computes UTF-16 line and column accurately with CRLF, lone CR, and astral characters', () => {
    // Line 1: {"emoji": "😀",\r\n
    // Note: "😀" is 2 UTF-16 code units!
    // Line 2: "bad": 01}
    const src = '{"emoji": "😀",\r\n"bad": 01}';
    const res = parseJsonStrict(src);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('INVALID_NUMBER');
      expect(res.error.line).toBe(2);
      expect(res.error.column).toBe(8);
      expect(lineColumnToOffset(src, res.error.line, res.error.column)).toBe(res.error.offset);
    }

    // Astral character on the same line before the error:
    // '{"a":"😀", bad}'
    // Indices:
    // 0: { (col 1)
    // 1..3: "a" (col 2..4)
    // 4: : (col 5)
    // 5: " (col 6)
    // 6..7: 😀 (2 UTF-16 units -> col 7..8)
    // 8: " (col 9)
    // 9: , (col 10)
    // 10: space (col 11)
    // 11: b (col 12)
    const astralSameLine = '{"a":"😀", bad}';
    const astralRes = parseJsonStrict(astralSameLine);
    expect(astralRes.ok).toBe(false);
    if (!astralRes.ok) {
      expect(astralRes.error.offset).toBe(11);
      expect(astralRes.error.line).toBe(1);
      expect(astralRes.error.column).toBe(12);
    }

    // Lone CR counts as a line break (consistent with eol.ts)
    const loneCrSrc = '{\r  "x": +1\r}';
    const loneCrRes = parseJsonStrict(loneCrSrc);
    expect(loneCrRes.ok).toBe(false);
    if (!loneCrRes.ok) {
      expect(loneCrRes.error.line).toBe(2);
      expect(loneCrRes.error.column).toBe(8);
      expect(offsetToLineColumn(loneCrSrc, loneCrRes.error.offset)).toEqual({
        line: 2,
        column: 8,
      });
    }
  });

  it('flags lone surrogates in JSON string escapes without rejecting valid RFC 8259 syntax', () => {
    const res = parseJsonStrict('{"loneHigh":"\\ud800","loneLow":"\\udfff","pair":"\\ud83d\\ude00"}');
    expect(res.ok).toBe(true);
    if (!res.ok || res.document.root.kind !== 'object') return;

    const [pHigh, pLow, pPair] = res.document.root.properties;
    expect(pHigh?.valueNode.kind).toBe('string');
    if (pHigh?.valueNode.kind === 'string') {
      expect(pHigh.valueNode.hasLoneSurrogate).toBe(true);
    }
    if (pLow?.valueNode.kind === 'string') {
      expect(pLow.valueNode.hasLoneSurrogate).toBe(true);
    }
    if (pPair?.valueNode.kind === 'string') {
      expect(pPair.valueNode.hasLoneSurrogate).toBe(false);
      expect(pPair.valueNode.value).toBe('😀');
    }
  });

  it('validates JSON number lexemes strictly', () => {
    expect(isValidJsonNumberLexeme('0')).toBe(true);
    expect(isValidJsonNumberLexeme('-0')).toBe(true);
    expect(isValidJsonNumberLexeme('42')).toBe(true);
    expect(isValidJsonNumberLexeme('9007199254740993')).toBe(true);
    expect(isValidJsonNumberLexeme('0.10')).toBe(true);
    expect(isValidJsonNumberLexeme('1e400')).toBe(true);
    expect(isValidJsonNumberLexeme('-2.5E-10')).toBe(true);

    expect(isValidJsonNumberLexeme('')).toBe(false);
    expect(isValidJsonNumberLexeme('01')).toBe(false);
    expect(isValidJsonNumberLexeme('-01')).toBe(false);
    expect(isValidJsonNumberLexeme('+1')).toBe(false);
    expect(isValidJsonNumberLexeme('.5')).toBe(false);
    expect(isValidJsonNumberLexeme('1.')).toBe(false);
    expect(isValidJsonNumberLexeme('1e')).toBe(false);
    expect(isValidJsonNumberLexeme('1e+')).toBe(false);
    expect(isValidJsonNumberLexeme(' 42')).toBe(false);
    expect(isValidJsonNumberLexeme('42 ')).toBe(false);
    expect(isValidJsonNumberLexeme('NaN')).toBe(false);
    expect(isValidJsonNumberLexeme('Infinity')).toBe(false);
  });

  it('parses 10000-deep nested arrays and objects iteratively without stack overflow', () => {
    const deepArray = '['.repeat(10_000) + '1' + ']'.repeat(10_000);
    const arrRes = parseJsonStrict(deepArray);
    expect(arrRes.ok).toBe(true);
    if (arrRes.ok) {
      expect(arrRes.document.maxDepth).toBe(10_000);
    }

    const deepObject = '{"a":'.repeat(10_000) + '1' + '}'.repeat(10_000);
    const objRes = parseJsonStrict(deepObject);
    expect(objRes.ok).toBe(true);
    if (objRes.ok) {
      expect(objRes.document.maxDepth).toBe(10_000);
    }
  });
});
