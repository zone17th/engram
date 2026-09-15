# Mockup UI — engram

Bộ mockup tĩnh cho **engram** (`key.zone17th.click`). HTML thuần + Tailwind Play CDN, không build, không backend.
Dữ liệu là giả và **không có mã hoá thật** — mọi thứ "khoá/mở khoá" ở đây chỉ là trạng thái UI.

Đây là **tiêu chuẩn thiết kế ràng buộc** cho §7 của [spec](../docs/SPEC.md#70-tiêu-chuẩn-thiết-kế--mockups), không phải bản demo
dùng một lần. Khi lệch nhau: **mockup thắng** về thị giác (bố cục, khoảng cách, màu, type, trạng thái),
**spec thắng** về hành vi và dữ liệu (ranking, điều kiện hiển thị, luồng crypto, tên field).

Kế hoạch triển khai theo phase nằm ở [docs/phases/README.md](../docs/phases/README.md). Bảng đối chiếu mockup/source demo và các chỗ cần sửa trước khi port production nằm ở [§5 của bộ phase](../docs/phases/README.md#5-chênh-lệch-mockup-cần-giải-quyết-khi-port); đừng coi hành vi giả trong HTML/`mock.js` là contract API.

## Chạy

```bash
python -m http.server 5178 --directory mockups
```

Rồi mở <http://localhost:5178/landing.html>. Trong Claude Code có sẵn launch config tên `mockups`
(`.claude/launch.json`) làm đúng việc này.

## Màn hình ↔ mục trong SPEC

| File | Mục SPEC | Nội dung |
|---|---|---|
| `landing.html` | §11.1 | Trang giới thiệu. Hero **là ô omnibox chạy được**, tự gõ `wif` khi tải trang. |
| `index.html` | §7.2 | Vỏ ứng dụng: rail tag, omnibox tìm/lưu, lưới mục gần đây. |
| `item.html` | §7.3, §7.4, §7.5 | Chi tiết mục: tên + tag + entry; entry `json` xem dạng bảng; modal nhập JSON. |
| `settings.html` | §7.6 | Tài khoản, Bảo mật (passphrase / recovery key / passkey / phiên), Tìm kiếm, Dữ liệu. |
| `auth.html` | §3.1, §10.2 | Đăng nhập, đăng ký, quay lại từ OAuth, xác thực lại, lỗi/khoá/CAPTCHA. |
| `onboarding.html` | §3.2, §5.2 | Ba bước tạo vault: passphrase → lưới 10 recovery key → passkey tuỳ chọn. |
| `unlock.html` | §3.3, §3.14 | Mở vault: thiết bị mới, có passkey, thiết bị đã nhớ, và các lỗi mở khoá. |
| `recovery.html` | §3.10 | Quên passphrase: thử đường khác → nhập một RK → passphrase mới → bù key trống. |
| `states.html` | §7.7, §6.8 | Bộ trạng thái dùng chung: rỗng, đang tải, lỗi, ngoại tuyến, giảm chức năng. |
| `docs.html` | §11.1, §5.1 | Trang tài liệu/quyền riêng tư theo token landing. |

Ngoài phạm vi bản này, phải thiết kế thêm trước khi implement: share dialog / recipient status / shared-with-me (P08-A),
extension popup/options/unlock (P08-B), màn quản lý API token (P08-C), và các màn P07 (import backup, rotate VK, sync).
Thêm màn mới thì bổ sung vào thư mục này **và** cập nhật bảng ở §7.0 của spec.

Trong các file đã có vẫn còn ô cần bổ sung, thuộc phase sở hữu màn đó: P02 thêm dialog tài khoản trong `settings.html`;
P06 thêm luồng export encrypted/progress/confirm. P07/P08 phải thêm mockup riêng trước khi implement.

## File dùng chung

| File | Việc |
|---|---|
| `tokens.css` | Nguồn sự thật về thị giác. Màu, type scale, bo góc, component class — lấy nguyên từ `clickup.design.md`. Có cả `[data-theme='dark']` và `prefers-reduced-motion`. |
| `tw.js` | Map token sang utility của Tailwind. **Phải nạp sau** script CDN. |
| `mock.js` | Toàn bộ hành vi: dữ liệu giả, tìm kiếm, omnibox, bảng JSON, khoá/mở vault, dialog, toast. Xuất ra `window.SAK`. |

## Những chỗ mockup cố tình thể hiện đúng spec

- **Gần nghĩa là nhóm riêng, nằm dưới nhóm lexical** (§6.4). Bật/tắt semantic không xáo trộn thứ tự kết quả
  lexical — gõ `mật khẩu` ở `index.html` sẽ thấy *chỉ* nhóm "Gần nghĩa"; gõ `wif` thì không có nhóm đó chen lên trên.
- **Trùng tên mục là hợp lệ** (§3.4). Gõ `wifi #nhà: nội dung` rồi Enter → hộp thoại chọn mục nào, kèm lựa chọn
  "Tạo mục mới cùng tên".
- **JSON không bị mất mát** (§7.4). Cột lấy theo **thứ tự khoá trong nguồn**, không theo thứ tự JS liệt kê;
  hàng có **khoá trùng** rơi về bảng field/value để giữ đủ mọi occurrence; số lớn (`9007199254740993`) hiện
  nguyên văn chứ không bị làm tròn.
- **Chỉ nội dung entry được mã hoá.** Khoá vault ở `index.html`/`item.html`: tên mục, tag, số entry vẫn đọc được;
  chỉ phần nội dung bị che. Đây là lý do tìm kiếm hoạt động.
- **Đổi passphrase không cần passphrase cũ** (§7.6) — cần đăng nhập lại + một đường mở vault đang dùng được.
  "Đặt lại vault" nằm sau danh sách các đường mở khoá phải thử trước.

## Phím tắt

`Ctrl K` hoặc `/` — vào ô tìm · `↑ ↓` — chọn · `Enter` — mở / lưu · `Tab` — điền gợi ý · `Esc` — đóng
