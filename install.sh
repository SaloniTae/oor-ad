#!/usr/bin/env bash
# One-command install. Does NOT touch host Redis/Nginx. All in Docker.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "==> installing Docker"; curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "Install docker-compose-plugin."; exit 1; }

if [[ ! -f .env ]]; then
  JWT=$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 48)
  ADMIN_PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 24)
  IP=$(curl -s ifconfig.me || echo localhost)
  cat > .env <<EOF
PUBLIC_URL=http://${IP}:6780
JWT_SECRET=${JWT}
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PW}
RATE_LIMIT_RPM=120
MAX_UPLOAD_MB=200
EOF
  echo "==> generated .env"
fi

if ss -tlnp 2>/dev/null | grep -q ":6780 "; then
  echo "!! Port 6780 already in use. Edit docker-compose.yml (ports:) to remap." >&2
  exit 1
fi

echo "==> build + start"
docker compose up -d --build

IP=$(grep ^PUBLIC_URL= .env | cut -d= -f2-)
EMAIL=$(grep ^BOOTSTRAP_ADMIN_EMAIL= .env | cut -d= -f2-)
PW=$(grep ^BOOTSTRAP_ADMIN_PASSWORD= .env | cut -d= -f2-)
echo
echo "===================================================="
echo " Ad Injection v2 is up."
echo
echo " Admin:      ${IP}/admin/"
echo " API Docs:   ${IP}/docs/"
echo " Health:     ${IP}/health"
echo
echo " Bootstrap login:"
echo "   email:    ${EMAIL}"
echo "   password: ${PW}"
echo
echo " Change password after first login."
echo
echo " Logs:       docker compose logs -f"
echo " Stop:       docker compose down"
echo " NUKE all:   ./uninstall.sh"
echo "===================================================="
