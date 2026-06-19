#!/usr/bin/env bash
# One-shot migration: copy each profile's data out of the existing
# `hermes_hermes-data` volume into its own `hermes-platform_data-<name>`
# volume.
#
# Usage:  bash scripts/migrate-from-shared-volume.sh [--profile <name>] [--dry-run]
#
# Source layout (legacy hermes/ stack):
#   /opt/data/SOUL.md           ← `default` profile (root)
#   /opt/data/memories/         ← `default` profile
#   /opt/data/sessions/         ← `default` profile
#   /opt/data/profiles/mark/    ← `mark` profile
#   /opt/data/profiles/steve/   ← `steve` profile
#   /opt/data/profiles/wifey/   ← `wifey` profile
#   /opt/data/profiles/littlejohn/
#
# Destination layout (new hermes-platform/ stack):
#   /opt/data/SOUL.md           ← profile's data at the volume ROOT
#   /opt/data/memories/
#   /opt/data/sessions/
#   ...
#
# Each per-profile data subtree is flattened: a profile container sees
# ONLY its own data at /opt/data/. SHA-256 verification follows each
# copy; non-zero exit if mismatch.
#
# The source volume is mounted READ-ONLY (-v ro). This script never
# writes to hermes_hermes-data.
. "$(dirname "$0")/_common.sh"
require_cmd docker yq sha256sum

DRY=0
ONLY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY=1; shift ;;
        --profile) ONLY="$2"; validate_profile_name "$ONLY"; shift 2 ;;
        *) die "unknown arg: $1" ;;
    esac
done

SRC_VOL="hermes_hermes-data"
if ! docker volume inspect "$SRC_VOL" >/dev/null 2>&1; then
    die "source volume $SRC_VOL not found (is a legacy hermes/ deployment available to migrate from?)"
fi

if [ -n "$ONLY" ]; then
    profiles=("$ONLY")
else
    mapfile -t profiles < <(list_profiles)
fi

for name in "${profiles[@]}"; do
    dst_vol="hermes-platform_data-${name}"
    if ! docker volume inspect "$dst_vol" >/dev/null 2>&1; then
        if [ "$DRY" = "0" ]; then
            log_info "creating $dst_vol"
            docker volume create "$dst_vol" >/dev/null
        else
            log_info "DRY: would create $dst_vol"
        fi
    fi

    if [ "$name" = "default" ]; then
        SRC_SUBPATH=""   # default's data is at the volume root, not under profiles/
    else
        SRC_SUBPATH="profiles/$name"
    fi

    log_info "migrating $name (src: /opt/data/$SRC_SUBPATH → dst: $dst_vol:/opt/data/)"

    if [ "$DRY" = "1" ]; then
        docker run --rm \
            -v "$SRC_VOL:/src:ro" \
            alpine:3.20 sh -c "
                set -eu
                cd /src/$SRC_SUBPATH 2>/dev/null || { echo 'no source dir for $name'; exit 0; }
                echo 'DRY: would copy these top-level entries:'
                ls -la | head -40
                echo 'DRY: file count = '\$(find . -type f | wc -l)
            "
        continue
    fi

    docker run --rm \
        -v "$SRC_VOL:/src:ro" \
        -v "$dst_vol:/dst" \
        alpine:3.20 sh -c "
            set -eu
            apk add --no-cache rsync >/dev/null
            cd /src/$SRC_SUBPATH 2>/dev/null || { echo 'no source dir for $name; nothing to copy'; exit 0; }
            rsync -a --delete-excluded \
                --exclude='gateway.lock' --exclude='gateway.pid' \
                --exclude='*.log' \
                ./ /dst/
            # Verify with SHA-256 sums for every file
            cd /dst
            ( cd /src/$SRC_SUBPATH && find . -type f \\( -name 'gateway.lock' -o -name 'gateway.pid' -o -name '*.log' \\) -prune -o -type f -print0 | xargs -0 sha256sum ) > /tmp/src.sums
            (                              find . -type f -print0 | xargs -0 sha256sum                                                                                                       ) > /tmp/dst.sums
            sort /tmp/src.sums > /tmp/src.sorted
            sort /tmp/dst.sums > /tmp/dst.sorted
            if diff -q /tmp/src.sorted /tmp/dst.sorted >/dev/null; then
                echo 'OK  SHA-256 verification passed (\$(wc -l < /tmp/src.sums) files)'
            else
                echo 'FAIL  SHA-256 mismatch for $name:' >&2
                diff /tmp/src.sorted /tmp/dst.sorted | head -40 >&2
                exit 1
            fi
            chown -R 10000:10000 /dst
        "
done

log_info "migration complete"
if [ "$DRY" = "0" ]; then
    log_info "next: bash $STACK_DIR/scripts/patch-souls.sh   (adds OpenViking policy to migrated SOUL.md)"
fi
