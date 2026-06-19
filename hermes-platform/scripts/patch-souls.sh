#!/usr/bin/env bash
# Append or replace the `## OpenViking Memory Policy` section in each
# profile's SOUL.md.
#
# Usage:  bash scripts/patch-souls.sh [--dry-run] [--profile <name>]
#
# Behavior:
#   * Always backs up SOUL.md → SOUL.md.bak.<epoch> before mutating
#   * If `## OpenViking Memory Policy` heading is absent → append it
#   * If present → REPLACE only that section (from the heading up to the
#     next H2 heading or EOF). Other content untouched.
#   * Idempotent: re-running with no template changes is a no-op
#     (backup file still created so audit trail is preserved).
#
# --dry-run prints the diff and does NOT write.
. "$(dirname "$0")/_common.sh"
require_cmd docker

DRY=0
ONLY=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY=1; shift ;;
        --profile) ONLY="$2"; validate_profile_name "$ONLY"; shift 2 ;;
        *) die "unknown arg: $1" ;;
    esac
done

if [ -n "$ONLY" ]; then
    profiles=("$ONLY")
else
    mapfile -t profiles < <(list_profiles)
fi

TS="$(date +%s)"
TEMPLATE="$STACK_DIR/profile-template/SOUL.md.template"
[ -f "$TEMPLATE" ] || die "missing template: $TEMPLATE"

for name in "${profiles[@]}"; do
    vol="hermes-platform_data-${name}"
    if ! docker volume inspect "$vol" >/dev/null 2>&1; then
        log_warn "volume $vol does not exist, skipping"
        continue
    fi
    log_info "processing $name"

    # Render the OpenViking Memory Policy section for this profile by
    # extracting it from the template and substituting <PROFILE-NAME>.
    POLICY_SECTION="$(awk '
        /^## OpenViking Memory Policy[[:space:]]*$/ { in_section=1 }
        in_section { print }
    ' "$TEMPLATE" | sed "s|<PROFILE-NAME>|$name|g")"

    if [ -z "$POLICY_SECTION" ]; then
        die "could not extract '## OpenViking Memory Policy' from template"
    fi

    # Run the mutation inside an alpine container with awk available.
    DRY_FLAG="$DRY" TS="$TS" docker run --rm -i \
        -v "$vol:/opt/data" \
        -e DRY_FLAG="$DRY" \
        -e TS="$TS" \
        -e POLICY_SECTION="$POLICY_SECTION" \
        alpine:3.20 sh <<'INNER'
set -eu
cd /opt/data
if [ ! -f SOUL.md ]; then
    echo "  no SOUL.md present; skipping (run create-profile.sh to seed)"
    exit 0
fi

# Backup first (even in dry-run, so the audit trail exists; cheap copy)
if [ "$DRY_FLAG" != "1" ]; then
    cp -p SOUL.md "SOUL.md.bak.$TS"
fi

# Split SOUL.md into:
#   HEAD  — everything BEFORE the `## OpenViking Memory Policy` heading
#   TAIL  — empty if no such heading; otherwise everything AFTER its section
# Then write HEAD + POLICY_SECTION + TAIL.
HEAD_FILE=$(mktemp)
TAIL_FILE=$(mktemp)

awk '
    BEGIN { state = "head" }
    /^## OpenViking Memory Policy[[:space:]]*$/ {
        if (state == "head") { state = "in"; next }
    }
    state == "in" {
        # leaving on next H2 heading
        if (/^## /) { state = "tail" }
    }
    state == "head" { print > "'"$HEAD_FILE"'" }
    state == "tail" { print > "'"$TAIL_FILE"'" }
' SOUL.md

NEW_FILE=$(mktemp)
{
    cat "$HEAD_FILE"
    # Ensure a single blank line between head and section
    if [ -s "$HEAD_FILE" ]; then
        tail_char=$(tail -c1 "$HEAD_FILE" | od -An -c | tr -d ' ')
        [ "$tail_char" = "\\n" ] || printf '\n'
        printf '\n'
    fi
    printf '%s\n' "$POLICY_SECTION"
    if [ -s "$TAIL_FILE" ]; then
        printf '\n'
        cat "$TAIL_FILE"
    fi
} > "$NEW_FILE"

if cmp -s SOUL.md "$NEW_FILE"; then
    echo "  no changes (already up to date)"
else
    if [ "$DRY_FLAG" = "1" ]; then
        echo "  DRY-RUN — would update SOUL.md:"
        diff -u SOUL.md "$NEW_FILE" | sed 's/^/    /' | head -120 || true
    else
        mv "$NEW_FILE" SOUL.md
        chown 10000:10000 SOUL.md "SOUL.md.bak.$TS"
        echo "  updated SOUL.md (backup at SOUL.md.bak.$TS)"
    fi
fi
rm -f "$HEAD_FILE" "$TAIL_FILE" "$NEW_FILE" 2>/dev/null || true
INNER
done
log_info "patch-souls done"
