#!/usr/bin/env bash
# Bring up the always-on stacks in dependency order.
# Safe to re-run — all docker commands are idempotent.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

PLATFORM="$(cd "$(dirname "$0")" && pwd)"
cd "$PLATFORM"

echo "=== platform bootstrap starting from $PLATFORM ==="

# 1. Shared networks ─────────────────────────────────────────────────────────
# platform-net: internal=true, every stack joins this for DNS (AdGuard) and
#               service-to-service discovery.
# platform-egress: not internal. Only services that cannot use the HTTP proxy
#                  (SMTP, AdGuard DoH upstream, Wazuh raw feeds, Squid itself).
echo "--- ensuring shared networks exist ---"
docker network inspect platform-net >/dev/null 2>&1 \
  || docker network create --driver bridge --internal --subnet 172.30.0.0/24 platform-net

docker network inspect platform-egress >/dev/null 2>&1 \
  || docker network create --driver bridge --subnet 172.31.0.0/24 platform-egress

# 2. Always-on stacks, dependency order ──────────────────────────────────────
# socket-proxy first (Dozzle/Wazuh/Trivy depend on it).
# adguard next (DNS — everything else uses it).
# egress-proxy after adguard (needs DNS to resolve its access.log ACLs).
# secrets (Infisical) — slow to start, so earlier is better.
# wazuh, dozzle after — non-blocking for others.
STACKS=(
  "security/socket-proxy"
  "security/adguard"
  "security/egress-proxy"
  "secrets"
  "observability/dozzle"
  "security/wazuh"
  "security/trivy"
)

for stack in "${STACKS[@]}"; do
  if [[ -f "$stack/docker-compose.yml" ]]; then
    echo "--- starting $stack ---"
    ( cd "$stack" && docker compose up -d )
  else
    echo "--- skipping $stack (no docker-compose.yml yet) ---"
  fi

  # After secrets stack: fix Rancher Desktop's sshPortForwarder DNAT rules that
  # hijack intra-bridge TCP, then verify and repair platform-egress routing.
  if [[ "$stack" == "secrets" ]]; then
    echo "--- fixing Rancher Desktop sshPortForwarder NAT rules ---"
    "$PLATFORM/ops/fix-nat-prerouting.sh"
    echo "--- verifying platform-egress bridge routing ---"
    "$PLATFORM/ops/repair-egress.sh"
  fi
done

echo
echo "=== bootstrap complete ==="
echo "OpenClaw is on-demand — start it with: ./openclaw/start.sh"
echo "Status across all stacks: ./ops/status.sh"
