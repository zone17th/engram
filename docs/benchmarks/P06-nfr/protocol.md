# P06 NFR — protocol đo (cố định trước khi đo)

Nguồn: [plan P06](../../plans/2026-11-07-P06-beta.md) Task 19 + Task 20, [phase doc](../../phases/P06-beta.md) `P06-A6`, [SPEC](../../SPEC.md) §10.1 (TTFB landing SSG < 200 ms, App Shell LCP < 2 s trên 4G, libsodium WASM lazy sau login) và `P04-A10` (G1 quick-add ≤ 3 s).

**Quy tắc đóng băng (`P06-A6`):** file này được commit **riêng** và phải là **tổ tiên** của mọi SHA mà `scripts/measure-nfr.mjs` chạy đo thật lần đầu. Kiểm: `git log --oneline docs/benchmarks/P06-nfr/protocol.md` + `git merge-base --is-ancestor <sha-protocol> <sha-run>`. Đổi ngưỡng, số mẫu hay profile mạng sau run đầu = commit mới + lý do ghi trong report; không sửa ngược kết quả đã đo.

Phép đo chỉ dùng **tài khoản tổng hợp** (email `nfr.<timestamp>.<rand>@example.test`, body entry giả `payload-<n>`), không dữ liệu người dùng thật (user-dec-016). Script không ghi passphrase, mật khẩu, recovery key, cookie hay `storageState` ra đĩa hoặc log.

## 0. Môi trường và host

| Phép đo | Host chạy | Target |
|---|---|---|
| (1) TTFB, (2) LCP, (3) G1 | `cursor-runner` (Playwright trong `$PLAYWRIGHT_IMAGE` pin ở `infra/image-pins.env`, `--network host`) | 21a: `https://staging.localtest.me --insecure-tls` (cùng round runner, trước `down -v`); 21c: `https://engram.zone17.click` |
| (3) server p95 | `cursor-runner` (`go test -tags perf`, Postgres pin) | router trong tiến trình |
| (4) semantic | `bro` (chỉ đọc metric, nhẹ) | metric nội bộ |
| TTFB phía máy chủ (21c) | `bro`: `curl` × 100 qua `global_nginx` cục bộ (`--resolve …:443:127.0.0.1`) | production, chỉ đọc |

- `bro` **không** chạy Playwright, build hay suite (team-rules, N-09).
- `nfr-bench` không bao giờ trỏ script tới URL production/staging ngoài các round đã nêu; dry-run chỉ nhắm server TLS tự ký tạm `https://127.0.0.1:13443` trên runner.
- Mỗi run ghi vào JSON: SHA (`git rev-parse HEAD`), `os.cpus()[0].model`, số lõi, RAM, phiên bản Node/Playwright/Chromium, `curl --version` dòng 1, target, thời điểm UTC.

## 1. Landing TTFB < 200 ms (SPEC §10.1)

- URL: `GET /` và `GET /vi` (mỗi URL đo riêng, tiêu chí áp cho từng URL).
- Mỗi URL: **5 warmup** (bỏ) rồi **100 request tuần tự**, header `Cache-Control: no-cache`, `curl -s --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code} %{time_starttransfer}'` (`-k` chỉ khi `--insecure-tls`). Không chạy song song. Request quá hạn = mẫu lỗi (không retry, không bỏ mẫu).
- Thống kê: n, p50, p95, p99 (nearest-rank), max, số lỗi (status ≠ 200). Quyết định pass/fail dùng giá trị thô; làm tròn chỉ khi hiển thị.
- **Tiêu chí (cả hai URL):** p95 < 200 ms; 0 lỗi; response cuối có:
  - header SSG: `x-nextjs-cache: HIT|STALE` **hoặc** `x-nextjs-prerender: 1` **hoặc** `cache-control` chứa `s-maxage`;
  - `content-security-policy` có mặt;
  - `strict-transport-security` có mặt.

## 2. App Shell LCP < 2 s trên 4G (SPEC §10.1)

- Trang: `/app` sau login (App Shell + Omnibox). libsodium/WASM chỉ được tải ở `/app`.
- Profile mạng (CDP `Network.emulateNetworkConditions`, "Fast 4G"): `latency 40 ms`, `download 9 Mbps` (đơn vị thập phân: `9 000 000/8 = 1 125 000` B/s), `upload 3 Mbps` (`375 000` B/s); CPU 1x (`Emulation.setCPUThrottlingRate rate=1`); CPU model ghi vào JSON. Viewport 1440×900.
- Đo: `new PerformanceObserver(...).observe({type:'largest-contentful-paint', buffered:true})`; lấy `startTime` của entry LCP cuối cùng sau khi trang `load` + chờ thêm 1 s (hoặc lần input đầu, không có).
- Mẫu: **15 cold** (mỗi mẫu một browser context mới chỉ mang cookie phiên, cache trống; cookie phiên được chuyển tiếp từ context trước vì refresh rotation không có grace window) và **15 warm** (cùng một context, điều hướng lại `/app` sau một lượt nạp cache). Cold và warm báo cáo tách riêng. Mẫu không kết thúc ở `/app` có `#omni` (redirect login, trang lỗi) bị loại và làm tiêu chí số mẫu trượt.
- **Tiêu chí:** cold p75 < 2000 ms **và** cold median < 2000 ms; warm p75 < 2000 ms **và** warm median < 2000 ms.
- **WASM lazy:** nạp `/` (không đăng nhập, context mới) đến `networkidle`; **0 request `.wasm`** (đếm ở sự kiện request, kể cả request bị chặn/hỏng) và 0 response `content-type: application/wasm`.

## 3. Quick-add G1 ≤ 3 s (`P04-A10`, `P06-A6`)

- Tài khoản: tạo mới qua UI (signup mật khẩu → onboarding passphrase → bỏ qua passkey) để vault mở trong phiên. Nếu target buộc xác minh email (không có mail sink), dùng tài khoản tổng hợp đã chuẩn bị qua biến môi trường `NFR_EMAIL` / `NFR_PASSWORD` / `NFR_PASSPHRASE` (login + mở khoá); không có cả hai → tiêu chí ghi `fail` kèm lý do.
- Thao tác mỗi mẫu: ghi `g1-<run>-<n> #g1: payload-<n>` vào omnibox (`#omni textarea[data-vault-secret]`), bấm `Enter`, bấm giờ từ `Enter` đến khi toast `undo-toast-item` chứa tên item hiện ra (seal trong Worker → `POST /items` + `POST /items/{id}/entries` trả `201` → omnibox xoá). Mỗi mẫu cũng kiểm hai response `201` và omnibox rỗng.
- Mẫu: **15** liên tiếp, không mạng giả lập (mạng thật runner → target), cùng profile CPU 1x.
- **Tiêu chí:** median ≤ 3000 ms; 0 mẫu lỗi.
- **Server p95 < 150 ms:** cùng round runner, cùng SHA ứng viên, ghi **một** run có khung vào một log mới (không nối log cũ): `S=$(git rev-parse HEAD); { echo "NFR_PERF_BEGIN sha=$S"; (cd apps/api && CGO_ENABLED=1 go test -tags perf ./internal/perf/... -count=1 -timeout 18m -v); echo "NFR_PERF_END sha=$S exit=$?"; } > perf.log 2>&1`, rồi `measure-nfr.mjs --server-perf-log perf.log`. Tiêu chí `server.p95` chỉ đọc phần trong khung và cần: đúng một `NFR_PERF_BEGIN` và một `NFR_PERF_END`, cả hai `sha` = SHA đang đo, `exit=0`; dòng `ok … /internal/perf`; không `--- FAIL`/`--- SKIP`/`FAIL`/`panic:`; `--- PASS: TestEntryCreatePerformanceA10` và `--- PASS: TestEntryCreatePerformanceA10SemanticOn` mỗi dòng đúng một lần; mỗi `POPULATION pop1_sequential|pop2_burst_no_purge|pop3_burst_purge_overlap` và mỗi `SEMANTIC-ON POPULATION` cùng tên có đúng một dòng p95, mọi p95 < 150 ms. Mọi trường hợp khác (thiếu, SHA lạ, log trộn/trùng/cắt cụt, run fail) = `fail`. Thời gian `POST` nhìn từ trình duyệt chỉ để tham khảo.
  - Nguồn gốc trong khung (advisor-dec-P06-054): không marker `NFR_PERF_*` lồng/cũ; mọi token hex 7–40 ký tự trong ngữ cảnh `sha`/`commit`/`head`/`rev` (có/không dấu nháy, JSON, tiền tố bất kỳ) phải là tiền tố của SHA đang đo, ngược lại `fail`.

## 4. Semantic (`FU-P06-SEM-OBSERVE`, `FU-T23-RUNNER`)

- Tham chiếu nền: [`2026-11-03-T23-full.md`](../P05-search/results/2026-11-03-T23-full.md) và [`2026-11-03-5bc77b3-full-arm64.md`](../P05-search/results/2026-11-03-5bc77b3-full-arm64.md) (protocol P05 giữ nguyên).
- Sau deploy (21c), trên `bro`, chỉ đọc (không tạo tải, không đổi cấu hình): scrape metric nội bộ qua mạng Docker (guard `RequireInternalOrLoopback` cho phép):
  `ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' engram-api-1); curl -s --max-time 10 "http://$ip:8080/api/v1/metrics" > api.prom` và, khi `WORKER_METRICS_ADDR` bật, tương tự cho `engram-worker-1` → `worker.prom`. Hai file chép sang runner (chỉ số tổng hợp, không có `q`).
- `measure-nfr.mjs --semantic-metrics api.prom --semantic-metrics worker.prom` tính: latency `openai_compat` khi cache miss thật = chỉ chuỗi `embedding_provider_latency_seconds{provider="openai_compat",op="query"}` (số lần gọi, p50/p95 theo `histogram_quantile`; TEI và `op="document"` bị loại), `semantic_query_cache_total{result}`, `embedding_jobs_total{kind,outcome}`. Chỉ các họ metric này được đưa vào JSON.
- Trạng thái: `collected` (có lần gọi `openai_compat` query, histogram có bucket hữu hạn + `+Inf` = `_count`, p50/p95 hữu hạn, và có `embedding_jobs_total`) = `pass`. Mọi trạng thái khác — `pending` (không có scrape), `no_cache_miss_observed`, `invalid_latency`, `partial` (thiếu worker), `invalid` — trong run thật là `fail` (advisor-dec-P06-054); chỉ `--dry-run` được ghi `pending`. Không có ngưỡng mới (P05 targets giữ nguyên). Hệ quả: một run thật chỉ thoát `0` khi đã có scrape `bro` sau deploy; run 21a trước deploy ghi lý do `semantic.observed` trong `not_met`.
  - Mọi sample thô của các họ metric được dùng (`embedding_provider_latency_seconds_{bucket,count,sum}`, `embedding_jobs_total`, `semantic_query_cache_total`) được kiểm **trước** khi cộng gộp: giá trị phải là số hữu hạn ≥ 0, `le` là `+Inf` hoặc số hữu hạn ≥ 0. Bất kỳ sample NaN/Inf/âm/không phải số → `invalid_samples` = `fail` (cả dry-run); không bỏ qua, không kẹp.

## 5. Script và kết quả

- `node scripts/measure-nfr.mjs --target <https-url> [--insecure-tls] [--out <dir>] [--server-perf-log <log>] [--semantic-metrics <file>]...` chạy (1)–(4) theo đúng mục trên; `--insecure-tls` = Playwright `ignoreHTTPSErrors: true` + `curl -k`, chỉ cho staging `tls internal` hoặc dry-run.
- Mặc định `--out docs/benchmarks/P06-nfr/results/`; file `nfr-<UTC>-<sha7>.json` gồm môi trường, mẫu thô, thống kê, từng tiêu chí `{id, status: pass|fail|pending|skipped, value, threshold}`, `pass`, `complete` và `not_met` (id + trạng thái + lý do của mọi tiêu chí chưa đạt).
- **Run thật (advisor-dec-P06-054):** exit `0` chỉ khi **mọi** tiêu chí là `pass`; thiếu/pending/cũ/lạ/fail = chưa đạt → exit `1`, lý do trong `not_met`. `2` = dùng sai CLI. Dòng spec runner bắt mã thoát vào `NFR_EXIT`. Nghiệm thu `P06-A6` cần `complete=true`.
- `--dry-run` (chỉ kiểm harness, không phải bằng chứng NFR, JSON `dry_run: true`, tên file `-dryrun`): 1 warmup + 3 mẫu TTFB mỗi URL, 1 mẫu LCP trên `/`, kiểm `.wasm` ở `/`; bỏ đăng nhập, LCP `/app` và G1; ngưỡng trình duyệt ghi `skipped`; `server.p95`/`semantic.observed` chỉ được đánh giá khi có file đầu vào (semantic chưa đủ = `pending`), ngược lại `skipped`; exit `0` khi không có tiêu chí `fail`; `complete` luôn `false`.
- Hàm quyết định thuần (thống kê, profile mạng, `server.p95`, `semantic.observed`) có self-test: `node --test docs/benchmarks/P06-nfr/measure-nfr.selftest.mjs`.
- Report Task 20: `docs/benchmarks/P06-nfr/results/2026-11-07-p06-nfr-report.md` (URL run, SHA ứng viên = SHA 21a, phần cứng runner, phương pháp = file này).
