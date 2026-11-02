// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyTextareaEol,
  areNonWhitespaceTokensIdentical,
  buildRootTableView,
  changeCellType,
  decodeUtf8FileStrict,
  detectEol,
  formatJsonStrict,
  insertField,
  insertRow,
  lineColumnToOffset,
  normalizeEolToLf,
  offsetToLineColumn,
  parseJsonStrict,
  removeField,
  removeRow,
  setValue,
  type JsonDocument,
  type JsonNode,
  type JsonNodeRef,
  type JsonPrimitiveNode,
} from './index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CORPUS_DIR = path.resolve(
  __dirname,
  '../../../../packages/content-fixtures/json-corpus',
);

interface CorpusFixtureEntry {
  id: string;
  file: string;
  kind: 'valid' | 'valid-bom' | 'invalid-json-second-bom' | 'invalid-utf8';
  eol: 'lf' | 'crlf' | 'mixed' | 'cr';
  expectedBomStripped: boolean;
  expectedValidJson: boolean;
  byteLength: number;
  description: string;
}

interface CorpusManifest {
  version: number;
  fixtures: CorpusFixtureEntry[];
}

const utf8Encoder = new TextEncoder();

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  expect(Buffer.compare(actual, expected)).toBe(0);
}

function stripWhitespaceOutsideStringsOracle(input: string): string {
  return input.replace(/"(?:\\.|[^"\\])*"|\s+/g, (match) =>
    match.startsWith('"') ? match : '',
  );
}

interface ScannedPrimitives {
  firstEditable: { node: JsonPrimitiveNode; ref: JsonNodeRef } | null;
  firstString: { node: JsonPrimitiveNode; ref: JsonNodeRef } | null;
  firstNumber: { node: JsonPrimitiveNode; ref: JsonNodeRef } | null;
  secondDuplicateValue: { node: JsonPrimitiveNode; ref: JsonNodeRef } | null;
  readOnlyStrings: { node: JsonPrimitiveNode; ref: JsonNodeRef }[];
}

/**
 * Iteratively scans `document` (explicit stack, zero recursion) to collect:
 * - first editable primitive value
 * - first editable string value (or property key if no string value exists)
 * - first number value
 * - first 2nd+ occurrence value in a duplicate-key object
 * - all read-only string value nodes (lone surrogate or carriage return)
 */
function scanCorpusPrimitives(document: JsonDocument): ScannedPrimitives {
  let firstEditable: { node: JsonPrimitiveNode; ref: JsonNodeRef } | null = null;
  let firstString: { node: JsonPrimitiveNode; ref: JsonNodeRef } | null = null;
  let firstKeyString: { node: JsonPrimitiveNode; ref: JsonNodeRef } | null = null;
  let firstNumber: { node: JsonPrimitiveNode; ref: JsonNodeRef } | null = null;
  let secondDuplicateValue: { node: JsonPrimitiveNode; ref: JsonNodeRef } | null = null;
  const readOnlyStrings: { node: JsonPrimitiveNode; ref: JsonNodeRef }[] = [];

  function makeRef(node: JsonPrimitiveNode, propertyId?: number): JsonNodeRef {
    const parent = document.parentById.get(node.id) ?? null;
    return {
      revision: document.revision,
      nodeId: node.id,
      span: node.span,
      parentId: parent ? parent.id : null,
      ...(propertyId !== undefined ? { propertyId } : {}),
    };
  }

  const stack: { node: JsonNode; isDuplicateOccurrence: boolean; propertyId?: number }[] = [
    { node: document.root, isDuplicateOccurrence: false },
  ];

  while (stack.length > 0) {
    const item = stack.pop()!;
    const curr = item.node;
    if (curr.kind === 'object') {
      for (let i = 0; i < curr.properties.length; i++) {
        const prop = curr.properties[i]!;
        if (
          !firstKeyString &&
          !prop.keyNode.hasLoneSurrogate &&
          !prop.keyNode.hasCarriageReturn
        ) {
          firstKeyString = { node: prop.keyNode, ref: makeRef(prop.keyNode, prop.id) };
        }
      }
      for (let i = curr.properties.length - 1; i >= 0; i--) {
        const prop = curr.properties[i]!;
        stack.push({
          node: prop.valueNode,
          isDuplicateOccurrence: prop.occurrenceIndex >= 1,
          propertyId: prop.id,
        });
      }
    } else if (curr.kind === 'array') {
      for (let i = curr.elements.length - 1; i >= 0; i--) {
        stack.push({
          node: curr.elements[i]!,
          isDuplicateOccurrence: false,
        });
      }
    } else {
      const ref = makeRef(curr, item.propertyId);
      if (curr.kind === 'string' && (curr.hasLoneSurrogate || curr.hasCarriageReturn)) {
        readOnlyStrings.push({ node: curr, ref });
        continue;
      }
      if (!firstEditable) {
        firstEditable = { node: curr, ref };
      }
      if (curr.kind === 'string' && !firstString) {
        firstString = { node: curr, ref };
      }
      if (curr.kind === 'number' && !firstNumber) {
        firstNumber = { node: curr, ref };
      }
      if (item.isDuplicateOccurrence && !secondDuplicateValue) {
        secondDuplicateValue = { node: curr, ref };
      }
    }
  }

  return {
    firstEditable,
    firstString: firstString ?? firstKeyString,
    firstNumber,
    secondDuplicateValue,
    readOnlyStrings,
  };
}

function getDisplayValueForPrimitive(node: JsonPrimitiveNode): string {
  switch (node.kind) {
    case 'string':
      return node.value;
    case 'number':
      return node.lexeme;
    case 'boolean':
      return node.raw;
    case 'null':
      return 'null';
  }
}

function assertSplicePreservesOutsideBytes(
  originalBytes: Uint8Array,
  originalSource: string,
  editedSource: string,
  edit: { offset: number; length: number; content: string },
): void {
  const prefixBytes = utf8Encoder.encode(originalSource.slice(0, edit.offset));
  const suffixBytes = utf8Encoder.encode(originalSource.slice(edit.offset + edit.length));
  const spliceBytes = utf8Encoder.encode(edit.content);
  const editedBytes = utf8Encoder.encode(editedSource);

  expect(editedBytes.byteLength).toBe(
    prefixBytes.byteLength + spliceBytes.byteLength + suffixBytes.byteLength,
  );
  expectBytesEqual(
    editedBytes.subarray(0, prefixBytes.byteLength),
    originalBytes.subarray(0, prefixBytes.byteLength),
  );
  expectBytesEqual(
    editedBytes.subarray(
      prefixBytes.byteLength,
      prefixBytes.byteLength + spliceBytes.byteLength,
    ),
    spliceBytes,
  );
  expectBytesEqual(
    editedBytes.subarray(editedBytes.byteLength - suffixBytes.byteLength),
    originalBytes.subarray(originalBytes.byteLength - suffixBytes.byteLength),
  );
}
describe('P04-T12 JSON Corpus (packages/content-fixtures/json-corpus)', () => {
  const manifestPath = path.join(CORPUS_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CorpusManifest;

  const validFixtures = manifest.fixtures.filter(
    (f) => f.kind === 'valid' || f.kind === 'valid-bom',
  );
  const invalidUtf8Fixtures = manifest.fixtures.filter((f) => f.kind === 'invalid-utf8');
  const twoBomFixture = manifest.fixtures.find((f) => f.id === 'two-bom');

  it('loads all expected fixtures from packages/content-fixtures/json-corpus/manifest.json', () => {
    expect(validFixtures.length).toBeGreaterThanOrEqual(22);
    expect(invalidUtf8Fixtures.length).toBeGreaterThanOrEqual(3);
    expect(twoBomFixture).toBeDefined();
  });

  it.each(validFixtures)(
    '[$id] round-trips raw/import bytes verbatim and preserves every byte outside edited span (P04-A6, P04-A7)',
    (entry) => {
      expect.hasAssertions();
      const filePath = path.join(CORPUS_DIR, entry.file);
      const fileBytes = new Uint8Array(fs.readFileSync(filePath));
      expect(fileBytes.byteLength).toBe(entry.byteLength);

      // 1. Strict UTF-8 decode + single BOM strip
      const decoded = decodeUtf8FileStrict(fileBytes);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;

      expect(decoded.hadBom).toBe(entry.expectedBomStripped);
      const expectedSourceBytes = entry.expectedBomStripped ? fileBytes.subarray(3) : fileBytes;
      const reencodedSourceBytes = utf8Encoder.encode(decoded.text);
      // Byte-for-byte identity of imported/raw text
      expectBytesEqual(reencodedSourceBytes, expectedSourceBytes);

      // 2. EOL detection matches manifest
      const eolInfo = detectEol(decoded.text);
      expect(eolInfo.kind).toBe(entry.eol);
      if (entry.eol === 'cr') {
        expect(eolInfo.majority).toBe('cr');
        expect(eolInfo.majoritySeq).toBe('\r');
      }

      // Raw textarea no-op round-trip: if user opens Raw JSON and clicks Save without editing,
      // applyTextareaEol reports changed=false and keeps original bytes intact.
      const noopTextareaPlan = applyTextareaEol(
        decoded.text,
        normalizeEolToLf(decoded.text),
      );
      expect(noopTextareaPlan.changed).toBe(false);
      expectBytesEqual(utf8Encoder.encode(noopTextareaPlan.text), expectedSourceBytes);

      // 3. Strict iterative parse + lazy root table view build (no stack overflow)
      const parsed = parseJsonStrict(decoded.text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const doc = parsed.document;
      const rootView = buildRootTableView(doc);
      expect(rootView).toBeDefined();

      // 4. Scan primitives in the fixture and verify:
      //    (a) All read-only string cells (lone surrogate or \r) refuse edits with READ_ONLY_CELL.
      //    (b) First string cell (and converted primitive if no string cell) set to `42` produces `"42"`,
      //        and unchanged commit is byte-identical.
      //    (c) First number cell (if present) edits losslessly and preserves outside bytes.
      //    (d) Second duplicate-key occurrence (if present) edits independently without touching 1st occurrence.
      const scanned = scanCorpusPrimitives(doc);

      for (const ro of scanned.readOnlyStrings) {
        const roAttempt = setValue(doc, ro.ref, 'should-fail');
        expect(roAttempt.ok).toBe(false);
        if (!roAttempt.ok) {
          expect(roAttempt.error.code).toBe('READ_ONLY_CELL');
        }
      }

      function verifyPrimitiveCellEdit(target: {
        node: JsonPrimitiveNode;
        ref: JsonNodeRef;
      }): void {
        const currentDisplay = getDisplayValueForPrimitive(target.node);
        const noopOutcome = setValue(doc, target.ref, currentDisplay);
        expect(noopOutcome.ok).toBe(true);
        if (noopOutcome.ok) {
          expect(noopOutcome.changed).toBe(false);
          expect(noopOutcome.edit).toBeNull();
          expectBytesEqual(utf8Encoder.encode(noopOutcome.source), expectedSourceBytes);
        }

        if (target.node.kind === 'string') {
          // If this is a property key node, pick '42' (none of the fixtures already have key '42')
          const editedOutcome = setValue(doc, target.ref, '42');
          expect(editedOutcome.ok).toBe(true);
          if (editedOutcome.ok && editedOutcome.edit) {
            expect(editedOutcome.edit.content).toBe('"42"');
            assertSplicePreservesOutsideBytes(
              expectedSourceBytes,
              doc.source,
              editedOutcome.source,
              editedOutcome.edit,
            );
          }
        } else if (target.node.kind === 'number') {
          const nextNum = target.node.lexeme === '42' ? '9007199254740993' : '42';
          const editedOutcome = setValue(doc, target.ref, nextNum);
          expect(editedOutcome.ok).toBe(true);
          if (editedOutcome.ok && editedOutcome.edit) {
            expect(editedOutcome.edit.content).toBe(nextNum);
            assertSplicePreservesOutsideBytes(
              expectedSourceBytes,
              doc.source,
              editedOutcome.source,
              editedOutcome.edit,
            );
          }
        } else if (target.node.kind === 'boolean') {
          const nextBool = target.node.value ? 'false' : 'true';
          const editedOutcome = setValue(doc, target.ref, nextBool);
          expect(editedOutcome.ok).toBe(true);
          if (editedOutcome.ok && editedOutcome.edit) {
            assertSplicePreservesOutsideBytes(
              expectedSourceBytes,
              doc.source,
              editedOutcome.source,
              editedOutcome.edit,
            );
          }
        } else {
          const toStr = changeCellType(doc, target.ref, 'string');
          expect(toStr.ok).toBe(true);
          if (toStr.ok && toStr.edit) {
            assertSplicePreservesOutsideBytes(
              expectedSourceBytes,
              doc.source,
              toStr.source,
              toStr.edit,
            );
            const rescanned = scanCorpusPrimitives(toStr.document);
            expect(rescanned.firstString).not.toBeNull();
            if (rescanned.firstString) {
              const str42 = setValue(toStr.document, rescanned.firstString.ref, '42');
              expect(str42.ok).toBe(true);
              if (str42.ok && str42.edit) {
                expect(str42.edit.content).toBe('"42"');
              }
            }
          }
        }
      }

      if (scanned.firstEditable) {
        verifyPrimitiveCellEdit(scanned.firstEditable);
      }
      if (
        scanned.firstString &&
        scanned.firstString.node.id !== scanned.firstEditable?.node.id
      ) {
        verifyPrimitiveCellEdit(scanned.firstString);
      }
      if (
        scanned.firstNumber &&
        scanned.firstNumber.node.id !== scanned.firstEditable?.node.id
      ) {
        verifyPrimitiveCellEdit(scanned.firstNumber);
      }
      if (scanned.secondDuplicateValue) {
        verifyPrimitiveCellEdit(scanned.secondDuplicateValue);
      }

      // Also verify extras (+N field) on array-of-objects-25-cols
      if (rootView.kind === 'array-of-objects' && rootView.hasExtraFieldsColumn) {
        const colRow = rootView.rows[0];
        expect(colRow?.kind).toBe('columns');
        if (colRow?.kind === 'columns' && colRow.extraFields) {
          const extraView = colRow.extraFields.expand();
          expect(extraView.kind).toBe('object');
          const extraRow = extraView.rows[0]!;
          const extraEdit = setValue(doc, extraRow.nodeRef, '9999');
          expect(extraEdit.ok).toBe(true);
          if (extraEdit.ok && extraEdit.edit) {
            assertSplicePreservesOutsideBytes(
              expectedSourceBytes,
              doc.source,
              extraEdit.source,
              extraEdit.edit,
            );
          }
        }
      }

      // 5. Structural insert/remove at first/last/empty container when root is a container:
      //    asserts outside-splice bytes, EOL consistency, strict reparse, and remove(insert(doc)) === original bytes.
      if (doc.root.kind === 'object') {
        const rootRef: JsonNodeRef = {
          revision: doc.revision,
          nodeId: doc.root.id,
          span: doc.root.span,
          parentId: null,
        };
        const insFirst = insertField(doc, rootRef, '__corpus_first__', {
          index: 0,
          initialValueLexeme: '1',
        });
        expect(insFirst.ok).toBe(true);
        if (insFirst.ok && insFirst.edit) {
          assertSplicePreservesOutsideBytes(
            expectedSourceBytes,
            doc.source,
            insFirst.source,
            insFirst.edit,
          );
          if (entry.eol === 'cr') {
            expect(insFirst.edit.content).toContain('\r');
            expect(insFirst.edit.content).not.toContain('\n');
          }
          const insFirstBytes = utf8Encoder.encode(insFirst.source);
          const remFirst = removeField(
            insFirst.document,
            {
              revision: insFirst.document.revision,
              nodeId: insFirst.document.root.id,
              span: insFirst.document.root.span,
              parentId: null,
            },
            { key: '__corpus_first__', occurrenceIndex: 0 },
          );
          expect(remFirst.ok).toBe(true);
          if (remFirst.ok && remFirst.edit) {
            assertSplicePreservesOutsideBytes(
              insFirstBytes,
              insFirst.source,
              remFirst.source,
              remFirst.edit,
            );
            expectBytesEqual(utf8Encoder.encode(remFirst.source), expectedSourceBytes);
          }
        }

        const insLast = insertField(doc, rootRef, '__corpus_last__', {
          initialValueLexeme: '"tail"',
        });
        expect(insLast.ok).toBe(true);
        if (insLast.ok && insLast.edit && insLast.document.root.kind === 'object') {
          assertSplicePreservesOutsideBytes(
            expectedSourceBytes,
            doc.source,
            insLast.source,
            insLast.edit,
          );
          const insLastBytes = utf8Encoder.encode(insLast.source);
          const lastIdx = insLast.document.root.properties.length - 1;
          const remLast = removeField(
            insLast.document,
            {
              revision: insLast.document.revision,
              nodeId: insLast.document.root.id,
              span: insLast.document.root.span,
              parentId: null,
            },
            { propertyIndex: lastIdx },
          );
          expect(remLast.ok).toBe(true);
          if (remLast.ok && remLast.edit) {
            assertSplicePreservesOutsideBytes(
              insLastBytes,
              insLast.source,
              remLast.source,
              remLast.edit,
            );
            expectBytesEqual(utf8Encoder.encode(remLast.source), expectedSourceBytes);
          }
        }
      } else if (doc.root.kind === 'array' && doc.maxDepth <= 1000) {
        const rootRef: JsonNodeRef = {
          revision: doc.revision,
          nodeId: doc.root.id,
          span: doc.root.span,
          parentId: null,
        };
        const insFirst = insertRow(doc, rootRef, { index: 0 });
        expect(insFirst.ok).toBe(true);
        if (insFirst.ok && insFirst.edit) {
          assertSplicePreservesOutsideBytes(
            expectedSourceBytes,
            doc.source,
            insFirst.source,
            insFirst.edit,
          );
          const insFirstBytes = utf8Encoder.encode(insFirst.source);
          const remFirst = removeRow(
            insFirst.document,
            {
              revision: insFirst.document.revision,
              nodeId: insFirst.document.root.id,
              span: insFirst.document.root.span,
              parentId: null,
            },
            0,
          );
          expect(remFirst.ok).toBe(true);
          if (remFirst.ok && remFirst.edit) {
            assertSplicePreservesOutsideBytes(
              insFirstBytes,
              insFirst.source,
              remFirst.source,
              remFirst.edit,
            );
            expectBytesEqual(utf8Encoder.encode(remFirst.source), expectedSourceBytes);
          }
        }

        const insLast = insertRow(doc, rootRef);
        expect(insLast.ok).toBe(true);
        if (insLast.ok && insLast.edit && insLast.document.root.kind === 'array') {
          assertSplicePreservesOutsideBytes(
            expectedSourceBytes,
            doc.source,
            insLast.source,
            insLast.edit,
          );
          const insLastBytes = utf8Encoder.encode(insLast.source);
          const lastIdx = insLast.document.root.elements.length - 1;
          const remLast = removeRow(
            insLast.document,
            {
              revision: insLast.document.revision,
              nodeId: insLast.document.root.id,
              span: insLast.document.root.span,
              parentId: null,
            },
            lastIdx,
          );
          expect(remLast.ok).toBe(true);
          if (remLast.ok && remLast.edit) {
            assertSplicePreservesOutsideBytes(
              insLastBytes,
              insLast.source,
              remLast.source,
              remLast.edit,
            );
            expectBytesEqual(utf8Encoder.encode(remLast.source), expectedSourceBytes);
          }
        }
      }

      // 6. Format verification: depth <= 1000 formats and preserves exact token sequence
      //    (verified both with areNonWhitespaceTokensIdentical AND an independent regex oracle);
      //    depth > 1000 (deep-10000-array) is rejected with DEPTH_LIMIT_EXCEEDED.
      const fmtRes = formatJsonStrict(doc);
      if (doc.maxDepth > 1000) {
        expect(fmtRes.ok).toBe(false);
        if (!fmtRes.ok) {
          expect(fmtRes.error.code).toBe('DEPTH_LIMIT_EXCEEDED');
        }
      } else {
        expect(fmtRes.ok).toBe(true);
        if (fmtRes.ok) {
          expect(areNonWhitespaceTokensIdentical(doc.source, fmtRes.text)).toBe(true);
          expect(stripWhitespaceOutsideStringsOracle(fmtRes.text)).toBe(
            stripWhitespaceOutsideStringsOracle(doc.source),
          );
        }
      }
    },
  );

  it('handles the two-BOM file: strips first BOM, rejects second U+FEFF as JSON whitespace, and preserves second BOM for Save as text (Q8)', () => {
    expect(twoBomFixture).toBeDefined();
    const rawBytes = new Uint8Array(
      fs.readFileSync(path.join(CORPUS_DIR, twoBomFixture!.file)),
    );
    // Starts with EF BB BF EF BB BF
    expect(Array.from(rawBytes.subarray(0, 6))).toEqual([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]);

    const decoded = decodeUtf8FileStrict(rawBytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    expect(decoded.hadBom).toBe(true);
    // First BOM stripped; second U+FEFF remains at index 0
    expect(decoded.text.charCodeAt(0)).toBe(0xfeff);
    expect(decoded.text).toBe('\uFEFF{"a":1}');

    // Strict JSON parser rejects the remaining U+FEFF because U+FEFF is not RFC 8259 whitespace
    const parsed = parseJsonStrict(decoded.text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe('BOM_NOT_WHITESPACE');
      expect(parsed.error.offset).toBe(0);
      expect(parsed.error.line).toBe(1);
      expect(parsed.error.column).toBe(1);
    }

    // "Save as text" uses `decoded.text`, keeping the second BOM intact
    const textEntryBytes = utf8Encoder.encode(decoded.text);
    expectBytesEqual(textEntryBytes, rawBytes.subarray(3));
  });

  it.each(invalidUtf8Fixtures)(
    '[$id] rejects malformed UTF-8 byte fixture without emitting U+FFFD (P04-A7)',
    (entry) => {
      const rawBytes = new Uint8Array(fs.readFileSync(path.join(CORPUS_DIR, entry.file)));
      const decoded = decodeUtf8FileStrict(rawBytes);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) {
        expect(decoded.error.code).toBe('INVALID_UTF8');
        expect('text' in decoded).toBe(false);
        expect(Object.keys(decoded)).toEqual(['ok', 'error']);
      }
    },
  );

  it('verifies offset <-> line/column round-trip across CRLF and astral characters in corpus fixtures', () => {
    const sample = '{\r\n  "astral": "😀🚀",\r\n  "num": 9007199254740993\r\n}';
    for (let offset = 0; offset <= sample.length; offset++) {
      // Skip the '\n' half of '\r\n' where lineColumnToOffset maps to the start of the line
      if (offset > 0 && sample[offset - 1] === '\r' && sample[offset] === '\n') {
        continue;
      }
      const { line, column } = offsetToLineColumn(sample, offset);
      expect(lineColumnToOffset(sample, line, column)).toBe(offset);
    }
  });
});
