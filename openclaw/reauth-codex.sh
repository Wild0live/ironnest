#!/usr/bin/env bash
# Re-authenticate OpenClaw with your ChatGPT subscription (openai-codex provider).
#
# The openai-codex provider uses the ChatGPT web backend (chatgpt.com/backend-api/v1).
# Authentication requires a ChatGPT session accessToken extracted from the browser.
# There is no automated OAuth flow — the token must be pasted manually.
#
# HOW TO GET YOUR TOKEN:
#   1. Open https://chatgpt.com in your browser (logged in)
#   2. Navigate to https://chatgpt.com/api/auth/session
#   3. Copy the value of "accessToken" from the JSON response
#   4. Run this script and paste the token when prompted
#
# Token lifetime: hours to a few days. Re-run when the codex provider stops working.
#
# Usage:
#   bash openclaw/reauth-codex.sh
#
# After pasting, the token is saved to the persistent volume — no restart required.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

if ! docker inspect openclaw-gateway >/dev/null 2>&1; then
  echo "ERROR: openclaw-gateway container is not running."
  echo "Start it first with: ./openclaw/start.sh"
  exit 1
fi

echo "=== Codex (ChatGPT subscription) token refresh ==="
echo ""
echo "Step 1: Open this URL in your browser (must be logged in to ChatGPT):"
echo "        https://chatgpt.com/api/auth/session"
echo "Step 2: Copy the value of \"accessToken\" from the JSON"
echo "Step 3: Paste it below when prompted"
echo ""

# winpty is required in Git Bash / mintty for proper TTY allocation.
# Fall back to plain docker exec for Windows Terminal / PowerShell.
if command -v winpty >/dev/null 2>&1; then
  winpty docker exec -it openclaw-gateway openclaw models auth paste-token --provider codex
else
  docker exec -it openclaw-gateway openclaw models auth paste-token --provider codex
fi

echo ""
echo "=== Done ==="
echo "NOTE: codex/gpt-5.4 requires ChatGPT Pro ($200/mo). Token saved but model"
echo "      will only work if your account has Pro access. Current default model"
echo "      is anthropic/claude-sonnet-4-6 (switch manually if you upgrade)."
