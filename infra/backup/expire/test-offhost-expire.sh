#!/usr/bin/env bash
# Off-host retention proof (P06 Task 22, review r1 R1-03, advisor-dec-P06-059). Cloud runner (needs pwsh; installs
# a pinned PowerShell tarball into a temp dir when absent). Never touches real backups. Prints OPSPROD_OFFHOST_EXIT=<n>.
#   p  parity: engram-offhost-expire.ps1 and engram-backup-expire.sh leave the SAME files and the same ok flag on one
#      fixture set (boundary 7d21h59m/7d22h00m, name vs fresh mtime, allowlist rejects, bad/future dates, symlink)
#   t  Task Scheduler XML: hourly repetition, StartWhenAvailable=true, logon trigger, IgnoreNew, runs the .ps1
#   s  30-day simulation, hourly ticks: bro producer + bro hourly sweep; owner-PC DAILY pull (copies keep names, get
#      fresh mtime; pulls fail on days 4, 5, 13) + INDEPENDENT hourly PC sweep (missed at h250 and h500): no PC
#      copy ever reaches 8d, including right after a pull and after a missed sweep
# check() evals single-quoted conditions at call time; helpers are called from those strings.
# shellcheck disable=SC2016,SC2034,SC2317
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASH_SWEEP="$HERE/engram-backup-expire.sh"
PS_SWEEP="$HERE/engram-offhost-expire.ps1"
TASK_XML="$HERE/engram-offhost-expire.task.xml"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FAIL %s\n' "$1"; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
finish() {
  printf 'test-offhost-expire: %s passed, %s failed\n' "$PASSES" "$FAILS"
  local rc=0
  [ "$FAILS" -eq 0 ] || rc=1
  echo
  echo "OPSPROD_OFFHOST_EXIT=$rc"
  exit "$rc"
}

PWSH_VERSION=7.4.6
PWSH="$(command -v pwsh || true)"
if [ -z "$PWSH" ]; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) arch="" ;;
  esac
  if [ -n "$arch" ] && mkdir -p "$WORK/pwsh" &&
    curl -fsSL "https://github.com/PowerShell/PowerShell/releases/download/v$PWSH_VERSION/powershell-$PWSH_VERSION-linux-$arch.tar.gz" |
    tar -xz -C "$WORK/pwsh"; then
    chmod +x "$WORK/pwsh/pwsh"
    PWSH="$WORK/pwsh/pwsh"
  fi
fi
if [ -z "$PWSH" ] || ! "$PWSH" -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' >"$WORK/pwsh.ver" 2>&1; then
  fail "pwsh unavailable (cannot prove the off-host sweep)"
  finish
fi
printf 'pwsh %s\n' "$(cat "$WORK/pwsh.ver")"

ts_of() { date -u -d "@$1" +%Y%m%dT%H%M%SZ; }
D=86400
H=3600
MAX=$((7 * D + 22 * H))
NOW=1794000000
mk() { mkdir -p "$(dirname "$1")"; : >"$1"; }
ps_sweep() { # ps_sweep <root> <now> -> PS_RC
  EXPIRE_NOW_EPOCH="$2" "$PWSH" -NoProfile -NonInteractive -File "$PS_SWEEP" -Root "$1" >"$WORK/ps.out" 2>&1
  PS_RC=$?
}
bash_sweep() { # bash_sweep <root> <now> -> BASH_RC
  EXPIRE_BACKUP_ROOT="$1" EXPIRE_NOW_EPOCH="$2" EXPIRE_WAL_IMAGE="" bash "$BASH_SWEEP" >"$WORK/bash.out" 2>&1
  BASH_RC=$?
}

# p. Parity on one fixture set.
fixture() {
  local r="$1" old keep drop
  old="$(ts_of $((NOW - 30 * D)))"
  keep="$(ts_of $((NOW - MAX + 60)))"
  drop="$(ts_of $((NOW - MAX)))"
  for t in "$keep" "$drop"; do
    mk "$r/nightly/engram-$t.dump.gpg"
    mk "$r/pitr/base/engram-base-$t.tar.gz.gpg"
    mk "$r/pitr/base/engram-base-$t.tar.gz.gpg.sha256"
    mk "$r/pitr/wal/$t--000000010000000000000042.gz.gpg"
    mk "$r/pitr/wal/$t--000000010000000000000042.gz.gpg.sha256"
  done
  mk "$r/nightly/engram-$old.dump.gpg"
  touch -d "@$NOW" "$r/nightly/engram-$old.dump.gpg" # fresh mtime from a pull
  mk "$r/nightly/engram-$(ts_of $((NOW - D))).dump.gpg"
  touch -d "@$((NOW - 40 * D))" "$r/nightly/engram-$(ts_of $((NOW - D))).dump.gpg"
  mk "$r/engram-pre-p05-$old.dump"
  mk "$r/not-a-backup-$old.sql"
  mk "$r/nightly/engram-$old.dump.gpg.UNEXPECTED.gpg"
  mk "$r/pitr/wal/$old--00000001000000000000000a.gz.gpg"
  mk "$r/nightly/engram-20261340T000000Z.dump.gpg"
  mk "$r/nightly/engram-$(ts_of $((NOW + D))).dump.gpg"
  mk "$r/notes-$old.txt"
  mk "$WORK/outside-$old.dump.gpg"
  ln -s "$WORK/outside-$old.dump.gpg" "$r/link-engram-$old.dump.gpg"
  ln -s "$WORK/outside-$old.dump.gpg" "$r/engram-pre-p04-$old.dump"
}
listing() { (cd "$1" && find . \( -type f -o -type l \) ! -path './expire/*' | sort); }
fixture "$WORK/pa"
fixture "$WORK/pb"
bash_sweep "$WORK/pa" "$NOW"
ps_sweep "$WORK/pb" "$NOW"
cat "$WORK/ps.out"
check "p parity: same surviving files (bash vs PowerShell)" 'diff <(listing "$WORK/pa") <(listing "$WORK/pb") >&2'
check "p parity: both exit 1 with ok:false (5 problem files kept)" \
  '[ "$BASH_RC" -eq 1 ] && [ "$PS_RC" -eq 1 ] && grep -q "\"ok\":false" "$WORK/pb/expire/last-sweep.json" && grep -q "\"problems\":5" "$WORK/pb/expire/last-sweep.json" && grep -q "\"problems\":5" "$WORK/pa/expire/last-sweep.json"'
check "p 7d22h00m deleted, 7d21h59m kept (PowerShell)" \
  '[ ! -e "$WORK/pb/nightly/engram-$(ts_of $((NOW - MAX))).dump.gpg" ] && [ -e "$WORK/pb/nightly/engram-$(ts_of $((NOW - MAX + 60))).dump.gpg" ]'
check "p old name with fresh mtime deleted; legacy pre-p05 dump deleted; symlinks + targets kept (PowerShell)" \
  '[ ! -e "$WORK/pb/nightly/engram-$(ts_of $((NOW - 30 * D))).dump.gpg" ] && [ ! -e "$WORK/pb/engram-pre-p05-$(ts_of $((NOW - 30 * D))).dump" ] && [ -L "$WORK/pb/engram-pre-p04-$(ts_of $((NOW - 30 * D))).dump" ] && [ -e "$WORK/outside-$(ts_of $((NOW - 30 * D))).dump.gpg" ]'
mkdir -p "$WORK/pc"
mk "$WORK/pc/nightly/engram-$(ts_of $((NOW - H))).dump.gpg"
ps_sweep "$WORK/pc" "$NOW"
check "p clean tree -> exit 0, ok:true marker with ts" \
  '[ "$PS_RC" -eq 0 ] && grep -q "\"ok\":true" "$WORK/pc/expire/last-sweep.json" && grep -q "\"ts\":\"20" "$WORK/pc/expire/last-sweep.json"'

# t. Task Scheduler definition.
check "t task XML: hourly, StartWhenAvailable, logon trigger, IgnoreNew, runs the sweep script" "python3 - '$TASK_XML' <<'EOF'
import sys, xml.etree.ElementTree as ET
ns = {'t': 'http://schemas.microsoft.com/windows/2004/02/mit/task'}
r = ET.parse(sys.argv[1]).getroot()
g = lambda p: (r.find(p, ns).text or '').strip()
assert g('t:Triggers/t:TimeTrigger/t:Repetition/t:Interval') == 'PT1H'
assert g('t:Triggers/t:TimeTrigger/t:Enabled') == 'true'
assert r.find('t:Triggers/t:LogonTrigger', ns) is not None
assert g('t:Settings/t:StartWhenAvailable') == 'true'
assert g('t:Settings/t:MultipleInstancesPolicy') == 'IgnoreNew'
assert g('t:Settings/t:Enabled') == 'true'
assert 'engram-offhost-expire.ps1' not in g('t:Actions/t:Exec/t:Command')
assert '-File \"__SCRIPT__\" -Root \"__ROOT__\"' in g('t:Actions/t:Exec/t:Arguments')
EOF"

# s. 30-day simulation: bro + daily pull + independent hourly PC sweep.
BRO="$WORK/sim-bro"
PC="$WORK/sim-pc"
mkdir -p "$BRO"/{nightly,pitr/base,pitr/wal} "$PC"
declare -A EP
mkt() { local s; s="$(ts_of "$2")"; EP[$s]=$2; mk "$1$s$3"; }
T0=$((NOW - NOW % D))
seq=1
nextwal=$T0
max_pc=0
max_after_pull=0
violations=0
for ((h = 0; h < 30 * 24; h++)); do
  t=$((T0 + h * H))
  while [ "$nextwal" -le "$t" ]; do
    mkt "$BRO/pitr/wal/" "$nextwal" "--$(printf '%024X' "$seq").gz.gpg"
    seq=$((seq + 1))
    nextwal=$((nextwal + 1800))
  done
  hod=$(((t % D) / H))
  day=$((h / 24))
  if [ "$hod" -eq 21 ]; then
    mkt "$BRO/nightly/engram-" $((t - 43 * 60)) ".dump.gpg"
    mkt "$BRO/pitr/base/engram-base-" $((t - 15 * 60)) ".tar.gz.gpg"
  fi
  bash_sweep "$BRO" "$t"
  # Daily pull 12:00Z (owner PC on), failing on days 4, 5, 13: copy names as-is with a fresh mtime.
  if [ "$hod" -eq 12 ] && [ "$day" -ne 4 ] && [ "$day" -ne 5 ] && [ "$day" -ne 13 ]; then
    (cd "$BRO" && find nightly pitr -type f -name '*.gpg' -print0) | while IFS= read -r -d '' rel; do
      [ -e "$PC/$rel" ] || { mkdir -p "$PC/$(dirname "$rel")"; cp "$BRO/$rel" "$PC/$rel"; touch -d "@$t" "$PC/$rel"; }
    done
    while IFS= read -r -d '' f; do
      [[ "${f##*/}" =~ [0-9]{8}T[0-9]{6}Z ]] || continue
      a=$((t - EP[${BASH_REMATCH[0]}]))
      [ "$a" -gt "$max_after_pull" ] && max_after_pull=$a
    done < <(find "$PC" -type f -name '*.gpg' -print0)
  fi
  # Oldest PC copy right before the PC sweep (worst point).
  while IFS= read -r -d '' f; do
    [[ "${f##*/}" =~ [0-9]{8}T[0-9]{6}Z ]] || continue
    a=$((t - EP[${BASH_REMATCH[0]}]))
    [ "$a" -gt "$max_pc" ] && max_pc=$a
    [ "$a" -ge $((8 * D)) ] && violations=$((violations + 1))
  done < <(find "$PC" -type f -name '*.gpg' -print0)
  if [ "$h" -eq 250 ] || [ "$h" -eq 500 ]; then
    continue # missed hourly PC sweep (PC asleep); StartWhenAvailable runs the next one
  fi
  ps_sweep "$PC" "$t"
  if [ "$PS_RC" -ne 0 ]; then
    violations=$((violations + 1))
    cat "$WORK/ps.out"
  fi
done
printf 's simulated 720 hourly ticks: oldest PC copy before a sweep %ss, right after a pull %ss (8d = %ss)\n' \
  "$max_pc" "$max_after_pull" $((8 * D))
check "s no off-host copy ever reaches 8d (daily pulls, failed pulls, 2 missed hourly sweeps)" \
  '[ "$violations" -eq 0 ] && [ "$max_pc" -lt $((8 * D)) ] && [ "$max_after_pull" -lt $((8 * D)) ]'
check "s PC sweep marker fresh and ok at the end" 'grep -q "\"ok\":true" "$PC/expire/last-sweep.json"'
finish
