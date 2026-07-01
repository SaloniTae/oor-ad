#!/usr/bin/env bash
# NUKE the ad-injection test stack. Removes:
#   - containers (adinj-app, adinj-redis)
#   - the isolated Docker network
#   - the built image
#   - any anonymous volumes (there are none by default, but -v is used anyway)
# Does NOT touch your host Redis, Nginx, other Docker projects, or system files.
#
# Usage:
#   sudo ./uninstall.sh              # containers + image gone, source dir kept
#   sudo ./uninstall.sh --purge      # ALSO delete this whole directory

set -euo pipefail
cd "$(dirname "$0")"

echo "==> stopping and removing containers, network, volumes"
docker compose down -v --remove-orphans 2>/dev/null || true

echo "==> removing built image"
docker image rm -f ad-injection-app 2>/dev/null || true
# Fallback: any image tagged from this compose project
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '(^|/)ad-injection[-_]app' | xargs -r docker image rm -f 2>/dev/null || true

echo "==> pruning dangling build cache from this project"
docker builder prune -f --filter "label=com.docker.compose.project=$(basename "$PWD")" 2>/dev/null || true

if [[ "${1:-}" == "--purge" ]]; then
  D="$PWD"
  cd ..
  echo "==> deleting source directory: $D"
  rm -rf "$D"
fi

echo "✓ done. Nothing else on the VPS was touched."
