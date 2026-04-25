#!/usr/bin/env bash
# Scan local Docker images for vulnerabilities via the Trivy stack.
# Reports are written to G:\rancher-stack-backups\trivy\<YYYY-MM-DD>\
#
# Usage:
#   ./scan.sh all              # scan every local image
#   ./scan.sh <image>[:<tag>]  # scan one image
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

STACK_DIR="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
WIN_REPORT_DIR="G:/rancher-stack-backups/trivy/$STAMP"
mkdir -p "/g/rancher-stack-backups/trivy/$STAMP"

cd "$STACK_DIR"

# Resolve image list
if [[ "${1:-all}" == "all" ]]; then
  IMAGES=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>')
else
  IMAGES="$1"
fi

echo "=== scanning images → $WIN_REPORT_DIR ==="
for img in $IMAGES; do
  safe="$(echo "$img" | tr '/:' '__')"
  echo "--- $img ---"
  # MSYS_NO_PATHCONV=1 prevents Git Bash from mangling the container-internal
  # /reports/... path into C:/Program Files/Git/reports/...
  MSYS_NO_PATHCONV=1 docker compose run --rm scanner image \
    --severity HIGH,CRITICAL \
    --format json \
    -o "/reports/$STAMP/$safe.json" \
    "$img" || echo "  (skipped — see logs)"
  MSYS_NO_PATHCONV=1 docker compose run --rm scanner image \
    --severity HIGH,CRITICAL \
    --format table \
    -o "/reports/$STAMP/$safe.txt" \
    "$img" || true
done

echo
echo "=== scan complete ==="
echo "Reports at: $WIN_REPORT_DIR"
ls -la "/g/rancher-stack-backups/trivy/$STAMP/"
