#!/usr/bin/env bash
# Compatibility entry point for Unix callers; the implementation is portable Node.
set -euo pipefail
exec node "$(dirname "$0")/smoke.mjs" "$@"
