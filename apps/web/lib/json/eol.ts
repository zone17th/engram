export type EolKind = 'lf' | 'crlf' | 'mixed' | 'cr';

export type MajorityEolKind = 'lf' | 'crlf' | 'cr';

export interface EolAnalysis {
  /**
   * Overall EOL classification of the document:
   * - `'cr'`: at least one lone `\r` (not immediately followed by `\n`) is present.
   * - `'mixed'`: both `\n` (not preceded by `\r`) and `\r\n` are present, with no lone `\r`.
   * - `'crlf'`: one or more `\r\n` sequences and no bare `\n` or lone `\r`.
   * - `'lf'`: only `\n` sequences, or no line breaks at all.
   */
  kind: EolKind;
  /**
   * The majority EOL kind (`'lf'`, `'crlf'`, or `'cr'`) used when inserting new lines in
   * `edit.ts` or normalizing mixed/CR documents on raw textarea save (plan §2.10 rule 2 & 5):
   * - Compares `lfCount`, `crlfCount`, and `crCount`.
   * - Tie-breaker among the tied maximum counts: kind of the first line break in the document;
   *   if the first line break is not among the tied maximum, falls back in `'crlf' -> 'lf' -> 'cr'` order.
   * - If there are no line breaks at all (empty/single-line), defaults to `'lf'`.
   */
  majority: MajorityEolKind;
  /** Number of bare `\n` line breaks (not preceded by `\r`). */
  lfCount: number;
  /** Number of `\r\n` line breaks. */
  crlfCount: number;
  /** Number of lone `\r` line breaks (not followed by `\n`). */
  crCount: number;
  /** Total number of line breaks (`lfCount + crlfCount + crCount`). */
  totalBreaks: number;
  /** The literal EOL sequence corresponding to `majority` (`"\n"`, `"\r\n"`, or `"\r"`). */
  majoritySeq: '\n' | '\r\n' | '\r';
  /**
   * True when `kind === 'mixed' || kind === 'cr'`.
   * Saving from a `<textarea>` in this state requires warning the user before converting
   * line endings to `majority` (plan §2.10 rule 2).
   */
  requiresConversionWarning: boolean;
}

export interface TextareaEolSavePlan {
  /**
   * False when `normalizeToLf(textareaValue) === normalizeToLf(originalSource)`.
   * When `changed === false`, the caller MUST keep `originalSource` verbatim and MUST NOT
   * send a `PUT` request (plan §2.10 rule 2, P04-A6).
   */
  changed: boolean;
  /**
   * The resulting document string with EOLs applied:
   * - If `changed === false`, identical to `originalSource` (byte-exact).
   * - If `changed === true`, `textareaValue` normalized to the `majority` EOL of `originalSource`
   *   (pure `'lf'` stays `\n`, pure `'crlf'` converts `\n` -> `\r\n`, `'mixed'`/`'cr'` converts
   *   to `majoritySeq`).
   */
  text: string;
  /** EOL analysis of `originalSource`. */
  sourceEol: EolAnalysis;
  /**
   * True when `changed === true` and `sourceEol.requiresConversionWarning === true`
   * (`kind === 'mixed' || kind === 'cr'`). The UI must show the mixed-EOL confirmation
   * before persisting `text`.
   */
  requiresWarning: boolean;
  /** The target EOL kind applied when `changed === true`. */
  targetEol: MajorityEolKind;
}

/**
 * Analyzes all line endings in `text` in a single linear pass.
 */
export function detectEol(text: string): EolAnalysis {
  let lfCount = 0;
  let crlfCount = 0;
  let crCount = 0;
  let firstBreak: 'lf' | 'crlf' | 'cr' | null = null;

  const len = text.length;
  for (let i = 0; i < len; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x0d /* \r */) {
      if (i + 1 < len && text.charCodeAt(i + 1) === 0x0a /* \n */) {
        crlfCount++;
        if (firstBreak === null) {
          firstBreak = 'crlf';
        }
        i++; // consume \n of \r\n
      } else {
        crCount++;
        if (firstBreak === null) {
          firstBreak = 'cr';
        }
      }
    } else if (ch === 0x0a /* \n */) {
      lfCount++;
      if (firstBreak === null) {
        firstBreak = 'lf';
      }
    }
  }

  let kind: EolKind;
  if (crCount > 0) {
    kind = 'cr';
  } else if (lfCount > 0 && crlfCount > 0) {
    kind = 'mixed';
  } else if (crlfCount > 0) {
    kind = 'crlf';
  } else {
    kind = 'lf';
  }

  // Majority EOL over {LF, CRLF, CR}, tie = first break's kind; if first break is not among the
  // tied maximum counts, fall back in `crlf -> lf -> cr` order; pure-CR doc stays CR (advisor-dec-126).
  const maxCount = Math.max(lfCount, crlfCount, crCount);
  let majority: MajorityEolKind;
  if (maxCount === 0) {
    majority = 'lf';
  } else {
    const lfTied = lfCount === maxCount;
    const crlfTied = crlfCount === maxCount;
    const crTied = crCount === maxCount;
    const tiedCount = (lfTied ? 1 : 0) + (crlfTied ? 1 : 0) + (crTied ? 1 : 0);
    if (tiedCount === 1) {
      majority = crlfTied ? 'crlf' : crTied ? 'cr' : 'lf';
    } else if (
      (firstBreak === 'crlf' && crlfTied) ||
      (firstBreak === 'cr' && crTied) ||
      (firstBreak === 'lf' && lfTied)
    ) {
      majority = firstBreak;
    } else {
      majority = crlfTied ? 'crlf' : lfTied ? 'lf' : 'cr';
    }
  }

  const majoritySeq = majority === 'crlf' ? '\r\n' : majority === 'cr' ? '\r' : '\n';
  const requiresConversionWarning = kind === 'mixed' || kind === 'cr';

  return {
    kind,
    majority,
    lfCount,
    crlfCount,
    crCount,
    totalBreaks: lfCount + crlfCount + crCount,
    majoritySeq,
    requiresConversionWarning,
  };
}

/**
 * Normalizes all line breaks (`\r\n`, `\r`, `\n`) in `text` to `\n`, matching HTML
 * `<textarea>.value` normalization rules.
 */
export function normalizeEolToLf(text: string): string {
  // Fast check: if no \r exists, return string as-is without allocating.
  if (text.indexOf('\r') === -1) {
    return text;
  }
  return text.replace(/\r\n|\r/g, '\n');
}

/**
 * Converts all line breaks in `text` to the specified `target` EOL (`'lf'`, `'crlf'`, or `'cr'`).
 */
export function convertEol(text: string, target: MajorityEolKind): string {
  const lfText = normalizeEolToLf(text);
  if (target === 'lf') {
    return lfText;
  }
  if (target === 'cr') {
    return lfText.replace(/\n/g, '\r');
  }
  return lfText.replace(/\n/g, '\r\n');
}

/**
 * Re-applies the original source's EOL convention to a `<textarea>` value per plan §2.10
 * rules 1, 2, and 5:
 * - HTML `<textarea>` always normalizes `\r\n` and `\r` to `\n` in `.value`.
 * - If `normalizeEolToLf(textareaValue) === normalizeEolToLf(originalSource)`, the user made
 *   no content change: returns `{ changed: false, text: originalSource, ... }` so the caller
 *   keeps `originalSource` byte-identical and skips `PUT`.
 * - Otherwise, converts `\n` in `textareaValue` to `sourceEol.majority` (`\n` for `'lf'`,
 *   `\r\n` for `'crlf'`) and flags `requiresWarning = true` when `sourceEol.kind` was
 *   `'mixed'` or `'cr'`.
 */
export function applyTextareaEol(
  originalSource: string,
  textareaValue: string,
  precomputedSourceEol?: EolAnalysis,
): TextareaEolSavePlan {
  const sourceEol = precomputedSourceEol ?? detectEol(originalSource);
  const normalizedOriginal = normalizeEolToLf(originalSource);
  const normalizedInput = normalizeEolToLf(textareaValue);

  if (normalizedInput === normalizedOriginal) {
    return {
      changed: false,
      text: originalSource,
      sourceEol,
      requiresWarning: false,
      targetEol: sourceEol.majority,
    };
  }

  const targetEol = sourceEol.majority;
  const text = convertEol(normalizedInput, targetEol);

  return {
    changed: true,
    text,
    sourceEol,
    requiresWarning: sourceEol.requiresConversionWarning,
    targetEol,
  };
}
