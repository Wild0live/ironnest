#!/usr/bin/env bash
# Snapshot of platform state — containers grouped by compose project.
export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"

STACKS=(socket-proxy adguard egress-proxy secrets dozzle wazuh trivy openclaw)

echo "=== platform status ==="
for s in "${STACKS[@]}"; do
  count=$(docker ps -q --filter "label=com.docker.compose.project=$s" | wc -l)
  total=$(docker ps -aq --filter "label=com.docker.compose.project=$s" | wc -l)
  printf "  %-15s %d/%d running\n" "$s" "$count" "$total"
done

echo
echo "=== containers ==="
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" \
  | grep -vE "k8s_|POD_|traefik|pause|coredns|helm|metrics-server|local-path"

echo
echo "=== shared networks ==="
docker network ls --filter name=platform- --format "table {{.Name}}\t{{.Driver}}\t{{.Scope}}"

echo
echo "=== volumes (by age, platform-related) ==="
docker volume ls --format "{{.Name}}" \
  | grep -E "^(rancher-stack_|secrets_|wazuh_|dozzle_|trivy_|egress-proxy_|openclaw_)" \
  | sort
