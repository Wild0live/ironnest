#!/bin/sh
# Polls socket-proxy every 60s for running containers and writes a TSV
# lookup file (/lookups/containers.tsv) that Fluent Bit's Lua filter
# reads to enrich log records with first-class metadata fields.
#
# Output schema (tab-separated):
#   <short_id>\t<name>\t<image>\t<compose_project>\t<compose_service>
# Missing labels are emitted as "-" so split logic stays simple.
#
# Runs from Dockerfile.container-sync (alpine + curl + jq pre-installed at
# build time — runtime is on internal-only platform-net).
set -eu

mkdir -p /lookups

while true; do
    if curl -sf --max-time 10 http://socket-proxy:2375/containers/json \
        | jq -r '.[] | [
              (.Id[0:12]),
              (.Names[0] | ltrimstr("/")),
              .Image,
              (.Labels["com.docker.compose.project"] // "-"),
              (.Labels["com.docker.compose.service"] // "-")
          ] | @tsv' > /lookups/containers.tsv.tmp; then
        mv /lookups/containers.tsv.tmp /lookups/containers.tsv
    else
        rm -f /lookups/containers.tsv.tmp
        echo "[$(date -Iseconds)] container-sync: refresh failed" >&2
    fi
    sleep 60
done
