#!/usr/bin/env bash
# Self-contained HTTPS + production-build CSP E2E runner for clean cloud VMs (P06-T8, NF-02, R4-01, R1-BE-06).
# Bootstraps non-production E2E environment defaults from .env.example without relying on a pre-existing .env
# or real secrets, generates an ephemeral self-signed loopback certificate in a temp directory (never logged
# or committed) cleaned up via trap EXIT, installs host Chromium for Playwright (scripts/https-e2e.mjs:173-176),
# and executes `pnpm e2e:https` from the repository root.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if [ -f .env.example ]; then
  while IFS='=' read -r key val || [ -n "$key" ]; do
    key="${key%$'\r'}"
    val="${val%$'\r'}"
    case "$key" in
      ''|\#*) continue ;;
    esac
    if [ -z "${!key+x}" ]; then
      export "$key=$val"
    fi
  done < .env.example
fi

export APP_ENV="${APP_ENV:-development}"
export DATABASE_URL="${DATABASE_URL:-postgres://engram:engram@localhost:5432/engram?sslmode=disable}"
export NEXT_PUBLIC_CONTENT_ENABLED="${NEXT_PUBLIC_CONTENT_ENABLED:-true}"
# scripts/https-e2e.mjs sets APP_ORIGIN=https://127.0.0.1:13443; keep WEBAUTHN_RP_ID/ORIGIN empty so
# config.Load() derives 127.0.0.1 from APP_ORIGIN instead of rejecting .env.example's "localhost".
export WEBAUTHN_RP_ID=""
export WEBAUTHN_RP_ORIGIN=""

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
export TLS_CERT_FILE="$tmp/cert.pem" TLS_KEY_FILE="$tmp/key.pem"

pnpm --filter @engram/web exec playwright install --with-deps chromium
pnpm e2e:https
