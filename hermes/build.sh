#!/usr/bin/env bash
# Build the platform/hermes-agent image used by hermes-platform stack.
#
# This image is shared between all hermes-pf-* containers and hermes-platform-ttyd.
# The legacy hermes/ docker-compose.yml has been removed (2026-05-31) — hermes-platform
# is the sole agent stack. This script only builds the image.
#
# Run this when:
#   - The Dockerfile changes (e.g. version bump: update HERMES_TAG + image tag)
#   - hermes-platform/start.sh detects a missing image on first run
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

IMAGE=$(grep '^ARG HERMES_TAG=' Dockerfile | head -1 | cut -d= -f2)
echo "--- building platform/hermes-agent:${IMAGE}-patched $PULL ---"
echo "    (first build: ~20 min — subsequent builds use Docker layer cache)"
docker build $PULL -t "platform/hermes-agent:${IMAGE}-patched" .

echo "--- build complete ---"
docker image inspect "platform/hermes-agent:${IMAGE}-patched" --format '{{.RepoTags}} {{.Size}} bytes'
