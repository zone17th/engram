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
