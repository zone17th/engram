#!/usr/bin/env bash
# Regression check (R1-V1): upstream pg_dump failure after >= 10 KiB output must
# exit non-zero, publish no backup, leave no .partial, and keep prior files/last.json unchanged.
# Uses a fake docker on PATH and an isolated output dir + throwaway GPG keyring; never touches production.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${1:-$HERE/engram-backup.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin" "$TMP/out" "$TMP/gpg"
chmod 700 "$TMP/gpg"
GNUPGHOME="$TMP/gpg" gpg --batch --quiet --import "$HERE/engram-backup-pub.asc"

cat >"$TMP/bin/docker" <<'EOF'
#!/usr/bin/env bash
head -c 20000 /dev/zero
exit 17
EOF
chmod +x "$TMP/bin/docker"

printf 'prev-backup\n' >"$TMP/out/engram-20260101T000000Z.dump.gpg"
printf '{"ts":"20260101T000000Z","bytes":12,"sha256":"prev","ok":true}\n' >"$TMP/out/last.json"
before="$(sha256sum "$TMP/out"/*)"

set +e
PATH="$TMP/bin:$PATH" \
  ENGRAM_BACKUP_GNUPGHOME="$TMP/gpg" \
  ENGRAM_BACKUP_DIR="$TMP/out" \
  ENGRAM_BACKUP_LOG="$TMP/backup.log" \
  "$SCRIPT"
rc=$?
set -e

[ "$rc" -ne 0 ] || { echo "FAIL: expected non-zero exit, got 0" >&2; exit 1; }
ls "$TMP/out"/*.partial >/dev/null 2>&1 && { echo "FAIL: .partial left behind" >&2; exit 1; }
[ "$(ls -1 "$TMP/out"/engram-*.dump.gpg | wc -l)" -eq 1 ] || { echo "FAIL: backup set changed" >&2; exit 1; }
grep -q "gpg exit" "$TMP/backup.log" && { echo "FAIL: gpg failed instead of upstream check" >&2; exit 1; }
after="$(sha256sum "$TMP/out"/*)"
[ "$before" = "$after" ] || { echo "FAIL: prior files or last.json modified" >&2; exit 1; }
echo "PASS: upstream exit 17 after 20000B caught (rc=$rc, prior state intact)"
