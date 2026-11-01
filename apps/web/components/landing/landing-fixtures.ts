/**
 * Dữ liệu mẫu CÔNG KHAI, chỉ dành cho trang landing (advisor-dec-186/187).
 * Không phải dữ liệu người dùng, không đi qua API, không phải contract.
 * Cố ý tách khỏi `lib/demo-fixtures.ts`: file đó dùng chung với lane home.
 */

/**
 * JSON của card "Cấu hình router" ở mục Cách dùng, chép từ mockups/landing.html
 * để nội dung khớp tiêu đề card (audit UIA-7). Bỏ `note_id` của mockup: JS number
 * không giữ được 9007199254740993, và đoạn chữ bên cạnh đã nói về số dài đó.
 */
export const LANDING_ROUTER_JSON: Record<string, unknown> = {
  ssid: 'Zone17th-5G',
  band: '5GHz',
  channel: 36,
  wpa: 3,
  guest: { ssid: 'Zone17th-Guest', isolate: true, expires: null },
  vlans: [
    { id: 10, name: 'trusted', cidr: '10.0.10.0/24', dhcp: true },
    { id: 20, name: 'iot', cidr: '10.0.20.0/24', dhcp: true },
    { id: 30, name: 'guest', cidr: '10.0.30.0/24', dhcp: false },
  ],
};

/* ---------- hero demo (audit UIA-5 / UIA-24) ---------- */

export type LandingLocale = 'en' | 'vi';

export interface HeroTag {
  name: string;
  /** Số mục mang tag này, hiện ở cột phải của hàng gợi ý. */
  count: number;
}

export interface HeroItem {
  id: string;
  name: string;
  /** Gợi ý phân biệt các mục trùng tên (SPEC §3.4); rỗng nếu không có. */
  hint: string;
  tags: string[];
  entries: number;
  /** Ngày sửa, đã định dạng sẵn theo locale. */
  updated: string;
  /** Độ "hay dùng" giả lập, dùng để xếp khi ô tìm kiếm còn trống. */
  touched: number;
}

/**
 * Bảng "gần nghĩa" giả lập vector search, chép từ mockups/mock.js (SEMANTIC).
 * `triggers` đã bỏ dấu, viết thường; `hits` là [id mục, điểm].
 */
export interface HeroNearRule {
  triggers: string[];
  hits: [string, number][];
}

export interface HeroFixture {
  tags: HeroTag[];
  items: HeroItem[];
  near: HeroNearRule[];
}

const VI: HeroFixture = {
  tags: [
    { name: 'nhà', count: 24 },
    { name: 'office', count: 11 },
    { name: 'công-ty', count: 8 },
    { name: 'ops', count: 15 },
    { name: 'home-lab', count: 6 },
    { name: 'okrs', count: 4 },
    { name: 'wifi-khách', count: 2 },
  ],
  items: [
    { id: 'i1', name: 'wifi', hint: '', tags: ['nhà', 'office', 'home-lab', 'ops'], entries: 12, updated: '12/03/2026', touched: 9 },
    { id: 'i2', name: 'wifi', hint: 'tầng 4 — SSID nội bộ', tags: ['công-ty', 'office'], entries: 3, updated: '01/06/2026', touched: 6 },
    { id: 'i11', name: 'wifi', hint: 'nhà bố mẹ · cáp quang', tags: ['nhà', 'wifi-khách'], entries: 2, updated: '14/01/2026', touched: 5 },
    { id: 'i12', name: 'wifi', hint: 'quán cà phê hay ngồi', tags: ['wifi-khách'], entries: 1, updated: '08/11/2025', touched: 3 },
    { id: 'i3', name: 'wifi-office', hint: '', tags: ['office'], entries: 3, updated: '28/05/2026', touched: 4 },
    { id: 'i4', name: 'mạng nhà', hint: 'router, VLAN, DNS', tags: ['nhà', 'home-lab'], entries: 7, updated: '02/09/2026', touched: 8 },
    { id: 'i5', name: 'docker', hint: '', tags: ['ops', 'home-lab'], entries: 9, updated: '10/09/2026', touched: 12 },
    { id: 'i6', name: 'k8s', hint: 'kubernetes cụm nhà', tags: ['ops', 'home-lab'], entries: 5, updated: '30/08/2026', touched: 5 },
    { id: 'i7', name: 'meeting-mkt', hint: '', tags: ['okrs'], entries: 4, updated: '11/09/2026', touched: 7 },
    { id: 'i8', name: 'api key openai', hint: '', tags: ['ops'], entries: 2, updated: '19/07/2026', touched: 3 },
    { id: 'i9', name: 'hợp đồng thuê nhà', hint: '', tags: ['nhà'], entries: 6, updated: '05/01/2026', touched: 2 },
    { id: 'i10', name: 'ngân hàng', hint: 'số tài khoản, chi nhánh', tags: [], entries: 3, updated: '22/04/2026', touched: 4 },
  ],
  near: [
    { triggers: ['mat khau', 'password', 'pass', 'mk'], hits: [['i1', 0.86], ['i2', 0.82], ['i8', 0.74]] },
    { triggers: ['mang', 'internet', 'router', 'ssid', 'network'], hits: [['i4', 0.88], ['i1', 0.79], ['i6', 0.68]] },
    { triggers: ['wifi', 'wi-fi'], hits: [['i4', 0.81]] },
    { triggers: ['container', 'image', 'compose'], hits: [['i5', 0.84], ['i6', 0.77]] },
    { triggers: ['hop', 'lich hop', 'meeting', 'bien ban'], hits: [['i7', 0.85]] },
    { triggers: ['thue nha', 'nha tro', 'contract'], hits: [['i9', 0.83]] },
    { triggers: ['tien', 'chuyen khoan', 'bank'], hits: [['i10', 0.87]] },
  ],
};

/** Bản tiếng Anh: cùng id, cùng điểm; tên, tag và gợi ý viết bằng tiếng Anh (UIA-24). */
const EN: HeroFixture = {
  tags: [
    { name: 'home', count: 24 },
    { name: 'office', count: 11 },
    { name: 'company', count: 8 },
    { name: 'ops', count: 15 },
    { name: 'home-lab', count: 6 },
    { name: 'okrs', count: 4 },
    { name: 'wifi-guest', count: 2 },
  ],
  items: [
    { id: 'i1', name: 'wifi', hint: '', tags: ['home', 'office', 'home-lab', 'ops'], entries: 12, updated: 'Mar 12, 2026', touched: 9 },
    { id: 'i2', name: 'wifi', hint: '4th floor — internal SSID', tags: ['company', 'office'], entries: 3, updated: 'Jun 1, 2026', touched: 6 },
    { id: 'i11', name: 'wifi', hint: 'parents’ place · fibre', tags: ['home', 'wifi-guest'], entries: 2, updated: 'Jan 14, 2026', touched: 5 },
    { id: 'i12', name: 'wifi', hint: 'the café I work from', tags: ['wifi-guest'], entries: 1, updated: 'Nov 8, 2025', touched: 3 },
    { id: 'i3', name: 'wifi-office', hint: '', tags: ['office'], entries: 3, updated: 'May 28, 2026', touched: 4 },
    { id: 'i4', name: 'home network', hint: 'router, VLAN, DNS', tags: ['home', 'home-lab'], entries: 7, updated: 'Sep 2, 2026', touched: 8 },
    { id: 'i5', name: 'docker', hint: '', tags: ['ops', 'home-lab'], entries: 9, updated: 'Sep 10, 2026', touched: 12 },
    { id: 'i6', name: 'k8s', hint: 'home kubernetes cluster', tags: ['ops', 'home-lab'], entries: 5, updated: 'Aug 30, 2026', touched: 5 },
    { id: 'i7', name: 'meeting-mkt', hint: '', tags: ['okrs'], entries: 4, updated: 'Sep 11, 2026', touched: 7 },
    { id: 'i8', name: 'api key openai', hint: '', tags: ['ops'], entries: 2, updated: 'Jul 19, 2026', touched: 3 },
    { id: 'i9', name: 'apartment lease', hint: '', tags: ['home'], entries: 6, updated: 'Jan 5, 2026', touched: 2 },
    { id: 'i10', name: 'bank', hint: 'account number, branch', tags: [], entries: 3, updated: 'Apr 22, 2026', touched: 4 },
  ],
  near: [
    { triggers: ['password', 'pass', 'pw'], hits: [['i1', 0.86], ['i2', 0.82], ['i8', 0.74]] },
    { triggers: ['network', 'internet', 'router', 'ssid'], hits: [['i4', 0.88], ['i1', 0.79], ['i6', 0.68]] },
    { triggers: ['wifi', 'wi-fi'], hits: [['i4', 0.81]] },
    { triggers: ['container', 'image', 'compose'], hits: [['i5', 0.84], ['i6', 0.77]] },
    { triggers: ['meeting', 'minutes', 'agenda'], hits: [['i7', 0.85]] },
    { triggers: ['rent', 'lease', 'contract', 'landlord'], hits: [['i9', 0.83]] },
    { triggers: ['money', 'transfer', 'bank', 'iban'], hits: [['i10', 0.87]] },
  ],
};

export const HERO_FIXTURES: Record<LandingLocale, HeroFixture> = { en: EN, vi: VI };
