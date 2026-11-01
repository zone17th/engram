/**
 * Omnibox quick-add grammar and mode classifier per P04 plan mục 2.11 and SPEC §3.4.
 *
 * SECURITY INVARIANT (advisor-dec-098, P4BE1-1, P4FE1-3):
 * - This parser is a pure, synchronous, side-effect-free function.
 * - It makes NO network requests, reads/writes NO storage or query cache, and NEVER embeds
 *   user input in error codes.
 * - Search (`GET /items?q=`) and add-mode exact lookup (`GET /items/lookup?name=`) are sent
 *   by the UI ONLY on Enter (never while typing).
 */

import { parseJsonStrict } from '../../lib/json/parse';
import {
  NAME_MAX_RUNES,
  countRunes,
  isUnicodeWhiteSpace,
  normalizeName,
  normalizeTag,
  trimUnicodeWhiteSpace,
} from './normalize';

export const QUICK_ADD_MAX_TAGS = 20;
export const QUICK_ADD_SEARCHABLE_MAX_RUNES = 200;

export type QuickAddMode = 'search' | 'tag-filter' | 'add' | 'add-invalid';

export type QuickAddErrorCode =
  | 'body_empty'
  | 'name_empty'
  | 'name_invalid'
  | 'tag_has_space'
  | 'tag_display_invalid'
  | 'tag_limit';

export interface QuickAddParseResult {
  readonly mode: QuickAddMode;
  readonly name: string;
  readonly tags: string[];
  readonly body: string;
  readonly jsonCandidate: boolean;
  readonly searchable: boolean;
  readonly error?: QuickAddErrorCode;
}

interface HeadTokensSplit {
  readonly nameSegment: string;
  readonly tagTokens: string[];
  readonly hasWordAfterTag: boolean;
}

/**
 * Returns the index of the first line break (`\n` or `\r`), or `value.length` if single-line.
 */
function findFirstLineEnd(value: string): number {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0a || code === 0x0d) {
      return i;
    }
  }
  return value.length;
}

/**
 * Finds the index of the first ASCII `:` on `firstLine` that is NOT immediately followed
 * by `//` (SPEC §3.4 `(?!//)` rule so URLs in `head` like `docs https://a.b: note` do not
 * split at `https:`). Full-width colon `：` (U+FF1A) is NOT a separator.
 * Returns `-1` if no separator colon is present on the first line.
 */
export function findQuickAddSeparatorColon(firstLine: string): number {
  for (let i = 0; i < firstLine.length; i++) {
    if (firstLine.charCodeAt(i) === 0x3a /* ':' */) {
      if (
        i + 2 < firstLine.length &&
        firstLine.charCodeAt(i + 1) === 0x2f /* '/' */ &&
        firstLine.charCodeAt(i + 2) === 0x2f /* '/' */
      ) {
        continue;
      }
      return i;
    }
  }
  return -1;
}

/**
 * Splits `head` (the portion of the first line before the separator `:`) into the name
 * segment and trailing `#tag` tokens per plan mục 2.11 rule 3:
 * - Whitespace-delimited tokens are scanned in order.
 * - The first token starting with `#` begins the tag sequence.
 * - Once a `#` token has been seen, every subsequent token must also start with `#`;
 *   any plain word after a tag sets `hasWordAfterTag = true` (`tag_has_space`, Q5).
 */
function splitHeadNameAndTags(head: string): HeadTokensSplit {
  const runes = Array.from(head);
  const tokens: { text: string; startCodeUnit: number }[] = [];

  let i = 0;
  let codeUnitOffset = 0;
  while (i < runes.length) {
    while (i < runes.length) {
      const ch = runes[i];
      const cp = ch?.codePointAt(0);
      if (ch === undefined || cp === undefined || !isUnicodeWhiteSpace(cp)) {
        break;
      }
      codeUnitOffset += ch.length;
      i++;
    }
    if (i >= runes.length) {
      break;
    }
    const tokenStartOffset = codeUnitOffset;
    let tokenText = '';
    while (i < runes.length) {
      const ch = runes[i];
      const cp = ch?.codePointAt(0);
      if (ch === undefined || cp === undefined || isUnicodeWhiteSpace(cp)) {
        break;
      }
      tokenText += ch;
      codeUnitOffset += ch.length;
      i++;
    }
    tokens.push({ text: tokenText, startCodeUnit: tokenStartOffset });
  }

  let firstTagIndex = -1;
  for (let idx = 0; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok !== undefined && tok.text.startsWith('#')) {
      firstTagIndex = idx;
      break;
    }
  }

  const firstTag = firstTagIndex >= 0 ? tokens[firstTagIndex] : undefined;
  if (firstTag === undefined) {
    return {
      nameSegment: head,
      tagTokens: [],
      hasWordAfterTag: false,
    };
  }

  const nameSegment = head.slice(0, firstTag.startCodeUnit);
  const tagTokens: string[] = [];
  let hasWordAfterTag = false;

  for (let idx = firstTagIndex; idx < tokens.length; idx++) {
    const tok = tokens[idx];
    if (tok === undefined) {
      continue;
    }
    if (!tok.text.startsWith('#')) {
      hasWordAfterTag = true;
    } else {
      tagTokens.push(tok.text);
    }
  }

  return {
    nameSegment,
    tagTokens,
    hasWordAfterTag,
  };
}

/**
 * Checks whether `trimmedBody` starts with `{` or `[` and is accepted by `parseJsonStrict`
 * (`apps/web/lib/json`).
 */
function isJsonCandidateBody(trimmedBody: string): boolean {
  if (trimmedBody.length === 0) {
    return false;
  }
  const firstChar = trimmedBody.charCodeAt(0);
  if (firstChar !== 0x7b /* '{' */ && firstChar !== 0x5b /* '[' */) {
    return false;
  }
  return parseJsonStrict(trimmedBody).ok;
}

/**
 * Computes whether a non-add omnibox input is eligible for search on Enter:
 * single line (no `\n` or `\r`) and `<= 200` runes (plan mục 2.11, Task 13).
 */
function isSearchableInput(rawInput: string, firstLineEnd: number): boolean {
  if (firstLineEnd !== rawInput.length) {
    return false;
  }
  return countRunes(rawInput) <= QUICK_ADD_SEARCHABLE_MAX_RUNES;
}

/**
 * Parses the omnibox input string into a `QuickAddParseResult` per P04 plan mục 2.11 and SPEC §3.4.
 */
export function parseQuickAdd(input: string): QuickAddParseResult {
  const firstLineEnd = findFirstLineEnd(input);
  const firstLine = input.slice(0, firstLineEnd);
  const trimmedLeading = trimUnicodeWhiteSpace(input);

  // Rule 1: Input starting with `#` (after leading whitespace) is always tag-filter mode,
  // never quick-add.
  if (trimmedLeading.startsWith('#')) {
    return {
      mode: 'tag-filter',
      name: '',
      tags: [],
      body: '',
      jsonCandidate: false,
      searchable: false,
    };
  }

  const colonIndex = findQuickAddSeparatorColon(firstLine);
  if (colonIndex === -1) {
    return {
      mode: 'search',
      name: '',
      tags: [],
      body: '',
      jsonCandidate: false,
      searchable: isSearchableInput(input, firstLineEnd),
    };
  }

  const rawHead = firstLine.slice(0, colonIndex);
  const rawBody = input.slice(colonIndex + 1);
  const body = trimUnicodeWhiteSpace(rawBody);

  const { nameSegment, tagTokens, hasWordAfterTag } = splitHeadNameAndTags(rawHead);
  const trimmedNameCandidate = trimUnicodeWhiteSpace(nameSegment);
  const nameNorm = normalizeName(nameSegment);

  // Parse and deduplicate tags that are valid so the UI preview can still display what was
  // recognized, while recording the first grammar/validation error if any.
  const deduplicatedTags: string[] = [];
  const seenNormalizedTags = new Set<string>();
  let tagValidationError: QuickAddErrorCode | undefined;

  for (const token of tagTokens) {
    const rawTagDisplay = token.slice(1);
    // Rule 3: A tag token starts with `#`, ends at whitespace, and contains no `#` or `:`.
    if (
      rawTagDisplay.length === 0 ||
      rawTagDisplay.includes('#') ||
      rawTagDisplay.includes(':')
    ) {
      tagValidationError ??= 'tag_display_invalid';
      continue;
    }
    const tagNorm = normalizeTag(rawTagDisplay);
    if (!tagNorm.ok) {
      tagValidationError ??= 'tag_display_invalid';
      continue;
    }
    if (!seenNormalizedTags.has(tagNorm.normalized)) {
      seenNormalizedTags.add(tagNorm.normalized);
      deduplicatedTags.push(tagNorm.trimmed);
    }
  }

  const displayName = nameNorm.ok ? nameNorm.trimmed : trimmedNameCandidate;

  // Determine validation errors in priority order:
  // 1. Name empty or invalid
  if (trimmedNameCandidate === '') {
    return {
      mode: 'add-invalid',
      name: '',
      tags: deduplicatedTags,
      body,
      jsonCandidate: false,
      searchable: false,
      error: 'name_empty',
    };
  }

  if (!nameNorm.ok || countRunes(nameNorm.trimmed) > NAME_MAX_RUNES) {
    return {
      mode: 'add-invalid',
      name: displayName,
      tags: deduplicatedTags,
      body,
      jsonCandidate: false,
      searchable: false,
      error: 'name_invalid',
    };
  }

  // 2. Word after a tag token (Q5: tags with spaces must use chips)
  if (hasWordAfterTag) {
    return {
      mode: 'add-invalid',
      name: nameNorm.trimmed,
      tags: deduplicatedTags,
      body,
      jsonCandidate: false,
      searchable: false,
      error: 'tag_has_space',
    };
  }

  // 3. Invalid tag token (e.g. lone `#`, `#a#b`, `#` > 50 runes, punctuation-only `#!!!`, C0/bidi)
  if (tagValidationError !== undefined) {
    return {
      mode: 'add-invalid',
      name: nameNorm.trimmed,
      tags: deduplicatedTags,
      body,
      jsonCandidate: false,
      searchable: false,
      error: tagValidationError,
    };
  }

  // 4. More than 20 deduplicated tags
  if (deduplicatedTags.length > QUICK_ADD_MAX_TAGS) {
    return {
      mode: 'add-invalid',
      name: nameNorm.trimmed,
      tags: deduplicatedTags,
      body,
      jsonCandidate: false,
      searchable: false,
      error: 'tag_limit',
    };
  }

  // 5. Rule 2: Empty body after `:` -> not add mode yet (show hint "Gõ nội dung sau dấu :")
  if (body === '') {
    return {
      mode: 'add-invalid',
      name: nameNorm.trimmed,
      tags: deduplicatedTags,
      body: '',
      jsonCandidate: false,
      searchable: false,
      error: 'body_empty',
    };
  }

  return {
    mode: 'add',
    name: nameNorm.trimmed,
    tags: deduplicatedTags,
    body,
    jsonCandidate: isJsonCandidateBody(body),
    searchable: false,
  };
}
