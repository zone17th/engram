# P06 Evidence Shard — Task 8 (`ops-edge`)

- **Lane / Task:** `ops-edge` (Task 8, Wave W1)
- **Scope:** CSP Nonce (`'unsafe-inline'` closed in `script-src`), SSG route SHA-256 CSP manifest (`public/.well-known/csp-hashes.json`), HSTS, `Permissions-Policy`, `poweredByHeader: false`, Nginx hardening & export UUID log scrub (`infra/nginx/engram.conf`), Build Manifest (`public/.well-known/build-manifest.json`) & CycloneDX SBOM (`scripts/gen-release-artifacts.mjs` → `docs/phases/evidence/p06-sbom.json`), and self-contained HTTPS CSP E2E wrapper (`scripts/ops-edge-csp-e2e.sh`).
- **Plan reference:** `docs/plans/2026-11-07-P06-beta.md` §4.2 (`ops-edge`), Task 8 (lines 520–540), §6 (`P06-A6`, `P06-A7`, `P06-A9`).
- **Secret policy:** Public repository — no secrets, tokens, keys, or user data appear in this document.

## 1. Task 8 Evidence Matrix (`Xong khi / Evidence`)

| Kiểm tra | Lệnh | Host | Artifact / Kỳ vọng | Tested SHA | Exit / Marker | Raw Log / Evidence | Trạng thái |
|---|---|---|---|---|---|---|---|
| Unit CSP + manifest | `(cd apps/web && pnpm exec vitest run tests/csp.test.ts && node --test scripts/postbuild-csp-manifest.test.mjs); rc=$?; echo; echo OPSEDGE_UNIT_EXIT=$rc; exit $rc` | `cursor-runner` | `✓`/`ok` từng test; `OPSEDGE_UNIT_EXIT=0` | `<pending-lead>` | `pending` | `reports/ops-edge/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |
| CSP thật trên production build (NF-02, R4-01) | `bash scripts/ops-edge-csp-e2e.sh; rc=$?; echo; echo OPSEDGE_E2E_EXIT=$rc; exit $rc` (nạp mẫu env không-production từ `.env.example` + đặt `DATABASE_URL`/`APP_ENV=development`/`NEXT_PUBLIC_CONTENT_ENABLED=true`/`WEBAUTHN_RP_ID=""`, tự tạo cert tạm trong `mktemp -d` + `trap` dọn, export `TLS_CERT_FILE`/`TLS_KEY_FILE`, `pnpm --filter @engram/web exec playwright install --with-deps chromium`, `pnpm e2e:https` chạy `scripts/https-e2e.mjs` = compose DB + `migrate up` + `next build` gồm postbuild manifest + `next start` sau proxy TLS + `playwright.transport.config.ts`) | `cursor-runner` | log có build xong, test `transport-desktop` `✓` trên các route W1 (`/` + `/vi/privacy` hash CSP, `/app/auth/login` Turnstile nonce, `/app/unlock` Worker+WASM, `/app/settings` dialog tài khoản hiện có; 2 request `/app` nonce khác nhau; `sha256-` thật trên `/`), `playwright transport exit 0`, không `"missing local test certificate"`, không route 404; 0 `securitypolicyviolation`; `OPSEDGE_E2E_EXIT=0` | `<pending-lead>` | `pending` | `reports/ops-edge/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |
| Browser smoke (dec-019) | W1 pre-deploy: listener `console`/`securitypolicyviolation` trong `e2e/transport.spec.ts` chạy qua `bash scripts/ops-edge-csp-e2e.sh` (`pnpm e2e:https`) + `visual-local` (`pi/tester_visual`) trên các trang có CSP; sau deploy (Task 21c): `visual-local` Orca browser mở 5 route trên `https://engram.zone17.click`, đọc console | `cursor-runner` + `local` (sau deploy) | 0 lỗi CSP; `reports/ops-edge/visual-<seq>.md` (W1) và `reports/release/browser-smoke-prod.md` (Task 21c) | `<pending-lead>` | `pending` | `reports/ops-edge/visual-<seq>.md` / `reports/release/browser-smoke-prod.md` | `[ ] pending (cloud-runner + visual-local / Task 21c)` |
| Production sau PROD-STEP-8b | `curl -sI https://engram.zone17.click/ \| grep -i content-security-policy` (có `sha256-`), `curl -sI https://engram.zone17.click/app/auth/login` (có `nonce-`), không `X-Powered-By`, đúng 1 header `Strict-Transport-Security` (do `proxy_hide_header Strict-Transport-Security;` chặn bản trùng từ upstream) và có `Permissions-Policy` | `bro` (curl nhẹ, Task 21b) | header đúng; nếu `/` chỉ có `script-src 'self'` → rollback theo Task 21 | `<pending-release>` | `pending (Task 21b)` | `docs/phases/evidence/P06/release.md` | `[ ] pending host (Task 21b)` |
| Nginx hardening + log scrub (R1-BE-01, R1-BE-05, R1-9, R1-10, R2-BE-01, R2-BE-02, `advisor-dec-P06-024` D) | `docker exec global_nginx nginx -t`; `curl -s -o /dev/null -w '%{http_code}' https://engram.zone17.click/api/v1/metrics`; ghi `SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)` rồi chạy canary export **bình thường** (tạo/tải job thật + `GET /api/v1/exports/<job-uuid>/download?canary=<marker>` → `200`/`404`) **và thất bại** (request `404`/`410` + nhánh lỗi upstream `502`/`504` vào `/api/v1/exports/<job-uuid>/decrypted-pages?cursor=<marker>`), sau đó chạy script thu thập từng luồng riêng biệt có kiểm tra mã thoát (xem lệnh đầy đủ mục 3.3: `set -euo pipefail`, `docker logs --since "$SINCE" <c> > "$tmp/<c>.log" 2>&1` cho `global_nginx` và `engram-{api,worker,web}-1`; trong `global_nginx` chỉ đọc `/var/log/nginx/{access,error}.log` sau khi `test ! -L "$f" && test -f "$f"` chứng minh là regular file, **tuyệt đối không** `cat` symlink `/dev/stdout`\|`/dev/stderr`); kế tiếp assert **bằng chứng dương** (có dòng `"GET /api/v1/exports/{id}/download" (200\|404)` và `"GET /api/v1/exports/{id}/decrypted-pages" (401\|404\|409\|410\|502\|504)` kèm HTTP status trong log `global_nginx`) **và bằng chứng âm** (`! grep -F "$JOB_UUID"` và `! grep -F "$CANARY_MARKER"` trên toàn bộ file log đã thu). Kỳ vọng mã thoát: lỗi thu thập bất kỳ luồng nào → `!= 0`; canary sạch đủ bằng chứng dương → `0`; rò rỉ `<job-uuid>` hoặc `<marker>` → `!= 0` | `bro` (sau PROD-STEP-7, Task 21c) | `server_tokens off`, đúng 1 header HSTS, metrics `404`, access log giữ nguyên dòng `/api/v1/exports/{id}/...` kèm HTTP status (cho cả `200`/`404` và `502`/`504`), error log trong `location ^~ /api/v1/exports/` ở mức `crit` không ghi `request:`/`upstream:` khi lỗi upstream, **UUID job và canary query không xuất hiện** trong bất kỳ luồng log nào; cổng release xác nhận thêm alerting 5xx của `ops-obs` (Task 4 `infra/ops/engram-monitor.sh`) bao phủ cả `502`/`504` do nginx phát sinh trên `/api/v1/exports/` (`advisor-dec-P06-024` D) | `<pending-release>` | `pending (PROD-STEP-7 / Task 21c; local stub smoke: fail=1, clean=0, leak-uuid=1, leak-marker=1, stream-symlink=0)` | `docs/phases/evidence/P06/release.md` | `[ ] pending host (PROD-STEP-7 / Task 21c)` |

## 2. Regression & Release Artifact Checks (`ops-edge`)

| Kiểm tra | Lệnh | Host | Artifact / Kỳ vọng | Tested SHA | Exit / Marker | Raw Log / Evidence | Trạng thái |
|---|---|---|---|---|---|---|---|
| CycloneDX SBOM generation + graph/importer verify (R1-BE-02, R1-BE-03) | `node scripts/gen-release-artifacts.mjs && node scripts/gen-release-artifacts.mjs --verify` | `local` / `cursor-runner` | Sinh `docs/phases/evidence/p06-sbom.json` (CycloneDX 1.5, 814 components = 4 workspace components `engram:apps/{api,web}` + `engram:packages/{crypto-vectors,shared-types}`, 6 pinned images từ `infra/image-pins.env`, 102 Go modules + `h1` SHA-256 từ `apps/api/go.mod`+`go.sum`, 702 npm packages + SRI từ `pnpm-lock.yaml`); `--verify` xác nhận mọi `ref`/`dependsOn` đều phân giải (`unresolvedRefs: []`) và mọi direct dependency khớp version importer trong `pnpm-lock.yaml` (`directDependencyMismatches: []`, `webPostcssRefs: ["npm:postcss@8.5.28"]`, `webPostcssMatchesImporter: true`) | `<pending-lead>` | `0` | `docs/phases/evidence/p06-sbom.json` | `[x] verified locally (exit 0)` |
| Regression `web-unit` | `node .cursor/cloud/cloud-runner.mjs test --spec .cursor/cloud/specs/web-unit.txt --lane ops-edge --out reports/ops-edge/cloud-test-<seq>.md` | `cursor-runner` | Mọi marker `*_EXIT=0` trong `.cursor/cloud/specs/web-unit.txt` | `<pending-lead>` | `pending` | `reports/ops-edge/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |
| Regression `e2e` | `node .cursor/cloud/cloud-runner.mjs test --spec .cursor/cloud/specs/e2e.txt --lane ops-edge --out reports/ops-edge/cloud-test-<seq>.md` | `cursor-runner` | Mọi marker `*_EXIT=0` trong `.cursor/cloud/specs/e2e.txt` | `<pending-lead>` | `pending` | `reports/ops-edge/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |

## 3. Nginx Log Destination, Export Canary & Observability Gate (`R1-BE-01`, `R1-BE-05`, `R1-9`, `R1-10`, `R2-BE-01`, `R2-BE-02`, `advisor-dec-P06-024` D)

1. **Đích ghi log thực tế trên `bro` và quy tắc không đọc `/dev/stdout`|`/dev/stderr` (`reports/opsrecon/baseline-ops.md:16,19`, `R2-BE-01`):**
   - Vhost `~/global-infra/nginx/conf.d/engram.conf` (mount từ `infra/nginx/engram.conf`) khai báo `access_log /var/log/nginx/access.log engram_noquery;` ở mức `server` và `error_log /var/log/nginx/error.log warn;` (riêng `location ^~ /api/v1/exports/` đặt `error_log /var/log/nginx/error.log crit;`).
   - Trong container `global_nginx` (`nginx:1.27.5-alpine`), `/var/log/nginx/access.log` là symlink tới `/dev/stdout` và `/var/log/nginx/error.log` là symlink tới `/dev/stderr`, được Docker `json-file` driver thu vào `docker logs global_nginx` (không phải file `/var/log/nginx/*engram*`).
   - **Quy tắc `R2-BE-01` (bắt buộc kết thúc, không treo pipe):** Khi chạy `docker exec global_nginx ...`, `/dev/stdout` và `/dev/stderr` là pipe của chính tiến trình `exec`, **không phải** bộ đệm log lịch sử của nginx; gọi `cat /var/log/nginx/access.log` khi đích là symlink `/dev/stdout` có thể chặn (block) vô thời hạn trên pipe. Vì vậy mọi bước kiểm tra phải:
     1. Thu luồng log qua `docker logs --since "$SINCE" global_nginx` (đọc từ Docker `json-file` driver, luôn kết thúc ngay).
     2. Bên trong container `global_nginx`, chỉ đọc `/var/log/nginx/access.log` hoặc `/var/log/nginx/error.log` **sau khi** kiểm tra `test ! -L "$f" && test -f "$f"` xác nhận đích là **regular file** thật (không phải symlink tới `/dev/stdout`|`/dev/stderr`, FIFO hay thiết bị ký tự).
2. **Chống lộ UUID/query và điều kiện giám sát 5xx theo `advisor-dec-P06-024` D (`R1-BE-01`, `R1-10`):**
   - `access_log`: `location ^~ /api/v1/exports/` kế thừa `access_log /var/log/nginx/access.log engram_noquery;` từ khối `server`. `map $uri $engram_log_uri` thay `/api/v1/exports/[^/]+(/.*)?$` bằng `"/api/v1/exports/{id}$1"`, và `log_format engram_noquery` ghi `"$request_method $engram_log_uri" $status $body_bytes_sent $request_time "$http_user_agent"` — giữ đầy đủ **HTTP `$status`** (kể cả `200`, `404`, `409`, `410`, `502`, `504`) nhưng bỏ hoàn toàn `<job-uuid>`, `$args`/query string và `Referer`.
   - `error_log`: Nginx mặc định ghi nguyên dòng `request: "GET /api/v1/exports/<uuid>/... HTTP/2.0"` và `upstream: "..."` ở mức `error` khi upstream đóng kết nối hoặc timeout (`502`/`504`). Khối `location ^~ /api/v1/exports/` đặt `error_log /var/log/nginx/error.log crit;` (cùng cấu hình proxy tới `http://engram-web:3000` và `proxy_hide_header Strict-Transport-Security;` như `location /`), giữ `error_log /var/log/nginx/error.log warn;` cho mọi route còn lại.
   - **Lưu ý theo `advisor-dec-P06-024` ruling D & cổng kiểm tra trước release (`ops-obs`, Task 4):** Việc đặt `error_log ... crit;` tại `location ^~ /api/v1/exports/` được chấp thuận với điều kiện: (a) `access_log` tại location này vẫn ghi nhận đầy đủ mã trạng thái HTTP (`$status`, đã chứng minh ở trên), và (b) cảnh báo tỷ lệ lỗi 5xx của `ops-obs` (Task 4 — `docs/plans/2026-11-07-P06-beta.md` §4.2 `ops-obs` / Task 4 dòng 436, `infra/ops/engram-monitor.sh` + `infra/ops/test-monitor.sh`) bao phủ cả `/api/v1/exports/*`. Vì nhánh `ops-edge` không chứa `infra/ops/engram-monitor.sh`, đây là **điều kiện cổng release bắt buộc phải xác nhận khi tích hợp với `ops-obs` / trước `PROD-STEP-6-INSTALL` & `PROD-STEP-7` (Task 21/22)** (ghi nhận như một release-gate check cần xác minh chứ không tuyên bố đã nghiệm thu tại worktree `ops-edge`): cần đối chiếu evidence của `ops-obs` để xác nhận monitor 5xx đọc nguồn bao phủ cả lỗi `502`/`504` do `global_nginx` phát sinh trên `/api/v1/exports/{id}/...` (ví dụ từ access log của `global_nginx` hoặc probe tương đương), không chỉ 5xx phát sinh bên trong tiến trình `engram-api`.
3. **Quy trình & lệnh kiểm tra Canary tách luồng, fail-closed (`R2-BE-01`, `R2-BE-02`) ở `PROD-STEP-7` / Task 21c:**
   - Không được gộp các lệnh `docker logs` vào một subshell duy nhất phía trái `| grep` với `!` phủ định toàn pipeline (vì nếu `docker` lỗi không đọc được log nào, `grep` trả `1` và `!` biến thành `0` — fail-open).
   - Thay vào đó, thu từng luồng vào file tạm riêng dưới `set -euo pipefail` (bất kỳ lệnh `docker` nào thất bại → thoát `!= 0` ngay), kiểm tra `test ! -L "$f" && test -f "$f"` trước khi đọc file trong container, rồi kiểm tra **cả bằng chứng dương** (dòng access log đã scrub kèm HTTP status của cả canary bình thường và canary thất bại đều có mặt) **lẫn bằng chứng âm** (không xuất hiện `$JOB_UUID` và `$CANARY_MARKER` ở bất kỳ luồng nào):

```bash
set -euo pipefail
# Thay bằng giá trị thật của phiên kiểm tra canary ở PROD-STEP-7 / Task 21c:
SINCE="${SINCE:?set UTC ISO-8601 timestamp captured before sending canary requests}"
JOB_UUID="${JOB_UUID:?set canary export job UUID}"
CANARY_MARKER="${CANARY_MARKER:?set canary query marker}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 1. Thu từng luồng độc lập; bất kỳ container nào lỗi/không tồn tại sẽ làm lệnh fail ngay (exit != 0)
docker logs --since "$SINCE" global_nginx >"$tmp/global_nginx.stream.log" 2>&1
docker exec global_nginx sh -eu -c '
  for f in /var/log/nginx/access.log /var/log/nginx/error.log; do
    if [ ! -L "$f" ] && [ -f "$f" ]; then
      cat "$f"
    fi
  done
' >"$tmp/global_nginx.files.log"
docker logs --since "$SINCE" engram-api-1 >"$tmp/engram-api-1.log" 2>&1
docker logs --since "$SINCE" engram-worker-1 >"$tmp/engram-worker-1.log" 2>&1
docker logs --since "$SINCE" engram-web-1 >"$tmp/engram-web-1.log" 2>&1

cat "$tmp/global_nginx.stream.log" "$tmp/global_nginx.files.log" >"$tmp/global_nginx.all.log"

# 2. Bằng chứng dương (positive evidence): dòng đã scrub + HTTP status phải xuất hiện cho cả canary bình thường và thất bại
grep -Eq '"GET /api/v1/exports/\{id\}/download" (200|404) ' "$tmp/global_nginx.all.log"
grep -Eq '"GET /api/v1/exports/\{id\}/decrypted-pages" (401|404|409|410|502|504) ' "$tmp/global_nginx.all.log"

# 3. Bằng chứng âm (negative evidence): không luồng nào được chứa JOB_UUID hoặc CANARY_MARKER
if grep -Fq -- "$JOB_UUID" \
  "$tmp/global_nginx.all.log" \
  "$tmp/engram-api-1.log" \
  "$tmp/engram-worker-1.log" \
  "$tmp/engram-web-1.log"; then
  echo "FAIL: leaked JOB_UUID in collected logs" >&2
  exit 1
fi

if grep -Fq -- "$CANARY_MARKER" \
  "$tmp/global_nginx.all.log" \
  "$tmp/engram-api-1.log" \
  "$tmp/engram-worker-1.log" \
  "$tmp/engram-web-1.log"; then
  echo "FAIL: leaked CANARY_MARKER in collected logs" >&2
  exit 1
fi
```

4. **Kỳ vọng kết quả và kiểm chứng cục bộ bằng stub (không chạy Docker):**

| Kịch bản kiểm tra logic | Điều kiện mô phỏng (stub `docker`) | Mã thoát kỳ vọng | Mã thoát thực tế (local stub smoke) |
|---|---|---|---|
| **Lỗi thu thập luồng** (`collection failure`) | Bất kỳ lệnh `docker logs` / `docker exec` nào trả mã `!= 0` (container không khả dụng / mất quyền đọc) | `!= 0` (fail-closed) | `1` |
| **Thiếu bằng chứng dương** (`missing positive scrubbed line`) | Thu thập thành công (`exit 0`) nhưng log rỗng hoặc thiếu dòng `"GET /api/v1/exports/{id}/..." <status>` | `!= 0` (fail-closed) | `1` |
| **Canary sạch + symlink `/dev/stdout`** (`clean canary`) | `/var/log/nginx/{access,error}.log` là symlink tới pipe chặn (`/dev/stdout`), `docker logs` có đủ dòng scrub `200`/`502`, 0 UUID, 0 marker | `0` (kết thúc ngay, không treo) | `0` |
| **Canary sạch + file vật lý** (`regular file destination`) | `/var/log/nginx/access.log` là regular file chứa dòng scrub, `test ! -L "$f" && test -f "$f"` đọc được | `0` | `0` |
| **Rò rỉ UUID hoặc query marker** (`synthetic leaked marker`) | Bất kỳ luồng log nào chứa `$JOB_UUID` hoặc `$CANARY_MARKER` | `!= 0` | `1` (`leak-uuid=1`, `leak-marker=1`) |

## 4. Delivered Files in Lane `ops-edge`

- **BE / Infra (`pi/worker_be`):**
  - `infra/nginx/engram.conf` — `server_tokens off;`, single-emitter HSTS (`add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;` + `proxy_hide_header Strict-Transport-Security;` in proxied locations), `location = /api/v1/metrics { return 404; }`, `location ^~ /api/v1/exports/` with `error_log /var/log/nginx/error.log crit;`, `map $uri $engram_log_uri` scrubbing `/api/v1/exports/<id>[/...]` to `/api/v1/exports/{id}$1`, and `log_format engram_noquery` logging `$request_method $engram_log_uri` without query string or Referer.
  - `scripts/gen-release-artifacts.mjs` — Deterministic CycloneDX 1.5 SBOM generator declaring workspace components (`engram:apps/{api,web}`, `engram:packages/{crypto-vectors,shared-types}`), verifying `@sha256:` image pins (`infra/image-pins.env`), Go modules (`apps/api/go.mod`, `apps/api/go.sum`), and pnpm lockfile packages + per-importer direct dependency versions (`pnpm-lock.yaml`) with graph referential integrity check (`--verify`) into `docs/phases/evidence/p06-sbom.json`.
  - `scripts/ops-edge-csp-e2e.sh` — Self-contained HTTPS CSP E2E wrapper bootstrapping non-production E2E env defaults from `.env.example` (`DATABASE_URL`, `APP_ENV=development`, `NEXT_PUBLIC_CONTENT_ENABLED=true`, empty `WEBAUTHN_RP_ID`/`WEBAUTHN_RP_ORIGIN`), creating a temporary loopback X.509 cert (`SAN IP:127.0.0.1,DNS:localhost`) with `trap` cleanup, installing host Playwright Chromium (`--with-deps chromium`), and running `pnpm e2e:https`.
  - `docs/phases/evidence/P06/ops-edge.md` — This evidence shard.
- **FE (`pi/worker_fe`):**
  - `apps/web/next.config.ts`, `apps/web/middleware.ts`, `apps/web/lib/csp/**`
  - `apps/web/app/(marketing)/[locale]/layout.tsx`, `apps/web/app/app/layout.tsx`
  - `apps/web/scripts/postbuild-csp-manifest.mjs`, `apps/web/scripts/postbuild-csp-manifest.test.mjs`
  - `apps/web/tests/csp.test.ts`, `apps/web/e2e/transport.spec.ts`, `apps/web/playwright.transport.config.ts`, `apps/web/package.json`
