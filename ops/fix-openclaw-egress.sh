#!/usr/bin/env bash
# Two-part fix for openclaw_ingress networking:
#
# Part 1 — raw/PREROUTING: unblock intra-bridge container→gateway traffic.
#
#   Rancher Desktop inserts per-container DROP rules in raw/PREROUTING:
#     DROP all -- !br-<id> * 0.0.0.0/0 <container-ip>
#   These fire before conntrack/FORWARD. When openclaw-ttyd sends a packet to
#   openclaw-gateway, it enters PREROUTING with the veth (not the bridge) as
#   input interface, so !br-<id> matches and the SYN is silently dropped.
#   Fix: prepend RETURN for ingress-subnet → gateway-ip.
#
# Part 2 — filter/DOCKER-USER: block direct outbound from the ingress bridge.
#
#   openclaw_ingress is a non-internal Docker bridge — its only purpose is to
#   let Docker publish 127.0.0.1:18789 and 127.0.0.1:7681 to the host.
#   Without enforcement, a process inside a container that ignores HTTP_PROXY
#   can reach the internet directly through this bridge's default route.
#   Rules:
#     ACCEPT -i <br> -d <ingress-subnet> --ctstate NEW   (intra-bridge)
#     LOG    -i <br>                     --ctstate NEW   (direct-egress attempts, rate-limited)
#     DROP   -i <br>                     --ctstate NEW   (outbound)
#
# Must run AFTER openclaw stack is up (openclaw_ingress network must exist).
# Called by: openclaw/start.sh
# Idempotent: each rule is checked before inserting.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

log() { echo "[fix-openclaw-egress] $*"; }

docker_iptables() {
  docker run --rm --cap-add NET_ADMIN --network host alpine \
    sh -c "apk add -q iptables 2>/dev/null && $*"
}

# Resolve the Linux bridge interface name for openclaw_ingress.
# Docker names it br-<first-12-chars-of-network-id>.
NETWORK_ID=$(docker network inspect openclaw_ingress --format '{{.Id}}' 2>/dev/null || true)
if [ -z "$NETWORK_ID" ]; then
  log "ERROR: openclaw_ingress network not found — is the openclaw stack running?"
  exit 1
fi
BR="br-${NETWORK_ID:0:12}"
log "openclaw_ingress bridge: $BR"

# Get the ingress bridge subnet (e.g. 172.19.0.0/20).
INGRESS_SUBNET=$(docker network inspect openclaw_ingress --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || true)
if [ -z "$INGRESS_SUBNET" ]; then
  log "WARNING: could not detect ingress subnet"
fi

# ── Part 1: raw/PREROUTING — unblock ttyd→gateway TCP ───────────────────────
GATEWAY_IP=$(docker inspect openclaw-gateway \
  --format '{{(index .NetworkSettings.Networks "openclaw_ingress").IPAddress}}' 2>/dev/null || true)

if [ -z "$GATEWAY_IP" ]; then
  log "WARNING: could not detect gateway IP on openclaw_ingress — skipping raw PREROUTING fix"
elif [ -z "$INGRESS_SUBNET" ]; then
  log "WARNING: ingress subnet unknown — skipping raw PREROUTING fix"
else
  log "gateway ingress IP: $GATEWAY_IP"
  if docker_iptables "iptables -t raw -C PREROUTING -s $INGRESS_SUBNET -d $GATEWAY_IP -j RETURN 2>/dev/null"; then
    log "raw PREROUTING RETURN rule already present"
  else
    log "inserting raw PREROUTING RETURN rule ($INGRESS_SUBNET → $GATEWAY_IP)..."
    docker_iptables "iptables -t raw -I PREROUTING 1 -s $INGRESS_SUBNET -d $GATEWAY_IP -j RETURN"
    log "raw PREROUTING RETURN rule inserted — ttyd→gateway TCP unblocked"
  fi
fi

# ── Part 2: filter/DOCKER-USER — block direct outbound egress ───────────────
log "checking DOCKER-USER for intra-bridge allow rule..."
if [ -n "$INGRESS_SUBNET" ]; then
  if docker_iptables "iptables -C DOCKER-USER -i $BR -d $INGRESS_SUBNET -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null"; then
    log "intra-bridge ACCEPT rule already present"
  else
    log "inserting intra-bridge ACCEPT rule for $BR → $INGRESS_SUBNET..."
    docker_iptables "iptables -I DOCKER-USER 1 -i $BR -d $INGRESS_SUBNET -m conntrack --ctstate NEW -j ACCEPT"
  fi
fi

log "checking DOCKER-USER for outbound-block rule..."
log "checking DOCKER-USER for outbound-attempt log rule..."
if docker_iptables "iptables -C DOCKER-USER -i $BR -m conntrack --ctstate NEW -m limit --limit 6/min --limit-burst 10 -j LOG --log-prefix 'IRONNEST_OPENCLAW_EGRESS_DROP ' --log-level 4 2>/dev/null"; then
  log "outbound-attempt LOG rule already present"
else
  log "inserting outbound-attempt LOG rule for $BR..."
  docker_iptables "iptables -I DOCKER-USER 2 -i $BR -m conntrack --ctstate NEW -m limit --limit 6/min --limit-burst 10 -j LOG --log-prefix 'IRONNEST_OPENCLAW_EGRESS_DROP ' --log-level 4"
fi

if docker_iptables "iptables -C DOCKER-USER -i $BR -m conntrack --ctstate NEW -j DROP 2>/dev/null"; then
  log "outbound-block DROP rule already present"
else
  log "inserting outbound-block DROP rule for $BR..."
  docker_iptables "iptables -I DOCKER-USER 3 -i $BR -m conntrack --ctstate NEW -j DROP"
  docker_iptables "iptables -C DOCKER-USER -i $BR -m conntrack --ctstate NEW -j DROP 2>/dev/null"
  log "direct egress from openclaw_ingress is now blocked (intra-bridge traffic allowed)"
fi
