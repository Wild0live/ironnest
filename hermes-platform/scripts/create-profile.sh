#!/usr/bin/env bash
# Create a new Hermes profile and wire it into the platform.
#
# Usage:  bash scripts/create-profile.sh <profile-name>
#
# Steps (every step is idempotent; safe to re-run):
#   1. Validate profile name
#   2. Create policies/<name>.policy.yaml from profile-template/policy.yaml.template
#   3. Append to registry/profiles-registry.yaml (skip if entry exists)
#   4. Create a named volume hermes-platform_data-<name>
#   5. Seed the volume with SOUL.md / USER.md / MEMORY.md from templates
#      and append the OpenViking Memory Policy section to SOUL.md
#   6. Print follow-up steps (Infisical token, compose entry, restart)
#
# This script does NOT mutate docker-compose.yml. Profile containers must
# be added by hand (or by a future emit-compose-fragment.sh) — kept that
# way to avoid clobbering a hand-edited compose file.
. "$(dirname "$0")/_common.sh"

require_cmd docker
require_yq

[ $# -eq 1 ] || die "usage: $(basename "$0") <profile-name>"
NAME="$1"
validate_profile_name "$NAME"

POLICY_FILE="$STACK_DIR/policies/${NAME}.policy.yaml"
REGISTRY_FILE="$STACK_DIR/registry/profiles-registry.yaml"
TEMPLATE_DIR="$STACK_DIR/profile-template"
DATA_VOLUME="hermes-platform_data-${NAME}"

# 1 — policy file
if [ -f "$POLICY_FILE" ]; then
    log_warn "policy file already exists, leaving in place: $POLICY_FILE"
else
    log_info "creating policy file: $POLICY_FILE"
    sed "s|<PROFILE-NAME>|$NAME|g" \
        "$TEMPLATE_DIR/policy.yaml.template" > "$POLICY_FILE"
fi

# 2 — registry entry (idempotent — skip if name already present)
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if yq -e ".profiles[] | select(.name == \"$NAME\")" "$REGISTRY_FILE" >/dev/null 2>&1; then
    log_warn "registry already has entry for $NAME, skipping append"
else
    log_info "appending registry entry for $NAME"
    yq -i ".profiles += [{
        \"name\": \"$NAME\",
        \"namespace\": \"viking://profiles/$NAME/\",
        \"approved_shared_namespace\": \"viking://shared/approved/$NAME/\",
        \"container_name\": \"hermes-pf-$NAME\",
        \"status\": \"enabled\",
        \"policy_file\": \"${NAME}.policy.yaml\",
        \"created_at\": \"$NOW\",
        \"tags\": [\"dynamic\"],
        \"notes\": \"created by scripts/create-profile.sh\"
    }]" "$REGISTRY_FILE"
fi

# 3 — named volume (idempotent)
if docker volume inspect "$DATA_VOLUME" >/dev/null 2>&1; then
    log_warn "data volume already exists: $DATA_VOLUME"
else
    log_info "creating data volume: $DATA_VOLUME"
    docker volume create "$DATA_VOLUME" >/dev/null
fi

# 4 — seed volume with templated files. We use a throwaway alpine container.
log_info "seeding volume $DATA_VOLUME with profile templates"
_TEMPLATE_HOST="$TEMPLATE_DIR"
if command -v cygpath >/dev/null 2>&1; then
    _TEMPLATE_HOST="$(cygpath -w "$TEMPLATE_DIR")"
fi
docker run --rm \
    -v "$DATA_VOLUME:/opt/data" \
    -v "${_TEMPLATE_HOST}:/tmpl:ro" \
    alpine:3.20 sh -c "
        set -eu
        cd /opt/data
        for f in SOUL.md USER.md MEMORY.md; do
            if [ ! -f \"\$f\" ]; then
                sed -e 's|<PROFILE-NAME>|$NAME|g' \
                    -e \"s|<PROFILE-NAME-UPPER>|\$(echo $NAME | tr '[:lower:]' '[:upper:]')|g\" \
                    -e \"s|<CREATED-AT>|$NOW|g\" \
                    /tmpl/\${f}.template > \"\$f\"
            fi
        done
        if [ ! -f tools.yaml ]; then
            sed 's|<PROFILE-NAME>|$NAME|g' /tmpl/tools.yaml.template > tools.yaml
        fi
        mkdir -p sessions memories skills cache logs workspace
        chown -R 10000:10000 /opt/data
        chmod 0700 /opt/data
    "

# 5 — reload gateway policies (if memory-gateway is running)
if docker inspect -f '{{.State.Health.Status}}' hermes-platform-memory-gateway 2>/dev/null | grep -q healthy; then
    log_info "reloading gateway policies"
    log_info "  (set MEMORY_GATEWAY_ADMIN_TOKEN to the admin token from Infisical /hermes-platform/gateway)"
    if [ -n "${MEMORY_GATEWAY_ADMIN_TOKEN:-}" ]; then
        curl -fsS -X POST \
            -H "Authorization: Bearer $MEMORY_GATEWAY_ADMIN_TOKEN" \
            http://127.0.0.1:18080/admin/reload-policies | jq . || true
    else
        log_warn "MEMORY_GATEWAY_ADMIN_TOKEN not set; run reload by hand:"
        log_warn "  curl -XPOST -H 'Authorization: Bearer \$TOKEN' http://127.0.0.1:18080/admin/reload-policies"
    fi
fi

cat <<EOF

=== profile '$NAME' created ===

Next steps (operator):

  1) Add bearer token to Infisical:
       UI: Infisical → project hermes-platform → folder /hermes-platform/gateway
           → MEMORY_GATEWAY_PROFILE_TOKENS_JSON  (extend the JSON object)
           {
             ...,
             "$NAME": "<new 64-char hex token, generate via: openssl rand -hex 32>"
           }

       Add a per-profile folder at /hermes-platform/$NAME containing:
           MEMORY_GATEWAY_TOKEN  = <same token as above>
           (any per-profile secrets — Telegram bot token, etc.)
       Plus a Secret Link importing shared keys from /hermes-platform.

  2) Add a service block to docker-compose.yml (clone an existing
     hermes-pf-<other> service, change container_name, command,
     INFISICAL_PATH, HERMES_PROFILE, and the data volume binding).

  3) Restart the gateway and bring up the new container:
       cd $STACK_DIR
       docker compose up -d hermes-pf-$NAME

  4) Verify isolation/sharing:
       bash $STACK_DIR/scripts/validate-isolation.sh $NAME
       bash $STACK_DIR/scripts/validate-sharing.sh   $NAME

EOF
