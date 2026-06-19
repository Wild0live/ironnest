#!/usr/bin/env bash
# Repair Hermes authentication-file ownership after a root-run diagnostic or
# chat command.
#
# Usage:
#   bash scripts/repair-auth-lock-permissions.sh mark
#   bash scripts/repair-auth-lock-permissions.sh          # all profiles
. "$(dirname "$0")/_common.sh"
require_cmd docker

if [ "$#" -gt 0 ]; then
    profiles=("$@")
else
    mapfile -t profiles < <(list_profiles)
fi

for profile in "${profiles[@]}"; do
    validate_profile_name "$profile"
    container="hermes-pf-${profile}"
    if ! docker ps --format '{{.Names}}' | grep -qx "$container"; then
        log_warn "$container is not running; skipped"
        continue
    fi

    docker exec --user 0:0 "$container" sh -c '
        chown 10000:10000 /opt/data
        find /opt/data -maxdepth 1 -type f -name "auth*" \
            -exec chown 10000:10000 {} \;
    '
    log_info "repaired authentication-file ownership for $profile"
done

log_info "authentication-file permission repair complete"
