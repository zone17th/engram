# P06 evidence — `ops-dr` (Tasks 9–10: WAL/PITR, base backup, retention inputs, scratch rehearsal)

Scope: repo artifacts only. Nothing was installed or changed on `bro` production (Task 22 `PROD-STEP-4`/`RETENTION`
install them under separate GOs). Production-archive rehearsal is Task 21c evidence in `release.md`, not here.

## Artifacts

| File | Role |
| --- | --- |
| `infra/backup/pitr/Dockerfile.db` | `FROM $POSTGRES_IMAGE` + `gnupg gzip` + archive/restore scripts + public key only → `POSTGRES_PITR_IMAGE` (`infra/image-pins.env`) |
| `infra/backup/pitr/postgresql-pitr.conf` | `wal_level=replica`, `archive_mode=on`, `archive_timeout=300s`, `archive_command`, `wal_keep_size=2GB` |
| `infra/backup/pitr/engram-wal-archive.sh` | `archive_command`: gzip → gpg → `<ts>--<wal>.gz.gpg` + `.sha256`, no overwrite |
| `infra/backup/pitr/engram-wal-restore.sh` | `restore_command`: strips `<ts>--`, decrypts, verifies sha256; corrupt = exit 126 (abort) |
| `infra/backup/pitr/engram-pitr-base.sh` + `.service` + `.timer` | daily 03:45 UTC+7 encrypted `pg_basebackup`, atomic publish, `last-base.json` only on success |
| `infra/backup/pitr/bootstrap-replication.sql`, `engram-pitr-hba.sh` | `engram_replication` SCRAM role (password read inside psql), HBA apply/rollback |
| `infra/backup/rehearsal/run-pitr-rehearsal.sh` | `--scratch` rehearsal; `--from-decrypted-stream` (owner PC); `--from-prod-archive` refused |
| `docs/runbooks/backup-restore-pitr.md` | 5 sections + retention contract (a)–(e) verbatim |

## Scratch rehearsal results

Run: `bash infra/backup/rehearsal/run-pitr-rehearsal.sh --scratch`. Throwaway GPG test key, containers/volumes
`engram-dr-<id>-*`, all removed at exit. Raw logs live in the run folder `reports/ops-dr/` (not in the repo).

Round 1 (`02cbcf2`, before review r1): bro smoke `bro-smoke-4.log` and cloud `cloud-test-1.md` both
`PITR_REHEARSAL=PASS` (RPO 294 s; RTO 99 s bro / 89 s cloud). Review r1 (R1-01..R1-10) tightened the harness; the
round-2 results below supersede round 1.

| Check (round 2, review fixes) | bro dev smoke (`bro-smoke-7.log`, tree == `e490066`) | Cursor cloud runner |
| --- | --- | --- |
| Exit / verdict | `0` / `PITR_REHEARSAL=PASS` | `0` / `PITR_REHEARSAL=PASS` (`cloud-test-3.md` @ `16f4fba`; `OPSDR_LINT_EXIT=0`, `OPSDR_IMAGE_EXIT=0`, `OPSDR_EXIT=0`; nonzero `*_EXIT` grep empty) |
| HBA: generic `local replication all trust` on line 1 + owned rule at the end → `apply` | owned rule moved to line 1, single copy, precedence verified (`HBA_APPLY_PRECEDENCE`, `HBA_APPLY_IDEMPOTENT`) | PASS / PASS |
| Archive: `<ts>--<wal>.gz.gpg` + `.sha256` (plaintext + encrypted digests), archiver advances | PASS, `failed_count` 0 | PASS, `failed_count` 0, archived 0 → 1 → 644 |
| Archive retry: idempotent; truncated ciphertext / different plaintext NOT acknowledged | PASS (no private key used) | PASS |
| restore_command round trip; corrupt copy → exit 126 (abort) | PASS / PASS | PASS / PASS |
| Base under write load + continuous `CHECKPOINT` | 3 s, `ok:true`, sha256 verifies, not plain gzip | 3 s, same checks PASS |
| Failure cases, each with its own cause in its own log, nothing published | wrong `.pgpass` (`password authentication failed`), missing `.pgpass` (`no password supplied`), gpg missing, `pg_basebackup` killed (1 process killed while streaming), disk full (`No space left on device`), WAL recycled (`requested WAL segment … has already been removed`), failure after publish (final + `.sha256` rolled back, marker kept), concurrent start (refused; running base's `.partial` intact, it publishes), bootstrap without password file — all PASS; cause matrix discriminates | all 9 PASS + cause matrix PASS |
| Canary: one argv log for the whole run (bootstrap + every base), container/run/case/base/bootstrap/migrate logs | 0 hits in 24 files; sampler saw the `pg_basebackup` command line and (enforced) the bootstrap `psql`; scanner self-test PASS | 0 hits in 24 files; both command lines sampled; self-test PASS; runner logs grep 0 |
| Restore to `T_target` from an archive with 3 bases (one after the target) | newest base before the target selected; T1 1000/1000, T2 500/500, T3 0, RK stays consumed | older base `…T122457Z` selected (late base `…T123013Z` not); T2 500/500, T3 0, RK consumed |
| Restored roles keep a non-fixture password; restore-only HBA | sessions revoked (0 active), `migrate up` exit 0, `/readyz` 200 | PASS / rc 0 / 200 |
| Target older than every base | refused (no base selected, restore exit 3) | refused |
| Second restore, same directory, `T_near` | later base selected; T3 + T4 present, T5 absent; post-restore checks PASS | later base `…T123013Z`; T3+T4 present, T5 absent |
| Negative control: dirty migration on a pingable restored DB | `NEGCTL_MIGRATE_UP=FAIL` counted → verdict would fail (`NEGATIVE_CONTROL_MIGRATE_FAILURE_FAILS_VERDICT=PASS`) | `NEGCTL_MIGRATE_UP=FAIL` → control PASS |
| RPO (T3 commit → archived by `archive_timeout` alone, no manual switch) | 295 s (≤ 15 min) | 294 s |
| RTO, warm (source destroyed → `/readyz` 200: base decrypt + WAL replay + revoke + migrate + api; images built and archive local beforehand) | 7 s (selected base is minutes old; round 1 with a 10-minute-old base and 440 segments: 99 s) | 5 s |

The bro rows are a development smoke (scratch only, throwaway key, no production data, under `heavy.lock`); the cloud
round on the fix SHA is the evidence of record (`reports/ops-dr/cloud-test-3.md`, raw `cloud-test-3.logs/{a,b,c}.log`;
round 2 on `e490066` passed every check but tripped the runner on the negative control's `NEGCTL_MIGRATE_UP_EXIT=1`
marker, renamed to `*_RC` in `16f4fba`). RTO is a warm, local-archive figure; a cold disaster adds image pulls
and copying the archive from off-host.

### Round 3 — review r2 fixes (`d98024c`)

Every round-2 check above still runs and passes; these were added:

| Check | bro dev smoke (`bro-smoke-8.log`, tree == `d98024c`) | Cursor cloud runner |
| --- | --- | --- |
| Exit / verdict | `0` / `PITR_REHEARSAL=PASS` | `0` / `PITR_REHEARSAL=PASS` (`cloud-test-4.md` @ `d98024c`; `OPSDR_LINT_EXIT=0`, `OPSDR_IMAGE_EXIT=0`, `OPSDR_EXIT=0`; nonzero `*_EXIT` grep empty; canary 0) |
| HBA apply failing before publication (stale temporary) | live `pg_hba.conf` byte-identical, apply succeeds afterwards | PASS / PASS |
| Restore DB on its dedicated network | unreachable from the default bridge, reachable on the private network | PASS / PASS |
| Restore negative controls (a promoted restore running before the first) | key import / extraction / start failures all non-zero, no promoted container left | all 3 PASS |
| Owner simulation (superseded in round 4: RPO PASS from filename times withdrawn, advisor-dec-P06-029) | restored, sessions revoked, migrate rc 0, `/readyz` 200, T3+T4 present, RTO 6 s, `RPO_UPPER_BOUND_SECONDS=60` → `RPO_ACCEPTANCE=PASS` | PASS: migrate rc 0, `/readyz` 200, T3+T4 500, RTO 5 s, bound 60 s → `PASS` |
| RPO protocol cases (superseded in round 4) | missing capture → `PENDING`; over bound (2000 s) → `FAIL`; proven inactive → `PASS` | `PENDING` / `FAIL` / `PASS` |
| Scratch RPO / warm RTO | 294 s / 12 s | 294 s / 9 s |

### Round 4 — review r3 fixes and advisor-dec-P06-029 (`R4_SHA`)

Owner mode no longer accepts RPO: it reports `ARCHIVE_FRESHNESS_SECONDS` / `ROLLBACK_SECONDS` as telemetry with
`RPO_ACCEPTANCE=UNMEASURED_OWNER`; production RPO is Task 21c (source commit/LSN boundary). Every timestamp is parsed
explicitly and fails closed. Restores copy WAL into a postgres-owned volume, so the documented owner path works as a
plain non-root user. All earlier checks still run.

| Check | bro dev smoke (`bro-smoke-9.log`) | Cursor cloud runner |
| --- | --- | --- |
| Exit / verdict | R4_BRO_VERDICT | R4_CLOUD_VERDICT |
| Owner simulation: owner-owned pulled copy → `convert-archive-to-test-key.sh` as non-root uid (≠ 999) → owner flow with key B only, no permission fix-ups | R4_BRO_OWNER | R4_CLOUD_OWNER |
| Owner RPO never accepted (`RPO_ACCEPTANCE=UNMEASURED_OWNER`), freshness telemetry 60 s | R4_BRO_RPO | R4_CLOUD_RPO |
| Fail-closed timestamps: not-a-time, capture before archive, bad target → non-zero; missing capture → `UNMEASURED_NO_CAPTURE_TIME`; valid → 120 s telemetry | R4_BRO_FRESH | R4_CLOUD_FRESH |
| Negative control prints `NEGCTL_MIGRATE_UP_FAILED_AS_EXPECTED=yes` | R4_BRO_NEG | R4_CLOUD_NEG |
| Scratch RPO / warm RTO (Task 10) | R4_BRO_RPORTO | R4_CLOUD_RPORTO |

## `wal_keep_size` sizing (R4-03)

- Measured WAL rate under the rehearsal's synthetic write load (200-row inserts + `CHECKPOINT` every ~0.3 s):
  `WAL_RATE_BYTES_PER_SEC_UNDER_LOAD=223270` on bro, `245310`–`254259` on the cloud runner (≈ 0.25 MB/s). Production today is far below that (DB 13 MB,
  `opsrecon/baseline-ops.md` §4).
- Max base duration: 4 s for 33 MB in the rehearsal; production DB is 13 MB. Budget 1 h as the worst case.
- 0.25 MB/s × 3600 s × 2 ≈ 1.8 GB ≤ `wal_keep_size = 2GB`. If a base ever needs more, it fails (proved by the WAL-recycled
  case) and publishes nothing; the monitor flags a stale `last-base.json`.

## Existing backups on bro (inventory, read-only, 2026-11-07)

`~/backups/engram/`: `engram-pre-p04-20261102T041126Z.dump` and `engram-pre-p05-20261104T035150Z.dump` (manual
pre-migration `pg_dump -Fc`, **plaintext**, with `.sha256`), `env.production.bak-20261102T041126Z`,
`env.production.bak-20261104T035150Z`, `r1-vars.sh` (all mode 600). `nightly/`: `engram-20261107T060138Z.dump.gpg`,
`engram-20261107T060150Z.dump.gpg`, `last.json` (interim encrypted nightly). The plaintext dumps are deleted at
`PROD-STEP-RETENTION` (Task 22) after a restore-verify, per the plan; this lane deletes nothing on bro.

## Not covered here

- Retention sweep `engram-backup-expire.sh` and its boundary/30-day simulation test: `ops-prod` Task 22.
- Production archive restore (`now − 6d` and near `now`, fingerprint `F2C47029…`): `release` Task 21c on the owner PC
  (`P06-A8` stays pending until then).
