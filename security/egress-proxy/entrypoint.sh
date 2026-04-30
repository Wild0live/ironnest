#!/bin/sh
set -eu

BLOCKLIST_DIR="/etc/squid/blocklists"

# Create empty blocklist files so squid can start before the first updater run.
mkdir -p "${BLOCKLIST_DIR}"
[ -f "${BLOCKLIST_DIR}/malicious_ips.txt" ]     || touch "${BLOCKLIST_DIR}/malicious_ips.txt"
[ -f "${BLOCKLIST_DIR}/malicious_domains.txt" ] || touch "${BLOCKLIST_DIR}/malicious_domains.txt"

# Watch for blocklist replacements (updater uses atomic mv, which fires IN_MOVED_TO
# on the directory rather than IN_CLOSE_WRITE on the file).
(
  while true; do
    inotifywait -q -e moved_to --include 'malicious_ips\.txt' "${BLOCKLIST_DIR}" 2>/dev/null && {
      printf '%s [watchdog] Blocklist replaced — triggering squid -k reconfigure\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      squid -k reconfigure 2>/dev/null || true
    }
  done
) &

exec /usr/sbin/squid -N -f /etc/squid/squid.conf "$@"
