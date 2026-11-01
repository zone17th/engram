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
| `index.html` | §7.2 | Vỏ ứng dụng: rail tag (`#rail-tags`, lọc tag, menu đổi tên `#tagRenameDlg` / xoá có Undo), omnibox tìm/lưu, picker trùng tên U9 (`#dupDialog`), lưới mục gần đây (`#recent-grid`, danh sách gần đây duy nhất, không preview nội dung entry). |
| `item.html` | §7.3, §7.4, §7.5 | Chi tiết mục (`default`, `editing`, `saving`, `conflict`, `crypto-err`, `limits`): tên + gợi ý inline + dòng privacy + chip tag (`#tag-add-chip`); thanh thêm entry (`+ Văn bản`, `+ JSON / bảng`, `Import JSON…`); entry text/JSON (`Bảng` / `JSON gốc`), sửa văn bản, trạng thái lưu, xung đột 412, lỗi khoá cũ / giải mã, giới hạn 20 tag / 200 entry; modal nhập JSON (`#importDlg`). |
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

### Màn nội dung P04 (`index.html`, `item.html`, `mock.js`) — view `data-target`, dialog & neo chính

| File | Target / Dialog | Nội dung & neo chính |
|---|---|---|
| `index.html` | `#rail-tags`, `#recent-grid`, `#tagRenameDlg`, `#dupDialog` | Rail tag (`#rail-tags`, `#rail-tag-list`, `#rail-clear-filter`, menu tag `⋯` Đổi tên / Xoá có Undo toast); dialog đổi tên tag (`#tagRenameDlg`, `#tagRenameInput`, `#tagRenameConflict` `409 tag_conflict`); picker trùng tên U9 (`#dupDialog`, `#dupListbox`, `#dup-opt-new`, phân trang `Xem thêm`); lưới mục gần đây (`#recent-items-header`, `#recent-grid`, không preview body) |
| `item.html` | `default`, `editing`, `saving`, `conflict`, `crypto-err`, `limits`, `#importDlg` | Mặc định (`default` / `#item-default`: `#item-name-input`, `#item-hint-input`, `#item-privacy-note`, `#tag-add-chip`, `#tag-add-popover`, `#tag-suggest-input`, `#entry-composer`, `#card-menu-pop`, tab `Bảng` / `JSON gốc`); đang sửa text (`editing` / `#item-editing`: `#card-text-editing`, `#entry-edit-textarea`, `#entry-byte-counter`, `#entry-discard-confirm`); trạng thái lưu (`saving` / `#item-saving`: `#card-saving`, `#card-saved`, `#card-save-error`); xung đột 412 (`conflict` / `#item-conflict`: `#card-conflict-412`, `#conflict-reload-confirm`, `#item-header-conflict-412`); lỗi giải mã / khoá cũ (`crypto-err` / `#item-crypto-err`: `#card-key-mismatch`, `#card-decrypt-fail`); giới hạn (`limits` / `#item-limits`: `#item-tag-limit-20`, `#item-entry-limit-200`); modal nhập JSON (`#importDlg`) |
| `mock.js` | `#toastStack`, `#dupDialog` | Chồng toast Undo (`#toastStack`, một `role="status"` chung, tối đa 3 hiện + nút `+N` `[data-toast-expand]`, dừng đếm khi hover/focus, ≥ 10 s sau focus, `Ctrl+Z` / `⌘Z`); hàm `SAK.openDupDialog` mở picker U9 (`#dupDialog`) trả về item ID |

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
| `states.html` | `empty`, `load`, `err`, `auth`, `vault`, `off`, `degr` | Rỗng (`empty`); đang tải (`load`); lỗi chung & P04 (`err`: `#err-version-mismatch` 412 ba nút + `#err-conflict-confirm`, `#err-entry-too-large` 256 KiB, `#err-dup-name-picker` mở U9 `#dupDialog`, `#err-decrypt-fail` có Thử lại, `#err-entry-key-mismatch` `409 entry_key_mismatch`); Auth/P02 (`auth`); Vault/P03 (`vault`: `#vault-version-mismatch`, `#vault-reauth-expired-password`, `#vault-reauth-expired-oauth`, `#vault-rate-limited`, `#vault-mutations-disabled`, `#vault-locked-broadcast`, `#vault-insufficient-memory`); ngoại tuyến (`off`: `#off-save-deferred` giữ trong ô cho tới khi vault khoá); giảm chức năng (`degr`) |

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

- **Gần nghĩa là nhóm riêng, nằm dưới nhóm lexical** (§6.4, thuộc P05; ở P04 công tắc "Gần nghĩa" và cột "Liên quan" không hiển thị trên trang chủ/trang mục, chỉ còn trên trang giới thiệu `landing.html`).
- **Trùng tên mục là hợp lệ** — quick-add mở picker U9 (`#dupDialog`: mỗi dòng hiện tên, tối đa 3 chip tag, `created_at`, `entry_count`, nút "Xem thêm" khi còn trang, và dòng cuối "Tạo mục mới cùng tên") trả về đúng item ID (§3.4).
- **JSON không bị mất mát** (§7.4). Cột lấy theo **thứ tự khoá trong nguồn**, không theo thứ tự JS liệt kê;
  hàng có **khoá trùng** rơi về bảng field/value để giữ đủ mọi occurrence; số lớn (`9007199254740993`) hiện
  nguyên văn chứ không bị làm tròn; tab xem nguồn dùng tên thống nhất **"JSON gốc"**.
- **Chỉ nội dung entry được mã hoá; tên mục, tag và gợi ý không được mã hoá** (§5.1). Khoá vault ở `index.html`/`item.html`: tên mục, tag, số entry vẫn đọc được; lưới mục gần đây trên trang chủ là danh sách gần đây duy nhất và không tải hay preview nội dung entry.
- **Đổi passphrase không cần passphrase cũ** (§7.6) — cần đăng nhập lại + một đường mở vault đang dùng được.
  "Đặt lại vault" nằm sau danh sách các đường mở khoá phải thử trước.
- **Tạo lại (regenerate) và xoay (rotate) recovery key đúng ngữ nghĩa live server** (§3.12, §5.9): tạo lại chỉ sinh và hiển thị key mới cho các slot đang trống (từ slot nhỏ nhất); "Xoay cả 10" (`#rotateDlg`) thay cho nút thu hồi cũ để cấp bộ 10 key mới trên live server; đổi passphrase chỉ bọc lại `wrapK` nên các recovery key, bản in cũ và passkey vẫn mở được vault.

## Phím tắt

`Ctrl K` hoặc `/` — vào ô tìm · `↑ ↓` — chọn · `Enter` — mở / lưu · `Ctrl Z` (`⌘Z` trên Apple) — hoàn tác toast mới nhất · `Esc` — đóng
