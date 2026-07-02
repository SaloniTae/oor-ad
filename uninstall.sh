#!/usr/bin/env bash
# NUKE all traces. Does NOT touch host Redis/Nginx/other Docker projects.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> stopping and removing containers + volumes"
docker compose down -v --remove-orphans 2>/dev/null || true

echo "==> removing built images"
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '(^|/)ad-injection[-_]app|ad-injection[_-]app' | xargs -r docker image rm -f 2>/dev/null || true

echo "==> pruning build cache from this project"
docker builder prune -f --filter "label=com.docker.compose.project=$(basename "$PWD")" 2>/dev/null || true

if [[ "${1:-}" == "--purge" ]]; then
  D="$PWD"; cd ..; echo "==> deleting $D"; rm -rf "$D"
fi
echo "✓ done."
