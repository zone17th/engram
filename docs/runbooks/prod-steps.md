# Runbook: P06 production predeploy steps on `bro` (PROD-STEP-2-PREP, 3, 4, 5, 6-INSTALL, 7, 8 config, RETENTION)

Owner lane: `ops-prod` (P06 Task 22). Plan: `docs/plans/2026-11-07-P06-beta.md` Task 22 + Task 21 rollout order.
Related: `docs/runbooks/backup-restore-pitr.md` (Task 9, retention contract (a)–(e)), `docs/runbooks/release-rollback.md`
(Task 21, PROD-STEP-8b), `docs/phases/evidence/P06/ops-prod.md` (evidence of every applied step).
Decisions: advisor-dec-P06-058 (overlays + C12 test), advisor-dec-P06-059 (+ addendum: monitor, nginx, off-host).

> **Every step below requires Advisor GO.** Nothing here is run on production without an explicit Advisor "go"
> message naming that step (team-rules production gate). Each step is applied, verified and recorded alone.
> None of these steps changes the app image; only PROD-STEP-8b (release lane) does.

## 0. Conventions and the step library (all steps)

On bro, as `ubuntu`, in ONE shell per step. `PROD` = production checkout (never build/branch/edit tracked files there),
`DEV` = dev clone used ONLY to read the reviewed files at the merged SHA named in the GO message.

```sh
export PROD=~/projects/engram DEV=~/projects/engram-dev
export SHA=<phase06/beta SHA named in the GO>      # reviewed source of every file copied below
git -C "$DEV" fetch --quiet origin && git -C "$DEV" cat-file -e "$SHA^{commit}"
export TS=$(date -u +%Y%m%dT%H%M%SZ)              # one TS per step; every backup is <file>.bak-$TS
# Load the step library below, read from the reviewed SHA (never from a working tree):
source <(git -C "$DEV" show "$SHA:docs/runbooks/prod-steps.md" |
  awk '/^<!-- prodsteps-lib:begin -->$/{f=1;next} /^<!-- prodsteps-lib:end -->$/{f=0} f' | sed '1d;$d')
```

The library is the only code that mutates files in these steps; `infra/backup/expire/test-prod-steps-lib.sh` runs
exactly this block (extracted the same way) against fixtures with recording `docker`/`systemctl` shims.

<!-- prodsteps-lib:begin -->
```sh
# --- prod-steps library (P06 Task 22). Needs PROD DEV SHA TS. ---
NGINX_CONF="${NGINX_CONF:-$HOME/global-infra/nginx/conf.d/engram.conf}"
NGINX_CONTAINER="${NGINX_CONTAINER:-global_nginx}"
HEAVY_LOCK="${HEAVY_LOCK:-$HOME/engram-dev-run/heavy.lock}"
STATE_DIR="${STATE_DIR:-$HOME/engram-ops/prodsteps}"

show() { git -C "$DEV" show "$SHA:$1"; }            # a reviewed file at the GO SHA
# -f list from .data/deploy/compose-files.txt; before 2-PREP (file absent) the live P05 pair.
DC() { (cd "$PROD" && docker compose -p engram --env-file infra/image-pins.env --env-file .env.production \
  $(cat .data/deploy/compose-files.txt 2>/dev/null || echo -f infra/docker-compose.yml -f .data/deploy/compose.prod.yml) "$@"); }

# bak_files <file>...: mode-preserving <file>.bak-$TS, or <file>.absent-$TS when it does not exist yet.
bak_files() {
  local f
  for f in "$@"; do
    if [ -e "$f" ]; then cp -p -- "$f" "$f.bak-$TS" || return 1
    else mkdir -p -- "$(dirname -- "$f")" && : >"$f.absent-$TS" || return 1; fi
  done
}
# restore_files <file>...: exact prior content+mode, or removal when the file did not exist before this step.
restore_files() {
  local f
  for f in "$@"; do
    if [ -e "$f.bak-$TS" ]; then cp -p -- "$f.bak-$TS" "$f" || return 1
    elif [ -e "$f.absent-$TS" ]; then rm -f -- "$f" "$f.absent-$TS" || return 1
    else echo "restore_files: no backup marker for $f ($TS)" >&2; return 1; fi
  done
}
# install_reviewed <repo-path> <dest> <mode>: reviewed file -> dest atomically (call bak_files on dest first).
install_reviewed() {
  mkdir -p -- "$(dirname -- "$2")" && show "$1" >"$2.new-$TS" && chmod "$3" "$2.new-$TS" && mv -f -- "$2.new-$TS" "$2"
}
# bak_units <unit>...: unit files + enabled/active state; restore_units puts both back and daemon-reloads.
# State words are the first line systemctl prints (it exits non-zero for disabled/inactive: that is not "absent").
unit_state() { # unit_state is-enabled|is-active <unit> -> one word
  local s
  s="$(systemctl --user "$1" "$2" 2>/dev/null)" || true
  s="${s%%$'\n'*}"
  printf '%s\n' "${s:-absent}"
}
bak_units() {
  local u d="$HOME/.config/systemd/user"
  mkdir -p "$STATE_DIR"
  for u in "$@"; do
    bak_files "$d/$u" || return 1
    printf '%s %s\n' "$(unit_state is-enabled "$u")" "$(unit_state is-active "$u")" >"$STATE_DIR/$u.state-$TS"
  done
}
restore_units() {
  local u d="$HOME/.config/systemd/user" en act
  for u in "$@"; do # stop/disable what was not enabled+active before, while its unit file still exists
    read -r en act <"$STATE_DIR/$u.state-$TS" || return 1
    [ "$act" = active ] || systemctl --user stop "$u" 2>/dev/null || true
    [ "$en" = enabled ] || systemctl --user disable "$u" 2>/dev/null || true
  done
  for u in "$@"; do restore_files "$d/$u" || return 1; done
  systemctl --user daemon-reload || return 1
  for u in "$@"; do
    read -r en act <"$STATE_DIR/$u.state-$TS" || return 1
    if [ "$en" = enabled ]; then systemctl --user enable "$u" || return 1; fi
    if [ "$act" = active ]; then systemctl --user restart "$u" || return 1; fi
  done
}

# Overlay list: base + compose.prod.yml + every pre-8b overlay present, in the supported order 2-PREP -> 4.
# Reinstalling 2-PREP after STEP-4 keeps the STEP-4 overlay (R2-05).
compose_files_refresh() {
  local d="$PROD/.data/deploy" list="-f infra/docker-compose.yml -f .data/deploy/compose.prod.yml"
  [ -f "$d/compose.prod-2prep.yml" ] && list="$list -f .data/deploy/compose.prod-2prep.yml"
  [ -f "$d/compose.prod-step4.yml" ] && list="$list -f .data/deploy/compose.prod-step4.yml"
  printf '%s\n' "$list" >"$d/compose-files.txt" &&
    printf 'docker compose -p engram --env-file infra/image-pins.env --env-file .env.production %s\n' "$list" >"$d/compose-cmd.txt"
}

# PROD-STEP-4 is a FIRST install only (R2-05/R2-06): 2-PREP must already be applied, and no earlier replication
# install may exist (overlay, secret files or role) — its rollback drops the role, which is exact only then.
# Updating an existing PITR install needs its own reviewed procedure.
step4_precheck() {
  local d="$PROD/.data/deploy" s="$HOME/engram-ops/pitr/secrets" role
  [ -f "$d/compose.prod-2prep.yml" ] || { echo "step4_precheck: apply PROD-STEP-2-PREP first" >&2; return 1; }
  [ ! -e "$d/compose.prod-step4.yml" ] || { echo "step4_precheck: STEP-4 overlay already installed" >&2; return 1; }
  [ ! -e "$s/engram_replication.password" ] && [ ! -e "$s/engram_replication.pgpass" ] ||
    { echo "step4_precheck: replication secrets already exist" >&2; return 1; }
  role="$(docker exec engram-db-1 psql -X -U engram -Atc "select 1 from pg_roles where rolname = 'engram_replication'")" ||
    { echo "step4_precheck: cannot query pg_roles" >&2; return 1; }
  [ -z "$role" ] || { echo "step4_precheck: role engram_replication already exists" >&2; return 1; }
}

# PROD-STEP-4: build engram-db-pitr from the reviewed SHA exactly like Dockerfile.db documents; prints the tag.
step4_build() {
  local - w pg pitr
  set -o pipefail
  w="$(mktemp -d)" || return 1
  git -C "$DEV" archive "$SHA" infra/backup/pitr infra/backup/interim/engram-backup-pub.asc infra/image-pins.env |
    tar -x -C "$w" || return 1
  pg="$(grep '^POSTGRES_IMAGE=' "$w/infra/image-pins.env" | cut -d= -f2-)"
  pitr="$(grep '^POSTGRES_PITR_IMAGE=' "$w/infra/image-pins.env" | cut -d= -f2-)"
  [ -n "$pg" ] && [ -n "$pitr" ] || { echo "step4_build: pins missing" >&2; return 1; }
  flock -o "$HEAVY_LOCK" docker build -f "$w/infra/backup/pitr/Dockerfile.db" \
    --build-arg POSTGRES_IMAGE="$pg" -t "$pitr" "$w" >&2 || return 1
  rm -rf "$w"
  printf '%s\n' "$pitr"
}

# PROD-STEP-7: nginx. Reviewed source is read to a temp file and checked (non-empty, both engram server blocks)
# BEFORE the live file is touched (R2-04); then swap -> `nginx -t` in the container -> reload in the container.
# A failed `nginx -t` puts the backup back (no reload of the candidate ever happens).
nginx_test_reload() { docker exec "$NGINX_CONTAINER" nginx -t && docker exec "$NGINX_CONTAINER" nginx -s reload; }
step7_apply() { # step7_apply staged|final
  local - src="$NGINX_CONF.src-$TS" tmp="$NGINX_CONF.new-$TS"
  set -o pipefail
  case "$1" in staged | final) ;; *) echo "step7_apply: staged|final" >&2; return 1 ;; esac
  rm -f -- "$src" "$tmp"
  if ! show infra/nginx/engram.conf >"$src" || [ "$(grep -c 'server_name engram.zone17.click;' "$src")" -ne 2 ]; then
    echo "step7_apply: cannot read the reviewed infra/nginx/engram.conf at $SHA; live file untouched" >&2
    rm -f -- "$src"
    return 1
  fi
  if [ "$1" = staged ]; then
    sed 's/max-age=31536000; includeSubDomains/max-age=300/' "$src" >"$tmp" && grep -q 'max-age=300' "$tmp" || { rm -f -- "$src" "$tmp"; return 1; }
  else
    mv -f -- "$src" "$tmp" || return 1
  fi
  rm -f -- "$src"
  [ -e "$NGINX_CONF.bak-$TS" ] || bak_files "$NGINX_CONF" || { rm -f -- "$tmp"; return 1; }
  chmod --reference="$NGINX_CONF.bak-$TS" "$tmp" 2>/dev/null || true
  mv -f -- "$tmp" "$NGINX_CONF" || return 1
  if ! nginx_test_reload; then
    echo "step7_apply: nginx -t/reload failed, restoring $NGINX_CONF.bak-$TS" >&2
    cp -p -- "$NGINX_CONF.bak-$TS" "$NGINX_CONF" && nginx_test_reload
    return 1
  fi
}
step7_rollback() { cp -p -- "$NGINX_CONF.bak-$TS" "$NGINX_CONF" && nginx_test_reload; }
```
<!-- prodsteps-lib:end -->

Other conventions:

- `.data/deploy/compose-files.txt` holds the `-f` list (one line); `.data/deploy/compose-cmd.txt` keeps the full
  command for humans. Both are backed up and updated in the same step that adds an overlay.
- Secrets: generated or pasted **on bro only**, written with `umask 077`, never echoed, never in argv of a
  long-lived process, never in the repo, reports or chat. Verify with `grep -c '^NAME=' file`, never `cat`.
- Config output: `DC config` prints secrets. Only ever pipe it into `cfgcheck`, never to a terminal or file:

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
RETENTION, each its own GO. **Supported order constraint: 2-PREP before 4** (`step4_precheck` refuses otherwise;
a 2-PREP reinstall keeps an applied STEP-4 overlay via `compose_files_refresh`). 3, 6-INSTALL, 7 and RETENTION are
independent of each other and of 2-PREP/4 (RETENTION's WAL sweep and the monitor's WAL listing use an isolated
`docker run` of the POSTGRES_IMAGE pin, so they work before STEP-4, after it and after its rollback)
→ **only then** 8b (release) → 8c → 8d → 21c (incl. STEP-5).

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

1. Backup: `cd "$PROD"; bak_files .data/deploy/compose.prod.yml .data/deploy/compose-cmd.txt .data/deploy/compose-files.txt .data/deploy/compose.prod-2prep.yml .env.production`
2. Files (reviewed copies only):
   ```sh
   git -C "$DEV" show 4cbffff:infra/deploy/compose.prod.yml > .data/deploy/compose.prod.yml   # live + logging only
   install_reviewed infra/deploy/compose.prod-2prep.yml .data/deploy/compose.prod-2prep.yml 600
   chmod 600 .data/deploy/compose.prod.yml
   compose_files_refresh          # base + compose.prod.yml + 2-PREP (+ STEP-4 if already applied)
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
   DC up -d    # recreates containers for the logging/env change; no --build, same images
   ```
5. Verify:
   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' https://engram.zone17.click/api/v1/readyz        # 200
   for c in engram-db-1 engram-api-1 engram-worker-1 engram-web-1; do
     docker inspect -f '{{.Name}} {{.State.Status}} {{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}' $c
   done                                                     # running json-file {"max-file":"5","max-size":"20m"}
   docker run --rm --network none -v engram_engram-exports:/x "$(grep ^NODE_IMAGE= "$PROD/infra/image-pins.env" | cut -d= -f2)" \
     stat -c '%u %a' /x                                     # 65532 700
   docker exec engram-api-1 /app/api -healthcheck && echo api-ok
   ```
6. Rollback (immediate): `restore_files .data/deploy/compose.prod.yml .data/deploy/compose-cmd.txt .data/deploy/compose-files.txt .data/deploy/compose.prod-2prep.yml .env.production && DC up -d`
   (`compose-files.txt` did not exist before, so `DC` falls back to the P05 pair). The empty volume
   `engram_engram-exports` may stay.
7. Evidence: `ops-prod.md` §2-PREP (cfgcheck output, LogConfig, readyz, volume `65532 700`, TS of backups).

## PROD-STEP-3 — nightly encrypted `pg_dump` + off-host pull (requires Advisor GO)

State 2026-11-08 (read-only): `engram-backup.timer` installed and active (03:17 Asia/Ho_Chi_Minh, `Persistent=true`),
`~/engram-ops/backup/engram-backup.sh` identical to `infra/backup/interim/engram-backup.sh`, names
`engram-<YYYYmmddTHHMMSSZ>.dump.gpg` (source timestamp, contract (a)), `nightly/last.json` ok.

1. Verify the producer (no change unless the GO says so):
   ```sh
   systemctl --user list-timers engram-backup.timer
   cmp ~/engram-ops/backup/engram-backup.sh <(show infra/backup/interim/engram-backup.sh) && echo same
   cat ~/backups/engram/nightly/last.json         # ok:true, ts < 26 h
   ```
   If it differs: `bak_files ~/engram-ops/backup/engram-backup.sh && install_reviewed infra/backup/interim/engram-backup.sh ~/engram-ops/backup/engram-backup.sh 700`;
   rollback `restore_files ~/engram-ops/backup/engram-backup.sh`.
2. Decrypt check (`advisor-dec-P06-006`): the owner pulls `engram-20261107T060150Z.dump.gpg` (and the newest
   nightly) to the owner PC and runs `gpg -d <f> | pg_restore --list > /dev/null && echo DECRYPT_OK` there. The
   private key never comes to bro or the runner.
3. Off-host pull (Advisor script on the owner PC, retention contract (a)/(e)):
   - copies `nightly/*.gpg`, `pitr/base/*.gpg(.sha256)` and the WAL archive **keeping names**, verifies `sha256sum`,
     never renames, never uses `mtime`. The WAL dir is `999:999 0700`: read it without relaxing that, through an
     isolated read-only container: `ssh bro 'docker run --rm --network none --user 999:999 -v ~/backups/engram/pitr/wal:/w:ro <POSTGRES_IMAGE pin> tar -C /w -cf - .' | tar -x -C <pc copy>/pitr/wal`;
   - the PC copy has its OWN hourly sweep (PROD-STEP-RETENTION item 4); the pull may call the sweep again before
     copying, never instead of it;
   - writes back `~/backups/engram/offhost/last-pull.json` = `{"ts":"<ISO8601Z>","ok":true,"files":<n>}` (atomic
     `.tmp` + `mv`) after a successful pull; the monitor alerts when it is older than 26 h.
4. Verify: `cat ~/backups/engram/offhost/last-pull.json` fresh + ok; owner reports `DECRYPT_OK`.
5. Rollback: none on bro (read-only for production); disable the PC pull task if it misbehaves.
6. Evidence: `ops-prod.md` §3.

## PROD-STEP-4 — WAL archive + PITR base backups (requires Advisor GO, after Task 10 scratch PASS — C19)

Precondition: Task 10 `run-pitr-rehearsal.sh --scratch` PASS on cloud (dec-P06-034: PASS, 14a6653) and GO names
`PROD-STEP-4`. Procedure is exactly the one rehearsed (`docs/runbooks/backup-restore-pitr.md` §1, Task 9).
Restart of `db` ≈ 2–3 s; api/worker reconnect.

1. Precondition + backup + pre-dump (STEP-4 is a first install: 2-PREP applied, no prior replication install):
   ```sh
   cd "$PROD"
   step4_precheck && echo precheck-ok   # anything but precheck-ok = stop here and ask the Advisor
   systemctl --user start engram-backup.service && cat ~/backups/engram/nightly/last.json   # fresh ok:true
   bak_files .data/deploy/compose-files.txt .data/deploy/compose-cmd.txt .data/deploy/compose.prod-step4.yml .env.production
   bak_files ~/engram-ops/backup/pitr/engram-pitr-base.sh
   bak_units engram-pitr-base.service engram-pitr-base.timer
   docker exec engram-db-1 cat /var/lib/postgresql/data/pg_hba.conf > ~/engram-ops/pitr-pg_hba.conf.bak-$TS
   ```
2. Build the PITR image from the reviewed SHA (`--build-arg POSTGRES_IMAGE` = the pinned base; cloud-proven by
   `test-prod-steps-lib.sh build`):
   ```sh
   PIN=$(step4_build) && docker run --rm --network none --entrypoint sh "$PIN" -c \
     'command -v gpg && test -x /etc/postgresql/engram-wal-archive.sh && gosu postgres gpg --list-keys F2C47029212F6EE7A9D4D1779D5A1ABAB6A75AD7 >/dev/null && echo pitr-image-ok'
   ( umask 077; grep -q '^POSTGRES_PITR_IMAGE=' .env.production || printf 'POSTGRES_PITR_IMAGE=%s\n' "$PIN" >> .env.production )
   ```
   `infra/image-pins.env` in the production checkout is tracked (P05, no PITR pin): never edit it; the pin goes to
   the untracked `.env.production` (later `--env-file` wins). At 8b the P06 checkout's pin carries the same value.
3. Host files (must exist before `up`, else Docker creates directories):
   ```sh
   mkdir -p ~/backups/engram/pitr/{base,wal} ~/engram-ops/pitr/secrets
   ( umask 077; P=$(openssl rand -hex 24); \
     printf '%s' "$P" > ~/engram-ops/pitr/secrets/engram_replication.password; \
     printf '*:*:replication:engram_replication:%s\n' "$P" > ~/engram-ops/pitr/secrets/engram_replication.pgpass; unset P )
   sudo chown 999:999 ~/backups/engram/pitr/wal ~/engram-ops/pitr/secrets/engram_replication.{password,pgpass}
   sudo chmod 0700 ~/backups/engram/pitr/wal; sudo chmod 0600 ~/engram-ops/pitr/secrets/engram_replication.{password,pgpass}
   ```
4. Overlay + restart db:
   ```sh
   install_reviewed infra/deploy/compose.prod-step4.yml .data/deploy/compose.prod-step4.yml 600
   compose_files_refresh          # adds .data/deploy/compose.prod-step4.yml after the 2-PREP overlay
   cfgcheck | tail -1                     # db_image=engram-db-pitr:...
   DC up -d db && docker exec engram-db-1 psql -U engram -Atc "show archive_mode; show wal_keep_size"   # on / 2GB
   ```
5. Replication role + HBA + base timer (reviewed scripts, exactly as Task 9 / the rehearsal step (b)):
   ```sh
   docker exec -i engram-db-1 psql -X -U engram -v ON_ERROR_STOP=1 < <(show infra/backup/pitr/bootstrap-replication.sql)
   bash <(show infra/backup/pitr/engram-pitr-hba.sh) apply
   install_reviewed infra/backup/pitr/engram-pitr-base.sh ~/engram-ops/backup/pitr/engram-pitr-base.sh 700   # unit ExecStart path
   install_reviewed infra/backup/pitr/engram-pitr-base.service ~/.config/systemd/user/engram-pitr-base.service 644
   install_reviewed infra/backup/pitr/engram-pitr-base.timer ~/.config/systemd/user/engram-pitr-base.timer 644
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
   # If RETENTION is installed: its next sweep lists the WAL dir through the isolated run (no change needed):
   systemctl --user start engram-backup-expire.service 2>/dev/null; cat ~/backups/engram/expire/last-sweep.json 2>/dev/null
   ```
7. Rollback: `bash <(show infra/backup/pitr/engram-pitr-hba.sh) rollback` (drops role, removes the HBA line — exact
   prior state, because `step4_precheck` guaranteed no role/rule/secret existed before); remove the step's secret files
   (`sudo rm -f ~/engram-ops/pitr/secrets/engram_replication.{password,pgpass}`);
   `restore_units engram-pitr-base.service engram-pitr-base.timer; restore_files ~/engram-ops/backup/pitr/engram-pitr-base.sh`;
   `restore_files .data/deploy/compose-files.txt .data/deploy/compose-cmd.txt .data/deploy/compose.prod-step4.yml .env.production`;
   `DC up -d db` (back to the plain pin, archive off). The encrypted archive files stay (999:999 0700) and keep being
   swept by name through the isolated run.
8. Evidence: `ops-prod.md` §4 (archiver counters before/after, `last-base.json`, readyz).

## PROD-STEP-5 — real production restore (acceptance, not predeploy; release Task 21c)

After ≥ 6 days of PITR: the owner restores on the owner PC to `now − 6d` and to near `now` (Task 10 row 2,
`backup-restore-pitr.md` §2/§5 R1-11: decrypt on the PC, re-encrypt to a test key, scratch only). Evidence goes to
`docs/phases/evidence/P06/release.md` (Task 21c). Nothing runs on bro except the off-host pull.

## PROD-STEP-6-INSTALL — monitor + alerts (requires Advisor GO + owner `ALERT_WEBHOOK_URL`)

Owner input: a real `ALERT_WEBHOOK_URL`. **Empty → do not install; `P06-A9` stays BLOCKED (owner item).**
The reviewed monitor (dec-P06-059) passes the webhook URL to curl only through a stdin config (never argv), lists the
WAL dir through an isolated read-only `docker run`, and scrapes metrics on the api container's INTERNAL address
(edge `/api/v1/metrics` is 404 by design after STEP-7; the API guard rejects proxied requests).

1. Dependency preflight (host tools only; nothing is installed in this round):
   ```sh
   for c in docker curl python3 openssl timeout awk sha256sum; do command -v "$c" >/dev/null || echo "MISSING $c"; done
   ```
   Any `MISSING` = stop and ask the Advisor (no host `psql`/`gpg` needed: psql runs inside the DB container).
2. Backup + install reviewed files:
   ```sh
   M=~/engram-ops/monitor
   bak_files $M/engram-monitor.sh $M/monitor.env
   bak_units engram-monitor.service engram-monitor.timer
   install_reviewed infra/ops/engram-monitor.sh $M/engram-monitor.sh 700
   install_reviewed infra/ops/engram-monitor.service ~/.config/systemd/user/engram-monitor.service 644
   install_reviewed infra/ops/engram-monitor.timer ~/.config/systemd/user/engram-monitor.timer 644
   PG=$(grep ^POSTGRES_IMAGE= "$PROD/infra/image-pins.env" | cut -d= -f2-)
   set +x                                             # never trace a secret
   ( umask 077; read -rsp 'ALERT_WEBHOOK_URL: ' U; echo; \
     printf 'ALERT_WEBHOOK_URL=%s\nMONITOR_WAL_IMAGE=%s\n' "$U" "$PG" > $M/monitor.env; unset U )   # mode 0600
   grep -c '^ALERT_WEBHOOK_URL=.' $M/monitor.env   # 1
   ```
   Do **not** set `MONITOR_API_BASE_URL`: the monitor resolves the api container address itself (internal metrics).
3. Test alert, then enable:
   ```sh
   ( set +x -a; . $M/monitor.env; set +a; TEST_ALERT=1 $M/engram-monitor.sh ); echo rc=$?   # monitor un-exports the URL before any child
   python3 -c 'import json;print(json.load(open("'$M'/status.json"))["summary"])' | tr ';' '\n' | grep -E 'telemetry|deps' || echo internal-metrics-ok
   systemctl --user daemon-reload && systemctl --user enable --now engram-monitor.timer
   ```
   Owner confirms the `TEST_ALERT` message arrived. Before 8b the monitor legitimately reports CRIT for the
   missing worker/web healthchecks and (until STEP-4/RETENTION) the missing markers; listed in the evidence, not silenced.
4. Rollback: `restore_units engram-monitor.service engram-monitor.timer; restore_files $M/engram-monitor.sh $M/monitor.env`.
5. Evidence: `ops-prod.md` §6 (TEST_ALERT received, no telemetry/deps finding, timer listed). 4-container health = 21c.

## PROD-STEP-7 — nginx hardening + log scrub (requires Advisor GO)

Source: `infra/nginx/engram.conf` at `$SHA` (Task 8 ops-edge + dec-P06-059 live-behaviour fixes). Live file
`~/global-infra/nginx/conf.d/engram.conf` mounted in `global_nginx` (nginx 1.27.5). Whole-file live-vs-repo diff
(read-only, 2026-11-08), every difference intended:

| Repo vs live | Why |
|---|---|
| `map $uri $engram_log_uri` + `log_format ... $engram_log_uri` | export id scrub (Task 8, R1-18) |
| `server_tokens off` (both servers) | version hidden (Task 8) |
| `http2 on` | Task 8; nginx ≥ 1.25.1 (live 1.27.5) |
| HSTS `add_header ... always` + `proxy_hide_header Strict-Transport-Security` | single HSTS emitter (Task 8) |
| `location = /api/v1/metrics { return 404; }` | metrics never at the edge (Task 4/8) |
| `location ^~ /api/v1/exports/` (error_log crit, same proxy headers) | dec-P06-024 D |
| `resolver 127.0.0.11` in `location /` | dynamic upstream like the exports block |

Kept identical to live (dec-P06-059): `location ^~ /.well-known/acme-challenge/` + `default_type text/plain`,
`proxy_set_header Connection $connection_upgrade` (map defined at http level in `conf.d/zone17.conf`) and
`proxy_read_timeout 120s` in both proxied locations. If the live file changed since, re-diff before the GO.

1. Apply staged (HSTS `max-age=300`; backup, `nginx -t` and reload all inside `step7_apply`; a failed test restores
   the backup automatically): `step7_apply staged`
2. Verify:
   ```sh
   curl -sI https://engram.zone17.click/ | grep -iE '^(strict-transport-security|server):'   # max-age=300, no version
   curl -s -o /dev/null -w '%{http_code}\n' https://engram.zone17.click/app                  # 200 (or 307 to login)
   curl -s -o /dev/null -w '%{http_code}\n' https://engram.zone17.click/api/v1/metrics       # 404
   echo ok > ~/global-infra/certbot/www/.well-known/acme-challenge/step7-$TS 2>/dev/null &&
     curl -s http://engram.zone17.click/.well-known/acme-challenge/step7-$TS                 # ok (ACME path served)
   rm -f ~/global-infra/certbot/www/.well-known/acme-challenge/step7-$TS
   curl -s -o /dev/null "https://engram.zone17.click/api/v1/exports/00000000-0000-0000-0000-000000000000/download?canary=STEP7"
   docker logs --since 2m global_nginx 2>&1 | grep -c 'exports/{id}'                         # >= 1
   docker logs --since 2m global_nginx 2>&1 | grep -cE '00000000-0000|canary=STEP7'          # 0
   ```
   (The ACME webroot host path is whatever `global_nginx` mounts at `/var/www/certbot`; check with
   `docker inspect -f '{{json .Mounts}}' global_nginx` first.) Full canary procedure: `docs/phases/evidence/P06/ops-edge.md` §3.
3. Final HSTS (same GO, after WebAuthn/cookie check in a browser): `step7_apply final`; `curl -sI` shows
   `max-age=31536000; includeSubDomains`; repeat the ACME check.
4. Rollback (any time, from any directory): `step7_rollback` (restores `engram.conf.bak-$TS` by absolute path, then
   `nginx -t` + reload inside `global_nginx`). With `max-age=300` staged first, an HSTS rollback expires in 5 minutes.
5. Evidence: `ops-prod.md` §7.

## PROD-STEP-8 config — prepared here, applied by `release` at 8b (requires Advisor GO for 8b)

`infra/deploy/compose.prod.yml` at `$SHA` is the reviewed post-8b file. Diff vs the pre-8b live stack (C12):
`APP_ENV: production`; images `engram-{api,worker,web}:${ENGRAM_RELEASE_TAG}` (`p06-<sha>`, set in `.env.production`);
**`AUTH_MAIL_SINK_DIR: ''` in the anchor and again on `api` and `worker`** (do-not-delete comment kept);
`AUTH_MAIL_CAPTURE_AS_DELIVERY: 'false'`; `engram-mail` mounts/volume and `mail-sink-perms` retired; HTTPS
`APP_ORIGIN` required (production rejects http); worker `/app/worker -healthcheck` + web `fetch /api/v1/healthz`
healthchecks; 2-PREP and STEP-4 values folded in. At 8b the release lane:
```sh
cd "$PROD"; bak_files .data/deploy/compose.prod.yml .data/deploy/compose-files.txt .data/deploy/compose-cmd.txt .env.production
install_reviewed infra/deploy/compose.prod.yml .data/deploy/compose.prod.yml 600
echo '-f infra/docker-compose.yml -f .data/deploy/compose.prod.yml' > .data/deploy/compose-files.txt   # overlays dropped
cfgcheck   # api+worker APP_ENV=production AUTH_MAIL_SINK_DIR='' healthcheck=True; same_export_secret_api_worker=True
```
then follows `release-rollback.md` (checkout to the P06 SHA, `migrate up`, `up -d --build`, readyz, 4 containers
healthy). Rollback = `restore_files` of those four + `:pre-p06` images together; never run this file with the
`:pre-p06` image. Cloud proof: `infra/deploy/test-compose-prod.sh` (resolve + boot with/without SMTP).

## PROD-STEP-RETENTION — 8-day sweep, off-host rule, retire old plaintext (requires Advisor GO; prerequisite of 8b)

Contract: `backup-restore-pitr.md` "Retention contract" (a)–(e). Script: `infra/backup/expire/engram-backup-expire.sh`
(exact recognised names only, source timestamp in the name, deletes at ≥ 7d22h, anything unexpected kept and
reported `ok:false`), cloud-tested by `infra/backup/expire/test-expire.sh`. Until this step is done, the public
"8 days" copy must not be deployed (8b waits for it).

1. Inventory (read-only) + decrypt proof first:
   ```sh
   find ~/backups/engram -path ~/backups/engram/pitr/wal -prune -o -type f -printf '%P\n' | sort     # names only
   ```
   Old plaintext archives (`opsrecon baseline-ops.md:31`): `engram-pre-p04-20261102T041126Z.dump`,
   `engram-pre-p05-20261104T035150Z.dump` (+ `.sha256`), recognised by name. They go only after the owner has reported
   `DECRYPT_OK` for an encrypted nightly newer than them (STEP-3 item 2).
2. Backup + install:
   ```sh
   E=~/engram-ops/expire
   bak_files $E/engram-backup-expire.sh $E/expire.env
   bak_units engram-backup-expire.service engram-backup-expire.timer
   install_reviewed infra/backup/expire/engram-backup-expire.sh $E/engram-backup-expire.sh 700
   install_reviewed infra/backup/expire/engram-backup-expire.service ~/.config/systemd/user/engram-backup-expire.service 644
   install_reviewed infra/backup/expire/engram-backup-expire.timer ~/.config/systemd/user/engram-backup-expire.timer 644
   ( umask 077; printf 'EXPIRE_WAL_IMAGE=%s\n' "$(grep ^POSTGRES_IMAGE= "$PROD/infra/image-pins.env" | cut -d= -f2-)" > $E/expire.env )
   ```
   `EXPIRE_WAL_IMAGE` is the same before and after STEP-4: with no `pitr/wal` dir the WAL part is skipped; with it, the
   999:999 0700 dir is swept by name in `docker run --network none --user 999:999` (0700 never relaxed).
3. First sweep, then the timer:
   ```sh
   systemctl --user daemon-reload
   systemctl --user start engram-backup-expire.service; echo rc=$?
   cat ~/backups/engram/expire/last-sweep.json        # ok:true, fresh ts
   tail -n 20 ~/backups/engram/expire/expire.log      # DELETED lines name only expired recognised files
   systemctl --user enable --now engram-backup-expire.timer && systemctl --user list-timers engram-backup-expire.timer
   ```
   The first sweep deletes the plaintext `engram-pre-p0{4,5}-*` dumps once they are ≥ 7d22h old (both are by
   2026-11-12). If GO comes earlier and the owner has `DECRYPT_OK`, delete them explicitly by exact name
   (`rm -- ~/backups/engram/engram-pre-p04-20261102T041126Z.dump{,.sha256} ...`), never by glob.
   `ok:false` (unrecognised/future/bad-date backup name, scan or WAL error) = stop, read `expire.log`, fix, rerun; the
   monitor alerts. `env.production.bak-*` and `r1-vars.sh` are not backup files and are never swept.
   The interim `KEEP=7` count in `engram-backup.sh` stays (it only deletes earlier than the 7d22h rule).
4. Off-host (contract (e), dec-P06-059; installed on the owner PC by the Advisor after its own GO): the PC copy gets an
   **independent hourly, missed-run-aware** sweep with the same names and threshold —
   `infra/backup/expire/engram-offhost-expire.ps1` (Windows PowerShell 5.1/7) scheduled by
   `infra/backup/expire/engram-offhost-expire.task.xml` (hourly repetition, `StartWhenAvailable`, logon trigger,
   `IgnoreNew`). Install (PowerShell on the PC):
   ```powershell
   $x = (Get-Content engram-offhost-expire.task.xml -Raw) -replace '__SCRIPT__', '<abs path>\engram-offhost-expire.ps1' `
        -replace '__ROOT__', '<abs path of the copy>' -replace '__START__', (Get-Date).AddMinutes(5).ToString('s')
   Register-ScheduledTask -TaskName 'engram-offhost-expire' -TaskPath '\engram\' -Xml $x
   Start-ScheduledTask -TaskPath '\engram\' -TaskName 'engram-offhost-expire'   # first sweep now
   ```
   The pull may also run the script before copying; it never replaces the schedule. Proof: `test-offhost-expire.sh`
   (bash/PowerShell parity, task XML, 30-day simulation with daily/failed pulls and missed hourly sweeps). Residual
   risk: while the PC is powered off nothing can delete; the copy is swept at logon/next availability before anything
   else reads it.
5. Verify: `last-sweep.json` fresh + ok on bro; the PC `<copy>\expire\last-sweep.json` fresh + ok; `last-pull.json`
   fresh + ok; `find ~/backups/engram -name '*.dump' ! -name '*.gpg'` empty (no plaintext dump left); monitor clean.
6. Rollback: `restore_units engram-backup-expire.service engram-backup-expire.timer; restore_files $E/engram-backup-expire.sh $E/expire.env`
   (expired backup data is not restored: that is the contract).
7. Evidence: `ops-prod.md` §RETENTION.

## Missed-sweep bound (advisor-dec-P06-062)

With the Task 9 threshold 7d22h and an hourly timer: no missed run → deleted before 7d23h; one missed run → strictly
less than 8d (`test-expire.sh` c3 deletes at 7d23h30m; the 30-day simulation's worst case is 7d23h50m). Threshold
unchanged at 7d22h.
