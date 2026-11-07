#!/usr/bin/env bash
# engram PITR restore rehearsal (P06 Task 9/10, P06-A8).
#
#   run-pitr-rehearsal.sh [--scratch]           default. Throwaway cluster + throwaway GPG test key (mktemp -d):
#       baseline cluster on the CURRENT image with seed data (no replication role, non-fixture DB password)
#       -> switch to engram-db-pitr + bootstrap-replication.sql + HBA + .pgpass exactly as PROD-STEP-4
#       -> real archive_command, pg_switch_wal, .gpg + .sha256 on the mount, pg_stat_archiver advances
#       -> engram-pitr-base.sh (recipient = test key) under write load + continuous CHECKPOINT
#       -> failure cases, each with its own cause assertion (no final file, no ok:true)
#       -> T2 (+ consume RK) -> T_target -> T3 -> later base -> T4 -> T_near
#       -> disaster -> restore to T_target (picks the newest base BEFORE the target) -> T2 100%, T3 absent,
#          revoke sessions, migrate up, /readyz 200; reject a target older than every base;
#          restore again to T_near from the same directory (picks the later base)
#       -> RPO/RTO; canary replication password never in argv/logs.
#   run-pitr-rehearsal.sh --from-decrypted-stream --archive-dir DIR --gnupghome DIR --target-time TS
#                         [--capture-time TS]
#       Owner PC only (R1-11, Task 21c): DIR holds base/ and wal/ converted to the test key in --gnupghome by
#       convert-archive-to-test-key.sh. Restores to TS with a restore-only HBA (no production credential needed),
#       then the same mandatory post-restore assertions (sessions revoked, migrate up exit 0, /readyz 200,
#       RTO <= 2h). RPO is NOT accepted here (advisor-dec-P06-029): ARCHIVE_FRESHNESS_SECONDS (capture time minus
#       the newest WAL file's archive_command time) is telemetry only and RPO_ACCEPTANCE=UNMEASURED_OWNER always;
#       production RPO is measured in Task 21c against a source commit/LSN boundary.
#   run-pitr-rehearsal.sh --from-prod-archive   always refused: production archives are never restored on bro or
#       a runner (the production private key never leaves the owner PC).
#
# Needs: docker, gpg, curl, GNU date/coreutils on the host. Only touches containers/volumes/networks named
# engram-dr-<id>. Prints KEY=VALUE evidence lines and ends with PITR_REHEARSAL=PASS (exit 0) or FAIL (exit 1).
# RTO here is a warm measurement: images are built and the archive is local before the clock starts.
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
capture_in=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --scratch) mode=scratch ;;
    --from-decrypted-stream) mode=decrypted ;;
    --from-prod-archive) mode=prod ;;
    --archive-dir) archive_in="$2"; shift ;;
    --gnupghome) gnupg_in="$2"; shift ;;
    --target-time) target_in="$2"; shift ;;
    --capture-time) capture_in="$2"; shift ;;
    -h | --help) sed -n '2,/^# shellcheck/p' "$0"; exit 0 ;;
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

for bin in docker gpg curl sha256sum flock date; do
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
VOL_RHBA="$P-restorehba"
VOL_RWAL="$P-restorewal"
APP_IMAGE="engram-dr-app:$rid"
PITR_IMAGE="$POSTGRES_PITR_IMAGE"
DB_USER="${ENGRAM_DR_DB_USER:-engram}"
DB_NAME="${ENGRAM_DR_DB_NAME:-engram}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/engram-dr.XXXXXX")"
OUT="${ENGRAM_DR_OUT:-$repo/.data/pitr-rehearsal}"
mkdir -p "$OUT"
RUNLOG="$OUT/rehearsal-$rid.log"
EVID="$OUT/evidence-$rid.env"
TESTGPG="$WORK/gnupg"
PITR_DIR="$WORK/pitr"
WAL_HOST="$WORK/pitr/wal"
ARCH_IN_CT=/var/lib/postgresql/wal-archive
ARGV_LOG="$WORK/argv.log"
sampler_pid=""
load_pid=""
tmpfs_dir=""
failures=0
: >"$ARGV_LOG"

exec > >(tee -a "$RUNLOG") 2>&1

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
ev_prefix=""
ev() { printf '%s%s=%s\n' "$ev_prefix" "$1" "$2"; printf '%s%s=%s\n' "$ev_prefix" "$1" "$2" >>"$EVID"; }
check() { # check NAME command...  -> NAME=PASS|FAIL, failures counted
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
  [ -d "$WORK" ] && docker run --rm --user 0 -v "$WORK:/w" --entrypoint sh "$POSTGRES_IMAGE" -c 'rm -rf /w/pitr /w/conv' >/dev/null 2>&1
  [ -n "$tmpfs_dir" ] && sudo -n umount "$tmpfs_dir" 2>/dev/null
  docker volume rm -f "$VOL_SRC" "$VOL_DST" "$VOL_SEC" "$VOL_RGPG" "$VOL_RHBA" "$VOL_RWAL" "$P-pwmissdata" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  docker image rm -f "$APP_IMAGE" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'echo "FATAL: unexpected error at line $LINENO"; echo "PITR_REHEARSAL=FAIL"' ERR

epoch() { date -u +%s; }
psql_src() { docker exec -u postgres "$SRC" psql -X -At -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "$1"; }
psql_dst() { docker exec -u postgres "$DST" psql -X -At -q -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" -c "$1"; }

wait_pg() { # container
  local c="$1"
  for _ in $(seq 1 120); do
    if docker exec -u postgres "$c" pg_isready -q -h /var/run/postgresql 2>/dev/null \
      && docker exec -u postgres "$c" psql -X -At -U "$DB_USER" -d "$DB_NAME" -c 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs --tail 50 "$c"
  return 1
}

wait_init_done() { # container: official entrypoint restarts the server once after init
  local c="$1"
  for _ in $(seq 1 120); do
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

# Restore-only access: the restored cluster keeps its archived roles/passwords untouched; the isolated restore
# container is started with its own HBA (trust on the socket and on the private scratch network only).
db_url() { printf 'postgres://%s@%s:5432/%s?sslmode=disable' "$DB_USER" "$1" "$DB_NAME"; }
migrate_up() { docker run --rm --network "$NET" -e DATABASE_URL="$(db_url "$1")" "$APP_IMAGE" /app/migrate up; }

make_key() { # homedir uid-label -> prints fingerprint
  mkdir -p "$1"; chmod 700 "$1"
  GNUPGHOME="$1" gpg --batch --quiet --pinentry-mode loopback --passphrase '' \
    --quick-gen-key "engram-dr-$2-$rid <dr-test@invalid>" default default never 2>/dev/null
  GNUPGHOME="$1" gpg --batch --with-colons --list-keys | awk -F: '$1=="fpr"{print $10; exit}'
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

# ---------- argv canary sampler (R5-01): one log for the whole run, appended across restarts ----------
start_sampler() {
  (
    set +e
    while :; do
      {
        for f in /proc/[0-9]*/cmdline; do { tr '\0' ' ' <"$f"; } 2>/dev/null; echo; done
        ps -eo args 2>/dev/null
        docker exec "$SRC" sh -c 'for f in /proc/[0-9]*/cmdline; do tr "\0" " " <"$f" 2>/dev/null; echo; done' 2>/dev/null
      } >>"$ARGV_LOG"
      sleep 0.1
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
    while :; do
      docker exec -u postgres "$SRC" psql -X -q -U "$DB_USER" -d "$DB_NAME" \
        -c "INSERT INTO dr_marker(phase, n, pad) SELECT 'load', g, repeat(md5(g::text), 8) FROM generate_series(1, 200) g" \
        -c 'CHECKPOINT' >/dev/null 2>&1
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
wait_wal_archived() { # walname timeout_s : until pg_stat_archiver has archived >= walname
  local w="$1" t="$2" last
  for _ in $(seq 1 "$t"); do
    last="$(psql_src 'SELECT coalesce(last_archived_wal, $$$$) FROM pg_stat_archiver')"
    [ -n "$last" ] && [[ "$last" > "$w" || "$last" == "$w" ]] && return 0
    sleep 1
  done
  return 1
}
switch_and_wait() {
  local w
  w="$(psql_src 'SELECT pg_walfile_name(pg_switch_wal())')"
  wait_wal_archived "$w" 120
}
utc_now_sql() { psql_src "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'"; }

base_count() { find "$PITR_DIR/base" -maxdepth 1 -name 'engram-base-*.tar.gz.gpg' 2>/dev/null | wc -l; }
sha_count() { find "$PITR_DIR/base" -maxdepth 1 -name 'engram-base-*.tar.gz.gpg.sha256' 2>/dev/null | wc -l; }
partial_count() { find "$PITR_DIR/base" -maxdepth 1 -name '*.partial' 2>/dev/null | wc -l; }
json_tmp_count() { find "$PITR_DIR" -maxdepth 1 -name 'last-base.json.tmp*' 2>/dev/null | wc -l; }
last_base_sum() { sha256sum "$PITR_DIR/last-base.json" 2>/dev/null | awk '{print $1}'; }

run_base() { # VAR=value overrides...
  env ENGRAM_DB_CONTAINER="$SRC" ENGRAM_PITR_DIR="$PITR_DIR" ENGRAM_BACKUP_GNUPGHOME="$TESTGPG" \
    ENGRAM_BACKUP_RECIPIENT="$TEST_FPR" "$@" bash "$pitr_src/engram-pitr-base.sh"
}

# No-publication invariant shared by every failure case.
snap_outputs() { snap="$(base_count) $(sha_count) $(last_base_sum)"; }
outputs_unchanged() {
  [ "$(base_count) $(sha_count) $(last_base_sum)" = "$snap" ] && [ "$(partial_count)" -eq 0 ] && [ "$(json_tmp_count)" -eq 0 ]
}
cause_in() { # log regex
  grep -qiE "$2" "$1"
}

# Per-case cause patterns (asserted on that invocation's own log only).
declare -A CAUSE=(
  [wrong_pgpass]='password authentication failed'
  [missing_pgpass]='no password supplied'
  [gpg_missing]='gpg not found'
  [killed]='pg_basebackup exit (137|143|1)\b'
  [disk_full]='no space left on device'
  [wal_recycled]='requested WAL segment .* has already been removed'
  [after_publish]='rename last-base\.json'
  [concurrent]='another base backup is running'
  [bootstrap_pw]='replication password file missing|No such file'
)

expect_base_fails() { # case-name VAR=value...
  local name="$1"; shift
  local rc log="$WORK/case-$name.log"
  snap_outputs
  rc=0; run_base ENGRAM_PITR_LOG="$WORK/case-$name.base.log" "$@" >"$log" 2>&1 || rc=$?
  say "case $name: exit=$rc"; sed 's/^/    /' "$log" | tail -n 4
  [ "$rc" -ne 0 ] && outputs_unchanged && cause_in "$log" "${CAUSE[$name]}"
}

wait_proc_in() { # container comm timeout_s
  for _ in $(seq 1 "$3"); do
    docker exec -u 0 "$1" sh -c "for d in /proc/[0-9]*; do [ \"\$(cat \$d/comm 2>/dev/null)\" = $2 ] && exit 0; done; exit 1" && return 0
    sleep 0.2
  done
  return 1
}
kill_basebackup_in() { # prints number of pg_basebackup processes killed
  docker exec -u 0 "$1" sh -c 'n=0; for d in /proc/[0-9]*; do if [ "$(cat $d/comm 2>/dev/null)" = pg_basebackup ]; then kill -9 "${d#/proc/}" && n=$((n+1)); fi; done; echo $n'
}

case_killed() {
  local rc pid killed log="$WORK/case-killed.log"
  snap_outputs
  run_base ENGRAM_PITR_LOG="$WORK/case-killed.base.log" ENGRAM_PITR_MAX_RATE=256k >"$log" 2>&1 &
  pid=$!
  wait_proc_in "$SRC" pg_basebackup 50 || { say "case killed: pg_basebackup never started"; wait "$pid" || true; return 1; }
  sleep 1
  [ "$(find "$PITR_DIR/base" -maxdepth 1 -name '*.partial' | wc -l)" -ge 1 ] || { say "case killed: no .partial while streaming"; }
  killed="$(kill_basebackup_in "$SRC")"
  rc=0; wait "$pid" || rc=$?
  say "case pg_basebackup_killed: killed=$killed exit=$rc"; sed 's/^/    /' "$log" | tail -n 3
  [ "$killed" -ge 1 ] && [ "$rc" -ne 0 ] && outputs_unchanged && cause_in "$log" "${CAUSE[killed]}" \
    && ! cause_in "$log" "${CAUSE[wrong_pgpass]}|${CAUSE[missing_pgpass]}|${CAUSE[gpg_missing]}"
}

case_disk_full() {
  tmpfs_dir="$WORK/full"
  mkdir -p "$tmpfs_dir"
  local rc log="$WORK/case-disk_full.log"
  if ! sudo -n mount -t tmpfs -o size=1m,mode=0700,uid="$(id -u)",gid="$(id -g)" tmpfs "$tmpfs_dir" 2>/dev/null; then
    say "case disk_full: cannot mount a 1 MiB tmpfs (sudo -n unavailable)"
    tmpfs_dir=""
    return 1
  fi
  set +e
  env ENGRAM_DB_CONTAINER="$SRC" ENGRAM_PITR_DIR="$tmpfs_dir" ENGRAM_PITR_LOG="$WORK/case-disk_full.base.log" \
    ENGRAM_BACKUP_GNUPGHOME="$TESTGPG" ENGRAM_BACKUP_RECIPIENT="$TEST_FPR" \
    bash "$pitr_src/engram-pitr-base.sh" >"$log" 2>&1
  rc=$?
  set -e
  local finals leftovers json
  finals="$(find "$tmpfs_dir/base" -name 'engram-base-*' ! -name '*.partial' | wc -l)"
  leftovers="$(find "$tmpfs_dir/base" -name '*.partial' | wc -l)"
  json=no; [ -e "$tmpfs_dir/last-base.json" ] && json=yes
  say "case disk_full: exit=$rc finals=$finals partials=$leftovers last-base.json=$json"; sed 's/^/    /' "$log" | tail -n 3
  sudo -n umount "$tmpfs_dir"; tmpfs_dir=""
  [ "$rc" -ne 0 ] && [ "$finals" -eq 0 ] && [ "$leftovers" -eq 0 ] && [ "$json" = no ] && cause_in "$log" "${CAUSE[disk_full]}"
}

case_wal_recycled() {
  # wal_keep_size 0 + tiny max_wal_size + segment churn (pg_switch_wal + CHECKPOINT; data size stays flat)
  # while a throttled base runs: the WAL that -X fetch needs is removed, so the base must FAIL with that error
  # (no fallback to the gzip/GPG archive).
  psql_src "ALTER SYSTEM SET wal_keep_size = '0'" >/dev/null
  psql_src "ALTER SYSTEM SET max_wal_size = '32MB'" >/dev/null
  psql_src "ALTER SYSTEM SET min_wal_size = '32MB'" >/dev/null
  psql_src 'SELECT pg_reload_conf()' >/dev/null
  local rc pid churn log="$WORK/case-wal_recycled.log"
  snap_outputs
  run_base ENGRAM_PITR_LOG="$WORK/case-wal_recycled.base.log" ENGRAM_PITR_MAX_RATE=512k >"$log" 2>&1 &
  pid=$!
  (
    set +e
    while :; do
      docker exec -u postgres "$SRC" psql -X -q -U "$DB_USER" -d "$DB_NAME" \
        -c "INSERT INTO dr_churn(pad) VALUES (md5(random()::text))" \
        -c 'SELECT pg_switch_wal()' -c 'CHECKPOINT' >/dev/null 2>&1
      sleep 0.2
    done
  ) &
  churn=$!
  rc=0; wait "$pid" || rc=$?
  kill "$churn" 2>/dev/null || true; wait "$churn" 2>/dev/null || true
  psql_src 'TRUNCATE dr_churn' >/dev/null
  psql_src 'ALTER SYSTEM RESET wal_keep_size' >/dev/null
  psql_src 'ALTER SYSTEM RESET max_wal_size' >/dev/null
  psql_src 'ALTER SYSTEM RESET min_wal_size' >/dev/null
  psql_src 'SELECT pg_reload_conf()' >/dev/null
  say "case wal_recycled: exit=$rc"; sed 's/^/    /' "$log" | tail -n 3
  [ "$rc" -ne 0 ] && outputs_unchanged && cause_in "$log" "${CAUSE[wal_recycled]}"
}

case_after_publish() {
  # Failure AFTER the base and .sha256 were renamed into place (last-base.json cannot be replaced):
  # this run's final + .sha256 must be rolled back, the previous success marker kept.
  local rc log="$WORK/case-after_publish.log"
  snap_outputs
  mv "$PITR_DIR/last-base.json" "$WORK/last-base.json.keep"
  mkdir "$PITR_DIR/last-base.json"
  rc=0; run_base ENGRAM_PITR_LOG="$WORK/case-after_publish.base.log" >"$log" 2>&1 || rc=$?
  rmdir "$PITR_DIR/last-base.json"
  mv "$WORK/last-base.json.keep" "$PITR_DIR/last-base.json"
  say "case after_publish: exit=$rc"; sed 's/^/    /' "$log" | tail -n 3
  [ "$rc" -ne 0 ] && outputs_unchanged && cause_in "$log" "${CAUSE[after_publish]}" \
    && grep -q '^.*START engram-base-' "$WORK/case-after_publish.base.log"
}

case_concurrent() {
  # A second start while a base is streaming must exit 1 and leave the running producer's files alone;
  # the first run then publishes normally.
  local rc_a rc_b pid partial_seen before_n log_a="$WORK/case-concurrent-a.log" log="$WORK/case-concurrent.log"
  before_n="$(base_count)"
  run_base ENGRAM_PITR_MAX_RATE=8M >"$log_a" 2>&1 &
  pid=$!
  wait_proc_in "$SRC" pg_basebackup 50 || { wait "$pid" || true; return 1; }
  sleep 1
  partial_seen="$(partial_count)"
  rc_b=0; run_base >"$log" 2>&1 || rc_b=$?
  local partial_after; partial_after="$(partial_count)"
  rc_a=0; wait "$pid" || rc_a=$?
  say "case concurrent: second exit=$rc_b partials before/after=$partial_seen/$partial_after first exit=$rc_a"
  sed 's/^/    /' "$log" | tail -n 2
  [ "$rc_b" -ne 0 ] && cause_in "$log" "${CAUSE[concurrent]}" && [ "$partial_seen" -ge 1 ] && [ "$partial_after" -ge 1 ] \
    && [ "$rc_a" -eq 0 ] && [ "$(base_count)" -eq $((before_n + 1)) ] && grep -q '"ok":true' "$PITR_DIR/last-base.json"
}

case_bootstrap_missing_password() {
  # Fresh throwaway cluster without the secret mount: bootstrap must fail and set no password.
  docker run -d --name "$P-pwmiss" --network "$NET" -e POSTGRES_USER=engram -e POSTGRES_PASSWORD=engram \
    -e POSTGRES_DB=engram -v "$P-pwmissdata:/var/lib/postgresql/data" "$PITR_IMAGE" >/dev/null
  wait_init_done "$P-pwmiss" || return 1
  local rc role log="$WORK/case-bootstrap_pw.log"
  set +e
  docker exec -i "$P-pwmiss" psql -X -U engram -v ON_ERROR_STOP=1 <"$pitr_src/bootstrap-replication.sql" >"$log" 2>&1
  rc=$?
  set -e
  role="$(docker exec -u postgres "$P-pwmiss" psql -X -At -U engram -d engram \
    -c "SELECT count(*) FROM pg_authid WHERE rolname='engram_replication' AND rolpassword IS NOT NULL")"
  docker rm -f "$P-pwmiss" >/dev/null
  say "case bootstrap_missing_password_file: exit=$rc roles_with_password=$role"; sed 's/^/    /' "$log" | tail -n 2
  [ "$rc" -ne 0 ] && [ "$role" = 0 ] && cause_in "$log" "${CAUSE[bootstrap_pw]}"
}

# Each case log must match its own cause and none of the other specific causes (a different failure can't pass).
cause_matrix_discriminates() {
  local c o ok=0
  for c in wrong_pgpass missing_pgpass gpg_missing disk_full wal_recycled after_publish concurrent bootstrap_pw; do
    for o in wrong_pgpass missing_pgpass gpg_missing disk_full wal_recycled after_publish concurrent bootstrap_pw; do
      [ "$c" = "$o" ] && continue
      if cause_in "$WORK/case-$c.log" "${CAUSE[$o]}"; then say "cause matrix: case $c log also matches $o"; ok=1; fi
    done
  done
  return "$ok"
}

wal_archive_unit_checks() {
  # Runs the real archive_command script in the source container on a synthetic segment (no private key):
  # first archive, idempotent retry, corrupt ciphertext retry, different plaintext retry.
  docker exec -u postgres -e ENGRAM_WAL_ARCHIVE_DIR=/tmp/archtest "$SRC" bash -c '
    set -u
    a=/etc/postgresql/engram-wal-archive.sh; d=/tmp/archtest; w=0000000100000000000000FE
    rm -rf "$d" /tmp/seg && mkdir -p "$d" && head -c 1048576 /dev/urandom >/tmp/seg
    $a /tmp/seg $w || { echo "first archive failed"; exit 1; }
    $a /tmp/seg $w || { echo "idempotent retry failed"; exit 1; }
    [ "$(ls "$d" | grep -c "\.gz\.gpg$")" = 1 ] || { echo "retry created a second copy"; exit 1; }
    f="$(ls "$d"/*--$w.gz.gpg)"; cp "$f" /tmp/good
    truncate -s 64 "$f"
    if $a /tmp/seg $w 2>/tmp/err; then echo "corrupt ciphertext acknowledged"; exit 1; fi
    grep -q "encrypted digest mismatch" /tmp/err || { cat /tmp/err; exit 1; }
    cp /tmp/good "$f"
    head -c 1048576 /dev/urandom >/tmp/seg2
    if $a /tmp/seg2 $w 2>/tmp/err; then echo "different plaintext acknowledged"; exit 1; fi
    $a /tmp/seg $w || { echo "restored-ciphertext retry failed"; exit 1; }
    rm -rf "$d" /tmp/seg /tmp/seg2 /tmp/good /tmp/err
    echo "wal archive unit checks ok"'
}

# ---------- secrets (never in argv: written through stdin into a volume) ----------
write_secret() { # file-in-volume, host source file
  docker run --rm -i --user 0 -v "$VOL_SEC:/s" --entrypoint sh "$POSTGRES_IMAGE" \
    -c 'umask 077; cat >"/s/$1"; chown 999:999 "/s/$1"; chmod 0600 "/s/$1"' sh "$1" <"$2"
}

# ---------- restore ----------
to_compact() { date -u -d "$1" +%Y%m%dT%H%M%SZ; }

# Newest-first list of bases whose source timestamp (start of pg_basebackup) is strictly before the target.
bases_before() { # root target
  local t name
  t="$(to_compact "$2")" || return 1
  find "$1/base" -maxdepth 1 -name 'engram-base-*.tar.gz.gpg' -printf '%f\n' | sort -r | while read -r name; do
    local ts="${name#engram-base-}"; ts="${ts%.tar.gz.gpg}"
    if [[ "$ts" < "$t" ]]; then printf '%s\n' "$1/base/$name"; fi
  done
}

# Every restore attempt starts from scratch: previous restore/api containers and volumes must be GONE (verified),
# then a fresh restore-only keyring volume and HBA volume are created. Each mandatory step returns non-zero
# explicitly: these functions are called from `|| rc=$?` / `if` contexts where errexit does not apply.
prepare_restore_volumes() { # gnupghome
  docker rm -f "$API" "$DST" >/dev/null 2>&1 || true
  if docker inspect "$DST" >/dev/null 2>&1 || docker inspect "$API" >/dev/null 2>&1; then
    say "previous restore container still present"; return 1
  fi
  docker volume rm -f "$VOL_DST" "$VOL_RGPG" "$VOL_RHBA" "$VOL_RWAL" >/dev/null 2>&1 || true
  if docker volume inspect "$VOL_DST" >/dev/null 2>&1 || docker volume inspect "$VOL_RGPG" >/dev/null 2>&1 \
    || docker volume inspect "$VOL_RHBA" >/dev/null 2>&1 || docker volume inspect "$VOL_RWAL" >/dev/null 2>&1; then
    say "previous restore volume still present"; return 1
  fi
  GNUPGHOME="$1" gpg --batch --quiet --pinentry-mode loopback --passphrase '' --export-secret-keys \
    | docker run --rm -i --user 0 -v "$VOL_RGPG:/g" --entrypoint sh "$PITR_IMAGE" -c '
        set -e; chown postgres:postgres /g; chmod 0700 /g
        gosu postgres env GNUPGHOME=/g gpg --batch --quiet --import
        gosu postgres env GNUPGHOME=/g gpg --batch --list-secret-keys --with-colons | grep -q "^sec"' \
    || { say "restore key import failed"; return 1; }
  printf 'local all all trust\nhost all all samenet trust\n' \
    | docker run --rm -i --user 0 -v "$VOL_RHBA:/h" --entrypoint sh "$PITR_IMAGE" -c '
        set -e; cat >/h/pg_hba.conf; chown -R postgres:postgres /h; chmod 0700 /h; chmod 0600 /h/pg_hba.conf' \
    || { say "restore HBA volume failed"; return 1; }
}

restore_one() { # base gnupghome archive_root target -> 0 promoted, 2 base not consistent before target, 1 error
  local base="$1" gpgdir="$2" root="$3" target="$4" cid
  (cd "$(dirname "$base")" && sha256sum -c --quiet "$(basename "$base").sha256") || { say "checksum mismatch $base"; return 1; }
  prepare_restore_volumes "$gpgdir" || return 1
  GNUPGHOME="$gpgdir" gpg --batch --quiet --decrypt "$base" \
    | docker run --rm -i --user 0 -v "$VOL_DST:/var/lib/postgresql/data" --entrypoint sh "$PITR_IMAGE" -c '
        set -e
        tar -xzf - -C /var/lib/postgresql/data
        test -f /var/lib/postgresql/data/PG_VERSION
        touch /var/lib/postgresql/data/recovery.signal
        chown -R postgres:postgres /var/lib/postgresql/data
        chmod 0700 /var/lib/postgresql/data' \
    || { say "base decrypt/extract failed for $(basename "$base")"; return 1; }
  # Copy the archive's WAL (whoever owns it on the host: owner PC user, runner user, uid 999) into a
  # postgres-owned restore volume; the source directory is mounted read-only and never modified.
  docker run --rm --user 0 -v "$root/wal:/src:ro" -v "$VOL_RWAL:/w" --entrypoint sh "$PITR_IMAGE" -c '
      set -e
      find /src -maxdepth 1 -type f \( -name "*--*.gz.gpg" -o -name "*--*.gz.gpg.sha256" \) -exec cp -t /w {} +
      chown -R postgres:postgres /w; chmod 0700 /w; find /w -type f -exec chmod 0600 {} +
      test -n "$(find /w -maxdepth 1 -name "*--*.gz.gpg" -print -quit)"' \
    || { say "copying WAL into the restore volume failed"; return 1; }
  cid="$(docker run -d --name "$DST" --network "$NET" \
    -v "$VOL_DST:/var/lib/postgresql/data" -v "$VOL_RWAL:$ARCH_IN_CT:ro" \
    -v "$VOL_RGPG:/var/lib/postgresql/restore-gnupg" -v "$VOL_RHBA:/var/lib/postgresql/restore-hba:ro" \
    -e ENGRAM_RESTORE_GNUPGHOME=/var/lib/postgresql/restore-gnupg \
    "$PITR_IMAGE" postgres -c config_file=/etc/postgresql/postgresql-pitr.conf -c archive_mode=off \
    -c hba_file=/var/lib/postgresql/restore-hba/pg_hba.conf -c 'listen_addresses=*' \
    -c "restore_command=/etc/postgresql/engram-wal-restore.sh %f %p" \
    -c "recovery_target_time=$target" -c recovery_target_action=promote)" || { say "restore container did not start"; return 1; }
  [ -n "$cid" ] || return 1
  # Poll THIS attempt's container id, never the name (a stale container can't satisfy the check).
  for _ in $(seq 1 7200); do
    if docker exec -u postgres "$cid" psql -X -At -U "$DB_USER" -d "$DB_NAME" -c 'SELECT pg_is_in_recovery()' 2>/dev/null | grep -qx f; then
      return 0
    fi
    if ! docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null | grep -qx true; then
      if docker logs "$cid" 2>&1 | grep -q 'before consistent recovery point'; then return 2; fi
      docker logs --tail 20 "$cid" 2>&1 | sed 's/^/    restore: /'
      return 1
    fi
    sleep 1
  done
  return 1
}

restore_from() { # archive_root gnupghome target  -> sets BASE_SELECTED
  local root="$1" gpgdir="$2" target="$3" base rc list
  list="$(bases_before "$root" "$target")" || die "cannot parse target time '$target'"
  [ -n "$list" ] || { say "no base backup older than target $target"; return 3; }
  while read -r base; do
    say "restore base $(basename "$base") -> target $target"
    rc=0; restore_one "$base" "$gpgdir" "$root" "$target" </dev/null || rc=$?
    if [ "$rc" -eq 0 ]; then BASE_SELECTED="$(basename "$base")"; return 0; fi
    [ "$rc" -eq 2 ] || return 1
    say "base $(basename "$base") is not consistent before the target; trying the next older base"
  done <<<"$list"
  say "no base is consistent before target $target"
  return 3
}

post_restore_open() { # mandatory pre-open steps + assertions (both modes)
  psql_dst 'UPDATE session SET revoked_at = now() WHERE revoked_at IS NULL' >/dev/null
  psql_dst 'DELETE FROM oauth_reauth_receipt' >/dev/null
  ev SESSIONS_ACTIVE_AFTER_REVOKE "$(psql_dst 'SELECT count(*) FROM session WHERE revoked_at IS NULL')"
  check SESSIONS_REVOKED test "$(psql_dst 'SELECT count(*) FROM session WHERE revoked_at IS NULL')" = 0
  local mrc=0
  migrate_up "$DST" >"$WORK/migrate.log" 2>&1 || mrc=$?
  [ "$mrc" -eq 0 ] || sed 's/^/    migrate: /' "$WORK/migrate.log" | tail -n 5
  # *_RC, not *_EXIT: the cloud runner treats any *_EXIT=<n> > 0 line as a failed step, and the
  # negative control below legitimately records a non-zero migrate rc.
  ev MIGRATE_UP_RC "$mrc"
  check MIGRATE_UP test "$mrc" -eq 0
  docker rm -f "$API" >/dev/null 2>&1 || true
  docker run -d --name "$API" --network "$NET" -p 127.0.0.1::8080 \
    -e DATABASE_URL="$(db_url "$DST")" -e HTTP_ADDR=0.0.0.0:8080 \
    -e APP_ENV=development -e APP_ORIGIN=http://127.0.0.1:3000 -e EMBEDDING_PROVIDER=noop \
    -e AUTH_FAKE_OAUTH=true -e AUTH_MAIL_SINK_DIR=/tmp "$APP_IMAGE" /app/api >/dev/null
  local port code=000
  port="$(docker port "$API" 8080/tcp | head -n 1 | sed 's/.*://')"
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/v1/readyz" || true)"
    [ "$code" = 200 ] && break
    sleep 1
  done
  [ "$code" = 200 ] || docker logs --tail 30 "$API"
  ev READYZ "$code"
  check READYZ_200 test "$code" = 200
}

finish() {
  if [ "$failures" -eq 0 ]; then ev PITR_REHEARSAL PASS; exit 0; fi
  say "$failures check(s) failed"
  ev PITR_REHEARSAL FAIL
  exit 1
}

# Strict UTC parse; prints epoch or fails (never lets an empty value become 0 in arithmetic).
to_epoch() { local e; e="$(date -u -d "$1" +%s 2>/dev/null)" || return 1; [[ "$e" =~ ^[0-9]+$ ]] || return 1; printf '%s\n' "$e"; }
compact_to_epoch() { # YYYYmmddTHHMMSSZ
  local t="$1"
  [[ "$t" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  to_epoch "${t:0:4}-${t:4:2}-${t:6:2} ${t:9:2}:${t:11:2}:${t:13:2}Z"
}

# Owner-mode archive telemetry (advisor-dec-P06-029). ARCHIVE_FRESHNESS_SECONDS = capture time - archive_command
# time of the newest WAL file. That clock is when the segment was SHIPPED (>= its last write), so it is not a
# recovered-commit bound and never yields RPO acceptance: RPO_ACCEPTANCE=UNMEASURED_OWNER always. Production RPO is
# measured in Task 21c against a source commit/LSN boundary. Fails closed (return 1) on any unparsable timestamp,
# on capture before the newest archived WAL, or on capture before the target.
archive_freshness() { # archive_root capture target
  local newest new_e cap_e tgt_e
  ev RPO_ACCEPTANCE UNMEASURED_OWNER
  newest="$(find "$1/wal" -maxdepth 1 -name '*--*.gz.gpg' -printf '%f\n' | sort | tail -n 1)" || return 1
  newest="${newest%%--*}"
  ev ARCHIVE_NEWEST_WAL_TS "${newest:-none}"
  [ -n "$newest" ] || { ev ARCHIVE_FRESHNESS INVALID_NO_WAL; return 1; }
  new_e="$(compact_to_epoch "$newest")" || { ev ARCHIVE_FRESHNESS INVALID_WAL_NAME; return 1; }
  if [ -z "$2" ]; then ev ARCHIVE_FRESHNESS UNMEASURED_NO_CAPTURE_TIME; return 0; fi
  cap_e="$(to_epoch "$2")" || { ev ARCHIVE_FRESHNESS INVALID_CAPTURE_TIME; return 1; }
  tgt_e="$(to_epoch "$3")" || { ev ARCHIVE_FRESHNESS INVALID_TARGET_TIME; return 1; }
  [ "$cap_e" -ge "$new_e" ] || { ev ARCHIVE_FRESHNESS INVALID_CAPTURE_BEFORE_ARCHIVE; return 1; }
  [ "$cap_e" -ge "$tgt_e" ] || { ev ARCHIVE_FRESHNESS INVALID_CAPTURE_BEFORE_TARGET; return 1; }
  ev ARCHIVE_FRESHNESS_SECONDS "$((cap_e - new_e))"
  ev ROLLBACK_SECONDS "$((cap_e - tgt_e))"
  ev ARCHIVE_FRESHNESS MEASURED_TELEMETRY_ONLY
}

owner_flow() { # archive_root gnupghome target capture
  local t_start rc rto
  ev TARGET_TIME "$3"
  t_start="$(epoch)"
  rc=0; restore_from "$1" "$2" "$3" || rc=$?
  if [ "$rc" -ne 0 ]; then ev RESTORE_RC "$rc"; check RESTORED false; return 0; fi
  check RESTORED true
  ev BASE_SELECTED "$BASE_SELECTED"
  ev RESTORED_TABLES "$(psql_dst "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
  ev RESTORED_USERS "$(psql_dst 'SELECT count(*) FROM app_user')"
  ev RECOVERED_LAST_REPLAYED_COMMIT "$(psql_dst "SELECT coalesce(to_char(pg_last_xact_replay_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || '+00', 'none')")"
  post_restore_open
  rto=$(( $(epoch) - t_start ))
  ev RTO_SECONDS "$rto"
  check RTO_LE_2H test "$rto" -le 7200
  check ARCHIVE_TIMESTAMPS_VALID archive_freshness "$1" "$4" "$3"
}

# =====================================================================================
if [ "$mode" = decrypted ]; then
  if [ ! -d "$archive_in/base" ] || [ ! -d "$archive_in/wal" ] || [ ! -d "$gnupg_in" ] || [ -z "$target_in" ]; then
    echo "--from-decrypted-stream needs --archive-dir (base/, wal/), --gnupghome, --target-time [--capture-time]" >&2
    exit 2
  fi
  docker network create "$NET" >/dev/null
  build_images
  to_epoch "$target_in" >/dev/null || { echo "--target-time is not a valid time: $target_in" >&2; exit 2; }
  if [ -n "$capture_in" ]; then to_epoch "$capture_in" >/dev/null || { echo "--capture-time is not a valid time: $capture_in" >&2; exit 2; }; fi
  owner_flow "$archive_in" "$gnupg_in" "$target_in" "$capture_in"
  finish
fi

# ------------------------------- scratch -------------------------------
say "scratch rehearsal $P, evidence $EVID"
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
docker run --rm --network "$NET" -e DATABASE_URL="postgres://engram:engram@$SRC:5432/engram?sslmode=disable" \
  "$APP_IMAGE" /app/migrate up >"$WORK/migrate-baseline.log" 2>&1 || { cat "$WORK/migrate-baseline.log"; die "baseline migrate"; }
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
# Production roles never have the fixture password: give engram a random one (via stdin, never argv) so the
# restore path is proved not to depend on knowing it.
printf "ALTER ROLE engram PASSWORD '%s';\n" "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" >"$WORK/rolepw.sql"
docker exec -i -u postgres "$SRC" psql -X -q -U engram -d engram -v ON_ERROR_STOP=1 <"$WORK/rolepw.sql" >/dev/null
rm -f "$WORK/rolepw.sql"
ev SEED_USERS "$(psql_src 'SELECT count(*) FROM app_user')"
ev REPL_ROLE_BEFORE "$(psql_src "SELECT count(*) FROM pg_roles WHERE rolname='engram_replication'")"

# (b) switch the SAME data volume to engram-db-pitr + PROD-STEP-4 procedure
say "(b) switch to $PITR_IMAGE (archive_mode=on) + bootstrap-replication.sql + HBA + .pgpass"
CANARY="CANARY_REPL_PW_$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
printf '%s\n' "$CANARY" >"$WORK/canary.pattern"
printf '%s' "$CANARY" >"$WORK/pw"
printf '*:*:replication:engram_replication:%s\n' "$CANARY" >"$WORK/pgpass"
printf '*:*:replication:engram_replication:%s\n' "wrong-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')" >"$WORK/pgpass-wrong"
unset CANARY
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
# The bootstrap psql lives for well under a second: repeat the idempotent bootstrap until the argv sampler has
# recorded its command line at least once, so the canary scan provably covers it.
for _ in $(seq 1 40); do
  # bracket pattern: this grep's own argv (also sampled) must not match itself
  grep -qE 'psql -X -U engra[m] -v ON_ERROR_STOP=1' "$ARGV_LOG" && break
  docker exec -i "$SRC" psql -X -U engram -v ON_ERROR_STOP=1 <"$pitr_src/bootstrap-replication.sql" >>"$WORK/bootstrap.log" 2>&1 \
    || die "bootstrap-replication.sql rerun failed"
  sleep 0.3
done
# HBA precondition as on a hand-edited cluster: a generic trust rule on line 1 and the owned rule at the end.
docker exec -u postgres "$SRC" sh -ec 'f=/var/lib/postgresql/data/pg_hba.conf
  { echo "local replication all trust"; cat "$f"; echo "local replication engram_replication scram-sha-256"; } >"$f.new"
  cat "$f.new" >"$f"; rm -f "$f.new"'
psql_src 'SELECT pg_reload_conf()' >/dev/null
check HBA_APPLY_PRECEDENCE env ENGRAM_DB_CONTAINER="$SRC" bash "$pitr_src/engram-pitr-hba.sh" apply
check HBA_APPLY_IDEMPOTENT env ENGRAM_DB_CONTAINER="$SRC" bash "$pitr_src/engram-pitr-hba.sh" apply
# Failure before publication (stale temporary in place): apply must fail and leave the live file byte-identical.
hba_failure_keeps_live_file() {
  local f=/var/lib/postgresql/data/pg_hba.conf before after
  before="$(docker exec -u postgres "$SRC" sha256sum "$f")"
  docker exec -u postgres "$SRC" mkdir "$f.engram-new"
  if ENGRAM_DB_CONTAINER="$SRC" bash "$pitr_src/engram-pitr-hba.sh" apply >"$WORK/hba-fail.log" 2>&1; then
    docker exec -u postgres "$SRC" rmdir "$f.engram-new"; return 1
  fi
  after="$(docker exec -u postgres "$SRC" sha256sum "$f")"
  docker exec -u postgres "$SRC" rmdir "$f.engram-new"
  sed 's/^/    /' "$WORK/hba-fail.log"
  [ "$before" = "$after" ] && grep -q 'live file untouched' "$WORK/hba-fail.log"
}
check HBA_FAILURE_KEEPS_LIVE_FILE hba_failure_keeps_live_file
check HBA_APPLY_AFTER_FAILED_ATTEMPT env ENGRAM_DB_CONTAINER="$SRC" bash "$pitr_src/engram-pitr-hba.sh" apply
ev HBA_RULE_LINES "$(docker exec -u postgres "$SRC" grep -cxF 'local replication engram_replication scram-sha-256' /var/lib/postgresql/data/pg_hba.conf)"
ev HBA_LINE1 "$(docker exec -u postgres "$SRC" head -n 1 /var/lib/postgresql/data/pg_hba.conf)"
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
check WAL_ARCHIVE_IDEMPOTENT_AND_CORRUPT_REJECTED wal_archive_unit_checks
# restore_command: strips the <ts>-- prefix, verifies both digests; a corrupt copy aborts recovery (exit 126).
GNUPGHOME="$TESTGPG" gpg --batch --quiet --pinentry-mode loopback --passphrase '' --export-secret-keys \
  | docker exec -i -u postgres "$SRC" sh -c 'umask 077; mkdir -p /tmp/rg && GNUPGHOME=/tmp/rg gpg --batch --quiet --import'
check RESTORE_COMMAND_ROUNDTRIP docker exec -u postgres -e ENGRAM_RESTORE_GNUPGHOME=/tmp/rg "$SRC" sh -c \
  "/etc/postgresql/engram-wal-restore.sh $lastwal /tmp/rt.wal && test \"\$(sha256sum </tmp/rt.wal | cut -d' ' -f1)\" = \"\$(head -n1 $ARCH_IN_CT/*--$lastwal.gz.gpg.sha256 | cut -d' ' -f1)\" && ! /etc/postgresql/engram-wal-restore.sh FFFFFFFFFFFFFFFFFFFFFFFF /tmp/none.wal"
check RESTORE_COMMAND_CORRUPT_ABORTS docker exec -u postgres -e ENGRAM_RESTORE_GNUPGHOME=/tmp/rg -e W="$lastwal" "$SRC" bash -c '
  set -u; d=/tmp/rcorrupt; rm -rf $d; mkdir -p $d
  cp '"$ARCH_IN_CT"'/*--$W.gz.gpg '"$ARCH_IN_CT"'/*--$W.gz.gpg.sha256 $d/
  f=$(ls $d/*--$W.gz.gpg); truncate -s 64 "$f"
  ENGRAM_WAL_ARCHIVE_DIR=$d /etc/postgresql/engram-wal-restore.sh $W /tmp/rc.wal; rc=$?
  rm -rf $d /tmp/rc.wal; [ "$rc" -eq 126 ]'
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

# WAL rate (for wal_keep_size sizing)
lsn0="$(psql_src 'SELECT pg_current_wal_lsn()')"
start_load; sleep 20; stop_load
lsn1="$(psql_src 'SELECT pg_current_wal_lsn()')"
ev WAL_RATE_BYTES_PER_SEC_UNDER_LOAD "$(psql_src "SELECT (pg_wal_lsn_diff('$lsn1','$lsn0') / 20)::bigint")"

# failure cases: exit != 0, the case-specific cause in that invocation's own log, and nothing published
say "failure cases"
check CASE_WRONG_PGPASS expect_base_fails wrong_pgpass ENGRAM_REPL_PGPASSFILE=/run/secrets/wrong.pgpass
check CASE_MISSING_PGPASS expect_base_fails missing_pgpass ENGRAM_REPL_PGPASSFILE=/run/secrets/absent.pgpass
check CASE_GPG_MISSING expect_base_fails gpg_missing ENGRAM_GPG=/nonexistent/gpg
check CASE_PG_BASEBACKUP_KILLED case_killed
check CASE_DISK_FULL case_disk_full
check CASE_WAL_RECYCLED_NO_ARCHIVE_FALLBACK case_wal_recycled
check CASE_FAIL_AFTER_PUBLISH_ROLLS_BACK case_after_publish
check CASE_CONCURRENT_START_LEAVES_RUNNING_BASE case_concurrent
check CASE_BOOTSTRAP_MISSING_PASSWORD_FILE case_bootstrap_missing_password
check CASE_CAUSES_DISCRIMINATE cause_matrix_discriminates
stop_sampler

# canary: one argv log for the whole run (bootstrap, every base incl. the successful ones), container log,
# run log, every case/base/bootstrap/migrate log. Sampler must have seen pg_basebackup's command line.
docker logs "$SRC" >"$WORK/src-container.log" 2>&1
scan_files=("$ARGV_LOG" "$WORK/src-container.log" "$RUNLOG" "$WORK/bootstrap.log" "$WORK/base-ok.log" "$WORK/migrate-baseline.log")
for f in "$WORK"/case-*.log "$PITR_DIR/base.log"; do [ -f "$f" ] && scan_files+=("$f"); done
canary_hits() { local n=0 f c; for f in "$@"; do c="$(grep -cFf "$WORK/canary.pattern" "$f" || true)"; n=$((n + c)); done; echo "$n"; }
# Scanner self-test: a decoy copy holding the canary in an early argv-style line must be detected.
{ echo "early sample"; echo "psql -X -U engram $(cat "$WORK/canary.pattern")"; } >"$WORK/decoy.log"
check CANARY_SCANNER_SELFTEST test "$(canary_hits "$WORK/decoy.log")" -ge 1
rm -f "$WORK/decoy.log"
argv_samples="$(wc -l <"$ARGV_LOG")"
ev CANARY_ARGV_SAMPLES "$argv_samples"
ev CANARY_ARGV_SAW_BASEBACKUP "$(grep -c 'pg_basebackup -h /var/run/postgresql -U engram_replication' "$ARGV_LOG" || true)"
ev CANARY_ARGV_SAW_BOOTSTRAP "$(grep -cF 'psql -X -U engram -v ON_ERROR_STOP=1' "$ARGV_LOG" || true)"
check CANARY_SAMPLER_COVERED_BASE grep -q 'pg_basebackup -h /var/run/postgresql -U engram_replication' "$ARGV_LOG"
check CANARY_SAMPLER_COVERED_BOOTSTRAP grep -qF 'psql -X -U engram -v ON_ERROR_STOP=1' "$ARGV_LOG"
hits="$(canary_hits "${scan_files[@]}")"
ev CANARY_FILES_SCANNED "${#scan_files[@]}"
ev CANARY_HITS "$hits"
check CANARY_ABSENT test "$hits" -eq 0

# T2 (+ consume one RK, as POST /vault/recover/complete does) -> T_target -> T3
say "T2 -> T_target -> T3"
rk_consumed="$(psql_src "DELETE FROM vault_recovery_key WHERE id = (SELECT id FROM vault_recovery_key ORDER BY id LIMIT 1) RETURNING id")"
psql_src "INSERT INTO dr_marker (phase, n) SELECT 'T2', g FROM generate_series(1, 500) g" >/dev/null
t2_commit="$(psql_src "SELECT max(at) FROM dr_marker WHERE phase = 'T2'")"
switch_and_wait || die "T2 WAL not archived"
sleep 2
T_TARGET="$(utc_now_sql)"
sleep 2
psql_src "INSERT INTO dr_marker (phase, n) SELECT 'T3', g FROM generate_series(1, 300) g" >/dev/null
psql_src "INSERT INTO session (user_id, refresh_token_hash, expires_at) SELECT id, gen_random_bytes(32), now() + interval '1 day' FROM app_user LIMIT 5" >/dev/null
t3_commit_epoch="$(psql_src "SELECT extract(epoch FROM max(at))::bigint FROM dr_marker WHERE phase = 'T3'")"
t3_seg="$(psql_src 'SELECT pg_walfile_name(pg_current_wal_insert_lsn())')"
ev T_TARGET "$T_TARGET"
ev RK_CONSUMED_AT_T2 "$rk_consumed"

# RPO: no manual switch; archive_timeout alone must ship the T3 segment.
say "waiting for archive_timeout to ship the T3 segment (<= 300s)"
wait_wal_archived "$t3_seg" 900 || die "T3 segment not archived within 15 min"
t3_archived_epoch="$(psql_src 'SELECT extract(epoch FROM last_archived_time)::bigint FROM pg_stat_archiver')"
rpo=$((t3_archived_epoch - t3_commit_epoch))
ev RPO_SECONDS "$rpo"

# A later base (after T_target) + T4: the archive now holds bases on both sides of T_target.
sleep 1
run_base >"$WORK/base-late.log" 2>&1 || { cat "$WORK/base-late.log"; die "late base failed"; }
late_base="$(sed -n 's/.*"file":"\([^"]*\)".*/\1/p' "$PITR_DIR/last-base.json")"
ev LATE_BASE "$late_base"
psql_src "INSERT INTO dr_marker (phase, n) SELECT 'T4', g FROM generate_series(1, 200) g" >/dev/null
switch_and_wait || die "T4 WAL not archived"
sleep 1
T_NEAR="$(utc_now_sql)"
ev T_NEAR "$T_NEAR"
# Recovery to a time target needs a later commit in the archive (else "recovery ended before configured
# recovery target was reached"): T5 is committed after T_near, archived, and must be absent.
sleep 1
psql_src "INSERT INTO dr_marker (phase, n) SELECT 'T5', g FROM generate_series(1, 100) g" >/dev/null
switch_and_wait || die "T5 WAL not archived"
ev BASES_IN_ARCHIVE "$(base_count)"
c2="$(archived_count)"
ev ARCHIVED_COUNT_AFTER "$c2"
ev ARCHIVER_FAILED_COUNT_AFTER "$(psql_src 'SELECT failed_count FROM pg_stat_archiver')"
expect_t1="$(psql_src "SELECT count(*) FROM dr_marker WHERE phase = 'T1'")"
expect_users="$(psql_src 'SELECT count(*) FROM app_user')"
expect_base_target="$(basename "$(bases_before "$PITR_DIR" "$T_TARGET" | head -n 1)")"

# disaster: source gone. RTO clock starts (warm: images built, archive local).
say "disaster: removing source cluster"
t_disaster="$(epoch)"
stop_sampler
docker rm -f "$SRC" >/dev/null
docker volume rm -f "$VOL_SRC" >/dev/null

rc=0; restore_from "$PITR_DIR" "$TESTGPG" "$T_TARGET" || rc=$?
[ "$rc" -eq 0 ] || die "restore to T_target failed (rc=$rc)"
ev BASE_SELECTED_FOR_T_TARGET "$BASE_SELECTED"
check BASE_SELECTED_BEFORE_TARGET test "$BASE_SELECTED" = "$expect_base_target" -a "$BASE_SELECTED" != "$late_base"
# Restore DB reachable only on the dedicated network: a peer on the default bridge must not reach it.
dst_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$DST")"
ev RESTORE_DB_IP_ON_PRIVATE_NET "$dst_ip"
check RESTORE_DB_UNREACHABLE_FROM_DEFAULT_BRIDGE bash -c '! docker run --rm --entrypoint pg_isready "$1" -h "$2" -p 5432 -t 3' _ "$POSTGRES_IMAGE" "$dst_ip"
check RESTORE_DB_REACHABLE_ON_PRIVATE_NET docker run --rm --network "$NET" --entrypoint pg_isready "$POSTGRES_IMAGE" -h "$DST" -p 5432 -t 10

t1_got="$(psql_dst "SELECT count(*) FROM dr_marker WHERE phase = 'T1'")"
t2_got="$(psql_dst "SELECT count(*) FROM dr_marker WHERE phase = 'T2'")"
t3_got="$(psql_dst "SELECT count(*) FROM dr_marker WHERE phase = 'T3'")"
rk_back="$(psql_dst "SELECT count(*) FROM vault_recovery_key WHERE id = '$rk_consumed'")"
ev T1_PRESENT "$t1_got/$expect_t1"
ev T2_PRESENT "$t2_got/500"
ev T3_PRESENT "$t3_got"
ev USERS_PRESENT "$(psql_dst 'SELECT count(*) FROM app_user')/$expect_users"
ev T2_LAST_COMMIT "$t2_commit"
check T1_COMPLETE test "$t1_got" = "$expect_t1"
check T2_COMPLETE test "$t2_got" = 500
check T3_ABSENT test "$t3_got" = 0
check RK_STAYS_CONSUMED test "$rk_back" = 0

post_restore_open
rto=$(( $(epoch) - t_disaster ))
ev RTO_SECONDS "$rto"
check RPO_LE_15M test "$rpo" -le 900
check RTO_LE_2H test "$rto" -le 7200
check ARCHIVED_COUNT_INCREASED test "$c2" -gt "$c0"

# Target older than every base: rejected, nothing restored.
rc_old=0; out_old="$(bases_before "$PITR_DIR" '2000-01-01 00:00:00+00')" || rc_old=$?
check REJECT_TARGET_BEFORE_ALL_BASES test "$rc_old" -eq 0 -a -z "$out_old"
rc_old=0; restore_from "$PITR_DIR" "$TESTGPG" '2000-01-01 00:00:00+00' >/dev/null || rc_old=$?
check RESTORE_REFUSES_TARGET_BEFORE_ALL_BASES test "$rc_old" -eq 3

# Same directory, near-now target: the later base is selected and T3 + T4 are present.
say "second restore from the same archive to T_near"
rc=0; restore_from "$PITR_DIR" "$TESTGPG" "$T_NEAR" || rc=$?
[ "$rc" -eq 0 ] || die "restore to T_near failed (rc=$rc)"
ev BASE_SELECTED_FOR_T_NEAR "$BASE_SELECTED"
check BASE_SELECTED_LATE_FOR_T_NEAR test "$BASE_SELECTED" = "$late_base"
ev T_NEAR_T3_PRESENT "$(psql_dst "SELECT count(*) FROM dr_marker WHERE phase = 'T3'")"
ev T_NEAR_T4_PRESENT "$(psql_dst "SELECT count(*) FROM dr_marker WHERE phase = 'T4'")"
check T_NEAR_T3_T4_PRESENT test "$(psql_dst "SELECT count(*) FROM dr_marker WHERE phase IN ('T3','T4')")" = 500
check T_NEAR_T5_ABSENT test "$(psql_dst "SELECT count(*) FROM dr_marker WHERE phase = 'T5'")" = 0
post_restore_open

# Negative control: a restored DB that still answers ping but whose migration fails must fail the verdict
# through the same shared post-restore assertions (prefixed NEGCTL_ so they are not mistaken for the real run).
psql_dst 'UPDATE schema_migrations SET dirty = true' >/dev/null
saved_failures="$failures"
ev_prefix="NEGCTL_"
post_restore_open
ev_prefix=""
neg_failures=$((failures - saved_failures))
failures="$saved_failures"
psql_dst 'UPDATE schema_migrations SET dirty = false' >/dev/null
if [ "$neg_failures" -ge 1 ] && grep -qx 'NEGCTL_MIGRATE_UP=FAIL' "$EVID"; then
  ev NEGCTL_MIGRATE_UP_FAILED_AS_EXPECTED yes
else
  ev NEGCTL_MIGRATE_UP_FAILED_AS_EXPECTED no
fi
# An unexpected migrate success makes this check (and the run) FAIL.
check NEGATIVE_CONTROL_MIGRATE_FAILURE_FAILS_VERDICT grep -qx 'NEGCTL_MIGRATE_UP_FAILED_AS_EXPECTED=yes' "$EVID"

# Restore negative controls (a promoted restore from the step above is still running when the first starts):
# each must return non-zero and leave no promoted restore container behind.
no_promoted_dst() {
  ! docker exec -u postgres "$DST" psql -X -At -U "$DB_USER" -d "$DB_NAME" -c 'SELECT pg_is_in_recovery()' 2>/dev/null | grep -qx f
}
restore_must_fail() { # base gnupghome target
  local rc=0
  restore_one "$1" "$2" "$PITR_DIR" "$3" </dev/null >"$WORK/negrestore.log" 2>&1 || rc=$?
  sed 's/^/    /' "$WORK/negrestore.log" | tail -n 2
  [ "$rc" -ne 0 ] && no_promoted_dst
}
mkdir -p "$WORK/emptygpg" "$WORK/fake/base"; chmod 700 "$WORK/emptygpg"
fake="$WORK/fake/base/engram-base-20000101T000000Z.tar.gz.gpg"
head -c 65536 /dev/urandom | GNUPGHOME="$TESTGPG" gpg --batch --quiet --trust-model always --encrypt --recipient "$TEST_FPR" --output "$fake"
(cd "$WORK/fake/base" && sha256sum "$(basename "$fake")" >"$(basename "$fake").sha256")
check NEG_RESTORE_KEY_IMPORT_FAILS restore_must_fail "$PITR_DIR/base/$late_base" "$WORK/emptygpg" "$T_NEAR"
check NEG_RESTORE_EXTRACT_FAILS restore_must_fail "$fake" "$TESTGPG" "$T_NEAR"
check NEG_RESTORE_START_FAILS restore_must_fail "$PITR_DIR/base/$late_base" "$TESTGPG" "not-a-time"

# Owner procedure simulation (R1-11, R2-03, R3-01): the scratch archive (key A) is "pulled" to a copy owned by
# the invoking non-root user (as on the owner PC), converted to key B with convert-archive-to-test-key.sh run
# directly as that user, then restored through the real owner flow with ONLY key B and no permission fix-ups.
say "owner simulation: pull copy -> convert key A -> key B as uid $(id -u) -> owner flow with key B only"
ev OWNERSIM_UID "$(id -u)"
check OWNERSIM_UID_NOT_POSTGRES test "$(id -u)" != 999 -a "$(id -u)" != 0
TESTGPG_B="$WORK/gnupg-b"
FPR_B="$(make_key "$TESTGPG_B" keyb)"
ev OWNERSIM_KEY_B_FPR "$FPR_B"
mkdir -p "$WORK/pull" "$WORK/conv"
docker run --rm --user 0 -v "$PITR_DIR:/src:ro" -v "$WORK/pull:/pull" --entrypoint sh "$PITR_IMAGE" -c \
  "cp -r /src/base /src/wal /pull/ && rm -f /pull/base/*.partial && chown -R $(id -u):$(id -g) /pull && chmod -R go-rwx /pull" \
  || die "pull copy failed"
SRC_GNUPGHOME="$TESTGPG" DST_GNUPGHOME="$TESTGPG_B" bash "$here/convert-archive-to-test-key.sh" "$WORK/pull" "$WORK/conv" "$FPR_B" \
  >"$WORK/convert.log" 2>&1 || { cat "$WORK/convert.log"; die "archive conversion failed"; }
sed 's/^/    /' "$WORK/convert.log" | tail -n 1
ev OWNERSIM_CONV_WAL_MODE "$(stat -c '%u-%a' "$WORK/conv/wal" | tr -d '\n')"
check OWNERSIM_CONVERTED_ARCHIVE_ONLY_KEY_B bash -c '! GNUPGHOME="$1" gpg --batch --list-secret-keys "$2" >/dev/null 2>&1' _ "$TESTGPG_B" "$TEST_FPR"
newest_wal="$(find "$WORK/conv/wal" -maxdepth 1 -name '*--*.gz.gpg' -printf '%f\n' | sort | tail -n 1)"
[ -n "$newest_wal" ] || die "converted archive has no WAL"
newest_e="$(compact_to_epoch "${newest_wal%%--*}")" || die "bad WAL name $newest_wal"
fmt() { date -u -d "@$1" '+%Y-%m-%d %H:%M:%S+00'; }
saved_failures="$failures"
ev_prefix="OWNERSIM_"
owner_flow "$WORK/conv" "$TESTGPG_B" "$T_NEAR" "$(fmt $((newest_e + 60)))"
ev T3_T4_PRESENT "$(psql_dst "SELECT count(*) FROM dr_marker WHERE phase IN ('T3','T4')")"
ev_prefix=""
ownersim_failures=$((failures - saved_failures))
failures="$saved_failures"
check OWNERSIM_FLOW_PASS test "$ownersim_failures" -eq 0
check OWNERSIM_T3_T4_PRESENT grep -qx 'OWNERSIM_T3_T4_PRESENT=500' "$EVID"
check OWNERSIM_RPO_NOT_ACCEPTED grep -qx 'OWNERSIM_RPO_ACCEPTANCE=UNMEASURED_OWNER' "$EVID"
check OWNERSIM_FRESHNESS_TELEMETRY grep -qx 'OWNERSIM_ARCHIVE_FRESHNESS_SECONDS=60' "$EVID"

# Owner timestamp validation (no restore): every invalid input fails closed, none claims RPO.
fresh_case() { # prefix capture target -> rc
  local rc=0
  ev_prefix="$1"; archive_freshness "$WORK/conv" "$2" "$3" || rc=$?; ev_prefix=""
  return "$rc"
}
fresh_must_fail() { ! fresh_case "$@"; }
check FRESHNESS_MISSING_CAPTURE_UNMEASURED fresh_case FRESH_MISSING_ "" "$T_NEAR"
check FRESHNESS_MISSING_CAPTURE_STATE grep -qx 'FRESH_MISSING_ARCHIVE_FRESHNESS=UNMEASURED_NO_CAPTURE_TIME' "$EVID"
check FRESHNESS_REJECTS_NOT_A_TIME fresh_must_fail FRESH_BADTIME_ "not-a-time" "$T_NEAR"
check FRESHNESS_REJECTS_CAPTURE_BEFORE_ARCHIVE fresh_must_fail FRESH_BACKWARDS_ "$(fmt $((newest_e - 3600)))" "$T_NEAR"
check FRESHNESS_REJECTS_BAD_TARGET fresh_must_fail FRESH_BADTARGET_ "$(fmt $((newest_e + 60)))" "2026-13-45 99:99:99+00"
check FRESHNESS_VALID_IS_TELEMETRY_ONLY fresh_case FRESH_VALID_ "$(fmt $((newest_e + 120)))" "$T_NEAR"
check FRESHNESS_VALID_SECONDS grep -qx 'FRESH_VALID_ARCHIVE_FRESHNESS_SECONDS=120' "$EVID"
check FRESHNESS_NEVER_ACCEPTS_RPO bash -c '! grep -E "^(FRESH_[A-Z]+_|OWNERSIM_)RPO_ACCEPTANCE=" "$1" | grep -vq "=UNMEASURED_OWNER$"' _ "$EVID"

finish
