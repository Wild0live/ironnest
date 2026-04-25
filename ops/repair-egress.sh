#!/usr/bin/env bash
# Diagnoses and repairs cross-container routing on platform-egress.
#
# Root cause: after Rancher Desktop / WSL2 resumes from hibernate or sleep, the
# Linux bridge FDB (forwarding database) inside the Docker network namespace can
# hold stale MAC entries for veth pairs that were frozen. New packets from other
# containers on the bridge go nowhere — manifesting as i/o timeout to Infisical.
#
# Fix: disconnect + reconnect Infisical from platform-egress (creates a fresh
# veth pair, forcing FDB re-learning). Falls back to a full container restart if
# the reconnect alone is insufficient.
#
# Safe to run at any time; exits 0 immediately if routing is already healthy.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

log() { echo "[repair-egress] $*"; }

# Spin up a throwaway container on platform-egress and probe Infisical's API.
# This is the canonical cross-container routing test.
test_routing() {
  docker run --rm \
    --network platform-egress \
    alpine:latest \
    sh -c 'wget -T5 -qO- http://infisical:8090/api/status 2>/dev/null' \
    | grep -q '"Ok"'
}

wait_infisical_loopback() {
  local max=12
  for i in $(seq 1 $max); do
    if docker exec infisical wget -T3 -qO- http://127.0.0.1:8090/api/status 2>/dev/null | grep -q '"Ok"'; then
      return 0
    fi
    sleep 5
  done
  return 1
}

log "testing platform-egress routing to infisical..."

if test_routing; then
  log "routing OK — nothing to repair"
  exit 0
fi

log "routing DEGRADED — attempting repair via network reconnect (non-disruptive)..."

docker network disconnect platform-egress infisical 2>/dev/null || true
sleep 2
docker network connect platform-egress infisical 2>/dev/null || true

for i in 1 2 3 4; do
  sleep 5
  if test_routing; then
    log "routing RESTORED via network reconnect"
    exit 0
  fi
done

log "reconnect insufficient — restarting infisical container..."
docker restart infisical

log "waiting for infisical to accept connections..."
if ! wait_infisical_loopback; then
  log "ERROR: infisical did not come healthy after restart" >&2
  exit 1
fi

for i in 1 2 3 4; do
  sleep 5
  if test_routing; then
    log "routing RESTORED after infisical restart"
    exit 0
  fi
done

log "ERROR: routing still broken after all repair attempts" >&2
exit 1
