# platform/openviking-server:0.1.0
#
# OpenViking — context database for AI agents.
# Source: https://github.com/volcengine/OpenViking
#
# Runs `openviking-server` listening on port 1933 inside the
# hermes-platform-mem-net (internal Docker network). Reachable ONLY from
# the memory-gateway container — Hermes profile containers have no route
# to this service. Publishes no host ports.
#
# Config is rendered at container start by entrypoint.sh from
# ov.conf.template, with embedding/VLM provider keys injected from
# Infisical via the sidecar pattern (see browser-intent/ for reference).

FROM python:3.13.1-slim-bookworm

# Python runtime sanity
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# OpenViking config locations (per official README)
ENV OPENVIKING_CONFIG_FILE=/etc/openviking/ov.conf \
    OPENVIKING_HOME=/var/lib/openviking \
    OPENVIKING_WORKSPACE=/var/lib/openviking/workspace

# Minimal system deps; `gettext-base` provides envsubst for template render
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gettext-base tini && \
    rm -rf /var/lib/apt/lists/*

# Install OpenViking from PyPI with provider extras.
#
# Extras shipped by upstream openviking 0.3.x (subset):
#   gemini, gemini-async — Google Gemini API support
#   local-embed         — llama.cpp local embedding models
#   ocr                 — OCR for PDF ingestion
#   bot-*               — VikingBot integrations
#
# We always include `gemini` because hermes-platform's default deployment
# uses Gemini embeddings. Override OPENVIKING_EXTRAS at build time to add
# more (e.g. OPENVIKING_EXTRAS=gemini,ocr,local-embed).
ARG OPENVIKING_VERSION=
ARG OPENVIKING_EXTRAS=gemini
RUN if [ -n "$OPENVIKING_VERSION" ]; then \
        pip install "openviking[${OPENVIKING_EXTRAS}]==${OPENVIKING_VERSION}"; \
    else \
        pip install "openviking[${OPENVIKING_EXTRAS}]"; \
    fi && \
    openviking-server --version 2>/dev/null || true

# Non-root runtime user
RUN groupadd --system --gid 11000 openviking && \
    useradd  --system --uid 11000 --gid 11000 \
        --home-dir /var/lib/openviking \
        --shell /usr/sbin/nologin \
        openviking && \
    mkdir -p /etc/openviking /var/lib/openviking/workspace /var/log/openviking && \
    chown -R openviking:openviking /etc/openviking /var/lib/openviking /var/log/openviking

# Templates + entrypoint
COPY --chown=root:root ov.conf.template /etc/openviking/ov.conf.template
COPY --chmod=0755     entrypoint.sh    /usr/local/bin/openviking-entrypoint

USER openviking

VOLUME ["/var/lib/openviking"]
EXPOSE 1933

# Healthcheck uses the documented /status endpoint shape; the CLI `ov status`
# wraps an HTTP GET against the server. We poke the bare port to confirm
# the listener is up — if OpenViking exposes a richer /healthz we can
# switch to it without a code change.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
    CMD curl -fsS "http://127.0.0.1:1933/" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/openviking-entrypoint"]
