#!/usr/bin/env bash
# Tests the step library in docs/runbooks/prod-steps.md exactly as operators load it (same awk/sed extraction),
# against fixtures with recording docker/systemctl shims (P06 Task 22, review r1 R1-02/R1-05/R1-08).
# Never touches bro production. Prints OPSPROD_STEPLIB_EXIT=<n>.
#   files   bak_files/restore_files: existing file -> exact content + mode back; absent file -> removed again
#   units   bak_units/restore_units: pre-existing enabled+active timer restored (file, enable, start, daemon-reload);
#           first install (absent) -> disabled and removed again
#   nginx   step7_apply staged/final + step7_rollback from the PROD dir: absolute paths, `nginx -t` then reload,
#           both via `docker exec global_nginx`; failed `nginx -t` restores the backup and never reloads first
#   build   step4_build argv: Dockerfile.db, --build-arg POSTGRES_IMAGE=<pin>, -t <PITR pin>, under flock
#   real    (mode `real`, cloud) step4_build with real docker from the reviewed tree -> image has gpg, archive script,
#           public key; real `nginx -t` (nginx:1.27.5-alpine = live version) on infra/nginx/engram.conf with the
#           live http-level `map $http_upgrade $connection_upgrade` and a throwaway cert
# Usage: bash infra/backup/expire/test-prod-steps-lib.sh [unit|real|all]   (default unit)
# check() evals single-quoted conditions at call time; shims/helpers run indirectly.
# shellcheck disable=SC2016,SC2034,SC2317
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MODE="${1:-unit}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILS=0
PASSES=0
pass() { PASSES=$((PASSES + 1)); printf 'PASS %s\n' "$1"; }
fail() { FAILS=$((FAILS + 1)); printf 'FAIL %s\n' "$1"; }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
mode_of() { stat -c '%a' "$1"; }

# Reviewed tree = a throwaway git repo holding the working-tree files the library reads (DEV + SHA as in production).
export DEV="$WORK/dev"
mkdir -p "$DEV"
(cd "$REPO" && tar -cf - docs/runbooks/prod-steps.md infra/nginx/engram.conf infra/image-pins.env infra/backup/pitr \
  infra/backup/interim/engram-backup-pub.asc infra/ops infra/backup/expire) | tar -xf - -C "$DEV"
git -C "$DEV" init -q && git -C "$DEV" add -A && git -C "$DEV" -c user.name=t -c user.email=t@t commit -qm fixture
export SHA
SHA="$(git -C "$DEV" rev-parse HEAD)"
export PROD="$WORK/prod" TS=20261108T120000Z
mkdir -p "$PROD"
export HOME="$WORK/home" HEAVY_LOCK="$WORK/heavy.lock" STATE_DIR="$WORK/home/engram-ops/prodsteps"
mkdir -p "$HOME/.config/systemd/user"
LIB="$WORK/lib.sh"
# Exactly the documented extraction.
git -C "$DEV" show "$SHA:docs/runbooks/prod-steps.md" |
  awk '/^<!-- prodsteps-lib:begin -->$/{f=1;next} /^<!-- prodsteps-lib:end -->$/{f=0} f' | sed '1d;$d' >"$LIB"
check "lib extracted from the runbook and parses" '[ -s "$LIB" ] && bash -n "$LIB"'

run_unit() {
  local BIN="$WORK/bin"
  mkdir -p "$BIN" "$WORK/sysd"
  cat >"$BIN/docker" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$WORK/docker.argv"
if [ "\$1 \$2 \$3 \$4" = "exec global_nginx nginx -t" ] && [ -e "$WORK/nginx-t-fails" ]; then exit 1; fi
if [ "\$1 \$2 \$3" = "exec engram-db-1 psql" ]; then cat "$WORK/fake-role" 2>/dev/null; exit 0; fi
exit 0
EOF
  # Behaves like systemctl: is-enabled/is-active print a word and exit non-zero unless enabled/active; a unit that
  # has no file and no state prints nothing (systemd's "not found" goes to stderr).
  cat >"$BIN/systemctl" <<EOF
#!/usr/bin/env bash
[ "\$1" = --user ] && shift
cmd="\$1"; u="\${2:-}"; st="$WORK/sysd/\$u"; uf="$HOME/.config/systemd/user/\$u"
printf '%s %s\n' "\$cmd" "\$u" >>"$WORK/systemctl.log"
case "\$cmd" in
  is-enabled)
    if [ -f "\$st.en" ]; then s="\$(cat "\$st.en")"; elif [ -e "\$uf" ]; then s=disabled; else echo "Failed to get unit file state for \$u" >&2; exit 1; fi
    echo "\$s"; [ "\$s" = enabled ] ;;
  is-active) s="\$(cat "\$st.act" 2>/dev/null || echo inactive)"; echo "\$s"; [ "\$s" = active ] ;;
  enable) echo enabled >"\$st.en" ;;
  disable) echo disabled >"\$st.en" ;;
  start | restart) echo active >"\$st.act" ;;
  stop) echo inactive >"\$st.act" ;;
  daemon-reload) : ;;
esac
EOF
  chmod +x "$BIN/docker" "$BIN/systemctl"
  export PATH="$BIN:$PATH"
  # shellcheck disable=SC1090
  source "$LIB"

  # files
  local f1="$PROD/.data/deploy/compose.prod.yml" f2="$PROD/.data/deploy/compose.prod-2prep.yml"
  mkdir -p "$(dirname "$f1")"
  printf 'old-compose\n' >"$f1"
  chmod 640 "$f1"
  (cd "$PROD" && bak_files .data/deploy/compose.prod.yml .data/deploy/compose.prod-2prep.yml)
  printf 'new\n' >"$f1"; chmod 600 "$f1"; printf 'overlay\n' >"$f2"
  (cd "$PROD" && restore_files .data/deploy/compose.prod.yml .data/deploy/compose.prod-2prep.yml)
  check "files: existing file restored with exact content and mode" '[ "$(cat "$f1")" = old-compose ] && [ "$(mode_of "$f1")" = 640 ]'
  check "files: file absent before the step is removed again" '[ ! -e "$f2" ]'
  check "files: restore without a backup marker fails" '! (cd "$PROD" && restore_files .data/deploy/never.yml 2>/dev/null)'

  # units: pre-existing enabled+active timer, and a first install
  local d="$HOME/.config/systemd/user"
  printf '[Timer]\nOnCalendar=hourly\n' >"$d/engram-monitor.timer"; chmod 644 "$d/engram-monitor.timer"
  echo enabled >"$WORK/sysd/engram-monitor.timer.en"; echo active >"$WORK/sysd/engram-monitor.timer.act"
  bak_units engram-monitor.timer engram-backup-expire.timer
  install_reviewed infra/ops/engram-monitor.timer "$d/engram-monitor.timer" 600
  install_reviewed infra/backup/expire/engram-backup-expire.timer "$d/engram-backup-expire.timer" 644
  systemctl --user disable engram-monitor.timer; systemctl --user stop engram-monitor.timer
  systemctl --user enable engram-backup-expire.timer; systemctl --user start engram-backup-expire.timer
  : >"$WORK/systemctl.log"
  restore_units engram-monitor.timer engram-backup-expire.timer
  check "units: pre-existing timer file content + mode restored" \
    '[ "$(cat "$d/engram-monitor.timer")" = "$(printf "[Timer]\nOnCalendar=hourly")" ] && [ "$(mode_of "$d/engram-monitor.timer")" = 644 ]'
  check "units: pre-existing timer enabled + active again, daemon-reload ran" \
    '[ "$(cat "$WORK/sysd/engram-monitor.timer.en")" = enabled ] && [ "$(cat "$WORK/sysd/engram-monitor.timer.act")" = active ] && grep -q "^daemon-reload" "$WORK/systemctl.log"'
  check "units: first-install timer disabled, stopped and its file removed" \
    '[ ! -e "$d/engram-backup-expire.timer" ] && [ "$(cat "$WORK/sysd/engram-backup-expire.timer.en")" = disabled ] && [ "$(cat "$WORK/sysd/engram-backup-expire.timer.act")" = inactive ]'
  check "units: first-install timer disabled BEFORE its file was removed" \
    '[ "$(grep -n "^disable engram-backup-expire.timer" "$WORK/systemctl.log" | cut -d: -f1)" -lt "$(grep -n "^daemon-reload" "$WORK/systemctl.log" | cut -d: -f1)" ]'

  # units (R2-02): disabled-but-active and disabled-inactive pre-existing timers round-trip exactly
  printf '[Timer]\nOnCalendar=daily\n' >"$d/engram-pitr-base.timer"
  printf '[Timer]\nOnCalendar=weekly\n' >"$d/engram-monitor.service"
  echo disabled >"$WORK/sysd/engram-pitr-base.timer.en"; echo active >"$WORK/sysd/engram-pitr-base.timer.act"
  echo disabled >"$WORK/sysd/engram-monitor.service.en"; echo inactive >"$WORK/sysd/engram-monitor.service.act"
  TS=20261108T130000Z bak_units engram-pitr-base.timer engram-monitor.service
  check "units: state file holds exactly one 'enabled active' word pair per unit" \
    '[ "$(cat "$STATE_DIR/engram-pitr-base.timer.state-20261108T130000Z")" = "disabled active" ] && [ "$(cat "$STATE_DIR/engram-monitor.service.state-20261108T130000Z")" = "disabled inactive" ]'
  TS=20261108T130000Z install_reviewed infra/backup/pitr/engram-pitr-base.timer "$d/engram-pitr-base.timer" 644
  systemctl --user enable engram-pitr-base.timer; systemctl --user stop engram-pitr-base.timer
  systemctl --user enable engram-monitor.service; systemctl --user start engram-monitor.service
  TS=20261108T130000Z restore_units engram-pitr-base.timer engram-monitor.service
  check "units: disabled-active timer restored disabled AND active with its prior file" \
    '[ "$(cat "$WORK/sysd/engram-pitr-base.timer.en")" = disabled ] && [ "$(cat "$WORK/sysd/engram-pitr-base.timer.act")" = active ] && [ "$(cat "$d/engram-pitr-base.timer")" = "$(printf "[Timer]\nOnCalendar=daily")" ]'
  check "units: disabled-inactive unit restored disabled and inactive" \
    '[ "$(cat "$WORK/sysd/engram-monitor.service.en")" = disabled ] && [ "$(cat "$WORK/sysd/engram-monitor.service.act")" = inactive ]'

  # compose overlay list (R2-05): order 2-PREP -> 4, and a 2-PREP reinstall keeps STEP-4
  local dd="$PROD/.data/deploy"
  : >"$dd/compose.prod-2prep.yml"
  compose_files_refresh
  check "compose: after 2-PREP the list is base + prod + 2prep" \
    '[ "$(cat "$dd/compose-files.txt")" = "-f infra/docker-compose.yml -f .data/deploy/compose.prod.yml -f .data/deploy/compose.prod-2prep.yml" ]'
  : >"$dd/compose.prod-step4.yml"
  compose_files_refresh
  compose_files_refresh # 2-PREP reinstall
  check "compose: after STEP-4 and a 2-PREP reinstall, STEP-4 stays last; cmd file matches" \
    '[ "$(cat "$dd/compose-files.txt")" = "-f infra/docker-compose.yml -f .data/deploy/compose.prod.yml -f .data/deploy/compose.prod-2prep.yml -f .data/deploy/compose.prod-step4.yml" ] && grep -q -- "--env-file .env.production $(cat "$dd/compose-files.txt")$" "$dd/compose-cmd.txt"'

  # STEP-4 precheck (R2-05/R2-06): first install only
  rm -f "$dd/compose.prod-step4.yml" "$dd/compose.prod-2prep.yml"
  check "step4_precheck: refuses without 2-PREP" '! step4_precheck 2>/dev/null'
  : >"$dd/compose.prod-2prep.yml"
  : >"$WORK/fake-role"
  check "step4_precheck: passes on a clean first install" 'step4_precheck'
  echo 1 >"$WORK/fake-role"
  check "step4_precheck: refuses when role engram_replication exists" '! step4_precheck 2>/dev/null'
  : >"$WORK/fake-role"
  mkdir -p "$HOME/engram-ops/pitr/secrets"; : >"$HOME/engram-ops/pitr/secrets/engram_replication.pgpass"
  check "step4_precheck: refuses when replication secrets exist" '! step4_precheck 2>/dev/null'
  rm -f "$HOME/engram-ops/pitr/secrets/engram_replication.pgpass"
  : >"$dd/compose.prod-step4.yml"
  check "step4_precheck: refuses when the STEP-4 overlay is already installed" '! step4_precheck 2>/dev/null'
  rm -f "$dd/compose.prod-step4.yml"

  # nginx, run from the production checkout dir (relative paths must not matter)
  export NGINX_CONF="$HOME/global-infra/nginx/conf.d/engram.conf"
  mkdir -p "$(dirname "$NGINX_CONF")"
  printf 'server { listen 80; }  # live\n' >"$NGINX_CONF"; chmod 644 "$NGINX_CONF"
  local orig; orig="$(cat "$NGINX_CONF")"
  : >"$WORK/docker.argv"
  (cd "$PROD" && step7_apply staged)
  check "nginx: staged apply writes the reviewed file with HSTS max-age=300 and keeps the live ACME block" \
    'grep -q "max-age=300" "$NGINX_CONF" && ! grep -q "max-age=31536000" "$NGINX_CONF" && grep -q "location ^~ /.well-known/acme-challenge/" "$NGINX_CONF" && grep -q "default_type text/plain" "$NGINX_CONF"'
  check "nginx: backup taken by absolute path with mode" '[ "$(cat "$NGINX_CONF.bak-$TS")" = "$orig" ] && [ "$(mode_of "$NGINX_CONF")" = 644 ]'
  check "nginx: nginx -t then reload, both inside global_nginx" \
    '[ "$(cat "$WORK/docker.argv")" = "$(printf "exec global_nginx nginx -t\nexec global_nginx nginx -s reload")" ]'
  (cd "$PROD" && step7_apply final)
  check "nginx: final apply = reviewed file byte-identical" 'cmp -s "$NGINX_CONF" "$REPO/infra/nginx/engram.conf"'
  : >"$WORK/docker.argv"
  (cd / && step7_rollback)
  check "nginx: rollback from another dir restores the pre-step live file and reloads inside global_nginx" \
    '[ "$(cat "$NGINX_CONF")" = "$orig" ] && [ "$(cat "$WORK/docker.argv")" = "$(printf "exec global_nginx nginx -t\nexec global_nginx nginx -s reload")" ]'
  touch "$WORK/nginx-t-fails"
  : >"$WORK/docker.argv"
  local rc=0
  (cd "$PROD" && step7_apply staged 2>/dev/null) || rc=$?
  rm -f "$WORK/nginx-t-fails"
  check "nginx: failed nginx -t -> non-zero, live file restored, no reload issued" \
    '[ "$rc" -ne 0 ] && [ "$(cat "$NGINX_CONF")" = "$orig" ] && ! grep -q "nginx -s reload" "$WORK/docker.argv"'
  # R2-04: the reviewed source cannot be read (bad SHA) -> live file byte/mode identical, no docker call at all.
  for m in staged final; do
    : >"$WORK/docker.argv"
    rc=0
    # operator shell defaults: no pipefail
    (set +o pipefail; SHA=0000000000000000000000000000000000000000; cd "$PROD" && step7_apply "$m" 2>/dev/null) || rc=$?
    check "nginx: failed source read ($m) -> non-zero, live file byte+mode identical, no nginx call" \
      '[ "$rc" -ne 0 ] && [ "$(cat "$NGINX_CONF")" = "$orig" ] && [ "$(mode_of "$NGINX_CONF")" = 644 ] && [ ! -s "$WORK/docker.argv" ] && ! ls "$NGINX_CONF".src-* "$NGINX_CONF".new-* >/dev/null 2>&1'
  done

  # build argv
  : >"$WORK/docker.argv"
  local out pg pitr
  out="$(step4_build 2>/dev/null)"
  pg="$(grep '^POSTGRES_IMAGE=' "$REPO/infra/image-pins.env" | cut -d= -f2-)"
  pitr="$(grep '^POSTGRES_PITR_IMAGE=' "$REPO/infra/image-pins.env" | cut -d= -f2-)"
  check "build: docker build -f Dockerfile.db --build-arg POSTGRES_IMAGE=<pin> -t <PITR pin>, prints the tag" \
    '[ "$out" = "$pitr" ] && grep -qE "^build -f /.*/infra/backup/pitr/Dockerfile.db --build-arg POSTGRES_IMAGE=$pg -t $pitr /" "$WORK/docker.argv"'
}

run_real() {
  local brc=0
  (
    # shellcheck disable=SC1090
    source "$LIB"
    pitr="$(step4_build)" || { echo "step4_build failed"; exit 1; }
    docker run --rm --network none --entrypoint sh "$pitr" -c \
      'command -v gpg >/dev/null && command -v gzip >/dev/null && test -x /etc/postgresql/engram-wal-archive.sh && test -f /etc/postgresql/postgresql-pitr.conf && gosu postgres gpg --batch --list-keys F2C47029212F6EE7A9D4D1779D5A1ABAB6A75AD7 >/dev/null'
  ) || brc=$?
  check "real: documented step4_build succeeds and the image has gpg, gzip, archive script, conf, public key" '[ "$brc" -eq 0 ]'

  local n="$WORK/nginx"
  mkdir -p "$n/conf.d" "$n/le"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=engram.zone17.click \
    -keyout "$n/le/privkey.pem" -out "$n/le/fullchain.pem" >/dev/null 2>&1
  cp "$REPO/infra/nginx/engram.conf" "$n/conf.d/engram.conf"
  # Live http context: the map lives in conf.d/zone17.conf on bro.
  printf 'map $http_upgrade $connection_upgrade {\n    default upgrade;\n    %s close;\n}\n' "''" >"$n/conf.d/zone17.conf"
  docker run --rm --network none -v "$n/conf.d:/etc/nginx/conf.d:ro" \
    -v "$n/le:/etc/letsencrypt/live/engram.zone17.click:ro" nginx:1.27.5-alpine nginx -t >"$WORK/nginx-t.log" 2>&1
  local rc=$?
  cat "$WORK/nginx-t.log"
  check "real: nginx -t (1.27.5) accepts infra/nginx/engram.conf with the live connection_upgrade map" '[ "$rc" -eq 0 ]'
}

case "$MODE" in
  unit) run_unit ;;
  real) run_real ;;
  all) run_real; run_unit ;;
  *) echo "usage: $0 [unit|real|all]"; exit 2 ;;
esac
printf 'test-prod-steps-lib: %s passed, %s failed\n' "$PASSES" "$FAILS"
rc=0
[ "$FAILS" -eq 0 ] || rc=1
echo
echo "OPSPROD_STEPLIB_EXIT=$rc"
exit "$rc"
