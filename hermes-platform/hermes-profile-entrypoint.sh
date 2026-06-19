#!/bin/sh
# Repair Hermes auth state before the upstream entrypoint drops privileges.
# Root-run diagnostics can otherwise leave auth files unreadable by Hermes.
set -eu

HERMES_HOME="${HERMES_HOME:-/opt/data}"
HERMES_UID="${HERMES_UID:-10000}"
HERMES_GID="${HERMES_GID:-10000}"

if [ "$(id -u)" = "0" ] && [ -d "$HERMES_HOME" ]; then
    find "$HERMES_HOME" -maxdepth 1 -type f -name 'auth*' \
        -exec chown "$HERMES_UID:$HERMES_GID" {} \; 2>/dev/null || true
fi

exec /opt/hermes/docker/entrypoint.sh "$@"
