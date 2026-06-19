#!/usr/bin/env bash
# Delete a Hermes profile.
#
# Usage:  bash scripts/delete-profile.sh <profile-name> [--purge-volume]
#
# Default: removes container, registry entry, policy file. KEEPS the
# data volume (admin must opt in with --purge-volume).
. "$(dirname "$0")/_common.sh"

require_cmd docker
require_yq

PURGE_VOLUME=0
NAME=""
for arg in "$@"; do
    case "$arg" in
        --purge-volume) PURGE_VOLUME=1 ;;
        -*) die "unknown flag: $arg" ;;
        *)  [ -z "$NAME" ] || die "extra arg: $arg"; NAME="$arg" ;;
    esac
done
[ -n "$NAME" ] || die "usage: $(basename "$0") <profile-name> [--purge-volume]"
validate_profile_name "$NAME"

POLICY_FILE="$STACK_DIR/policies/${NAME}.policy.yaml"
REGISTRY_FILE="$STACK_DIR/registry/profiles-registry.yaml"
CONTAINER="hermes-pf-${NAME}"
DATA_VOLUME="hermes-platform_data-${NAME}"

# Stop + remove container if present
if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    log_info "stopping $CONTAINER"
    docker stop "$CONTAINER" >/dev/null || true
    docker rm   "$CONTAINER" >/dev/null
fi

# Remove registry entry
if yq -e ".profiles[] | select(.name == \"$NAME\")" "$REGISTRY_FILE" >/dev/null 2>&1; then
    log_info "removing $NAME from registry"
    yq -i "del(.profiles[] | select(.name == \"$NAME\"))" "$REGISTRY_FILE"
else
    log_warn "$NAME not in registry"
fi

# Remove policy file
if [ -f "$POLICY_FILE" ]; then
    log_info "removing $POLICY_FILE"
    rm "$POLICY_FILE"
fi

if [ "$PURGE_VOLUME" = "1" ]; then
    if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
        log_warn "PURGING data volume $DATA_VOLUME — this is destructive"
        docker volume rm "$DATA_VOLUME"
    fi
else
    log_info "data volume KEPT: $DATA_VOLUME (delete with --purge-volume)"
fi

# Reload gateway policies
if [ -n "${MEMORY_GATEWAY_ADMIN_TOKEN:-}" ] && docker inspect -f '{{.State.Health.Status}}' hermes-platform-memory-gateway 2>/dev/null | grep -q healthy; then
    log_info "reloading gateway policies"
    curl -fsS -X POST -H "Authorization: Bearer $MEMORY_GATEWAY_ADMIN_TOKEN" \
        http://127.0.0.1:18080/admin/reload-policies | jq . || true
fi

log_info "deletion of profile '$NAME' complete"
