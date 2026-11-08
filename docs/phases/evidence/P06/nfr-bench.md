# Bằng chứng nghiệm thu — P06 · Task 19 (`nfr-bench`)

> Lane `nfr-bench` (W2, P06-T19) — nguồn: [plan P06](../../../plans/2026-11-07-P06-beta.md) Task 19. Task 20 (đo thật trên staging 21a / production 21c) không thuộc vòng này; chưa có run đo thật nào.

## 1. Bàn giao

| Hạng mục Task 19 | File | Trạng thái |
|---|---|---|
| Protocol cố định trước khi đo (`P06-A6`) | `docs/benchmarks/P06-nfr/protocol.md` | Commit riêng `699b7a2` (r1), `b5d6e03` (r2), `991a411` (r3, advisor-dec-P06-054), đều trước mọi run thật và là tổ tiên của SHA cuối |
| Script tự động 4 phép đo, xuất JSON | `scripts/measure-nfr.mjs` | (1) TTFB `curl` `/`+`/vi` 5+100, có deadline, header SSG/CSP/HSTS; (2) LCP `/app` 15 cold + 15 warm Fast 4G 9/3 Mbps thập phân, mẫu phải ở `/app` có `#omni`, 0 request `.wasm` ở `/` (đếm ở request); (3) G1 15 mẫu + `server.p95` từ đúng một run `go test -tags perf` có khung `NFR_PERF_BEGIN/END` cùng SHA (`--server-perf-log`); (4) semantic từ metric scrape trên `bro` (`--semantic-metrics`: latency `openai_compat` query khi cache miss, `semantic_query_cache_total`, `embedding_jobs_total`), chỉ `collected` mới đạt |
| CLI | `--target <https-url>` (bắt buộc), `--insecure-tls`, `--out <dir>`, `--help`; thêm `--server-perf-log`, `--semantic-metrics`, `--dry-run` | Run thật: exit `0` chỉ khi mọi tiêu chí `pass` (thiếu/pending/cũ/lạ/fail → `1`, lý do trong `not_met`); `--dry-run`: `0` khi không có `fail`, `complete=false`; `2` dùng sai |
| Self-test hàm quyết định | `docs/benchmarks/P06-nfr/measure-nfr.selftest.mjs` | Biên 200/2000 ms thô, profile 1 125 000/375 000 B/s; `server.p95`: run hợp lệ, biên 150 ms, thiếu, SHA lạ, khung cũ, trộn A/B, pass cũ + fail mới, run trùng, cắt cụt, exit 1, FAIL, panic, population thiếu/trùng; semantic: TEI-only, count không bucket, `+Inf` ≠ count, partial, collected; quyết định run thật vs dry-run |

Ghi chú lệch so với plan: `--dry-run` (advisor-dec-P06-053) chỉ kiểm harness, JSON `dry_run: true`; không phải bằng chứng NFR. Không dependency mới.

## 2. Kiểm tra

| Kiểm tra | Lệnh | Host | Kết quả |
|---|---|---|---|
| Protocol commit ancestor | `git log --oneline docs/benchmarks/P06-nfr/protocol.md` + `git merge-base --is-ancestor b5d6e03 <sha-run>` | `bro` | xem `reports/nfr-bench/merge-ready.md` |
| Self-test + CLI nhẹ | `node --test docs/benchmarks/P06-nfr/measure-nfr.selftest.mjs`; `node --check`; `--help` | `bro` + `cursor-runner` | xem `merge-ready.md` |
| CLI measure-nfr (`--help` + dry-run TLS tự ký + đối chứng âm TLS, WASM hỏng, peer treo) | cloud-spec `nfr-bench` (`NFRHELP_EXIT`, `NFRSELFTEST_EXIT`, `NFRCLI_EXIT`, `NFRTLSNEG_EXIT`, `NFRWASMNEG_EXIT`, `NFRHANG_EXIT`) | `cursor-runner` | xem `merge-ready.md` |
