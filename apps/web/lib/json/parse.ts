import { isWellFormedUtf16 } from './utf8';

/**
 * UTF-16 code-unit span `[start, end)` into the current document string.
 */
export interface JsonSpan {
  readonly start: number;
  readonly end: number;
}

export type JsonErrorCode =
  | 'EMPTY_DOCUMENT'
  | 'UNEXPECTED_EOF'
  | 'UNEXPECTED_TOKEN'
  | 'TRAILING_COMMA'
  | 'TRAILING_CONTENT'
  | 'COMMENT_NOT_ALLOWED'
  | 'BOM_NOT_WHITESPACE'
  | 'EXPECTED_PROPERTY_KEY'
  | 'EXPECTED_COLON'
  | 'EXPECTED_COMMA_OR_END'
  | 'UNTERMINATED_STRING'
  | 'UNESCAPED_CONTROL_CHAR'
  | 'INVALID_ESCAPE'
  | 'INVALID_UNICODE_ESCAPE'
  | 'INVALID_NUMBER';

/**
 * Structured error returned by the strict RFC 8259 parser.
 *
 * Line and column convention (1-based UTF-16 code units):
 * - `offset` is the 0-based UTF-16 code-unit index in `source`.
 * - `line` starts at 1 and increments on `\r\n` (counted as ONE line break), bare `\n`,
 *   or lone `\r` (not followed by `\n`). If `offset` points at the `\n` of a `\r\n` pair,
 *   it remains on the `\r`'s line and only advances to the next line at `offset + 1`.
 * - `column` starts at 1 after each line break and increments by 1 per UTF-16 code unit,
 *   so an astral character (surrogate pair, 2 UTF-16 code units) advances `column` by 2.
 */
export interface JsonParseError {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly code: JsonErrorCode;
  readonly message: string;
}

export const JSON_PARSE_STATIC_MESSAGES: readonly string[] = [
  'U+FEFF (BOM) is not valid RFC 8259 whitespace',
  'Comments are not permitted in RFC 8259 JSON',
  'Unescaped control character in JSON string',
  'Unterminated escape in JSON string',
  'Incomplete \\uXXXX escape sequence in string',
  'Invalid hex digit in \\uXXXX escape sequence',
  'Invalid escape sequence in JSON string',
  'Unterminated JSON string literal',
  'Unexpected end of input after minus sign',
  'Leading zeros are not allowed in RFC 8259 numbers',
  'Invalid number literal',
  'Trailing decimal point in number literal',
  'Decimal point must be followed by at least one digit',
  'Incomplete exponent in number literal',
  'Exponent must contain at least one digit',
  'JSON document is empty',
  'Unexpected end of input while expecting a JSON value',
  'Malformed JSON number token',
  'Unexpected token while expecting a JSON value',
  'Unterminated JSON array',
  'Unexpected comma at start of array',
  'Unexpected end of input after comma in array',
  'Trailing comma is not permitted in RFC 8259 array',
  'Expected "," or "]" after array element',
  'Unterminated JSON object',
  'Unexpected comma at start of object',
  'Unexpected end of input while expecting object key',
  'Expected double-quoted string as object property key',
  'Unexpected end of input while expecting ":"',
  'Expected ":" after object property key',
  'Unexpected end of input after comma in object',
  'Trailing comma is not permitted in RFC 8259 object',
  'Expected "," or "}" after object property value',
  'Unexpected trailing content after root JSON value',
];

export interface JsonStringFlags {
  readonly hasLoneSurrogate: boolean;
  readonly hasCarriageReturn: boolean;
  readonly hasLineFeed: boolean;
}

export interface JsonStringNode extends JsonStringFlags {
  readonly id: number;
  readonly kind: 'string';
  readonly span: JsonSpan;
  readonly raw: string;
  readonly value: string;
}

export interface JsonNumberNode {
  readonly id: number;
  readonly kind: 'number';
  readonly span: JsonSpan;
  /** Verbatim source lexeme (`9007199254740993`, `1e400`, `-0`, `0.10`, etc.). */
  readonly lexeme: string;
}

export interface JsonBooleanNode {
  readonly id: number;
  readonly kind: 'boolean';
  readonly span: JsonSpan;
  readonly value: boolean;
  readonly raw: 'true' | 'false';
}

export interface JsonNullNode {
  readonly id: number;
  readonly kind: 'null';
  readonly span: JsonSpan;
  readonly value: null;
  readonly raw: 'null';
}

export interface JsonPropertyNode {
  readonly id: number;
  readonly kind: 'property';
  /** Span from `keyNode.span.start` to `valueNode.span.end`. */
  readonly span: JsonSpan;
  readonly keyNode: JsonStringNode;
  /** Decoded property key string. */
  readonly key: string;
  /**
   * 0-based occurrence index of this `key` within its parent object (`0` for the first
   * occurrence of `"a"`, `1` for the second `"a"`, etc.).
   */
  readonly occurrenceIndex: number;
  /** 0-based position of this property inside `parent.properties`. */
  readonly propertyIndex: number;
  /** UTF-16 offset of the `:` separating key and value. */
  readonly colonOffset: number;
  readonly valueNode: JsonNode;
}

export interface JsonObjectNode {
  readonly id: number;
  readonly kind: 'object';
  readonly span: JsonSpan;
  readonly properties: readonly JsonPropertyNode[];
  /** True when at least one key appears more than once in `properties`. */
  readonly hasDuplicateKeys: boolean;
}

export interface JsonArrayNode {
  readonly id: number;
  readonly kind: 'array';
  readonly span: JsonSpan;
  readonly elements: readonly JsonNode[];
}

export type JsonPrimitiveNode =
  | JsonStringNode
  | JsonNumberNode
  | JsonBooleanNode
  | JsonNullNode;

export type JsonNode =
  | JsonObjectNode
  | JsonArrayNode
  | JsonStringNode
  | JsonNumberNode
  | JsonBooleanNode
  | JsonNullNode;

export interface JsonDocument {
  readonly source: string;
  readonly revision: number;
  readonly root: JsonNode;
  readonly maxDepth: number;
  readonly nodeById: ReadonlyMap<number, JsonNode>;
  readonly propertyById: ReadonlyMap<number, JsonPropertyNode>;
  readonly parentById: ReadonlyMap<number, JsonObjectNode | JsonArrayNode | null>;
}

export interface JsonParseSuccess {
  readonly ok: true;
  readonly document: JsonDocument;
}

export interface JsonParseFailure {
  readonly ok: false;
  readonly error: JsonParseError;
}

export type JsonParseResult = JsonParseSuccess | JsonParseFailure;

/**
 * Computes 1-based `{ line, column }` in UTF-16 code units for a 0-based `offset` in `source`.
 *
 * Line break rules:
 * - `\r\n` counts as ONE line break (line increments after `\n`).
 * - Bare `\n` counts as ONE line break.
 * - Lone `\r` (not followed by `\n`) also counts as ONE line break.
 * - Astral characters (UTF-16 surrogate pairs) occupy 2 UTF-16 code units and therefore
 *   advance `column` by 2.
 */
export function offsetToLineColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lineStart = 0;

  for (let i = 0; i < clamped; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 0x0d /* \r */) {
      if (i + 1 < source.length && source.charCodeAt(i + 1) === 0x0a /* \n */) {
        if (i + 1 < clamped) {
          i++; // consume \n of \r\n
          line++;
          lineStart = i + 1;
        }
        // If clamped === i + 1 (pointing directly at \n of \r\n), stay on current line.
      } else {
        line++;
        lineStart = i + 1;
      }
    } else if (ch === 0x0a /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }

  return {
    line,
    column: clamped - lineStart + 1,
  };
}

/**
 * Converts a 1-based `{ line, column }` (in UTF-16 code units) back into a 0-based UTF-16
 * code-unit offset in `source` (useful for raw editor "Go to error" `setSelectionRange`).
 */
export function lineColumnToOffset(source: string, line: number, column: number): number {
  const targetLine = Math.max(1, line);
  const targetCol = Math.max(1, column);
  let currentLine = 1;
  let i = 0;
  const len = source.length;

  while (i < len && currentLine < targetLine) {
    const ch = source.charCodeAt(i);
    if (ch === 0x0d /* \r */) {
      if (i + 1 < len && source.charCodeAt(i + 1) === 0x0a /* \n */) {
        i += 2;
      } else {
        i++;
      }
      currentLine++;
    } else if (ch === 0x0a /* \n */) {
      i++;
      currentLine++;
    } else {
      i++;
    }
  }

  // Clamp within current line (or end of source)
  let lineEnd = i;
  while (lineEnd < len) {
    const ch = source.charCodeAt(lineEnd);
    if (ch === 0x0d || ch === 0x0a) {
      break;
    }
    lineEnd++;
  }

  return Math.min(i + (targetCol - 1), lineEnd);
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  return (code & ~0x20) - 0x37;
}

/**
 * Validates whether `lexeme` strictly matches RFC 8259 §6 `number` grammar:
 * `number = [ minus ] int [ frac ] [ exp ]`
 * Rejects leading/trailing whitespace, leading `+`, leading zeroes (`01`, `-01`),
 * bare `.5`, trailing `1.`, incomplete exponent `1e`/`1e+`, `NaN`, `Infinity`, etc.
 */
export function isValidJsonNumberLexeme(lexeme: string): boolean {
  const len = lexeme.length;
  if (len === 0) {
    return false;
  }
  let pos = 0;
  if (lexeme.charCodeAt(pos) === 0x2d /* - */) {
    pos++;
    if (pos >= len) {
      return false;
    }
  }

  const first = lexeme.charCodeAt(pos);
  if (first === 0x30 /* 0 */) {
    pos++;
    if (pos < len) {
      const next = lexeme.charCodeAt(pos);
      if (next >= 0x30 && next <= 0x39) {
        return false; // leading zero like 01
      }
    }
  } else if (first >= 0x31 && first <= 0x39) {
    pos++;
    while (pos < len) {
      const d = lexeme.charCodeAt(pos);
      if (d >= 0x30 && d <= 0x39) {
        pos++;
      } else {
        break;
      }
    }
  } else {
    return false;
  }

  if (pos < len && lexeme.charCodeAt(pos) === 0x2e /* . */) {
    pos++;
    if (pos >= len) {
      return false; // trailing dot like 1.
    }
    const fracFirst = lexeme.charCodeAt(pos);
    if (fracFirst < 0x30 || fracFirst > 0x39) {
      return false;
    }
    pos++;
    while (pos < len) {
      const d = lexeme.charCodeAt(pos);
      if (d >= 0x30 && d <= 0x39) {
        pos++;
      } else {
        break;
      }
    }
  }

  if (pos < len) {
    const expChar = lexeme.charCodeAt(pos);
    if (expChar === 0x65 /* e */ || expChar === 0x45 /* E */) {
      pos++;
      if (pos >= len) {
        return false;
      }
      const sign = lexeme.charCodeAt(pos);
      if (sign === 0x2b /* + */ || sign === 0x2d /* - */) {
        pos++;
        if (pos >= len) {
          return false;
        }
      }
      const expFirst = lexeme.charCodeAt(pos);
      if (expFirst < 0x30 || expFirst > 0x39) {
        return false;
      }
      pos++;
      while (pos < len) {
        const d = lexeme.charCodeAt(pos);
        if (d >= 0x30 && d <= 0x39) {
          pos++;
        } else {
          break;
        }
      }
    }
  }

  return pos === len;
}

type StackFrame =
  | {
      kind: 'object';
      id: number;
      start: number;
      state: 'START_OR_END' | 'KEY' | 'COLON' | 'VALUE' | 'COMMA_OR_END';
      properties: JsonPropertyNode[];
      keyCounts: Map<string, number>;
      hasDuplicateKeys: boolean;
      pendingKeyNode: JsonStringNode | null;
      pendingColonOffset: number;
    }
  | {
      kind: 'array';
      id: number;
      start: number;
      state: 'VALUE_OR_END' | 'VALUE' | 'COMMA_OR_END';
      elements: JsonNode[];
    };

let revisionCounter = 1;

/**
 * Allocates the next monotonically increasing document revision ID.
 * Shared across fresh parses, splice edits, and formatting so references from an
 * edited document can never collide with a subsequent fresh parse.
 */
export function nextRevision(): number {
  return revisionCounter++;
}

/**
 * Iterative (explicit-stack, zero-recursion) strict RFC 8259 JSON parser with UTF-16 spans.
 *
 * Guarantees:
 * - Zero recursion in parsing, tree construction, and parent map indexing (safe at depth 10,000+).
 * - Rejects comments (`//`, `/*`), trailing commas, trailing content, invalid numbers
 *   (`01`, `.5`, `+1`, `1.`, `1e`), bad escapes, unescaped U+0000..U+001F in strings, and
 *   U+FEFF as whitespace.
 * - Preserves number lexemes verbatim without `Number(...)` conversion.
 * - Preserves duplicate object keys in source order with per-key `occurrenceIndex`.
 * - Decodes string escapes while flagging lone surrogates (`hasLoneSurrogate`), `\r`
 *   (`hasCarriageReturn`), and `\n` (`hasLineFeed`) for table model editability rules.
 */
export function parseJsonStrict(
  source: string,
  options?: { revision?: number },
): JsonParseResult {
  const revision = options?.revision ?? nextRevision();
  if (revision >= revisionCounter) {
    revisionCounter = revision + 1;
  }
  const len = source.length;
  let pos = 0;
  let nextId = 1;
  let maxDepth = 0;

  const nodeById = new Map<number, JsonNode>();
  const propertyById = new Map<number, JsonPropertyNode>();
  const parentById = new Map<number, JsonObjectNode | JsonArrayNode | null>();

  function makeError(offset: number, code: JsonErrorCode, message: string): JsonParseFailure {
    const { line, column } = offsetToLineColumn(source, offset);
    return {
      ok: false,
      error: {
        offset,
        line,
        column,
        code,
        message,
      },
    };
  }

  function skipWhitespace(): JsonParseFailure | null {
    while (pos < len) {
      const ch = source.charCodeAt(pos);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        pos++;
      } else if (ch === 0xfeff) {
        return makeError(
          pos,
          'BOM_NOT_WHITESPACE',
          'U+FEFF (BOM) is not valid RFC 8259 whitespace',
        );
      } else if (ch === 0x2f /* / */) {
        const next = pos + 1 < len ? source.charCodeAt(pos + 1) : 0;
        if (next === 0x2f /* / */ || next === 0x2a /* * */) {
          return makeError(pos, 'COMMENT_NOT_ALLOWED', 'Comments are not permitted in RFC 8259 JSON');
        }
        break;
      } else {
        break;
      }
    }
    return null;
  }

  function parseStringLiteral(): { ok: true; node: JsonStringNode } | JsonParseFailure {
    const start = pos;
    pos++; // skip opening '"'
    let chunkStart = pos;
    let out = '';

    while (pos < len) {
      const ch = source.charCodeAt(pos);
      if (ch === 0x22 /* " */) {
        if (pos > chunkStart) {
          out += source.slice(chunkStart, pos);
        }
        pos++; // consume closing '"'
        const end = pos;
        const raw = source.slice(start, end);
        const hasLoneSurrogate = !isWellFormedUtf16(out);
        const hasCarriageReturn = out.indexOf('\r') !== -1;
        const hasLineFeed = out.indexOf('\n') !== -1;
        const node: JsonStringNode = {
          id: nextId++,
          kind: 'string',
          span: { start, end },
          raw,
          value: out,
          hasLoneSurrogate,
          hasCarriageReturn,
          hasLineFeed,
        };
        return { ok: true, node };
      }

      if (ch <= 0x1f) {
        return makeError(
          pos,
          'UNESCAPED_CONTROL_CHAR',
          'Unescaped control character in JSON string',
        );
      }

      if (ch === 0x5c /* \ */) {
        if (pos > chunkStart) {
          out += source.slice(chunkStart, pos);
        }
        const escapeStart = pos;
        pos++; // consume '\'
        if (pos >= len) {
          return makeError(start, 'UNTERMINATED_STRING', 'Unterminated escape in JSON string');
        }
        const esc = source.charCodeAt(pos++);
        switch (esc) {
          case 0x22: // "
            out += '"';
            break;
          case 0x5c: // \
            out += '\\';
            break;
          case 0x2f: // /
            out += '/';
            break;
          case 0x62: // b
            out += '\b';
            break;
          case 0x66: // f
            out += '\f';
            break;
          case 0x6e: // n
            out += '\n';
            break;
          case 0x72: // r
            out += '\r';
            break;
          case 0x74: // t
            out += '\t';
            break;
          case 0x75: {
            // \uXXXX
            if (pos + 4 > len) {
              return makeError(
                escapeStart,
                'INVALID_UNICODE_ESCAPE',
                'Incomplete \\uXXXX escape sequence in string',
              );
            }
            let codeUnit = 0;
            for (let i = 0; i < 4; i++) {
              const c = source.charCodeAt(pos + i);
              if (!isHexDigit(c)) {
                return makeError(
                  escapeStart,
                  'INVALID_UNICODE_ESCAPE',
                  'Invalid hex digit in \\uXXXX escape sequence',
                );
              }
              codeUnit = (codeUnit << 4) | hexValue(c);
            }
            pos += 4;
            out += String.fromCharCode(codeUnit);
            break;
          }
          default:
            return makeError(
              escapeStart,
              'INVALID_ESCAPE',
              'Invalid escape sequence in JSON string',
            );
        }
        chunkStart = pos;
      } else {
        pos++;
      }
    }

    return makeError(start, 'UNTERMINATED_STRING', 'Unterminated JSON string literal');
  }

  function parseNumberLiteral(): { ok: true; node: JsonNumberNode } | JsonParseFailure {
    const start = pos;
    if (source.charCodeAt(pos) === 0x2d /* - */) {
      pos++;
      if (pos >= len) {
        return makeError(start, 'INVALID_NUMBER', 'Unexpected end of input after minus sign');
      }
    }

    const firstDigit = source.charCodeAt(pos);
    if (firstDigit === 0x30 /* 0 */) {
      pos++;
      if (pos < len) {
        const next = source.charCodeAt(pos);
        if (next >= 0x30 && next <= 0x39) {
          return makeError(
            start,
            'INVALID_NUMBER',
            'Leading zeros are not allowed in RFC 8259 numbers',
          );
        }
      }
    } else if (firstDigit >= 0x31 && firstDigit <= 0x39) {
      pos++;
      while (pos < len) {
        const d = source.charCodeAt(pos);
        if (d >= 0x30 && d <= 0x39) {
          pos++;
        } else {
          break;
        }
      }
    } else {
      return makeError(start, 'INVALID_NUMBER', 'Invalid number literal');
    }

    if (pos < len && source.charCodeAt(pos) === 0x2e /* . */) {
      pos++;
      if (pos >= len) {
        return makeError(start, 'INVALID_NUMBER', 'Trailing decimal point in number literal');
      }
      const fracFirst = source.charCodeAt(pos);
      if (fracFirst < 0x30 || fracFirst > 0x39) {
        return makeError(
          start,
          'INVALID_NUMBER',
          'Decimal point must be followed by at least one digit',
        );
      }
      pos++;
      while (pos < len) {
        const d = source.charCodeAt(pos);
        if (d >= 0x30 && d <= 0x39) {
          pos++;
        } else {
          break;
        }
      }
    }

    if (pos < len) {
      const expChar = source.charCodeAt(pos);
      if (expChar === 0x65 /* e */ || expChar === 0x45 /* E */) {
        pos++;
        if (pos >= len) {
          return makeError(start, 'INVALID_NUMBER', 'Incomplete exponent in number literal');
        }
        const sign = source.charCodeAt(pos);
        if (sign === 0x2b /* + */ || sign === 0x2d /* - */) {
          pos++;
          if (pos >= len) {
            return makeError(start, 'INVALID_NUMBER', 'Incomplete exponent in number literal');
          }
        }
        const expFirst = source.charCodeAt(pos);
        if (expFirst < 0x30 || expFirst > 0x39) {
          return makeError(
            start,
            'INVALID_NUMBER',
            'Exponent must contain at least one digit',
          );
        }
        pos++;
        while (pos < len) {
          const d = source.charCodeAt(pos);
          if (d >= 0x30 && d <= 0x39) {
            pos++;
          } else {
            break;
          }
        }
      }
    }

    const end = pos;
    const lexeme = source.slice(start, end);
    const node: JsonNumberNode = {
      id: nextId++,
      kind: 'number',
      span: { start, end },
      lexeme,
    };
    return { ok: true, node };
  }

  const wsErr = skipWhitespace();
  if (wsErr) {
    return wsErr;
  }
  if (pos >= len) {
    return makeError(pos, 'EMPTY_DOCUMENT', 'JSON document is empty');
  }

  const stack: StackFrame[] = [];
  let rootNode: JsonNode | null = null;
  let expectingValue = true;

  function attachCompletedValue(node: JsonNode): JsonParseFailure | null {
    nodeById.set(node.id, node);
    if (stack.length === 0) {
      parentById.set(node.id, null);
      rootNode = node;
      expectingValue = false;
      return null;
    }

    const top = stack[stack.length - 1]!;
    if (top.kind === 'array') {
      top.elements.push(node);
      top.state = 'COMMA_OR_END';
      return null;
    }

    // top.kind === 'object'
    const keyNode = top.pendingKeyNode!;
    const key = keyNode.value;
    const prevCount = top.keyCounts.get(key) ?? 0;
    top.keyCounts.set(key, prevCount + 1);
    if (prevCount > 0) {
      top.hasDuplicateKeys = true;
    }
    const propNode: JsonPropertyNode = {
      id: nextId++,
      kind: 'property',
      span: { start: keyNode.span.start, end: node.span.end },
      keyNode,
      key,
      occurrenceIndex: prevCount,
      propertyIndex: top.properties.length,
      colonOffset: top.pendingColonOffset,
      valueNode: node,
    };
    propertyById.set(propNode.id, propNode);
    top.properties.push(propNode);
    top.pendingKeyNode = null;
    top.pendingColonOffset = -1;
    top.state = 'COMMA_OR_END';
    return null;
  }

  while (expectingValue || stack.length > 0) {
    if (expectingValue) {
      const ws = skipWhitespace();
      if (ws) {
        return ws;
      }
      if (pos >= len) {
        return makeError(pos, 'UNEXPECTED_EOF', 'Unexpected end of input while expecting a JSON value');
      }

      const ch = source.charCodeAt(pos);

      if (ch === 0x7b /* { */) {
        const frame: StackFrame = {
          kind: 'object',
          id: nextId++,
          start: pos,
          state: 'START_OR_END',
          properties: [],
          keyCounts: new Map<string, number>(),
          hasDuplicateKeys: false,
          pendingKeyNode: null,
          pendingColonOffset: -1,
        };
        pos++; // consume '{'
        stack.push(frame);
        if (stack.length > maxDepth) {
          maxDepth = stack.length;
        }
        expectingValue = false;
        continue;
      }

      if (ch === 0x5b /* [ */) {
        const frame: StackFrame = {
          kind: 'array',
          id: nextId++,
          start: pos,
          state: 'VALUE_OR_END',
          elements: [],
        };
        pos++; // consume '['
        stack.push(frame);
        if (stack.length > maxDepth) {
          maxDepth = stack.length;
        }
        expectingValue = false;
        continue;
      }

      if (ch === 0x22 /* " */) {
        const strRes = parseStringLiteral();
        if (!strRes.ok) {
          return strRes;
        }
        const err = attachCompletedValue(strRes.node);
        if (err) {
          return err;
        }
        expectingValue = false;
        continue;
      }

      if (ch === 0x2d /* - */ || (ch >= 0x30 && ch <= 0x39)) {
        const numRes = parseNumberLiteral();
        if (!numRes.ok) {
          return numRes;
        }
        const err = attachCompletedValue(numRes.node);
        if (err) {
          return err;
        }
        expectingValue = false;
        continue;
      }

      if (ch === 0x2e /* . */ || ch === 0x2b /* + */) {
        return makeError(pos, 'INVALID_NUMBER', 'Malformed JSON number token');
      }

      if (ch === 0x74 /* t */) {
        if (source.startsWith('true', pos)) {
          const start = pos;
          pos += 4;
          const node: JsonBooleanNode = {
            id: nextId++,
            kind: 'boolean',
            span: { start, end: pos },
            value: true,
            raw: 'true',
          };
          const err = attachCompletedValue(node);
          if (err) {
            return err;
          }
          expectingValue = false;
          continue;
        }
        return makeError(pos, 'UNEXPECTED_TOKEN', 'Unexpected token while expecting a JSON value');
      }

      if (ch === 0x66 /* f */) {
        if (source.startsWith('false', pos)) {
          const start = pos;
          pos += 5;
          const node: JsonBooleanNode = {
            id: nextId++,
            kind: 'boolean',
            span: { start, end: pos },
            value: false,
            raw: 'false',
          };
          const err = attachCompletedValue(node);
          if (err) {
            return err;
          }
          expectingValue = false;
          continue;
        }
        return makeError(pos, 'UNEXPECTED_TOKEN', 'Unexpected token while expecting a JSON value');
      }

      if (ch === 0x6e /* n */) {
        if (source.startsWith('null', pos)) {
          const start = pos;
          pos += 4;
          const node: JsonNullNode = {
            id: nextId++,
            kind: 'null',
            span: { start, end: pos },
            value: null,
            raw: 'null',
          };
          const err = attachCompletedValue(node);
          if (err) {
            return err;
          }
          expectingValue = false;
          continue;
        }
        return makeError(pos, 'UNEXPECTED_TOKEN', 'Unexpected token while expecting a JSON value');
      }

      return makeError(
        pos,
        'UNEXPECTED_TOKEN',
        'Unexpected token while expecting a JSON value',
      );
    }

    // Advance state machine of top container frame
    const top = stack[stack.length - 1]!;
    const ws = skipWhitespace();
    if (ws) {
      return ws;
    }

    if (top.kind === 'array') {
      if (top.state === 'VALUE_OR_END') {
        if (pos >= len) {
          return makeError(pos, 'UNEXPECTED_EOF', 'Unterminated JSON array');
        }
        const ch = source.charCodeAt(pos);
        if (ch === 0x5d /* ] */) {
          pos++; // consume ']'
          stack.pop();
          const arrNode: JsonArrayNode = {
            id: top.id,
            kind: 'array',
            span: { start: top.start, end: pos },
            elements: top.elements,
          };
          for (let i = 0; i < top.elements.length; i++) {
            parentById.set(top.elements[i]!.id, arrNode);
          }
          const err = attachCompletedValue(arrNode);
          if (err) {
            return err;
          }
          continue;
        }
        if (ch === 0x2c /* , */) {
          return makeError(pos, 'UNEXPECTED_TOKEN', 'Unexpected comma at start of array');
        }
        top.state = 'VALUE';
        expectingValue = true;
        continue;
      }

      if (top.state === 'COMMA_OR_END') {
        if (pos >= len) {
          return makeError(pos, 'UNEXPECTED_EOF', 'Unterminated JSON array');
        }
        const ch = source.charCodeAt(pos);
        if (ch === 0x2c /* , */) {
          const commaPos = pos;
          pos++; // consume ','
          const wsAfterComma = skipWhitespace();
          if (wsAfterComma) {
            return wsAfterComma;
          }
          if (pos >= len) {
            return makeError(pos, 'UNEXPECTED_EOF', 'Unexpected end of input after comma in array');
          }
          if (source.charCodeAt(pos) === 0x5d /* ] */) {
            return makeError(
              commaPos,
              'TRAILING_COMMA',
              'Trailing comma is not permitted in RFC 8259 array',
            );
          }
          top.state = 'VALUE';
          expectingValue = true;
          continue;
        }
        if (ch === 0x5d /* ] */) {
          pos++; // consume ']'
          stack.pop();
          const arrNode: JsonArrayNode = {
            id: top.id,
            kind: 'array',
            span: { start: top.start, end: pos },
            elements: top.elements,
          };
          for (let i = 0; i < top.elements.length; i++) {
            parentById.set(top.elements[i]!.id, arrNode);
          }
          const err = attachCompletedValue(arrNode);
          if (err) {
            return err;
          }
          continue;
        }
        return makeError(
          pos,
          'EXPECTED_COMMA_OR_END',
          'Expected "," or "]" after array element',
        );
      }
    } else {
      // top.kind === 'object'
      if (top.state === 'START_OR_END') {
        if (pos >= len) {
          return makeError(pos, 'UNEXPECTED_EOF', 'Unterminated JSON object');
        }
        const ch = source.charCodeAt(pos);
        if (ch === 0x7d /* } */) {
          pos++; // consume '}'
          stack.pop();
          const objNode: JsonObjectNode = {
            id: top.id,
            kind: 'object',
            span: { start: top.start, end: pos },
            properties: top.properties,
            hasDuplicateKeys: top.hasDuplicateKeys,
          };
          for (let i = 0; i < top.properties.length; i++) {
            parentById.set(top.properties[i]!.keyNode.id, objNode);
            parentById.set(top.properties[i]!.valueNode.id, objNode);
          }
          const err = attachCompletedValue(objNode);
          if (err) {
            return err;
          }
          continue;
        }
        if (ch === 0x2c /* , */) {
          return makeError(pos, 'UNEXPECTED_TOKEN', 'Unexpected comma at start of object');
        }
        top.state = 'KEY';
      }

      if (top.state === 'KEY') {
        if (pos >= len) {
          return makeError(pos, 'UNEXPECTED_EOF', 'Unexpected end of input while expecting object key');
        }
        if (source.charCodeAt(pos) !== 0x22 /* " */) {
          return makeError(
            pos,
            'EXPECTED_PROPERTY_KEY',
            'Expected double-quoted string as object property key',
          );
        }
        const keyRes = parseStringLiteral();
        if (!keyRes.ok) {
          return keyRes;
        }
        nodeById.set(keyRes.node.id, keyRes.node);
        top.pendingKeyNode = keyRes.node;
        top.state = 'COLON';
        continue;
      }

      if (top.state === 'COLON') {
        if (pos >= len) {
          return makeError(pos, 'UNEXPECTED_EOF', 'Unexpected end of input while expecting ":"');
        }
        if (source.charCodeAt(pos) !== 0x3a /* : */) {
          return makeError(pos, 'EXPECTED_COLON', 'Expected ":" after object property key');
        }
        top.pendingColonOffset = pos;
        pos++; // consume ':'
        top.state = 'VALUE';
        expectingValue = true;
        continue;
      }

      if (top.state === 'COMMA_OR_END') {
        if (pos >= len) {
          return makeError(pos, 'UNEXPECTED_EOF', 'Unterminated JSON object');
        }
        const ch = source.charCodeAt(pos);
        if (ch === 0x2c /* , */) {
          const commaPos = pos;
          pos++; // consume ','
          const wsAfterComma = skipWhitespace();
          if (wsAfterComma) {
            return wsAfterComma;
          }
          if (pos >= len) {
            return makeError(pos, 'UNEXPECTED_EOF', 'Unexpected end of input after comma in object');
          }
          if (source.charCodeAt(pos) === 0x7d /* } */) {
            return makeError(
              commaPos,
              'TRAILING_COMMA',
              'Trailing comma is not permitted in RFC 8259 object',
            );
          }
          top.state = 'KEY';
          continue;
        }
        if (ch === 0x7d /* } */) {
          pos++; // consume '}'
          stack.pop();
          const objNode: JsonObjectNode = {
            id: top.id,
            kind: 'object',
            span: { start: top.start, end: pos },
            properties: top.properties,
            hasDuplicateKeys: top.hasDuplicateKeys,
          };
          for (let i = 0; i < top.properties.length; i++) {
            parentById.set(top.properties[i]!.keyNode.id, objNode);
            parentById.set(top.properties[i]!.valueNode.id, objNode);
          }
          const err = attachCompletedValue(objNode);
          if (err) {
            return err;
          }
          continue;
        }
        return makeError(
          pos,
          'EXPECTED_COMMA_OR_END',
          'Expected "," or "}" after object property value',
        );
      }
    }
  }

  const trailingWsErr = skipWhitespace();
  if (trailingWsErr) {
    return trailingWsErr;
  }
  if (pos < len) {
    return makeError(pos, 'TRAILING_CONTENT', 'Unexpected trailing content after root JSON value');
  }
  if (!rootNode) {
    return makeError(0, 'EMPTY_DOCUMENT', 'JSON document is empty');
  }

  return {
    ok: true,
    document: {
      source,
      revision,
      root: rootNode,
      maxDepth,
      nodeById,
      propertyById,
      parentById,
    },
  };
}
