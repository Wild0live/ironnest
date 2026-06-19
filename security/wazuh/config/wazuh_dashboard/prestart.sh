#!/bin/bash
# Wazuh dashboard prestart wrapper.
#
# Replaces the upstream /entrypoint.sh because the upstream's keystore-setup
# (yes | opensearch-dashboards-keystore create) WIPES anything we put in the
# keystore before it runs. Our OIDC client_secret has to be added AFTER the
# upstream's username/password adds, but BEFORE the dashboard process starts.
#
# This script mirrors what /entrypoint.sh does and inserts the OIDC add at
# the right point. Keep in sync with the upstream entrypoint when upgrading
# the wazuh-dashboard image (currently 4.14.4).

set -euo pipefail

INSTALL_DIR=/usr/share/wazuh-dashboard
HOOK_DIR="$INSTALL_DIR/config"
DASHBOARD_USERNAME="${DASHBOARD_USERNAME:-kibanaserver}"
DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-kibanaserver}"

# ── Source Infisical-rendered secrets ───────────────────────────────────────
# Sourced here (not via compose env_file) because env_file is locked at
# compose-up time, before the sidecar has rendered the .env file.
OIDC_ENV="/opt/oidc-secrets/.env"
if [[ -f "$OIDC_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$OIDC_ENV"
  set +a
  echo "[prestart] Loaded $OIDC_ENV"
else
  echo "[prestart] $OIDC_ENV not found — OIDC client_secret will be missing" >&2
fi

# ── Build the combined CA bundle for NODE_EXTRA_CA_CERTS ───────────────────
if [[ -x "$HOOK_DIR/build-ca-bundle.sh" ]]; then
  "$HOOK_DIR/build-ca-bundle.sh" || echo "[prestart] CA bundle build failed (continuing)" >&2
fi

# ── Recreate the keystore (mirrors upstream /entrypoint.sh) ────────────────
# `yes | create` exits 141 (SIGPIPE from `yes`) under `pipefail`. Wrap it
# in a subshell with pipefail disabled. The keystore still gets recreated.
( set +o pipefail
  yes | "$INSTALL_DIR/bin/opensearch-dashboards-keystore" create --allow-root >/dev/null 2>&1
) || true
echo "$DASHBOARD_USERNAME" | "$INSTALL_DIR/bin/opensearch-dashboards-keystore" add opensearch.username --stdin --allow-root --force
echo "$DASHBOARD_PASSWORD" | "$INSTALL_DIR/bin/opensearch-dashboards-keystore" add opensearch.password --stdin --allow-root --force

# ── OUR addition: OIDC client_secret ───────────────────────────────────────
if [[ -n "${WAZUH_OIDC_CLIENT_SECRET:-}" ]]; then
  printf '%s' "$WAZUH_OIDC_CLIENT_SECRET" | \
    "$INSTALL_DIR/bin/opensearch-dashboards-keystore" add opensearch_security.openid.client_secret --stdin --allow-root --force
  echo "[prestart] opensearch_security.openid.client_secret loaded into keystore"
else
  echo "[prestart] WAZUH_OIDC_CLIENT_SECRET empty — OIDC client_secret NOT loaded" >&2
fi

# ── Upstream's Wazuh app config step ───────────────────────────────────────
if [[ -x /wazuh_app_config.sh ]]; then
  /wazuh_app_config.sh "${WAZUH_UI_REVISION:-}"
fi

# ── Start the dashboard ────────────────────────────────────────────────────
exec "$INSTALL_DIR/bin/opensearch-dashboards" -c "$INSTALL_DIR/config/opensearch_dashboards.yml"
