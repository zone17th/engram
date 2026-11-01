import { detectEol, type MajorityEolKind } from './eol';
import {
  parseJsonStrict,
  type JsonDocument,
  type JsonParseError,
} from './parse';
import { JSON_MAX_UTF8_BYTES, measureUtf8Bytes } from './utf8';

export const JSON_FORMAT_MAX_DEPTH = 1000;

export type JsonFormatErrorCode =
  | 'PARSE_ERROR'
  | 'DEPTH_LIMIT_EXCEEDED'
  | 'BYTE_LIMIT_EXCEEDED'
  | 'TOKEN_MISMATCH';

export class JsonFormatError extends Error {
  readonly code: JsonFormatErrorCode;
  readonly parseError?: JsonParseError;
  readonly byteLength?: number;
  readonly limitBytes?: number;
  readonly depth?: number;
  readonly maxDepth?: number;

  constructor(
    code: JsonFormatErrorCode,
    message: string,
    details?: {
      parseError?: JsonParseError;
      byteLength?: number;
      limitBytes?: number;
      depth?: number;
      maxDepth?: number;
    },
  ) {
    super(message);
    this.name = 'JsonFormatError';
    this.code = code;
    this.parseError = details?.parseError;
    this.byteLength = details?.byteLength;
    this.limitBytes = details?.limitBytes;
    this.depth = details?.depth;
    this.maxDepth = details?.maxDepth;
  }
}

export type JsonFormatResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly byteLength: number;
      readonly document: JsonDocument;
    }
  | {
      readonly ok: false;
      readonly error: JsonFormatError;
    };

export interface FormatJsonOptions {
  /** Maximum UTF-8 byte length of the formatted result (defaults to 262,144 B). */
  readonly maxBytes?: number;
  /** Maximum nesting depth allowed for formatting (defaults to 1,000). */
  readonly maxDepth?: number;
  /**
   * Line ending to use for formatted output.
   * Defaults to the input document's majority EOL (`detectEol(source).majority`).
   */
  readonly eol?: MajorityEolKind;
}

export interface JsonNonWhitespaceToken {
  readonly kind: '{' | '}' | '[' | ']' | ':' | ',' | 'string' | 'literal';
  readonly raw: string;
  readonly utf8Bytes: number;
}

/**
 * Extracts the exact sequence of non-whitespace JSON tokens from `source` in a single
 * linear pass without modifying any token's text.
 *
 * Used both to drive formatting and to verify that formatting only modifies whitespace
 * outside strings (`areNonWhitespaceTokensIdentical`).
 */
export function scanNonWhitespaceTokens(source: string): JsonNonWhitespaceToken[] {
  const tokens: JsonNonWhitespaceToken[] = [];
  const len = source.length;
  let pos = 0;

  while (pos < len) {
    const ch = source.charCodeAt(pos);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      pos++;
      continue;
    }

    if (
      ch === 0x7b /* { */ ||
      ch === 0x7d /* } */ ||
      ch === 0x5b /* [ */ ||
      ch === 0x5d /* ] */ ||
      ch === 0x3a /* : */ ||
      ch === 0x2c /* , */
    ) {
      const raw = source[pos]!;
      tokens.push({
        kind: raw as '{' | '}' | '[' | ']' | ':' | ',',
        raw,
        utf8Bytes: 1,
      });
      pos++;
      continue;
    }

    if (ch === 0x22 /* " */) {
      const start = pos;
      pos++; // skip opening '"'
      while (pos < len) {
        const c = source.charCodeAt(pos);
        if (c === 0x5c /* \ */) {
          pos += 2;
          continue;
        }
        if (c === 0x22 /* " */) {
          pos++;
          break;
        }
        pos++;
      }
      const raw = source.slice(start, pos);
      tokens.push({
        kind: 'string',
        raw,
        utf8Bytes: measureUtf8Bytes(raw),
      });
      continue;
    }

    // Number, boolean, or null literal
    const start = pos;
    while (pos < len) {
      const c = source.charCodeAt(pos);
      if (
        c === 0x20 ||
        c === 0x09 ||
        c === 0x0a ||
        c === 0x0d ||
        c === 0x7b ||
        c === 0x7d ||
        c === 0x5b ||
        c === 0x5d ||
        c === 0x3a ||
        c === 0x2c ||
        c === 0x22
      ) {
        break;
      }
      pos++;
    }
    const raw = source.slice(start, pos);
    tokens.push({
      kind: 'literal',
      raw,
      utf8Bytes: raw.length, // numbers, true, false, null are pure ASCII
    });
  }

  return tokens;
}

/**
 * Verifies that `beforeSource` and `afterSource` have the exact same sequence of
 * non-whitespace tokens (identical count, token kinds, and verbatim token strings).
 */
export function areNonWhitespaceTokensIdentical(
  beforeSource: string,
  afterSource: string,
): boolean {
  const beforeTokens = scanNonWhitespaceTokens(beforeSource);
  const afterTokens = scanNonWhitespaceTokens(afterSource);
  if (beforeTokens.length !== afterTokens.length) {
    return false;
  }
  for (let i = 0; i < beforeTokens.length; i++) {
    const a = beforeTokens[i]!;
    const b = afterTokens[i]!;
    if (a.kind !== b.kind || a.raw !== b.raw) {
      return false;
    }
  }
  return true;
}

/**
 * Iterative (explicit-stack, zero-recursion) JSON formatter per Task 12:
 * 1.Strictly parses `sourceOrDoc` first (if a string is passed).
 * 2. Rejects documents with nesting depth `> maxDepth` (default 1000) with
 *    `DEPTH_LIMIT_EXCEEDED` BEFORE allocating formatted output (e.g., 10,000-deep
 *    arrays would otherwise expand to ~100 MB of indentation).
 * 3. Precomputes the exact UTF-8 byte length of the formatted output from the token stream
 *    and rejects if `> maxBytes` (default 262,144 B) with `BYTE_LIMIT_EXCEEDED`
 *    before materializing the formatted string.
 * 4. Emits 2-space indented JSON modifying ONLY whitespace outside strings (preserving
 *    key order, duplicate keys, number lexemes, and string escapes verbatim).
 * 5. Verifies that the non-whitespace token sequence before and after formatting is identical.
 */
export function formatJsonStrict(
  sourceOrDoc: string | JsonDocument,
  options?: FormatJsonOptions,
): JsonFormatResult {
  const maxBytes = options?.maxBytes ?? JSON_MAX_UTF8_BYTES;
  const maxDepth = options?.maxDepth ?? JSON_FORMAT_MAX_DEPTH;

  let doc: JsonDocument;
  if (typeof sourceOrDoc === 'string') {
    const parsed = parseJsonStrict(sourceOrDoc);
    if (!parsed.ok) {
      return {
        ok: false,
      error: new JsonFormatError(
        'PARSE_ERROR',
        'Cannot format invalid JSON',
        { parseError: parsed.error },
      ),
      };
    }
    doc = parsed.document;
  } else {
    doc = sourceOrDoc;
  }

  if (doc.maxDepth > maxDepth) {
    return {
      ok: false,
      error: new JsonFormatError(
        'DEPTH_LIMIT_EXCEEDED',
        'JSON nesting depth exceeds maximum formatting depth',
        { depth: doc.maxDepth, maxDepth },
      ),
    };
  }

  const eolKind = options?.eol ?? detectEol(doc.source).majority;
  const eolSeq = eolKind === 'crlf' ? '\r\n' : eolKind === 'cr' ? '\r' : '\n';
  const eolBytes = eolSeq.length;

  const tokens = scanNonWhitespaceTokens(doc.source);

  // Pass 1: Precompute exact UTF-8 byte length (and check depth) without building strings.
  let predictedBytes = 0;
  let currentDepth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const nextTok = i + 1 < tokens.length ? tokens[i + 1]! : null;

    if (tok.kind === '{' || tok.kind === '[') {
      predictedBytes += 1; // '{' or '['
      if (nextTok && (nextTok.kind === '}' || nextTok.kind === ']')) {
        // Empty container `{}` or `[]`: next token is closing bracket on same line
        predictedBytes += 1;
        i++; // consume closing bracket
      } else {
        currentDepth++;
        if (currentDepth > maxDepth) {
          return {
            ok: false,
            error: new JsonFormatError(
              'DEPTH_LIMIT_EXCEEDED',
              'JSON nesting depth exceeds maximum formatting depth',
              { depth: currentDepth, maxDepth },
            ),
          };
        }
        predictedBytes += eolBytes + currentDepth * 2;
      }
    } else if (tok.kind === '}' || tok.kind === ']') {
      currentDepth--;
      predictedBytes += eolBytes + currentDepth * 2 + 1;
    } else if (tok.kind === ':') {
      predictedBytes += 2; // ': '
    } else if (tok.kind === ',') {
      predictedBytes += 1 + eolBytes + currentDepth * 2;
    } else {
      predictedBytes += tok.utf8Bytes;
    }

    if (predictedBytes > maxBytes) {
      return {
        ok: false,
        error: new JsonFormatError(
          'BYTE_LIMIT_EXCEEDED',
          'Formatted JSON exceeds maximum allowed UTF-8 byte length',
          { byteLength: predictedBytes, limitBytes: maxBytes },
        ),
      };
    }
  }

  // Pass 2: Materialize the formatted string using pre-cached indent strings.
  const indentCache: string[] = [''];
  function getIndent(depth: number): string {
    while (indentCache.length <= depth) {
      indentCache.push(`${indentCache[indentCache.length - 1]!}  `);
    }
    return indentCache[depth]!;
  }

  const parts: string[] = [];
  let buildDepth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const nextTok = i + 1 < tokens.length ? tokens[i + 1]! : null;

    if (tok.kind === '{' || tok.kind === '[') {
      if (nextTok && (nextTok.kind === '}' || nextTok.kind === ']')) {
        parts.push(tok.raw, nextTok.raw);
        i++;
      } else {
        buildDepth++;
        parts.push(tok.raw, eolSeq, getIndent(buildDepth));
      }
    } else if (tok.kind === '}' || tok.kind === ']') {
      buildDepth--;
      parts.push(eolSeq, getIndent(buildDepth), tok.raw);
    } else if (tok.kind === ':') {
      parts.push(': ');
    } else if (tok.kind === ',') {
      parts.push(',', eolSeq, getIndent(buildDepth));
    } else {
      parts.push(tok.raw);
    }
  }

  const formattedText = parts.join('');
  const actualBytes = measureUtf8Bytes(formattedText);
  if (actualBytes > maxBytes) {
    return {
      ok: false,
      error: new JsonFormatError(
        'BYTE_LIMIT_EXCEEDED',
        'Formatted JSON exceeds maximum allowed UTF-8 byte length',
        { byteLength: actualBytes, limitBytes: maxBytes },
      ),
    };
  }

  // Verify token sequence identity before/after
  const afterTokens = scanNonWhitespaceTokens(formattedText);
  if (afterTokens.length !== tokens.length) {
    return {
      ok: false,
      error: new JsonFormatError(
        'TOKEN_MISMATCH',
        'Formatted output token count differs from input',
      ),
    };
  }
  for (let i = 0; i < tokens.length; i++) {
    if (
      afterTokens[i]!.kind !== tokens[i]!.kind ||
      afterTokens[i]!.raw !== tokens[i]!.raw
    ) {
      return {
        ok: false,
        error: new JsonFormatError(
          'TOKEN_MISMATCH',
          'Formatted output token sequence differs from input',
        ),
      };
    }
  }

  const reparsed = parseJsonStrict(formattedText, { revision: doc.revision + 1 });
  if (!reparsed.ok) {
    return {
      ok: false,
      error: new JsonFormatError(
        'PARSE_ERROR',
        'Formatted JSON failed strict re-parse',
        { parseError: reparsed.error },
      ),
    };
  }

  return {
    ok: true,
    text: formattedText,
    byteLength: actualBytes,
    document: reparsed.document,
  };
}
