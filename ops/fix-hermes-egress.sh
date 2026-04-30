#!/usr/bin/env bash
# Block direct outbound from hermes_ingress at the kernel level.
#
# hermes_ingress is a non-internal Docker bridge — its only purpose is to let
# Docker publish 127.0.0.1:7682 to the host. Without enforcement, a process
# inside hermes-ttyd that ignores HTTP_PROXY can reach the internet directly
# through this bridge's default route, bypassing Squid (and therefore the
# allowlist + Wazuh visibility).
#
# Rules (in DOCKER-USER, prepended in order):
#   ACCEPT -i <br> -d <ingress-subnet> --ctstate NEW   (intra-bridge)
#   LOG    -i <br>                     --ctstate NEW   (egress attempts, rate-limited)
#   DROP   -i <br>                     --ctstate NEW   (everything else outbound)
#
# Unlike openclaw_ingress, hermes_ingress has no gateway container — the
# raw/PREROUTING fix from fix-openclaw-egress.sh is not needed here.
#
# Must run AFTER hermes stack is up (hermes_ingress network must exist).
# Called by: hermes/start.sh
# Idempotent: each rule is checked before inserting.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

log() { echo "[fix-hermes-egress] $*"; }

docker_iptables() {
  docker run --rm --cap-add NET_ADMIN --network host alpine \
    sh -c "apk add -q iptables 2>/dev/null && $*"
}

NETWORK_ID=$(docker network inspect hermes_ingress --format '{{.Id}}' 2>/dev/null || true)
if [ -z "$NETWORK_ID" ]; then
  log "ERROR: hermes_ingress network not found — is the hermes stack running?"
  exit 1
fi
BR="br-${NETWORK_ID:0:12}"
log "hermes_ingress bridge: $BR"

INGRESS_SUBNET=$(docker network inspect hermes_ingress --format '{{(index .IPAM.Config 0).Subnet}}' 2>/dev/null || true)
if [ -z "$INGRESS_SUBNET" ]; then
  log "WARNING: could not detect ingress subnet"
fi

log "checking DOCKER-USER for intra-bridge allow rule..."
if [ -n "$INGRESS_SUBNET" ]; then
  if docker_iptables "iptables -C DOCKER-USER -i $BR -d $INGRESS_SUBNET -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null"; then
    log "intra-bridge ACCEPT rule already present"
  else
    log "inserting intra-bridge ACCEPT rule for $BR → $INGRESS_SUBNET..."
    docker_iptables "iptables -I DOCKER-USER 1 -i $BR -d $INGRESS_SUBNET -m conntrack --ctstate NEW -j ACCEPT"
  fi
fi

log "checking DOCKER-USER for outbound-attempt log rule..."
if docker_iptables "iptables -C DOCKER-USER -i $BR -m conntrack --ctstate NEW -m limit --limit 6/min --limit-burst 10 -j LOG --log-prefix 'IRONNEST_HERMES_EGRESS_DROP ' --log-level 4 2>/dev/null"; then
  log "outbound-attempt LOG rule already present"
else
  log "inserting outbound-attempt LOG rule for $BR..."
  docker_iptables "iptables -I DOCKER-USER 2 -i $BR -m conntrack --ctstate NEW -m limit --limit 6/min --limit-burst 10 -j LOG --log-prefix 'IRONNEST_HERMES_EGRESS_DROP ' --log-level 4"
fi

log "checking DOCKER-USER for outbound-block rule..."
if docker_iptables "iptables -C DOCKER-USER -i $BR -m conntrack --ctstate NEW -j DROP 2>/dev/null"; then
  log "outbound-block DROP rule already present"
else
  log "inserting outbound-block DROP rule for $BR..."
  docker_iptables "iptables -I DOCKER-USER 3 -i $BR -m conntrack --ctstate NEW -j DROP"
  log "direct egress from hermes_ingress is now blocked (intra-bridge traffic allowed)"
fi
