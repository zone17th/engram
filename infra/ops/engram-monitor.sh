#!/usr/bin/env bash
# engram production monitor & alerting (P06 Task 4, C09, C20).
# Runs every 5 minutes via systemd user timer engram-monitor.timer.
# Checks (never modifies production state):
#   1. Required commands in PATH: gpg, docker, psql, curl (CRIT if missing)
#   2. Container health: engram-db-1, engram-api-1, engram-worker-1, engram-web-1
#   3. /api/v1/healthz and /api/v1/readyz HTTP 200 within 2 s
#   4. Root filesystem (or MONITOR_DISK_PATH): >88% WARN, >92% CRIT
#   5. Edge TLS certificate remaining validity: <21d WARN, <7d CRIT
#   6. HTTP 5xx delta on engram_http_request_duration_seconds_count{status=~"5.."}
#      (covers export 5xx per advisor-dec-P06-024 D) and
#      export_cleanup_pending_age_seconds > 3600 -> CRIT
#   7. WAL archiver: pg_stat_archiver.failed_count increased -> CRIT,
#      now - last_archived_time > 900s (or null while archiving) -> CRIT,
#      pg_wal/archive_status/*.ready > 16 -> CRIT
#   8. Nightly & base backup markers: nightly/last.json and pitr/last-base.json
#      must have ok:true and ts age <= 26h -> CRIT
#   9. Retention 8-day bound (C09): OLDEST source timestamp encoded in ANY
#      backup filename under BACKUP_ROOT/** > 7d23h (687600s) -> CRIT even when
#      newer files exist in the same folder; expire/last-sweep.json ok:true age
#      > 75m (4500s) -> CRIT
#  10. Off-host pull marker: offhost/last-pull.json ok:true age > 26h -> CRIT
#
# Writes state/status.json + alerts.log, deduplicates identical alert sets within
# DEDUP_SECONDS, and POSTs JSON to ALERT_WEBHOOK_URL when findings exist (or when
# TEST_ALERT=1).
set -uo pipefail
umask 077

STATE_DIR="${MONITOR_STATE_DIR:-/home/ubuntu/engram-ops/monitor}"
BACKUP_ROOT="${MONITOR_BACKUP_ROOT:-/home/ubuntu/backups/engram}"
ALERT_LOG="${MONITOR_ALERT_LOG:-$STATE_DIR/alerts.log}"
STATUS_JSON="${MONITOR_STATUS_JSON:-$STATE_DIR/status.json}"
PREV_STATE="${MONITOR_PREV_STATE:-$STATE_DIR/prev.env}"
DEDUP_FILE="${MONITOR_DEDUP_FILE:-$STATE_DIR/last-alert.sig}"
DEDUP_SECONDS="${MONITOR_DEDUP_SECONDS:-1800}"
NOW_EPOCH="${MONITOR_NOW_EPOCH:-$(date -u +%s)}"
NOW_ISO="$(date -u -d "@$NOW_EPOCH" +%Y-%m-%dT%H:%M:%SZ)"

CONTAINERS="${MONITOR_CONTAINERS:-engram-db-1 engram-api-1 engram-worker-1 engram-web-1}"
DB_CONTAINER="${MONITOR_DB_CONTAINER:-engram-db-1}"
API_CONTAINER="${MONITOR_API_CONTAINER:-engram-api-1}"
DB_USER="${MONITOR_DB_USER:-engram}"
DB_NAME="${MONITOR_DB_NAME:-engram}"
API_BASE_URL="${MONITOR_API_BASE_URL:-}"
TLS_HOST="${MONITOR_TLS_HOST:-engram.zone17.click}"
TLS_PORT="${MONITOR_TLS_PORT:-443}"
NGINX_CONTAINER="${MONITOR_NGINX_CONTAINER:-global_nginx}"
DISK_PATH="${MONITOR_DISK_PATH:-/}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"

MAX_BACKUP_AGE=93600          # 26h
MAX_OFFHOST_AGE=93600         # 26h
MAX_SWEEP_AGE=4500            # 75m
MAX_RETENTION_SOURCE_AGE=687600 # 7d23h = 191h
MAX_WAL_LAG=900               # 15m
MAX_WAL_READY=16
MAX_CLEANUP_AGE=3600
MAX_5XX_DELTA="${MONITOR_MAX_5XX_DELTA:-5}"

mkdir -p "$STATE_DIR"

declare -a CRITS=()
declare -a WARNS=()
add_crit() { CRITS+=("$1"); }
add_warn() { WARNS+=("$1"); }

# Parse YYYYmmddTHHMMSSZ or ISO-8601 into epoch seconds; prints empty on error.
ts_to_epoch() {
  local raw="$1" norm
  [ -n "$raw" ] || return 1
  if [[ "$raw" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$ ]]; then
    norm="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}T${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}Z"
  else
    norm="$raw"
  fi
  date -u -d "$norm" +%s 2>/dev/null
}

# Read {"ts":"...","ok":true} marker file without requiring jq.
check_marker_json() {
  local label="$1" file="$2" max_age="$3"
  if [ ! -s "$file" ]; then
    add_crit "$label: missing marker $file"
    return
  fi
  local content ts epoch age
  content="$(tr -d '\n\r ' <"$file" 2>/dev/null || true)"
  if [[ "$content" != *'"ok":true'* ]]; then
    add_crit "$label: marker $file does not have ok:true"
    return
  fi
  ts="$(sed -n 's/.*"ts":"\([^"]*\)".*/\1/p' <<<"$content")"
  epoch="$(ts_to_epoch "$ts" || true)"
  if [ -z "$epoch" ]; then
    add_crit "$label: unreadable ts in $file"
    return
  fi
  age=$((NOW_EPOCH - epoch))
  if [ "$age" -gt "$max_age" ]; then
    add_crit "$label: stale (${age}s > ${max_age}s, ts=$ts)"
  fi
}

# 1. Dependency commands in PATH (C20: missing gpg/docker/psql/curl -> CRIT).
for cmd in gpg docker psql curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    add_crit "deps: required command '$cmd' not found in PATH"
  fi
done

# Load previous counters (archiver failed_count, 5xx total).
prev_archiver_failed=""
prev_http_5xx=""
if [ -f "$PREV_STATE" ]; then
  # shellcheck disable=SC1090
  . "$PREV_STATE"
fi

# 2. Container health.
if [ "${MONITOR_SKIP_CONTAINERS:-0}" != "1" ] && command -v docker >/dev/null 2>&1; then
  for c in $CONTAINERS; do
    st="$(docker inspect -f '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c" 2>/dev/null || echo 'missing:missing')"
    case "$st" in
      running:healthy|running:none) ;;
      *) add_crit "container: $c state=$st" ;;
    esac
  done
fi

# Resolve API base URL on the Docker bridge when not overridden (prod resets host ports).
if [ -z "$API_BASE_URL" ] && command -v docker >/dev/null 2>&1; then
  api_ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$API_CONTAINER" 2>/dev/null | awk '{print $1}')"
  [ -n "$api_ip" ] && API_BASE_URL="http://${api_ip}:8080"
fi
API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8080}"

# 3. /healthz + /readyz < 2s.
if [ "${MONITOR_SKIP_HTTP:-0}" != "1" ] && command -v curl >/dev/null 2>&1; then
  for ep in healthz readyz; do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$API_BASE_URL/api/v1/$ep" 2>/dev/null || echo 000)"
    [ "$code" = "200" ] || add_crit "http: /api/v1/$ep returned $code (budget 2s)"
  done
fi

# 4. Disk usage on / (>88% WARN, >92% CRIT).
disk_pct="${MONITOR_FAKE_DISK_PCT:-}"
if [ -z "$disk_pct" ]; then
  disk_pct="$(df -P "$DISK_PATH" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
fi
if [[ "$disk_pct" =~ ^[0-9]+$ ]]; then
  if [ "$disk_pct" -gt 92 ]; then
    add_crit "disk: $DISK_PATH at ${disk_pct}% (>92%)"
  elif [ "$disk_pct" -gt 88 ]; then
    add_warn "disk: $DISK_PATH at ${disk_pct}% (>88%)"
  fi
else
  add_crit "disk: cannot read df for $DISK_PATH"
fi

# 5. TLS expiry (<21d WARN, <7d CRIT).
if [ "${MONITOR_SKIP_TLS:-0}" != "1" ]; then
  enddate="${MONITOR_FAKE_TLS_ENDDATE:-}"
  if [ -z "$enddate" ]; then
    enddate="$(echo | timeout 5 openssl s_client -servername "$TLS_HOST" -connect "$TLS_HOST:$TLS_PORT" 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
  fi
  tls_epoch="$(date -u -d "$enddate" +%s 2>/dev/null || true)"
  if [ -z "$tls_epoch" ]; then
    add_crit "tls: cannot read certificate enddate for $TLS_HOST"
  else
    tls_days=$(((tls_epoch - NOW_EPOCH) / 86400))
    if [ "$tls_days" -lt 7 ]; then
      add_crit "tls: $TLS_HOST expires in ${tls_days}d (<7d)"
    elif [ "$tls_days" -lt 21 ]; then
      add_warn "tls: $TLS_HOST expires in ${tls_days}d (<21d)"
    fi
  fi
fi

# 6. Metrics: 5xx rate (including export 5xx) + export_cleanup_pending_age_seconds > 3600.
new_http_5xx="$prev_http_5xx"
if [ "${MONITOR_SKIP_METRICS:-0}" != "1" ]; then
  metrics_body=""
  if [ -n "${MONITOR_METRICS_FILE:-}" ] && [ -f "$MONITOR_METRICS_FILE" ]; then
    metrics_body="$(cat "$MONITOR_METRICS_FILE")"
  elif command -v curl >/dev/null 2>&1; then
    metrics_body="$(curl -sS --max-time 3 "$API_BASE_URL/api/v1/metrics" 2>/dev/null || true)"
  fi
  if [ -z "$metrics_body" ]; then
    add_crit "metrics: empty response from /api/v1/metrics"
  else
    cleanup_age="$(awk '/^export_cleanup_pending_age_seconds / {print $2; exit}' <<<"$metrics_body")"
    if [ -n "$cleanup_age" ]; then
      if awk -v v="$cleanup_age" -v m="$MAX_CLEANUP_AGE" 'BEGIN {exit !(v+0 > m+0)}'; then
        add_crit "export_cleanup: pending age ${cleanup_age}s > ${MAX_CLEANUP_AGE}s"
      fi
    fi
    cur_5xx="$(awk '/^engram_http_request_duration_seconds_count\{.*status="5[0-9][0-9]"/ {s += $NF} END {printf "%.0f", s+0}' <<<"$metrics_body")"
    new_http_5xx="$cur_5xx"
    if [[ "$prev_http_5xx" =~ ^[0-9]+$ ]] && [ "$cur_5xx" -ge "$prev_http_5xx" ]; then
      delta=$((cur_5xx - prev_http_5xx))
      if [ "$delta" -gt "$MAX_5XX_DELTA" ]; then
        add_crit "http_5xx: +${delta} 5xx responses in last window (threshold $MAX_5XX_DELTA)"
      elif [ "$delta" -gt 0 ]; then
        add_warn "http_5xx: +${delta} 5xx responses in last window"
      fi
    fi
  fi
fi

# 7. WAL archiver: failed_count increase, last_archived_time lag > 15m, .ready backlog > 16.
  # Edge access-log 5xx delta on /api/v1/exports/{id}* (advisor-dec-P06-024 D):
  # nginx error_log is set to crit for the exports location to scrub job UUIDs,
  # so upstream 502/504 are observed from the scrubbed access_log stream.
  edge_lines=""
  if [ -n "${MONITOR_NGINX_LOG_FILE:-}" ] && [ -f "$MONITOR_NGINX_LOG_FILE" ]; then
    edge_lines="$(cat "$MONITOR_NGINX_LOG_FILE")"
  elif [ "${MONITOR_SKIP_CONTAINERS:-0}" != "1" ] && command -v docker >/dev/null 2>&1; then
    edge_lines="$(docker logs --since 5m "$NGINX_CONTAINER" 2>&1 || true)"
  fi
  if [ -n "$edge_lines" ]; then
    edge_5xx="$(awk '/" [5][0-9][0-9] [0-9]/ && /\/api\/v1\/exports\// {c++} END {print c+0}' <<<"$edge_lines")"
    if [ "${edge_5xx:-0}" -gt 0 ]; then
      add_crit "edge_exports_5xx: ${edge_5xx} 5xx responses on /api/v1/exports/* in nginx access log"
    fi
  fi
new_archiver_failed="$prev_archiver_failed"
if [ "${MONITOR_SKIP_WAL:-0}" != "1" ]; then
  wal_row="${MONITOR_FAKE_ARCHIVER_ROW:-}"
  if [ -z "$wal_row" ] && command -v docker >/dev/null 2>&1; then
    wal_row="$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -AtF '|' -c "
      SELECT COALESCE(failed_count,0),
             COALESCE(EXTRACT(EPOCH FROM last_archived_time)::bigint, 0),
             (SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready')
      FROM pg_stat_archiver;" 2>/dev/null || true)"
  fi
  if [ -z "$wal_row" ]; then
    add_crit "wal: cannot query pg_stat_archiver"
  else
    IFS='|' read -r failed_cnt last_arch_epoch ready_cnt <<<"$wal_row"
    new_archiver_failed="$failed_cnt"
    if [[ "$prev_archiver_failed" =~ ^[0-9]+$ ]] && [ "${failed_cnt:-0}" -gt "$prev_archiver_failed" ]; then
      add_crit "wal: pg_stat_archiver.failed_count increased (${prev_archiver_failed} -> ${failed_cnt})"
    fi
    if [ "${last_arch_epoch:-0}" -le 0 ] || [ $((NOW_EPOCH - last_arch_epoch)) -gt "$MAX_WAL_LAG" ]; then
      add_crit "wal: last_archived_time lag $((NOW_EPOCH - ${last_arch_epoch:-0}))s > ${MAX_WAL_LAG}s"
    fi
    if [ "${ready_cnt:-0}" -gt "$MAX_WAL_READY" ]; then
      add_crit "wal: archive_status .ready backlog ${ready_cnt} > ${MAX_WAL_READY}"
    fi
  fi
fi

# 8. Base & nightly backup markers (<= 26h, ok:true).
check_marker_json "backup_nightly" "$BACKUP_ROOT/nightly/last.json" "$MAX_BACKUP_AGE"
check_marker_json "backup_pitr_base" "$BACKUP_ROOT/pitr/last-base.json" "$MAX_BACKUP_AGE"

# 9. Retention (C09): expire/last-sweep.json <= 75m AND oldest source timestamp
# in ANY backup filename under BACKUP_ROOT/** <= 7d23h (never trust newest file or mtime).
check_marker_json "retention_sweep" "$BACKUP_ROOT/expire/last-sweep.json" "$MAX_SWEEP_AGE"

if [ -d "$BACKUP_ROOT" ]; then
  oldest_age=0
  oldest_file=""
  while IFS= read -r -d '' f; do
    base="$(basename "$f")"
    if [[ "$base" =~ ^(engram(-base)?-)?([0-9]{8}T[0-9]{6}Z)(--|\.) ]]; then
      src_ts="${BASH_REMATCH[3]}"
      src_epoch="$(ts_to_epoch "$src_ts" || true)"
      if [ -n "$src_epoch" ]; then
        age=$((NOW_EPOCH - src_epoch))
        if [ "$age" -gt "$oldest_age" ]; then
          oldest_age="$age"
          oldest_file="$f"
        fi
      else
        add_crit "retention: backup file $f has unreadable timestamp"
      fi
    else
      add_crit "retention: backup file $f lacks immutable source timestamp in name"
    fi
  done < <(find "$BACKUP_ROOT" -type f \( -name '*.gpg' -o -name '*.dump' -o -name '*.tar*' \) -print0 2>/dev/null)
  if [ "$oldest_age" -gt "$MAX_RETENTION_SOURCE_AGE" ]; then
    add_crit "retention: oldest source backup $oldest_file is ${oldest_age}s old (> 7d23h = ${MAX_RETENTION_SOURCE_AGE}s)"
  fi
else
  add_crit "retention: backup root $BACKUP_ROOT missing"
fi

# 10. Off-host pull marker (<= 26h, ok:true).
check_marker_json "offhost_pull" "$BACKUP_ROOT/offhost/last-pull.json" "$MAX_OFFHOST_AGE"

# Persist counters for next run.
cat >"$PREV_STATE.tmp" <<EOF
prev_archiver_failed=${new_archiver_failed:-0}
prev_http_5xx=${new_http_5xx:-0}
EOF
mv -f "$PREV_STATE.tmp" "$PREV_STATE"

if [ "${TEST_ALERT:-0}" = "1" ]; then
  add_warn "test_alert: synthetic alert probe requested via TEST_ALERT=1"
fi

status="ok"
[ "${#WARNS[@]}" -gt 0 ] && status="warn"
[ "${#CRITS[@]}" -gt 0 ] && status="crit"

all_msgs=()
for m in "${CRITS[@]}"; do all_msgs+=("CRIT: $m"); done
for m in "${WARNS[@]}"; do all_msgs+=("WARN: $m"); done

summary="$(printf '%s; ' "${all_msgs[@]}")"
summary="${summary%; }"

json_escape() {
  sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' <<<"$1" | tr '\n' ' '
}

printf '{"ts":"%s","status":"%s","crit_count":%d,"warn_count":%d,"summary":"%s"}\n' \
  "$NOW_ISO" "$status" "${#CRITS[@]}" "${#WARNS[@]}" "$(json_escape "$summary")" >"$STATUS_JSON.tmp"
mv -f "$STATUS_JSON.tmp" "$STATUS_JSON"

if [ "$status" != "ok" ]; then
  printf '%s [%s] %s\n' "$NOW_ISO" "$status" "$summary" >>"$ALERT_LOG"
  sig="$(printf '%s\n' "${all_msgs[@]}" | sha256sum | awk '{print $1}')"
  send_alert=1
  if [ "${TEST_ALERT:-0}" != "1" ] && [ -f "$DEDUP_FILE" ]; then
    read -r old_ts old_sig <"$DEDUP_FILE" || true
    if [ "$old_sig" = "$sig" ] && [ $((NOW_EPOCH - ${old_ts:-0})) -lt "$DEDUP_SECONDS" ]; then
      send_alert=0
    fi
  fi
  if [ "$send_alert" -eq 1 ]; then
    if [ -z "$ALERT_WEBHOOK_URL" ]; then
      printf '%s [blocked] ALERT_WEBHOOK_URL is empty; alert not delivered\n' "$NOW_ISO" >>"$ALERT_LOG"
      exit 2
    fi
    payload="$(printf '{"ts":"%s","host":"%s","status":"%s","text":"[engram %s] %s"}' \
      "$NOW_ISO" "${HOSTNAME:-bro}" "$status" "$status" "$(json_escape "$summary")")"
    if curl -sS -f --max-time 10 -H 'Content-Type: application/json' -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null 2>>"$ALERT_LOG"; then
      printf '%s %s\n' "$NOW_EPOCH" "$sig" >"$DEDUP_FILE"
    else
      printf '%s [webhook_error] delivery failed\n' "$NOW_ISO" >>"$ALERT_LOG"
      exit 1
    fi
  fi
fi

exit 0
