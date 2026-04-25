#!/usr/bin/env bash
# Generate a self-signed TLS certificate and write it into the traefik-certs
# Docker volume. Run once before starting the ingress stack.
#
# Usage:
#   ./generate-certs.sh                  # uses ironnest.local
#   ./generate-certs.sh myhost.example.com

set -euo pipefail

DOMAIN="${1:-ironnest.local}"
VOLUME="ingress_traefik-certs"

echo "=== generating self-signed cert for *.${DOMAIN} ==="

docker volume inspect "$VOLUME" >/dev/null 2>&1 \
  || docker volume create "$VOLUME"

MSYS_NO_PATHCONV=1 docker run --rm \
  -v "${VOLUME}:/certs" \
  alpine/openssl req -x509 -nodes \
    -newkey rsa:4096 \
    -keyout /certs/server.key \
    -out    /certs/server.crt \
    -days   3650 \
    -subj   "/CN=${DOMAIN}" \
    -addext "subjectAltName=DNS:${DOMAIN},DNS:*.${DOMAIN}"

echo "=== done — cert written to volume ${VOLUME} ==="
echo ""
echo "Next steps:"
echo "  1. Add hosts entries for *.${DOMAIN} → <your server IP> (or use split-DNS)"
echo "  2. Trust the cert on client machines (optional — avoids browser warnings):"
echo "       docker run --rm -v ${VOLUME}:/certs alpine cat /certs/server.crt"
echo "  3. Start the ingress stack: cd security/ingress && docker compose up -d"
