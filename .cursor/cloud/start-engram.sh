#!/usr/bin/env bash
# Every-round start on a Cursor cloud runner VM for zone17th/engram:
# ensures dockerd is running (falling back to background dockerd when systemd is
# absent), makes Docker usable without sudo for spec commands, and creates
# .data/mail-sink. Fails loudly with a clear message on error.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$(git rev-parse --show-toplevel)"
export PATH=/usr/local/go/bin:$HOME/go/bin:$PATH

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

if ! command -v docker >/dev/null 2>&1; then
  echo "FATAL: docker binary not found on PATH ($PATH); run $here/provision-engram.sh first" >&2
  exit 1
fi

if ! $SUDO docker info >/dev/null 2>&1; then
  if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
    $SUDO systemctl start docker >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    $SUDO service docker start >/dev/null 2>&1 || true
  fi
fi

if ! $SUDO docker info >/dev/null 2>&1; then
  if ! pgrep -x dockerd >/dev/null 2>&1; then
    $SUDO sh -c 'nohup dockerd > /tmp/dockerd.log 2>&1 &'
  fi
  ready=0
  for _ in $(seq 1 30); do
    if $SUDO docker info >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "FATAL: dockerd did not become ready within 30s" >&2
    if [ -f /tmp/dockerd.log ]; then
      tail -n 40 /tmp/dockerd.log >&2 || true
    fi
    exit 1
  fi
fi

$SUDO usermod -aG docker "$(id -un)" 2>/dev/null || true
if [ -S /var/run/docker.sock ]; then
  $SUDO chmod 0666 /var/run/docker.sock
fi

if ! docker info >/dev/null 2>&1; then
  echo "FATAL: docker info failed without sudo after chmod 0666 /var/run/docker.sock" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "FATAL: docker compose plugin is not available" >&2
  exit 1
fi

mkdir -p .data/mail-sink
chmod 0777 .data/mail-sink 2>/dev/null || $SUDO chmod 0777 .data/mail-sink

echo "cloud start (engram): dockerd ready, .data/mail-sink prepared"
