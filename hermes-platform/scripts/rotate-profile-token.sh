#!/usr/bin/env bash
# Mint a fresh bearer token for a profile.
#
# Usage:  bash scripts/rotate-profile-token.sh <profile-name>
#
# Prints the new token; the operator must paste it into Infisical at:
#     /hermes-platform/gateway → MEMORY_GATEWAY_PROFILE_TOKENS_JSON  (replace the profile's value)
#     /hermes-platform/<name>  → MEMORY_GATEWAY_TOKEN                (replace)
#
# Then `docker compose restart memory-gateway hermes-pf-<name>` to apply.
#
# This script intentionally does NOT call Infisical for you — token rotation
# is a deliberate, audited action.
. "$(dirname "$0")/_common.sh"

[ $# -eq 1 ] || die "usage: $(basename "$0") <profile-name>"
NAME="$1"
validate_profile_name "$NAME"

# Generate 32 bytes → 64 hex chars (256 bits of entropy)
NEW_TOKEN="$(openssl rand -hex 32)"

cat <<EOF

=== Token rotation for profile '$NAME' ===

New token (do NOT commit, do NOT paste in chat, do NOT log):

  $NEW_TOKEN

Steps to apply:

  1) Infisical → project hermes-platform → folder /hermes-platform/gateway
        → MEMORY_GATEWAY_PROFILE_TOKENS_JSON
          set "$NAME": "$NEW_TOKEN"

  2) Infisical → folder /hermes-platform/$NAME
        → MEMORY_GATEWAY_TOKEN = $NEW_TOKEN

  3) Restart the two affected containers:
        cd $STACK_DIR
        docker compose restart memory-gateway hermes-pf-$NAME

  4) Verify:
        bash $STACK_DIR/scripts/validate-profile.sh $NAME

The previous token is invalidated as soon as the gateway restarts.

EOF
