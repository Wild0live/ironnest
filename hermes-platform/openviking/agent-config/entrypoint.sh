#!/bin/sh
# hermes-platform — openviking infisical-agent sidecar entrypoint.
#
# Mirrors the browser-intent infisical-agent pattern:
#   1. Authenticate to Infisical via Universal Auth machine identity
#   2. Render /secrets/.env from the secrets at INFISICAL_PATH (recursive)
#   3. Poll every 60s and re-render if anything changes (atomic replace)
#
# The openviking container watches /secrets/.env (mtime) and re-reads it
# on every rendered config rebuild.
set -eu

: "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:?missing}"
: "${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:?missing}"
: "${INFISICAL_PROJECT_ID:?missing}"
INFISICAL_DOMAIN="${INFISICAL_DOMAIN:-http://infisical:8090}"
INFISICAL_ENV="${INFISICAL_ENV:-dev}"
INFISICAL_PATH="${INFISICAL_PATH:-/hermes-platform/openviking}"

SECRETS_DIR=/secrets
SECRETS_FILE="$SECRETS_DIR/.env"
TMP_FILE="$SECRETS_DIR/.env.tmp"
LOGIN_HOME=$(mktemp -d)

render_once() {
    INFISICAL_TOKEN=$(HOME="$LOGIN_HOME" infisical login \
        --method=universal-auth --domain="$INFISICAL_DOMAIN" \
        --plain --silent)
    export INFISICAL_TOKEN

    # Single-path export (we don't have sub-folders under /hermes-platform/openviking).
    # `--include-imports` pulls in Secret Links from /hermes-platform (the shared
    # keys folder), so a Secret Link from /hermes-platform/openviking/EMBEDDING_API_KEY
    # to /hermes-platform/GEMINI_API_KEY works transparently.
    infisical export \
        --domain="$INFISICAL_DOMAIN" \
        --projectId="$INFISICAL_PROJECT_ID" \
        --env="$INFISICAL_ENV" \
        --path="$INFISICAL_PATH" \
        --include-imports \
        --format=dotenv \
        > "$TMP_FILE"

    # 0644 (world-readable) is required because the openviking container runs
    # as non-root UID 11000 and needs to source this file. The /secrets volume
    # is mounted into ONLY two containers (this sidecar rw + openviking ro),
    # so world-read is functionally equivalent to 0600 owner=openviking.
    chmod 0644 "$TMP_FILE"
    mv "$TMP_FILE" "$SECRETS_FILE"
    unset INFISICAL_TOKEN
}

echo "openviking-infisical-agent: initial render from $INFISICAL_PATH"
render_once
echo "openviking-infisical-agent: ready (polling every 60s)"

while true; do
    sleep 60
    render_once 2>&1 | sed 's/^/openviking-infisical-agent: /' || \
        echo "openviking-infisical-agent: render failed (will retry in 60s)"
done
