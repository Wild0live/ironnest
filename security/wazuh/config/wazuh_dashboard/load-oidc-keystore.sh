#!/bin/bash
# Loads WAZUH_OIDC_CLIENT_SECRET into the OpenSearch Dashboards keystore.
#
# Runs as a prestart hook inside wazuh.dashboard (wired via the container
# entrypoint chain — see docker-compose.yml). The secret must be populated
# before the dashboard process starts, otherwise OpenID auth fails with
# "client_secret not configured".
#
# Why a keystore and not a yaml field?
# opensearch_dashboards.yml does NOT do env-var substitution for
# `opensearch_security.openid.client_secret`. The OpenSearch Security
# plugin reads it from the dashboards keystore at startup.
#
# This script is idempotent — `--force` overwrites whatever's already there.
# Safe to run on every container start.

set -euo pipefail

if [[ -z "${WAZUH_OIDC_CLIENT_SECRET:-}" ]]; then
  echo "[load-oidc-keystore] WAZUH_OIDC_CLIENT_SECRET is empty — skipping keystore population." >&2
  echo "[load-oidc-keystore] The dashboard will start but OIDC auth will fail." >&2
  exit 0
fi

KEYSTORE_BIN="/usr/share/wazuh-dashboard/bin/opensearch-dashboards-keystore"

if [[ ! -x "$KEYSTORE_BIN" ]]; then
  echo "[load-oidc-keystore] $KEYSTORE_BIN not found — wrong image?" >&2
  exit 1
fi

# Initialize the keystore if it doesn't exist yet (first boot).
if ! "$KEYSTORE_BIN" list >/dev/null 2>&1; then
  "$KEYSTORE_BIN" create
fi

printf '%s' "$WAZUH_OIDC_CLIENT_SECRET" | \
  "$KEYSTORE_BIN" add --stdin --force opensearch_security.openid.client_secret

echo "[load-oidc-keystore] opensearch_security.openid.client_secret loaded into keystore."
