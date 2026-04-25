# IronNest Architecture

## Overview

**IronNest** is a security-hardened, modular 14-container platform running on Rancher Desktop (WSL2/Windows 11). It hosts an AI application workload (OpenClaw) surrounded by a layered security perimeter: secrets management, DNS filtering, HTTP egress control, SIEM monitoring, image scanning, and observability — each in its own isolated Compose project.

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

OpenClaw has an extra non-internal `openclaw_ingress` bridge solely so Docker can publish `127.0.0.1:18789` to Windows. Because that bridge can create a default route, `openclaw/start.sh` runs `ops/fix-openclaw-egress.sh` after startup. The script inserts an idempotent `DOCKER-USER` rule that drops NEW outbound connections initiated from the `openclaw_ingress` bridge, preventing `curl --noproxy`-style direct internet bypasses while preserving localhost UI access and Squid-mediated egress.

### 6. Network segmentation by trust level
- `platform-net` (internal) — inter-service comms, no internet exit.
- `platform-egress` — internet-capable, only for services that genuinely need raw TCP.
- Stack-private `ingress` bridges — used solely for localhost port publishing; keeps internal networks from leaking host-facing ports to the wrong services. OpenClaw's ingress bridge is additionally blocked from initiating direct outbound internet traffic by a `DOCKER-USER` firewall rule.
- Stack-private internal networks (e.g. `secrets-internal`, `wazuh-internal`) — database/index tiers that should never be reachable from other stacks.

### 7. Secrets out of images and out of git
Per-stack `.env` files hold credentials. All `.env` files are gitignored; only `.env.example` templates are tracked. Infisical is the runtime secrets manager for application secrets injection via an **Infisical Agent sidecar** (`infisical/cli:latest`) that authenticates with Universal Auth, polls every 60 s, and renders secrets into `openclaw/secrets-runtime/.env` via a Jinja2 template. The gateway loads this file via `env_file` (`required: false`) so it starts even if secrets are temporarily unavailable.

### 8. Modular startup order
`bootstrap.sh` brings stacks up in hard-wired dependency order so every service finds its upstream already healthy:

```
socket-proxy → adguard → egress-proxy → secrets → dozzle → wazuh → trivy → openclaw
```

OpenClaw is last because it depends on DNS (AdGuard), HTTP proxy (Squid), and optionally Infisical — all of which must be ready first.

Use `openclaw/start.sh` instead of bare `docker compose up -d` for OpenClaw. It repairs Rancher Desktop NAT, verifies `platform-egress` routing, starts the stack, applies the `openclaw_ingress` direct-egress firewall rule, registers injected API keys, and verifies that direct no-proxy egress is blocked.

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
| openclaw | `openclaw/` | on-demand | 127.0.0.1:18789, 127.0.0.1:7681 (ttyd) |

---

## Container Profile

All 14 containers across 8 stacks, as reported by `docker ps`.

| Container | Role | Stack | Image | Host Port |
|-----------|------|-------|-------|-----------|
| `openclaw-gateway` | AI app workload | openclaw | `platform/openclaw:2026.4.22-1-codex` | `127.0.0.1:18789` |
| `openclaw-ttyd` | Browser terminal sidecar | openclaw | `platform/openclaw:2026.4.22-1-codex` | `127.0.0.1:7681` |
| `openclaw-infisical-agent` | Secrets sidecar | openclaw | `platform/infisical-cli:0.43.76-patched` | — |
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
Socket Isolation → Observability → DNS Filtering → Egress Control → SIEM → Image Scanning → Secrets → AI Core
```

### Image Version Pins

All images are pinned — no `latest` or floating tags anywhere in IronNest. Semver tags are used where the upstream publishes them; SHA256 digests are used where only a floating tag exists.

| Image (compose / built tag) | Dockerfile `FROM` pin | Upstream version | Pin method |
|---|---|---|---|
| `ghcr.io/openclaw/openclaw:2026.4.22-1-amd64` | — (external, set via `$OPENCLAW_IMAGE`) | 2026.4.22-1 | Calendar semver |
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
- `wazuh-internal` — manager + indexer + dashboard mesh
- `ingress` bridges on OpenClaw, Dozzle, Wazuh — used only for localhost port publishing
- `openclaw_ingress` — non-internal because Windows port publishing requires it; direct outbound NEW connections from its Linux bridge are dropped by `ops/fix-openclaw-egress.sh`

---

## Service Resource Limits

| Service | CPUs | Memory |
|---------|------|--------|
| Postgres | 1.0 | 512 MB |
| Redis | 0.5 | 256 MB |
| Infisical | 2.0 | 1 GB |
| OpenClaw gateway | 4.0 | 4 GB |
| openclaw-ttyd | 0.25 | 128 MB |
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
| openclaw-gateway direct internet bypass | Docker `DOCKER-USER` firewall | NEW outbound traffic from `openclaw_ingress` is dropped by `ops/fix-openclaw-egress.sh` |
| openclaw-ttyd | browser (host) | HTTP Basic Auth via ttyd `--credential`; credentials `TTYD_USERNAME`/`TTYD_PASSWORD` injected from Infisical |

---

## Egress Allowlist (Squid)

| Consumer | Allowed destinations |
|----------|---------------------|
| OpenClaw | `.anthropic.com`, `.openai.com`, `.chatgpt.com`, `.cohere.ai`, `.mistral.ai`, `registry.npmjs.org` |
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
