import { describe, expect, it } from 'vitest';
import {
  changeCellType,
  escapeJsonStringMinimal,
  insertField,
  insertRow,
  removeField,
  removeRow,
  setValue,
} from './edit';
import { buildRootTableView } from './model';
import { parseJsonStrict } from './parse';

const encoder = new TextEncoder();

describe('lib/json/edit', () => {
  it('encodes strings with minimal escaping (only ", \\, and U+0000..U+001F)', () => {
    expect(escapeJsonStringMinimal('42')).toBe('"42"');
    expect(escapeJsonStringMinimal('café 😀 https://engram.zone17.click/a/b')).toBe(
      '"café 😀 https://engram.zone17.click/a/b"',
    );
    expect(escapeJsonStringMinimal('quote " backslash \\ tab \t lf \n cr \r nul \u0000')).toBe(
      '"quote \\" backslash \\\\ tab \\t lf \\n cr \\r nul \\u0000"',
    );
  });

  it('Rule 1: preserves cell type (typing 42 into a string cell writes "42") and validates number lexemes', () => {
    const parsed = parseJsonStrict('{\n  "str": "hello",\n  "num": 9007199254740993\n}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    if (view.kind !== 'object') return;
    const strRef = view.rows[0]!.valueCell.nodeRef;
    const numRef = view.rows[1]!.valueCell.nodeRef;

    const strEdit = setValue(parsed.document, strRef, '42');
    expect(strEdit.ok).toBe(true);
    if (!strEdit.ok) return;
    expect(strEdit.changed).toBe(true);
    expect(strEdit.source).toBe('{\n  "str": "42",\n  "num": 9007199254740993\n}');

    // Invalid number lexeme rejected without modifying document
    const view2 = buildRootTableView(strEdit.document);
    if (view2.kind !== 'object') return;
    const numRef2 = view2.rows[1]!.valueCell.nodeRef;

    const badNum = setValue(strEdit.document, numRef2, '01');
    expect(badNum.ok).toBe(false);
    if (!badNum.ok) {
      expect(badNum.error.code).toBe('INVALID_NUMBER_LEXEME');
    }

    // Valid huge number lexeme preserved verbatim
    const goodNum = setValue(strEdit.document, numRef2, '9007199254740995');
    expect(goodNum.ok).toBe(true);
    if (goodNum.ok) {
      expect(goodNum.source).toBe('{\n  "str": "42",\n  "num": 9007199254740995\n}');
    }

    // Stale ref rejected with STALE_SPAN
    const staleAttempt = setValue(strEdit.document, numRef, '10');
    expect(staleAttempt.ok).toBe(false);
    if (!staleAttempt.ok) {
      expect(staleAttempt.error.code).toBe('STALE_SPAN');
    }
  });

  it('Rule 1: changes cell primitive type via changeCellType with specified defaults', () => {
    const parsed = parseJsonStrict('{"a": "1e400", "b": "hello", "c": true}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view1 = buildRootTableView(parsed.document);
    if (view1.kind !== 'object') return;

    // String with valid JSON number -> number keeps the exact lexeme "1e400"
    const toNumValid = changeCellType(
      parsed.document,
      view1.rows[0]!.valueCell.nodeRef,
      'number',
    );
    expect(toNumValid.ok).toBe(true);
    if (!toNumValid.ok) return;
    expect(toNumValid.source).toBe('{"a": 1e400, "b": "hello", "c": true}');

    // String with non-numeric text -> number defaults to 0
    const view2 = buildRootTableView(toNumValid.document);
    if (view2.kind !== 'object') return;
    const toNumDefault = changeCellType(
      toNumValid.document,
      view2.rows[1]!.valueCell.nodeRef,
      'number',
    );
    expect(toNumDefault.ok).toBe(true);
    if (!toNumDefault.ok) return;
    expect(toNumDefault.source).toBe('{"a": 1e400, "b": 0, "c": true}');

    // Number -> string defaults to ""
    const view3 = buildRootTableView(toNumDefault.document);
    if (view3.kind !== 'object') return;
    const toStr = changeCellType(
      toNumDefault.document,
      view3.rows[1]!.valueCell.nodeRef,
      'string',
    );
    expect(toStr.ok).toBe(true);
    if (!toStr.ok) return;
    expect(toStr.source).toBe('{"a": 1e400, "b": "", "c": true}');

    // Boolean -> null
    const view4 = buildRootTableView(toStr.document);
    if (view4.kind !== 'object') return;
    const toNull = changeCellType(toStr.document, view4.rows[2]!.valueCell.nodeRef, 'null');
    expect(toNull.ok).toBe(true);
    if (!toNull.ok) return;
    expect(toNull.source).toBe('{"a": 1e400, "b": "", "c": null}');
  });

  it('Rule 2: no-op commit produces no splice and keeps source byte-identical (including \\u00e9 escapes)', () => {
    const src = '{\r\n  "word": "caf\\u00e9",\r\n  "num": 0.10\r\n}\r\n';
    const parsed = parseJsonStrict(src);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    if (view.kind !== 'object') return;

    // Display text of "caf\\u00e9" is "café". Committing "café" must be a no-op!
    const noopStr = setValue(parsed.document, view.rows[0]!.valueCell.nodeRef, 'café');
    expect(noopStr.ok).toBe(true);
    if (noopStr.ok) {
      expect(noopStr.changed).toBe(false);
      expect(noopStr.edit).toBeNull();
      expect(noopStr.source).toBe(src);
      expect(encoder.encode(noopStr.source)).toEqual(encoder.encode(src));
    }

    const noopNum = setValue(parsed.document, view.rows[1]!.valueCell.nodeRef, '0.10');
    expect(noopNum.ok).toBe(true);
    if (noopNum.ok) {
      expect(noopNum.changed).toBe(false);
      expect(noopNum.edit).toBeNull();
      expect(noopNum.source).toBe(src);
    }
  });

  it('Rule 3: rejects editing read-only string cells (lone surrogate or \\r)', () => {
    const parsed = parseJsonStrict('{"surr": "\\ud800", "cr": "line1\\r\\nline2"}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    if (view.kind !== 'object') return;

    const surrEdit = setValue(parsed.document, view.rows[0]!.valueCell.nodeRef, 'replaced');
    expect(surrEdit.ok).toBe(false);
    if (!surrEdit.ok) {
      expect(surrEdit.error.code).toBe('READ_ONLY_CELL');
    }

    const crEdit = setValue(parsed.document, view.rows[1]!.valueCell.nodeRef, 'replaced');
    expect(crEdit.ok).toBe(false);
    if (!crEdit.ok) {
      expect(crEdit.error.code).toBe('READ_ONLY_CELL');
    }
  });

  it('Rule 5: inserts and removes fields/rows at first/last/empty positions preserving sibling indent and majority EOL', () => {
    // 1. Empty single-line containers [] and {} receive element on the same line
    const emptyArr = parseJsonStrict('[]');
    expect(emptyArr.ok).toBe(true);
    if (emptyArr.ok) {
      const view = buildRootTableView(emptyArr.document);
      if (view.kind === 'primitive-array') {
        const ins = insertRow(emptyArr.document, view.containerRef, { valueLexeme: '1' });
        expect(ins.ok).toBe(true);
        if (ins.ok) {
          expect(ins.source).toBe('[1]');
          // Removing the only element returns to []
          const v2 = buildRootTableView(ins.document);
          if (v2.kind === 'primitive-array') {
            const rem = removeRow(ins.document, v2.rows[0]!.elementRef);
            expect(rem.ok).toBe(true);
            if (rem.ok) {
              expect(rem.source).toBe('[]');
            }
          }
        }
      }
    }

    const emptyObj = parseJsonStrict('{}');
    expect(emptyObj.ok).toBe(true);
    if (emptyObj.ok) {
      const view = buildRootTableView(emptyObj.document);
      if (view.kind === 'object') {
        const ins = insertField(emptyObj.document, view.containerRef, 'k', {
          initialValueLexeme: '"v"',
        });
        expect(ins.ok).toBe(true);
        if (ins.ok) {
          expect(ins.source).toBe('{"k": "v"}');
          const v2 = buildRootTableView(ins.document);
          if (v2.kind === 'object') {
            const rem = removeField(ins.document, v2.rows[0]!.nodeRef);
            expect(rem.ok).toBe(true);
            if (rem.ok) {
              expect(rem.source).toBe('{}');
            }
          }
        }
      }
    }

    // 2. Multiline CRLF object with 4-space sibling indentation:
    // Inserting at end takes sibling's 4-space indent + CRLF; inserting at index 0 uses parent+2 spaces + CRLF.
    const crlfObjSrc = '{\r\n    "a": 1,\r\n    "b": 2\r\n}';
    const crlfObj = parseJsonStrict(crlfObjSrc);
    expect(crlfObj.ok).toBe(true);
    if (crlfObj.ok) {
      const view = buildRootTableView(crlfObj.document);
      if (view.kind === 'object') {
        // Duplicate key rejected with KEY_EXISTS ("Key đã có")
        const dup = insertField(crlfObj.document, view.containerRef, 'a');
        expect(dup.ok).toBe(false);
        if (!dup.ok) {
          expect(dup.error.code).toBe('KEY_EXISTS');
        }

        // Insert at end -> uses preceding sibling's 4-space indent and CRLF
        const insEnd = insertField(crlfObj.document, view.containerRef, 'c', {
          initialValueLexeme: '3',
        });
        expect(insEnd.ok).toBe(true);
        if (insEnd.ok) {
          expect(insEnd.source).toBe('{\r\n    "a": 1,\r\n    "b": 2,\r\n    "c": 3\r\n}');

          // Remove first field ("a") -> leaves "b" and "c" valid
          const v2 = buildRootTableView(insEnd.document);
          if (v2.kind === 'object') {
            const remFirst = removeField(insEnd.document, v2.rows[0]!.nodeRef);
            expect(remFirst.ok).toBe(true);
            if (remFirst.ok) {
              expect(remFirst.source).toBe('{\r\n    "b": 2,\r\n    "c": 3\r\n}');

              // Remove last field ("c") -> leaves only "b" without trailing comma
              const v3 = buildRootTableView(remFirst.document);
              if (v3.kind === 'object') {
                const remLast = removeField(remFirst.document, v3.rows[1]!.nodeRef);
                expect(remLast.ok).toBe(true);
                if (remLast.ok) {
                  expect(remLast.source).toBe('{\r\n    "b": 2\r\n}');
                }
              }
            }
          }
        }
      }
    }

    // 3. Array of objects: new row initializes all current union columns to null
    const aooSrc = '[\n  { "id": 1, "name": "alice" },\n  { "id": 2, "role": "admin" }\n]';
    const aoo = parseJsonStrict(aooSrc);
    expect(aoo.ok).toBe(true);
    if (aoo.ok) {
      const view = buildRootTableView(aoo.document);
      if (view.kind === 'array-of-objects') {
        const insRow = insertRow(aoo.document, view.containerRef);
        expect(insRow.ok).toBe(true);
        if (insRow.ok) {
          expect(insRow.source).toBe(
            '[\n  { "id": 1, "name": "alice" },\n  { "id": 2, "role": "admin" },\n  { "id": null, "name": null, "role": null }\n]',
          );
        }
      }
    }
  });
});
