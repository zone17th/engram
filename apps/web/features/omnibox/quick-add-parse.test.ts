import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSON_MAX_UTF8_BYTES, measureUtf8Bytes } from '../../lib/json/utf8';
import {
  QUICK_ADD_MAX_TAGS,
  QUICK_ADD_SEARCHABLE_MAX_RUNES,
  findQuickAddSeparatorColon,
  parseQuickAdd,
  type QuickAddErrorCode,
  type QuickAddParseResult,
} from './quick-add-parse';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../packages/content-fixtures/quick-add.json',
);

interface QuickAddFixtureCase {
  name: string;
  input: string;
  expected: QuickAddParseResult;
}

interface QuickAddFixtureSuite {
  version: number;
  schema: string;
  description: string;
  cases: QuickAddFixtureCase[];
}

const ALLOWED_ERROR_CODES: readonly QuickAddErrorCode[] = [
  'body_empty',
  'name_empty',
  'name_invalid',
  'tag_has_space',
  'tag_display_invalid',
  'tag_limit',
];

function loadQuickAddFixtureSuite(): QuickAddFixtureSuite {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  expect(raw.length).toBeGreaterThan(0);
  const suite = JSON.parse(raw) as QuickAddFixtureSuite;
  expect(suite.version).toBe(1);
  expect(suite.schema).toBe('engram-content-quick-add-v1');
  expect(suite.cases.length).toBeGreaterThanOrEqual(60);
  return suite;
}

describe('features/omnibox/quick-add-parse — shared quick-add.json fixture', () => {
  const suite = loadQuickAddFixtureSuite();
  const seenNames = new Set<string>();

  for (const tc of suite.cases) {
    if (seenNames.has(tc.name)) {
      throw new Error(`Duplicate fixture case name: ${tc.name}`);
    }
    seenNames.add(tc.name);

    it(`matches fixture case: ${tc.name}`, () => {
      expect.hasAssertions();
      const actual = parseQuickAdd(tc.input);
      expect(actual).toEqual(tc.expected);
      expect(actual.mode).toBe(tc.expected.mode);
      expect(actual.name).toBe(tc.expected.name);
      expect(actual.tags).toEqual(tc.expected.tags);
      expect(actual.body).toBe(tc.expected.body);
      expect(actual.jsonCandidate).toBe(tc.expected.jsonCandidate);
      expect(actual.searchable).toBe(tc.expected.searchable);
      expect(actual.error).toBe(tc.expected.error);

      if (actual.error !== undefined) {
        expect(ALLOWED_ERROR_CODES).toContain(actual.error);
      }
    });
  }
});

describe('features/omnibox/quick-add-parse — security & boundary invariants', () => {
  it('never embeds input or body text into error codes (user-dec-016, advisor-dec-098)', () => {
    const secretInputs = [
      ':SECRET_BODY_HUNTER2',
      'SECRET_NAME_EMPTY_BODY:',
      'wifi #tag plainWordAfterTag: SECRET_BODY_VALUE',
      'wifi #\ud800: SECRET_BODY_VALUE',
      `wifi\u0007bell: SECRET_BODY_VALUE`,
      `wifi ${Array.from({ length: 21 }, (_, i) => `#tag${i}`).join(' ')}: SECRET_BODY_VALUE`,
    ];

    for (const input of secretInputs) {
      const res = parseQuickAdd(input);
      expect(res.mode).toBe('add-invalid');
      expect(res.error).toBeDefined();
      if (res.error !== undefined) {
        expect(ALLOWED_ERROR_CODES).toContain(res.error);
        expect(res.error).not.toContain('SECRET');
        expect(res.error).not.toContain('HUNTER2');
        expect(res.error).not.toContain('wifi');
      }
    }
  });

  it('has zero side effects and does not reference network, storage, or DOM APIs', () => {
    const parseSource = fs.readFileSync(
      path.resolve(__dirname, './quick-add-parse.ts'),
      'utf8',
    );
    const normalizeSource = fs.readFileSync(
      path.resolve(__dirname, './normalize.ts'),
      'utf8',
    );
    const combined = `${parseSource}\n${normalizeSource}`;

    expect(combined).not.toMatch(/\bfetch\b|\bXMLHttpRequest\b|\bsendBeacon\b/);
    expect(combined).not.toMatch(/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/);
    expect(combined).not.toMatch(/\bwindow\b|\bdocument\b|\bnavigator\b/);
  });

  it('finds the first colon not followed by // on the first line only', () => {
    expect(findQuickAddSeparatorColon('wifi:Abc123')).toBe(4);
    expect(findQuickAddSeparatorColon('https://example.com')).toBe(-1);
    expect(findQuickAddSeparatorColon('docs https://example.com: note')).toBe(24);
    expect(findQuickAddSeparatorColon('a::b')).toBe(1);
    expect(findQuickAddSeparatorColon('wifi\uff1aAbc123')).toBe(-1);
  });

  it('counts astral emoji runes accurately for searchable (200 runes) and tag/name limits', () => {
    expect(QUICK_ADD_MAX_TAGS).toBe(20);
    expect(QUICK_ADD_SEARCHABLE_MAX_RUNES).toBe(200);

    // 200 astral emojis = 200 runes (400 UTF-16 code units) -> searchable: true
    const emoji200 = '🔐'.repeat(200);
    expect(emoji200.length).toBe(400);
    expect(parseQuickAdd(emoji200)).toEqual({
      mode: 'search',
      name: '',
      tags: [],
      body: '',
      jsonCandidate: false,
      searchable: true,
    });

    // 201 astral emojis = 201 runes -> searchable: false
    const emoji201 = '🔐'.repeat(201);
    expect(parseQuickAdd(emoji201)).toEqual({
      mode: 'search',
      name: '',
      tags: [],
      body: '',
      jsonCandidate: false,
      searchable: false,
    });

    // 200 astral emojis in name -> add valid
    expect(parseQuickAdd(`${emoji200}: secret`)).toEqual({
      mode: 'add',
      name: emoji200,
      tags: [],
      body: 'secret',
      jsonCandidate: false,
      searchable: false,
    });

    // 50 astral emojis in tag -> add valid
    const tagEmoji50 = '🚀'.repeat(50);
    expect(parseQuickAdd(`wifi #${tagEmoji50}: secret`)).toEqual({
      mode: 'add',
      name: 'wifi',
      tags: [tagEmoji50],
      body: 'secret',
      jsonCandidate: false,
      searchable: false,
    });

    // 51 astral emojis in tag -> add-invalid
    const tagEmoji51 = '🚀'.repeat(51);
    expect(parseQuickAdd(`wifi #${tagEmoji51}: secret`)).toEqual({
      mode: 'add-invalid',
      name: 'wifi',
      tags: [],
      body: 'secret',
      jsonCandidate: false,
      searchable: false,
      error: 'tag_display_invalid',
    });
  });

  it('rejects a ~100k-rune "! ! ! …:" name before punctuation-strip loop (QA1-3)', () => {
    // 50,000 "! " pairs + "!" = 100,001 runes trimmed (> 200 rune limit)
    const hugePunctName = `${'! '.repeat(50_000)}!`;
    expect(hugePunctName.length).toBe(100_001);
    const res = parseQuickAdd(`${hugePunctName}: secret`);
    expect(res).toEqual({
      mode: 'add-invalid',
      name: hugePunctName,
      tags: [],
      body: 'secret',
      jsonCandidate: false,
      searchable: false,
      error: 'name_invalid',
    });
  });

  it('enforces the 262,144-byte UTF-8 limit on jsonCandidate bodies (QA1-4)', () => {
    expect(JSON_MAX_UTF8_BYTES).toBe(262_144);

    // '{"a":"' is 6 ASCII bytes, '"}' is 2 ASCII bytes -> 262,136 'x' bytes = 262,144 bytes total
    const body262144 = `{"a":"${'x'.repeat(JSON_MAX_UTF8_BYTES - 8)}"}`;
    expect(measureUtf8Bytes(body262144)).toBe(262_144);
    expect(parseQuickAdd(`cfg: ${body262144}`)).toEqual({
      mode: 'add',
      name: 'cfg',
      tags: [],
      body: body262144,
      jsonCandidate: true,
      searchable: false,
    });

    // 1 byte over the 262,144-byte limit -> jsonCandidate: false (still valid add mode as text)
    const body262145 = `{"a":"${'x'.repeat(JSON_MAX_UTF8_BYTES - 7)}"}`;
    expect(measureUtf8Bytes(body262145)).toBe(262_145);
    expect(parseQuickAdd(`cfg: ${body262145}`)).toEqual({
      mode: 'add',
      name: 'cfg',
      tags: [],
      body: body262145,
      jsonCandidate: false,
      searchable: false,
    });
  });
});
