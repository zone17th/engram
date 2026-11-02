# ADR 0007 — Generation embedding: bảng vector theo generation, khoá, pin và cutover

- Trạng thái: đề xuất (owner đã cho đi theo đề xuất qua user-dec-015; Advisor ghi ở advisor-dec-243 và advisor-dec-244)
- Ngày: 2026-11-02
- Phase: P05 (semantic: contract Task 1; bảng và bootstrap Task 6; vòng đời Task 19); P06 vận hành
- Nguồn: [plan P05](../plans/2026-11-02-P05-search.md) mục 2.12, 2.14, 2.15, 2.17, 2.18, 2.20, 2.22 và mục 9 (OQ-16, OQ-18, OQ-19, OQ-22), [ADR 0004](0004-embedding-provider-openai-compat.md), [SPEC](../SPEC.md) §4.4, §6.6, §6.7, §6.10, §8, [threat model](../threat-model.md)
- Thay thế một phần: SPEC §6.6 (sơ đồ shadow/cutover dựa trên một bảng `item_embedding`/`tag_embedding` và cột `model`), SPEC §8 (tên bảng `item_embedding`/`tag_embedding`, `item_emb_model_idx`)
- Không đổi crypto: search không bao giờ thấy body entry; `lib/crypto/**`, envelope và `internal/vault/{envelope,wrap,kdf}.go` giữ nguyên (gate crypto, plan mục 5)
- Bất biến ràng buộc (`user-dec-016`): input embedding chỉ là `item.name` (+ `hint`) và `tag.display`; body entry không bao giờ vào index, job, provider, cache hay benchmark

## Bối cảnh

ADR 0004 cho phép nhiều provider (`tei`, `openai_compat`, `noop`) và ghi nhận rằng đổi model, đổi revision, đổi instruction hay đổi số chiều là **đổi không gian vector**: vector cũ và vector mới không so sánh được với nhau, và cột `vector(<dims>)` không đổi kiểu tại chỗ. SPEC v0.7 §6.6 mô tả shadow/cutover trên một bảng duy nhất có cột `model`, đủ cho một model nhưng chưa trả lời các câu hỏi P05 phải chốt trước khi code:

- Hai generation với số chiều khác nhau sống chung thế nào (một cột `vector(1024)` không chứa được `vector(1536)`).
- Mutation của người dùng (tạo/sửa/xoá item, tag) trong lúc đang backfill generation mới ghi vào đâu, và làm sao để generation mới không bỏ sót mutation nào dù chỉ một khe hở.
- Một request query dùng đúng một generation từ đầu tới cuối dù active đổi giữa chừng.
- Client provider nào được phép ghi vào generation nào (cùng tên model nhưng khác revision không được trộn).
- Người dùng tắt `semantic_suggest` ảnh hưởng thế nào khi deployment có generation `tei` lẫn generation `openai_compat`.
- Deployment mới (chưa có generation nào) bật semantic thế nào mà không cần thao tác CLI thủ công, trong khi mọi lần đổi model sau đó vẫn phải do người vận hành quyết.
- Khi nào được xoá hẳn bảng của generation cũ.

ADR này ghi các quyết định đó để các lane `embedprov`, `embedstore`, `embedjobs`, `semquery`, `searchscale`, `semops` không phải tự suy.

## Quyết định

### 1. Mỗi generation một cặp bảng `_g<N>`, kể cả g1 (OQ-18)

- Bảng `embedding_generation` ghi danh tính và cấu hình của từng generation; `embedding_active` là singleton trỏ tới generation đang phục vụ query.
- Mỗi generation `N` có hai bảng riêng: `item_embedding_g<N>` và `tag_embedding_g<N>` (`N` từ 1 đến 9999), kể cả generation đầu tiên g1 — không có bảng "mặc định" không hậu tố. Cột: `(user_id, target_id, embedding vector(<dims>), model, model_version, input_hash bytea, embedded_at)`, khoá chính `(user_id, target_id)`, khoá ngoại composite `(user_id, target_id) → item|tag(user_id, id) ON DELETE CASCADE` (hard delete/purge kéo theo xoá vector), `PARTITION BY HASH (user_id)` chia 16 partition `…_g<N>_p<i>`.
- `embedding_generation` giữ: `provider (tei|openai_compat)`, `model`, `model_version`, `preprocessing`, `query_prefix`, `doc_prefix`, `dims (1..2000)`, `partitions` (mặc định 16), `hnsw_m` (16), `hnsw_ef_construction` (128), `semantic_min_cos real` (`0 < x < 1`), `calibration_ref text NOT NULL`, `canary jsonb`, `item_table`/`tag_table` (UNIQUE, `CHECK` bằng đúng `'item_embedding_g' || id`), `state (pending|active|retired|dropped)`, `bootstrap bool` (mặc định `false`), `rollback_until`, `index_ready`, `verified_at`, `verify_report jsonb` (chỉ số đếm/recall), và các mốc thời gian. Partial unique index: tối đa **một** generation `pending`.
- Đổi `partitions`, `hnsw_m`, `hnsw_ef_construction`, `dims`, model, revision, instruction, `preprocessing` đều là **generation mới**, không `ALTER` bảng đang chạy. Migration không tạo HNSW; HNSW tạo theo partition (xem mục 7).
- `semantic_min_cos` là cột của hàng generation (không phải của bảng active riêng): ngưỡng đi cùng không gian vector mà nó đã được hiệu chỉnh cho.

### 2. Vì sao không `PARTITION BY LIST (generation)` trên một bảng chung

Một bảng chung phân vùng theo generation trông gọn hơn nhưng không dùng được khi các generation khác số chiều: cột `embedding` phải có một kiểu cố định, nên mỗi chiều cần cột/kiểu riêng hoặc một cột `vector` không ràng buộc chiều. HNSW của pgvector cần kiểu có số chiều xác định, nên index trên cột không ràng buộc chiều phải là **expression index với cast `(embedding::vector(<dims>))` riêng cho từng dims**, kèm điều kiện partial trùng khớp mới được planner chọn; thêm một generation khác chiều nghĩa là thêm một expression index mới trên bảng đang phục vụ tải, và mọi truy vấn phải lặp lại đúng biểu thức cast. Bảng riêng `_g<N>` cho `vector(<dims>)` thật, index và vacuum độc lập, drop một generation là `DROP TABLE` chứ không phải xoá hàng loạt khỏi bảng đang phục vụ. Cái giá (tên bảng động) được kiểm soát ở mục 5.

### 3. Tập nhận R và giao thức khoá (OQ-16)

- **Tập nhận** `R = {active} ∪ {pending} ∪ {retired có rollback_until > now()}`. `generation.ReceivingGenerations(tx)` là nguồn duy nhất cho enqueue và restore; không code nào tự suy R.
- **Xoá vector** (soft-delete target, user-off) **không** dựa vào R mà dùng **mọi generation còn bảng** (`state ≠ dropped`), kể cả generation retired đã hết cửa sổ rollback, để không sót vector của target đã xoá hay của user đã tắt.
- **Khoá advisory** trên một khoá "tập generation" duy nhất:
  - mọi transaction mutation enqueue/xoá vector lấy `pg_advisory_xact_lock_shared(<khoá generation set>)` **trước khi đọc `R`**;
  - create / flip / rollback / retire / drop / lấy watermark `W` lấy `pg_advisory_xact_lock` (exclusive) cùng khoá.
  - Hệ quả: một generation mới chỉ commit sau khi mọi mutation đang bay đã commit, và mutation bắt đầu sau commit thấy generation mới trong `R`. Backfill bắt đầu sau commit nên **không có khe hở** giữa "trước khi generation tồn tại" và "mutation bắt đầu fan-out".
- **Worker upsert** không lấy advisory lock nội dung: khoá hàng item/tag `FOR SHARE` → `app_user FOR SHARE` → hàng embedding. Nhờ vậy p95 tạo entry của P04 (A10) không bị chặn bởi worker; chi phí advisory lock shared trên `POST /items` đo và báo riêng ở Task 23.
- Không giữ lock nào trong lúc gọi mạng tới provider; lock chỉ nằm ở transaction ghi ngắn sau khi có vector.

### 4. Pin theo request

API đọc generation active (cache ≤ 2 s, **xoá ngay** khi nhận `NOTIFY embedding_generation_changed`, không chờ TTL) thành một `Pin{GenID, Identity, MinCos, ItemTable, TagTable}`. `Identity` đủ bảy trường (mục 6) và được điền từ **cùng một hàng** `embedding_generation`, không tra lại active lần hai. Embed query, cache query-embedding, hai truy vấn vector (item, tag) và cursor `/search` dùng cùng một Pin, nên một request không bao giờ trộn hai generation dù cutover xảy ra giữa chừng. Trước khi truy vấn DB, kiểm `len(qvec) == Pin.Identity.Dims` (`dims_mismatch` → degrade, không ném lỗi). Cache query-embedding có key `user_id ‖ generation_id ‖ HMAC-SHA256(k, qn)`, không bao giờ dùng chung giữa user.

### 5. Tên bảng động: allowlist và hàm DDL (OQ-22)

- Go chỉ chấp nhận tên khớp `^(item|tag)_embedding_g[1-9][0-9]{0,3}$` **và** bằng tên suy từ id của generation; SQL dựng bằng `pgx.Identifier{name}.Sanitize()`. Không bao giờ nối chuỗi từ đầu vào ngoài. Query vector viết tay trong `internal/embedding/store` (sqlc chỉ phủ `embedding_generation` và `embedding_active`) — ngoại lệ có review.
- DDL nằm ở hàm SQL trong migration `0009_embedding`, CLI `worker reembed generation …` chỉ gọi hàm:
  - `embedding_generation_create_tables(p_id, p_dims, p_partitions, p_with_hnsw, p_m, p_efc)` (plpgsql): kiểm khoảng của từng tham số, dựng tên bằng `format('%I')` từ id; `p_with_hnsw` chỉ cho bảng rỗng.
  - `embedding_generation_drop_tables(p_id)`: chỉ chạy khi `state = 'retired'`, không bao giờ với generation active.
- Tách role DB riêng cho hàm DDL (`SECURITY DEFINER`) nằm ngoài phạm vi P05 (để P06).

### 6. Client provider theo generation, khớp danh tính đầy đủ (BE-1)

- Deployment cấu hình tối đa hai client: bộ `EMBEDDING_*` (primary) và bộ `EMBEDDING_SHADOW_*` (client thứ hai cho cutover, rỗng = không có; cùng tên trường như bộ primary).
- Danh tính là kiểu `embedid.Identity` ở package lá `apps/api/internal/embedding/embedid` (chỉ stdlib), gồm **bảy** trường: `Provider`, `Model`, `ModelVersion`, `Dims`, `QueryPrefix`, `DocPrefix`, `Preprocessing`. `Key()` mã hoá không nhập nhằng cả bảy trường (có tách độ dài). Cùng package có `type CalibrationLookup func(Identity) (minCos float64, reportPath string, ok bool)`.
- `ClientSet.Match(id)` chỉ trả client khi `client.Identity.Key() == id.Key()` — **cả bảy** trường, kiểm **trước** mọi lời gọi mạng. Cùng tên model nhưng khác revision (`ModelVersion`) hoặc khác prefix document → không khớp: query ở trạng thái `degraded` (`generation_unconfigured`), job `JobSnooze(5m)`. Không bao giờ gọi provider hay upsert vào generation bằng client có danh tính khác.
- Package lá: `embedid` ← `embedding` (provider, `input.go`); `embedid` ← `generation` (registry, pin, lock, tables, bootstrap; không import `store`/`reconcile`/`jobs`/`lifecycle`); `jobargs` (args job); `store` → `generation`; `reconcile` → `generation`, `store`, `embedding`, `jobargs`; `jobs` → `generation`, `store`, `jobargs`, `reconcile` (không bao giờ `lifecycle`); `lifecycle` → `generation`, `store`, `reconcile`, `jobargs`; chỉ `internal/worker` và `cmd/worker` import `lifecycle`. Test `TestEmbeddingImportDirection` khoá các cạnh cấm.

### 7. Vòng đời generation: bảy bước (OQ-19)

| Bước | Việc |
|---|---|
| 1. `create` | Giữ khoá exclusive; tạo hàng `pending` và hai bảng (chưa có HNSW). Từ commit, mọi mutation fan-out vào cả active và pending. Host không đủ hai provider → cửa sổ chỉ-lexical có lịch. Từ chối nếu thiếu calibration (mục 10). |
| 2. `backfill` | Reconcile(All) trên generation pending: batch 64, concurrency 2, tôn trọng `Retry-After`. |
| 3. `index` | HNSW tạo theo từng partition bằng `CREATE INDEX CONCURRENTLY`, rồi index cha `ON ONLY` + `ATTACH PARTITION`; `index_ready` khi mọi `pg_index.indisvalid`. |
| 4. `verify` | Dưới watermark `W` (exclusive): không còn job embed tạo trước `W` ở trạng thái available/retryable/running; Reconcile dry-run = 0 missing + 0 stale cho mọi target sống của user đủ điều kiện, cả hai corpus; toàn vẹn (số hàng/partition, không vector của target đã xoá, đúng dims); recall mẫu 200 query ANN so với exact đạt C2 — bỏ qua khi generation có < 200 vector. Không flip ở mức 95 %. |
| 5. `flip` | Transaction exclusive: pending → active, active cũ → `retired` với `rollback_until = now() + SEARCH_ROLLBACK_WINDOW` (mặc định `168h` = 7 ngày), rồi `NOTIFY embedding_generation_changed`. Thủ công cần `--yes`; từ chối nếu `verify` đã quá 1 giờ hoặc có mutation chưa phủ. |
| 6. `rollback` | Chỉ trong cửa sổ và chỉ khi bản retired catch up cùng điều kiện của bước 4; ngoài cửa sổ → `generation_not_caught_up`. Cần `--yes`. |
| 7. `drop` | Chỉ generation `retired`, **sau** `rollback_until` **và** có `--accepted-evidence <path>` (đường dẫn tới evidence nghiệm thu của generation mới); cần `--yes`. Gọi `embedding_generation_drop_tables`. |

Cửa sổ rollback 7 ngày và yêu cầu evidence cho `drop` là quyết định OQ-19: bảng retired còn nguyên để quay lại nhanh; xoá hẳn là việc không đảo ngược nên cần bằng chứng generation mới đã được chấp nhận.

### 8. Bootstrap g1 `pending` và tự flip chỉ cho `bootstrap=true` (BE-4)

- Hàm duy nhất `generation.Bootstrap` (Task 6): khi `SEARCH_SEMANTIC_ENABLED=true`, provider ≠ `noop`, có calibration cho danh tính của client primary và **chưa có hàng generation nào**, tạo g1 ở trạng thái **`pending`** với `bootstrap=true` (bảng và HNSW dựng ngay vì rỗng) — **không** active. Worker boot gọi `Bootstrap` (transaction commit **trước** `river.Client.Start`), CLI `worker reembed generation create --bootstrap` gọi cùng hàm.
- Từ commit, mutation enqueue vào R (gồm pending); Reconcile(All) lúc boot backfill trong khi `semantic_available=false`.
- Job periodic `embedding_bootstrap_flip` (đăng ký `RunOnStart` + chu kỳ `1m`; chu kỳ chỉ đổi qua env test-only `EMBEDDING_BOOTSTRAP_FLIP_INTERVAL`, bị `validate` từ chối ở production) chạy `verify`; khi đạt, **tự flip** generation bootstrap → active vì không có gì cũ cần bảo vệ, rồi `NOTIFY` xoá cache Pin và cache availability. Với generation bootstrap, `index_ready` đọc thẳng `indisvalid` theo partition; deployment rỗng flip ở lần chạy `RunOnStart` đầu tiên.
- **Chỉ generation `bootstrap=true` được tự flip.** Mọi lần đổi model/revision/instruction sau đó đi qua CLI thủ công theo mục 7 với `--yes`. Thiếu điều kiện bootstrap → semantic unavailable + metric, không đoán.

### 9. User-off theo provider của từng generation (BE-3) và Reconcile dry-run (BE-11)

- Chính sách người dùng quyết theo `provider` **của generation đích**, không theo provider active của deployment. `semantic_suggest=false`:
  - xoá vector của user trong **mọi** generation còn bảng có `provider = openai_compat` (`store.DeleteUserExternal`, kể cả retired hết cửa sổ);
  - generation `tei` giữ nguyên vector và vẫn được cập nhật;
  - enqueue, job `embed_*` và Reconcile bỏ user đó **chỉ** với generation `openai_compat`.
  Bật lại → `reembed_user` (Reconcile(User)) cho mọi generation `openai_compat` ∈ R. Request provider đã bay trước commit không thu hồi được (threat model L-7); job muộn bị chặn ở bước ghi vì đọc `app_user FOR SHARE`.
- **Reconcile `DryRun` không ghi gì** (BE-11): không `INSERT`/`UPDATE`/`DELETE`, không enqueue, không gọi provider; chỉ trả số đề xuất `would_enqueue`, `would_delete_orphan`, `would_delete_user_off` tách khỏi số đã áp. Nhánh xoá chỉ chạy ở mode `Enqueue`. `verify` dùng DryRun, nên kiểm tra không làm thay đổi trạng thái cần kiểm.

### 10. Calibration là điều kiện tạo generation

`semantic_min_cos` và `calibration_ref` (`NOT NULL`) lấy từ `internal/embedding/calibration.go` — bảng `(provider, model, model_version) → min_cos, report path` — cùng report `worker semeval` tương ứng trong `docs/benchmarks/semantic-eval/`. Code từ chối tạo hoặc kích hoạt generation thiếu calibration (gồm `Bootstrap`, `create`, `flip`). Recall < 0.60 trên bộ cặp đánh giá → `decision_required`, không bật cho user. `calibration.go` được biên dịch vào binary nên phải merge rồi build/deploy image mới trước khi bootstrap g1. Entry cho model fake của CI (`fakeembed`) chỉ được chấp nhận khi `APP_ENV` không phải production. Đổi ngưỡng cùng model = sửa `calibration.go` + report mới; worker boot cập nhật cột của generation.

### 11. Lệnh vận hành: subcommand của binary `worker`

Không có endpoint HTTP vận hành, không binary mới. Chạy bằng `docker compose … run --rm worker /app/worker reembed …` với cùng env file của deploy. Cấu hình lấy từ env, không nhận key qua argv; đầu ra chỉ số đếm/UUID/id job, không tên, không `q`, không args job.

| Lệnh | Việc | An toàn |
|---|---|---|
| `worker reembed all [--generation N] [--dry-run]` | Reconcile(All) | in số đếm; `--dry-run` không ghi gì (BE-11) |
| `worker reembed user --user <uuid> [--dry-run]` | Reconcile(User) | UUID, không email |
| `worker reembed status` | generation, state, coverage, queue depth/lag, dead-letter | không tên/q |
| `worker reembed deadletter list\|retry [--generation N]` | job embed discarded | in số + id job, không args |
| `worker reembed generation create [--bootstrap] --client primary\|shadow [--partitions --m --ef-construction]` | bước 1; `--bootstrap` gọi đúng `generation.Bootstrap` như worker boot → g1 `pending`, tự flip sau verify | cấu hình từ env, không nhận key qua argv; ngưỡng lấy từ `calibration.go` |
| `worker reembed generation backfill\|index\|verify\|flip\|rollback\|retire\|drop --generation N` | bước 2–7 | `flip`/`rollback`/`drop` cần `--yes`; `drop` cần `--accepted-evidence` |
| `worker semeval --pairs … --out …` | chạy evaluator calibration | không in input |

## Các phương án đã cân nhắc và loại bỏ

- **Một bảng `PARTITION BY LIST (generation)`** — loại, lý do ở mục 2 (cần expression index với cast riêng cho từng dims, mọi truy vấn phải lặp biểu thức cast, drop = xoá hàng khỏi bảng đang chạy).
- **Giữ một bảng, thêm cột `model` và `item_emb_model_idx`** (SPEC cũ) — loại: không chứa được số chiều khác nhau, và index HNSW trộn hai không gian vector sẽ cho kết quả sai. Bảng mới mỗi generation, bỏ `item_emb_model_idx`.
- **`ALTER` bảng tại chỗ khi đổi `partitions`/`m`/`ef_construction`** — loại: không có đường quay lại; đổi tham số = generation mới.
- **Chọn client theo tên model** — loại: cùng tên khác revision hay prefix document sẽ ghi vector khác không gian vào index cũ. Khớp cả bảy trường.
- **Flip tự động mọi generation sau verify** — loại: đổi model là quyết định vận hành; chỉ generation `bootstrap=true` (không có gì cũ cần bảo vệ) tự flip.
- **Endpoint HTTP vận hành hoặc nút "Nhúng lại tất cả"** — loại theo user-dec-015 (UX tối giản, giữ an toàn): vận hành qua CLI.

## Hệ quả

- Task 1 tạo `embedid`; Task 6 tạo migration `0009_embedding`, `generation/{registry,pin,lock,tables,bootstrap}.go`, `store`, `jobargs`; Task 15/19 thêm `reconcile` và `lifecycle`; Task 11a/11b nối hook enqueue trong transaction; Task 12 dùng Pin cho query.
- Mỗi generation tốn bảng và index riêng (≈ 4 GB heap/bộ bảng + HNSW cùng bậc ở quy mô `full` của benchmark, protocol ở `docs/benchmarks/P05-search/protocol.md`), nên cutover cần chỗ trống đĩa cho hai bộ trong cửa sổ rollback 7 ngày (suy ra từ thiết kế, runbook Task 24 nên nêu rõ).
- Tên bảng động là bề mặt tấn công mới: giới hạn bằng allowlist + id (mục 5); CLI chỉ in số/UUID. Query-embedding cache nằm RAM theo user + HMAC, cursor không chứa `q`, backfill/Reconcile `openai_compat` bỏ user-off (threat model).
- Semantic chỉ available khi `SEARCH_SEMANTIC_ENABLED && provider ≠ noop && active generation khớp một client đã cấu hình (đủ bảy trường) && có calibration`; breaker không lật cờ này, degrade báo theo response bằng `semantic_reason="degraded"`.
- Lexical không phụ thuộc generation: mọi nhánh lỗi (client không khớp, breaker mở, generation chưa sẵn sàng) chỉ làm vùng "Gần nghĩa" tạm nghỉ.
