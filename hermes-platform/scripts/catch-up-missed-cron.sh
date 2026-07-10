#!/usr/bin/env bash
# Run missed Hermes cron schedules once after the stack comes back online.
set -euo pipefail

. "$(dirname "$0")/_common.sh"

container="hermes-platform-mission-control"
if ! docker inspect "$container" >/dev/null 2>&1; then
    log_warn "$container is not present; skipping cron catch-up"
    exit 0
fi

status="$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
if [ "$status" != "healthy" ]; then
    log_warn "$container is not healthy yet; skipping cron catch-up"
    exit 0
fi

docker exec -i "$container" python - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

token = os.environ.get("MISSION_CONTROL_ADMIN_TOKEN", "").strip()
headers = {"Content-Type": "application/json"}
if token:
    headers["Authorization"] = f"Bearer {token}"

request = urllib.request.Request(
    "http://127.0.0.1:8080/api/schedules/cron/catch-up",
    data=b"{}",
    headers=headers,
    method="POST",
)
try:
    with urllib.request.urlopen(request, timeout=270) as response:
        payload = json.loads(response.read().decode("utf-8"))
except urllib.error.HTTPError as exc:
    sys.stderr.write(f"cron catch-up failed: HTTP {exc.code}\n")
    sys.exit(1)
except Exception as exc:
    sys.stderr.write(f"cron catch-up failed: {exc}\n")
    sys.exit(1)

ran = len(payload.get("ran") or [])
skipped = len(payload.get("skipped") or [])
print(f"cron catch-up: ran={ran} skipped={skipped}")
PY
