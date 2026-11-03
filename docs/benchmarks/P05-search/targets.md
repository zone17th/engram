# P05 Search — target benchmark (đóng băng)

> **File này phải có trong lịch sử git TRƯỚC mọi run profile `full`.** Report của run `full` phải dẫn commit của file này và commit đó phải là **tổ tiên** của head SHA của run (cách kiểm: [protocol.md](protocol.md) mục 7). Đổi target chỉ bằng một `user-dec` ghi **trước** run kế tiếp; không sửa target để "vừa" với số đo vừa thấy (plan P05 mục 2.23, gate 6; phase doc P05 Gate).

Nguồn: [plan P05](../../plans/2026-11-02-P05-search.md) mục 2.23, gate 6, Task 1, Task 10, Task 23, mục 6 (P05-C1, P05-C2); [protocol](protocol.md); [ADR 0007](../../adr/0007-embedding-generation-cutover.md).

## 1. Bảng target

Mọi chỉ số đo ở **concurrency 8, warm** (đo thêm ở 1 và 32 để báo cáo, không phải target). Percentile dùng nearest-rank.

| ID | Chỉ số (concurrency 8, warm) | Target |
|---|---|---|
| C1-L | lexical server, whale 100k + 20k | p95 < 40 ms |
| C1-H | hybrid, cache hit | p95 < 100 ms |
| C1-M | hybrid, cache miss, stub 90 ms | p95 < 350 ms |
| C2-R | recall@20 trung bình mỗi (corpus × lớp tenant đi ANN) | ≥ 0,95 |
| C2-Q | recall@20 từng query | ≥ 0,80 cho ≥ 95 % query |
| C2-U | underfill sau fallback | ≤ 1 % query |
| C2-B | nhánh vector một corpus | p95 ≤ 80 ms, p99 báo cáo |
| C2-T | kết quả khác tenant | 0 (cứng) |

Ghi chú:

- C1-M áp cho profile **stub 90 ms** (OQ-21, advisor-dec-244). Với `openai_compat` trên host `bro` (~2,3 s/request) latency cache miss là **số vận hành báo cho P06** (metric Task 24), không phải target P05; UI không bao giờ chờ semantic (lexical hiện trước, near append muộn không dời hàng lexical).
- C2-T là điều kiện cứng: một hàng thuộc tenant khác ở bất kỳ query nào = fail, không có dung sai.
- Mục tiêu recall định lượng được ghi ở đây trước run (phase doc P05-C2).

## 2. Định nghĩa đóng băng (BE-6)

Với mỗi query:

- `E` = top-`min(20, eligible)` của **exact** (oracle) **sau** lọc ngưỡng `min_cos`; `eligible` = số target của tenant qua ngưỡng `min_cos`.
- `recall@20 = |ANN ∩ E| / |E|`.
- Query có `|E| = 0` **bị loại** khỏi C2-R và C2-Q, và phải trả **0** hàng ANN. Số query vi phạm (ANN trả > 0 hàng khi `|E| = 0`) đếm riêng thành chỉ số **false-positive, target 0**.
- C2-R = trung bình trên các query có `|E| > 0`, tính theo từng (corpus × lớp tenant) đi ANN.
- C2-Q = tỉ lệ query (có `|E| > 0`) đạt recall@20 ≥ 0,80; target ≥ 95 % query.
- **Underfill (C2-U)** đo **sau** lọc ngưỡng và **sau** fallback, so với `E`: một query bị underfill khi số hàng trả về < `|E|`.
- Underfill **ứng viên ANN** trước lọc ngưỡng (quy tắc fallback production, plan mục 2.16) được báo riêng, **không phải target**.
- Fixture test của harness (Task 10) phải phủ: N < 20, 0 eligible, ngưỡng cắt bớt, underfill ANN thật.

## 3. `min_cos` của benchmark

`min_cos` benchmark là một **hằng cố định** cho mọi run (vector tổng hợp, không liên quan `semantic_min_cos` hiệu chỉnh của model thật ở [ADR 0004](../../adr/0004-embedding-provider-openai-compat.md)).

| Tham số | Giá trị |
|---|---|
| `min_cos` benchmark | **0.50** (advisor-dec-255, 2026-11-02) |

Ràng buộc đóng băng cho generator dataset (Task 10): query gần item (70 %) đặt cos với target **cao hơn hẳn** 0.50; query ngẫu nhiên (10 %) **dưới** 0.50, để cả ca `|E| = 0` lẫn fixture "ngưỡng cắt bớt" đều xảy ra. Đây **chỉ** là tham số benchmark: không bao giờ dùng làm `semantic_min_cos` production (giá trị đó theo từng generation, từ calibration — plan P05 mục 2.20; giá trị tạm 0.55/0.58 của ADR 0004 không bị ảnh hưởng). Đổi giá trị chỉ theo mục 4.

## 4. Quy tắc thất bại

- Target **không đổi âm thầm**.
- Run fail được **giữ nguyên** trong `results/` kèm bottleneck (EXPLAIN ANALYZE BUFFERS, path, cap hit), không xoá, không ghi đè.
- Sửa trong phase (index, knob, thiết kế), rồi chạy lại; mỗi run được ghi, không chạy lặp để "may mắn" đạt.
- Đổi target (hoặc `min_cos`, hoặc định nghĩa mục 2) chỉ bằng `user-dec` **ghi trước** run kế tiếp, dẫn trong report của run đó.
- Benchmark fail không được đánh dấu Done vì demo ít dữ liệu trông nhanh (phase doc P05 Gate).
- Profile `smoke` không phải bằng chứng acceptance và không dùng để tuyên bố đạt hay trượt target.

## 5. Ngoại lệ runner CI đã ghi nhận — exception advisor-dec-354 (user-dec-015)

- **Không đổi giá trị target:** `C1-L` (`p95 < 40 ms` ở `c=8`) và `C1-H` (`p95 < 100 ms` ở `c=8`) ở mục 1 giữ nguyên là target production.
- **Số đo ghi nhận ở Task 23 trên shared CI runner 4-CPU (`ubuntu-24.04-arm`, 4 logical vCPU, không phải host `bro`):** tại head `5bc77b3` (R6), T23 ghi nhận **`C1-L` `p95 = 54.4 ms`** (`54.42 ms` ở `c=8`, `p50 = 18.19 ms`, `partials = 144/4000` measured / `158/4300` tính cả warm-up) và **`C1-H` `p95 = 115.5 ms`** (`115.48 ms` ở `c=8`, `p50 = 71.38 ms`, **`0/4000 degraded`, valid**); ở **`c=1`** đạt **`21.8 / 43 ms`** (`C1-L` `p95 = 21.75 ms < 40 ms`, `C1-H` `p95 = 43.15 ms < 100 ms`).
- **Bằng chứng bão hoà CPU trên runner 4-CPU:** thông lượng `C1-L` chạm trần cứng **`357 vs 358 req/s` tại `c=8`/`c=32`** (`16` nhánh DB song song + Go API tranh chấp 4 vCPU, kéo giãn latency ~2,5× so với `c=1`); toàn bộ các chỉ số `C1-M` (`p95 = 133.13 ms < 350 ms`) và `C2-R`/`C2-Q`/`C2-U`/`C2-B`/`C2-T`/`C2-FP` đều **PASS** (`recall@20 = 1.0000`, `underfill = 0.00%`, `branch p95 = 22.0–23.0 ms`).
- **Chuỗi run bằng chứng:** R2 `41567750625` / R4 `41575503986` / R5 `41591601264` / R6 `41598130936` (báo cáo tổng hợp: [results/2026-11-03-T23-full.md](results/2026-11-03-T23-full.md), báo cáo R6: [results/2026-11-03-5bc77b3-full-arm64.md](results/2026-11-03-5bc77b3-full-arm64.md)).
- **Follow-up:** **`FU-T23-RUNNER`** — đo lại `C1` trên máy/runner có `>= 8` CPU trước/sau bước rollout 24-2.
