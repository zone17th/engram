#!/usr/bin/env bash
# engram scheduled encrypted base backup for PITR (P06 Task 9, R3-02/R4-02/R4-03).
# pg_basebackup (tar, gzip, -X fetch) runs in the DB container over the local socket as engram_replication
# (SCRAM via .pgpass; only the FILE PATH is passed) and streams straight into gpg: no plaintext touches disk.
# Output: <pitr>/base/engram-base-<YYYYmmddTHHMMSSZ>.tar.gz.gpg (+ .sha256), ts = UTC start of pg_basebackup.
# <pitr>/last-base.json is written ONLY after every step succeeded; its atomic rename is the commit point. On any
# failure before it: .partial/temporaries AND any final/.sha256 this run already renamed are removed,
# last-base.json untouched, exit 1. A concurrent start (lock held) exits 1 without touching any file.
set -euo pipefail
umask 077

CONTAINER="${ENGRAM_DB_CONTAINER:-engram-db-1}"
RECIPIENT="${ENGRAM_BACKUP_RECIPIENT:-F2C47029212F6EE7A9D4D1779D5A1ABAB6A75AD7}"
export GNUPGHOME="${ENGRAM_BACKUP_GNUPGHOME:-/home/ubuntu/engram-ops/backup/gnupg}"
PITR_DIR="${ENGRAM_PITR_DIR:-/home/ubuntu/backups/engram/pitr}"
PGPASSFILE_IN_CONTAINER="${ENGRAM_REPL_PGPASSFILE:-/run/secrets/engram_replication.pgpass}"
GPG="${ENGRAM_GPG:-gpg}"
LOG="${ENGRAM_PITR_LOG:-$PITR_DIR/base.log}"
MIN_BASE_BYTES="${ENGRAM_PITR_MIN_BASE_BYTES:-102400}"
# Rehearsal-only throttle (pg_basebackup -r) so failure cases can interrupt a running base. Empty in production.
MAX_RATE="${ENGRAM_PITR_MAX_RATE:-}"

BASE_DIR="$PITR_DIR/base"
mkdir -p "$BASE_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; }

# Lock BEFORE naming or registering cleanup of any output: a rejected concurrent start owns nothing and
# therefore removes nothing (the running producer's .partial stays intact).
exec 9>"$PITR_DIR/.base.lock"
if ! flock -n 9; then
  log "FAIL another base backup is running"
  echo "engram-pitr-base: FAIL another base backup is running" >&2
  exit 1
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
name="engram-base-$ts.tar.gz.gpg"
final="$BASE_DIR/$name"
partial="$final.partial"
sha_partial="$final.sha256.partial"
tmp_json="$PITR_DIR/last-base.json.tmp.$$"
errf="$(mktemp)"
cntf="$(mktemp)"
# Files this invocation published; removed again on any failure before the last-base.json commit point.
own_final=0
own_sha=0

cleanup() {
  rm -f "$partial" "$sha_partial" "$tmp_json" "$errf" "$cntf"
  [ "$own_final" -eq 1 ] && rm -f "$final"
  [ "$own_sha" -eq 1 ] && rm -f "$final.sha256"
  return 0
}
fail() {
  trap - ERR
  log "FAIL $name: $*" || true
  [ -s "$errf" ] && { sed 's/^/  pg_basebackup: /' "$errf" >>"$LOG" || true; }
  echo "engram-pitr-base: FAIL $*" >&2
  [ -s "$errf" ] && sed 's/^/  pg_basebackup: /' "$errf" >&2
  cleanup
  exit 1
}
trap 'fail "unexpected error line $LINENO"' ERR
trap cleanup EXIT

command -v "$GPG" >/dev/null 2>&1 || fail "gpg not found ($GPG)"
"$GPG" --batch --list-keys "$RECIPIENT" >/dev/null 2>&1 || fail "recipient key not in GNUPGHOME"
if [ -e "$final" ] || [ -e "$final.sha256" ]; then fail "$final already exists"; fi

rate_args=()
[ -n "$MAX_RATE" ] && rate_args=(-r "$MAX_RATE")

log "START $name"
trap - ERR
set +e
docker exec -u postgres -e PGPASSFILE="$PGPASSFILE_IN_CONTAINER" "$CONTAINER" \
  pg_basebackup -h /var/run/postgresql -U engram_replication -w -D - -Ft -X fetch -z --checkpoint=fast -v \
  "${rate_args[@]}" 2>"$errf" \
  | tee >(wc -c >"$cntf") \
  | "$GPG" --batch --yes --quiet --trust-model always --encrypt --recipient "$RECIPIENT" --output "$partial" 2>>"$errf"
rc=("${PIPESTATUS[@]}")
set -e
trap 'fail "unexpected error line $LINENO"' ERR
for _ in $(seq 1 50); do [ -s "$cntf" ] && break; sleep 0.2; done
[ "${rc[0]}" -eq 0 ] || fail "pg_basebackup exit ${rc[0]}"
[ "${rc[1]}" -eq 0 ] || fail "tee exit ${rc[1]}"
[ "${rc[2]}" -eq 0 ] || fail "gpg exit ${rc[2]}"
plain_bytes="$(tr -d ' ' <"$cntf")"
if [ -z "$plain_bytes" ] || [ "$plain_bytes" -lt "$MIN_BASE_BYTES" ]; then
  fail "base too small: ${plain_bytes:-0} bytes"
fi
wal_start="$(sed -n 's/.*write-ahead log start point: \([0-9A-F]*\/[0-9A-F]*\).*/\1/p' "$errf" | head -n 1)"
[ -n "$wal_start" ] || fail "no write-ahead log start point in pg_basebackup output"

sha="$(sha256sum "$partial" | awk '{print $1}')" || fail "sha256sum"
printf '%s  %s\n' "$sha" "$name" >"$sha_partial" || fail "write .sha256"
sync -f "$partial" "$sha_partial" || fail "sync"
mv -nT "$sha_partial" "$final.sha256" || fail "rename .sha256"
[ ! -e "$sha_partial" ] || fail "rename .sha256 did not publish"
own_sha=1
mv -nT "$partial" "$final" || fail "rename base"
[ ! -e "$partial" ] || fail "atomic rename did not publish $final"
own_final=1
sync -f "$BASE_DIR" || fail "sync dir"
bytes="$(stat -c %s "$final")" || fail "stat"

printf '{"ts":"%s","file":"%s","bytes":%s,"sha256":"%s","wal_start":"%s","ok":true}\n' \
  "$ts" "$name" "$bytes" "$sha" "$wal_start" >"$tmp_json" || fail "write last-base.json"
sync -f "$tmp_json" || fail "sync last-base.json"
# Commit point: after this rename the new base is the published, recorded success.
mv -T "$tmp_json" "$PITR_DIR/last-base.json" || fail "rename last-base.json"
own_final=0
own_sha=0
trap - ERR
sync -f "$PITR_DIR" || true
log "OK $name plain_bytes=$plain_bytes enc_bytes=$bytes sha256=$sha wal_start=$wal_start" || true
