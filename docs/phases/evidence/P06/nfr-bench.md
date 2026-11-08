# Bằng chứng nghiệm thu — P06 · Task 19 (`nfr-bench`)

> Lane `nfr-bench` (W2, P06-T19) — nguồn: [plan P06](../../../plans/2026-11-07-P06-beta.md) Task 19. Task 20 (đo thật trên staging 21a / production 21c) không thuộc vòng này.

## 1. Bàn giao

| Hạng mục Task 19 | File | Trạng thái |
|---|---|---|
| Protocol cố định trước khi đo (`P06-A6`) | `docs/benchmarks/P06-nfr/protocol.md` | Commit riêng `699b7a2`, tổ tiên của mọi SHA chạy script |
| Script đo tự động 4 phép đo, xuất JSON | `scripts/measure-nfr.mjs` | (1) TTFB `curl` `/`+`/vi` 5+100, header SSG/CSP/HSTS; (2) LCP `/app` 15 cold + 15 warm Fast 4G CDP + 0 `.wasm` ở `/`; (3) G1 15 mẫu omnibox → toast, kiểm `POST` `201`; (4) semantic + server p95 ghi ở protocol (đọc metric `bro`, `go test -tags perf`) vì không đo được qua URL |
| CLI | `--target <https-url>` (bắt buộc), `--insecure-tls`, `--out <dir>`, `--help`, thêm `--dry-run` | Exit `0` pass / `1` có tiêu chí fail / `2` dùng sai |

Ghi chú lệch nhỏ so với plan: dòng dry-run của plan không có cờ chọn chế độ; script thêm `--dry-run` vì server TLS tự ký tạm không có login/vault nên các tiêu chí ngưỡng (LCP `/app`, G1) không thể pass — `--dry-run` chỉ kiểm harness (TLS tự ký, curl, Playwright, LCP observer, JSON) và đánh dấu ngưỡng `skipped`. Không dependency mới (Playwright từ `apps/web`, `curl`).

## 2. Kiểm tra

| Kiểm tra | Lệnh | Host | Kết quả |
|---|---|---|---|
| Protocol commit ancestor | `git log --oneline docs/benchmarks/P06-nfr/protocol.md` + `git merge-base --is-ancestor 699b7a2 <sha-run>` | `bro` | xem `reports/nfr-bench/merge-ready.md` |
| Cú pháp + CLI nhẹ | `node --check scripts/measure-nfr.mjs`; `--help`; `--target http://x` → exit 2 | `bro` | PASS |
| CLI measure-nfr (`--help` + dry-run TLS tự ký + đối chứng âm không `--insecure-tls`) | cloud-spec `nfr-bench` (3 dòng: `NFRHELP_EXIT`, `NFRCLI_EXIT`, `NFRTLSNEG_EXIT`) | `cursor-runner` | xem `reports/nfr-bench/merge-ready.md` |
