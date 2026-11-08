#!/usr/bin/env bash
# C12 check for the production compose files (P06 Task 22 ops-prod; advisor-dec-P06-058). Cloud runner only
# (builds images, starts containers). Never run against bro production; never prints a secret value.
#   resolve   P06 base + infra/deploy/compose.prod.yml (post-8b target) with generated dummy secrets:
#             APP_ENV production, AUTH_MAIL_SINK_DIR "" on api AND worker, no mail-sink mount/service,
#             one EXPORT_AT_REST_SECRET for api+worker, healthchecks api/worker/web, json-file logging, PITR db;
#             a missing EXPORT_AT_REST_SECRET / ENGRAM_RELEASE_TAG makes `config` fail (fail closed).
#   pre8b     live pre-P06 stack (base 468cc3b + prodhygiene 4cbffff compose.prod.yml) + compose.prod-2prep.yml
#             (+ compose.prod-step4.yml): env/volume added, APP_ENV/sink unchanged, NO worker healthcheck.
#   boot      build the candidate images, up api+worker+web from the resolved target (db swapped for the plain
#             pgvector pin by a test-only override: the PITR image is Task 9's evidence), without and with
#             SMTP_HOST: api+worker+web healthy, /api/v1/readyz 200, mail_delivery_available false/true.
# Markers: COMPOSE_RESOLVE_EXIT, COMPOSE_PRE8B_EXIT, COMPOSE_BOOT_NOSMTP_EXIT, COMPOSE_BOOT_SMTP_EXIT,
# final OPSPROD_COMPOSE_EXIT. Usage: bash infra/deploy/test-compose-prod.sh [resolve|pre8b|boot|all]
set -uo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
MODE="${1:-all}"
P05_BASE_SHA=468cc3b    # live production checkout (P05 + hotfixes)
PRODHYGIENE_SHA=4cbffff # live compose.prod.yml + json-file logging (== bro .data/deploy/compose.prod.yml + logging)
PROJECT=engram-c12
WORK="$(mktemp -d)"
FAILS=0
# shellcheck disable=SC2317 # invoked via trap
cleanup() {
  if [ -f "$WORK/boot.started" ]; then
    compose_target down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf 'PASS %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FAIL %s\n' "$1"; }

# Dummy env: fresh random secrets (distinct, >= 32 B), written 0600 into WORK, never echoed.
gen_env() {
  local f="$WORK/dummy.env" v
  : >"$f"
  for v in AUTH_JWT_SECRET AUTH_CSRF_SECRET AUTH_REAUTH_SECRET AUTH_IP_PEPPER AUTH_EMAIL_PEPPER EXPORT_AT_REST_SECRET; do
    printf '%s=%s\n' "$v" "$(openssl rand -base64 48 | tr -d '\n')" >>"$f"
  done
  cat >>"$f" <<'EOF'
APP_ORIGIN=https://engram.c12.example.test
WEBAUTHN_RP_ID=engram.c12.example.test
WEBAUTHN_RP_ORIGIN=https://engram.c12.example.test
ENGRAM_DB_PASSWORD=c12-dummy-db-password
EMBEDDING_API_KEY=c12-dummy
ENGRAM_RELEASE_TAG=c12
EOF
}

compose_target() {
  docker compose -p "$PROJECT" --env-file infra/image-pins.env --env-file "$WORK/dummy.env" \
    ${EXTRA_ENV:+--env-file "$EXTRA_ENV"} \
    -f infra/docker-compose.yml -f infra/deploy/compose.prod.yml ${BOOT_OVERRIDE:+-f "$BOOT_OVERRIDE"} "$@"
}

# py_assert <json-file> <python body using d=services dict, top=whole doc>; prints FAIL lines, exit 1 on any.
py_assert() {
  python3 - "$1" <<EOF
import json, sys
top = json.load(open(sys.argv[1]))
d = top["services"]
bad = []
def need(cond, msg):
    if not cond:
        bad.append(msg)
$2
for b in bad:
    print("  assert:", b)
sys.exit(1 if bad else 0)
EOF
}

run_resolve() {
  local rc=0
  compose_target config --format json >"$WORK/target.json" 2>"$WORK/target.err" || {
    sed 's/=.*/=<redacted>/' "$WORK/target.err"
    fail "resolve: target config failed"
    return 1
  }
  py_assert "$WORK/target.json" '
for s in ("api", "worker"):
    e = d[s]["environment"]
    need(e.get("APP_ENV") == "production", s + " APP_ENV production")
    need("AUTH_MAIL_SINK_DIR" in e and e["AUTH_MAIL_SINK_DIR"] == "", s + " AUTH_MAIL_SINK_DIR is explicitly empty")
    need(e.get("AUTH_MAIL_CAPTURE_AS_DELIVERY") == "false", s + " capture-as-delivery false")
    need(e.get("APP_ORIGIN", "").startswith("https://"), s + " HTTPS origin")
    need(e.get("AUTH_FAKE_OAUTH") == "false", s + " fake oauth off")
    need(e.get("EXPORT_STORAGE_DIR") == "/var/lib/engram-exports", s + " export dir")
    need(e.get("EXPORT_CREATE_PAUSED") == "false", s + " export not paused")
    need(e.get("EXPORT_AT_REST_SECRET"), s + " export secret set")
    for k in ("SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM", "SMTP_TLS_MODE"):
        need(k in e, s + " " + k + " passthrough")
    vols = d[s].get("volumes", [])
    need([v.get("target") for v in vols] == ["/var/lib/engram-exports"], s + " only the exports volume is mounted")
    need(all("mail" not in str(v.get("source", "")) for v in vols), s + " no mail-sink mount")
    need("mail-sink-perms" not in d[s].get("depends_on", {}), s + " no mail-sink dependency")
    need("export-storage-perms" in d[s].get("depends_on", {}), s + " waits for export-storage-perms")
    need(d[s].get("image") == s.replace("api", "engram-api").replace("worker", "engram-worker") + ":c12", s + " image tag from ENGRAM_RELEASE_TAG")
need(d["api"]["environment"]["EXPORT_AT_REST_SECRET"] == d["worker"]["environment"]["EXPORT_AT_REST_SECRET"], "api and worker share ONE export secret")
need("/app/worker" in str(d["worker"].get("healthcheck", {}).get("test")), "worker healthcheck /app/worker -healthcheck")
need("healthz" in str(d["web"].get("healthcheck", {}).get("test")), "web healthcheck")
need("/app/api" in str(d["api"].get("healthcheck", {}).get("test")), "api healthcheck")
need(d["web"].get("image") == "engram-web:c12", "web image tag")
need("mail-sink-perms" not in d, "mail-sink-perms not started (retired profile)")
need("engram-mail" not in top.get("volumes", {}), "engram-mail volume not declared")
need("engram-exports" in top.get("volumes", {}), "engram-exports volume declared")
p = d["export-storage-perms"]
need("chown 65532:65532" in str(p.get("command")) and "chmod 0700" in str(p.get("command")), "exports volume 65532 0700")
need(d["db"].get("image", "").startswith("engram-db-pitr:"), "db PITR image")
need("config_file=/etc/postgresql/postgresql-pitr.conf" in str(d["db"].get("command")), "db PITR config")
need(not d["db"].get("ports") and not d["api"].get("ports") and not d["web"].get("ports"), "no published ports")
for s in ("db", "migrate", "api", "worker", "web", "export-storage-perms"):
    lg = d[s].get("logging", {})
    need(lg.get("driver") == "json-file" and lg.get("options", {}).get("max-size") == "20m", s + " json-file rotation")
' || rc=1
  grep -q "do NOT delete this key" infra/deploy/compose.prod.yml || { echo "  assert: do-not-delete-key comment kept"; rc=1; }
  # Fail closed: required secrets/tag missing => config refuses to render.
  local v
  for v in EXPORT_AT_REST_SECRET ENGRAM_RELEASE_TAG; do
    grep -v "^$v=" "$WORK/dummy.env" >"$WORK/missing.env"
    if docker compose -p "$PROJECT" --env-file infra/image-pins.env --env-file "$WORK/missing.env" \
      -f infra/docker-compose.yml -f infra/deploy/compose.prod.yml config >/dev/null 2>&1; then
      echo "  assert: config must fail without $v"
      rc=1
    fi
  done
  if [ "$rc" -eq 0 ]; then pass "resolve: post-8b target"; else fail "resolve: post-8b target"; fi
  return "$rc"
}

run_pre8b() {
  local rc=0 d="$WORK/p05"
  mkdir -p "$d/infra/deploy"
  if ! git cat-file -e "$P05_BASE_SHA:infra/docker-compose.yml" 2>/dev/null ||
    ! git cat-file -e "$PRODHYGIENE_SHA:infra/deploy/compose.prod.yml" 2>/dev/null; then
    git fetch --quiet --unshallow origin 2>/dev/null || git fetch --quiet origin 2>/dev/null || true
  fi
  git show "$P05_BASE_SHA:infra/docker-compose.yml" >"$d/infra/docker-compose.yml" || rc=1
  git show "$PRODHYGIENE_SHA:infra/deploy/compose.prod.yml" >"$d/infra/deploy/compose.prod.yml" || rc=1
  git show "$P05_BASE_SHA:infra/image-pins.env" >"$d/infra/image-pins.env" || rc=1
  cp infra/deploy/compose.prod-2prep.yml infra/deploy/compose.prod-step4.yml "$d/infra/deploy/" || rc=1
  # The live P05 image-pins.env has no POSTGRES_PITR_IMAGE; PROD-STEP-4 adds it (same value as the repo pin).
  grep '^POSTGRES_PITR_IMAGE=' infra/image-pins.env >>"$d/infra/image-pins.env"
  if [ "$rc" -ne 0 ]; then
    fail "pre8b: cannot read $P05_BASE_SHA / $PRODHYGIENE_SHA from git"
    return 1
  fi
  local files=(-f infra/docker-compose.yml -f infra/deploy/compose.prod.yml -f infra/deploy/compose.prod-2prep.yml)
  (cd "$d" && docker compose -p "$PROJECT-pre" --env-file infra/image-pins.env --env-file "$WORK/dummy.env" \
    "${files[@]}" config --format json) >"$WORK/pre.json" 2>"$WORK/pre.err" || {
    sed 's/=.*/=<redacted>/' "$WORK/pre.err"
    fail "pre8b: 2-PREP config failed"
    return 1
  }
  (cd "$d" && docker compose -p "$PROJECT-pre" --env-file infra/image-pins.env --env-file "$WORK/dummy.env" \
    "${files[@]}" -f infra/deploy/compose.prod-step4.yml config --format json) >"$WORK/pre4.json" 2>"$WORK/pre4.err" || {
    sed 's/=.*/=<redacted>/' "$WORK/pre4.err"
    fail "pre8b: STEP-4 config failed"
    return 1
  }
  py_assert "$WORK/pre.json" '
for s in ("api", "worker"):
    e = d[s]["environment"]
    need(e.get("APP_ENV") == "development", s + " APP_ENV unchanged (development) before 8b")
    need(e.get("AUTH_MAIL_SINK_DIR") == "/var/lib/engram-mail", s + " mail sink unchanged before 8b")
    need(e.get("EXPORT_STORAGE_DIR") == "/var/lib/engram-exports" and e.get("EXPORT_CREATE_PAUSED") == "false", s + " export env")
    need(e.get("SMTP_TLS_MODE") == "starttls" and "SMTP_HOST" in e, s + " SMTP passthrough")
    tg = [v.get("target") for v in d[s].get("volumes", [])]
    need("/var/lib/engram-exports" in tg and "/var/lib/engram-mail" in tg, s + " exports added, mail sink kept")
    need("export-storage-perms" in d[s].get("depends_on", {}), s + " waits for export-storage-perms")
    need(d[s].get("logging", {}).get("driver") == "json-file", s + " json-file rotation (4cbffff)")
need(d["api"]["environment"]["EXPORT_AT_REST_SECRET"] == d["worker"]["environment"]["EXPORT_AT_REST_SECRET"], "one export secret for api+worker")
need("healthcheck" not in d["worker"], "no worker healthcheck before 8b")
need("healthcheck" not in d["web"], "no web healthcheck before 8b")
need(not d["db"].get("image", "").startswith("engram-db-pitr"), "2-PREP alone keeps the current db image")
p = d["export-storage-perms"]
need("chown 65532:65532" in str(p.get("command")) and "chmod 0700" in str(p.get("command")), "exports volume 65532 0700")
' || rc=1
  py_assert "$WORK/pre4.json" '
need(d["db"].get("image", "").startswith("engram-db-pitr:"), "STEP-4 db PITR image")
need("config_file=/etc/postgresql/postgresql-pitr.conf" in str(d["db"].get("command")), "STEP-4 PITR config")
tg = [v.get("target") for v in d["db"].get("volumes", [])]
for t in ("/var/lib/postgresql/data", "/var/lib/postgresql/wal-archive", "/run/secrets/engram_replication.password", "/run/secrets/engram_replication.pgpass"):
    need(t in tg, "db mount " + t)
need(all(v.get("read_only") for v in d["db"]["volumes"] if v.get("target", "").startswith("/run/secrets/")), "secret mounts read-only")
need(d["api"]["environment"].get("APP_ENV") == "development", "STEP-4 does not touch the app")
' || rc=1
  if [ "$rc" -eq 0 ]; then pass "pre8b: 2-PREP and STEP-4 overlays on the live P05 stack"; else fail "pre8b overlays"; fi
  return "$rc"
}

# api fetch through the project network with the pinned node image (distroless api has no curl).
api_get() {
  local node_image
  node_image="$(grep '^NODE_IMAGE=' infra/image-pins.env | cut -d= -f2-)"
  docker run --rm --network "${PROJECT}_default" "$node_image" node -e "
fetch('http://api:8080$1').then(async r => { console.log(r.status); console.log(await r.text()); }).catch(e => { console.log('ERR ' + e.message); process.exit(1); })"
}

boot_round() { # boot_round <label> <smtp: yes|no>
  local label="$1" smtp="$2" rc=0 out
  EXTRA_ENV="$WORK/smtp-$smtp.env"
  if [ "$smtp" = yes ]; then
    printf 'SMTP_HOST=smtp.c12.example.test\nSMTP_PORT=587\nSMTP_FROM=no-reply@c12.example.test\nSMTP_TLS_MODE=starttls\n' >"$EXTRA_ENV"
  else
    : >"$EXTRA_ENV"
  fi
  export EXTRA_ENV
  touch "$WORK/boot.started"
  if ! compose_target up -d --wait --wait-timeout 240 db migrate export-storage-perms api worker web >"$WORK/up-$label.log" 2>&1; then
    tail -n 40 "$WORK/up-$label.log" | sed 's/\(SECRET\|PEPPER\|PASSWORD\)[^ ]*/\1=<redacted>/g'
    compose_target ps -a
    compose_target logs --no-color --tail 40 api worker 2>&1 | grep -viE 'secret|pepper|password' || true
    fail "boot $label: stack not healthy"
    rc=1
  fi
  local s state
  for s in api worker web; do
    state="$(docker inspect -f '{{.State.Status}} {{.State.Health.Status}} {{.State.ExitCode}}' "${PROJECT}-$s-1" 2>/dev/null || echo missing)"
    printf '  %s: %s\n' "$s" "$state"
    [ "$state" = "running healthy 0" ] || rc=1
  done
  out="$(api_get /api/v1/readyz)" || rc=1
  printf '  readyz: %s\n' "$(head -n1 <<<"$out")"
  [ "$(head -n1 <<<"$out")" = 200 ] || rc=1
  out="$(api_get /api/v1/auth/config)" || rc=1
  local want=false
  [ "$smtp" = yes ] && want=true
  if grep -q "\"mail_delivery_available\":$want" <<<"$out"; then
    printf '  mail_delivery_available=%s\n' "$want"
  else
    printf '  auth/config: %s\n' "$(head -c 300 <<<"$out")"
    rc=1
  fi
  compose_target down -v --remove-orphans >/dev/null 2>&1 || true
  if [ "$rc" -eq 0 ]; then pass "boot $label"; else fail "boot $label"; fi
  return "$rc"
}

run_boot() {
  # Test-only: plain pgvector pin for db (no PITR mounts/secrets) and the external edge network.
  BOOT_OVERRIDE="$WORK/boot-db.yml"
  cat >"$BOOT_OVERRIDE" <<'EOF'
services:
  db:
    image: ${POSTGRES_IMAGE}
    command: !reset []
    volumes: !override
      - engram-db:/var/lib/postgresql/data
EOF
  export BOOT_OVERRIDE
  docker network inspect selfio_backend >/dev/null 2>&1 || docker network create selfio_backend >/dev/null
  EXTRA_ENV="" compose_target build api worker web >"$WORK/build.log" 2>&1 || {
    tail -n 60 "$WORK/build.log"
    fail "boot: image build"
    echo
    echo "COMPOSE_BOOT_NOSMTP_EXIT=1"
    echo "COMPOSE_BOOT_SMTP_EXIT=1"
    return 1
  }
  local a=0 b=0
  boot_round nosmtp no || a=1
  echo
  echo "COMPOSE_BOOT_NOSMTP_EXIT=$a"
  boot_round smtp yes || b=1
  echo
  echo "COMPOSE_BOOT_SMTP_EXIT=$b"
  [ "$a" -eq 0 ] && [ "$b" -eq 0 ]
}

gen_env
case "$MODE" in
  resolve | all)
    r=0; run_resolve || r=1; echo; echo "COMPOSE_RESOLVE_EXIT=$r" ;;&
  pre8b | all)
    r=0; run_pre8b || r=1; echo; echo "COMPOSE_PRE8B_EXIT=$r" ;;&
  boot | all)
    run_boot || true ;;
  resolve | pre8b) ;;
  *) echo "usage: $0 [resolve|pre8b|boot|all]"; exit 2 ;;
esac
rc=0
[ "$FAILS" -eq 0 ] || rc=1
echo
echo "OPSPROD_COMPOSE_EXIT=$rc"
exit "$rc"
