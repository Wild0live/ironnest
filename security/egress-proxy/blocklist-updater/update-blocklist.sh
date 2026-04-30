#!/usr/bin/env sh
# Download and merge threat IP feeds into a Squid ACL file.
# Runs every 6 hours via crond. Writes atomically to /blocklists/ (shared volume).
#
# Feeds used (all free for non-commercial use):
#   Spamhaus DROP/EDROP  — hijacked/leased-to-spam netblocks
#   Emerging Threats     — compromised hosts
#   Feodo Tracker        — botnet C2 servers

set -eu

BLOCKLIST_DIR="/blocklists"
TMP_IPS="${BLOCKLIST_DIR}/malicious_ips.tmp"
FINAL_IPS="${BLOCKLIST_DIR}/malicious_ips.txt"

SPAMHAUS_DROP_URL="https://www.spamhaus.org/drop/drop.txt"
SPAMHAUS_EDROP_URL="https://www.spamhaus.org/drop/edrop.txt"
ET_IPS_URL="https://rules.emergingthreats.net/blockrules/compromised-ips.txt"
FEODO_URL="https://feodotracker.abuse.ch/downloads/ipblocklist.txt"

log() { printf '%s [blocklist-updater] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Returns 0 if the string looks like a valid IPv4, IPv6, or CIDR; 1 otherwise.
is_ip_or_cidr() {
    printf '%s' "$1" | grep -qE \
      '^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$|^[0-9a-fA-F:]+(/[0-9]{1,3})?$'
}

# Download one feed; on failure fall back to the last cached copy.
download_feed() {
    url="$1"
    label="$2"
    feed_raw="${BLOCKLIST_DIR}/.feed_${label}.raw"
    feed_cache="${BLOCKLIST_DIR}/.feed_${label}.cache"

    if wget -q --timeout=30 --tries=2 -O "${feed_raw}" "${url}"; then
        # Extract valid IP/CIDR tokens; strip comments and blank lines.
        grep -v '^[[:space:]]*[#;]' "${feed_raw}" \
          | grep -v '^[[:space:]]*$' \
          | while IFS= read -r line; do
              token=$(printf '%s' "$line" | awk '{print $1}')
              if is_ip_or_cidr "${token}"; then printf '%s\n' "${token}"; fi
            done > "${feed_cache}"
        log "OK  ${label} ($(wc -l < "${feed_cache}") entries)"
    else
        log "WARN ${label} download failed"
        if [ ! -f "${feed_cache}" ]; then
            log "WARN no cache for ${label} — skipping"
            return 0
        fi
        log "INFO using cached ${label} ($(wc -l < "${feed_cache}") entries)"
    fi

    cat "${feed_cache}" >> "${TMP_IPS}"
}

mkdir -p "${BLOCKLIST_DIR}"
: > "${TMP_IPS}"

log "Starting blocklist update"
download_feed "${SPAMHAUS_DROP_URL}"  "spamhaus_drop"
download_feed "${SPAMHAUS_EDROP_URL}" "spamhaus_edrop"
download_feed "${ET_IPS_URL}"         "et_compromised"
download_feed "${FEODO_URL}"          "feodo_tracker"

sort -u "${TMP_IPS}" > "${TMP_IPS}.sorted"
ENTRY_COUNT=$(wc -l < "${TMP_IPS}.sorted")
log "Merged ${ENTRY_COUNT} unique entries"

if [ "${ENTRY_COUNT}" -eq 0 ]; then
    log "WARN all feeds failed with no cache — leaving existing blocklist untouched"
    rm -f "${TMP_IPS}" "${TMP_IPS}.sorted"
    exit 0
fi

# Atomic replace: cp + mv so the squid watchdog sees a single IN_MOVED_TO event.
cp "${TMP_IPS}.sorted" "${FINAL_IPS}.new"
mv "${FINAL_IPS}.new" "${FINAL_IPS}"
rm -f "${TMP_IPS}" "${TMP_IPS}.sorted"

log "Blocklist updated: ${FINAL_IPS} (${ENTRY_COUNT} entries)"
