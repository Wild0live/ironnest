# platform/hermes-agent:v2026.5.7-patched
# Built from NousResearch/hermes-agent at a pinned release tag + ttyd 1.7.7.
# Source: https://github.com/NousResearch/hermes-agent/releases/tag/v2026.5.7
#
# First build downloads Node modules, Playwright, and Python deps — allow ~20 min.
# Subsequent builds are fast (Docker layer cache hits on the npm/pip layers).
#
# To upgrade: bump HERMES_TAG, update the image tag in docker-compose.yml, rebuild.

ARG HERMES_TAG=v2026.5.7

# ── Pinned upstream helpers (same digests as official hermes Dockerfile) ──────
FROM ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie@sha256:b3c543b6c4f23a5f2df22866bd7857e5d304b67a564f4feab6ac22044dde719b AS uv_source
FROM tianon/gosu:1.19-trixie@sha256:3b176695959c71e123eb390d427efc665eeb561b1540e82679c15e992006b8b9 AS gosu_source
FROM infisical/cli@sha256:dba406b35e5819632412c561bfa46e6185e04c6d76175dc82bf97c4ff53745d7 AS infisical_source

FROM debian:13.4

# Disable Python stdout buffering; keep Playwright browsers off the data volume.
ENV PYTHONUNBUFFERED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright

# ── System dependencies (mirrors official hermes Dockerfile) ─────────────────
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential nodejs npm python3 ripgrep ffmpeg gcc python3-dev \
        libffi-dev procps git openssh-client docker-cli tini ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# ── ttyd — added for IronNest browser terminal access ─────────────────────────
RUN curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
      -o /usr/local/bin/ttyd \
 && chmod +x /usr/local/bin/ttyd \
 && ttyd --version

# ── Chromium (apt) — supports persistent profiles; Playwright's chromium is headless-shell only ──
RUN apt-get update && \
    apt-get install -y --no-install-recommends chromium chromium-sandbox && \
    rm -rf /var/lib/apt/lists/*

# ── Google Chrome Stable ──────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends gnupg && \
    rm -rf /var/lib/apt/lists/* && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg && \
    printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main\n' \
      > /etc/apt/sources.list.d/google-chrome.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends google-chrome-stable && \
    rm -rf /var/lib/apt/lists/*

# ── Microsoft Edge Stable ─────────────────────────────────────────────────────
RUN curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
      | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg && \
    printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/edge stable main\n' \
      > /etc/apt/sources.list.d/microsoft-edge.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends microsoft-edge-stable && \
    rm -rf /var/lib/apt/lists/*

# ── Browser extensions (baked into image; load via --load-extension at runtime) ─
COPY --chown=hermes:hermes extensions/ /opt/browser-extensions/

# ── Non-root runtime user; UID can be overridden via HERMES_UID at runtime ───
RUN useradd -u 10000 -m -d /opt/data hermes

COPY --chmod=0755 --from=gosu_source /gosu /usr/local/bin/
COPY --chmod=0755 --from=uv_source /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/
COPY --chmod=0755 --from=infisical_source /bin/infisical /usr/local/bin/infisical

# IronNest secrets pattern: `infisical run` fetches secrets from the local
# Infisical at process start and injects them as env vars — never on disk.
COPY --chmod=0755 with-infisical.sh /usr/local/bin/with-infisical

# ── Clone hermes-agent source at pinned tag ───────────────────────────────────
ARG HERMES_TAG=v2026.5.7
RUN git clone --depth 1 --branch ${HERMES_TAG} \
      https://github.com/NousResearch/hermes-agent.git /opt/hermes

WORKDIR /opt/hermes

# ── Node.js deps + Playwright + web dashboard build ──────────────────────────
# Cached unless package-lock.json changes (only on tag upgrades).
RUN npm install --prefer-offline --no-audit && \
    npx playwright install --with-deps chromium --only-shell && \
    (cd web && npm install --prefer-offline --no-audit) && \
    npm cache clean --force

RUN cd web && npm run build

# ── Python virtualenv ─────────────────────────────────────────────────────────
USER root
RUN chmod -R a+rX /opt/hermes
RUN uv venv && \
    uv pip install --no-cache-dir -e ".[all]"

# ── Runtime ───────────────────────────────────────────────────────────────────
ENV HERMES_WEB_DIST=/opt/hermes/hermes_cli/web_dist
ENV HERMES_HOME=/opt/data
ENV PATH="/opt/data/.local/bin:${PATH}"
ENV CHROMIUM_BIN=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/google-chrome-stable
ENV EDGE_BIN=/usr/bin/microsoft-edge-stable
ENV BROWSER_EXTENSIONS_DIR=/opt/browser-extensions
ENV BROWSER_PROFILES_DIR=/opt/data/browser-profiles

VOLUME ["/opt/data"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/hermes/docker/entrypoint.sh"]
