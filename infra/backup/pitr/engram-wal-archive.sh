#!/usr/bin/env bash
# engram WAL archive_command (P06 Task 9). Runs INSIDE the DB container as user postgres:
#   archive_command = '/etc/postgresql/engram-wal-archive.sh %p %f'
# Writes <archive>/<ts-archive>--<walname>.gz.gpg plus .sha256 (sha256 of the plaintext segment).
# <ts-archive> = UTC time this command runs (>= last write in the segment); retention ages files by this
# name timestamp only, never by mtime. Any non-zero exit makes Postgres keep the segment and retry.
set -euo pipefail
umask 077

if [ "$#" -ne 2 ]; then
  echo "engram-wal-archive: usage: $0 %p %f" >&2
  exit 1
fi
src_path="$1"
wal_name="$2"
ARCHIVE_DIR="${ENGRAM_WAL_ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
RECIPIENT="${ENGRAM_BACKUP_RECIPIENT:-F2C47029212F6EE7A9D4D1779D5A1ABAB6A75AD7}"
export GNUPGHOME="${GNUPGHOME:-/etc/postgresql/.gnupg}"

case "$wal_name" in
  '' | */* | .*) echo "engram-wal-archive: refusing wal name '$wal_name'" >&2; exit 1 ;;
esac
[ -d "$ARCHIVE_DIR" ] || { echo "engram-wal-archive: missing $ARCHIVE_DIR" >&2; exit 1; }

sha="$(sha256sum "$src_path" | awk '{print $1}')"

# Never overwrite: an archived copy of this segment (any ts prefix) with a matching checksum = done;
# a mismatching one = error (Postgres retries; operator investigates).
shopt -s nullglob
existing=("$ARCHIVE_DIR"/*--"$wal_name".gz.gpg)
shopt -u nullglob
if [ "${#existing[@]}" -gt 0 ]; then
  for f in "${existing[@]}"; do
    if [ -f "$f.sha256" ] && [ "$(awk '{print $1}' "$f.sha256")" = "$sha" ]; then
      exit 0
    fi
  done
  echo "engram-wal-archive: $wal_name already archived with a different checksum" >&2
  exit 1
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
final="$ARCHIVE_DIR/$ts--$wal_name.gz.gpg"
partial="$final.partial"
sha_partial="$final.sha256.partial"
trap 'rm -f "$partial" "$sha_partial"' EXIT

gzip -c "$src_path" \
  | gpg --batch --yes --quiet --trust-model always --encrypt --recipient "$RECIPIENT" --output "$partial"
printf '%s  %s\n' "$sha" "$wal_name" >"$sha_partial"
sync -f "$partial" "$sha_partial"
mv -n "$sha_partial" "$final.sha256"
mv -n "$partial" "$final"
if [ ! -f "$final" ] || [ -e "$partial" ]; then
  echo "engram-wal-archive: rename failed for $final" >&2
  exit 1
fi
sync -f "$ARCHIVE_DIR"
exit 0
