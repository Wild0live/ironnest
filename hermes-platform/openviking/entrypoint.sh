#!/bin/sh
# hermes-platform/openviking — entrypoint
#
# 1. Wait for the sidecar-rendered /secrets/.env (Infisical → /hermes-platform/openviking)
# 2. Source it
# 3. Build /etc/openviking/ov.conf (JSON) from env vars via python
# 4. Exec `openviking-server`
#
# ov.conf format reference (from openviking_cli/setup_wizard.py _build_cloud_config):
#   {
#     "storage": {"workspace": "..."},
#     "embedding": {"dense": {"provider", "model", "api_key", "dimension", "api_base"}},
#     "vlm": {...optional...}
#   }
set -eu

CONF_OUT=/etc/openviking/ov.conf
SECRETS_FILE=/secrets/.env

# ── Wait for sidecar to render secrets ──────────────────────────────────────
i=0
while [ ! -f "$SECRETS_FILE" ]; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
        echo "openviking-entrypoint: timed out waiting for $SECRETS_FILE" >&2
        echo "openviking-entrypoint: is the infisical-agent sidecar healthy?" >&2
        exit 1
    fi
    sleep 1
done

# ── Source secrets into env ─────────────────────────────────────────────────
set -a
# shellcheck disable=SC1090
. "$SECRETS_FILE"
set +a

# ── Sanity check: required keys present ─────────────────────────────────────
: "${EMBEDDING_API_KEY:?openviking-entrypoint: EMBEDDING_API_KEY missing from $SECRETS_FILE}"

# ── Build ov.conf JSON ──────────────────────────────────────────────────────
# Using python (always available — base image is python:3.13-slim) avoids
# every envsubst-meets-JSON quoting trap. Optional vlm block is included
# only when VLM_API_KEY is set; matches the official wizard's behavior.
python3 <<'PY' > "$CONF_OUT"
import json, os, sys

config = {
    "storage": {"workspace": "/var/lib/openviking/workspace"},
    "embedding": {
        "dense": {
            "provider":  os.environ.get("EMBEDDING_PROVIDER",  "volcengine"),
            "model":     os.environ.get("EMBEDDING_MODEL",     "doubao-embedding-text-240715"),
            "api_key":   os.environ["EMBEDDING_API_KEY"],
            "dimension": int(os.environ.get("EMBEDDING_DIMENSION", "2560")),
            "api_base":  os.environ.get("EMBEDDING_API_BASE",
                          "https://ark.cn-beijing.volces.com/api/v3"),
        }
    },
}

# Server bind + auth.
#
# host=0.0.0.0 — listen on ALL interfaces (lo + eth0). Without this,
# OpenViking defaults to localhost-only, which means memory-gateway on
# another container cannot connect even when they share a Docker network.
#
# port=1933 — match the documented default; also gives the healthcheck
# a known port (we keep curl http://127.0.0.1:1933/health).
#
# root_api_key (when set) — auto-enables auth_mode=API_KEY. Requires
# `Authorization: Bearer <key>` on every request. Only memory-gateway has
# the matching key (from Infisical /hermes-platform/gateway).
server = {"host": "0.0.0.0", "port": 1933}
if os.environ.get("ROOT_API_KEY"):
    server["root_api_key"] = os.environ["ROOT_API_KEY"]
config["server"] = server

if os.environ.get("VLM_API_KEY"):
    config["vlm"] = {
        "provider":    os.environ.get("VLM_PROVIDER", "openai"),
        "model":       os.environ.get("VLM_MODEL",    "gpt-4o"),
        "api_key":     os.environ["VLM_API_KEY"],
        "api_base":    os.environ.get("VLM_API_BASE", "https://api.openai.com/v1"),
        "temperature": 0.0,
        "max_retries": 2,
    }

json.dump(config, sys.stdout, indent=2)
PY

echo "openviking-entrypoint: rendered $CONF_OUT, starting server on :1933"
exec openviking-server --config "$CONF_OUT"
