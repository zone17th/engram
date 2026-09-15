# P07 — Mở rộng sử dụng cá nhân

> Kế hoạch hậu MVP · Phụ thuộc: [P06](P06-beta.md).
> Ánh xạ: Phase 2 cũ của [SPEC](../SPEC.md) §12; tham chiếu §5.6, §3.11, §6.1.

## Mục tiêu và trạng thái contract

Vault dùng được lâu dài với khả năng đổi VK an toàn, mang dữ liệu backup trở lại, đồng bộ qua nhiều thiết bị, tìm trong nội dung đã decrypt và lưu các kiểu dữ liệu mới. Đây không phải điều kiện để phát hành MVP.

Spec tổng thể mới định hướng các tính năng này, chưa có đầy đủ schema/API/mockup. Các invariant/acceptance dưới đây là bắt buộc; hoàn thành ADR/OpenAPI/mockup ở từng mốc trước khi implement, không coi chi tiết chưa chốt là quyết định đã được user xác nhận.

## Thứ tự mốc

| Mốc | Phạm vi bắt buộc | Phụ thuộc bên trong |
|---|---|---|
| P07-A | Durable changes/resync và live update | CRUD/delta MVP P04 |
| P07-B | Key registry + rotate VK | P07-A cho stale writer/resume và P03 crypto |
| P07-C | Import encrypted backup/decrypted archive | Export P06; dùng registry P07-B khi chạm key migration |
| P07-D | Client-side body search | P07-A + lock/crypto lifecycle |
| P07-E | `link`, `file`, `image` | Key registry P07-B + storage/limits ADR |
| P07-F | Login-with-passkey | Verified credential P03; independent với media/body search |

Merge tag khi rename collision đi cùng P07-C hoặc sau đó; move entry, JSON Schema, RLS rollout và ConnectRPC là **conditional**, ghi rõ chọn làm/bỏ trước khi đưa vào gate. UI sessions đã có ở P02; P07 không làm lại auth/session management từ đầu. App vẫn online-only, không tự thêm offline write queue/PWA.

## Quyết định phải đóng trước từng mốc

| Mốc | Deliverable trước code | Điều kiện lựa chọn |
|---|---|---|
| A | ADR cursor ordering, retention, pagination, resync; OpenAPI changes/SSE | Không mất event khi transaction commit khác thứ tự sequence/timestamp |
| B | ADR key registry/wrapped-key layout, write cutover, crash recovery và ciphertext migration | Có thể resume sau tab/browser đóng; không khoá vĩnh viễn vault nếu batch dở |
| C | Schema import/export version/mapping/idempotency, merge policy, limits | Body raw JSON được giữ, không resurrect RK/passkey wrapper cũ |
| D | Browser memory/index budget, coverage và refresh policy | Không claim search toàn vault khi chỉ load/decrypt một phần |
| E | Blob storage/upload protocol, byte/quota limits, chunk crypto/version, MIME/preview policy | 256 KiB/entry của MVP không tự biến thành giới hạn file; công bố trần mới trước dùng |
| F | WebAuthn login options/verify session policy, supported device list | Credential cũ phải verified; discoverable thực sự, không suy từ residentKey preferred |

Mỗi mốc có mockup mới trong `mockups/` và cập nhật §7.0: sync/conflict indicator, rotate progress/recovery, import wizard, body-search coverage, attachment upload/preview, login passkey. Không sửa visual language hiện tại khi thêm màn.

## P07-A — Đồng bộ và resync

- Có durable cursor/token thay timestamp đơn thuần; semantic cursor không phải UUID hay đồng hồ client. Chốt ordering theo commit/publication sao cho không skip transaction commit muộn.
- Changes gồm create/update/delete, reorder, tag membership và reset/key generation; tombstone retention có thời hạn công bố. Cursor hết hạn trả resync-required, không trả empty như đã up-to-date.
- SSE chỉ báo thay đổi/ciphertext metadata được phép, không body plaintext; client pull canonical state, reconnect/resume/dedup. Session expire/locked state không làm lộ body.
- Conflict vẫn dựa revision/If-Match, không collaborative merge tự động. Trong sync nhiều tab/account, cache key và cancellation gắn account/vault generation.

## P07-B — Rotate VK

- Tạo VK/key_id mới và registry trạng thái old/active/migrating; encryption envelope version mới chỉ khi ADR yêu cầu. Giữ khả năng đọc ciphertext old trong thời gian migrate, mọi job/batch có idempotent progress và concurrency ownership.
- Chốt điểm chuyển writer, reject device/request cũ ghi ciphertext key_id cũ sau cutover. Finalize chỉ khi mọi ciphertext thuộc phạm vi giữ lại đã migrate/được xử lý theo retention policy, gồm soft-deleted entry; kiểm tra cả blob nếu E đã triển khai.
- Resume không phụ thuộc VK chỉ tồn tại trong một tab đã đóng: lưu recovery metadata/wrapped migration keys được client mở bằng unlock method hợp lệ; server không có plaintext VK. Crash trước/sau wrap commit, giữa batch và finalize đều có đường tiếp tục hoặc rollback rõ.
- RK cũ không thể rewrap sang VK mới nếu không còn plaintext RK: sinh đủ 10 RK mới, hiện/xác nhận trước cutover. Passkey cần PRF lại để tạo wrapper mới; credential không thực hiện được PRF trong migration phải được đánh dấu/revoke khỏi bộ unlock mới theo flow đã công bố. DevKey thiết bị khác không tự được rewrap từ server.
- Old backup/ciphertext vẫn mở bằng VK cũ; rotate không thu hồi dữ liệu attacker đã đọc/copy. Không hứa remote wipe những device đã biết old key.

## P07-C — Import và tổ chức dữ liệu

- Nhận encrypted `.sabk.json` version hỗ trợ hoặc decrypted archive; phân biệt với paste/file JSON thành một entry đã có P04.
- Client validate manifest/limits, unlock snapshot bằng bí mật tương ứng, decrypt body rồi encrypt vào vault đích. Không copy RK/passkey wrappers snapshot vào live vault.
- New target vault onboard keys mới; existing target giữ unlock set hiện tại. ID remap kéo theo AAD/envelope mới, item_tag/entry relation remap nhất quán. Tag normalize conflict dùng merge mapping rõ, name trùng vẫn hợp lệ.
- Import có preview counts/conflicts/deleted-data policy, progress/cancel/resume/idempotency. Batch đã commit không âm thầm mất khi retry; rollback chỉ xóa tài nguyên import tạo ra còn không bị người dùng sửa.
- Merge tag có confirmation/transaction/ownership/counter correctness; move entry chỉ khi được chọn, phải cập nhật ownership/relations và AAD theo schema đang active, không giả định metadata có thể thay tuỳ ý.

## P07-D/E/F — Tìm body, media và passkey login

- **Body search:** MiniSearch/FlexSearch hoặc tương đương trong Worker với plaintext đã decrypt; index memory-only, xoá khi lock/logout/account switch/reset. UI nêu coverage loading/partial/full, có cancel/budget; query body không gửi server hay TEI. Thay đổi item/entry cập nhật index theo durable changes.
- **Media:** server chỉ giữ encrypted blob + metadata được công bố; client chunk encrypt và verify, upload retry/resume, quota/cancel/orphan cleanup. Preview chỉ local object URL sau decrypt, revoke khi lock; không server thumbnail/OCR/unfurl body plaintext. Link unfurl client chịu CORS: fallback render URL, không thêm proxy bên server đọc URL bí mật như workaround.
- **Passkey login:** server verify WebAuthn assertion để cấp cookie; PRF unwrap VK là bước client tách biệt. Không PRF sau login vẫn chỉ đăng nhập account và yêu cầu phương thức unlock khác; không biến login assertion thành key giải mã. Credential không discoverable cần đăng ký lại/flow account-assisted đã định nghĩa, không hứa mọi passkey MVP login không cần account hint.
- **Conditional hardening:** RLS cần test pool/SET LOCAL/reset context và mọi background job; ConnectRPC chỉ đổi transport khi có nhu cầu đã chốt, không phá REST client đang dùng.

## API/file dự kiến

API/schema mới: changes cursor/SSE, key registry/rotation operation, import operation+mapping, encrypted blob upload/download/cleanup, WebAuthn auth options/verify. Các tên path/field cụ thể phải được chốt trong OpenAPI theo bảng quyết định, không coi bảng này là API đã triển khai.

Modules: `features/{sync,key-rotation,import,content-search,attachment}/**`, `lib/crypto/**`, `internal/{changes,rotation,import,blob,auth}/**`, jobs/storage adapters, migrations, ADR/fixtures/runbooks. Reuse export parser và cryptographic contract; không viết parser JSON thứ hai làm mất raw body.

## Acceptance

| ID | Kịch bản | Đạt khi |
|---|---|---|
| P07-A1 | Sync race/reconnect | Không mất event khi commits đảo thứ tự, cursor page/replay dedup; expired cursor yêu cầu resync |
| P07-A2 | Delete/reset multi-device | Tombstone, reorder/tag change và key reset tới đúng user/device; stale edit có conflict |
| P07-B1 | Rotation crash matrix | Resume từ trước wrap commit/giữa batch/trước finalize/sau finalize; không mất key hay ciphertext |
| P07-B2 | Writer/key policy | Writer old key bị reject sau cutover; remaining RK/passkey/DevKey status đúng; đủ 10 RK mới |
| P07-B3 | Old backup | Old key không mở new ciphertext; vẫn mở old snapshot, docs mô tả đúng giới hạn |
| P07-C1 | Import fixtures | ID/AAD remap đúng, duplicates/large JSON giữ raw text, wrappers cũ không live lại |
| P07-C2 | Retry/cancel | Không trùng dữ liệu qua retry/resume; merge tag/counters/limits đúng |
| P07-D1 | Body-search privacy | Index/query chỉ client; lock dọn index/results; coverage không nói full khi partial |
| P07-E1 | Blob lifecycle | Tamper/partial upload/retry/quota/cancel/orphan cleanup và decrypt preview đúng; không plaintext server |
| P07-F1 | Passkey auth | Assertion replay/wrong RP/user verification/counter-policy failure bị xử lý; login và unwrap failure tách biệt |
| P07-G1 | Regression | MVP export/recovery/JSON/search vẫn pass; migration/rollback không phá clients được hỗ trợ |

## Gate và bàn giao

P07 chỉ Done khi các mốc bắt buộc A–F có evidence và ADR/mockup/OpenAPI đã đồng bộ. Native mobile/JSON Schema/move entry không tự thành điều kiện bắt buộc. P08 nhận key registry và sync contract ổn định; có thể thiết kế sharing trước khi media xong nhưng không phát hành chia sẻ nếu key lifecycle chưa nghiệm thu.
