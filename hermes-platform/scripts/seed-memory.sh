#!/usr/bin/env bash
# Seed the OpenViking server with the initial directory structure.
#
# Usage:  bash scripts/seed-memory.sh
#
# Creates (via the gateway, so policy is exercised even at seed time):
#   viking://shared/org/        — organizational knowledge
#   viking://shared/project/    — current project context
#   viking://shared/knowledge/  — durable references
#   viking://shared/reference/
#   viking://shared/security/
#   viking://shared/approved/<profile>/  for every profile
#
# Seed entries are minimal placeholder content explaining the namespace.
# Real content gets added by profiles over time.
. "$(dirname "$0")/_common.sh"
require_cmd docker yq curl jq

mapfile -t profiles < <(yq -r '.profiles[].name' "$STACK_DIR/registry/profiles-registry.yaml")

[ -n "${MEMORY_GATEWAY_ADMIN_TOKEN:-}" ] || die "set MEMORY_GATEWAY_ADMIN_TOKEN (from Infisical /hermes-platform/gateway)"

# Use any profile's container to make the gateway calls — seeds touch
# viking://shared/** which every profile may write to its own approved
# subtree, but for shared/org we need admin privileges. We give the admin
# token a synthetic profile identity 'admin' for the seed only.
#
# For now: bypass policy by writing directly to OpenViking via the admin
# token using a private internal endpoint. (The gateway doesn't expose
# this yet — TODO when we add admin write support; for now, this seed
# script lives as documentation and the operator runs the equivalent
# `docker exec` against openviking once we know the SDK API.)

log_warn "seed-memory.sh is a placeholder until the gateway exposes /admin/seed."
log_warn "for now, manually populate via:"
cat <<EOF
    for p in ${profiles[*]}; do
        echo "creating namespaces for \$p..."
        # Each profile writes its own approved-shared root placeholder
        docker exec hermes-pf-\$p sh -c '
            curl -sS -H "Authorization: Bearer \$MEMORY_GATEWAY_TOKEN" \
                 -H "Content-Type: application/json" \
                 -d "{\"uri\":\"viking://shared/approved/\$HERMES_PROFILE/.placeholder\",\"content\":\"namespace seed\"}" \
                 http://memory-gateway:8080/memory/write
        '
    done
EOF
