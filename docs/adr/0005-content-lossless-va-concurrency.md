# ADR 0005 — Content P04: JSON lossless, concurrency theo version và ranh giới gửi

- Trạng thái: đề xuất (owner đã cho đi theo đề xuất Q1–Q19 qua user-dec-015, Advisor ghi ở advisor-dec-078; owner đọc lại trong PR Task 1)
- Ngày: 2026-11-01
- Phase: P04 (item, tag, entry text/JSON); P05–P07 kế thừa
- Nguồn: [plan P04](../plans/2026-11-01-P04-content.md) mục 1–3 và mục 9 (Q1–Q19), [phase doc P04](../phases/P04-content.md), [SPEC](../SPEC.md) §2–§3, §5.5, §7, §8–§9, [ADR 0002](0002-vault-crypto-layout.md) (envelope, AAD), [threat model](../threat-model.md)
- Thay thế một phần: SPEC §3.7 `If-Match: updated_at`, §9.2 `PUT /items/{id}/tags`, §9.1 danh sách route có `Idempotency-Key`, §4.3 `jsonc-parser` + virtualize, §5.5 câu "giảm rò rỉ size", §3.6 `filename`
- Không đổi crypto: envelope v1, AAD, `lib/crypto/**`, `internal/vault/{envelope,wrap,kdf}.go` giữ nguyên (gate crypto plan mục 5)

## Bối cảnh

P04 là phase đầu tiên dữ liệu thật đi suốt auth → vault → CRUD → render. Phase doc đòi bốn thứ mà SPEC v0.7 chưa chốt đủ để code: JSON lưu và sửa không mất byte, nhiều thiết bị sửa cùng entry mà không đè nhau, quick-add nhiều bước retry được mà không tạo bản sao, và xoá có Undo mà không resurrect dữ liệu cũ. Bất biến của chủ repo (user-dec-016): kẻ chiếm hoàn toàn server vẫn không giải mã được thân entry nếu thiếu bí mật phía người dùng; chỉ thân entry là bí mật, `name`/`hint`/tag/`type`/thời điểm/số lượng/độ dài là plaintext. Nguyên tắc UX (user-dec-015): ít bước, ít màn, mặc định hợp lý, không đổi lấy việc nới zero-knowledge.

ADR này ghi các quyết định kiến trúc xuyên nhiều task để lane sau (content-core, itemtag, entryapi, jsonlib, contentclient, itempage, home, sync) không phải tự suy.

## Quyết định

### 1. JSON: text gốc là nguồn, cây cú pháp có source span

- Nguồn sự thật của entry `json` là **chuỗi UTF-8 gốc** sau khi giải mã. Parser strict riêng `apps/web/lib/json` (không dependency `jsonc-parser`, không thêm npm — Q10) dựng cây cú pháp giữ **source span** của mọi token: offset theo **UTF-16 code unit** của chuỗi hiện tại (đúng đơn vị của `String` trong JS), không dùng offset byte.
- **Occurrence identity:** mỗi property có định danh theo vị trí xuất hiện trong object (thứ tự gốc), không theo key. Object có key trùng hiện đủ từng occurrence; sửa một ô chỉ đụng đúng occurrence đó. Key dạng số nguyên giữ thứ tự nguồn (không theo thứ tự liệt kê của JS object).
- **Lexeme số:** ô số đọc lexeme từ text (`9007199254740993`, `1e400`, `-0` giữ nguyên); giá trị mới validate bằng grammar JSON number và ghi đúng lexeme người dùng gõ. Không đi qua `Number`.
- **Sửa = splice:** sửa ô/thêm/xoá tạo text edit `{offset, length, content}` trên revision hiện tại, áp splice, rồi parse strict lại và dựng span mới; không áp span cũ lên revision mới, không `JSON.stringify` cả document. Byte ngoài span sửa giữ nguyên. "Định dạng" là tuỳ chọn tường minh, chỉ đổi whitespace ngoài string.
- Parser chạy trên main thread trong memory của card; plaintext không ra khỏi tab. Mảng lớn: trang 50 hàng, mở nút con lazy, không virtualize.
- Server không parse JSON; `type=json` chỉ chọn renderer sau khi giải mã.

### 2. Xuống dòng (EOL)

`textarea` luôn trả `\n`, nên `.value` không phải nguồn sự thật. Khi mở editor, ghi nhận kiểu EOL của nguồn (LF, CRLF, hỗn hợp, CR lẻ). Lưu: `.value` sau chuẩn hoá bằng nguồn sau chuẩn hoá → không có thay đổi, không `PUT`; khác → nguồn thuần LF hoặc thuần CRLF thì đổi `\n` về đúng kiểu đó (byte-exact cho phần không sửa); nguồn hỗn hợp/CR lẻ → cảnh báo "sẽ đổi về kiểu chiếm đa số" trước khi cho lưu (hoà → kiểu của lần xuống dòng đầu tiên). Sửa qua bảng JSON không đi qua `textarea` nên luôn byte-exact; ô string chứa `\r` chỉ đọc trong bảng.

Lời hứa byte: import bằng **file** giữ nguyên byte UTF-8 của file sau khi bỏ đúng một BOM (Q8) — đường byte-exact được hứa; import bằng **dán** giữ đúng chuỗi `text/plain` mà trình duyệt trả về, không hứa gì về byte CR trước khi qua trình duyệt; entry tạo từ quick-add lưu xuống dòng LF.

### 3. Concurrency: `If-Match` theo `version`, không theo `updated_at` (Q1, Q2)

- `entry.version` và `item.version` (`int NOT NULL DEFAULT 1`). `PUT /entries/{id}` và `PATCH /items/{id}` bắt buộc `If-Match: "<version>"`; parser riêng `httpx.ParseVersionIfMatch` trên phần chung `RequireIfMatch`, không đụng parser vault. Thiếu/`*`/weak/danh sách/sai dạng → `428`; handler khoá hàng rồi so: không có → `404` (ưu tiên hơn `412`), lệch → `412 version_mismatch` + `current_version`.
- `entry.version` chỉ tăng khi **body** đổi; reorder/xoá/restore đổi `updated_at` nhưng không tăng version, nên reorder ở thiết bị A không làm thiết bị B đang sửa nhận 412 giả. `item.version` tăng khi `name`/`hint` đổi; gán/gỡ tag không tăng (thao tác cộng dồn).
- Lý do bỏ `updated_at`: timestamp không phải validator đáng tin (độ chính xác khi serialize, hai thay đổi trong cùng micro-giây, reorder đổi `updated_at`).
- Không last-write-wins: client chỉ ghi đè khi người dùng chọn "Giữ bản của tôi" (seal lại với nonce mới, `If-Match` mới, `Idempotency-Key` mới). Conflict chỉ có "Tải bản mới" / "Giữ bản của tôi" / "Chép bản của tôi", không màn so sánh (Q11). Mỗi entry chỉ có một lần lưu chưa rõ kết quả; `PATCH` item tuần tự theo hàng đợi, nên client không bao giờ tự gây 412.

### 4. Idempotency-Key cho mọi mutation content (Q4)

Mọi route ghi `/items*`, `/tags*`, `/entries*` bắt buộc `Idempotency-Key` và đi qua `ChainIdempotencyMiddleware` của P03 (fingerprint `method + concrete path + body`, giữ 24 giờ). Lý do: `PUT` có If-Match, nếu mất response mà retry không có idempotency thì bản ghi của chính mình trả 412; delete/restore/reorder/assign retry cũng phải trả đúng response gốc. Một quy tắc cho mọi mutation → client có đúng một helper (`contentMutate`) serialize body một lần và giữ byte + key qua retry. Rate limit `content_write` 10/giây/user chạy sau lookup (replay không bị đếm). Trần body content chặn **trước** lookup (entry 400 KiB → `413 entry_too_large`, item/tag 16 KiB → `413 invalid_request`) bằng `IdempotencyRouteConfig.BodyLimit`, vì lookup của P03 đọc tới 512 KiB.

### 5. Kiểm `key_id` dưới `vault FOR SHARE`

Route ghi ciphertext mới (tạo, import, `PUT` entry) lấy `SELECT vault_key_id FROM vault WHERE user_id=$u FOR SHARE` trước mọi khoá khác: không có vault → `404 vault_absent`; `envelope.key_id ≠ vault_key_id` → `409 entry_key_mismatch`. Reset vault khoá `vault FOR UPDATE` rồi mới xoá entry, nên request ghi cũ bay song song hoặc chạy sau reset luôn bị chặn ("stale writes fail", P04-A9). Validator P03 cho phép dạng `sk:` (P08) nhưng MVP từ chối vì không bằng `vault_key_id`. Server không giải mã, không suy ra body; kiểm là trên envelope/ciphertext/metadata.

### 6. Khoá nội dung theo user và thứ tự khoá

Mọi transaction ghi content, reset hook và job purge lấy `pg_advisory_xact_lock(hashtext('engram.content'), hashtext(user_id::text))` (helper `LockUserContent`). Chỉ một transaction ghi content của một user chạy tại một thời điểm, nên trần 20 tag/200 entry, counter, upsert tag, restore và reorder không đua; unique index vẫn là lưới an toàn (`23505` → `503 dependency_unavailable`, không 500). Thứ tự khoá toàn cục: (1) `vault` (`FOR SHARE` cho ghi ciphertext, `FOR UPDATE` cho reset) → (2) khoá nội dung → (3) `item` theo `id` tăng → (4) `tag` theo `id` tăng → (5) `entry`. Không transaction nào lấy khoá vault sau (2). `40P01`/`55P03` → `503` + `Retry-After: 1`, claim được release. Chi phí: ghi cùng user bị tuần tự hoá; p95 burst đo ở Task 21b, vượt trần → `decision_required`, không nới trần.

### 7. Provenance xoá, restore và purge

- Xoá item sinh `delete_batch`; item và mọi entry **sống** của nó nhận cùng batch với `entry.deleted_via='item'`; `item_tag` giữ nguyên. Xoá entry riêng: `deleted_via='entry'`. CHECK `(deleted_at IS NULL) = (deleted_via IS NULL)`.
- Restore item chỉ khôi phục entry `deleted_via='item' AND delete_batch = item.delete_batch`; entry user đã xoá riêng trước đó không sống lại (A8). Restore entry xoá theo item → `409 entry_restore_via_item`. Restore tôn trọng trần 20/200 và không restore một phần.
- `tag.item_count` đếm item sống gắn tag kể cả khi tag đã soft-delete, nên restore tag không phải tính lại. `position` mới tính trên mọi hàng kể cả tombstone, nên restore không trùng vị trí.
- Purge (`content_purge`, mỗi giờ, lô 500, cutoff 30 ngày do job truyền) xoá vĩnh viễn entry, item (cascade) và tag (cascade `item_tag`), mỗi lô dưới khoá nội dung của user.
- Undo UI (Q9, Q10): xoá không có hộp xác nhận; toast Undo 5 giây (10 giây sau thao tác bàn phím), dừng khi hover/focus, xếp chồng, `Ctrl+Z`/`⌘Z`. Không màn thùng rác; API restore vẫn dùng được 30 ngày.

### 8. Gán tag cộng dồn, bỏ `PUT /items/{id}/tags` (Q3)

`POST /items/{id}/tags {tag_ids}` chỉ thêm cặp chưa có (`ON CONFLICT DO NOTHING`), kiểm mọi tag sống cùng user (sai → `404` cả request, không ghi gì) và tổng tag sống ≤ 20 sau hợp. `DELETE /items/{id}/tags/{tag_id}` gỡ một cặp. `PUT` thay cả bộ là ghi đè snapshot — đúng điều phase doc cấm (thiết bị khác vừa thêm tag sẽ mất) — nên bị bỏ khỏi MVP. `POST /tags` upsert theo `normalized` trong số tag sống (có → `200`, chưa → `201`).

### 9. Quick-add nhiều mutation, ID client, Undo chỉ xoá entry (Q18)

Quick-add là một **kế hoạch** trong memory của phiên: `itemId` (UUID client nếu tạo mới), các tag cần upsert, `entryId`, ciphertext seal **một lần**, và một `Idempotency-Key` sinh trước cho từng bước. Chạy tuần tự `POST /items {id}` → `POST /tags` → `POST /items/{id}/tags` → `POST /items/{id}/entries`; lỗi giữ draft + kế hoạch, "Thử lại" chạy tiếp từ bước lỗi với đúng key/byte cũ, nên timeout ở bất kỳ bước nào không tạo bản sao (A3). Chỉ response từ handler hoặc replay mới chốt kết quả một bước; `401`/`403` do session/CSRF trả trước idempotency lookup không chứng minh lần gửi trước (mất response) đã thất bại, nên với `access_expired`, `csrf_invalid` và `unauthenticated` đã phục hồi bằng refresh có điều kiện (khôi phục được trong phiên) client giữ ID, byte và key rồi gửi lại đúng request trước khi dựng kế hoạch mới. `unauthenticated` không refresh được, `session_invalid`, `forbidden` chỉ khôi phục bằng đăng nhập lại, tức ranh giới logout: kế hoạch bị bỏ, không replay, UI báo lần lưu trước vào mục đó chưa xác nhận, chỉ cho đúng `user_id` đã lưu (đổi user, đăng xuất chủ động, đóng hay tải lại trang thì xoá; SPEC §3.4, §3.7). Lock/logout/đổi user/reset vẫn bỏ kế hoạch. `POST /items` với `id` đã có và request khác → `409 item_id_conflict`. Toast "Đã lưu" chỉ hiện sau khi entry commit.

Undo quick-add **chỉ** `DELETE /entries/{entryId}`. Mục, tag và cặp gán mà kế hoạch đã tạo là metadata dùng chung mà thiết bị khác có thể đã đổi tên, gắn thêm tag hay thêm entry trong lúc đó; server không chứng minh được "chưa ai đụng tới" nếu không thêm cơ chế phiên bản riêng. Toast nói rõ phạm vi; mục rỗng xoá tay được. Lock/logout/reset/đổi `vault_key_id` bỏ kế hoạch và draft; không gửi lại ciphertext cũ sau unlock (Q15).

### 10. Ranh giới gửi của omnibox (Q17, advisor-dec-098)

Chuỗi đang gõ chưa phân loại có thể là body tương lai (dán body trước, gõ `name:` sau), và huỷ request không rút lại được dữ liệu đã gửi. Vì vậy ranh giới đặt **trước khi gửi**: ô omnibox **không gửi gì trước Enter** ở mọi chế độ. Add mode cũng vậy (advisor-dec-098): chuỗi dán vào như `root:hunter2` đã là add mode, nên lookup theo debounce sẽ gửi phần trước `:` — một mảnh body — trước khi người dùng xác nhận. Lookup tên (`GET /items/lookup?name=`, chỉ phần name) chạy khi Enter; trước Enter, preview chỉ dựng từ name và tag parse cục bộ; name không hợp lệ hoặc > 200 rune thì không gửi. Picker vốn cần kết quả lookup ở Enter nên luồng không thêm bước. Tìm kiếm chỉ gửi khi người dùng nhấn Enter, chỉ input một dòng ≤ 200 rune, có dòng báo "chữ đã gõ gửi tới máy chủ, không mã hoá", kết quả hiện dưới ô và không vào URL/history. Lọc tag (`#…`) chạy phía client trên cache; chỉ gửi `GET /tags?q=` khi không có trong cache. Server từ chối `q`/`name` > 200 rune. Gợi ý theo phím của P05 phải giữ ranh giới này.

**Cập nhật P05 (advisor-dec-244, thay advisor-dec-115 chỉ cho P05, có hiệu lực từ Task 17; bổ sung, không viết lại các đoạn trên):** P05 gửi gợi ý theo từng phím, nhưng **chỉ chuỗi chắc chắn do người dùng gõ ở chế độ tìm**. Ranh giới vẫn đặt **trước khi gửi**; thứ đổi là điều kiện để một chuỗi được coi là "chắc chắn gõ tay". Quy tắc đầy đủ ở [SPEC](../SPEC.md) §3.4–§3.5 (plan P05 mục 2.1); tóm tắt ràng buộc:

- **Chỉ gõ — quy tắc taint (L2).** Draft **tainted** (quay về hành vi P04: không request trước Enter) tới khi ô rỗng khi: một sự kiện input ngoài composition chèn > 1 grapheme (chip clipboard, chạm gợi ý bàn phím, text replacement, dictation); `inputType` ngoài allowlist (`insertText`, các biến thể composition và `delete*` — dán, thả, undo/redo, autofill đều ngoài); thiếu `inputType`; giá trị đổi bằng code không qua omnibox. Ghi của chính omnibox đi qua `setDraft()` nên không taint. Khi tainted, help text đổi tạm thành câu chung "Nhấn Enter để tìm" — không banner.
- **IME (L3).** Không gửi khi đang composing; sau `compositionend`, chữ đã commit tính là gõ (một commit > 64 grapheme thì taint) và debounce 120 ms bắt đầu lại, nên chuỗi Telex trung gian không rời trình duyệt.
- **Khoá dấu hai chấm (L1; phán quyết Advisor FE-1 = advisor-dec-244).** `:` hoặc `：` (U+FF1A) ở **bất kỳ đâu** — mọi chế độ kể cả `#` và `://` — khoá gửi tới khi ô rỗng; add mode cũng khoá tới khi ô rỗng và lookup tên ở add mode vẫn Enter-only (advisor-dec-098 giữ nguyên). Đây là điều kiện chặn merge: `#home:secretbody`, `#home secret:x`, `name: body`, `wifi： mật khẩu`, `http://x`, văn bản dán không được tạo request `/suggest`/`/search` mang chữ sau `:` hay chữ đã dán.
- **Hình dạng được gửi:** một dòng ≤ 200 rune; ở chế độ `#` chỉ token giữa `#` và khoảng trắng/`:` đầu (≤ 50 rune, `scope=tag`) và chỉ khi draft chưa có `:`; debounce 120 ms, `semantic=0`/`1` bắn song song. Câu "chữ gõ để tìm được gửi tới máy chủ, không mã hoá" chỉ ở help text tìm kiếm (không banner, UX tối giản).
- **Rủi ro còn lại (threat model C-4):** người dùng **gõ tay** từng ký tự một bí mật một dòng không có dấu hai chấm ở chế độ tìm thì từng tiền tố được gửi (kể cả gõ body rồi quay về đầu gõ `tên:`); bàn phím đẩy chip clipboard/gợi ý qua composing text (Android Gboard, ≤ 64 grapheme) được tính là gõ. Chấp nhận để đổi lấy gợi ý theo phím vì `name`/`hint`/`tag.display` vốn là plaintext theo thiết kế (user-dec-016); body entry không bao giờ vào đường này.

Dòng "Tìm kiếm theo từng phím, huỷ khi thành add mode" ở bảng **Phương án đã loại** cũ vẫn đúng cho phương án đó (huỷ sau khi gửi); P05 không dùng nó mà dùng cơ chế gửi-có-điều-kiện ở trên.

### 11. Feed thay đổi: watermark, overlap 120 giây là heuristic, refetch bắt buộc

`GET /entries/changes?since&cursor&limit` trả thay đổi gồm tombstone, sắp `(updated_at, id)`, cursor keyset trên đúng cặp đó, kèm `watermark` = `clock_timestamp()` ở đầu chuỗi trang. Client lưu watermark chỉ sau khi đọc hết trang cuối, lần sau gửi `since = watermark − 120 s` rồi dedup theo `(id, updated_at)`. Overlap chỉ là heuristic giảm bỏ sót, **không** phải bảo đảm: P03 không có hạn tổng cho transaction, một transaction giữ lâu có thể commit hàng có `updated_at` cũ hơn vùng overlap. Bảo đảm hội tụ đến từ quy tắc bắt buộc: **mỗi lần** client thức dậy (focus, reconnect, visible) đều refetch nguồn chuẩn (metadata entry của item đang mở, list item/tag đang hiện). `since` cũ hơn 29 ngày (tombstone có thể đã purge sau 30 ngày) → `410 changes_window_expired`, client bỏ watermark và refetch toàn bộ. Client chưa có watermark (thiết bị mới, sau `410`) gọi feed không có `since` để nhận watermark mà không quét bảng; Thứ tự bootstrap: lấy watermark trước, rồi refetch nguồn chuẩn; chỉ lưu watermark sau khi refetch xong (thay đổi chen giữa hai bước nằm sau watermark nên lần feed kế tiếp thấy). Đây là "best effort delta"; cursor bền và SSE là P07-A.

### 12. Kích thước: bucket là metadata làm tròn, ciphertext vẫn lộ độ dài (Q11)

`plaintext_len_bucket` là bội số 256 (`256…262144`) và server kiểm nó bằng đúng `ceil((octet_length(ciphertext) − 16) / 256) × 256`, để client không đặt metadata sai. Bucket **không** che kích thước: envelope v1 không padding nên `octet_length(ciphertext) − 16` là độ dài plaintext chính xác (threat model P-1, L-9). P04 giữ nguyên envelope, sửa SPEC §5.5/§10.4 và copy riêng tư để không hứa che kích thước. Padding là envelope v2, xét ở P07 qua gate crypto.

### 13. Không field plaintext mới

P04 không thêm field plaintext nào ngoài danh sách SPEC (`name`, `hint`, tag, `type`, bucket, thời điểm, số lượng): entry không có tiêu đề (Q19), import không có `filename` (Q7), audit import chỉ có `import_source ∈ {paste, file}` qua allowlist của sanitizer. Plaintext body chỉ ở Worker lúc seal/open, cache `vaultBodyQueryKey`, state card/editor đang mở, DOM text node đang hiển thị và ô đang sửa có `data-vault-secret`; không ở thuộc tính DOM (kể cả `href` — lý do bỏ autolink), URL, storage, `MutationCache` hay cache khác.

## Phương án đã loại

| Phương án | Lý do loại |
|---|---|
| `If-Match: updated_at` (SPEC §3.7 cũ) | Không phải validator chắc chắn; reorder gây 412 giả (Q1) |
| Last-write-wins cho tên/hint item | Mất sửa đổi âm thầm (Q2) |
| `PUT /items/{id}/tags` thay cả bộ | Ghi đè snapshot của thiết bị khác (Q3) |
| `Idempotency-Key` chỉ cho `POST` tạo | Retry `PUT`/delete/restore mất response trả sai (Q4) |
| Tìm kiếm theo từng phím, huỷ khi thành add mode | Body tương lai đã rời client trước khi huỷ (Q17) |
| Undo quick-add dọn cả mục/tag vừa tạo nếu rỗng | Server không chứng minh được thiết bị khác chưa dùng (Q18) |
| Padding envelope để che độ dài | Đổi crypto (gate), để P07 (Q11) |
| `jsonc-parser` + thư viện virtualize | Dependency mới; parser riêng kiểm được strict/occurrence/lexeme (Q10) |

## Hệ quả

- Task 2: cột `version`, `deleted_via`, `delete_batch`, index và CHECK mới (SPEC §8). Task 3b: `BodyLimit`, `ParseVersionIfMatch`, scope `content_write`, `LockUserContent`. Task 4–8: handler theo mục 3–7 ở trên. Task 11: một helper `contentMutate`. Task 12: parser/edit engine `lib/json`. Task 18: ranh giới gửi.
- Client có ba nút conflict thay vì màn so sánh; người dùng tự gộp qua clipboard.
- Ghi cùng user tuần tự hoá; cần đo p95 burst (Task 21b).
- Feed không bền; mọi client bắt buộc refetch khi thức dậy.
- Threat model bổ sung: request ghi cũ sau reset bị chặn bằng `key_id`; feed không bền; omnibox không gửi gì trước Enter (kể cả lookup add mode); clipboard sau "Chép".
- Preview add mode không biết trước số mục trùng tên; người dùng biết khi Enter (0/1 → lưu, nhiều → picker). Đây là giá của ranh giới gửi (advisor-dec-098).
