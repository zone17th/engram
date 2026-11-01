# ADR 0006 — Đặt lại mật khẩu tài khoản (Account Password Reset)

- Trạng thái: đề xuất (theo quyết định chủ repo `user-dec-017`, `user-dec-015`, `user-dec-016` và `advisor-dec-131`)
- Ngày: 2026-11-01
- Phase: P04 (lane `authui` — P04-AUTH)
- Nguồn: [SPEC](../SPEC.md) §3.1, §3.2, §3.16, §5.1, §5.8, §7.6, §8, §9; [ADR 0001](0001-auth-session-va-reauth-assurance.md); [ADR 0002](0002-vault-crypto-layout.md); [ADR 0003](0003-webauthn-prf-va-devkey.md); [threat model](../threat-model.md)
- Bất biến ràng buộc (`user-dec-016`): **Đặt lại mật khẩu tài khoản chỉ khôi phục quyền đăng nhập vào tài khoản, tuyệt đối không mở khoá, tạo lại khoá (re-key) hay xoá (reset) vault.** Kẻ tấn công chiếm được hộp thư email hoặc toàn bộ server vẫn không giải mã được thân entry nếu không có bí mật mở vault phía người dùng (encryption passphrase, recovery key, passkey PRF hoặc thiết bị đã nhớ `DevKey`).

## Bối cảnh

Chủ repo rà soát màn hình đăng nhập/đăng ký trên production (`user-dec-017`) và yêu cầu bổ sung luồng **Quên mật khẩu tài khoản** qua email bên cạnh phần giải thích mô hình mã hoá đầu-cuối, liên kết Điều khoản/Quyền riêng tư và bộ đo độ mạnh mật khẩu cục bộ.

Ở P02 ([ADR 0001](0001-auth-session-va-reauth-assurance.md)), hệ thống mới có:
- `POST /me/password`: đổi mật khẩu khi đang đăng nhập và có re-auth grant `account.password_change`, hoặc đặt mật khẩu lần đầu cho tài khoản OAuth-only qua `enrollment_token` (`purpose = 'password_enroll'`).
- Luồng khôi phục **vault passphrase** bằng 10 recovery key ở P03 (`POST /vault/unlock/recovery` + `POST /vault/recover/complete`, SPEC §3.10).

Tuy nhiên, người dùng đã có mật khẩu đăng nhập nhưng quên mật khẩu đó (khi đã đăng xuất và không liên kết OAuth) chưa có đường lấy lại quyền đăng nhập vào tài khoản để tới màn hình mở khoá vault. Tài liệu này chốt toàn bộ hợp đồng API, mô hình dữ liệu, cơ chế chống dò tài khoản (anti-enumeration), ràng buộc token, giới hạn tốc độ và ranh giới bảo mật với vault để U3 (API) và U4 (Web) triển khai.

## Quyết định

### 1. Ranh giới bảo mật tuyệt đối với Vault (`user-dec-016`)

1. **Tách biệt hoàn toàn mật khẩu tài khoản và bí mật mở vault:**
   - Mật khẩu tài khoản (`auth_identity.password_hash`, Argon2id phía server) chỉ xác thực danh tính với API để nhận cookie phiên (`sabk_session`, `sabk_refresh`).
   - Vault Key (`VK`) bảo vệ thân entry (`entry.ciphertext`) chỉ được bọc bởi `KEK` (dẫn xuất từ encryption passphrase trong Web Worker), 10 Recovery Key (`RK`), `PWK` (WebAuthn PRF) và `DevKey` (IndexedDB `sabk.device`).
2. **Không đụng trạng thái Vault khi reset mật khẩu tài khoản:**
   - Luồng reset mật khẩu tài khoản **không** đọc, ghi, sửa hay xoá bất kỳ bảng hay trường nào của vault (`vault`, `vault_recovery_key`, `vault_passkey`, `webauthn_challenge`, `entry`).
   - Sau khi đặt lại mật khẩu tài khoản và đăng nhập lại, người dùng **vẫn phải mở khoá vault** bằng một trong các đường hợp lệ: nhập encryption passphrase, dùng một trong 10 recovery key, xác thực bằng passkey PRF, hoặc mở trên trình duyệt đã bật "Nhớ thiết bị này" (`DevKey` — nếu phiên trên thiết bị đó chưa bị xoá `DevKey`).
3. **Truyền thông trung thực trên giao diện (copy bắt buộc):**
   - Cả màn hình nhập mật khẩu mới lẫn màn hình hoàn tất đặt lại mật khẩu đều phải nêu rõ: *"Đặt lại mật khẩu tài khoản không mở khoá dữ liệu đã mã hoá. Sau khi đăng nhập, bạn vẫn cần passphrase của vault, một recovery key, passkey hoặc thiết bị đã nhớ để mở vault."*

### 2. Endpoint và quy ước HTTP

Thêm 2 operation dưới `/api/v1` (nhóm `auth`), không yêu cầu session đăng nhập (`OptionalSession` + `AttachAnon` như `signup`/`login`), bắt buộc `Origin == APP_ORIGIN`, `Content-Type: application/json`, và `X-CSRF-Token` khớp cookie `sabk_csrf` (anonymous hoặc session):

| Method & Path | `operationId` | Request Body | Response thành công | Mã lỗi chính |
|---|---|---|---|---|
| `POST /auth/password/forgot` | `authPasswordForgot` | `{email, captcha_token?}` | `202 Accepted` (body rỗng, `Cache-Control: no-store`) | `400 invalid_request`, `403 csrf_invalid` / `captcha_required`, `429 rate_limited`, `503 mail_delivery_unavailable` |
| `POST /auth/password/reset` | `authPasswordReset` | `{token, new_password}` | `204 No Content` (body rỗng, xoá cookie session/refresh hiện tại nếu có, `Cache-Control: no-store`) | `400 invalid_request` / `password_weak` / `reset_token_invalid`, `403 csrf_invalid`, `429 rate_limited` |

- **Không tự động đăng nhập sau `POST /auth/password/reset` (trả `204 No Content`):**
  - Không phát session mới ngay trong response reset. Người dùng chuyển về màn hình đăng nhập (`/app/auth/login`) kèm thông báo thành công để đăng nhập lại bằng mật khẩu vừa đặt.
  - Nếu trình duyệt gọi `POST /auth/password/reset` đang mang sẵn cookie `sabk_session` / `sabk_refresh` cũ, server xoá luôn các cookie auth trên response `204` (giữ nguyên cookie `sabk_locale`, `sabk_theme` và cấp lại `sabk_anon`/`sabk_csrf` anonymous khi bootstrap tiếp theo).
  - Lý do: tránh giữ trạng thái nửa chừng giữa phiên cũ trong tab với phiên mới, buộc luồng đăng nhập chuẩn khởi tạo lại CSRF/session/guard sạch sẽ trước khi bước vào màn hình mở khoá vault.
- **Không mở endpoint `POST /auth/password/reset/check`:**
  - Trạng thái token hết hạn, đã dùng hoặc không hợp lệ được kiểm tra và hiển thị ngay khi người dùng gửi biểu mẫu đặt mật khẩu mới (`POST /auth/password/reset` trả `400 reset_token_invalid`).
  - Lý do: tuân thủ nguyên tắc UX tối giản (`user-dec-015`), bớt một bề mặt API unauthenticated có thể bị dò quét, và tránh rò rỉ trạng thái token trước khi người dùng thực sự gửi mật khẩu mới hợp lệ. Trên màn hình lỗi `reset_token_invalid`, giao diện hiển thị ngay nút chuyển về màn hình yêu cầu gửi lại liên kết mới.

### 3. Chống dò tài khoản (Anti-Enumeration) và xử lý Mailer

`POST /auth/password/forgot` bảo đảm không tiết lộ email có tồn tại trong hệ thống hay thuộc loại tài khoản nào:

1. **Chuẩn hoá và kiểm tra định dạng trước khi đụng DB:**
   - Chuẩn hoá `email` bằng `NormalizeEmail(in.Email)`. Nếu sai định dạng RFC 5322 addr-spec → trả `400 invalid_request` (kiểm tra thuần cú pháp, không phụ thuộc DB).
2. **Kiểm tra khả năng gửi mail ở mức toàn cục (`mail_delivery_unavailable`):**
   - Nếu mailer chưa được cấu hình hoặc đang ở trạng thái tắt/lỗi cấp hệ thống (`s.mail == nil`), trả ngay `503 mail_delivery_unavailable` **trước** khi tra cứu email trong DB.
   - Vì đây là trạng thái cấu hình của cả deployment (mọi địa chỉ email đều nhận `503 mail_delivery_unavailable` như nhau), phản hồi này **không** làm lộ sự tồn tại của tài khoản nhưng giúp giao diện hiển thị thông báo trung thực (không hứa hẹn *"kiểm tra hộp thư của bạn"* khi máy chủ chưa bật dịch vụ gửi thư — đáp ứng `advisor-dec-086`).
3. **Đồng nhất mã trạng thái, body và lớp thời gian phản hồi (Timing Class):**
   - Với mọi email hợp lệ về cú pháp (khi mailer sẵn sàng và chưa vượt rate limit):
     - Tài khoản tồn tại và có password identity (`provider = 'password'`),
     - Tài khoản tồn tại nhưng chỉ có OAuth (`google` / `github`, chưa có password identity),
     - Email không tồn tại hoặc tài khoản đã xoá (`deleted_at IS NOT NULL`),
     đều trả về **đúng cùng một response `202 Accepted` không có body** (`Cache-Control: no-store`).
   - Giao diện luôn hiển thị cùng một thông điệp trung lập: *"Nếu địa chỉ email này có tài khoản, chúng tôi đã gửi hướng dẫn tiếp theo."*
   - **Gửi email bất đồng bộ (Asynchronous Mail Delivery):** Sau khi transaction DB tạo token (hoặc kiểm tra tài khoản) hoàn tất, việc gọi `Mailer.Send` được thực hiện bất đồng bộ (qua River job `password_reset_mail` hoặc goroutine nền tách rời thời gian trả HTTP response, tương tự cơ chế `security_notice_mail` của P02) để độ trễ mạng SMTP/API gửi thư không tạo ra chênh lệch thời gian giữa email tồn tại và email không tồn tại. Nếu gửi nền thất bại, worker ghi log lỗi đã scrub (không log email hay token).

### 4. Hành vi theo trạng thái tài khoản (OAuth-only & Email chưa xác minh)

1. **Tài khoản OAuth-only (chưa có `auth_identity` với `provider = 'password'`):**
   - **Tuyệt đối không biến luồng quên mật khẩu thành đường đặt mật khẩu lần đầu thứ hai.** Đường đặt mật khẩu lần đầu của tài khoản OAuth-only vẫn giữ nguyên là **US1b** (`POST /auth/password/enroll/send` + `POST /me/password` khi đang đăng nhập, hoặc Google fresh re-auth).
   - Khi nhận `POST /auth/password/forgot` cho một tài khoản chỉ có liên kết Google/GitHub:
     - Server **không** sinh reset token.
     - Server xếp hàng gửi một email thông báo (purpose `password_reset_oauth_only`, không chứa link token) nhắc người dùng rằng tài khoản này đang đăng nhập bằng Google/GitHub và họ có thể đặt mật khẩu đăng nhập trong mục **Cài đặt › Tài khoản** sau khi đăng nhập.
     - HTTP response vẫn là `202 Accepted` y hệt mọi trường hợp khác.
2. **Tài khoản đã có password nhưng email chưa xác minh (`email_verified_at IS NULL`):**
   - **Cho phép** đặt lại mật khẩu qua email khi `AUTH_REQUIRE_EMAIL_VERIFICATION=false` (mặc định hệ thống) cũng như khi `true`, vì địa chỉ email chính là định danh đăng nhập của tài khoản password đó.
   - **Tự động đánh dấu email đã xác minh khi hoàn tất reset:** Khi người dùng tiêu thụ thành công token từ hộp thư trong `POST /auth/password/reset`, nếu `app_user.email_verified_at IS NULL` (và `app_user.email` vẫn khớp `target_email` của token), server cập nhật luôn `email_verified_at = now()` trong cùng transaction. Lý do: chứng minh quyền kiểm soát hộp thư qua token 32 byte CSPRNG gửi tới địa chỉ đó có độ đảm bảo tương đương luồng `verify-email` (`signup`).

### 5. Thiết kế Token, Bảng dữ liệu (Migration `0007_password_reset`) và Ràng buộc trạng thái

Để ràng buộc chặt token với **trạng thái mật khẩu hiện tại** (`password_hash_sha256`) mà không làm phình hay nới lỏng ràng buộc `CHECK (session_id IS NOT NULL)` trên bảng `email_verification` của P02, U3 tạo bảng riêng `password_reset_token` trong migration `0007_password_reset.{up,down}.sql` (chạy sau `0006_content`):

```sql
CREATE TABLE password_reset_token (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  target_email         citext NOT NULL,
  token_hash           bytea NOT NULL UNIQUE,
  password_hash_sha256 bytea NOT NULL,
  expires_at           timestamptz NOT NULL,
  consumed_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(token_hash) = 32),
  CHECK (octet_length(password_hash_sha256) = 32)
);

CREATE INDEX password_reset_token_pending_idx
  ON password_reset_token (user_id)
  WHERE consumed_at IS NULL;

CREATE INDEX password_reset_token_expires_idx
  ON password_reset_token (expires_at);
```

Các bất biến của token:
1. **Sinh và lưu chỉ bản băm:**
   - Sinh 32 byte CSPRNG bằng `NewOpaqueToken()` (`crypto/rand`), mã hoá base64url không padding (43 ký tự) để đưa vào link email.
   - DB chỉ lưu `token_hash = SHA256Bytes(raw)` (32 byte), tuyệt đối không lưu plaintext token.
2. **Thời hạn (TTL) và dùng một lần (Single-use):**
   - ` TTL = 30 phút ` (`expires_at = now + 30m`).
   - Khi phát hành token mới cho `user_id`, server vô hiệu hoá ngay mọi token chưa dùng trước đó của cùng `user_id` (`UPDATE password_reset_token SET consumed_at = $now WHERE user_id = $uid AND consumed_at IS NULL`) trong cùng transaction trước khi `INSERT`.
   - Khi tiêu thụ tại `POST /auth/password/reset`, server khoá hàng user (`GetUserByIDForUpdate`) và hàng token (`SELECT * FROM password_reset_token WHERE token_hash = $1 FOR UPDATE`), kiểm tra `consumed_at IS NULL` và `expires_at > now`, rồi đánh dấu `consumed_at = now`.
3. **Ràng buộc vào trạng thái mật khẩu và email hiện tại (State Binding):**
   - Lúc tạo token, server lấy `auth_identity` (`provider = 'password'`) hiện tại của user và tính `password_hash_sha256 = SHA256Bytes([]byte(*identity.PasswordHash))`, lưu cùng `target_email = user.Email`.
   - Lúc tiêu thụ token (`POST /auth/password/reset`), sau khi khoá `app_user` và `auth_identity` (`provider = 'password'`), server kiểm tra:
     1. User chưa bị xoá (`deleted_at IS NULL`).
     2. `equalFoldEmail(row.TargetEmail, user.Email)` vẫn đúng (nếu user đã đổi email sau khi yêu cầu reset, token cũ tự động vô hiệu).
     3. User vẫn có password identity và ` subtle.ConstantTimeCompare(row.PasswordHashSha256, SHA256Bytes([]byte(*identity.PasswordHash))) == 1 `.
   - Hệ quả: nếu mật khẩu tài khoản đã được thay đổi (qua `POST /me/password`, qua một token reset khác, hoặc gỡ password identity) sau thời điểm phát hành token, `password_hash_sha256` sẽ lệch và token lập tức bị từ chối với `400 reset_token_invalid`.
4. **Dọn dẹp định kỳ (Prune):**
   - Worker `AuthPruneWorker` (`internal/worker/auth_prune.go`) xoá các hàng `password_reset_token` có `expires_at < now - 24h` cùng chu kỳ với `email_verification`.

### 6. Truyền tải Token qua URL Fragment và Bảo vệ chống rò rỉ Link

Đồng nhất với `verify-email` và `password-enroll` của P02 ([ADR 0001](0001-auth-session-va-reauth-assurance.md)):
- Link trong email có dạng:
  `{APP_ORIGIN}/app/auth/reset-password#token=<base64url_32B>`
- **Vì sao dùng URL Fragment (`#token=...`) thay vì Query (`?token=...`):**
  - Trình duyệt không bao giờ gửi phần `#fragment` trong HTTP request `GET /app/auth/reset-password` lên máy chủ web hay reverse proxy (`nginx`), nên token không bao giờ lọt vào access log của nginx/Next.js hay header `Referer` khi tải tài nguyên.
  - Ngay khi trang `/app/auth/reset-password` mount (`useLayoutEffect`), client đọc token từ `window.location.hash` vào biến bộ nhớ (in-memory state) và gọi ngay `window.history.replaceState(null, '', window.location.pathname + window.location.search)` để xoá `#token=...` khỏi thanh địa chỉ và lịch sử trình duyệt.
  - Trang đặt `Referrer-Policy: no-referrer` và `Cache-Control: no-store`. Token chỉ được gửi đúng một lần trong JSON body của `POST /api/v1/auth/password/reset`.

### 7. Giới hạn tốc độ (Rate Limits)

Sử dụng bộ giới hạn cửa sổ cố định (`httpx.FixedWindow`) và HMAC subject theo chuẩn P02 (`authhttp` / `auth/hmac.go`):

1. **Trên `POST /auth/password/forgot`:**
   - **Theo IP:** dùng chung bucket `credLimit` **5 yêu cầu / phút / IP** (hoặc bucket `forgotIP` 5/phút/IP) — vượt quá trả `429 rate_limited` kèm header `Retry-After` và `retry_after` trong body.
   - **Theo địa chỉ email đã chuẩn hoá (HMAC `HashEmailSubject(emPepper, email)`):**
     - **1 yêu cầu / phút / email** (`forgotEmailMin = NewFixedWindow(1)`) VÀ **3 yêu cầu / giờ / email** (`forgotEmailHour = NewFixedWindowWith(3, time.Hour)`), khớp đúng hạn mức gửi mail `1/phút` + `3/giờ` của `limitMail` ở P02.
     - **Quan trọng (Anti-Enumeration):** Bộ đếm theo HMAC email được kiểm tra và tăng **trước** khi tra cứu DB cho **mọi** địa chỉ email hợp lệ về cú pháp (dù email đó có tồn tại trong DB hay không). Nhờ vậy, kẻ tấn công gửi lặp lại một email bất kỳ sẽ chạm ngưỡng `429 rate_limited` ở đúng lần thứ 2 trong 1 phút (hoặc lần thứ 4 trong 1 giờ) bất kể tài khoản có tồn tại hay không.
2. **Trên `POST /auth/password/reset`:**
   - **Theo IP:** dùng chung `credLimit` **5 yêu cầu / phút / IP** (cùng nhóm với `login`, `signup`, `reauth`, `verify-email/confirm`).
   - Kiểm tra độ mạnh/quy cách `new_password` (`ValidatePassword`: ≥ 12 ký tự Unicode, ≤ 1024 byte UTF-8) trước hoặc cùng lúc; mật khẩu yếu trả `400 password_weak`.

### 8. Hoàn tất Reset: Thu hồi phiên, Thông báo và Sự kiện bảo mật (`secevent`)

Khi `POST /auth/password/reset` kiểm tra hợp lệ và cập nhật mật khẩu trong transaction DB:

1. **Cập nhật mật khẩu và trạng thái xác minh:**
   - Băm `new_password` bằng `HashPassword` (Argon2id `m=64MiB, t=3, p=1`, salt 16 B mới, key 32 B) và cập nhật `auth_identity.password_hash`.
   - Đánh dấu `password_reset_token.consumed_at = now`.
   - Vô hiệu hoá mọi proof email/enrollment đang chờ của user (`CancelPendingEmailProofs`) và mọi token reset khác còn sống của user.
   - Nếu `user.EmailVerifiedAt` đang `NULL`, cập nhật `email_verified_at = now`.
   - Reset bộ đếm khoá đăng nhập `auth_throttle` của email đó (`ResetThrottle(subject)`), để người dùng vừa đặt lại mật khẩu xong có thể đăng nhập ngay mà không bị kẹt bởi các lần gõ sai mật khẩu cũ trước đó.
2. **Thu hồi TOÀN BỘ phiên và refresh token (`RevokeAllUserSessions`):**
   - Thực thi `UPDATE session SET revoked_at = $now WHERE user_id = $uid AND revoked_at IS NULL` — thu hồi **mọi** session của user (không giữ lại bất kỳ session nào, vì request reset là unauthenticated và không tạo session mới).
   - Hệ quả dây chuyền theo P02/P03:
     - Mọi access JWT đang còn hạn sẽ bị middleware `EnsureLive` từ chối ngay lập tức với `401 session_invalid` (`reason = revoked`).
     - Mọi refresh token (hiện tại hoặc trong `session_refresh_used`) đều không thể xoay tiếp.
     - Mọi re-auth grant (`X-Reauth-Token`) từng cấp cho các session cũ đều mất hiệu lực vì session gắn với grant đã bị revoke.
     - Các tab đang mở của user khi nhận `401 session_invalid` (`reason = revoked`) sẽ xoá cache plaintext trong Worker/DOM và xoá `DevKey` trên thiết bị đó theo đúng quy tắc P03 ([ADR 0003](0003-webauthn-prf-va-devkey.md)).
3. **Ghi sự kiện bảo mật (`secevent`) và gửi thông báo (`user_notification` + email):**
   - Thêm hằng số sự kiện `EventPasswordReset = "auth.password.reset"` vào `internal/secevent/event.go` (hoặc ghi nhận cùng `EventPasswordChange` nếu dùng chung, quyết định: thêm rõ `EventPasswordReset = "auth.password.reset"` để phân biệt đổi mật khẩu khi đang đăng nhập với đặt lại qua email trong nhật ký bảo mật `GET /auth/audit`).
   - Ghi `s.audit.Record(ctx, tx, secevent.Record{UserID: &uid, SessionID: nil, Event: secevent.EventPasswordReset, Result: secevent.ResultSuccess, Actor: "user", IPHash: HashIP(s.ipPepper, ip), UserAgent: ua})`.
   - Gọi `s.notify.NotifySecurity(ctx, tx, secevent.Notice{UserID: uid, Kind: secevent.NoticeSecurity, EmailTargets: []string{u.Email}})` để tạo thông báo trong ứng dụng (`user_notification`) **và** xếp job River `security_notice_mail` gửi email cảnh báo *"Mật khẩu tài khoản của bạn vừa được thay đổi"* tới địa chỉ email của tài khoản.

### 9. Mã lỗi RFC 9457 (Problem Catalog — 5 nơi trong 1 commit)

- **Chỉ thêm đúng 1 mã lỗi mới vào cuối catalog:**
  - `reset_token_invalid` (HTTP `400 Bad Request`, title tiếng Việt trong `httpx`: `"Mã đặt lại mật khẩu không hợp lệ"`).
  - Dùng chung một mã `reset_token_invalid` cho mọi nguyên nhân token không dùng được: sai định dạng base64url/độ dài, không tồn tại trong DB, đã được tiêu thụ (`consumed_at IS NOT NULL`), đã quá hạn 30 phút (`expires_at <= now`), email tài khoản đã đổi, hoặc mật khẩu tài khoản đã thay đổi từ sau khi phát hành token (`password_hash_sha256` không khớp). Việc gộp chung một mã đảm bảo server không tiết lộ chi tiết trạng thái nội bộ cho kẻ tấn công.
- **Tái sử dụng các mã lỗi đã có:**
  - `invalid_request` (`400`): JSON hỏng, trường lạ, email sai định dạng.
  - `password_weak` (`400`): `new_password` ngắn hơn 12 ký tự Unicode hoặc dài hơn 1024 byte UTF-8.
  - `csrf_invalid` (`403`): thiếu hoặc sai `Origin` / `X-CSRF-Token`.
  - `captcha_required` (`403`): khi Turnstile bật và yêu cầu xác minh.
  - `rate_limited` (`429`): vượt hạn mức theo IP hoặc theo email (kèm `Retry-After` và `retry_after`).
  - `mail_delivery_unavailable` (`503`): dịch vụ gửi thư chưa cấu hình hoặc không sẵn sàng.
- Cập nhật đồng bộ cả 5 nơi trong cùng một commit:
  1. `apps/api/internal/httpx/codes.go` (`ProblemCodes` — nối `"reset_token_invalid"` vào cuối slice, ngay sau `"changes_window_expired"`).
  2. `apps/api/internal/httpx/problem.go` (`problemTitles` — thêm `"reset_token_invalid": "Mã đặt lại mật khẩu không hợp lệ"`).
  3. `apps/api/internal/auth/authhttp/errors.go` (`statusFor` — thêm `"reset_token_invalid"` vào nhánh `http.StatusBadRequest`, cùng `auth.ErrResetTokenInvalid` trong `internal/auth/errors.go`).
  4. `apps/api/api/openapi.yaml` (`components.schemas.ProblemCode.enum` — nối `- reset_token_invalid` vào cuối danh sách).
  5. `packages/shared-types/src/problem.ts` (`ERROR_CODES` — nối `'reset_token_invalid'` vào cuối tuple) + chạy generator cập nhật `packages/shared-types/src/api.d.ts`.

## Các phương án đã cân nhắc và loại bỏ (Alternatives)

| Phương án | Lý do loại bỏ |
|---|---|
| **Tự động đăng nhập (cấp session cookie) ngay trong `POST /auth/password/reset`** | Phá vỡ sự tách bạch giữa bước khôi phục thông tin đăng nhập và bước đăng nhập mới; làm phức tạp xử lý cookie/CSRF khi tab đang mở có sẵn session cũ của user khác hoặc chính user đó. Trả `204` rồi đưa người dùng về màn đăng nhập giúp luồng rõ ràng và an toàn hơn. |
| **Thêm endpoint `POST /auth/password/reset/check` để kiểm tra token trước khi hiện form** | Tăng thêm một endpoint unauthenticated để dò token, tốn thêm round-trip và state UI mà không tăng độ an toàn (token vẫn có thể hết hạn hoặc bị thay thế trong lúc người dùng đang gõ mật khẩu mới). Kiểm tra một lần khi submit (`POST /auth/password/reset`) đơn giản hơn (`user-dec-015`). |
| **Dùng chung bảng `email_verification` bằng cách thêm `purpose = 'password_reset'`** | Bảng `email_verification` có ràng buộc `CHECK (purpose = 'signup' OR (purpose IN ('email_change', 'password_enroll') AND session_id IS NOT NULL))` và không có cột `password_hash_sha256` (32 byte `NOT NULL`) để buộc chặt token vào trạng thái mật khẩu hiện tại. Tạo bảng riêng `password_reset_token` ở migration `0007` giữ nguyên các ràng buộc `NOT NULL` chặt chẽ mà không cần cột nullable thừa. |
| **Cho phép tài khoản OAuth-only đặt mật khẩu lần đầu qua `POST /auth/password/forgot`** | Biến forgot-password thành đường enrollment thứ hai không qua phiên đăng nhập và không qua kiểm tra bảo mật của US1b. Giữ cố định một đường US1b duy nhất; với OAuth-only chỉ gửi email nhắc nhở phương thức đăng nhập. |
| **Đặt token trong query string (`?token=...`)** | Query string bị trình duyệt gửi lên server trong request tải trang HTML, dễ lọt vào access log của reverse proxy (`nginx`), lịch sử proxy hoặc header `Referer`. Dùng `#token=...` (URL fragment) + `history.replaceState` loại bỏ hoàn toàn rủi ro này. |
| **Tách riêng các mã lỗi `reset_token_expired`, `reset_token_used`, `reset_token_not_found`** | Tiết lộ thông tin không cần thiết cho kẻ tấn công về việc một token có từng tồn tại hay đã được người dùng sử dụng hay chưa. Một mã `reset_token_invalid` duy nhất đủ để UI hiển thị hướng dẫn yêu cầu liên kết mới. |

## Hệ quả

- **U2 (Contract):** Cập nhật `docs/SPEC.md` (thêm `US1c`, `§3.16`, cập nhật `§7.6`, `§8`, `§9.1`, `§9.2`), `docs/threat-model.md` (thêm kịch bản chiếm email -> chiếm tài khoản nhưng vault vẫn khoá kín, rò rỉ link reset, dò tài khoản), `apps/api/api/openapi.yaml`, 5 nơi của problem catalog và tái sinh `packages/shared-types`.
- **U3 (API):** Thêm migration `0007_password_reset.{up,down}.sql`, queries sqlc cho `password_reset_token` và `RevokeAllUserSessions`, worker/async mail cho `password_reset` và `password_reset_oauth_only`, service + handler cho `POST /auth/password/forgot` và `POST /auth/password/reset`, cùng bộ kiểm thử tích hợp (anti-enumeration, single-use, TTL 30m, password-change invalidation, session revocation, rate limits, OAuth-only mail, secevent & notice mail).
- **U4 (Web):** Thêm route `/app/auth/forgot-password` và `/app/auth/reset-password`, đọc `#token=` bằng `useLayoutEffect` + `history.replaceState`, hiển thị rõ trạng thái `mail_delivery_unavailable` (không hứa hẹn inbox) và cảnh báo bắt buộc rằng vault vẫn cần passphrase / recovery key / passkey / thiết bị đã nhớ.
