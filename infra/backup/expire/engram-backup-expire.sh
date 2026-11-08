#!/usr/bin/env bash
# engram 8-day backup retention sweep (P06 Task 22, PROD-STEP-RETENTION; contract R1-09/C09 in
# docs/runbooks/backup-restore-pitr.md "Retention contract" (a)-(e)).
#
# (a) Age = immutable SOURCE timestamp in the file NAME (first YYYYmmddTHHMMSSZ in the basename):
#     engram-<ts>.dump.gpg, engram-base-<ts>.tar.gz.gpg, <ts>--<wal>.gz.gpg, their .sha256/.partial
#     sidecars and every copy with the same name. mtime/ctime are NEVER read.
# (b) Deletes every backup file with now - source_ts >= 7d22h (684000 s). Runs hourly from
#     engram-backup-expire.timer (Persistent=true), independent of backup success.
#     Writes BACKUP_ROOT/expire/last-sweep.json (top-level ts + ok) and appends expire.log.
# (c) The monitor (infra/ops/engram-monitor.sh) alerts on a stale/failed marker or a source > 7d23h.
# (d) Daily bases + all WAL newer than them are kept until 7d22h, so a base aged 6d..7d22h and its
#     WAL always exist (PITR target now - 6d).
#
# Backup files = regular files (symlinks are never followed or deleted) whose name ends in
# .gpg .dump .sha256 .partial .tar .gz .sql. A backup file without a parseable timestamp, or with a
# timestamp more than 5 min in the future, is kept and makes the sweep ok:false (fail closed: the
# monitor alerts). Any delete/scan failure also gives ok:false and exit 1.
#
# The PITR WAL archive (BACKUP_ROOT/pitr/wal) is owned by the container's postgres user (0700), so
# with EXPIRE_WAL_CONTAINER set it is swept INSIDE that container as postgres (docker exec, this
# same script in --sweep-only mode) and pruned from the host scan.
#
# Env: EXPIRE_BACKUP_ROOT (default /home/ubuntu/backups/engram), EXPIRE_NOW_EPOCH (test clock;
# never set in the unit), EXPIRE_WAL_CONTAINER (e.g. engram-db-1; empty = scan pitr/wal directly),
# EXPIRE_WAL_CONTAINER_DIR (default /var/lib/postgresql/wal-archive).
# Exit: 0 sweep ok, 1 sweep finished with problems (marker ok:false) or could not run.
set -euo pipefail
umask 077

MAX_AGE=684000   # 7d22h
MAX_FUTURE=300   # tolerated clock skew for names ahead of now
TS_RE='[0-9]{8}T[0-9]{6}Z'
EXT_RE='\.(gpg|dump|sha256|partial|tar|gz|sql)$'

die() {
  printf 'engram-backup-expire: %s\n' "$*" >&2
  exit 1
}

# name_epoch <basename>: sets EPOCH to the UTC epoch of the first YYYYmmddTHHMMSSZ in the name;
# returns non-zero when there is none or it is not a real calendar time. Pure bash (no fork per
# file): days-from-civil, proleptic Gregorian, no leap seconds.
name_epoch() {
  local ts y m d hh mi ss dim era yoe doy doe
  [[ "$1" =~ $TS_RE ]] || return 1
  ts="${BASH_REMATCH[0]}"
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

# sweep <root> <now> [prune-dir]: deletes expired backup files under root. Prints one record per
# event (DELETED|UNNAMED|FUTURE|ERROR <path>) and a final "COUNTS deleted kept problems" line.
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
    [[ "$base" =~ $EXT_RE ]] || continue
    if ! name_epoch "$base"; then
      printf 'UNNAMED %s\n' "$f"
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
  # In-container mode: engram-backup-expire.sh --sweep-only <dir> <now-epoch>
  [ "$#" -eq 3 ] || die "usage: --sweep-only <dir> <now-epoch>"
  [[ "$3" =~ ^[0-9]+$ ]] || die "bad now epoch"
  [ -d "$2" ] || die "missing dir $2"
  sweep "$2" "$3"
  exit 0
fi

ROOT="${EXPIRE_BACKUP_ROOT:-/home/ubuntu/backups/engram}"
NOW="${EXPIRE_NOW_EPOCH:-$(date -u +%s)}"
WAL_CONTAINER="${EXPIRE_WAL_CONTAINER:-}"
WAL_CONTAINER_DIR="${EXPIRE_WAL_CONTAINER_DIR:-/var/lib/postgresql/wal-archive}"
[[ "$NOW" =~ ^[0-9]+$ ]] || die "EXPIRE_NOW_EPOCH must be epoch seconds"
[ -d "$ROOT" ] || die "backup root $ROOT missing"

STATE="$ROOT/expire"
mkdir -p "$STATE"
# One sweep at a time. flock is absent on the owner PC (Git Bash) where the off-host copy is swept with the same
# script (contract (e)); there a single scheduled task is the serialisation.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$STATE/.lock"
  flock -n 9 || die "another sweep holds $STATE/.lock"
fi

NOW_ISO="$(date -u -d "@$NOW" +%Y-%m-%dT%H:%M:%SZ)"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT

prune=""
if [ -n "$WAL_CONTAINER" ]; then
  prune="$ROOT/pitr/wal"
fi
sweep "$ROOT" "$NOW" "$prune" >>"$out"

if [ -n "$WAL_CONTAINER" ]; then
  # Same script, same clock, run as the archive owner inside the DB container.
  wal_rc=0
  docker exec -i -u postgres "$WAL_CONTAINER" bash -s -- --sweep-only "$WAL_CONTAINER_DIR" "$NOW" \
    <"${BASH_SOURCE[0]}" >>"$out" 2>&1 || wal_rc=$?
  if [ "$wal_rc" -ne 0 ]; then
    printf 'ERROR wal sweep in %s exit %s\n' "$WAL_CONTAINER" "$wal_rc" >>"$out"
  fi
fi

# Each sweep's COUNTS already includes its scan/delete problems; a failed WAL exec adds one.
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
