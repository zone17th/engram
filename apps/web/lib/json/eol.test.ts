import { describe, expect, it } from 'vitest';
import {
  applyTextareaEol,
  convertEol,
  detectEol,
  normalizeEolToLf,
} from './eol';

describe('lib/json/eol', () => {
  it('detects pure lf, pure crlf, mixed, and lone cr line endings', () => {
    const noBreaks = detectEol('{"a":1}');
    expect(noBreaks.kind).toBe('lf');
    expect(noBreaks.majority).toBe('lf');
    expect(noBreaks.totalBreaks).toBe(0);
    expect(noBreaks.requiresConversionWarning).toBe(false);

    const pureLf = detectEol('{\n  "a": 1,\n  "b": 2\n}');
    expect(pureLf.kind).toBe('lf');
    expect(pureLf.majority).toBe('lf');
    expect(pureLf.lfCount).toBe(3);
    expect(pureLf.crlfCount).toBe(0);
    expect(pureLf.crCount).toBe(0);
    expect(pureLf.requiresConversionWarning).toBe(false);

    const pureCrlf = detectEol('{\r\n  "a": 1,\r\n  "b": 2\r\n}');
    expect(pureCrlf.kind).toBe('crlf');
    expect(pureCrlf.majority).toBe('crlf');
    expect(pureCrlf.crlfCount).toBe(3);
    expect(pureCrlf.lfCount).toBe(0);
    expect(pureCrlf.crCount).toBe(0);
    expect(pureCrlf.requiresConversionWarning).toBe(false);

    const mixedMoreCrlf = detectEol('{\r\n  "a": 1,\r\n  "b": 2\n}');
    expect(mixedMoreCrlf.kind).toBe('mixed');
    expect(mixedMoreCrlf.majority).toBe('crlf');
    expect(mixedMoreCrlf.crlfCount).toBe(2);
    expect(mixedMoreCrlf.lfCount).toBe(1);
    expect(mixedMoreCrlf.requiresConversionWarning).toBe(true);

    const mixedMoreLf = detectEol('{\r\n  "a": 1,\n  "b": 2\n}');
    expect(mixedMoreLf.kind).toBe('mixed');
    expect(mixedMoreLf.majority).toBe('lf');
    expect(mixedMoreLf.crlfCount).toBe(1);
    expect(mixedMoreLf.lfCount).toBe(2);
    expect(mixedMoreLf.requiresConversionWarning).toBe(true);

    // Any lone \r classifies the document as 'cr'
    const loneCr = detectEol('{\r  "a": 1\r}');
    expect(loneCr.kind).toBe('cr');
    expect(loneCr.crCount).toBe(2);
    expect(loneCr.majority).toBe('cr');
    expect(loneCr.majoritySeq).toBe('\r');
    expect(loneCr.requiresConversionWarning).toBe(true);
    const mixedWithCr = detectEol('{\r\n  "a": 1,\r  "b": 2\r\n}');
    expect(mixedWithCr.kind).toBe('cr');
    expect(mixedWithCr.majority).toBe('crlf');
    expect(mixedWithCr.requiresConversionWarning).toBe(true);
  });

  it('resolves ties over {LF, CRLF, CR} using the first line break in the document (plan §2.10 rule 5)', () => {
    const tieFirstCrlf = detectEol('{\r\n  "a": 1,\n  "b": 2}');
    expect(tieFirstCrlf.kind).toBe('mixed');
    expect(tieFirstCrlf.crlfCount).toBe(1);
    expect(tieFirstCrlf.lfCount).toBe(1);
    expect(tieFirstCrlf.majority).toBe('crlf');
    expect(tieFirstCrlf.majoritySeq).toBe('\r\n');

    const tieFirstLf = detectEol('{\n  "a": 1,\r\n  "b": 2}');
    expect(tieFirstLf.kind).toBe('mixed');
    expect(tieFirstLf.crlfCount).toBe(1);
    expect(tieFirstLf.lfCount).toBe(1);
    expect(tieFirstLf.majority).toBe('lf');
    expect(tieFirstLf.majoritySeq).toBe('\n');

    const tieFirstCr = detectEol('{\r  "a": 1,\n  "b": 2}');
    expect(tieFirstCr.kind).toBe('cr');
    expect(tieFirstCr.crCount).toBe(1);
    expect(tieFirstCr.lfCount).toBe(1);
    expect(tieFirstCr.majority).toBe('cr');
    expect(tieFirstCr.majoritySeq).toBe('\r');

    // Fallback branch when first break is not among the tied maximum counts (`crlf -> lf -> cr` order, JL2-5):
    // crlf=1 (first break), lf=2, cr=2 -> lf & cr tied at 2, firstBreak='crlf' not tied -> falls back to 'lf'
    const tieFallbackLfVsCr = detectEol('{\r\n  "a": 1,\n  "b": 2,\n  "c": 3,\r  "d": 4,\r  "e": 5}');
    expect(tieFallbackLfVsCr.crlfCount).toBe(1);
    expect(tieFallbackLfVsCr.lfCount).toBe(2);
    expect(tieFallbackLfVsCr.crCount).toBe(2);
    expect(tieFallbackLfVsCr.majority).toBe('lf');
    expect(tieFallbackLfVsCr.majoritySeq).toBe('\n');

    // lf=1 (first break), crlf=2, cr=2 -> crlf & cr tied at 2, firstBreak='lf' not tied -> falls back to 'crlf'
    const tieFallbackCrlfVsCr = detectEol('{\n  "a": 1,\r\n  "b": 2,\r\n  "c": 3,\r  "d": 4,\r  "e": 5}');
    expect(tieFallbackCrlfVsCr.lfCount).toBe(1);
    expect(tieFallbackCrlfVsCr.crlfCount).toBe(2);
    expect(tieFallbackCrlfVsCr.crCount).toBe(2);
    expect(tieFallbackCrlfVsCr.majority).toBe('crlf');
    expect(tieFallbackCrlfVsCr.majoritySeq).toBe('\r\n');
  });

  it('returns changed: false and preserves originalSource byte-for-byte when textarea only normalized EOLs (§2.10 rule 2, P04-A6)', () => {
    const originalCrlf = '{\r\n  "host": "db.internal",\r\n  "port": 5432\r\n}\r\n';
    // Browser <textarea>.value normalizes CRLF to LF:
    const textareaValue = normalizeEolToLf(originalCrlf);
    expect(textareaValue).not.toBe(originalCrlf);

    const plan = applyTextareaEol(originalCrlf, textareaValue);
    expect(plan.changed).toBe(false);
    expect(plan.text).toBe(originalCrlf);
    expect(plan.requiresWarning).toBe(false);

    // Also works for mixed/CR documents if the user did not edit any character:
    const originalMixed = '{\r\n  "a": 1,\n  "b": 2\r}';
    const mixedPlan = applyTextareaEol(originalMixed, normalizeEolToLf(originalMixed));
    expect(mixedPlan.changed).toBe(false);
    expect(mixedPlan.text).toBe(originalMixed);
    expect(mixedPlan.requiresWarning).toBe(false);
  });

  it('re-applies CRLF or majority EOL when textarea content was modified (§2.10 rule 2)', () => {
    const originalCrlf = '{\r\n  "host": "db.internal",\r\n  "port": 5432\r\n}\r\n';
    const editedTextarea = '{\n  "host": "db.internal",\n  "port": 5433\n}\n';

    const crlfPlan = applyTextareaEol(originalCrlf, editedTextarea);
    expect(crlfPlan.changed).toBe(true);
    expect(crlfPlan.requiresWarning).toBe(false);
    expect(crlfPlan.targetEol).toBe('crlf');
    expect(crlfPlan.text).toBe('{\r\n  "host": "db.internal",\r\n  "port": 5433\r\n}\r\n');

    // Mixed EOL with CRLF majority -> warns and converts to CRLF
    const originalMixed = '{\r\n  "a": 1,\r\n  "b": 2\n}';
    const mixedEdited = '{\n  "a": 10,\n  "b": 2\n}';
    const mixedPlan = applyTextareaEol(originalMixed, mixedEdited);
    expect(mixedPlan.changed).toBe(true);
    expect(mixedPlan.requiresWarning).toBe(true);
    expect(mixedPlan.targetEol).toBe('crlf');
    expect(mixedPlan.text).toBe('{\r\n  "a": 10,\r\n  "b": 2\r\n}');

    expect(convertEol('a\r\nb\rc\n', 'lf')).toBe('a\nb\nc\n');
    expect(convertEol('a\nb\rc', 'crlf')).toBe('a\r\nb\r\nc');
    expect(convertEol('a\r\nb\nc', 'cr')).toBe('a\rb\rc');
  });
});
