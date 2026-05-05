#!/bin/sh
# Polls socket-proxy for running containers and writes a short-ID → name
# lookup file that Fluent Bit's Lua filter reads every 60 seconds.
set -e
mkdir -p /lookups
while true; do
    curl -sf http://socket-proxy:2375/containers/json \
        | jq 'map({(.[\"Id\"][0:12]): (.Names[0] | ltrimstr("/"))}) | add // {}' \
        > /lookups/container-names.json.tmp \
        && mv /lookups/container-names.json.tmp /lookups/container-names.json
    sleep 60
done
