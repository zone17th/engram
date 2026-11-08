#!/usr/bin/env bash
# engram WAL restore_command (P06 Task 9). Runs inside a RESTORE container (never production) as postgres:
#   restore_command = '/etc/postgresql/engram-wal-restore.sh %f %p'
# Finds <archive>/<ts>--<%f>.gz.gpg (the <ts>-- prefix is stripped by matching on the suffix), decrypts with the
# private key in ENGRAM_RESTORE_GNUPGHOME after checking the encrypted digest (.sha256 line 2), verifies the plaintext
# sha256 (.sha256 line 1), then writes %p.
# Exit 1 when the segment is not archived (normal end of archive for Postgres). A present but corrupt/undecryptable
# segment exits 126 so Postgres ABORTS recovery instead of silently promoting at an earlier point.
set -euo pipefail
umask 077

if [ "$#" -ne 2 ]; then
  echo "engram-wal-restore: usage: $0 %f %p" >&2
  exit 126
fi
wal_name="$1"
dst_path="$2"
ARCHIVE_DIR="${ENGRAM_WAL_ARCHIVE_DIR:-/var/lib/postgresql/wal-archive}"
export GNUPGHOME="${ENGRAM_RESTORE_GNUPGHOME:?ENGRAM_RESTORE_GNUPGHOME (private key dir) is required}"

case "$wal_name" in
  '' | */* | .*) echo "engram-wal-restore: refusing wal name '$wal_name'" >&2; exit 126 ;;
esac

shopt -s nullglob
candidates=("$ARCHIVE_DIR"/*--"$wal_name".gz.gpg)
shopt -u nullglob
[ "${#candidates[@]}" -gt 0 ] || exit 1

tmp="$dst_path.engram-restore"
trap 'rm -f "$tmp"' EXIT
for f in "${candidates[@]}"; do
  [ -f "$f.sha256" ] || continue
  want="$(awk 'NR == 1 {print $1}' "$f.sha256")"
  want_enc="$(awk 'NR == 2 {print $1}' "$f.sha256")"
  if [ -n "$want_enc" ] && [ "$(sha256sum "$f" | awk '{print $1}')" = "$want_enc" ] \
    && gpg --batch --quiet --decrypt "$f" 2>/dev/null | gunzip -c >"$tmp"; then
    got="$(sha256sum "$tmp" | awk '{print $1}')"
    if [ "$got" = "$want" ]; then
      mv "$tmp" "$dst_path"
      exit 0
    fi
  fi
  echo "engram-wal-restore: $f failed decrypt or checksum" >&2
  exit 126
done
echo "engram-wal-restore: $wal_name archived without .sha256" >&2
exit 126
