#!/usr/bin/env bash
# Start the Hermes Agent stack.
# Run this instead of bare "docker compose up -d".
# Prerequisite: bootstrap.sh must have run (platform-net, platform-egress,
# Squid, AdGuard, and Infisical must be healthy).
#
# This script does NOT build. Rebuild with: bash hermes/build.sh (e.g., after
# Dockerfile changes). On first run, if the image is missing, this script
# invokes build.sh automatically.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

PLATFORM="$(cd "$(dirname "$0")/.." && pwd)"

# Repair Rancher Desktop NAT rules and platform-egress routing (idempotent).
"$PLATFORM/ops/fix-nat-prerouting.sh"
"$PLATFORM/ops/repair-egress.sh"

cd "$PLATFORM/hermes"

# First-run detection: if the hermes image isn't present locally, build it.
IMAGE="$(awk '/^[[:space:]]+image:/{print $2; exit}' docker-compose.yml)"
if [ -z "$IMAGE" ]; then
  echo "ERROR: could not parse image name from docker-compose.yml" >&2
  exit 1
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "--- hermes image $IMAGE not present, running build.sh first ---"
  "$(dirname "$0")/build.sh"
fi

echo "--- starting hermes stack ---"
# --no-build: skip BuildKit evaluation entirely. Compose would otherwise inspect
# the build: context even when the image exists, which hangs for many minutes
# under WSL2 cold-start I/O pressure. Rebuilds are explicit via build.sh.
docker compose up -d --no-build

# Block direct outbound from the hermes_ingress bridge at the kernel level.
# Must run after compose up so hermes_ingress network exists.
"$PLATFORM/ops/fix-hermes-egress.sh"

echo "--- waiting for hermes-ttyd and hermes-gateway to be healthy ---"
until [ "$(docker inspect -f '{{.State.Health.Status}}' hermes-ttyd 2>/dev/null)" = "healthy" ] \
   && [ "$(docker inspect -f '{{.State.Health.Status}}' hermes-gateway 2>/dev/null)" = "healthy" ]; do
  printf '.'
  sleep 5
done
echo " healthy"

echo ""
echo "=== Hermes Agent is ready ==="
echo "  Browser terminal:  http://127.0.0.1:7682"
echo "  Via Traefik:       https://hermes.ironnest.local"
echo "  Gateway:           hermes-gateway (Compose-managed)"
echo ""
echo "  Credentials: Infisical → project 'hermes' → HERMES_TTYD_USERNAME / HERMES_TTYD_PASSWORD"
echo ""
echo "  First-run: open the terminal and run: hermes setup"
echo "  Migrating from OpenClaw: hermes claw migrate"
echo ""

echo "--- verifying direct egress is blocked from hermes_ingress bridge ---"
if docker exec hermes-ttyd curl --noproxy "*" -m 5 -sf https://example.com -o /dev/null 2>/dev/null; then
  echo "WARNING: direct bypass reachable from hermes-ttyd — check iptables rules"
else
  echo "OK: direct egress blocked from hermes-ttyd"
fi
