# Mockup UI — engram

Bộ mockup tĩnh cho **engram** (`key.zone17th.click`). HTML thuần + Tailwind Play CDN, không build, không backend.
Dữ liệu là giả và **không có mã hoá thật** — mọi thứ "khoá/mở khoá" ở đây chỉ là trạng thái UI.

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

Ngoài phạm vi bản này: onboarding và màn mở khoá vault (§7.1) — mới chỉ có trạng thái khoá/mở ngay trong app.

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
