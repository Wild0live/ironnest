#!/usr/bin/env bash
# Inserts a RETURN rule in nat/PREROUTING that exempts container-origin traffic
# from Rancher Desktop's sshPortForwarder DNAT rules.
#
# Root cause:
#   Rancher Desktop (sshPortForwarder: true) injects bare DNAT rules into the
#   Docker namespace's nat/PREROUTING chain to support Windows-to-container port
#   access via an SSH tunnel:
#
#     DNAT tcp -- * * 0.0.0.0/0  0.0.0.0/0  tcp dpt:8080 to:127.0.0.1:8080
#
#   These rules have NO interface or source restriction, so they intercept ALL
#   TCP to those ports — including intra-bridge container-to-container traffic.
#   Packets are DNATted to 127.0.0.1 (the SSH tunnel), which never responds to
#   intra-bridge callers, causing TCP timeouts. ICMP is unaffected (no DNAT).
#
# Fix:
#   Prepend a RETURN rule that short-circuits PREROUTING for traffic originating
#   from within Docker's container address space (172.16.0.0/12). The SSH tunnel
#   connects from 127.0.0.1, which is outside this range, so Windows port
#   publishing continues to work unchanged.
#
# Called by: bootstrap.sh (after secrets stack), openclaw/start.sh
# Idempotent: checks for the rule before adding it.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

log() { echo "[fix-nat-prerouting] $*"; }

# Run iptables inside Docker's network namespace via a host-network container
# (docker run --network host is in the same netns as the Docker bridges).
docker_iptables() {
  docker run --rm --cap-add NET_ADMIN --network host alpine \
    sh -c "apk add -q iptables 2>/dev/null && $*"
}

log "checking nat/PREROUTING for container-traffic RETURN rule..."

# Check idempotently (iptables -C returns 0 if rule exists)
if docker_iptables 'iptables -t nat -C PREROUTING -s 172.16.0.0/12 -j RETURN 2>/dev/null'; then
  log "RETURN rule already present — nothing to do"
  exit 0
fi

log "inserting RETURN rule for container traffic (172.16.0.0/12)..."
docker_iptables 'iptables -t nat -I PREROUTING 1 -s 172.16.0.0/12 -j RETURN'

log "verifying..."
docker_iptables 'iptables -t nat -C PREROUTING -s 172.16.0.0/12 -j RETURN 2>/dev/null'
log "rule in place"
