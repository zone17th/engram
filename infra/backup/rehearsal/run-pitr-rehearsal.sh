#!/usr/bin/env bash
# engram PITR restore rehearsal (P06 Task 9/10, P06-A8).
#
#   run-pitr-rehearsal.sh [--scratch]           default. Throwaway cluster + throwaway GPG test key (mktemp -d):
#       baseline cluster on the CURRENT image with seed data (no replication role)
#       -> switch to engram-db-pitr + bootstrap-replication.sql + HBA + .pgpass exactly as PROD-STEP-4
#       -> real archive_command, pg_switch_wal, .gpg + .sha256 on the mount, pg_stat_archiver advances
#       -> engram-pitr-base.sh (recipient = test key) under write load + continuous CHECKPOINT
#       -> failure cases (no final file, no ok:true) -> T2 (+ consume RK) -> T_target -> T3
#       -> disaster -> restore base + WAL to T_target -> T2 100%, T3 absent, revoke sessions, migrate up, /readyz 200
#       -> RPO/RTO; canary replication password never in argv/logs.
#   run-pitr-rehearsal.sh --from-decrypted-stream --archive-dir DIR --gnupghome DIR --target-time TS
#       Owner PC only (R1-11, Task 21c): DIR holds base/ and wal/ already re-encrypted to the test key in
#       --gnupghome. Restores to TS, then table counts, session revoke, migrate up, /readyz.
#   run-pitr-rehearsal.sh --from-prod-archive   always refused: production archives are never restored on bro or
#       a runner (the production private key never leaves the owner PC).
#
# Needs: docker, gpg, curl, coreutils on the host. Only touches containers/volumes/networks named engram-dr-<id>.
# Prints KEY=VALUE evidence lines and ends with PITR_REHEARSAL=PASS (exit 0) or PITR_REHEARSAL=FAIL (exit 1).
# Functions run indirectly via trap/check (SC2317); single-quoted bash -c / sh -c bodies expand later (SC2016).
# shellcheck disable=SC2317,SC2016
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
pitr_src="$repo/infra/backup/pitr"

mode=scratch
archive_in=""
gnupg_in=""
target_in=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --scratch) mode=scratch ;;
    --from-decrypted-stream) mode=decrypted ;;
    --from-prod-archive) mode=prod ;;
    --archive-dir) archive_in="$2"; shift ;;
    --gnupghome) gnupg_in="$2"; shift ;;
    --target-time) target_in="$2"; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$mode" = prod ]; then
  echo "REFUSED: --from-prod-archive is not allowed (R1-11). Restore a production archive only on the owner PC:" >&2
  echo "decrypt locally, re-encrypt to a test key, then use --from-decrypted-stream." >&2
  exit 3
fi
if [ "$mode" = decrypted ] && { [ -d /home/ubuntu/projects/engram ] || [ "$(hostname)" = bro ]; }; then
  echo "REFUSED: --from-decrypted-stream runs on the owner PC only, never on the production host (R1-11)." >&2
  exit 3
fi

for bin in docker gpg curl sha256sum flock; do
  command -v "$bin" >/dev/null 2>&1 || { echo "missing required tool: $bin" >&2; exit 2; }
done

set -a
# shellcheck disable=SC1091
. "$repo/infra/image-pins.env"
set +a
: "${POSTGRES_IMAGE:?}" "${POSTGRES_PITR_IMAGE:?}" "${GO_BUILD_IMAGE:?}" "${DISTROLESS_IMAGE:?}"

rid="$(date -u +%H%M%S)$$"
P="engram-dr-$rid"
NET="$P-net"
SRC="$P-src"
DST="$P-dst"
API="$P-api"
VOL_SRC="$P-srcdata"
VOL_DST="$P-dstdata"
VOL_SEC="$P-secrets"
VOL_RGPG="$P-restoregpg"
APP_IMAGE="engram-dr-app:$rid"
PITR_IMAGE="$POSTGRES_PITR_IMAGE"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/engram-dr.XXXXXX")"
OUT="${ENGRAM_DR_OUT:-$repo/.data/pitr-rehearsal}"
mkdir -p "$OUT"
RUNLOG="$OUT/rehearsal-$rid.log"
TESTGPG="$WORK/gnupg"
PITR_DIR="$WORK/pitr"
WAL_HOST="$WORK/pitr/wal"
ARCH_IN_CT=/var/lib/postgresql/wal-archive
sampler_pid=""
load_pid=""
failures=0

exec > >(tee -a "$RUNLOG") 2>&1

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
ev() { printf '%s=%s\n' "$1" "$2"; printf '%s=%s\n' "$1" "$2" >>"$OUT/evidence-$rid.env"; }
check() { # check NAME condition-description command...
  local name="$1"; shift
  if "$@"; then ev "$name" PASS; else ev "$name" FAIL; failures=$((failures + 1)); fi
}
die() { say "FATAL: $*"; ev PITR_REHEARSAL FAIL; exit 1; }

cleanup() {
  set +e
  [ -n "$sampler_pid" ] && kill "$sampler_pid" 2>/dev/null
  [ -n "$load_pid" ] && kill "$load_pid" 2>/dev/null
  docker rm -f "$API" "$SRC" "$DST" "$P-pwmiss" >/dev/null 2>&1
  # Archive files are owned by the container's postgres uid; remove them from a container.
  [ -d "$WORK" ] && docker run --rm --user 0 -v "$WORK:/w" --entrypoint sh "$POSTGRES_IMAGE" -c 'rm -rf /w/pitr /w/sec' >/dev/null 2>&1
  [ -n "${tmpfs_dir:-}" ] && { sudo -n umount "$tmpfs_dir" 2>/dev/null || true; }
  docker volume rm -f "$VOL_SRC" "$VOL_DST" "$VOL_SEC" "$VOL_RGPG" "$P-pwmissdata" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  docker image rm -f "$APP_IMAGE" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'echo "FATAL: unexpected error at line $LINENO"; echo "PITR_REHEARSAL=FAIL"' ERR

epoch() { date -u +%s; }
psql_src() { docker exec -u postgres "$SRC" psql -X -At -q -v ON_ERROR_STOP=1 -U engram -d engram -c "$1"; }
psql_dst() { docker exec -u postgres "$DST" psql -X -At -q -v ON_ERROR_STOP=1 -U engram -d engram -c "$1"; }

wait_pg() { # container
  local c="$1" i
  for i in $(seq 1 120); do
    if docker exec -u postgres "$c" pg_isready -q -h /var/run/postgresql 2>/dev/null \
      && docker exec -u postgres "$c" psql -X -At -U engram -d engram -c 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs --tail 50 "$c"
  return 1
}

wait_init_done() { # container: official entrypoint restarts the server once after init
  local c="$1" i
  for i in $(seq 1 120); do
    docker logs "$c" 2>&1 | grep -q 'PostgreSQL init process complete' && break
    sleep 1
  done
  wait_pg "$c"
}

build_images() {
  say "build $PITR_IMAGE and app image"
  docker build -q -f "$pitr_src/Dockerfile.db" --build-arg POSTGRES_IMAGE="$POSTGRES_IMAGE" -t "$PITR_IMAGE" "$repo" >/dev/null
  docker build -q -f "$repo/apps/api/Dockerfile" --build-arg GO_BUILD_IMAGE="$GO_BUILD_IMAGE" \
    --build-arg DISTROLESS_IMAGE="$DISTROLESS_IMAGE" -t "$APP_IMAGE" "$repo" >/dev/null
  docker run --rm --user postgres --entrypoint sh "$PITR_IMAGE" -c 'command -v gpg && command -v gzip && gpg --version | head -n1' \
    | sed 's/^/  image tool: /'
}

migrate_up() { # host
  docker run --rm --network "$NET" -e DATABASE_URL="postgres://engram:engram@$1:5432/engram?sslmode=disable" \
    "$APP_IMAGE" /app/migrate up
}

make_test_key() {
  mkdir -p "$TESTGPG"
  chmod 700 "$TESTGPG"
  GNUPGHOME="$TESTGPG" gpg --batch --quiet --pinentry-mode loopback --passphrase '' \
    --quick-gen-key "engram-dr-test-$rid <dr-test@invalid>" default default never 2>/dev/null
  TEST_FPR="$(GNUPGHOME="$TESTGPG" gpg --batch --with-colons --list-keys | awk -F: '$1=="fpr"{print $10; exit}')"
  [ -n "$TEST_FPR" ] || die "test key generation failed"
  ev TEST_KEY_FPR "$TEST_FPR"
}

# ---------- argv/log canary sampler (R5-01) ----------
start_sampler() {
  : >"$WORK/argv.log"
  (
    set +e
    while :; do
      {
        for f in /proc/[0-9]*/cmdline; do { tr '\0' ' ' <"$f"; } 2>/dev/null; echo; done
        ps -eo args 2>/dev/null
        docker exec "$SRC" sh -c 'for f in /proc/[0-9]*/cmdline; do tr "\0" " " <"$f" 2>/dev/null; echo; done' 2>/dev/null
      } >>"$WORK/argv.log"
      sleep 0.2
    done
  ) &
  sampler_pid=$!
}
stop_sampler() {
  if [ -n "$sampler_pid" ]; then kill "$sampler_pid" 2>/dev/null || true; wait "$sampler_pid" 2>/dev/null || true; fi
  sampler_pid=""
}

# ---------- write load + continuous CHECKPOINT ----------
start_load() {
  (
    set +e
    i=0
    while :; do
      i=$((i + 1))
      docker exec -u postgres "$SRC" psql -X -q -U engram -d engram \
        -c "INSERT INTO dr_marker(phase, n, pad) SELECT 'load', g, repeat(md5(g::text), 8) FROM generate_series(1, 200) g" \
        -c 'CHECKPOINT' >/dev/null 2>&1 || true
      sleep 0.3
    done
  ) &
  load_pid=$!
}
stop_load() {
  if [ -n "$load_pid" ]; then kill "$load_pid" 2>/dev/null || true; wait "$load_pid" 2>/dev/null || true; fi
  load_pid=""
}

archived_count() { psql_src 'SELECT archived_count FROM pg_stat_archiver'; }
wait_archived_gt() { # n timeout_s
  local n="$1" t="$2" i
  for i in $(seq 1 "$t"); do
    [ "$(archived_count)" -gt "$n" ] && return 0
    sleep 1
  done
  return 1
}
wait_wal_archived() { # walname timeout_s : wait until pg_stat_archiver has archived >= walname
  local w="$1" t="$2" i last
  for i in $(seq 1 "$t"); do
    last="$(psql_src 'SELECT coalesce(last_archived_wal, $$$$) FROM pg_stat_archiver')"
    [ -n "$last" ] && [[ "$last" > "$w" || "$last" == "$w" ]] && return 0
    sleep 1
  done
  return 1
}
switch_and_wait() { # returns once the segment that held the switch is archived
  local w
  w="$(psql_src 'SELECT pg_walfile_name(pg_switch_wal())')"
  wait_wal_archived "$w" 120
}

base_count() { find "$PITR_DIR/base" -maxdepth 1 -name 'engram-base-*.tar.gz.gpg' 2>/dev/null | wc -l; }
partial_count() { find "$PITR_DIR/base" -maxdepth 1 -name '*.partial' 2>/dev/null | wc -l; }
last_base_sum() { sha256sum "$PITR_DIR/last-base.json" 2>/dev/null | awk '{print $1}'; }

run_base() { # env overrides as args: VAR=value ...
  env ENGRAM_DB_CONTAINER="$SRC" ENGRAM_PITR_DIR="$PITR_DIR" ENGRAM_BACKUP_GNUPGHOME="$TESTGPG" \
    ENGRAM_BACKUP_RECIPIENT="$TEST_FPR" "$@" bash "$pitr_src/engram-pitr-base.sh"
}

# Each failure case: base must exit != 0, leave no new final file, no .partial, last-base.json unchanged.
expect_base_fails() { # name, env overrides...
  local name="$1"; shift
  local before after sum_before rc
  before="$(base_count)"; sum_before="$(last_base_sum)"
  set +e; run_base "$@" >"$WORK/case-$name.log" 2>&1; rc=$?; set -e
  after="$(base_count)"
  say "case $name: exit=$rc finals_before=$before finals_after=$after partials=$(partial_count)"
  sed 's/^/    /' "$WORK/case-$name.log" | tail -n 3
  grep 'pg_basebackup: .*error' "$PITR_DIR/base.log" | tail -n 1 | sed 's/^/    /' || true
  [ "$rc" -ne 0 ] && [ "$after" -eq "$before" ] && [ "$(partial_count)" -eq 0 ] && [ "$(last_base_sum)" = "$sum_before" ]
}

kill_basebackup_in() { # container
  docker exec -u 0 "$1" sh -c 'for d in /proc/[0-9]*; do [ "$(cat $d/comm 2>/dev/null)" = pg_basebackup ] && kill -9 "${d#/proc/}"; done; true'
}

case_killed() {
  local before sum_before rc pid
  before="$(base_count)"; sum_before="$(last_base_sum)"
  run_base ENGRAM_PITR_MAX_RATE=256k >"$WORK/case-killed.log" 2>&1 &
  pid=$!
  sleep 4
  kill_basebackup_in "$SRC"
  set +e; wait "$pid"; rc=$?; set -e
  say "case pg_basebackup_killed: exit=$rc finals=$(base_count) partials=$(partial_count)"
  [ "$rc" -ne 0 ] && [ "$(base_count)" -eq "$before" ] && [ "$(partial_count)" -eq 0 ] && [ "$(last_base_sum)" = "$sum_before" ]
}

case_disk_full() {
  tmpfs_dir="$WORK/full"
  mkdir -p "$tmpfs_dir"
  local rc
  if sudo -n mount -t tmpfs -o size=1m,mode=0700,uid="$(id -u)",gid="$(id -g)" tmpfs "$tmpfs_dir" 2>/dev/null; then
    set +e
    env ENGRAM_DB_CONTAINER="$SRC" ENGRAM_PITR_DIR="$tmpfs_dir" ENGRAM_PITR_LOG="$WORK/case-disk.base.log" \
      ENGRAM_BACKUP_GNUPGHOME="$TESTGPG" ENGRAM_BACKUP_RECIPIENT="$TEST_FPR" \
      bash "$pitr_src/engram-pitr-base.sh" >"$WORK/case-disk.log" 2>&1
    rc=$?
    set -e
    local finals partials json
    finals="$(find "$tmpfs_dir/base" -name 'engram-base-*.tar.gz.gpg' | wc -l)"
    partials="$(find "$tmpfs_dir/base" -name '*.partial' | wc -l)"
    json=no; [ -e "$tmpfs_dir/last-base.json" ] && json=yes
    say "case disk_full: exit=$rc finals=$finals partials=$partials last-base.json=$json"
    sudo -n umount "$tmpfs_dir"; tmpfs_dir=""
    [ "$rc" -ne 0 ] && [ "$finals" -eq 0 ] && [ "$partials" -eq 0 ] && [ "$json" = no ]
  else
    say "case disk_full: cannot mount a 1 MiB tmpfs (sudo -n unavailable)"
    tmpfs_dir=""
    return 1
  fi
}

case_wal_recycled() {
  # wal_keep_size 0 + tiny max_wal_size + segment churn (pg_switch_wal + CHECKPOINT; data size stays flat)
  # while a throttled base runs:
  # the WAL that -X fetch needs is recycled, so the base must FAIL (no fallback to the gzip/GPG archive).
  psql_src "ALTER SYSTEM SET wal_keep_size = '0'" >/dev/null
  psql_src "ALTER SYSTEM SET max_wal_size = '32MB'" >/dev/null
  psql_src "ALTER SYSTEM SET min_wal_size = '32MB'" >/dev/null
  psql_src 'SELECT pg_reload_conf()' >/dev/null
  local before sum_before rc pid churn
  before="$(base_count)"; sum_before="$(last_base_sum)"
  run_base ENGRAM_PITR_MAX_RATE=512k >"$WORK/case-walrecycle.log" 2>&1 &
  pid=$!
  (
    while :; do
      docker exec -u postgres "$SRC" psql -X -q -U engram -d engram \
        -c "INSERT INTO dr_churn(pad) VALUES (md5(random()::text))" \
        -c 'SELECT pg_switch_wal()' -c 'CHECKPOINT' >/dev/null 2>&1 || true
      sleep 0.2
    done
  ) &
  churn=$!
  set +e; wait "$pid"; rc=$?; set -e
  kill "$churn" 2>/dev/null; wait "$churn" 2>/dev/null || true
  psql_src 'TRUNCATE dr_churn' >/dev/null
  psql_src 'ALTER SYSTEM RESET wal_keep_size' >/dev/null
  psql_src 'ALTER SYSTEM RESET max_wal_size' >/dev/null
  psql_src 'ALTER SYSTEM RESET min_wal_size' >/dev/null
  psql_src 'SELECT pg_reload_conf()' >/dev/null
  say "case wal_recycled: exit=$rc finals=$(base_count) partials=$(partial_count)"
  grep -iE 'removed|requested WAL segment' "$WORK/case-walrecycle.log" "$PITR_DIR/base.log" | tail -n 2 | sed 's/^/    /' || true
  [ "$rc" -ne 0 ] && [ "$(base_count)" -eq "$before" ] && [ "$(partial_count)" -eq 0 ] && [ "$(last_base_sum)" = "$sum_before" ]
}

case_bootstrap_missing_password() {
  # Fresh throwaway cluster without the secret mount: bootstrap must fail and set no password.
  docker run -d --name "$P-pwmiss" --network "$NET" -e POSTGRES_USER=engram -e POSTGRES_PASSWORD=engram \
    -e POSTGRES_DB=engram -v "$P-pwmissdata:/var/lib/postgresql/data" "$PITR_IMAGE" >/dev/null
  wait_init_done "$P-pwmiss" || return 1
  local rc
  set +e
  docker exec -i "$P-pwmiss" psql -X -U engram -v ON_ERROR_STOP=1 <"$pitr_src/bootstrap-replication.sql" \
    >"$WORK/case-pwmiss.log" 2>&1
  rc=$?
  set -e
  local role
  role="$(docker exec -u postgres "$P-pwmiss" psql -X -At -U engram -d engram \
    -c "SELECT count(*) FROM pg_authid WHERE rolname='engram_replication' AND rolpassword IS NOT NULL")"
  docker rm -f "$P-pwmiss" >/dev/null
  say "case bootstrap_missing_password_file: exit=$rc roles_with_password=$role"
  [ "$rc" -ne 0 ] && [ "$role" = 0 ]
}

# ---------- secrets (never in argv: written through stdin into a volume) ----------
write_secret() { # file-in-volume, host source file
  docker run --rm -i --user 0 -v "$VOL_SEC:/s" --entrypoint sh "$POSTGRES_IMAGE" \
    -c 'umask 077; cat >"/s/$1"; chown 999:999 "/s/$1"; chmod 0600 "/s/$1"' sh "$1" <"$2"
}

restore_from() { # archive_root(host, has base/ and wal/) gnupghome target_time -> sets RESTORE_* vars
  local root="$1" gpgdir="$2" target="$3" base
  base="$(find "$root/base" -maxdepth 1 -name 'engram-base-*.tar.gz.gpg' | sort | tail -n 1)"
  [ -n "$base" ] || die "no base backup in $root/base"
  (cd "$root/base" && sha256sum -c --quiet "$(basename "$base").sha256") || die "base checksum mismatch"
  say "restore base $(basename "$base") -> $VOL_DST"
  GNUPGHOME="$gpgdir" gpg --batch --quiet --decrypt "$base" \
    | docker run --rm -i --user 0 -v "$VOL_DST:/var/lib/postgresql/data" --entrypoint sh "$PITR_IMAGE" -c '
        set -e
        tar -xzf - -C /var/lib/postgresql/data
        touch /var/lib/postgresql/data/recovery.signal
        chown -R postgres:postgres /var/lib/postgresql/data
        chmod 0700 /var/lib/postgresql/data'
  GNUPGHOME="$gpgdir" gpg --batch --quiet --pinentry-mode loopback --passphrase '' --export-secret-keys \
    | docker run --rm -i --user 0 -v "$VOL_RGPG:/g" --entrypoint sh "$PITR_IMAGE" -c '
        set -e
        chown postgres:postgres /g; chmod 0700 /g
        gosu postgres env GNUPGHOME=/g gpg --batch --quiet --import'
  docker run -d --name "$DST" --network "$NET" \
    -v "$VOL_DST:/var/lib/postgresql/data" -v "$root/wal:$ARCH_IN_CT:ro" -v "$VOL_RGPG:/var/lib/postgresql/restore-gnupg" \
    -e ENGRAM_RESTORE_GNUPGHOME=/var/lib/postgresql/restore-gnupg \
    "$PITR_IMAGE" postgres -c config_file=/etc/postgresql/postgresql-pitr.conf -c archive_mode=off \
    -c "restore_command=/etc/postgresql/engram-wal-restore.sh %f %p" \
    -c "recovery_target_time=$target" -c recovery_target_action=promote >/dev/null
  local i
  for i in $(seq 1 3600); do
    if docker exec -u postgres "$DST" psql -X -At -U engram -d engram -c 'SELECT pg_is_in_recovery()' 2>/dev/null | grep -qx f; then
      return 0
    fi
    docker inspect -f '{{.State.Running}}' "$DST" | grep -qx true || { docker logs --tail 40 "$DST"; die "restore container stopped"; }
    sleep 1
  done
  die "recovery did not finish"
}

post_restore_open() { # revoke sessions + re-auth receipts (runbook pre-open), migrate up, api /readyz
  psql_dst 'UPDATE session SET revoked_at = now() WHERE revoked_at IS NULL' >/dev/null
  psql_dst 'DELETE FROM oauth_reauth_receipt' >/dev/null
  ev SESSIONS_ACTIVE_AFTER_REVOKE "$(psql_dst 'SELECT count(*) FROM session WHERE revoked_at IS NULL')"
  set +e; migrate_up "$DST" >"$WORK/migrate.log" 2>&1; local mrc=$?; set -e
  ev MIGRATE_UP_EXIT "$mrc"
  docker run -d --name "$API" --network "$NET" -p 127.0.0.1::8080 \
    -e DATABASE_URL="postgres://engram:engram@$DST:5432/engram?sslmode=disable" -e HTTP_ADDR=0.0.0.0:8080 \
    -e APP_ENV=development -e APP_ORIGIN=http://127.0.0.1:3000 -e EMBEDDING_PROVIDER=noop \
    -e AUTH_FAKE_OAUTH=true -e AUTH_MAIL_SINK_DIR=/tmp "$APP_IMAGE" /app/api >/dev/null
  local port code=000 i
  port="$(docker port "$API" 8080/tcp | head -n 1 | sed 's/.*://')"
  for i in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/v1/readyz" || true)"
    [ "$code" = 200 ] && break
    sleep 1
  done
  [ "$code" = 200 ] || docker logs --tail 30 "$API"
  ev READYZ "$code"
}

# =====================================================================================
if [ "$mode" = decrypted ]; then
  if [ ! -d "$archive_in/base" ] || [ ! -d "$archive_in/wal" ] || [ ! -d "$gnupg_in" ] || [ -z "$target_in" ]; then
    echo "--from-decrypted-stream needs --archive-dir (base/, wal/), --gnupghome, --target-time" >&2
    exit 2
  fi
  docker network create "$NET" >/dev/null
  build_images
  t_start="$(epoch)"
  restore_from "$archive_in" "$gnupg_in" "$target_in"
  ev RESTORED_TABLES "$(psql_dst "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  ev RESTORED_USERS "$(psql_dst 'SELECT count(*) FROM app_user')"
  post_restore_open
  ev RTO_SECONDS "$(( $(epoch) - t_start ))"
  if [ "$(grep -c '=FAIL$' "$OUT/evidence-$rid.env" || true)" -eq 0 ] && grep -qx 'READYZ=200' "$OUT/evidence-$rid.env"; then
    ev PITR_REHEARSAL PASS; exit 0
  fi
  ev PITR_REHEARSAL FAIL; exit 1
fi

# ------------------------------- scratch -------------------------------
say "scratch rehearsal $P, evidence $OUT/evidence-$rid.env"
docker network create "$NET" >/dev/null
build_images
make_test_key
mkdir -p "$PITR_DIR/base" "$WAL_HOST"
docker run --rm --user 0 -v "$WAL_HOST:/w" --entrypoint sh "$POSTGRES_IMAGE" -c 'chown 999:999 /w && chmod 0700 /w'

# (a) baseline cluster on the CURRENT image, seeded, no replication role
say "(a) baseline on $POSTGRES_IMAGE"
docker run -d --name "$SRC" --network "$NET" -e POSTGRES_USER=engram -e POSTGRES_PASSWORD=engram -e POSTGRES_DB=engram \
  -v "$VOL_SRC:/var/lib/postgresql/data" "$POSTGRES_IMAGE" >/dev/null
wait_init_done "$SRC" || die "baseline did not start"
migrate_up "$SRC" >"$WORK/migrate-baseline.log" 2>&1 || { cat "$WORK/migrate-baseline.log"; die "baseline migrate"; }
psql_src "
CREATE TABLE dr_marker (id bigserial PRIMARY KEY, phase text NOT NULL, n int NOT NULL, pad text,
                        at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE dr_churn (pad text);
CREATE TABLE dr_filler AS SELECT g AS id, encode(gen_random_bytes(400), 'hex') AS pad FROM generate_series(1, 60000) g;
INSERT INTO app_user (email) SELECT 'dr-' || g || '@example.invalid' FROM generate_series(1, 200) g;
INSERT INTO vault (user_id, kdf, vault_key_id, vault_key_wrapped_by_kek, x25519_public, ed25519_public, private_keys_wrapped)
  SELECT id, '{\"alg\":\"argon2id\"}'::jsonb, 'vk-' || id, gen_random_bytes(60), gen_random_bytes(32),
         gen_random_bytes(32), gen_random_bytes(96) FROM app_user;
INSERT INTO vault_recovery_key (vault_id, slot, lookup_hash, wrap)
  SELECT v.user_id, s, gen_random_bytes(32), gen_random_bytes(60) FROM vault v, generate_series(1, 10) s;
INSERT INTO session (user_id, refresh_token_hash, expires_at)
  SELECT id, gen_random_bytes(32), now() + interval '30 days' FROM app_user;
INSERT INTO dr_marker (phase, n) SELECT 'T1', g FROM generate_series(1, 1000) g;
" >/dev/null || die "seed"
ev SEED_USERS "$(psql_src 'SELECT count(*) FROM app_user')"
ev REPL_ROLE_BEFORE "$(psql_src "SELECT count(*) FROM pg_roles WHERE rolname='engram_replication'")"

# (b) switch the SAME data volume to engram-db-pitr + PROD-STEP-4 procedure
say "(b) switch to $PITR_IMAGE (archive_mode=on) + bootstrap-replication.sql + HBA + .pgpass"
CANARY="CANARY_REPL_PW_$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$CANARY" >"$WORK/canary.pattern"
printf '%s' "$CANARY" >"$WORK/pw"
printf '*:*:replication:engram_replication:%s\n' "$CANARY" >"$WORK/pgpass"
printf '*:*:replication:engram_replication:%s\n' "wrong-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')" >"$WORK/pgpass-wrong"
docker volume create "$VOL_SEC" >/dev/null
start_sampler
write_secret engram_replication.password "$WORK/pw"
write_secret engram_replication.pgpass "$WORK/pgpass"
write_secret wrong.pgpass "$WORK/pgpass-wrong"
rm -f "$WORK/pw" "$WORK/pgpass" "$WORK/pgpass-wrong"
docker stop -t 30 "$SRC" >/dev/null && docker rm "$SRC" >/dev/null
docker run -d --name "$SRC" --network "$NET" \
  -v "$VOL_SRC:/var/lib/postgresql/data" -v "$WAL_HOST:$ARCH_IN_CT" -v "$VOL_SEC:/run/secrets:ro" \
  -e ENGRAM_BACKUP_RECIPIENT="$TEST_FPR" \
  "$PITR_IMAGE" postgres -c config_file=/etc/postgresql/postgresql-pitr.conf >/dev/null
wait_pg "$SRC" || die "pitr cluster did not start"
GNUPGHOME="$TESTGPG" gpg --batch --armor --export "$TEST_FPR" | docker exec -i -u postgres "$SRC" gpg --batch --quiet --import
ev SRC_SETTINGS "$(psql_src "SELECT string_agg(name || '=' || setting, ',' ORDER BY name) FROM pg_settings WHERE name IN ('wal_level','archive_mode','archive_timeout','wal_keep_size')")"
docker exec -i "$SRC" psql -X -U engram -v ON_ERROR_STOP=1 <"$pitr_src/bootstrap-replication.sql" >"$WORK/bootstrap.log" 2>&1 \
  || { cat "$WORK/bootstrap.log"; die "bootstrap-replication.sql"; }
docker exec -i "$SRC" psql -X -U engram -v ON_ERROR_STOP=1 <"$pitr_src/bootstrap-replication.sql" >>"$WORK/bootstrap.log" 2>&1 \
  || die "bootstrap-replication.sql is not idempotent"
ENGRAM_DB_CONTAINER="$SRC" bash "$pitr_src/engram-pitr-hba.sh" apply
ENGRAM_DB_CONTAINER="$SRC" bash "$pitr_src/engram-pitr-hba.sh" apply >/dev/null
ev HBA_RULE_LINES "$(docker exec -u postgres "$SRC" grep -cxF 'local replication engram_replication scram-sha-256' /var/lib/postgresql/data/pg_hba.conf)"
ev REPL_ROLE_SCRAM "$(psql_src "SELECT count(*) FROM pg_authid WHERE rolname='engram_replication' AND rolreplication AND rolpassword LIKE 'SCRAM-SHA-256%'")"

# archive_command for real
c0="$(archived_count)"
ev ARCHIVED_COUNT_BEFORE "$c0"
psql_src "INSERT INTO dr_marker (phase, n) SELECT 'A', g FROM generate_series(1, 100) g" >/dev/null
switch_and_wait || die "archiver did not archive after pg_switch_wal"
c1="$(archived_count)"
ev ARCHIVED_COUNT_AFTER_SWITCH "$c1"
lastwal="$(psql_src 'SELECT last_archived_wal FROM pg_stat_archiver')"
arch_files="$(docker exec -u postgres "$SRC" sh -c "ls $ARCH_IN_CT")"
check ARCHIVE_FILE_GPG_AND_SHA256 bash -c '
  f="$(printf "%s\n" "$1" | grep -E "^[0-9]{8}T[0-9]{6}Z--$2\.gz\.gpg$" | head -n1)"
  [ -n "$f" ] && printf "%s\n" "$1" | grep -qxF "$f.sha256"' _ "$arch_files" "$lastwal"
check ARCHIVER_ADVANCED test "$c1" -gt "$c0"
ev ARCHIVER_FAILED_COUNT "$(psql_src 'SELECT failed_count FROM pg_stat_archiver')"
# restore_command strips the <ts>-- prefix and verifies the plaintext sha256 (round trip with the test key).
GNUPGHOME="$TESTGPG" gpg --batch --quiet --pinentry-mode loopback --passphrase '' --export-secret-keys \
  | docker exec -i -u postgres "$SRC" sh -c 'umask 077; mkdir -p /tmp/rg && GNUPGHOME=/tmp/rg gpg --batch --quiet --import'
check RESTORE_COMMAND_ROUNDTRIP docker exec -u postgres -e ENGRAM_RESTORE_GNUPGHOME=/tmp/rg "$SRC" sh -c \
  "/etc/postgresql/engram-wal-restore.sh $lastwal /tmp/rt.wal && test \"\$(sha256sum </tmp/rt.wal | cut -d' ' -f1)\" = \"\$(cat $ARCH_IN_CT/*--$lastwal.gz.gpg.sha256 | cut -d' ' -f1)\" && ! /etc/postgresql/engram-wal-restore.sh FFFFFFFFFFFFFFFFFFFFFFFF /tmp/none.wal"
docker exec -u 0 "$SRC" rm -rf /tmp/rg /tmp/rt.wal

# base backup under write load + continuous CHECKPOINT
say "base backup (engram-pitr-base.sh, recipient = test key) under write load + CHECKPOINT"
start_load
sleep 2
t_base0="$(epoch)"
run_base >"$WORK/base-ok.log" 2>&1 || { cat "$WORK/base-ok.log" "$PITR_DIR/base.log"; die "engram-pitr-base.sh failed"; }
base_secs=$(( $(epoch) - t_base0 ))
stop_load
ev BASE_SECONDS "$base_secs"
ev LAST_BASE_JSON "$(cat "$PITR_DIR/last-base.json")"
check LAST_BASE_OK grep -q '"ok":true' "$PITR_DIR/last-base.json"
check BASE_SHA256_FILE bash -c 'cd "$1/base" && sha256sum -c --quiet engram-base-*.tar.gz.gpg.sha256' _ "$PITR_DIR"
check BASE_IS_ENCRYPTED bash -c '! gzip -t "$1"/base/engram-base-*.tar.gz.gpg 2>/dev/null' _ "$PITR_DIR"
stop_sampler
start_sampler

# WAL rate (for wal_keep_size sizing)
lsn0="$(psql_src 'SELECT pg_current_wal_lsn()')"
start_load; sleep 20; stop_load
lsn1="$(psql_src 'SELECT pg_current_wal_lsn()')"
ev WAL_RATE_BYTES_PER_SEC_UNDER_LOAD "$(psql_src "SELECT (pg_wal_lsn_diff('$lsn1','$lsn0') / 20)::bigint")"

# failure cases: no final file, no .partial, last-base.json unchanged, exit != 0
say "failure cases"
check CASE_WRONG_PGPASS expect_base_fails wrong_pgpass ENGRAM_REPL_PGPASSFILE=/run/secrets/wrong.pgpass
check CASE_MISSING_PGPASS expect_base_fails missing_pgpass ENGRAM_REPL_PGPASSFILE=/run/secrets/absent.pgpass
check CASE_GPG_MISSING expect_base_fails gpg_missing ENGRAM_GPG=/nonexistent/gpg
check CASE_PG_BASEBACKUP_KILLED case_killed
check CASE_DISK_FULL case_disk_full
check CASE_WAL_RECYCLED_NO_ARCHIVE_FALLBACK case_wal_recycled
check CASE_BOOTSTRAP_MISSING_PASSWORD_FILE case_bootstrap_missing_password
stop_sampler

# canary: argv (host + container), container logs, run log, case logs
docker logs "$SRC" >"$WORK/src-container.log" 2>&1
hits=0
for f in "$WORK/argv.log" "$WORK/src-container.log" "$RUNLOG" "$WORK"/case-*.log "$WORK/bootstrap.log" "$PITR_DIR/base.log"; do
  [ -f "$f" ] || continue
  n="$(grep -cFf "$WORK/canary.pattern" "$f" || true)"
  hits=$((hits + n))
done
ev CANARY_ARGV_SAMPLES "$(wc -l <"$WORK/argv.log")"
ev CANARY_HITS "$hits"
check CANARY_ABSENT test "$hits" -eq 0
rm -f "$WORK/canary.pattern"

# T2 (+ consume one RK, as POST /vault/recover/complete does) -> T_target -> T3
say "T2 -> T_target -> T3"
rk_consumed="$(psql_src "DELETE FROM vault_recovery_key WHERE id = (SELECT id FROM vault_recovery_key ORDER BY id LIMIT 1) RETURNING id")"
psql_src "INSERT INTO dr_marker (phase, n) SELECT 'T2', g FROM generate_series(1, 500) g" >/dev/null
t2_commit="$(psql_src "SELECT max(at) FROM dr_marker WHERE phase = 'T2'")"
switch_and_wait || die "T2 WAL not archived"
sleep 2
T_TARGET="$(psql_src "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
sleep 2
psql_src "INSERT INTO dr_marker (phase, n) SELECT 'T3', g FROM generate_series(1, 300) g" >/dev/null
psql_src "INSERT INTO session (user_id, refresh_token_hash, expires_at) SELECT id, gen_random_bytes(32), now() + interval '1 day' FROM app_user LIMIT 5" >/dev/null
t3_commit_epoch="$(psql_src "SELECT extract(epoch FROM max(at))::bigint FROM dr_marker WHERE phase = 'T3'")"
t3_lsn="$(psql_src 'SELECT pg_walfile_name(pg_current_wal_insert_lsn())')"
ev T_TARGET "$T_TARGET"
ev RK_CONSUMED_AT_T2 "$rk_consumed"

# RPO: no manual switch; archive_timeout alone must ship the T3 segment.
say "waiting for archive_timeout to ship the T3 segment (<= 300s)"
wait_wal_archived "$t3_lsn" 900 || die "T3 segment not archived within 15 min"
t3_archived_epoch="$(psql_src 'SELECT extract(epoch FROM last_archived_time)::bigint FROM pg_stat_archiver')"
rpo=$((t3_archived_epoch - t3_commit_epoch))
ev RPO_SECONDS "$rpo"
c2="$(archived_count)"
ev ARCHIVED_COUNT_AFTER "$c2"
ev ARCHIVER_FAILED_COUNT_AFTER "$(psql_src 'SELECT failed_count FROM pg_stat_archiver')"
expect_t1="$(psql_src "SELECT count(*) FROM dr_marker WHERE phase = 'T1'")"
expect_users="$(psql_src 'SELECT count(*) FROM app_user')"

# disaster: source gone. RTO clock starts.
say "disaster: removing source cluster"
t_disaster="$(epoch)"
docker rm -f "$SRC" >/dev/null
docker volume rm -f "$VOL_SRC" >/dev/null

restore_from "$PITR_DIR" "$TESTGPG" "$T_TARGET"

t1_got="$(psql_dst "SELECT count(*) FROM dr_marker WHERE phase = 'T1'")"
t2_got="$(psql_dst "SELECT count(*) FROM dr_marker WHERE phase = 'T2'")"
t3_got="$(psql_dst "SELECT count(*) FROM dr_marker WHERE phase = 'T3'")"
rk_back="$(psql_dst "SELECT count(*) FROM vault_recovery_key WHERE id = '$rk_consumed'")"
ev T1_PRESENT "$t1_got/$expect_t1"
ev T2_PRESENT "$t2_got/500"
ev T3_PRESENT "$t3_got"
ev USERS_PRESENT "$(psql_dst 'SELECT count(*) FROM app_user')/$expect_users"
ev RK_CONSUMED_STILL_CONSUMED "$([ "$rk_back" = 0 ] && echo yes || echo no)"
ev T2_LAST_COMMIT "$t2_commit"
check T1_COMPLETE test "$t1_got" = "$expect_t1"
check T2_COMPLETE test "$t2_got" = 500
check T3_ABSENT test "$t3_got" = 0
check RK_STAYS_CONSUMED test "$rk_back" = 0

post_restore_open
t_ready="$(epoch)"
rto=$((t_ready - t_disaster))
ev RTO_SECONDS "$rto"
check SESSIONS_REVOKED grep -qx 'SESSIONS_ACTIVE_AFTER_REVOKE=0' "$OUT/evidence-$rid.env"
check MIGRATE_UP grep -qx 'MIGRATE_UP_EXIT=0' "$OUT/evidence-$rid.env"
check READYZ_200 grep -qx 'READYZ=200' "$OUT/evidence-$rid.env"
check RPO_LE_15M test "$rpo" -le 900
check RTO_LE_2H test "$rto" -le 7200
check ARCHIVED_COUNT_INCREASED test "$c2" -gt "$c0"

if [ "$failures" -eq 0 ]; then
  ev PITR_REHEARSAL PASS
  exit 0
fi
say "$failures check(s) failed"
ev PITR_REHEARSAL FAIL
exit 1
