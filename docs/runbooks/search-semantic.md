# Runbook — tìm kiếm semantic (P05)

> **Trạng thái: bản khung stage 24-1** (lane `rollout`, nhánh `phase05/rollout`). Mọi lệnh, cờ, tên env, tên metric và tên mã lý do dưới đây được đối chiếu với code tại thời điểm viết; chỗ nào chưa biết giá trị thật ghi `TODO(T24-host)` (điền trên host `bro` ở stage 24-2) hoặc `TODO(T23)` (knob do Task 23 đo và chốt, Advisor đồng bộ vào nhánh sau). Không có số nào ở đây là số đo.
> Nguồn: [plan P05](../plans/2026-11-02-P05-search.md) mục 2.12–2.22, 5 (gate 5, 8, 9), 7, Task 24; [SPEC](../SPEC.md) §3.4–§3.5, §6.6–§6.10, §10.4; [ADR 0004](../adr/0004-embedding-provider-openai-compat.md), [ADR 0007](../adr/0007-embedding-generation-cutover.md); [threat model](../threat-model.md).
> **Repo công khai.** Tài liệu này không chứa secret, URL provider thật, tên miền nội bộ hay dữ liệu người dùng. Secret chỉ nằm trong `.env.production` trên host (ngoài git) và **không bao giờ** đi qua argv (không `-e KEY=...`, không `--api-key`).
> **Ai chạy gì:** lệnh trên `bro` do chủ repo hoặc lane release chạy theo thứ tự mục 12 sau khi P05 merge vào `develop` và Advisor mở stage 24-2. Agent không chạy lệnh nào trên production, không viết SQL trên production. Các lệnh `SHOW`/`SELECT` chỉ-đọc ở mục 10 là bước kiểm của người vận hành.

## 0. Quy ước

- `compose` là bí danh shell cho lệnh chuẩn của Task 24 (mục 9). Mọi lệnh `worker …` chạy qua `compose run --rm worker /app/worker …`; image không có shell (distroless, `ENTRYPOINT []`, user `nonroot`).
- Đầu ra của mọi lệnh `worker reembed …` chỉ gồm id, số đếm, state và mã lý do; không bao giờ có tên item/tag, `hint`, `q`, vector, URL provider, key hay args job (code: `cmd/worker/commands.go` quy tắc riêng tư, `cmd/worker/reembed.go`, `cmd/worker/reembed_generation.go`). Khi dán kết quả vào evidence cũng chỉ dán số.
- Tên metric dưới đây là tên đăng ký trong code (`internal/obs/embedding_metrics.go`, `search_metrics.go`, `embedding_gauges.go`), **không** có tiền tố `engram_` (khác `engram_http_request_duration_seconds` của P01).
- API phục vụ metric ở `GET /api/v1/metrics`; worker chỉ phục vụ `/metrics` khi `WORKER_METRICS_ADDR` khác rỗng (production: bind mạng Docker nội bộ, không publish port; mọi path khác trả 404). Cách scrape thật trên host: `TODO(T24-host)`.

## 1. Công tắc deployment `SEARCH_SEMANTIC_ENABLED`

Env bool, mặc định `true` ở `config.go`; compose truyền cho cả `api` và `worker`. Đổi giá trị = sửa `.env.production` rồi **redeploy cả `api` và `worker`** (config đọc lúc khởi động).

| Giá trị | Hệ quả (plan 2.18 hàng 1–3, SPEC §6.6) |
|---|---|
| `false` | không enqueue job embed, không gọi provider, không đọc bảng vector; `GET /api/v1/auth/me` và `GET /api/v1/readyz` trả `semantic_available:false`; `PATCH /me/settings {semantic_suggest:true}` trả `409 semantic_unavailable`; mỗi response `/suggest`/`/search` có `semantic:false`, `semantic_reason:"disabled_server"`; lexical không đổi. `worker reembed all|user` (không `--dry-run`), `reembed deadletter retry` và mọi leaf `reembed generation` ngoài `verify` **từ chối** ghi (`embedding is disabled in this deployment …`); `--dry-run`, `status`, `deadletter list`, `generation verify` vẫn chạy. Worker không đăng ký queue `embedding` và không gọi `Bootstrap`. `/readyz` vẫn 200. |
| `true` + `EMBEDDING_PROVIDER=noop` | như `false` (deployment không có provider thì semantic unavailable). |
| `true` + provider thật + có calibration | worker boot: `generation.Bootstrap` (mục 4A) rồi chèn một job `reembed_all` (Reconcile(All)); `semantic_available` thành `true` khi g1 đã active. |
| `true` + provider thật **nhưng image không có entry calibration cho danh tính của client** | worker log warn `chưa có calibration cho embedding identity lúc boot; bỏ qua bootstrap g1`, tăng `embedding_generation_mismatch_total{reason="unconfigured"}`, **không** tạo g1; semantic vẫn unavailable. Đây là trạng thái fail-closed (gate 5); sửa bằng image có entry (mục 12 bước 3), không bằng cờ. |

**Bật lại sau khi tắt** (Reconcile): trong lúc tắt không có job nào được enqueue nên vector có thể thiếu hoặc lệch hash. Khi bật lại, worker boot chèn `reembed_all` (ByArgs, restart không chất đống job), chu kỳ 24 h cũng chạy Reconcile(All), và có thể chạy tay: `reembed all --dry-run` (xem `would_enqueue`) rồi `reembed all` (mục 3). Bước kiểm: `reembed status` (mục 3) cho tới khi `*_coverage_pct=100.0` ở generation active và `queue=embedding state=available|retryable|running count=0`.
Pause nhanh khi có sự cố provider không cần rollback: đặt `false`, redeploy `api` + `worker`; bật lại theo đoạn trên (plan mục 7 bước 5).

## 2. Công tắc theo user và provider của từng generation

`app_user.settings.semantic_suggest` (mặc định `true`, SPEC l.121/1216; FU-OWNER-SEMDEFAULT ở mục 14). Chính sách quyết theo **`provider` của generation đích**, không theo provider active của deployment (BE-3; plan 2.15, 2.17, 2.18 hàng 5/7/11, SPEC §6.10):

| Việc | Generation `tei` | Generation `openai_compat` |
|---|---|---|
| user tắt (`PATCH {false}`) | giữ vector, vẫn enqueue/embed; `semantic_reason:"disabled_user"` ở query | `store.DeleteUserExternal` xoá vector của user trong **mọi** generation còn bảng (`state ≠ dropped`, kể cả retired hết cửa sổ), mọi enqueue/job/Reconcile bỏ user đó; job đang chờ → `skipped_user_off`, không gửi gì ra provider |
| user bật lại (`PATCH {true}`) | không cần backfill | trong cùng tx chèn `reembed_user` (Reconcile(User) cho **mọi** generation `openai_compat` ∈ R); bị `409 semantic_unavailable` nếu `semantic_available=false` hoặc breaker API đang mở |
| R trộn provider (`tei` active + `openai_compat` pending/retired) | user off vẫn được enqueue vào `tei` | user off bị bỏ ở `openai_compat` |

Giới hạn đã biết: request provider đã bay trước commit của `PATCH {false}` không thu hồi được (threat model L-7); job sau đó bị chặn ở bước 5 vì đọc `app_user FOR SHARE`. Dữ liệu đã gửi tới dịch vụ bên ngoài không thu hồi được từ phía engram (copy `#timkiem` nói rõ điều này).
Dò lỗi một user: `compose run --rm worker /app/worker reembed user --user <uuid> --dry-run` (chỉ UUID, không email; in `skipped_user_off`, `would_delete_user_off`).

## 3. `worker reembed` — lệnh vận hành

Cú pháp lấy từ `cmd/worker/reembed.go` (`worker reembed help` in lại). Mọi lệnh `reembed` tự mở pool DB từ `DATABASE_URL`.

| Lệnh | Việc | Ghi chú an toàn |
|---|---|---|
| `reembed all [--generation N] [--dry-run]` | Reconcile(All) đồng bộ trong process này cho mọi generation ∈ R (hoặc đúng N, N phải ∈ R) | `--dry-run` **không** INSERT/UPDATE/DELETE, không enqueue, không gọi provider; chỉ in `would_enqueue`, `would_delete_orphan`, `would_delete_user_off`. Không `--dry-run` cần `SEARCH_SEMANTIC_ENABLED=true` và provider ≠ noop |
| `reembed user --user <uuid> [--dry-run]` | Reconcile(User) | UUID, không email; cùng quy tắc `--dry-run` |
| `reembed status` | mỗi generation: `state`, `provider`, `*_vectors`, `*_targets`, `*_coverage_pct` (item/tag); `queue=embedding state=<…> count`; `oldest_available_age_seconds`; `dead_letter_count` | không tên/q; chạy được cả khi deployment tắt |
| `reembed deadletter list [--generation N]` | in `dead_letter_count` và `job_id` (không in args) | chạy được khi tắt |
| `reembed deadletter retry [--generation N]` | thử lại job embed đã `discarded` | cần deployment bật; in `dead_letter_found/retried/failed` |
| `reembed generation create|backfill|index|verify|flip|rollback|retire|drop …` | vòng đời generation, mục 4–5 | `flip`/`rollback`/`drop` cần `--yes`; `drop` cần `--accepted-evidence <file>`; `--generation` là 1..9999 |

Dòng kết quả Reconcile: `generation=<N> scanned=… missing=… stale=… enqueued=… orphan_deleted=… user_off_deleted=… skipped_user_off=… would_enqueue=… would_delete_orphan=… would_delete_user_off=…` (+ `stop_reason=` nếu dừng sớm). Đọc: `missing`/`stale` > 0 sau backfill nghĩa là chưa phủ; `would_delete_orphan` > 0 ở `--dry-run` nghĩa là còn vector của target đã xoá.
`status` đếm job `discarded` trong **cả queue** `embedding`; `dead_letter_count` và `deadletter list/retry` chỉ tính `embed_item`/`embed_tag` (`deadLetterKinds()` trong `reembed.go`).

## 4. Bootstrap g1 tự động và cutover 7 bước

### 4A. Bootstrap g1 (lần bật đầu tiên, không có generation nào)

Tự động, không có lệnh bắt buộc (plan 2.15, SPEC §6.6). Điều kiện (một hàm `generation.Bootstrap`, gọi ở worker boot **và** ở `reembed generation create --bootstrap --client primary`): `SEARCH_SEMANTIC_ENABLED=true`, provider ≠ noop, **có calibration cho danh tính client primary**, và **chưa có hàng generation nào**.

1. Worker boot (tx của `Bootstrap` commit trước `river.Client.Start`) → g1 `pending`, `bootstrap=true`, bảng + HNSW tạo ngay khi rỗng. Không active nên `semantic_available=false`.
2. Từ commit, mọi mutation item/tag enqueue vào R (gồm pending); sau `Start` worker chèn `reembed_all` → backfill g1 (batch 64, concurrency 2 của queue `embedding`, tôn trọng `Retry-After`).
3. Job periodic `embedding_bootstrap_flip` (`RunOnStart` + chu kỳ `1m`) chạy `verify`; khi đạt (mục 4B bước 4: bỏ mẫu recall nếu g1 < 200 vector, deployment rỗng flip ngay ở lần chạy đầu) thì **tự flip** g1 → active, `NOTIFY embedding_generation_changed` xoá cache Pin và availability → `semantic_available=true`. Chỉ generation `bootstrap=true` được tự flip. Tệ nhất ≈ một chu kỳ + thời gian backfill, không cộng TTL cache 30 s.
4. Theo dõi: `reembed status` (g1 `state=pending` → `active`, coverage → 100.0), `GET /api/v1/readyz` → `semantic_available`. Muốn thử tay trước chu kỳ: `reembed generation verify --generation 1` (không ghi vector/job, chỉ ghi báo cáo verify; in `passed=` và `reason=`).

Dừng nếu: log warn `chưa có calibration …` (image thiếu entry → mục 12 bước 3), `khởi tạo embedding client set thất bại lúc boot` (kiểm env provider; log chỉ có `provider`, `error_class`), `embedding_dead_letter_jobs > 0`, breaker mở > 10 phút, coverage không tới 100 % → đặt `SEARCH_SEMANTIC_ENABLED=false` (mục 1), chẩn đoán, bật lại.

### 4B. Cutover thủ công 7 bước (mọi lần đổi model, revision, instruction, dims, prefix, preprocessing, partitions, m, ef_construction sau bootstrap)

Đổi bất kỳ tham số danh tính nào là **generation mới**, không `ALTER` (plan 2.15). Mỗi bước in id/state/số đếm; một bước lỗi thì dừng, không nhảy bước.

**Chuẩn bị (trước bước 1).**
1. Chạy `worker semeval` cho model mới (mục 12 bước 3 là mẫu), commit report + entry `calibration.go` bằng PR nhỏ, merge, **build + deploy image mới** — `create` từ chối generation thiếu calibration (`ErrCalibrationMissing`, gate 5).
2. Đặt client mới ở `EMBEDDING_SHADOW_*` trong `.env.production` (bộ đủ trường như `EMBEDDING_*`; `EMBEDDING_SHADOW_PROVIDER` rỗng = tắt) rồi redeploy `api` + `worker`. `ClientSet.Match` so `Identity.Key()` cả bảy trường trên cả hai bộ client; không khớp thì query `degraded` (`generation_unconfigured`) và job `JobSnooze(5m)`, không bao giờ gọi provider vào generation cũ. **Giữ client của model cũ cấu hình suốt cửa sổ rollback** (mục 5) vì rollback cần client khớp danh tính cũ.
3. Host phải chịu được hai provider cùng lúc trong lúc backfill (mutation fan-out cả active lẫn pending); không đủ thì có cửa sổ lexical-only có lịch (plan 2.15 bước 1).

| # | Lệnh (qua `compose run --rm worker /app/worker …`) | Điều kiện dừng / lỗi cố định |
|---|---|---|
| 1 | `reembed generation create --client shadow [--partitions N --m N --ef-construction N]` → `created=true generation=N state=pending …` (từ commit mutation fan-out vào cả active và pending). Cấu hình lấy từ env, ngưỡng từ `calibration.go`, không nhận key qua argv. Shape: partitions 1..256, m 2..100, ef_construction 4..1000 và ≥ 2·m; để trống = mặc định. | `a pending generation already exists` (tối đa một pending: `retire` nó trước), `generation: calibration missing …` (dừng: calibrate trước), `generation tables do not match declared dims`, `--client shadow needs EMBEDDING_SHADOW_PROVIDER configured` |
| 2 | `reembed generation backfill --generation N` (Reconcile(All) trên pending; in dòng kết quả mục 3). Theo dõi `reembed status`. | Dừng nếu `embedding_dead_letter_jobs > 0`, `provider_429` kéo dài, breaker worker mở; xử lý theo mục 6 rồi chạy lại (idempotent) |
| 3 | `reembed generation index --generation N` → `expected built repaired already_valid valid ready=true` (`CREATE INDEX CONCURRENTLY` từng partition, rồi `ON ONLY` parent + `ATTACH PARTITION`; chạy lại sửa index hỏng) | `ready=false` hoặc `generation index is not ready` → chạy lại; không sang bước 4 |
| 4 | `reembed generation verify --generation N` dưới watermark `W`: không còn job embed trước `W` ở available/retryable/running; Reconcile dry-run = 0 missing + 0 stale **cả hai corpus**; toàn vẹn (hàng/partition, không vector target đã xoá, dims); recall mẫu 200 query ANN vs exact đạt C2 (bỏ qua khi < 200 vector). Thoát khác 0 nếu `passed=false`, kèm `reason=` | `reason` ∈ `index_not_ready`, `jobs_pending`, `coverage_incomplete`, `integrity_failed`, `recall_below_target`, `generation_not_receiving`, `recall_sample_short`, `recall_baseline_unavailable`, `recall_path_invalid`. Không flip ở 95 % (plan 2.15). `recall_baseline_unavailable` = oracle exact của tenant lớn hết ngân sách, **fail closed**: knob timeout `TODO(T23)` (FU-T19-FLIPCOST) |
| 5 | `reembed generation flip --generation N --yes [--reason TOKEN]` (tx exclusive; pending → active, active cũ → `retired` + `rollback_until = now() + SEARCH_ROLLBACK_WINDOW`, `NOTIFY`). Từ chối nếu verify > 1 h hoặc có mutation chưa phủ. Sau đó `reembed status` + `GET /api/v1/readyz`. | `lifecycle: last verification is older than one hour` → chạy lại `verify`; `generation does not cover every eligible target`; `--yes` thiếu. **Quiet window:** flip/rollback quét coverage trong lock (O(target sống + vector)), mutation đợi → chạy ngoài giờ cao điểm; thời lượng đo được `TODO(T23)` (FU-T19-FLIPCOST) |
| 6 | `reembed generation rollback --generation <old> --yes` (xem mục 5) | |
| 7 | `reembed generation retire` rồi `drop` (xem mục 5) | |

Sau flip: nếu model mới dùng bộ `EMBEDDING_SHADOW_*` thì **đừng** gỡ nó cho tới khi cửa sổ rollback đóng; việc hoán đổi sang bộ `EMBEDDING_*` làm ở lần redeploy sau, cả `api` và `worker`, và client model cũ chỉ gỡ sau `retire`/`drop`.

## 5. Rollback và drop

- **Rollback** (`reembed generation rollback --generation <old> --yes [--reason TOKEN]`): chỉ khi bản retired còn trong cửa sổ (`SEARCH_ROLLBACK_WINDOW`, mặc định `168h`, hợp lệ 1m..8760h) **và** đã catch up cùng điều kiện verify (retired trong cửa sổ vẫn nhận mutation). Lỗi cố định: `lifecycle: rollback window closed` (ngoài cửa sổ), `lifecycle: generation_not_caught_up`. Rollback cần client khớp danh tính cũ đang cấu hình. Chạy ngoài giờ cao điểm (quét coverage trong lock, `TODO(T23)`).
- **Retire** (`reembed generation retire --generation N`): pending → bỏ (rời R, đóng cửa sổ); retired → đóng cửa sổ sớm. Active bị từ chối (`lifecycle: generation is active`). Không ghi SQL tay.
- **Drop** (`reembed generation drop --generation N --yes --accepted-evidence <file>`): chỉ `retired`, sau `rollback_until`, và file bằng chứng phải **tồn tại trong container** (CLI chỉ kiểm file thường tồn tại, không đọc nội dung; lifecycle chỉ đòi đường dẫn khác rỗng). Mount file read-only: `compose run --rm -v "<đường dẫn trên host>:/evidence/accepted.md:ro" worker /app/worker reembed generation drop --generation N --yes --accepted-evidence /evidence/accepted.md`. Từ chối nếu active, trong cửa sổ hoặc thiếu evidence (`lifecycle: drop refused by guard`). Drop không hoàn tác: bảng vector bị xoá.
- Sự cố provider **không** cần rollback generation: breaker + `degraded` (mục 6); tắt hẳn bằng mục 1.
- Binary rollback phải tương thích schema `0008`/`0009` (plan mục 7 bước 2); migration chỉ forward, `down` chỉ cho dev.

## 6. Degrade: router / OpenRouter / TEI chết, breaker, phục hồi không storm

Hành vi (plan 2.12, 2.21, SPEC §6.6): provider timeout/5xx/429/refused/bad response → breaker mở 60 s (API: **một** lỗi; worker: 3 lỗi liên tiếp) → lexical-only, `semantic:false`, `semantic_reason:"degraded"`, không toast. `semantic_available` **không** lật theo breaker (tĩnh). Quick-add, CRUD item/tag, lexical suggest/search vẫn 2xx; enqueue không lỗi; `/readyz` 200. Half-open: đúng **một** request thử mỗi process mỗi 60 s. Worker: job gặp breaker mở → `JobSnooze(còn lại + jitter 0–10 s)`, 429 có `Retry-After` → snooze tới `min(Retry-After, 1 h)`; snooze không tốn attempt; retry `min(1m·2^(attempt−1), 1h)·(1+j)`, `j ∈ [0, 0,2]`, `MaxAttempts = 30` ⇒ dead-letter sau ≥ 24 h.

Phân loại nhanh (log `error_class`, label `embedding_provider_requests_total{provider,op,outcome}`; mã lý do ở `internal/worker/metrics.go`):

| Dấu hiệu | Nghĩa thường gặp | Việc làm |
|---|---|---|
| `outcome=refused` / `provider_refused` | router/provider không nhận kết nối (container router dừng, sai mạng Docker, URL sai) | kiểm router (cùng host, ADR 0004; tên container và lệnh `TODO(T24-host)`), mạng Docker, `EMBEDDING_BASE_URL` (rule URL `urlrule.go`: `https://` bất kỳ; `http://` chỉ IP loopback/RFC 1918/`100.64.0.0/10`/`fc00::/7`) |
| `http_5xx` / `provider_5xx` | OpenRouter hoặc model provider phía sau lỗi | chờ; kiểm trạng thái upstream; không đổi model giữa sự cố |
| `http_429` / `provider_429` | hết quota/hạn mức; worker tôn trọng `Retry-After` | giảm tải backfill (không có knob concurrency: hằng 2 × batch 64), chờ; kiểm chi phí/quota ở nhà cung cấp |
| `timeout` / `provider_timeout` | quá `EMBEDDING_QUERY_TIMEOUT` (rỗng → `4s` với `openai_compat`) hoặc `EMBEDDING_DOCUMENT_TIMEOUT` (`30s`) | kiểm độ trễ router→upstream |
| `bad_response` / `provider_bad_response`, `dims_mismatch` | provider trả sai dims/NaN/format; `EMBEDDING_DIMENSIONS` không khớp generation | kiểm `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS`; không flip; tăng `embedding_generation_mismatch_total` |
| TEI (`EMBEDDING_PROVIDER=tei`, profile compose `semantic`) | chỉ amd64 (digest `TEI_IMAGE`); `bro` là ARM64 nên dùng `openai_compat` (OQ-23) | nếu dùng TEI ở host khác: kiểm `GET {TEI_URL}/health` từ trong mạng Docker |

**Kiểm phục hồi không storm** (sau khi provider sống lại):
1. `embedding_breaker_open{process="api"}` và `{process="worker"}` về `0`; response `/suggest` trở lại `semantic:true` trong ≤ ~60 s (một probe half-open đủ).
2. Tốc độ lời gọi provider không vọt: `rate(embedding_provider_requests_total[1m])` chỉ ≈ probe half-open (≤ 1/60 s/process) cho tới khi breaker đóng, rồi bị chặn bởi concurrency 2 × batch 64 của worker; không có đỉnh theo số job tồn.
3. Backlog xả dần: `reembed status` → `queue=embedding state=available|retryable` giảm, `oldest_available_age_seconds` giảm, `embedding_jobs_total{outcome="snoozed"}` ngừng tăng nhanh.
4. Không job nào bị dead-letter vì lần chết ngắn: `embedding_dead_letter_jobs` vẫn `0`, `dead_letter_count=0`.
5. Nếu bất thường: tắt hẳn bằng mục 1.

## 7. Alert (plan 2.21)

Repo **không** có cấu hình Prometheus/Alertmanager; ngưỡng dưới đây cấu hình trên host (`TODO(T24-host)`), đến lúc đó kiểm tay `/metrics` hằng ngày trong 24 h đầu (mục 12 bước 5). Biểu thức PromQL là gợi ý theo tên metric thật:

| Alert | Biểu thức gợi ý | Việc làm |
|---|---|---|
| Breaker mở > 10 phút | `max by (provider,process) (embedding_breaker_open) == 1` suốt 10 phút | mục 6 |
| Dead-letter > 0 | `embedding_dead_letter_jobs > 0` | `reembed deadletter list`, chẩn đoán nguyên nhân, `deadletter retry` khi provider khoẻ |
| Lag p95 > 10 s trong 15 phút, ngoài backfill | `embedding_job_lag_seconds{role="active"} > 10` suốt 15 phút (gauge **đã là p95** của cửa sổ 15 phút; mỗi `(corpus, role)`) | loại trừ cửa sổ backfill/cutover; mục 6 |
| Mismatch tăng | `increase(embedding_generation_mismatch_total[10m]) > 0` (nhãn `reason` ∈ `dims`, `model`, `hash`, `unconfigured`) | `unconfigured` = client không khớp danh tính generation hoặc thiếu calibration (mục 1, 4B bước chuẩn bị) |
| Canary < 0.99 | `embedding_canary_min_cos < 0.99` (và `increase(embedding_canary_drift_total[1h]) > 0`) | canary chạy lúc boot và mỗi giờ (`embedding_canary`), so 8 chuỗi hằng với hàng generation; **không tự cutover**: cân nhắc cutover thủ công (mục 4B) |
| Coverage active < 99 % sau backfill | `embedding_generation_coverage_ratio{generation="<active>"} < 0.99` cho từng `corpus` | `reembed all --dry-run` rồi `reembed all` |

**Khoảng trống đã biết (nói thẳng):**
- `embedding_jobs_total{kind,outcome}` chỉ có `kind` ∈ `embed_item`, `embed_tag` (`obs.EmbeddingJobKinds`); `embedding_dead_letter_jobs`, `reembed deadletter` và `dead_letter_count` cũng chỉ tính hai kind đó. Job `reembed_user`, `reembed_all`, `embedding_canary`, `embedding_bootstrap_flip` hỏng/bị discard **không** hiện ở metric nào; chỉ thấy qua `reembed status` (`queue=embedding state=discarded|retryable`) và log worker (manifest follow-up về mở rộng tập kind: chưa đóng).
- `semantic_decisions_total{reason}`, `search_vector_path_total{corpus,path}`, `search_vector_underfill_total{corpus}`, `search_lexical_partial_total{corpus}`, `semantic_query_cache_total{result}`, `suggest_latency_seconds{mode,scope,semantic}` có sẵn để xem hành vi, nhưng plan 2.21 chưa gắn alert; đặt ngưỡng sau khi có số đo `TODO(T23)`.
- Mã lý do `ErrorClassForJobReason` chưa có caller runtime (follow-up FU-T20A-ERRCLASS): log job dùng chuỗi lý do literal.

## 8. Model pin hiện hành

Bảng điền ở stage 24-2 sau `worker semeval` và bootstrap thật. **Chưa có giá trị thật** — đừng suy ra từ mặc định trong repo.

| Trường | Giá trị | Nguồn |
|---|---|---|
| generation id | `TODO(T24-host)` (g1 nếu bootstrap) | `reembed status` |
| state | `TODO(T24-host)` | `reembed status` |
| provider | `openai_compat` (ADR 0004; `bro` ARM64, TEI không dùng) — xác nhận `TODO(T24-host)` | `.env.production` `EMBEDDING_PROVIDER` |
| model | `TODO(T24-host)` (mặc định config: `openai_compat/openrouter/qwen/qwen3-embedding-8b`) | `Model()` của client = `openai_compat/` + `EMBEDDING_MODEL` |
| `model_version` | `TODO(T24-host)` (định dạng `dims=<d>;instr=<sha8>`; nếu giữ mặc định instruction và `dims=1024` thì kỳ vọng `dims=1024;instr=97581580`, **phải đối chiếu với report**) | `OpenAIModelVersion(dims, instruction)`; report `worker semeval` |
| dims | `TODO(T24-host)` (mặc định 1024) | `EMBEDDING_DIMENSIONS`, report |
| `semantic_min_cos` | `TODO(T24-host)` (lưới 0.30–0.90 bước 0.01, FPR ≤ 5 %, recall ≥ 0.60) | report `docs/benchmarks/semantic-eval/report-<slug>-<dims>-<yyyymmdd>.json`, entry `calibration.go` |
| calibration report | `TODO(T24-host)` | đường dẫn trong repo |
| precision / recall / FPR / n cặp | `TODO(T24-host)` | report |
| canary `embedding_canary_min_cos` | `TODO(T24-host)` (cảnh báo dưới 0.99) | `/metrics` |
| Advisor decision ngưỡng (gate 5) | `TODO(T24-host)` (id) | `decisions/DECISIONS.md` ngoài repo |
| partitions / m / ef_construction | `TODO(T23)` (mặc định DDL: 16 / 16 / 128) | `reembed status`, generation row |
| image đang chạy (digest/SHA) | `TODO(T24-host)` | host |

## 9. Lệnh compose chuẩn (Task 24)

Chạy từ thư mục repo trên host (đường dẫn `TODO(T24-host)`); `.data/deploy/compose.prod.yml` là override của host (ngoài git; tên service và biến thật `TODO(T24-host)`). Secret chỉ ở `.env.production`:

```sh
compose() {
  docker compose -p engram \
    --env-file infra/image-pins.env --env-file .env.production \
    -f infra/docker-compose.yml -f .data/deploy/compose.prod.yml "$@"
}

# dạng đầy đủ không bí danh:
docker compose -p engram --env-file infra/image-pins.env --env-file .env.production \
  -f infra/docker-compose.yml -f .data/deploy/compose.prod.yml \
  run --rm worker /app/worker reembed status
```

Quy tắc: không `set -x`/`bash -x` khi chạy, không `docker compose config` (in secret đã nội suy), không `-e NAME=giá-trị` cho secret, không dán `env` vào evidence. `/app/worker` là subcommand registry (`reembed`, `semeval`; `worker help` liệt kê); không Dockerfile mới cho production (`/out/worker` đã có).

**`worker semeval`** (calibration, chạy **một lần** trên host, cần provider thật; không cần `SEARCH_SEMANTIC_ENABLED=true`; từ chối nếu `EMBEDDING_PROVIDER=noop`): flag `--pairs <path>` (mặc định `docs/benchmarks/semantic-eval/pairs.v1.jsonl`, **tương đối**) và `--out <path>` (bắt buộc; từ chối nếu file đã tồn tại). Report ghi `pairs_file` đúng bằng giá trị `--pairs`, và `TestCalibrationEntriesHaveReports` đòi `pairs_file = docs/benchmarks/semantic-eval/pairs.v1.jsonl`, nên chạy với **đường dẫn tương đối mặc định** qua thư mục làm việc trong container và mount, không dùng đường dẫn tuyệt đối:

```sh
SCRATCH="$(mktemp -d)"; chmod 0777 "$SCRATCH"      # user nonroot (uid 65532) phải ghi được
compose run --rm -w /w \
  -v "$PWD/docs/benchmarks/semantic-eval:/w/docs/benchmarks/semantic-eval:ro" \
  -v "$SCRATCH:/w/out" \
  worker /app/worker semeval --out /w/out/report-<slug>-<dims>-<yyyymmdd>.json
# rồi copy report vào repo và commit bằng PR nhỏ của lane rollout (mục 12 bước 3)
```

Đầu ra không in input; `decision` ∈ `ok` | `decision_required` (exit code ≠ 0 khi `decision_required`: **không bật semantic**).

## 10. Checklist log — gate 8a (trước deploy lexical) và 8b (trước bật semantic)

Lý do: sau P05 chữ gõ để tìm (`q`) nằm trong query string của `GET /api/v1/suggest|search`; không lớp nào được ghi nó (plan 2.7, gate 8). Repo không chứa cấu hình nginx/Postgres production (`git ls-files` không có nginx/caddy/`postgresql.conf`; `infra/` chỉ có compose dev/CI), nên mục 1–2 và 5 **chỉ kiểm được trên host** và ghi dòng evidence ở `docs/phases/evidence/P05.md` (gate 8a). Chưa đạt → **không deploy lexical**. Nguồn: báo cáo T22 22-1c (FU-T24-DEPLOY-8A). Dùng marker tổng hợp, không bao giờ dùng `q` thật:

```sh
CANARY="zz8a-canary-$(date +%s)"    # chuỗi tổng hợp, không phải dữ liệu người dùng
```

| # | Kiểm (chạy trên `bro` **trước** deploy lexical) | Lệnh kiểm chính xác | Đạt khi |
|---|---|---|---|
| 1 | nginx: không `$request`, `$request_uri`, `$args`, `$query_string` trong `log_format` dùng cho `location /api/` (dùng `$uri` hoặc `$request_method $uri`, hoặc `access_log off` cho `/api/`); kiểm cả error log/debug log | `nginx -T 2>&1 \| grep -nE 'access_log\|log_format\|error_log\|\$request\b\|\$request_uri\|\$args\|\$query_string'` rồi đọc từng `log_format` được `location /api/` dùng. Thử thực: `curl -s -o /dev/null "https://<host>/api/v1/suggest?q=$CANARY"` (401 là bình thường, URL vẫn vào log nếu cấu hình sai) rồi `grep -R "$CANARY" /var/log/nginx/` | 0 dòng khớp; `log_format` của `/api/` không chứa biến query |
| 2 | Postgres: role API không log tham số bind | trong `psql` (chỉ-đọc): `SHOW log_parameter_max_length;`, `SHOW log_parameter_max_length_on_error;`, `SHOW log_statement;`, `SHOW log_min_duration_statement;`, `SHOW shared_preload_libraries;` (kiểm `auto_explain`/`pg_stat_statements`); `SELECT rolname, rolconfig FROM pg_roles WHERE rolname = '<api_role>';` và `SELECT * FROM pg_db_role_setting;`. Nếu cần: `ALTER ROLE <api_role> SET log_parameter_max_length = 0;` (owner thực hiện; agent không viết SQL trên production) | `log_parameter_max_length = 0` (và `..._on_error = 0`) cho role API, `log_statement` không phải `all`/`mod`, `auto_explain.log_parameters` không bật, không log statement kèm tham số |
| 3 | Access log của API không có query string | repo: `apps/api/internal/httpx/middleware.go` `AccessLog` chỉ ghi route pattern, method, status, `duration_ms`, `request_id` (cấm `RawQuery`); `semantic/cache.go` key theo HMAC(qn) | **đạt trong repo** (kiểm lại bằng `compose logs api \| grep -c "$CANARY"` = 0 sau bước 2 của mục 12) |
| 4 | Proxy Next (web → api) không log URL | repo: `apps/web/next.config.*` chỉ `rewrites()`, không có `logging`; trên host xác nhận web container không chạy cờ debug/`NODE_DEBUG`: `compose config` **không** dùng (in secret) — kiểm `docker inspect <web container> --format '{{.Config.Cmd}} {{.Config.Entrypoint}}'` | không có cờ debug, `grep -c "$CANARY"` trên log web = 0 |
| 5 | Lớp khác phía trước ghi URL `/api/` (Cloudflare/LB/CDN, log driver `json-file` của Docker nhận output proxy, fail2ban) | rà từng lớp thật của `bro`: `TODO(T24-host)`; kiểm `grep -R "$CANARY" /var/lib/docker/containers/*/*-json.log` (cần root) | 0 dòng khớp; mỗi lớp được liệt kê và xác nhận |
| 6 | **Gate 8b — copy** | mở `/en/privacy`, `/vi/privacy`, `/en/terms`, `/vi/terms` trên `bro`: có "bên thứ ba / third-party", mặc định bật + cách tắt (≈ trong Settings), thân entry vẫn mã hoá đầu-cuối, **không** còn chữ "sắp tới / upcoming"; trang landing `privacyBody1` nêu giả định L-8 (không tuyên bố tuyệt đối "không có cách nào đọc") | đủ ba ý và đúng với cấu hình thật; **chỉ kiểm lại trước bước bật semantic** (mục 12 bước 4) |

Câu công khai "access logs do not record search queries" chỉ đúng khi 1, 2 và 5 đã xác nhận; nếu một mục fail thì sửa host hoặc làm yếu câu đó **trước** khi copy live. Dòng evidence (mục 12 bước 1) ghi số mục đạt/không đạt và giờ, không ghi tên miền nội bộ hay đường dẫn log.

## 11. Token bucket theo process

Rate limit `search_read` của `GET /suggest` và `GET /search` là token bucket **in-memory theo `user_id` mỗi process** (`internal/httpx/tokenbucket.go`: 20 token/s nạp, dung lượng 40, trần 100 000 key; không dùng `rate_event` trong DB). Hệ quả: với **N instance `api`** mỗi user có thể dùng tới **N ×** hạn mức (≈ 20·N token/s); mỗi nhịp gõ tốn 2 token (`semantic=0` và `semantic=1`). P05 chạy một instance `api` trên `bro`; trước khi chạy nhiều replica phải thêm limiter dùng chung (ngoài phạm vi P05, plan mục 7). Khi chạm giới hạn: `429 rate_limited` + `Retry-After`, client giữ hàng và không toast đỏ.

## 12. Thứ tự rollout (plan mục 7, Task 24; chỉ khi P05 đã merge `develop` và Advisor mở stage 24-2)

Mỗi bước có điều kiện dừng và **một dòng evidence chỉ có số** (giờ UTC, id, số đếm; không tên, không `q`, không secret) dán vào `docs/phases/evidence/P05.md` mục rollout. Điều kiện vào: giá trị knob Task 23 đã được Advisor đồng bộ vào nhánh (mục 13); `pg_dump` có chỗ lưu.

1. **Checklist log gate 8a** (mục 10, 1–5). *Dừng nếu* bất kỳ mục nào không đạt hoặc chưa kiểm được. *Evidence:* `8a <giờ> items_passed=<n>/5 canary_hits=<n>`.
2. **`pg_dump` → migrate `0008`/`0009` → deploy image P05 với `SEARCH_SEMANTIC_ENABLED=false`** → kiểm lexical. Lexical `/suggest`/`/search`, help text trong app và copy legal Task 22 nằm cùng image nên live trước mọi bước bật semantic. Lệnh: `pg_dump` custom format (`-Fc`) ra file ngoài repo (dòng lệnh chính xác `TODO(T24-host)`: tên container/role/db), rồi migrate bằng service `migrate` (`/app/migrate up`), rồi `compose up -d api worker web` với `SEARCH_SEMANTIC_ENABLED=false`. Kiểm: `GET /api/v1/readyz` → 200 và `semantic_available:false`; lexical `GET /api/v1/suggest` bằng tài khoản thử → 200; không còn dấu marker `CANARY` trong log API/web/Postgres sau một request thử; `reembed status` chạy được. *Dừng nếu:* dump thất bại, migrate lỗi (không thử lại mù: binary rollback phải tương thích schema, restore từ dump theo SPEC §10.5), `/readyz` ≠ 200, lexical không 2xx, `semantic_available` ≠ false, marker lọt log. *Evidence:* `deploy <giờ> image=<sha7> migrations=0008,0009 dump_bytes=<n> readyz=200 semantic_available=false suggest_status=200 canary_hits=0`.
3. **Calibration trên host → PR → image mới.** Đặt env `openai_compat` trong `.env.production` (router trong mạng Docker, key chỉ trong file này, `SEARCH_SEMANTIC_ENABLED` vẫn `false`) → chạy `worker semeval` (mục 9) → nếu `decision=ok`: PR nhỏ của lane `rollout` với report `docs/benchmarks/semantic-eval/report-*.json` + entry thật trong `internal/embedding/calibration.go` (điền `calProductionPending`, `TODO(T24-host)`; guard bắt buộc `NonProductionOnly=false`, `MinCos` thuộc lưới, report `synthetic=false` và `decision=ok`) → `Go checks` xanh (`TestCalibrationEntriesHaveReports`) → Advisor ghi decision ngưỡng (gate 5) → merge → **build + deploy image mới** (calibration biên dịch vào binary). *Dừng nếu:* `decision_required` (recall < 0.60 hoặc không t nào đạt FPR ≤ 5 %): **không bật cho user**, gửi `decision_required`; CI đỏ; report không khớp entry. *Evidence:* `calibration <giờ> n_pairs=<n> threshold=<t> precision=<p> recall=<r> fpr=<f> ci_run=<id> head=<sha7> decision_id=<id> image=<sha7>`.
4. **Gate 8b rồi bật semantic.** Xác nhận copy legal/help live (mục 10 mục 6); redeploy `api` + `worker` với `SEARCH_SEMANTIC_ENABLED=true` + provider. Worker boot tạo g1 `pending` (bootstrap), `reembed_all` backfill (mutation trong lúc này enqueue vào pending), theo dõi: `reembed status` (coverage, `queue=embedding`, `oldest_available_age_seconds`, `dead_letter_count`), lag, `provider_429`, chi phí; `verify` đạt → `embedding_bootstrap_flip` tự flip (≤ 1 phút sau verify; NOTIFY xoá cache) → `GET /api/v1/readyz` có `semantic_available:true`. Tuỳ chọn thử tay: `reembed generation verify --generation 1`. *Dừng (đặt `SEARCH_SEMANTIC_ENABLED=false`, mục 1) nếu:* copy chưa live; log `chưa có calibration …`; `embedding_dead_letter_jobs > 0`; `provider_429` kéo dài; breaker mở > 10 phút; coverage không tới 100 %; `verify` `passed=false` kéo dài. *Evidence:* `enable <giờ> 8b=ok boot_generation=1 backfill_scanned=<n> missing=<n> stale=<n> enqueued=<n> dead_letter=<n> backfill_minutes=<n> lag_p95_s=<n> flipped_at=<giờ> readyz_semantic_available=true`.
5. **Quan sát 24 h:** `suggest_latency_seconds{semantic}` và latency miss `openai_compat` thật (`embedding_provider_latency_seconds{op="query"}`; target 350 ms của C1-M áp cho stub 90 ms, **không** áp cho `openai_compat` ~2,3 s; đây là số vận hành báo P06, OQ-21), `embedding_breaker_open`, dead-letter, canary. *Evidence:* `observe <giờ bắt đầu>..<giờ kết thúc> suggest_p95_ms=<n> miss_query_p95_ms=<n> breaker_open_minutes=<n> dead_letter=<n> canary_min_cos=<x>`. Báo P06 (không có tên/q).

Không bước nào chờ một đường đang tắt. `0010_search_lexical_drop_global_trgm` (nếu Task 23 tạo) chỉ deploy sau report benchmark, ngoài chuỗi trên (plan mục 7 bước 6).

## 13. Knob do Task 23 chốt (`TODO(T23)`)

Không điền số suy đoán. Giá trị mặc định trong repo (từ `config.go`/`.env.example`, **không** phải số đã đo) chỉ để biết tên và nơi đặt; giá trị production ghi vào đây khi Advisor đồng bộ report Task 23 (có run URL + head SHA):

| Knob | Nơi đặt | Mặc định trong repo | Giá trị production |
|---|---|---|---|
| ngưỡng exact/ANN | `SEARCH_EXACT_MAX_VECTORS` | `5000` | `TODO(T23)` |
| trần fallback exact (underfill) | `SEARCH_EXACT_FALLBACK_MAX_VECTORS` | `20000` | `TODO(T23)` |
| `ef_search` | `SEARCH_HNSW_EF_SEARCH` | `64` | `TODO(T23)` |
| `max_scan_tuples` | `SEARCH_HNSW_MAX_SCAN_TUPLES` | `20000` | `TODO(T23)` |
| iterative scan | `SEARCH_HNSW_ITERATIVE_SCAN` | `relaxed_order` | `TODO(T23)` |
| ngân sách nhánh vector / ngân sách tối thiểu cho fallback | `SEARCH_VECTOR_BRANCH_TIMEOUT` / `SEARCH_VECTOR_FALLBACK_MIN_BUDGET` | `80ms` / `30ms` | `TODO(T23)` |
| partitions / `m` / `ef_construction` của generation | `reembed generation create --partitions --m --ef-construction` (đổi = generation mới) | DDL: 16 / 16 / 128 | `TODO(T23)` |
| chi phí flip/rollback (quét coverage trong lock) và timeout oracle recall tenant lớn | cửa sổ yên tĩnh ở mục 4B/5 | chưa đo | `TODO(T23)` (FU-T19-FLIPCOST) |
| lựa chọn planner ở thể tích thật (GIN trigram cho fuzzy, ghi chú FU-SL-1) | báo cáo benchmark | chưa đo | `TODO(T23)` (FU-SL-1) |
| drop index trigram toàn cục (`0010`) | migration tuỳ chọn | không có | `TODO(T23)` |
| reconcile full / build HNSW từng partition (thời gian) | báo cáo benchmark | chưa đo | `TODO(T23)` |

## 14. Việc chờ chủ repo và việc người vận hành

- **FU-T22-MANUAL — checklist thủ công đa trình duyệt/thiết bị: trạng thái `pending owner`.** CI chỉ có Desktop Chrome (plan Task 22, FE-6/FE-7); chưa có kết quả nào. Dữ liệu thử: chỉ chữ tổng hợp công khai (ví dụ `nimbus`, `wifi`), không dùng bí mật thật. Hành vi mong đợi (plan 2.1): gõ không sạch (dán, thả, autocorrect, text replacement, commit composition nhiều grapheme, undo của ghi từ ngoài) **taint** draft: không có `GET /suggest` kèm `q` cho tới Enter, help text đổi thành "Nhấn Enter để tìm / Press Enter to search", Enter gửi một `/search` với `semantic=0`; kiểm bằng tab Network. Ghi `pass | fail | n/a` + phiên bản trình duyệt/OS + ngày.

  | # | Trình duyệt / cách nhập | Bước | Mong đợi | Kết quả |
  |---|---|---|---|---|
  | 1 | Safari macOS + Telex | gõ `đường` bằng Telex (`dduwowngf`); gõ `ma` rồi commit | không gửi gì khi đang composition (`compositionstart`…`end`); sau commit gõ sạch gửi `/suggest` theo 2.1; ghi lại chuỗi `inputType` (`insertFromComposition`/`insertText`) | pending owner |
  | 2 | Safari macOS: bấm ≈ giữ focus (RV-T17-2-FE1-5; WebKit mới chỉ có unit test) | stack có semantic, gõ `nim`, bấm ≈ | textarea giữ focus, danh sách vẫn mở | pending owner (cần stack semantic) |
  | 3 | iOS Safari autocorrect | gõ `pasword`, nhận autocorrect thành `password` | draft taint: không `/suggest` kèm `q` sau thay thế, help "Nhấn Enter để tìm"; Enter → một `/search` `semantic=0` | pending owner |
  | 4 | iOS Safari text replacement (Cài đặt → Bàn phím → Thay thế văn bản, ví dụ `omw`) | gõ phím tắt, chấp nhận | taint như dòng 3 | pending owner |
  | 5 | Firefox desktop dán | copy `nimbus`, Ctrl+V vào omnibox | taint, không `/suggest` kèm `q`; Enter → `/search` | pending owner |
  | 6 | Firefox desktop undo | gõ `nim`, Ctrl+Z, Ctrl+Shift+Z | undo/redo của chính phím đã gõ: ghi lại có taint không (`historyUndo`/`historyRedo`); không request nào chứa chữ sau dấu `:` | pending owner |
  | 7 | Android Chrome + Gboard: chip clipboard | copy `nimbus`, chạm chip clipboard của Gboard | taint (ghi chuỗi `inputType`, ví dụ `insertFromPaste` hay `insertText`) | pending owner |
  | 8 | Android Chrome + Gboard: chip gợi ý | gõ `nim`, chạm một từ gợi ý | ghi `inputType`; ≤ 64 grapheme commit qua composition là rủi ro còn lại đã chấp nhận C-4 (FE-24) | pending owner |
  | 9 | Mobile 390 px: dropdown + toast Undo (FU10) | quick-add một item (toast hiện), gõ `nim` | popover kết thúc phía trên toast; hàng hành động cuộn được trong popover | pending owner |
  | 10 | Bàn phím trên danh sách dài (O1b) | `nimbus` + Enter, rồi Tab từ omnibox | popover tràn là một điểm dừng Tab có vòng focus thấy được; Esc về textarea và đóng | pending owner |

  Cách ghi `inputType` (chỉ ghi kiểu, không ghi chữ): trong console DevTools **trước** khi gõ: `document.querySelector('#omni textarea').addEventListener('beforeinput', e => console.log(e.inputType))`.
- **FU-OWNER-SEMDEFAULT (chủ repo quyết):** `semantic_suggest` mặc định `true` + `openai_compat` bên ngoài ở production ⇒ tên/tag/hint/query của user mới gửi tới bên thứ ba cho đến khi họ tắt. Đổi sang mặc định tắt cần PR contract (SPEC + migration + copy), chỉ theo quyết định của chủ repo (advisor-dec-325). Gate 8b (mục 10 mục 6) là biện pháp bắt buộc trước khi bật.
- **FU-T13-OAS:** mô tả 409 của `meSettingsPatch` trong OpenAPI còn ghi "provider probe" (nên là `semantic_available=false` hoặc breaker mở): sửa chữ ở PR contract riêng (ngoài file của lane rollout).
