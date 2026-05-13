#!/usr/bin/env bash
# Build the hermes-agent image.
#
# Run this manually when:
#   - The Dockerfile changes
#   - The bundled Hermes Python package needs a refresh
#   - hermes/start.sh detects a missing image on first run (it calls this script)
#
# Subsequent starts use the cached image — hermes/start.sh does NOT build.
#
# Usage:
#   bash hermes/build.sh           # cache-friendly build
#   bash hermes/build.sh --pull    # also pull fresh base layers
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

PLATFORM="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PLATFORM/hermes"

PULL=""
if [ "${1:-}" = "--pull" ]; then
  PULL="--pull"
fi

echo "--- building hermes-agent image $PULL ---"
echo "    (first build: ~20 min — subsequent builds use Docker layer cache)"
docker compose build $PULL

echo "--- build complete ---"
docker compose images
