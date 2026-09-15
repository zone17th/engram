# P02 — Tài khoản, session và re-auth

> Kế hoạch · MVP 2/6 · Phụ thuộc: [P01](P01-foundation.md).
> Nguồn: [SPEC](../SPEC.md) §3.1, §4.2, §7.6, §8, §9.1–§9.2, §10.2.

## Mục tiêu và đầu ra

Người dùng đăng ký/đăng nhập bằng password hoặc Google/GitHub, có session thật, quản lý phiên và settings tài khoản. Re-auth độc lập với encryption passphrase đã có API/control để P03 dùng. Signup thành công dẫn tới trạng thái cần tạo vault, không tự sinh vault thiếu recovery key.

## Phạm vi

- Email/password với Argon2id server, validation/copy lỗi; Google/GitHub OAuth với state/PKCE và OIDC nonce khi provider hỗ trợ.
- **Rate limit và chống brute force của auth (§9.1, §10.2):** auth 5 req/phút/IP, lockout tăng dần theo số lần sai liên tiếp, CAPTCHA (Turnstile) sau 5 lần login sai. Middleware rate limit dùng chung được dựng ở phase này; các quota khác gắn phase sở hữu endpoint — unlock/recovery 5 lần/15 phút/user và passkey options 20/phút thuộc [P03](P03-vault.md), write 10 rps và suggest 20 rps burst 40 thuộc [P04](P04-content.md)/[P05](P05-search.md), export 3/giờ thuộc [P06](P06-beta.md).
- `AUTH_REQUIRE_EMAIL_VERIFICATION=false` mặc định; khi true phải có verification flow gửi/lấy token hợp lệ trước tạo vault. Email chưa verified không dùng để tự động merge danh tính.
- Session HttpOnly/Secure/SameSite=Lax, access/refresh policy §9.1, refresh rotation và reuse detection, logout/revoke.
- Settings account: hiển thị/đổi email qua verify địa chỉ mới, password đăng nhập, link identity khi đã auth, locale/theme. Auto-lock/semantic có trường trong settings nhưng UI tính năng do P03/P05 hoàn tất.
- Re-auth grant 5 phút gắn user/session/action, CSRF, audit store/read và notification adapter dùng cho vault về sau.

Ngoài phạm vi: encryption passphrase, RK/passkey vault, passkey login, email lấy lại VK. Không dùng email account verification làm recovery vault.

## UI và thiết kế cần thêm

- U6 theo [settings.html](../../mockups/settings.html) `#taikhoan`; session list thuộc `#baomat` do P02 wire trước, P03 tiếp phần vault.
- U19 theo [auth.html](../../mockups/auth.html): signup/login/verify/OAuth callback/re-auth, kèm lỗi sai credential, CAPTCHA sau 5 lần sai và lockout. Dialog account còn thiếu trong `settings.html` bổ sung ở phase này, dùng token hiện có rồi cập nhật bảng §7.0 và mockups README.
- U18 auth theo [states.html](../../mockups/states.html): đang submit, sai credential, email trùng, chưa verify, provider cancel/error, rate limit, session expired/revoked. Không tiết lộ có tài khoản qua lỗi login.
- App phân biệt `signed_out`, `authenticated_without_vault`, `authenticated_with_vault`; status vault đến từ API, không dùng localStorage làm nguồn quyền.

## API và dữ liệu

| Contract | Chủ sở hữu |
|---|---|
| Signup/login, OAuth start/callback, refresh/logout/me | Endpoint hiện có §9.2; hoàn thiện OpenAPI/response cookie. `GET /auth/me` trả cả `features.semantic_available` để client biết có được bật semantic hay không ([P05](P05-search.md) là bên tiêu thụ) |
| `/auth/reauth` | Password re-entry hoặc OAuth re-auth; grant không nằm trong URL/log |
| `/auth/sessions` + revoke một session | Chỉ list/revoke session user hiện tại; revoke current session về signed-out |
| `/me/settings` | Field whitelist, enum/locale validation; partial update không xoá field khác. `PATCH` bật `semantic_enabled` khi provider không sẵn sàng trả `409 SEMANTIC_UNAVAILABLE`, không lưu im lặng |
| Verify email, change email/password, link identity, audit feed | Bổ sung contract cụ thể vào OpenAPI và §9 trước handler; không để nút account chỉ toast |

Bảng sở hữu: `app_user`, `auth_identity`, `session`, `audit_log`; lưu token verify/re-auth hoặc hash/grant metadata theo ADR. Email gửi trong local dùng sink/mock transport; production provider config được xác minh P06. Audit có TTL/retention theo spec, payload whitelist.

**Re-auth cần chốt trước code:** mô tả từng provider kiểm tra danh tính và mức freshness ra sao. Google/OIDC có thể dùng tham số/claim phù hợp; không giả định GitHub trả `email_verified`/`auth_time` như OIDC hoặc hỗ trợ force password prompt. Đọc verified email từ API provider tương ứng. Callback từ browser đang có provider session không được quảng cáo là bắt nhập password lại. Ghi assurance và residual risk vào ADR, không đưa yêu cầu passphrase cũ trở lại để lấp lỗ hổng account auth.

Login password và encryption passphrase là hai bí mật khác nhau. Server không chứng minh client có VK; re-auth bảo vệ quyền gọi mutation account/vault. CSRF/ownership được kiểm tra server, không dựa route guard phía React.

## Cấu trúc và thứ tự

File dự kiến: `apps/api/internal/auth/**`, `internal/http/middleware/**`, `internal/db/migrations/**`, `internal/db/queries/auth*.sql`, `internal/audit/**`, `internal/notification/**`, `apps/web/features/auth/**`, `features/settings/account/**`, `lib/api/**`, `messages/**`.

1. Chốt OpenAPI auth/session/token lifecycle và migration; viết các ca tenant/token nguy hiểm trước handler tương ứng.
2. Password auth + session/refresh/logout + protected middleware; thiết lập CSRF và same-origin local từ P01.
3. OAuth signup/login/link/verification; xử lý identity collision mà không auto-link bằng email chưa chứng minh.
4. Re-auth grants + audit/notification adapter; chốt assurance của từng provider.
5. Mockup rồi UI auth/account/session, locale/theme persistence và trạng thái chuyển tới onboarding P03.

## Acceptance

| ID | Kịch bản | Đạt khi |
|---|---|---|
| P02-A1 | Signup password, login lại, reload | Session bền đúng TTL, password chỉ hash trên DB, route private bị chặn khi signed-out |
| P02-A2 | Google và GitHub | User mới/cũ/link/cancel đều đúng; mismatch state/nonce/PKCE/provider identity bị reject |
| P02-A3 | Refresh cạnh tranh/reuse | Không tạo hai nhánh refresh hợp lệ vô hạn; token reuse được xử lý theo policy ghi trong ADR |
| P02-A4 | Revoke session | User B không đọc/revoke phiên A; current/revoked session không gọi mutation tiếp được |
| P02-A5 | Re-auth grant | Sai user/session/action, hết 5 phút, revoked hoặc thiếu CSRF đều bị từ chối |
| P02-A6 | Account settings | Locale/theme giữ qua login; đổi email/password/link có re-auth và verify phù hợp, không takeover bằng email trùng |
| P02-A7 | Email flag | Default false không chặn onboarding; true yêu cầu verify thật, token hết hạn/reuse bị từ chối |
| P02-A8 | UI/accessibility | U6/U19 và auth errors khớp mockup; form label/focus/error en/vi, mobile và dark đúng |
| P02-A9 | Logs | Không password/token/query/body; audit đủ actor/action/result không có secret |
| P02-A10 | Rate limit và lockout | Quá 5 req/phút/IP trả 429 kèm thông tin retry; 5 lần login sai bật Turnstile và lockout tăng dần; lockout theo tài khoản không bị né bằng cách đổi IP, và không tiết lộ tài khoản có tồn tại hay không |
| P02-A11 | Settings degraded | `PATCH /me/settings` bật semantic lúc provider down trả `409 SEMANTIC_UNAVAILABLE` và không đổi state; `GET /auth/me` trả `features.semantic_available=false` đúng lúc đó |

## Bàn giao và giới hạn

P03 nhận user/session + re-auth/CSRF + audit/notification interface thực, không phụ thuộc cookie giả. OAuth fake-server tests không thay smoke test với cấu hình provider thật trước beta; thiếu credentials được ghi là chưa verify, không đánh dấu toàn bộ auth release-ready. Rollback giữ user/session schema tương thích; khi token policy sai có thể revoke sessions, không xoá account/vault.
