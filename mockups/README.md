# Mockup UI — engram

Bộ mockup tĩnh cho **engram** (`engram.zone17.click`). HTML thuần + Tailwind Play CDN, không build, không backend.
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
| `settings.html` | §7.6 | Tài khoản (email, mật khẩu, provider, locale, theme), phiên/audit/thông báo P02; `#baomat` P03 (passphrase `#passDlg`, RK còn N/10 + `#rkDlg` regenerate + `#rotateDlg` xoay cả 10, passkey + `#passkeyAddDlg`, auto-lock 5/15/60/Never + nhớ thiết bị, `#resetDlg` đặt lại vault 5 bước); tìm kiếm `#timkiem` P05. |
| `auth.html` | §3.1, §10.2 | Đăng nhập/đăng ký, xác minh email, đặt mật khẩu OAuth-only, OAuth return, re-auth, lỗi auth (CAPTCHA, lockout, session). |
| `onboarding.html` | §3.2, §5.2 | Ba bước tạo vault: passphrase (`pp`, lỗi thiếu bộ nhớ `pp-oom`) → lưới 10 recovery key (`rk`, `409 vault_exists` `rk-exists`) → passkey tuỳ chọn & nhớ thiết bị (`pk`, lỗi PRF/cancel/missing/orphan). |
| `unlock.html` | §3.3, §3.14 | Mở vault: thiết bị mới (`new`), có passkey (`pk`), thiết bị đã nhớ (`known`), lỗi mở khoá (`err`) và lỗi passkey (`err-pk`). |
| `recovery.html` | §3.10 | Quên passphrase: thử đường khác + re-auth đầu luồng (`s1`) → nhập một RK (`s2`) → đặt passphrase mới ở trạng thái `recovering` (`s3`, lỗi `s3-err`) → xác nhận lại trước khi tạo key bù (`s4-reauth`) → bù key cho slot trống (`s4`). |
| `states.html` | §7.7, §6.8 | Bộ trạng thái dùng chung: rỗng (`empty`), đang tải (`load`), lỗi (`err`), Auth/P02 (`auth`), Vault/P03 (`vault`), ngoại tuyến (`off`), giảm chức năng (`degr`). |
| `docs.html` | §11.1, §5.1 | Trang tài liệu/quyền riêng tư theo token landing. |

Ngoài phạm vi bản này, phải thiết kế thêm trước khi implement: share dialog / recipient status / shared-with-me (P08-A),
extension popup/options/unlock (P08-B), màn quản lý API token (P08-C), và các màn P07 (import backup, rotate VK, sync).
Thêm màn mới thì bổ sung vào thư mục này **và** cập nhật bảng ở §7.0 của spec.

Trong các file đã có vẫn còn ô cần bổ sung, thuộc phase sở hữu màn đó: P06 thêm luồng export encrypted/progress/confirm.
P07/P08 phải thêm mockup riêng trước khi implement.

### Dialog ID (P02 account — `settings.html`)

| ID | Mục đích |
|---|---|
| `emailChangeDlg` | Đổi email (chờ xác minh) |
| `passwordChangeDlg` | Đổi mật khẩu đăng nhập |
| `linkProviderDlg` | Bắt đầu liên kết OAuth |
| `unlinkProviderDlg` | Xác nhận gỡ provider |
| `reauthDlg` | Re-auth trước mutation nhạy cảm |
| `revokeSessionsDlg` | Xác nhận thu hồi phiên khác |

### Dialog ID (P03 vault — `settings.html#baomat`)

| ID | Bước / trạng thái (`data-target`) | Mục đích |
|---|---|---|
| `passDlg` | `pass-form`, `pass-oauth`, `pass-oom`, `pass-reauth-expired`, `pass-mismatch`, `pass-ratelimit`, `pass-done` | Đổi passphrase (re-auth đầu luồng, không hỏi passphrase cũ; giữ nguyên RK và passkey) |
| `rkDlg` | `rk-reauth`, `rk-keys` (`#rkRegenSaved`, `#rkRegenDoneBtn`), `rk-reauth-expired`, `rk-mismatch`, `rk-ratelimit`, `rk-done` | Tạo lại recovery key cho các slot trống (chỉ hiện key mới theo slot nhỏ nhất trước) |
| `rotateDlg` | `rot-reauth`, `rot-keys` (`#rkRotateSaved`, `#rkRotateConfirmBtn`), `rot-reauth-expired`, `rot-mismatch`, `rot-ratelimit`, `rot-done` | Xoay cả 10 recovery key trên live server (thay cho thao tác thu hồi cũ; không xoay VK) |
| `passkeyAddDlg` | `pk-start`, `pk-prf-unsupported`, `pk-cancelled`, `pk-prf-missing`, `pk-orphan`, `pk-reauth-expired` | Đăng ký passkey mở vault (kiểm PRF, xử lý credential thừa khi POST lỗi) |
| `resetDlg` | `rst-s1`, `rst-s2`, `rst-s3`, `rst-s4` (`#rst-confirm-word`, `#rstConfirmBtn`), `rst-s5`, `rst-reauth-expired`, `rst-mismatch` | Đặt lại vault 5 bước (thử đường mở khoá → kiểm backup → re-auth → gõ xác nhận → xong) |

### Màn auth (`auth.html`) — view `data-target`

| Target | Nội dung |
|---|---|
| `login` | Form + submitting + validation |
| `signup` | Form + email trùng |
| `verify` | Xác minh email + token lỗi |
| `enroll` | Đặt mật khẩu lần đầu + sent/expired/reused/session/quota |
| `oauth` | Callback loading, cancel, error, collision |
| `reauth` | Password + Google; OAuth-only enrollment |
| `err` | Credential, CAPTCHA, lockout, session, network |

### Màn vault & trạng thái (`onboarding.html`, `unlock.html`, `recovery.html`, `states.html`) — view `data-target`

| File | Target | Nội dung & neo chính |
|---|---|---|
| `onboarding.html` | `pp`, `pp-oom`, `rk`, `rk-exists`, `pk` | Bước 1 passphrase (`pp`) + thiếu bộ nhớ Argon2id (`pp-oom`, `#onboard-oom`); bước 2 lưới 10 RK (`rk`, `#rkOk`, `#createVault`) + `409 vault_exists` (`rk-exists`, `#onboard-vault-exists`); bước 3 passkey & nhớ thiết bị (`pk`: `#pk-prf-unsupported`, `#pk-cancelled`, `#pk-prf-missing`, `#pk-orphan`) |
| `unlock.html` | `new`, `pk`, `known`, `err`, `err-pk` | Thiết bị mới (`new`); ưu tiên passkey (`pk`, `#unlock-passkey-not-found`); thiết bị đã nhớ (`known`); lỗi passphrase/phiên (`err`: `#err-passphrase-aead`, `#err-insufficient-memory`, `#err-session-expired`); lỗi passkey (`err-pk`: `#err-prf-unsupported`, `#err-pk-cancelled`, `#err-prf-missing`, `#err-pk-aead`, `#err-rate-limited`, `#err-pk-not-found`) |
| `recovery.html` | `s1`, `s2`, `s3`, `s3-err`, `s4-reauth`, `s4` | Thử đường khác + re-auth đầu luồng (`s1`, `#recovery-reauth-start`); nhập 1 RK (`s2`: `#s2-err-invalid`, `#s2-err-rate`, `#s2-err-aead`); đặt passphrase mới ở state `recovering` (`s3`, `#s3-recovering-note`); lỗi bước 3 (`s3-err`: `#s3-reauth-expired-password`, `#s3-reauth-expired-oauth`, `#s3-err-oom`, `#s3-err-version`, `#s3-err-rate`); xác nhận lại trước khi tạo key bù (`s4-reauth`: `#s4-regenerate-reauth`); tạo key bù slot trống (`s4`: `#s4-replacement-card`) |
| `states.html` | `empty`, `load`, `err`, `auth`, `vault`, `off`, `degr` | Rỗng (`empty`); đang tải (`load`); lỗi chung (`err`); Auth/P02 (`auth`); Vault/P03 (`vault`: `#vault-version-mismatch`, `#vault-reauth-expired-password`, `#vault-reauth-expired-oauth`, `#vault-rate-limited`, `#vault-mutations-disabled`, `#vault-locked-broadcast`, `#vault-insufficient-memory`); ngoại tuyến (`off`); giảm chức năng (`degr`) |

- **Quy ước song ngữ vi/en (`advisor-dec-002`, option A):** tiếng Việt là ngôn ngữ chính; mọi chuỗi hoặc trạng thái mới bổ sung đều kèm bản tiếng Anh inline (`lang="en"`), không thêm nút chuyển ngôn ngữ trên khung mockup.
- **Định dạng ví dụ recovery key:** mọi RK trong mockup là dữ liệu giả hợp lệ theo `rk{n}_XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XX` (`n = 1…10`, 26 ký tự Crockford Base32 `0-9 A-H J K M N P-T V-Z`, ký tự đầu `0`–`7`, bắt đầu bằng `0FAK-E`, ví dụ `rk3_0FAK-E7QK-4M2X-D9FR-AT1V-B60H-NZ`).

Screenshot revision (Task 24): chụp `auth.html` và `settings.html` ở 390/768/1440 px, light/dark — không có secret thật trong form.

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
- **Tạo lại (regenerate) và xoay (rotate) recovery key đúng ngữ nghĩa live server** (§3.12, §5.9): tạo lại chỉ sinh và hiển thị key mới cho các slot đang trống (từ slot nhỏ nhất); "Xoay cả 10" (`#rotateDlg`) thay cho nút thu hồi cũ để cấp bộ 10 key mới trên live server; đổi passphrase chỉ bọc lại `wrapK` nên các recovery key, bản in cũ và passkey vẫn mở được vault.

## Phím tắt

`Ctrl K` hoặc `/` — vào ô tìm · `↑ ↓` — chọn · `Enter` — mở / lưu · `Tab` — điền gợi ý · `Esc` — đóng
