#!/usr/bin/env bash
# Sync the orchestrator container's local profile roster from the registry.
#
# Usage:
#   bash scripts/sync-orchestrator-roster.sh [--orchestrator=hermes-pf-default]
#                                            [--dry-run]
#
# WHY THIS EXISTS
# ───────────────
# `hermes kanban decompose` routes each child task to a specialist profile by
# matching the task to that profile's *description*. The decomposer runs in the
# orchestrator container (default: hermes-pf-default / Dr. Smith) and reads its
# routable roster from that container's local /opt/data/profiles/<name>/profile.yaml
# (via profiles.list_profiles). An "undescribed" profile cannot be routed to —
# the decomposer falls back to the default_assignee (the orchestrator itself),
# which is why subtasks all pile up on Dr. Smith until descriptions exist.
#
# Two failure modes this script defends against:
#   1. A newly provisioned profile is NOT automatically known to the
#      orchestrator (provision-profile.sh only seeds the new profile's OWN
#      volume), so decompose can never route to it.
#   2. The orchestrator stubs + descriptions live in the orchestrator's
#      per-container /opt/data volume, so rebuilding that volume silently drops
#      all routing.
#
# This script reconciles that roster from the declarative source of truth —
# the `description` field in registry/profiles-registry.yaml. It is idempotent:
# run it any time, and after every provision-profile.sh. start.sh runs it once
# the stack is healthy.
#
# It is purely additive to the orchestrator's roster: the stubs it creates are
# lightweight (--no-skills --no-alias) and never run an agent. The real agent
# for each profile runs in its own hermes-pf-<name> container; these stubs only
# give the decomposer a name + description to route to.

. "$(dirname "$0")/_common.sh"

ORCH="hermes-pf-default"
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --orchestrator=*) ORCH="${arg#*=}" ;;
        --dry-run)        DRY_RUN=1 ;;
        -h|--help)        sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "unknown arg: $arg (see --help)" ;;
    esac
done

require_cmd docker
require_yq

REGISTRY_FILE="$STACK_DIR/registry/profiles-registry.yaml"
[ -f "$REGISTRY_FILE" ] || die "registry not found: $REGISTRY_FILE"

# Orchestrator container must be up — `hermes profile` runs inside it.
running="$(docker inspect -f '{{.State.Running}}' "$ORCH" 2>/dev/null || echo false)"
[ "$running" = "true" ] || die "orchestrator container '$ORCH' is not running (start the stack first)"

# Files in the orchestrator volume are owned by the hermes user (uid 10000).
# We exec as that uid so profile.yaml isn't stranded root-owned, and so the
# stub directories match the rest of the roster.
orch() { docker exec -u 10000 "$ORCH" hermes profile "$@"; }

# Enabled profiles, in registry order.
mapfile -t NAMES < <(yq -r '.profiles[] | select(.status == "enabled") | .name' "$REGISTRY_FILE")
[ "${#NAMES[@]}" -gt 0 ] || die "no enabled profiles in registry"

log_info "syncing orchestrator '$ORCH' roster from $REGISTRY_FILE (${#NAMES[@]} enabled profiles)"
created=0; described=0; skipped=0; errors=0

for name in "${NAMES[@]}"; do
    desc="$(yq -r ".profiles[] | select(.name == \"$name\") | .description // \"\"" "$REGISTRY_FILE")"
    if [ -z "$desc" ] || [ "$desc" = "null" ]; then
        log_warn "  $name: no description in registry — skipping (decomposer can't route to it)"
        skipped=$((skipped + 1))
        continue
    fi

    if [ "$DRY_RUN" = "1" ]; then
        log_info "  [dry-run] would ensure + describe '$name': ${desc:0:60}…"
        continue
    fi

    # `describe` succeeds only if the profile already exists in the orchestrator
    # (the active 'default' profile always does; specialists exist as stubs).
    # If it doesn't, create a lightweight routing stub first, then describe.
    if orch describe "$name" --text "$desc" >/dev/null 2>&1; then
        described=$((described + 1))
    else
        log_info "  $name: not present in orchestrator — creating routing stub"
        if orch create "$name" --no-skills --no-alias >/dev/null 2>&1; then
            created=$((created + 1))
        else
            log_warn "  $name: 'profile create' reported an issue (continuing; the s6 gateway-register warning is expected and harmless)"
        fi
        # `profile create` can leave the new stub dir root-owned (s6 register
        # path runs privileged), which makes the uid-10000 `describe` below fail
        # with EACCES. Normalise ownership before describing. CHOWN cap present.
        docker exec -u 0 "$ORCH" sh -c "chown -R 10000:10000 /opt/data/profiles/'$name' 2>/dev/null" || true
        if orch describe "$name" --text "$desc" >/dev/null 2>&1; then
            described=$((described + 1))
        else
            log_err "  $name: failed to set description even after create"
            errors=$((errors + 1))
            continue
        fi
    fi
    log_info "  $name ✓"
done

echo
log_info "roster sync complete: created=$created described=$described skipped=$skipped errors=$errors"
[ "$errors" -eq 0 ] || die "one or more profiles failed to sync"
