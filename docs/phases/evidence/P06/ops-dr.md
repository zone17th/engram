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

| Check (round 2, review fixes) | bro dev smoke (`bro-smoke-7.log`, tree == fix commit) | Cursor cloud runner |
| --- | --- | --- |
| Exit / verdict | `0` / `PITR_REHEARSAL=PASS` | see `reports/ops-dr/merge-ready.md` |
| HBA: generic `local replication all trust` on line 1 + owned rule at the end → `apply` | owned rule moved to line 1, single copy, precedence verified (`HBA_APPLY_PRECEDENCE`, `HBA_APPLY_IDEMPOTENT`) | |
| Archive: `<ts>--<wal>.gz.gpg` + `.sha256` (plaintext + encrypted digests), archiver advances | PASS, `failed_count` 0 | |
| Archive retry: idempotent; truncated ciphertext / different plaintext NOT acknowledged | PASS (no private key used) | |
| restore_command round trip; corrupt copy → exit 126 (abort) | PASS / PASS | |
| Base under write load + continuous `CHECKPOINT` | 3 s, `ok:true`, sha256 verifies, not plain gzip | |
| Failure cases, each with its own cause in its own log, nothing published | wrong `.pgpass` (`password authentication failed`), missing `.pgpass` (`no password supplied`), gpg missing, `pg_basebackup` killed (1 process killed while streaming), disk full (`No space left on device`), WAL recycled (`requested WAL segment … has already been removed`), failure after publish (final + `.sha256` rolled back, marker kept), concurrent start (refused; running base's `.partial` intact, it publishes), bootstrap without password file — all PASS; cause matrix discriminates | |
| Canary: one argv log for the whole run (bootstrap + every base), container/run/case/base/bootstrap/migrate logs | 0 hits in 24 files; sampler saw the `pg_basebackup` command line and (enforced) the bootstrap `psql`; scanner self-test PASS | |
| Restore to `T_target` from an archive with 3 bases (one after the target) | newest base before the target selected; T1 1000/1000, T2 500/500, T3 0, RK stays consumed | |
| Restored roles keep a non-fixture password; restore-only HBA | sessions revoked (0 active), `migrate up` exit 0, `/readyz` 200 | |
| Target older than every base | refused (no base selected, restore exit 3) | |
| Second restore, same directory, `T_near` | later base selected; T3 + T4 present, T5 absent; post-restore checks PASS | |
| Negative control: dirty migration on a pingable restored DB | `NEGCTL_MIGRATE_UP=FAIL` counted → verdict would fail (`NEGATIVE_CONTROL_MIGRATE_FAILURE_FAILS_VERDICT=PASS`) | |
| RPO (T3 commit → archived by `archive_timeout` alone, no manual switch) | 295 s (≤ 15 min) | |
| RTO, warm (source destroyed → `/readyz` 200: base decrypt + WAL replay + revoke + migrate + api; images built and archive local beforehand) | 7 s (selected base is minutes old; round 1 with a 10-minute-old base and 440 segments: 99 s) | |

The bro rows are a development smoke (scratch only, throwaway key, no production data, under `heavy.lock`); the cloud
round on the fix SHA is the evidence of record. RTO is a warm, local-archive figure; a cold disaster adds image pulls
and copying the archive from off-host.

## `wal_keep_size` sizing (R4-03)

- Measured WAL rate under the rehearsal's synthetic write load (200-row inserts + `CHECKPOINT` every ~0.3 s):
  `WAL_RATE_BYTES_PER_SEC_UNDER_LOAD=223270` on bro, `254259` on the cloud runner (≈ 0.25 MB/s). Production today is far below that (DB 13 MB,
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
