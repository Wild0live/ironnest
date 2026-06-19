#!/usr/bin/env bash
# Cross-stack smoke test. Run AFTER start.sh.
# Usage:  bash scripts/healthcheck.sh
. "$(dirname "$0")/_common.sh"

ok=1
check() {
    local desc="$1"; shift
    if "$@" >/dev/null 2>&1; then
        log_info "PASS  $desc"
    else
        log_err  "FAIL  $desc"
        ok=0
    fi
}

# 1. Required external networks
check "platform-net exists"    docker network inspect platform-net
check "platform-egress exists" docker network inspect platform-egress

# 2. Stack containers healthy
containers=(
    hermes-platform-openviking-infisical-agent
    hermes-platform-ollama
    hermes-platform-openviking
    hermes-platform-memory-gateway
    hermes-platform-mission-control
    hermes-platform-ttyd
)
while IFS= read -r p; do
    [ -n "$p" ] && containers+=("hermes-pf-$p")
done < <(list_profiles)

for c in "${containers[@]}" ; do
    check "$c is healthy" \
        bash -c "[ \"\$(docker inspect -f '{{.State.Health.Status}}' $c 2>/dev/null)\" = healthy ]"
done

# 3. Memory gateway /health responds.
#    Test from INSIDE a hermes-pf-* container (the actual call path the agents
#    use) rather than via 127.0.0.1:18080. The host port-publish is for ops
#    only and can intermittently flake on Rancher Desktop's port forwarder
#    after RD restarts; that's an RD quirk, not a gateway problem.
check "memory-gateway /health reachable from hermes-pf-default" \
    bash -c "docker exec hermes-pf-default curl -fsS -m 5 http://memory-gateway:8080/health -o /dev/null"

# 3b. Best-effort check of the host-published diag port. Non-fatal: a
#    failure here only means the admin diag port isn't bound (RD forwarder
#    glitch); the gateway itself is fine if check #3 passed.
if curl -fsS -m 3 http://127.0.0.1:18080/health >/dev/null 2>&1 ; then
    log_info "PASS  memory-gateway host-published 127.0.0.1:18080 reachable"
else
    log_warn "WARN  memory-gateway 127.0.0.1:18080 not reachable (RD port forwarder quirk — gateway itself is up; in-container call works)"
fi

# 4. OpenViking has NO host port published (deliberate)
check "openviking publishes no host port" \
    bash -c "[ -z \"\$(docker port hermes-platform-openviking 2>/dev/null)\" ]"

# 5. Network segmentation holds
check "openviking unreachable from hermes-pf-mark" \
    bash -c "! docker exec hermes-pf-mark curl --noproxy '*' -m 5 -sf http://openviking:1933/ -o /dev/null"

# 6. Mission Control can see the profile chat bridges over platform-net.
check "mission-control /api/agents/health reachable in-container" \
    bash -c "docker exec hermes-platform-mission-control python - <<'PY'
import json
import sys
import urllib.request

with urllib.request.urlopen('http://127.0.0.1:8080/api/agents/health', timeout=10) as resp:
    data = json.loads(resp.read().decode('utf-8'))
health = data.get('health') or {}
sys.exit(0 if health and all(health.values()) else 1)
PY"

[ "$ok" = "1" ] || die "healthcheck failed"
log_info "all healthcheck assertions passed"
