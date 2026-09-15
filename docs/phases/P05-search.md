# P05 — Tìm kiếm lexical và semantic

> Kế hoạch · MVP 5/6 · Phụ thuộc: [P04](P04-content.md).
> Nguồn: [SPEC](../SPEC.md) §6, §7.0/§7.2, §8–§9, §10, §11.3.

## Mục tiêu và đầu ra

Tìm lại bằng name/tag trên hai corpus, prefix/fuzzy trước và semantic bổ sung sau. TEI lỗi hoặc tắt vẫn lưu/tìm lexical được. Kết quả semantic không làm di chuyển hàng lexical đang được user chọn.

## Mốc triển khai

| Mốc | Phạm vi |
|---|---|
| P05-A — Lexical | Normalize/unaccent, prefix/pg_trgm, two-corpus suggest/search, keyboard/highlight/quotas |
| P05-B — Semantic | TEI bge-m3, query cache, jobs, toggle hai tầng, timeout/circuit, stable merge |
| P05-C — Scale/rollout | Exact vs partitioned HNSW, backfill stale, shadow model generation, benchmark/cutover/rollback |

Ngoài phạm vi: search body plaintext phía server hoặc client content index, third-party embedding API, user tự chọn model, private-name/blind index. Không thêm user opt-out indexing toggle hoặc nút global `ReembedAll` theo demo.

## UI

- U15 theo [index.html](../../mockups/index.html) và header search [item.html](../../mockups/item.html): tag lexical → item lexical → vùng Gần nghĩa cuối; mỗi row có kind/ID và dấu khớp.
- U16 theo [settings.html](../../mockups/settings.html) `#timkiem`: giữ card/toggle/token. Sửa copy user-off vẫn index; ẩn/bỏ action vận hành "Nhúng lại tất cả" khỏi app user nếu chưa có contract sản phẩm.
- U18 theo [states.html](../../mockups/states.html): empty, request pending, server-disabled/user-disabled/degraded. Ca nào thiếu thì thêm vào file đó trước khi code. Tắt/degraded không spam toast lỗi; prefix/fuzzy còn hoạt động.
- `Tab` item điền `name: `, tag điền `#display `; `Enter` mở ID/filter tag ID; AbortController + query generation bỏ response cũ. Không gửi body sau colon hoặc secret draft vào API search.

## Query/ranking contract

- Endpoint `/suggest` và `/search` theo §9.2, scopes all/item/tag, leading `#` là tag. q rỗng recent; <2 ký tự chỉ prefix; semantic chỉ ≥3 và mọi gate cho phép. Rate limit theo §9.1: suggest **20 rps, burst 40** cho mỗi user — vượt hạn thì degrade về kết quả đã có, không hiện lỗi đỏ giữa lúc gõ.
- Client đọc `features.semantic_available` từ `GET /auth/me` ([P02](P02-auth.md) sở hữu field này) để quyết định hiện toggle semantic; bật semantic lúc provider down thì `PATCH /me/settings` trả `409 SEMANTIC_UNAVAILABLE` và UI hiện trạng thái degraded, không tự lưu rồi coi như đã bật.
- Không RRF weighted sum. Trong prefix/fuzzy: relevance trước rồi last_used/count/id tie-break; semantic-only dedup với lexical rồi sort cosine/tie-break theo §6.4.
- Chốt quotas item/tag và vùng semantic cho từng limit trong OpenAPI trước UI: cùng q/scope/limit phải giữ cùng quota lexical khi toggle semantic. Không lấy chỗ lexical đã hiện để nhét semantic; full response không được thay selection thành index khác.
- Request `semantic=0` ép lexical, `1` không override env/user/breaker. Hai response cùng query giữ snapshot lexical đang hiển thị và selection `(kind,id)`; query/data refresh mới là thời điểm reconcile có chủ đích.
- User setting off: không TEI query và không vector lookup; indexing vẫn chạy. Deployment off/noop: không enqueue/query semantic và features unavailable. Degraded: timeout/circuit 60 s, lexical response còn hợp lệ.
- Query cache key generation + normalized query; response/client cache còn gồm user, scope, limit, mode/settings. Không cache response dữ liệu của user dưới key chỉ có q. Không log raw q.

## Embedding và storage

- Provider chỉ `tei`/`noop`; bge-m3 1024 dims normalize cosine, đọc model revision/dims từ provider. Item input name + optional hint, tag input display; body không vào jobs/TEI.
- Mutation P04 enqueue River trong transaction khi deployment enabled; target/user/generation/input_hash. Job đọc current input, so hash trước UPSERT để job chậm không đè rename mới; soft-delete loại vector, restore enqueue lại.
- `ReembedAll` sửa missing **hoặc** hash/model/version mismatch. Test case bắt buộc deployment off → sửa name/hint/tag → on. User-off không cần backfill đặc biệt vì vẫn enqueue.
- Exact khi corpus user ≤ `SEARCH_EXACT_MAX_VECTORS` khởi đầu 5000: preselect tenant bằng B-tree/materialized CTE rồi exact sort. Corpus lớn dùng 16 hash partitions theo user làm baseline, HNSW/index từng partition.
- HNSW vẫn post-filter trong partition: iterative relaxed_order, ef_search 64, max_scan_tuples 20000 là giá trị khởi đầu; đo underfill/recall/latency. Không suy 2–3 ms từ 4 KB/vector, không gọi hash partition là per-user prefilter.
- Pin generation/model/query prefix/dims cho mỗi request; các bảng active/pending không trộn vector space. Rename dữ liệu không đổi generation; thay model/revision/preprocessing luôn shadow cả hai bảng/index.

## Rollout và lỗi vận hành

1. Build shadow tables + provider cho generation mới; active cũ tiếp tục phục vụ, mutation enqueue active/pending. Nếu host không đủ tài nguyên chạy hai provider thì lên lịch maintenance/lexical-only có kế hoạch, không đổi query model trỏ vào index cũ.
2. Backfill + catch up tới watermark; index riêng, đủ cả hai corpus và kiểm tra recall/integrity.
3. Atomic flip active pointer chứa model/provider/config/two table names allowlisted. Cache namespace theo generation; request cũ pin generation cũ tới khi hoàn thành.
4. Giữ generation cũ nhận mutation trong cửa sổ rollback; rollback pointer an toàn chỉ nếu dữ liệu đã catch up. Drop sau xác nhận, không drop để tiết kiệm chỗ trước nghiệm thu.

TEI timeout/5xx, queue retry/dead-letter, generation sai dims/hash đều có metric/error code vận hành. `/readyz` không buộc toàn app fail khi semantic optional hỏng; worker failure không làm rollback item create đã commit.

## File dự kiến

`apps/api/internal/{suggest,embedding,jobs}/**`, `internal/db/queries/search*.sql`, migrations partition/index/generation metadata, `cmd/worker`, command `reembed`, `apps/web/features/omnibox/**`, `features/settings/search/**`, `infra/**` TEI profile, `docs/benchmarks/**`, model rollout runbook.

## Acceptance

| ID | Kịch bản | Đạt khi |
|---|---|---|
| P05-A1 | Corpus vi/en | Prefix, sai dấu, typo, `#`, trùng name, empty query theo rule và user scope |
| P05-A2 | Stable ranking | Semantic on/off/late result không đổi thứ tự/DOM identity/selection lexical; recency chỉ tie-break |
| P05-A3 | Query privacy | Add-mode body không vào q; log/cache không lộ response user khác |
| P05-B1 | Toggle matrix | Env off/user off/noop/breaker/short q đều đúng behavior + feature flags |
| P05-B2 | Async indexing | Create/rename/delete/restore và job đến trễ đúng hash; lag p95 <10 s trên môi trường ghi rõ |
| P05-B3 | Backfill | Deployment off edits được sửa khi bật lại; user-off vẫn cập nhật index |
| P05-C1 | Search performance | Dataset 100k item +20k tag/user: lexical server p95 <40 ms, hybrid cache hit <100 ms, miss <350 ms; report hardware/concurrency/cache mode |
| P05-C2 | Tenant scale | Thêm nhiều tenant và skew; đo exact baseline recall@20, p95/p99, underfill/scan cap, tune ngưỡng; mục tiêu recall định lượng phải ghi trước chạy benchmark |
| P05-C3 | Model switch | Shadow cùng dims lẫn khác dims, mutation lúc build, active flip/rollback đều không trộn query/index model |
| P05-C4 | Degrade | Dừng TEI vẫn quick-add/lexical được; retry/circuit recovery không tạo storm |
| P05-C5 | UI | U15/U16/U18 theo mockup đã chỉnh behavior, keyboard/mobile/dark, quota và error state rõ |

## Gate

P06 nhận report relevance/performance, cấu hình đã đo, model pin và runbook toggle/reembed/cutover. Benchmark thất bại không được sửa target âm thầm hoặc đánh dấu Done vì demo ít dữ liệu trông nhanh; ghi bottleneck và khắc phục trong phase.
