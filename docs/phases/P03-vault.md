# P03 — Vault, mã hoá và recovery

> Kế hoạch · MVP 3/6 · Phụ thuộc: [P02](P02-auth.md).
> Nguồn: [SPEC](../SPEC.md) §3.2–§3.3, §3.9–§3.15, §5, §7.6, §9, §11.4.

## Mục tiêu và đầu ra

User có vault với passphrase riêng, đúng 10 RK ở onboarding và passkey PRF tuỳ chọn; unlock ở browser khác, tự khoá, nhớ/quên thiết bị, recovery và đổi passphrase hoạt động thật. Giữ VK qua passkey/DevKey/phiên đang mở đủ quyền rewrap KEK sau re-auth tài khoản, không đòi passphrase cũ.

P03 bàn giao crypto module và key lifecycle. Entry CRUD chưa thuộc phase này; dùng fixture ciphertext đi qua API/DB test harness để chứng minh round-trip, sau đó P04 bắt buộc kiểm chứng lại trên entry thật. Không đánh dấu kiểm thử reset giữ Item/Tag đã đạt khi mới có vault rỗng.

## Hai mốc nội bộ

| Mốc | Đầu ra | Điều kiện |
|---|---|---|
| P03-A — Core/passphrase/RK | Worker, wrap/envelope vectors, onboarding đủ 10 RK, passphrase unlock, rewrap và recovery atomic | Không phát hành onboarding chỉ có passphrase hoặc RK giả |
| P03-B — Passkey/DevKey/lifecycle | PRF create/get, nhiều credential, remember/forget/auto-lock, Settings, error states | P03-A qua vector/concurrency gate |

Ngoài phạm vi: login-with-passkey, largeBlob/server-held fallback, rotate VK, share key; đều giữ ngoài MVP tương ứng P07/P08.

## Thiết kế trước UI

- Thiết kế đã có: [onboarding.html](../../mockups/onboarding.html), [unlock.html](../../mockups/unlock.html), [recovery.html](../../mockups/recovery.html), vault error states trong [states.html](../../mockups/states.html), re-auth handoff trong [auth.html](../../mockups/auth.html). State nào phát sinh thêm lúc implement thì bổ sung vào đúng file này rồi cập nhật §7.0 và mockups README.
- U3: passphrase strength/confirm → lưới 10 RK với download/print/copy + checkbox → optional passkey/remember device. Chỉ `POST /vault` sau bước xác nhận RK.
- U4: passphrase/passkey, nhớ thiết bị off, link quên passphrase; PRF unsupported/cancel/AEAD fail, recovery-key invalid và form passphrase mới là các trạng thái riêng.
- U7 theo [settings.html](../../mockups/settings.html) `#baomat`, `#passDlg`, `#rkDlg`, `#resetDlg`. Sửa copy RK: rewrap không làm bản in RK cũ vô hiệu; đổi "Thu hồi tất cả" thành flow rotate đủ 10 và lưu key mới. Không show bí mật key đã lưu trên server.
- U5 theo [index.html](../../mockups/index.html)/[item.html](../../mockups/item.html): lock chỉ để name/tag/type/list tiếp tục hiện. Production phải xoá dữ liệu trong memory/DOM/cache, không giữ bản plaintext trong `dataset.plain` như demo.

## Contract crypto bắt buộc

| Thành phần | Contract |
|---|---|
| KDF | libsodium Worker Argon2id 64 MiB, ops=3, p=1, salt 16 B; không fallback thấp hơn |
| VK/keypair | VK random 32 B; X25519 + Ed25519 lúc tạo vault, private blob wrapped bằng VK |
| Entry envelope | Đúng 5 field v1, JCS RFC 8785; AAD prefix/NUL/JCS/NUL/client UUID theo §5.5; không đổi protocol `sabk` |
| Entry ID | Client UUID v4 trước seal, được API giữ nguyên; `vault_key_id` lấy từ vault response trước tạo entry |
| RK | 16 B CSPRNG/key, format Crockford, lookup/wrap hash tách domain, wrap VK trực tiếp; không persist plaintext RK |
| PRF | Salt riêng 32 B/credential, UV required; create có thể cần follow-up get; nhiều credential dùng evalByCredential |
| DevKey | WebCrypto AES-GCM non-extractable + sealed VK trong IndexedDB, opt-in off; namespace theo user/key_id để không trộn account |
| Re-auth | Grant P02 + session/CSRF cho sensitive mutations; trạng thái client unlocked không phải proof server kiểm tra được |

**Trước khi viết crypto:** ADR mô tả byte layout của mọi wrap blob (version/nonce/tag/ciphertext/AAD), private-key serialization, RK canonical form và endianness/encoding nếu có. Chuẩn hoá RK đúng một lần dùng cho cả lookup/wrap; vector gồm hyphen/case/prefix/Crockford aliases và input invalid. Không để onboarding hash chuỗi hiển thị còn recovery hash chuỗi đã normalize khác nhau. Vectors kiểm thử bằng implementation/library chuẩn, không chỉ encrypt/decrypt bằng cùng code mới.

WebAuthn ADR/OpenAPI phải hoàn tất registration verification: challenge TTL/session binding/one-time, expected RP/origin đúng port dev, attestation/clientData/authenticatorData và pubkey extraction. Không nhận pubkey/aaguid do client tự khai rồi coi là credential đã verify để P07 login. PRF output chỉ ở client; server verify credential registration không đồng nghĩa server thấy PRF. Xác định route challenge tiếp cho credential vừa create trước khi persist final wrapper. Phase này không biến assertion unlock local thành login session.

## State, persistence và mutation

- State machine tối thiểu: `no_vault`, `onboarding`, `locked`, `unlocking`, `unlocked`, `recovering`, `rewrapping`, `resetting`, `error`. Chuyển state không giữ form secret trong history/router/query cache; task crypto hoàn tất sau lock phải bị loại theo session generation.
- Auto-lock: chọn 5/15/60 phút hoặc không bao giờ, trong đó "không bao giờ" là `auto_lock_minutes=0`; mặc định 15. Xoá VK/KEK/PWK trong Worker và plaintext cache/forms; callback decrypt cũ không đưa secret trở lại. JS không đảm bảo xoá mọi bản copy string khỏi heap: giảm lifetime/reference, không hứa memory zero tuyệt đối.
- Remembered device: interaction sau auto-lock được silent unlock, đúng chủ đích §5.6. Logout không xoá DevKey nhưng phải xoá VK/plaintext và yêu cầu account auth trước silent unlock; revoked session xoá IDB khi client nhận revoked. Offline/revoked client không thể bị server xoá IDB tức thì.
- Rewrap: mở VK → re-auth → KEK mới/salt mới → `PUT /vault/kek` + If-Match; version tăng, VK/key_id không đổi nên các RK/passkey/DevKey còn hiệu lực. Audit/in-app notice + email verified qua adapter P02, mail fail không rollback mutation.
- Recovery: lookup unused theo user → local unwrap → re-auth/new passphrase → complete atomic + If-Match + idempotency; chỉ một request consume được RK. Retry commit trả response gốc, không xoá thêm key hoặc rewrap lần nữa.
- Regenerate/rotate: cùng policy re-auth; lock/count trong transaction, max 10, slot thiếu có thể regenerate; rotate thay đủ 10 sau confirm lưu. Response không trả bí mật cũ.
- Passkey revoke chỉ xoá wrapper live; RK consume/rotate cũng không vô hiệu wrapper đã copy. UI/docs theo §5.9, không hứa backup cũ mất hiệu lực.
- Reset: re-auth và hướng dẫn thử mọi đường unlock/backup trước, cấp vault/key_id mới. P03 định nghĩa hook/policy reset; P04 hoàn tất transaction xoá mọi entry (kể cả soft-delete), giữ item/tag và làm count đúng.

## API và cấu trúc

Owner: mọi endpoint `/vault*` trong §9.2, version/idempotency middleware kết hợp P02, cùng đăng ký/rename/revoke passkey và audit notice. Bổ sung route rename passkey nếu UI giữ chức năng đó; thêm challenge registration verification vào OpenAPI trước handler.

Rate limit thuộc phase này theo §9.1: unlock và recovery **5 lần/15 phút/user**, passkey options **20/phút**. Đếm theo user chứ không theo IP để đổi mạng không né được; thông báo quá hạn không tiết lộ còn bao nhiêu RK chưa dùng hay passphrase có đúng một phần nào không.

Idempotency middleware (§9.1) do phase này chốt và P04 dùng lại: fingerprint gồm method + path + body, ghi cùng transaction với mutation, giữ 24 giờ. Gửi lại đúng key với payload khác trả `409`; retry vẫn cần session/CSRF hợp lệ nhưng **không** đòi một re-auth grant còn sống nếu grant ban đầu đã được tiêu thụ hợp lệ; mutation không bao giờ chạy lần hai.

File dự kiến: `apps/web/lib/crypto/{worker,envelope,wrap,recovery,device}*`, `features/vault/**`, `features/settings/security/**`, `apps/api/internal/vault/**`, `internal/db/queries/vault*.sql`, migrations vault/RK/passkey/idempotency, `docs/adr/**`, `docs/threat-model.md`.

## Acceptance

| ID | Kịch bản | Đạt khi |
|---|---|---|
| P03-A1 | Onboard 10 RK | 9/11/duplicate lookup rejected; chưa checkbox không POST; retry không tạo vault khác |
| P03-A2 | Envelope/AEAD | Vectors qua `jsonb`, đổi field order vẫn mở; field/ID sai hoặc thiếu ct_enc bị reject/fail |
| P03-A3 | Passphrase | Browser context mới unlock đúng, sai passphrase báo lỗi; KDF không hạ mem |
| P03-A4 | Recovery concurrent | Hai request cạnh tranh chỉ một consume; stale version/foreign RK bị reject; retry idempotent đúng |
| P03-A5 | Regenerate/rotate | Concurrent request không vượt 10; không có đường bỏ re-auth qua regenerate rồi recover |
| P03-B1 | PRF matrix | Create output trực tiếp, enabled-only rồi get, unsupported/cancel/missing result đều đúng; salt không trộn |
| P03-B2 | Credential verification | Challenge replay/sai session/RP/origin/pubkey metadata bị reject; có smoke test authenticator PRF thật trước beta |
| P03-B3 | DevKey | Off mặc định; remember/forget/account switch/reset/key_id đổi đúng; rewrap không xoá wrap thiết bị hợp lệ |
| P03-B4 | Quên passphrase | Unlock bằng passkey/DevKey/phiên VK → re-auth → đặt passphrase mới không biết passphrase cũ |
| P03-B5 | Lock lifecycle | Timer/manual lock/logout xoá cache/form secret, task decrypt cũ không hồi sinh body; name/tag còn hiện |
| P03-B6 | Backup semantics | Test fixture RK consumed/passkey revoked với wrapper cũ vẫn lấy VK nếu có secret/PRF; không claim cryptographic revocation |
| P03-B7 | UI | U3–U7 khớp mockup, state en/vi, keyboard/mobile/dark; không copy/screenshot RK thật vào evidence |
| P03-B8 | Rate limit unlock/recovery | Lần thứ 6 trong 15 phút bị chặn dù đổi IP/thiết bị; passkey options quá 20/phút bị chặn; thông báo không tiết lộ số RK còn lại hoặc passphrase đúng/sai một phần |
| P03-B9 | Idempotency | Cùng key + cùng body trả response gốc và không chạy lại mutation; cùng key + body khác trả `409`; bản ghi hết hạn sau 24 giờ; retry thiếu session/CSRF bị từ chối còn grant re-auth đã tiêu thụ thì không cần cấp lại |

## Gate và bàn giao

ADR + crypto vectors + review theo quy định hai người ở §11.4 là gate bắt buộc cho thay đổi crypto/envelope; không thay bằng tự review hoặc mock test. Thiếu môi trường PRF thật ghi rõ là chưa verify và P06 không được nhận là đã đạt.

P04 nhận API/Worker encrypt/decrypt lifecycle và fixture; P03/P04 cùng nghiệm thu reset/lock trên dữ liệu thật. Không nâng envelope version hoặc giảm KDF như workaround khi fail. Khi regression wrap xảy ra, dừng mutation key mới, giữ ciphertext/wrapper để điều tra; không tự reset vault người dùng.
