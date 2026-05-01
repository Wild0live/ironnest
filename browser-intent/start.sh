#!/usr/bin/env bash
# Start Browser Intent, repairing platform-egress bridge routing first if needed.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

PLATFORM="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$PLATFORM/browser-intent/.env" ]; then
  echo "ERROR: browser-intent/.env is missing."
  echo "Create it from browser-intent/.env.example and add the IronNest Infisical Machine Identity credentials."
  exit 1
fi

if grep -q '<YOUR_IRONNEST_INFISICAL_PROJECT_ID>' "$PLATFORM/browser-intent/agent-config/secrets.tmpl"; then
  echo "ERROR: browser-intent/agent-config/secrets.tmpl still contains <YOUR_IRONNEST_INFISICAL_PROJECT_ID>."
  echo "Replace it with the IronNest Infisical project UUID before starting Browser Intent."
  exit 1
fi

"$PLATFORM/ops/fix-nat-prerouting.sh"
"$PLATFORM/ops/repair-egress.sh"

cd "$PLATFORM/browser-intent"
docker compose up -d

echo "--- waiting for browser-intent-mcp to be healthy ---"
until [ "$(docker inspect -f '{{.State.Health.Status}}' browser-intent-mcp 2>/dev/null)" = "healthy" ]; do
  printf '.'
  sleep 3
done
echo " healthy"
echo "Browser Intent MCP/API: http://127.0.0.1:18901"
