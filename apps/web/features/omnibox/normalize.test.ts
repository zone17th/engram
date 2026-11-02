import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ERR_HINT_INVALID,
  ERR_NAME_INVALID,
  ERR_TAG_DISPLAY_INVALID,
  TextNormError,
  countRunes,
  decodeUtf8StrictForNormalize,
  normalize,
  normalizeLookupName,
  normalizeName,
  normalizeQuery,
  normalizeTag,
  normalizeTagQuery,
  validateHint,
} from './normalize';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../packages/content-fixtures/normalize.json',
);

interface NormalizeFixtureCase {
  name: string;
  kind: 'name' | 'tag' | 'hint' | 'query';
  input?: string;
  input_bytes?: string;
  trimmed?: string;
  normalized?: string;
  error?: 'name_invalid' | 'tag_display_invalid' | 'hint_invalid';
}

interface NormalizeFixtureSuite {
  version: number;
  schema: string;
  description: string;
  cases: NormalizeFixtureCase[];
}

function loadNormalizeFixtureSuite(): NormalizeFixtureSuite {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  expect(raw.length).toBeGreaterThan(0);
  const suite = JSON.parse(raw) as NormalizeFixtureSuite;
  expect(suite.version).toBe(1);
  expect(suite.schema).toBe('engram-content-normalize-v1');
  expect(suite.cases.length).toBe(79);
  return suite;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function resolveFixtureInput(tc: NormalizeFixtureCase): string | Uint8Array {
  if (tc.input !== undefined && tc.input_bytes !== undefined) {
    throw new Error(`Case ${tc.name} sets both input and input_bytes`);
  }
  if (tc.input !== undefined) {
    return tc.input;
  }
  if (tc.input_bytes !== undefined) {
    return hexToBytes(tc.input_bytes);
  }
  throw new Error(`Case ${tc.name} sets neither input nor input_bytes`);
}

describe('features/omnibox/normalize — shared normalize.json oracle', () => {
  const suite = loadNormalizeFixtureSuite();
  const seenNames = new Set<string>();

  for (const tc of suite.cases) {
    if (seenNames.has(tc.name)) {
      throw new Error(`Duplicate fixture case name: ${tc.name}`);
    }
    seenNames.add(tc.name);

    it(`matches oracle for [${tc.kind}] ${tc.name}`, () => {
      expect.hasAssertions();
      const input = resolveFixtureInput(tc);
      if (tc.input_bytes !== undefined && input instanceof Uint8Array) {
        expect(decodeUtf8StrictForNormalize(input)).toBeNull();
      }

      switch (tc.kind) {
        case 'name': {
          const res = normalizeName(input);
          if (tc.error !== undefined) {
            expect(res).toEqual({ ok: false, error: tc.error });
            expect(normalizeLookupName(input)).toEqual({ ok: false, error: tc.error });
            return;
          }
          expect(res).toEqual({
            ok: true,
            trimmed: tc.trimmed,
            normalized: tc.normalized,
          });
          if (res.ok) {
            expect(normalize(input)).toEqual({ ok: true, normalized: tc.normalized });
            expect(normalizeLookupName(input)).toEqual({
              ok: true,
              normalized: tc.normalized,
            });
            // Idempotency on accepted normalized output
            expect(normalize(res.normalized)).toEqual({
              ok: true,
              normalized: res.normalized,
            });
          }
          break;
        }

        case 'tag': {
          const res = normalizeTag(input);
          if (tc.error !== undefined) {
            expect(res).toEqual({ ok: false, error: tc.error });
            return;
          }
          expect(res).toEqual({
            ok: true,
            trimmed: tc.trimmed,
            normalized: tc.normalized,
          });
          if (res.ok) {
            expect(normalize(input)).toEqual({ ok: true, normalized: tc.normalized });
            expect(normalize(res.normalized)).toEqual({
              ok: true,
              normalized: res.normalized,
            });
          }
          break;
        }

        case 'hint': {
          const res = validateHint(input);
          if (tc.error !== undefined) {
            expect(res).toEqual({ ok: false, error: tc.error });
            return;
          }
          expect(res).toEqual({
            ok: true,
            trimmed: tc.trimmed,
          });
          break;
        }

        case 'query': {
          const res = normalizeQuery(input);
          if (tc.error !== undefined) {
            expect(res).toEqual({ ok: false, error: tc.error });
            return;
          }
          expect(res).toEqual({
            ok: true,
            normalized: tc.normalized,
          });
          break;
        }
      }
    });
  }
});

describe('features/omnibox/normalize — direct unit invariants', () => {
  it('keeps Vietnamese diacritics distinct (mã != ma)', () => {
    const maTilde = normalize('Mã');
    const maPlain = normalize('Ma');
    expect(maTilde).toEqual({ ok: true, normalized: 'mã' });
    expect(maPlain).toEqual({ ok: true, normalized: 'ma' });
    if (maTilde.ok && maPlain.ok) {
      expect(maTilde.normalized).not.toBe(maPlain.normalized);
    }
  });

  it('produces identical keys for J+U+030C, j+U+030C, and precomposed U+01F0 (advisor-dec-125)', () => {
    const inputs = ['J\u030c', 'j\u030c', '\u01f0'];
    for (const input of inputs) {
      expect(normalize(input)).toEqual({ ok: true, normalized: '\u01f0' });
      expect(normalizeName(input)).toEqual({
        ok: true,
        trimmed: input,
        normalized: '\u01f0',
      });
      expect(normalizeLookupName(input)).toEqual({ ok: true, normalized: '\u01f0' });
      expect(normalizeTag(input)).toEqual({
        ok: true,
        trimmed: input,
        normalized: '\u01f0',
      });
    }
  });

  it('rejects all C0 and C1 control characters except U+0020 space', () => {
    for (let cp = 0; cp <= 0x009f; cp++) {
      if (cp > 0x001f && cp < 0x007f) {
        continue;
      }
      const s = `a${String.fromCodePoint(cp)}b`;
      expect(normalize(s)).toEqual({ ok: false, error: 'name_invalid' });
      expect(normalizeName(s)).toEqual({ ok: false, error: 'name_invalid' });
      expect(normalizeTag(s)).toEqual({ ok: false, error: 'tag_display_invalid' });
      expect(validateHint(s)).toEqual({ ok: false, error: 'hint_invalid' });
      expect(normalizeQuery(s)).toEqual({ ok: false, error: 'name_invalid' });
    }
  });

  it('rejects all bidi override and isolate code points', () => {
    const bidiRunes = [
      0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
    ];
    for (const cp of bidiRunes) {
      const s = `item${String.fromCodePoint(cp)}name`;
      expect(normalize(s)).toEqual({ ok: false, error: 'name_invalid' });
      expect(normalizeName(s)).toEqual({ ok: false, error: 'name_invalid' });
      expect(normalizeTag(s)).toEqual({ ok: false, error: 'tag_display_invalid' });
      expect(validateHint(s)).toEqual({ ok: false, error: 'hint_invalid' });
      expect(normalizeQuery(s)).toEqual({ ok: false, error: 'name_invalid' });
    }
  });

  it('rejects unpaired UTF-16 surrogates without leaking input text', () => {
    const loneHigh = 'secret\ud800value';
    expect(normalize(loneHigh)).toEqual({ ok: false, error: 'name_invalid' });
    expect(normalizeName(loneHigh)).toEqual({ ok: false, error: 'name_invalid' });
    expect(normalizeTag(loneHigh)).toEqual({ ok: false, error: 'tag_display_invalid' });
    expect(validateHint(loneHigh)).toEqual({ ok: false, error: 'hint_invalid' });
    expect(normalizeQuery(loneHigh)).toEqual({ ok: false, error: 'name_invalid' });
  });

  it('enforces 50-rune limit in normalizeTagQuery', () => {
    expect(normalizeTagQuery('   ')).toEqual({ ok: true, normalized: '' });
    const q50 = 't'.repeat(50);
    expect(normalizeTagQuery(q50)).toEqual({ ok: true, normalized: q50 });
    const q51 = 't'.repeat(51);
    expect(normalizeTagQuery(q51)).toEqual({ ok: false, error: 'name_invalid' });
  });

  it('counts astral emoji runes as 1 code point each and never embeds input in TextNormError', () => {
    expect(countRunes('🔐🚀')).toBe(2);
    expect(ERR_NAME_INVALID).toBeInstanceOf(TextNormError);
    expect(ERR_NAME_INVALID.code).toBe('name_invalid');
    expect(ERR_NAME_INVALID.message).toBe('name_invalid');
    expect(ERR_TAG_DISPLAY_INVALID.code).toBe('tag_display_invalid');
    expect(ERR_HINT_INVALID.code).toBe('hint_invalid');
  });
});
