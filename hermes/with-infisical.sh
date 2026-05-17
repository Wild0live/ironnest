#!/bin/sh
# IronNest: wrap a command with Infisical-injected secrets.
#
# Logs into the local Infisical instance via Universal Auth (machine identity),
# fetches secrets for the configured project/env/path, and exec's the wrapped
# command with those secrets injected as environment variables. Secrets live
# only in the process environment — never written to disk.
#
# Required env vars (loaded from compose env_file: ./.env):
#   INFISICAL_UNIVERSAL_AUTH_CLIENT_ID
#   INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
#   INFISICAL_PROJECT_ID
#
# Optional env vars (with defaults):
#   INFISICAL_DOMAIN  (default: http://infisical:8090)
#   INFISICAL_ENV     (default: dev)
#   INFISICAL_PATH    (default: /)
#
# Usage in compose: command: ["with-infisical", "sh", "-c", "..."]

set -eu

: "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:?with-infisical: missing INFISICAL_UNIVERSAL_AUTH_CLIENT_ID}"
: "${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:?with-infisical: missing INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET}"
: "${INFISICAL_PROJECT_ID:?with-infisical: missing INFISICAL_PROJECT_ID}"

INFISICAL_DOMAIN="${INFISICAL_DOMAIN:-http://infisical:8090}"
INFISICAL_ENV="${INFISICAL_ENV:-dev}"
INFISICAL_PATH="${INFISICAL_PATH:-/}"

# Sandbox HOME during login so the CLI's config (token cache, machine ID)
# never lands on the persistent /opt/data volume.
LOGIN_HOME=$(mktemp -d)
trap 'rm -rf "$LOGIN_HOME"' EXIT

# Pass token via INFISICAL_TOKEN env var rather than --token=, so it never
# appears in argv (visible to anyone who can `ps -ef` inside the container).
# Same reasoning for the login: client-id/client-secret are read from the
# already-exported INFISICAL_UNIVERSAL_AUTH_CLIENT_{ID,SECRET} env vars
# instead of being passed as --client-id / --client-secret flags.
INFISICAL_TOKEN=$(HOME="$LOGIN_HOME" infisical login \
  --method=universal-auth \
  --domain="$INFISICAL_DOMAIN" \
  --plain --silent)
export INFISICAL_TOKEN

unset INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET

# `exec` replaces this shell, so EXIT traps won't fire — clean up first.
rm -rf "$LOGIN_HOME"
trap - EXIT

exec infisical run \
  --domain="$INFISICAL_DOMAIN" \
  --projectId="$INFISICAL_PROJECT_ID" \
  --env="$INFISICAL_ENV" \
  --path="$INFISICAL_PATH" \
  --silent \
  -- "$@"
