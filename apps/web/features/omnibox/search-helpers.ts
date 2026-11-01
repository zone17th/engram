/**
 * Omnibox client-side helpers for P04 Task 18a (search & tag-filter modes):
 * - Extracts the tag-filter token and rune-bound validity from `#…` inputs.
 * - Filters cached `Tag` items by normalized prefix without network requests.
 * - Splits item/tag names for `<mark>` prefix highlighting without putting user input into attributes.
 */

import type { Tag } from '@/lib/api/content';
import {
  TAG_QUERY_MAX_RUNES,
  countRunes,
  isUnicodeWhiteSpace,
  normalize,
  toLowerRuneGo,
  trimUnicodeWhiteSpace,
} from './normalize';

export interface ParsedTagFilterInput {
  readonly token: string;
  readonly searchable: boolean;
}

/**
 * Extracts the first whitespace-delimited tag query token after the leading `#`
 * in `#…` tag-filter mode, and checks whether its rune count is within the 50-rune limit.
 */
export function parseTagFilterInput(rawInput: string): ParsedTagFilterInput {
  let i = 0;
  const len = rawInput.length;
  while (i < len) {
    const cp = rawInput.codePointAt(i);
    if (cp === undefined || !isUnicodeWhiteSpace(cp)) {
      break;
    }
    i += cp > 0xffff ? 2 : 1;
  }

  // Skip the leading '#'
  if (i < len && rawInput.codePointAt(i) === 0x23 /* '#' */) {
    i += 1;
  }

  const afterHash = trimUnicodeWhiteSpace(rawInput.slice(i));
  if (afterHash === '') {
    return { token: '', searchable: true };
  }

  let end = 0;
  while (end < afterHash.length) {
    const cp = afterHash.codePointAt(end);
    if (cp === undefined || isUnicodeWhiteSpace(cp)) {
      break;
    }
    end += cp > 0xffff ? 2 : 1;
  }

  const token = afterHash.slice(0, end);
  const searchable = countRunes(token, TAG_QUERY_MAX_RUNES) <= TAG_QUERY_MAX_RUNES;
  return { token, searchable };
}

/**
 * Normalizes a string for client-side prefix matching (NFC -> Go-compatible lowercase -> NFC ->
 * collapse whitespace -> strip edge punctuation). Returns `''` if empty/invalid.
 */
export function normalizeForPrefixMatch(value: string): string {
  const res = normalize(value);
  return res.ok ? res.normalized : '';
}

/**
 * Filters a list of cached `Tag` objects client-side by normalized prefix (`#…` mode, plan §2.11).
 * Never sends a network request.
 */
export function filterCachedTagsByPrefix(
  tags: readonly Tag[],
  tagToken: string,
): Tag[] {
  const trimmed = trimUnicodeWhiteSpace(tagToken);
  if (trimmed === '') {
    return [...tags];
  }
  const target = normalizeForPrefixMatch(trimmed);
  if (target === '') {
    return [];
  }
  return tags.filter((tag) => {
    const normTag = normalizeForPrefixMatch(tag.display);
    return normTag !== '' && normTag.startsWith(target);
  });
}

export interface PrefixMarkSegments {
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

/**
 * Splits `text` into `{ before, match, after }` for `<mark>` rendering when `query` matches
 * `text` case-insensitively after NFC normalization.
 */
export function splitMarkedPrefix(text: string, query: string): PrefixMarkSegments {
  const target = normalizeForPrefixMatch(query);
  if (target === '' || text === '') {
    return { before: '', match: '', after: text };
  }

  const nfcText = text.normalize('NFC');
  const codeUnitOffsets: number[] = [];
  let lowered = '';
  let offset = 0;
  for (const ch of nfcText) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) {
      const lowCh = toLowerRuneGo(cp);
      for (let k = 0; k < lowCh.length; k += 1) {
        codeUnitOffsets.push(offset);
      }
      lowered += lowCh;
    }
    offset += ch.length;
  }
  codeUnitOffsets.push(nfcText.length);

  const matchIdx = lowered.indexOf(target);
  if (matchIdx < 0) {
    return { before: '', match: '', after: text };
  }

  const startOffset = codeUnitOffsets[matchIdx] ?? 0;
  const endIdx = Math.min(matchIdx + target.length, codeUnitOffsets.length - 1);
  const endOffset = codeUnitOffsets[endIdx] ?? nfcText.length;

  return {
    before: nfcText.slice(0, startOffset),
    match: nfcText.slice(startOffset, endOffset),
    after: nfcText.slice(endOffset),
  };
}
