#!/usr/bin/env bash
# Boundary + simulation test for engram-backup-expire.sh (P06 Task 22, C09). Bash + coreutils only,
# simulated clock via EXPIRE_NOW_EPOCH; never touches real backups. Prints OPSPROD_EXPIRE_EXIT=<n>.
#   1  7d21h59m kept / 7d22h00m deleted (nightly, base, WAL, .sha256 sidecars)
#   2  age from NAME only: old name + fresh mtime deleted; fresh name + ancient mtime kept
#   3  missed sweep: the next sweep deletes, age at deletion < 8d
#   4  backup failure (nightly/last.json ok:false, no new dump): sweep still deletes, ok:true
#   5  fail closed: unnamed / impossible-date / future backup files kept + ok:false + exit 1;
#      non-backup files (markers, env baks) and symlink targets untouched
#   6  WAL archive swept through `docker exec -u postgres` (shimmed docker), same clock
#   7  30-day hourly simulation (daily nightly + base, WAL every 10 min, failed backups, missed
#      sweeps): no file ever reaches 8d; from day 7 a base aged >= 6d with contiguous WAL after it
# check() evals single-quoted conditions at call time; keep/drop are read through ${!t}.
# shellcheck disable=SC2016,SC2034,SC2317
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/engram-backup-expire.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
PASSES=0

pass() { PASSES=$((PASSES + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FAIL %s\n' "$1"; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }

ts_of() { date -u -d "@$1" +%Y%m%dT%H%M%SZ; }
D=86400
H=3600
MAX=$((7 * D + 22 * H))
NOW=1794000000 # fixed simulated clock (2026-11-06T..Z); the real clock is never used

newroot() {
  local r="$WORK/$1"
  mkdir -p "$r"/{nightly,pitr/base,pitr/wal,expire,offhost}
  printf '%s\n' "$r"
}
mk() { mkdir -p "$(dirname "$1")"; : >"$1"; }
run_sweep() { # run_sweep <root> <now> -> rc in SWEEP_RC
  EXPIRE_BACKUP_ROOT="$1" EXPIRE_NOW_EPOCH="$2" EXPIRE_WAL_CONTAINER="${3:-}" \
    bash "$SCRIPT" >"$WORK/last.out" 2>&1
  SWEEP_RC=$?
}
marker_ok() { grep -q '"ok":true' "$1/expire/last-sweep.json"; }

# 1. Boundary.
R="$(newroot c1)"
keep=$((NOW - MAX + 60)) # 7d21h59m
drop=$((NOW - MAX))      # 7d22h00m
for t in keep drop; do
  e=${!t}
  mk "$R/nightly/engram-$(ts_of "$e").dump.gpg"
  mk "$R/nightly/engram-$(ts_of "$e").dump.gpg.sha256"
  mk "$R/pitr/base/engram-base-$(ts_of "$e").tar.gz.gpg"
  mk "$R/pitr/wal/$(ts_of "$e")--000000010000000000000042.gz.gpg"
done
run_sweep "$R" "$NOW"
check "c1 sweep exit 0 + marker ok" '[ "$SWEEP_RC" -eq 0 ] && marker_ok "$R"'
check "c1 7d21h59m kept (4 files)" '[ "$(find "$R" -name "*$(ts_of "$keep")*" | wc -l)" -eq 4 ]'
check "c1 7d22h00m deleted (4 files)" '[ "$(find "$R" -name "*$(ts_of "$drop")*" | wc -l)" -eq 0 ]'

# 2. Name, never mtime.
R="$(newroot c2)"
old="$R/offhost/engram-$(ts_of $((NOW - 8 * D))).dump.gpg"
fresh="$R/nightly/engram-$(ts_of $((NOW - D))).dump.gpg"
mk "$old"
touch -d "@$NOW" "$old"
mk "$fresh"
touch -d "@$((NOW - 40 * D))" "$fresh"
run_sweep "$R" "$NOW"
check "c2 old name + fresh mtime deleted" '[ ! -e "$old" ]'
check "c2 fresh name + 40d-old mtime kept" '[ -e "$fresh" ]'

# 3. Missed sweep.
R="$(newroot c3)"
f="$R/nightly/engram-$(ts_of $((NOW - MAX + 30 * 60))).dump.gpg" # 7d21h30m at run k
mk "$f"
run_sweep "$R" "$NOW"
check "c3 run k (7d21h30m) keeps" '[ -e "$f" ]'
# run k+1 at NOW+1h is missed; run k+2 at NOW+2h sees age 7d23h30m.
run_sweep "$R" $((NOW + 2 * H))
check "c3 run after a missed sweep deletes, age < 8d" \
  '[ ! -e "$f" ] && [ $((MAX - 30 * 60 + 2 * H)) -lt $((8 * D)) ]'

# 4. Backup failure does not stop retention.
R="$(newroot c4)"
printf '{"ts":"%s","ok":false}\n' "$(ts_of $((NOW - 2 * D)))" >"$R/nightly/last.json"
f="$R/nightly/engram-$(ts_of $((NOW - 9 * D))).dump.gpg"
mk "$f"
run_sweep "$R" "$NOW"
check "c4 failed backup: expired dump still deleted, ok:true" \
  '[ ! -e "$f" ] && [ "$SWEEP_RC" -eq 0 ] && marker_ok "$R"'
check "c4 nightly/last.json untouched" 'grep -q "\"ok\":false" "$R/nightly/last.json"'

# 5. Fail closed + scope.
R="$(newroot c5)"
mk "$R/engram-pre-p04-manual.dump"
mk "$R/nightly/engram-20261340T000000Z.dump.gpg"
mk "$R/nightly/engram-$(ts_of $((NOW + D))).dump.gpg"
mk "$R/env.production.bak-$(ts_of $((NOW - 30 * D)))"
mk "$R/r1-vars.sh"
outside="$WORK/outside-$(ts_of $((NOW - 30 * D))).dump.gpg"
mk "$outside"
ln -s "$outside" "$R/nightly/link-$(ts_of $((NOW - 30 * D))).dump.gpg"
run_sweep "$R" "$NOW"
check "c5 problems -> exit 1 + ok:false" \
  '[ "$SWEEP_RC" -eq 1 ] && grep -q "\"ok\":false" "$R/expire/last-sweep.json" && grep -q "\"problems\":3" "$R/expire/last-sweep.json"'
check "c5 unnamed/impossible/future kept" \
  '[ -e "$R/engram-pre-p04-manual.dump" ] && [ -e "$R/nightly/engram-20261340T000000Z.dump.gpg" ] && [ -e "$R/nightly/engram-$(ts_of $((NOW + D))).dump.gpg" ]'
check "c5 non-backup files untouched" '[ -e "$R/env.production.bak-$(ts_of $((NOW - 30 * D)))" ] && [ -e "$R/r1-vars.sh" ]'
check "c5 symlink and its target untouched" '[ -L "$R/nightly/link-$(ts_of $((NOW - 30 * D))).dump.gpg" ] && [ -e "$outside" ]'
check "c5 expire.log records UNNAMED + FUTURE" 'grep -q UNNAMED "$R/expire/expire.log" && grep -q FUTURE "$R/expire/expire.log"'

# 6. WAL via docker exec (shim maps the container dir onto the fixture dir and records argv).
R="$(newroot c6)"
mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$WORK/docker.argv"
[ "\$1 \$2 \$3 \$4" = "exec -i -u postgres" ] || exit 99
shift 5 # exec -i -u postgres <container>
args=("\$@")
for i in "\${!args[@]}"; do [ "\${args[\$i]}" = /var/lib/postgresql/wal-archive ] && args[\$i]="$R/pitr/wal"; done
exec "\${args[@]}"
EOF
chmod +x "$WORK/bin/docker"
wold="$R/pitr/wal/$(ts_of $((NOW - 8 * D)))--000000010000000000000001.gz.gpg"
wnew="$R/pitr/wal/$(ts_of $((NOW - H)))--000000010000000000000002.gz.gpg"
nold="$R/nightly/engram-$(ts_of $((NOW - 8 * D))).dump.gpg"
mk "$wold"; mk "$wnew"; mk "$nold"
PATH="$WORK/bin:$PATH" run_sweep "$R" "$NOW" engram-db-1
check "c6 WAL swept in container: old deleted, new kept, host dump deleted" \
  '[ "$SWEEP_RC" -eq 0 ] && [ ! -e "$wold" ] && [ -e "$wnew" ] && [ ! -e "$nold" ]'
check "c6 docker exec as postgres in engram-db-1 with the same clock" \
  'grep -q "^exec -i -u postgres engram-db-1 bash -s -- --sweep-only /var/lib/postgresql/wal-archive $NOW\$" "$WORK/docker.argv"'
check "c6 marker counts host + WAL deletions" 'grep -q "\"deleted\":2" "$R/expire/last-sweep.json"'
printf '#!/usr/bin/env bash\nexit 1\n' >"$WORK/bin/docker"
PATH="$WORK/bin:$PATH" run_sweep "$R" "$NOW" engram-db-1
check "c6 WAL exec failure -> ok:false + exit 1" '[ "$SWEEP_RC" -eq 1 ] && grep -q "\"ok\":false" "$R/expire/last-sweep.json"'

# 7. 30-day hourly simulation.
R="$(newroot c7)"
T0=$((NOW - NOW % D)) # 00:00Z
declare -A BASE_START # base ts -> first WAL seq archived after it
seq=1
nextwal=$T0
violations=0
pitr_fail=0
pitr_checks=0
max_seen=0
declare -A EP # source ts string -> epoch (recorded at creation; avoids a date fork per file per tick)
mkt() { # mkt <path-prefix> <epoch> <suffix>
  local s
  s="$(ts_of "$2")"
  EP[$s]=$2
  mk "$1$s$3"
}
for ((h = 0; h < 30 * 24; h++)); do
  t=$((T0 + h * H))
  # WAL every 10 min up to t (archive time = source ts).
  while [ "$nextwal" -le "$t" ]; do
    mkt "$R/pitr/wal/" "$nextwal" "--$(printf '%024X' "$seq").gz.gpg"
    seq=$((seq + 1))
    nextwal=$((nextwal + 600))
  done
  hod=$(((t % D) / H))
  day=$((h / 24))
  if [ "$hod" -eq 21 ]; then
    # 20:17Z nightly dump (03:17 UTC+7), failing on days 3, 11, 12 (no file).
    if [ "$day" -ne 3 ] && [ "$day" -ne 11 ] && [ "$day" -ne 12 ]; then
      mkt "$R/nightly/engram-" $((t - 43 * 60)) ".dump.gpg"
    fi
    # 20:45Z base (03:45 UTC+7). WAL 20:50 (seq-2) and 21:00 (seq-1) were archived after its start.
    bts=$((t - 15 * 60))
    mkt "$R/pitr/base/engram-base-" "$bts" ".tar.gz.gpg"
    BASE_START[$bts]=$((seq - 2))
  fi
  # Oldest file age right before the sweep (the worst point, incl. after a missed sweep).
  while IFS= read -r -d '' f; do
    [[ "${f##*/}" =~ [0-9]{8}T[0-9]{6}Z ]] || continue
    a=$((t - EP[${BASH_REMATCH[0]}]))
    [ "$a" -gt "$max_seen" ] && max_seen=$a
    [ "$a" -ge $((8 * D)) ] && violations=$((violations + 1))
  done < <(find "$R" -type f -name '*.gpg' -print0)
  # Missed sweeps (timer did not fire) at hours 200 and 401.
  if [ "$h" -eq 200 ] || [ "$h" -eq 401 ]; then
    continue
  fi
  run_sweep "$R" "$t"
  if [ "$SWEEP_RC" -ne 0 ]; then
    violations=$((violations + 1))
    cat "$WORK/last.out"
  fi
  # PITR (d): from day 7, a base with ts <= t - 6d exists and every WAL seq from its start to now.
  if [ "$day" -ge 7 ]; then
    pitr_checks=$((pitr_checks + 1))
    # WAL present: min seq + count (names are unique per seq, so count == range <=> no gap).
    minseq=-1
    nwal=0
    for f in "$R"/pitr/wal/*.gpg; do
      [ -e "$f" ] || continue
      b="${f##*--}"
      k=$((16#${b%%.*}))
      nwal=$((nwal + 1))
      if [ "$minseq" -lt 0 ] || [ "$k" -lt "$minseq" ]; then minseq=$k; fi
    done
    good=0
    for f in "$R"/pitr/base/*.gpg; do
      [[ "${f##*/}" =~ [0-9]{8}T[0-9]{6}Z ]] || continue
      e=${EP[${BASH_REMATCH[0]}]}
      [ "$e" -le $((t - 6 * D)) ] || continue
      if [ "$minseq" -ge 0 ] && [ "$minseq" -le "${BASE_START[$e]}" ] && [ "$nwal" -eq $((seq - minseq)) ]; then
        good=1
        break
      fi
    done
    [ "$good" -eq 1 ] || pitr_fail=$((pitr_fail + 1))
  fi
done
printf 'c7 simulated %s hourly ticks, oldest age seen before a sweep %ss (8d = %ss), pitr checks %s\n' \
  $((30 * 24)) "$max_seen" $((8 * D)) "$pitr_checks"
check "c7 no backup file ever reaches 8d (missed sweeps at h200 and h401)" '[ "$violations" -eq 0 ] && [ "$max_seen" -lt $((8 * D)) ]'
check "c7 a base aged >= 6d with contiguous WAL after it, every hour from day 7" '[ "$pitr_fail" -eq 0 ] && [ "$pitr_checks" -gt 0 ]'
oldest_nightly=0
for f in "$R"/nightly/*.gpg; do
  [[ "${f##*/}" =~ [0-9]{8}T[0-9]{6}Z ]] || continue
  a=$((t - EP[${BASH_REMATCH[0]}]))
  [ "$a" -gt "$oldest_nightly" ] && oldest_nightly=$a
done
check "c7 failed backup days (3, 11, 12) did not stop retention: oldest dump < 7d22h at the end" \
  '[ "$oldest_nightly" -gt 0 ] && [ "$oldest_nightly" -lt "$MAX" ]'

printf 'test-expire: %s passed, %s failed\n' "$PASSES" "$FAILS"
rc=0
[ "$FAILS" -eq 0 ] || rc=1
echo
echo "OPSPROD_EXPIRE_EXIT=$rc"
exit "$rc"
