import type {
  JsonArrayNode,
  JsonDocument,
  JsonNode,
  JsonObjectNode,
  JsonPropertyNode,
  JsonSpan,
} from './parse';

export const JSON_TABLE_MAX_COLUMNS = 20;
export const JSON_TABLE_PAGE_SIZE = 50;

/**
 * Revision-tagged reference to a JSON AST node or property occurrence.
 * Passed into `edit.ts` operations; if `ref.revision !== document.revision`,
 * `edit.ts` rejects with `STALE_SPAN`.
 */
export interface JsonNodeRef {
  readonly revision: number;
  readonly nodeId: number;
  readonly span: JsonSpan;
  readonly parentId: number | null;
  readonly propertyId?: number;
  readonly propertyKey?: string;
  readonly occurrenceIndex?: number;
  readonly elementIndex?: number;
}

export type JsonCellEditorMode = 'singleline' | 'multiline' | 'readonly';

export type JsonReadOnlyReason = 'lone_surrogate' | 'carriage_return' | null;

export interface JsonPrimitiveCellView {
  readonly kind: 'primitive';
  readonly valueType: 'string' | 'number' | 'boolean' | 'null';
  readonly nodeRef: JsonNodeRef;
  /**
   * Display text shown in the cell and initial editor input:
   * - `string`: decoded string value (unless `readOnlyReason === 'lone_surrogate'`, where raw literal is kept).
   * - `number`: verbatim `lexeme` from source (`9007199254740993`, `1e400`, `-0`, `0.10`).
   * - `boolean`: `'true'` or `'false'`.
   * - `null`: `'null'`.
   */
  readonly displayText: string;
  /** Verbatim slice in source text. */
  readonly rawLexeme: string;
  readonly editorMode: JsonCellEditorMode;
  readonly readOnly: boolean;
  readonly readOnlyReason: JsonReadOnlyReason;
  readonly multiline: boolean;
}

export interface JsonContainerCellView {
  readonly kind: 'container';
  readonly containerKind: 'object' | 'array';
  readonly nodeRef: JsonNodeRef;
  readonly childCount: number;
  /** Summary label, e.g. `"Object (3)"` or `"Array (5)"`. */
  readonly summaryLabel: string;
  /**
   * Lazily builds the nested table view for this container ONLY when expanded.
   * Never recurses eagerly during parent table construction.
   */
  readonly expand: (options?: BuildTableViewOptions) => JsonTableView;
}

export interface JsonMissingCellView {
  readonly kind: 'missing';
  readonly rowObjectRef: JsonNodeRef;
  readonly columnKey: string;
}

export type JsonTableCellView =
  | JsonPrimitiveCellView
  | JsonContainerCellView
  | JsonMissingCellView;

export interface JsonFieldRowView {
  readonly kind: 'field';
  readonly propertyId: number;
  readonly propertyIndex: number;
  readonly key: string;
  readonly occurrenceIndex: number;
  readonly totalOccurrencesForKey: number;
  readonly isDuplicateKey: boolean;
  /** Disambiguated label when `isDuplicateKey` is true (e.g. `"a (#2)"`), else `key`. */
  readonly keyLabel: string;
  readonly keyCell: JsonPrimitiveCellView;
  readonly valueCell: JsonPrimitiveCellView | JsonContainerCellView;
  readonly nodeRef: JsonNodeRef;
}

export interface JsonObjectTableView {
  readonly kind: 'object';
  readonly containerRef: JsonNodeRef;
  readonly totalRows: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly rows: readonly JsonFieldRowView[];
  readonly hasDuplicateKeys: boolean;
  readonly hasReadOnlyCells: boolean;
}

export interface JsonExtraFieldsView {
  readonly count: number;
  /** Label `+N field` per Task 12 (`"+5 field"`). */
  readonly label: string;
  readonly fields: readonly JsonFieldRowView[];
  /** Builds a standalone field/value view for the extra fields when expanded. */
  readonly expand: (options?: BuildTableViewOptions) => JsonObjectTableView;
}

export interface JsonArrayOfObjectsColumnRowView {
  readonly kind: 'columns';
  readonly rowIndex: number;
  readonly rowObjectRef: JsonNodeRef;
  /**
   * Keyed by column name using a `Map` (never a plain JS object) so `__proto__`,
   * `constructor`, and `hasOwnProperty` are normal keys without prototype pollution.
   */
  readonly cells: ReadonlyMap<string, JsonTableCellView>;
  /**
   * Present when this row has keys outside the first 20 union columns (`+N field`).
   */
  readonly extraFields: JsonExtraFieldsView | null;
}

export interface JsonArrayOfObjectsFallbackRowView {
  readonly kind: 'duplicate-fallback';
  readonly rowIndex: number;
  readonly rowObjectRef: JsonNodeRef;
  /**
   * When a row object has duplicate keys, it falls back to a field/value sub-table
   * so all occurrences are shown and individually editable (SPEC §7.4, Task 12).
   */
  readonly fallbackTable: JsonObjectTableView;
}

export type JsonArrayOfObjectsRowView =
  | JsonArrayOfObjectsColumnRowView
  | JsonArrayOfObjectsFallbackRowView;

export interface JsonArrayOfObjectsTableView {
  readonly kind: 'array-of-objects';
  readonly containerRef: JsonNodeRef;
  /**
   * First-appearance union of keys across the array's object elements, capped at 20.
   */
  readonly columns: readonly string[];
  /**
   * Total distinct keys across all object elements in the array (may exceed 20).
   */
  readonly totalDistinctKeys: number;
  /**
   * Map from column key to 0-based column index (safe for `__proto__`, `constructor`, etc.).
   */
  readonly columnIndexByKey: ReadonlyMap<string, number>;
  readonly totalRows: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly rows: readonly JsonArrayOfObjectsRowView[];
  readonly hasExtraFieldsColumn: boolean;
  readonly hasReadOnlyCells: boolean;
}

export interface JsonArrayElementRowView {
  readonly index: number;
  readonly elementRef: JsonNodeRef;
  readonly valueCell: JsonPrimitiveCellView | JsonContainerCellView;
}

export interface JsonPrimitiveArrayTableView {
  readonly kind: 'primitive-array';
  readonly containerRef: JsonNodeRef;
  readonly totalRows: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly rows: readonly JsonArrayElementRowView[];
  readonly hasReadOnlyCells: boolean;
}

export interface JsonArrayOfArraysRowView {
  readonly index: number;
  readonly elementRef: JsonNodeRef;
  readonly childCount: number;
  /** `"Array (n)"` per SPEC §7.4 & Task 12. */
  readonly label: string;
  readonly cell: JsonContainerCellView;
}

export interface JsonArrayOfArraysTableView {
  readonly kind: 'array-of-arrays';
  readonly containerRef: JsonNodeRef;
  readonly totalRows: number;
  readonly page: number;
  readonly pageSize: number;
  readonly totalPages: number;
  readonly rows: readonly JsonArrayOfArraysRowView[];
  readonly hasReadOnlyCells: boolean;
}

export interface JsonRootPrimitiveTableView {
  readonly kind: 'root-primitive';
  readonly cell: JsonPrimitiveCellView;
  readonly hasReadOnlyCells: boolean;
}

export type JsonTableView =
  | JsonObjectTableView
  | JsonArrayOfObjectsTableView
  | JsonPrimitiveArrayTableView
  | JsonArrayOfArraysTableView
  | JsonRootPrimitiveTableView;

export interface BuildTableViewOptions {
  /** 1-based page number (defaults to 1). */
  readonly page?: number;
  /** Page size (defaults to 50). */
  readonly pageSize?: number;
}

function computePagination(
  totalRows: number,
  options?: BuildTableViewOptions,
): { page: number; pageSize: number; totalPages: number; startIndex: number; endIndex: number } {
  const pageSize =
    options?.pageSize && options.pageSize > 0 ? Math.floor(options.pageSize) : JSON_TABLE_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const requestedPage = options?.page && options.page > 0 ? Math.floor(options.page) : 1;
  const page = Math.min(requestedPage, totalPages);
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(totalRows, startIndex + pageSize);
  return { page, pageSize, totalPages, startIndex, endIndex };
}

function makeNodeRef(
  document: JsonDocument,
  node: JsonNode,
  extra?: {
    propertyId?: number;
    propertyKey?: string;
    occurrenceIndex?: number;
    elementIndex?: number;
  },
): JsonNodeRef {
  const parent = document.parentById.get(node.id) ?? null;
  return {
    revision: document.revision,
    nodeId: node.id,
    span: node.span,
    parentId: parent ? parent.id : null,
    ...extra,
  };
}

export function buildCellView(
  document: JsonDocument,
  node: JsonNode,
  refExtra?: {
    propertyId?: number;
    propertyKey?: string;
    occurrenceIndex?: number;
    elementIndex?: number;
  },
): JsonPrimitiveCellView | JsonContainerCellView {
  const nodeRef = makeNodeRef(document, node, refExtra);

  if (node.kind === 'object') {
    const childCount = node.properties.length;
    return {
      kind: 'container',
      containerKind: 'object',
      nodeRef,
      childCount,
      summaryLabel: `Object (${childCount})`,
      expand: (opts) => buildNodeTableView(document, node, opts),
    };
  }

  if (node.kind === 'array') {
    const childCount = node.elements.length;
    return {
      kind: 'container',
      containerKind: 'array',
      nodeRef,
      childCount,
      summaryLabel: `Array (${childCount})`,
      expand: (opts) => buildNodeTableView(document, node, opts),
    };
  }

  if (node.kind === 'string') {
    // Task 12 & §2.10 rule 6:
    // - String with lone surrogate (\ud800) -> read-only in table (edit via raw tab).
    // - String with \r -> read-only in table (HTML inputs strip CR).
    // - String with \n (and no \r, no lone surrogate) -> multiline (textarea).
    // - Otherwise -> singleline (input).
    if (node.hasLoneSurrogate) {
      return {
        kind: 'primitive',
        valueType: 'string',
        nodeRef,
        displayText: node.raw,
        rawLexeme: node.raw,
        editorMode: 'readonly',
        readOnly: true,
        readOnlyReason: 'lone_surrogate',
        multiline: false,
      };
    }
    if (node.hasCarriageReturn) {
      return {
        kind: 'primitive',
        valueType: 'string',
        nodeRef,
        displayText: node.value,
        rawLexeme: node.raw,
        editorMode: 'readonly',
        readOnly: true,
        readOnlyReason: 'carriage_return',
        multiline: false,
      };
    }
    const multiline = node.hasLineFeed;
    return {
      kind: 'primitive',
      valueType: 'string',
      nodeRef,
      displayText: node.value,
      rawLexeme: node.raw,
      editorMode: multiline ? 'multiline' : 'singleline',
      readOnly: false,
      readOnlyReason: null,
      multiline,
    };
  }

  if (node.kind === 'number') {
    return {
      kind: 'primitive',
      valueType: 'number',
      nodeRef,
      displayText: node.lexeme,
      rawLexeme: node.lexeme,
      editorMode: 'singleline',
      readOnly: false,
      readOnlyReason: null,
      multiline: false,
    };
  }

  if (node.kind === 'boolean') {
    return {
      kind: 'primitive',
      valueType: 'boolean',
      nodeRef,
      displayText: node.raw,
      rawLexeme: node.raw,
      editorMode: 'singleline',
      readOnly: false,
      readOnlyReason: null,
      multiline: false,
    };
  }

  // node.kind === 'null'
  return {
    kind: 'primitive',
    valueType: 'null',
    nodeRef,
    displayText: 'null',
    rawLexeme: node.raw,
    editorMode: 'singleline',
    readOnly: false,
    readOnlyReason: null,
    multiline: false,
  };
}

function buildFieldRowView(
  document: JsonDocument,
  parentObject: JsonObjectNode,
  prop: JsonPropertyNode,
  totalOccurrencesForKey: number,
): JsonFieldRowView {
  const isDuplicateKey = totalOccurrencesForKey > 1;
  const keyLabel = isDuplicateKey ? `${prop.key} (#${prop.occurrenceIndex + 1})` : prop.key;

  const keyCellRaw = buildCellView(document, prop.keyNode, {
    propertyId: prop.id,
    propertyKey: prop.key,
    occurrenceIndex: prop.occurrenceIndex,
  }) as JsonPrimitiveCellView;

  const valueCell = buildCellView(document, prop.valueNode, {
    propertyId: prop.id,
    propertyKey: prop.key,
    occurrenceIndex: prop.occurrenceIndex,
  });

  const nodeRef: JsonNodeRef = {
    revision: document.revision,
    nodeId: prop.valueNode.id,
    span: prop.span,
    parentId: parentObject.id,
    propertyId: prop.id,
    propertyKey: prop.key,
    occurrenceIndex: prop.occurrenceIndex,
  };

  return {
    kind: 'field',
    propertyId: prop.id,
    propertyIndex: prop.propertyIndex,
    key: prop.key,
    occurrenceIndex: prop.occurrenceIndex,
    totalOccurrencesForKey,
    isDuplicateKey,
    keyLabel,
    keyCell: keyCellRaw,
    valueCell,
    nodeRef,
  };
}

function buildObjectTableViewFromProperties(
  document: JsonDocument,
  objectNode: JsonObjectNode,
  properties: readonly JsonPropertyNode[],
  options?: BuildTableViewOptions,
): JsonObjectTableView {
  const countsByKey = new Map<string, number>();
  for (let i = 0; i < objectNode.properties.length; i++) {
    const k = objectNode.properties[i]!.key;
    countsByKey.set(k, (countsByKey.get(k) ?? 0) + 1);
  }

  const totalRows = properties.length;
  const { page, pageSize, totalPages, startIndex, endIndex } = computePagination(
    totalRows,
    options,
  );

  const rows: JsonFieldRowView[] = [];
  let hasReadOnlyCells = false;

  for (let i = startIndex; i < endIndex; i++) {
    const prop = properties[i]!;
    const totalOcc = countsByKey.get(prop.key) ?? 1;
    const row = buildFieldRowView(document, objectNode, prop, totalOcc);
    if (
      row.keyCell.readOnly ||
      (row.valueCell.kind === 'primitive' && row.valueCell.readOnly)
    ) {
      hasReadOnlyCells = true;
    }
    rows.push(row);
  }

  return {
    kind: 'object',
    containerRef: makeNodeRef(document, objectNode),
    totalRows,
    page,
    pageSize,
    totalPages,
    rows,
    hasDuplicateKeys: objectNode.hasDuplicateKeys,
    hasReadOnlyCells,
  };
}

function buildArrayTableView(
  document: JsonDocument,
  arrayNode: JsonArrayNode,
  options?: BuildTableViewOptions,
):
  | JsonArrayOfObjectsTableView
  | JsonPrimitiveArrayTableView
  | JsonArrayOfArraysTableView {
  const elements = arrayNode.elements;
  const totalRows = elements.length;

  // Classify array:
  // 1. Non-empty and every element is an object -> 'array-of-objects'
  // 2. Non-empty and every element is an array -> 'array-of-arrays'
  // 3. Otherwise (empty array, all primitives, or mixed elements) -> 'primitive-array' (`#` / value)
  let allObjects = totalRows > 0;
  let allArrays = totalRows > 0;
  for (let i = 0; i < totalRows; i++) {
    const k = elements[i]!.kind;
    if (k !== 'object') {
      allObjects = false;
    }
    if (k !== 'array') {
      allArrays = false;
    }
    if (!allObjects && !allArrays) {
      break;
    }
  }

  const { page, pageSize, totalPages, startIndex, endIndex } = computePagination(
    totalRows,
    options,
  );
  const containerRef = makeNodeRef(document, arrayNode);

  if (allObjects) {
    // Union of keys in first-appearance order across all object rows in source order.
    // Stored in a Map so `__proto__`, `constructor`, `hasOwnProperty` are normal keys.
    const columnIndexByKey = new Map<string, number>();
    const columns: string[] = [];
    const distinctKeys = new Map<string, true>();

    for (let i = 0; i < totalRows; i++) {
      const obj = elements[i] as JsonObjectNode;
      const props = obj.properties;
      for (let j = 0; j < props.length; j++) {
        const key = props[j]!.key;
        if (!distinctKeys.has(key)) {
          distinctKeys.set(key, true);
          if (columns.length < JSON_TABLE_MAX_COLUMNS) {
            columnIndexByKey.set(key, columns.length);
            columns.push(key);
          }
        }
      }
    }

    const rows: JsonArrayOfObjectsRowView[] = [];
    let hasExtraFieldsColumn = false;
    let hasReadOnlyCells = false;

    for (let i = startIndex; i < endIndex; i++) {
      const obj = elements[i] as JsonObjectNode;
      const rowObjectRef = makeNodeRef(document, obj, { elementIndex: i });

      if (obj.hasDuplicateKeys) {
        const fallbackTable = buildObjectTableViewFromProperties(document, obj, obj.properties);
        if (fallbackTable.hasReadOnlyCells) {
          hasReadOnlyCells = true;
        }
        rows.push({
          kind: 'duplicate-fallback',
          rowIndex: i,
          rowObjectRef,
          fallbackTable,
        });
        continue;
      }

      const propByKey = new Map<string, JsonPropertyNode>();
      const extraProps: JsonPropertyNode[] = [];

      for (let j = 0; j < obj.properties.length; j++) {
        const prop = obj.properties[j]!;
        if (columnIndexByKey.has(prop.key)) {
          propByKey.set(prop.key, prop);
        } else {
          extraProps.push(prop);
        }
      }

      const cells = new Map<string, JsonTableCellView>();
      for (let c = 0; c < columns.length; c++) {
        const colKey = columns[c]!;
        const prop = propByKey.get(colKey);
        if (prop) {
          const cell = buildCellView(document, prop.valueNode, {
            propertyId: prop.id,
            propertyKey: prop.key,
            occurrenceIndex: prop.occurrenceIndex,
          });
          if (cell.kind === 'primitive' && cell.readOnly) {
            hasReadOnlyCells = true;
          }
          cells.set(colKey, cell);
        } else {
          cells.set(colKey, {
            kind: 'missing',
            rowObjectRef,
            columnKey: colKey,
          });
        }
      }

      let extraFields: JsonExtraFieldsView | null = null;
      if (extraProps.length > 0) {
        hasExtraFieldsColumn = true;
        const extraFieldRows = extraProps.map((prop) => {
          const fieldRow = buildFieldRowView(document, obj, prop, 1);
          if (
            fieldRow.keyCell.readOnly ||
            (fieldRow.valueCell.kind === 'primitive' && fieldRow.valueCell.readOnly)
          ) {
            hasReadOnlyCells = true;
          }
          return fieldRow;
        });
        extraFields = {
          count: extraProps.length,
          label: `+${extraProps.length} field`,
          fields: extraFieldRows,
          expand: (opts) => buildObjectTableViewFromProperties(document, obj, extraProps, opts),
        };
      }

      rows.push({
        kind: 'columns',
        rowIndex: i,
        rowObjectRef,
        cells,
        extraFields,
      });
    }

    return {
      kind: 'array-of-objects',
      containerRef,
      columns,
      totalDistinctKeys: distinctKeys.size,
      columnIndexByKey,
      totalRows,
      page,
      pageSize,
      totalPages,
      rows,
      hasExtraFieldsColumn,
      hasReadOnlyCells,
    };
  }

  if (allArrays) {
    const rows: JsonArrayOfArraysRowView[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      const childArr = elements[i] as JsonArrayNode;
      const cell = buildCellView(document, childArr, {
        elementIndex: i,
      }) as JsonContainerCellView;
      rows.push({
        index: i,
        elementRef: cell.nodeRef,
        childCount: childArr.elements.length,
        label: `Array (${childArr.elements.length})`,
        cell,
      });
    }
    return {
      kind: 'array-of-arrays',
      containerRef,
      totalRows,
      page,
      pageSize,
      totalPages,
      rows,
      hasReadOnlyCells: false,
    };
  }

  // Primitive array or mixed array -> `#` / value
  const rows: JsonArrayElementRowView[] = [];
  let hasReadOnlyCells = false;
  for (let i = startIndex; i < endIndex; i++) {
    const el = elements[i]!;
    const valueCell = buildCellView(document, el, { elementIndex: i });
    if (valueCell.kind === 'primitive' && valueCell.readOnly) {
      hasReadOnlyCells = true;
    }
    rows.push({
      index: i,
      elementRef: valueCell.nodeRef,
      valueCell,
    });
  }

  return {
    kind: 'primitive-array',
    containerRef,
    totalRows,
    page,
    pageSize,
    totalPages,
    rows,
    hasReadOnlyCells,
  };
}

/**
 * Builds the table view for a specific AST node (`root` by default) without recursion.
 * Nested container children are NOT built until their `.expand()` callback is invoked.
 */
export function buildNodeTableView(
  document: JsonDocument,
  node: JsonNode,
  options?: BuildTableViewOptions,
): JsonTableView {
  if (node.kind === 'object') {
    return buildObjectTableViewFromProperties(document, node, node.properties, options);
  }
  if (node.kind === 'array') {
    return buildArrayTableView(document, node, options);
  }
  const cell = buildCellView(document, node) as JsonPrimitiveCellView;
  return {
    kind: 'root-primitive',
    cell,
    hasReadOnlyCells: cell.readOnly,
  };
}

/**
 * Builds the root table view for a parsed `JsonDocument`.
 */
export function buildRootTableView(
  document: JsonDocument,
  options?: BuildTableViewOptions,
): JsonTableView {
  return buildNodeTableView(document, document.root, options);
}
