#!/usr/bin/env bash
# Daily backup of the platform.
# Target: G:\rancher-stack-backups\<YYYY-MM-DD_HHMMSS>\
# Retention: 14 days.
#
# Covers:
#   - Infisical Postgres (logical dump)
#   - OpenClaw home volume + Codex CLI home volume
#   - Hermes data volume (config, sessions, memories, skills)
#   - AdGuard conf volume
#   - Wazuh etc + logs + indexer data + dashboard config
#   - All .env files across stacks (contain ENCRYPTION_KEY etc.)
#   - Wazuh TLS certs
#
# Skipped (regenerable):
#   - Trivy CVE DB cache
#   - AdGuard work volume (query logs, filter stats)
#   - Dozzle (stateless)
#   - Squid cache
#   - Redis (Infisical's cache)
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

to_win() { echo "$1" | sed -E 's|^/([a-zA-Z])/|\U\1:/|'; }

# Override either variable via environment to match your install paths:
#   IRONNEST_PLATFORM_DIR=/d/my-clone/platform bash ops/backup.sh
#   IRONNEST_BACKUP_ROOT=/e/backups bash ops/backup.sh
PLATFORM_DIR="${IRONNEST_PLATFORM_DIR:-/d/claude-workspace/platform}"
BACKUP_ROOT="${IRONNEST_BACKUP_ROOT:-/g/rancher-stack-backups}"
RETENTION_DAYS=14
STAMP="$(date +%Y-%m-%d_%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"
LOG="$BACKUP_ROOT/backup.log"

mkdir -p "$DEST"
log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }

log "=== backup start → $DEST ==="

DEST_WIN="$(to_win "$DEST")"

# 1. Infisical postgres logical dump
log "dumping infisical postgres"
docker exec -t infisical-postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --clean --if-exists' \
  | gzip -9 > "$DEST/postgres.sql.gz"

# 2. Named volumes — each as a tar.gz via a throwaway alpine container
backup_volume() {
  local volname="$1" outfile="$2"
  log "archiving volume $volname → $outfile"
  MSYS_NO_PATHCONV=1 docker run --rm \
    -v "${volname}:/src:ro" \
    -v "${DEST_WIN}:/backup" \
    alpine tar czf "/backup/$outfile" -C /src . 2>/dev/null
}

backup_volume rancher-stack_openclaw-home openclaw-home.tar.gz
backup_volume openclaw_codex-home         codex-home.tar.gz
backup_volume hermes_hermes-data          hermes-data.tar.gz
backup_volume rancher-stack_adguard-conf  adguard-conf.tar.gz
backup_volume wazuh_wazuh_etc             wazuh-etc.tar.gz
backup_volume wazuh_wazuh_logs            wazuh-logs.tar.gz
backup_volume wazuh_filebeat_etc          wazuh-filebeat-etc.tar.gz
backup_volume wazuh_wazuh-indexer-data    wazuh-indexer-data.tar.gz
backup_volume wazuh_wazuh-dashboard-config wazuh-dashboard-config.tar.gz

# 3. Platform config (all .env files + wazuh TLS certs + compose files)
log "archiving platform config (.env files, certs, compose)"
tar czf "$DEST/platform-config.tar.gz" \
  -C "$PLATFORM_DIR" \
  --exclude='**/trivy-cache/**' \
  --exclude='**/squid-cache/**' \
  secrets/.env \
  openclaw/.env \
  security/wazuh/.env \
  security/wazuh/config \
  security/adguard/docker-compose.yml \
  security/socket-proxy/docker-compose.yml \
  security/egress-proxy \
  security/trivy/docker-compose.yml \
  security/trivy/scan.sh \
  secrets/docker-compose.yml \
  openclaw/docker-compose.yml \
  security/wazuh/docker-compose.yml \
  security/wazuh/generate-indexer-certs.yml \
  observability/dozzle/docker-compose.yml \
  bootstrap.sh \
  ops 2>/dev/null

# 4. Checksums
( cd "$DEST" && sha256sum *.gz > SHA256SUMS )

log "backup size: $(du -sh "$DEST" | cut -f1)"
log "artifacts:"
ls -la "$DEST" | tee -a "$LOG"

# Retention
log "pruning backups older than $RETENTION_DAYS days"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" \
  -exec rm -rf {} + 2>/dev/null || true

log "=== backup complete ==="
