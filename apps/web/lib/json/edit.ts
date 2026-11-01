import { detectEol } from './eol';
import { JSON_TABLE_MAX_COLUMNS, type JsonNodeRef } from './model';
import {
  isValidJsonNumberLexeme,
  nextRevision,
  parseJsonStrict,
  type JsonArrayNode,
  type JsonDocument,
  type JsonNode,
  type JsonObjectNode,
  type JsonParseError,
  type JsonPropertyNode,
} from './parse';
import { isWellFormedUtf16 } from './utf8';

/**
 * UTF-16 code-unit splice edit `{ offset, length, content }` on a specific revision.
 */
export interface JsonTextEdit {
  readonly offset: number;
  readonly length: number;
  readonly content: string;
}

export type JsonEditErrorCode =
  | 'STALE_SPAN'
  | 'NODE_NOT_FOUND'
  | 'READ_ONLY_CELL'
  | 'INVALID_NUMBER_LEXEME'
  | 'INVALID_BOOLEAN_LEXEME'
  | 'INVALID_NULL_LEXEME'
  | 'INVALID_STRING_VALUE'
  | 'INVALID_VALUE_LEXEME'
  | 'INVALID_CONTAINER_KIND'
  | 'INVALID_INDEX'
  | 'KEY_EXISTS'
  | 'REPARSE_FAILED';

export class JsonEditError extends Error {
  readonly code: JsonEditErrorCode;
  readonly parseError?: JsonParseError;

  constructor(code: JsonEditErrorCode, message: string, parseError?: JsonParseError) {
    super(message);
    this.name = 'JsonEditError';
    this.code = code;
    this.parseError = parseError;
  }
}

export type JsonEditOutcome =
  | {
      readonly ok: true;
      /**
       * False when a commit did not change the displayed value (Task 12 rule 2:
       * no-op commit produces no splice and preserves source byte-for-byte).
       */
      readonly changed: boolean;
      readonly edit: JsonTextEdit | null;
      readonly source: string;
      readonly document: JsonDocument;
    }
  | {
      readonly ok: false;
      readonly error: JsonEditError;
    };

export type JsonCellValueKind = 'string' | 'number' | 'true' | 'false' | 'null';

/**
 * Minimal JSON string escaper per Task 12 rule 4:
 * Escapes ONLY `"`, `\`, and control characters U+0000..U+001F (`\b`, `\f`, `\n`, `\r`, `\t`,
 * or `\u00XX` lowercase hex). Leaves `/`, non-ASCII characters (`é`, `😀`, etc.), and all
 * other printable code points unescaped.
 */
export function escapeJsonStringMinimal(value: string): string {
  let out = '"';
  let chunkStart = 0;
  const len = value.length;

  for (let i = 0; i < len; i++) {
    const ch = value.charCodeAt(i);
    let escaped: string | null = null;
    if (ch === 0x22 /* " */) {
      escaped = '\\"';
    } else if (ch === 0x5c /* \ */) {
      escaped = '\\\\';
    } else if (ch <= 0x1f) {
      switch (ch) {
        case 0x08:
          escaped = '\\b';
          break;
        case 0x09:
          escaped = '\\t';
          break;
        case 0x0a:
          escaped = '\\n';
          break;
        case 0x0c:
          escaped = '\\f';
          break;
        case 0x0d:
          escaped = '\\r';
          break;
        default:
          escaped = `\\u${ch.toString(16).padStart(4, '0')}`;
          break;
      }
    }

    if (escaped !== null) {
      if (i > chunkStart) {
        out += value.slice(chunkStart, i);
      }
      out += escaped;
      chunkStart = i + 1;
    }
  }

  if (chunkStart < len) {
    out += value.slice(chunkStart);
  }
  out += '"';
  return out;
}

/**
 * Applies a `JsonTextEdit` splice to `source` and strictly reparses the resulting string
 * with a fresh monotonic revision allocated from `nextRevision()`.
 */
export function applyTextEditAndReparse(
  document: JsonDocument,
  edit: JsonTextEdit,
): JsonEditOutcome {
  const { source } = document;
  const nextSource =
    source.slice(0, edit.offset) + edit.content + source.slice(edit.offset + edit.length);

  const parsed = parseJsonStrict(nextSource, { revision: nextRevision() });
  if (!parsed.ok) {
    return {
      ok: false,
      error: new JsonEditError(
        'REPARSE_FAILED',
        'Edited JSON failed strict re-parse',
        parsed.error,
      ),
    };
  }

  return {
    ok: true,
    changed: true,
    edit,
    source: nextSource,
    document: parsed.document,
  };
}

function validateRefRevision(document: JsonDocument, ref: JsonNodeRef): JsonEditError | null {
  if (ref.revision !== document.revision) {
    return new JsonEditError(
      'STALE_SPAN',
      'Node reference revision does not match current document revision',
    );
  }
  return null;
}

function resolveTargetNode(
  document: JsonDocument,
  ref: JsonNodeRef,
): { ok: true; node: JsonNode } | { ok: false; error: JsonEditError } {
  const revErr = validateRefRevision(document, ref);
  if (revErr) {
    return { ok: false, error: revErr };
  }
  const node = document.nodeById.get(ref.nodeId);
  if (!node) {
    return {
      ok: false,
      error: new JsonEditError('NODE_NOT_FOUND', 'Target node not found in document'),
    };
  }
  if (node.span.start !== ref.span.start || node.span.end !== ref.span.end) {
    return {
      ok: false,
      error: new JsonEditError(
        'STALE_SPAN',
        'Target node span does not match current document',
      ),
    };
  }
  return { ok: true, node };
}

function isSingleJsonValueLexeme(lexeme: string): boolean {
  if (lexeme.length === 0 || !isWellFormedUtf16(lexeme)) {
    return false;
  }
  const first = lexeme.charCodeAt(0);
  const last = lexeme.charCodeAt(lexeme.length - 1);
  if (
    first === 0x20 ||
    first === 0x09 ||
    first === 0x0a ||
    first === 0x0d ||
    last === 0x20 ||
    last === 0x09 ||
    last === 0x0a ||
    last === 0x0d
  ) {
    return false;
  }
  const parsed = parseJsonStrict(`[${lexeme}]`, { revision: 0 });
  return (
    parsed.ok &&
    parsed.document.root.kind === 'array' &&
    parsed.document.root.elements.length === 1
  );
}

function findLineStart(source: string, offset: number): number {
  let i = offset;
  while (i > 0) {
    const ch = source.charCodeAt(i - 1);
    if (ch === 0x0a /* \n */ || ch === 0x0d /* \r */) {
      break;
    }
    i--;
  }
  return i;
}

function getLeadingIndentAt(source: string, offset: number): string {
  const lineStart = findLineStart(source, offset);
  let i = lineStart;
  while (i < offset) {
    const ch = source.charCodeAt(i);
    if (ch === 0x20 /* space */ || ch === 0x09 /* \t */) {
      i++;
    } else {
      break;
    }
  }
  return source.slice(lineStart, i);
}

function hasLineBreakBetween(source: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const ch = source.charCodeAt(i);
    if (ch === 0x0a || ch === 0x0d) {
      return true;
    }
  }
  return false;
}

function isAllHorizontalWhitespaceBetween(source: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const ch = source.charCodeAt(i);
    if (ch !== 0x20 && ch !== 0x09) {
      return false;
    }
  }
  return true;
}

function findCommaBetween(source: string, start: number, end: number): number {
  for (let i = start; i < end; i++) {
    if (source.charCodeAt(i) === 0x2c /* , */) {
      return i;
    }
  }
  return -1;
}

function computeRemovalSpan(
  source: string,
  containerSpan: { start: number; end: number },
  items: readonly { span: { start: number; end: number } }[],
  removeIndex: number,
): JsonTextEdit {
  const target = items[removeIndex]!;

  if (items.length === 1) {
    // Only child: if multiline between `{`/`[` and `}`/`]`, collapse to empty container on same line
    // if there is only whitespace around it, or remove the item's own line cleanly.
    const innerStart = containerSpan.start + 1;
    const innerEnd = containerSpan.end - 1;
    return {
      offset: innerStart,
      length: innerEnd - innerStart,
      content: '',
    };
  }

  if (removeIndex < items.length - 1) {
    // First or middle item: remove from target start through the comma and whitespace up to next sibling start.
    // Wait: if we remove from `target.span.start` to `next.span.start`, the next sibling takes the exact
    // position (and indentation!) of `target`. Let's verify:
    // Suppose:
    //   {\n
    //     "a": 1,\n
    //     "b": 2\n
    //   }
    // `target.span.start` is right after `    ` on `"a"`'s line.
    // `next.span.start` is right after `    ` on `"b"`'s line.
    // Splicing `[target.span.start, next.span.start)` with `""` leaves the `    ` before `"a"` and puts `"b": 2`
    // right after it! And every byte before `target.span.start` and from `next.span.start` onward is untouched!
    // What if `"a"` had a different indent from `"b"`? Taking `[lineStart(target), lineStart(next))` when on
    // separate lines preserves `"b"`'s own indentation!
    const next = items[removeIndex + 1]!;
    const commaPos = findCommaBetween(source, target.span.end, next.span.start);
    const targetLineStart = findLineStart(source, target.span.start);
    const nextLineStart = findLineStart(source, next.span.start);

    if (
      targetLineStart > containerSpan.start &&
      nextLineStart > target.span.end &&
      commaPos !== -1 &&
      commaPos < nextLineStart &&
      isAllHorizontalWhitespaceBetween(source, targetLineStart, target.span.start) &&
      isAllHorizontalWhitespaceBetween(source, commaPos + 1, findLineEndBeforeBreak(source, commaPos + 1, nextLineStart))
    ) {
      return {
        offset: targetLineStart,
        length: nextLineStart - targetLineStart,
        content: '',
      };
    }

    return {
      offset: target.span.start,
      length: next.span.start - target.span.start,
      content: '',
    };
  }

  // Last item (`removeIndex === items.length - 1` and `items.length >= 2`):
  // Remove from the previous sibling's end (`prev.span.end`, which precedes the separating comma)
  // to `target.span.end`. This removes the comma and any whitespace/newline+indent between `prev` and `target`,
  // while leaving whatever trailing newline/indent exists after `target.span.end` before `}` / `]` intact!
  const prev = items[removeIndex - 1]!;
  return {
    offset: prev.span.end,
    length: target.span.end - prev.span.end,
    content: '',
  };
}

function findLineEndBeforeBreak(source: string, from: number, limit: number): number {
  let i = from;
  while (i < limit) {
    const ch = source.charCodeAt(i);
    if (ch === 0x0a || ch === 0x0d) {
      return i;
    }
    i++;
  }
  return limit;
}

/**
 * Computes the insertion splice for adding a new element or property into a container
 * at `insertIndex` (0..existingItems.length) per Task 12 rule 5:
 * - Empty single-line container (`[]`, `{}`, `[  ]`) receives the element on the same line (`[elem]`).
 * - Empty multi-line container (`[\n]`) inserts on a new line with `parentIndent + "  "` and majority EOL.
 * - Non-empty container:
 *   - Indentation is taken from the immediately preceding sibling (`insertIndex - 1`), or if
 *     inserting at index 0, from `parentIndent + "  "` (or the first sibling if single-line).
 *   - EOL uses the document's majority EOL (`detectEol(source).majoritySeq`).
 *   - Commas are placed before/after as required for first/middle/last position.
 */
function computeInsertionSpan(
  source: string,
  containerSpan: { start: number; end: number },
  items: readonly { span: { start: number; end: number } }[],
  insertIndex: number,
  newItemText: string,
): JsonTextEdit {
  const clampedIndex = Math.max(0, Math.min(insertIndex, items.length));
  const eol = detectEol(source).majoritySeq;
  const parentIndent = getLeadingIndentAt(source, containerSpan.start);
  const defaultChildIndent = `${parentIndent}  `;

  if (items.length === 0) {
    const innerStart = containerSpan.start + 1;
    const innerEnd = containerSpan.end - 1;
    if (!hasLineBreakBetween(source, innerStart, innerEnd)) {
      // Single-line empty container (`[]` or `{}`): keep on same line per Task 12 rule 5.
      return {
        offset: innerStart,
        length: innerEnd - innerStart,
        content: newItemText,
      };
    }
    // Multi-line empty container:
    return {
      offset: innerStart,
      length: innerEnd - innerStart,
      content: `${eol}${defaultChildIndent}${newItemText}${eol}${parentIndent}`,
    };
  }

  const isMultilineContainer = hasLineBreakBetween(
    source,
    containerSpan.start,
    containerSpan.end,
  );

  if (clampedIndex === 0) {
    // Insert before the current first item (`items[0]`).
    // When `first` is on its own line, splice at `findLineStart(source, first.span.start)`
    // using the first sibling's leading indentation so the existing first line is untouched.
    const first = items[0]!;
    const firstHasOwnLine = hasLineBreakBetween(source, containerSpan.start, first.span.start);
    if (!isMultilineContainer || !firstHasOwnLine) {
      return {
        offset: first.span.start,
        length: 0,
        content: `${newItemText}, `,
      };
    }
    const firstLineStart = findLineStart(source, first.span.start);
    const firstIndent = getLeadingIndentAt(source, first.span.start);
    return {
      offset: firstLineStart,
      length: 0,
      content: `${firstIndent}${newItemText},${eol}`,
    };
  }

  // `clampedIndex > 0`: there is a preceding sibling `prev = items[clampedIndex - 1]`.
  // Rule 5: take indentation from the preceding sibling (`prev`).
  const prev = items[clampedIndex - 1]!;
  const prevHasOwnLine = hasLineBreakBetween(source, containerSpan.start, prev.span.start);
  const siblingIndent = prevHasOwnLine
    ? getLeadingIndentAt(source, prev.span.start)
    : defaultChildIndent;

  if (!isMultilineContainer && !prevHasOwnLine) {
    return {
      offset: prev.span.end,
      length: 0,
      content: `, ${newItemText}`,
    };
  }

  return {
    offset: prev.span.end,
    length: 0,
    content: `,${eol}${siblingIndent}${newItemText}`,
  };
}

/**
 * Updates the value of a primitive AST node (or object property key if `nodeRef` points to `keyNode`)
 * according to Task 12 rules 1–4:
 * 1. Keeps the cell's current type:
 *    - `string` cell: `newInput` is treated as the decoded string value and encoded with minimal
 *      escaping (`"42"` when the user types `42`).
 *    - `number` cell: `newInput` must match strict RFC 8259 number grammar (`isValidJsonNumberLexeme`)
 *      and is written verbatim without `Number(...)` conversion.
 *    - `boolean` cell: `newInput` must be `'true'` or `'false'`.
 *    - `null` cell: `newInput` must be `'null'`.
 * 2. No-op commit = no edit: if the displayed value is unchanged (`node.value === newInput` for
 *    strings, `node.lexeme === newInput` for numbers, `node.raw === newInput` for bool/null),
 *    returns `{ ok: true, changed: false, edit: null, source: document.source, document }` so
 *    existing escapes like `"caf\u00e9"` are never rewritten.
 * 3. Rejects editing read-only string cells (lone surrogate `\ud800` or `\r` in table mode unless
 *    `allowCarriageReturnInString` is explicitly enabled).
 */
export function setValue(
  document: JsonDocument,
  nodeRef: JsonNodeRef,
  newInput: string,
  options?: { allowCarriageReturnInString?: boolean },
): JsonEditOutcome {
  const targetRes = resolveTargetNode(document, nodeRef);
  if (!targetRes.ok) {
    return targetRes;
  }
  const node = targetRes.node;

  if (node.kind === 'object' || node.kind === 'array') {
    return {
      ok: false,
      error: new JsonEditError(
        'INVALID_CONTAINER_KIND',
        'setValue cannot be called directly on an object or array container node',
      ),
    };
  }

  if (node.kind === 'string') {
    if (node.hasLoneSurrogate) {
      return {
        ok: false,
        error: new JsonEditError(
          'READ_ONLY_CELL',
          'String cell containing a lone surrogate is read-only in table view; edit in Raw JSON',
        ),
      };
    }
    if (node.hasCarriageReturn && !options?.allowCarriageReturnInString) {
      return {
        ok: false,
        error: new JsonEditError(
          'READ_ONLY_CELL',
          'String cell containing a carriage return (\\r) is read-only in table view; edit in Raw JSON',
        ),
      };
    }
    if (!isWellFormedUtf16(newInput)) {
      return {
        ok: false,
        error: new JsonEditError(
          'INVALID_STRING_VALUE',
          'New string value contains an unpaired UTF-16 surrogate',
        ),
      };
    }

    // Rule 2: No-op commit produces no splice (preserves original escapes like \u00e9 or \/).
    if (node.value === newInput) {
      return {
        ok: true,
        changed: false,
        edit: null,
        source: document.source,
        document,
      };
    }

    // If this string node is an object property key, ensure renaming does not collide with an
    // existing sibling key in the parent object.
    const parentFromMap = document.parentById.get(node.id);
    const parentFromRef =
      nodeRef.parentId !== null ? document.nodeById.get(nodeRef.parentId) : undefined;
    const parentObj =
      parentFromMap && parentFromMap.kind === 'object'
        ? parentFromMap
        : parentFromRef && parentFromRef.kind === 'object'
          ? parentFromRef
          : null;
    if (parentObj) {
      const prop =
        nodeRef.propertyId !== undefined
          ? document.propertyById.get(nodeRef.propertyId)
          : parentObj.properties.find((p) => p.keyNode.id === node.id);
      if (prop && prop.keyNode.id === node.id) {
        const duplicate = parentObj.properties.some(
          (p) => p.id !== prop.id && p.key === newInput,
        );
        if (duplicate) {
          return {
            ok: false,
            error: new JsonEditError('KEY_EXISTS', 'Property key already exists in object'),
          };
        }
      }
    }

    const escaped = escapeJsonStringMinimal(newInput);
    const edit: JsonTextEdit = {
      offset: node.span.start,
      length: node.span.end - node.span.start,
      content: escaped,
    };
    return applyTextEditAndReparse(document, edit);
  }

  if (node.kind === 'number') {
    if (!isValidJsonNumberLexeme(newInput)) {
      return {
        ok: false,
        error: new JsonEditError(
          'INVALID_NUMBER_LEXEME',
          'Invalid RFC 8259 number lexeme',
        ),
      };
    }
    if (node.lexeme === newInput) {
      return {
        ok: true,
        changed: false,
        edit: null,
        source: document.source,
        document,
      };
    }
    const edit: JsonTextEdit = {
      offset: node.span.start,
      length: node.span.end - node.span.start,
      content: newInput,
    };
    return applyTextEditAndReparse(document, edit);
  }

  if (node.kind === 'boolean') {
    if (newInput !== 'true' && newInput !== 'false') {
      return {
        ok: false,
        error: new JsonEditError(
          'INVALID_BOOLEAN_LEXEME',
          'Expected "true" or "false" for boolean cell',
        ),
      };
    }
    if (node.raw === newInput) {
      return {
        ok: true,
        changed: false,
        edit: null,
        source: document.source,
        document,
      };
    }
    const edit: JsonTextEdit = {
      offset: node.span.start,
      length: node.span.end - node.span.start,
      content: newInput,
    };
    return applyTextEditAndReparse(document, edit);
  }

  // node.kind === 'null'
  if (newInput !== 'null') {
    return {
      ok: false,
      error: new JsonEditError(
        'INVALID_NULL_LEXEME',
        'Expected "null" for null cell',
      ),
    };
  }
  return {
    ok: true,
    changed: false,
    edit: null,
    source: document.source,
    document,
  };
}

/**
 * Changes the primitive type of a cell via the explicit "Kiểu" (Type) menu per Task 12 rule 1:
 * - Target types: `'string' | 'number' | 'true' | 'false' | 'null'`.
 * - Default values when changing type:
 *   - `'string'` -> `""`
 *   - `'number'` -> if current node is a `'string'` whose decoded value is a valid JSON number
 *     lexeme, keeps that number lexeme; otherwise `'0'`.
 *   - `'true'` -> `'true'`
 *   - `'false'` -> `'false'`
 *   - `'null'` -> `'null'`
 */
export function changeCellType(
  document: JsonDocument,
  nodeRef: JsonNodeRef,
  targetType: JsonCellValueKind,
): JsonEditOutcome {
  const targetRes = resolveTargetNode(document, nodeRef);
  if (!targetRes.ok) {
    return targetRes;
  }
  const node = targetRes.node;

  if (node.kind === 'object' || node.kind === 'array') {
    return {
      ok: false,
      error: new JsonEditError(
        'INVALID_CONTAINER_KIND',
        'Cannot change primitive type of an object or array container',
      ),
    };
  }

  if (node.kind === 'string' && (node.hasLoneSurrogate || node.hasCarriageReturn)) {
    return {
      ok: false,
      error: new JsonEditError(
        'READ_ONLY_CELL',
        'Read-only string cell cannot be modified in table view',
      ),
    };
  }

  // Check if already the exact target type/value
  if (
    (targetType === 'string' && node.kind === 'string') ||
    (targetType === 'number' && node.kind === 'number') ||
    (targetType === 'true' && node.kind === 'boolean' && node.value === true) ||
    (targetType === 'false' && node.kind === 'boolean' && node.value === false) ||
    (targetType === 'null' && node.kind === 'null')
  ) {
    return {
      ok: true,
      changed: false,
      edit: null,
      source: document.source,
      document,
    };
  }

  let replacementLexeme: string;
  switch (targetType) {
    case 'string':
      replacementLexeme = '""';
      break;
    case 'number':
      if (node.kind === 'string' && isValidJsonNumberLexeme(node.value)) {
        replacementLexeme = node.value;
      } else {
        replacementLexeme = '0';
      }
      break;
    case 'true':
      replacementLexeme = 'true';
      break;
    case 'false':
      replacementLexeme = 'false';
      break;
    case 'null':
      replacementLexeme = 'null';
      break;
  }

  const edit: JsonTextEdit = {
    offset: node.span.start,
    length: node.span.end - node.span.start,
    content: replacementLexeme,
  };
  return applyTextEditAndReparse(document, edit);
}

export interface InsertFieldOptions {
  /** Insertion index in `objectNode.properties` (defaults to appending at the end). */
  readonly index?: number;
  /** Raw JSON lexeme for the initial value (defaults to `'null'`). */
  readonly initialValueLexeme?: string;
}

/**
 * Inserts a new field (`"key": value`) into an object node per Task 12 rule 5:
 * - Rejects if `key` already exists in `objectNode.properties` (`KEY_EXISTS` — "Key đã có").
 * - Escapes `key` with minimal JSON string escaping.
 * - Uses indentation of preceding sibling (or parent + 2 spaces if first/empty) and document's
 *   majority EOL.
 */
export function insertField(
  document: JsonDocument,
  objectRef: JsonNodeRef,
  key: string,
  options?: InsertFieldOptions,
): JsonEditOutcome {
  const targetRes = resolveTargetNode(document, objectRef);
  if (!targetRes.ok) {
    return targetRes;
  }
  const node = targetRes.node;
  if (node.kind !== 'object') {
    return {
      ok: false,
      error: new JsonEditError(
        'INVALID_CONTAINER_KIND',
        'insertField requires an object node',
      ),
    };
  }

  if (!isWellFormedUtf16(key)) {
    return {
      ok: false,
      error: new JsonEditError(
        'INVALID_STRING_VALUE',
        'Field key contains an unpaired UTF-16 surrogate',
      ),
    };
  }

  // Rule 5: Adding a field whose key already exists in the object -> error "Key đã có"
  for (let i = 0; i < node.properties.length; i++) {
    if (node.properties[i]!.key === key) {
      return {
        ok: false,
        error: new JsonEditError('KEY_EXISTS', 'Property key already exists in object'),
      };
    }
  }

  const initialValueLexeme = options?.initialValueLexeme ?? 'null';
  if (!isSingleJsonValueLexeme(initialValueLexeme)) {
    return {
      ok: false,
      error: new JsonEditError(
        'INVALID_VALUE_LEXEME',
        'Initial field value must be a single valid JSON value lexeme',
      ),
    };
  }
  const insertIndex = options?.index ?? node.properties.length;
  const keyLexeme = escapeJsonStringMinimal(key);
  const propText = `${keyLexeme}: ${initialValueLexeme}`;

  const edit = computeInsertionSpan(
    document.source,
    node.span,
    node.properties,
    insertIndex,
    propText,
  );
  return applyTextEditAndReparse(document, edit);
}

export interface InsertRowOptions {
  /** Insertion index in `arrayNode.elements` (defaults to appending at the end). */
  readonly index?: number;
  /**
   * Explicit raw JSON lexeme for the new element.
   * If omitted:
   * - For a non-empty array of objects, builds an object containing all current union columns
   *   (up to `JSON_TABLE_MAX_COLUMNS` = 20 in first-appearance order) mapped to `null`
   *   (Task 12 rule 5: "hàng mới của array-of-object = object với mọi cột hiện có mang `null`").
   * - Otherwise, defaults to `'null'`.
   */
  readonly valueLexeme?: string;
  /**
   * Optional column key when `insertRow` is invoked on a missing cell's `rowObjectRef`
   * inside an array-of-objects table.
   */
  readonly columnKey?: string;
}

function deriveArrayOfObjectsColumns(arrayNode: JsonArrayNode): string[] | null {
  if (arrayNode.elements.length === 0) {
    return null;
  }
  const columns: string[] = [];
  const seen = new Map<string, true>();

  for (let i = 0; i < arrayNode.elements.length; i++) {
    const el = arrayNode.elements[i]!;
    if (el.kind !== 'object') {
      return null;
    }
    for (let j = 0; j < el.properties.length; j++) {
      const k = el.properties[j]!.key;
      if (!seen.has(k)) {
        seen.set(k, true);
        if (columns.length < JSON_TABLE_MAX_COLUMNS) {
          columns.push(k);
        }
      }
    }
  }
  return columns;
}

/**
 * Inserts a new element row into an array node per Task 12 rule 5.
 */
export function insertRow(
  document: JsonDocument,
  arrayRef: JsonNodeRef,
  options?: InsertRowOptions,
): JsonEditOutcome {
  const targetRes = resolveTargetNode(document, arrayRef);
  if (!targetRes.ok) {
    return targetRes;
  }
  const node = targetRes.node;
  if (node.kind === 'object' && options?.columnKey !== undefined) {
    return insertField(document, arrayRef, options.columnKey, {
      initialValueLexeme: options.valueLexeme ?? 'null',
      index: options.index,
    });
  }
  if (node.kind !== 'array') {
    return {
      ok: false,
      error: new JsonEditError(
        'INVALID_CONTAINER_KIND',
        'insertRow requires an array node',
      ),
    };
  }

  let itemLexeme = options?.valueLexeme;
  if (itemLexeme === undefined) {
    const columns = deriveArrayOfObjectsColumns(node);
    if (columns !== null) {
      if (columns.length === 0) {
        itemLexeme = '{}';
      } else {
        const pairs = columns.map((col) => `${escapeJsonStringMinimal(col)}: null`);
        itemLexeme = `{ ${pairs.join(', ')} }`;
      }
    } else {
      itemLexeme = 'null';
    }
  } else if (!isSingleJsonValueLexeme(itemLexeme)) {
    return {
      ok: false,
      error: new JsonEditError(
        'INVALID_VALUE_LEXEME',
        'Row value must be a single valid JSON value lexeme',
      ),
    };
  }
  const insertIndex = options?.index ?? node.elements.length;
  const edit = computeInsertionSpan(
    document.source,
    node.span,
    node.elements,
    insertIndex,
    itemLexeme,
  );
  return applyTextEditAndReparse(document, edit);
}

/**
 * Removes an element from an array node by 0-based `elementIndex`, or by an element
 * `JsonNodeRef` (carrying `elementIndex` or targeting a non-array child element).
 * Calling `removeRow(doc, arrayRef)` without `elementIndex` on an array container ref
 * (where `elementIndex === undefined`) is rejected with `INVALID_INDEX` so an array ref
 * without index can never delete the array itself from its parent.
 * To remove a nested array element by its element ref alone, pass a ref with `elementIndex`
 * (as produced by `model.ts`) or call `removeRowAt(doc, elementRef)`.
 */
export function removeRow(
  document: JsonDocument,
  arrayOrElementRef: JsonNodeRef,
  elementIndex?: number,
): JsonEditOutcome {
  const resolved = resolveTargetNode(document, arrayOrElementRef);
  if (!resolved.ok) {
    return resolved;
  }

  if (elementIndex !== undefined) {
    if (resolved.node.kind !== 'array') {
      return {
        ok: false,
        error: new JsonEditError(
          'INVALID_CONTAINER_KIND',
          'Target node for removeRow(doc, arrayRef, index) must be an array node',
        ),
      };
    }
    const arrayNode = resolved.node;
    if (elementIndex < 0 || elementIndex >= arrayNode.elements.length) {
      return {
        ok: false,
        error: new JsonEditError(
          'INVALID_INDEX',
          'Array element index is out of bounds',
        ),
      };
    }
    const edit = computeRemovalSpan(
      document.source,
      arrayNode.span,
      arrayNode.elements,
      elementIndex,
    );
    return applyTextEditAndReparse(document, edit);
  }

  if (resolved.node.kind === 'array' && arrayOrElementRef.elementIndex === undefined) {
    return {
      ok: false,
      error: new JsonEditError(
        'INVALID_INDEX',
        'removeRow on an array container reference requires an explicit element index',
      ),
    };
  }

  return removeRowAt(document, arrayOrElementRef);
}

/**
 * Removes the array element directly referenced by `elementRef` from its parent array.
 */
export function removeRowAt(
  document: JsonDocument,
  elementRef: JsonNodeRef,
): JsonEditOutcome {
  const resolved = resolveTargetNode(document, elementRef);
  if (!resolved.ok) {
    return resolved;
  }

  const parentId = elementRef.parentId ?? (document.parentById.get(resolved.node.id)?.id ?? null);
  const parent = parentId !== null ? document.nodeById.get(parentId) : undefined;
  if (!parent || parent.kind !== 'array') {
    return {
      ok: false,
      error: new JsonEditError(
        'INVALID_CONTAINER_KIND',
        'Target node for removeRowAt is not an element of a parent array',
      ),
    };
  }

  const targetIndex = parent.elements.findIndex((el) => el.id === resolved.node.id);
  if (targetIndex < 0 || targetIndex >= parent.elements.length) {
    return {
      ok: false,
      error: new JsonEditError(
        'INVALID_INDEX',
        'Array element index is out of bounds',
      ),
    };
  }

  const edit = computeRemovalSpan(
    document.source,
    parent.span,
    parent.elements,
    targetIndex,
  );
  return applyTextEditAndReparse(document, edit);
}

/**
 * Selector for `removeField` when `targetRef` points to the parent object node
 * rather than a specific property occurrence (`targetRef.propertyId === undefined`):
 * - `{ key, occurrenceIndex? }`: removes the N-th occurrence (default 0) of `key`.
 * - `{ propertyIndex }`: removes the property at 0-based `propertyIndex` in `objectNode.properties`.
 */
export type RemoveFieldSelector =
  | { readonly key: string; readonly occurrenceIndex?: number; readonly propertyIndex?: undefined }
  | { readonly propertyIndex: number; readonly key?: string; readonly occurrenceIndex?: number };

/**
 * Removes a property occurrence from an object node.
 * Accepts either:
 * - A `JsonNodeRef` carrying `propertyId` (from `JsonFieldRowView.nodeRef`, `keyCell.nodeRef`,
 *   or `valueCell.nodeRef`), OR
 * - An object `JsonNodeRef` plus `{ key, occurrenceIndex? }` or `{ propertyIndex }`.
 */
export function removeField(
  document: JsonDocument,
  targetRef: JsonNodeRef,
  selector?: RemoveFieldSelector,
): JsonEditOutcome {
  const revErr = validateRefRevision(document, targetRef);
  if (revErr) {
    return { ok: false, error: revErr };
  }

  let objectNode: JsonObjectNode | null = null;
  let propNode: JsonPropertyNode | undefined;

  if (targetRef.propertyId !== undefined) {
    propNode = document.propertyById.get(targetRef.propertyId);
    if (!propNode) {
      return {
        ok: false,
        error: new JsonEditError(
          'NODE_NOT_FOUND',
          'Target property not found in document',
        ),
      };
    }
    const parent =
      targetRef.parentId !== null
        ? document.nodeById.get(targetRef.parentId)
        : document.parentById.get(propNode.valueNode.id);
    if (!parent || parent.kind !== 'object') {
      return {
        ok: false,
        error: new JsonEditError(
          'INVALID_CONTAINER_KIND',
          'Parent of property is not an object node',
        ),
      };
    }
    objectNode = parent;
  } else {
    const resolved = resolveTargetNode(document, targetRef);
    if (!resolved.ok) {
      return resolved;
    }
    if (resolved.node.kind === 'object') {
      objectNode = resolved.node;
      if (selector?.propertyIndex !== undefined) {
        propNode = objectNode.properties[selector.propertyIndex];
      } else if (selector?.key !== undefined) {
        const occ = selector.occurrenceIndex ?? 0;
        propNode = objectNode.properties.find(
          (p) => p.key === selector.key && p.occurrenceIndex === occ,
        );
      }
    }
  }

  if (!objectNode || !propNode) {
    return {
      ok: false,
      error: new JsonEditError(
        'NODE_NOT_FOUND',
        'Could not resolve target object property to remove',
      ),
    };
  }

  // Verify span integrity when targetRef was a property/value/key ref
  if (targetRef.propertyId !== undefined) {
    const matchesPropertySpan =
      targetRef.span.start === propNode.span.start && targetRef.span.end === propNode.span.end;
    const matchesValueSpan =
      targetRef.span.start === propNode.valueNode.span.start &&
      targetRef.span.end === propNode.valueNode.span.end;
    const matchesKeySpan =
      targetRef.span.start === propNode.keyNode.span.start &&
      targetRef.span.end === propNode.keyNode.span.end;
    if (!matchesPropertySpan && !matchesValueSpan && !matchesKeySpan) {
      return {
        ok: false,
        error: new JsonEditError('STALE_SPAN', 'Property span does not match current document'),
      };
    }
  }

  const removeIndex = propNode.propertyIndex;
  const edit = computeRemovalSpan(
    document.source,
    objectNode.span,
    objectNode.properties,
    removeIndex,
  );
  return applyTextEditAndReparse(document, edit);
}
