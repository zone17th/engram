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

/**
 * Finds the first editable primitive node in `document` using an explicit stack (zero recursion)
 * so it works even on 10,000-deep fixtures.
 */
function findFirstEditablePrimitive(
  document: JsonDocument,
): { node: JsonPrimitiveNode; ref: JsonNodeRef } | null {
  const stack: JsonNode[] = [document.root];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    if (curr.kind === 'object') {
      for (let i = curr.properties.length - 1; i >= 0; i--) {
        stack.push(curr.properties[i]!.valueNode);
      }
    } else if (curr.kind === 'array') {
      for (let i = curr.elements.length - 1; i >= 0; i--) {
        stack.push(curr.elements[i]!);
      }
    } else {
      if (curr.kind === 'string' && (curr.hasLoneSurrogate || curr.hasCarriageReturn)) {
        continue;
      }
      const parent = document.parentById.get(curr.id) ?? null;
      return {
        node: curr,
        ref: {
          revision: document.revision,
          nodeId: curr.id,
          span: curr.span,
          parentId: parent ? parent.id : null,
        },
      };
    }
  }
  return null;
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
      expect(reencodedSourceBytes).toEqual(expectedSourceBytes);

      // 2. EOL detection matches manifest
      const eolInfo = detectEol(decoded.text);
      expect(eolInfo.kind).toBe(entry.eol);

      // Raw textarea no-op round-trip: if user opens Raw JSON and clicks Save without editing,
      // applyTextareaEol reports changed=false and keeps original bytes intact.
      const noopTextareaPlan = applyTextareaEol(
        decoded.text,
        normalizeEolToLf(decoded.text),
      );
      expect(noopTextareaPlan.changed).toBe(false);
      expect(utf8Encoder.encode(noopTextareaPlan.text)).toEqual(expectedSourceBytes);

      // 3. Strict iterative parse + lazy root table view build (no stack overflow)
      const parsed = parseJsonStrict(decoded.text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const doc = parsed.document;
      const rootView = buildRootTableView(doc);
      expect(rootView).toBeDefined();

      // 4. Locate first editable primitive cell (if the fixture has one) and verify:
      //    (a) Unchanged commit is a no-op and byte-identical.
      //    (b) Editing the cell splices ONLY the target span: every UTF-8 byte before and after
      //        the edited span is 100% byte-identical to `expectedSourceBytes`.
      //    (c) Setting a string cell (or converting cell to string and setting `42`) produces `"42"`.
      const target = findFirstEditablePrimitive(doc);
      if (target) {
        const currentDisplay = getDisplayValueForPrimitive(target.node);
        const noopOutcome = setValue(doc, target.ref, currentDisplay);
        expect(noopOutcome.ok).toBe(true);
        if (noopOutcome.ok) {
          expect(noopOutcome.changed).toBe(false);
          expect(noopOutcome.edit).toBeNull();
          expect(utf8Encoder.encode(noopOutcome.source)).toEqual(expectedSourceBytes);
        }

        // Perform a real edit on `target`
        const prefixText = doc.source.slice(0, target.node.span.start);
        const suffixText = doc.source.slice(target.node.span.end);
        const prefixBytes = utf8Encoder.encode(prefixText);
        const suffixBytes = utf8Encoder.encode(suffixText);

        let editedOutcome;
        if (target.node.kind === 'string') {
          // Typing 42 into a string cell must produce "42"
          editedOutcome = setValue(doc, target.ref, '42');
        } else if (target.node.kind === 'number') {
          const nextNum = target.node.lexeme === '42' ? '9007199254740993' : '42';
          editedOutcome = setValue(doc, target.ref, nextNum);
        } else if (target.node.kind === 'boolean') {
          editedOutcome = setValue(doc, target.ref, target.node.value ? 'false' : 'true');
        } else {
          editedOutcome = changeCellType(doc, target.ref, 'string');
          if (editedOutcome.ok) {
            const nextTarget = findFirstEditablePrimitive(editedOutcome.document)!;
            editedOutcome = setValue(editedOutcome.document, nextTarget.ref, '42');
          }
        }

        expect(editedOutcome.ok).toBe(true);
        if (editedOutcome.ok) {
          const editedBytes = utf8Encoder.encode(editedOutcome.source);
          // Compare UTF-8 bytes outside the edited span (prefix and suffix must be byte-identical!)
          const actualPrefixBytes = editedBytes.subarray(0, prefixBytes.byteLength);
          const actualSuffixBytes = editedBytes.subarray(
            editedBytes.byteLength - suffixBytes.byteLength,
          );
          expect(actualPrefixBytes).toEqual(prefixBytes);
          expect(actualSuffixBytes).toEqual(suffixBytes);

          if (target.node.kind === 'string') {
            const middleBytes = editedBytes.subarray(
              prefixBytes.byteLength,
              editedBytes.byteLength - suffixBytes.byteLength,
            );
            expect(middleBytes).toEqual(utf8Encoder.encode('"42"'));
          }
        }
      }

      // 5. Structural insert/remove at first/last/empty container when root is a container
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
        if (insFirst.ok) {
          const remFirst = removeField(insFirst.document, {
            revision: insFirst.document.revision,
            nodeId: insFirst.document.root.id,
            span: insFirst.document.root.span,
            parentId: null,
          }, { propertyIndex: 0 });
          expect(remFirst.ok).toBe(true);
        }

        const insLast = insertField(doc, rootRef, '__corpus_last__', {
          initialValueLexeme: '"tail"',
        });
        expect(insLast.ok).toBe(true);
        if (insLast.ok && insLast.document.root.kind === 'object') {
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
        if (insFirst.ok) {
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
        }

        const insLast = insertRow(doc, rootRef);
        expect(insLast.ok).toBe(true);
        if (insLast.ok && insLast.document.root.kind === 'array') {
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
        }
      }

      // 6. Format verification: depth <= 1000 formats and preserves exact token sequence;
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
    expect(textEntryBytes).toEqual(rawBytes.subarray(3));
  });

  it.each(invalidUtf8Fixtures)(
    '[$id] rejects malformed UTF-8 byte fixture without emitting U+FFFD (P04-A7)',
    (entry) => {
      const rawBytes = new Uint8Array(fs.readFileSync(path.join(CORPUS_DIR, entry.file)));
      const decoded = decodeUtf8FileStrict(rawBytes);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) {
        expect(decoded.error.code).toBe('INVALID_UTF8');
        expect(decoded.error.message).not.toContain('\uFFFD');
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
