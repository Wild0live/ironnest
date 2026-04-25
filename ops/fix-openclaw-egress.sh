#!/usr/bin/env bash
# Blocks direct outbound NEW connections from the openclaw_ingress bridge.
#
# Why this is needed:
#   openclaw_ingress is a non-internal Docker bridge — its only purpose is to
#   let Docker publish 127.0.0.1:18789 to the host. Without enforcement, a
#   process inside openclaw-gateway that ignores HTTP_PROXY (e.g. curl --noproxy)
#   can reach the internet directly through this bridge's default route.
#
# How the rule works:
#   iptables DOCKER-USER -i <ingress-bridge> --ctstate NEW -j DROP
#
#   - Drops any NEW connection initiated FROM the container on the ingress bridge.
#   - ESTABLISHED/RELATED packets (responses to the host browser's inbound
#     requests on port 18789) are not NEW, so they pass through unaffected.
#   - Inbound host->container DNAT traffic arrives on lo, not br-*, so it is
#     also unaffected.
#
# Must run AFTER openclaw stack is up (openclaw_ingress network must exist).
# Called by: openclaw/start.sh
# Idempotent: checks for the rule before inserting.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

log() { echo "[fix-openclaw-egress] $*"; }

# Resolve the Linux bridge interface name for openclaw_ingress.
# Docker names it br-<first-12-chars-of-network-id>.
NETWORK_ID=$(docker network inspect openclaw_ingress --format '{{.Id}}' 2>/dev/null || true)
if [ -z "$NETWORK_ID" ]; then
  log "ERROR: openclaw_ingress network not found — is the openclaw stack running?"
  exit 1
fi
BR="br-${NETWORK_ID:0:12}"
log "openclaw_ingress bridge: $BR"

docker_iptables() {
  docker run --rm --cap-add NET_ADMIN --network host alpine \
    sh -c "apk add -q iptables 2>/dev/null && $*"
}

log "checking DOCKER-USER for outbound-block rule..."
if docker_iptables "iptables -C DOCKER-USER -i $BR -m conntrack --ctstate NEW -j DROP 2>/dev/null"; then
  log "rule already present — nothing to do"
  exit 0
fi

log "inserting outbound-block rule for $BR..."
docker_iptables "iptables -I DOCKER-USER 1 -i $BR -m conntrack --ctstate NEW -j DROP"

log "verifying..."
docker_iptables "iptables -C DOCKER-USER -i $BR -m conntrack --ctstate NEW -j DROP 2>/dev/null"
log "direct egress from openclaw_ingress is now blocked"
