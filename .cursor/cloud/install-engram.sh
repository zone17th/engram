#!/usr/bin/env bash
# First-use install on a Cursor cloud runner VM for zone17th/engram:
# provisions system toolchains, starts dockerd, installs workspace JS and Go
# dependencies, and warms the pinned Postgres + Playwright images from
# infra/image-pins.env. Idempotent; acts on the current git checkout.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$(git rev-parse --show-toplevel)"

bash "$here/provision-engram.sh"
export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH

bash "$here/start-engram.sh"

pnpm install --frozen-lockfile

(cd apps/api && go mod download)

if [ -f infra/image-pins.env ]; then
  set -a
  # shellcheck disable=SC1091
  . infra/image-pins.env
  set +a
  for img in "${POSTGRES_IMAGE:-}" "${PLAYWRIGHT_IMAGE:-}"; do
    [ -n "$img" ] || continue
    docker image inspect "$img" >/dev/null 2>&1 || docker pull "$img"
  done
fi

echo "cloud install (engram): done"
