# IronNest read-only data browser image.
#
# Minimal alpine + the packages VS Code Server needs to bootstrap inside the
# container WITHOUT requiring network access at attach time. This lets the
# runtime container stay on `network_mode: none` while still supporting
# "Dev Containers: Attach to Running Container".
#
# Pre-installed:
#   libstdc++  — required by VS Code Server (it tries `apk add` otherwise; fails offline)
#   bash       — VS Code Server / Dev Containers extension prefers bash over alpine's ash
#   git        — useful in the attached terminal for inspecting any git repos in volumes
#   ripgrep    — backs VS Code's Ctrl+Shift+F across 16 mounted volumes; otherwise slow
#   findutils  — GNU find/xargs; some VS Code search features expect GNU flags
#
# Image size: ~30 MB. Built locally; no upstream dependency at runtime.

FROM alpine:latest

RUN apk add --no-cache \
        libstdc++ \
        bash \
        git \
        ripgrep \
        findutils
