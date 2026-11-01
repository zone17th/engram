# ADR 0006 — Đặt lại mật khẩu tài khoản (Account Password Reset)

- Trạng thái: đề xuất (theo quyết định chủ repo `user-dec-017`, `user-dec-015`, `user-dec-016` và quyết định Advisor `advisor-dec-131`, `advisor-dec-140`, `advisor-dec-146`)
- Ngày: 2026-11-01
- Phase: P04 (lane `authui` — P04-AUTH)
- Nguồn: [SPEC](../SPEC.md) §3.1, §3.2, §3.16, §5.1, §5.8, §7.0, §7.6, §8, §9; [ADR 0001](0001-auth-session-va-reauth-assurance.md); [ADR 0002](0002-vault-crypto-layout.md); [ADR 0003](0003-webauthn-prf-va-devkey.md); [threat model](../threat-model.md)
- Bất biến ràng buộc (`user-dec-016`): **Đặt lại mật khẩu tài khoản chỉ khôi phục quyền đăng nhập vào tài khoản, tuyệt đối không mở khoá, tạo lại khoá (re-key) hay xoá (reset) vault.** Kẻ tấn công chiếm được hộp thư email hoặc toàn bộ server vẫn không giải mã được thân entry nếu không có bí mật mở vault phía người dùng (encryption passphrase, recovery key, passkey PRF hoặc trình duyệt vẫn đang nhớ `DevKey`).

## Bối cảnh

Chủ repo rà soát màn hình đăng nhập/đăng ký trên production (`user-dec-017`) và yêu cầu bổ sung luồng **Quên mật khẩu tài khoản** qua email bên cạnh phần giải thích mô hình mã hoá đầu-cuối, liên kết Điều khoản/Quyền riêng tư và bộ đo độ mạnh mật khẩu cục bộ.

Ở P02 ([ADR 0001](0001-auth-session-va-reauth-assurance.md)), hệ thống mới có:
- `POST /me/password`: đổi mật khẩu khi đang đăng nhập và có re-auth grant `account.password_change`, hoặc đặt mật khẩu lần đầu cho tài khoản OAuth-only qua `enrollment_token` (`purpose = 'password_enroll'`).
- Luồng khôi phục **vault passphrase** bằng 10 recovery key ở P03 (`POST /vault/unlock/recovery` + `POST /vault/recover/complete`, SPEC §3.10).

Tuy nhiên, người dùng đã có mật khẩu đăng nhập nhưng quên mật khẩu đó (khi đã đăng xuất và không liên kết OAuth) chưa có đường lấy lại quyền đăng nhập vào tài khoản để tới màn hình mở khoá vault. Tài liệu này chốt toàn bộ hợp đồng API, khả năng gửi mail (`mail_delivery_available`), mô hình dữ liệu, cơ chế chống dò tài khoản (anti-enumeration), hàng đợi worker bất đồng bộ trong bộ nhớ, thứ tự khoá hàng và điểm tuyến tính hoá (linearization point), chính sách bảo vệ chống đăng ký trước (pre-registration), giới hạn tốc độ, mã lỗi RFC 9457, thông báo bảo mật và hợp đồng giao diện/route guard cho U3 (API) và U4 (Web).

## Quyết định

### 1. Ranh giới bảo mật tuyệt đối với Vault (`user-dec-016`)

1. **Tách biệt hoàn toàn mật khẩu tài khoản và bí mật mở vault:**
   - Mật khẩu tài khoản (`auth_identity.password_hash`, Argon2id phía server) chỉ xác thực danh tính với API để nhận cookie phiên (`sabk_session`, `sabk_refresh`).
   - Vault Key (`VK`) bảo vệ thân entry (`entry.ciphertext`) chỉ được bọc bởi `KEK` (dẫn xuất từ encryption passphrase trong Web Worker), 10 Recovery Key (`RK`), `PWK` (WebAuthn PRF) và `DevKey` (IndexedDB `sabk.device`).
2. **Không đụng trạng thái Vault khi reset mật khẩu tài khoản:**
   - Luồng reset mật khẩu tài khoản **không** đọc, ghi, sửa hay xoá bất kỳ bảng hay trường nào của vault (`vault`, `vault_recovery_key`, `vault_passkey`, `webauthn_challenge`, `entry`) và không đụng tới passkeys hay `DevKey` (`user-dec-016`, `user-dec-017`, `advisor-dec-140` D3).
   - Sau khi đặt lại mật khẩu tài khoản và đăng nhập lại, người dùng **vẫn phải mở khoá vault** bằng một trong các đường hợp lệ: nhập encryption passphrase, dùng một trong 10 recovery key, xác thực bằng passkey PRF, hoặc mở trên trình duyệt hiện tại nếu trình duyệt đó vẫn còn giữ `DevKey` (lưu ý: vì đặt lại mật khẩu thu hồi toàn bộ phiên đăng nhập nên các thiết bị/trình duyệt khác khi nhận `401 session_invalid` với `reason = revoked` sẽ tự động xoá `DevKey` theo [ADR 0003](0003-webauthn-prf-va-devkey.md) §6).
3. **Truyền thông trung thực trên giao diện — Copy bắt buộc song ngữ `vi` + `en` (`AU2-FE1-3`, `AU2-FE1-4`, `AU2-FE1-9`, `AU2-FE1-14`, `AU2-FE1-16`):**
   - **Trên màn hình nhập mật khẩu mới (`/app/auth/reset-password`, trạng thái form):**
     - **VI:** *"Đặt lại mật khẩu đăng nhập không mở khoá được vault. Sau khi đăng nhập, bạn vẫn cần passphrase của vault, một recovery key hoặc passkey để mở nội dung đã mã hoá (hoặc trình duyệt này nếu trình duyệt vẫn còn nhớ thiết bị; việc đặt lại có thể xoá trạng thái nhớ thiết bị). Mọi phiên đăng nhập, kể cả trên trình duyệt này, sẽ bị đăng xuất."*
     - **EN:** *"Resetting your login password does not open your vault. After signing in, you will still need your vault passphrase, a recovery key, or a passkey to decrypt entries (or this browser if it still remembers the device; a reset can clear remembered devices). All sessions, including this browser's, will be signed out."*
   - **Gợi ý dưới ô mật khẩu mới (cảnh báo không dùng lại passphrase vault — `AU2-FE1-16`):**
     - **VI:** *"Ít nhất 12 ký tự (tối đa 1024 byte UTF-8). Không dùng passphrase của vault ở đây; mật khẩu này được gửi tới máy chủ của chúng tôi."*
     - **EN:** *"At least 12 characters (up to 1024 UTF-8 bytes). Do not use your vault passphrase here; this password is sent to our server."*
   - **Trên banner hoàn tất đặt lại mật khẩu hiển thị tại màn hình đăng nhập (`/app/auth/login?reset=done`, sau `204 No Content` — `AU2-FE2-2`):**
     - **VI (Tiêu đề `auth.login.resetSuccessTitle`):** *"Đã đặt mật khẩu đăng nhập mới — hãy đăng nhập lại"*
     - **EN (Title `auth.login.resetSuccessTitle`):** *"Your login password has been reset — sign in again with your new password."*
     - **VI (Nội dung `auth.login.resetSuccessBody`):** *"Mọi phiên đăng nhập, kể cả trên trình duyệt này, đã được đăng xuất. Đặt lại mật khẩu tài khoản không mở khoá vault — khi đăng nhập lại, bạn vẫn cần passphrase của vault, một recovery key hoặc passkey (hoặc trình duyệt này nếu trình duyệt vẫn còn nhớ thiết bị; việc đặt lại có thể xoá trạng thái nhớ thiết bị)."*
     - **EN (Body `auth.login.resetSuccessBody`):** *"All sessions, including this browser's, were signed out. Resetting your account password does not open your vault — after signing in, you still need your vault passphrase, a recovery key, or a passkey (or this browser if it still remembers the device; a reset can clear remembered devices)."*

### 2. Endpoint và quy ước HTTP

Thêm 2 operation dưới `/api/v1` (nhóm `auth`), không yêu cầu session đăng nhập (`OptionalSession` + `AttachAnon` như `signup`/`login`), bắt buộc `Origin == APP_ORIGIN`, `Content-Type: application/json`, và `X-CSRF-Token` khớp cookie `sabk_csrf` (anonymous hoặc session), đồng thời mở rộng `GET /auth/config` (`AuthConfig`):

| Method & Path | `operationId` | Request Body | Response thành công | Mã lỗi chính |
|---|---|---|---|---|
| `GET /auth/config` | `authConfig` | — | `200 OK` `{oauth_providers, email_verification_required, captcha_site_key, mail_delivery_available}` (`Cache-Control: no-store`) | — |
| `POST /auth/password/forgot` | `authPasswordForgot` | `{email, captcha_token?, locale?}` | `202 Accepted` (body rỗng, `Cache-Control: no-store`) | `400 invalid_request`, `403 csrf_invalid` / `captcha_required`, `429 rate_limited`, `503 mail_delivery_unavailable` |
| `POST /auth/password/reset` | `authPasswordReset` | `{token, new_password}` | `204 No Content` (body rỗng, xoá toàn bộ cookie auth bằng `ClearAuthCookies`, `Cache-Control: no-store`) | `400 invalid_request` / `password_weak` / `reset_token_invalid`, `403 csrf_invalid`, `429 rate_limited`, `503 dependency_unavailable` (`Retry-After: 1`) |

- **Ngôn ngữ email (`locale?` trong `PasswordForgotRequest` — `AU2-FE1-7`):**
  - `PasswordForgotRequest` nhận trường tuỳ chọn `locale` (`"en" | "vi"`, tham chiếu `#/components/schemas/Locale`); nếu bỏ trống thì mặc định `"en"`, nếu truyền giá trị ngoài `"en" | "vi"` thì trả `400 invalid_request`.
  - U4 gửi locale đang hiển thị trên giao diện khi gọi `POST /auth/password/forgot`.
  - Cả email đặt lại mật khẩu (`purpose = "password_reset"`) lẫn email nhắc nhở tài khoản OAuth-only (`purpose = "password_reset_oauth_only"`) đều được soạn theo `locale` của request này.
  - Email thông báo bảo mật sau khi hoàn tất đặt lại mật khẩu (`purpose = "password_reset_notice"`, xem mục 8.3) sử dụng `app_user.locale` đã lưu của tài khoản.
- **Không tự động đăng nhập sau `POST /auth/password/reset` (`204 No Content`) và quy trình dọn trạng thái phiên ở cả Server lẫn Client (`AU2-BE1-9`):**
  - Server **không** phát session mới trong response reset. Trên response `204 No Content`, handler bắt buộc gọi helper có sẵn `authhttp.ClearAuthCookies(w)` (`apps/api/internal/auth/authhttp/cookies.go:84-90`) để xoá đúng path cho toàn bộ cookie xác thực trên trình duyệt đang gọi:
    - `sabk_session` (path `/api`),
    - `sabk_refresh`, `sabk_anon`, `sabk_oauth`, `sabk_reauth` (path `/api/v1/auth`),
    - `sabk_csrf` (path `/`),
    - giữ nguyên `sabk_locale` và `sabk_theme`.
  - **Hành vi khi người dùng B đang đăng nhập trên trình duyệt nhưng mở link reset của tài khoản A (`AU2-BE1-9`):**
    - Trên server, token reset xác định tài khoản mục tiêu **A** (tuyệt đối không lấy principal tuỳ chọn của B làm chủ thể reset). Chỉ các phiên của **A** bị thu hồi trên server (`RevokeAllUserSessions(A)`); các phiên trên máy chủ của **B** ở thiết bị khác vẫn sống bình thường. Tuy nhiên, trình duyệt đang thực hiện thao tác reset bị xoá cookie auth cục bộ bởi `ClearAuthCookies(w)`.
    - Trên client (U4), vì response `204 No Content` không tự sinh lỗi `401 session_invalid`, ngay khi nhận `204` từ `POST /auth/password/reset` và **trước khi** điều hướng cứng (`window.location.assign('/app/auth/login?reset=done')`) về màn hình đăng nhập, client **bắt buộc**:
      1. Phát thông báo đăng xuất liên tab **`postSessionBroadcast({ type: 'signed_out', reason: 'logout' })`** làm **nguồn kích hoạt dọn dẹp duy nhất** (`AU2-FE2-7`a): hàm `postSessionBroadcast` (`apps/web/lib/auth/broadcast.ts:18-20`) gọi ngay lập tức các subscriber trong cùng tab lẫn các tab khác, nhờ đó handler trong `SessionProvider` (`apps/web/features/auth/session-provider.tsx:229-240`) tự động thực thi `setKnownDeviceSessionUserId(null)`, `setLastSessionEndReason('logout')`, `clearPrivateCache()`, `resetSessionEpoch()`, `setSessionEpochState(getSessionEpoch())` và `queryClient.setQueryData(['auth', 'me', getSessionEpoch()], null)` đúng một lần (tránh gọi lặp `clearPrivateCache()` / `resetSessionEpoch()` gây tăng epoch hai lần và refetch thừa).
      2. Gọi thêm **`await bootstrapCsrf()`** để lấy lại cặp cookie `sabk_anon` + `sabk_csrf` anonymous mới sau khi server đã xoá cookie bằng `ClearAuthCookies(w)`.
      3. Điều hướng cứng (**hard navigation**: `window.location.assign('/app/auth/login?reset=done')` — `AU2-FE2-1`, `AU2-FE2-2`) sang trang đăng nhập.
      - *Lưu ý về `DevKey` và `lastSessionEndReason` (`AU2-FE2-7`d):* Phát `reason: 'logout'` (không phải `'revoked'`) trên trình duyệt vừa bấm reset để không xoá nhầm `DevKey` của trình duyệt hiện tại nếu người dùng tự đặt lại mật khẩu trên chính máy đã nhớ của mình, trong khi vẫn khoá/dọn sạch bộ nhớ tạm và cache truy vấn riêng tư (`['auth', 'me']`, `['vault', ...]`, re-auth grant). Trên `/app/auth/login`, `LoginForm` chỉ hiển thị banner phiên kết thúc khi `lastSessionEndReason` là `'revoked'` hoặc `'expired'` (`login-form.tsx:53-56`), hoàn toàn bỏ qua `'logout'`; đồng thời khi người dùng đăng nhập lại thành công, `login()` / `completeOAuthLogin()` nạp `me` mới và `useEffect` tại `session-provider.tsx:252-265` đặt lại `terminalCleanupReason.current = null`, đảm bảo không bao giờ hiện nhầm banner phiên cũ sau khi đăng nhập.
- **Không mở endpoint `POST /auth/password/reset/check`:**
  - Trạng thái token hết hạn, đã dùng hoặc không hợp lệ được kiểm tra và tiêu thụ nguyên tử khi người dùng gửi biểu mẫu đặt mật khẩu mới (`POST /auth/password/reset` trả `400 reset_token_invalid`).
  - Lý do: tuân thủ nguyên tắc UX tối giản (`user-dec-015`), bớt một bề mặt API unauthenticated có thể bị dò quét, và tránh race condition giữa lúc mở trang với lúc bấm submit.

### 3. Khả năng gửi Mail thực tế (`mail_delivery_available`), Chính sách CAPTCHA và Ranh giới chấp nhận bất đồng bộ (Anti-Enumeration)

#### 3.1. Cờ khả năng gửi thư thực tế `mail_delivery_available` (`advisor-dec-140` D1 — `AU2-BE1-1`, `AU2-FE1-1`)

- **Vấn đề ở P02 và production hiện tại:** Hàm `compose.NewAuth` (`apps/api/internal/compose/auth.go:41-51`) luôn gắn `auth.SinkMailer` (ghi file JSON vào `.data/mail-sink`) khi `mail == nil` trong môi trường `APP_ENV=development`, nên điều kiện `s.mail == nil` không bao giờ xảy ra. Hiện tại VPS production (`engram.zone17.click`) đang chạy với sink mailer theo `advisor-dec-086` cho tới khi chủ repo cấu hình nhà cung cấp SMTP/API gửi thư thật.
- **Quyết định D1 (`advisor-dec-140`):**
  1. Bổ sung trường boolean bắt buộc `mail_delivery_available` vào `AuthConfig` (`GET /api/v1/auth/config`, `apps/api/internal/auth/dto.go` và `openapi.yaml`).
  2. `mail_delivery_available` chỉ mang giá trị `true` khi:
     - hệ thống được cấu hình một **adapter gửi thư ra ngoài thực sự** (real outbound mail adapter), **HOẶC**
     - đang dùng adapter thu giữ/sink (`SinkMailer` / recording mailer trong kiểm thử) **VÀ** biến môi trường chỉ dành cho kiểm thử **`AUTH_MAIL_CAPTURE_AS_DELIVERY=true`** được bật tường minh.
  3. **Cơ chế an toàn đóng (Fail-Closed) của `AUTH_MAIL_CAPTURE_AS_DELIVERY`:**
     - Mặc định khi không đặt (`unset` hoặc `false`): `SinkMailer` có `mail_delivery_available = false`.
     - Khi `APP_ENV=production` (hoặc `staging`), hàm `config.Load()` / `validateAuthPolicy()` **từ chối khởi động (fail boot)** nếu `AUTH_MAIL_CAPTURE_AS_DELIVERY=true` được bật.
     - Trên VPS hiện tại (đang chạy sink theo `advisor-dec-086`), biến `AUTH_MAIL_CAPTURE_AS_DELIVERY` **tuyệt đối không được bật**, do đó `/auth/config` trả `mail_delivery_available: false`, và tính năng quên mật khẩu hiển thị trạng thái *"chưa hỗ trợ gửi email"* trung thực cho tới khi chủ repo bổ sung mailer thật.
  4. **Hành vi trên Server và UI khi `mail_delivery_available == false`:**
     - `POST /auth/password/forgot` kiểm tra `!s.MailDeliveryAvailable()` ngay sau bước kiểm tra cú pháp email và trả về đồng nhất **`503 mail_delivery_unavailable`** **trước** mọi bước kiểm tra CAPTCHA, đếm quota hay tra cứu DB.
     - Trên UI (`/app/auth/forgot-password` — `AU2-FE2-4`), kiểm tra khả năng gửi thư phải **đóng an toàn (fail-closed)**: chỉ coi dịch vụ gửi mail là khả dụng khi **`config?.mail_delivery_available === true`**. Cụ thể:
       - Khi `config === null` và đang tải cấu hình (`!bootstrapComplete || configQuery.isLoading`): hiển thị khung skeleton hoặc giữ biểu mẫu ở trạng thái vô hiệu hoá nút gửi (`disabled`) và chưa kích hoạt gửi.
       - Khi tải `/auth/config` thất bại (`status === 'unavailable'` hoặc `configQuery.isError`): hiển thị thẻ lỗi mạng/không khả dụng (`auth.errors.networkTitle` + `auth.errors.network`), tuyệt đối không hiển thị biểu mẫu rỗng hứa hẹn gửi thư.
       - Khi `config !== null && config.mail_delivery_available !== true` (tức `false` hoặc thiếu trường) hoặc khi `POST /auth/password/forgot` trả `503 mail_delivery_unavailable`: giao diện hiển thị trạng thái tĩnh, bình tĩnh báo rằng dịch vụ gửi email hiện chưa được bật trên máy chủ này (tuyệt đối không hứa hẹn *"kiểm tra hộp thư của bạn"*), và **tuyệt đối không mount `<TurnstileWidget>` / không tải script Turnstile** ở trạng thái không khả dụng này:
         - **VI:** *"Tính năng gửi email đặt lại mật khẩu hiện chưa khả dụng trên máy chủ này. Chưa có email nào được gửi đi."*
         - **EN:** *"Email delivery for password reset is not available on this server yet. No email was sent."*
       - *Lưu ý cho kiểm thử U4 (`AU2-FE2-4`):* mọi mock `GET /api/v1/auth/config` trong unit test / E2E test của các luồng cần biểu mẫu quên mật khẩu hoạt động phải trả rõ `mail_delivery_available: true`.
  5. **Phạm vi với P02 (`MAIL-CAP-P02`):** Các luồng P02 hiện có (`POST /auth/verify-email/send`, `POST /auth/password/enroll/send`, `POST /me/email`) **không** thay đổi hành vi trong lane này; ghi nhận mục follow-up **`MAIL-CAP-P02`** để đồng bộ cổng `mail_delivery_available` cho P02 khi chủ repo cấu hình mailer.

#### 3.2. Chính sách Turnstile CAPTCHA đồng nhất (`AU2-BE1-11`, `AU2-FE1-8`)

- **Trên `POST /auth/password/forgot`:**
  - Khi `config?.mail_delivery_available === true` và Turnstile được cấu hình (`cfg.TurnstileEnabled()`, tức `config.captcha_site_key != null`):
    - Giao diện `/app/auth/forgot-password` **luôn luôn hiển thị** widget `<TurnstileWidget>` ngay trên biểu mẫu yêu cầu đặt lại mật khẩu (không đợi sau khi lỗi như màn hình đăng nhập; ngược lại khi ở trạng thái `mail_delivery_available !== true` thì không mount Turnstile theo `AU2-FE2-4`).
    - **Vòng đời làm mới Turnstile token sau mỗi lần submit (`AU2-FE2-6`):** Vì mỗi token Turnstile chỉ dùng được một lần (single-use), U4 **bắt buộc** reset widget Turnstile (xóa `captchaToken` về `undefined` và tăng `captchaResetSignal` truyền vào `<TurnstileWidget resetSignal={captchaResetSignal} />`) sau **mọi kết quả phản hồi của lần bấm gửi** cho phép người dùng gửi lại — bao gồm: `403 captcha_required`, `429 rate_limited`, `503 mail_delivery_unavailable`, lỗi mạng, và khi người dùng bấm *"Thử địa chỉ khác"* (`tryAnotherEmail`) sau `202 Accepted`. Nhờ đó lần bấm gửi tiếp theo luôn lấy token Turnstile mới thay vì gửi lại token đã tiêu thụ.
    - Server xác minh `captcha_token` **đồng nhất cho mọi request** ngay sau bước kiểm tra cú pháp email, `mail_delivery_available` và IP rate limit, **trước** khi đếm rate limit theo email và **trước** khi tra cứu tài khoản trong DB.
    - Widget và verifier phía server dùng chung một hostname (suy từ `APP_ORIGIN`) và action cố định (tái sử dụng verifier `a.captcha.Verify(ctx, in.CaptchaToken, ip, "", "login")` đã được `compose.NewAuth` khởi tạo, hoặc action `"login"` dùng chung cho các form auth công khai để không cần đổi cấu hình Turnstile).
    - Nếu thiếu `captcha_token`, token không hợp lệ, hoặc lệnh gọi xác minh tới nhà cung cấp Turnstile gặp lỗi mạng/timeout/5xx, server **đóng an toàn (fail closed)** và trả `403 captcha_required` (kèm extension `captcha_required: true`).
  - Khi Turnstile tắt (`!a.captcha.Enabled()`, `config.captcha_site_key == null`): cả UI và server đều bỏ qua bước kiểm tra CAPTCHA; nếu client gửi kèm `captcha_token` thì server lờ đi.
- **Trên `POST /auth/password/reset`:**
  - **Không** sử dụng CAPTCHA trên biểu mẫu đặt mật khẩu mới (quyền truy cập đã được bảo vệ bởi bearer token 256-bit CSPRNG một lần và rate limit theo IP). Trang `/app/auth/reset-password` nhờ đó không cần tải script Turnstile (xem thêm quy tắc CSP tại mục 6).

#### 3.3. Một ranh giới chấp nhận bất đồng bộ duy nhất và Hàng đợi Worker trong bộ nhớ (`AU2-BE1-2`, `AU2-BE1-5`)

Để đảm bảo `POST /auth/password/forgot` có **cùng mã trạng thái, cùng body và cùng lớp thời gian phản hồi HTTP (timing class)** cho cả 3 nhánh (tài khoản có password, tài khoản OAuth-only, và email không tồn tại) mà **không bao giờ lưu plaintext reset token vào bảng `river_job` hay log**:

1. **Thứ tự xử lý đồng bộ trước khi trả `202 Accepted` (hoàn toàn không chạm bảng `app_user` / `auth_identity` / `password_reset_token`):**
   - Bước 1: Giải mã JSON nghiêm ngặt (`email`, `captcha_token?`, `locale?`); chuẩn hoá `email` bằng `NormalizeEmail` và kiểm tra `locale ∈ {"", "en", "vi"}` → sai trả `400 invalid_request`.
   - Bước 2: Kiểm tra `s.MailDeliveryAvailable()` → nếu `false` trả ngay `503 mail_delivery_unavailable`.
   - Bước 3: Kiểm tra rate limit theo IP (`credLimit`: **5 yêu cầu / phút / IP**) → vượt trả `429 rate_limited`.
   - Bước 4: Nếu Turnstile bật (`a.captcha.Enabled()`), xác minh `captcha_token` → thất bại trả `403 captcha_required`.
   - Bước 5: Kiểm tra và tăng bộ đếm rate limit theo HMAC email đã chuẩn hoá (`forgotEmailMin`: **1 yêu cầu / phút / email**, `forgotEmailHour`: **3 yêu cầu / giờ / email**) → vượt trả `429 rate_limited`.
   - Bước 6 (**Ranh giới chấp nhận bất đồng bộ — Async Acceptance Boundary**): Đẩy công việc `{Email: normalizedEmail, Locale: effectiveLocale}` vào **hàng đợi có giới hạn trong bộ nhớ (bounded in-process channel/worker)** của `auth.Service` bằng thao tác không chặn (`non-blocking send`) và **trả về ngay `202 Accepted` (body rỗng, `Cache-Control: no-store`)**.
2. **Thiết kế hàng đợi trong bộ nhớ (Bounded In-Process Worker Queue — `AU2-BE1-5`):**
   - Hàng đợi buffered channel kích thước cố định **`forgotQueueSize = 128`** (cấu hình trong `auth.Service`, chạy với một hoặc một số worker goroutine gắn với vòng đời context của service, mỗi job áp timeout xử lý riêng `15s`).
   - **Hành vi khi tràn hàng đợi (Queue Overflow):** Nếu channel đầy tại thời điểm `non-blocking send`, handler **vẫn trả `202 Accepted`** (để không lộ trạng thái tải nội bộ hay tạo kênh phân biệt), bỏ qua yêu cầu đó và ghi một bản ghi log cảnh báo / metric (`slog.Warn("password forgot queue full, dropping request")` — **tuyệt đối không log địa chỉ email hay token**).
   - **Vì sao chọn In-Process Worker thay vì River job cho bước phát hành token + gửi mail (`AU2-BE1-5`):**
     - Nếu đưa link/token vào tham số River job (`river_job.args`), bearer secret chưa băm sẽ nằm dưới dạng plaintext JSON trong PostgreSQL, vi phạm nguyên tắc chỉ lưu bản băm (`SHA-256`) trong DB. Ngược lại, nếu River job chỉ lưu ID hàng `password_reset_token`, worker không thể khôi phục 32 byte ngẫu nhiên từ `token_hash` để tạo link.
     - Với in-process worker: worker tra cứu DB, nếu là tài khoản có password thì sinh 32 byte CSPRNG trong RAM, ghi `SHA256Bytes(raw)` vào `password_reset_token`, ghép link `#token=<base64url>` trong RAM và gọi `s.mail.Send(...)` ngay lập tức, sau đó xoá biến tạm. Token thô chỉ tồn tại trong bộ nhớ tiến trình lúc gửi và đi thẳng tới hộp thư đích (hoặc file sink khi test), không bao giờ đi vào `river_job`, DB hay log.
     - Nếu tiến trình API khởi động lại đúng lúc một job đang nằm trong RAM và email chưa kịp gửi, việc mất job đó là chấp nhận được: người dùng chỉ cần gửi lại yêu cầu đặt lại mật khẩu sau 1 phút.
3. **Công việc bên trong Worker nền (sau khi HTTP `202` đã trả về):**
   - Tra cứu `GetUserByEmail(ctx, email)`. Nếu không tìm thấy hoặc `deleted_at IS NOT NULL` → kết thúc êm.
   - Nếu tìm thấy user: thực hiện transaction phát hành token dưới khoá `GetUserByIDForUpdate` (xem mục 5.2 và mục 5.4).
     - Nếu user có identity `provider = 'password'`: hết hạn các token pending cũ, chèn hàng `password_reset_token` mới, commit transaction, rồi gọi `s.mail.Send(ctx, u.Email, "password_reset", resetLink)` (theo `locale` của request).
     - Nếu user chỉ có OAuth (không có `provider = 'password'`): không tạo token, gọi `s.mail.Send(ctx, u.Email, "password_reset_oauth_only", loginLink)` (theo `locale` của request).
   - Mọi lỗi DB hoặc SMTP bên trong worker chỉ ghi log lỗi đã scrub (không kèm email, không kèm token).
4. **Copy bắt buộc trên màn hình sau khi gửi yêu cầu (`202 Accepted` — `AU2-FE1-9`, `AU2-FE1-14`):**
   - Phải nói *"hướng dẫn tiếp theo"* / *"the next steps"* (không nói cứng *"link đặt lại mật khẩu"* vì tài khoản OAuth-only nhận email nhắc nhở phương thức đăng nhập chứ không có link reset) và **không ghi cứng con số `"30 phút"` / `"30 minutes"`** trong copy giao diện (để UI không bị lệch nếu cấu hình TTL phía server thay đổi):
     - **VI:** *"Nếu có tài khoản dùng địa chỉ email này, chúng tôi đã gửi hướng dẫn tiếp theo. Vui lòng kiểm tra hộp thư đến và thư rác."*
     - **EN:** *"If an account uses this email address, we have sent the next steps. Please check your inbox and spam folder."*

### 4. Hành vi theo trạng thái tài khoản & Bảo vệ chống Pre-Registration (`advisor-dec-140` D3 — `AU2-BE1-4`)

1. **Tài khoản OAuth-only (chưa có `auth_identity` với `provider = 'password'`):**
   - **Tuyệt đối không biến luồng quên mật khẩu thành đường đặt mật khẩu lần đầu thứ hai.** Đường đặt mật khẩu lần đầu của tài khoản OAuth-only vẫn giữ nguyên là **US1b** (`POST /auth/password/enroll/send` + `POST /me/password` khi đang đăng nhập, hoặc Google fresh re-auth).
   - Khi worker xử lý yêu cầu `forgot` cho tài khoản OAuth-only: không sinh reset token, chỉ gửi email nhắc nhở (`purpose = "password_reset_oauth_only"`).
2. **Nguy cơ Pre-Registration kèm liên kết OAuth của kẻ tấn công (`AU2-BE1-4`) và Quyết định D3 (`advisor-dec-140`):**
   - *Kịch bản tấn công nếu không chặn:* Khi `AUTH_REQUIRE_EMAIL_VERIFICATION=false`, kẻ tấn công đăng ký trước địa chỉ email của nạn nhân bằng mật khẩu, đăng nhập, rồi liên kết tài khoản Google/GitHub của chính kẻ tấn công vào tài khoản đó. Khi nạn nhân thật dùng luồng quên mật khẩu để lấy lại tài khoản và xác minh email, nếu các liên kết OAuth cũ vẫn được giữ nguyên thì kẻ tấn công vẫn đăng nhập lại được qua Google/GitHub (`GetIdentityByProviderUID`).
   - **Quyết định D3 — Phòng ngừa chiều vào (Cấm liên kết OAuth mới khi email tài khoản chưa xác minh):**
     - Trên `POST /api/v1/auth/oauth/{provider}/link` (`OauthLinkStart` / `oauth.Service.StartLink`) **và** khi hoàn tất nhánh `case "link":` trong `GET /api/v1/auth/oauth/{provider}/callback` (`oauth.Service.Callback`, dưới khoá `GetUserByIDForUpdate`): nếu tài khoản hiện tại chưa xác minh email (`!u.EmailVerifiedAt.Valid`), server **từ chối ngay** việc liên kết danh tính OAuth mới (kể cả khi `AUTH_REQUIRE_EMAIL_VERIFICATION=false`).
     - Mã lỗi sử dụng: **tái sử dụng mã lỗi RFC 9457 đã có `email_not_verified` (`403 Forbidden`, `auth.ErrEmailNotVerified`)** cho `POST /auth/oauth/{provider}/link` (và trả `status = "invalid_flow"` nếu email bị đổi về trạng thái chưa xác minh giữa lúc `start` và `callback`). Không cần thêm mã lỗi mới vào problem catalog.
     - **Đăng ký mới bằng OAuth (OAuth Signup) không bị ảnh hưởng:** Khi người dùng tạo tài khoản mới trực tiếp qua `GET /auth/oauth/{provider}/start` → `POST /auth/oauth/complete`, provider đã xác minh email (`id.EmailVerified == true`) và server đặt ngay `email_verified_at = now()` lúc tạo user như P02 hiện hành.
   - **Quyết định D3 & E1 (`advisor-dec-140` D3, `advisor-dec-146` E1 — `AU2-BE1-4`, `AU2-BE2-1`, `AU2-BE2-3`) — Bản chụp `was_email_unverified` bắt buộc và Dọn sạch triệt để khi khôi phục tài khoản chưa xác minh:**
     - **Bắt buộc lưu bản chụp lúc phát hành (`AU2-BE2-3`):** Không chấp nhận phương án bỏ cột hoặc chỉ kiểm tra `u.EmailVerifiedAt` tại thời điểm consume. Khi phát hành token trong bảng `password_reset_token`, server **bắt buộc** ghi `was_email_unverified = !u.EmailVerifiedAt.Valid` dưới khoá `GetUserByIDForUpdate` (mục 5.1, 5.2). Khi tiêu thụ token, điều kiện kích hoạt dọn dẹp D3 **bắt buộc** là `row.WasEmailUnverified || !u.EmailVerifiedAt.Valid` — đảm bảo nếu token được phát hành khi tài khoản chưa xác minh email, rồi kẻ tấn công (hoặc một tab khác) kịp xác minh email trước khi nạn nhân bấm hoàn tất reset, toàn bộ bước gỡ OAuth và thu hồi phiên bên dưới vẫn chạy đầy đủ.
     - Trong transaction tiêu thụ token thành công của `POST /auth/password/reset`: nếu `row.WasEmailUnverified || !u.EmailVerifiedAt.Valid`, server thực hiện nguyên tử trong **cùng một transaction** với việc cập nhật `password_hash` và thu hồi toàn bộ session (`RevokeAllUserSessions`):
       1. Đánh dấu email tài khoản đã xác minh (`UpdateUserEmailVerified`: `email_verified_at = now`).
       2. **Xoá (unlink) toàn bộ danh tính OAuth (`provider IN ('google', 'github')`) đang gắn với `user_id` đó** (`DeleteOAuthIdentitiesByUser` — trả về danh sách các `(provider, provider_uid)` vừa bị xoá hoặc đọc danh sách OAuth identities của user dưới khoá `app_user FOR UPDATE` ngay trước khi xoá).
       3. **Huỷ toàn bộ giao dịch OAuth đang mở liên quan tới user và các danh tính vừa bị gỡ (`AU2-BE2-1`, `advisor-dec-146` E1):**
          - Huỷ mọi giao dịch `link` / `reauth` ở trạng thái `'pending'`, `'claimed'`, `'ready'` của user (`expected_user_id = $user_id AND consumed_at IS NULL` → đặt `consumed_at = $now, status = 'completed'`, đồng thời huỷ các `oauth_reauth_receipt` chưa dùng của user `CancelReceiptsByUser`).
          - **Cách xác định và huỷ giao dịch OAuth `login` của kẻ tấn công (`mode = 'login'`):** Một luồng OAuth `login` bắt đầu khi chưa đăng nhập nên `expected_user_id` và `expected_session_id` luôn là `NULL` (`apps/api/internal/auth/oauth/service.go:82-84,143-164`); không bao giờ được dựa vào `expected_user_id` để tìm luồng `login`. Thay vào đó, một giao dịch `login` đã qua bước `Callback` (`MarkOAuthReady`, `status = 'ready'`) được định danh bởi cặp **`(identity_provider, identity_provider_uid)`** trên bảng `oauth_transaction` (`migrations/0004_auth.up.sql:95-96`). Trong cùng transaction reset, với mỗi danh tính OAuth `(provider, provider_uid)` bị gỡ của user (hoặc dùng truy vấn tổng hợp trước khi xoá `auth_identity`), server huỷ mọi hàng `oauth_transaction` có **`mode = 'login' AND status = 'ready' AND consumed_at IS NULL AND (identity_provider, identity_provider_uid)` thuộc các danh tính OAuth của user đó** (`CancelReadyOAuthLoginByUserIdentities`: đặt `consumed_at = $now, status = 'completed'`).
          - Với một callback OAuth `login` vẫn đang ở bước trao đổi code với provider (`status = 'claimed'`, chưa có `identity_provider_uid` trong `oauth_transaction`) hoặc một lệnh `oauth.Service.Complete` đang bay song song: việc chặn cấp session được đảm bảo tuyệt đối bởi bước khoá `app_user FOR UPDATE` và kiểm tra lại danh tính trong `oauth.Service.Complete` (xem mục 5.3 bên dưới — **chiếm quyền tài khoản không bao giờ là rủi ro tồn dư**).
       4. Ghi sự kiện bảo mật (`secevent`) cho từng provider bị gỡ (`EventIdentityUnlink = "auth.identity.unlink"`, `Meta: {Provider: p, Reason: ReasonUnverified}`) bên cạnh sự kiện `EventPasswordReset = "auth.password.reset"`.
       5. Đưa danh sách các provider đã bị gỡ vào `secevent.Meta` của thông báo bảo mật để email thông báo (`purpose = "password_reset_notice"`) nêu đích danh các nhà cung cấp OAuth vừa bị ngắt liên kết (ví dụ: Google, GitHub).
     - **Giữ nguyên trạng thái Vault, Passkeys và DevKey (`user-dec-016`, `user-dec-017`, D3):** Việc đặt lại mật khẩu của tài khoản chưa xác minh **tuyệt đối không** xoá hay thay đổi `vault`, `vault_recovery_key`, `vault_passkey` hay `DevKey`.

### 5. Thiết kế Token, Bảng dữ liệu (Migration `0007_password_reset`), Thứ tự khoá và Điểm tuyến tính hoá

#### 5.1. Schema bảng `password_reset_token` (Migration `0007_password_reset.{up,down}.sql`)

U3 tạo bảng `password_reset_token` trong migration `0007_password_reset` (chạy sau `0006_content`):

```sql
CREATE TABLE password_reset_token (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  target_email         citext NOT NULL,
  token_hash           bytea NOT NULL UNIQUE,
  password_hash_sha256 bytea NOT NULL,
  was_email_unverified boolean NOT NULL DEFAULT false,
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

#### 5.2. Các bất biến khi phát hành và tiêu thụ Token (`AU2-BE1-6`, `AU2-BE1-7`, `AU2-BE1-12`)

1. **Định dạng, Schema của Token và Kiểm tra biên JSON có nhận biết sự tồn tại của trường (`AU2-BE1-12`, `AU2-BE2-4`):**
   - Sinh 32 byte CSPRNG bằng `NewOpaqueToken()` (`crypto/rand`), mã hoá base64url không padding (đúng **43 ký tự**, khớp biểu thức chính quy `^[A-Za-z0-9_-]{43}$`).
   - Trong `openapi.yaml`, trường `PasswordResetRequest.token` quy định rõ `minLength: 43`, `maxLength: 43`, `pattern: '^[A-Za-z0-9_-]{43}$'`.
   - **Kiểm tra biên JSON có nhận biết sự hiện diện của trường (Presence-Aware DTO — `AU2-BE2-4`):** Vì `httpx.DecodeJSON` (`apps/api/internal/httpx/json.go:39-50`) dùng `encoding/json` tiêu chuẩn nên nếu DTO dùng trường `string` thường, một trường bị bỏ trống (omitted) hoặc mang giá trị `null` sẽ giải mã thành chuỗi rỗng `""` mà không báo lỗi. Do đó, giữ nguyên `httpx.DecodeJSON` chung nhưng handler `POST /auth/password/reset` **bắt buộc** dùng DTO có nhận biết sự hiện diện của trường (ví dụ `Token *string` và `NewPassword *string`, hoặc `json.RawMessage`):
     - Nếu `token` hoặc `new_password` **vắng mặt (omitted)**, mang giá trị **`null`** (`Token == nil || NewPassword == nil`), hoặc **sai kiểu dữ liệu JSON** (số, boolean, mảng, object — khiến `httpx.DecodeJSON` trả lỗi): trả về **`400 invalid_request`**.
     - Khi cả `token` và `new_password` đều là chuỗi JSON (`string`) có mặt và khác `null`: nếu chuỗi `*in.Token` rỗng (`""`), sai độ dài (`len != 43`), chứa ký tự ngoài bảng mã base64url hoặc không giải mã ra đúng 32 byte (`ParseOpaqueToken(*in.Token)` trả lỗi), handler **bắt buộc trả `400 reset_token_invalid`** (đồng nhất với token không tồn tại/hết hạn/đã dùng). Sau đó kiểm tra `ValidatePassword(*in.NewPassword)` (hoặc kiểm tra `ValidatePassword` trước khi tra DB) → không đạt trả `400 password_weak`.
   - DB chỉ lưu `token_hash = SHA256Bytes(raw)` (32 byte), tuyệt đối không lưu plaintext token.
2. **Tuần tự hoá việc phát hành Token dưới khoá `app_user FOR UPDATE` (`AU2-BE1-6`):**
   - Trong worker nền của `ForgotPassword`, việc phát hành token cho một user có password bắt buộc diễn ra trong **một transaction duy nhất** theo đúng thứ tự:
     1. Khoá hàng user: `u, err := q.GetUserByIDForUpdate(ctx, userID)`.
     2. Đọc bản chụp danh tính mật khẩu hiện tại dưới khoá user: `ident, err := q.GetIdentityByUserProvider(ctx, {UserID: u.ID, Provider: "password"})`. Nếu không có password identity hoặc `PasswordHash == nil` thì rollback và chuyển sang nhánh gửi mail nhắc OAuth-only.
     3. Vô hiệu hoá mọi token reset đang chờ trước đó của user: `q.ExpirePendingPasswordResetTokensByUser(ctx, {UserID: u.ID, ConsumedAt: pgts(now)})` (`UPDATE password_reset_token SET consumed_at = $2 WHERE user_id = $1 AND consumed_at IS NULL`).
     4. Chèn hàng `password_reset_token` mới (`InsertPasswordResetToken`) với `target_email = u.Email`, `token_hash = SHA256Bytes(raw)`, `password_hash_sha256 = SHA256Bytes([]byte(*ident.PasswordHash))`, `was_email_unverified = !u.EmailVerifiedAt.Valid`, `expires_at = now.Add(30 * time.Minute)`.
     5. Commit transaction rồi mới gửi email chứa `raw` token.
   - Nhờ khoá `GetUserByIDForUpdate`, hai yêu cầu phát hành chạy song song cho cùng một user (hoặc phát hành đua với tiêu thụ reset / đổi mật khẩu / đổi email) luôn được tuần tự hoá hoàn toàn; chỉ đúng **một** token cuối cùng còn trạng thái `consumed_at IS NULL`.
3. **Ràng buộc trạng thái và Huỷ tường minh khi đổi Email A → B → A (`AU2-BE1-7`):**
   - Lúc tiêu thụ token (`POST /auth/password/reset`), dưới khoá `GetUserByIDForUpdate`, server kiểm tra:
     - `row.ConsumedAt == nil` và `row.ExpiresAt.After(now)`,
     - `equalFoldEmail(row.TargetEmail, u.Email)`,
     - user vẫn có `auth_identity` (`provider = 'password'`) và `subtle.ConstantTimeCompare(row.PasswordHashSha256, SHA256Bytes([]byte(*ident.PasswordHash))) == 1`.
   - **Ngăn chặn hồi sinh token khi đổi email A → B → A (`AU2-BE1-7`):** Chỉ so sánh `row.TargetEmail == u.Email` lúc consume là không đủ nếu người dùng đổi email từ `A` sang `B` rồi đổi ngược về `A` trong vòng 30 phút với cùng mật khẩu. Do đó, hợp đồng bắt buộc U3 phải gọi **`q.ExpirePendingPasswordResetTokensByUser(ctx, {UserID: uid, ConsumedAt: pgts(now)})`** ngay bên trong:
     1. Transaction xác nhận đổi email `Service.ConfirmEmailToken` (`apps/api/internal/auth/account.go:269-278`, nhánh `row.Purpose == "email_change"` ngay cạnh `q.CancelPendingEmailProofs`),
     2. Transaction đổi mật khẩu `Service.ChangePassword` (`apps/api/internal/auth/account.go:66-69`),
     3. Transaction gỡ phương thức đăng nhập `Service.UnlinkIdentity` khi `provider == "password"` (`apps/api/internal/auth/account.go:330-339`).
4. **Dọn dẹp định kỳ (Prune):**
   - Worker `AuthPruneWorker` (`apps/api/internal/worker/auth_prune.go`) gọi `DeleteExpiredPasswordResetTokens` để xoá các hàng có `expires_at < now - 24h` cùng chu kỳ hàng giờ với `email_verification`.

#### 5.3. Tuần tự hoá Đăng nhập Mật khẩu & OAuth `Complete` với Reset, Thứ tự khoá thực tế và Xử lý Deadlock (`advisor-dec-140` D2, `advisor-dec-146` E1 A & E2 B — `AU2-BE1-3`, `AU2-BE1-6`, `AU2-BE2-1`, `AU2-BE2-2`)

1. **Đóng kẽ hở Race Condition khi đăng nhập bằng mật khẩu cũ (`Service.Login` — `advisor-dec-140` D2, `AU2-BE1-3`):**
   - Trong code P02 hiện tại (`apps/api/internal/auth/service.go:289-332`), `Service.Login` đọc `app_user` và `auth_identity`, chạy `VerifyPassword` (Argon2id) ở ngoài transaction, rồi mới mở transaction `s.pool.Begin(ctx)` để gọi `s.sessions.Issue(ctx, tx, ...)` mà không khoá hàng `app_user` và không kiểm tra lại `password_hash`.
   - **Điểm áp dụng P02 số 1 (`Service.Login` trong `apps/api/internal/auth/service.go`):**
     - Bước kiểm tra Argon2id (`VerifyPassword`) vẫn chạy trước khi mở transaction (để không giữ khoá DB trong lúc tính Argon2id 64 MiB).
     - Sau khi `VerifyPassword` khớp với bản chụp `verifiedHash := *id.PasswordHash`, khi mở transaction cấp session (`tx, err := s.pool.Begin(ctx)`), `Service.Login` **bắt buộc**:
       1. Khoá hàng user: `uLocked, err := q.GetUserByIDForUpdate(ctx, u.ID)` (nếu lỗi hoặc user đã xoá → trả `ErrInvalidCredentials`).
       2. Đọc lại identity mật khẩu hiện tại trong `tx`: `idNow, err := q.GetIdentityByUserProvider(ctx, {UserID: uLocked.ID, Provider: "password"})`.
       3. Kiểm tra bản băm mật khẩu hiện tại trong DB vẫn khớp từng byte với `verifiedHash` vừa xác minh (`idNow.PasswordHash != nil && subtle.ConstantTimeCompare(SHA256Bytes([]byte(*idNow.PasswordHash)), SHA256Bytes([]byte(verifiedHash))) == 1`).
       4. Nếu không khớp (tức là một giao dịch `ResetPassword`, `ChangePassword` hoặc `UnlinkIdentity("password")` đã commit giữa lúc `VerifyPassword` và lúc lấy khoá `FOR UPDATE`), rollback transaction và trả về `401 invalid_credentials` (không ghi tăng bộ đếm lockout thất bại).
       5. Chỉ khi khớp mới gọi `s.sessions.Issue(ctx, tx, ...)` và `s.audit.Record(...)` rồi `tx.Commit(ctx)`.

2. **Đóng kẽ hở Race Condition khi hoàn tất đăng nhập OAuth (`oauth.Service.Complete` — `advisor-dec-146` E1 A, `AU2-BE2-1`):**
   - **Vấn đề trong P02 hiện tại (`apps/api/internal/auth/oauth/service.go:421-499`):** `oauth.Service.Complete` mở transaction, khoá `GetOAuthTxByIDForUpdate(row.ID)` trước, đọc `GetIdentityByProviderUID(provider, uid)` để lấy `userID` mà không khoá hàng `app_user`, rồi gọi `s.sessions.Issue(ctx, tx, ...)`. Nếu một tài khoản chưa xác minh email bị kẻ tấn công gắn OAuth từ trước (hoặc đang có phiên OAuth `login` lơ lửng / đang ở bước `Callback` trao đổi code) và nạn nhân chạy `POST /auth/password/reset` gỡ toàn bộ OAuth identities + thu hồi phiên, một lệnh `Complete` chạy đua có thể đã đọc `userID` trước khi reset xoá `auth_identity` và chèn session mới cho kẻ tấn công ngay sau khi reset commit, hoặc gây xung đột thứ tự khoá `oauth_transaction` → `app_user` ngược với reset (`app_user` → `oauth_transaction`).
   - **Điểm áp dụng P02 số 2 (`oauth.Service.Complete` trong `apps/api/internal/auth/oauth/service.go` — `advisor-dec-146` E1 A):**
     - **Bước 1 — Khám phá chủ sở hữu không giữ khoá (Non-locking owner discovery, ngoài transaction ghi hoặc trước khi lấy bất kỳ khoá dòng nào):**
       - Giải mã `binding` (`auth.ParseOpaqueToken(binding)`).
       - Đọc không khoá giao dịch OAuth mới nhất theo binding: `row, err := s.q.GetLatestOAuthTxByBinding(ctx, auth.SHA256Bytes(bindRaw))`. Kiểm tra nhanh `row.Mode == "login"`, `row.Status == "ready"`, `!row.ConsumedAt.Valid`, `row.CompletionDeadline.Valid && row.CompletionDeadline.Time.After(now)`, `row.ExpiresAt.Time.After(now)`, và các trường `IdentityProvider`, `IdentityProviderUid`, `IdentityEmail` khác `nil` (nếu sai → trả `400 oauth_state_invalid`).
       - Tra cứu không khoá xem cặp `(provider, uid)` hiện có đang gắn với tài khoản nào không: `ident, err := s.q.GetIdentityByProviderUID(ctx, {Provider: provider, ProviderUid: &uid})`.
     - **Bước 2 — Nhánh đã có chủ sở hữu (`err == nil`, tức đăng nhập vào tài khoản đã tồn tại):**
       - Mở transaction `tx, err := s.pool.Begin(ctx)` (`q := s.q.WithTx(tx)`).
       - **Lấy khoá gốc `app_user FOR UPDATE` TRƯỚC TIÊN:** `uLocked, err := q.GetUserByIDForUpdate(ctx, ident.UserID)` (nếu không tìm thấy hoặc đã xoá → trả `400 oauth_state_invalid`).
       - **Đọc lại ánh xạ `(provider, uid)` dưới khoá `app_user FOR UPDATE`:** `identNow, err := q.GetIdentityByProviderUID(ctx, {Provider: provider, ProviderUid: &uid})`. Nếu `errors.Is(err, pgx.ErrNoRows)` hoặc `identNow.UserID != uLocked.ID` (tức là giao dịch `ResetPassword` theo D3 hoặc `UnlinkIdentity` vừa gỡ liên kết OAuth này trước khi `Complete` lấy được khoá user):
         - **Không được chuyển sang nhánh tạo tài khoản mới (signup)** và **tuyệt đối không cấp session**; huỷ hoặc bỏ qua flow và rollback, trả về **`400 oauth_state_invalid`** (`auth.ErrOAuthStateInvalid`).
       - **Khoá và kiểm tra lại dòng `oauth_transaction` dưới khoá `app_user`:** `locked, err := q.GetOAuthTxByIDForUpdate(ctx, row.ID)`. Kiểm tra lại `locked.Mode == "login"`, `locked.Status == "ready"`, `!locked.ConsumedAt.Valid`, `locked.CompletionDeadline.Valid && locked.CompletionDeadline.Time.After(s.clk.Now())`, `locked.ExpiresAt.Time.After(s.clk.Now())`, và `*locked.IdentityProvider == provider && *locked.IdentityProviderUid == uid` (nếu không thoả, bao gồm trường hợp `ResetPassword` đã huỷ flow này → trả `400 oauth_state_invalid`).
       - Chỉ khi cả ánh xạ `auth_identity` lẫn dòng `oauth_transaction` đều còn hợp lệ và trỏ đúng `uLocked.ID` mới gọi `s.sessions.Issue(ctx, tx, ...)`, `q.CompleteOAuthTransaction(ctx, ...)`, `s.audit.Record(ctx, tx, ...)` và `tx.Commit(ctx)`.
       - *Hệ quả cho cả Callback đang bay:* Nếu một callback OAuth `login` vẫn đang trao đổi code với provider (`status = 'claimed'`) trong lúc `ResetPassword` chạy và chỉ gọi `MarkOAuthReady` sau khi `ResetPassword` đã commit (xoá `auth_identity` của kẻ tấn công và đặt `app_user.email_verified_at = now()`), thì khi kẻ tấn công gọi `Complete`, bước khám phá sẽ không thấy `auth_identity`, rơi vào nhánh tạo mới bên dưới và bị chặn ngay bởi `GetUserByEmail` trả **`409 email_taken`** (`auth.ErrEmailTaken`). Không có bất kỳ đường nào để kẻ tấn công lấy được session sau khi nạn nhân reset.
     - **Bước 3 — Nhánh tạo tài khoản mới bằng OAuth (OAuth Signup khi `GetIdentityByProviderUID` trả `pgx.ErrNoRows`):**
       - Giữ nguyên hành vi đăng ký mới của P02: mở transaction, khoá `GetOAuthTxByIDForUpdate(row.ID)`, kiểm tra `status == "ready"` và hạn dùng; kiểm tra lại `GetIdentityByProviderUID` (nếu vừa được gắn đồng thời thì báo lỗi/thử lại dưới khoá user); kiểm tra `GetUserByEmail(ctx, email)` (nếu email đã tồn tại → trả `409 email_taken`); nếu chưa có thì `InsertUser` → `UpdateUserEmailVerified` → `InsertOAuthIdentity` → `sessions.Issue` → `CompleteOAuthTransaction` → `audit.Record` → `Commit`.

3. **Thứ tự khoá thực tế trong hệ thống, Lý do không viết lại P02 `Logout` / `Refresh`, và Cơ chế Retry + `503 dependency_unavailable` (`advisor-dec-146` E2 B — `AU2-BE2-2`):**
   - **Bỏ tuyên bố "một thứ tự khoá toàn cục duy nhất cho mọi luồng P02":** Trong P02 hiện hành, các luồng xác thực được chia làm hai nhóm thực tế:
     - **Nhóm A — Các luồng đột biến tài khoản / xác thực gốc lấy `app_user FOR UPDATE` làm khoá gốc đầu tiên (User-root serialized paths):**
       - Mọi luồng trong nhóm này đều lấy **`app_user FOR UPDATE` (`GetUserByIDForUpdate`) làm khoá đầu tiên**, nên mọi cặp giao dịch thuộc Nhóm A trên cùng một tài khoản luôn được **tuần tự hoá tuyệt đối tại gốc `app_user`** (tuyến tính hoá hoàn toàn, không thể đan xen hay deadlock với nhau dù thứ tự khoá bảng con bên dưới có khác nhau giữa `EnsureLiveTx` và đọc `auth_identity`):
         1. **Phát hành token reset (`ForgotPassword` worker):** `app_user FOR UPDATE` → đọc `auth_identity` → `ExpirePendingPasswordResetTokensByUser` (`password_reset_token`) → `InsertPasswordResetToken`.
         2. **Tiêu thụ token reset (`ResetPassword` — thứ tự bắt buộc theo `advisor-dec-146` E2 B):** đọc không khoá `user_id` từ `GetPasswordResetTokenByHash` → **(1) `app_user FOR UPDATE` (`GetUserByIDForUpdate`)** → **(2) `session` (`RevokeAllUserSessions` ngay sau khoá user)** → **(3) `password_reset_token FOR UPDATE` (`GetPasswordResetTokenByHashForUpdate`), kiểm tra hợp lệ & `ConsumePasswordResetToken` + `ExpirePendingPasswordResetTokensByUser` + `CancelPendingEmailProofs` (`email_verification`) + cập nhật/xoá `auth_identity` + huỷ `oauth_transaction` (`CancelPendingOAuthByUser`, `CancelReadyOAuthLoginByUserIdentities`) & `oauth_reauth_receipt`** → **(4) `auth_throttle` (`ResetThrottle`) + `audit_log` + `user_notification` / `river_job`**.
            - *Lưu ý quan trọng:* Vì toàn bộ bước kiểm tra và cập nhật nằm trong một transaction PostgreSQL duy nhất, việc gọi `RevokeAllUserSessions` ngay ở bước (2) (ngay sau `GetUserByIDForUpdate`) sẽ tự động được **rollback hoàn toàn** nếu bước (3) phát hiện token đã dùng, hết hạn hoặc lệch `target_email` / `password_hash_sha256`. Đổi lại, đặt `session` ngay sau `app_user` giúp `ResetPassword` khớp thứ tự `app_user → session` với `ChangePassword`, `ConfirmEmailToken`, `UnlinkIdentity`, `RevokeSession`, `oauth.Callback (link/reauth)` và `oauth.ConsumeReceipt`.
         3. **Đăng nhập mật khẩu (`Service.Login` — D2):** `VerifyPassword` (ngoài tx) → mở tx → `app_user FOR UPDATE` → đọc lại `auth_identity` và đối chiếu `password_hash` → `InsertSession` (`session`) → `audit_log`.
         4. **Hoàn tất đăng nhập OAuth cho user đã tồn tại (`oauth.Service.Complete` — E1 A):** đọc không khoá `oauth_transaction` & `auth_identity` (ngoài tx) → mở tx → `app_user FOR UPDATE` → đọc lại `auth_identity` → `oauth_transaction FOR UPDATE` → `InsertSession` (`session`) → `CompleteOAuthTransaction` → `audit_log`.
         5. **Đổi / đặt mật khẩu (`Service.ChangePassword`):** `app_user FOR UPDATE` → `EnsureLiveTx` (`session FOR UPDATE`) → đọc/cập nhật/chèn `auth_identity` (và `email_verification FOR UPDATE` nếu dùng `enrollment_token`) → `CancelPendingEmailProofs` + `ExpirePendingPasswordResetTokensByUser` → `RevokeOtherSessions` + `RevokeSession` + `InsertSession` → `audit_log` + `user_notification`.
         6. **Xác nhận email / đổi email (`Service.ConfirmEmailToken`):** `app_user FOR UPDATE` → `EnsureLiveTx` (`session FOR UPDATE`) → `email_verification FOR UPDATE` → `UpdateUserEmail` / `UpdateUserEmailVerified` → (nếu `email_change`: `CancelPendingEmailProofs` + `ExpirePendingPasswordResetTokensByUser` + `RevokeOtherSessions`) → `audit_log` + `user_notification`.
         7. **Gỡ phương thức đăng nhập (`Service.UnlinkIdentity`):** `app_user FOR UPDATE` → `EnsureLiveTx` (`session FOR UPDATE`) → `DeleteIdentity` (`auth_identity`) → (nếu `provider == "password"`: `ExpirePendingPasswordResetTokensByUser`) → `RevokeOtherSessions` → `audit_log`.
         8. **Thu hồi phiên từ Settings (`Service.RevokeSession` / `SessionStore.Revoke`), OAuth `Callback` (`link`/`reauth`) và `oauth.ConsumeReceipt`:** đều lấy `app_user FOR UPDATE` → `session FOR UPDATE` (`EnsureLiveTx`) → bảng con (`email_verification` / `oauth_transaction` / `oauth_reauth_receipt`).
     - **Nhóm B — Hai luồng bắt đầu từ phiên (Session-first paths) của P02 KHÔNG viết lại trong lane này (`advisor-dec-146` E2 B):**
       - Theo quyết định `advisor-dec-146` E2 B, để giữ phạm vi thay đổi tối thiểu (`user-dec-015`), **không viết lại thứ tự khoá** của hai luồng P02 sau:
         1. `Service.Logout` (`apps/api/internal/auth/service.go:351-368`): mở tx → `RevokeSession` (`session`) → `CancelPendingBySession` (`email_verification`) → `CancelPendingOAuthBySession` (`oauth_transaction`) → `CancelReceiptsBySession` (`oauth_reauth_receipt`) → `audit.Record` (`audit_log`, có FK `user_id REFERENCES app_user(id)` nên xin `FOR KEY SHARE` trên `app_user`).
         2. `SessionStore.Refresh` nhánh phát hiện dùng lại refresh token đã xoay (`!current`, `apps/api/internal/auth/session.go:183-227`): mở tx → `lockSessionByRefresh` (`session FOR UPDATE`) → `GetUserByID` → `RevokeSession` (`session`) → `audit.Record` (`audit_log`, xin `FOR KEY SHARE` trên `app_user`).
       - Vì Nhóm B khoá `session` trước rồi mới xin `FOR KEY SHARE` trên `app_user` (khi ghi `audit_log`), trong khi `ResetPassword` (và các luồng Nhóm A) khoá `app_user FOR UPDATE` trước rồi mới cập nhật `session` (`RevokeAllUserSessions`), một va chạm đồng thời cực hiếm trên cùng một user giữa `ResetPassword` và `Logout` / `Refresh (reuse)` có thể tạo chu trình chờ `app_user ↔ session` và bị bộ phát hiện deadlock của PostgreSQL cắt bằng SQLSTATE `40P01` (`deadlock_detected`) hoặc `55P03` (`lock_not_available`).
   - **Cơ chế xử lý `40P01` / `55P03` bắt buộc trên `POST /auth/password/reset` (`advisor-dec-146` E2 B):**
     - Trong `Service.ResetPassword`: nếu bất kỳ bước nào trong transaction tiêu thụ token (hoặc lúc `Commit`) gặp lỗi PostgreSQL có SQLSTATE **`40P01` (`deadlock_detected`)** hoặc **`55P03` (`lock_not_available`)** (`var pgErr *pgconn.PgError; errors.As(err, &pgErr)`):
       1. Rollback sạch sẽ transaction hiện tại (đảm bảo không bao giờ có trạng thái áp dụng dở dang / half-applied).
       2. **Tự động thử lại (retry) toàn bộ transaction tối đa 1 lần** ngay trong lời gọi đó (sau một khoảng nhường CPU ngắn như `10–25ms` hoặc chạy lại ngay; Argon2id `HashPassword` đã tính sẵn trước khi mở transaction nên lần retry không phải băm lại mật khẩu). Trong thực tế, khi Postgres huỷ một phía của deadlock, lần retry ngay lập tức của `ResetPassword` sẽ lấy được khoá và commit thành công (thu hồi toàn bộ phiên).
       3. Nếu lần thử lại thứ hai vẫn gặp `40P01` hoặc `55P03`: `Service.ResetPassword` trả về lỗi miền **`auth.ErrDependencyUnavailable` (`code = "dependency_unavailable"`)**, và handler `authhttp` trả về **`503 Service Unavailable`** với `code: "dependency_unavailable"`, header **`Retry-After: 1`** và `retry_after: 1` trong body Problem JSON (**tuyệt đối không bao giờ trả `500 internal_error`** và token reset vẫn chưa bị đánh dấu `consumed_at` nên người dùng bấm gửi lại được ngay).
   - **Hiện trạng ánh xạ lỗi của P02 `Logout` / `Refresh` khi thua Deadlock và Follow-up `AUTH-DEADLOCK-MAP` (`AU2-BE2-2`):**
     - Qua kiểm tra mã nguồn P02 hiện hành: `WriteDomainError` tại `apps/api/internal/auth/authhttp/errors.go:22-51` chỉ ánh xạ `*auth.RateLimitedError`, `*auth.Error` và `*httpx.AuthError`; mọi lỗi `*pgconn.PgError` thô (như SQLSTATE `40P01` / `55P03`) thoát ra từ `a.svc.Logout` (`apps/api/internal/auth/authhttp/handlers.go:224-226`) hoặc `a.svc.Refresh` (`apps/api/internal/auth/authhttp/handlers.go:193-196`) hiện rơi xuống nhánh mặc định tại **`apps/api/internal/auth/authhttp/errors.go:50`** và trả `500 internal_error` (tương tự, middleware `httpx.IsRetryableTxError` chỉ được gắn trên các route content P04 trong `apps/api/internal/httpx/idempotency.go:61-74`, chưa gắn trong `authhttp.WriteDomainError`).
     - Theo đúng chỉ đạo của `advisor-dec-146` E2 B: **không sửa P02 `Logout` / `Refresh` trong lane này**; ghi nhận mục follow-up **`AUTH-DEADLOCK-MAP`** để ánh xạ `40P01`/`55P03` trong `authhttp.WriteDomainError` sang `503 dependency_unavailable` kèm `Retry-After: 1` cho các route auth P02 còn lại. Trong kịch bản va chạm `ResetPassword` vs `Logout` của U3, `ResetPassword` (nhờ retry 1 lần) luôn kết thúc ở trạng thái đã commit (toàn bộ session bị thu hồi) và không trả `500`.
   - **Rủi ro tồn dư đã chấp nhận (Residual Risk — `advisor-dec-146` E2 B):**
     - Trong trường hợp cực hiếm khi chính tài khoản đang thực hiện `POST /auth/password/reset` đồng thời gọi `Logout` hoặc `Refresh (reuse)` đúng vào cửa sổ mili-giây khoá chéo và cả hai lần thử trong `ResetPassword` đều bị xung đột khoá, người dùng sẽ nhận phản hồi `503 dependency_unavailable` (`Retry-After: 1`) và cần bấm lưu mật khẩu mới lại một lần; nếu `Logout` hoặc `Refresh` là phía bị Postgres chọn làm deadlock victim trước khi `AUTH-DEADLOCK-MAP` được triển khai, request `Logout`/`Refresh` đó có thể nhận một lỗi tạm thời trong khi `ResetPassword` vẫn commit và thu hồi toàn bộ phiên của tài khoản. Đây hoàn toàn là vấn đề sẵn sàng tạm thời (availability/retry) trên cùng một user, không tạo bất kỳ kẽ hở bảo mật hay phiên sống sót nào.

### 6. Vòng đời URL Fragment (`#token=`), Header Bảo mật, CSP và Điều hướng cứng trên Web (`AU2-FE1-5`, `AU2-FE1-11`, `AU2-FE1-12`, `AU2-FE2-1`, `AU2-FE2-2`, `AU2-FE2-5`)

1. **Vòng đời `#token=` trên `/app/auth/reset-password` và Quy tắc tương thích React Strict Mode (`AU2-FE1-5`, `AU2-FE2-5`):**
   - Link trong email có dạng: `{APP_ORIGIN}/app/auth/reset-password#token=<base64url_43_chars>`.
   - **Quy tắc chính xác trong `useLayoutEffect` để sống sót qua React Strict Mode (`reactStrictMode: true` trong `next.config.ts:7` chạy mount → cleanup → mount ở dev — `AU2-FE2-5`):**
     - Khai báo state cục bộ trong `ResetPasswordForm`: `const [token, setToken] = useState<string | null>(null)` và `const [fragmentHandled, setFragmentHandled] = useState(false)` (theo đúng precedent của `apps/web/features/auth/forms/verify-email-form.tsx:36,41-56`, nhưng **không** có biến cấp module).
     - Bên trong `useLayoutEffect(() => { ... }, [])`:
       1. **Chỉ xử lý khi `window.location.hash` không rỗng (`if (hash)`):** Hàm `takeTokenFromHash` kiểm tra `const hash = window.location.hash; if (hash) { ... }`. Nếu có `hash`, trích xuất tham số `token`, kiểm tra khớp biểu thức `/^[A-Za-z0-9_-]{43}$/` (hợp lệ thì `setToken(extracted)`, không hợp lệ hoặc rỗng thì `setToken(null)`), rồi gọi ngay `window.history.replaceState(null, '', window.location.pathname + window.location.search)` để xoá sạch `#token=...` khỏi thanh địa chỉ. Nếu `hash` rỗng (`""`) ở lần chạy thứ hai của Strict Mode double-effect, hàm **không được ghi đè** `token` đã nạp ở lần chạy đầu tiên.
       2. **Đánh dấu đã xử lý fragment sau khi hiệu ứng chạy:** Gọi `setFragmentHandled(true)` ở cuối `takeTokenFromHash()`. Chỉ quyết định hiển thị khung *"Liên kết bị thiếu / không hợp lệ"* (`missingToken`) **sau khi `fragmentHandled === true` và `token === null`** (trong lúc `fragmentHandled === false` ở pha render đầu tiên trước `useLayoutEffect`, chưa hiển thị khung lỗi thiếu token).
       3. **Hàm cleanup của `useLayoutEffect` chỉ gỡ listener `hashchange`:** `return () => window.removeEventListener('hashchange', takeTokenFromHash);`. **Tuyệt đối không** gọi `setToken(null)` hay xoá ref trong hàm cleanup của effect (vì React Strict Mode chạy cleanup rồi chạy lại effect trên cùng component instance trong khi hash trên URL đã bị `replaceState` xoá mất; khi component thực sự unmount thì state cục bộ của React tự động bị thu hồi cùng fiber).
       4. Chỉ xoá tường minh `setToken(null)` trong bộ nhớ khi: `POST /auth/password/reset` trả `204 No Content`, hoặc trả `400 reset_token_invalid`.
   - **Nơi lưu trữ Token trong bộ nhớ (Strict Component-State Isolation):**
     - **Tuyệt đối không** lưu token vào biến cấp module (module-level variable như `pendingVerificationToken` của `verify-email-form.tsx`), không lưu vào `sessionStorage` / `localStorage` / `IndexedDB`, không truyền qua React Query `useMutation` variables (để không lọt vào `MutationCache` theo `user-dec-016` — gọi trực tiếp hàm fetch `authPasswordReset({ token, new_password })`), không đưa vào `returnTo` hay URL query, và không ghi log.
   - **Xử lý khi thiếu, rỗng, sai định dạng Token hoặc khi người dùng Reload trang sau khi đã xoá Hash (`AU2-FE1-5`, `AU2-FE2-5`):**
     - Khi `fragmentHandled === true && token === null` (do người dùng tự gõ URL, mở từ bookmark, bấm Reload trang sau khi `replaceState` đã xoá fragment, hoặc giá trị `#token=` ban đầu rỗng / không khớp biểu thức `^[A-Za-z0-9_-]{43}$`):
       - Client **không gọi bất kỳ request mạng nào** lên server.
       - Hiển thị ngay khung trạng thái link không khả dụng / đã hết hạn (frame 4) kèm lời giải thích trung thực rằng nếu họ vừa tải lại trang thì có thể bấm lại liên kết trong email (vì việc mở trang chưa tiêu thụ token), hoặc yêu cầu gửi liên kết mới:
         - **VI:** *"Liên kết đặt lại mật khẩu bị thiếu, không hợp lệ hoặc đã hết hạn. Nếu bạn vừa tải lại trang này, hãy mở lại liên kết trực tiếp từ email của bạn, hoặc yêu cầu gửi một liên kết mới."*
         - **EN:** *"This password reset link is missing, invalid, or expired. If you just reloaded this page, open the link from your email again, or request a new reset link."*
2. **Header HTTP, CSP hẹp hơn cho `/app/auth/reset-password`, Điều hướng cứng (Hard Navigation) khi rời trang Reset và sửa `metadata.referrer` (`AU2-FE1-11`, `AU2-FE1-12`, `AU2-FE2-1`, `AU2-FE2-2`):**
   - Trong `apps/web/next.config.ts`:
     - Giữ quy tắc hiện có cho `/app/auth/:path*` (`Content-Security-Policy: turnstileCsp`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`) — quy tắc này bao phủ `/app/auth/forgot-password` và `/app/auth/login` (vốn cần `turnstileCsp` cho phép `https://challenges.cloudflare.com`).
     - Thêm một quy tắc **đặt sau** `/app/auth/:path*` dành riêng cho `source: '/app/auth/reset-password'` với:
       - `Content-Security-Policy`: dùng **`csp` cơ sở (base CSP, KHÔNG có `https://challenges.cloudflare.com`)** vì trang nhập mật khẩu mới không dùng Turnstile, giúp thu hẹp tối đa bề mặt script/frame bên thứ ba trên trang đang cầm reset token.
       - `Referrer-Policy`: `'no-referrer'`
       - `Cache-Control`: `'no-store'`
       - `X-Content-Type-Options`: `'nosniff'`
       - `X-Frame-Options`: `'DENY'`
     - Trong `apps/web/tests/csp.test.ts`: U4 bổ sung test khẳng định `/app/auth/forgot-password` có `Referrer-Policy: no-referrer` và `turnstileCsp`, còn `/app/auth/reset-password` có `Referrer-Policy: no-referrer`, `Cache-Control: no-store` và CSP cơ sở (không chứa `challenges.cloudflare.com`).
   - **Quy tắc bắt buộc dùng Điều hướng cứng (Hard Navigation) cho MỌI lối thoát khỏi `/app/auth/reset-password` (`AU2-FE2-1`):**
     - *Vấn đề:* Trình duyệt gắn `Content-Security-Policy` theo HTTP response của tài liệu (document) hiện tại. Khi người dùng đang ở `/app/auth/reset-password` (được phục vụ với base `csp` không có `https://challenges.cloudflare.com`), nếu dùng điều hướng mềm phía client của Next.js (`<Link>` của `next/link` hoặc `router.push` / `router.replace`), tài liệu HTML không được tải lại nên trang đích (`/app/auth/forgot-password` hoặc `/app/auth/login`) vẫn bị áp base `csp` của trang reset và trình duyệt sẽ chặn toàn bộ script/iframe Turnstile.
     - *Quyết định bắt buộc:* Mọi lối thoát từ `/app/auth/reset-password` sang route khác — bao gồm:
       1. Nút / liên kết **"Yêu cầu liên kết mới"** (`requestNewLink` → `/app/auth/forgot-password`) trên khung thiếu/hết hạn token,
       2. Điều hướng tự động sau **`204 No Content`** sang **`/app/auth/login?reset=done`**,
       3. Nút / liên kết **"Về đăng nhập"** (`backToLogin` → `/app/auth/login`),
       **bắt buộc phải thực hiện điều hướng cứng tải lại tài liệu (hard navigation)** bằng `window.location.assign(...)` hoặc thẻ `<a href="...">` thuần của HTML (**tuyệt đối không dùng `next/link` hay `router.push` / `router.replace`**). Điều hướng cứng vừa đảm bảo trình duyệt nhận đúng header `turnstileCsp` từ server cho `/app/auth/forgot-password` và `/app/auth/login`, vừa xoá sạch hoàn toàn bộ nhớ JS của trang đã từng cầm reset token.
   - **Một trải nghiệm hoàn tất duy nhất sau `204` qua cờ `/app/auth/login?reset=done` (`AU2-FE2-2`):**
     - Loại bỏ phương án hiển thị khung hoàn tất riêng trên `/app/auth/reset-password` và bỏ các khoá i18n của khung đó (`auth.reset.successTitle`, `auth.reset.successVaultNotice`, `auth.reset.continueToLogin`; khung số 5 `#forgot-done` trong `mockups/auth.html` chỉ là bản mẫu thiết kế/review độc lập).
     - Ngay sau khi `POST /auth/password/reset` trả `204 No Content`, chạy `postSessionBroadcast({ type: 'signed_out', reason: 'logout' })` và `await bootstrapCsrf()`, rồi gọi **`window.location.assign('/app/auth/login?reset=done')`** (chỉ truyền đúng cờ hằng số `?reset=done`, **tuyệt đối không có token hay địa chỉ email trong URL**).
     - Trên `/app/auth/login`, `LoginForm` kiểm tra `searchParams.get('reset') === 'done'` khi mount: nếu đúng thì bật state cục bộ `resetDone = true` để hiển thị banner thành công (`#login-reset-success-banner` dùng `auth.login.resetSuccessTitle` + `auth.login.resetSuccessBody`, nêu rõ mọi phiên đã đăng xuất và vault vẫn khoá kín) ở phía trên biểu mẫu đăng nhập, đồng thời gọi ngay `window.history.replaceState(null, '', window.location.pathname + cleanedSearchWithoutReset)` để gỡ tham số `reset=done` khỏi thanh địa chỉ (nhờ đó nếu người dùng tải lại trang đăng nhập lần nữa thì banner không hiện lại mãi).
   - Trong `apps/web/app/app/auth/layout.tsx` (`AU2-FE1-12`):
     - Thay `other: { 'Referrer-Policy': 'no-referrer' }` (sinh ra thẻ `<meta name="Referrer-Policy">` không hợp chuẩn HTML và bị trình duyệt bỏ qua) bằng trường chuẩn của Next.js `referrer: 'no-referrer'` (sinh `<meta name="referrer" content="no-referrer">`), đồng thời xác định rõ HTTP response header `Referrer-Policy: no-referrer` từ `next.config.ts` là chốt chặn chính.

### 7. Giới hạn tốc độ (Rate Limits) và Trải nghiệm Đếm ngược (`AU2-FE1-10`, `AU2-FE1-15`)

Sử dụng bộ giới hạn cửa sổ cố định (`httpx.FixedWindow`) và HMAC subject theo chuẩn P02 (`authhttp` / `auth/hmac.go`):

1. **Trên `POST /auth/password/forgot`:**
   - **Theo IP:** dùng chung bucket `credLimit` **5 yêu cầu / phút / IP** (`"cred:" + ip`) — vượt quá trả `429 rate_limited` kèm header `Retry-After` và `retry_after` trong body.
   - **Theo địa chỉ email đã chuẩn hoá (`key := "forgot:" + hex.EncodeToString(HashEmailSubject(emPepper, email))`):**
     - **1 yêu cầu / phút / email** (`mailMin`, cửa sổ cố định 60 giây) VÀ **3 yêu cầu / giờ / email** (`mailHour`, cửa sổ cố định 1 giờ).
     - **Chống dò tài khoản:** Kiểm tra và tăng bộ đếm theo HMAC email ở bước đồng bộ **trước** khi đẩy vào worker nền (cho mọi email hợp lệ cú pháp, khi `mail_delivery_available == true` và đã qua CAPTCHA). Nhờ đó cả email tồn tại lẫn email không tồn tại đều chạm `429 rate_limited` ở đúng cùng một ngưỡng.
2. **Trên `POST /auth/password/reset`:**
   - **Theo IP:** dùng chung bucket `credLimit` **5 yêu cầu / phút / IP** (`"cred:" + ip`).
   - Kiểm tra quy cách `new_password` (`ValidatePassword`: ≥ 12 ký tự Unicode, ≤ 1024 byte UTF-8) → không đạt trả `400 password_weak`.
3. **Hành vi khi chuyển từ Login sang Forgot Password (`AU2-FE1-15`):**
   - Vì `login`, `forgot` và `reset` dùng chung bucket `credLimit` (`5/phút/IP`), một người dùng vừa gõ sai mật khẩu liên tiếp 5 lần trên màn hình đăng nhập rồi bấm sang *"Quên mật khẩu?"* có thể gặp `429 rate_limited` ở lần bấm gửi đầu tiên (thời gian chờ tối đa 60 giây).
   - Giữ nguyên giới hạn dùng chung này để ngăn kẻ tấn công nhân đôi quota dò quét trên cùng một IP. U4 xử lý bằng cách tái sử dụng pattern `rateLimited` + `useRetryCountdown(retryUntil)` trên cả hai biểu mẫu `ForgotPasswordForm` và `ResetPasswordForm`.
   - Liên kết *"Quên mật khẩu?"* từ `/app/auth/login` sang `/app/auth/forgot-password` là liên kết tĩnh `/app/auth/forgot-password` — **tuyệt đối không** truyền địa chỉ email qua query string (`?email=...`) để tránh đưa email vào URL, lịch sử trình duyệt và access log.

### 8. Hoàn tất Reset: Thu hồi phiên, Thông báo riêng (`password_reset_notice`) và Sự kiện bảo mật (`secevent`)

Khi `POST /auth/password/reset` kiểm tra hợp lệ trong transaction DB (theo thứ tự khoá của `advisor-dec-146` E2 B: đọc `user_id` theo `token_hash` → `app_user FOR UPDATE` → `RevokeAllUserSessions` trên `session` → `password_reset_token FOR UPDATE`):

1. **Thu hồi TOÀN BỘ phiên và refresh token ngay dưới khoá user (`RevokeAllUserSessions` — `advisor-dec-146` E2 B):**
   - Ngay sau khi lấy khoá `GetUserByIDForUpdate(user_id)`, thực thi `UPDATE session SET revoked_at = $now WHERE user_id = $uid AND revoked_at IS NULL` — thu hồi **mọi** session của user (nếu bất kỳ kiểm tra token nào ở bước 2 thất bại, transaction rollback sẽ hoàn tác lệnh `UPDATE` này).
2. **Khoá `password_reset_token`, cập nhật mật khẩu, xác minh email và xử lý OAuth liên kết khi tài khoản chưa xác minh (`D3`, `advisor-dec-146` E1 A, `AU2-BE2-1`, `AU2-BE2-3`):**
   - Khoá `GetPasswordResetTokenByHashForUpdate(token_hash)` và xác minh: `consumed_at IS NULL`, `expires_at > now`, `equalFoldEmail(row.TargetEmail, u.Email)`, và `row.PasswordHashSha256 == SHA256(currentPasswordHash)` (nếu không khớp → rollback và trả `400 reset_token_invalid`).
   - Cập nhật `auth_identity.password_hash` bằng bản băm Argon2id mới của `new_password` (`HashPassword`: Argon2id `m=64MiB, t=3, p=1`, salt 16 B mới, key 32 B — đã tính trước khi mở transaction).
   - Đánh dấu `password_reset_token.consumed_at = now` (`ConsumePasswordResetToken`).
   - Vô hiệu hoá mọi proof email/enrollment đang chờ (`CancelPendingEmailProofs`) và mọi token reset khác đang chờ (`ExpirePendingPasswordResetTokensByUser`).
   - Nếu tài khoản chưa xác minh email tại thời điểm phát hành token hoặc hiện tại (**`row.WasEmailUnverified || !u.EmailVerifiedAt.Valid`** — `AU2-BE2-3`):
     - Cập nhật `email_verified_at = now` (`UpdateUserEmailVerified`).
     - Huỷ mọi giao dịch OAuth `mode = 'login'` đang ở trạng thái `'ready'` có `(identity_provider, identity_provider_uid)` khớp với các danh tính OAuth của user (`CancelReadyOAuthLoginByUserIdentities`), huỷ mọi giao dịch OAuth `link`/`reauth` đang ở trạng thái `'pending'`/`'claimed'`/`'ready'` của user (`CancelPendingOAuthByUser`) và mọi `oauth_reauth_receipt` chưa dùng của user (`CancelReceiptsByUser`).
     - Xoá mọi `auth_identity` có `provider IN ('google', 'github')` của user đó (`DeleteOAuthIdentitiesByUser`), và ghi các bản ghi `audit_log` `auth.identity.unlink` (`Reason: "unverified"`).
   - Reset bộ đếm khoá đăng nhập `auth_throttle` của email đó (`ResetThrottle(subject)`).
   - Nếu gặp SQLSTATE `40P01` hoặc `55P03` ở bất kỳ bước nào hoặc lúc `Commit`: rollback, thử lại toàn bộ transaction tối đa 1 lần; nếu vẫn lỗi thì trả `503 dependency_unavailable` kèm `Retry-After: 1` (`advisor-dec-146` E2 B).
3. **Sự kiện bảo mật (`secevent`) và Thông báo email chuyên biệt (`password_reset_notice` — `AU2-BE1-10`, `D3`):**
   - **Audit Event (`internal/secevent/event.go` & Web `audit-catalog.ts`):**
     - Thêm hằng số `EventPasswordReset = "auth.password.reset"` vào `apps/api/internal/secevent/event.go`.
     - Ghi `s.audit.Record(ctx, tx, secevent.Record{UserID: &uid, SessionID: nil, Event: secevent.EventPasswordReset, Result: secevent.ResultSuccess, Actor: "user", IPHash: HashIP(s.ipPepper, ip), UserAgent: ua, Meta: secevent.Meta{Provider: secevent.ProviderPassword}})`.
     - Trên Web (U4), thêm `'auth.password.reset'` vào `AUDIT_EVENTS` trong `apps/web/lib/auth/audit-catalog.ts` và thêm khoá dịch `settings.audit.events.auth_password_reset` vào `apps/web/messages/{vi,en}.json` (**VI:** `"Đặt lại mật khẩu đăng nhập qua email"`, **EN:** `"Login password reset via email"`).
   - **Phân biệt thông báo đặt lại mật khẩu (`password_reset_notice`) với thông báo bảo mật chung (`security`):**
     - Giữ nguyên thông báo bảo mật chung của P02 (`purpose = "security"`) cho các sự kiện P02 khác.
     - Mở rộng `secevent.Meta` (được whitelist nghiêm ngặt trong `Sanitize()`) bằng trường phân loại sự kiện thông báo được allowlist (ví dụ `Event: "auth.password.reset"` trong `secevent.Meta` hoặc trường `UnlinkedProviders []string` chỉ nhận các giá trị thuộc `{"google", "github"}` trong `secevent.Meta`).
     - Khi `POST /auth/password/reset` gọi `s.notify.NotifySecurity(ctx, tx, secevent.Notice{UserID: uid, Kind: secevent.NoticeSecurity, Meta: secevent.Meta{...}, EmailTargets: []string{u.Email}})`:
       - Hàng `user_notification` vẫn có `kind = "security"` (để feed thông báo trong ứng dụng hoạt động tương thích với `NOTICE_KINDS = ['security']`), kèm `meta` đã qua `Sanitize()` chứa dấu hiệu sự kiện `"auth.password.reset"` và danh sách provider OAuth bị gỡ (nếu có theo D3).
       - Trong `SecurityNoticeWorker.Work` (`apps/api/internal/worker/notice_mail.go`), worker đọc `row` (và `u.Locale` hoặc `meta`):
         - Nếu `meta` là thông báo đặt lại mật khẩu (`auth.password.reset`), worker gọi `w.mail.Send(ctx, to, purpose, detail)` với **purpose chuyên biệt `"password_reset_notice"`** (thay vì `"security"` chung chung), truyền kèm danh sách các provider đã bị gỡ liên kết (nếu có, ví dụ `"unlinked:google,github"` hoặc template tương ứng theo `u.Locale`) để email gửi cho người dùng có tiêu đề và nội dung rõ ràng:
           - **Tiêu đề / Nội dung (VI):** *"Mật khẩu đăng nhập engram của bạn vừa được đặt lại"* — nêu rõ mật khẩu tài khoản vừa được thay đổi và toàn bộ phiên đăng nhập đã bị thu hồi; nếu có OAuth provider bị gỡ theo D3 thì nêu rõ tên các provider đã bị ngắt liên kết (ví dụ: Google, GitHub); nếu người dùng không thực hiện thao tác này, hãy đặt lại mật khẩu ngay.
           - **Subject / Body (EN):** *"Your engram login password was reset"* — states that the account login password was changed and all sessions were signed out; if any OAuth providers were unlinked under D3, names those unlinked providers (e.g. Google, GitHub); advises resetting immediately if unauthorized.
         - Với mọi thông báo P02 khác, `SecurityNoticeWorker` tiếp tục gọi `w.mail.Send(ctx, to, "security", "")` không đổi.

### 9. Mã lỗi RFC 9457 (Problem Catalog) và Bảng ánh xạ i18n trên Web (`AU2-FE1-6`, `AU2-FE1-10`, `AU2-FE1-13`)

1. **Problem Catalog (5 nơi):**
   - Giữ nguyên các `problemTitles` tiếng Việt phía server trong `apps/api/internal/httpx/problem.go` (server problem titles không phải là copy hiển thị trực tiếp trên UI).
   - Chỉ thêm 1 mã mới vào cuối catalog (ngay sau `changes_window_expired`):
     - `reset_token_invalid` (`400 Bad Request`, title server: `"Mã đặt lại mật khẩu không hợp lệ"`).
   - Quyết định D3 (`advisor-dec-140`) về từ chối liên kết OAuth khi email chưa xác minh tái sử dụng mã lỗi đã có `email_not_verified` (`403 Forbidden`).
   - Trong `packages/shared-types/src/problem.test.ts` (`AU2-FE1-13`): đổi tên test và kiểm tra rõ phần đuôi catalog `[...p04, 'reset_token_invalid']` bằng `ERROR_CODES.slice(-(p04.length + 1))` thay cho phép tính chỉ số dễ vỡ.
2. **Quy tắc cấm render raw `problem.title` / `problem.detail`, Cấm tái sử dụng các khoá đặc thù của Login và Bảng ánh xạ mã lỗi sang i18n key cho U4 (`AU2-FE1-6`, `AU2-FE1-10`, `AU2-FE2-2..7`):**
   - Trên mọi màn hình xác thực (`/app/auth/login`, `/app/auth/signup`, `/app/auth/forgot-password`, `/app/auth/reset-password`, `/app/auth/verify-email`, `/app/auth/password-enroll`, `/app/auth/reauth`), U4 **tuyệt đối không bao giờ** hiển thị trực tiếp `err.problem.title` hay `err.problem.detail` từ server (vì server trả chuỗi tiếng Việt cố định sẽ gây trộn ngôn ngữ trên giao diện tiếng Anh), và chỉ hiển thị đúng một ngôn ngữ theo locale đang chọn trong mỗi lần render. Mọi nhánh fallback không xác định đều phải hiển thị khoá i18n `auth.errors.genericTitle`.
   - **Các khoá i18n đặc thù của màn hình Đăng nhập TUYỆT ĐỐI KHÔNG ĐƯỢC tái sử dụng trên `/app/auth/forgot-password` và `/app/auth/reset-password` (`AU2-FE2-3`):**
     - Không dùng `auth.errors.lockoutTitle` (*"Sign-in temporarily locked"* / *"Đăng nhập tạm khoá"*), `auth.errors.lockout`, `auth.errors.lockoutHint` (vốn nói về khoá đăng nhập) và không dùng `auth.errors.captchaHint` (*"After several failed attempts, each sign-in needs Turnstile"*).
     - Thay vào đó, bổ sung khoá tiêu đề trung tính **`auth.errors.rateLimitedTitle`** (**VI:** `"Yêu cầu quá nhanh"`, **EN:** `"Too many attempts"`) để kết hợp với `auth.errors.rateLimited` (`{seconds}`) cho trạng thái `429 rate_limited` trên cả hai màn hình `forgot-password` và `reset-password`.
   - **Bảng ánh xạ đầy đủ các trạng thái và mã lỗi sang khoá i18n `auth.*` / `settings.*` (`apps/web/messages/{vi,en}.json`) cho U4:**

| Màn hình / Tình huống | Điều kiện / Mã lỗi HTTP & `problem.code` | Khoá i18n (`auth.*` / `settings.*`) trong `messages/{vi,en}.json` | Hành vi UI trên U4 |
|---|---|---|---|
| **Forgot** — Đang tải `/auth/config` | `config === null` và `!bootstrapComplete \|\| configQuery.isLoading` | `auth.guard.loading` (hoặc skeleton biểu mẫu) | Hiển thị skeleton hoặc giữ nút submit `disabled`; chưa cho phép gửi (`AU2-FE2-4`) |
| **Forgot** — Lỗi tải `/auth/config` | `status === 'unavailable'` hoặc `configQuery.isError` | `auth.errors.networkTitle`, `auth.errors.network` | Hiển thị thẻ lỗi mạng/không khả dụng, không hiển thị biểu mẫu rỗng (`AU2-FE2-4`) |
| **Forgot** — Mail chưa bật từ cấu hình | `config !== null && config.mail_delivery_available !== true` | `auth.forgot.mailUnavailableTitle`, `auth.forgot.mailUnavailableBody`, `auth.forgot.backToLogin` | Hiển thị ngay trạng thái tĩnh báo chưa hỗ trợ gửi email, không hứa hẹn hộp thư, **không mount script/widget Turnstile** (`AU2-FE2-4`); hướng dẫn tới kênh liên hệ (`/legal#contact`), chỉ nhắc phương thức đăng nhập OAuth nếu `config.oauth_providers.length > 0`, kèm liên kết quay lại đăng nhập (`AU2-FE2-7`c) |
| **Forgot** — Đang gửi | `submitting === true` | `auth.forgot.submitting`, `auth.forgot.submittingButton` | Khoá nút submit, hiện trạng thái đang xử lý |
| **Forgot** — Thành công | `202 Accepted` | `auth.forgot.sentTitle`, `auth.forgot.sentBody`, `auth.forgot.tryAnotherEmail`, `auth.forgot.backToLogin` | Chuyển sang khung "Đã gửi hướng dẫn tiếp theo" (không hứa thời gian 30 phút cứng, không lộ tài khoản tồn tại hay OAuth-only); khi bấm `tryAnotherEmail` phải reset lại Turnstile widget (`AU2-FE2-6`) |
| **Forgot** — Email rỗng / sai cú pháp | Validation phía client hoặc `400 invalid_request` | `auth.validation.email.required`, `auth.validation.email.invalid` | Báo lỗi inline ngay dưới ô email, focus vào ô email |
| **Forgot** — Cần CAPTCHA | `403 captcha_required` (hoặc thiếu token khi `captcha_site_key != null`) | `auth.errors.captchaRequiredTitle`, `auth.errors.captchaRequired` | Reset Turnstile widget (`captchaResetSignal++`), hiển thị thẻ cảnh báo yêu cầu hoàn thành xác minh (không dùng `auth.errors.captchaHint` — `AU2-FE2-3`, `AU2-FE2-6`) |
| **Forgot / Reset** — CSRF hết hạn | `403 csrf_invalid` | `auth.errors.genericTitle` (sau khi tự gọi `ensureCsrf()` và thử lại tối đa 1 lần) | Nếu thử lại vẫn lỗi thì hiện thông báo lỗi chung theo ngôn ngữ hiện tại (reset Turnstile nếu ở trang forgot) |
| **Forgot** — Quá giới hạn tốc độ | `429 rate_limited` (`retry_after`) | `auth.errors.rateLimitedTitle`, `auth.errors.rateLimited` (`{seconds}`) | Reset Turnstile widget (`AU2-FE2-6`), chạy `useRetryCountdown`, khoá nút gửi cho tới khi đếm ngược về `0` (không dùng `lockoutTitle`/`lockoutHint` — `AU2-FE2-3`) |
| **Forgot** — Dịch vụ mail tắt/lỗi sau khi bấm gửi | `503 mail_delivery_unavailable` | `auth.forgot.mailUnavailableTitle`, `auth.forgot.mailUnavailableBody`, `auth.forgot.backToLogin` | Reset Turnstile widget (`AU2-FE2-6`); hiển thị khung không gửi được email (không có nút retry chết, bỏ khoá `auth.forgot.retry` — `AU2-FE2-7`b); hướng dẫn tới kênh liên hệ (`/legal#contact`), chỉ gợi ý phương thức OAuth nếu `config.oauth_providers.length > 0`, kèm liên kết về đăng nhập (`AU2-FE2-7`c) |
| **Forgot / Reset** — Lỗi mạng hoặc `503 dependency_unavailable` | Lỗi fetch / không phải `ProblemError` hoặc `503 dependency_unavailable` | `auth.errors.networkTitle`, `auth.errors.network` (hoặc đếm ngược 1s nếu có `retry_after`) | Reset Turnstile widget nếu ở trang forgot (`AU2-FE2-6`); hiển thị thẻ lỗi, giữ nguyên dữ liệu/token trong state để người dùng bấm gửi lại |
| **Reset** — Thiếu hoặc sai `#token=` trên URL | Sau khi `useLayoutEffect` chạy (`fragmentHandled === true`) mà `token === null` (kể cả sau reload hoặc sai format 43 ký tự base64url) | `auth.reset.missingTokenTitle`, `auth.reset.missingTokenBody`, `auth.reset.requestNewLink`, `auth.reset.backToLogin` | Không gọi API; hiện khung báo mở lại link từ email (nếu vừa reload) hoặc yêu cầu link mới. Nút `requestNewLink` (`/app/auth/forgot-password`) và `backToLogin` (`/app/auth/login`) **bắt buộc dùng hard navigation** (`<a href>` hoặc `window.location.assign` — `AU2-FE2-1`, `AU2-FE2-5`) |
| **Reset** — Đang lưu | `submitting === true` | `auth.reset.submitting`, `auth.reset.submittingButton` | Khoá nút submit, hiện trạng thái đang lưu |
| **Reset** — Thành công & Banner trên trang Đăng nhập | `204 No Content` → hard-navigate `/app/auth/login?reset=done` | `auth.login.resetSuccessTitle`, `auth.login.resetSuccessBody` | Xoá token trong state, gọi `postSessionBroadcast({ type: 'signed_out', reason: 'logout' })` (nguồn cleanup duy nhất) + `await bootstrapCsrf()`, rồi gọi **`window.location.assign('/app/auth/login?reset=done')`**; trang `/app/auth/login` đọc `?reset=done`, hiển thị banner thành công (nêu rõ mọi phiên đã đăng xuất + vault vẫn khoá) và xoá ngay `?reset=done` bằng `history.replaceState` (`AU2-FE2-1`, `AU2-FE2-2`, `AU2-FE2-7`a) |
| **Reset** — Token hết hạn / đã dùng / không hợp lệ | `400 reset_token_invalid` | `auth.reset.invalidTokenTitle`, `auth.reset.invalidTokenBody`, `auth.reset.requestNewLink`, `auth.reset.backToLogin` | Xoá token trong state; chuyển sang khung link không còn hiệu lực; nút `requestNewLink` (`/app/auth/forgot-password`) và `backToLogin` (`/app/auth/login`) **bắt buộc dùng hard navigation** (`AU2-FE2-1`) |
| **Reset / Signup** — Mật khẩu yếu hoặc quá dài | Client check (`< 12` ký tự hoặc `> 1024` byte UTF-8) hoặc `400 password_weak` | `auth.validation.password.short` (`< 12` ký tự), `auth.validation.password.tooLong` (`> 1024` byte UTF-8), `auth.validation.password.weak` (server `password_weak` bao quát cả giới hạn 12 ký tự và 1024 byte) | Báo lỗi inline tại ô mật khẩu mới |
| **Reset / Signup** — Xác nhận mật khẩu lệch | `confirmPassword !== newPassword` | `auth.validation.password.mismatch` (hoặc `auth.enroll.mismatch`) | Báo lỗi inline tại ô nhập lại mật khẩu |
| **Reset** — Quá giới hạn tốc độ | `429 rate_limited` (`retry_after`) | `auth.errors.rateLimitedTitle`, `auth.errors.rateLimited` (`{seconds}`) | Chạy `useRetryCountdown` trên biểu mẫu đặt lại mật khẩu, giữ nguyên token trong state để người dùng bấm gửi lại khi hết đếm ngược (`AU2-FE2-3`) |
| **Settings › Tài khoản** — Liên kết OAuth khi chưa xác minh email | `403 email_not_verified` trên `POST /auth/oauth/{provider}/link` | `settings.account.linkRequiresVerifiedEmail` | Hiển thị thông báo yêu cầu xác minh địa chỉ email hiện tại trước khi liên kết Google/GitHub |
| **Settings › Bảo mật** — Nhật ký sự kiện đặt lại mật khẩu | `event === "auth.password.reset"` | `settings.audit.events.auth_password_reset` | Hiển thị nhãn sự kiện đã dịch trong bảng nhật ký bảo mật |
### 10. Quy tắc Route Guard trên Web (`features/auth/guard-redirect.ts` — `AU2-BE1-8`, `AU2-FE1-2`)

Để người dùng mở `/app/auth/forgot-password` hoặc mở liên kết `/app/auth/reset-password#token=...` từ email không bao giờ bị `RouteGuard` đá sang trang khác làm mất `#token=` (dù trình duyệt đó đang đăng xuất, đang đăng nhập cùng tài khoản hay khác tài khoản, chưa xác minh email, chưa tạo vault hay đang khoá vault), U4 **bắt buộc** cập nhật `apps/web/features/auth/guard-redirect.ts` (và `apps/web/tests/route-guard.test.tsx`) như sau:

1. **Giữ form mount trong lúc `status === 'loading'` (`keepAuthFormMountedWhileLoading`):**
   - Bổ sung `/app/auth/forgot-password` và `/app/auth/reset-password` vào `keepAuthFormMountedWhileLoading(path)` để `RouteGuard` không thay cây DOM bằng `<AuthLoadingFrame>` trong lúc bootstrap CSRF/Me, giúp `ResetPasswordForm` chạy `useLayoutEffect` đọc và xoá `#token=` ngay ở frame đầu tiên.
2. **Cho phép truy cập khi đã đăng xuất (`status === 'signed_out'`):**
   - Trong `isPublicAuthRoute(path)` (hoặc nhánh `if (status === 'signed_out')` của `resolveGuardRedirect`): cho phép cả `/app/auth/forgot-password` và `/app/auth/reset-password` trả về `null` (không redirect về `/app/auth/login?returnTo=...`).
3. **Cho phép truy cập ở MỌI trạng thái đã đăng nhập (`needsEmailVerify`, `authenticated_without_vault`, `authenticated_with_vault` cả khi vault đang khoá lẫn khi đang mở):**
   - Khai báo biến nhận diện trong `resolveGuardRedirect`:
     - `const forgotPassword = pathname === '/app/auth/forgot-password';`
     - `const resetPassword = pathname === '/app/auth/reset-password';`
   - Bổ sung `forgotPassword || resetPassword` vào danh sách cho phép (`allowed`) của **cả 4 nhánh**:
     1. Nhánh `if (needsEmailVerify(me))`: `const allowed = settings || verify || callback || enroll || reauth || forgotPassword || resetPassword;`
     2. Nhánh `if (status === 'authenticated_without_vault')`: `const allowed = settings || onboarding || callback || reauth || verify || enroll || forgotPassword || resetPassword;`
     3. Nhánh `if (!isVaultUnlocked)` (khi `authenticated_with_vault` và vault đang `locked`/`unlocking`/`recovering`/`error`): bổ sung `forgotPassword || resetPassword` vào `allowedWhileLocked`.
     4. Nhánh cuối khi vault đã mở (`if (auth && !reauth && !callback && !verify && !enroll && !forgotPassword && !resetPassword) return '/app';`): giữ nguyên trên `/app/auth/forgot-password` và `/app/auth/reset-password` (không redirect về `/app`).

## Các phương án đã cân nhắc và loại bỏ (Alternatives)

| Phương án | Lý do loại bỏ |
|---|---|
| **Kiểm tra `s.mail == nil` để phát hiện dịch vụ gửi thư tắt** | `compose.NewAuth` luôn gán `SinkMailer` khi `mail == nil` ở môi trường dev/production hiện tại (`advisor-dec-086`), làm nhánh `503` không bao giờ chạy. Thay bằng cờ `mail_delivery_available` kết hợp `AUTH_MAIL_CAPTURE_AS_DELIVERY` (fail closed, bị cấm ở `APP_ENV=production`). |
| **Chỉ chạy bất đồng bộ lệnh `Mailer.Send` sau khi đã tra cứu DB và tạo token đồng bộ** | Tạo chênh lệch thời gian (timing channel) giữa tài khoản có password (tốn khoá hàng + `UPDATE` + `INSERT` + commit) và email không tồn tại. Thay bằng một ranh giới chấp nhận bất đồng bộ duy nhất cùng hàng đợi worker có giới hạn trong bộ nhớ. |
| **Đẩy link/token qua bảng `river_job` của PostgreSQL** | Lưu bearer token chưa băm vào cột JSON `args` của `river_job`, vi phạm bất biến chỉ lưu bản băm trong DB. Worker trong bộ nhớ giữ token thô hoàn toàn trong RAM. |
| **Tự động đăng nhập (cấp session cookie) ngay trong `POST /auth/password/reset`** | Làm phức tạp trạng thái cookie/CSRF/vault khi trình duyệt đang có phiên cũ của cùng hoặc khác user. Trả `204`, xoá cookie bằng `ClearAuthCookies` và dọn sạch state/cache phía client trước khi về màn hình đăng nhập an toàn và rõ ràng hơn. |
| **Thêm endpoint `POST /auth/password/reset/check` để kiểm tra token trước khi hiện form** | Tăng thêm một endpoint unauthenticated để dò token và vẫn có thể hết hạn giữa lúc mở form với lúc submit (`user-dec-015`). |
| **Cho phép liên kết OAuth mới khi email tài khoản chưa xác minh** | Mở lỗ hổng pre-registration: kẻ tấn công tạo trước tài khoản bằng email nạn nhân, gắn OAuth của kẻ tấn công rồi chờ nạn nhân reset mật khẩu. Chặn liên kết OAuth mới khi `email_verified_at IS NULL` và gỡ mọi OAuth khi reset tài khoản unverified (`advisor-dec-140` D3) đóng triệt để đường này. |

## Hệ quả

- **U2 (Contract):**
  - Cập nhật `docs/adr/0006-account-password-reset.md`, `docs/SPEC.md` (`US1c`, `§3.16`, `§7.0`, `§7.6`, `§8`, `§9.1`, `§9.2`, `§12.2`), `docs/threat-model.md` (`C-7`..`C-10`), `apps/api/api/openapi.yaml` (`AuthConfig.mail_delivery_available`, `PasswordForgotRequest.locale`, `PasswordResetRequest.token` 43-char base64url, `/auth/password/reset` response `503 ContentUnavailable` `dependency_unavailable` kèm `Retry-After: 1`, `/auth/oauth/{provider}/link` `403 email_not_verified`), `packages/shared-types/src/problem.test.ts` và tái sinh `packages/shared-types/src/api.d.ts`.
- **U3 (API) — Danh sách triển khai, các điểm áp dụng P02 và kịch bản kiểm thử bắt buộc trên Cloud CI:**
  1. Cấu hình `AUTH_MAIL_CAPTURE_AS_DELIVERY` (mặc định `false`; từ chối khởi động khi `APP_ENV=production` hoặc `staging`) và trường `mail_delivery_available` trong `AuthConfig` (`GET /auth/config`).
  2. Migration `0007_password_reset.{up,down}.sql` (bảng `password_reset_token` có cột bắt buộc `was_email_unverified boolean NOT NULL DEFAULT false`) + queries sqlc (`InsertPasswordResetToken`, `GetPasswordResetTokenByHash`, `GetPasswordResetTokenByHashForUpdate`, `ConsumePasswordResetToken`, `ExpirePendingPasswordResetTokensByUser`, `DeleteExpiredPasswordResetTokens`, `RevokeAllUserSessions`, `DeleteOAuthIdentitiesByUser`, `CancelPendingOAuthByUser`, `CancelReadyOAuthLoginByUserIdentities`, `CancelReceiptsByUser`).
  3. Ranh giới bất đồng bộ và worker trong bộ nhớ (`forgotQueueSize = 128`) cho `POST /auth/password/forgot` (kiểm tra cú pháp + `mail_delivery_available` + IP limit + Turnstile CAPTCHA đồng nhất + HMAC email limit trước khi đưa vào queue; trong worker lấy `app_user FOR UPDATE`, ghi `was_email_unverified = !u.EmailVerifiedAt.Valid` trên mọi lần phát hành; gửi mail theo `locale`).
  4. `POST /auth/password/reset`:
     - Dùng DTO có nhận biết sự hiện diện của trường (`Token *string`, `NewPassword *string` hoặc `json.RawMessage` — `AU2-BE2-4`): thiếu trường / `null` / sai kiểu JSON → `400 invalid_request`; chuỗi `token` rỗng hoặc không phải 43 ký tự base64url giải mã ra 32 byte → `400 reset_token_invalid`.
     - Thực thi transaction theo thứ tự khoá của `advisor-dec-146` E2 B (`AU2-BE2-2`): đọc không khoá `user_id` theo `token_hash` → `GetUserByIDForUpdate(user_id)` → `RevokeAllUserSessions(user_id)` (ngay sau khoá user) → `GetPasswordResetTokenByHashForUpdate(token_hash)` → kiểm tra trạng thái & cập nhật `password_hash`, `ConsumePasswordResetToken`, `CancelPendingEmailProofs`, `ExpirePendingPasswordResetTokensByUser`, xử lý D3 nếu `row.WasEmailUnverified || !u.EmailVerifiedAt.Valid`, `ResetThrottle`, ghi `auth.password.reset` và gửi `password_reset_notice` theo `u.Locale`.
     - Khi gặp SQLSTATE `40P01` hoặc `55P03`: rollback và thử lại toàn bộ transaction tối đa 1 lần; nếu vẫn gặp `40P01`/`55P03` thì trả `503 dependency_unavailable` kèm `Retry-After: 1` (không bao giờ trả `500`, không bao giờ áp dụng dở dang).
     - Trên response `204 No Content`, gọi `authhttp.ClearAuthCookies(w)`.
  5. **Danh sách đầy đủ 6 điểm áp dụng trên mã P02 do U3 thực hiện (`advisor-dec-140` D2/D3, `advisor-dec-146` E1 A, `AU2-BE1-3`, `AU2-BE1-4`, `AU2-BE1-7`, `AU2-BE2-1`):**
     1. **`Service.Login` (`apps/api/internal/auth/service.go` — D2):** sau `VerifyPassword` ngoài tx, trong transaction cấp session phải gọi `GetUserByIDForUpdate(u.ID)`, đọc lại `GetIdentityByUserProvider(u.ID, "password")` và kiểm tra `password_hash` hiện tại vẫn khớp với `verifiedHash` trước khi gọi `sessions.Issue` (nếu lệch → rollback, trả `401 invalid_credentials`).
     2. **`oauth.Service.Complete` (`apps/api/internal/auth/oauth/service.go` — `advisor-dec-146` E1 A, `AU2-BE2-1`):** đọc không khoá `GetLatestOAuthTxByBinding` và khám phá chủ sở hữu qua `GetIdentityByProviderUID(provider, uid)` trước khi lấy khoá; nếu danh tính OAuth đã tồn tại, mở tx và lấy **`GetUserByIDForUpdate(ident.UserID)` trước**, sau đó đọc lại `GetIdentityByProviderUID` và khoá `GetOAuthTxByIDForUpdate(row.ID)` dưới khoá user, chỉ cấp session nếu ánh xạ `(provider, uid)` vẫn tồn tại và thuộc cùng `userID` và flow vẫn ở trạng thái `ready`/còn hạn (nếu identity đã bị gỡ hoặc flow đã bị huỷ → rollback, trả `400 oauth_state_invalid`, tuyệt đối không chuyển sang tạo user mới). Nhánh tạo tài khoản OAuth mới (OAuth signup) giữ nguyên.
     3. **`oauth.Service.StartLink` và `oauth.Service.Callback` nhánh `case "link":` (`apps/api/internal/auth/oauth/service.go` — D3):** từ chối liên kết OAuth mới khi tài khoản hiện tại chưa xác minh email (`!u.EmailVerifiedAt.Valid`), trả `403 email_not_verified` (`auth.ErrEmailNotVerified`) ở `StartLink` và `"invalid_flow"` ở `Callback`.
     4. **`Service.ConfirmEmailToken` (`apps/api/internal/auth/account.go:269-278`, nhánh `row.Purpose == "email_change"` — `AU2-BE1-7`):** gọi `ExpirePendingPasswordResetTokensByUser` dưới khoá `GetUserByIDForUpdate` ngay cạnh `CancelPendingEmailProofs`.
     5. **`Service.ChangePassword` (`apps/api/internal/auth/account.go:66-69` — `AU2-BE1-7`):** gọi `ExpirePendingPasswordResetTokensByUser` (và `CancelPendingEmailProofs`) dưới khoá `GetUserByIDForUpdate`.
     6. **`Service.UnlinkIdentity` (`apps/api/internal/auth/account.go:330-339`, khi `provider == "password"` — `AU2-BE1-7`):** gọi `ExpirePendingPasswordResetTokensByUser` dưới khoá `GetUserByIDForUpdate`.
     - *(Không sửa thứ tự khoá của P02 `Service.Logout` và `SessionStore.Refresh`; theo dõi việc ánh xạ `40P01`/`55P03` trong `authhttp.WriteDomainError:50` tại follow-up `AUTH-DEADLOCK-MAP` theo `advisor-dec-146` E2 B).*
  6. **Các kịch bản kiểm thử Cloud CI bắt buộc cho U3:**
     - **D1 (`mail_delivery_available`):** khi dùng `SinkMailer` mà không bật `AUTH_MAIL_CAPTURE_AS_DELIVERY`, `/auth/config` trả `mail_delivery_available: false` và `POST /auth/password/forgot` trả `503 mail_delivery_unavailable`; khi bật `AUTH_MAIL_CAPTURE_AS_DELIVERY=true` ở `APP_ENV=production` thì `config.Load()` trả lỗi từ chối khởi động.
     - **Anti-enumeration & Async boundary (`AU2-BE1-2`):** chặn (block) công việc DB/mail bên trong worker và xác nhận `POST /auth/password/forgot` vẫn trả `202 Accepted` ngay lập tức như nhau cho cả 3 nhánh (password, OAuth-only, unknown email); kiểm tra tràn hàng đợi vẫn trả `202`.
     - **Kiểm tra biên JSON trên `POST /auth/password/reset` (`AU2-BE2-4`):** (a) thiếu `token`, (b) `token: null`, (c) thiếu `new_password`, (d) `new_password: null`, (e) sai kiểu JSON (`token: 123`, `new_password: ["a"]`) đều trả `400 invalid_request`; trong khi (f) `token: ""` (chuỗi rỗng) và chuỗi sai độ dài / sai bảng mã base64url trả `400 reset_token_invalid`.
     - **Đua song song khi phát hành (`AU2-BE1-6`):** 2 yêu cầu phát hành chạy song song cho cùng một user chỉ để lại đúng 1 token còn hiệu lực (token phát hành sau theo thứ tự khoá `app_user FOR UPDATE`).
     - **Đua song song giữa `Login` mật khẩu cũ và `ResetPassword` (`D2 / AU2-BE1-3`):** kịch bản kiểm thử tất định (dùng barrier sau `VerifyPassword` của `Login`, cho `ResetPassword` commit mật khẩu mới + thu hồi phiên, rồi mở barrier cho `Login`) chứng minh `Login` bị từ chối với `401 invalid_credentials` và không có phiên nào sống sót.
     - **Đua song song giữa `oauth.Service.Complete` / `Callback` và `ResetPassword` trên tài khoản unverified (`advisor-dec-146` E1 A / `AU2-BE2-1`):**
       1. Kịch bản barrier tất định trong `oauth.Service.Complete`: tạm dừng `Complete` ngay sau bước khám phá chủ sở hữu không khoá (hoặc khi flow đang `ready`), cho `ResetPassword` của tài khoản chưa xác minh commit (đánh dấu email verified, gỡ mọi OAuth identity, huỷ các luồng OAuth `login` `ready` và thu hồi mọi phiên), rồi cho `Complete` chạy tiếp → khẳng định `Complete` bị từ chối với `400 oauth_state_invalid`, **không có bất kỳ phiên nào của kẻ tấn công sống sót**, và lần đăng nhập OAuth tiếp theo không thể vào tài khoản đã khôi phục.
       2. Kịch bản callback đang ở bước trao đổi provider (`status = 'claimed'`): khi callback OAuth `login` hoàn tất trao đổi sau khi `ResetPassword` đã commit, lời gọi `Complete` tiếp theo không tìm thấy `auth_identity` đã bị gỡ và bị chặn bởi `409 email_taken` (không tạo tài khoản trùng và không cấp session).
     - **Xác minh email giữa lúc phát hành và lúc tiêu thụ token reset (`AU2-BE2-3`):** phát hành token reset khi `email_verified_at IS NULL` (`was_email_unverified = true`), sau đó xác minh email của tài khoản trước khi tiêu thụ token reset, rồi gọi `POST /auth/password/reset` → khẳng định nhờ `row.WasEmailUnverified == true`, giao dịch reset vẫn gỡ sạch mọi OAuth identity, thu hồi toàn bộ session, ghi secevent `auth.identity.unlink` (`reason = "unverified"`) và gửi `password_reset_notice` nêu tên các provider bị gỡ.
     - **Va chạm cưỡng bức giữa `ResetPassword` và `Logout` (`advisor-dec-146` E2 B / `AU2-BE2-2`):** kịch bản CI giữ khoá/barrier tạo va chạm giữa `ResetPassword` và `Logout` trên cùng một user (hoặc giả lập xung đột `40P01`/`55P03` lần đầu) → khẳng định `ResetPassword` tự động retry và kết thúc ở trạng thái đã commit (mật khẩu được cập nhật, mọi session bị thu hồi), không trả `500`.
     - **Đổi email A → B → A (`AU2-BE1-7`):** phát hành token reset ở email A, đổi email sang B rồi đổi lại về A (giữ nguyên mật khẩu), xác nhận token reset ban đầu bị từ chối với `400 reset_token_invalid`.
- **U4 (Web) — Danh sách triển khai và kiểm thử bắt buộc:**
  1. Cập nhật `apps/web/features/auth/guard-redirect.ts` (và unit test `apps/web/tests/route-guard.test.tsx`) để `/app/auth/forgot-password` và `/app/auth/reset-password` hoạt động ở mọi trạng thái (`signed_out`, `loading` keep-mounted, `needsEmailVerify`, `authenticated_without_vault`, `authenticated_with_vault` locked/unlocked).
  2. Cập nhật `apps/web/next.config.ts` (thêm rule header riêng cho `/app/auth/reset-password` với base CSP không có Turnstile, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`), `apps/web/app/app/auth/layout.tsx` (`metadata.referrer = 'no-referrer'`), và mở rộng `apps/web/tests/csp.test.ts`.
  3. Triển khai `/app/auth/forgot-password`:
     - Chỉ coi mail khả dụng khi `config?.mail_delivery_available === true`; hiện skeleton/disabled khi `config === null`, hiện thẻ lỗi mạng khi tải config lỗi, và hiện khung tĩnh không khả dụng (không mount script/widget Turnstile, trỏ tới kênh liên hệ `/legal#contact`, chỉ nhắc OAuth nếu `oauth_providers.length > 0`) khi `mail_delivery_available !== true` hoặc khi nhận `503 mail_delivery_unavailable` (`AU2-FE2-4`, `AU2-FE2-7`b,c).
     - Khi `mail_delivery_available === true` và `captcha_site_key != null`, luôn render `<TurnstileWidget>` và **reset widget (`captchaResetSignal++`) sau mọi kết quả submit** (`403`, `429`, `503`, lỗi mạng, và khi bấm `tryAnotherEmail` sau `202` — `AU2-FE2-6`, kèm unit test cho retry sau `429` và sau `tryAnotherEmail`).
  4. Triển khai `/app/auth/reset-password` và banner trên `/app/auth/login`:
     - Đọc `#token=` trong `useLayoutEffect` theo quy tắc tương thích Strict Mode (`if (hash)` mới đọc và `replaceState`, cleanup chỉ gỡ listener `hashchange`, chỉ quyết định thiếu token sau khi `fragmentHandled === true && token === null` — `AU2-FE2-5`).
     - **Mọi lối thoát khỏi `/app/auth/reset-password`** (`requestNewLink` sang `/app/auth/forgot-password`, điều hướng sau `204` sang `/app/auth/login?reset=done`, và `backToLogin` sang `/app/auth/login`) **bắt buộc dùng hard navigation** (`window.location.assign` hoặc `<a href>` thuần, không dùng `next/link` hay `router.push`/`replace` — `AU2-FE2-1`), kèm kiểm thử U4 khẳng định tính chất hard navigation (và widget Turnstile hoạt động trên trang đích).
     - Khi nhận `204 No Content`, dùng `postSessionBroadcast({ type: 'signed_out', reason: 'logout' })` làm nguồn dọn dẹp duy nhất + `await bootstrapCsrf()`, rồi điều hướng cứng sang `/app/auth/login?reset=done`; trên `/app/auth/login`, hiển thị banner thành công (`auth.login.resetSuccessTitle` + `auth.login.resetSuccessBody`) khi có `?reset=done` và xoá ngay tham số đó bằng `history.replaceState` (kèm unit/E2E test xác nhận banner hiện một lần và không hiện lại khi reload, cũng như không hiện banner phiên cũ sau lần đăng nhập tiếp theo — `AU2-FE2-2`, `AU2-FE2-7`a,d).
  5. Bổ sung đầy đủ các khoá `auth.forgot.*` (không có `auth.forgot.retry`), `auth.reset.*` (không có `successTitle`/`successVaultNotice`/`continueToLogin`), `auth.login.{resetSuccessTitle,resetSuccessBody}`, `auth.errors.rateLimitedTitle` (không tái sử dụng `lockoutTitle`/`lockoutHint`/`captchaHint`), `auth.validation.password.*`, `settings.account.linkRequiresVerifiedEmail`, `settings.audit.events.auth_password_reset` trong `apps/web/messages/{vi,en}.json` và `'auth.password.reset'` trong `apps/web/lib/auth/audit-catalog.ts`; thêm unit test xác nhận mọi mã lỗi auth/reset đều ánh xạ sang khoá i18n hợp lệ ở cả `vi` và `en` (`AU2-FE2-2`, `AU2-FE2-3`, `AU2-FE2-7`b).
