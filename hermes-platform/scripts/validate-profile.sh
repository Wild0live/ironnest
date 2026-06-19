#!/usr/bin/env bash
# Validate a profile's policy + registry entry + container existence.
#
# Usage:  bash scripts/validate-profile.sh <profile-name>
#
# Checks:
#   1. policies/<name>.policy.yaml exists and parses
#   2. registry entry exists with matching namespace
#   3. container hermes-pf-<name> exists (running or stopped)
#   4. data volume hermes-platform_data-<name> exists
#   5. gateway /admin/profiles lists the profile
. "$(dirname "$0")/_common.sh"

require_cmd docker
require_yq

[ $# -eq 1 ] || die "usage: $(basename "$0") <profile-name>"
NAME="$1"
validate_profile_name "$NAME"

ok=1
fail() { log_err "FAIL: $*"; ok=0; }
pass() { log_info "PASS: $*"; }

# 1
F="$STACK_DIR/policies/${NAME}.policy.yaml"
if [ -f "$F" ] && yq -e ".profile == \"$NAME\"" "$F" >/dev/null 2>&1; then
    pass "policy file present and profile field matches: $F"
else
    fail "policy file missing or invalid: $F"
fi

# 2
R="$STACK_DIR/registry/profiles-registry.yaml"
if yq -e ".profiles[] | select(.name == \"$NAME\") | .namespace == \"viking://profiles/$NAME/\"" \
       "$R" >/dev/null 2>&1; then
    pass "registry entry matches expected namespace"
else
    fail "registry entry missing or namespace mismatch: $R"
fi

# 3
C="hermes-pf-${NAME}"
if docker ps -a --format '{{.Names}}' | grep -qx "$C"; then
    pass "container $C exists"
else
    fail "container $C not found"
fi

# 4
V="hermes-platform_data-${NAME}"
if docker volume inspect "$V" >/dev/null 2>&1; then
    pass "data volume $V exists"
else
    fail "data volume $V not found"
fi

# 5 — if gateway is up and we have admin token, hit /admin/profiles
if [ -n "${MEMORY_GATEWAY_ADMIN_TOKEN:-}" ] && \
   docker inspect -f '{{.State.Health.Status}}' hermes-platform-memory-gateway 2>/dev/null | grep -q healthy; then
    if curl -fsS -H "Authorization: Bearer $MEMORY_GATEWAY_ADMIN_TOKEN" \
            http://127.0.0.1:18080/admin/profiles | jq -e ".profiles[] | select(.name == \"$NAME\")" \
            >/dev/null; then
        pass "gateway /admin/profiles lists $NAME"
    else
        fail "gateway /admin/profiles does NOT list $NAME (reload policies?)"
    fi
else
    log_warn "skipping gateway /admin/profiles check (gateway down or MEMORY_GATEWAY_ADMIN_TOKEN unset)"
fi

[ "$ok" = "1" ] || exit 1
log_info "all checks passed for profile $NAME"
