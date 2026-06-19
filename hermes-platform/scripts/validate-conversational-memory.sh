#!/usr/bin/env bash
# Validate the automatic Hermes MemoryProvider lifecycle through memory-gateway.
#
# This does not call an LLM. It loads the configured provider in each running
# profile, invokes the same sync_turn hook Hermes calls after a reply, and
# reads the written turn back through the policy gateway.
. "$(dirname "$0")/_common.sh"
require_cmd docker

mapfile -t profiles < <(list_profiles)
stamp="$(date +%s)"
ok=1

for profile in "${profiles[@]}"; do
    container="hermes-pf-${profile}"
    if ! docker ps --format '{{.Names}}' | grep -qx "$container"; then
        log_err "FAIL  $container is not running"
        ok=0
        continue
    fi

    # Match the live Hermes gateway UID. Running an auth-capable Hermes command
    # as docker-exec's default root user can leave /opt/data/auth.lock
    # unwritable by the gateway process.
    docker exec -i --user 10000:10000 \
        -e HERMES_PROFILE="$profile" \
        "$container" with-infisical python - "$profile" "$stamp" <<'PY'
import json
import os
import sys

os.environ["HERMES_HOME"] = "/opt/data"
from plugins.memory import load_memory_provider

profile, stamp = sys.argv[1:3]
session_id = f"provider-lifecycle-{stamp}"
provider = load_memory_provider("ironnest_gateway")
assert provider is not None, "provider not discovered"
assert provider.is_available(), "provider is not available"
provider.initialize(session_id)
provider.sync_turn(
    f"automatic lifecycle check {stamp} for {profile}",
    "AUTOMATIC_MEMORY_OK",
    session_id=session_id,
)
provider.shutdown()
uri = f"viking://profiles/{profile}/conversations/{session_id}/turn-00001.md"
body = provider._post("/memory/read", {"uri": uri})
text = json.dumps(body, ensure_ascii=False)
assert "AUTOMATIC_MEMORY_OK" in text, text
print(f"PASS  {profile}: automatic sync_turn stored and read {uri}")
PY
done

[ "$ok" = "1" ] || die "automatic conversational memory validation failed"
log_info "all running profiles passed automatic conversational memory validation"
