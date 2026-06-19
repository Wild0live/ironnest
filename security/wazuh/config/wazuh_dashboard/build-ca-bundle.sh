#!/bin/bash
# Concatenates the Wazuh internal CA + the Traefik self-signed CA into a
# single PEM bundle so Node can trust both via NODE_EXTRA_CA_CERTS (which
# only accepts ONE file path).
#
# Without this, the dashboard's OpenID Connect plugin can fetch OP metadata
# from https://auth.ironnest.local (Traefik CA trusted) OR talk to
# https://wazuh.indexer:9200 (Wazuh CA trusted), but not both.
#
# Runs as a prestart hook before the dashboard process. Output is written
# to a writable named volume mounted at /usr/share/wazuh-dashboard/certs/bundle.
# NODE_EXTRA_CA_CERTS in docker-compose.yml points at the bundle output.

set -euo pipefail

WAZUH_CA="/usr/share/wazuh-dashboard/certs/root-ca.pem"
# Traefik volume contains server.crt (self-signed; subject == issuer so it
# acts as its own CA when used as a trust anchor). Wildcard SAN
# *.ironnest.local covers auth.ironnest.local.
TRAEFIK_CA="/usr/share/wazuh-dashboard/certs/traefik/server.crt"
# /usr/share/wazuh-dashboard/certs/ is owned by root + not writable by the
# wazuh-dashboard runtime user. Write the bundle to /tmp instead.
BUNDLE_DIR="/tmp/ca-bundle"
BUNDLE_OUT="$BUNDLE_DIR/ca-bundle.pem"

if [[ ! -f "$WAZUH_CA" ]]; then
  echo "[build-ca-bundle] $WAZUH_CA missing — Wazuh init didn't run?" >&2
  exit 1
fi

if [[ ! -f "$TRAEFIK_CA" ]]; then
  echo "[build-ca-bundle] $TRAEFIK_CA missing — is the traefik-certs volume mounted?" >&2
  echo "[build-ca-bundle] Continuing with Wazuh CA only — OIDC fetches to" >&2
  echo "[build-ca-bundle] auth.ironnest.local will fail with UNABLE_TO_VERIFY_LEAF_SIGNATURE." >&2
  mkdir -p "$BUNDLE_DIR"
  cp "$WAZUH_CA" "$BUNDLE_OUT"
  exit 0
fi

mkdir -p "$BUNDLE_DIR"
cat "$WAZUH_CA" "$TRAEFIK_CA" > "$BUNDLE_OUT"
echo "[build-ca-bundle] Wrote combined CA bundle to $BUNDLE_OUT"
