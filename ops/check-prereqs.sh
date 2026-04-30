#!/usr/bin/env bash
# Pre-flight checks before running bootstrap.sh.
# Exits 0 only if every check passes. Run this first if you hit unexpected errors.
set -euo pipefail

export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

PASS=0; WARN=0; FAIL=0
pass()  { echo "  [PASS] $*"; PASS=$((PASS+1)); }
warn()  { echo "  [WARN] $*"; WARN=$((WARN+1)); }
fail()  { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }

echo "=== IronNest pre-flight checks ==="

# ── Docker ────────────────────────────────────────────────────────────────────
echo ""
echo "Docker"
if docker info >/dev/null 2>&1; then
  pass "Docker daemon is reachable"
else
  fail "Docker daemon not reachable — is Rancher Desktop running? (check system tray)"
fi

# ── WSL2 kernel version ───────────────────────────────────────────────────────
echo ""
echo "WSL2 kernel"
KERNEL="$(uname -r 2>/dev/null || echo "0.0.0")"
KERNEL_MAJOR="$(echo "$KERNEL" | cut -d. -f1)"
KERNEL_MINOR="$(echo "$KERNEL" | cut -d. -f2)"
if [ "$KERNEL_MAJOR" -gt 5 ] || { [ "$KERNEL_MAJOR" -eq 5 ] && [ "$KERNEL_MINOR" -ge 15 ]; }; then
  pass "Kernel $KERNEL >= 5.15 (iptables rules will work)"
else
  fail "Kernel $KERNEL < 5.15 — iptables rules used by fix-nat-prerouting.sh may not work. Update Rancher Desktop."
fi

# ── docker compose plugin ─────────────────────────────────────────────────────
echo ""
echo "docker compose"
if docker compose version >/dev/null 2>&1; then
  VER="$(docker compose version --short 2>/dev/null || docker compose version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
  pass "docker compose $VER available"
else
  fail "docker compose plugin not found — update Rancher Desktop to v1.10+"
fi

# ── Disk space ────────────────────────────────────────────────────────────────
echo ""
echo "Disk space"
PLATFORM_DIR="${IRONNEST_PLATFORM_DIR:-/d/claude-workspace/platform}"
BACKUP_ROOT="${IRONNEST_BACKUP_ROOT:-/g/rancher-stack-backups}"

check_space() {
  local path="$1" label="$2" min_gb="$3"
  # Find an ancestor that actually exists
  local check_path="$path"
  while [ ! -d "$check_path" ] && [ "$check_path" != "/" ]; do
    check_path="$(dirname "$check_path")"
  done
  local avail_kb
  avail_kb="$(df -k "$check_path" 2>/dev/null | awk 'NR==2{print $4}')"
  if [ -z "$avail_kb" ]; then
    warn "$label: could not read disk space at $check_path"
    return
  fi
  local avail_gb=$(( avail_kb / 1024 / 1024 ))
  if [ "$avail_gb" -ge "$min_gb" ]; then
    pass "$label: ${avail_gb} GB free at $check_path (need ${min_gb} GB)"
  else
    fail "$label: only ${avail_gb} GB free at $check_path (need ${min_gb} GB minimum)"
  fi
}

check_space "$PLATFORM_DIR" "Platform dir"  5
check_space "$BACKUP_ROOT"  "Backup root"   10

# Docker storage VHD
DOCKER_DISK="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null | sed 's|/var/lib/docker||' || true)"
if [ -n "$DOCKER_DISK" ]; then
  check_space "/var/lib/docker" "Docker storage" 40
else
  warn "Docker storage path unknown — ensure 40 GB free on your Docker VHD drive"
fi

# ── Required .env files ───────────────────────────────────────────────────────
echo ""
echo ".env files"
for stack in secrets "security/wazuh" openclaw; do
  env_file="$PLATFORM_DIR/$stack/.env"
  example_file="$PLATFORM_DIR/$stack/.env.example"
  if [ -f "$env_file" ]; then
    if grep -q "CHANGE_ME" "$env_file" 2>/dev/null; then
      warn "$stack/.env exists but still contains CHANGE_ME placeholder values"
    else
      pass "$stack/.env exists and appears filled in"
    fi
  elif [ -f "$example_file" ]; then
    fail "$stack/.env missing — copy from $stack/.env.example and fill in values"
  else
    fail "$stack/.env missing"
  fi
done

# ── Wazuh TLS certificates ────────────────────────────────────────────────────
echo ""
echo "Wazuh TLS certs"
CERT_DIR="$PLATFORM_DIR/security/wazuh/config/wazuh_indexer_ssl_certs"
if [ -d "$CERT_DIR" ] && [ -f "$CERT_DIR/root-ca.pem" ]; then
  pass "Wazuh TLS certs found at $CERT_DIR"
else
  fail "Wazuh TLS certs missing — run: cd security/wazuh && docker compose -f generate-indexer-certs.yml run --rm generator"
fi

# ── secrets.tmpl files ────────────────────────────────────────────────────────
echo ""
echo "Infisical secrets templates"
for stack in openclaw hermes; do
  tmpl="$PLATFORM_DIR/$stack/agent-config/secrets.tmpl"
  example="$PLATFORM_DIR/$stack/agent-config/secrets.tmpl.example"
  if [ -f "$tmpl" ]; then
    if grep -q "YOUR_INFISICAL_PROJECT_UUID" "$tmpl" 2>/dev/null; then
      fail "$stack/agent-config/secrets.tmpl still contains placeholder UUID — replace with your real project UUID"
    else
      pass "$stack/agent-config/secrets.tmpl exists and UUID appears set"
    fi
  elif [ -f "$example" ]; then
    fail "$stack/agent-config/secrets.tmpl missing — copy from secrets.tmpl.example and replace the UUID placeholder"
  else
    fail "$stack/agent-config/secrets.tmpl missing"
  fi
done

# ── Shared networks ───────────────────────────────────────────────────────────
echo ""
echo "Docker networks"
for net in platform-net platform-egress; do
  if docker network inspect "$net" >/dev/null 2>&1; then
    pass "network $net exists"
  else
    warn "network $net not found — bootstrap.sh will create it"
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary: $PASS passed, $WARN warnings, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  echo "Fix the FAIL items above before running bootstrap.sh"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  echo "Warnings present but bootstrap.sh should still run. Review before proceeding."
  exit 0
else
  echo "All checks passed — safe to run bootstrap.sh"
fi
