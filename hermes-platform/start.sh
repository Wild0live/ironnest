#!/usr/bin/env bash
# Start the hermes-platform stack.
#
# Prerequisite: bootstrap.sh must have run (platform-net, platform-egress,
# AdGuard, Squid, Infisical healthy), AND the platform/hermes-agent image
# must exist (built by hermes/build.sh).
#
# This script does NOT build. Rebuild with: bash hermes-platform/build.sh.
# On first run, if an image is missing, this script invokes build.sh.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

PLATFORM="$(cd "$(dirname "$0")/.." && pwd)"
STACK="$PLATFORM/hermes-platform"

# Repair Rancher Desktop NAT + platform-egress routing (idempotent).
"$PLATFORM/ops/fix-nat-prerouting.sh"
"$PLATFORM/ops/repair-egress.sh"

cd "$STACK"

COMPOSE_FILES=(-f docker-compose.yml)
if compgen -G "services.d/*.yml" >/dev/null; then
    for f in services.d/*.yml; do
        COMPOSE_FILES+=(-f "$f")
    done
fi

# The privileged operations runner is opt-in. It is excluded from routine
# startup unless an operator explicitly enables it after configuring its token.
COMPOSE_PROFILES=()
if [ "${ENABLE_OPERATIONS_RUNNER:-0}" = "1" ]; then
    COMPOSE_PROFILES+=(--profile operations)
fi

compose() {
    docker compose "${COMPOSE_FILES[@]}" "${COMPOSE_PROFILES[@]}" "$@"
}

# ── Required external volumes used by the stack ─────────────────────────────
# The named volumes declared in docker-compose.yml are managed by Compose;
# none are external. But hermes-platform DOES read the existing
# hermes_hermes-data volume during migration (one-shot, manually triggered).

# ── First-run image detection ──────────────────────────────────────────────
IMAGES=(
    platform/hermes-platform-openviking:0.1.0
    platform/hermes-platform-memory-gateway:0.1.0
    platform/hermes-platform-mission-control:0.1.0
)
if [ "${ENABLE_OPERATIONS_RUNNER:-0}" = "1" ]; then
    IMAGES+=(platform/hermes-platform-operations-runner:0.1.0)
fi
for IMG in "${IMAGES[@]}"; do
    if ! docker image inspect "$IMG" >/dev/null 2>&1; then
        echo "--- image $IMG not present, running build.sh ---"
        "$STACK/build.sh"
        break
    fi
done

# Hermes-agent image must exist (reused, not rebuilt by us)
HERMES_IMG="platform/hermes-agent:v2026.6.19-patched"
if ! docker image inspect "$HERMES_IMG" >/dev/null 2>&1; then
    echo "FATAL: required image $HERMES_IMG not found." >&2
    echo "       Run: bash $PLATFORM/hermes/build.sh" >&2
    exit 1
fi

echo "--- starting hermes-platform stack ---"
compose up -d --no-build

# Block direct outbound from the stack's ingress bridge at the kernel level.
# Same pattern as hermes/start.sh + openclaw/start.sh (DOCKER-USER rules).
if [ -x "$PLATFORM/ops/fix-hermes-egress.sh" ]; then
    # Reuse the hermes egress fix for our ingress bridge as well.
    # The script is idempotent and matches `*_ingress` bridges by pattern.
    "$PLATFORM/ops/fix-hermes-egress.sh"
fi

echo "--- waiting for hermes-platform services to be healthy ---"
mapfile -t PROFILE_CONTAINERS < <(compose config --services | awk '/^hermes-pf-/ {print}')
CONTAINERS=(
    hermes-platform-openviking-infisical-agent
    hermes-platform-ollama
    hermes-platform-openviking
    hermes-platform-memory-gateway
    hermes-platform-mission-control
    hermes-platform-artifact-apps
    hermes-platform-ttyd
    "${PROFILE_CONTAINERS[@]}"
)
if [ "${ENABLE_OPERATIONS_RUNNER:-0}" = "1" ]; then
    CONTAINERS+=(hermes-platform-operations-runner)
fi
deadline=$(( $(date +%s) + 300 ))
while :; do
    all_ok=1
    for c in "${CONTAINERS[@]}"; do
        status=$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo "missing")
        if [ "$status" != "healthy" ]; then
            all_ok=0
            break
        fi
    done
    [ "$all_ok" = "1" ] && break
    if [ "$(date +%s)" -gt "$deadline" ]; then
        echo
        echo "TIMEOUT waiting for healthy. Last status:" >&2
        for c in "${CONTAINERS[@]}"; do
            printf '  %-40s %s\n' "$c" "$(docker inspect -f '{{.State.Health.Status}}' "$c" 2>/dev/null || echo missing)"
        done >&2
        exit 1
    fi
    printf '.'
    sleep 5
done
echo " healthy"

# Reconcile the orchestrator's kanban-decompose routing roster from the
# registry (idempotent). Without this, decomposed subtasks can't be routed to
# specialist profiles and pile up on the orchestrator. Non-fatal: a routing
# hiccup must not block the stack from coming up.
if [ -x "$STACK/scripts/sync-orchestrator-roster.sh" ]; then
    echo "--- syncing orchestrator decompose roster from registry ---"
    "$STACK/scripts/sync-orchestrator-roster.sh" || \
        echo "WARN: orchestrator roster sync failed — decompose routing may be degraded" >&2
fi

if [ -x "$STACK/scripts/catch-up-missed-cron.sh" ]; then
    echo "--- catching up missed scheduled scripts once ---"
    "$STACK/scripts/catch-up-missed-cron.sh" || \
        echo "WARN: missed cron catch-up failed — use Mission Control Schedules to retry" >&2
fi

echo
echo "=== hermes-platform is ready ==="
echo "  Memory Gateway (admin/diag):   http://127.0.0.1:18080/health"
echo "  Mission Control (FIDO-gated):  https://mission.ironnest.local/"
echo "  Platform terminal (FIDO):      https://hermes-platform.ironnest.local/"
echo "  OpenViking (internal only):    http://openviking:1933  (NOT published)"
echo
echo "  Profile containers: ${PROFILE_CONTAINERS[*]}"
echo "  Add a profile:      bash $STACK/scripts/provision-profile.sh <name> [flags]"
echo "  Validate model:  bash $STACK/scripts/validate-isolation.sh"
echo "                   bash $STACK/scripts/validate-sharing.sh"
echo "  Migrate data:    bash $STACK/scripts/migrate-from-shared-volume.sh"
echo "  Patch SOULs:     bash $STACK/scripts/patch-souls.sh --dry-run"
echo

echo "--- verifying openviking is unreachable from hermes-pf-mark ---"
if docker exec hermes-pf-mark curl --noproxy "*" -m 5 -sf http://openviking:1933/ -o /dev/null 2>/dev/null; then
    echo "WARNING: openviking is REACHABLE from hermes-pf-mark — network segmentation failed" >&2
    echo "         Check that hermes-pf-mark is NOT joined to hermes-platform-mem-net" >&2
else
    echo "OK: openviking is unreachable from hermes-pf-mark (network segmentation holds)"
fi
