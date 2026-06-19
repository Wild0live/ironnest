#!/usr/bin/env bash
# Build images for the hermes-platform stack.
#
# Run this manually when:
#   - openviking/Dockerfile, gateway/Dockerfile, or mission-control/Dockerfile changes
#   - Python deps in gateway/requirements.txt or mission-control/requirements.txt change
#   - hermes-platform/start.sh detects a missing image on first run
#
# Hermes profile containers REUSE the existing platform/hermes-agent
# image built by hermes/build.sh — this script does NOT rebuild Hermes.
#
# Usage:
#   bash hermes-platform/build.sh           # cache-friendly build
#   bash hermes-platform/build.sh --pull    # also pull fresh base layers
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

PLATFORM="$(cd "$(dirname "$0")/.." && pwd)"
STACK="$PLATFORM/hermes-platform"
cd "$STACK"

PULL=""
if [ "${1:-}" = "--pull" ]; then
    PULL="--pull"
fi

# Sanity: hermes-agent image must already exist (built by hermes/build.sh).
# Without it, the hermes-pf-* containers can't start.
HERMES_IMG="platform/hermes-agent:v2026.6.5-patched"
if ! docker image inspect "$HERMES_IMG" >/dev/null 2>&1; then
    echo "ERROR: required image $HERMES_IMG not found." >&2
    echo "       Run: bash $PLATFORM/hermes/build.sh" >&2
    echo "       Then re-run this script." >&2
    exit 1
fi

echo "--- building hermes-platform images $PULL ---"
docker compose build $PULL openviking memory-gateway mission-control

echo "--- build complete ---"
docker compose images openviking memory-gateway mission-control
