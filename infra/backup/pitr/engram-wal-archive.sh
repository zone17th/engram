#!/usr/bin/env bash
# engram WAL archive_command (P06 Task 9). Runs INSIDE the DB container as user postgres:
#   archive_command = '/etc/postgresql/engram-wal-archive.sh %p %f'
# Writes <archive>/<ts-archive>--<walname>.gz.gpg plus <same>.sha256 with two sha256sum lines:
#   line 1: sha256 of the PLAINTEXT segment   "<sha>  <walname>"          (checked after decrypt on restore)
#   line 2: sha256 of the ENCRYPTED file      "<sha>  <ts>--<walname>.gz.gpg" (checked without any private key)
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

plain_sha="$(sha256sum "$src_path" | awk '{print $1}')"

# Never overwrite. An archived copy of this segment (any ts prefix) is acknowledged only when its plaintext
# digest matches the live segment AND its encrypted bytes still match the recorded ciphertext digest; the
# files and directory are synced again before returning 0. Anything else = error (Postgres retries).
shopt -s nullglob
existing=("$ARCHIVE_DIR"/*--"$wal_name".gz.gpg)
shopt -u nullglob
if [ "${#existing[@]}" -gt 0 ]; then
  for f in "${existing[@]}"; do
    [ -f "$f.sha256" ] || continue
    want_plain="$(awk 'NR == 1 {print $1}' "$f.sha256")"
    want_enc="$(awk 'NR == 2 {print $1}' "$f.sha256")"
    [ "$want_plain" = "$plain_sha" ] || continue
    if [ -n "$want_enc" ] && [ "$(sha256sum "$f" | awk '{print $1}')" = "$want_enc" ]; then
      sync -f "$f" "$f.sha256"
      sync -f "$ARCHIVE_DIR"
      exit 0
    fi
    echo "engram-wal-archive: $f is corrupt (encrypted digest mismatch); not acknowledging $wal_name" >&2
    exit 1
  done
  echo "engram-wal-archive: $wal_name already archived with a different or missing checksum" >&2
  exit 1
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
base="$ts--$wal_name.gz.gpg"
final="$ARCHIVE_DIR/$base"
partial="$final.partial"
sha_partial="$final.sha256.partial"
trap 'rm -f "$partial" "$sha_partial"' EXIT

gzip -c "$src_path" \
  | gpg --batch --yes --quiet --trust-model always --encrypt --recipient "$RECIPIENT" --output "$partial"
enc_sha="$(sha256sum "$partial" | awk '{print $1}')"
printf '%s  %s\n%s  %s\n' "$plain_sha" "$wal_name" "$enc_sha" "$base" >"$sha_partial"
sync -f "$partial" "$sha_partial"
mv -n "$sha_partial" "$final.sha256"
mv -n "$partial" "$final"
if [ ! -f "$final" ] || [ -e "$partial" ]; then
  echo "engram-wal-archive: rename failed for $final" >&2
  exit 1
fi
sync -f "$ARCHIVE_DIR"
exit 0
