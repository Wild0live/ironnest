#!/bin/sh
# Run once immediately at startup so the blocklist is populated before the
# first 6-hour cron tick, then hand off to crond for scheduled updates.
set -eu
/usr/local/bin/update-blocklist.sh
exec /usr/sbin/crond -f -l 6
