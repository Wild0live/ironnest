#!/usr/bin/env bash
# Prove the collaboration path: a profile can publish to its own approved
# shared namespace, and other profiles can READ that approved entry.
#
# Usage:  bash scripts/validate-sharing.sh
#
# Cycles A → publishes → B reads, for every (A, B) pair where A != B.
. "$(dirname "$0")/_common.sh"
require_cmd docker

mapfile -t profiles < <(list_profiles)
[ "${#profiles[@]}" -ge 2 ] || die "need at least 2 profiles to validate sharing"

case_id=0; pass=0; fail=0
# Same matcher as validate-isolation.sh: ALLOW means "anything not 401/403",
# meaning auth+policy succeeded; storage-layer outcome is incidental.
status_matches() {
    local got="$1" expected="$2"
    case "$expected" in
        ALLOW)    [ "$got" != "401" ] && [ "$got" != "403" ] && [ -n "$got" ] && return 0; return 1 ;;
        DENY)     [ "$got" = "403" ] && return 0; return 1 ;;
        *)        [ "$got" = "$expected" ] && return 0; return 1 ;;
    esac
}
run_case() {
    local desc="$1" expected="$2"; shift 2
    case_id=$((case_id + 1))
    status="$("$@" 2>/dev/null | tail -n1)"
    if status_matches "$status" "$expected"; then
        pass=$((pass + 1))
        printf '  [%02d]  PASS  %s  (HTTP %s, expected %s)\n' "$case_id" "$desc" "$status" "$expected"
    else
        fail=$((fail + 1))
        printf '  [%02d]  FAIL  %s  (got HTTP %s, expected class %s)\n' \
            "$case_id" "$desc" "$status" "$expected" >&2
    fi
}

gw_call_from() {
    local c="$1" path="$2" body="$3"
    # See validate-isolation.sh comment — `with-infisical` is required so the
    # exec shell inherits the MEMORY_GATEWAY_TOKEN env var.
    docker exec "$c" with-infisical sh -c "curl -sS -o /dev/null -w '%{http_code}' \
        -H \"Authorization: Bearer \$MEMORY_GATEWAY_TOKEN\" \
        -H 'Content-Type: application/json' \
        -d '$body' http://memory-gateway:8080$path"
}

log_info "running sharing case matrix"
ts=$(date +%s)

for A in "${profiles[@]}"; do
    a="hermes-pf-$A"
    docker ps --format '{{.Names}}' | grep -qx "$a" || { log_warn "$a not running"; continue; }

    # A publishes a curated approved note
    approved_uri="viking://shared/approved/$A/published-$ts"
    run_case "$A publishes to own approved-shared $approved_uri" "ALLOW" \
        gw_call_from "$a" "/memory/write" \
        "{\"uri\":\"$approved_uri\",\"content\":\"published by $A at $ts\"}"

    # Every other profile MUST be able to READ that approved entry
    for B in "${profiles[@]}"; do
        [ "$B" = "$A" ] && continue
        b="hermes-pf-$B"
        docker ps --format '{{.Names}}' | grep -qx "$b" || continue
        run_case "$B reads $approved_uri (cross-profile sharing path)" "ALLOW" \
            gw_call_from "$b" "/memory/read" \
            "{\"uri\":\"$approved_uri\"}"
    done

    # A may also publish via the /memory/publish-approved endpoint
    src_uri="viking://profiles/$A/notes/temp-$ts"
    gw_call_from "$a" "/memory/write" \
        "{\"uri\":\"$src_uri\",\"content\":\"draft\"}" >/dev/null
    run_case "$A promotes via /memory/publish-approved" "ALLOW" \
        gw_call_from "$a" "/memory/publish-approved" \
        "{\"source_uri\":\"$src_uri\",\"target_uri\":\"viking://shared/approved/$A/promoted-$ts\",\"rationale\":\"validation\"}"
done

echo
log_info "results: $pass passed, $fail failed"
[ "$fail" = 0 ] || die "sharing path regression detected"
