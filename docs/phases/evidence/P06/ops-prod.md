# P06 evidence shard: `ops-prod` (Task 22)

Lane `ops-prod`, branch `phase06/ops-prod`. Runbook: `docs/runbooks/prod-steps.md`. Scope = plan 4.2 `ops-prod` row +
3 out-of-row files authorised by `advisor-dec-P06-058` (`infra/deploy/compose.prod-2prep.yml`,
`infra/deploy/compose.prod-step4.yml`, `infra/deploy/test-compose-prod.sh`).

**Production gate:** this round is repo + cloud only. No PROD-STEP has been applied on `bro`; every row in §2 is
`PENDING (Advisor GO)` until its own GO, then filled with command, exit code and timestamp.

## 1. Cloud evidence (cursor-runner)

| Check | Command | Expected | Result |
|---|---|---|---|
| Retention boundary + 30-day simulation (C09, P06-A8) | `bash infra/backup/expire/test-expire.sh` | 21 PASS; `OPSPROD_EXPIRE_EXIT=0` | see `reports/ops-prod/cloud-test-*.md` (SHA recorded there) |
| Expire lint | `bash -n` + `shellcheck` on `infra/backup/expire/*.sh`, `infra/deploy/test-compose-prod.sh` | clean | idem |
| Compose post-8b resolve (C12) | `bash infra/deploy/test-compose-prod.sh resolve` | `AUTH_MAIL_SINK_DIR: ""` on api+worker, APP_ENV production, one export secret, healthchecks, no mail-sink; fail closed without `EXPORT_AT_REST_SECRET`/`ENGRAM_RELEASE_TAG`; `COMPOSE_RESOLVE_EXIT=0` | idem |
| Pre-8b overlays on the live P05 stack | `bash infra/deploy/test-compose-prod.sh pre8b` | 2-PREP: env/volume added, APP_ENV/sink unchanged, no worker/web healthcheck; STEP-4: PITR db only; `COMPOSE_PRE8B_EXIT=0` | idem |
| Boot api+worker+web from the resolved target (C12) | `bash infra/deploy/test-compose-prod.sh boot` | healthy, readyz 200, `mail_delivery_available` false without / true with `SMTP_HOST`; `COMPOSE_BOOT_NOSMTP_EXIT=0`, `COMPOSE_BOOT_SMTP_EXIT=0` | idem |

Boot limits (stated, not hidden): db runs on the plain pgvector pin in the boot round (PITR image = Task 9/10
evidence); with `SMTP_HOST` set, boot + `mail_delivery_available: true` is proven, actual delivery is Task 5 / 21c.

### Simulation facts (test-expire.sh c7)

720 hourly ticks over 30 days, WAL every 10 min, daily nightly + base, nightly failures on days 3/11/12, missed
sweeps at h200 and h401: oldest file seen right before any sweep = 690600 s (7d23h50m) < 8d (691200 s); from day 7,
550/550 checks found a base aged ≥ 6d with every WAL segment after it.

## 2. bro steps (each requires its own Advisor GO)

| Step | Evidence required | Status |
|---|---|---|
| PROD-STEP-2-PREP | `cfgcheck` (env/volume, same secret api+worker), `LogConfig` json-file 20m×5, readyz 200, volume `65532 700` | PENDING (Advisor GO) |
| PROD-STEP-3 | timer + script identical to repo, `last.json` ok, owner `DECRYPT_OK` (`engram-20261107T060150Z.dump.gpg`), `offhost/last-pull.json` fresh | PENDING (Advisor GO; owner decrypt + Advisor pull script) |
| PROD-STEP-4 | archiver advances, `failed_count` flat, `last_archived_time` < 15 min, `pitr/last-base.json` ok, readyz 200 | PENDING (Advisor GO; Task 10 scratch PASS = dec-P06-034) |
| PROD-STEP-6-INSTALL | owner received `TEST_ALERT`, timer enabled | BLOCKED until owner provides `ALERT_WEBHOOK_URL` (P06-A9) |
| PROD-STEP-7 | `nginx -t`, metrics 404, HSTS 300 → 31536000, log scrub canary | PENDING (Advisor GO; ACME location drift to reconcile first) |
| PROD-STEP-RETENTION | first `last-sweep.json` ok, `last-pull.json` fresh, no plaintext `*.dump` left | PENDING (Advisor GO; after owner `DECRYPT_OK`) |
| PROD-STEP-8 config | prepared in `infra/deploy/compose.prod.yml`; applied by `release` at 8b | READY (cloud C12 above) |
