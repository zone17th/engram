#!/usr/bin/env bash
# Every-round start on a Cursor cloud runner VM for zone17th/engram:
# ensures dockerd is running with non-overlapping bridge address pools and
# permissive bridge forwarding (Cursor VMs may run inside an outer 172.18.0.0/16
# network or have br_netfilter/iptables-nft drop inter-container bridge traffic),
# makes Docker usable without sudo for spec commands, verifies container-to-
# container TCP on a custom bridge when NODE_IMAGE is present, and prepares
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

# Configure non-overlapping RFC1918 pools (10.249.0.0/16 + 10.250.0.0/16) so
# user-defined compose bridges never collide with a 172.18.0.0/16 outer VM route
# while remaining inside AUTH_TRUSTED_PROXY_CIDRS (10.0.0.0/8).
daemon_cfg='{"bip":"10.249.0.1/24","default-address-pools":[{"base":"10.250.0.0/16","size":24}]}'
need_restart=0
$SUDO mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ] || ! grep -q '10\.250\.0\.0/16' /etc/docker/daemon.json 2>/dev/null; then
  printf '%s\n' "$daemon_cfg" | $SUDO tee /etc/docker/daemon.json >/dev/null
  need_restart=1
fi

apply_net_fixes() {
  $SUDO sysctl -qw net.ipv4.ip_forward=1 2>/dev/null || true
  $SUDO sysctl -qw net.bridge.bridge-nf-call-iptables=0 2>/dev/null || true
  $SUDO sysctl -qw net.bridge.bridge-nf-call-ip6tables=0 2>/dev/null || true
  for ipt in iptables iptables-legacy iptables-nft; do
    command -v "$ipt" >/dev/null 2>&1 || continue
    $SUDO "$ipt" -P FORWARD ACCEPT 2>/dev/null || true
    $SUDO "$ipt" -C FORWARD -j ACCEPT 2>/dev/null || $SUDO "$ipt" -I FORWARD 1 -j ACCEPT 2>/dev/null || true
    $SUDO "$ipt" -C DOCKER-USER -j ACCEPT 2>/dev/null || $SUDO "$ipt" -I DOCKER-USER 1 -j ACCEPT 2>/dev/null || true
  done
}

stop_dockerd() {
  if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
    $SUDO systemctl stop docker docker.socket 2>/dev/null || true
  elif command -v service >/dev/null 2>&1; then
    $SUDO service docker stop 2>/dev/null || true
  fi
  if pgrep -x dockerd >/dev/null 2>&1; then
    $SUDO pkill -x dockerd 2>/dev/null || true
    for _ in $(seq 1 15); do
      pgrep -x dockerd >/dev/null 2>&1 || break
      sleep 1
    done
  fi
}

start_dockerd() {
  apply_net_fixes
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
    local ready=0
    for _ in $(seq 1 30); do
      if $SUDO docker info >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 1
    done
    if [ "$ready" -ne 1 ]; then
      echo "FATAL: dockerd did not become ready within 30s" >&2
      [ -f /tmp/dockerd.log ] && tail -n 40 /tmp/dockerd.log >&2 || true
      exit 1
    fi
  fi
  apply_net_fixes
  $SUDO usermod -aG docker "$(id -un)" 2>/dev/null || true
  [ -S /var/run/docker.sock ] && $SUDO chmod 0666 /var/run/docker.sock
}

if [ "$need_restart" -eq 1 ] && $SUDO docker info >/dev/null 2>&1; then
  # Remove any stale 172.18.0.0/16 compose networks before restarting dockerd.
  $SUDO docker network prune -f >/dev/null 2>&1 || true
  stop_dockerd
fi

start_dockerd

if ! docker info >/dev/null 2>&1; then
  echo "FATAL: docker info failed without sudo after chmod 0666 /var/run/docker.sock" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "FATAL: docker compose plugin is not available" >&2
  exit 1
fi

# Verify container-to-container TCP on a custom bridge when NODE_IMAGE is cached.
if [ -f infra/image-pins.env ]; then
  # shellcheck disable=SC1091
  . infra/image-pins.env
  if [ -n "${NODE_IMAGE:-}" ] && docker image inspect "$NODE_IMAGE" >/dev/null 2>&1; then
    probe_bridge() {
      docker rm -f engram-probe-srv engram-probe-cli >/dev/null 2>&1 || true
      docker network rm engram-probe-net >/dev/null 2>&1 || true
      docker network create engram-probe-net >/dev/null 2>&1 || return 1
      docker run -d --rm --name engram-probe-srv --network engram-probe-net "$NODE_IMAGE" \
        node -e "require('net').createServer(s=>s.end('ok')).listen(5432,'0.0.0.0')" >/dev/null 2>&1 || return 1
      local srv_ip
      srv_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' engram-probe-srv 2>/dev/null || true)
      local ok=1
      if docker run --rm --name engram-probe-cli --network engram-probe-net "$NODE_IMAGE" \
        node -e "const net=require('net'),deadline=Date.now()+4000,host='${srv_ip:-engram-probe-srv}';(function dial(){const s=net.connect(5432,host,()=>{s.on('data',()=>process.exit(0))});s.on('error',()=>{if(Date.now()>=deadline)process.exit(1);setTimeout(dial,100)});setTimeout(()=>process.exit(1),4000)})()" >/dev/null 2>&1; then
        ok=0
      fi
      docker rm -f engram-probe-srv engram-probe-cli >/dev/null 2>&1 || true
      docker network rm engram-probe-net >/dev/null 2>&1 || true
      return "$ok"
    }
    if ! probe_bridge; then
      if command -v iptables-legacy >/dev/null 2>&1 && command -v update-alternatives >/dev/null 2>&1; then
        $SUDO update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1 || true
        $SUDO update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null 2>&1 || true
        stop_dockerd
        start_dockerd
      fi
      if ! probe_bridge; then
        echo "FATAL: inter-container TCP on user-defined bridge failed; routes=$(ip route | tr '\n' ';') forward=$($SUDO iptables -S FORWARD 2>&1 | tr '\n' ';')" >&2
        exit 1
      fi
    fi
  fi
fi

mkdir -p .data/mail-sink
chmod 0777 .data/mail-sink 2>/dev/null || $SUDO chmod 0777 .data/mail-sink

echo "cloud start (engram): dockerd ready, bridge verified, .data/mail-sink prepared"
