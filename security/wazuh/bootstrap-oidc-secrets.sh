#!/usr/bin/env bash
# Bootstrap the four Infisical secrets needed for Wazuh ↔ Authelia OIDC.
#
# Generates fresh material with openssl, computes the Authelia-format PBKDF2
# hash of the OIDC client secret, and pushes all four into Infisical via the
# `infisical` CLI (run inside platform/infisical-cli:0.43.76-patched, which
# already has network reach to infisical:8090 on platform-net).
#
# Requires on host: docker, openssl
# Uses Universal Auth credentials from security/wazuh/.env or openclaw/.env.
#
# Idempotent: re-running OVERWRITES the four secret values. Don't re-run
# casually — it will invalidate the existing JWKS key + force every Wazuh
# session to re-auth.
#
# Project/env hardcoded to match openclaw + hermes templating:
#   project: 63d75eb0-ef3a-4ce3-908d-46360b922fa8
#   env:     dev
#   path:    /wazuh-oidc/

set -euo pipefail

PROJECT_ID="63d75eb0-ef3a-4ce3-908d-46360b922fa8"
ENV_SLUG="dev"
SECRET_PATH="/wazuh-oidc/"
INFISICAL_IMAGE="platform/infisical-cli:0.43.76-patched"

# ── Load Universal Auth creds ───────────────────────────────────────────────
WAZUH_ENV="$(dirname "$0")/.env"
OPENCLAW_ENV="$(dirname "$0")/../../openclaw/.env"

# shellcheck disable=SC1090
[[ -f "$WAZUH_ENV"    ]] && source <(grep -E '^INFISICAL_UNIVERSAL_AUTH' "$WAZUH_ENV"    || true)
# shellcheck disable=SC1090
[[ -f "$OPENCLAW_ENV" ]] && source <(grep -E '^INFISICAL_UNIVERSAL_AUTH' "$OPENCLAW_ENV" || true)

: "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:?Set in security/wazuh/.env or openclaw/.env}"
: "${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:?Set in security/wazuh/.env or openclaw/.env}"

# ── Generate material ───────────────────────────────────────────────────────
echo "[bootstrap] Generating OIDC HMAC secret..."
HMAC="$(openssl rand -hex 48)"

echo "[bootstrap] Generating RSA 2048 JWKS private key..."
JWKS_PEM="$(openssl genrsa 2048 2>/dev/null)"

echo "[bootstrap] Generating Wazuh OIDC client secret..."
CLIENT_SECRET="$(openssl rand -hex 24)"

echo "[bootstrap] Computing Authelia PBKDF2 hash of client secret..."
CLIENT_SECRET_HASH="$(docker exec -i authelia authelia crypto hash generate pbkdf2 \
  --variant sha512 --iterations 310000 --password "$CLIENT_SECRET" 2>&1 \
  | grep -oE '\$pbkdf2-sha512\$[^[:space:]]+' | head -1)"

if [[ -z "$CLIENT_SECRET_HASH" ]]; then
  echo "[bootstrap] FAILED to extract PBKDF2 hash from authelia crypto output." >&2
  exit 1
fi

# ── Stage payload files in a temp dir mounted into the CLI container ────────
TMP_PAYLOAD="$(mktemp -d)"
trap 'rm -rf "$TMP_PAYLOAD"' EXIT
chmod 700 "$TMP_PAYLOAD"

# Build a YAML manifest of all four secrets. YAML supports multi-line values
# via the `|` block scalar — needed for the RSA PEM.
# The CLI's `secrets set --file=` syntax dereferences and stores the parsed
# VALUE; the `@/path/file` shorthand stores the literal string (bug or
# version mismatch — we verified it stored "@/payload/..." last attempt).
{
  echo "AUTHELIA_OIDC_HMAC: \"$HMAC\""
  echo "WAZUH_OIDC_CLIENT_SECRET: \"$CLIENT_SECRET\""
  # Hash contains $ chars that YAML treats literally inside double quotes, but
  # we wrap in single quotes to be safe against any future Authelia format change.
  printf "WAZUH_OIDC_CLIENT_SECRET_HASH: '"
  printf '%s' "$CLIENT_SECRET_HASH" | sed "s/'/''/g"   # YAML single-quote escape
  echo "'"
  echo "AUTHELIA_OIDC_JWKS_PRIVATE_KEY: |"
  printf '%s\n' "$JWKS_PEM" | sed 's/^/  /'
} > "$TMP_PAYLOAD/secrets.yaml"

# Windows path conversion for the bind mount (Git Bash quirk).
if command -v cygpath >/dev/null 2>&1; then
  TMP_PAYLOAD_HOST="$(cygpath -w "$TMP_PAYLOAD")"
else
  TMP_PAYLOAD_HOST="$TMP_PAYLOAD"
fi

# ── Push via infisical CLI (in-network → no Authelia gate) ──────────────────
echo "[bootstrap] Pushing four secrets via infisical CLI..."

# MSYS_NO_PATHCONV=1 stops Git Bash from translating "/wazuh-oidc/" into a
# Windows path before docker sees it. Safe here because host-side cygpath
# was already applied to TMP_PAYLOAD_HOST above.
MSYS_NO_PATHCONV=1 docker run --rm \
  --network platform-net \
  -e INFISICAL_API_URL="http://infisical:8090" \
  -e CID="$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" \
  -e CSEC="$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" \
  -e PROJECT_ID="$PROJECT_ID" \
  -e ENV_SLUG="$ENV_SLUG" \
  -e SECRET_PATH="$SECRET_PATH" \
  -v "${TMP_PAYLOAD_HOST}:/payload:ro" \
  --entrypoint sh \
  "$INFISICAL_IMAGE" -c '
    set -e
    echo "[cli] Logging in via Universal Auth..."
    TOKEN=$(infisical login --method=universal-auth \
      --client-id="$CID" --client-secret="$CSEC" --plain --silent)
    [ -n "$TOKEN" ] || { echo "Login returned empty token"; exit 1; }

    echo "[cli] Ensuring folder $SECRET_PATH exists (ignore if already present)..."
    infisical secrets folders create \
      --name="wazuh-oidc" --path="/" \
      --projectId="$PROJECT_ID" --env="$ENV_SLUG" \
      --token="$TOKEN" --silent 2>&1 | grep -v "already exists" || true

    echo "[cli] Upserting all four secrets from YAML manifest..."
    infisical secrets set \
      --file=/payload/secrets.yaml \
      --projectId="$PROJECT_ID" \
      --env="$ENV_SLUG" \
      --path="$SECRET_PATH" \
      --type=shared \
      --token="$TOKEN" \
      --silent

    echo "[cli] All four secrets in place at $SECRET_PATH"
  '

echo "[bootstrap] Done."
echo
echo "Verify in the Infisical UI: https://infisical.ironnest.local/"
echo "  Project ID: $PROJECT_ID"
echo "  Env:        $ENV_SLUG"
echo "  Path:       $SECRET_PATH"
