# Runbook: P06 production predeploy steps on `bro` (PROD-STEP-2-PREP, 3, 4, 5, 6-INSTALL, 7, 8 config, RETENTION)

Owner lane: `ops-prod` (P06 Task 22). Plan: `docs/plans/2026-11-07-P06-beta.md` Task 22 + Task 21 rollout order.
Related: `docs/runbooks/backup-restore-pitr.md` (Task 9, retention contract (a)–(e)), `docs/runbooks/release-rollback.md`
(Task 21, PROD-STEP-8b), `docs/phases/evidence/P06/ops-prod.md` (evidence of every applied step).

> **Every step below requires Advisor GO.** Nothing here is run on production without an explicit Advisor "go"
> message naming that step (team-rules production gate). Each step is applied, verified and recorded alone.
> None of these steps changes the app image; only PROD-STEP-8b (release lane) does.

## 0. Conventions (all steps)

```sh
# On bro, as ubuntu. PROD = production checkout (never build/branch/edit tracked files there),
# DEV = dev clone used ONLY to read the reviewed files at the merged SHA named in the GO message.
PROD=~/projects/engram
DEV=~/projects/engram-dev
SHA=<phase06/beta SHA named in the GO>          # reviewed source of every file copied below
git -C "$DEV" fetch --quiet origin && git -C "$DEV" cat-file -e "$SHA^{commit}"
TS=$(date -u +%Y%m%dT%H%M%SZ)                    # one TS per step; every backup is <file>.bak-$TS
show() { git -C "$DEV" show "$SHA:$1"; }         # read a reviewed file without checking it out
DC() { (cd "$PROD" && docker compose -p engram --env-file infra/image-pins.env --env-file .env.production \
        $(cat .data/deploy/compose-files.txt) "$@"); }
```

- `.data/deploy/compose-files.txt` holds the `-f` list (one line); `.data/deploy/compose-cmd.txt` keeps the full
  command for humans. Both are updated in the same step that adds an overlay, and backed up first.
- Secrets: generated or pasted **on bro only**, written with `umask 077`, never echoed, never in argv of a
  long-lived process, never in the repo, reports or chat. Verify with `grep -c '^NAME=' file`, never `cat`.
- Config output: `DC config` prints secrets. Only ever pipe it into a filter that prints key names/booleans
  (the `cfgcheck` helper below), never to the terminal or a file.

```sh
cfgcheck() { DC config --format json | python3 -c '
import json,sys; d=json.load(sys.stdin)["services"]
for s in ("api","worker"):
    e=d[s]["environment"]
    print(s, "APP_ENV="+e.get("APP_ENV",""), "AUTH_MAIL_SINK_DIR="+repr(e.get("AUTH_MAIL_SINK_DIR")),
          "EXPORT_STORAGE_DIR="+e.get("EXPORT_STORAGE_DIR",""), "EXPORT_CREATE_PAUSED="+e.get("EXPORT_CREATE_PAUSED",""),
          "export_secret_set="+str(bool(e.get("EXPORT_AT_REST_SECRET"))), "smtp_host_set="+str(bool(e.get("SMTP_HOST"))),
          "volumes="+",".join(v["target"] for v in d[s].get("volumes",[])),
          "healthcheck="+str("healthcheck" in d[s]))
print("same_export_secret_api_worker="+str(d["api"]["environment"].get("EXPORT_AT_REST_SECRET")==d["worker"]["environment"].get("EXPORT_AT_REST_SECRET")))
print("db_image="+d["db"]["image"])'; }
```

Order (Task 21 GO graph): `PROD-STEP-1` (done) → 2-PREP · 3 · 4 (after Task 10 scratch PASS) · 6-INSTALL · 7 ·
RETENTION (any order among themselves, each its own GO) → **only then** 8b (release) → 8c → 8d → 21c (incl. STEP-5).

Compose file layout (advisor-dec-P06-058):

| File | Applied | Content |
|---|---|---|
| `.data/deploy/compose.prod.yml` | live now | P05 override; replaced by prodhygiene `4cbffff` copy at 2-PREP (adds json-file rotation only) |
| `.data/deploy/compose.prod-2prep.yml` | 2-PREP | `infra/deploy/compose.prod-2prep.yml`: export volume/env + SMTP passthrough |
| `.data/deploy/compose.prod-step4.yml` | 4 | `infra/deploy/compose.prod-step4.yml`: PITR db image + archive mount + replication secrets |
| `infra/deploy/compose.prod.yml` (repo) | 8b only | cumulative post-8b target; replaces all three at 8b (lines tagged `[2-PREP]`/`[4]`/`[8b]`) |

All overlays are cloud-tested exactly as committed (`infra/deploy/test-compose-prod.sh pre8b`).

---

## PROD-STEP-2-PREP — export volume + env + SMTP passthrough + log rotation (requires Advisor GO)

Precondition: GO names `PROD-STEP-2-PREP` and `$SHA`. Image unchanged (P05 binary ignores the new env keys).
Owner input: SMTP credentials are optional here (empty `SMTP_HOST` = mail delivery off; production fails closed at 8b).

1. Backup:
   ```sh
   cd "$PROD"
   cp -p .data/deploy/compose.prod.yml .data/deploy/compose.prod.yml.bak-$TS
   cp -p .data/deploy/compose-cmd.txt .data/deploy/compose-cmd.txt.bak-$TS
   cp -p .env.production ~/backups/engram/env.production.bak-$TS
   ```
2. Files (reviewed copies only):
   ```sh
   git -C "$DEV" show 4cbffff:infra/deploy/compose.prod.yml > .data/deploy/compose.prod.yml
   show infra/deploy/compose.prod-2prep.yml > .data/deploy/compose.prod-2prep.yml
   chmod 600 .data/deploy/compose.prod.yml .data/deploy/compose.prod-2prep.yml
   echo '-f infra/docker-compose.yml -f .data/deploy/compose.prod.yml -f .data/deploy/compose.prod-2prep.yml' \
     > .data/deploy/compose-files.txt
   echo "docker compose -p engram --env-file infra/image-pins.env --env-file .env.production $(cat .data/deploy/compose-files.txt)" \
     > .data/deploy/compose-cmd.txt
   ```
   `4cbffff` differs from the live file only by comments + `logging: *engram-logging` (read-only diff 2026-11-08).
3. Secret (one value for api AND worker, C03; ≥ 32 B after base64 decode; never printed):
   ```sh
   ( umask 077; grep -q '^EXPORT_AT_REST_SECRET=' .env.production || \
     printf 'EXPORT_AT_REST_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> .env.production )
   grep -c '^EXPORT_AT_REST_SECRET=' .env.production   # expect 1
   # Optional, owner-provided: SMTP_HOST SMTP_PORT SMTP_USERNAME SMTP_PASSWORD SMTP_FROM SMTP_TLS_MODE (starttls|implicit)
   ```
   This value must survive every later step: rotating it = `PROD-STEP-EXPORT-KEY-ROTATE` (drain), never an edit.
4. Verify config, then apply:
   ```sh
   cfgcheck   # api+worker: APP_ENV=development, AUTH_MAIL_SINK_DIR='/var/lib/engram-mail' (unchanged),
              # EXPORT_STORAGE_DIR=/var/lib/engram-exports, EXPORT_CREATE_PAUSED=false, export_secret_set=True,
              # volumes include /var/lib/engram-exports, worker healthcheck=False; same_export_secret_api_worker=True
   DC up -d    # recreates api/worker/web/db only for the logging/env change; no --build, same images
   ```
5. Verify:
   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://engram.zone17.click/api/v1/readyz        # 200
   for c in engram-db-1 engram-api-1 engram-worker-1 engram-web-1; do
     docker inspect -f '{{.Name}} {{.State.Status}} {{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}' $c
   done                                                     # running json-file {"max-file":"5","max-size":"20m"}
   docker run --rm -v engram_engram-exports:/x "$(grep ^NODE_IMAGE= "$PROD/infra/image-pins.env" | cut -d= -f2)" \
     stat -c '%u %a' /x                                     # 65532 700
   docker exec engram-api-1 /app/api -healthcheck && echo api-ok
   ```
6. Rollback (immediate): `cp -p .data/deploy/compose.prod.yml.bak-$TS .data/deploy/compose.prod.yml`,
   restore `compose-cmd.txt.bak-$TS`, write the old `-f` list (base + compose.prod.yml) to `compose-files.txt`,
   `rm .data/deploy/compose.prod-2prep.yml`, `DC up -d`; keep `EXPORT_AT_REST_SECRET` in `.env.production`
   (unused by P05; deleting it would orphan nothing yet, but keeping it avoids a second key). Empty volume
   `engram_engram-exports` may stay.
7. Evidence: `ops-prod.md` §2-PREP (cfgcheck output, LogConfig, readyz, volume `65532 700`, TS of backups).

## PROD-STEP-3 — nightly encrypted `pg_dump` + off-host pull (requires Advisor GO)

State 2026-11-08 (read-only): `engram-backup.timer` installed and active (03:17 Asia/Ho_Chi_Minh, `Persistent=true`),
`~/engram-ops/backup/engram-backup.sh` identical to `infra/backup/interim/engram-backup.sh`, names
`engram-<YYYYmmddTHHMMSSZ>.dump.gpg` (source timestamp, contract (a)), `nightly/last.json` ok.

1. Verify the producer (no change needed unless the GO says so):
   ```sh
   systemctl --user list-timers engram-backup.timer
   cmp ~/engram-ops/backup/engram-backup.sh <(show infra/backup/interim/engram-backup.sh) && echo same
   cat ~/backups/engram/nightly/last.json         # ok:true, ts < 26 h
   ```
   If it differs: `cp -p ~/engram-ops/backup/engram-backup.sh{,.bak-$TS}`, install the reviewed copy
   (`show ... > ...; chmod 700`), `systemctl --user daemon-reload`. Rollback = restore `.bak-$TS`.
2. Decrypt check (`advisor-dec-P06-006`): the owner pulls `engram-20261107T060150Z.dump.gpg` (and the newest
   nightly) to the owner PC and runs `gpg -d <f> | pg_restore --list > /dev/null && echo DECRYPT_OK` there. The
   private key never comes to bro or the runner.
3. Off-host pull (Advisor script on the owner PC, retention contract (a)/(e)):
   - copies `~/backups/engram/{nightly,pitr/base}/*.gpg` and `pitr/wal/*.gpg` (+ `.sha256`) **keeping names**,
     verifies `sha256sum`, never renames, never uses `mtime`;
   - sweeps the PC copy with the same rule (`EXPIRE_BACKUP_ROOT=<pc copy> bash engram-backup-expire.sh`,
     Git Bash, hourly or at least before every pull — the 8-day bound covers off-host copies too);
   - writes back `~/backups/engram/offhost/last-pull.json` = `{"ts":"<ISO8601Z>","ok":true,"files":<n>}` (atomic
     `.tmp` + `mv`) after a successful pull; the monitor alerts when it is older than 26 h.
4. Verify: `cat ~/backups/engram/offhost/last-pull.json` fresh + ok; owner reports `DECRYPT_OK`.
5. Rollback: none needed (read-only for production); disable the PC task if it misbehaves.
6. Evidence: `ops-prod.md` §3.

## PROD-STEP-4 — WAL archive + PITR base backups (requires Advisor GO, after Task 10 scratch PASS — C19)

Precondition: Task 10 `run-pitr-rehearsal.sh --scratch` PASS on cloud (dec-P06-034: PASS, 14a6653) and GO names
`PROD-STEP-4`. Procedure is exactly the one rehearsed (`docs/runbooks/backup-restore-pitr.md` §1, Task 9).
Restart of `db` ≈ 2–3 s; api/worker reconnect.

1. Backup + pre-dump:
   ```sh
   systemctl --user start engram-backup.service && cat ~/backups/engram/nightly/last.json   # fresh ok:true
   cp -p "$PROD/.data/deploy/compose-files.txt"{,.bak-$TS}; cp -p "$PROD/.data/deploy/compose-cmd.txt"{,.bak-$TS}
   docker exec engram-db-1 cat /var/lib/postgresql/data/pg_hba.conf > ~/engram-ops/pitr-pg_hba.conf.bak-$TS
   ```
2. Build the PITR image from reviewed sources (one heavy job: `flock -o ~/engram-dev-run/heavy.lock`):
   ```sh
   W=$(mktemp -d); git -C "$DEV" archive "$SHA" infra/backup/pitr infra/backup/interim/engram-backup-pub.asc \
     infra/image-pins.env | tar -x -C "$W"
   PIN=$(grep ^POSTGRES_PITR_IMAGE= "$W/infra/image-pins.env" | cut -d= -f2)
   flock -o ~/engram-dev-run/heavy.lock docker build -f "$W/infra/backup/pitr/Dockerfile.db" -t "$PIN" "$W"
   ( umask 077; grep -q '^POSTGRES_PITR_IMAGE=' "$PROD/.env.production" || \
     printf 'POSTGRES_PITR_IMAGE=%s\n' "$PIN" >> "$PROD/.env.production" )
   ```
   `infra/image-pins.env` in the production checkout is tracked (P05, no PITR pin): never edit it; the pin goes to
   the untracked `.env.production` (later `--env-file` wins). At 8b the P06 checkout's pin carries the same value.
3. Host files (must exist before `up`, else Docker creates directories):
   ```sh
   mkdir -p ~/backups/engram/pitr/{base,wal} ~/engram-ops/pitr/secrets
   ( umask 077; P=$(openssl rand -base64 33 | tr -d '\n/+='); \
     printf '%s' "$P" > ~/engram-ops/pitr/secrets/engram_replication.password; \
     printf '*:*:replication:engram_replication:%s\n' "$P" > ~/engram-ops/pitr/secrets/engram_replication.pgpass; unset P )
   sudo chown 999:999 ~/backups/engram/pitr/wal ~/engram-ops/pitr/secrets/engram_replication.{password,pgpass}
   sudo chmod 0700 ~/backups/engram/pitr/wal; sudo chmod 0600 ~/engram-ops/pitr/secrets/engram_replication.{password,pgpass}
   ```
4. Overlay + restart db:
   ```sh
   show infra/deploy/compose.prod-step4.yml > "$PROD/.data/deploy/compose.prod-step4.yml"
   echo '-f infra/docker-compose.yml -f .data/deploy/compose.prod.yml -f .data/deploy/compose.prod-2prep.yml -f .data/deploy/compose.prod-step4.yml' \
     > "$PROD/.data/deploy/compose-files.txt"
   cfgcheck | tail -1                     # db_image=engram-db-pitr:...
   DC up -d db && docker exec engram-db-1 psql -U engram -Atc "show archive_mode; show wal_keep_size"   # on / 2GB
   ```
5. Replication role + HBA + base timer (reviewed scripts, exactly as Task 9):
   ```sh
   docker exec -i engram-db-1 psql -X -U engram -v ON_ERROR_STOP=1 < "$W/infra/backup/pitr/bootstrap-replication.sql"
   bash "$W/infra/backup/pitr/engram-pitr-hba.sh" apply
   mkdir -p ~/engram-ops/backup/pitr
   install -m 700 "$W/infra/backup/pitr/engram-pitr-base.sh" ~/engram-ops/backup/pitr/engram-pitr-base.sh   # unit ExecStart path
   install -m 644 "$W"/infra/backup/pitr/engram-pitr-base.{service,timer} ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now engram-pitr-base.timer
   systemctl --user start engram-pitr-base.service      # first base, non-interactive
   ```
6. Verify:
   ```sh
   docker exec engram-db-1 psql -U engram -Atc "select pg_switch_wal()" >/dev/null
   docker exec engram-db-1 psql -U engram -Atc "select archived_count, failed_count, now()-last_archived_time from pg_stat_archiver"
   # archived_count increases, failed_count does not, last_archived_time < 15 min
   cat ~/backups/engram/pitr/last-base.json            # ok:true
   curl -s -o /dev/null -w '%{http_code}\n' https://engram.zone17.click/api/v1/readyz   # 200
   ```
7. Rollback: `bash "$W/infra/backup/pitr/engram-pitr-hba.sh" rollback` (drops role, removes HBA line);
   `systemctl --user disable --now engram-pitr-base.timer`; restore `compose-files.txt.bak-$TS`,
   `rm .data/deploy/compose.prod-step4.yml`; `DC up -d db` (back to the plain pin, archive off). Keep the
   archive files (encrypted) for the retention sweep.
8. Evidence: `ops-prod.md` §4 (archiver counters before/after, `last-base.json`, readyz).

## PROD-STEP-5 — real production restore (acceptance, not predeploy; release Task 21c)

After ≥ 6 days of PITR: the owner restores on the owner PC to `now − 6d` and to near `now` (Task 10 row 2,
`backup-restore-pitr.md` §2/§5 R1-11: decrypt on the PC, re-encrypt to a test key, scratch only). Evidence goes to
`docs/phases/evidence/P06/release.md` (Task 21c). Nothing runs on bro except the off-host pull.

## PROD-STEP-6-INSTALL — monitor + alerts (requires Advisor GO + owner `ALERT_WEBHOOK_URL`)

Owner input: a real `ALERT_WEBHOOK_URL`. **Empty → do not install; `P06-A9` stays BLOCKED (owner item).**

1. Install reviewed files:
   ```sh
   mkdir -p ~/engram-ops/monitor
   [ -e ~/engram-ops/monitor/engram-monitor.sh ] && cp -p ~/engram-ops/monitor/engram-monitor.sh{,.bak-$TS}
   show infra/ops/engram-monitor.sh > ~/engram-ops/monitor/engram-monitor.sh && chmod 700 ~/engram-ops/monitor/engram-monitor.sh
   show infra/ops/engram-monitor.service > ~/.config/systemd/user/engram-monitor.service
   show infra/ops/engram-monitor.timer > ~/.config/systemd/user/engram-monitor.timer
   ( umask 077; printf 'ALERT_WEBHOOK_URL=%s\nMONITOR_API_BASE_URL=https://engram.zone17.click\n' "<pasted by owner, not echoed>" \
     > ~/engram-ops/monitor/monitor.env )                     # mode 0600
   grep -c '^ALERT_WEBHOOK_URL=.' ~/engram-ops/monitor/monitor.env  # 1
   ```
2. Test alert, then enable:
   ```sh
   ( set -a; . ~/engram-ops/monitor/monitor.env; TEST_ALERT=1 ~/engram-ops/monitor/engram-monitor.sh ); echo rc=$?
   systemctl --user daemon-reload && systemctl --user enable --now engram-monitor.timer
   ```
   Owner confirms the `TEST_ALERT` message arrived. Before 8b the monitor legitimately reports CRIT for the
   missing worker/web healthchecks and (until STEP-4/RETENTION) the missing markers; that is expected and listed
   in the evidence, not silenced.
3. Rollback: `systemctl --user disable --now engram-monitor.timer` (read-only tool, nothing else to undo).
4. Evidence: `ops-prod.md` §6 (TEST_ALERT received, timer listed). Health of 4 containers = 21c after 8b.

## PROD-STEP-7 — nginx hardening + log scrub (requires Advisor GO)

Source: `infra/nginx/engram.conf` at `$SHA` (Task 8 ops-edge). Live file `~/global-infra/nginx/conf.d/engram.conf`
mounted in `global_nginx`. **Drift found 2026-11-08 (read-only diff):** live has
`location ^~ /.well-known/acme-challenge/ { ... default_type text/plain; }`, the repo has
`location /.well-known/acme-challenge/` without `default_type` — reconcile (keep the live ACME block) in the
reviewed copy before GO, or certificate renewal may break.

1. Backup + stage HSTS short:
   ```sh
   cp -p ~/global-infra/nginx/conf.d/engram.conf ~/global-infra/nginx/conf.d/engram.conf.bak-$TS
   show infra/nginx/engram.conf | sed 's/max-age=31536000; includeSubDomains/max-age=300/' \
     > ~/global-infra/nginx/conf.d/engram.conf
   docker exec global_nginx nginx -t && docker exec global_nginx nginx -s reload
   ```
2. Verify:
   ```sh
   curl -sI https://engram.zone17.click/ | grep -iE '^(strict-transport-security|server):'   # max-age=300, no version
   curl -s -o /dev/null -w '%{http_code}\n' https://engram.zone17.click/app                  # 200 (or 307 to login)
   curl -s -o /dev/null -w '%{http_code}\n' https://engram.zone17.click/api/v1/metrics       # 404
   curl -s -o /dev/null https://engram.zone17.click/api/v1/exports/00000000-0000-0000-0000-000000000000/download?canary=STEP7
   docker logs --since 2m global_nginx 2>&1 | grep -c 'exports/{id}'     # >= 1, and:
   docker logs --since 2m global_nginx 2>&1 | grep -cE '00000000-0000|canary=STEP7'   # 0
   ```
   Then (same GO, after WebAuthn/cookie check in a browser) raise HSTS: `show infra/nginx/engram.conf >` the live
   file, `nginx -t`, reload, `curl -sI` shows `max-age=31536000; includeSubDomains`. Full canary procedure:
   `docs/phases/evidence/P06/ops-edge.md` §3 (split streams, fail-closed).
3. Rollback: `cp -p engram.conf.bak-$TS engram.conf && docker exec global_nginx nginx -t && nginx -s reload`.
   With `max-age=300` staged first, an HSTS rollback expires in 5 minutes.
4. Evidence: `ops-prod.md` §7.

## PROD-STEP-8 config — prepared here, applied by `release` at 8b (requires Advisor GO for 8b)

`infra/deploy/compose.prod.yml` at `$SHA` is the reviewed post-8b file. Diff vs the pre-8b live stack (C12):
`APP_ENV: production`; images `engram-{api,worker,web}:${ENGRAM_RELEASE_TAG}` (`p06-<sha>`, set in `.env.production`);
**`AUTH_MAIL_SINK_DIR: ''` in the anchor and again on `api` and `worker`** (do-not-delete comment kept);
`AUTH_MAIL_CAPTURE_AS_DELIVERY: 'false'`; `engram-mail` mounts/volume and `mail-sink-perms` retired; HTTPS
`APP_ORIGIN` required (production rejects http); worker `/app/worker -healthcheck` + web `fetch /api/v1/healthz`
healthchecks; 2-PREP and STEP-4 values folded in. At 8b the release lane:
```sh
cp -p .data/deploy/compose.prod.yml .data/deploy/compose.prod.yml.bak-$TS; cp -p .data/deploy/compose-files.txt{,.bak-$TS}
cp -p .env.production ~/backups/engram/env.production.bak-$TS
show infra/deploy/compose.prod.yml > .data/deploy/compose.prod.yml
echo '-f infra/docker-compose.yml -f .data/deploy/compose.prod.yml' > .data/deploy/compose-files.txt   # overlays dropped
cfgcheck   # api+worker APP_ENV=production AUTH_MAIL_SINK_DIR='' healthcheck=True; same_export_secret_api_worker=True
```
then follows `release-rollback.md` (checkout to the P06 SHA, `migrate up`, `up -d --build`, readyz, 4 containers
healthy). Rollback = `.bak-$TS` compose + `compose-files.txt` + env + `:pre-p06` images together; never run this
file with the `:pre-p06` image. Cloud proof: `infra/deploy/test-compose-prod.sh` (resolve + boot with/without SMTP).

## PROD-STEP-RETENTION — 8-day sweep, off-host rule, retire old plaintext (requires Advisor GO; prerequisite of 8b)

Contract: `backup-restore-pitr.md` "Retention contract" (a)–(e). Script: `infra/backup/expire/engram-backup-expire.sh`
(name timestamp only, deletes at ≥ 7d22h, fail-closed marker), cloud-tested by `infra/backup/expire/test-expire.sh`.
Until this step is done, the public "8 days" copy must not be deployed (8b waits for it).

1. Inventory (read-only) + decrypt proof first:
   ```sh
   find ~/backups/engram -type f -printf '%P\n' | sort      # names only
   ```
   Old plaintext archives (`opsrecon baseline-ops.md:31`): `engram-pre-p04-20261102T041126Z.dump`,
   `engram-pre-p05-20261104T035150Z.dump` (+ `.sha256`). They are deleted only after the owner has reported
   `DECRYPT_OK` for an encrypted nightly newer than them (STEP-3 item 2).
2. Install:
   ```sh
   mkdir -p ~/engram-ops/expire
   show infra/backup/expire/engram-backup-expire.sh > ~/engram-ops/expire/engram-backup-expire.sh
   chmod 700 ~/engram-ops/expire/engram-backup-expire.sh
   show infra/backup/expire/engram-backup-expire.service > ~/.config/systemd/user/engram-backup-expire.service
   show infra/backup/expire/engram-backup-expire.timer > ~/.config/systemd/user/engram-backup-expire.timer
   # After PROD-STEP-4 only (WAL archive owned by the container's postgres, 0700):
   ( umask 077; echo 'EXPIRE_WAL_CONTAINER=engram-db-1' > ~/engram-ops/expire/expire.env )
   ```
3. First sweep, then the timer:
   ```sh
   systemctl --user daemon-reload
   systemctl --user start engram-backup-expire.service; echo rc=$?
   cat ~/backups/engram/expire/last-sweep.json        # ok:true, fresh ts
   tail -n 20 ~/backups/engram/expire/expire.log      # DELETED lines name only expired files
   systemctl --user enable --now engram-backup-expire.timer && systemctl --user list-timers engram-backup-expire.timer
   ```
   The first sweep deletes the plaintext `engram-pre-p0{4,5}-*` dumps once they are ≥ 7d22h old (both are by
   2026-11-12). If GO comes earlier and the owner has `DECRYPT_OK`, delete them explicitly by exact name
   (`rm -- ~/backups/engram/engram-pre-p04-20261102T041126Z.dump{,.sha256} ...`), never by glob.
   `ok:false` (unnamed/future backup file, scan or WAL error) = stop, read `expire.log`, fix, rerun; the monitor alerts.
   `env.production.bak-*` and `r1-vars.sh` are not backup files (no backup extension) and are never swept.
   The interim `KEEP=7` count in `engram-backup.sh` stays (it only deletes earlier than the 7d22h rule).
4. Off-host: the owner PC pull follows STEP-3 item 3 (same names, same sweep, fresh `offhost/last-pull.json`).
5. Verify: `last-sweep.json` fresh + ok; `last-pull.json` fresh + ok; `find ~/backups/engram -name '*.dump' ! -name '*.gpg'`
   empty (no plaintext dump left); monitor retention checks clean.
6. Rollback: `systemctl --user disable --now engram-backup-expire.timer` (deleted expired files are not restored:
   that is the contract).
7. Evidence: `ops-prod.md` §RETENTION.

## Known cross-lane notes (for the Advisor)

- Monitor (`infra/ops/engram-monitor.sh`, Task 4) scans `~/backups/engram/**` with `find` as `ubuntu`; after STEP-4 the
  WAL dir is `999:999 0700`, so that scan reports "backup tree scan incomplete" (CRIT). The expire script sweeps WAL
  through `docker exec -u postgres`; the monitor needs the same or a group-readable WAL dir. Owner: ops-obs/Advisor.
- STEP-7 nginx ACME `location` drift (above). Owner: ops-edge/Advisor.
