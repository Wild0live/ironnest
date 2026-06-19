#!/bin/sh
# Bootstrap the Infisical agent for the ingress stack.
#
# Universal Auth credentials arrive via env_file (.env in this directory).
# We write them to tmpfs files because `infisical agent` requires file paths,
# not raw env vars. tmpfs is mounted size=1m,mode=0700 so the creds never
# touch disk and are not readable by other UIDs.
set -e
printf '%s' "$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID"     > /tmp/client-id
printf '%s' "$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" > /tmp/client-secret
exec infisical agent --config /agent-config/agent.yaml
