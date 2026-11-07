#!/usr/bin/env bash
# Self-contained HTTPS + production-build CSP E2E runner for clean cloud VMs (P06-T8, NF-02, R4-01).
# Generates an ephemeral self-signed loopback certificate in a temp directory (never logged or committed),
# installs host Chromium for Playwright (scripts/https-e2e.mjs:173-176 runs Playwright on the host),
# and executes `pnpm e2e:https` from the repository root.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=127.0.0.1 -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
export TLS_CERT_FILE="$tmp/cert.pem" TLS_KEY_FILE="$tmp/key.pem"

pnpm --filter @engram/web exec playwright install --with-deps chromium
pnpm e2e:https
