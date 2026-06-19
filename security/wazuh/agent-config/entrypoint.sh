#!/bin/sh
# Bootstrap the Infisical agent for the wazuh stack.
# Mirrors security/ingress/agent-config/entrypoint.sh.
set -e
printf '%s' "$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"     > /tmp/client-id
printf '%s' "$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" > /tmp/client-secret
exec infisical agent --config /agent-config/agent.yaml
