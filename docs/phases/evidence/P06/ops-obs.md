# P06 Evidence Shard — Task 4 (`ops-obs`)

- **Lane / Task:** `ops-obs` (Task 4, Wave W1)
- **Scope:**
  - `/api/v1/metrics` guard (`RequireInternalOrLoopback` in `apps/api/internal/httpx/metrics_guard.go`, mounted in `router.go`): allows only direct loopback or Docker private network requests with no `X-Forwarded-For`/`X-Real-IP`/`Forwarded` headers; edge-proxied or public requests return `404 not_found`.
  - P06 observability collectors (`apps/api/internal/obs/export_metrics.go`, wired into `obs.NewRegistry()`): `export_jobs_total{kind,outcome}`, `export_job_duration_seconds{kind,outcome}`, `export_decrypted_audit_total{outcome}`, `account_deletions_total{outcome}`, and DB-backed `export_cleanup_pending_age_seconds` (`RegisterExportCleanupGauge`). Zero user/job/email/path labels; `TestMetricsHaveNoUserOrQueryLabels` updated.
  - Worker binary `-healthcheck` (`apps/api/cmd/worker/main.go`, `SELECT 1` within 2 s, exits `0`/`1` without echoing DSN credentials); `infra/docker-compose.yml` healthchecks for `worker` and `web`, `json-file` log rotation kept, `engram-exports:/var/lib/engram-exports` volume initialized `65532:65532` mode `0700` (mounted only in `api`+`worker`), shared `x-engram-app-env` (`EXPORT_STORAGE_DIR`, single test `EXPORT_AT_REST_SECRET` for `api`+`worker`, `EXPORT_CREATE_PAUSED`, `SMTP_*` passthrough).
  - Production monitor & alerting (`infra/ops/engram-monitor.{sh,service,timer}` + `infra/ops/test-monitor.sh`, C09/C20): dependency binaries in `PATH`, container health, `/healthz`+`/readyz` < 2 s, disk `/` >88% WARN >92% CRIT, TLS <21d WARN <7d CRIT, API + edge nginx `/api/v1/exports/*` 5xx (covering `advisor-dec-P06-024` D), `export_cleanup_pending_age_seconds > 3600`, WAL archiver `failed_count` delta / `last_archived_time` > 15 m / `.ready` > 16, nightly + PITR base markers <= 26 h, retention oldest source timestamp in backup filenames > 7d23h and `expire/last-sweep.json` > 75 m, `offhost/last-pull.json` > 26 h.
- **Plan reference:** `docs/plans/2026-11-07-P06-beta.md` §4.2 (`ops-obs`), Task 4 (lines 429–446), §6 (`P06-A9`).
- **Secret policy:** Public repository — no secrets, tokens, keys, or user data appear in this document.

## 1. Task 4 Evidence Matrix (`Xong khi / Evidence`)

| Kiểm tra | Lệnh | Host | Artifact / Kỳ vọng | Tested SHA | Exit / Marker | Raw Log / Evidence | Trạng thái |
|---|---|---|---|---|---|---|---|
| `/metrics` guard + label allowlist | `(cd apps/api && go test -v -run 'TestMetricsGuard\|TestMetricsHaveNoUserOrQueryLabels' ./internal/httpx ./internal/obs); rc=$?; echo; echo OPSOBS_METRICS_EXIT=$rc; exit $rc` | `cursor-runner` | `--- PASS:` từng test; `404 not_found` khi có `X-Forwarded-For`/`X-Real-IP` hoặc IP ngoài loopback/mạng nội bộ; `200` nội bộ; `OPSOBS_METRICS_EXIT=0` | `<pending-cloud>` | `pending` | `reports/ops-obs/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |
| `/metrics` guard sau PROD-STEP-7 | `curl -s -o /dev/null -w '%{http_code}' -H "X-Forwarded-For: 1.2.3.4" https://engram.zone17.click/api/v1/metrics` | `bro` (sau PROD-STEP-7, Task 22) | `404` qua proxy biên | `<pending-ops-prod>` | `pending (Task 22)` | `docs/phases/evidence/P06/ops-prod.md` | `[ ] pending host (Task 22)` |
| Worker healthcheck + stack e2e | `(cd apps/api && go test -v -run 'TestWorkerHealthcheck' ./cmd/worker); rc=$?; echo; echo OPSOBS_WORKER_HC_EXIT=$rc; exit $rc` + `docker compose ps` trong stack e2e runner | `cursor-runner` | `--- PASS: TestWorkerHealthcheck`; `worker`/`web` `healthy` trong stack e2e; `OPSOBS_WORKER_HC_EXIT=0` | `<pending-cloud>` | `pending` | `reports/ops-obs/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |
| Alert script (C09, C20, dec-024 D) | `bash infra/ops/test-monitor.sh` | `cursor-runner` | Kịch bản sạch không alert; mọi kịch bản lỗi (nguồn 7d23h30m cùng thư mục với file mới, sweep 2h, off-host pull 30h, archiver stall, backlog 17, `failed_count` tăng, thiếu `gpg` trong `PATH`, disk 95%, `export_cleanup_pending_age_seconds` > 3600, export 5xx trên API và nginx access log) đều gửi webhook; `OPSOBS_MONITOR_EXIT=0` | `<pending-cloud>` | `pending` | `reports/ops-obs/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |
| Regression `go-unit` + `e2e` | `node .cursor/cloud/cloud-runner.mjs test --spec .cursor/cloud/specs/<group>.txt --lane ops-obs --out reports/ops-obs/cloud-test-<seq>.md` | `cursor-runner` | Mọi marker `*_EXIT=0` | `<pending-cloud>` | `pending` | `reports/ops-obs/cloud-test-<seq>.md` | `[ ] pending (cloud-runner)` |

## 2. Handoff Notes for Downstream Lanes

- **`exportapi` (Task 11, W2):**
  - Rebase on `apps/api/internal/httpx/router.go` (Task 4 wraps `/api/v1/metrics` with `RequireInternalOrLoopback`).
  - Wire `obs.RegisterExportCleanupGauge(reg, pool)` next to `obs.RegisterGauges(reg, ...)` in `apps/api/cmd/api/main.go` (`cmd/api/main.go` is owned by `exportapi` in §4.2).
  - Record export/audit/account-deletion outcomes via `metrics.Export.ObserveJob(kind, outcome, d)`, `metrics.Export.IncDecryptedAudit(outcome)`, and `metrics.Export.IncAccountDeletion(outcome)`.
- **`ops-prod` (Task 22, `PROD-STEP-6-INSTALL`):**
  - Install `infra/ops/engram-monitor.{sh,service,timer}` under `/home/ubuntu/engram-ops/monitor/` and `~/.config/systemd/user/`, set non-empty `ALERT_WEBHOOK_URL` in `/home/ubuntu/engram-ops/monitor/monitor.env` (mode `0600`), and run `TEST_ALERT=1 /home/ubuntu/engram-ops/monitor/engram-monitor.sh`.
- **Out-of-row test adjustments (required by the new `/api/v1/metrics` guard):**
  - `apps/api/internal/httpx/metrics_test.go` and `apps/api/internal/suggest/log_test.go`: `httptest.NewRequest` defaults `RemoteAddr` to `192.0.2.1:1234` (TEST-NET-1 public IP), which `RequireInternalOrLoopback` rejects with `404`; those two internal scrape calls now set `RemoteAddr = "127.0.0.1:41000"`.
