#!/usr/bin/env bash
# engram interim nightly encrypted DB backup (P06-BACKUPNOW).
# pg_dump (custom format) is streamed straight into gpg; no plaintext dump ever touches disk.
# Exit codes: 0 ok, 1 failure (previous backups untouched), 2 skipped (low disk).
set -euo pipefail
umask 077

CONTAINER="${ENGRAM_DB_CONTAINER:-engram-db-1}"
DB_USER="${ENGRAM_DB_USER:-engram}"
DB_NAME="${ENGRAM_DB_NAME:-engram}"
RECIPIENT="F2C47029212F6EE7A9D4D1779D5A1ABAB6A75AD7"
export GNUPGHOME="${ENGRAM_BACKUP_GNUPGHOME:-/home/ubuntu/engram-ops/backup/gnupg}"
OUT_DIR="${ENGRAM_BACKUP_DIR:-/home/ubuntu/backups/engram/nightly}"
LOG="${ENGRAM_BACKUP_LOG:-/home/ubuntu/engram-ops/backup/backup.log}"
KEEP=7
MIN_DUMP_BYTES=10240
MIN_FREE_KB=$((3 * 1024 * 1024))

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG"; }

ts="$(date -u +%Y%m%dT%H%M%SZ)"
final="$OUT_DIR/engram-$ts.dump.gpg"
partial="$final.partial"
cnt="$(mktemp)"

cleanup() { rm -f "$partial" "$cnt"; }
fail() { log "FAIL $*"; cleanup; exit 1; }
trap 'fail "unexpected error line $LINENO"' ERR
trap 'rm -f "$partial" "$cnt"' EXIT

mkdir -p "$OUT_DIR"

free_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
if [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
  log "SKIP low disk: ${free_kb}KB free on / (< 3GB)"
  rm -f "$cnt"
  exit 2
fi

log "START $final"
set +e
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -Fc "$DB_NAME" 2>>"$LOG" \
  | tee >(wc -c >"$cnt") \
  | gpg --batch --yes --trust-model always --encrypt --recipient "$RECIPIENT" --output "$partial" 2>>"$LOG"
rc=("${PIPESTATUS[@]}")
# tee's process substitution may finish after the pipeline; wait briefly for the byte count.
for _ in $(seq 1 50); do [ -s "$cnt" ] && break; sleep 0.2; done
set -e
[ "${rc[0]}" -eq 0 ] || fail "pg_dump exit ${rc[0]}"
[ "${rc[2]}" -eq 0 ] || fail "gpg exit ${rc[2]}"
dump_bytes="$(tr -d ' ' <"$cnt")"
[ -n "$dump_bytes" ] && [ "$dump_bytes" -ge "$MIN_DUMP_BYTES" ] || fail "dump too small: ${dump_bytes:-0} bytes"

mv "$partial" "$final"
bytes="$(stat -c %s "$final")"
sha="$(sha256sum "$final" | awk '{print $1}')"
printf '{"ts":"%s","bytes":%s,"sha256":"%s","ok":true}\n' "$ts" "$bytes" "$sha" >"$OUT_DIR/last.json.tmp"
mv "$OUT_DIR/last.json.tmp" "$OUT_DIR/last.json"
rm -f "$cnt"

# Retention: only nightly files in OUT_DIR matching our own pattern.
ls -1 "$OUT_DIR"/engram-*.dump.gpg 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f -- "$old" && log "PRUNE $old"
done

log "OK $final dump_bytes=$dump_bytes enc_bytes=$bytes sha256=$sha"
