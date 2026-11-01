import { describe, expect, it } from 'vitest';
import {
  JSON_TABLE_MAX_COLUMNS,
  JSON_TABLE_PAGE_SIZE,
  buildRootTableView,
} from './model';
import { parseJsonStrict } from './parse';

describe('lib/json/model', () => {
  it('builds object field/value view preserving source key order and duplicate keys', () => {
    const parsed = parseJsonStrict('{"10":"ten","2":"two","dup":1,"dup":2}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    expect(view.kind).toBe('object');
    if (view.kind !== 'object') return;

    expect(view.hasDuplicateKeys).toBe(true);
    expect(view.rows.map((r) => r.key)).toEqual(['10', '2', 'dup', 'dup']);
    expect(view.rows.map((r) => r.occurrenceIndex)).toEqual([0, 0, 0, 1]);
    expect(view.rows.map((r) => r.keyLabel)).toEqual(['10', '2', 'dup (#1)', 'dup (#2)']);
  });

  it('builds array-of-objects union columns (max 20) in first-appearance order and groups 21+ into +N field', () => {
    const row1Pairs: string[] = [];
    for (let i = 1; i <= 25; i++) {
      row1Pairs.push(`"k${i}": ${i}`);
    }
    const src = `[{ ${row1Pairs.join(', ')} }, { "k2": 20, "k26": 260 }]`;
    const parsed = parseJsonStrict(src);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    expect(view.kind).toBe('array-of-objects');
    if (view.kind !== 'array-of-objects') return;

    expect(view.columns).toHaveLength(JSON_TABLE_MAX_COLUMNS);
    expect(view.columns[0]).toBe('k1');
    expect(view.columns[19]).toBe('k20');
    expect(view.totalDistinctKeys).toBe(26);
    expect(view.hasExtraFieldsColumn).toBe(true);

    const r0 = view.rows[0];
    expect(r0?.kind).toBe('columns');
    if (r0?.kind === 'columns') {
      expect(r0.extraFields).not.toBeNull();
      expect(r0.extraFields?.count).toBe(5);
      expect(r0.extraFields?.label).toBe('+5 field');
      expect(r0.extraFields?.fields.map((f) => f.key)).toEqual([
        'k21',
        'k22',
        'k23',
        'k24',
        'k25',
      ]);
      const expandedExtra = r0.extraFields!.expand();
      expect(expandedExtra.kind).toBe('object');
      expect(expandedExtra.rows).toHaveLength(5);
    }

    const r1 = view.rows[1];
    expect(r1?.kind).toBe('columns');
    if (r1?.kind === 'columns') {
      expect(r1.cells.get('k1')?.kind).toBe('missing');
      expect(r1.cells.get('k2')?.kind).toBe('primitive');
      expect(r1.extraFields?.count).toBe(1);
      expect(r1.extraFields?.label).toBe('+1 field');
      expect(r1.extraFields?.fields[0]?.key).toBe('k26');
    }
  });

  it('stores columns in Map so __proto__, constructor, and hasOwnProperty work as ordinary keys', () => {
    const src = '[{"__proto__": "p1", "constructor": "c1", "hasOwnProperty": "h1"}]';
    const parsed = parseJsonStrict(src);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    expect(view.kind).toBe('array-of-objects');
    if (view.kind !== 'array-of-objects') return;

    expect(view.columns).toEqual(['__proto__', 'constructor', 'hasOwnProperty']);
    const row = view.rows[0];
    expect(row?.kind).toBe('columns');
    if (row?.kind === 'columns') {
      const protoCell = row.cells.get('__proto__');
      const ctorCell = row.cells.get('constructor');
      const hopCell = row.cells.get('hasOwnProperty');
      expect(protoCell?.kind === 'primitive' && protoCell.displayText).toBe('p1');
      expect(ctorCell?.kind === 'primitive' && ctorCell.displayText).toBe('c1');
      expect(hopCell?.kind === 'primitive' && hopCell.displayText).toBe('h1');
    }
  });

  it('falls back to field/value view for a row in array-of-objects that contains duplicate keys', () => {
    const src = '[{"id": 1, "name": "ok"}, {"id": 2, "id": 3, "name": "dup"}]';
    const parsed = parseJsonStrict(src);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    expect(view.kind).toBe('array-of-objects');
    if (view.kind !== 'array-of-objects') return;

    expect(view.rows[0]?.kind).toBe('columns');
    expect(view.rows[1]?.kind).toBe('duplicate-fallback');
    if (view.rows[1]?.kind === 'duplicate-fallback') {
      expect(view.rows[1].fallbackTable.rows.map((r) => r.keyLabel)).toEqual([
        'id (#1)',
        'id (#2)',
        'name',
      ]);
    }
  });

  it('handles primitive arrays (#/value), arrays of arrays ("Array (n)"), and root primitives', () => {
    const primArrParsed = parseJsonStrict('[10, "twenty", true, null]');
    expect(primArrParsed.ok).toBe(true);
    if (primArrParsed.ok) {
      const view = buildRootTableView(primArrParsed.document);
      expect(view.kind).toBe('primitive-array');
      if (view.kind === 'primitive-array') {
        expect(view.rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
      }
    }

    const arrOfArrParsed = parseJsonStrict('[[1, 2], ["a"], []]');
    expect(arrOfArrParsed.ok).toBe(true);
    if (arrOfArrParsed.ok) {
      const view = buildRootTableView(arrOfArrParsed.document);
      expect(view.kind).toBe('array-of-arrays');
      if (view.kind === 'array-of-arrays') {
        expect(view.rows.map((r) => r.label)).toEqual(['Array (2)', 'Array (1)', 'Array (0)']);
      }
    }

    const rootPrimParsed = parseJsonStrict('42');
    expect(rootPrimParsed.ok).toBe(true);
    if (rootPrimParsed.ok) {
      const view = buildRootTableView(rootPrimParsed.document);
      expect(view.kind).toBe('root-primitive');
      if (view.kind === 'root-primitive') {
        expect(view.cell.displayText).toBe('42');
      }
    }
  });

  it('marks strings with \\r or lone surrogates as read-only and strings with \\n (no \\r) as multiline', () => {
    const src = '{"plain":"abc","lf":"a\\nb","crlf":"a\\r\\nb","cr":"a\\rb","surrogate":"\\ud800"}';
    const parsed = parseJsonStrict(src);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const view = buildRootTableView(parsed.document);
    expect(view.kind).toBe('object');
    if (view.kind !== 'object') return;
    expect(view.hasReadOnlyCells).toBe(true);

    const [plain, lf, crlf, cr, surrogate] = view.rows;
    expect(plain?.valueCell.kind === 'primitive' && plain.valueCell.editorMode).toBe('singleline');
    expect(lf?.valueCell.kind === 'primitive' && lf.valueCell.editorMode).toBe('multiline');
    expect(lf?.valueCell.kind === 'primitive' && lf.valueCell.multiline).toBe(true);
    expect(lf?.valueCell.kind === 'primitive' && lf.valueCell.readOnly).toBe(false);

    expect(crlf?.valueCell.kind === 'primitive' && crlf.valueCell.readOnly).toBe(true);
    expect(crlf?.valueCell.kind === 'primitive' && crlf.valueCell.readOnlyReason).toBe(
      'carriage_return',
    );
    expect(cr?.valueCell.kind === 'primitive' && cr.valueCell.readOnly).toBe(true);
    expect(surrogate?.valueCell.kind === 'primitive' && surrogate.valueCell.readOnly).toBe(true);
    expect(surrogate?.valueCell.kind === 'primitive' && surrogate.valueCell.readOnlyReason).toBe(
      'lone_surrogate',
    );
  });

  it('paginates containers with >50 children in pages of 50 and builds children lazily on expand', () => {
    const items = Array.from({ length: 600 }, (_, i) => `{"idx":${i}}`).join(',');
    const parsed = parseJsonStrict(`[${items}]`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const page1 = buildRootTableView(parsed.document, { page: 1 });
    expect(page1.kind).toBe('array-of-objects');
    if (page1.kind !== 'array-of-objects') return;
    expect(page1.totalRows).toBe(600);
    expect(page1.pageSize).toBe(JSON_TABLE_PAGE_SIZE);
    expect(page1.totalPages).toBe(12);
    expect(page1.rows).toHaveLength(50);
    expect(page1.rows[0]?.rowIndex).toBe(0);
    expect(page1.rows[49]?.rowIndex).toBe(49);

    const page12 = buildRootTableView(parsed.document, { page: 12 });
    if (page12.kind === 'array-of-objects') {
      expect(page12.rows).toHaveLength(50);
      expect(page12.rows[0]?.rowIndex).toBe(550);
      expect(page12.rows[49]?.rowIndex).toBe(599);
    }

    // 10000-deep array builds root view immediately (1 row) without building all 10000 levels
    const deep = '['.repeat(10_000) + '42' + ']'.repeat(10_000);
    const deepParsed = parseJsonStrict(deep);
    expect(deepParsed.ok).toBe(true);
    if (deepParsed.ok) {
      const rootView = buildRootTableView(deepParsed.document);
      expect(rootView.kind).toBe('array-of-arrays');
      if (rootView.kind === 'array-of-arrays') {
        expect(rootView.rows).toHaveLength(1);
        const level2 = rootView.rows[0]!.cell.expand();
        expect(level2.kind).toBe('array-of-arrays');
      }
    }
  });
});
