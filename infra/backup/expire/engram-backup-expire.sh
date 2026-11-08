#!/usr/bin/env bash
# engram 8-day backup retention sweep (P06 Task 22, PROD-STEP-RETENTION; contract R1-09/C09 in
# docs/runbooks/backup-restore-pitr.md "Retention contract" (a)-(e); review r1 R1-01/R1-07, advisor-dec-P06-059).
#
# (a) Age = immutable SOURCE timestamp in the file NAME. Only these exact names are recognised (anchored, full name):
#       engram-<ts>.dump.gpg[.sha256|.partial]                                nightly pg_dump (Task 9 interim producer)
#       engram-base-<ts>.tar.gz.gpg[.sha256|.partial|.sha256.partial]    PITR base (engram-pitr-base.sh)
#       <ts>--<wal>.gz.gpg[.sha256|.partial|.sha256.partial]             WAL (engram-wal-archive.sh); <wal> = 24 hex
#                                                                         segment [.partial] | segment.<8 hex>.backup
#                                                                         | <8 hex>.history
#       engram-pre-p0<N>-<ts>.dump[.sha256]                              inventoried legacy manual dumps (opsrecon)
#     <ts> = YYYYmmddTHHMMSSZ. mtime/ctime are NEVER read. Copies keep the same names (off-host: same rule).
# (b) Deletes every recognised file with now - source_ts >= 7d22h (684000 s). Runs hourly from
#     engram-backup-expire.timer (Persistent=true), independent of backup success.
#     Writes BACKUP_ROOT/expire/last-sweep.json (top-level ts + ok) and appends expire.log.
# (c) The monitor (infra/ops/engram-monitor.sh) alerts on a stale/failed marker or a source > 7d23h.
# (d) Daily bases + all WAL newer than them are kept until 7d22h, so a base aged 6d..7d22h and its WAL always exist.
#
# Fail closed: a backup-like file (.gpg .dump .sha256 .partial .tar .gz .sql) that is not an exact recognised name,
# has an impossible date, or is > 5 min in the future is KEPT and makes the sweep ok:false (exit 1); so does any
# scan/delete error. Other files (markers, logs, env backups) are not backups and are ignored. Symlinks are never
# followed or deleted.
#
# WAL archive (BACKUP_ROOT/pitr/wal) is owned by the container's postgres uid 999, mode 0700 (Task 9). With
# EXPIRE_WAL_IMAGE set, that subtree is pruned from the host scan and swept by THIS script (--sweep-only) in a
# throwaway `docker run --network none --user 999:999` of that image with only the WAL dir mounted. It never execs
# into the production DB container and never relaxes 0700, so it works before PROD-STEP-4, after it and after its
# rollback. EXPIRE_WAL_IMAGE unset + unreadable WAL dir = scan error = ok:false.
#
# Env: EXPIRE_BACKUP_ROOT (default /home/ubuntu/backups/engram), EXPIRE_NOW_EPOCH (test clock; never set in the
# unit), EXPIRE_WAL_IMAGE (e.g. the POSTGRES_IMAGE pin), EXPIRE_WAL_UID (default 999:999).
# Exit: 0 sweep ok, 1 sweep finished with problems (marker ok:false) or could not run.
set -euo pipefail
umask 077

MAX_AGE=684000 # 7d22h
MAX_FUTURE=300 # tolerated clock skew for names ahead of now
TS='([0-9]{8}T[0-9]{6}Z)'
WALNAME='([0-9A-F]{24}(\.partial|\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)'
RECOGNISED=(
  "^engram-${TS}\.dump\.gpg(\.sha256|\.partial)?$"
  "^engram-base-${TS}\.tar\.gz\.gpg(\.sha256|\.partial|\.sha256\.partial)?$"
  "^${TS}--${WALNAME}\.gz\.gpg(\.sha256|\.partial|\.sha256\.partial)?$"
  "^engram-pre-p0[0-9]-${TS}\.dump(\.sha256)?$"
)
BACKUP_LIKE='\.(gpg|dump|sha256|partial|tar|gz|sql)$'

die() {
  printf 'engram-backup-expire: %s\n' "$*" >&2
  exit 1
}

# recognised_ts <basename>: sets TSV to the source timestamp when the WHOLE name is a recognised backup name.
recognised_ts() {
  local re
  for re in "${RECOGNISED[@]}"; do
    if [[ "$1" =~ $re ]]; then
      TSV="${BASH_REMATCH[1]}"
      return 0
    fi
  done
  return 1
}

# ts_epoch <YYYYmmddTHHMMSSZ>: sets EPOCH (UTC); non-zero for an impossible calendar time. Pure bash (no fork per
# file): days-from-civil, proleptic Gregorian, no leap seconds.
ts_epoch() {
  local ts="$1" y m d hh mi ss dim era yoe doy doe
  y=$((10#${ts:0:4})) m=$((10#${ts:4:2})) d=$((10#${ts:6:2}))
  hh=$((10#${ts:9:2})) mi=$((10#${ts:11:2})) ss=$((10#${ts:13:2}))
  [ "$m" -ge 1 ] && [ "$m" -le 12 ] && [ "$hh" -le 23 ] && [ "$mi" -le 59 ] && [ "$ss" -le 59 ] || return 1
  case "$m" in
    4 | 6 | 9 | 11) dim=30 ;;
    2) if [ $((y % 4)) -eq 0 ] && { [ $((y % 100)) -ne 0 ] || [ $((y % 400)) -eq 0 ]; }; then dim=29; else dim=28; fi ;;
    *) dim=31 ;;
  esac
  [ "$d" -ge 1 ] && [ "$d" -le "$dim" ] || return 1
  [ "$m" -le 2 ] && y=$((y - 1))
  era=$((y / 400))
  yoe=$((y - era * 400))
  if [ "$m" -gt 2 ]; then doy=$(((153 * (m - 3) + 2) / 5 + d - 1)); else doy=$(((153 * (m + 9) + 2) / 5 + d - 1)); fi
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  EPOCH=$(((era * 146097 + doe - 719468) * 86400 + hh * 3600 + mi * 60 + ss))
}

# sweep <root> <now> [prune-dir]: deletes expired recognised backups under root. Prints one record per event
# (DELETED|UNRECOGNISED|BADDATE|FUTURE|ERROR <path>) and a final "COUNTS deleted kept problems" line.
sweep() {
  local root="$1" now="$2" prune="${3:-}" list err rc=0 f base age
  local deleted=0 kept=0 problems=0
  list="$(mktemp)"
  err="$(mktemp)"
  if [ -n "$prune" ]; then
    find "$root" -path "$prune" -prune -o -type f -print0 >"$list" 2>"$err" || rc=$?
  else
    find "$root" -type f -print0 >"$list" 2>"$err" || rc=$?
  fi
  if [ "$rc" -ne 0 ] || [ -s "$err" ]; then
    printf 'ERROR scan %s (find exit %s): %s\n' "$root" "$rc" "$(head -c 300 "$err" | tr '\n' ' ')"
    problems=$((problems + 1))
  fi
  while IFS= read -r -d '' f; do
    base="${f##*/}"
    if ! recognised_ts "$base"; then
      if [[ "$base" =~ $BACKUP_LIKE ]]; then
        printf 'UNRECOGNISED %s\n' "$f"
        problems=$((problems + 1))
      fi
      continue
    fi
    if ! ts_epoch "$TSV"; then
      printf 'BADDATE %s\n' "$f"
      problems=$((problems + 1))
      continue
    fi
    age=$((now - EPOCH))
    if [ "$age" -lt $((-MAX_FUTURE)) ]; then
      printf 'FUTURE %s\n' "$f"
      problems=$((problems + 1))
    elif [ "$age" -ge "$MAX_AGE" ]; then
      if rm -f -- "$f"; then
        printf 'DELETED %s age=%ss\n' "$f" "$age"
        deleted=$((deleted + 1))
      else
        printf 'ERROR delete %s\n' "$f"
        problems=$((problems + 1))
      fi
    else
      kept=$((kept + 1))
    fi
  done <"$list"
  rm -f "$list" "$err"
  printf 'COUNTS %s %s %s\n' "$deleted" "$kept" "$problems"
}

if [ "${1:-}" = "--sweep-only" ]; then
  # Isolated-container mode: engram-backup-expire.sh --sweep-only <dir> <now-epoch>
  [ "$#" -eq 3 ] || die "usage: --sweep-only <dir> <now-epoch>"
  [[ "$3" =~ ^[0-9]+$ ]] || die "bad now epoch"
  [ -d "$2" ] || die "missing dir $2"
  sweep "$2" "$3"
  exit 0
fi

ROOT="${EXPIRE_BACKUP_ROOT:-/home/ubuntu/backups/engram}"
NOW="${EXPIRE_NOW_EPOCH:-$(date -u +%s)}"
WAL_IMAGE="${EXPIRE_WAL_IMAGE:-}"
WAL_UID="${EXPIRE_WAL_UID:-999:999}"
[[ "$NOW" =~ ^[0-9]+$ ]] || die "EXPIRE_NOW_EPOCH must be epoch seconds"
[ -d "$ROOT" ] || die "backup root $ROOT missing"
ROOT="$(cd "$ROOT" && pwd -P)"

STATE="$ROOT/expire"
mkdir -p "$STATE"
# One sweep at a time (flock is util-linux; the off-host PowerShell sweep has its own mutex).
exec 9>"$STATE/.lock"
flock -n 9 || die "another sweep holds $STATE/.lock"

NOW_ISO="$(date -u -d "@$NOW" +%Y-%m-%dT%H:%M:%SZ)"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT

WAL_DIR="$ROOT/pitr/wal"
prune=""
[ -n "$WAL_IMAGE" ] && prune="$WAL_DIR"
sweep "$ROOT" "$NOW" "$prune" >>"$out"

if [ -n "$WAL_IMAGE" ] && [ -d "$WAL_DIR" ]; then
  # Same script, same clock, as the archive owner, with nothing but the WAL dir mounted.
  wal_rc=0
  docker run --rm -i --network none --user "$WAL_UID" --entrypoint bash \
    -v "$WAL_DIR:/wal-archive" "$WAL_IMAGE" -s -- --sweep-only /wal-archive "$NOW" \
    <"${BASH_SOURCE[0]}" >>"$out" 2>&1 || wal_rc=$?
  if [ "$wal_rc" -ne 0 ] || ! grep -q '^COUNTS ' <(tail -n 1 "$out"); then
    printf 'ERROR wal sweep (docker run %s) exit %s\n' "$WAL_IMAGE" "$wal_rc" >>"$out"
  fi
fi

# Each sweep's COUNTS already includes its scan/delete problems; a failed WAL run adds one.
deleted=0
kept=0
problems=0
while read -r tag a b c _; do
  [ "$tag" = COUNTS ] || continue
  deleted=$((deleted + a))
  kept=$((kept + b))
  problems=$((problems + c))
done <"$out"
if grep -q '^ERROR wal sweep' "$out"; then
  problems=$((problems + 1))
fi

ok=true
[ "$problems" -eq 0 ] || ok=false

{
  grep -vE '^COUNTS ' "$out" | sed "s|^|$NOW_ISO |" || true
  printf '%s SWEEP ok=%s deleted=%s kept=%s problems=%s\n' "$NOW_ISO" "$ok" "$deleted" "$kept" "$problems"
} >>"$STATE/expire.log"

printf '{"ts":"%s","ok":%s,"deleted":%s,"kept":%s,"problems":%s,"max_age_seconds":%s}\n' \
  "$NOW_ISO" "$ok" "$deleted" "$kept" "$problems" "$MAX_AGE" >"$STATE/last-sweep.json.tmp"
mv "$STATE/last-sweep.json.tmp" "$STATE/last-sweep.json"

[ "$ok" = true ] || exit 1
exit 0
