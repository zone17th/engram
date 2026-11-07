#!/usr/bin/env bash
# First-use install on a Cursor cloud runner VM for zone17th/engram:
# provisions system toolchains, starts dockerd, installs workspace JS and Go
# dependencies, warms the pinned images from infra/image-pins.env, and verifies
# inter-container bridge networking. Idempotent; acts on the current checkout.
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
  for img in "${NODE_IMAGE:-}" "${POSTGRES_IMAGE:-}" "${PLAYWRIGHT_IMAGE:-}"; do
    [ -n "$img" ] || continue
    docker image inspect "$img" >/dev/null 2>&1 || docker pull "$img"
  done
fi

# Re-run start-engram.sh now that NODE_IMAGE is pulled so the inter-container
# bridge probe runs and verifies container-to-container TCP connectivity.
bash "$here/start-engram.sh"

echo "cloud install (engram): done"
