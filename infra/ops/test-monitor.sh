#!/usr/bin/env bash
# Test harness for infra/ops/engram-monitor.sh (P06 Task 4, C09, C20).
# Starts a local HTTP webhook recorder, constructs isolated backup/state
# fixtures per scenario, and asserts that every failure condition POSTs a
# matching alert body while the clean baseline sends nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR="$SCRIPT_DIR/engram-monitor.sh"

WORK="$(mktemp -d)"
WH_PID=""
cleanup() {
  if [ -n "$WH_PID" ]; then kill "$WH_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

WEBHOOK_LOG="$WORK/webhook-bodies.jsonl"
PORT_FILE="$WORK/webhook.port"
: >"$WEBHOOK_LOG"

node -e '
const http = require("http");
const fs = require("fs");
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    fs.appendFileSync(process.argv[1], body.replace(/\n/g, " ") + "\n");
    res.writeHead(200);
    res.end("ok");
  });
});
srv.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(process.argv[2], String(srv.address().port));
});
' "$WEBHOOK_LOG" "$PORT_FILE" &
WH_PID=$!

for _ in $(seq 1 50); do [ -s "$PORT_FILE" ] && break; sleep 0.1; done
PORT="$(cat "$PORT_FILE")"
WEBHOOK_URL="http://127.0.0.1:$PORT/hook"

# Fake dependency binaries so the test does not depend on host docker/psql/gpg.
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
for cmd in gpg docker psql; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKE_BIN/$cmd"
  chmod +x "$FAKE_BIN/$cmd"
done
# Keep real curl + coreutils behind FAKE_BIN.
BASE_PATH="$FAKE_BIN:$PATH"

NOW=1794052800 # 2026-11-07T12:00:00Z
ts_fmt() { date -u -d "@$1" +%Y%m%dT%H%M%SZ; }

# Prepare a clean fixture in $1.
make_clean_fixture() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir/state" "$dir/backups"/{nightly,pitr/base,pitr/wal,expire,offhost}
  local fresh_ts
  fresh_ts="$(ts_fmt $((NOW - 3600)))"
  printf '{"ts":"%s","ok":true}\n' "$fresh_ts" >"$dir/backups/nightly/last.json"
  printf '{"ts":"%s","ok":true}\n' "$fresh_ts" >"$dir/backups/pitr/last-base.json"
  printf '{"ts":"%s","ok":true}\n' "$fresh_ts" >"$dir/backups/expire/last-sweep.json"
  printf '{"ts":"%s","ok":true}\n' "$fresh_ts" >"$dir/backups/offhost/last-pull.json"
  : >"$dir/backups/nightly/engram-${fresh_ts}.dump.gpg"
  : >"$dir/backups/pitr/base/engram-base-${fresh_ts}.tar.gz.gpg"
  : >"$dir/backups/pitr/wal/${fresh_ts}--000000010000000000000001.gz.gpg"
  cat >"$dir/metrics.txt" <<'EOF'
export_cleanup_pending_age_seconds 10
engram_http_request_duration_seconds_count{method="GET",route="/api/v1/exports/{id}",status="500"} 0
EOF
  cat >"$dir/state/prev.env" <<'EOF'
prev_archiver_failed=3
prev_http_5xx=0
EOF
}

run_case() {
  local dir="$1"
  shift
  : >"$WEBHOOK_LOG"
  env \
    PATH="$BASE_PATH" \
    MONITOR_NOW_EPOCH="$NOW" \
    MONITOR_STATE_DIR="$dir/state" \
    MONITOR_BACKUP_ROOT="$dir/backups" \
    MONITOR_SKIP_CONTAINERS=1 \
    MONITOR_SKIP_HTTP=1 \
    MONITOR_FAKE_DISK_PCT=40 \
    MONITOR_FAKE_TLS_ENDDATE="Jan 29 00:00:00 2027 GMT" \
    MONITOR_METRICS_FILE="$dir/metrics.txt" \
    MONITOR_FAKE_ARCHIVER_ROW="3|$((NOW - 120))|0" \
    ALERT_WEBHOOK_URL="$WEBHOOK_URL" \
    "$@" \
    bash "$MONITOR"
}

assert_alert_contains() {
  local name="$1" needle="$2"
  if [ ! -s "$WEBHOOK_LOG" ]; then
    echo "FAIL [$name]: webhook received NO alert (expected '$needle')" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$WEBHOOK_LOG"; then
    echo "FAIL [$name]: webhook body did not contain '$needle'; got:" >&2
    cat "$WEBHOOK_LOG" >&2
    exit 1
  fi
  echo "PASS [$name]: alert delivered ($needle)"
}

# 0. Clean scenario: zero alerts delivered, status=ok.
make_clean_fixture "$WORK/clean"
run_case "$WORK/clean"
if [ -s "$WEBHOOK_LOG" ]; then
  echo "FAIL [clean]: unexpected alert sent: $(cat "$WEBHOOK_LOG")" >&2
  exit 1
fi
grep -Fq '"status":"ok"' "$WORK/clean/state/status.json"
echo "PASS [clean]: no alert sent, status=ok"

# 1. Retention bound (C09/C20): fresh file + 7d23h30m source-ts file in the SAME
# folder (with mtime=now so an mtime check would be fooled) -> CRIT.
make_clean_fixture "$WORK/c1"
old_src="$(ts_fmt $((NOW - (7*86400 + 23*3600 + 1800))))"
stale_file="$WORK/c1/backups/pitr/wal/${old_src}--000000010000000000000000.gz.gpg"
: >"$stale_file"
touch "$stale_file"
run_case "$WORK/c1"
assert_alert_contains "retention_oldest_source_7d23h30m" "retention: oldest source backup"

# 2. Retention sweep stale (2h > 75m).
make_clean_fixture "$WORK/c2"
printf '{"ts":"%s","ok":true}\n' "$(ts_fmt $((NOW - 7200)))" >"$WORK/c2/backups/expire/last-sweep.json"
run_case "$WORK/c2"
assert_alert_contains "sweep_stale_2h" "retention_sweep: stale"

# 3. Off-host pull stale (30h > 26h).
make_clean_fixture "$WORK/c3"
printf '{"ts":"%s","ok":true}\n' "$(ts_fmt $((NOW - 108000)))" >"$WORK/c3/backups/offhost/last-pull.json"
run_case "$WORK/c3"
assert_alert_contains "offhost_pull_stale_30h" "offhost_pull: stale"

# 4. WAL archiver stall (last_archived_time 20m old > 15m, even with failed_count unchanged).
make_clean_fixture "$WORK/c4"
run_case "$WORK/c4" MONITOR_FAKE_ARCHIVER_ROW="3|$((NOW - 1200))|0"
assert_alert_contains "archiver_stall" "wal: last_archived_time lag"

# 5. WAL archive_status .ready backlog = 17 (> 16).
make_clean_fixture "$WORK/c5"
run_case "$WORK/c5" MONITOR_FAKE_ARCHIVER_ROW="3|$((NOW - 60))|17"
assert_alert_contains "wal_backlog_17" "wal: archive_status .ready backlog 17"

# 6. pg_stat_archiver.failed_count increased (3 -> 4).
make_clean_fixture "$WORK/c6"
run_case "$WORK/c6" MONITOR_FAKE_ARCHIVER_ROW="4|$((NOW - 60))|0"
assert_alert_contains "archiver_failed_count_up" "wal: pg_stat_archiver.failed_count increased (3 -> 4)"

# 7. Missing gpg in PATH -> CRIT.
make_clean_fixture "$WORK/c7"
NO_GPG_BIN="$WORK/nogpg-bin"
mkdir -p "$NO_GPG_BIN"
for cmd in bash docker psql curl date awk sed grep tr find sort head tail wc sha256sum stat cat mv rm mkdir basename dirname cut; do
  real="$(PATH="$BASE_PATH" command -v "$cmd" || true)"
  [ -n "$real" ] && ln -sf "$real" "$NO_GPG_BIN/$cmd"
done
run_case "$WORK/c7" PATH="$NO_GPG_BIN"
assert_alert_contains "missing_gpg_in_path" "deps: required command 'gpg' not found"

# 8. Low disk (>92% -> CRIT).
make_clean_fixture "$WORK/c8"
run_case "$WORK/c8" MONITOR_FAKE_DISK_PCT=95
assert_alert_contains "disk_crit" "disk: / at 95%"

# 9. Export cleanup pending age > 3600s and export 5xx spike -> CRIT.
make_clean_fixture "$WORK/c9"
cat >"$WORK/c9/metrics.txt" <<'EOF'
export_cleanup_pending_age_seconds 3900
engram_http_request_duration_seconds_count{method="GET",route="/api/v1/exports/{id}/download",status="500"} 9
EOF
run_case "$WORK/c9"
assert_alert_contains "export_cleanup_and_5xx" "export_cleanup: pending age 3900s"
assert_alert_contains "export_5xx_delta" "http_5xx: +9 5xx responses"

# 10. Edge nginx access-log 502 on /api/v1/exports/{id} (advisor-dec-P06-024 D).
make_clean_fixture "$WORK/c10"
printf '203.0.113.5 - [07/Nov/2026:12:00:00 +0000] "GET /api/v1/exports/{id}/download" 502 150 0.010 "Mozilla/5.0"\n' >"$WORK/c10/nginx.log"
run_case "$WORK/c10" MONITOR_NGINX_LOG_FILE="$WORK/c10/nginx.log"
assert_alert_contains "edge_exports_502" "edge_exports_5xx: 1 5xx responses on /api/v1/exports/*"

echo "OPSOBS_MONITOR_EXIT=0"
