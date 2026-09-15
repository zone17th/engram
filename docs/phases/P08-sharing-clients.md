# P08 — Chia sẻ Item và client ngoài web

> Kế hoạch hậu MVP · Phụ thuộc: P06, cùng P07-A (sync/resync) và P07-B (key registry + rotate VK) của [P07](P07-personal-expansion.md) — không cần trọn P07.
> Ánh xạ: Phase 3 cũ của [SPEC](../SPEC.md); nguồn §5.3 (sealed box cho recipient) và §12.1 roadmap.

## Mục tiêu và giới hạn

User chia sẻ một Item read-only cho user khác mà không đưa VK toàn vault cho người nhận; có "shared with me", accept/revoke rõ nghĩa. Browser extension hỗ trợ quick-save trong cùng mô hình mã hoá, API token có scope cho integration.

Native mobile vẫn **conditional** sau khi web ổn định và có nhu cầu/nguồn lực; không tạo sẵn app iOS/Android chỉ để hoàn tất phase. Không thêm public plaintext link, collaborative editing hoặc chia sẻ writable nếu chưa đổi phạm vi sản phẩm.

## Mốc và thiết kế phải đóng

| Mốc | Đầu ra | ADR/mockup/OpenAPI trước code |
|---|---|---|
| P08-A — Sharing | Invite/accept/read/revoke Item, shared-with-me | Key distribution/recipient identity, metadata visibility, version/cutover/revoke semantics |
| P08-B — Extension | Quick-save/tìm lại từ extension, unlock flow rõ | Origin/RP/key custody và permission model; passkey web không tự dùng được trong extension origin |
| P08-C — API token | Tạo/list/revoke token scoped, tài liệu client E2E | Scopes/resource binding/expiry/rate limits; plaintext-body boundary |
| Conditional — Verifier/mobile | Verifier đáng tin và native app nếu scope được chọn | Trust anchor/update verification; platform/credential/key migration riêng |

Mockup mới cần có share dialog, recipient status, shared-with-me, revoked state, extension popup/options/unlock, token settings/revoke/copy-once; dùng token engram và bổ sung §7.0. Những phần crypto chưa có trong spec tổng thể phải được review trước code, không suy rằng X25519 sealed box tự giải quyết mọi quyền.

## P08-A — Sharing read-only

- Owner sinh `ShareKey_I` riêng cho Item, re-encrypt entries thuộc phạm vi chia sẻ bằng share key, sealed-box share key cho recipient X25519 pubkey theo §5.3. VK không rời browser và không được gửi recipient.
- Key registry P07 phân biệt `vk:` và `sk:`; owner cũng phải có wrap đọc được ShareKey sau khi đóng tab. Share/unshare/rotate VK không được làm owner mất access hoặc vô tình chia sẻ item khác.
- Chốt chính sách nhận dạng/xác thực public key: server directory cung cấp key chưa phải bằng chứng không bị thay key. ADR mô tả trust model, verification và chữ ký Ed25519 nếu dùng; không tuyên bố key authenticity chỉ dựa ciphertext sealed box.
- Metadata sharing phải có whitelist: name/hint/tag/type/time nào recipient thấy, tag là của owner hay copy local. Không expose toàn tag catalog, other items, account identity/secrets ngoài quyền được cấp.
- Invite/accept/revoke state machine transactional, session/user/role checks mọi route và blob/export/download. Recipient read-only không sửa/reorder/add/delete entry hoặc chuyển tiếp quyền owner qua API.
- Cập nhật entry sau share dùng đúng share key generation, phân phối membership/key version tương ứng; xử lý owner edit lúc migration/share pending bằng revision/If-Match và write gate.
- Revoke chặn server access ngay theo session/token cache policy và rotate share key cho **future/current ciphertext cần bảo vệ** theo ADR; recipient có key/ciphertext/plaintext cũ vẫn giữ được dữ liệu đó. Không hứa thu hồi kiến thức hay xoá file đã download.
- Owner xoá item/account, reset vault, rotate VK hoặc recipient mất account/key đều có policy rõ; migration/cancel không để item nửa share nửa inaccessible. Chia sẻ copy hay dataset chung phải chọn trong ADR; không để hai dạng song song vô tình.

## P08-B — Browser extension

- Extension quick-save lấy page title/URL/selection chỉ khi user chủ động, phân biệt metadata plaintext với entry body; encrypt client trước upload, không ghi clipboard/selection vào telemetry.
- Reuse parse/entry API/schema, duplicate-name picker, limits/idempotency và E2E module đã review. Không import script web động vào extension để né review/update policy.
- Chốt key custody: passkey RP web không tự gọi từ extension scheme; nếu dùng web handoff phải có origin/session binding, one-time channel và kiểm tra sender. Không chuyển VK qua URL, localStorage plaintext, wildcard postMessage hoặc content script.
- Permissions tối thiểu theo chức năng; content scripts không nhận vault-wide key. Unlock/lock/revoke session thực, không bê remembered-device demo vào extension.
- Extension verifier có thể là mốc riêng nhưng chưa được quảng cáo như bảo vệ supply-chain trước khi có trust anchor độc lập. Hash bundle được tải từ cùng server có thể phát JS độc không đủ làm verifier đáng tin.

## P08-C — API token

- Token random entropy cao, show secret một lần; server chỉ lưu hash/label/scope/expiry/last_used/revoked metadata. Re-auth account khi tạo/revoke; audit không chứa token.
- Scope có nghĩa rõ theo resource/action (ví dụ metadata read, entry ciphertext read/write trong phạm vi được cấp), ownership kiểm tra cả token lẫn request IDs. Không có scope ngầm biến read-only share thành owner write.
- Token không chứa VK và không phải phương thức unlock vault. Integration đọc body cần client-side E2E/key provisioning được user chủ động cấu hình; server không decrypt giúp.
- Docs/SDK sample create entry phải sinh UUID trước seal/JCS, giữ ciphertext qua retry; rate limit/quota vẫn áp dụng. Revoked/expired token không dùng được sau cache TTL công bố.

## Dữ liệu và API cần chốt

Share membership/invitation, share key generation/wraps, recipient access, export/blob access rules; extension auth handoff nếu chọn; API token metadata/hash/scope. Route/DTO/migrations cụ thể bổ sung vào OpenAPI và §8–§9 qua ADR của từng mốc. Các key/entry formats được versioned và giữ compatibility của MVP/P07; không silently reinterpret envelope v1.

File dự kiến: `internal/{share,keyring,token}/**`, `features/{sharing,shared-items,api-tokens}/**`, `apps/extension/**`, shared crypto/API package, migrations/jobs/fixtures và `docs/runbooks/share-revocation.md`. Native mobile chỉ thêm layout repo khi đã chọn platform/scope.

## Trình tự và acceptance

Thứ tự: threat model/ADR + mockup → share-key owner/recipient fixtures → membership/read-only APIs → UI/sync/revocation → extension auth/key custody → scoped tokens/SDK → review/compatibility/release.

| ID | Kịch bản | Đạt khi |
|---|---|---|
| P08-A1 | A share một item cho B | B đọc đúng item, không nhận VK hoặc item/tag catalog khác; owner vẫn mở sau reload |
| P08-A2 | Permission matrix | B/C không write/add/share/reorder/download ngoài quyền qua bất kỳ ID/endpoint nào |
| P08-A3 | Key authenticity | Key substitution/recipient mismatch và signature policy được test theo trust model đã chọn |
| P08-A4 | Revoke/update race | Server chặn recipient bị revoke; new-key ciphertext không dùng old share key; copy cũ vẫn có giới hạn đúng docs |
| P08-A5 | Lifecycle | Reset/delete/rotate owner, invite pending, partial migration, export/blob/sync không rò rỉ hoặc làm owner mất key |
| P08-B1 | Extension save | Auth/unlock → encrypt → duplicate picker → retry/save đúng; metadata/body boundary theo policy |
| P08-B2 | Extension origin | Content-script/wrong-origin messages không lấy được key; logout/revoke và permission handling đúng |
| P08-C1 | Token scope/revoke | Secret copy-once, hash-only DB, wrong resource/scope/expiry/revoked bị reject; audit không chứa secret |
| P08-C2 | SDK E2E | Client sample encrypt/decrypt tương thích vectors cũ; token không được server dùng để decrypt |
| P08-D1 | Regression/release | Crypto/security review theo repo, cross-user/device tests và rollback có evidence; MVP/P07 vẫn đọc dữ liệu cũ |

Phase Done khi A–C đạt; conditional verifier/mobile chỉ là Done nếu đã được đưa vào phạm vi và có nghiệm thu riêng. Public release không được mô tả read-only/revoke như cơ chế ngăn recipient copy dữ liệu từng đọc được.
