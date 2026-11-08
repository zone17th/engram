# P06 evidence shard: `ops-prod` (Task 22)

Lane `ops-prod`, branch `phase06/ops-prod`. Runbook: `docs/runbooks/prod-steps.md`. Scope = plan 4.2 `ops-prod` row +
out-of-row files authorised by `advisor-dec-P06-058` (`infra/deploy/compose.prod-2prep.yml`,
`infra/deploy/compose.prod-step4.yml`, `infra/deploy/test-compose-prod.sh`) and `advisor-dec-P06-059` + addendum
(`infra/ops/engram-monitor.sh`, `infra/ops/test-monitor.sh`, `infra/nginx/engram.conf`) and `advisor-dec-P06-061`
(`apps/api/cmd/api/main.go` registers `export_cleanup_pending_age_seconds`; test `apps/api/cmd/api/metrics_wiring_test.go`).

**Production gate:** this round is repo + cloud only. No PROD-STEP has been applied on `bro` and nothing was installed
on the owner PC; every row in §2 is `PENDING (Advisor GO)` until its own GO, then filled with command, exit, timestamp.

## 1. Cloud evidence (cursor-runner)

Raw logs: run-folder `reports/ops-prod/cloud-test-<n>.logs/`; the tested SHA is in each report header.

| Check | Command (spec line) | Expected marker / result |
|---|---|---|
| Lint | per-file `bash -n` + `shellcheck` on `infra/backup/expire/*.sh`, `infra/deploy/test-compose-prod.sh`, `infra/ops/{engram-monitor,test-monitor}.sh` | `OPSPROD_LINT_EXIT=0` |
| Retention boundary, allowlist, 30-day simulation, real 999:0700 WAL run (C09, P06-A8) | `OPSPROD_EXPIRE_REAL_DOCKER=1 bash infra/backup/expire/test-expire.sh` | `OPSPROD_EXPIRE_EXIT=0` |
| Off-host PowerShell sweep: parity, Task Scheduler XML, 30-day daily-pull simulation (R1-03) | `bash infra/backup/expire/test-offhost-expire.sh` | `OPSPROD_OFFHOST_EXIT=0` |
| Monitor: webhook URL never in argv, WAL via isolated run, deps preflight (R1-06/R1-10, cross-lane 1) | `bash infra/ops/test-monitor.sh` | `OPSOBS_MONITOR_EXIT=0` |
| Runbook step library: backup/restore, unit state, STEP-7 routing, STEP-4 build (R1-02/05/08) + real PITR build + real `nginx -t` 1.27.5 | `bash infra/backup/expire/test-prod-steps-lib.sh all` | `OPSPROD_STEPLIB_EXIT=0` |
| api serves the cleanup gauge (dec-061) | `(cd apps/api && go test -count=1 -run TestRegisterDBMetricsServesExportCleanupGauge ./cmd/api)` | `--- PASS`, `OPSPROD_GAUGE_EXIT=0` (fails without the call: checked by mutation) |
| Compose post-8b resolve, pre-8b overlays, boot with/without SMTP, monitor internal metrics (C12, R1-04) | `bash infra/deploy/test-compose-prod.sh all` | `COMPOSE_RESOLVE/PRE8B/BOOT_NOSMTP/BOOT_SMTP_EXIT=0`, `OPSPROD_C12_EXIT=0` |

Rounds (filled from the reports; every `*_EXIT` marker read in the raw logs):

| Round | SHA | Result |
|---|---|---|
| cloud-test-1 | 0f78e2b | retention 21/21 + C12 all 0; lint 127 = runner lacked shellcheck (fixed in later specs) |

Boot limits (stated, not hidden): db runs on the plain pgvector pin in the boot round (PITR image is built and checked
separately by the step-library `real` mode and by Task 9/10); with `SMTP_HOST` set, boot + `mail_delivery_available:
true` is proven, actual delivery is Task 5 / 21c.

## 2. bro steps (each requires its own Advisor GO)

| Step | Evidence required | Status |
|---|---|---|
| PROD-STEP-2-PREP | `cfgcheck` (env/volume, same secret api+worker), `LogConfig` json-file 20m×5, readyz 200, volume `65532 700` | PENDING (Advisor GO) |
| PROD-STEP-3 | timer + script identical to repo, `last.json` ok, owner `DECRYPT_OK` (`engram-20261107T060150Z.dump.gpg`), `offhost/last-pull.json` fresh | PENDING (Advisor GO; owner decrypt + Advisor pull script) |
| PROD-STEP-4 | `pitr-image-ok`, archiver advances, `failed_count` flat, `last_archived_time` < 15 min, `pitr/last-base.json` ok, readyz 200 | PENDING (Advisor GO; Task 10 scratch PASS = dec-P06-034) |
| PROD-STEP-6-INSTALL | deps preflight clean, owner received `TEST_ALERT`, no telemetry/deps finding, timer enabled | BLOCKED until owner provides `ALERT_WEBHOOK_URL` (P06-A9) |
| PROD-STEP-7 | `nginx -t`, metrics 404, ACME path served, HSTS 300 → 31536000, log scrub canary | PENDING (Advisor GO) |
| PROD-STEP-RETENTION | first `last-sweep.json` ok (bro + PC copy), `last-pull.json` fresh, no plaintext `*.dump` left | PENDING (Advisor GO; after owner `DECRYPT_OK`; PC task installed by the Advisor) |
| PROD-STEP-8 config | prepared in `infra/deploy/compose.prod.yml`; applied by `release` at 8b | READY (cloud C12 above) |
