# ADR 0001 — Session, CSRF, refresh và assurance re-auth

- Trạng thái: chấp nhận (quyết định triển khai P02)
- Ngày: 2026-09-15
- Phase: P02
- Phụ thuộc: P01 HEAD `c7784a9` (config typed, `httpx`, client `apiFetch`, sqlc, migration 0001–0003, same-origin proxy)
- Không phải bằng chứng: ADR này không khẳng định đã kiểm Google/GitHub/Turnstile/mail production

## Bối cảnh

SPEC v0.7 mô tả auth/session/re-auth nhưng chưa chốt hạn refresh tuyệt đối, cookie phụ (CSRF anonymous, OAuth binding, enrollment), reuse detection, hay cách OAuth-only đặt password lần đầu khi provider không chứng minh freshness. P02 cần các quyết định này trước handler.

## Quyết định

### Cookie và TLS

Mọi cookie host-only (không `Domain`), `Secure`, `SameSite=Lax`. Production bắt buộc `APP_ORIGIN` HTTPS. Local giữ `http://localhost:3000` theo P01; hành vi Secure cookie trên browser mục tiêu được kiểm ở Task 24, không tắt Secure cho production.

| Cookie | Path | TTL | HttpOnly |
|---|---|---|---|
| `sabk_session` | `/api` | `min(10m, session.expires_at)` | có |
| `sabk_refresh` | `/api/v1/auth` | không vượt hạn tuyệt đối session (30 ngày) | có |
| `sabk_csrf` | `/` | theo session; anonymous 10 phút | không |
| `sabk_anon` | `/api/v1/auth` | 10 phút | có |
| `sabk_oauth` | `/api/v1/auth` | 10 phút | có |
| `sabk_reauth` | `/api/v1/auth` | 2 phút, không vượt deadline flow | có |
| `sabk_locale`, `sabk_theme` | `/` | 1 năm | không |

Logout xoá cookie auth (kể cả anon/oauth/reauth), không xoá preference.

### Session tuyệt đối và refresh không grace

Session có hạn tuyệt đối 30 ngày; refresh không kéo dài. Access JWT HS256 chỉ chứa version, `iss`, `aud`, `sub=user_id`, `sid=session_id`, `iat`, `exp`, `jti`. Secret JWT ≠ CSRF ≠ re-auth.

`POST /auth/refresh` không cần access còn hạn. Rotation: hash hiện tại → secret mới, hash cũ vào `session_refresh_used`, giữ `expires_at`. **Không grace window.** Hai request cùng token: một rotation; nhánh reuse (sau CSRF hợp lệ) **commit revoke** cả session — access vừa cấp cũng chết. Hash lạ chỉ reject. CSRF sai không revoke session của nạn nhân.

Lịch sử hash giữ đến khi session không thể sống (hết hạn tuyệt đối hoặc đã revoke + hết cửa sổ phát hiện reuse). Không prune sớm hơn TTL session.

Mất response refresh sau commit có thể buộc đăng nhập lại; client không retry refresh mù. Đây là giới hạn đã ghi, không phải lỗi password.

Browser xoá access cookie khi hết 10 phút, nên protected API có thể trả `unauthenticated` thay vì `access_expired`. Với route cần session, client chỉ thử phục hồi trường hợp này khi CSRF cookie có loại session; bootstrap có thể tạo cookie đó sau khi nhận diện refresh HttpOnly. Đây là dấu hiệu điều phối, không phải proof cấp quyền. Trong Web Lock, client đọc lại Me trước khi rotate; signed-out có CSRF anonymous không rotate. Lỗi mạng/5xx giữ trạng thái unavailable; `session_invalid.reason` được chuyển tới subscriber cùng tab và các tab khác.

### CSRF anonymous và bootstrap

`GET /auth/csrf` trả 204 + cookie, không phải đăng nhập. Session còn hiệu lực → ký theo session ID. Access hết hạn có thể nhận diện qua refresh hash hiện tại/lịch sử nhưng không rotate/revoke. Chưa có session → nonce anonymous HttpOnly + HMAC gắn nonce. Không reset nonce còn hạn sau mỗi GET. Prefix chữ ký anonymous và session khác nhau; so khớp constant-time.

Mọi unsafe request: `Origin == APP_ORIGIN`, `Content-Type: application/json`, `X-CSRF-Token` khớp cookie đã ký. Không dựa riêng SameSite. Cross-site GET csrf bị reject qua Fetch Metadata khi có. Không bật credentialed CORS cho origin khác.

OAuth callback là ngoại lệ redirect: state + cookie binding + transaction một lần. GET OAuth start chỉ login; link/re-auth dùng POST + CSRF.

### Provider assurance

- Google OIDC: dùng authorize/token/JWKS endpoint cố định, kiểm chữ ký RSA/issuer allowlist/audience/azp/iat/expiry/nonce/`email_verified`. Re-auth gửi `prompt=select_account`, `max_age=0`; chỉ cấp grant khi `AUTH_GOOGLE_REAUTH_ENABLED=true` **và** kiểm được freshness đã ký: `auth_time >= flow.started_at - 120s`, `auth_time <= now + 30s`. Thiếu/stale `auth_time` fail closed. Mặc định capability tắt — chưa có evidence cấu hình production.
- GitHub: `/user` + `/user/emails` (primary verified). Dùng login/link. Callback im lặng không phải fresh authentication; không cấp re-auth grant.
- Login provider bật ≠ re-auth bật. Fake-provider test không thay smoke production (P06).
- Adapter production Google/GitHub thực hiện token exchange và xác minh identity trong P02; HTTP fixture kiểm cả nhánh hợp lệ và dữ liệu provider sai. P06 xác minh cấu hình credentials/callback thật, không thay việc triển khai adapter bằng smoke test.
- OAuth re-auth chỉ cấp receipt khi provider subject đã liên kết đúng user của session, không dùng email làm bằng chứng liên kết. Callback kiểm lại deadline và session sau provider exchange; receipt không sống quá deadline flow.

### Password enrollment (OAuth-only)

Tài khoản chưa có password, email hiện tại đã verified: `POST /auth/password/enroll/send` gửi token hash-only, purpose `password_enroll`, gắn user/session/email, TTL 10 phút. `POST /me/password` nhận `{new_password, enrollment_token}` **hoặc** grant `account.password_change` — hai proof loại trừ. Password đã tồn tại luôn cần grant, không nhận enrollment token.

Email proof chỉ thêm password lần đầu: không cấp grant vault, không mở VK, không verify email chưa verified thay signup. Không phải password reset và không phải recovery vault.

### Grant replay

Grant HMAC: version, user, session, **một** action, iat, exp, nonce. TTL cố định 5 phút (không env nới). Dùng lại đúng action trong TTL nếu session còn sống; không consume một lần theo nghĩa burn. Revoke session vô hiệu mọi grant. Đổi password thay session hiện tại nên grant cũ hết tác dụng. Header `X-Reauth-Token`. Grant không vào URL, cookie, cache hay telemetry.

### Signup email collision

`409 email_taken` là disclosure có chủ ý (khớp mockup), không áp dụng cho login (login luôn `invalid_credentials`).

### Retention audit/notice

`AUTH_AUDIT_RETENTION_DAYS` mặc định 90, áp dụng cho `audit_log` và `user_notification` toàn app. Prune không xoá session sống. OAuth/receipt/verification hết hạn + 24 giờ; throttle sau 24 giờ inactive; refresh history chỉ sau session hết hạn/revoke.

### Rate limit (chốt scope)

Cửa sổ cố định 60 giây, counter atomic, `Retry-After` tới cuối cửa sổ. Một replica API nhớ map in-memory có TTL/cap (MVP); scale-out cần store chung.

| Quota | Phạm vi | Không tính |
|---|---|---|
| 5/phút/IP | signup, login, refresh, OAuth start/link/reauth start, re-auth, confirm token | GET me/config/csrf/lists, logout |
| 20/phút/IP | OAuth callback + complete | — |
| 3/giờ/user và 1/phút/user | gửi verification/enrollment | — |

Lockout theo HMAC email (pepper riêng), xuyên IP; 5 lần sai → CAPTCHA + lock 1 phút, nhân đôi tới 1 giờ. Lock hết hạn không reset `failed_count`. Email không tồn tại cùng đường (dummy hash + cùng 429/CAPTCHA).

### Mail và vault

Local/test: sink file JSON trong workspace (`AUTH_MAIL_SINK_DIR`). Production không dùng sink. P02 `VaultStatusProvider` luôn `absent`. Server không nhận encryption passphrase / RK / VK / PWK.

## Hệ quả

- OpenAPI/SPEC phải khai 26 operation và bảng phụ trước handler.
- Client điều phối refresh trong Web Lock; UI ghi rõ mất response refresh = đăng nhập lại.
- P03 nhận middleware session/CSRF/re-auth và `session_invalid.reason=revoked` để xoá DevKey wrap; logout/expiry không tự xoá DevKey.
- P06 mới xác minh Google freshness thật, mail production, Turnstile/CSP production, trusted proxy topology.
