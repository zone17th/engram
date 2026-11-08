#!/usr/bin/env bash
# R1-01 proof (P06 Task 4): the base compose has no public EXPORT_AT_REST_SECRET
# fallback. Resolves base and base+production templates with synthetic values,
# asserts api and worker receive the SAME value, then boots the real worker
# binary config path with each resolved environment:
#   - dev/e2e (APP_ENV=development, key unset): boots past config (shared dev constant)
#   - production (APP_ENV=production, key unset): config.Load fails closed
#   - production with the dev constant as key: config.Load fails closed
# Requires docker (compose config only, no daemon contact) and go.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

synthetic() {
  local b
  b="$(head -c 48 /dev/urandom | base64 -w0)"
  printf '%s' "$b"
}

export APP_ORIGIN=https://example.invalid WEBAUTHN_RP_ID=example.invalid WEBAUTHN_RP_ORIGIN=https://example.invalid
export ENGRAM_DB_PASSWORD=x EMBEDDING_API_KEY=x
AUTH_CSRF_SECRET="$(synthetic)"; AUTH_EMAIL_PEPPER="$(synthetic)"; AUTH_IP_PEPPER="$(synthetic)"
AUTH_JWT_SECRET="$(synthetic)"; AUTH_REAUTH_SECRET="$(synthetic)"
export AUTH_CSRF_SECRET AUTH_EMAIL_PEPPER AUTH_IP_PEPPER AUTH_JWT_SECRET AUTH_REAUTH_SECRET
unset EXPORT_AT_REST_SECRET

resolve() { # $1 = out json, rest = -f files
  local out="$1"
  shift
  docker compose --env-file infra/image-pins.env "$@" config --format json >"$out"
}

resolve "$WORK/dev.json" -f infra/docker-compose.yml
resolve "$WORK/prod.json" -f infra/docker-compose.yml -f infra/deploy/compose.prod.yml

python3 - "$WORK" <<'PY'
import json, sys, os
work = sys.argv[1]
for name in ("dev", "prod"):
    cfg = json.load(open(os.path.join(work, name + ".json")))
    env = {s: cfg["services"][s]["environment"] for s in ("api", "worker")}
    a = env["api"].get("EXPORT_AT_REST_SECRET")
    w = env["worker"].get("EXPORT_AT_REST_SECRET")
    assert a == w, f"{name}: api/worker EXPORT_AT_REST_SECRET differ"
    assert a == "", f"{name}: compose injected a non-empty export key fallback: {a!r}"
    for s in ("api", "worker"):
        with open(os.path.join(work, f"{name}-{s}.env"), "w") as fh:
            for k, v in env[s].items():
                if v is None:
                    continue
                fh.write(f"{k}={v}\n")
    print(f"PASS [{name}]: api and worker resolve identical EXPORT_AT_REST_SECRET (empty, no public fallback)")
PY

(cd apps/api && go build -o "$WORK/worker" ./cmd/worker)

# Runs `worker help` (config.Load runs before dispatch; help exits 0 without DB).
boot() { # $1 env file, rest overrides
  local envf="$1"
  shift
  local -a vars=()
  while IFS= read -r line; do vars+=("$line"); done <"$envf"
  env -i PATH="$PATH" HOME="$WORK" "${vars[@]}" "$@" "$WORK/worker" help >"$WORK/out" 2>&1
}

if boot "$WORK/dev-worker.env"; then
  echo "PASS [dev boot]: development config loads with shared dev constant"
else
  cat "$WORK/out" >&2
  echo "FAIL [dev boot]" >&2
  exit 1
fi

if boot "$WORK/prod-worker.env" APP_ENV=production AUTH_MAIL_SINK_DIR= ; then
  echo "FAIL [prod missing key]: production config accepted an empty EXPORT_AT_REST_SECRET" >&2
  exit 1
fi
grep -q "EXPORT_AT_REST_SECRET" "$WORK/out" || { cat "$WORK/out" >&2; echo "FAIL [prod missing key]: wrong error" >&2; exit 1; }
echo "PASS [prod missing key]: production boot rejects missing EXPORT_AT_REST_SECRET"

dev_const_b64="$(printf '%s' 'engram-dev-export-at-rest-key32!' | base64 -w0)"
if boot "$WORK/prod-worker.env" APP_ENV=production AUTH_MAIL_SINK_DIR= EXPORT_AT_REST_SECRET="$dev_const_b64"; then
  echo "FAIL [prod dev constant]: production accepted the public development constant" >&2
  exit 1
fi
grep -q "EXPORT_AT_REST_SECRET" "$WORK/out" || { cat "$WORK/out" >&2; echo "FAIL [prod dev constant]: wrong error" >&2; exit 1; }
echo "PASS [prod dev constant]: production boot rejects the public development constant"
echo "OPSOBS_EXPORT_KEY_EXIT=0"
