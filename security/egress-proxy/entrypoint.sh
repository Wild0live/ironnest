#!/bin/sh
set -eu

BLOCKLIST_DIR="/etc/squid/blocklists"
SQUID_CONF="/etc/squid/squid.conf"

# Create empty blocklist files so squid can start before the first updater run.
mkdir -p "${BLOCKLIST_DIR}"
[ -f "${BLOCKLIST_DIR}/malicious_ips.txt" ]     || touch "${BLOCKLIST_DIR}/malicious_ips.txt"
[ -f "${BLOCKLIST_DIR}/malicious_domains.txt" ] || touch "${BLOCKLIST_DIR}/malicious_domains.txt"

# The custom entrypoint replaces ubuntu/squid's stock cache preparation.
# Initialize the UFS cache tree on every boot; squid -z is idempotent and fixes
# empty or newly-created cache volumes before the foreground process starts.
rm -f /run/squid.pid
/usr/sbin/squid -z -f "${SQUID_CONF}" >/dev/null 2>&1 || true
rm -f /run/squid.pid

# Watch for blocklist replacements (updater uses atomic mv, which fires IN_MOVED_TO
# on the directory rather than IN_CLOSE_WRITE on the file).
(
  while true; do
    inotifywait -q -e moved_to --include 'malicious_ips\.txt' "${BLOCKLIST_DIR}" 2>/dev/null && {
      printf '%s [watchdog] Blocklist replaced — triggering squid -k reconfigure\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      squid -f "${SQUID_CONF}" -k reconfigure 2>/dev/null || true
    }
  done
) &

exec /usr/sbin/squid -N -f "${SQUID_CONF}" "$@"
