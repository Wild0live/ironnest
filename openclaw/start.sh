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
# were injected by the Infisical agent into the container env. Each key is
# merged into auth-profiles.json so existing entries (e.g. codex session) are
# preserved across re-runs.

echo "--- waiting for openclaw-gateway to be healthy ---"
until [ "$(docker inspect -f '{{.State.Health.Status}}' openclaw-gateway 2>/dev/null)" = "healthy" ]; do
  printf '.'
  sleep 3
done
echo " healthy"

# Helper: merge a single provider entry into auth-profiles.json (node is always
# present in the openclaw image). Reads the file, merges the new entry, writes back.
register_provider() {
  local profile_id="$1"   # e.g. "openai:manual"
  local provider="$2"     # e.g. "openai"
  local token="$3"        # the API key value
  local auth_file="/home/node/.openclaw/agents/main/agent/auth-profiles.json"
  docker exec openclaw-gateway node -e "
    const fs = require('fs');
    const f = '$auth_file';
    let d = {};
    try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e) {}
    d['$profile_id'] = {
      profileId: '$profile_id',
      provider: '$provider',
      token: '$token',
      createdAt: new Date().toISOString()
    };
    fs.writeFileSync(f, JSON.stringify(d));
  "
}

# OpenAI — standard api.openai.com provider (sk-... key).
OPENAI_KEY="$(docker exec openclaw-gateway sh -c 'printf "%s" "$OPENAI_API_KEY"' 2>/dev/null || true)"
if [ -n "$OPENAI_KEY" ]; then
  echo "--- registering OPENAI_API_KEY into auth-profiles.json ---"
  register_provider "openai:manual" "openai" "$OPENAI_KEY"
  echo "--- openai provider auth registered ---"
else
  echo "--- OPENAI_API_KEY not found in gateway env, skipping openai auth ---"
fi

# Google Gemini — gemini.google.com provider (AIza... key).
GEMINI_KEY="$(docker exec openclaw-gateway sh -c 'printf "%s" "$GEMINI_API_KEY"' 2>/dev/null || true)"
if [ -n "$GEMINI_KEY" ]; then
  echo "--- registering GEMINI_API_KEY into auth-profiles.json ---"
  register_provider "google:manual" "google" "$GEMINI_KEY"
  echo "--- google/gemini provider auth registered ---"
else
  echo "--- GEMINI_API_KEY not found in gateway env, skipping google auth ---"
fi

# Codex (ChatGPT subscription / openai-codex provider) ──────────────────────
# OAuth session is set once via: docker exec -it openclaw-gateway openclaw models auth login --provider codex
# The session token persists in the volume and survives restarts. Re-login is
# only needed when the session expires (typically every few weeks).
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
