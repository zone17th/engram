# Runbook: backup, restore and PITR (P06 Task 9)

Scope: engram Postgres on `bro` (container `engram-db-1`, pgvector PG16 ARM64). Two backup layers, one 8-day retention
contract, one restore rehearsal. Scripts live in `infra/backup/pitr/`, `infra/backup/interim/` and
`infra/backup/rehearsal/`. Installation on production happens only in Task 22 (`PROD-STEP-3`, `PROD-STEP-4`,
`PROD-STEP-RETENTION`), each with its own Advisor GO. Nothing in this runbook is run on production without that GO.

Encryption: every backup file is GPG-encrypted to the backup key `F2C47029212F6EE7A9D4D1779D5A1ABAB6A75AD7` on the way
out. Only the **public** key exists on `bro` (`~/engram-ops/backup/gnupg`, and inside the `engram-db-pitr` image at
`/etc/postgresql/.gnupg`). The private key stays on the owner PC.

## 1. Architecture: two layers, retention 8d / PITR 6d

| Layer | What | Producer | Where on bro | Name (source timestamp, UTC) |
| --- | --- | --- | --- | --- |
| Logical | nightly `pg_dump -Fc` → gpg | `engram-backup.timer` 03:17 UTC+7 (`infra/backup/interim/`) | `~/backups/engram/nightly/` | `engram-<YYYYmmddTHHMMSSZ>.dump.gpg` |
| Physical base | `pg_basebackup -Ft -X fetch -z` → gpg | `engram-pitr-base.timer` 03:45 UTC+7 (`infra/backup/pitr/engram-pitr-base.sh`) | `~/backups/engram/pitr/base/` (+ `.sha256`, `pitr/last-base.json`) | `engram-base-<YYYYmmddTHHMMSSZ>.tar.gz.gpg` (start of `pg_basebackup`) |
| WAL | `archive_command` → gzip → gpg | Postgres archiver inside `engram-db-1` (`engram-wal-archive.sh`) | `~/backups/engram/pitr/wal/` (in container `/var/lib/postgresql/wal-archive`, owner postgres, 0700) | `<ts-archive>--<walname>.gz.gpg` (+ `.sha256`: line 1 plaintext segment digest, line 2 encrypted file digest) |
| Off-host | owner PC pull (Advisor script) | owner PC | owner PC | same names, never renamed |

Server settings (`infra/backup/pitr/postgresql-pitr.conf`, image `engram-db-pitr:<pin>-p06` from
`infra/backup/pitr/Dockerfile.db`, tag in `infra/image-pins.env` `POSTGRES_PITR_IMAGE`): `wal_level=replica`,
`archive_mode=on`, `archive_timeout=300s` (RPO ≤ 5 min plus archive latency; target ≤ 15 min),
`archive_command='/etc/postgresql/engram-wal-archive.sh %p %f'`, `wal_keep_size=2GB`. The server is started with
`postgres -c config_file=/etc/postgresql/postgresql-pitr.conf`; that file includes the cluster's own `postgresql.conf`
first, so only the PITR settings change.

Base backup auth (one path only): role `engram_replication` (LOGIN REPLICATION, SCRAM) over the local socket.
`infra/backup/pitr/bootstrap-replication.sql` creates it idempotently on a cluster that already has data and reads the
password **inside psql** from `/run/secrets/engram_replication.password` (read-only mount, 0600, owner postgres).
`infra/backup/pitr/engram-pitr-hba.sh apply` removes every copy of `local replication engram_replication scram-sha-256`,
puts exactly one on line 1 of `pg_hba.conf` (ahead of any generic rule such as `local replication all trust`), reloads,
and fails unless that rule is the first one matching a local replication connection of `engram_replication`. `.pgpass` (`*:*:replication:engram_replication:<password>`, 0600, owner postgres) is mounted at
`/run/secrets/engram_replication.pgpass`; the base script passes only that path (`PGPASSFILE`). No password in argv,
`psql -v`, `docker -e`, repo or logs (`SET log_statement='none'`, `log_min_error_statement='panic'` in the bootstrap
session). Rollback: `engram-pitr-hba.sh rollback` (drops the role, removes the line, reloads).

`-X fetch` takes WAL only from the source `pg_wal`; `wal_keep_size=2GB` keeps it there for the duration of a base (sizing
in `docs/phases/evidence/P06/ops-dr.md`). If WAL is recycled mid-base, `pg_basebackup` fails and nothing is published;
the gzip/GPG archive is never used as a source for `-X fetch`, only for PITR replay after the base.

Base publish rule: the producer takes `pitr/.base.lock` first (a concurrent start exits 1 and touches no file), then
`.partial` → `sha256sum` → `.sha256` → `sync -f` → atomic `mv` → `pitr/last-base.json` (`ts`/`file`/`bytes`/`sha256`/
`wal_start`/`ok:true`). The rename of `last-base.json` is the commit point. Any failure before it (auth, killed
`pg_basebackup`, gpg missing, disk full, WAL recycled, a later sync/stat/JSON write): `.partial` and temporaries
removed, and a final/`.sha256` this run already renamed is removed again; `last-base.json` untouched, exit 1 (systemd
marks the unit failed; monitor alerts on `last-base.json` age).

WAL publish rule: `.partial` (gzip → gpg) and `.sha256.partial` → `sync -f` → `mv` `.sha256` then `.gz.gpg`. A retry for
a segment already archived (any `<ts>--` prefix) returns 0 only when the plaintext digest matches the live segment
**and** the encrypted file still matches its recorded digest (checked with no private key), after syncing again; a
corrupt/truncated copy or a different plaintext exits 1, nothing is overwritten, and Postgres keeps the segment and
retries (watch `pg_stat_archiver.failed_count`; replace a corrupt copy by hand only after investigating).

### Retention contract (R1-09/C09, verbatim from the P06 plan, Task 9)

(a) **mọi** file backup (base, WAL, nightly `pg_dump`, bản thủ công, mọi bản copy off-host) mang **timestamp nguồn bất biến** trong tên: base `engram-base-<YYYYmmddTHHMMSSZ>.tar.gz.gpg` (giờ bắt đầu `pg_basebackup`), nightly `engram-<ts>.dump.gpg`, WAL `<ts-archive>--<walname>.gz.gpg` (giờ `archive_command` chạy, ≥ giờ ghi dữ liệu cuối trong segment); copy/pull giữ nguyên tên, **không bao giờ** dùng `mtime` để tính tuổi; (b) `engram-backup-expire.sh` chạy **mỗi giờ** (`Persistent=true`, độc lập với backup thành công) xoá mọi file có `now − source_ts ≥ 7d22h` (biên 2h = chu kỳ 1h + 1 lần lỡ) và ghi `expire/last-sweep.json`; (c) monitor (Task 4) CRIT khi sweep cũ > 75 phút hoặc nguồn cũ nhất > 7d23h → vẫn còn ≥ 1h trước khi vỡ bound 8 ngày; (d) **PITR ≥ 6 ngày:** base hằng ngày tuổi 6d..7d22h luôn tồn tại cùng toàn bộ WAL sau nó, nên target `now − 6d` khôi phục được; (e) bản pull trên PC owner do Advisor sửa script theo cùng quy tắc tên + ghi `offhost/last-pull.json` ngược về `bro`. Public: "dữ liệu đã xoá rời khỏi mọi bản sao lưu chậm nhất sau **8 ngày**"; không `-mtime +7`/"7 bản". Archive thủ công/plaintext cũ (`opsrecon baseline-ops.md:31`) inventory trong `ops-dr.md`, xoá ở `PROD-STEP-RETENTION` sau restore-verify.

Retention is implemented by `ops-prod` (`infra/backup/expire/**`, Task 22); its boundary test is Task 22 evidence.
The interim `KEEP=7` count in `engram-backup.sh` is replaced at `PROD-STEP-RETENTION` by the hourly name-timestamp sweep.

## 2. Restore

Always restore into a scratch cluster first (separate container/volume/network, no public port). Never restore over
production without an explicit Advisor GO naming the step.

### 2a. Logical (`pg_dump`) — on a machine holding the private key

```sh
sha256sum engram-<ts>.dump.gpg                    # compare with nightly/last.json
gpg -d engram-<ts>.dump.gpg | pg_restore --list    # inspect
createdb scratch_restore
gpg -d engram-<ts>.dump.gpg | pg_restore --no-owner -d scratch_restore
```

### 2b. PITR (base + WAL to a target time)

1. Pick the newest `engram-base-<ts>.tar.gz.gpg` whose `<ts>` (start of `pg_basebackup`) is strictly **before** the
   target; if Postgres then stops with `requested recovery stop point is before consistent recovery point` (target
   inside that base's own run), use the next older base. No base older than the target = the target is not
   restorable. Check `sha256sum -c engram-base-<ts>.tar.gz.gpg.sha256`. The archive must also hold a commit **after**
   the target, otherwise recovery ends with `recovery ended before configured recovery target was reached`.
2. Empty data volume for the restore cluster; extract the base as root, then hand it to postgres:
   ```sh
   gpg -d engram-base-<ts>.tar.gz.gpg | docker run --rm -i --user 0 -v <restore-vol>:/var/lib/postgresql/data \
     --entrypoint sh "$POSTGRES_PITR_IMAGE" -c 'tar -xzf - -C /var/lib/postgresql/data &&
       touch /var/lib/postgresql/data/recovery.signal && chown -R postgres:postgres /var/lib/postgresql/data &&
       chmod 0700 /var/lib/postgresql/data'
   ```
3. Import the private key into a restore-only GNUPGHOME volume (owner postgres, 0700); never into the production image.
   Write a restore-only HBA file (`local all all trust` + `host all all samenet trust`, owner postgres, 0600) into its
   own volume: the isolated restore cluster is opened without knowing (or changing) any archived role password.
4. Create a dedicated network (nothing else attached; the trust HBA must never be reachable from the default bridge or
   any shared network), then start the restore cluster on it with no published port, WAL archive read-only, archiving
   off. Every client (migrate, api) joins the same network; remove the network when done:
   ```sh
   docker network create engram-restore-net
   docker run -d --name engram-restore --network engram-restore-net -v <restore-vol>:/var/lib/postgresql/data \
     -v <wal-dir>:/var/lib/postgresql/wal-archive:ro -v <restore-gnupg>:/var/lib/postgresql/restore-gnupg \
     -v <restore-hba>:/var/lib/postgresql/restore-hba:ro \
     -e ENGRAM_RESTORE_GNUPGHOME=/var/lib/postgresql/restore-gnupg "$POSTGRES_PITR_IMAGE" \
     postgres -c config_file=/etc/postgresql/postgresql-pitr.conf -c archive_mode=off \
       -c hba_file=/var/lib/postgresql/restore-hba/pg_hba.conf -c 'listen_addresses=*' \
       -c 'restore_command=/etc/postgresql/engram-wal-restore.sh %f %p' \
       -c "recovery_target_time=<YYYY-MM-DD HH:MM:SS+00>" -c recovery_target_action=promote
   ```
   `engram-wal-restore.sh` matches `*--<walname>.gz.gpg` (strips the `<ts>--` prefix), checks the encrypted digest,
   decrypts, checks the plaintext digest and writes `%p`. Missing segment = exit 1 (end of archive). Corrupt/undecryptable segment = exit 126, which
   **aborts** recovery instead of promoting at an earlier point.
5. Wait for `SELECT pg_is_in_recovery()` = `f`; then run the pre-open checklist (section 3), with clients on the same
   network, e.g.
   `docker run --rm --network engram-restore-net -e DATABASE_URL='postgres://engram@engram-restore:5432/engram?sslmode=disable' <api-image> /app/migrate up`.
6. Tear down: `docker rm -f engram-restore <clients>; docker network rm engram-restore-net`; delete the restore volumes.

The same flow is automated end to end in `infra/backup/rehearsal/run-pitr-rehearsal.sh` (section 6).

## 3. Pre-open checklist (before any user traffic reaches a restored DB)

- [ ] Restore target and rollback window written down (target time, newest commit present, what is lost).
- [ ] Row counts sane for `app_user`, `vault`, `entry`, `item`; no error in the Postgres log.
- [ ] All sessions revoked and re-auth receipts dropped (users sign in again):
      `UPDATE session SET revoked_at = now() WHERE revoked_at IS NULL; DELETE FROM oauth_reauth_receipt;`
- [ ] `/app/migrate up` exits 0 against the restored DB (same binary as the deployed api).
- [ ] api `GET /api/v1/readyz` = 200 against the restored DB.
- [ ] Section 4 notice prepared when the restore rolls back past any vault key change.
- [ ] Archiving re-enabled (`archive_mode=on`, new timeline archived) and a fresh base taken right after opening.

## 4. PITR rollback and crypto (SPEC §11)

A point-in-time restore rolls back **server-side vault state**, not users' memories of it:

- RK consumed after the target comes back as unused (`vault_recovery_key` rows are deleted on consume; the restore
  re-creates them). Passkey wraps revoked after the target come back. `vault.version` rolls back too, so it cannot
  detect this.
- Passphrase changes (`PUT /vault/kek`) after the target are lost: the user unlocks with the **old** passphrase.
- Entries written after the target are gone; clients holding newer ciphertext must not resurrect it silently.
- Required actions: revoke every session and re-auth grant (section 3), tell users the rolled-back time range, ask them
  to check/rotate their recovery keys and revoke any passkey they had removed. Never claim the restore removed old
  wrappers from backups or revoked an old VK: it did not. The server never decrypts entries during restore
  (user-dec-016).

## 5. Restoring a production archive (R1-11)

- A production archive is restored **only on the owner PC**. Convert a COPY to a throwaway test key with
  `infra/backup/rehearsal/convert-archive-to-test-key.sh <pulled-archive> <converted-dir> <test-fpr>`
  (`SRC_GNUPGHOME` = production private keyring on the owner PC, `DST_GNUPGHOME` = test keyring). For every file it
  first verifies the ORIGINAL sidecar (base: encrypted digest; WAL: encrypted digest on line 2, plaintext digest on line
  1 while streaming), decrypts → re-encrypts to the test key in a pipe (no plaintext on disk), writes a NEW sidecar for
  the test copy (base: new encrypted digest; WAL: same plaintext digest + new encrypted digest) and publishes it under the
  SAME source-timestamped name. Copying the production sidecars unchanged would fail (re-encryption changes the encrypted
  bytes), so always use the converter. The pulled originals are only read.
- Then run `run-pitr-rehearsal.sh --from-decrypted-stream --archive-dir <converted-dir> --gnupghome <test keyring>
  --target-time <ts> [--capture-time <when the copy was pulled from bro>]` as the normal (non-root) owner user against a
  scratch cluster, once with `now − 6d` and once near `now`. The script copies the converted WAL into a postgres-owned
  restore volume itself (the converted directory stays owner-only and is never modified). Delete the converted copy
  and the test key afterwards.
- RPO is **not** accepted by this script (advisor-dec-P06-029): it reports `ARCHIVE_FRESHNESS_SECONDS` (capture time −
  `archive_command` time of the newest WAL file) and `ROLLBACK_SECONDS` (capture − target) as telemetry only, always
  with `RPO_ACCEPTANCE=UNMEASURED_OWNER`. The `archive_command` time is when a segment was shipped (≥ its last write),
  so it cannot bound lost commits. Production RPO is measured in Task 21c against a source commit/LSN boundary.
  Unparsable times, a capture before the newest archived WAL or before the target fail the run. The target must be
  earlier than some archived commit, otherwise recovery stops with `recovery ended before configured recovery target
  was reached`.
- The production private key **never** goes to `bro` or to any cloud runner. `run-pitr-rehearsal.sh` refuses
  `--from-prod-archive` everywhere and refuses `--from-decrypted-stream` on the production host.
- Task 21c records this run (targets `now − 6d` and near `now`, key fingerprint `F2C47029…`, table counts, RTO, and the
  RPO measured against a source commit/LSN boundary) in
  `docs/phases/evidence/P06/release.md`; a scratch PASS never stands in for it.

## 6. Rehearsal (scratch) and checks

`bash infra/backup/rehearsal/run-pitr-rehearsal.sh --scratch` (cloud runner, Docker): baseline cluster on the current
image with seed data → switch the same volume to `engram-db-pitr` + `bootstrap-replication.sql` + HBA + `.pgpass` →
`pg_switch_wal` and archived `.gpg`/`.sha256` (plus idempotent/corrupt-retry checks) → `engram-pitr-base.sh` under write
load + continuous `CHECKPOINT` → failure cases, each asserting its own cause (wrong/missing `.pgpass`, missing password
file, killed `pg_basebackup`, gpg missing, disk full, WAL recycled, failure after publish, concurrent start) → T2 +
consumed RK → `T_target` → T3 → later base → T4 → `T_near` → T5 → disaster → restore to `T_target` (older base
selected) → T2 100 %, T3 absent, RK stays consumed, sessions revoked, `migrate up`, `/readyz` 200 → target older than
every base refused → second restore to `T_near` (later base, T3+T4 present, T5 absent) → RPO/RTO (RTO is warm: images
built and archive local before the clock starts), canary replication password absent from argv and logs. Evidence
lines `KEY=VALUE` end with `PITR_REHEARSAL=PASS|FAIL`; results in `docs/phases/evidence/P06/ops-dr.md`.
Also exercised: HBA apply failing before publication leaves the live file byte-identical; the restore DB is unreachable
from the default bridge; restore negative controls (key import, extraction, start) fail with no promoted container; a
key A → key B conversion with `convert-archive-to-test-key.sh` run as a non-root user on an owner-owned pulled copy,
followed by the owner flow using only key B with no permission fix-ups, and the freshness telemetry's fail-closed cases
(not-a-time, capture before archive, bad target) with `RPO_ACCEPTANCE` never anything but `UNMEASURED_OWNER`.

Day-to-day checks on bro (read-only):

```sh
docker exec engram-db-1 psql -U engram -Atc 'select archived_count, failed_count, last_archived_wal, last_archived_time, last_failed_time from pg_stat_archiver'
cat ~/backups/engram/pitr/last-base.json
systemctl --user list-timers engram-pitr-base.timer engram-backup.timer
tail -n 20 ~/backups/engram/pitr/base.log
```
