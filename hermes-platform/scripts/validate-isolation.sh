#!/usr/bin/env bash
# Prove the security model: cross-profile private memory access is denied,
# and OpenViking is unreachable from any hermes-pf-* container.
#
# Usage:  bash scripts/validate-isolation.sh [profile-name ...]
#
# If no profile names are given, runs every cross-pair from the registry.
# Reads tokens from Infisical via memory-gateway admin endpoint? No — we
# do NOT exfiltrate tokens. Instead, run the read attempts FROM INSIDE
# each hermes-pf-<name> container, where the token is already in env as
# MEMORY_GATEWAY_TOKEN.
#
# Exit code: 0 = all cases passed; non-zero = at least one regression.
. "$(dirname "$0")/_common.sh"
require_cmd docker
# list_profiles is provided by _common.sh; uses yq if present, else falls
# back to listing policies/*.policy.yaml basenames.

if [ $# -ge 1 ]; then
    profiles=("$@")
else
    mapfile -t profiles < <(list_profiles)
fi

fail_count=0
pass_count=0
case_id=0

# Match codes for the validation invariants we ACTUALLY care about:
#   "ALLOW" cases expect "policy let it through" — anything that is NOT
#     401 (auth failed) and NOT 403 (policy denied). Storage-layer 404
#     or 4xx/5xx are acceptable — they mean OpenViking handled the
#     request after auth+policy approval; the storage outcome is
#     irrelevant to the SECURITY invariant.
#   "DENY" cases expect EXACTLY 403 (policy refused). Anything else is
#     either a regression (200 = wrongly allowed) or a different bug
#     (401 = auth issue).
#   "NETWORK" cases expect EXACTLY 000 (no TCP route).
status_matches() {
    local got="$1" expected="$2"
    case "$expected" in
        ALLOW)
            # Pass on anything that's not auth-fail (401) or policy-deny (403)
            [ "$got" != "401" ] && [ "$got" != "403" ] && [ -n "$got" ] && return 0
            return 1 ;;
        DENY)
            [ "$got" = "403" ] && return 0
            return 1 ;;
        NETWORK_BLOCKED)
            [ "$got" = "000" ] && return 0
            return 1 ;;
        *)
            [ "$got" = "$expected" ] && return 0
            return 1 ;;
    esac
}

run_case() {
    local desc="$1" expected="$2"
    shift 2
    case_id=$((case_id + 1))
    body="$("$@" 2>/dev/null || true)"
    status=$(printf '%s' "$body" | tail -n1)
    if status_matches "$status" "$expected"; then
        pass_count=$((pass_count + 1))
        printf '  [%02d]  PASS  %s  (HTTP %s, expected %s)\n' \
            "$case_id" "$desc" "$status" "$expected"
    else
        fail_count=$((fail_count + 1))
        printf '  [%02d]  FAIL  %s  (got HTTP %s, expected class %s)\n' \
            "$case_id" "$desc" "$status" "$expected" >&2
    fi
}

# Helper: from inside container $c, POST to memory-gateway and print "<HTTP_STATUS>".
#
# CRITICAL: hermes-pf-* containers receive MEMORY_GATEWAY_TOKEN via the
# `with-infisical` wrapper, which injects env vars ONLY into the wrapped
# process tree. A bare `docker exec` spawns a fresh shell that does NOT
# inherit those env vars. So we wrap the curl call in `with-infisical`
# again — it re-authenticates to Infisical and re-injects the env.
gw_call_from() {
    local container="$1" path="$2" json="$3"
    docker exec "$container" with-infisical sh -c "curl -sS -o /dev/null -w '%{http_code}' \
        -H \"Authorization: Bearer \$MEMORY_GATEWAY_TOKEN\" \
        -H 'Content-Type: application/json' \
        -d '$json' \
        http://memory-gateway:8080$path"
}

# Helper: network reachability check from a hermes-pf-* container.
# No token needed here — we're proving openviking is unreachable at the
# network layer, before any auth check happens.
ov_reach_from() {
    # curl prints "000" via -w when it can't connect, AND returns non-zero.
    # The `|| true` swallows the exit code so we don't print "000" twice.
    local container="$1"
    docker exec "$container" sh -c "curl -sS -o /dev/null -w '%{http_code}' \
        --noproxy '*' -m 5 http://openviking:1933/ 2>/dev/null; true"
}

log_info "running isolation case matrix across ${#profiles[@]} profile(s)"

for p in "${profiles[@]}"; do
    c="hermes-pf-$p"
    if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
        log_warn "$c not running, skipping"
        continue
    fi

    # 1. OpenViking must be unreachable from the profile container
    run_case "$c → openviking:1933 must be unreachable" "NETWORK_BLOCKED" \
        ov_reach_from "$c"

    # 2. Reading own private namespace must succeed (200) or be 404 if no data
    run_case "$c → read own viking://profiles/$p/notes must be ALLOWED" "ALLOW" \
        gw_call_from "$c" "/memory/read" \
        "{\"uri\":\"viking://profiles/$p/notes\"}"

    # 3. Reading shared/** must be ALLOWED
    run_case "$c → read viking://shared/org must be ALLOWED" "ALLOW" \
        gw_call_from "$c" "/memory/read" \
        "{\"uri\":\"viking://shared/org\"}"

    # 4. Writing own approved-shared must be ALLOWED
    run_case "$c → write viking://shared/approved/$p/note must be ALLOWED" "ALLOW" \
        gw_call_from "$c" "/memory/write" \
        "{\"uri\":\"viking://shared/approved/$p/test-$(date +%s)\",\"content\":\"x\"}"

    # 5. Cross-profile DENIES — for every OTHER profile, reading their private
    for other in "${profiles[@]}"; do
        [ "$other" = "$p" ] && continue
        run_case "$c → read viking://profiles/$other/notes must be DENIED" "DENY" \
            gw_call_from "$c" "/memory/read" \
            "{\"uri\":\"viking://profiles/$other/notes\"}"

        run_case "$c → write viking://profiles/$other/notes must be DENIED" "DENY" \
            gw_call_from "$c" "/memory/write" \
            "{\"uri\":\"viking://profiles/$other/notes\",\"content\":\"x\"}"

        run_case "$c → write viking://shared/approved/$other/x must be DENIED" "DENY" \
            gw_call_from "$c" "/memory/write" \
            "{\"uri\":\"viking://shared/approved/$other/x\",\"content\":\"x\"}"
    done

    # 6. Path traversal must be DENIED
    run_case "$c → uri with .. must be DENIED" "DENY" \
        gw_call_from "$c" "/memory/read" \
        "{\"uri\":\"viking://profiles/$p/../../etc/passwd\"}"
done

echo
log_info "results: $pass_count passed, $fail_count failed"
[ "$fail_count" = 0 ] || die "isolation regression detected"
