# Shared helpers for hermes-platform/scripts/*.sh
#
# Source via:  . "$(dirname "$0")/_common.sh"
#
# Provides:
#   STACK_DIR        — absolute path to hermes-platform/
#   PLATFORM_DIR     — absolute path to platform/
#   docker_compose() — runs `docker compose` in STACK_DIR
#   log_info / log_warn / log_err / die
#   require_cmd

set -euo pipefail

# Prefer Rancher Desktop's Windows Docker client when scripts are launched from
# Windows-hosted Bash. In WSL-style shells the Linux docker client may appear
# earlier on PATH but points at a missing /var/run/docker.sock; docker.exe talks
# to Rancher Desktop's Windows pipe correctly.
for _rd_bin in \
    "/mnt/c/Program Files/Rancher Desktop/resources/resources/win32/bin" \
    "/c/Program Files/Rancher Desktop/resources/resources/win32/bin"
do
    [ -d "$_rd_bin" ] && export PATH="$_rd_bin:$PATH"
done

for _docker_exe in \
    "/mnt/c/Program Files/Rancher Desktop/resources/resources/win32/bin/docker.exe" \
    "/c/Program Files/Rancher Desktop/resources/resources/win32/bin/docker.exe"
do
    if [ -x "$_docker_exe" ]; then
        export _docker_exe
        docker() { "$_docker_exe" "$@"; }
        export -f docker
        break
    fi
done

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLATFORM_DIR="$(cd "$STACK_DIR/.." && pwd)"

log_info() { printf '\033[0;36m[%s]\033[0m %s\n' "$(basename "$0")" "$*"; }
log_warn() { printf '\033[0;33m[%s WARN]\033[0m %s\n' "$(basename "$0")" "$*" >&2; }
log_err()  { printf '\033[0;31m[%s ERR]\033[0m %s\n'  "$(basename "$0")" "$*" >&2; }
die() { log_err "$*"; exit 1; }

require_cmd() {
    for c in "$@"; do
        command -v "$c" >/dev/null 2>&1 || die "required command not found: $c"
    done
}

# Ensure `yq` is callable. If the real binary is on PATH, use it. Otherwise
# fall back to `docker run mikefarah/yq:4` and define a shell function that
# rewrites STACK_DIR-prefixed file args to the in-container /work path.
#
# MSYS/Git-Bash gotchas (see [[feedback_git_bash_docker_msys]]):
#   - Host -v paths must be Windows-style → cygpath -w on STACK_DIR.
#   - Container -w / file args must start with `//` so MSYS does NOT
#     rewrite `/work` into `C:/Program Files/Git/work`.
require_yq() {
    command -v yq >/dev/null 2>&1 && return 0
    command -v docker >/dev/null 2>&1 \
        || die "neither yq nor docker found on PATH; install one of them"
    log_warn "yq not on PATH — using docker run mikefarah/yq:4 as a fallback"
    _YQ_HOST_DIR="$STACK_DIR"
    if command -v cygpath >/dev/null 2>&1; then
        _YQ_HOST_DIR="$(cygpath -w "$STACK_DIR")"
    fi
    yq() {
        local args=() a
        for a in "$@"; do
            case "$a" in
                "$STACK_DIR"|"$STACK_DIR"/*) a="//work${a#$STACK_DIR}" ;;
            esac
            args+=("$a")
        done
        docker run --rm -i \
            -v "${_YQ_HOST_DIR}:/work" \
            -w //work \
            mikefarah/yq:4 "${args[@]}"
    }
}

docker_compose() {
    ( cd "$STACK_DIR" && docker compose "$@" )
}

# List registered profile names, in sorted order.
# Falls back to policies/*.policy.yaml basenames when yq isn't installed —
# the two sources are kept in lockstep by create-profile.sh and
# delete-profile.sh, so this is reliable for read-only flows.
list_profiles() {
    if command -v yq >/dev/null 2>&1 && [ -f "$STACK_DIR/registry/profiles-registry.yaml" ]; then
        yq -r '.profiles[].name' "$STACK_DIR/registry/profiles-registry.yaml" 2>/dev/null
    else
        # Fallback: profile name is the basename of each policy file
        for f in "$STACK_DIR/policies"/*.policy.yaml; do
            [ -f "$f" ] || continue
            basename "$f" .policy.yaml
        done | sort
    fi
}

# Validate that a profile name matches the registry rule
# (gateway/app/namespace.py _PROFILE_NAME_RE — ^[a-z][a-z0-9_-]{0,31}$)
validate_profile_name() {
    local name="$1"
    case "$name" in
        ''|*[!a-z0-9_-]*)
            die "invalid profile name: $name (must match ^[a-z][a-z0-9_-]{0,31}\$)" ;;
    esac
    case "$name" in
        [a-z]*) : ;;
        *) die "invalid profile name: $name (must start with lowercase letter)" ;;
    esac
    [ "${#name}" -le 32 ] || die "invalid profile name: $name (max 32 chars)"
}
