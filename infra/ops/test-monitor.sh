#!/usr/bin/env bash
# Test harness for infra/ops/engram-monitor.sh (P06 Task 4, C09, C20, review r1).
# Runs a localhost HTTP server that (a) records webhook POST bodies and (b)
# serves /ok/api/v1/metrics (healthy body) and /err/api/v1/metrics (404 JSON).
# Every failure scenario must DELIVER a webhook body containing the expected
# finding; the clean scenario must deliver nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR="$SCRIPT_DIR/engram-monitor.sh"

WORK="$(mktemp -d)"
SRV_PID=""
cleanup() {
  if [ -n "$SRV_PID" ]; then kill "$SRV_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

WEBHOOK_LOG="$WORK/webhook-bodies.jsonl"
PORT_FILE="$WORK/server.port"
: >"$WEBHOOK_LOG"

node -e '
const http = require("http");
const fs = require("fs");
const okMetrics = "export_cleanup_pending_age_seconds 10\nengram_http_request_duration_seconds_count{method=\"GET\",route=\"/api/v1/healthz\",status=\"200\"} 4\n";
const srv = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/ok/api/v1/metrics") {
    res.writeHead(200, {"Content-Type": "text/plain"}); res.end(okMetrics); return;
  }
  if (req.method === "GET" && req.url === "/err/api/v1/metrics") {
    res.writeHead(404, {"Content-Type": "application/problem+json"});
    res.end("{\"status\":404,\"code\":\"not_found\"}"); return;
  }
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    fs.appendFileSync(process.argv[1], body.replace(/\n/g, " ") + "\n");
    res.writeHead(200); res.end("ok");
  });
});
srv.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[2], String(srv.address().port)));
' "$WEBHOOK_LOG" "$PORT_FILE" &
SRV_PID=$!

for _ in $(seq 1 50); do [ -s "$PORT_FILE" ] && break; sleep 0.1; done
PORT="$(cat "$PORT_FILE")"
SRV="http://127.0.0.1:$PORT"

# Stub binaries: gpg/psql no-op; docker answers inspect/logs from env.
FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
for cmd in gpg psql; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKE_BIN/$cmd"
  chmod +x "$FAKE_BIN/$cmd"
done
cat >"$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  inspect)
    for a in "$@"; do last="$a"; done
    var="FAKE_INSPECT_${last//-/_}"
    echo "${!var:-${FAKE_INSPECT_DEFAULT:-running:healthy}}"
    ;;
  logs)
    if [ "${FAKE_DOCKER_LOGS_FAIL:-0}" = "1" ]; then
      echo "Error response from daemon: No such container: global_nginx" >&2
      exit 1
    fi
    [ -n "${FAKE_DOCKER_LOGS_FILE:-}" ] && cat "$FAKE_DOCKER_LOGS_FILE"
    ;;
  run)
    # Isolated WAL listing (MONITOR_WAL_IMAGE): list the container's view of the archive (FAKE_WAL_VIEW,
    # standing in for the 999:999 0700 dir the host user cannot read).
    printf '%s\n' "$*" >>"${FAKE_DOCKER_RUN_LOG:-/dev/null}"
    [ "${FAKE_DOCKER_RUN_FAIL:-0}" = "1" ] && { echo "docker: run failed" >&2; exit 125; }
    find "${FAKE_WAL_VIEW:?}" -type f -name '*.gpg' -print0
    ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_BIN/docker"
# curl recorder: logs every argv (R1-06: the webhook URL must never be in it), then runs the real curl.
REAL_CURL="$(command -v curl)"
cat >"$FAKE_BIN/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$WORK/curl-argv.log"
exec "$REAL_CURL" "\$@"
EOF
chmod +x "$FAKE_BIN/curl"
: >"$WORK/curl-argv.log"
BASE_PATH="$FAKE_BIN:$PATH"

NOW=1794052800 # 2026-11-07T12:00:00Z
ts_fmt() { date -u -d "@$1" +%Y%m%dT%H%M%SZ; }

make_clean_fixture() {
  local dir="$1" fresh_ts
  rm -rf "$dir"
  mkdir -p "$dir/state" "$dir/backups"/{nightly,pitr/base,pitr/wal,expire,offhost}
  fresh_ts="$(ts_fmt $((NOW - 3600)))"
  for m in nightly/last.json pitr/last-base.json expire/last-sweep.json offhost/last-pull.json; do
    printf '{"ts":"%s","ok":true}\n' "$fresh_ts" >"$dir/backups/$m"
  done
  : >"$dir/backups/nightly/engram-${fresh_ts}.dump.gpg"
  : >"$dir/backups/pitr/base/engram-base-${fresh_ts}.tar.gz.gpg"
  : >"$dir/backups/pitr/wal/${fresh_ts}--000000010000000000000001.gz.gpg"
  printf 'prev_archiver_failed=3\nprev_http_5xx=0\n' >"$dir/state/prev.env"
  : >"$dir/nginx.log"
}

LAST_RC=0
run_case() {
  local dir="$1"
  shift
  : >"$WEBHOOK_LOG"
  LAST_RC=0
  env \
    PATH="$BASE_PATH" \
    MONITOR_NOW_EPOCH="$NOW" \
    MONITOR_STATE_DIR="$dir/state" \
    MONITOR_BACKUP_ROOT="$dir/backups" \
    MONITOR_API_BASE_URL="$SRV/ok" \
    MONITOR_SKIP_HTTP=1 \
    MONITOR_FAKE_DISK_PCT=40 \
    MONITOR_FAKE_TLS_ENDDATE="Jan 29 00:00:00 2027 GMT" \
    FAKE_DOCKER_LOGS_FILE="$dir/nginx.log" \
    MONITOR_FAKE_ARCHIVER_ROW="3|$((NOW - 120))|0" \
    ALERT_WEBHOOK_URL="$SRV/hook" \
    "$@" \
    bash "$MONITOR" || LAST_RC=$?
}

fail() { echo "FAIL [$1]: $2" >&2; exit 1; }

assert_alert_contains() {
  local name="$1" needle="$2"
  [ "$LAST_RC" -eq 0 ] || fail "$name" "monitor exit $LAST_RC"
  [ -s "$WEBHOOK_LOG" ] || fail "$name" "webhook received NO alert (expected '$needle')"
  grep -Fq "$needle" "$WEBHOOK_LOG" || fail "$name" "body lacks '$needle'; got: $(cat "$WEBHOOK_LOG")"
  echo "PASS [$name]: alert delivered ($needle)"
}

assert_no_alert() {
  local name="$1" dir="$2"
  [ "$LAST_RC" -eq 0 ] || fail "$name" "monitor exit $LAST_RC"
  [ ! -s "$WEBHOOK_LOG" ] || fail "$name" "unexpected alert: $(cat "$WEBHOOK_LOG")"
  grep -Fq '"status":"ok"' "$dir/state/status.json" || fail "$name" "status not ok: $(cat "$dir/state/status.json")"
  echo "PASS [$name]: no alert, status=ok"
}

# 0. Clean: real HTTP scrape of healthy metrics, all four containers healthy.
make_clean_fixture "$WORK/clean"
run_case "$WORK/clean"
assert_no_alert "clean" "$WORK/clean"

# 1. Retention bound: old source ts (7d23h30m) beside a fresh file, fresh mtime.
make_clean_fixture "$WORK/c1"
old_src="$(ts_fmt $((NOW - (7*86400 + 23*3600 + 1800))))"
touch "$WORK/c1/backups/pitr/wal/${old_src}--000000010000000000000000.gz.gpg"
run_case "$WORK/c1"
assert_alert_contains "retention_oldest_source_7d23h30m" "retention: oldest source backup"

# 2. Sweep stale 2h.
make_clean_fixture "$WORK/c2"
printf '{"ts":"%s","ok":true}\n' "$(ts_fmt $((NOW - 7200)))" >"$WORK/c2/backups/expire/last-sweep.json"
run_case "$WORK/c2"
assert_alert_contains "sweep_stale_2h" "retention_sweep: stale"

# 3. Off-host pull stale 30h.
make_clean_fixture "$WORK/c3"
printf '{"ts":"%s","ok":true}\n' "$(ts_fmt $((NOW - 108000)))" >"$WORK/c3/backups/offhost/last-pull.json"
run_case "$WORK/c3"
assert_alert_contains "offhost_pull_stale_30h" "offhost_pull: stale"

# 4. Archiver stall (20 min).
make_clean_fixture "$WORK/c4"
run_case "$WORK/c4" MONITOR_FAKE_ARCHIVER_ROW="3|$((NOW - 1200))|0"
assert_alert_contains "archiver_stall" "wal: last_archived_time lag"

# 5. .ready backlog 17.
make_clean_fixture "$WORK/c5"
run_case "$WORK/c5" MONITOR_FAKE_ARCHIVER_ROW="3|$((NOW - 60))|17"
assert_alert_contains "wal_backlog_17" "wal: archive_status .ready backlog 17"

# 6. failed_count 3 -> 4.
make_clean_fixture "$WORK/c6"
run_case "$WORK/c6" MONITOR_FAKE_ARCHIVER_ROW="4|$((NOW - 60))|0"
assert_alert_contains "archiver_failed_count_up" "wal: pg_stat_archiver.failed_count increased (3 -> 4)"

# 7. R1-10 dependency preflight: a PATH with exactly the documented host tools (no host psql, no gpg) is clean;
#    dropping a required tool (openssl) is a deps CRIT.
make_clean_fixture "$WORK/c7"
MIN_BIN="$WORK/min-bin"
mkdir -p "$MIN_BIN"
for cmd in bash env docker curl python3 openssl timeout awk sha256sum date sed grep tr find sort head tail wc stat cat mv rm mkdir mktemp basename dirname cut df od; do
  real="$(PATH="$BASE_PATH" command -v "$cmd" || true)"
  if [ -n "$real" ]; then ln -sf "$real" "$MIN_BIN/$cmd"; fi
done
run_case "$WORK/c7" PATH="$MIN_BIN"
assert_no_alert "deps_minimal_path_no_psql_no_gpg" "$WORK/c7"
make_clean_fixture "$WORK/c7b"
rm -f "$MIN_BIN/openssl"
run_case "$WORK/c7b" PATH="$MIN_BIN"
assert_alert_contains "deps_missing_openssl" "deps: required command 'openssl' not found"

# 8. Disk 95%.
make_clean_fixture "$WORK/c8"
run_case "$WORK/c8" MONITOR_FAKE_DISK_PCT=95
assert_alert_contains "disk_crit" "disk: / at 95%"

# 9. Cleanup age > 3600 + API 5xx delta (file-fed metrics).
make_clean_fixture "$WORK/c9"
printf '%s\n' 'export_cleanup_pending_age_seconds 3900' \
  'engram_http_request_duration_seconds_count{method="GET",route="/api/v1/exports/{id}",status="500"} 9' >"$WORK/c9/metrics.txt"
run_case "$WORK/c9" MONITOR_METRICS_FILE="$WORK/c9/metrics.txt"
assert_alert_contains "export_cleanup_age" "export_cleanup: pending age 3900s"
assert_alert_contains "export_5xx_delta" "http_5xx: +9 5xx responses"

# 10. Edge 502 on the export request URI (via docker logs path).
make_clean_fixture "$WORK/c10"
printf '%s\n' '203.0.113.5 - [07/Nov/2026:12:00:00 +0000] "GET /api/v1/exports/{id}/download" 502 150 0.010 "Mozilla/5.0"' >"$WORK/c10/nginx.log"
run_case "$WORK/c10"
assert_alert_contains "edge_exports_502" "edge_exports_5xx: 1 5xx responses on /api/v1/exports/*"

# 11. R1-03: cleanup gauge missing.
make_clean_fixture "$WORK/c11"
printf 'up 1\n' >"$WORK/c11/metrics.txt"
run_case "$WORK/c11" MONITOR_METRICS_FILE="$WORK/c11/metrics.txt"
assert_alert_contains "cleanup_gauge_missing" "telemetry: export_cleanup_pending_age_seconds missing"

# 12. R1-03: non-finite gauge.
make_clean_fixture "$WORK/c12"
printf 'export_cleanup_pending_age_seconds NaN\n' >"$WORK/c12/metrics.txt"
run_case "$WORK/c12" MONITOR_METRICS_FILE="$WORK/c12/metrics.txt"
assert_alert_contains "cleanup_gauge_nan" "telemetry: export_cleanup_pending_age_seconds invalid value 'NaN'"

# 13. R1-03: scrape returns HTTP 404 problem body.
make_clean_fixture "$WORK/c13"
run_case "$WORK/c13" MONITOR_API_BASE_URL="$SRV/err"
assert_alert_contains "metrics_http_404" "telemetry: /api/v1/metrics scrape failed"

# 14. R1-04: retention traversal fails (permission denied) -> CRIT.
make_clean_fixture "$WORK/c14"
FIND_BIN="$WORK/find-bin"
mkdir -p "$FIND_BIN"
printf '#!/usr/bin/env bash\necho "find: %s: Permission denied" >&2\nexit 1\n' "'/x/pitr/wal'" >"$FIND_BIN/find"
chmod +x "$FIND_BIN/find"
run_case "$WORK/c14" PATH="$FIND_BIN:$BASE_PATH"
assert_alert_contains "retention_scan_failed" "retention: backup tree scan incomplete (find exit 1)"

# 15. R1-06: container without healthcheck.
make_clean_fixture "$WORK/c15"
run_case "$WORK/c15" FAKE_INSPECT_engram_worker_1="running:none"
assert_alert_contains "container_no_healthcheck" "container: engram-worker-1 has no healthcheck"

# 16. R1-06: unhealthy container.
make_clean_fixture "$WORK/c16"
run_case "$WORK/c16" FAKE_INSPECT_engram_web_1="running:unhealthy"
assert_alert_contains "container_unhealthy" "container: engram-web-1 state=running:unhealthy"

# 17. R1-07: future sweep marker (+30 days).
make_clean_fixture "$WORK/c17"
printf '{"ts":"%s","ok":true}\n' "$(ts_fmt $((NOW + 30*86400)))" >"$WORK/c17/backups/expire/last-sweep.json"
run_case "$WORK/c17"
assert_alert_contains "marker_future" "retention_sweep: marker ts"

# 18. R1-07: top-level ok:false with nested ok:true.
make_clean_fixture "$WORK/c18"
printf '{"ts":"%s","ok":false,"previous":{"ok":true}}\n' "$(ts_fmt $((NOW - 60)))" >"$WORK/c18/backups/nightly/last.json"
run_case "$WORK/c18"
assert_alert_contains "marker_nested_ok" "backup_nightly: marker"

# 19. R1-08: edge log acquisition failure.
make_clean_fixture "$WORK/c19"
run_case "$WORK/c19" FAKE_DOCKER_LOGS_FAIL=1
assert_alert_contains "edge_log_unreadable" "telemetry: cannot read edge access log"

# 20. LOW: export-looking User-Agent on a non-export route -> no edge alert.
make_clean_fixture "$WORK/c20"
printf '%s\n' '203.0.113.5 - [07/Nov/2026:12:00:00 +0000] "GET /app" 502 150 0.010 "bot /api/v1/exports/x"' >"$WORK/c20/nginx.log"
run_case "$WORK/c20"
grep -Fq "edge_exports_5xx" "$WEBHOOK_LOG" && fail "edge_ua_false_positive" "UA text classified as export traffic"
echo "PASS [edge_ua_false_positive]: non-export route not counted"

# 21. R1-05: unwritable state dir -> non-zero exit (persistence failure).
make_clean_fixture "$WORK/c21"
chmod 0500 "$WORK/c21/state"
run_case "$WORK/c21"
chmod 0700 "$WORK/c21/state"
if [ "$(id -u)" -ne 0 ]; then
  [ "$LAST_RC" -ne 0 ] || fail "state_unwritable" "monitor exited 0 despite unwritable state"
  echo "PASS [state_unwritable]: exit $LAST_RC"
else
  echo "SKIP [state_unwritable]: running as root (permissions not enforced)"
fi

# 22. R1-06: webhook URL (bearer secret) never in any process argv or the alert log, regular + TEST_ALERT delivery.
CANARY="CANARY$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
make_clean_fixture "$WORK/c22"
printf '{"ts":"%s","ok":true}\n' "$(ts_fmt $((NOW - 7200)))" >"$WORK/c22/backups/expire/last-sweep.json"
: >"$WORK/curl-argv.log"
run_case "$WORK/c22" ALERT_WEBHOOK_URL="$SRV/hook?token=$CANARY"
assert_alert_contains "webhook_canary_regular" "retention_sweep: stale"
grep -q "$CANARY" "$WORK/curl-argv.log" && fail "webhook_canary_argv" "webhook URL found in curl argv"
grep -q -- "-K -" "$WORK/curl-argv.log" || fail "webhook_canary_argv" "curl did not read its config from stdin"
grep -rq "$CANARY" "$WORK/c22/state" && fail "webhook_canary_state" "webhook URL persisted in monitor state/logs"
echo "PASS [webhook_canary_argv]: delivered, URL absent from argv and state"
make_clean_fixture "$WORK/c22b"
: >"$WORK/curl-argv.log"
run_case "$WORK/c22b" ALERT_WEBHOOK_URL="$SRV/hook?token=$CANARY" TEST_ALERT=1
assert_alert_contains "webhook_canary_test_alert" "test_alert: synthetic alert probe"
grep -q "$CANARY" "$WORK/curl-argv.log" && fail "webhook_canary_test_alert_argv" "webhook URL found in curl argv"
echo "PASS [webhook_canary_test_alert_argv]: URL absent from argv"

# 23. Cross-lane 1 (dec-P06-059): WAL dir 999:999 0700 is listed through an isolated docker run, never by the host.
wal_fixture() { # wal_fixture <dir>: host WAL dir unreadable, container view holds the real names
  make_clean_fixture "$1"
  mkdir -p "$1/walview"
  mv "$1/backups/pitr/wal/"* "$1/walview/"
  chmod 000 "$1/backups/pitr/wal"
}
if [ "$(id -u)" -ne 0 ]; then
  wal_fixture "$WORK/c23"
  run_case "$WORK/c23" MONITOR_WAL_IMAGE=pg-pin FAKE_WAL_VIEW="$WORK/c23/walview" FAKE_DOCKER_RUN_LOG="$WORK/c23/run.log"
  chmod 700 "$WORK/c23/backups/pitr/wal"
  assert_no_alert "wal_isolated_clean" "$WORK/c23"
  grep -q -- "--network none --user 999:999 --entrypoint find -v $WORK/c23/backups/pitr/wal:/wal-archive:ro pg-pin /wal-archive" "$WORK/c23/run.log" \
    || fail "wal_isolated_argv" "unexpected docker run: $(cat "$WORK/c23/run.log")"
  echo "PASS [wal_isolated_argv]: read-only, no network, uid 999"

  wal_fixture "$WORK/c24"
  : >"$WORK/c24/walview/$(ts_fmt $((NOW - 7 * 86400 - 23 * 3600 - 1800)))--000000010000000000000009.gz.gpg"
  run_case "$WORK/c24" MONITOR_WAL_IMAGE=pg-pin FAKE_WAL_VIEW="$WORK/c24/walview"
  chmod 700 "$WORK/c24/backups/pitr/wal"
  assert_alert_contains "wal_isolated_old_source" "retention: oldest source backup"

  wal_fixture "$WORK/c25"
  run_case "$WORK/c25" MONITOR_WAL_IMAGE=pg-pin FAKE_WAL_VIEW="$WORK/c25/walview" FAKE_DOCKER_RUN_FAIL=1
  chmod 700 "$WORK/c25/backups/pitr/wal"
  assert_alert_contains "wal_isolated_run_fails" "retention: backup tree scan incomplete"

  wal_fixture "$WORK/c26"
  run_case "$WORK/c26"
  chmod 700 "$WORK/c26/backups/pitr/wal"
  assert_alert_contains "wal_no_image_unreadable" "retention: backup tree scan incomplete"
else
  echo "SKIP [wal_isolated_*]: running as root (0700 not enforced)"
fi

echo "OPSOBS_MONITOR_EXIT=0"
