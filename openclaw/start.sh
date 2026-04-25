#!/usr/bin/env bash
# Start OpenClaw, repairing platform-egress bridge routing first if needed.
# Use this instead of bare "docker compose up -d" after any Rancher Desktop restart.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

PLATFORM="$(cd "$(dirname "$0")/.." && pwd)"

"$PLATFORM/ops/fix-nat-prerouting.sh"
"$PLATFORM/ops/repair-egress.sh"

cd "$PLATFORM/openclaw"
docker compose up -d

# Block direct outbound from the ingress bridge at kernel level.
# Must run after compose up so openclaw_ingress network exists.
"$PLATFORM/ops/fix-openclaw-egress.sh"

# ── Auth key registration ────────────────────────────────────────────────────
# Wait for the gateway to be healthy, then register any provider API keys that
# were injected by the Infisical agent into the container env. This ensures a
# key rotated in Infisical is always current in auth-profiles.json without any
# manual intervention.

echo "--- waiting for openclaw-gateway to be healthy ---"
until [ "$(docker inspect -f '{{.State.Health.Status}}' openclaw-gateway 2>/dev/null)" = "healthy" ]; do
  printf '.'
  sleep 3
done
echo " healthy"

# OpenAI — standard api.openai.com provider (sk-... key).
# Writes auth-profiles.json directly (avoids the interactive TUI prompt that
# paste-token requires, which doesn't work in non-TTY exec contexts).
OPENAI_KEY="$(docker exec openclaw-gateway sh -c 'printf "%s" "$OPENAI_API_KEY"' 2>/dev/null || true)"
if [ -n "$OPENAI_KEY" ]; then
  echo "--- registering OPENAI_API_KEY into auth-profiles.json ---"
  NOW="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  JSON="$(printf '{"openai:manual":{"profileId":"openai:manual","provider":"openai","token":"%s","createdAt":"%s"}}' "$OPENAI_KEY" "$NOW")"
  docker exec openclaw-gateway sh -c "printf '%s' '$JSON' > /home/node/.openclaw/agents/main/agent/auth-profiles.json"
  echo "--- openai provider auth registered ---"
else
  echo "--- OPENAI_API_KEY not found in gateway env, skipping openai auth ---"
fi

# Codex (ChatGPT subscription / openai-codex provider) ──────────────────────
# OAuth session is set once via: docker exec -it openclaw-gateway openclaw models auth login --provider codex
# The session token persists in the volume and survives restarts. Re-login is
# only needed when the session expires (typically every few weeks).
# Check whether a codex auth profile already exists and report its status.
CODEX_AUTH="$(docker exec openclaw-gateway //bin/sh -c \
  "cat /home/node/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null | grep -c 'codex:manual' || echo 0" 2>/dev/null || echo 0)"
if [ "$CODEX_AUTH" -gt 0 ] 2>/dev/null; then
  echo "--- codex session token found in auth-profiles.json ---"
else
  echo "--- WARNING: no codex session token found ---"
  echo "    Run to refresh your ChatGPT subscription token:"
  echo "    bash openclaw/reauth-codex.sh"
fi

# ── Egress enforcement verification ─────────────────────────────────────────
echo "--- verifying direct egress is blocked ---"
if docker exec openclaw-gateway curl --noproxy "*" -m 5 -sf https://example.com -o /dev/null 2>/dev/null; then
  echo "WARNING: direct bypass still reachable — DOCKER-USER rule may not have applied"
else
  echo "OK: direct bypass blocked (--noproxy curl to example.com timed out as expected)"
fi
