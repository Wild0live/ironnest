# platform/hermes-agent:v2026.6.5-patched
# Built from NousResearch/hermes-agent at a pinned release tag + ttyd 1.7.7.
# Source: https://github.com/NousResearch/hermes-agent/releases/tag/v2026.6.5
#
# First build downloads Node modules, Playwright, and Python deps — allow ~20 min.
# Subsequent builds are fast (Docker layer cache hits on the npm/pip layers).
#
# To upgrade: bump HERMES_TAG, update the image tag in docker-compose.yml, rebuild.

ARG HERMES_TAG=v2026.6.5

# ── Pinned upstream helpers ───────────────────────────────────────────────────
FROM ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie@sha256:b3c543b6c4f23a5f2df22866bd7857e5d304b67a564f4feab6ac22044dde719b AS uv_source
# Node 22 LTS: trixie ships Node 20 (EOL April 2026); copy from upstream node:22 image.
FROM node:22-bookworm-slim@sha256:7af03b14a13c8cdd38e45058fd957bf00a72bbe17feac43b1c15a689c029c732 AS node_source
FROM infisical/cli@sha256:dba406b35e5819632412c561bfa46e6185e04c6d76175dc82bf97c4ff53745d7 AS infisical_source

FROM debian:13.4

# Disable Python stdout buffering; keep Playwright browsers off the data volume.
ENV PYTHONUNBUFFERED=1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright

# ── System dependencies ───────────────────────────────────────────────────────
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential python3 ripgrep ffmpeg gcc python3-dev \
        libffi-dev procps git openssh-client docker-cli xz-utils \
        tini ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# ── Node 22 LTS (copied from upstream source stage) ──────────────────────────
COPY --chmod=0755 --from=node_source /usr/local/bin/node /usr/local/bin/
COPY --from=node_source /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=node_source /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx && \
    ln -sf /usr/local/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

# ── s6-overlay — replaces tini as PID 1; provides s6-setuidgid for privilege drop ──
ARG S6_OVERLAY_VERSION=3.2.3.0
ARG S6_OVERLAY_NOARCH_SHA256=b720f9d9340efc8bb07528b9743813c836e4b02f8693d90241f047998b4c53cf
ARG S6_OVERLAY_X86_64_SHA256=a93f02882c6ed46b21e7adb5c0add86154f01236c93cd82c7d682722e8840563
ARG S6_OVERLAY_SYMLINKS_SHA256=a60dc5235de3ecbcf874b9c1f18d73263ab99b289b9329aa950e8729c4789f0e
ADD https://github.com/just-containers/s6-overlay/releases/download/v3.2.3.0/s6-overlay-noarch.tar.xz /tmp/
ADD https://github.com/just-containers/s6-overlay/releases/download/v3.2.3.0/s6-overlay-symlinks-noarch.tar.xz /tmp/
RUN curl -fsSL --retry 3 -o /tmp/s6-overlay-arch.tar.xz \
        "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-x86_64.tar.xz" && \
    printf '%s  %s\n' "${S6_OVERLAY_NOARCH_SHA256}" /tmp/s6-overlay-noarch.tar.xz \
        > /tmp/s6-overlay.sha256 && \
    printf '%s  %s\n' "${S6_OVERLAY_X86_64_SHA256}" /tmp/s6-overlay-arch.tar.xz \
        >> /tmp/s6-overlay.sha256 && \
    printf '%s  %s\n' "${S6_OVERLAY_SYMLINKS_SHA256}" /tmp/s6-overlay-symlinks-noarch.tar.xz \
        >> /tmp/s6-overlay.sha256 && \
    sha256sum -c /tmp/s6-overlay.sha256 && \
    tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz && \
    tar -C / -Jxpf /tmp/s6-overlay-symlinks-noarch.tar.xz && \
    rm /tmp/s6-overlay-*.tar.xz /tmp/s6-overlay.sha256

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

# ── Non-root runtime user ─────────────────────────────────────────────────────
RUN useradd -u 10000 -m -d /opt/data hermes

COPY --chmod=0755 --from=uv_source /usr/local/bin/uv /usr/local/bin/uvx /usr/local/bin/
COPY --chmod=0755 --from=infisical_source /bin/infisical /usr/local/bin/infisical

# IronNest secrets pattern: `infisical run` fetches secrets from the local
# Infisical at process start and injects them as env vars — never on disk.
COPY --chmod=0755 with-infisical.sh /usr/local/bin/with-infisical

# ── Clone hermes-agent source at pinned tag ───────────────────────────────────
ARG HERMES_TAG=v2026.6.5
RUN git clone --depth 1 --branch ${HERMES_TAG} \
      https://github.com/NousResearch/hermes-agent.git /opt/hermes

WORKDIR /opt/hermes

ENV npm_config_install_links=false

# ── Node.js deps + Playwright + web/tui dashboard builds ─────────────────────
RUN npm install --prefer-offline --no-audit && \
    npx playwright install --with-deps chromium --only-shell && \
    (cd web && npm install --prefer-offline --no-audit) && \
    (cd ui-tui && npm install --prefer-offline --no-audit) && \
    npm cache clean --force

RUN cd web && npm run build && \
    cd ../ui-tui && npm run build

# ── Python virtualenv ─────────────────────────────────────────────────────────
USER root
RUN uv venv && \
    uv pip install --no-cache-dir -e ".[all]"
RUN chmod -R a+rX /opt/hermes && \
    chown -R hermes:hermes /opt/hermes/.venv /opt/hermes/ui-tui /opt/hermes/node_modules

# ── Patch: chatgpt.com/backend-api/codex API change (2026-05-31) ─────────────
# The Codex backend now sends response.completed with output:null (output was
# already streamed via output_item.done events). openai SDK ≤ 2.36.0 crashes
# with TypeError: 'NoneType' object is not iterable in parse_response().
# Fix: treat null output as empty list; Hermes backfills from collected items.
RUN python3 -c "import pathlib; f=next(pathlib.Path('/opt/hermes/.venv/lib').glob('python*/site-packages/openai/lib/_parsing/_responses.py')); txt=f.read_text(); f.write_text(txt.replace('for output in response.output:', 'for output in (response.output or []):', 1)); print('Patched', f)"

# ── s6-overlay service wiring ─────────────────────────────────────────────────
# We do NOT copy upstream s6-rc.d. IronNest uses one-container-per-process:
# each container's CMD (with-infisical sh -c "exec hermes gateway run") is the
# s6 "main program" and carries Infisical secrets. Copying s6-rc.d would cause
# s6 to also auto-start a supervised `main-hermes` service WITHOUT Infisical
# env vars, producing duplicate pollers and "No messaging platforms" warnings.

# stage2-hook as cont-init.d/01 — UID remap, chown, config seed, skills sync.
RUN mkdir -p /etc/cont-init.d && \
    printf '#!/command/with-contenv sh\nexec /opt/hermes/docker/stage2-hook.sh\n' \
        > /etc/cont-init.d/01-hermes-setup && \
    chmod +x /etc/cont-init.d/01-hermes-setup
# 015-supervise-perms and 02-reconcile-profiles are deliberately NOT installed.
# 015 chowns s6-rc supervision trees that don't exist in our single-process model.
# 02-reconcile-profiles creates s6-supervised gateway service slots for each
# profile found in $HERMES_HOME — with IronNest's shared hermes-data volume this
# causes every container to spawn s6-log daemons that fight over the same
# /opt/data/logs/gateways/<profile>/lock files. Our CMD (with-infisical ...
# exec hermes gateway run) is the only gateway process per container.

# ── privilege-drop exec shim for `docker exec` ───────────────────────────────
RUN mkdir -p /opt/hermes/bin && \
    if [ -f /opt/hermes/docker/hermes-exec-shim.sh ]; then \
        cp /opt/hermes/docker/hermes-exec-shim.sh /opt/hermes/bin/hermes && \
        chmod +x /opt/hermes/bin/hermes; fi

# ── Runtime ───────────────────────────────────────────────────────────────────
ENV HERMES_WEB_DIST=/opt/hermes/hermes_cli/web_dist
ENV HERMES_HOME=/opt/data
ENV PATH="/opt/hermes/bin:/opt/hermes/.venv/bin:/opt/data/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV CHROMIUM_BIN=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/google-chrome-stable
ENV EDGE_BIN=/usr/bin/microsoft-edge-stable
ENV BROWSER_EXTENSIONS_DIR=/opt/browser-extensions
ENV BROWSER_PROFILES_DIR=/opt/data/browser-profiles

RUN mkdir -p /opt/data
VOLUME ["/opt/data"]

# s6-overlay /init is PID 1; main-wrapper.sh routes CMD args and drops
# privileges to hermes via s6-setuidgid. Replaces the old tini+entrypoint.sh.
ENTRYPOINT ["/init", "/opt/hermes/docker/main-wrapper.sh"]
CMD []
