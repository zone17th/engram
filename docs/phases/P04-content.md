# P04 — Item, tag, text và JSON lossless

> Kế hoạch · MVP 4/6 · Phụ thuộc: [P03](P03-vault.md), shell P01.
> Nguồn: [SPEC](../SPEC.md) §2, §3.4–§3.8, §7.2–§7.5, §8–§9, §11.3.

## Mục tiêu và đầu ra

Một user đăng nhập/unlock có thể lưu text bằng quick-add, tạo item/tag, import JSON thành một entry bảng, sửa rồi mở lại ở thiết bị khác. Dữ liệu plaintext chỉ ở client; API/DB giữ ciphertext body. Đây là phase đầu tiên dữ liệu thật đi suốt auth → vault → CRUD → render.

## Mốc triển khai

| Mốc | Đầu ra |
|---|---|
| P04-A | Item/Tag CRUD, ownership, counters, pagination, entry storage, text edit |
| P04-B | Quick-add exact resolution, tag assignment, duplicate picker, retry/Undo |
| P04-C | Parser/spans + JSON renderer/import/editor, fixtures lossless |
| P04-D | Multi-device cơ bản, conflict/restore/purge, reset integration |

Ngoài phạm vi: suggest prefix/fuzzy đầy đủ/semantic ở P05; backup import, merge tag, move entry và file/image/link ở P07. P04 vẫn có list/recent/filter và exact name lookup đủ dùng quick-add; không cần đợi TEI để lưu dữ liệu.

## UI

- U8–U10 theo [index.html](../../mockups/index.html): quick-add, rail tag/filter, recent grid, duplicate-name picker có name + tag + created_at; selection giữ item ID, không chỉ string name.
- U11–U14 theo [item.html](../../mockups/item.html): name/hint/tag, text card, JSON table/raw, import paste/file, reorder/copy/delete.
- U18 theo [states.html](../../mockups/states.html): empty item/list, JSON invalid/too large, 20/200 limit, offline, saving/error, decrypt fail, conflict và delete/Undo. Ca nào thiếu thì thêm vào file đó trước khi code; bổ sung UI edit control/keyboard vào mockup khi HTML hiện tại chỉ có view.
- Không port giả lập `JSON.parse` import hoặc `__raw`/`__pairs`; không lưu plaintext trong React Query persisted cache, DOM data attribute hoặc server-rendered HTML. Recent card preview nếu có phải decrypt lazy client, và xoá khi lock.

## Domain và API

| Nội dung | Contract |
|---|---|
| Item | Name trùng được; normalize NFC/lower/trim/space/punctuation theo §2.4, giữ dấu; name 1–200, hint ≤120 plaintext |
| Tag | Display 1–50, unique normalized per user/live; create upsert, rename collision 409; max 20/item |
| Entry | Một item, text/json, max 200 active/item; UUID client trước encrypt; type plaintext, body ≤256 KiB UTF-8. Client gửi kèm `plaintext_len_bucket = ceil(len/256)*256` — metadata làm tròn, không phải độ dài thật |
| Ciphertext | Envelope/JCS §5.5; server size/shape/user/key_id validation, không parse text/JSON body. Chặn hai ngưỡng §10.2: `plaintext_len_bucket ≤ 262144` và `octet_length(ciphertext) ≤ 263168` |
| Concurrency | If-Match entry version/timestamp chuẩn serialize trong response; không dùng last-write-wins để đè edit khác |
| Counters | entry_count/item_count/tag limits cùng transaction/lock với mutation; không check count rồi insert ngoài lock |

Endpoint owner: `/items*`, `/tags*`, `/entries*` trong §9.2, **bao gồm `POST /items/{id}/entries/import-json`** — cùng body mã hoá như `POST entries`, `type` buộc `json`, thêm `source: paste|file` và `filename?` là plaintext meta, không nhận raw JSON. Import cũng đi qua idempotency key như mọi mutation ghi khác, retry không tạo entry thứ hai. Trước handler, chốt thêm contract exact name lookup và restore Item/Tag (spec có Undo nhưng hiện chỉ ghi entry restore); cập nhật OpenAPI/§9. Các nested IDs phải cùng user, kể cả reorder permutation, tag_ids, restore và bulk count.

Rate limit thuộc phase này theo §9.1: write **10 rps/user**. Middleware và bộ nhớ idempotency dùng lại của [P03](P03-vault.md) — fingerprint method + path + body, ghi cùng transaction, giữ 24 giờ, cùng key khác payload trả `409`.

### Quick-add và retry

1. Parse `name #tag: body` client; URL, colon, whitespace, nhiều dòng và tag display có khoảng trắng cần grammar/fixture rõ. Quick-add chỉ text; JSON detection gợi ý chuyển import, không tự đổi type. Body fragment không bao giờ đi vào request suggest/search, kể cả debounce từ trước lúc chuyển add mode.
2. Resolve **tất cả exact normalized-name matches** bằng query per-user có pagination/count hoặc ambiguity flag. Không dùng `/suggest` top-K để kết luận chỉ có một item. 0 → tạo; 1 → append; nhiều → picker hoặc tạo mới.
3. Tag upsert rồi assign theo union; không ghi đè tag mới vừa được device khác thêm bằng snapshot cũ. Nêu transaction/version contract trước implementation.
4. Sinh UUID/ciphertext một lần, giữ idempotency key và ID của từng mutation qua retry. Timeout giữa create item/assign tag/create entry không được tạo bản sao khi retry; UI chỉ báo đã lưu sau entry commit.
5. Lỗi giữ draft ở memory trong session, không queue offline. Lock xoá draft theo policy hiển thị; không tự gửi sau unlock nếu user chưa thực hiện lại.
6. Undo 5 giây thực sự restore/soft-delete mutation đích. Chốt scope quick-add Undo: xoá entry vừa thêm; việc dọn item/tag vừa tạo chỉ khi còn rỗng và không được thao tác khác dùng, không xoá dữ liệu mới của device khác. Ghi rõ scope trong toast/mutation contract.

### JSON lossless

- Source of truth là UTF-8 text hợp lệ + syntax tree/source spans; strict JSON, không comment/trailing comma. Import/raw-edit giữ text gốc, kể cả whitespace; invalid UTF-8 bị reject, không thay U+FFFD âm thầm.
- Span offset UTF-16 theo parser; table edit splice token/structure cần sửa, reparse sau mỗi revision; không stringify document. Field key trùng có occurrence identity; integer-like keys theo source order.
- Number cell giữ lexeme (`9007199254740993`, `1e400`, `-0`), không round-trip JS Number. Format explicit chỉ edit whitespace ngoài string.
- Nested object field/value, array-of-object union columns theo source, duplicate-key row fallback field/value, primitive root, mixed array/empty array đều có view hợp lý. Array >50 rows page/virtualize; expand lazy, tránh recursive eager render gây tràn stack với input nhỏ nhưng rất sâu.
- Sau edit đo đúng byte plaintext kết quả ≤256 KiB, nonce mới, cùng entry ID, If-Match. Xung đột hiển thị reload/compare/retry có chủ đích; không mất draft chưa submit mà không thông báo.

### Xoá, reset và nhiều thiết bị

- Soft-delete entry 30 ngày + restore/purge; restore vẫn phải tuân trần active entries và item tồn tại. Delete Item gỡ tags/soft-delete children; xác định provenance để Undo không resurrect entry đã bị user xoá trước đó. Tag delete không xoá item.
- Reset vault P03 được tích hợp transaction xoá entries kể cả tombstones, key wraps cũ và counters; giữ name/tag/item_tag. Revoke stale in-flight writes bằng key_id/vault state, không cho request cũ tạo entry không còn đọc được sau reset.
- `/entries/changes?since=` thuộc MVP theo §9.2: trả changed rows và tombstones, có pagination/tie handling. Chốt clock/watermark semantics và replay window; client dedup/refetch nguồn chuẩn khi focus/reconnect, không hứa timestamp feed là durable sync. P07 bổ sung change cursor/SSE/resync protocol. Session UI đã có P02, không trì hoãn tới P07.

## File dự kiến và thứ tự

`apps/api/internal/{item,tag,entry}/**`, migrations/queries CRUD+idempotency, `apps/web/features/{item,tag,entry,json-table,omnibox}/**`, `lib/json/**`, contract fixtures và Playwright flows. Dùng crypto P03, không tạo module encrypt thứ hai trong React card.

Chốt API/grammar → storage/text → quick-add → parser/view/edit JSON → delete/conflict/delta/reset → tích hợp en/vi/mobile/keyboard. Component và task được nghiệm thu theo mốc, nhưng phase chỉ Done khi cả bốn mốc đạt.

## Acceptance

| ID | Kịch bản | Đạt khi |
|---|---|---|
| P04-A1 | Tenant isolation | User B không đọc/attach/move qua IDs A ở mọi route/relationship |
| P04-A2 | Limits concurrent | Không vượt 20 tag/200 entries qua race, restore hay retry; counters luôn khớp rows |
| P04-A3 | Quick-add 0/1/n matches | Correct item ID, name trùng không unique; retry timeout không tạo item/entry trùng |
| P04-A4 | Body boundary | Network/log/SSR không có body text/JSON; `name: secret` chỉ gửi name tới lookup/search |
| P04-A5 | UUID/If-Match | Tạo→đọc decrypt đúng; đổi ID fail; device stale nhận conflict, không đè edit |
| P04-A6 | JSON corpus | Key trùng, integer-key order, số lớn, 1e400, -0, escaped Unicode/CRLF, root primitives, nested/mixed arrays giữ nguyên ngoài edit spans |
| P04-A7 | Size/parser | 256 KiB boundary tính UTF-8; malformed UTF-8/JSON bị reject; format/edit không normalize giá trị |
| P04-A8 | Delete/restore/purge | Undo thật; không resurrect deletion cũ; purge sau retention; tombstones tới device khác |
| P04-A9 | Lock/reset | Lock xoá mọi body/editor/preview cache; reset giữ item/tag nhưng không còn entry/key_id cũ, stale writes fail |
| P04-A10 | UX và tốc độ | G1 quick-add ≤3 giây trong test đã unlock; entry create đạt p95 < 150 ms phía server theo §6.9, đo trên dataset có kích thước thật; U8–U14/U18 mobile/dark/keyboard và lỗi mạng dùng được |
| P04-A11 | Idempotency và write limit | Retry `POST /entries` và `import-json` với cùng key trả response gốc, không tạo bản thứ hai; cùng key khác payload trả `409`; bản ghi hết hạn sau 24 giờ; vượt 10 rps ghi bị chặn mà không mất mutation đã commit |
| P04-A12 | Size metadata | `plaintext_len_bucket` luôn là bội số 256 và ≥ độ dài thật; quá 262144 hoặc ciphertext quá 263168 B bị từ chối trước khi lưu; server không suy ra độ dài chính xác từ bucket |

## Bàn giao

P05 nhận corpus name/tag thật, exact lookup, metadata counters và mutation hooks; P06 nhận exportable ciphertext/vault dataset. Recovery/lock/reset cùng P03 phải được chạy bằng entry thực. Migration lỗi không chữa bằng reset vault; giữ ciphertext/envelope để restore DB hoặc sửa forward.
