import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_ITEMS, DEMO_TAGS } from '../lib/demo-fixtures';
import { fold, markPrefix, searchDemo } from '../lib/demo-search';

describe('fold', () => {
  it('bỏ dấu tiếng Việt và hạ chữ thường', () => {
    expect(fold('Tiếng Việt')).toBe('tieng viet');
    expect(fold('ĐĂNG KÝ')).toBe('dang ky');
    expect(fold('cà phê sữa')).toBe('ca phe sua');
  });

  it('giữ nguyên chuỗi không dấu', () => {
    expect(fold('docker compose')).toBe('docker compose');
  });
});

describe('searchDemo', () => {
  it('query rỗng trả toàn bộ mục', () => {
    expect(searchDemo('').items).toHaveLength(DEMO_ITEMS.length);
  });

  it('gõ không dấu vẫn tìm ra mục có dấu', () => {
    const withDiacritics = DEMO_ITEMS.find((i) => /[àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(i.title));
    expect(withDiacritics).toBeDefined();
    const folded = fold(withDiacritics!.title).split(' ')[0];
    expect(searchDemo(folded).items.map((i) => i.id)).toContain(withDiacritics!.id);
  });

  it('khớp cả tag lẫn tiêu đề', () => {
    const tag = DEMO_TAGS[0].name;
    const result = searchDemo(tag);
    expect(result.tags).toContain(tag);
  });

  it('query không khớp gì trả danh sách rỗng', () => {
    expect(searchDemo('zzzzqqqq').items).toEqual([]);
  });

  it('trả lại query đã nhập để UI hiển thị', () => {
    expect(searchDemo('ghi chú').query).toBe('ghi chú');
  });
});

describe('markPrefix', () => {
  it('tách phần khớp tiền tố không phân biệt dấu', () => {
    expect(markPrefix('Ghi chú họp', 'ghi')).toEqual({ before: '', match: 'Ghi', after: ' chú họp' });
  });

  it('không khớp thì trả nguyên chuỗi ở after', () => {
    expect(markPrefix('Ghi chú', 'xyz')).toEqual({ before: '', match: '', after: 'Ghi chú' });
  });
});

describe('ranh giới demo (P01-A5)', () => {
  const source = [
    readFileSync(resolve(__dirname, '../lib/demo-search.ts'), 'utf8'),
    readFileSync(resolve(__dirname, '../lib/demo-fixtures.ts'), 'utf8'),
  ].join('\n');

  it('không gọi mạng', () => {
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/XMLHttpRequest|navigator\.sendBeacon/);
  });

  it('không import client API', () => {
    expect(source).not.toContain('@engram/shared-types');
  });

  it('không claim đã mã hoá', () => {
    expect(source).not.toMatch(/encrypt|mã hoá|đã mã hóa/i);
  });

  it('fixture không chứa dữ liệu trông như thật của người dùng', () => {
    const json = JSON.stringify(DEMO_ITEMS);
    expect(json).not.toMatch(/@gmail\.com|@yahoo\./i);
    expect(json).not.toMatch(/\b\d{9,}\b/);
  });
});
