# IronNest Architecture

## Overview

**IronNest** is a security-hardened, modular 19-container platform running on Rancher Desktop (WSL2/Windows 11). It hosts AI application workloads (OpenClaw and Hermes Agent) surrounded by a layered security perimeter: ingress proxy, secrets management, DNS filtering, HTTP egress control, SIEM monitoring, image scanning, and observability — each in its own isolated Compose project.

**Platform root:** `D:\claude-workspace\platform\`  
**Docker storage:** `F:\wsl\rancher-desktop-data\ext4.vhdx`  
**Backup target:** `G:\rancher-stack-backups\`

---

## Design Principles

### 1. Blast-radius isolation
Each capability lives in its own Compose project. Restarting or resetting one stack cannot affect others. OpenClaw has zero Docker socket access and zero lifecycle control over any other container.

### 2. Least privilege everywhere
- All containers drop capabilities they don't need; most use `cap_drop: ALL`.
- Filesystem mounts are read-only except where writes are strictly required (tmpfs for ephemeral scratch).
- `no-new-privileges: true` on every service that accepts it.
- Healthchecks use proper credentials where the service requires auth (e.g. wazuh.indexer passes `WAZUH_INDEXER_PASSWORD` and asserts HTTP 200, not 401). Accepting 401 as healthy masks auth misconfiguration.

### 3. Zero raw socket access
No container mounts `/var/run/docker.sock` directly. All Docker API consumers (Dozzle, Wazuh, Trivy) talk to the `socket-proxy` service, which exposes only read-only endpoints (CONTAINERS, EVENTS, IMAGES, INFO, NETWORKS, PING, VERSION, VOLUMES). All write/exec/build operations are blocked.

### 4. DNS-first filtering
Every service sets `dns: 172.30.0.10` (AdGuard). DNS-layer blocking is the first line of defence against malicious domain resolution before any TCP connection is attempted.

### 5. Allowlist-only HTTP egress
Outbound HTTP/HTTPS is routed through Squid (`HTTP_PROXY=http://squid:3128`). Squid enforces a hostname allowlist — destinations not explicitly named are denied. Raw TCP (SMTP, threat feeds) bypasses Squid but is restricted to `platform-egress` network members only.

OpenClaw and Hermes each have an extra non-internal ingress bridge solely so Docker can publish localhost-only ports to Windows. Because those bridges can create default routes, their start scripts run `ops/fix-openclaw-egress.sh` and `ops/fix-hermes-egress.sh` after startup. These scripts insert idempotent `DOCKER-USER` rules that allow intra-bridge traffic, log direct-egress attempts with prefixes such as `IRONNEST_OPENCLAW_EGRESS_DROP` / `IRONNEST_HERMES_EGRESS_DROP`, then drop NEW outbound connections initiated from the workload ingress bridges. This prevents `curl --noproxy`-style direct internet bypasses while preserving localhost UI access and Squid-mediated egress.

### 6. Network segmentation by trust level
- `platform-net` (internal) — inter-service comms, no internet exit.
- `platform-egress` — internet-capable, only for services that genuinely need raw TCP.
- Stack-private `ingress` bridges — used solely for localhost port publishing; keeps internal networks from leaking host-facing ports to the wrong services. OpenClaw and Hermes ingress bridges are additionally blocked from initiating direct outbound internet traffic by `DOCKER-USER` firewall rules.
- Stack-private internal networks (e.g. `secrets-internal`, `wazuh-internal`) — database/index tiers that should never be reachable from other stacks.

### 7. Secrets out of images and out of git
Per-stack `.env` files hold credentials. All `.env` files are gitignored; only `.env.example` templates are tracked. Infisical is the runtime secrets manager for application secrets injection via an **Infisical Agent sidecar** (`infisical/cli:latest`) that authenticates with Universal Auth, polls every 60 s, and renders secrets into `openclaw/secrets-runtime/.env` via a Jinja2 template. The gateway loads this file via `env_file` (`required: false`) so it starts even if secrets are temporarily unavailable.

### 8. Modular startup order
`bootstrap.sh` brings stacks up in hard-wired dependency order so every service finds its upstream already healthy:

```
socket-proxy → adguard → egress-proxy → secrets → dozzle → wazuh → trivy → ingress → openclaw
```

OpenClaw is last because it depends on DNS (AdGuard), HTTP proxy (Squid), and optionally Infisical — all of which must be ready first.

Use `openclaw/start.sh` instead of bare `docker compose up -d` for OpenClaw. It repairs Rancher Desktop NAT, verifies `platform-egress` routing, starts the stack, applies the `openclaw_ingress` direct-egress firewall rule, registers injected API keys, and verifies that direct no-proxy egress is blocked.

Hermes is also on-demand and is intentionally not added to `bootstrap.sh`. Use `hermes/start.sh` instead of bare `docker compose up -d`; it repairs Rancher Desktop NAT, starts/builds the Hermes Agent image, applies the `hermes_ingress` direct-egress firewall rule, and verifies direct no-proxy egress is blocked.

### 9. Backup completeness and verifiability
Every backup run produces a `SHA256SUMS` file. `restore.sh` verifies checksums before touching anything. Fourteen-day retention with automatic pruning.

### 10. Resource limits on everything
Every service has explicit `cpus` and `memory` limits. This prevents a runaway container from starving the WSL2 VM and degrading Rancher Desktop.

---

## Stack Inventory

| Stack | Path | Lifecycle | Host UI |
|-------|------|-----------|---------|
| socket-proxy | `security/socket-proxy/` | always-on | — |
| adguard | `security/adguard/` | always-on | 127.0.0.1:3000 |
| egress-proxy | `security/egress-proxy/` | always-on | — |
| secrets (Infisical) | `secrets/` | always-on | 127.0.0.1:8090 |
| dozzle | `observability/dozzle/` | always-on | 127.0.0.1:8888 |
| wazuh | `security/wazuh/` | always-on | 127.0.0.1:8443 |
| trivy | `security/trivy/` | always-on (server) / on-demand (scanner) | — |
| ingress | `security/ingress/` | always-on | 127.0.0.1:8880 (dashboard) |
| openclaw | `openclaw/` | on-demand | 127.0.0.1:18789, 127.0.0.1:7681 (ttyd) |
| hermes | `hermes/` | on-demand | 127.0.0.1:7682 (ttyd) |

---

## Container Profile

All 19 containers across 10 stacks, as reported by `docker ps` when OpenClaw and Hermes are both running.

| Container | Role | Stack | Image | Host Port |
|-----------|------|-------|-------|-----------|
| `traefik` | Reverse proxy / ingress | ingress | `traefik:v3.3.4` | `0.0.0.0:80/443`, `127.0.0.1:8880` |
| `ingress-filebeat` | Ships Traefik access logs → Wazuh | ingress | `platform/ingress-filebeat:2026.4.25-1` | — |
| `openclaw-gateway` | AI app workload | openclaw | `platform/openclaw:2026.4.22-1-codex` | `127.0.0.1:18789` |
| `openclaw-ttyd` | Browser terminal sidecar | openclaw | `platform/openclaw:2026.4.22-1-codex` | `127.0.0.1:7681` |
| `openclaw-infisical-agent` | Secrets sidecar | openclaw | `platform/infisical-cli:0.43.76-patched` | — |
| `hermes-ttyd` | Hermes Agent browser terminal | hermes | `platform/hermes-agent:v2026.4.23-patched` | `127.0.0.1:7682` |
| `hermes-gateway` | Hermes messaging gateway (Telegram, etc.) | hermes | `platform/hermes-agent:v2026.4.23-patched` | — |
| `hermes-infisical-agent` | Hermes secrets sidecar | hermes | `platform/infisical-cli:0.43.76-patched` | — |
| `infisical` | Secrets manager UI/API | secrets | `platform/infisical:pg-36438985-patched` | `127.0.0.1:18090` |
| `infisical-postgres` | Infisical database | secrets | `platform/postgres:16.13-alpine-patched` | — |
| `infisical-redis` | Infisical cache | secrets | `platform/redis:7.4.8-alpine-patched` | — |
| `wazuh.manager` | SIEM log collection/analysis | wazuh | `wazuh/wazuh-manager:4.14.4` | `127.0.0.1:1514–1515` |
| `wazuh.indexer` | SIEM OpenSearch index | wazuh | `wazuh/wazuh-indexer:4.14.4` | — |
| `wazuh.dashboard` | SIEM dashboard | wazuh | `wazuh/wazuh-dashboard:4.14.4` | `127.0.0.1:8443` |
| `trivy-server` | CVE/image vulnerability scanner | security | `aquasec/trivy:0.70.0` | — |
| `egress-proxy` | HTTP allowlist proxy (Squid) | security | `platform/squid:6.13-patched` | — |
| `adguard` | DNS filter | security | `adguard/adguardhome:v0.107.74` | `127.0.0.1:3000` |
| `socket-proxy` | Read-only Docker socket proxy | security | `platform/socket-proxy:0.4.2-patched` | — |
| `dozzle` | Log viewer | observability | `amir20/dozzle:v10.4.1` | `127.0.0.1:8888` |

**Functional layers (outermost → core):**
```
Ingress Proxy → Socket Isolation → Observability → DNS Filtering → Egress Control → SIEM → Image Scanning → Secrets → AI Core
```

### Image Version Pins

All images are pinned — no `latest` or floating tags anywhere in IronNest. Semver tags are used where the upstream publishes them; SHA256 digests are used where only a floating tag exists.

| Image (compose / built tag) | Dockerfile `FROM` pin | Upstream version | Pin method |
|---|---|---|---|
| `traefik:v3.3.4` | — (used directly) | v3.3.4 | Semver tag |
| `platform/ingress-filebeat:2026.4.25-1` | `elastic/filebeat:8.17.4` | 8.17.4 | Semver tag |
| `ghcr.io/openclaw/openclaw:2026.4.22-1-amd64` | — (external, set via `$OPENCLAW_IMAGE`) | 2026.4.22-1 | Calendar semver |
| `platform/hermes-agent:v2026.4.23-patched` | `debian:13.4` + `NousResearch/hermes-agent` tag `v2026.4.23` | v2026.4.23 | Semver tag + helper digests |
| `platform/infisical-cli:0.43.76-patched` | `infisical/cli@sha256:dba406b3…` | 0.43.76 (binary) | Digest |
| `platform/infisical:pg-36438985-patched` | `infisical/infisical@sha256:36438985…` | unknown (floating upstream) | Digest |
| `platform/postgres:16.13-alpine-patched` | `postgres:16.13-alpine` | PostgreSQL 16.13 | Semver tag |
| `platform/redis:7.4.8-alpine-patched` | `redis:7.4.8-alpine` | Redis 7.4.8 | Semver tag |
| `platform/squid:6.13-patched` | `ubuntu/squid@sha256:6a097f68…` | Squid 6.13 / Ubuntu 24.04 | Digest |
| `platform/socket-proxy:0.4.2-patched` | `tecnativa/docker-socket-proxy@sha256:1f3a6f30…` | v0.4.2 | Digest |
| `wazuh/wazuh-manager:4.14.4` | — (used directly) | 4.14.4 | Semver tag |
| `wazuh/wazuh-indexer:4.14.4` | — (used directly) | 4.14.4 | Semver tag |
| `wazuh/wazuh-dashboard:4.14.4` | — (used directly) | 4.14.4 | Semver tag |
| `aquasec/trivy:0.70.0` | — (used directly) | 0.70.0 | Semver tag |
| `adguard/adguardhome:v0.107.74` | — (used directly) | v0.107.74 | Semver tag |
| `amir20/dozzle:v10.4.1` | — (used directly) | v10.4.1 | Semver tag |

> Digest-pinned images (infisical, squid, socket-proxy) have no upstream semver release tag. On upgrade, pull the new image, record the new digest, and update both the `FROM` line and the compose `image:` tag.

---

### OpenClaw Image Details

| Property | Value |
|----------|-------|
| Registry | GitHub Container Registry (`ghcr.io/openclaw/openclaw`) |
| Versioning | Calendar-based — `YYYY.M.DD-N-<arch>` (e.g. `2026.4.22-1-amd64`) |
| Base image | `node:24-bookworm` (Node.js 24.14.0, Debian Bookworm) |
| Health endpoint | `GET /healthz` → `{"ok":true,"status":"live"}` |
| Platform-net IP | `172.30.0.6` |
| Source | https://github.com/openclaw/openclaw |

---

## Network Architecture

```
                      Internet / Host PC
                              │
                    ┌─────────▼──────────┐
                    │      Traefik        │  0.0.0.0:80  → redirect HTTPS
                    │   (ingress stack)   │  0.0.0.0:443 → routes by Host header
                    │                     │  127.0.0.1:8880 → dashboard
                    │  IP allowlist        │
                    │  Rate limiting       │
                    │  TLS termination     │
                    │  Access log→stdout   │
                    └─────────┬───────────┘
                              │  platform-net
                              ▼
                          ┌─────────────────────────────────────────┐
                          │            platform-net (internal)       │
                          │              172.30.0.0/24               │
                          │                                          │
  ┌───────────┐  dns:     │  ┌──────────┐   ┌──────────────────┐   │
  │ All svcs  │──────────▶│  │ AdGuard  │   │  socket-proxy    │   │
  └───────────┘           │  │172.30.0.10   │  :2375 (r/o)     │   │
                          │  └──────────┘   └──────────────────┘   │
                          │       │                 ▲               │
                          │  ┌────┴─────┐   ┌──────┴──────┐        │
                          │  │  Squid   │   │Dozzle/Wazuh/│        │
                          │  │  :3128   │   │Trivy-scanner│        │
                          │  └────┬─────┘   └─────────────┘        │
                          │       │                                  │
                          └───────┼──────────────────────────────────┘
                                  │
                          ┌───────▼──────────────────────────────────┐
                          │        platform-egress                   │
                          │          172.31.0.0/24                   │
                          │                                          │
                          │  AdGuard (DoH) · Infisical (SMTP)       │
                          │  Wazuh (feeds) · Trivy-server (CVE DB)  │
                          └───────────────────────────────────────────┘
                                          │
                                          ▼
                                      Internet
```

### Stack-private networks (not shown above)
- `secrets-internal` — Postgres + Redis reachable only by Infisical
- `wazuh-internal` — manager + indexer + dashboard mesh; also joined by `ingress-filebeat` to reach `wazuh.indexer:9200`
- `traefik_ingress` — internet-capable bridge for Traefik port publishing (`:80`/`:443`)
- `ingress` bridges on OpenClaw, Dozzle, Wazuh — used only for localhost port publishing
- `openclaw_ingress` — non-internal because Windows port publishing requires it; direct outbound NEW connections from its Linux bridge are logged and dropped by `ops/fix-openclaw-egress.sh`
- `hermes_ingress` — non-internal because Windows port publishing requires it; direct outbound NEW connections from its Linux bridge are logged and dropped by `ops/fix-hermes-egress.sh`

---

## Service Resource Limits

| Service | CPUs | Memory |
|---------|------|--------|
| Traefik | 0.5 | 128 MB |
| ingress-filebeat | 0.25 | 128 MB |
| Postgres | 1.0 | 512 MB |
| Redis | 0.5 | 256 MB |
| Infisical | 2.0 | 1 GB |
| OpenClaw gateway | 4.0 | 4 GB |
| openclaw-ttyd | 0.50 | 1 GB |
| hermes-ttyd | 2.0 | 2 GB |
| hermes-gateway | 0.50 | 512 MB |
| hermes-infisical-agent | 0.25 | 64 MB |
| AdGuard | 0.5 | 256 MB |
| socket-proxy | 0.25 | 64 MB |
| Squid | 0.5 | 256 MB |
| Trivy server | 0.5 | 512 MB |
| Dozzle | 0.5 | 128 MB |
| Wazuh manager | 2.0 | 2 GB |
| Wazuh indexer | 2.0 | 2 GB |
| Wazuh dashboard | 1.0 | 1 GB |

---

## Key Integration Points

| Consumer | Provider | Transport |
|----------|----------|-----------|
| Browser / internet | Traefik | HTTPS `:443`; HTTP `:80` → redirect |
| Traefik | Backend services | HTTP/HTTPS on platform-net by container hostname |
| ingress-filebeat | Traefik | Docker stdout log files (`/var/lib/docker/containers/*/*.log`) |
| ingress-filebeat | wazuh.indexer | HTTPS `wazuh.indexer:9200` on `wazuh-internal`; basic auth + root-ca.pem |
| Dozzle | socket-proxy | `DOCKER_HOST=tcp://socket-proxy:2375` |
| Wazuh manager | socket-proxy | `DOCKER_HOST=tcp://socket-proxy:2375` |
| Trivy scanner | socket-proxy | `DOCKER_HOST=tcp://socket-proxy:2375` |
| infisical-agent (sidecar) | Infisical | `http://infisical:8090` (platform-net) |
| All containers | AdGuard | DNS `172.30.0.10` |
| HTTP clients | Squid | `HTTP_PROXY=http://squid:3128` |
| Infisical | Gmail | SMTP `smtp.gmail.com:587` (platform-egress) |
| Wazuh | CVE/threat feeds | HTTPS (platform-egress) |
| Trivy server | CVE registries | HTTPS via Squid |
| Host Windows agent | Wazuh manager | TCP `127.0.0.1:1514/1515` |
| wazuh.indexer healthcheck | wazuh.indexer | `curl -sk -u admin:$WAZUH_INDEXER_PASSWORD https://localhost:9200/` → 200 |
| openclaw-gateway (`openai` provider) | api.openai.com | HTTPS via Squid — key from Infisical |
| openclaw-gateway (`codex` provider) | chatgpt.com/backend-api/v1 | HTTPS via Squid — JWT token, manual refresh |
| openclaw-gateway direct internet bypass | Docker `DOCKER-USER` firewall | NEW outbound traffic from `openclaw_ingress` is logged with prefix `IRONNEST_OPENCLAW_EGRESS_DROP`, then dropped by `ops/fix-openclaw-egress.sh` |
| openclaw-ttyd | browser (host) | ttyd at `127.0.0.1:7681`; uses HTTP Basic Auth only when `TTYD_USERNAME`/`TTYD_PASSWORD` are present |
| hermes-ttyd | browser (host) | ttyd shell at `127.0.0.1:7682`; `hermes` CLI is on `PATH` and `TERMINAL_ENV=local` |
| hermes-ttyd | OpenRouter / Ollama / NousResearch | HTTPS via Squid — API keys injected from Infisical |
| hermes-ttyd (`openai-codex` provider) | chatgpt.com/backend-api/codex + auth.openai.com | HTTPS via Squid — ChatGPT OAuth tokens stored in `hermes-data` |
| hermes-gateway | Telegram Bot API | HTTPS via Squid — `TELEGRAM_*` values injected from Infisical runtime env, not `/opt/data/.env` |
| hermes-ttyd direct internet bypass | Docker `DOCKER-USER` firewall | NEW outbound traffic from `hermes_ingress` is logged with prefix `IRONNEST_HERMES_EGRESS_DROP`, then dropped by `ops/fix-hermes-egress.sh` |

---

## Egress Allowlist (Squid)

| Consumer | Allowed destinations |
|----------|---------------------|
| OpenClaw | `.anthropic.com`, `.openai.com`, `.chatgpt.com`, `.cohere.ai`, `.mistral.ai`, `registry.npmjs.org` |
| Hermes | `openrouter.ai`, `ollama.com`, `.ollama.ai`, `nousresearch.com`, `.chatgpt.com`, `.openai.com` |
| Wazuh | `.wazuh.com`, `.cve.mitre.org`, `.nvd.nist.gov`, `.github.com`, `packages.wazuh.com` |
| Trivy | `ghcr.io`, `.githubusercontent.com`, `aquasecurity.github.io`, `.aquasec.com`, `mirror.gcr.io`, `storage.googleapis.com`, `*.docker.io`, `production.cloudflare.docker.com` |
| AdGuard | `.quad9.net`, `.cloudflare-dns.com`, `dns.google` |
| Telegram (optional) | `.telegram.org` |

All other destinations: **denied**.

---

## Infisical Agent Sidecar (OpenClaw)

OpenClaw does not receive secrets via environment variables at container creation. Instead, a sidecar container (`infisical-agent`) runs alongside the gateway and injects secrets at runtime:

```
┌─────────────────────────────────────────────────────┐
│  openclaw stack                                      │
│                                                      │
│  ┌──────────────────┐     shared volume              │
│  │  infisical-agent │ ──► secrets-runtime/.env       │
│  │  (cli:latest)    │     (rendered every 60 s)      │
│  └──────────────────┘                                │
│           │                       ▲                  │
│           │ Universal Auth        │ env_file          │
│           ▼                       │ (required:false)  │
│     Infisical :8090         ┌──────────────┐         │
│     (platform-net)          │  openclaw-   │         │
│                             │  gateway     │         │
│                             └──────────────┘         │
└─────────────────────────────────────────────────────┘
```

**Key files:**
- `openclaw/agent-config/agent.yaml` — Universal Auth config; Infisical address `http://infisical:8090`
- `openclaw/agent-config/secrets.tmpl` — Jinja2 template, reads your Infisical project (replace `<YOUR_INFISICAL_PROJECT_ID>` with your actual project UUID) dev env
- `openclaw/agent-config/entrypoint.sh` — writes CLIENT_ID and CLIENT_SECRET to tmpfs, then `exec infisical agent`
- `openclaw/secrets-runtime/.env` — rendered output, never committed

**Startup:** `infisical-agent` must reach `healthy` before `openclaw-gateway` starts (`depends_on: service_healthy`). Health check: file `/secrets/.env` exists (polls 5 s, timeout 120 s).

**Secret rotation:** agent polls every 60 s and rewrites `secrets-runtime/.env`. The gateway only re-reads it on restart — a `docker compose restart openclaw-gateway` applies rotated secrets.

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

**Design:** Uses the same image as `openclaw-gateway` (`platform/openclaw:2026.4.22-1-codex`) — this gives it the `openclaw` CLI binary without a separate installation. The shared `openclaw-home` volume means the CLI reads live gateway state, so `openclaw security audit` reflects the running gateway's configuration.

**Authentication:** ttyd's `--credential` flag enforces HTTP Basic Auth when both `TTYD_USERNAME` and `TTYD_PASSWORD` are present. If either value is missing, the localhost-only terminal starts without the broken empty credential gate.

**Healthcheck:** Uses `CMD` format (not `CMD-SHELL`) calling `curl -so /dev/null http://localhost:7681`. The `-so` flag discards output and accepts any HTTP response including 401, so the healthcheck passes even when auth is enforced.

**Usage:**
```bash
# From browser at http://127.0.0.1:7681 (credentials from Infisical)
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

---

## Hermes Agent Stack

Hermes is an on-demand AI agent workload based on `NousResearch/hermes-agent` tag `v2026.4.23`, with a ttyd browser terminal at `http://127.0.0.1:7682`.

```
┌─────────────────────────────────────────────────────┐
│  hermes stack                                        │
│                                                      │
│  ┌──────────────────┐     shared file render         │
│  │ hermes-infisical │ ──► secrets-runtime/.env       │
│  │ agent            │                               │
│  └──────────────────┘                               │
│           │ Universal Auth                           │
│           ▼                                          │
│     Infisical :8090                                  │
│                                                      │
│  ┌──────────────────┐     named volume               │
│  │   hermes-ttyd    │◄──► hermes-data                │
│  │  ttyd :7682      │     /opt/data                  │
│  └──────────────────┘           ▲                    │
│                                 │                    │
│  ┌──────────────────┐           │                    │
│  │ hermes-gateway   │───────────┘                    │
│  │ Telegram/etc.    │                                │
│  └──────────────────┘                                │
└─────────────────────────────────────────────────────┘
```

**Design:** `hermes-ttyd` opens a shell with `/opt/hermes/.venv/bin` on `PATH`, so the browser terminal can run setup/auth commands (`hermes auth add ...`) and then launch the Hermes TUI with `hermes`. It sets `TERMINAL_ENV=local`, so shell/tool execution happens inside the Hermes container itself. No Docker socket is mounted, and the container does not get host lifecycle control.

**Gateway:** `hermes-gateway` runs `hermes gateway run` as a Compose-managed service for Telegram and other messaging adapters. This keeps messaging alive across ttyd terminal closes and container restarts; do not run a second manual `hermes gateway run` inside ttyd unless the Compose service is stopped.

**Secrets:** Hermes uses its own Infisical project and sidecar. `hermes/agent-config/secrets.tmpl` renders `HERMES_TTYD_USERNAME`, `HERMES_TTYD_PASSWORD`, `OPENROUTER_API_KEY`, and optional `TELEGRAM_*` values into `hermes/secrets-runtime/.env`. `hermes-ttyd` and `hermes-gateway` receive updated rendered values after container recreation because Compose `env_file` values are read at container creation time. `/opt/data/.env` is not the IronNest source of truth for Telegram secrets; check `hermes status` or the runtime environment instead. If `TELEGRAM_HOME_CHANNEL` is absent, the Hermes containers derive it from the single configured `TELEGRAM_ALLOWED_USERS` value at startup, keeping the default direct-chat target out of git.

**Networking:** `hermes-ttyd` joins `platform-net` for AdGuard DNS and Squid proxy access, plus `hermes_ingress` solely for localhost port publishing. `hermes-gateway` joins only `platform-net` and reaches Telegram through Squid. Direct no-proxy internet egress from `hermes_ingress` is logged and dropped by `ops/fix-hermes-egress.sh`; HTTP(S) provider and Telegram calls must go through Squid.

**Provider egress:** Squid allowlists `openrouter.ai`, `ollama.com`, `.ollama.ai`, `nousresearch.com`, `.chatgpt.com`, and `.openai.com` for Hermes. Live verification showed OpenRouter reachable through Squid and direct no-proxy egress blocked.

**ChatGPT Plus / Codex OAuth:** Hermes supports ChatGPT subscription auth through provider id `openai-codex`. This is distinct from the standard OpenAI API-key provider. Run `hermes auth add openai-codex --type oauth` inside the Hermes ttyd terminal and complete the browser/device-code login. Tokens are stored in the persistent `hermes-data` volume, not in git or static `.env` files.

**Startup:**
```bash
bash hermes/start.sh
```

**First-run inside ttyd:**
```bash
hermes setup
hermes claw migrate
```

---

## OpenClaw AI Provider Configuration

OpenClaw supports multiple AI providers. IronNest has two configured: the standard OpenAI API (API-key billed) and the Codex provider (ChatGPT subscription, flat-rate). Both are registered in `auth-profiles.json` on the persistent volume.

### Configured Providers

| Provider ID | Backend | Auth method | Billing | Default model |
|---|---|---|---|---|
| `openai` | `api.openai.com` | API key (`sk-...`) from Infisical | Per token | `openai/gpt-5.4` |
| `codex` | `chatgpt.com/backend-api/v1` | JWT session token (manual) | ChatGPT subscription | `codex/gpt-5.4-pro` ✅ |

> `codex/gpt-5.4-pro` is the active default. Set via `openclaw models set codex/gpt-5.4-pro`.

---

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

---

### OpenAI API Key — automated via Infisical

The `openai` provider key (`OPENAI_API_KEY`) is stored in Infisical → injected into the gateway container env by the Infisical agent sidecar → re-registered into `auth-profiles.json` automatically by `openclaw/start.sh` on every startup. No manual steps required after key rotation.

---

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

**Provider ID notes:**
- Correct: `--provider codex`
- Wrong: `--provider openai-codex` → returns *"No provider plugins found"*
- The display label `· openai-codex` shown in the UI is the API type, not the provider ID

---

### Egress note

The `codex` provider calls `chatgpt.com/backend-api/v1`; Squid explicitly allowlists `.chatgpt.com`. Direct no-proxy internet access from OpenClaw should remain blocked by the `DOCKER-USER` rule on `openclaw_ingress`; verify with:

```bash
docker exec openclaw-gateway curl --noproxy "*" -m 5 -sf https://example.com -o /dev/null \
  && echo "BAD: direct egress reachable" \
  || echo "OK: direct egress blocked"
```

---

## Traefik Ingress Stack

### Overview

`security/ingress/` is the single internet-facing entry point for IronNest. All external traffic — including traffic from the host PC — passes through Traefik before reaching any backend service.

```
security/ingress/
├── docker-compose.yml       # traefik + ingress-filebeat
├── traefik.yml              # static config (entrypoints, access log, ping)
├── conf/
│   ├── routers.yml          # dynamic routing + middleware (hot-watched)
│   └── tls.yml              # TLS cert binding + cipher config
├── filebeat/
│   ├── filebeat.yml         # reads Docker stdout logs → wazuh.indexer
│   └── root-ca.pem          # Wazuh CA baked into image at build time
├── Dockerfile.filebeat      # bakes filebeat.yml + root-ca.pem into image
├── generate-certs.sh        # one-time self-signed cert generator
└── .env.example             # WAZUH_INDEXER_PASSWORD (copy wazuh/.env value)
```

### Routing Rules

Defined in `conf/routers.yml`. Traefik watches this file — **no restart needed** after edits, except on Windows where inotify doesn't propagate through WSL2 bind mounts (`docker restart traefik` required).

| Hostname | Backend | Middlewares |
|---|---|---|
| `adguard.ironnest.local` | `adguard:80` | trusted-networks, strict-rate-limit |
| `infisical.ironnest.local` | `infisical:8090` | rate-limit |
| `dozzle.ironnest.local` | `dozzle:8080` | trusted-networks, strict-rate-limit |
| `wazuh.ironnest.local` | `wazuh.dashboard:5601` | trusted-networks, strict-rate-limit |
| `openclaw.ironnest.local` | `openclaw-gateway:18789` | rate-limit |
| `hermes.ironnest.local` | `hermes-ttyd:7682` | trusted-networks, strict-rate-limit |

### Middlewares

| Middleware | Config | Applied to |
|---|---|---|
| `rate-limit` | 100 req/s avg, burst 50 | Infisical, OpenClaw |
| `strict-rate-limit` | 20 req/s avg, burst 10 | Wazuh, Dozzle, AdGuard |
| `trusted-networks` | RFC1918 + loopback allowlist | Wazuh, Dozzle, AdGuard |

To add a remote IP (VPN, static home IP) to `trusted-networks`, append to `sourceRange` in `conf/routers.yml` then `docker restart traefik`.

### Access Log → Dozzle + Wazuh

Traefik writes JSON access logs to **stdout**. This means:
- **Dozzle** (`127.0.0.1:8888`) shows live traffic by selecting the `traefik` container
- **ingress-filebeat** reads from Docker's captured stdout (`/var/lib/docker/containers/*/*.log`), filters to the `traefik` container, and ships to `wazuh.indexer:9200`
- Wazuh indexes traffic under `traefik-access-YYYY.MM.DD` — create index pattern `traefik-access-*` in Stack Management to query it

Key access log fields: `ClientAddr`, `RequestMethod`, `RequestPath`, `RouterName`, `DownstreamStatus`, `Duration`.

### TLS

Self-signed cert generated by `./generate-certs.sh` into the `ingress_traefik-certs` named volume. The cert covers `ironnest.local` and `*.ironnest.local` (3650-day validity). To replace with Let's Encrypt: see comments at the top of `conf/tls.yml`.

### First-Time Setup

```bash
cd platform/security/ingress
./generate-certs.sh          # creates ingress_traefik-certs volume
cp .env.example .env         # fill in WAZUH_INDEXER_PASSWORD
docker compose up -d
```

---

## Backup Artifacts

Produced by `ops/backup.sh`, stored at `G:\rancher-stack-backups\<YYYY-MM-DD_HHMMSS>\`:

| File | Contents |
|------|----------|
| `postgres.sql.gz` | Infisical Postgres logical dump |
| `openclaw-home.tar.gz` | OpenClaw persistent home volume |
| `adguard-conf.tar.gz` | AdGuard configuration volume |
| `wazuh-etc.tar.gz` | Wazuh manager `/etc/wazuh` |
| `wazuh-logs.tar.gz` | Wazuh manager logs |
| `wazuh-filebeat-etc.tar.gz` | Filebeat config |
| `wazuh-indexer-data.tar.gz` | OpenSearch index data |
| `wazuh-dashboard-config.tar.gz` | Dashboard configuration |
| `platform-config.tar.gz` | All `.env` files, Wazuh TLS certs, compose files, ops scripts |
| `SHA256SUMS` | Checksums for all above artifacts |

**Not backed up (regenerable):** Trivy CVE DB cache, AdGuard work volume, Dozzle state, Squid cache, Infisical Redis cache.

Retention: **14 days**. Runbook: `G:\rancher-stack-backups\RECOVERY.txt`.

---

## Known Issues & Recovery Runbooks

### Infisical agent TCP timeout — Rancher Desktop `sshPortForwarder` DNAT hijack

**Symptom:** `openclaw-infisical-agent` logs `dial tcp <infisical-ip>:8090: i/o timeout`. ICMP (ping) works between containers but TCP connections hang. Affects all published ports (8090, 3000, 18789, 1514/1515, 8443, 8888).

**Root cause:** Rancher Desktop's experimental `sshPortForwarder` feature injects bare DNAT rules into the Docker network namespace's `nat/PREROUTING` chain to enable Windows→container port access via an SSH tunnel. Crucially, these rules have **no source or interface restriction**:

```
DNAT tcp -- * * 0.0.0.0/0  0.0.0.0/0  tcp dpt:8090 to:127.0.0.1:8090
```

This intercepts **all** TCP to the published port — including intra-bridge container-to-container traffic — and redirects it to the loopback SSH tunnel, which drops the connection. ICMP is unaffected because DNAT only matches TCP.

The rules are (re-)added by `sshPortForwarder` after each Rancher Desktop restart or whenever a container's port mapping changes.

**Permanent fix (applied by `bootstrap.sh` and `openclaw/start.sh`):**

`ops/fix-nat-prerouting.sh` inserts a `RETURN` rule at the top of `nat/PREROUTING` that exempts all container-origin traffic from the DNAT rules:

```bash
iptables -t nat -I PREROUTING 1 -s 172.16.0.0/12 -j RETURN
```

Docker containers use addresses in `172.16.0.0/12` (172.16–172.31). The SSH tunnel connects from `127.0.0.1`, which is outside this range, so Windows port publishing continues to work. The script is idempotent — it checks before inserting.

**Manual recovery (if `bootstrap.sh` was not re-run after a restart):**

```bash
cd D:/claude-workspace/platform
bash ops/fix-nat-prerouting.sh
bash ops/repair-egress.sh              # verify routing, restart infisical if needed
cd openclaw && docker compose up -d --force-recreate openclaw-gateway
```

> `docker compose restart` is insufficient — env_file is loaded at container creation time, not on restart. Always use `--force-recreate` when secrets change.

**The rules reset on every Rancher Desktop restart.** Always run `bootstrap.sh` (or `openclaw/start.sh`) after restarting Rancher Desktop — do not bring individual stacks up with bare `docker compose up -d`.

---

## Windows/WSL2 Operational Notes

- **Autostart:** `ops/autostart.ps1` is registered as Task Scheduler task `platform-autostart` (runs at logon, elevated). It polls `docker info` up to 180 s for Rancher Desktop to initialize, then runs `bootstrap.sh && openclaw/start.sh` automatically — no manual bootstrap needed after restart.
- Start Rancher Desktop from Start Menu before any `docker` commands.
- Add binaries to PATH in Git Bash:
  ```bash
  export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"
  ```
- `.wslconfig` has `localhostForwarding=false` — required to prevent `wslrelay.exe` conflicting with `host-switch.exe`. Do not re-enable.
- Git Bash path conversion: use `MSYS_NO_PATHCONV=1` and convert `/c/...` → `C:/...` with a `to_win()` helper when passing bind-mount paths to `docker -v`.
- Wazuh host agent installed at `C:\Program Files (x86)\ossec-agent\` (service: `WazuhSvc`), pointing at `127.0.0.1:1514/1515`. Re-enroll: `& "C:\Program Files (x86)\ossec-agent\agent-auth.exe" -m 127.0.0.1 -p 1515` then `Restart-Service WazuhSvc`. After a manager container restart, `client.keys` on the host goes stale — remove old agent from manager (`manage_agents -r <id>`) before re-enrolling.
