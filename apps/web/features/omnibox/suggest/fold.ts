/**
 * Folded prefix highlighting (`prefix_folded`, plan P05 mục 2.2, SPEC §6.8):
 * - NFD decomposition
 * - Strip non-spacing marks `\p{Mn}`
 * - Map `đ` (U+0111) / `Đ` (U+0110) -> `d`
 * - Compatible with `splitMarkedPrefix` in `features/omnibox/search-helpers.ts`
 *   (returns `{ before, match, after }` plain text segments for text-node rendering, never HTML).
 */

import { isUnicodeWhiteSpace, toLowerRuneGo } from '../normalize';
import {
  normalizeForPrefixMatch,
  splitMarkedPrefix,
  type PrefixMarkSegments,
} from '../search-helpers';
import type { SuggestMatch } from '@/lib/api/search';

export type { PrefixMarkSegments };

const COMBINING_MARK_RE = /\p{Mn}/gu;

/**
 * Folds a single string using NFD decomposition, stripping `\p{Mn}`, mapping `đ/Đ -> d`,
 * and applying Go-compatible lowercasing.
 */
export function foldDiacritics(value: string): string {
  if (value === '') return '';
  const nfd = value.normalize('NFD').replace(COMBINING_MARK_RE, '');
  let result = '';
  for (const ch of nfd) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 0x0111 /* đ */ || cp === 0x0110 /* Đ */) {
      result += 'd';
    } else {
      result += toLowerRuneGo(cp);
    }
  }
  return result;
}

/**
 * Normalizes and folds a query string for `prefix_folded` matching.
 */
export function normalizeForFoldedPrefixMatch(query: string): string {
  const norm = normalizeForPrefixMatch(query);
  if (norm === '') return '';
  return foldDiacritics(norm);
}

/**
 * Splits `text` into `{ before, match, after }` when `query` matches `text` after NFD + `\p{Mn}` strip
 * + `đ/Đ -> d` folding (plan P05 mục 2.2).
 *
 * Preserves original diacritics and casing in the returned `before`, `match`, and `after` slices
 * of `text.normalize('NFC')`, and never includes trailing combining marks in `after` when a base
 * character is part of `match`.
 */
export function splitMarkedFoldedPrefix(
  text: string,
  query: string,
): PrefixMarkSegments {
  const target = normalizeForFoldedPrefixMatch(query);
  if (target === '' || text === '') {
    return { before: '', match: '', after: text };
  }

  const nfcText = text.normalize('NFC');
  // Map each code unit in `folded` back to its [startOffset, endOffset] in `nfcText`.
  // Also collapse contiguous whitespace runs in `nfcText` to a single `' '` so queries
  // whose internal whitespace was collapsed by `normalizeForPrefixMatch` align with `text`.
  const unitStartOffsets: number[] = [];
  const unitEndOffsets: number[] = [];
  let folded = '';

  let offset = 0;
  let inWhitespace = false;
  let wsStartOffset = 0;

  for (const ch of nfcText) {
    const cp = ch.codePointAt(0)!;
    const nextOffset = offset + ch.length;

    if (isUnicodeWhiteSpace(cp)) {
      if (!inWhitespace) {
        inWhitespace = true;
        wsStartOffset = offset;
      }
      offset = nextOffset;
      continue;
    }

    if (inWhitespace) {
      folded += ' ';
      unitStartOffsets.push(wsStartOffset);
      unitEndOffsets.push(offset);
      inWhitespace = false;
    }

    // Decompose this NFC code point (or character), strip combining marks, map đ/Đ -> d.
    const chFolded = foldDiacritics(ch);
    for (let k = 0; k < chFolded.length; k += 1) {
      unitStartOffsets.push(offset);
      unitEndOffsets.push(nextOffset);
    }
    folded += chFolded;
    offset = nextOffset;
  }

  if (inWhitespace) {
    folded += ' ';
    unitStartOffsets.push(wsStartOffset);
    unitEndOffsets.push(offset);
  }

  const matchIdx = folded.indexOf(target);
  if (matchIdx < 0) {
    return { before: '', match: '', after: text };
  }

  const lastUnitIdx = matchIdx + target.length - 1;
  const startOffset = unitStartOffsets[matchIdx] ?? 0;
  const endOffset = unitEndOffsets[lastUnitIdx] ?? nfcText.length;

  return {
    before: nfcText.slice(0, startOffset),
    match: nfcText.slice(startOffset, endOffset),
    after: nfcText.slice(endOffset),
  };
}

/**
 * Dispatches highlight segmentation by `SuggestMatch` channel (SPEC §6.8):
 * - `'prefix'`: `splitMarkedPrefix`
 * - `'prefix_folded'`: `splitMarkedFoldedPrefix`
 * - `'fuzzy'` | `'semantic'`: no `<mark>` (`match: ''`, `after: text`)
 */
export function splitHighlightByMatch(
  text: string,
  query: string,
  match: SuggestMatch,
): PrefixMarkSegments {
  if (match === 'prefix') {
    return splitMarkedPrefix(text, query);
  }
  if (match === 'prefix_folded') {
    return splitMarkedFoldedPrefix(text, query);
  }
  return { before: '', match: '', after: text };
}
