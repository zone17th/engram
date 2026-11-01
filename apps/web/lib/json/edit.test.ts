import { describe, expect, it } from 'vitest';
import {
  changeCellType,
  escapeJsonStringMinimal,
  insertField,
  insertRow,
  removeField,
  removeRow,
  removeRowAt,
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
    expect.hasAssertions();
    const parsed = parseJsonStrict('{\n  "str": "hello",\n  "num": 9007199254740993\n}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    expect(view.kind).toBe('object');
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
    expect(view2.kind).toBe('object');
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
    expect.hasAssertions();
    const parsed = parseJsonStrict('{"a": "1e400", "b": "hello", "c": true}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view1 = buildRootTableView(parsed.document);
    expect(view1.kind).toBe('object');
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
    expect(view2.kind).toBe('object');
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
    expect(view3.kind).toBe('object');
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
    expect(view4.kind).toBe('object');
    if (view4.kind !== 'object') return;
    const toNull = changeCellType(toStr.document, view4.rows[2]!.valueCell.nodeRef, 'null');
    expect(toNull.ok).toBe(true);
    if (!toNull.ok) return;
    expect(toNull.source).toBe('{"a": 1e400, "b": "", "c": null}');
  });

  it('Rule 2: no-op commit produces no splice and keeps source byte-identical (including \\u00e9 escapes)', () => {
    expect.hasAssertions();
    const src = '{\r\n  "word": "caf\\u00e9",\r\n  "num": 0.10\r\n}\r\n';
    const parsed = parseJsonStrict(src);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    expect(view.kind).toBe('object');
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
    expect.hasAssertions();
    const parsed = parseJsonStrict('{"surr": "\\ud800", "cr": "line1\\r\\nline2"}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    expect(view.kind).toBe('object');
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
    expect.hasAssertions();
    // 1. Empty single-line containers [] and {} receive element on the same line
    const emptyArr = parseJsonStrict('[]');
    expect(emptyArr.ok).toBe(true);
    if (emptyArr.ok) {
      const view = buildRootTableView(emptyArr.document);
      expect(view.kind).toBe('primitive-array');
      if (view.kind === 'primitive-array') {
        const ins = insertRow(emptyArr.document, view.containerRef, { valueLexeme: '1' });
        expect(ins.ok).toBe(true);
        if (ins.ok) {
          expect(ins.source).toBe('[1]');
          // Removing the only element returns to []
          const v2 = buildRootTableView(ins.document);
          expect(v2.kind).toBe('primitive-array');
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
      expect(view.kind).toBe('object');
      if (view.kind === 'object') {
        const ins = insertField(emptyObj.document, view.containerRef, 'k', {
          initialValueLexeme: '"v"',
        });
        expect(ins.ok).toBe(true);
        if (ins.ok) {
          expect(ins.source).toBe('{"k": "v"}');
          const v2 = buildRootTableView(ins.document);
          expect(v2.kind).toBe('object');
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
    // Inserting at end takes sibling's 4-space indent + CRLF; inserting at index 0 takes first sibling's 4-space indent + CRLF without touching the old first line (JL1-4).
    const crlfObjSrc = '{\r\n    "a": 1,\r\n    "b": 2\r\n}';
    const crlfObj = parseJsonStrict(crlfObjSrc);
    expect(crlfObj.ok).toBe(true);
    if (crlfObj.ok) {
      const view = buildRootTableView(crlfObj.document);
      expect(view.kind).toBe('object');
      if (view.kind === 'object') {
        // Duplicate key rejected with KEY_EXISTS ("Key đã có")
        const dup = insertField(crlfObj.document, view.containerRef, 'a');
        expect(dup.ok).toBe(false);
        if (!dup.ok) {
          expect(dup.error.code).toBe('KEY_EXISTS');
        }

        // Insert at index 0 -> uses first sibling's 4-space indent and leaves old first line untouched
        const insFirst = insertField(crlfObj.document, view.containerRef, 'z', {
          index: 0,
          initialValueLexeme: '0',
        });
        expect(insFirst.ok).toBe(true);
        if (insFirst.ok) {
          expect(insFirst.source).toBe(
            '{\r\n    "z": 0,\r\n    "a": 1,\r\n    "b": 2\r\n}',
          );
        }

        // Insert at middle (index 1) -> uses preceding sibling's 4-space indent and CRLF
        const insMid = insertField(crlfObj.document, view.containerRef, 'm', {
          index: 1,
          initialValueLexeme: '15',
        });
        expect(insMid.ok).toBe(true);
        if (insMid.ok) {
          expect(insMid.source).toBe(
            '{\r\n    "a": 1,\r\n    "m": 15,\r\n    "b": 2\r\n}',
          );
        }

        // Insert at end -> uses preceding sibling's 4-space indent and CRLF
        const insEnd = insertField(crlfObj.document, view.containerRef, 'c', {
          initialValueLexeme: '3',
        });
        expect(insEnd.ok).toBe(true);
        if (insEnd.ok) {
          expect(insEnd.source).toBe('{\r\n    "a": 1,\r\n    "b": 2,\r\n    "c": 3\r\n}');

          // Remove middle field ("b") -> leaves "a" and "c" valid
          const vMid = buildRootTableView(insEnd.document);
          expect(vMid.kind).toBe('object');
          if (vMid.kind === 'object') {
            const remMid = removeField(insEnd.document, vMid.rows[1]!.nodeRef);
            expect(remMid.ok).toBe(true);
            if (remMid.ok) {
              expect(remMid.source).toBe('{\r\n    "a": 1,\r\n    "c": 3\r\n}');
            }
          }

          // Remove first field ("a") -> leaves "b" and "c" valid
          const v2 = buildRootTableView(insEnd.document);
          expect(v2.kind).toBe('object');
          if (v2.kind === 'object') {
            const remFirst = removeField(insEnd.document, v2.rows[0]!.nodeRef);
            expect(remFirst.ok).toBe(true);
            if (remFirst.ok) {
              expect(remFirst.source).toBe('{\r\n    "b": 2,\r\n    "c": 3\r\n}');

              // Remove last field ("c") -> leaves only "b" without trailing comma
              const v3 = buildRootTableView(remFirst.document);
              expect(v3.kind).toBe('object');
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
      expect(view.kind).toBe('array-of-objects');
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

  it('handles index-0, middle, and last inserts for 2-space, 4-space, tab, CRLF, and lone-CR without re-indenting existing lines (JL1-4, JL1-6, JL1-11)', () => {
    expect.hasAssertions();
    // 2-space LF array: index 0, middle, last + removeRow first, middle, last
    const twoSpace = parseJsonStrict('[\n  10,\n  20\n]');
    expect(twoSpace.ok).toBe(true);
    if (twoSpace.ok) {
      const view = buildRootTableView(twoSpace.document);
      expect(view.kind).toBe('primitive-array');
      if (view.kind === 'primitive-array') {
        const ins0 = insertRow(twoSpace.document, view.containerRef, {
          index: 0,
          valueLexeme: '5',
        });
        expect(ins0.ok).toBe(true);
        if (ins0.ok) {
          expect(ins0.source).toBe('[\n  5,\n  10,\n  20\n]');
          // Bytes from old first line onward (`  10,\n  20\n]`) are untouched
          expect(ins0.source.slice(ins0.edit!.offset + ins0.edit!.content.length)).toBe(
            '  10,\n  20\n]',
          );
          const v0 = buildRootTableView(ins0.document);
          expect(v0.kind).toBe('primitive-array');
          if (v0.kind === 'primitive-array') {
            const rem0 = removeRow(ins0.document, v0.containerRef, 0);
            expect(rem0.ok).toBe(true);
            if (rem0.ok) {
              expect(rem0.source).toBe('[\n  10,\n  20\n]');
            }
          }
        }

        const insMid = insertRow(twoSpace.document, view.containerRef, {
          index: 1,
          valueLexeme: '15',
        });
        expect(insMid.ok).toBe(true);
        if (insMid.ok) {
          expect(insMid.source).toBe('[\n  10,\n  15,\n  20\n]');
          const vMid = buildRootTableView(insMid.document);
          expect(vMid.kind).toBe('primitive-array');
          if (vMid.kind === 'primitive-array') {
            const remMid = removeRow(insMid.document, vMid.containerRef, 1);
            expect(remMid.ok).toBe(true);
            if (remMid.ok) {
              expect(remMid.source).toBe('[\n  10,\n  20\n]');
            }
          }
        }
      }
    }

    // Tab-indented array: index 0, middle, last
    const tabArr = parseJsonStrict('[\n\t1,\n\t2\n]');
    expect(tabArr.ok).toBe(true);
    if (tabArr.ok) {
      const view = buildRootTableView(tabArr.document);
      expect(view.kind).toBe('primitive-array');
      if (view.kind === 'primitive-array') {
        const ins0 = insertRow(tabArr.document, view.containerRef, {
          index: 0,
          valueLexeme: '0',
        });
        expect(ins0.ok).toBe(true);
        if (ins0.ok) {
          expect(ins0.source).toBe('[\n\t0,\n\t1,\n\t2\n]');
        }

        const insMid = insertRow(tabArr.document, view.containerRef, {
          index: 1,
          valueLexeme: '15',
        });
        expect(insMid.ok).toBe(true);
        if (insMid.ok) {
          expect(insMid.source).toBe('[\n\t1,\n\t15,\n\t2\n]');
        }

        const insLast = insertRow(tabArr.document, view.containerRef, {
          valueLexeme: '3',
        });
        expect(insLast.ok).toBe(true);
        if (insLast.ok) {
          expect(insLast.source).toBe('[\n\t1,\n\t2,\n\t3\n]');
        }
      }
    }

    // Pure lone-CR document uses \r on insert (advisor-dec-126 / JL1-11)
    const loneCrArr = parseJsonStrict('[\r  1,\r  2\r]');
    expect(loneCrArr.ok).toBe(true);
    if (loneCrArr.ok) {
      const view = buildRootTableView(loneCrArr.document);
      expect(view.kind).toBe('primitive-array');
      if (view.kind === 'primitive-array') {
        const ins0 = insertRow(loneCrArr.document, view.containerRef, {
          index: 0,
          valueLexeme: '0',
        });
        expect(ins0.ok).toBe(true);
        if (ins0.ok) {
          expect(ins0.source).toBe('[\r  0,\r  1,\r  2\r]');
        }
        const insLast = insertRow(loneCrArr.document, view.containerRef, {
          valueLexeme: '3',
        });
        expect(insLast.ok).toBe(true);
        if (insLast.ok) {
          expect(insLast.source).toBe('[\r  1,\r  2,\r  3\r]');
        }
      }
    }

    // Multi-line empty container (`[\n]` and `{\r\n  }`)
    const multiEmptyArr = parseJsonStrict('[\n]');
    expect(multiEmptyArr.ok).toBe(true);
    if (multiEmptyArr.ok) {
      const view = buildRootTableView(multiEmptyArr.document);
      expect(view.kind).toBe('primitive-array');
      if (view.kind === 'primitive-array') {
        const ins = insertRow(multiEmptyArr.document, view.containerRef, { valueLexeme: '42' });
        expect(ins.ok).toBe(true);
        if (ins.ok) {
          expect(ins.source).toBe('[\n  42\n]');
        }
      }
    }

    // 20-column cap on insertRow into array-of-objects with 25 distinct keys
    const pairs25 = Array.from({ length: 25 }, (_, i) => `"k${i + 1}": ${i + 1}`).join(', ');
    const aoo25 = parseJsonStrict(`[{ ${pairs25} }]`);
    expect(aoo25.ok).toBe(true);
    if (aoo25.ok) {
      const view = buildRootTableView(aoo25.document);
      expect(view.kind).toBe('array-of-objects');
      if (view.kind === 'array-of-objects') {
        const ins = insertRow(aoo25.document, view.containerRef);
        expect(ins.ok).toBe(true);
        if (ins.ok && ins.document.root.kind === 'array') {
          const newRow = ins.document.root.elements[1]!;
          expect(newRow.kind).toBe('object');
          if (newRow.kind === 'object') {
            expect(newRow.properties).toHaveLength(20);
            expect(newRow.properties[0]!.key).toBe('k1');
            expect(newRow.properties[19]!.key).toBe('k20');
          }
        }
      }
    }
  });

  it('rejects renaming a property key to an existing sibling key with KEY_EXISTS, including duplicate-key docs (JL1-5)', () => {
    expect.hasAssertions();
    const parsed = parseJsonStrict('{"a": 1, "b": 2}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    expect(view.kind).toBe('object');
    if (view.kind !== 'object') return;

    // Renaming "b" -> "a" must fail with KEY_EXISTS
    const collide = setValue(parsed.document, view.rows[1]!.keyCell.nodeRef, 'a');
    expect(collide.ok).toBe(false);
    if (!collide.ok) {
      expect(collide.error.code).toBe('KEY_EXISTS');
    }

    // Renaming "b" -> "c" succeeds
    const renamed = setValue(parsed.document, view.rows[1]!.keyCell.nodeRef, 'c');
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(renamed.source).toBe('{"a": 1, "c": 2}');
    }

    // Duplicate-key doc: renaming one occurrence of "a" to "a" is a no-op, renaming to another existing key "b" -> KEY_EXISTS, renaming to "unique" succeeds
    const dupParsed = parseJsonStrict('{"a": 1, "a": 2, "b": 3}');
    expect(dupParsed.ok).toBe(true);
    if (!dupParsed.ok) return;
    const dupView = buildRootTableView(dupParsed.document);
    expect(dupView.kind).toBe('object');
    if (dupView.kind !== 'object') return;

    const dupToB = setValue(dupParsed.document, dupView.rows[1]!.keyCell.nodeRef, 'b');
    expect(dupToB.ok).toBe(false);
    if (!dupToB.ok) {
      expect(dupToB.error.code).toBe('KEY_EXISTS');
    }

    const dupBToA = setValue(dupParsed.document, dupView.rows[2]!.keyCell.nodeRef, 'a');
    expect(dupBToA.ok).toBe(false);
    if (!dupBToA.ok) {
      expect(dupBToA.error.code).toBe('KEY_EXISTS');
    }

    const dupDisambiguate = setValue(
      dupParsed.document,
      dupView.rows[1]!.keyCell.nodeRef,
      'a2',
    );
    expect(dupDisambiguate.ok).toBe(true);
    if (dupDisambiguate.ok) {
      expect(dupDisambiguate.source).toBe('{"a": 1, "a2": 2, "b": 3}');
    }
  });

  it('prevents removeRow(arrayRef) without index from deleting the array and allows setValue on field row nodeRef/valueRef (JL1-10)', () => {
    expect.hasAssertions();
    const nestedArrParsed = parseJsonStrict('[[1], [2]]');
    expect(nestedArrParsed.ok).toBe(true);
    if (!nestedArrParsed.ok) return;

    const rootView = buildRootTableView(nestedArrParsed.document);
    expect(rootView.kind).toBe('array-of-arrays');
    if (rootView.kind !== 'array-of-arrays') return;

    // Expanding the first nested array gives a primitive-array view whose containerRef has no elementIndex
    const subView = rootView.rows[0]!.cell.expand();
    expect(subView.kind).toBe('primitive-array');
    if (subView.kind !== 'primitive-array') return;

    const accidentalDelete = removeRow(nestedArrParsed.document, subView.containerRef);
    expect(accidentalDelete.ok).toBe(false);
    if (!accidentalDelete.ok) {
      expect(accidentalDelete.error.code).toBe('INVALID_INDEX');
    }

    // Explicit removeRow(doc, subView.containerRef, 0) deletes element 0 of the inner array
    const innerDelete = removeRow(nestedArrParsed.document, subView.containerRef, 0);
    expect(innerDelete.ok).toBe(true);
    if (innerDelete.ok) {
      expect(innerDelete.source).toBe('[[], [2]]');
    }

    // removeRowAt(doc, rootView.rows[0].elementRef) or removeRow(doc, rootView.rows[0].elementRef) deletes the first row of the outer array
    const outerDelete = removeRowAt(nestedArrParsed.document, rootView.rows[0]!.elementRef);
    expect(outerDelete.ok).toBe(true);
    if (outerDelete.ok) {
      expect(outerDelete.source).toBe('[[2]]');
    }

    // Field row nodeRef and valueRef work directly with setValue and removeField
    const objParsed = parseJsonStrict('{"x": 10, "y": 20}');
    expect(objParsed.ok).toBe(true);
    if (!objParsed.ok) return;
    const objView = buildRootTableView(objParsed.document);
    expect(objView.kind).toBe('object');
    if (objView.kind !== 'object') return;

    const editViaRowNodeRef = setValue(objParsed.document, objView.rows[0]!.nodeRef, '99');
    expect(editViaRowNodeRef.ok).toBe(true);
    if (editViaRowNodeRef.ok) {
      expect(editViaRowNodeRef.source).toBe('{"x": 99, "y": 20}');
    }

    const editViaRowValueRef = setValue(objParsed.document, objView.rows[1]!.valueRef, '88');
    expect(editViaRowValueRef.ok).toBe(true);
    if (editViaRowValueRef.ok) {
      expect(editViaRowValueRef.source).toBe('{"x": 10, "y": 88}');
    }

    const removeViaRowNodeRef = removeField(objParsed.document, objView.rows[0]!.nodeRef);
    expect(removeViaRowNodeRef.ok).toBe(true);
    if (removeViaRowNodeRef.ok) {
      expect(removeViaRowNodeRef.source).toBe('{"y": 20}');
    }
  });

  it('rejects refs from an earlier parse of other text with STALE_SPAN and validates single JSON value lexemes on insert (JL1-9, JL1-12, JL1-3)', () => {
    expect.hasAssertions();
    const docA = parseJsonStrict('[1, 2]');
    const docB = parseJsonStrict('[1, 9]');
    expect(docA.ok).toBe(true);
    expect(docB.ok).toBe(true);
    if (!docA.ok || !docB.ok) return;

    const viewA = buildRootTableView(docA.document);
    expect(viewA.kind).toBe('primitive-array');
    if (viewA.kind !== 'primitive-array') return;

    // Ref from docA used against docB -> STALE_SPAN even though node 1 has the same span [1, 2)
    const crossDocEdit = setValue(docB.document, viewA.rows[0]!.valueCell.nodeRef, '99');
    expect(crossDocEdit.ok).toBe(false);
    if (!crossDocEdit.ok) {
      expect(crossDocEdit.error.code).toBe('STALE_SPAN');
    }

    // Multi-value or malformed lexemes in insertRow / insertField are rejected with INVALID_VALUE_LEXEME
    const viewB = buildRootTableView(docB.document);
    expect(viewB.kind).toBe('primitive-array');
    if (viewB.kind !== 'primitive-array') return;
    const badRow = insertRow(docB.document, viewB.containerRef, {
      valueLexeme: '2, 3',
    });
    expect(badRow.ok).toBe(false);
    if (!badRow.ok) {
      expect(badRow.error.code).toBe('INVALID_VALUE_LEXEME');
    }

    const objDoc = parseJsonStrict('{"a": 1}');
    expect(objDoc.ok).toBe(true);
    if (!objDoc.ok) return;
    const objView = buildRootTableView(objDoc.document);
    expect(objView.kind).toBe('object');
    if (objView.kind !== 'object') return;

    const badField = insertField(objDoc.document, objView.containerRef, 'b', {
      initialValueLexeme: '1, "a": 2',
    });
    expect(badField.ok).toBe(false);
    if (!badField.ok) {
      expect(badField.error.code).toBe('INVALID_VALUE_LEXEME');
    }

    // Sentinel body text never appears in any JsonEditError message or fields (JL1-3)
    const sentinel = 'hunter2-edit-secret';
    const numCellRef = objView.rows[0]!.valueCell.nodeRef;
    const numFail = setValue(objDoc.document, numCellRef, sentinel);
    expect(numFail.ok).toBe(false);
    if (!numFail.ok) {
      expect(numFail.error.message).not.toContain(sentinel);
      expect(JSON.stringify(numFail.error)).not.toContain(sentinel);
    }

    const dupKeyParsed = parseJsonStrict(`{"${sentinel}": 1, "other": 2}`);
    expect(dupKeyParsed.ok).toBe(true);
    if (dupKeyParsed.ok) {
      const dupKeyView = buildRootTableView(dupKeyParsed.document);
      expect(dupKeyView.kind).toBe('object');
      if (dupKeyView.kind === 'object') {
        const keyFail = insertField(dupKeyParsed.document, dupKeyView.containerRef, sentinel);
        expect(keyFail.ok).toBe(false);
        if (!keyFail.ok) {
          expect(keyFail.error.code).toBe('KEY_EXISTS');
          expect(keyFail.error.message).not.toContain(sentinel);
          expect(JSON.stringify(keyFail.error)).not.toContain(sentinel);
        }
        const renameFail = setValue(
          dupKeyParsed.document,
          dupKeyView.rows[1]!.keyCell.nodeRef,
          sentinel,
        );
        expect(renameFail.ok).toBe(false);
        if (!renameFail.ok) {
          expect(renameFail.error.code).toBe('KEY_EXISTS');
          expect(renameFail.error.message).not.toContain(sentinel);
          expect(JSON.stringify(renameFail.error)).not.toContain(sentinel);
        }
      }
    }
  });
});
