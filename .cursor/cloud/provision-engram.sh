#!/usr/bin/env bash
# System toolchain and Docker Engine for a Cursor cloud agent running zone17th/engram,
# matching .github/workflows/ci.yml. Shared by install-engram.sh and run-tests.sh on
# provision drift, so every step is idempotent.
# Runs as root or as a user with passwordless sudo.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || (cd "$here" && git rev-parse --show-toplevel 2>/dev/null) || pwd)

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"
MARKERS=/var/lib/engram-cloud
$SUDO mkdir -p "$MARKERS"

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) go_arch=amd64 ;;
  aarch64|arm64) go_arch=arm64 ;;
  *) echo "provision-engram.sh: unsupported architecture: $arch" >&2; exit 1 ;;
esac

# CI's setup-go version (1.27.3) wins over apps/api/go.mod's minimum (1.26.0).
GO_VERSION_DEFAULT=1.27.3
GO_VERSION=""
if [ -f "$repo_root/.github/workflows/ci.yml" ]; then
  GO_VERSION=$(sed -n "s/^[[:space:]]*go-version:[[:space:]]*['\"]\?\([0-9.]*\)['\"]\?.*/\1/p" "$repo_root/.github/workflows/ci.yml" | head -n1)
fi
GO_VERSION=${GO_VERSION:-$GO_VERSION_DEFAULT}

NODE_MAJOR=22

PNPM_VERSION_DEFAULT=10.34.5
PNPM_VERSION=""
if [ -f "$repo_root/package.json" ]; then
  PNPM_VERSION=$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([0-9.]*\)".*/\1/p' "$repo_root/package.json" | head -n1)
fi
PNPM_VERSION=${PNPM_VERSION:-$PNPM_VERSION_DEFAULT}

GOLANGCI_LINT_VERSION=v2.14.0
GOVULNCHECK_VERSION=v1.9.0
SQLC_VERSION=v1.30.0

# Postgres 16 + pgvector run inside Docker containers for every CI job
# (Testcontainers for integration/perf, docker compose for migrate/e2e, and the
# pinned pgvector image for search-bench), so no host PostgreSQL server is needed.
packages=(
  ca-certificates curl git gnupg sudo make jq unzip xz-utils
  build-essential pkg-config tzdata procps lsof
)
missing=()
for p in "${packages[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
done
if [ "${#missing[@]}" -gt 0 ]; then
  $SUDO apt-get update -q
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}"
fi

# Docker Engine + Compose plugin from Docker's official Ubuntu apt repository.
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  $SUDO install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | $SUDO tee /etc/apt/keyrings/docker.asc >/dev/null
    $SUDO chmod a+r /etc/apt/keyrings/docker.asc
  fi
  # shellcheck disable=SC1091
  codename=$(. /etc/os-release && echo "${VERSION_CODENAME:-noble}")
  dpkg_arch=$(dpkg --print-architecture)
  echo "deb [arch=${dpkg_arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" \
    | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  $SUDO apt-get update -q
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

if [ "$(/usr/local/go/bin/go env GOVERSION 2>/dev/null)" != "go${GO_VERSION}" ]; then
  $SUDO rm -rf /usr/local/go
  curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz" | $SUDO tar -C /usr/local -xz
fi
# shellcheck disable=SC2016
echo 'export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH' | $SUDO tee /etc/profile.d/engram-go.sh >/dev/null
export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH

case "$(node --version 2>/dev/null)" in
  "v${NODE_MAJOR}."*) ;;
  *)
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO bash -
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs
    ;;
esac

if [ "$(pnpm --version 2>/dev/null)" != "$PNPM_VERSION" ]; then
  $SUDO npm install -g "pnpm@${PNPM_VERSION}"
fi

if ! golangci-lint --version 2>/dev/null | grep -qF "${GOLANGCI_LINT_VERSION#v}"; then
  # GitHub release-asset CDN can 504 while proxy.golang.org stays up; fall back
  # to `go install` so provisioning survives the outage (exportbe r1 round).
  if ! (set -o pipefail; curl -fsSL https://raw.githubusercontent.com/golangci/golangci-lint/HEAD/install.sh \
    | $SUDO sh -s -- -b /usr/local/bin "$GOLANGCI_LINT_VERSION"); then
    echo "golangci-lint tarball fetch failed; installing via go install"
    GOBIN="$(go env GOPATH)/bin" go install "github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${GOLANGCI_LINT_VERSION}"
    $SUDO ln -sf "$(go env GOPATH)/bin/golangci-lint" /usr/local/bin/golangci-lint
  fi
fi

mkdir -p "$HOME/go/bin"
if ! go version -m "$(command -v govulncheck 2>/dev/null || true)" 2>/dev/null \
  | grep -qE "^[[:space:]]*mod[[:space:]]+golang\.org/x/vuln[[:space:]]+${GOVULNCHECK_VERSION}([[:space:]]|$)"; then
  go install "golang.org/x/vuln/cmd/govulncheck@${GOVULNCHECK_VERSION}"
fi

if ! go version -m "$(command -v sqlc 2>/dev/null || true)" 2>/dev/null \
  | grep -qE "^[[:space:]]*mod[[:space:]]+github\.com/sqlc-dev/sqlc[[:space:]]+${SQLC_VERSION}([[:space:]]|$)"; then
  go install "github.com/sqlc-dev/sqlc/cmd/sqlc@${SQLC_VERSION}"
fi

echo "cloud provision (engram): done ($(go env GOVERSION), node $(node --version), pnpm $(pnpm --version), $(docker --version), $(golangci-lint --version | head -n1))"
