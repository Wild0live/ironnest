#!/usr/bin/env bash
# Runtime snapshot of Rancher Desktop's WSL2 distros.
# Target: G:\rancher-runtime-backups\<YYYY-MM-DD_HHMMSS>\
# Retention: keep newest 2 archives (count-based, not age-based — each is ~75-100 GB).
#
# Covers (full runtime — pairs with the data-only ops/backup.sh):
#   - rancher-desktop       (engine, k3s, Docker daemon config)
#   - rancher-desktop-data  (ext4.vhdx with image cache + Docker volumes)
#
# Recovery from this archive is a single `wsl --import` per distro.
# Without it, recovery requires reinstalling Rancher Desktop and re-pulling
# every image before ops/restore.sh can even start.
#
# REQUIRES Rancher Desktop to be SHUT DOWN before running. The script refuses
# to run if either distro is in the Running state — `wsl --export` of a live
# distro produces an inconsistent snapshot.
#
# Run weekly and before major Rancher Desktop upgrades.
set -euo pipefail

# wsl.exe lives in System32; force UTF-8 output so we can grep it cleanly.
export PATH="/c/Windows/System32:$PATH"
export WSL_UTF8=1

to_win() { echo "$1" | sed -E 's|^/([a-zA-Z])/|\U\1:/|'; }

# Override either variable via environment to match your install paths:
#   IRONNEST_RUNTIME_BACKUP_ROOT=/e/runtime-backups bash ops/backup-runtime.sh
#   IRONNEST_RUNTIME_BACKUP_KEEP=1                  bash ops/backup-runtime.sh
BACKUP_ROOT="${IRONNEST_RUNTIME_BACKUP_ROOT:-/g/rancher-runtime-backups}"
RETENTION_KEEP="${IRONNEST_RUNTIME_BACKUP_KEEP:-2}"
DISTROS=(rancher-desktop rancher-desktop-data)
STAMP="$(date +%Y-%m-%d_%H%M%S)"
DEST="$BACKUP_ROOT/$STAMP"
LOG="$BACKUP_ROOT/backup-runtime.log"

mkdir -p "$DEST"
log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG"; }

log "=== runtime backup start → $DEST ==="

# 1. Snapshot WSL state and refuse to run if either distro is live.
log "checking WSL distro state"
# tr -d '\0' is a safety net for older Windows builds that emit UTF-16 even with WSL_UTF8=1.
state="$(wsl.exe -l -v 2>&1 | tr -d '\0')"
echo "$state" | tee -a "$LOG"

for d in "${DISTROS[@]}"; do
  is_running="$(echo "$state" | awk -v d="$d" '
    NR > 1 {
      sub(/^\*?[ \t]+/, "")
      if ($1 == d && $2 == "Running") print "yes"
    }
  ')"
  if [ -n "$is_running" ]; then
    log "ERROR: distro '$d' is Running. Shut down Rancher Desktop first (right-click tray icon → Quit, wait until both distros show 'Stopped' in 'wsl -l -v'), then re-run."
    exit 1
  fi
done

# 2. Export each distro to its own .tar (no gzip — ext4 contents are mostly
#    binary; compression adds 10+ min for ~15% gain).
DEST_WIN="$(to_win "$DEST")"
for d in "${DISTROS[@]}"; do
  out="$DEST/${d}.tar"
  out_win="${DEST_WIN}/${d}.tar"
  log "exporting $d → $out"
  wsl.exe --export "$d" "$out_win"
  log "  size: $(du -h "$out" | cut -f1)"
done

# 3. Manifest for restore reference.
log "writing MANIFEST.txt"
{
  echo "Backup created:    $STAMP"
  echo "Distros exported:  ${DISTROS[*]}"
  echo "Backup root:       $BACKUP_ROOT"
  echo ""
  echo "WSL state at backup time:"
  echo "$state"
  echo ""
  echo "Restore (per distro):"
  echo "  wsl --unregister <distro>"
  echo "  wsl --import <distro> <new-install-path> $(to_win "$DEST")\\<distro>.tar --version 2"
} > "$DEST/MANIFEST.txt"

log "backup size: $(du -sh "$DEST" | cut -f1)"
log "artifacts:"
ls -la "$DEST" | tee -a "$LOG"

# 4. Retention — keep newest $RETENTION_KEEP dated dirs, delete the rest.
log "pruning to keep newest $RETENTION_KEEP archives in $BACKUP_ROOT"
ls -1dt "$BACKUP_ROOT"/*/ 2>/dev/null \
  | tail -n "+$((RETENTION_KEEP + 1))" \
  | xargs -r rm -rf 2>/dev/null || true

log "=== runtime backup complete ==="
