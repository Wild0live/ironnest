#!/usr/bin/env bash
# Restore from a backup.sh artifact.
# Usage: ./restore.sh /g/rancher-stack-backups/2026-04-19_220000
# WARNING: destroys current data in volumes that are being restored.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"
to_win() { echo "$1" | sed -E 's|^/([a-zA-Z])/|\U\1:/|'; }

SRC="${1:-}"
if [[ -z "$SRC" || ! -d "$SRC" ]]; then
  echo "Usage: $0 <backup-dir>"
  echo "Available:"
  ls -1 /g/rancher-stack-backups/ 2>/dev/null | grep -E '^[0-9]{4}-' || true
  exit 1
fi

PLATFORM_DIR="/d/claude-workspace/platform"
cd "$PLATFORM_DIR"

echo "Restoring from: $SRC"
echo "This will DESTROY current data in postgres, openclaw-home, adguard-conf, wazuh volumes."
read -p "Type 'yes' to continue: " C
[[ "$C" == "yes" ]] || { echo "aborted"; exit 1; }

echo "=== verifying checksums ==="
( cd "$SRC" && sha256sum -c SHA256SUMS )

echo "=== restoring platform config (.env + certs + compose) ==="
tar xzf "$SRC/platform-config.tar.gz" -C "$PLATFORM_DIR"

echo "=== stopping everything ==="
for stack in openclaw observability/dozzle security/trivy security/wazuh secrets \
             security/adguard security/egress-proxy security/socket-proxy; do
  [[ -f "$stack/docker-compose.yml" ]] && ( cd "$stack" && docker compose down 2>&1 | tail -2 )
done

SRC_WIN="$(to_win "$SRC")"

restore_volume() {
  local volname="$1" archive="$2"
  [[ -f "$SRC/$archive" ]] || { echo "skip $archive (not in backup)"; return; }
  echo "=== restoring $volname from $archive ==="
  docker volume rm "$volname" 2>/dev/null || true
  docker volume create "$volname" >/dev/null
  MSYS_NO_PATHCONV=1 docker run --rm \
    -v "${volname}:/dst" \
    -v "${SRC_WIN}:/backup:ro" \
    alpine sh -c "cd /dst && tar xzf /backup/$archive"
}

restore_volume rancher-stack_openclaw-home  openclaw-home.tar.gz
restore_volume rancher-stack_adguard-conf   adguard-conf.tar.gz
restore_volume wazuh_wazuh_etc              wazuh-etc.tar.gz
restore_volume wazuh_wazuh_logs             wazuh-logs.tar.gz
restore_volume wazuh_filebeat_etc           wazuh-filebeat-etc.tar.gz
restore_volume wazuh_wazuh-indexer-data     wazuh-indexer-data.tar.gz
restore_volume wazuh_wazuh-dashboard-config wazuh-dashboard-config.tar.gz

# OpenClaw volume must be owned by UID 1000
MSYS_NO_PATHCONV=1 docker run --rm -v rancher-stack_openclaw-home:/dst \
  alpine chown -R 1000:1000 /dst

echo "=== starting secrets first (postgres needs to receive dump) ==="
( cd secrets && docker compose up -d postgres )
for i in {1..30}; do
  docker exec infisical-postgres pg_isready -U infisical -d infisical >/dev/null 2>&1 && break
  sleep 2
done

echo "=== restoring postgres dump ==="
gunzip -c "$SRC/postgres.sql.gz" | docker exec -i infisical-postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

echo "=== bringing up the whole platform ==="
cd "$PLATFORM_DIR"
bash bootstrap.sh

echo "restore complete."
