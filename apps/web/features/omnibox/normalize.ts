/**
 * Name, tag, hint, and search query normalization and validation per P04 plan mục 2.2, 2.3
 * and SPEC §2.4, §8, §9.2.
 *
 * IMPORTANT: Web never normalizes to decide canonical identity on its own; this TypeScript
 * port exists ONLY to merge duplicate tags client-side (e.g. `#Nhà #nhà` in quick-add /
 * tag chips) and pre-validate inputs before sending. It runs against the exact same shared
 * fixture (`packages/content-fixtures/normalize.json`) as Go `apps/api/internal/textnorm`.
 *
 * Normalization order (advisor-dec-125):
 *   1. Reject ill-formed UTF-16/UTF-8, C0/C1 control characters (U+0000–U+001F,
 *      U+007F–U+009F) except ASCII space U+0020, bidi override/isolate code points
 *      (U+202A–U+202E, U+2066–U+2069), or strings empty after trimming Unicode White_Space.
 *   2. Unicode NFC -> per-code-point lowercase matching Go `unicode.ToLower` (no locale
 *      special-casing; 1-to-1 code point mapping: U+0130 -> 'i', U+03A3 -> U+03C3, etc.) ->
 *      Unicode NFC again -> collapse contiguous Unicode White_Space runs to a single
 *      ASCII space U+0020 -> trim leading/trailing space -> repeatedly strip leading and
 *      trailing punctuation runes (Unicode category P*, plus any spaces exposed by stripping).
 *   3. Reject if the resulting normalized string is empty (e.g. `"!!!"`, Q12) or if either
 *      the trimmed original display string or the normalized string violates rune bounds.
 */

import { isWellFormedUtf16 } from '../../lib/json/utf8';

export const NAME_MIN_RUNES = 1;
export const NAME_MAX_RUNES = 200;

export const TAG_MIN_RUNES = 1;
export const TAG_MAX_RUNES = 50;

export const HINT_MAX_RUNES = 120;

export const QUERY_MAX_RUNES = 200;
export const TAG_QUERY_MAX_RUNES = 50;

export type NormalizeErrorCode =
  | 'name_invalid'
  | 'tag_display_invalid'
  | 'hint_invalid';

/**
 * Typed sentinel error matching Go `textnorm.Error`.
 * `message` and `code` are the exact RFC 9457 ProblemCode string and NEVER embed user input.
 */
export class TextNormError extends Error {
  readonly code: NormalizeErrorCode;

  constructor(code: NormalizeErrorCode) {
    super(code);
    this.name = 'TextNormError';
    this.code = code;
  }
}

export const ERR_NAME_INVALID = new TextNormError('name_invalid');
export const ERR_TAG_DISPLAY_INVALID = new TextNormError('tag_display_invalid');
export const ERR_HINT_INVALID = new TextNormError('hint_invalid');

export type NormalizeBothResult =
  | {
      readonly ok: true;
      readonly trimmed: string;
      readonly normalized: string;
    }
  | {
      readonly ok: false;
      readonly error: NormalizeErrorCode;
    };

export type NormalizeSingleResult =
  | {
      readonly ok: true;
      readonly normalized: string;
    }
  | {
      readonly ok: false;
      readonly error: NormalizeErrorCode;
    };

export type ValidateHintResult =
  | {
      readonly ok: true;
      readonly trimmed: string;
    }
  | {
      readonly ok: false;
      readonly error: 'hint_invalid';
    };

const utf8FatalDecoder = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});

const UNICODE_PUNCT_RE = /^\p{P}$/u;

/**
 * Counts Unicode code points (runes) in a string, matching Go `utf8.RuneCountInString`.
 */
export function countRunes(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      }
    }
    count++;
  }
  return count;
}

/**
 * Checks whether a Unicode code point is a Unicode `White_Space` character,
 * matching Go `unicode.IsSpace`.
 */
export function isUnicodeWhiteSpace(cp: number): boolean {
  if (cp <= 0x00ff) {
    return (
      cp === 0x20 ||
      cp === 0x09 ||
      cp === 0x0a ||
      cp === 0x0b ||
      cp === 0x0c ||
      cp === 0x0d ||
      cp === 0x85 ||
      cp === 0xa0
    );
  }
  return (
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/**
 * Checks whether a Unicode code point is forbidden by plan mục 2.2 step 1:
 * C0/C1 control characters (U+0000–U+001F, U+007F–U+009F) except U+0020 space,
 * and bidi overrides/isolates (U+202A–U+202E, U+2066–U+2069).
 */
export function isForbiddenRune(cp: number): boolean {
  if (cp === 0x20) {
    return false;
  }
  if (cp <= 0x001f || (cp >= 0x007f && cp <= 0x009f)) {
    return true;
  }
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
    return true;
  }
  return false;
}

/**
 * Checks whether a string contains any forbidden C0/C1 or bidi override/isolate rune.
 */
export function hasForbiddenRune(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isForbiddenRune(cp)) {
      return true;
    }
  }
  return false;
}

/**
 * Lowercases a single Unicode code point using Go `unicode.ToLower` 1-to-1 simple case
 * folding semantics (no locale special-casing, no multi-character expansion, no contextual
 * Greek final-sigma rule).
 */
export function toLowerRuneGo(cp: number): string {
  // U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE -> 'i' (U+0069) in Go unicode.ToLower,
  // whereas JS String.prototype.toLowerCase() expands it to 'i\u0307' (2 code points).
  if (cp === 0x0130) {
    return 'i';
  }
  // U+03A3 GREEK CAPITAL LETTER SIGMA -> U+03C3 (always non-final sigma per code point).
  if (cp === 0x03a3) {
    return '\u03c3';
  }
  const ch = String.fromCodePoint(cp);
  const lowered = ch.toLowerCase();
  if (countRunes(lowered) === 1) {
    return lowered;
  }
  return ch;
}

/**
 * Trims leading and trailing Unicode `White_Space` code points (`unicode.IsSpace`).
 */
export function trimUnicodeWhiteSpace(value: string): string {
  const runes = Array.from(value);
  let start = 0;
  let end = runes.length;
  while (start < end) {
    const cp = runes[start]?.codePointAt(0);
    if (cp === undefined || !isUnicodeWhiteSpace(cp)) {
      break;
    }
    start++;
  }
  while (end > start) {
    const cp = runes[end - 1]?.codePointAt(0);
    if (cp === undefined || !isUnicodeWhiteSpace(cp)) {
      break;
    }
    end--;
  }
  if (start === 0 && end === runes.length) {
    return value;
  }
  return runes.slice(start, end).join('');
}

/**
 * Executes plan mục 2.2 step 2 on a valid string that has already passed step 1
 * (advisor-dec-125):
 * NFC -> per-rune `toLowerRuneGo` -> NFC again -> collapse `White_Space` runs to `' '` ->
 * trim -> repeatedly strip leading/trailing `P*` (and any newly exposed edge spaces).
 */
function normalizeStep2(value: string): string {
  const nfcFirst = value.normalize('NFC');
  let lowered = '';
  for (const ch of nfcFirst) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) {
      lowered += toLowerRuneGo(cp);
    }
  }
  const nfcSecond = lowered.normalize('NFC');

  let collapsed = '';
  let inSpace = false;
  for (const ch of nfcSecond) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isUnicodeWhiteSpace(cp)) {
      if (collapsed.length > 0) {
        inSpace = true;
      }
      continue;
    }
    if (inSpace) {
      collapsed += ' ';
      inSpace = false;
    }
    collapsed += ch;
  }

  let res = collapsed;
  while (res.length > 0) {
    const before = res;
    const runes = Array.from(res);
    let start = 0;
    let end = runes.length;
    while (start < end) {
      const ch = runes[start];
      if (ch === undefined || !UNICODE_PUNCT_RE.test(ch)) {
        break;
      }
      start++;
    }
    while (end > start) {
      const ch = runes[end - 1];
      if (ch === undefined || !UNICODE_PUNCT_RE.test(ch)) {
        break;
      }
      end--;
    }
    res = runes.slice(start, end).join('');
    while (res.startsWith(' ')) {
      res = res.slice(1);
    }
    while (res.endsWith(' ')) {
      res = res.slice(0, -1);
    }
    if (res === before) {
      break;
    }
  }
  return res;
}

/**
 * Decodes a UTF-8 byte sequence strictly using a fatal `TextDecoder` (without stripping BOM,
 * since BOM U+FEFF is not a valid name/tag character unless trimmed or rejected).
 * Returns `null` if the byte sequence is ill-formed UTF-8.
 */
export function decodeUtf8StrictForNormalize(bytes: Uint8Array): string | null {
  try {
    return utf8FatalDecoder.decode(bytes);
  } catch {
    return null;
  }
}

function resolveInputString(input: string | Uint8Array): string | null {
  if (typeof input === 'string') {
    if (!isWellFormedUtf16(input)) {
      return null;
    }
    return input;
  }
  if (input instanceof Uint8Array) {
    const decoded = decodeUtf8StrictForNormalize(input);
    if (decoded === null || !isWellFormedUtf16(decoded)) {
      return null;
    }
    return decoded;
  }
  return null;
}

function normalizeAndTrim(
  input: string | Uint8Array,
  invalidCode: NormalizeErrorCode,
): NormalizeBothResult {
  const s = resolveInputString(input);
  if (s === null || hasForbiddenRune(s)) {
    return { ok: false, error: invalidCode };
  }
  const trimmed = trimUnicodeWhiteSpace(s);
  if (trimmed === '') {
    return { ok: false, error: invalidCode };
  }
  const normalized = normalizeStep2(trimmed);
  if (normalized === '') {
    return { ok: false, error: invalidCode };
  }
  return { ok: true, trimmed, normalized };
}

function runeCountBetween(value: string, minRunes: number, maxRunes: number): boolean {
  const n = countRunes(value);
  return n >= minRunes && n <= maxRunes;
}

/**
 * Base normalization without a maximum rune limit (plan mục 2.2 steps 1–3).
 * Maps invalid inputs to `'name_invalid'`.
 */
export function normalize(input: string | Uint8Array): NormalizeSingleResult {
  const res = normalizeAndTrim(input, 'name_invalid');
  if (!res.ok) {
    return res;
  }
  return { ok: true, normalized: res.normalized };
}

/**
 * Validates and normalizes an item name (plan mục 2.2, 2.3):
 * - Enforces 1..200 runes on both trimmed display string and normalized string.
 * - Maps failures to `'name_invalid'`.
 */
export function normalizeName(input: string | Uint8Array): NormalizeBothResult {
  const res = normalizeAndTrim(input, 'name_invalid');
  if (!res.ok) {
    return res;
  }
  if (
    !runeCountBetween(res.trimmed, NAME_MIN_RUNES, NAME_MAX_RUNES) ||
    !runeCountBetween(res.normalized, NAME_MIN_RUNES, NAME_MAX_RUNES)
  ) {
    return { ok: false, error: 'name_invalid' };
  }
  return res;
}

/**
 * Validates and normalizes the `name` query parameter for `GET /items/lookup?name=`
 * (plan mục 2.3, 2.7).
 */
export function normalizeLookupName(input: string | Uint8Array): NormalizeSingleResult {
  const res = normalizeName(input);
  if (!res.ok) {
    return res;
  }
  return { ok: true, normalized: res.normalized };
}

/**
 * Validates and normalizes a tag display string (plan mục 2.2, 2.3):
 * - Enforces 1..50 runes on both trimmed display string and normalized string.
 * - Maps failures to `'tag_display_invalid'`.
 */
export function normalizeTag(input: string | Uint8Array): NormalizeBothResult {
  const res = normalizeAndTrim(input, 'tag_display_invalid');
  if (!res.ok) {
    return res;
  }
  if (
    !runeCountBetween(res.trimmed, TAG_MIN_RUNES, TAG_MAX_RUNES) ||
    !runeCountBetween(res.normalized, TAG_MIN_RUNES, TAG_MAX_RUNES)
  ) {
    return { ok: false, error: 'tag_display_invalid' };
  }
  return res;
}

/**
 * Validates an item hint (plan mục 2.3):
 * - Rejects invalid UTF-8/UTF-16, C0/C1 controls except U+0020, and bidi overrides/isolates.
 * - Trims leading/trailing Unicode `White_Space` without lowercasing or stripping punctuation.
 * - Enforces 0..120 runes on the trimmed result.
 */
export function validateHint(input: string | Uint8Array): ValidateHintResult {
  const s = resolveInputString(input);
  if (s === null || hasForbiddenRune(s)) {
    return { ok: false, error: 'hint_invalid' };
  }
  const trimmed = trimUnicodeWhiteSpace(s);
  if (countRunes(trimmed) > HINT_MAX_RUNES) {
    return { ok: false, error: 'hint_invalid' };
  }
  return { ok: true, trimmed };
}

function normalizeOptionalQuery(
  input: string | Uint8Array,
  maxRunes: number,
): NormalizeSingleResult {
  const s = resolveInputString(input);
  if (s === null || hasForbiddenRune(s)) {
    return { ok: false, error: 'name_invalid' };
  }
  const trimmed = trimUnicodeWhiteSpace(s);
  if (trimmed === '') {
    return { ok: true, normalized: '' };
  }
  if (countRunes(trimmed) > maxRunes) {
    return { ok: false, error: 'name_invalid' };
  }
  const normalized = normalizeStep2(trimmed);
  if (normalized === '' || countRunes(normalized) > maxRunes) {
    return { ok: false, error: 'name_invalid' };
  }
  return { ok: true, normalized };
}

/**
 * Validates and normalizes the optional `q` prefix filter for `GET /items?q=`
 * (plan mục 2.2, 2.3, 2.7; <= 200 runes).
 */
export function normalizeQuery(input: string | Uint8Array): NormalizeSingleResult {
  return normalizeOptionalQuery(input, QUERY_MAX_RUNES);
}

/**
 * Validates and normalizes the optional `q` prefix filter for `GET /tags?q=`
 * (plan mục 2.7, 3; <= 50 runes).
 */
export function normalizeTagQuery(input: string | Uint8Array): NormalizeSingleResult {
  return normalizeOptionalQuery(input, TAG_QUERY_MAX_RUNES);
}
