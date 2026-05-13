# IronNest Architecture

## Overview

**IronNest** is a security-hardened, modular container platform running on Rancher Desktop (WSL2/Windows 11). It hosts AI/agent workloads (OpenClaw, Hermes) and a managed browsing surface (Browser Intent) surrounded by a layered security perimeter: secrets management, DNS filtering, HTTP egress control, kernel-firewall ingress isolation, SIEM monitoring, image scanning, log aggregation, public reverse proxy, and observability — each in its own isolated Compose project.

**Footprint:** 12 Compose projects — **15 always-on** containers + **8 on-demand** containers (23 total when everything is running). The on-demand stacks (`openclaw`, `hermes`, `browser-intent`) are not started by `bootstrap.sh`; bring them up with their per-stack `start.sh` scripts (or have them auto-started at logon — see **Autostart** below).

**Platform root (canonical):** `D:\claude-workspace\platform\` — git repo, remote `https://github.com/Wild0live/ironnest`, branch `master`. Every running container's `com.docker.compose.project.config_files` label points under this tree (verified 2026-05-14 against egress-proxy, traefik, hermes, etc.). A separate clone at `D:\claude-workspace\gitHub\ironnest\` exists for documentation drafting only; it is not bind-mounted into any container.  
**Docker storage:** `F:\wsl\rancher-desktop-data\ext4.vhdx` (off the C: drive)  
**Backup target:** `G:\rancher-stack-backups\` (14-day retention)

---

## Design Principles

### 1. Blast-radius isolation
Each capability lives in its own Compose project. Restarting or resetting one stack cannot affect others. OpenClaw, Hermes, and Browser Intent have zero Docker socket access and zero lifecycle control over any other container.

### 2. Least privilege everywhere
- All containers drop capabilities they don't need; most use `cap_drop: ALL`.
- Filesystem mounts are read-only except where writes are strictly required (tmpfs for ephemeral scratch).
- `no-new-privileges: true` on every service that accepts it.
- Healthchecks use proper credentials where the service requires auth (e.g. wazuh.indexer passes `WAZUH_INDEXER_PASSWORD` and asserts HTTP 200, not 401). Accepting 401 as healthy masks auth misconfiguration.

### 3. Zero raw socket access
No container mounts `/var/run/docker.sock` directly. All Docker API consumers (Dozzle, Wazuh, Trivy, `monitoring-container-sync`) talk to the `socket-proxy` service, which exposes only read-only endpoints (CONTAINERS, EVENTS, IMAGES, INFO, NETWORKS, PING, VERSION, VOLUMES). All write/exec/build operations are blocked.

### 4. DNS-first filtering
Every service sets `dns: 172.30.0.10` (AdGuard). DNS-layer blocking is the first line of defence against malicious domain resolution before any TCP connection is attempted.

### 5. Allowlist-only HTTP egress
Outbound HTTP/HTTPS is routed through Squid (`HTTP_PROXY=http://squid:3128`). Squid enforces a hostname allowlist — destinations not explicitly named are denied. Raw TCP (SMTP, threat feeds) bypasses Squid but is restricted to `platform-egress` network members only.

OpenClaw and Hermes each have an extra non-internal `*_ingress` bridge solely so Docker can publish their localhost ports to Windows. Because those bridges can create default routes, their `start.sh` scripts run `ops/fix-openclaw-egress.sh` / `ops/fix-hermes-egress.sh` after startup. The scripts insert idempotent `DOCKER-USER` rules that drop NEW outbound connections initiated from those bridges, preventing `curl --noproxy`-style direct internet bypasses while preserving localhost UI access and Squid-mediated egress.

### 6. Network segmentation by trust level
- `platform-net` (internal) — inter-service comms, no internet exit.
- `platform-egress` — internet-capable, only for services that genuinely need raw TCP.
- Stack-private `ingress` bridges — used solely for localhost port publishing. OpenClaw's and Hermes's ingress bridges are additionally blocked from initiating direct outbound internet traffic by `DOCKER-USER` firewall rules.
- Stack-private internal networks (e.g. `secrets-internal`, `wazuh-internal`) — database/index tiers that should never be reachable from other stacks.

### 7. Secrets out of images and out of git
Per-stack `.env` files hold Infisical Universal-Auth machine identity credentials. All `.env` files are gitignored; only `.env.example` templates are tracked. Two patterns coexist for getting application secrets into containers (see **Secrets injection patterns** under each stack):
- **Sidecar pattern** (OpenClaw, Browser Intent) — an `infisical-agent` container renders `secrets-runtime/.env` every 60 s; main service loads it via `env_file`.
- **In-process wrapper** (Hermes) — each service starts via `/usr/local/bin/with-infisical`, which logs in to Infisical and `exec`s `infisical run`. Secrets become env vars in the wrapped process and are never written to disk.

### 8. Modular startup order
`bootstrap.sh` brings the always-on stacks up in hard-wired dependency order, repairing Rancher Desktop's WSL2 networking quirks at the right point in the chain so every service finds its upstream already healthy:

```
socket-proxy → adguard → egress-proxy → secrets
  → ops/fix-nat-prerouting.sh + ops/repair-egress.sh
  → dozzle → wazuh → trivy → ingress (Traefik) → monitoring (fluent-bit + container-sync)
```

`bootstrap.sh` deliberately **does not** start the on-demand stacks (`openclaw`, `hermes`, `browser-intent`) — bring those up explicitly with their per-stack `start.sh`. Each on-demand `start.sh` re-runs the NAT and egress repair scripts (idempotent), brings its compose project up, applies a kernel-firewall rule that blocks direct outbound traffic from its `*_ingress` bridge (where applicable), and waits for healthy.

At logon, two Task Scheduler tasks chain the entire bring-up; see **Autostart** below.

### 9. Backup completeness and verifiability
Every backup run produces a `SHA256SUMS` file. `restore.sh` verifies checksums before touching anything. Fourteen-day retention with automatic pruning.

### 10. Resource limits on everything
Every service has explicit `cpus` and `memory` limits. This prevents a runaway container from starving the WSL2 VM and degrading Rancher Desktop.

---

## Stack Inventory

12 Compose projects. Always-on stacks are brought up by `bootstrap.sh`; on-demand stacks need their own `start.sh` (or the autostart task).

| Stack | Path | Containers | Lifecycle | Host UI |
|-------|------|------------|-----------|---------|
| socket-proxy | `security/socket-proxy/` | 1 | always-on | — |
| adguard | `security/adguard/` | 1 | always-on | 127.0.0.1:3000 |
| egress-proxy | `security/egress-proxy/` | 2 (squid + blocklist-updater) | always-on | — |
| secrets (Infisical) | `secrets/` | 3 (infisical + postgres + redis) | always-on | 127.0.0.1:18090 |
| dozzle | `observability/dozzle/` | 1 | always-on | 127.0.0.1:8888 |
| wazuh | `security/wazuh/` | 3 (manager + indexer + dashboard) | always-on | 127.0.0.1:8443 |
| trivy | `security/trivy/` | 1 server (+ on-demand scanner) | always-on (server) | — |
| ingress | `security/ingress/` | 1 (traefik) | always-on | 0.0.0.0:80, 0.0.0.0:443, 127.0.0.1:8880 |
| monitoring | `monitoring/` | 2 (fluent-bit + container-sync) | always-on | — |
| openclaw | `openclaw/` | 3 (gateway + ttyd + infisical-agent) | on-demand | 127.0.0.1:18789, 127.0.0.1:7681 (ttyd) |
| hermes | `hermes/` | 2 (ttyd + gateway, in-process `with-infisical`) | on-demand | 127.0.0.1:7682 (ttyd), 127.0.0.1:9119 (metrics) |
| browser-intent | `browser-intent/` | 3 (mcp-server + worker + infisical-agent) | on-demand | 127.0.0.1:18901 |

> Infisical is published on **18090** rather than 8090 because Rancher Desktop's port forwarder intercepts low-numbered host ports inside the container netns. See the "Infisical agent TCP timeout" runbook below.

---

## Container Profile

| Container | Role | Stack | Image | Host Port |
|-----------|------|-------|-------|-----------|
| `socket-proxy` | Read-only Docker socket proxy | socket-proxy | `platform/socket-proxy:0.4.2-patched` | — |
| `adguard` | DNS filter (pinned at `172.30.0.10`) | adguard | `adguard/adguardhome:v0.107.74` | `127.0.0.1:3000` (→80/tcp) |
| `egress-proxy` | HTTP allowlist proxy (Squid) | egress-proxy | `platform/squid:6.13-patched` | — |
| `blocklist-updater` | Periodic threat-feed fetcher feeding Squid | egress-proxy | `platform/blocklist-updater:1.0` | — |
| `infisical` | Secrets manager UI/API | secrets | `platform/infisical:pg-36438985-patched` | `127.0.0.1:18090` (→8090/tcp) |
| `infisical-postgres` | Infisical database | secrets | `platform/postgres:16.13-alpine-patched` | — |
| `infisical-redis` | Infisical cache | secrets | `platform/redis:7.4.8-alpine-patched` | — |
| `dozzle` | Log viewer | dozzle | `amir20/dozzle:v10.4.1` | `127.0.0.1:8888` |
| `wazuh.manager` | SIEM log collection/analysis | wazuh | `wazuh/wazuh-manager:4.14.4` | `127.0.0.1:1514–1515` |
| `wazuh.indexer` | SIEM OpenSearch index | wazuh | `wazuh/wazuh-indexer:4.14.4` | — |
| `wazuh.dashboard` | SIEM dashboard | wazuh | `wazuh/wazuh-dashboard:4.14.4` | `127.0.0.1:8443` |
| `trivy-server` | CVE/image vulnerability scanner | trivy | `aquasec/trivy:0.70.0` | — |
| `traefik` | Public reverse proxy + TLS termination | ingress | `traefik:v3.3.4` | `0.0.0.0:80`, `0.0.0.0:443`, `127.0.0.1:8880` (dashboard) |
| `monitoring-fluent-bit` | Tails all container logs → Wazuh (pinned at `172.30.0.15`) | monitoring | `fluent/fluent-bit:3.2-debug` | — |
| `monitoring-container-sync` | Writes `/lookups/containers.tsv` (short-ID → name/image/compose-project/service) for fluent-bit's lua enrichment | monitoring | `platform/monitoring-container-sync:1.0` (alpine + curl + jq, built from `Dockerfile.container-sync`) | — |
| `openclaw-gateway` | AI app workload | openclaw | `platform/openclaw:2026.4.23-1-codex` | `127.0.0.1:18789` |
| `openclaw-ttyd` | Browser terminal sidecar | openclaw | `platform/openclaw:2026.4.23-1-codex` | `127.0.0.1:7681` |
| `openclaw-infisical-agent` | Secrets sidecar | openclaw | `platform/infisical-cli:0.43.76-patched` | — |
| `hermes-ttyd` | Hermes TUI terminal + dashboard | hermes | `platform/hermes-agent:v2026.5.7-patched` | `127.0.0.1:7682`, `127.0.0.1:9119` |
| `hermes-gateway` | Hermes Telegram/messaging gateway | hermes | `platform/hermes-agent:v2026.5.7-patched` | — (internal only) |
| `browser-intent-mcp` | Intent-level MCP facade | browser-intent | `platform/browser-intent-mcp:0.1.0` | `127.0.0.1:18901` |
| `browser-intent-worker` | Playwright browser worker (pinned at `172.30.0.30` so Squid can ACL it independently) | browser-intent | `platform/browser-intent-worker:0.1.0` | — |
| `browser-intent-infisical-agent` | Secrets sidecar | browser-intent | `platform/infisical-cli:0.43.76-patched` | — |

**Functional layers (outermost → core):**
```
Public Ingress (Traefik) → Socket Isolation → Observability (Dozzle)
  → DNS Filtering (AdGuard) → HTTP Egress Control (Squid + blocklists)
    → Kernel Firewall (DOCKER-USER per ingress bridge)
      → SIEM (Wazuh + fluent-bit + container-sync enrichment) → Image Scanning (Trivy)
        → Secrets (Infisical) → AI / Agent Cores (OpenClaw, Hermes, Browser Intent)
```

### Image Version Pins

All images are pinned — no `latest` or floating tags anywhere in IronNest. Semver tags are used where the upstream publishes them; SHA256 digests are used where only a floating tag exists.

| Image (compose / built tag) | Dockerfile `FROM` pin | Upstream version | Pin method |
|---|---|---|---|
| `platform/openclaw:2026.4.23-1-codex` | `ghcr.io/openclaw/openclaw:2026.4.23-1-amd64` | 2026.4.23-1 | Calendar semver |
| `platform/hermes-agent:v2026.5.7-patched` | upstream Hermes image (set in `hermes/Dockerfile`) | v2026.5.7 | Calendar semver |
| `platform/infisical-cli:0.43.76-patched` | `infisical/cli@sha256:dba406b3…` | 0.43.76 (binary) | Digest |
| `platform/infisical:pg-36438985-patched` | `infisical/infisical@sha256:36438985…` | unknown (floating upstream) | Digest |
| `platform/postgres:16.13-alpine-patched` | `postgres:16.13-alpine` | PostgreSQL 16.13 | Semver tag |
| `platform/redis:7.4.8-alpine-patched` | `redis:7.4.8-alpine` | Redis 7.4.8 | Semver tag |
| `platform/squid:6.13-patched` | `ubuntu/squid@sha256:6a097f68…` | Squid 6.13 / Ubuntu 24.04 | Digest |
| `platform/blocklist-updater:1.0` | `alpine:3.20` | local | Semver tag (in-house) |
| `platform/monitoring-container-sync:1.0` | `alpine:3.20` (+ curl, jq) | local | Semver tag (in-house) |
| `platform/socket-proxy:0.4.2-patched` | `tecnativa/docker-socket-proxy@sha256:1f3a6f30…` | v0.4.2 | Digest |
| `traefik:v3.3.4` | — (used directly) | v3.3.4 | Semver tag |
| `fluent/fluent-bit:3.2-debug` | — (used directly) | 3.2 | Semver tag |
| `wazuh/wazuh-manager:4.14.4` | — (used directly) | 4.14.4 | Semver tag |
| `wazuh/wazuh-indexer:4.14.4` | — (used directly) | 4.14.4 | Semver tag |
| `wazuh/wazuh-dashboard:4.14.4` | — (used directly) | 4.14.4 | Semver tag |
| `aquasec/trivy:0.70.0` | — (used directly) | 0.70.0 | Semver tag |
| `adguard/adguardhome:v0.107.74` | — (used directly) | v0.107.74 | Semver tag |
| `amir20/dozzle:v10.4.1` | — (used directly) | v10.4.1 | Semver tag |

> Digest-pinned images (infisical, squid, socket-proxy) have no upstream semver release tag. On upgrade, pull the new image, record the new digest, and update both the `FROM` line and the compose `image:` tag.

### OpenClaw Image Details

| Property | Value |
|----------|-------|
| Registry | GitHub Container Registry (`ghcr.io/openclaw/openclaw`) |
| Versioning | Calendar-based — `YYYY.M.DD-N-<arch>` (e.g. `2026.4.23-1-amd64`) |
| Base image | `node:24-bookworm` (Node.js 24.14.0, Debian Bookworm) |
| Health endpoint | `GET /healthz` → `{"ok":true,"status":"live"}` |
| Platform-net IP | `172.30.0.6` |
| Source | https://github.com/openclaw/openclaw |

---

## Network Architecture

IronNest uses **three Docker network classes**, each with a distinct trust posture:

1. **Inter-service mesh** — `platform-net` (172.30.0.0/24, `internal: true`). Every container that talks to another stack joins this network. AdGuard sits at the fixed address `172.30.0.10` and is hardcoded as the DNS server (`dns: 172.30.0.10`) for every service. `monitoring-fluent-bit` is pinned at `172.30.0.15`; Browser Intent's worker is pinned at `172.30.0.30` so Squid can ACL it independently. The bridge is created with `--ip-range 172.30.0.128/25`, which reserves `.2–.127` for static pins and gives dynamic allocations from `.128–.254` — preventing a container that boots before AdGuard from squatting on `.10` and breaking platform-wide DNS. Because the network is `internal: true`, the kernel drops the initial SYN of any container→Internet TCP connection that tries to leave through it.
2. **Internet-capable bridge** — `platform-egress` (172.31.0.0/24). Joined only by services that genuinely need raw outbound TCP and cannot proxy through Squid: AdGuard (DoH upstream), Infisical (SMTP), Wazuh (CVE / threat feeds), Trivy server (CVE DB), and every Infisical-agent sidecar (Universal Auth, gRPC). It is also Squid's own outbound path to the real Internet.
3. **Per-stack ingress bridges** — non-internal bridges used solely so Docker can publish container ports to Windows loopback. Examples in current use: `openclaw_ingress`, `hermes_ingress`, `browser-intent_ingress`, `dozzle_ingress`, `wazuh_ingress`, `ingress_traefik_ingress`. These bridges *can* route to the Internet by default, which would be a back-door bypass of Squid; the kernel firewall closes that hole (see "3-layer egress control" below).

```
                                          Internet
                                              ▲
                                              │  (NAT egress only via platform-egress)
  ┌─────────────────────────────────────┐    │   ┌─────────────────────────────────────┐
  │      platform-net (internal)         │    │   │  platform-egress (172.31.0.0/24)    │
  │      172.30.0.0/24, no SYN-out      │    │   │  Internet-capable bridge            │
  │      static .2-.127, dynamic .128+  │    │   │                                      │
  │                                      │    │   │  Squid (egress side)                 │
  │  AdGuard (172.30.0.10)  ◀── dns ───┐│    │   │  AdGuard (DoH upstream)              │
  │  fluent-bit (172.30.0.15)          ││    │   │  Infisical (SMTP)                    │
  │  BrowserIntent worker (172.30.0.30)││    │   │  Wazuh manager / indexer (feeds)     │
  │  Squid (ingress side)              ││    │   │  Trivy server (CVE DB)               │
  │  socket-proxy :2375 (r/o)          ││    │   │  *-infisical-agent sidecars          │
  │  Infisical (HTTP API)              ││    │   │                                      │
  │  Wazuh manager/indexer/dashboard   ││    │   └──────────────────▲──────────────────┘
  │  Trivy server (HTTP)               ││    │                       │
  │  Dozzle, Traefik                   ││    │                       │  HTTP_PROXY=http://squid:3128
  │  OpenClaw / Hermes / BrowserIntent ◀┘    │                       │  (allowlist enforced)
  │                                      │    │                       │
  └─────────┬─────────────────────────────┘    │                       │
            │                                   │                       │
            │ port-publish only                 │                       │
            ▼                                   │                       │
  ┌─────────────────────────────────────┐    ┌─┴───────────────────────┴──────────────┐
  │  Per-stack *_ingress bridges         │    │   Kernel firewall (DOCKER-USER chain)  │
  │  (non-internal, host-loopback only)  │    │   DROP NEW outbound from openclaw_ingress
  │  openclaw_ingress, hermes_ingress,   │◀───│   and hermes_ingress, logged as        │
  │  wazuh_ingress, dozzle_ingress, …    │    │   IRONNEST_OPENCLAW_EGRESS_DROP /      │
  │                                      │    │   IRONNEST_HERMES_EGRESS_DROP          │
  └─────────────────────────────────────┘    └─────────────────────────────────────────┘
            │
            ▼
       Windows host (127.0.0.1:<published port>)
```

### Stack-private internal networks
- `secrets-internal` — Postgres + Redis only reachable by Infisical itself.
- `wazuh-internal` — manager ↔ indexer ↔ dashboard mesh; joined by `monitoring-fluent-bit` to reach `wazuh.indexer:9200`.
- `browser-internal` — Browser Intent worker ↔ MCP server (Playwright traffic stays off `platform-net`).

### 3-layer egress control

Outbound access is restricted in three independent layers; a service must defeat all three to reach an unintended destination.

| Layer | Mechanism | Where enforced | What it blocks |
|---|---|---|---|
| 1 | DNS filtering | AdGuard at `172.30.0.10` (set as `dns:` on every service) | Resolution of malicious / non-allowlisted domains before TCP. Backed by `blocklist-updater` (Spamhaus DROP/EDROP, Emerging Threats, Feodo) merged into Squid's IP blocklist. |
| 2 | HTTP allowlist | Squid forward proxy at `squid:3128`, set via `HTTP_PROXY` on every service that talks to the web. Per-stack ACLs in `security/egress-proxy/squid.conf` (`dst_<stack>` → union `dst_allowed_combined`). | Any HTTP/HTTPS to a hostname not on the allowlist. Add a domain by appending to both the per-stack `acl` and `dst_allowed_combined`, then `docker exec egress-proxy squid -k reconfigure` (no restart). |
| 3 | Kernel firewall | iptables `DOCKER-USER` chain, applied by `ops/fix-openclaw-egress.sh` and `ops/fix-hermes-egress.sh`. | NEW outbound TCP from `openclaw_ingress` and `hermes_ingress` bridges, preventing `curl --noproxy "*"` style direct-Internet bypasses while preserving localhost UI access and Squid-mediated egress. Drops are logged as `IRONNEST_OPENCLAW_EGRESS_DROP` / `IRONNEST_HERMES_EGRESS_DROP` (visible in Wazuh). |

**Verification:** `docker exec <container> curl --noproxy "*" -m 5 https://example.com` should time out from any container behind the kernel firewall. Through Squid (`curl https://example.com`), an allowlisted destination should succeed and a non-allowlisted one should return Squid's `403 Forbidden`.

### Rancher Desktop networking quirks (must-fix on every restart)

The platform runs inside Rancher Desktop's WSL2 distro, which adds three persistent networking issues that `bootstrap.sh` repairs automatically:

1. **DNAT hijack on PREROUTING.** Rancher Desktop injects unrestricted DNAT rules on host-published ports (e.g. `0.0.0.0/0 → 127.0.0.1:8090`). These intercept *intra-bridge* container-to-container TCP and redirect it to the host SSH tunnel, where it dies. `ops/fix-nat-prerouting.sh` inserts an idempotent `iptables -t nat -I PREROUTING 1 -s 172.16.0.0/12 -j RETURN` so traffic from any Docker bridge address bypasses the hijack. **Re-run on every Rancher Desktop restart** — `bootstrap.sh` and each `start.sh` do this automatically. This is also why Infisical is published on **18090**, not 8090: Rancher Desktop intercepts the lower port more aggressively and 18090 sidesteps it.
2. **Stale FDB entries on WSL2 resume.** After hibernate/resume, Docker bridge FDB tables can hold stale veth MACs and cross-container TCP times out (containers ping but TCP hangs). `ops/repair-egress.sh` reconnects affected services (notably Infisical) from `platform-egress` to flush the FDB.
3. **Userspace port forwarder fragility.** Published ports are exported to Windows by `rancher-desktop-guestagent` (an OpenRC service in the `rancher-desktop` WSL distro) via `/services/forwarder/expose`. A flapping container can wedge this agent and silently drop *every* platform port. Recovery is documented in the "All published ports unreachable" runbook below.

---

## Service Resource Limits

| Service | CPUs | Memory |
|---------|------|--------|
| socket-proxy | 0.25 | 64 MB |
| AdGuard | 0.5 | 256 MB |
| Squid (egress-proxy) | 0.5 | 256 MB |
| blocklist-updater | 0.1 | 64 MB |
| Postgres (Infisical) | 1.0 | 512 MB |
| Redis (Infisical) | 0.5 | 256 MB |
| Infisical | 2.0 | 1 GB |
| Dozzle | 0.5 | 128 MB |
| Wazuh manager | 2.0 | 2 GB |
| Wazuh indexer | 2.0 | 2 GB |
| Wazuh dashboard | 1.0 | 1 GB |
| Trivy server | 0.5 | 512 MB |
| Traefik | 0.25 | 128 MB |
| monitoring-fluent-bit | 0.5 | 128 MB |
| monitoring-container-sync | 0.1 | 32 MB |
| OpenClaw gateway | 4.0 | 4 GB |
| openclaw-ttyd | 0.5 | 1 GB |
| openclaw-infisical-agent | 0.25 | 64 MB |
| hermes-ttyd | 2.0 | 2 GB |
| hermes-gateway | 0.5 | 512 MB |
| Browser Intent MCP | 0.5 | 256 MB |
| Browser Intent worker | 2.0 | 2 GB |
| browser-intent-infisical-agent | 0.25 | 64 MB |

**Total memory budget:** ~13.5 GB always-on. Add ~6 GB when all three on-demand stacks are running.

---

## Key Integration Points

| Consumer | Provider | Transport |
|----------|----------|-----------|
| All containers | AdGuard | DNS `172.30.0.10` |
| HTTP clients | Squid | `HTTP_PROXY=http://squid:3128` (allowlist enforced) |
| Dozzle | socket-proxy | `DOCKER_HOST=tcp://socket-proxy:2375` (read-only) |
| Wazuh manager | socket-proxy | `DOCKER_HOST=tcp://socket-proxy:2375` (read-only) |
| Trivy scanner | socket-proxy | `DOCKER_HOST=tcp://socket-proxy:2375` (read-only) |
| `monitoring-container-sync` | socket-proxy | `GET /containers/json` every 60 s; writes `/lookups/containers.tsv` |
| `monitoring-fluent-bit` | All container stdouts/stderrs + `containers.tsv` | Tails `/var/lib/docker/containers/*.log`, enriches via lua filter, ships to `wazuh.indexer` (`ironnest-containers-*`) |
| `*-infisical-agent` sidecars (OpenClaw, Browser Intent) | Infisical | `http://infisical:8090` on `platform-net` (Universal Auth, polled every 60 s) |
| `hermes-ttyd`, `hermes-gateway` | Infisical | `/usr/local/bin/with-infisical` logs in to `http://infisical:8090` and `exec`s `infisical run` — secrets become env vars in the wrapped process; never written to disk |
| Infisical | Gmail | SMTP `smtp.gmail.com:587` via `platform-egress` |
| Wazuh manager / indexer | CVE / threat feeds | HTTPS via `platform-egress` |
| Trivy server | CVE registries | HTTPS via Squid |
| `blocklist-updater` | Spamhaus / ET / Feodo feeds | HTTPS via `platform-egress` (writes to shared volume read by Squid) |
| Traefik | Public Internet | Inbound HTTPS on `0.0.0.0:443` with TLS termination via stored cert in `ingress_traefik-certs` |
| Host Windows Wazuh agent | Wazuh manager | TCP `127.0.0.1:1514/1515` |
| `wazuh.indexer` healthcheck | itself | `curl -sk -u admin:$WAZUH_INDEXER_PASSWORD https://localhost:9200/` → 200 (not 401) |
| `openclaw-gateway` (`openai` provider) | api.openai.com | HTTPS via Squid; key from Infisical |
| `openclaw-gateway` (`codex` provider) | chatgpt.com/backend-api/v1 | HTTPS via Squid; manual JWT refresh |
| `openclaw-ttyd` / `hermes-ttyd` | browser (Windows host) | HTTP Basic Auth via ttyd `--credential`; credentials injected from Infisical |
| `openclaw_ingress` / `hermes_ingress` direct egress | DOCKER-USER firewall | NEW outbound TCP dropped by `ops/fix-openclaw-egress.sh` / `ops/fix-hermes-egress.sh` |
| `hermes-gateway` | Telegram Bot API | HTTPS via Squid (`.telegram.org` allowlisted, CONNECT-only) |
| `hermes-gateway` daily-readings cron | usccb.org | HTTPS via Squid (`.usccb.org` allowlisted) |
| `openclaw-gateway` | `browser-intent-mcp` | Internal MCP/HTTP on `platform-net`; the MCP also publishes `127.0.0.1:18901` for host-only access |
| `browser-intent-mcp` | `browser-intent-worker` | Internal HTTP on `browser-internal` bridge |
| `browser-intent-worker` | Allowlisted portals | Static source IP `172.30.0.30`; HTTPS via Squid plus in-browser domain enforcement; returns sanitized JSON only |
| Published ports → Windows | `rancher-desktop-guestagent` | Userspace forwarder writes Windows-side listener via `host-switch.exe`; not iptables-DNAT |

---

## Egress Allowlist (Squid)

Live source: `security/egress-proxy/squid.conf`. Per-stack ACLs (`acl dst_<stack> dstdomain …`) are unioned into `dst_allowed_combined`, the only set granted to `platform_clients`. To add a domain, edit both the per-stack ACL and the union, then `docker exec egress-proxy squid -k reconfigure` (no restart).

| Consumer | Allowed destinations |
|----------|---------------------|
| OpenClaw / Hermes | `.anthropic.com`, `.openai.com`, `.chatgpt.com`, `.cohere.ai`, `.mistral.ai`, `.deepseek.com`, `registry.npmjs.org` |
| Hermes daily-readings cron | `.usccb.org` |
| Telegram (Hermes messaging) | `.telegram.org` (CONNECT only) |
| Browser Intent (src `172.30.0.30`) | `.colfinancial.com`, `.maxihealth.com.ph`, `.april.fr`, `.hi-precision.com.ph` |
| Wazuh | `.wazuh.com`, `.cve.mitre.org`, `.nvd.nist.gov`, `.github.com` |
| Trivy | `ghcr.io`, `.githubusercontent.com`, `aquasecurity.github.io`, `.aquasec.com`, `mirror.gcr.io`, `storage.googleapis.com`, `.docker.io`, `production.cloudflare.docker.com` |
| AdGuard | `.quad9.net`, `.cloudflare-dns.com`, `dns.google` |

All other destinations: **denied**. Browser Intent's source-IP ACL means even if a worker process is hijacked into another container's network namespace, it cannot reuse another stack's allowlist.

---

## Browser Intent MCP

`browser-intent/` is the on-demand stack for high-risk site automation (financial, insurance, medical portals). It follows the IronNest pattern: localhost-only ingress, Infisical sidecar secret injection, AdGuard DNS, Squid egress allowlisting, dropped Linux capabilities, `no-new-privileges`, and a static source IP (`172.30.0.30`) for per-stack Squid ACL isolation.

The AI-facing surface is `browser-intent-mcp`, never the worker. It exposes named intent tools only — no raw browser controls, no DOM access, no JavaScript eval, no arbitrary navigation, no Infisical reads.

**Login/session tools:**
```
login_col_financial
login_maxicare
login_april_international
login_hi_precision
check_site_session
logout_site
list_browser_intent_sites
```

**Post-login data tools (gated):**
```
col_financial_get_portfolio        — holdings + totals (sanitized JSON)
col_financial_diagnose_portfolio   — frame/header structural metadata only (no cell values)
```

### Security invariants

1. **Credentials never reach the LLM.** Username, password, and `TOTP_SECRET` are rendered into the worker's environment by the Infisical sidecar and used only by Playwright. No tool returns them.
2. **Login/session tools never return post-login data.** They return only `{status, ...}`.
3. **Post-login data tools** are explicit, allowlisted opt-ins:
   - Each new action must appear in `policies/sites.json` under the site's `allowedTools` array.
   - Session is required: if the worker has no logged-in session for the site, the call returns `{status: "session_expired"}` so the LLM is forced to call `login_<site>` first.
   - Returns only the documented JSON shape — no raw HTML, cookies, screenshots, or unparsed DOM.
   - Each call is audit-logged with `returned_sensitive_data: true`.
   - If the page DOM has drifted and the extractor cannot locate its target, the worker returns `{status: "needs_extractor_update"}` rather than guessing.

### Extractor module layout

`browser-intent/worker/extractors/<site>.js` exports functions named after the snake_case action (e.g. `getPortfolio`, `diagnosePortfolio`). The worker resolves `<site>_<action>` MCP calls to the matching module and method dynamically — adding a new extraction action means dropping a new file and listing the action in `policies/sites.json`; no MCP server code changes.

The first concrete extractor is `extractors/col_financial.js`: it frame-scans COL's classic-ASP `/ape/Final2/` portal for a holdings table whose headers match `HEADER_MATCHERS` (a forgiving allowlist of expected column names), then returns symbol/quantity/average-cost/last-price/market-value/unrealized-P&L per row plus totals. Header drift throws `needs_extractor_update` — humans patch `HEADER_MATCHERS` rather than letting the extractor silently mismatch.

---

## Infisical Agent Sidecar (OpenClaw, Browser Intent)

OpenClaw and Browser Intent do not receive secrets via environment variables at container creation. Instead, a sidecar container (`infisical-agent`) runs alongside the main service and injects secrets at runtime:

```
┌─────────────────────────────────────────────────────┐
│  openclaw / browser-intent stack                     │
│                                                      │
│  ┌──────────────────┐     shared volume              │
│  │  infisical-agent │ ──► secrets-runtime/.env       │
│  │  (cli:latest)    │     (rendered every 60 s)      │
│  └──────────────────┘                                │
│           │                       ▲                  │
│           │ Universal Auth        │ env_file          │
│           ▼                       │ (required:false)  │
│     Infisical :8090         ┌──────────────┐         │
│     (platform-net)          │  main service │         │
│                             └──────────────┘         │
└─────────────────────────────────────────────────────┘
```

**Key files (OpenClaw example; Browser Intent mirrors the layout):**
- `openclaw/agent-config/agent.yaml` — Universal Auth config; Infisical address `http://infisical:8090`
- `openclaw/agent-config/secrets.tmpl` — Jinja2 template, reads your Infisical project dev env
- `openclaw/agent-config/entrypoint.sh` — writes CLIENT_ID and CLIENT_SECRET to tmpfs, then `exec infisical agent`
- `openclaw/secrets-runtime/.env` — rendered output, never committed

**Startup:** `infisical-agent` must reach `healthy` before the main service starts (`depends_on: service_healthy`). Health check: file `/secrets/.env` exists (polls 5 s, timeout 120 s).

**Secret rotation:** agent polls every 60 s and rewrites `secrets-runtime/.env`. The main service only re-reads it on restart — a `docker compose restart <service>` applies rotated secrets.

Hermes uses a different pattern (in-process wrapper) — see **Hermes Stack** below.

---

## OpenClaw ttyd Browser Terminal

`openclaw-ttyd` is a sidecar container that provides a browser-based terminal at `http://127.0.0.1:7681`, allowing CLI access to the `openclaw` binary without needing a local shell or `docker exec`.

```
┌─────────────────────────────────────────────────────┐
│  openclaw stack                                      │
│                                                      │
│  ┌──────────────────┐     shared volume              │
│  │  openclaw-ttyd   │◄──► openclaw-home volume       │
│  │  (ttyd :7681)    │     (same state as gateway)    │
│  └──────────────────┘                                │
│           │                                          │
│    HTTP Basic Auth                                   │
│    TTYD_USERNAME / TTYD_PASSWORD                     │
│    (from Infisical → secrets-runtime/.env)           │
│                                                      │
│  ┌──────────────────┐                                │
│  │  openclaw-gateway│                                │
│  └──────────────────┘                                │
└─────────────────────────────────────────────────────┘
```

**Design:** Uses the same image as `openclaw-gateway` (`platform/openclaw:2026.4.23-1-codex`) — this gives it the `openclaw` CLI binary without a separate installation. The shared `openclaw-home` volume means the CLI reads live gateway state, so `openclaw security audit` reflects the running gateway's configuration.

**Authentication:** ttyd's `--credential` flag enforces HTTP Basic Auth. Credentials are sourced from Infisical (`TTYD_USERNAME`, `TTYD_PASSWORD`, dev env, root path `/`) and injected via the same `secrets-runtime/.env` that the gateway uses.

**Healthcheck:** Uses `CMD` format (not `CMD-SHELL`) calling `curl -so /dev/null http://localhost:7681`. The `-so` flag discards output and accepts any HTTP response including 401, so the healthcheck passes even when auth is enforced.

**Usage:**
```bash
# From browser at http://127.0.0.1:7681 (credentials from Infisical)
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

---

## Hermes Stack

`hermes/` is the second AI/agent core — an on-demand stack that runs a Hermes agent with a Telegram messaging gateway and a TUI dashboard. It follows the IronNest security pattern (localhost-only ingress, AdGuard DNS, Squid egress allowlisting, dropped Linux capabilities, `no-new-privileges`, kernel-firewall on `hermes_ingress`), but uses a **different secrets injection pattern from OpenClaw / Browser Intent**.

### Secrets injection — in-process `with-infisical` wrapper

Hermes does **not** run an `infisical-agent` sidecar. Instead, every Hermes service starts via `/usr/local/bin/with-infisical` (see `hermes/with-infisical.sh` + Dockerfile). The wrapper:

1. Logs in to `http://infisical:8090` using the Universal Auth machine identity from `hermes/.env`.
2. `exec`s `infisical run` with the Hermes project / dev environment.
3. Secrets become env vars in the wrapped process and are **never written to disk** — no `secrets-runtime/.env`, no shared volume.

Why differ from OpenClaw? Hermes was prototyping a "secrets only in process memory" model; on a security-restricted laptop, eliminating the rendered `.env` file removes one persistent secret surface. Both patterns coexist; pick per stack.

### Containers

```
┌─────────────────────────────────────────────────────┐
│  hermes stack                                        │
│                                                      │
│  ┌──────────────────┐    ┌──────────────────┐       │
│  │  hermes-ttyd     │    │  hermes-gateway  │       │
│  │  TUI :7682       │    │  Telegram bot    │       │
│  │  Dashboard :9119 │    │  (no host port)  │       │
│  └──────────────────┘    └──────────────────┘       │
│           │                       │                  │
│  Both wrapped by /usr/local/bin/with-infisical       │
│  (creds from hermes/.env, secrets in-process only)   │
│           │                       │                  │
│           ▼                       ▼                  │
│   shared volume hermes-data       Telegram (.tg.org) │
│   (config, memories, skills)      via Squid CONNECT  │
└─────────────────────────────────────────────────────┘
```

| Container | Role | Host port | Notes |
|---|---|---|---|
| `hermes-ttyd` | TUI terminal + Hermes web dashboard (`hermes dashboard --insecure`) | `127.0.0.1:7682` (TUI), `127.0.0.1:9119` (dashboard/metrics) | Basic Auth via `HERMES_TTYD_USERNAME` / `HERMES_TTYD_PASSWORD` from Infisical |
| `hermes-gateway` | Long-running Hermes agent + Telegram bot adapter | — (internal-only) | Reachable from other stacks on `platform-net` at `hermes-gateway:<port>` |

**Persistent volume:** `hermes_hermes-data` (mounted at `/opt/data` — config, conversation memories, skills). Backed up nightly.

**Egress allowlist:** Identical to OpenClaw plus `.usccb.org` (daily-readings cron) and `.telegram.org` (CONNECT-only for the bot).

### Build / start split

`hermes/build.sh` and `hermes/start.sh` are deliberately separate:

- **`hermes/build.sh`** runs `docker compose build [--pull]`. Run this manually when the Dockerfile or bundled Hermes source changes (e.g. version bump). The first build is ~20 min — Node/Python/Playwright deps; subsequent builds use the layer cache.
- **`hermes/start.sh`** is fast: it repairs Rancher Desktop NAT, parses the image tag from `docker-compose.yml`, calls `build.sh` only if the image is missing, runs `docker compose up -d --no-build`, applies `fix-hermes-egress.sh`, and waits for healthy. Verified end-to-end at logon in ~20 s warm / ~140 s cold.

Why `--no-build`? Both Hermes services have both `build:` and `image:` in compose. Even on plain `docker compose up -d`, BuildKit walks the build context to decide whether a rebuild is needed — on a WSL2 cold-start under disk-IO pressure this hangs for 5–10+ min. `--no-build` skips that evaluation entirely.

**Direct-egress check:** from inside any Hermes container, `curl --noproxy "*" -m 5 https://example.com` should time out (kernel rule), while `curl https://api.telegram.org` should succeed (Squid allowlist).

---

## Monitoring & Log Enrichment

`monitoring/` runs two always-on containers that together turn Docker's raw JSON log files into queryable, attributed events in Wazuh.

### Containers

- **`monitoring-fluent-bit`** (`fluent/fluent-bit:3.2-debug`, pinned at `172.30.0.15`). Tails `/var/lib/docker/containers/*.log`, applies the lua enrichment filter, ships to `wazuh.indexer` under `ironnest-containers-*`.
- **`monitoring-container-sync`** (`platform/monitoring-container-sync:1.0`, built from `monitoring/Dockerfile.container-sync`). Polls `socket-proxy` every 60 s for running containers and writes `/lookups/containers.tsv` to a shared volume that fluent-bit reads.

### Why a custom Dockerfile for container-sync

Earlier iterations used bare `alpine:3.20` with `apk add curl jq` in the entrypoint. That silently failed for days — the container is attached only to `platform-net` (`internal: true`), so the kernel drops the SYN of `apk add`'s package fetch, the script logs "curl: not found" forever, and the lookup file never appears. Fluent-bit then can't enrich anything. **Lesson:** services on `platform-net` cannot install packages at runtime. Pre-install at build time via a small Dockerfile.

### TSV schema

`/lookups/containers.tsv` is tab-separated, one row per container, columns produced by `jq -r '... | @tsv'`:

```
<short_id>\t<name>\t<image>\t<compose_project>\t<compose_service>
```

Missing labels are emitted as `"-"` so split logic stays simple. The lua filter rejects `"-"` for individual fields and falls back to `unknown` only for the name.

### Enrichment fields added to every record

| Field | Source |
|---|---|
| `container_id` | First 12 chars of container ID, extracted from the input tag |
| `container_name` | TSV column 2 (e.g. `openclaw-gateway`) |
| `container_image` | TSV column 3 (e.g. `platform/openclaw:2026.4.23-1-codex`) |
| `compose_project` | TSV column 4 (e.g. `openclaw`) |
| `compose_service` | TSV column 5 (e.g. `openclaw-gateway`) |

This lets Wazuh queries filter cleanly by stack (`compose_project=hermes`), service (`compose_service=traefik`), or image version without grep-on-text.

### Why Squid and Traefik no longer use the syslog driver

Earlier versions piped Squid and Traefik directly to `wazuh.manager:5140` via Docker's `syslog` driver. That has been replaced with the default `json-file` driver: both write to stdout/stderr, fluent-bit picks them up via the generic container-log tail, and the same lua enrichment applies. Net effect — one less moving part and access logs are now searchable by `container_name=egress-proxy` / `container_name=traefik` in the unified `ironnest-containers-*` index.

---

## OpenClaw AI Provider Configuration

OpenClaw supports multiple AI providers. IronNest has two configured: the standard OpenAI API (API-key billed) and the Codex provider (ChatGPT subscription, flat-rate). Both are registered in `auth-profiles.json` on the persistent volume.

### Configured Providers

| Provider ID | Backend | Auth method | Billing | Default model |
|---|---|---|---|---|
| `openai` | `api.openai.com` | API key (`sk-...`) from Infisical | Per token | `openai/gpt-5.4` |
| `codex` | `chatgpt.com/backend-api/v1` | JWT session token (manual) | ChatGPT subscription | `codex/gpt-5.4-pro` ✅ |

> `codex/gpt-5.4-pro` is the active default. Set via `openclaw models set codex/gpt-5.4-pro`.

### Auth Storage

Both provider tokens live in the persistent volume:

```
/home/node/.openclaw/agents/main/agent/auth-profiles.json
```

This file survives container restarts and `--force-recreate`. Structure:

```json
{
  "version": 1,
  "profiles": {
    "openai:manual":  { "provider": "openai",  "token": "sk-..."    },
    "codex:manual":   { "provider": "codex",   "token": "eyJhbGci..." }
  }
}
```

### OpenAI API Key — automated via Infisical

The `openai` provider key (`OPENAI_API_KEY`) is stored in Infisical → injected into the gateway container env by the Infisical agent sidecar → re-registered into `auth-profiles.json` automatically by `openclaw/start.sh` on every startup. No manual steps required after key rotation.

### Codex Token — manual refresh required

The `codex` provider authenticates against the ChatGPT web backend using a JWT `accessToken` extracted from the browser session. This token **expires periodically** (hours to days) and must be refreshed manually.

**How to get the token:**
1. Open `https://chatgpt.com` in your browser (must be logged in)
2. Navigate to `https://chatgpt.com/api/auth/session`
3. Copy **only** the JWT value from `"accessToken"` — starting with `eyJ...`, not the surrounding JSON

**⚠️ Common mistake:** Copying the raw JSON field (`accessToken":"eyJ...`) instead of just the value (`eyJ...`) corrupts the token in `auth-profiles.json`.

**How to register:**
```bash
# In Windows Terminal (requires interactive TTY):
docker exec -it openclaw-gateway openclaw models auth paste-token --provider codex
```

**Helper script** — use this for all future refreshes, handles TTY detection automatically:
```bash
bash openclaw/reauth-codex.sh
```

**Startup check:** `openclaw/start.sh` checks for a `codex:manual` profile on every boot and prints a warning if it is missing, but does not block startup.

### Egress note

The `codex` provider calls `chatgpt.com/backend-api/v1`; Squid explicitly allowlists `.chatgpt.com`. Direct no-proxy internet access from OpenClaw should remain blocked by the `DOCKER-USER` rule on `openclaw_ingress`; verify with:

```bash
docker exec openclaw-gateway curl --noproxy "*" -m 5 -sf https://example.com -o /dev/null \
  && echo "BAD: direct egress reachable" \
  || echo "OK: direct egress blocked"
```

---

## Autostart

Two Task Scheduler tasks registered for user `phoenix`, both triggered "At logon", `LogonType: Interactive`, `RunLevel: Limited`. They fire in parallel — the platform task waits for Docker to come up regardless of whether the RD task has finished launching it.

| Task | Script | Trigger | What it does |
|---|---|---|---|
| `rancher-desktop-autostart` | `ops/launch-rancher-desktop.ps1` | At logon (phoenix) | Polls until `vmcompute` + `WSLService` are `Running`, `wsl --status` returns OK, and `D:\claude-workspace\platform` is reachable. Sleeps 15 s. Launches `"C:\Program Files\Rancher Desktop\Rancher Desktop.exe"`. Skips if RD already running. ExecutionTimeLimit: 30 min. |
| `platform-autostart` | `ops/autostart.ps1` | At logon (phoenix) | Polls `docker info` up to 180 s (waits out RD cold-boot). Then chains `bash bootstrap.sh && { bash openclaw/start.sh; bash hermes/start.sh; bash browser-intent/start.sh; }`. The brace group with `;` means each on-demand stack runs independently — one's failure does not block the next. ExecutionTimeLimit: 1 hr. |

**Why two tasks, not one?** Separation lets each task have its own ExecutionTimeLimit and `LastTaskResult` for diagnosis. RD launch is bounded (30 min); platform bring-up may legitimately take longer (Wazuh + first-time Hermes build).

**Verified end-to-end (2026-05-14):** RD process up at +18 s after logon, Docker responsive at +40 s, all 23 containers healthy and `platform-autostart` exiting `LastTaskResult: 0` at +140 s.

**Prerequisite:** Rancher Desktop's own "Automatically start at login" toggle (Preferences → Application → Behavior) must be **off** so it doesn't race with `rancher-desktop-autostart`.

**Manual operation:**

```powershell
# Force a run without logging out
Start-ScheduledTask -TaskName 'rancher-desktop-autostart'
Start-ScheduledTask -TaskName 'platform-autostart'

# Check status
Get-ScheduledTaskInfo -TaskName 'platform-autostart' |
  Select-Object LastRunTime, LastTaskResult, NextRunTime
# LastTaskResult 0 = success, 267009 = still running, anything else = error
```

---

## Backup Artifacts

Produced by `ops/backup.sh` (Task Scheduler task `rancher-stack-backup`, daily), stored at `G:\rancher-stack-backups\<YYYY-MM-DD_HHMMSS>\`:

| File | Contents |
|------|----------|
| `postgres.sql.gz` | Infisical Postgres logical dump |
| `openclaw-home.tar.gz` | OpenClaw gateway persistent home volume |
| `openclaw-codex-home.tar.gz` | OpenClaw Codex provider session state |
| `hermes-data.tar.gz` | Hermes `/opt/data` (config, memories, skills) |
| `adguard-conf.tar.gz` | AdGuard configuration volume |
| `traefik-certs.tar.gz` | Traefik TLS cert + key (volume `ingress_traefik-certs`) |
| `wazuh-etc.tar.gz` | Wazuh manager `/etc/wazuh` |
| `wazuh-logs.tar.gz` | Wazuh manager logs |
| `wazuh-filebeat-etc.tar.gz` | Filebeat config |
| `wazuh-indexer-data.tar.gz` | OpenSearch index data |
| `wazuh-dashboard-config.tar.gz` | Dashboard configuration |
| `platform-config.tar.gz` | All `.env` files, Wazuh TLS certs, compose files, ops scripts |
| `SHA256SUMS` | Checksums for all above artifacts |

**Not backed up (regenerable):** Trivy CVE DB cache, AdGuard work volume, Dozzle state, Squid cache, Infisical Redis cache, blocklist-updater output (re-fetched on schedule), `monitoring-container-sync` TSV lookup (rebuilt every 60 s).

Retention: **14 days** with automatic pruning. Runbook: `G:\rancher-stack-backups\RECOVERY.txt`. `restore.sh` verifies `SHA256SUMS` before touching any volume.

---

## Known Issues & Recovery Runbooks

### Infisical agent TCP timeout — Rancher Desktop `sshPortForwarder` DNAT hijack

**Symptom:** `openclaw-infisical-agent` (or any sidecar agent) logs `dial tcp <infisical-ip>:8090: i/o timeout`. ICMP (ping) works between containers but TCP connections hang. Affects all published ports (8090, 3000, 18789, 1514/1515, 8443, 8888).

**Root cause:** Rancher Desktop's experimental `sshPortForwarder` feature injects bare DNAT rules into the Docker network namespace's `nat/PREROUTING` chain to enable Windows→container port access via an SSH tunnel. Crucially, these rules have **no source or interface restriction**:

```
DNAT tcp -- * * 0.0.0.0/0  0.0.0.0/0  tcp dpt:8090 to:127.0.0.1:8090
```

This intercepts **all** TCP to the published port — including intra-bridge container-to-container traffic — and redirects it to the loopback SSH tunnel, which drops the connection. ICMP is unaffected because DNAT only matches TCP.

The rules are (re-)added by `sshPortForwarder` after each Rancher Desktop restart or whenever a container's port mapping changes.

**Permanent fix (applied by `bootstrap.sh` and every `start.sh`):**

`ops/fix-nat-prerouting.sh` inserts a `RETURN` rule at the top of `nat/PREROUTING` that exempts all container-origin traffic from the DNAT rules:

```bash
iptables -t nat -I PREROUTING 1 -s 172.16.0.0/12 -j RETURN
```

Docker containers use addresses in `172.16.0.0/12` (172.16–172.31). The SSH tunnel connects from `127.0.0.1`, which is outside this range, so Windows port publishing continues to work. The script is idempotent — it checks before inserting.

**Manual recovery (if `bootstrap.sh` was not re-run after a restart):**

```bash
cd /d/claude-workspace/platform
bash ops/fix-nat-prerouting.sh
bash ops/repair-egress.sh              # verify routing, restart infisical if needed
cd openclaw && docker compose up -d --force-recreate openclaw-gateway
# For Hermes: bash hermes/start.sh   (re-applies fix-hermes-egress.sh)
```

> `docker compose restart` is insufficient — env_file is loaded at container creation time, not on restart. Always use `--force-recreate` when secrets change.

**The rules reset on every Rancher Desktop restart.** Always run `bootstrap.sh` (or the autostart task) after restarting Rancher Desktop — do not bring individual stacks up with bare `docker compose up -d`.

---

### All published ports unreachable from Windows — guestagent storm from a flapping container

**Symptom:** Every `127.0.0.1:<port>` published by the platform stops responding from the Windows host (browser shows `ERR_CONNECTION_RESET`, `curl` times out). Affects Hermes (7682, 9119), AdGuard (3000), Infisical (18090), OpenClaw (18789, 7681), Wazuh dashboard (8443), Traefik (8880), Dozzle (8888), and 80/443 simultaneously. Containers themselves report healthy and the in-container service responds when probed via `docker exec`.

**Root cause:** Rancher Desktop's `rancher-desktop-guestagent` (OpenRC service in the `rancher-desktop` WSL distro) drives port forwarding from a userspace forwarder via `/services/forwarder/expose`. It rebuilds an internal `portStorage` map on every Docker `start`/`die` event. If a single container is in a tight `start → exit 0 → restart` loop (e.g. an entrypoint that runs once and exits but has `restart: unless-stopped`), each die event causes the agent to flush the entire map then re-`expose` only the containers that happen to fire a fresh start event. The host-side forwarder retains stale bindings (`error from API: proxy already running`), and the API itself starts intermittently timing out. Net effect: the platform's published ports degrade or vanish until Rancher Desktop is restarted.

**Diagnostic signature:**

```bash
# Identify the looping container
wsl -d rancher-desktop -- sh -c "tail -n 200 /mnt/c/Users/$USER/AppData/Local/rancher-desktop/logs/rancher-desktop-guestagent.log" \
  | grep -oP "Status: die ContainerID: \K[a-f0-9]+" | sort -u
docker ps -a --no-trunc --filter "id=<id>" --format "{{.Names}}\t{{.Status}}"

# Confirm host-side timeout vs in-container success
docker exec <ttyd-container> curl -isS -m 3 http://127.0.0.1:7682/   # works → 401 expected
curl -m 5 http://127.0.0.1:7682/                                       # times out from Windows
```

**Recovery:**

1. Stop the flapping container so the storm ends:
   ```bash
   docker stop <looping-container>
   ```
2. If the guestagent is still healthy, restarting any affected container re-registers its ports. If the agent or forwarder API is stuck (`/services/forwarder/expose` timing out, `proxy already running` errors), fully restart Rancher Desktop (rdctl shutdown, then re-launch via the `rancher-desktop-autostart` task or manually). `platform-autostart` will re-run `bootstrap.sh` and all on-demand stacks at next logon — no manual bootstrap needed.
3. Fix the looping container's entrypoint so it stays in the foreground for the lifetime of the schedule (e.g. `exec crond -f` rather than running once and exiting). One-shot jobs should not have `restart: unless-stopped`.

---

## Windows/WSL2 Operational Notes

- **Autostart:** Two Task Scheduler tasks at logon — `rancher-desktop-autostart` (launches RD with dependency gating + 15 s settle) and `platform-autostart` (waits for Docker, then brings up bootstrap + all 3 on-demand stacks). See **Autostart** above for details. RD's own "Automatically start at login" toggle must be off.
- Start Rancher Desktop from Start Menu (or let the task launch it) before any `docker` commands. The tray icon must go green — wait for it.
- Add binaries to PATH in Git Bash:
  ```bash
  export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"
  ```
- `C:\Users\<you>\.wslconfig` has `localhostForwarding=false` — required to prevent `wslrelay.exe` from conflicting with Rancher Desktop's `host-switch.exe`. Do not re-enable.
- Git Bash path conversion: use `MSYS_NO_PATHCONV=1` and convert `/c/...` → `C:/...` with a `to_win()` helper when passing bind-mount paths to `docker -v`.
- Wazuh host agent installed at `C:\Program Files (x86)\ossec-agent\` (service: `WazuhSvc`), pointing at `127.0.0.1:1514/1515`. Re-enroll: `& "C:\Program Files (x86)\ossec-agent\agent-auth.exe" -m 127.0.0.1 -p 1515` then `Restart-Service WazuhSvc`. After a manager container restart, `client.keys` on the host goes stale — remove old agent from manager (`manage_agents -r <id>`) before re-enrolling.
- Log rotation: every container uses the shared `x-logging` anchor (`max-size: 10m`, `max-file: 3`). Don't override it per-service unless there's a specific reason.

## Ops Script Reference

| Script | Purpose | Idempotent? | When to run |
|---|---|---|---|
| `ops/launch-rancher-desktop.ps1` | Gated launch of Rancher Desktop (vmcompute + WSLService + wsl --status + D:\ checks, 15 s settle) | Yes (skips if RD running) | Task Scheduler `rancher-desktop-autostart` (at logon) |
| `ops/autostart.ps1` | Wait for Docker, then `bootstrap.sh && { openclaw; hermes; browser-intent }` | Yes | Task Scheduler `platform-autostart` (at logon) |
| `ops/fix-nat-prerouting.sh` | Insert `RETURN` rule shielding `172.16.0.0/12` from Rancher Desktop's PREROUTING DNAT hijack | Yes | After every Rancher Desktop restart (called by `bootstrap.sh` and each `start.sh`) |
| `ops/repair-egress.sh` | Reconnect Infisical from `platform-egress` to flush stale FDB entries | Yes | After WSL2 hibernate/resume; called by `bootstrap.sh` |
| `ops/fix-openclaw-egress.sh` | Insert DOCKER-USER DROP rule on `openclaw_ingress` outbound | Yes | Called by `openclaw/start.sh` |
| `ops/fix-hermes-egress.sh` | Insert DOCKER-USER DROP rule on `hermes_ingress` outbound | Yes | Called by `hermes/start.sh` |
| `hermes/build.sh` | Build the `platform/hermes-agent` image (`docker compose build [--pull]`) | Yes | Manual; only when Dockerfile or app source changes |
| `hermes/start.sh` | Up the Hermes stack with `--no-build`; auto-invokes `build.sh` on first run if image missing | Yes | Manual or via `platform-autostart` |
| `openclaw/start.sh` | Up OpenClaw, repair egress, register provider auth from injected env | Yes | Manual or via `platform-autostart` |
| `browser-intent/start.sh` | Up Browser Intent, repair egress, wait for MCP healthy | Yes | Manual or via `platform-autostart` |
| `ops/backup.sh` | Daily volume snapshots → `G:\rancher-stack-backups\` | n/a | Task Scheduler `rancher-stack-backup` (daily) |
| `ops/restore.sh` | Verify SHA256SUMS and restore selected volumes | n/a | Manual recovery; see `RECOVERY.txt` |
| `ops/status.sh` | Snapshot of stack health, listening ports, egress reachability | Yes | Ad-hoc diagnostics |
