# P05 Search — mẫu ghi phần cứng và cấu hình của một run

Sao chép file này vào báo cáo của run (`docs/benchmarks/P05-search/results/<YYYY-MM-DD>-<sha7>-<profile>-<arch>.md`) và điền **mọi** dòng. Dòng không biết → ghi `unknown`, không bỏ trống. Không điền secret, hostname hay IP thật.

Quy trình đo: [protocol.md](protocol.md); target: [targets.md](targets.md).

> **Không phải host production `bro`.** Số đo từ runner CI (hoặc máy khác) không thay cho latency vận hành thật trên `bro`.

## Run

| Mục | Giá trị |
|---|---|
| Run URL | |
| Job / conclusion | `search-bench` / |
| Head SHA của run | |
| Commit `targets.md` (tổ tiên của head SHA?) | `<sha>` / kết quả `git merge-base --is-ancestor` (exit code): |
| Profile | `smoke` \| `full` |
| `SEARCH_BENCH_SEED` | `20261102` (khác → ghi lý do) |
| Hash dataset (in ra bởi `dataset.go`) | |
| Ngày chạy (UTC) | |

## Máy chạy

| Mục | Giá trị |
|---|---|
| Runner (`runs-on`) | `ubuntu-24.04-arm` \| `ubuntu-latest` \| khác: |
| Lệch kiến trúc so với `bro` (ARM64)? | có / không (nếu có: giải thích) |
| `uname -m` | |
| CPU (model, số core/thread) | |
| RAM (`free -m`, đầu job) | |
| Disk (`df -h`, đầu job; trống / tổng) | |
| Precheck disk (≥ 1,5 × ước lượng) | đạt / không (số): |
| OS / kernel | |

## Phần mềm

| Mục | Giá trị |
|---|---|
| Postgres version | |
| pgvector version | |
| Image Postgres (`POSTGRES_IMAGE` digest từ `infra/image-pins.env`) | |
| Go version | |
| Build tags | `searchbench` |

## Cấu hình Postgres

| Tham số | Giá trị |
|---|---|
| `shared_buffers` | |
| `work_mem` | |
| `maintenance_work_mem` | |
| `effective_cache_size` | |
| `max_parallel_workers_per_gather` | |
| `max_parallel_maintenance_workers` | |
| `wal_level` / `max_wal_size` | |
| `synchronous_commit` | |
| `random_page_cost` | |
| Khác khác mặc định (liệt kê) | |

## Knob search đã dùng

| Knob | Giá trị |
|---|---|
| `SEARCH_EXACT_MAX_VECTORS` | |
| `SEARCH_EXACT_FALLBACK_MAX_VECTORS` | |
| `SEARCH_HNSW_EF_SEARCH` | |
| `SEARCH_HNSW_MAX_SCAN_TUPLES` | |
| `SEARCH_HNSW_ITERATIVE_SCAN` | |
| `SEARCH_VECTOR_BRANCH_TIMEOUT` | |
| `SEARCH_VECTOR_FALLBACK_MIN_BUDGET` | |
| `pg_trgm.similarity_threshold` / `pg_trgm.word_similarity_threshold` | |
| `min_cos` benchmark (từ `targets.md`) | |
| Partitions / `hnsw_m` / `hnsw_ef_construction` của generation | |
| Stub embed (cache miss) | 90 ms (khác → ghi lý do) |
| Rate limit nới (giá trị `search_read`) | |
| Concurrency đo | 1 / 8 / 32 (target áp ở 8) |
| Request mỗi kịch bản (≥ 2000) | |

## Kích thước và thời gian build

| Mục | Giá trị |
|---|---|
| Số item / tag / vector đã seed | |
| Heap `item_embedding_g1` / `tag_embedding_g1` | |
| Index HNSW (tổng, mỗi partition) | |
| Byte/vector (heap + index) | |
| Thời gian build HNSW từng partition / giây mỗi vector | |
| Thời gian seed | |
| Tổng thời gian job | |
| WAL phát sinh (nếu đo) | |

## Ghi chú và bất thường

(runner bị thay thế, giảm tenant nhỏ theo quy tắc dừng, retry, warning, `user-dec` liên quan…)
