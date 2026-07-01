#!/usr/bin/env bash
# One-command install of the ad-injection test stack on your VPS.
# - Uses Docker Compose (installs Docker if missing)
# - DOES NOT touch your existing Redis, Nginx, or system files
# - Generates a random ADMIN_TOKEN if you don't set one
# - Everything lives inside this directory + two Docker containers
#
# Usage:
#   chmod +x install.sh && sudo ./install.sh
#   # or with a custom token:  ADMIN_TOKEN=mysecret sudo ./install.sh

set -euo pipefail

cd "$(dirname "$0")"

echo "==> checking Docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing Docker (official convenience script)"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "Docker Compose plugin missing. Install docker-compose-plugin."; exit 1; }

if [[ ! -f .env ]]; then
  TOKEN="${ADMIN_TOKEN:-$(head -c 36 /dev/urandom | base64 | tr -d '/+=' | head -c 48)}"
  cat > .env <<EOF
ADMIN_TOKEN=${TOKEN}
LIVE_HLS_URL=https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
CLUSTER_WORKERS=2
EOF
  echo "==> generated .env with ADMIN_TOKEN=${TOKEN}"
fi

echo "==> checking port availability (6778/6779/6780)"
for p in 6778 6779 6780; do
  if ss -tlnp 2>/dev/null | grep -q ":${p} "; then
    echo "!! Port ${p} is already in use. Edit docker-compose.yml to remap it before continuing." >&2
    exit 1
  fi
done

echo "==> building + starting containers"
docker compose up -d --build

echo
echo "===================================================="
echo " Ad Injection is up."
echo
IP=$(curl -s ifconfig.me || echo YOUR_VPS_IP)
TOKEN=$(grep ^ADMIN_TOKEN= .env | cut -d= -f2-)
echo " Viewer:  http://${IP}:6780/player/"
echo " Admin:   http://${IP}:6780/admin/"
echo " Token:   ${TOKEN}"
echo
echo " Logs:      docker compose logs -f"
echo " Stop all:  docker compose down"
echo " NUKE all:  ./uninstall.sh"
echo "===================================================="
