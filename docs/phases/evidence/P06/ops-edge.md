# P06 Evidence Shard — Task 8 (`ops-edge`)

- **Lane / Task:** `ops-edge` (Task 8, Wave W1)
- **Scope:** CSP Nonce (`'unsafe-inline'` closed in `script-src`), SSG route SHA-256 CSP manifest (`public/.well-known/csp-hashes.json`), HSTS, `Permissions-Policy`, `poweredByHeader: false`, Nginx hardening & export UUID log scrub (`infra/nginx/engram.conf`), Build Manifest (`public/.well-known/build-manifest.json`) & CycloneDX SBOM (`scripts/gen-release-artifacts.mjs` → `docs/phases/evidence/p06-sbom.json`), and self-contained HTTPS CSP E2E wrapper (`scripts/ops-edge-csp-e2e.sh`).
- **Plan reference:** `docs/plans/2026-11-07-P06-beta.md` §4.2 (`ops-edge`), Task 8 (lines 520–540), §6 (`P06-A6`, `P06-A7`, `P06-A9`).
- **Secret policy:** Public repository — no secrets, tokens, keys, or user data appear in this document.

## 1. Task 8 Evidence Matrix (`Xong khi / Evidence`)

| Kiểm tra | Lệnh | Host | Artifact / Kỳ vọng | Tested SHA | Exit / Marker | Raw Log / Evidence | Trạng thái |
|---|---|---|---|---|---|---|---|
| Unit CSP + manifest | `(cd apps/web && pnpm exec vitest run tests/csp.test.ts && node --test scripts/postbuild-csp-manifest.test.mjs); rc=$?; echo; echo OPSEDGE_UNIT_EXIT=$rc; exit $rc` | `cursor-runner` | `✓`/`ok` từng test; `OPSEDGE_UNIT_EXIT=0` | `<pending-lead>` | `pending` | `reports/ops-edge/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |
| CSP thật trên production build (NF-02, R4-01) | `bash scripts/ops-edge-csp-e2e.sh; rc=$?; echo; echo OPSEDGE_E2E_EXIT=$rc; exit $rc` (tự tạo cert tạm trong `mktemp -d` + `trap` dọn, export `TLS_CERT_FILE`/`TLS_KEY_FILE`, `pnpm --filter @engram/web exec playwright install --with-deps chromium`, `pnpm e2e:https` chạy `scripts/https-e2e.mjs` = compose DB + `migrate up` + `next build` gồm postbuild manifest + `next start` sau proxy TLS + `playwright.transport.config.ts`) | `cursor-runner` | log có build xong, test `transport-desktop` `✓` trên các route W1 (`/` + `/vi/privacy` hash CSP, `/app/auth/login` Turnstile nonce, `/app/unlock` Worker+WASM, `/app/settings` dialog tài khoản hiện có; 2 request `/app` nonce khác nhau; `sha256-` thật trên `/`), `playwright transport exit 0`, không `"missing local test certificate"`, không route 404; 0 `securitypolicyviolation`; `OPSEDGE_E2E_EXIT=0` | `<pending-lead>` | `pending` | `reports/ops-edge/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |
| Browser smoke (dec-019) | W1 pre-deploy: listener `console`/`securitypolicyviolation` trong `e2e/transport.spec.ts` chạy qua `bash scripts/ops-edge-csp-e2e.sh` (`pnpm e2e:https`) + `visual-local` (`pi/tester_visual`) trên các trang có CSP; sau deploy (Task 21c): `visual-local` Orca browser mở 5 route trên `https://engram.zone17.click`, đọc console | `cursor-runner` + `local` (sau deploy) | 0 lỗi CSP; `reports/ops-edge/visual-<seq>.md` (W1) và `reports/release/browser-smoke-prod.md` (Task 21c) | `<pending-lead>` | `pending` | `reports/ops-edge/visual-<seq>.md` / `reports/release/browser-smoke-prod.md` | `[ ] pending (cloud-runner + visual-local / Task 21c)` |
| Production sau PROD-STEP-8b | `curl -sI https://engram.zone17.click/ \| grep -i content-security-policy` (có `sha256-`), `curl -sI https://engram.zone17.click/app/auth/login` (có `nonce-`), không `X-Powered-By`, có HSTS/`Permissions-Policy` | `bro` (curl nhẹ, Task 21b) | header đúng; nếu `/` chỉ có `script-src 'self'` → rollback theo Task 21 | `<pending-release>` | `pending (Task 21b)` | `docs/phases/evidence/P06/release.md` | `[ ] pending host (Task 21b)` |
| Nginx hardening + log scrub | `docker exec global_nginx nginx -t`; `curl -s -o /dev/null -w '%{http_code}' https://engram.zone17.click/api/v1/metrics`; tạo export thật rồi `grep -F '<job-uuid>' /var/log/nginx/*engram*` | `bro` (sau PROD-STEP-7, Task 21c) | `server_tokens off`, metrics `404`, **UUID job không xuất hiện** trong nginx/api/worker/web log | `<pending-release>` | `pending (PROD-STEP-7 / Task 21c)` | `docs/phases/evidence/P06/release.md` | `[ ] pending host (PROD-STEP-7 / Task 21c)` |

## 2. Regression & Release Artifact Checks (`ops-edge`)

| Kiểm tra | Lệnh | Host | Artifact / Kỳ vọng | Tested SHA | Exit / Marker | Raw Log / Evidence | Trạng thái |
|---|---|---|---|---|---|---|---|
| CycloneDX SBOM generation | `node scripts/gen-release-artifacts.mjs` | `local` / `cursor-runner` | Sinh `docs/phases/evidence/p06-sbom.json` (CycloneDX 1.5: 6 pinned images từ `infra/image-pins.env`, Go modules + `h1` SHA-256 từ `apps/api/go.mod`+`go.sum`, npm packages + SRI từ `pnpm-lock.yaml`) | `<pending-lead>` | `0` | `docs/phases/evidence/p06-sbom.json` | `[ ] pending (lead verify)` |
| Regression `web-unit` | `node .cursor/cloud/cloud-runner.mjs test --spec .cursor/cloud/specs/web-unit.txt --lane ops-edge --out reports/ops-edge/cloud-test-<seq>.md` | `cursor-runner` | Mọi marker `*_EXIT=0` trong `.cursor/cloud/specs/web-unit.txt` | `<pending-lead>` | `pending` | `reports/ops-edge/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |
| Regression `e2e` | `node .cursor/cloud/cloud-runner.mjs test --spec .cursor/cloud/specs/e2e.txt --lane ops-edge --out reports/ops-edge/cloud-test-<seq>.md` | `cursor-runner` | Mọi marker `*_EXIT=0` trong `.cursor/cloud/specs/e2e.txt` | `<pending-lead>` | `pending` | `reports/ops-edge/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |

## 3. Delivered Files in Lane `ops-edge`

- **BE / Infra (`pi/worker_be`):**
  - `infra/nginx/engram.conf` — `server_tokens off;`, `Strict-Transport-Security: max-age=31536000; includeSubDomains` (`always`), `location = /api/v1/metrics { return 404; }`, `map $uri $engram_log_uri` scrubbing `/api/v1/exports/<id>[/...]` to `/api/v1/exports/{id}$1`, and `log_format engram_noquery` logging `$request_method $engram_log_uri` without query string or Referer.
  - `scripts/gen-release-artifacts.mjs` — Deterministic CycloneDX 1.5 SBOM generator verifying `@sha256:` image pins (`infra/image-pins.env`), Go modules (`apps/api/go.mod`, `apps/api/go.sum`), and pnpm lockfile packages (`pnpm-lock.yaml`) into `docs/phases/evidence/p06-sbom.json`.
  - `scripts/ops-edge-csp-e2e.sh` — Self-contained HTTPS CSP E2E wrapper creating a temporary loopback X.509 cert (`SAN IP:127.0.0.1,DNS:localhost`) with `trap` cleanup, installing host Playwright Chromium (`--with-deps chromium`), and running `pnpm e2e:https`.
  - `docs/phases/evidence/P06/ops-edge.md` — This evidence shard.
- **FE (`pi/worker_fe`):**
  - `apps/web/next.config.ts`, `apps/web/middleware.ts`, `apps/web/lib/csp/**`
  - `apps/web/app/(marketing)/[locale]/layout.tsx`, `apps/web/app/app/layout.tsx`
  - `apps/web/scripts/postbuild-csp-manifest.mjs`, `apps/web/scripts/postbuild-csp-manifest.test.mjs`
  - `apps/web/tests/csp.test.ts`, `apps/web/e2e/transport.spec.ts`, `apps/web/playwright.transport.config.ts`, `apps/web/package.json`
