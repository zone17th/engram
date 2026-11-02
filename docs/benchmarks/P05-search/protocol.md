# P05 Search — protocol benchmark

Nguồn: [plan P05](../../plans/2026-11-02-P05-search.md) mục 2.23, gate 6, Task 10, Task 23, mục 6 (P05-C1, P05-C2); advisor-dec-243, advisor-dec-244 (OQ-17, OQ-20, OQ-21). Target và định nghĩa recall/underfill nằm ở [targets.md](targets.md) (đóng băng, phải có trong lịch sử trước run `full` đầu tiên); mẫu ghi phần cứng ở [hardware-template.md](hardware-template.md).

Benchmark chỉ dùng **dữ liệu tổng hợp**: không có body entry, không dữ liệu người dùng thật, không provider ngoài (user-dec-016).

## 1. Dataset

Sinh bởi `internal/searchbench/dataset.go` (build tag `searchbench`):

- Seed `SEARCH_BENCH_SEED=20261102`, PRNG `math/rand/v2` PCG; cùng seed → cùng bytes; **hash dataset được in ra** và kiểm cố định trong `TestDatasetDeterministic`.
- Seed vào DB bằng `pgx.CopyFrom` thẳng vào `item`, `tag`, `item_tag` và bảng generation g1 (`textnorm` thật cho `name_normalized`); lexicon vi/en tổng hợp ở `packages/search-fixtures/bench-lexicon.json`.
- Vector tổng hợp 1024 dims; 4096 chủ đề dùng chung giữa các tenant (stress post-filter của HNSW). Query: 70 % gần một item, 20 % gần một chủ đề, 10 % ngẫu nhiên.
- `min_cos` benchmark: hằng cố định trong [targets.md](targets.md) mục 3.

| Profile | Nội dung | Vai trò |
|---|---|---|
| `full` | 2 whale 100k item + 20k tag; 6 tenant trung bình (4k/6k/12k/30k/50k/75k item, tag = 1/5); 200 tenant nhỏ 10–500; hai tenant 6k/12k **ép cùng partition với một whale** (sinh UUID tới khi `satisfies_hash_partition` khớp) | bằng chứng acceptance C1/C2 |
| `smoke` | 1 tenant 10k item/2k tag + 20 tenant nhỏ | chạy mọi PR, < 20 phút, **không** phải bằng chứng acceptance |

## 2. Smoke so với full

- Job `search-bench` ("Search bench") trong `ci.yml` (thêm ở W3 bởi Task 10), trigger `pull_request`.
- `full` chạy **chỉ khi** `startsWith(github.head_ref, 'phase05/search-bench')` — tức draft PR "CI only: search-bench (never merge)". Mọi PR khác chạy `smoke`.
- Runner `full`: `ubuntu-24.04-arm` (ARM64 như host `bro`). Nếu không khả dụng, dùng `ubuntu-latest` và report ghi rõ lệch kiến trúc. `timeout-minutes: 150` cho `full`.
- Job **không** là required check nếu chạy > 20 phút (advisor-dec-243).
- DB lấy từ digest `POSTGRES_IMAGE` trong `infra/image-pins.env`, cấu hình giống compose production. **Không** chạy trên `bro` (host dùng chung với dịch vụ khác).

## 3. Ước lượng kích thước `full`, precheck, quy tắc dừng (FS-15, L17)

Ước lượng (xác nhận bằng run smoke):

- ≈ 2×100k + 177k + ~50k ≈ **430k item + ~80k tag ≈ 0,5 triệu vector**.
- `vector(1024)` ≈ 4,1 KB + cột khác → ≈ 1 hàng/trang 8 KB → heap ≈ **4 GB mỗi bộ bảng generation**, HNSW cùng bậc → **≈ 8–10 GB + WAL** lúc build.

Quy trình:

1. **Bảng sizing từ smoke (Task 10):** run smoke xuất byte/vector (heap + HNSW) và giây build HNSW/vector, ngoại suy lên `full`, ghi vào report smoke.
2. Lead chọn runner/disk theo bảng sizing đó **trước** Task 23.
3. **Precheck:** ở **đầu job, trước khi seed dataset và dựng HNSW** (mục 4 bước 2), in `df -h` và `free -m`. Disk trống < 1,5 × ước lượng → job dừng, fail sớm kèm số.
4. **Quy tắc dừng:** chỉ được giảm tenant **nhỏ**. **Không bao giờ** giảm whale 100k + 20k, và không giảm tenant trung bình colocation. Vẫn không đủ → cần `user-dec` (runner lớn hơn hoặc disk ngoài) ghi trước run kế; không tự đổi profile.

## 4. Quy trình chạy

1. Xác nhận [targets.md](targets.md) đã merge và `min_cos` benchmark đã được điền (mục 7).
2. **Precheck trước mọi cấp phát nặng (mục 3):** in `df -h` và `free -m`; disk trống < 1,5 × ước lượng → dừng fail sớm kèm số. Bước này chạy **trước** seed dataset và dựng HNSW, để runner không cạn disk/RAM giữa chừng.
3. Tạo DB từ `POSTGRES_IMAGE` pin; tạo bảng g1 bằng hàm DDL của Task 6 (`embedding_generation_create_tables`); seed dataset (in hash dataset); dựng HNSW theo partition.
4. Chạy kịch bản qua `router.ServeHTTP`; rate limit nới (ghi giá trị đã dùng vào report).
5. Closed-loop **1/8/32 client**, target áp ở **8**; warm-up bỏ; **≥ 2000 request mỗi kịch bản**.
6. Cache mode: lexical; hybrid cache hit; hybrid cache miss với stub **90 ms** (OQ-21); thông tin `openai_compat` ~2,3 s (số vận hành, không phải target).
7. C2: chạy **exact** (oracle chuẩn) và ANN theo corpus × lớp tenant. Ma trận knob: `ef_search ∈ {40,64,100}`, `max_scan_tuples ∈ {20000,50000}` + không giới hạn, `SEARCH_EXACT_MAX_VECTORS ∈ {5000,10000,20000}`.
8. Tính recall/underfill đúng **định nghĩa đóng băng** ở [targets.md](targets.md) mục 2 (không định nghĩa lại trong runner hay report).
9. Tự kiểm phép đo (BE-7, W3): chèn trễ 50 ms test-only vào nhánh lexical → C1-L **phải** fail; ép ANN trên whale (`SEARCH_EXACT_MAX_VECTORS=0`, fallback exact tắt, `hnsw.iterative_scan=off`, `ef_search=1`) → assert path thực tế là `ann` và C2-R **phải** fail. Target không đổi.
10. Task 23: chạy `full` trên draft PR `phase05/search-bench*`; tune trong ma trận knob (mỗi đổi ghi số đo dẫn tới; đổi partitions → generation mới, không `ALTER`); hồi quy P04 A10 với semantic bật (`entry_create_semantic_perf_test.go`, job `Content perf`).

## 5. Metric trong report

n, p50/p95/p99 (nearest-rank), max, lỗi; recall@20 vs exact và độ trùng sau ngưỡng; underfill trước/sau fallback; scan-cap hit; tỉ lệ path (`exact`, `ann`, `ann_fallback_exact`, `ann_short`); chi phí phép đếm có trần; kết quả khác tenant (C2-T); false-positive khi `|E| = 0`; kích thước bảng/index; thời gian build HNSW; knob đã dùng.

## 6. Báo cáo và artifact

- Hardware note theo [hardware-template.md](hardware-template.md), gồm dòng "Không phải host production `bro`".
- Kết quả: `docs/benchmarks/P05-search/results/<YYYY-MM-DD>-<sha7>-<profile>-<arch>.{md,json}`, cộng `$GITHUB_STEP_SUMMARY` và artifact `search-bench-results` (allowlist `*.json`, `*.md`).
- Mỗi report ghi run URL, job, conclusion, head SHA, profile/seed/hash dataset.
- Run fail giữ nguyên trong `results/` kèm bottleneck (EXPLAIN ANALYZE BUFFERS, path, cap hit); xem quy tắc thất bại ở [targets.md](targets.md) mục 4.

## 7. Dẫn commit `targets.md` là tổ tiên của head SHA

Report của run `full` phải có hai dòng:

```text
targets.md commit: <sha40 của commit gần nhất đổi docs/benchmarks/P05-search/targets.md>
head SHA của run:  <sha40>
```

Kiểm bằng lệnh (ghi exit code vào report):

```sh
T=$(git log -1 --format=%H -- docs/benchmarks/P05-search/targets.md)
git merge-base --is-ancestor "$T" "$HEAD_SHA"   # exit 0 = targets.md là tổ tiên của head SHA
```

Điều kiện đi kèm: `git log --follow docs/benchmarks/P05-search/targets.md` cho thấy commit đó nằm trước mọi run `full` đã ghi trong `results/`; và `min_cos` benchmark ở [targets.md](targets.md) mục 3 đã được điền (không còn `TBD`). Nếu `targets.md` bị sửa sau một run, report của run đó phải dẫn `user-dec` cho thay đổi (quy tắc thất bại, [targets.md](targets.md) mục 4).
