/**
 * Dữ liệu mẫu CÔNG KHAI cho demo ở landing. Không phải dữ liệu người dùng,
 * không đi qua API, không được coi là contract (P01-A5).
 * Mọi nội dung ở đây là bịa và an toàn để hiển thị cho người lạ.
 */
export interface DemoItem {
  id: string;
  title: string;
  kind: 'text' | 'json';
  tags: string[];
  preview: string;
}

export const DEMO_TAGS: { name: string; count: number }[] = [
  { name: 'ghi-chú', count: 12 },
  { name: 'công-thức', count: 7 },
  { name: 'cấu-hình', count: 5 },
  { name: 'đọc-sau', count: 4 },
  { name: 'du-lịch', count: 3 },
];

export const DEMO_ITEMS: DemoItem[] = [
  {
    id: 'd1',
    title: 'Cà phê sữa đá tỉ lệ 1:2',
    kind: 'text',
    tags: ['công-thức'],
    preview: 'Một phần cà phê phin đặc, hai phần sữa đặc, đá đầy ly.',
  },
  {
    id: 'd2',
    title: 'Ghi chú họp thứ Ba',
    kind: 'text',
    tags: ['ghi-chú'],
    preview: 'Chốt phạm vi bản thử, hẹn rà lại vào cuối tuần.',
  },
  {
    id: 'd3',
    title: 'Cấu hình máy chủ nhỏ',
    kind: 'json',
    tags: ['cấu-hình'],
    preview: '{"host":"localhost","port":8080,"tls":false}',
  },
  {
    id: 'd4',
    title: 'Sách muốn đọc năm nay',
    kind: 'text',
    tags: ['đọc-sau'],
    preview: 'Ba cuốn về trí nhớ, một cuốn về nghề bếp.',
  },
  {
    id: 'd5',
    title: 'Đường đi Đà Lạt bằng xe khách',
    kind: 'text',
    tags: ['du-lịch', 'ghi-chú'],
    preview: 'Đi chuyến đêm, xuống bến rồi bắt taxi thêm mười phút.',
  },
  {
    id: 'd6',
    title: 'Mẫu JSON của một mục engram',
    kind: 'json',
    tags: ['cấu-hình', 'ghi-chú'],
    preview: '{"keyword":"ca-phe","type":"text","tags":["công-thức"]}',
  },
];

/** JSON dùng cho bảng minh hoạ ở mục "Cách dùng" của landing. */
export const DEMO_JSON: Record<string, unknown> = {
  keyword: 'ca-phe',
  type: 'json',
  tags: ['công-thức', 'ghi-chú'],
  body: {
    ratio: '1:2',
    steps: ['pha phin', 'thêm sữa đặc', 'cho đá'],
    servings: 1,
  },
  updatedAt: '2026-09-01',
};
