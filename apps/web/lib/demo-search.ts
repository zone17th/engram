import { DEMO_ITEMS, DEMO_TAGS, type DemoItem } from './demo-fixtures';

/**
 * fold bỏ dấu và hạ chữ thường để gõ "ca phe" tìm ra "Cà phê".
 * Đây là bản demo chạy hoàn toàn trong trình duyệt — tìm kiếm thật của app
 * dùng immutable_unaccent + pg_trgm ở phía Postgres (P04).
 */
export function fold(input: string): string {
  return input
    .normalize('NFD')
    // \u0300-\u036f = Combining Diacritical Marks. Viết bằng escape, không dán
    // ký tự dấu trực tiếp vào regex — nhiều editor/diff sẽ nuốt mất chúng.
    // Lưu ý: markPrefix giả định chuỗi gốc ở dạng NFC (1 ký tự = 1 code point có dấu)
    // để index trên chuỗi đã fold ánh xạ đúng về chuỗi gốc.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export interface DemoSearchResult {
  tags: string[];
  items: DemoItem[];
  query: string;
}

/** searchDemo lọc fixture trong bộ nhớ. Không I/O, không mạng, không lưu gì. */
export function searchDemo(query: string): DemoSearchResult {
  const needle = fold(query.trim());
  if (needle === '') {
    return { tags: DEMO_TAGS.map((t) => t.name), items: DEMO_ITEMS, query };
  }

  const tags = DEMO_TAGS.filter((t) => fold(t.name).includes(needle)).map((t) => t.name);
  const items = DEMO_ITEMS.filter((item) => {
    const haystack = [item.title, item.preview, ...item.tags].map(fold);
    return haystack.some((text) => text.includes(needle));
  });

  return { tags, items, query };
}

/** markPrefix trả ba đoạn để UI bôi đậm phần khớp mà không cần dangerouslySetInnerHTML. */
export function markPrefix(text: string, query: string): { before: string; match: string; after: string } {
  const needle = fold(query.trim());
  if (needle === '') return { before: '', match: '', after: text };

  const index = fold(text).indexOf(needle);
  if (index === -1) return { before: '', match: '', after: text };

  return {
    before: text.slice(0, index),
    match: text.slice(index, index + needle.length),
    after: text.slice(index + needle.length),
  };
}
