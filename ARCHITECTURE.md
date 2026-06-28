# IronNest Architecture

## Overview

**IronNest** is a security-hardened, modular container platform running on Rancher Desktop (WSL2/Windows 11). It hosts AI/agent workloads (OpenClaw, Hermes) and a managed browsing surface (Browser Intent) surrounded by a layered security perimeter: **FIDO-gated identity at the edge (Authelia, WebAuthn passkeys)**, secrets management, DNS filtering, HTTP egress control, kernel-firewall ingress isolation, SIEM monitoring, image scanning, log aggregation, public reverse proxy, and observability — each in its own isolated Compose project.

All human-facing UIs are reachable only via `https://*.ironnest.local/` through Traefik, and **every route now requires a physical FIDO key tap (WebAuthn passkey)** to establish a session — most via Authelia's ForwardAuth middleware, and the **Wazuh dashboard via OIDC SSO** against Authelia acting as the OpenID Provider (wired 2026-05-28; the earlier "Wazuh is the one exception" ForwardAuth carve-out is gone). Backend services no longer publish loopback ports — the FIDO gate cannot be bypassed by an attacker who has access to the host's network stack. A coarse `trusted-networks` IP allowlist (RFC1918 + Docker bridge ranges) sits in front of Authelia on the sensitive routes; note that `127.0.0.1/32` is **deliberately excluded** so that even an attacker on the host loopback must pass the FIDO gate (Traefik publishes on `0.0.0.0:443`, so the host reaches services over the LAN-facing listener, not a loopback bypass).

**Footprint:** 13 regular Compose projects — **19 always-on/support** containers (across the 9 bootstrap stacks plus the internal `wazuh-query-broker` support stack; Wazuh runs 4 — manager + indexer + dashboard + `wazuh-infisical-agent` — and Ingress runs 3 — traefik + authelia + `ingress-infisical-agent`) + **22 on-demand** containers (openclaw 3 + hermes-platform 16 + browser-intent 3) = **41 regular containers** when every runtime stack is running. The optional `ironnest-browse` diagnostic stack adds 1 container, and the optional LLM Wiki companion (separate project at `D:\LLM Wiki`) adds 6 more. There is also **1 one-shot Trivy scanner profile**. The on-demand stacks (`openclaw`, `hermes-platform`, `browser-intent`) are not started by `bootstrap.sh`; the logon autostart task brings them up. The legacy `hermes/` Compose stack was **removed 2026-05-31** — `docker-compose.yml` and `start.sh` deleted; the `hermes/` directory is now solely the build context for `platform/hermes-agent` image (Dockerfile + build.sh). Hermes Platform (`hermes-platform/`) is the sole agent stack, with **16** containers: eight isolated `hermes-pf-*` profile gateways (incl. `octo`, added 2026-06-12), `hermes-platform-ttyd`, the memory gateway, OpenViking, Ollama, the OpenViking Infisical sidecar, the **Mission Control** ops dashboard (`hermes-platform-mission-control`, added 2026-06-07), the approval-gated **operations runner** (`hermes-platform-operations-runner`), and the sandboxed static artifact app server (`hermes-platform-artifact-apps`). Mission Control also relies on a tiny in-container **agent-chat bridge** co-process running inside each `hermes-pf-*` (not a separate container) for dashboard chat + file downloads — see **Hermes Platform Stack → Mission Control** below.

**Platform root (canonical):** `D:\claude-workspace\platform\` — git repo, remote `https://github.com/Wild0live/ironnest`, branch `master`. Every running container's `com.docker.compose.project.config_files` label points under this tree (verified 2026-05-14 against egress-proxy, traefik, hermes, etc.). A separate clone at `D:\claude-workspace\gitHub\ironnest\` exists for documentation drafting only; it is not bind-mounted into any container.  
**Docker storage:** `F:\wsl\rancher-desktop-data\ext4.vhdx` (off the C: drive)  
**Backup target:** `G:\rancher-stack-backups\` (14-day retention)

---

## Design Principles

### 1. Blast-radius isolation
Each capability lives in its own Compose project. Restarting or resetting one stack cannot affect others. OpenClaw, Hermes Platform profile agents, and Browser Intent have zero Docker socket access and zero lifecycle control over any other container; the only lifecycle-control path is Mission Control's private, approval-gated operations runner.

### 2. Least privilege everywhere
- All containers drop capabilities they don't need; most use `cap_drop: ALL`.
- Filesystem mounts are read-only except where writes are strictly required (tmpfs for ephemeral scratch).
- `no-new-privileges: true` on every service that accepts it.
- Healthchecks use proper credentials where the service requires auth (e.g. wazuh.indexer passes `WAZUH_INDEXER_PASSWORD` and asserts HTTP 200, not 401). Accepting 401 as healthy masks auth misconfiguration.

### 3. No raw Docker control except the approved runner
Dozzle, Wazuh, Trivy, and `monitoring-container-sync` talk to the `socket-proxy` service, which exposes only read-only endpoints (CONTAINERS, EVENTS, IMAGES, INFO, NETWORKS, PING, VERSION, VOLUMES). Write/exec/build operations stay blocked through the proxy. The only scoped exception is `hermes-platform-operations-runner`, which mounts the Docker socket read-only and is reachable only from Mission Control on `mission-control-ops-net`; it enforces bearer auth, single-use approvals, exact allowlists, and a narrow action set instead of exposing a general Docker API.

### 4. DNS-first filtering
Every service sets `dns: 172.30.0.10` (AdGuard). DNS-layer blocking is the first line of defence against malicious domain resolution before any TCP connection is attempted.

### 5. Blocklist-filtered HTTP egress
Outbound HTTP/HTTPS is routed through Squid (`HTTP_PROXY=http://squid:3128`). The current policy is **allow-by-default with destination blocklists** — Spamhaus DROP/EDROP, Emerging Threats, and Feodo Tracker feeds are refreshed every 6 h by `blocklist-updater` and an inotifywait watchdog inside the egress-proxy container triggers `squid -k reconfigure` whenever the list files change. AdGuard DNS provides the first-line domain filter (see Layer 1 below). A per-stack `dst_browser_intent` allowlist exists in `squid.conf` but is not currently referenced in any `http_access` rule; per-stack destination restriction for Browser Intent is enforced at the Playwright layer via `policies/sites.json` `allowedDomains`. Raw TCP (SMTP, threat feeds) bypasses Squid but is restricted to `platform-egress` network members only.

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

`bootstrap.sh` deliberately **does not** start the on-demand stacks (`openclaw`, legacy `hermes`, `hermes-platform`, `browser-intent`) — bring those up explicitly with their per-stack `start.sh` where present, or with the stack's documented compose command. Each on-demand startup path re-runs the NAT and egress repair scripts where applicable, brings its compose project up, applies a kernel-firewall rule that blocks direct outbound traffic from its `*_ingress` bridge where applicable, and waits for healthy.

At logon, two Task Scheduler tasks chain the entire bring-up; see **Autostart** below.

### 9. Backup completeness and verifiability
Every backup run produces a `SHA256SUMS` file. `restore.sh` verifies checksums before touching anything. Fourteen-day retention with automatic pruning.

### 10. Resource limits by default
Long-running services should have explicit `cpus` and `memory` limits to prevent a runaway container from starving the WSL2 VM and degrading Rancher Desktop. Current documented gaps are called out in **Service Resource Limits** so they can be closed deliberately.

### 11. FIDO-gated identity at the edge
Every human-facing UI is reachable only via `https://*.ironnest.local/` through Traefik and requires a WebAuthn passkey (FIDO key tap or Windows Hello) to establish a session. Most routers are wrapped in an Authelia **ForwardAuth** middleware; the **Wazuh dashboard** uses **OIDC SSO** against Authelia (the dashboard runs its own OpenID Connect flow, so it never gets a 302-to-HTML mid-SPA the way ForwardAuth broke it — see **Identity Gate (Authelia)** below). Backend services do **not** publish loopback ports — an attacker who has remote control of the host's network stack still cannot reach Infisical, Dozzle, AdGuard, Wazuh, OpenClaw, Hermes, or any dashboard without producing the physical key. Sessions are short (1h inactivity, 4h max, no remember-me) so a stolen cookie has a small useful window. See **Identity Gate (Authelia)** below.

---

## Stack Inventory

13 regular Compose projects (9 bootstrap always-on + 1 internal support stack + 3 on-demand). Always-on bootstrap stacks are brought up by `bootstrap.sh`; `wazuh-query-broker` is an internal support stack on `platform-net`; on-demand stacks need their own `start.sh`, documented compose command, or the autostart task. Optional `ironnest-browse` diagnostics and LLM Wiki at `D:\LLM Wiki` are separate companion projects, not part of the regular platform count.

The **Reachable from host** column lists the URL or port a user/operator types to access the service. Most services no longer publish any host port — they are reachable only via Traefik at a `*.ironnest.local` hostname (which itself sits behind Authelia's FIDO gate). The **Wazuh dashboard's `127.0.0.1:8443` escape hatch was closed 2026-05-27** when it moved to OIDC SSO — Wazuh is now reachable only at `https://wazuh.ironnest.local/`. The **only** remaining direct loopback escape hatch is the Traefik dashboard (`http://127.0.0.1:8880/dashboard/`), kept as a last resort for when Traefik's own routing breaks.

| Stack | Path | Containers | Lifecycle | Reachable from host |
|-------|------|------------|-----------|---------|
| socket-proxy | `security/socket-proxy/` | 1 | always-on | — |
| adguard | `security/adguard/` | 1 | always-on | `https://adguard.ironnest.local/` (Authelia-gated) |
| egress-proxy | `security/egress-proxy/` | 2 (squid + blocklist-updater) | always-on | — |
| secrets (Infisical) | `secrets/` | 3 (infisical + postgres + redis) | always-on | `https://infisical.ironnest.local/` (Authelia-gated) |
| dozzle | `observability/dozzle/` | 1 | always-on | `https://dozzle.ironnest.local/` (Authelia-gated) |
| wazuh | `security/wazuh/` | 4 (manager + indexer + dashboard + infisical-agent) | always-on | `https://wazuh.ironnest.local/` (**FIDO-gated via OIDC SSO** against Authelia since 2026-05-28; loopback `8443` escape hatch closed) |
| trivy | `security/trivy/` | 1 server (+ on-demand scanner) | always-on (server) | — |
| ingress | `security/ingress/` | 3 (traefik + authelia + ingress-infisical-agent) | always-on | `0.0.0.0:80` (→ HTTPS redirect), `0.0.0.0:443` (all `*.ironnest.local` routes), `https://traefik.ironnest.local/dashboard/` (Authelia-gated) **+ escape hatch** `http://127.0.0.1:8880/dashboard/`. Authelia itself at `https://auth.ironnest.local/`, no host port. |
| monitoring | `monitoring/` | 2 (fluent-bit + container-sync) | always-on | — |
| wazuh-query-broker | `security/wazuh-query-broker/` | 1 (read-only query API) | support | — (internal only on `platform-net`; no host port) |
| openclaw | `openclaw/` | 3 (gateway + ttyd + infisical-agent) | on-demand | `https://openclaw.ironnest.local/` (Authelia-gated). `openclaw-ttyd` no longer published. |
| hermes | `hermes/` | **Build context only** — `docker-compose.yml` removed 2026-05-31. `hermes/` now contains only Dockerfile + build.sh for building `platform/hermes-agent` image shared by hermes-platform. | — | — |
| hermes-platform | `hermes-platform/` | 16 (OpenViking + Ollama + memory-gateway + management ttyd + 8 isolated `hermes-pf-*` gateways + OpenViking Infisical sidecar + Mission Control dashboard + operations runner + artifact app server) | on-demand | `https://hermes-platform.ironnest.local/` (ttyd, Authelia-gated), `https://hermes-platform-dashboard.ironnest.local/` (dashboard, Authelia-gated), `https://mission.ironnest.local/` (Mission Control ops dashboard, Authelia-gated), `https://apps.ironnest.local/` (sandboxed artifact app server, Authelia-gated). Loopback `127.0.0.1:8123`/`8124` (ttyd/dashboard) and `127.0.0.1:18080` (memory-gateway admin/diagnostic, **not behind Authelia**) remain for direct/in-network access. The operations runner has no host route and is reachable only by Mission Control. |
| browser-intent | `browser-intent/` | 3 (mcp-server + worker + infisical-agent) | on-demand | 127.0.0.1:18901 (MCP API endpoint, not browser-facing — not behind Authelia) |

> Infisical is published on **18090** rather than 8090 because Rancher Desktop's port forwarder intercepts low-numbered host ports inside the container netns. See the "Infisical agent TCP timeout" runbook below. (Note: as of 2026-05-27 the 18090 publish is commented out; Infisical is only reachable via `https://infisical.ironnest.local/`. Uncomment to restore direct loopback.)

---

## Container Profile

| Container | Role | Stack | Image | Host Port |
|-----------|------|-------|-------|-----------|
| `socket-proxy` | Read-only Docker socket proxy | socket-proxy | `platform/socket-proxy:0.4.2-patched` | — |
| `adguard` | DNS filter (pinned at `172.30.0.10`) | adguard | `adguard/adguardhome:v0.107.74` | — (admin UI loopback closed 2026-05-27; reachable only via `https://adguard.ironnest.local/`) |
| `egress-proxy` | HTTP allowlist proxy (Squid) | egress-proxy | `platform/squid:6.13-patched` | — |
| `blocklist-updater` | Periodic threat-feed fetcher feeding Squid | egress-proxy | `platform/blocklist-updater:1.0` | — |
| `infisical` | Secrets manager UI/API | secrets | `platform/infisical:pg-36438985-patched` | — (loopback closed 2026-05-27; reachable only via `https://infisical.ironnest.local/`) |
| `infisical-postgres` | Infisical database | secrets | `platform/postgres:16.13-alpine-patched` | — |
| `infisical-redis` | Infisical cache | secrets | `platform/redis:7.4.8-alpine-patched` | — |
| `dozzle` | Log viewer | dozzle | `amir20/dozzle:v10.6.5` | — (was `0.0.0.0:8888`, **LAN-exposed**; closed 2026-05-27; reachable only via `https://dozzle.ironnest.local/`) |
| `wazuh.manager` | SIEM log collection/analysis | wazuh | `wazuh/wazuh-manager:4.14.5` | `127.0.0.1:1514–1515` |
| `wazuh.indexer` | SIEM OpenSearch index (also validates Authelia ID tokens via OIDC; joins `platform-net` to reach `auth.ironnest.local`) | wazuh | `wazuh/wazuh-indexer:4.14.5` | — |
| `wazuh.dashboard` | SIEM dashboard (OIDC SSO against Authelia) | wazuh | `wazuh/wazuh-dashboard:4.14.5` | — (loopback `8443` closed 2026-05-27; reachable only via `https://wazuh.ironnest.local/`) |
| `wazuh-infisical-agent` | Renders `WAZUH_OIDC_CLIENT_SECRET` for the dashboard's OIDC client | wazuh | `platform/infisical-cli:0.43.76-patched` | — |
| `wazuh-query` | Read-only Wazuh Query Broker for profile agents | wazuh-query-broker | `ironnest/wazuh-query-broker:1.0.0` | — (internal only on `platform-net`) |
| `trivy-server` | CVE/image vulnerability scanner | trivy | `aquasec/trivy:0.70.0` | — |
| `traefik` | Public reverse proxy + TLS termination | ingress | `traefik:v3.3.4` | `0.0.0.0:80`, `0.0.0.0:443`, `127.0.0.1:8880` (dashboard — kept as escape hatch; also reachable Authelia-gated at `https://traefik.ironnest.local/dashboard/`) |
| `authelia` | Identity gate / WebAuthn portal + OIDC provider (for Wazuh) | ingress | `authelia/authelia:4.39.20` | — (no host port; reachable only via Traefik at `https://auth.ironnest.local/`). State persisted in named volume `ingress_authelia-data`. |
| `ingress-infisical-agent` | Renders Authelia's OIDC HMAC/JWKS/client snippet (`oidc-snippet.yml`) into `ingress_oidc-secrets` | ingress | `platform/infisical-cli:0.43.76-patched` | — |
| `monitoring-fluent-bit` | Tails all container logs → Wazuh (pinned at `172.30.0.15`) | monitoring | `platform/monitoring-fluent-bit:3.2` (built from `Dockerfile.fluent-bit`; `FROM fluent/fluent-bit:3.2-debug` + baked config/scripts/root-CA) | — |
| `monitoring-container-sync` | Writes `/lookups/containers.tsv` (short-ID → name/image/compose-project/service) for fluent-bit's lua enrichment | monitoring | `platform/monitoring-container-sync:1.0` (alpine + curl + jq, built from `Dockerfile.container-sync`) | — |
| `openclaw-gateway` | AI app workload | openclaw | `platform/openclaw:2026.4.23-1-codex` | — (loopback closed 2026-05-27; reachable only via `https://openclaw.ironnest.local/`) |
| `openclaw-ttyd` | Browser terminal sidecar | openclaw | `platform/openclaw:2026.4.23-1-codex` | — (loopback closed 2026-05-27 per user preference; not routed through Traefik. To restore: uncomment ports stanza and optionally add `openclaw-terminal.ironnest.local` route) |
| `openclaw-infisical-agent` | Secrets sidecar | openclaw | `platform/infisical-cli:0.43.76-patched` | — |
| *(legacy hermes containers removed 2026-05-31)* | `hermes-ttyd`, `hermes-gateway`, `hermes-gateway-wifey/steve/mark/littlejohn` were removed when `hermes/docker-compose.yml` was deleted. hermes-platform is now the sole agent stack. | — | — | — |
| `hermes-platform-openviking-infisical-agent` | Renders OpenViking secrets from Infisical | hermes-platform | `infisical/cli@sha256:dba406b3…` | — |
| `hermes-platform-ollama` | Local embedding inference for OpenViking (GPU-accelerated via WSL2 passthrough since 2026-06-13) | hermes-platform | `ollama/ollama:0.4.6` | — |
| `hermes-platform-openviking` | Long-term memory backend | hermes-platform | `platform/hermes-platform-openviking:0.1.0` | — |
| `hermes-platform-memory-gateway` | Policy-enforcing memory front door | hermes-platform | `platform/hermes-platform-memory-gateway:0.1.0` | `127.0.0.1:18080` |
| `hermes-platform-ttyd` | Hermes Platform management terminal + dashboard | hermes-platform | `platform/hermes-agent:v2026.6.5-patched` | `127.0.0.1:8123`, `127.0.0.1:8124` |
| `hermes-pf-default` | Hermes Platform gateway — `default` profile | hermes-platform | `platform/hermes-agent:v2026.6.5-patched` | — (internal only) |
| `hermes-pf-mark` | Hermes Platform gateway — `mark` profile | hermes-platform | `platform/hermes-agent:v2026.6.5-patched` | — (internal only) |
| `hermes-pf-steve` | Hermes Platform gateway — `steve` profile | hermes-platform | `platform/hermes-agent:v2026.6.5-patched` | — (internal only) |
| `hermes-pf-qa` | Hermes Platform gateway — `qa` profile (QA/verification; renamed from `wifey` 2026-06-14) | hermes-platform | `platform/hermes-agent:v2026.6.5-patched` | — (internal only) |
| `hermes-pf-littlejohn` | Hermes Platform gateway — `littlejohn` profile | hermes-platform | `platform/hermes-agent:v2026.6.5-patched` | — (internal only) |
| `hermes-pf-jaime` | Hermes Platform gateway — `jaime` profile | hermes-platform | `platform/hermes-agent:v2026.6.5-patched` | — (internal only) |
| `hermes-pf-bigbert` | Hermes Platform gateway — `bigbert` profile | hermes-platform | `platform/hermes-agent:v2026.6.5-patched` | — (internal only) |
| `hermes-pf-octo` | Hermes Platform gateway — `octo` profile (platform-ops; added 2026-06-12) | hermes-platform | `platform/hermes-agent:v2026.6.5-patched` | — (internal only) |
| `hermes-platform-mission-control` | Mission Control ops dashboard (standalone FastAPI; reads registry + audit log read-only, holds NO secrets) | hermes-platform | `platform/hermes-platform-mission-control:0.1.0` | — (internal only; reachable via `https://mission.ironnest.local/`) |
| `hermes-platform-operations-runner` | Approval-gated lifecycle/factory operations runner | hermes-platform | `platform/hermes-platform-operations-runner:0.1.0` | — (internal only on `mission-control-ops-net`; reached by Mission Control only) |
| `hermes-platform-artifact-apps` | Sandboxed read-only static server for complete webapp artifacts from the Kanban shared volume | hermes-platform | `nginxinc/nginx-unprivileged:alpine` | — (internal only; reachable via `https://apps.ironnest.local/`) |
| `browser-intent-mcp` | Intent-level MCP facade | browser-intent | `platform/browser-intent-mcp:0.1.0` | `127.0.0.1:18901` |
| `browser-intent-worker` | Playwright browser worker (pinned at `172.30.0.30` so Squid can ACL it independently) | browser-intent | `platform/browser-intent-worker:0.1.0` | — |
| `browser-intent-infisical-agent` | Secrets sidecar | browser-intent | `platform/infisical-cli:0.43.76-patched` | — |

**Functional layers (outermost → core):**
```
Identity Gate (Authelia + WebAuthn passkey) → Public Ingress (Traefik) → Socket Isolation → Observability (Dozzle)
  → DNS Filtering (AdGuard) → HTTP Egress Control (Squid + blocklists)
    → Kernel Firewall (DOCKER-USER per ingress bridge)
      → SIEM (Wazuh + fluent-bit + container-sync enrichment) → Image Scanning (Trivy)
        → Secrets (Infisical) → AI / Agent Cores (OpenClaw, Hermes, Hermes Platform, Browser Intent)
```

### Image Version Pins

All images are pinned — no `latest` or floating tags anywhere in IronNest. Semver tags are used where the upstream publishes them; SHA256 digests are used where only a floating tag exists.

| Image (compose / built tag) | Dockerfile `FROM` pin | Upstream version | Pin method |
|---|---|---|---|
| `platform/openclaw:2026.4.23-1-codex` | `ghcr.io/openclaw/openclaw:2026.4.23-1-amd64` | 2026.4.23-1 | Calendar semver |
| `platform/hermes-agent:v2026.6.5-patched` | upstream Hermes image (set in `hermes/Dockerfile`) | v0.16.0 (tag `v2026.6.5`, "The Surface Release"; upgraded from v0.15.2 on 2026-06-13) | Calendar semver |
| `platform/infisical-cli:0.43.76-patched` | `infisical/cli@sha256:dba406b3…` | 0.43.76 (binary) | Digest |
| `platform/infisical:pg-36438985-patched` | `infisical/infisical@sha256:36438985…` | unknown (floating upstream) | Digest |
| `platform/postgres:16.13-alpine-patched` | `postgres:16.13-alpine` | PostgreSQL 16.13 | Semver tag |
| `platform/redis:7.4.8-alpine-patched` | `redis:7.4.8-alpine` | Redis 7.4.8 | Semver tag |
| `platform/squid:6.13-patched` | `ubuntu/squid@sha256:6a097f68…` | Squid 6.13 / Ubuntu 24.04 | Digest |
| `platform/blocklist-updater:1.0` | `alpine:3.20` | local | Semver tag (in-house) |
| `platform/monitoring-container-sync:1.0` | `alpine:3.20` (+ curl, jq) | local | Semver tag (in-house) |
| `platform/socket-proxy:0.4.2-patched` | `tecnativa/docker-socket-proxy@sha256:1f3a6f30…` | v0.4.2 | Digest |
| `traefik:v3.3.4` | — (used directly) | v3.3.4 | Semver tag |
| `platform/monitoring-fluent-bit:3.2` | `fluent/fluent-bit:3.2-debug` | Fluent Bit 3.2 | Semver tag (in-house; bakes `fluent-bit.conf`, lua scripts, root-CA) |
| `wazuh/wazuh-manager:4.14.5` | — (used directly) | 4.14.5 | Semver tag |
| `wazuh/wazuh-indexer:4.14.5` | — (used directly) | 4.14.5 | Semver tag |
| `wazuh/wazuh-dashboard:4.14.5` | — (used directly) | 4.14.5 | Semver tag |
| `aquasec/trivy:0.70.0` | — (used directly) | 0.70.0 | Semver tag |
| `adguard/adguardhome:v0.107.74` | — (used directly) | v0.107.74 | Semver tag |
| `amir20/dozzle:v10.6.5` | — (used directly) | v10.6.5 | Semver tag |

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
3. **Per-stack ingress bridges** — non-internal bridges used solely so Docker can publish container ports to Windows loopback. Examples in current use: `openclaw_ingress`, `hermes_ingress`, `hermes-platform_ingress`, `browser-intent_ingress`, `dozzle_ingress`, `wazuh_ingress`, `ingress_traefik_ingress`. These bridges *can* route to the Internet by default, which would be a back-door bypass of Squid; the kernel firewall closes that hole where applicable (see "3-layer egress control" below).

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
  │  OpenClaw / Hermes / Hermes Platform / BrowserIntent ◀┘          │  (blocklist filtering)
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
- `hermes-platform-mem-net` — OpenViking + memory-gateway only; Hermes profile containers do not join it.
- `hermes-platform-app-net` — memory-gateway + `hermes-pf-*` profile containers; the only path from Hermes Platform agents to memory.

### 3-layer egress control

Outbound access is restricted in three independent layers; a service must defeat all three to reach an unintended destination.

| Layer | Mechanism | Where enforced | What it blocks |
|---|---|---|---|
| 1 | DNS filtering | AdGuard at `172.30.0.10` (set as `dns:` on every service) | Resolution of malicious / non-allowlisted domains before TCP. Backed by `blocklist-updater` (Spamhaus DROP/EDROP, Emerging Threats, Feodo) merged into Squid's IP blocklist. |
| 2 | HTTP blocklist | Squid forward proxy at `squid:3128`, set via `HTTP_PROXY` on every service that talks to the web. Allow-by-default with destination IP/domain blocklists (Spamhaus DROP/EDROP, Emerging Threats, Feodo) refreshed every 6 h by `blocklist-updater`; an inotifywait watchdog in the egress-proxy container triggers `squid -k reconfigure` on each update. A `dst_browser_intent` allowlist is defined in `squid.conf` but is not currently referenced in any `http_access` rule — per-stack destination restriction lives in `browser-intent/policies/sites.json` instead. | HTTP/HTTPS to any blocklisted IP or domain. |
| 3 | Kernel firewall | iptables `DOCKER-USER` chain, applied by `ops/fix-openclaw-egress.sh` and `ops/fix-hermes-egress.sh`. | NEW outbound TCP from `openclaw_ingress` and `hermes_ingress` bridges, preventing `curl --noproxy "*"` style direct-Internet bypasses while preserving localhost UI access and Squid-mediated egress. Drops are logged as `IRONNEST_OPENCLAW_EGRESS_DROP` / `IRONNEST_HERMES_EGRESS_DROP` (visible in Wazuh). |

**Verification:** `docker exec <container> curl --noproxy "*" -m 5 https://example.com` should time out from any container behind the kernel firewall. Through Squid, any non-blocklisted destination should succeed and a blocklisted IP/domain should return Squid's `403 Forbidden`.

### Rancher Desktop networking quirks (must-fix on every restart)

The platform runs inside Rancher Desktop's WSL2 distro, which adds three persistent networking issues that `bootstrap.sh` repairs automatically:

1. **DNAT hijack on PREROUTING.** Rancher Desktop injects unrestricted DNAT rules on host-published ports (e.g. `0.0.0.0/0 → 127.0.0.1:8090`). These intercept *intra-bridge* container-to-container TCP and redirect it to the host SSH tunnel, where it dies. `ops/fix-nat-prerouting.sh` inserts an idempotent `iptables -t nat -I PREROUTING 1 -s 172.16.0.0/12 -j RETURN` so traffic from any Docker bridge address bypasses the hijack. **Re-run on every Rancher Desktop restart** — `bootstrap.sh` and each `start.sh` do this automatically. This is also why Infisical is published on **18090**, not 8090: Rancher Desktop intercepts the lower port more aggressively and 18090 sidesteps it.
2. **Stale FDB entries on WSL2 resume.** After hibernate/resume, Docker bridge FDB tables can hold stale veth MACs and cross-container TCP times out (containers ping but TCP hangs). `ops/repair-egress.sh` reconnects affected services (notably Infisical) from `platform-egress` to flush the FDB.
3. **Userspace port forwarder fragility.** Published ports are exported to Windows by `rancher-desktop-guestagent` (an OpenRC service in the `rancher-desktop` WSL distro) via `/services/forwarder/expose`. A flapping container can wedge this agent and silently drop *every* platform port. Recovery is documented in the "All published ports unreachable" runbook below.

---

## Identity Gate (Authelia)

Added 2026-05-27. Sits in front of every `*.ironnest.local` Traefik router and requires a physical FIDO key tap (WebAuthn passkey) before a user gets a session cookie that the backend services accept.

### Threat model it addresses
A remote attacker who has taken over the operator's Windows session (RDP, stolen credentials, RAT) cannot establish a new IronNest session without producing the physical security key. This now holds for **every** route including Wazuh (which moved from a ForwardAuth carve-out to OIDC SSO on 2026-05-28). They still can:
- Use a *currently-active* browser session while its cookie is valid (mitigation: short cookie lifetime).
- `docker exec` into containers — this is a Docker Desktop / Windows-user-permissions issue, not solvable at the web layer.
- Reach the Traefik dashboard via loopback `http://127.0.0.1:8880/dashboard/` — the **only** remaining loopback escape hatch, kept for when Traefik's own routing breaks. (The Wazuh `8443` escape hatch was closed when OIDC went live.)

### Components
- **`authelia`** container (`authelia/authelia:4.39.20`), no host port, on `platform-net`. State in named volume `ingress_authelia-data` (SQLite + registered WebAuthn credentials). Acts as both the ForwardAuth verifier **and** an OpenID Provider (OP) for the Wazuh dashboard.
- **`authelia` middleware** in `security/ingress/conf/routers.yml` — calls `http://authelia:9091/api/authz/forward-auth` for every ForwardAuth-protected route. A coarse **`trusted-networks`** IP-allowlist middleware (RFC1918 + Docker bridge ranges, with `127.0.0.1/32` deliberately omitted) and per-route rate limits (`rate-limit`, `strict-rate-limit`, `spa-rate-limit`) run alongside it. SPA-heavy dashboards (Traefik, Wazuh, Hermes Platform) use the loose `spa-rate-limit`/`rate-limit` so their burst of bundle/asset requests on load doesn't trip a 429.
- **`auth` router** at `https://auth.ironnest.local/` — the login UI **and** OIDC issuer (`https://auth.ironnest.local/.well-known/openid-configuration`). Cannot have the `authelia` ForwardAuth middleware applied to itself, or login becomes impossible.
- **OIDC provider config** (added 2026-05-28) is rendered by the `ingress-infisical-agent` sidecar into the `ingress_oidc-secrets` volume as `oidc-snippet.yml` (HMAC secret + JWKS signing key + the `wazuh` client with its PBKDF2 secret hash). Authelia merges it via `--config=/oidc-secrets/oidc-snippet.yml` on top of `configuration.yml`. Traefik carries a `platform-net` **alias `auth.ironnest.local`** so the Wazuh indexer/dashboard can fetch OIDC discovery + JWKS from inside the Docker network without leaving it. See `security/wazuh/OIDC-ROLLOUT.md`.
- **Config:** `security/ingress/authelia/configuration.yml`. Key settings: `webauthn.enable_passkey_login: true` (passkey is single-factor; no password needed once a key is registered), `session.cookies[].domain: ironnest.local` (cookie shared across all subdomains for SSO), `inactivity: 1h`, `expiration: 4h`, `remember_me: 0`.
- **Users:** `security/ingress/authelia/users.yml` (gitignored). Argon2id-hashed bootstrap password is the fallback when the FIDO key is lost. Registered passkeys live in the SQLite DB, not this file. The operator's user carries a `groups: ['wazuh-admin']` claim that maps to Wazuh's `all_access` role over OIDC.
- **Secrets:** `security/ingress/authelia/secrets/{session,storage,jwt}.txt` (gitignored). 64-byte random values, mounted read-only into the container and consumed via `*_FILE` env vars. The OIDC HMAC/JWKS/client-secret values live in Infisical (`/wazuh-oidc/*`), not in these files.

### Auth flow
**ForwardAuth routes** (Dozzle, AdGuard, Infisical, OpenClaw, Hermes, Hermes Platform, Mission Control, Wiki, Traefik dashboard, …):
1. Browser → `https://<service>.ironnest.local/`
2. Traefik routes match, then call Authelia ForwardAuth with the request headers + cookie.
3. **No valid cookie:** Authelia 302 → `https://auth.ironnest.local/?rd=...`. User taps FIDO key. Authelia sets `authelia_session` cookie on `.ironnest.local`. Browser re-requests the original URL; Traefik calls ForwardAuth, gets 200, proxies to backend.
4. **Valid cookie:** ForwardAuth returns 200 immediately, request is proxied.

**OIDC route** (Wazuh dashboard only): Traefik does **not** run the ForwardAuth middleware (it would break the SPA). Instead the dashboard's OpenSearch Security plugin redirects unauthenticated users to Authelia's OIDC authorize endpoint; the user taps the FIDO key; Authelia issues an ID token; the dashboard validates it (the indexer fetches Authelia's JWKS over the `platform-net` alias) and establishes its **own** session cookie that gates the SPA's XHR calls — so no 302-to-HTML ever lands mid-session. A valid `.ironnest.local` Authelia session from another route satisfies the OIDC prompt without a second key tap.

### Operator setup (one-time)
1. Hosts file entries (`C:\Windows\System32\drivers\etc\hosts`) for each `*.ironnest.local` name → `127.0.0.1`. Current set: `auth`, `dozzle`, `adguard`, `infisical`, `wazuh`, `openclaw`, `hermes`, `hermes-dashboard`, `hermes-platform`, `hermes-platform-dashboard`, `mission`, `wiki`, `chat`, `traefik`.
2. Trust the self-signed Traefik cert in Windows: `Import-Certificate -FilePath <cert> -CertStoreLocation Cert:\LocalMachine\Root` (elevated). **Required for WebAuthn** — Chrome refuses `navigator.credentials.create()` on any site with TLS errors.
3. Visit `https://auth.ironnest.local/`, log in with username + bootstrap password (in `secrets/bootstrap-password.txt`), navigate to **Settings → Security → WebAuthn Credentials**, click **Add**, retrieve the OTP from `docker exec authelia tail /data/notifications.txt`, then tap your FIDO key. Repeat for any backup authenticator (Windows Hello recommended).
4. Store the bootstrap password in a password manager. It's the recovery path if the FIDO key is lost.

### Quirks
- **Authelia eats the `Authorization: Basic` header.** If a backend uses Basic Auth (like Hermes ttyd did), Authelia tries to authenticate that user against its own user DB and rejects. We disabled ttyd's Basic Auth in `hermes/docker-compose.yml` to resolve this.
- **WebAuthn registration UI is hidden unless some access-control rule requires `two_factor`.** We added a dummy `unused-two-factor.ironnest.local` rule in `configuration.yml` to surface the registration UI; it never matches real traffic.
- **The Wazuh dashboard SPA breaks behind ForwardAuth** — *resolved 2026-05-28 via OIDC SSO.* It fetches `/ui/favicons/manifest.json` without credentials (HTML default for `<link rel="manifest">`), gets a 302 to login, parses HTML as JSON, and crashes. That is why the Wazuh router uses OIDC SSO (the dashboard runs its own OpenID Connect flow against Authelia and holds its own session cookie) rather than the ForwardAuth middleware. See `security/wazuh/OIDC-ROLLOUT.md` and **Identity Gate → Auth flow → OIDC route** above. Re-adding ForwardAuth as redundant defence-in-depth is possible (rollout playbook Phase 6) but not currently enabled.
- **Email-OTP for credential management.** Authelia requires a one-time code to register/remove WebAuthn credentials. No SMTP is configured, so the code is written to `/data/notifications.txt` inside the container — retrieve via `docker exec authelia tail /data/notifications.txt`. SMTP via Gmail App Password is a future improvement.
- **Rate limit on OTP generation.** Repeated failed attempts trigger Authelia's built-in throttle with delays up to ~8 min. Recover by `docker restart authelia` (in-memory counter, not persisted).
- **Incognito mode blocks WebAuthn registration** (Chrome behavior). Use a normal window for first-time enrollment; incognito works for subsequent logins.

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
| wazuh-infisical-agent | 0.25 | 64 MB |
| Trivy server | 0.5 | 512 MB |
| Traefik | 0.5 | 128 MB |
| Authelia | 0.5 | 256 MB |
| ingress-infisical-agent | 0.25 | 64 MB |
| monitoring-fluent-bit | 0.5 | 128 MB |
| monitoring-container-sync | 0.1 | 32 MB |
| wazuh-query-broker | not declared | not declared |
| OpenClaw gateway | 4.0 | 4 GB |
| openclaw-ttyd | 0.5 | 1 GB |
| openclaw-infisical-agent | 0.25 | 64 MB |
| hermes-platform-openviking-infisical-agent | 0.25 | 64 MB |
| hermes-platform-ollama | 5.0 | 2 GB |
| hermes-platform-openviking | 2.0 | 2 GB |
| hermes-platform-memory-gateway | 1.0 | 512 MB |
| hermes-platform-ttyd | 0.5 | 512 MB |
| hermes-pf-default | 2.0 | 768 MB |
| hermes-pf-mark | 2.0 | 768 MB |
| hermes-pf-steve | 2.0 | 768 MB |
| hermes-pf-qa | 2.0 | 768 MB |
| hermes-pf-littlejohn | 2.0 | 768 MB |
| hermes-pf-jaime | 2.0 | 768 MB |
| hermes-pf-bigbert | 2.0 | 768 MB |
| hermes-pf-octo | 2.0 | 768 MB |
| hermes-platform-mission-control | 0.5 | 128 MB |
| hermes-platform-operations-runner | not declared | not declared |
| hermes-platform-artifact-apps | 0.5 | 64 MB |
| Browser Intent MCP | 0.5 | 256 MB |
| Browser Intent worker | 2.0 | 2 GB |
| browser-intent-infisical-agent | 0.25 | 64 MB |

**Total declared memory budget:** ~8.7 GB for the 18 always-on bootstrap containers with limits. Add ~18.7 GB when all limited on-demand containers run (OpenClaw ~5.06 GB / 3, Hermes Platform ~11.3 GB / 15 limited containers, Browser Intent ~2.31 GB / 3) for ~27.4 GB across the 39 currently limited regular containers. Two live support/control containers (`wazuh-query-broker` and `hermes-platform-operations-runner`) do not currently declare Compose resource limits, so the regular 41-container deployment is not fully budgeted until those limits are added. Hermes Platform's declared budget is ~11.3 GB across its limited containers because the eight `hermes-pf-*` (incl. `octo`, added 2026-06-12) were bumped from 0.5 CPU / 512 MB to **2.0 CPU / 768 MB** and Ollama from 2.0 to **5.0 CPU** during the Mission Control chat-latency work (2026-06-07; CPU starvation was the real throttle on warm agent turns), plus the 128 MB Mission Control container and the 64 MB artifact app server. Note: as of 2026-06-13 Ollama runs embeddings on the host **GTX 1650 GPU** (WSL2 passthrough), so its 5.0 CPU ceiling is now largely idle — embeddings fell from ~20–31 s to ~1 s.

---

## Key Integration Points

| Consumer | Provider | Transport |
|----------|----------|-----------|
| All containers | AdGuard | DNS `172.30.0.10` |
| HTTP clients | Squid | `HTTP_PROXY=http://squid:3128` (blocklist filtering; see Egress Filtering section) |
| Dozzle | socket-proxy | `DOCKER_HOST=tcp://socket-proxy:2375` (read-only) |
| Wazuh manager | socket-proxy | `DOCKER_HOST=tcp://socket-proxy:2375` (read-only) |
| Trivy scanner | socket-proxy | `DOCKER_HOST=tcp://socket-proxy:2375` (read-only) |
| `monitoring-container-sync` | socket-proxy | `GET /containers/json` every 60 s; writes `/lookups/containers.tsv` |
| `monitoring-fluent-bit` | All container stdouts/stderrs + `containers.tsv` | Tails `/var/lib/docker/containers/*.log`, enriches via lua filter, ships to `wazuh.indexer` (`ironnest-containers-*`) |
| Profile agents | `wazuh-query` | Read-only SIEM query API on `platform-net`; token-gated broker in front of Wazuh indexer/API |
| Mission Control | `hermes-platform-operations-runner` | Token-gated approval execution on `mission-control-ops-net`; lifecycle/factory actions only |
| `*-infisical-agent` sidecars (OpenClaw, Browser Intent on `platform-net`; Ingress, Wazuh on `platform-egress`) | Infisical | `http://infisical:8090` (Universal Auth, polled every 60 s; Ingress renders the OIDC snippet, Wazuh renders the OIDC client secret) |
| `hermes-platform-ttyd`, `hermes-pf-*`, `memory-gateway` | Infisical | `/usr/local/bin/with-infisical` injects per-profile and gateway tokens from `/hermes-platform/*` paths |
| `hermes-pf-*` | `hermes-platform-memory-gateway` | Internal HTTP on `hermes-platform-app-net`; bearer token from Infisical |
| `hermes-platform-mission-control` | `hermes-pf-*` agent-chat bridge | Internal HTTP on `platform-net` to `hermes-pf-<profile>:8011`; bearer `MISSION_CONTROL_BRIDGE_TOKEN`; proxies chat (SSE) + agent-file downloads |
| `hermes-platform-memory-gateway` | `hermes-platform-openviking` | Internal HTTP on `hermes-platform-mem-net`; gateway is the only policy-approved path to OpenViking |
| `hermes-platform-openviking` | `hermes-platform-ollama` | Internal embedding calls on `hermes-platform-mem-net`; no host-published OpenViking port |
| Infisical | Gmail | SMTP `smtp.gmail.com:587` via `platform-egress` |
| Wazuh manager / indexer | CVE / threat feeds | HTTPS via `platform-egress` |
| Trivy server | CVE registries | HTTPS via Squid |
| `blocklist-updater` | Spamhaus / ET / Feodo feeds | HTTPS via `platform-egress` (writes to shared volume read by Squid) |
| Traefik | Public Internet | Inbound HTTPS on `0.0.0.0:443` with TLS termination via stored cert in `ingress_traefik-certs` |
| Host Windows Wazuh agent | Wazuh manager | TCP `127.0.0.1:1514/1515` |
| `wazuh.indexer` healthcheck | itself | `curl -sk -u admin:$WAZUH_INDEXER_PASSWORD https://localhost:9200/` → 200 (not 401) |
| `openclaw-gateway` (`openai` provider) | api.openai.com | HTTPS via Squid; key from Infisical |
| `openclaw-gateway` (`codex` provider) | chatgpt.com/backend-api/v1 | HTTPS via Squid; manual JWT refresh |
| `openclaw-ttyd` / `hermes-platform-ttyd` | browser (Windows host, via Traefik) | Authelia FIDO gate is the sole auth; ttyd's own `--credential` Basic Auth is **disabled** (Authelia consumes the `Authorization` header, which would 401 the Basic creds — FIDO is stronger anyway). `hermes-platform-ttyd` additionally allows iframe embedding by Mission Control via the `frame-mission` middleware. |
| `openclaw_ingress` direct egress | DOCKER-USER firewall | NEW outbound TCP dropped by `ops/fix-openclaw-egress.sh` |
| `hermes-pf-*` (per-profile gateways) | Telegram Bot API | HTTPS via Squid (`.telegram.org` allowlisted, CONNECT-only); one bot per profile token |
| `hermes-pf-*` cron automations (e.g. daily-readings) | usccb.org | HTTPS via Squid (`.usccb.org` allowlisted) |
| `openclaw-gateway` | `browser-intent-mcp` | Internal MCP/HTTP on `platform-net`; the MCP also publishes `127.0.0.1:18901` for host-only access |
| `browser-intent-mcp` | `browser-intent-worker` | Internal HTTP on `browser-internal` bridge |
| `browser-intent-worker` | Allowlisted portals | Static source IP `172.30.0.30`; HTTPS via Squid plus in-browser domain enforcement; returns sanitized JSON only |
| Published ports → Windows | `rancher-desktop-guestagent` | Userspace forwarder writes Windows-side listener via `host-switch.exe`; not iptables-DNAT |

---

## Egress Filtering (Squid)

Live source: `security/egress-proxy/squid.conf`. The current policy is **allow-by-default with destination blocklists** — not per-stack allowlists. `platform_clients` (all RFC1918 source addresses) are allowed to reach any destination not on a blocklist:

- `malicious_dst` — IPs from Spamhaus DROP/EDROP, Feodo Tracker
- `malicious_dstdomain` — domains from Emerging Threats and merged feeds

Both files are written by `blocklist-updater` every 6 h; an inotifywait watchdog inside the egress-proxy container triggers `squid -k reconfigure` automatically when either file changes.

A per-stack `dst_browser_intent` ACL is defined in `squid.conf` (`.colfinancial.com`, `.maxihealth.com.ph`, `.april.fr`, `.hi-precision.com.ph`) but is **not currently referenced** in any `http_access` rule. Per-stack destination restriction for Browser Intent is enforced at the Playwright layer instead — see `browser-intent/policies/sites.json` `allowedDomains` per site, which includes `*.healthonlineasia.com` for the Hi-Precision results host. Re-enabling Squid-level per-stack allowlisting requires wiring `dst_browser_intent` (and new equivalent ACLs for other stacks) into a deny-by-default rule above `http_access allow platform_clients`.

The table below lists the destinations each stack actually uses today (useful for blocklist exemption review and future re-tightening); these are not destinations enforced exclusively at the Squid layer.

| Consumer | Destinations used |
|----------|---------------------|
| OpenClaw / Hermes | `.anthropic.com`, `.openai.com`, `.chatgpt.com`, `.cohere.ai`, `.mistral.ai`, `.deepseek.com`, `registry.npmjs.org` |
| Hermes daily-readings cron | `.usccb.org` |
| Telegram (Hermes messaging) | `.telegram.org` (CONNECT only) |
| Browser Intent (src `172.30.0.30`) | `.colfinancial.com`, `.maxihealth.com.ph`, `.april.fr`, `.hi-precision.com.ph`, `.healthonlineasia.com` (Hi-Precision results host) |
| Wazuh | `.wazuh.com`, `.cve.mitre.org`, `.nvd.nist.gov`, `.github.com` |
| Trivy | `ghcr.io`, `.githubusercontent.com`, `aquasecurity.github.io`, `.aquasec.com`, `mirror.gcr.io`, `storage.googleapis.com`, `.docker.io`, `production.cloudflare.docker.com` |
| AdGuard | `.quad9.net`, `.cloudflare-dns.com`, `dns.google` |

Blocklisted destinations are denied. Browser Intent's static source IP `172.30.0.30` is still useful for future per-stack ACL re-enablement and for distinguishing its traffic in Squid access logs.

---

## Browser Intent MCP

`browser-intent/` is the on-demand stack for high-risk site automation (financial, insurance, medical portals). It follows the IronNest pattern: localhost-only ingress, Infisical sidecar secret injection, AdGuard DNS, Squid egress allowlisting, dropped Linux capabilities, `no-new-privileges`, and a static source IP (`172.30.0.30`) for per-stack Squid ACL isolation.

The AI-facing surface is `browser-intent-mcp`, never the worker. It exposes named intent tools only — no raw browser controls, no DOM access, no JavaScript eval, no arbitrary navigation, no Infisical reads.

Each action is exposed as a single tool that takes a `site` argument. The per-tool `site` enum is derived from `policies/sites.json`: only sites whose `allowedTools` list the action appear in the enum, so disallowed `(site, action)` combinations are rejected at the MCP schema layer.

**Session tools:**
```
login           { site }
logout          { site }
check_session   { site }
provide_otp     { site, code }        — only enum site is maxicare
list_browser_intent_sites             — no args
```

**Post-login data tools (gated):**
```
get_portfolio        { site }                      — holdings + totals (col_financial)
get_account_info     { site }                      — maxicare, april_international
get_policy_summary   { site }                      — maxicare
get_policy_info      { site }                      — april_international
get_claims_history   { site }                      — april_international
get_claim_status     { site, claim_id }            — april_international
get_documents_list   { site }                      — april_international
submit_claim         { site, treatment_date, ... } — april_international (WRITE; dry_run=true by default)
```

**Diagnostic tools (maintainer-only, off by default):** `diagnose_login_form`, `diagnose_member_portal`, `diagnose_portfolio`, `diagnose_claim_form`. Set `BROWSER_INTENT_ENABLE_DIAGNOSTICS=true` on the MCP container to expose them; leave unset in normal operation so the LLM never sees them.

### Security invariants

1. **Credentials never reach the LLM.** Username, password, and `TOTP_SECRET` are rendered into the worker's environment by the Infisical sidecar and used only by Playwright. No tool returns them.
2. **Login/session tools never return post-login data.** They return only `{status, ...}`.
3. **Per-client site scoping (`policies/clients.json`).** Each bearer token maps to a site allowlist. The MCP server intersects every tool's `site` enum with the calling client's `allowedSites`; tools with an empty intersection are dropped from `tools/list`, and a `tools/call` for a non-allowed site is rejected at the dispatcher. Hermes' default profile (Dr. Smith / @DrSmithVBot) is scoped to April International only; the `admin` client (existing `BROWSER_INTENT_MCP_TOKEN`) keeps full access for ops scripts. Clients whose `tokenEnvVar` is unset are silently skipped, so adding an entry without provisioning the secret is a no-op.
4. **Post-login data tools** are explicit, allowlisted opt-ins:
   - Each new action must appear in `policies/sites.json` under the site's `allowedTools` array.
   - Session is required: if the worker has no logged-in session for the site, the call returns `{status: "session_expired"}` so the LLM is forced to call `login` (with the same `site`) first.
   - Returns only the documented JSON shape — no raw HTML, cookies, screenshots, or unparsed DOM.
   - Each call is audit-logged with `returned_sensitive_data: true`.
   - If the page DOM has drifted and the extractor cannot locate its target, the worker returns `{status: "needs_extractor_update"}` rather than guessing.

### Extractor module layout

`browser-intent/worker/extractors/<site>.js` exports functions named after the snake_case action (e.g. `getPortfolio`, `diagnosePortfolio`). The MCP server forwards each tool call as `{ site, action, args }` over `/extract`; the worker resolves that to the matching module and method dynamically — adding a new extraction action means dropping a new file and listing the action in `policies/sites.json` and `ACTIONS` in `mcp-server/server.js`. The `site` enum on the tool is derived automatically from `allowedTools`, so listing the action under a new site is enough to make it callable for that site.

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

## Hermes Stack (legacy — REMOVED 2026-05-31, historical reference)

> **This stack no longer runs.** `hermes/docker-compose.yml` and `start.sh` were deleted 2026-05-31; the `hermes-ttyd` / `hermes-gateway*` containers below are **not present in the live config** (`docker ps` confirms none are running). [**Hermes Platform**](#hermes-platform-stack) is the sole agent stack today. This section is retained because (a) the `hermes/` directory still serves as the build context for the shared `platform/hermes-agent` image, so the **Build / start split** and **s6-overlay init** notes below still apply to that build, and (b) it documents the per-profile-Telegram-bot rationale that Hermes Platform inherited. Treat all container/port/route references in this section as historical.

`hermes/` *was* the second AI/agent core — an on-demand stack that ran a Hermes agent with a Telegram messaging gateway and a TUI dashboard. It followed the IronNest security pattern (localhost-only ingress, AdGuard DNS, Squid egress allowlisting, dropped Linux capabilities, `no-new-privileges`, kernel-firewall on `hermes_ingress`), but used a **different secrets injection pattern from OpenClaw / Browser Intent**.

### Secrets injection — in-process `with-infisical` wrapper

Hermes does **not** run an `infisical-agent` sidecar. Instead, every Hermes service starts via `/usr/local/bin/with-infisical` (see `hermes/with-infisical.sh` + Dockerfile). The wrapper:

1. Logs in to `http://infisical:8090` using the Universal Auth machine identity from `hermes/.env`.
2. `exec`s `infisical run` with the Hermes project / dev environment.
3. Secrets become env vars in the wrapped process and are **never written to disk** — no `secrets-runtime/.env`, no shared volume.

Why differ from OpenClaw? Hermes was prototyping a "secrets only in process memory" model; on a security-restricted laptop, eliminating the rendered `.env` file removes one persistent secret surface. Both patterns coexist; pick per stack.

### Containers

```
┌──────────────────────────────────────────────────────────────────────────┐
│  hermes stack — 6 containers                                              │
│                                                                           │
│  ┌──────────────────┐    ┌──────────────────┐                            │
│  │  hermes-ttyd     │    │  hermes-gateway  │   default profile          │
│  │  TUI :7682       │    │  @DrSmithVBot    │   Infisical path: /        │
│  │  Dashboard :9119 │    │  (no host port)  │                            │
│  └──────────────────┘    └──────────────────┘                            │
│                                                                           │
│  ┌────────────────────────────┐  ┌──────────────────────────────┐        │
│  │  hermes-gateway-wifey      │  │  hermes-gateway-steve         │        │
│  │  @may192007_bot            │  │  @SteveArmstrongBot           │        │
│  │  Infisical path: /wifey    │  │  Infisical path: /steve       │        │
│  └────────────────────────────┘  └──────────────────────────────┘        │
│                                                                           │
│  ┌────────────────────────────┐  ┌──────────────────────────────┐        │
│  │  hermes-gateway-mark       │  │  hermes-gateway-littlejohn    │        │
│  │  @MarkGordonBot            │  │  @LittleJohnArmstrongBot      │        │
│  │  Infisical path: /mark     │  │  Infisical path: /littlejohn  │        │
│  └────────────────────────────┘  └──────────────────────────────┘        │
│                                                                           │
│  All wrapped by /usr/local/bin/with-infisical                             │
│  (creds from hermes/.env, secrets in-process only).                       │
│  All share volume hermes-data (mounted /opt/data) — per-profile state     │
│  lives under /opt/data/profiles/<name>/, each with its own gateway.lock.  │
│  Outbound to Telegram (.telegram.org) routes through Squid CONNECT.       │
└──────────────────────────────────────────────────────────────────────────┘
```

| Container | Role | Host port | Notes |
|---|---|---|---|
| `hermes-ttyd` | TUI terminal + Hermes web dashboard (`hermes dashboard --insecure`) | `127.0.0.1:7682` (TUI), `127.0.0.1:9119` (dashboard/metrics) | Basic Auth via `HERMES_TTYD_USERNAME` / `HERMES_TTYD_PASSWORD` from Infisical |
| `hermes-gateway` | `default` profile gateway — Telegram bot @DrSmithVBot | — (internal-only) | Reachable from other stacks on `platform-net` at `hermes-gateway:<port>`. Loads secrets from Infisical path `/`. |
| `hermes-gateway-wifey` | `wifey` profile gateway — Telegram bot @may192007_bot | — (internal-only) | `INFISICAL_PATH=/wifey`; per-profile bot token overrides `/`, shared keys (OpenRouter, Gemini, …) imported from `/`. |
| `hermes-gateway-steve` | `steve` profile gateway — Telegram bot @SteveArmstrongBot | — (internal-only) | `INFISICAL_PATH=/steve`; same import pattern as `wifey`. |
| `hermes-gateway-mark` | `mark` profile gateway — Telegram bot @MarkGordonBot | — (internal-only) | `INFISICAL_PATH=/mark`; same import pattern. |
| `hermes-gateway-littlejohn` | `littlejohn` profile gateway — Telegram bot @LittleJohnArmstrongBot | — (internal-only) | `INFISICAL_PATH=/littlejohn`; same import pattern. |

**Why 5 gateways, not 1?** Each Telegram bot maintains a long-poll on `getUpdates`; multiple processes hitting the API with the same token cause `Conflict: terminated by other getUpdates request`. Splitting per profile gives each bot its own poller. Lock contention on the shared `hermes-data` volume is avoided because each profile has its own `gateway.lock` under its profile dir.

**Persistent volume:** `hermes_hermes-data` (mounted at `/opt/data` — config, conversation memories, skills, per-profile dirs under `/opt/data/profiles/<name>/`). Backed up nightly.

**Egress allowlist:** Identical to OpenClaw plus `.usccb.org` (daily-readings cron) and `.telegram.org` (CONNECT-only for the bots).

### Container init — s6-overlay (v0.15.0+)

From v0.15.0 (tag `v2026.5.28`) Hermes replaced `tini + gosu` with **s6-overlay 3.2.3.0** as the container init system. Impact on IronNest:

| Before (≤ v0.14.x) | After (v0.15.0+) |
|---|---|
| `ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/opt/hermes/docker/entrypoint.sh"]` | `ENTRYPOINT ["/init", "/opt/hermes/docker/main-wrapper.sh"]` |
| Privilege drop via `gosu hermes` in `entrypoint.sh` | Privilege drop via `s6-setuidgid hermes` in `main-wrapper.sh` |
| UID remap + chown in `entrypoint.sh` | UID remap + chown in `docker/stage2-hook.sh`, wired as `/etc/cont-init.d/01-hermes-setup` |
| `hermes-platform` overrode entrypoint: `["/usr/bin/tini", "-g", "--", "sh", "/opt/ironnest/hermes-profile-entrypoint.sh"]` | `hermes-platform` drops the entrypoint override; default `/init + main-wrapper.sh` is used |
| Node.js 20 (from Debian trixie apt) | Node.js 22 LTS (copied from `node:22-bookworm-slim` source stage — Node 20 EOL April 2026) |

`docker/entrypoint.sh` is now a **deprecated shim** — if a compose file sets `entrypoint:` to it, s6 bootstrap still runs but the CMD is **not exec'd**, causing exit 127. All IronNest entrypoint overrides have been removed. The `with-infisical` wrapper passes through `main-wrapper.sh` as the first CMD arg and is exec'd under `s6-setuidgid hermes` — secrets injection continues to work unchanged.

**IronNest-specific s6 adaptations** (required for one-container-per-gateway architecture):

| Upstream feature | IronNest decision | Reason |
|---|---|---|
| `docker/s6-rc.d/` (main-hermes + dashboard s6 services) | **NOT copied** into image | s6 would auto-start `hermes gateway run` WITHOUT Infisical secrets → duplicate gateway + "No messaging platforms" warning |
| `02-reconcile-profiles` cont-init.d | **NOT installed** | Calls `container_boot.py` which creates s6-log daemons that lock `/opt/data/logs/gateways/<profile>/lock` — all 6 legacy-stack containers share the same volume, causing perpetual lock conflicts |
| `015-supervise-perms` cont-init.d | **NOT installed** | Companion to reconcile-profiles; no supervised services means no supervise/ trees to chown |
| `HERMES_GATEWAY_NO_SUPERVISE=1` | **Set on all gateway containers** | In v0.15.0+, `hermes gateway run` signals s6 and exits immediately by default. This flag restores foreground (Docker-friendly) behavior |
| `active_profile` in shared legacy volume | **Pinned at startup** in `hermes-gateway` CMD | `active_profile` drifts to the last interactively-used profile; `hermes gateway run` (no -p) would poll the wrong bot and conflict with the per-profile gateway container |

### Build / start split

`hermes/build.sh` and `hermes/start.sh` are deliberately separate:

- **`hermes/build.sh`** runs `docker compose build [--pull]`. Run this manually when the Dockerfile or bundled Hermes source changes (e.g. version bump). The first build is ~20 min — Node/Python/Playwright deps; subsequent builds use the layer cache.
- **`hermes/start.sh`** is fast: it repairs Rancher Desktop NAT, parses the image tag from `docker-compose.yml`, calls `build.sh` only if the image is missing, runs `docker compose up -d --no-build`, applies `fix-hermes-egress.sh`, and waits for healthy. Verified end-to-end at logon in ~20 s warm / ~140 s cold.

Why `--no-build`? Both Hermes services have both `build:` and `image:` in compose. Even on plain `docker compose up -d`, BuildKit walks the build context to decide whether a rebuild is needed — on a WSL2 cold-start under disk-IO pressure this hangs for 5–10+ min. `--no-build` skips that evaluation entirely.

**Direct-egress check:** from inside any Hermes container, `curl --noproxy "*" -m 5 https://example.com` should time out (kernel rule), while `curl https://api.telegram.org` should succeed (Squid allowlist).

---

## Hermes Platform Stack

`hermes-platform/` is the newer multi-profile Hermes runtime and long-term-memory plane. It runs alongside the legacy `hermes/` stack during transition.

### Containers

| Container | Role | Host port | Notes |
|---|---|---|---|
| `hermes-platform-openviking-infisical-agent` | OpenViking secrets sidecar | — | Renders OpenViking config from Infisical path `/hermes-platform/openviking`. |
| `hermes-platform-ollama` | Local embedding model host | — | Runs `mxbai-embed-large` for OpenViking embeddings on the host **NVIDIA GTX 1650 GPU** via WSL2 passthrough (2026-06-13): the service mounts `/dev/dxg` + `/usr/lib/wsl/lib` + `/usr/lib/wsl/drivers` and sets `LD_LIBRARY_PATH=/usr/lib/wsl/lib`. Rancher Desktop has no nvidia runtime so `--gpus` is N/A; **both** the `lib` and `drivers` mounts are required or libcuda enumerates 0 devices and falls back to CPU. Embeddings dropped from ~20–31 s (CPU) to ~1 s. |
| `hermes-platform-openviking` | Long-term memory backend | — | No host port; reachable only from `memory-gateway` on `hermes-platform-mem-net`. |
| `hermes-platform-memory-gateway` | Policy-enforcing memory front door | `127.0.0.1:18080` | Only dual-homed service between profile agents and OpenViking. |
| `hermes-platform-ttyd` | Management terminal + Hermes dashboard | `127.0.0.1:8123`, `127.0.0.1:8124` | Mounts all profile volumes for admin visibility; this is a trusted management plane. |
| `hermes-pf-default` | `default` profile gateway | — | Mounts only `hermes-platform_data-default:/opt/data`. |
| `hermes-pf-mark` | `mark` profile gateway | — | Mounts only `hermes-platform_data-mark:/opt/data`. |
| `hermes-pf-steve` | `steve` profile gateway | — | Mounts only `hermes-platform_data-steve:/opt/data`. |
| `hermes-pf-qa` | `qa` profile gateway (QA/verification) | — | Mounts only `hermes-platform_data-qa:/opt/data`. Renamed from `wifey` 2026-06-14 (volume migrated; Infisical path `/hermes-platform/qa`). |
| `hermes-pf-littlejohn` | `littlejohn` profile gateway | — | Mounts only `hermes-platform_data-littlejohn:/opt/data`. |
| `hermes-pf-jaime` | `jaime` profile gateway | — | Mounts only `hermes-platform_data-jaime:/opt/data`; Telegram is configured through Infisical. |
| `hermes-pf-bigbert` | `bigbert` profile gateway | — | Mounts only `hermes-platform_data-bigbert:/opt/data`; Telegram is configured through Infisical. |
| `hermes-pf-octo` | `octo` profile gateway (platform-ops) | — | Mounts only `hermes-platform_data-octo:/opt/data`; added 2026-06-12, gateway auth and post-provisioning gaps resolved 2026-06-13. |
| `hermes-platform-mission-control` | Ops dashboard (standalone FastAPI) | — | `platform-net` only; reachable via `https://mission.ironnest.local/`. Holds NO secrets; reads registry + audit log read-only. Hardened: `cap_drop: ALL`, `no-new-privileges`, `read_only` rootfs + tmpfs, non-root uid 11002. See **Mission Control** below. |
| `hermes-platform-operations-runner` | Approval-gated operations runner | — | Internal only on `mission-control-ops-net`; reached by Mission Control. It validates bearer auth, single-use approvals, exact container/image/bind allowlists, and persisted execution state before running lifecycle or factory actions. It is the only Hermes Platform service with Docker socket access, mounted read-only, and is not a general Docker API/exec/build proxy. |
| `hermes-platform-artifact-apps` | Sandboxed static webapp artifact server | — | `platform-net` only; reachable via `https://apps.ironnest.local/`. Serves complete generated webapp folders from the Kanban shared artifacts volume read-only on a separate origin with a restrictive CSP, so agent-authored HTML/JS is isolated from Mission Control. |

**Memory isolation:** `hermes-pf-*` containers do not join `hermes-platform-mem-net` and cannot reach OpenViking directly. Every memory request must go through `hermes-platform-memory-gateway`, which authenticates with profile bearer tokens from Infisical and enforces deny-first profile policies.

**Automatic conversational memory:** Each `hermes-pf-*` container mounts the in-process Hermes provider `ironnest_gateway` read-only and selects it as `memory.provider` on every container start. During a conversation, the provider searches private memory before the model answers and persists the completed turn afterward by calling `hermes-platform-memory-gateway`; it does not connect to OpenViking directly. This keeps normal Hermes conversations on the same authenticated, policy-enforced, audited memory path as explicit memory operations.

**Profile isolation:** Runtime profile containers mount only their own Docker data volume at `/opt/data`. `hermes-platform-ttyd` intentionally mounts all profile volumes under `/opt/data/profiles/<profile>` so the Hermes dashboard can list/manage them; treat it as admin-only. Dynamic profiles are provisioned by `scripts/provision-profile.sh`, which creates a `services.d/hermes-pf-<name>.yml` Compose fragment; `hermes-platform/start.sh` includes those fragments automatically.

**Shared artifact exchange (scoped exception to data isolation):** Separate from the audited gateway/OpenViking memory path, every `hermes-pf-*` also mounts a host-bind tree at `/opt/shared` for cross-agent binary/file handoff — its own slice read-write at `/opt/shared/mine` and the whole tree read-only at `/opt/shared/all` (write-own / read-all). The tree is host-visible at `D:\claude-workspace\platform\hermes-platform\shared\`. This channel is **not** audited and exists only because OpenViking cannot hold binaries; `/opt/data` and OpenViking isolation are unaffected. See `hermes-platform/docs/08-SECURITY-MODEL.md §"Shared artifact exchange"` and decision D-013.

**Profile-owned automations:** legacy shared-volume automations have been migrated into isolated Hermes Platform profiles. `hermes-pf-mark` owns the Merx trading-bot scripts, Merx repo, and cron jobs (`start-merx-daily-0845-manila`, `check-merx-health-0855-manila`, `merx-heartbeat-hourly-market-hours-manila`, `stop-merx-market-close-1520-manila`). `hermes-pf-littlejohn` owns the CVE watch scripts, acknowledgement helper, copied CVE state, and watcher cron jobs (`cve-watch-infra-os`, `cve-watch-web-facing`, `cve-watch-package-supply-chain`). The legacy `hermes_hermes-data` copies remain archival/reference only.

**Legacy transition note:** `hermes-ttyd` on `127.0.0.1:7682/9119` reads the old shared `hermes_hermes-data` volume. The new platform UI is `127.0.0.1:8123/8124`.

### Mission Control (ops dashboard, added 2026-06-07)

`hermes-platform-mission-control` is a **standalone** least-privilege ops dashboard (image `platform/hermes-platform-mission-control:0.1.0`, built from `hermes-platform/mission-control/`). It is deliberately **decoupled from the memory-gateway policy kernel** (an earlier iteration baked it into the gateway image and was reverted) so the security-critical kernel stays small. It holds **no** OpenViking key, profile tokens, or Infisical creds.

- **Data sources (read-only, no gateway API calls):** the profile registry (`registry/profiles-registry.yaml`, `:ro`), the gateway audit log (`memory-gateway-log` volume, `:ro`), the policies dir (`:ro`, only to compute `policy_loaded`), plus its own `mission-control-state` volume for tasks/schedules/chat history.
- **Network:** `platform-net` for Traefik routing plus `mission-control-ops-net` for the private operations-runner path. Route `mission` → `http://mission-control:8080`, middlewares `[trusted-networks, rate-limit, authelia]` — behind the same FIDO gate as every other route.
- **Agent chat + file downloads** are served by a tiny **in-container agent-chat bridge** (`agent-bridge/agent-chat-bridge.py`, Python stdlib, no deps), bind-mounted read-only into **each** `hermes-pf-*` and launched as a background co-process before `hermes gateway run`. It listens on `:8011` (token-gated by `MISSION_CONTROL_BRIDGE_TOKEN`) and drives a persistent `hermes acp` (Agent Client Protocol) session **for its own profile only** — no Docker socket, no cross-profile access, per-profile isolation preserved. Mission Control proxies chat over `POST /api/agent/{profile}/chat[/stream]` (SSE token streaming) and serves agent-produced files over `GET /api/agent/{profile}/file/{name}` → the bridge's hardened `GET /file` (basename-only, charset-restricted, realpath-prefixed to `/opt/data/.mission-control-uploads`). This is the one egress path for files to leave an agent container to the operator's browser; it stays within `platform-net` and the FIDO gate.
- **Approval-gated operations:** Mission Control can submit approved lifecycle and factory requests to `hermes-platform-operations-runner` over `mission-control-ops-net`. The runner requires its bearer token, consumes each approval only once, checks exact container/image/bind allowlists, persists execution state in `operations-runner-state`, and intentionally excludes arbitrary Docker exec/build/API access. This keeps operator-approved start/stop/restart and bounded factory actions out of the profile agents and memory gateway.
- **Why the `hermes-pf-*`/Ollama resource bumps:** running `hermes acp` alongside `hermes gateway run` in 0.5 CPU starved warm chat turns; the `x-hermes-pf-base` anchor was raised to 2.0 CPU / 768 MB and Ollama to 5.0 CPU. Embeddings were originally CPU-bound (~20–31 s each, gating every memory-backed chat turn); as of **2026-06-13 Ollama offloads `mxbai-embed-large` to the host GTX 1650 GPU** (WSL2 passthrough), cutting embeddings to ~1 s. See **Service Resource Limits** and the Ollama container note above.
- The sidebar **Memory** item is an external link to the LLM Wiki (`https://wiki.ironnest.local`), not an in-app view.

---

## Monitoring & Log Enrichment

`monitoring/` runs two always-on containers that together turn Docker's raw JSON log files into queryable, attributed events in Wazuh.

### Containers

- **`monitoring-fluent-bit`** (`platform/monitoring-fluent-bit:3.2`, built from `monitoring/Dockerfile.fluent-bit` — `FROM fluent/fluent-bit:3.2-debug` with `fluent-bit.conf`, the lua enrichment scripts, and the platform root-CA baked in; pinned at `172.30.0.15`). Tails `/var/lib/docker/containers/*.log`, applies the lua enrichment filter, ships to `wazuh.indexer` under `ironnest-containers-*`.
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
| `platform-autostart` | `ops/autostart.ps1` | At logon (phoenix) | Polls `docker info` up to 180 s (waits out RD cold-boot). Then chains `bash bootstrap.sh && { bash openclaw/start.sh; bash hermes-platform/start.sh; bash browser-intent/start.sh; }`. The brace group with `;` means each listed on-demand stack runs independently — one's failure does not block the next. Legacy `hermes/start.sh` is intentionally excluded so the old `hermes-gateway*` containers do not compete with `hermes-pf-*` for Telegram polling. ExecutionTimeLimit: 1 hr. |

**Why two tasks, not one?** Separation lets each task have its own ExecutionTimeLimit and `LastTaskResult` for diagnosis. RD launch is bounded (30 min); platform bring-up may legitimately take longer (Wazuh + first-time Hermes build).

**Verified end-to-end (2026-05-14):** RD process up at +18 s after logon, Docker responsive at +40 s, all 23 containers healthy and `platform-autostart` exiting `LastTaskResult: 0` at +140 s. Footprint has since grown to 41 regular containers when all runtime stacks are up, plus optional `ironnest-browse`, LLM Wiki, and the Trivy scanner profile; re-time after the next cold boot.

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
| `hermes-data.tar.gz` | Legacy Hermes `/opt/data` (config, memories, skills) |
| `adguard-conf.tar.gz` | AdGuard configuration volume |
| `traefik-certs.tar.gz` | Traefik TLS cert + key (volume `ingress_traefik-certs`) |
| `wazuh-etc.tar.gz` | Wazuh manager `/etc/wazuh` |
| `wazuh-logs.tar.gz` | Wazuh manager logs |
| `wazuh-filebeat-etc.tar.gz` | Filebeat config |
| `wazuh-indexer-data.tar.gz` | OpenSearch index data |
| `wazuh-dashboard-config.tar.gz` | Dashboard configuration |
| `authelia-data.tar.gz` | Authelia SQLite (`db.sqlite3`) — registered WebAuthn/passkey credentials and session storage |
| `platform-config.tar.gz` | All `.env` files, Wazuh TLS certs, compose files, ops scripts |
| `SHA256SUMS` | Checksums for all above artifacts |

**Not backed up (regenerable):** Trivy CVE DB cache, AdGuard work volume, Dozzle state, Squid cache, Infisical Redis cache, blocklist-updater output (re-fetched on schedule), `monitoring-container-sync` TSV lookup (rebuilt every 60 s).

**Current backup gap (2026-05-24):** `ops/backup.sh` still backs up the legacy `hermes_hermes-data` volume only. Add Hermes Platform volumes before relying on backups for the new stack: `hermes-platform_data-*`, `hermes-platform_openviking-workspace`, `hermes-platform_ollama-models`, `hermes-platform_memory-gateway-log`, and `hermes-platform_openviking-secrets-runtime` if runtime-rendered OpenViking config should be captured. Note the shared artifact tree is a **host bind**, not a named volume — `hermes-platform/shared/` is captured by any backup of the stack directory (its runtime artifacts are `.gitignore`d but still on disk).

Retention: **14 days** with automatic pruning. Runbook: `G:\rancher-stack-backups\RECOVERY.txt`. `restore.sh` verifies `SHA256SUMS` before touching any volume.

---

## Known Issues & Recovery Runbooks

### Infisical agent TCP timeout — Rancher Desktop `sshPortForwarder` DNAT hijack

**Symptom:** `openclaw-infisical-agent` (or any sidecar agent) logs `dial tcp <infisical-ip>:8090: i/o timeout`. ICMP (ping) works between containers but TCP connections hang. Affects all published ports (8090, 3000, 18789, 1514/1515, 8888).

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
# For Hermes Platform: bash hermes-platform/start.sh
# Legacy Hermes: bash hermes/start.sh only if hermes-pf-* Telegram pollers are stopped.
```

> `docker compose restart` is insufficient — env_file is loaded at container creation time, not on restart. Always use `--force-recreate` when secrets change.

**The rules reset on every Rancher Desktop restart.** Always run `bootstrap.sh` (or the autostart task) after restarting Rancher Desktop — do not bring individual stacks up with bare `docker compose up -d`.

---

### All published ports unreachable from Windows — guestagent storm from a flapping container

**Symptom:** Every `127.0.0.1:<port>` published by the platform stops responding from the Windows host (browser shows `ERR_CONNECTION_RESET`, `curl` times out). Affects legacy Hermes (7682, 9119), Hermes Platform (8123, 8124, 18080), AdGuard (3000), Infisical (18090), OpenClaw (18789, 7681), Traefik (8880), Dozzle (8888), and 80/443 simultaneously. (The Wazuh dashboard no longer publishes `8443` — it is reached only via Traefik.) Containers themselves report healthy and the in-container service responds when probed via `docker exec`.

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

- **Autostart:** Two Task Scheduler tasks at logon — `rancher-desktop-autostart` (launches RD with dependency gating + 15 s settle) and `platform-autostart` (waits for Docker, then brings up bootstrap + OpenClaw + Hermes Platform + Browser Intent). Legacy Hermes is not included by default because its `hermes-gateway*` containers conflict with `hermes-pf-*` Telegram polling. See **Autostart** above for details. RD's own "Automatically start at login" toggle must be off.
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
| `ops/autostart.ps1` | Wait for Docker, then `bootstrap.sh && { openclaw; hermes-platform; browser-intent }`; legacy Hermes is intentionally excluded to avoid Telegram polling conflicts | Yes | Task Scheduler `platform-autostart` (at logon) |
| `ops/fix-nat-prerouting.sh` | Insert `RETURN` rule shielding `172.16.0.0/12` from Rancher Desktop's PREROUTING DNAT hijack | Yes | After every Rancher Desktop restart (called by `bootstrap.sh` and each `start.sh`) |
| `ops/repair-egress.sh` | Reconnect Infisical from `platform-egress` to flush stale FDB entries | Yes | After WSL2 hibernate/resume; called by `bootstrap.sh` |
| `ops/fix-openclaw-egress.sh` | Insert DOCKER-USER DROP rule on `openclaw_ingress` outbound | Yes | Called by `openclaw/start.sh` |
| `ops/fix-hermes-egress.sh` | Insert DOCKER-USER DROP rule on `hermes_ingress` outbound | Yes | Called by `hermes/start.sh` |
| `ops/ironnest-browse.compose.yml` | Read-only `ironnest-browser` VS Code attach target exposing non-secret operational volumes under `/view`, including all eight Hermes Platform profile volumes (`default`, `mark`, `steve`, `qa`, `littlejohn`, `jaime`, `bigbert`, `octo`) | Yes | Manual diagnostics with `docker compose -f ops/ironnest-browse.compose.yml up -d` |
| `hermes/build.sh` | Build the `platform/hermes-agent` image (`docker build`). Legacy `docker-compose.yml` removed; build.sh now calls `docker build` directly. | Yes | Manual; when Dockerfile or app source changes (e.g. version bump) |
| `hermes-platform/build.sh` | Build Hermes Platform images (`openviking`, `memory-gateway`) | Yes | Manual; first run or when Hermes Platform source changes |
| `hermes-platform/start.sh` | Up Hermes Platform, include `services.d/*.yml` dynamic profile fragments, repair NAT/egress, wait for OpenViking, memory-gateway, and `hermes-pf-*` healthy | Yes | Manual or via `platform-autostart` |
| `openclaw/start.sh` | Up OpenClaw, repair egress, register provider auth from injected env | Yes | Manual or via `platform-autostart` |
| `browser-intent/start.sh` | Up Browser Intent, repair egress, wait for MCP healthy | Yes | Manual or via `platform-autostart` |
| `ops/backup.sh` | Daily volume snapshots → `G:\rancher-stack-backups\` | n/a | Task Scheduler `rancher-stack-backup` (daily) |
| `ops/restore.sh` | Verify SHA256SUMS and restore selected volumes | n/a | Manual recovery; see `RECOVERY.txt` |
| `ops/status.sh` | Snapshot of stack health, listening ports, egress reachability | Yes | Ad-hoc diagnostics |
