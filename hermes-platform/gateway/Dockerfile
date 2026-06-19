# platform/hermes-platform-memory-gateway:0.1.0
#
# Memory Gateway — policy-enforcing front door to OpenViking.
#
# The ONLY service permitted to connect to openviking:1933. Hermes profile
# containers reach this gateway via http://memory-gateway:8080/ over the
# hermes-platform-app-net (internal) network; the gateway then talks to
# OpenViking over hermes-platform-mem-net (also internal).
#
# Secrets (bearer-token map for profile auth + Infisical-fetched config) are
# injected via the in-process `with-infisical` wrapper at container start
# (same pattern as hermes/with-infisical.sh). Nothing sensitive on disk.

FROM python:3.13.1-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# System deps:
#   ca-certificates, curl — healthcheck + outbound TLS
#   tini                  — PID 1, forwards signals to uvicorn
#   gosu                  — drop root after first-run chown
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl tini gosu && \
    rm -rf /var/lib/apt/lists/*

# ── Pinned Infisical CLI (matches the digest used by hermes/) ───────────────
COPY --from=infisical/cli@sha256:dba406b35e5819632412c561bfa46e6185e04c6d76175dc82bf97c4ff53745d7 \
    /bin/infisical /usr/local/bin/infisical
RUN chmod +x /usr/local/bin/infisical

# ── with-infisical wrapper (copied verbatim from hermes/) ───────────────────
# Build context is the stack root (hermes-platform/), see docker-compose.yml.
COPY --chmod=0755 with-infisical.sh /usr/local/bin/with-infisical

# ── App ─────────────────────────────────────────────────────────────────────
WORKDIR /app
COPY gateway/requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt

COPY gateway/app/    /app/app/
COPY policies/       /etc/hermes-platform/policies/
COPY registry/       /etc/hermes-platform/registry/
COPY spec/           /etc/hermes-platform/spec/

# Non-root runtime user
RUN groupadd --system --gid 11001 gateway && \
    useradd  --system --uid 11001 --gid 11001 \
        --home-dir /var/lib/gateway --create-home \
        --shell /usr/sbin/nologin \
        gateway && \
    mkdir -p /var/log/gateway && \
    chown -R gateway:gateway /var/lib/gateway /var/log/gateway /app /etc/hermes-platform

ENV MEMORY_GATEWAY_HOST=0.0.0.0 \
    MEMORY_GATEWAY_PORT=8080 \
    MEMORY_GATEWAY_POLICIES_DIR=/etc/hermes-platform/policies \
    MEMORY_GATEWAY_REGISTRY_FILE=/etc/hermes-platform/registry/profiles-registry.yaml \
    MEMORY_GATEWAY_AUDIT_LOG=/var/log/gateway/audit.log \
    MEMORY_GATEWAY_OPENVIKING_URL=http://openviking:1933 \
    MEMORY_GATEWAY_DRY_RUN=false

USER gateway

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --retries=3 --start-period=10s \
    CMD curl -fsS "http://127.0.0.1:8080/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["with-infisical", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--log-config", "/app/app/logging.json"]
