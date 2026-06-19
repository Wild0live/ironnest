#!/usr/bin/env bash
# Back up every SOUL.md in every per-profile volume.
#
# Usage:  bash scripts/backup-souls.sh [--profile <name>]
#
# Creates timestamped copies inside each volume:
#   /opt/data/SOUL.md.bak.<epoch>
# Matches the existing hermes convention (we observed
# /opt/data/profiles/mark/SOUL.md.bak.1779276033 in the live system).
#
# Pass --profile to back up just one volume.
. "$(dirname "$0")/_common.sh"
require_cmd docker

ONLY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --profile) ONLY="$2"; validate_profile_name "$ONLY"; shift 2 ;;
        *) die "unknown arg: $1" ;;
    esac
done

# Discover profiles from registry
if [ -n "$ONLY" ]; then
    profiles=("$ONLY")
else
    mapfile -t profiles < <(list_profiles)
fi

TS="$(date +%s)"
log_info "backing up SOUL.md across ${#profiles[@]} profile(s) (.bak.$TS)"

for name in "${profiles[@]}"; do
    vol="hermes-platform_data-${name}"
    if ! docker volume inspect "$vol" >/dev/null 2>&1; then
        log_warn "volume $vol does not exist, skipping"
        continue
    fi
    docker run --rm -v "$vol:/opt/data" alpine:3.20 sh -c "
        if [ -f /opt/data/SOUL.md ]; then
            cp -p /opt/data/SOUL.md /opt/data/SOUL.md.bak.$TS
            echo 'backed up SOUL.md → SOUL.md.bak.$TS for $name'
        else
            echo 'no SOUL.md present for $name (skipped)'
        fi
    "
done
log_info "done"
