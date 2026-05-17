#!/bin/sh
# Refresh the blocklist every 6 hours. A sleep loop is used instead of crond
# because dcron requires setpgid(), which the hardened security profile
# (cap_drop: ALL + no-new-privileges) blocks — crond would exit immediately
# and the restart policy would busy-loop the updates.
set -eu
while :; do
    /usr/local/bin/update-blocklist.sh || echo "[blocklist-updater] update failed, retrying next cycle"
    sleep 21600
done
