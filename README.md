# IronNest

**The secure local platform for running AI workloads on Windows.**

IronNest wraps [OpenClaw](https://github.com/openclaw/openclaw) — a self-hosted AI gateway supporting Anthropic Claude, OpenAI, and other providers — in seven independent security layers, so your AI workload runs with production-grade controls on your local machine. No cloud infrastructure required.

```
Socket Isolation → Observability → DNS Filtering → Egress Control → SIEM → Image Scanning → Secrets → AI Core
```

### The core idea

Running an AI gateway locally means managing real API keys, real outbound connections, and a real attack surface. IronNest treats OpenClaw as an untrusted workload and enforces that boundary in hardware:

- **API keys never touch the filesystem or git** — injected at runtime by a self-hosted Infisical vault
- **All outbound traffic goes through an allowlist proxy** — OpenClaw can only reach AI provider APIs; nothing else
- **Direct internet bypass is impossible** — blocked at the kernel level by a `DOCKER-USER` firewall rule
- **The host OS is monitored** — Wazuh watches for intrusion, file integrity changes, and anomalous behaviour
- **OpenClaw cannot see or control other containers** — zero Docker socket access, zero lifecycle privileges

OpenClaw is the default AI workload, but the platform is designed to host **any containerized AI workload** in the same security envelope. Swap out the `openclaw/` stack and the surrounding layers remain unchanged.

**Who this is for:** Developers and security-conscious teams who want to self-host an AI gateway with Infisical managing secrets, Wazuh watching the host, Squid enforcing an egress allowlist, and everything auditable from a single Dozzle log view — all on a Windows 11 machine.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design, network diagram, and security rationale.

---

## System Requirements

IronNest runs 14 containers simultaneously. Wazuh's OpenSearch indexer is the most memory-intensive component — size your machine accordingly.

| Component | Minimum | Recommended |
|---|---|---|
| **OS** | Windows 11 (22H2+) | Windows 11 (latest) |
| **RAM** | 16 GB | 32 GB |
| **CPU** | 4 cores / 8 threads | 8+ cores |
| **System drive (C:)** | 60 GB free | 100 GB free |
| **Docker storage** | 40 GB free (separate drive recommended) | 100 GB free |
| **Backup target** | 50 GB free | 100 GB free |
| **Virtualization** | Hyper-V or VT-x/AMD-V enabled in BIOS | — |

**Container memory budget (configured limits):**

| Stack | Containers | Memory limit |
|---|---|---|
| Wazuh (manager + indexer + dashboard) | 3 | 5 GB |
| OpenClaw gateway + ttyd | 2 | 4.1 GB |
| Infisical + Postgres + Redis | 3 | 1.8 GB |
| Trivy, Squid, AdGuard, Dozzle, socket-proxy | 5 | 1.2 GB |
| **Total** | **14** | **~12.1 GB** |

> Windows + WSL2 overhead adds ~2–4 GB on top. On a 16 GB machine, leave Wazuh indexer's memory limit lower (`OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx1g`) if you hit pressure.

**Storage breakdown:**
- Docker images: ~8 GB on first pull (Wazuh images are large)
- Wazuh indexer data: grows with log volume — plan for 10–20 GB over time
- Trivy CVE DB: ~1 GB (regenerable, not backed up)
- Backups: ~500 MB per daily snapshot × 14-day retention ≈ 7 GB minimum

---

## What's included

| Stack | Path | Purpose | UI |
|---|---|---|---|
| Socket proxy | `security/socket-proxy/` | Read-only Docker API for Dozzle / Wazuh / Trivy | — |
| DNS filter | `security/adguard/` | AdGuard Home — blocks malicious domains for all containers | `127.0.0.1:3000` |
| Egress proxy | `security/egress-proxy/` | Squid — hostname-allowlisted HTTPS egress | — |
| SIEM | `security/wazuh/` | Wazuh manager + indexer + dashboard | `127.0.0.1:8443` |
| Image scanner | `security/trivy/` | CVE DB server + on-demand scanner | — |
| Secrets manager | `secrets/` | Infisical + Postgres + Redis | `127.0.0.1:8090` |
| Log viewer | `observability/dozzle/` | Real-time container log viewer | `127.0.0.1:8888` |
| AI workload | `openclaw/` | OpenClaw gateway + ttyd browser terminal | `127.0.0.1:18789`, `127.0.0.1:7681` |

---

## Prerequisites

- **Rancher Desktop** (WSL2 backend, `moby` container runtime) — [rancher desktop docs](https://docs.rancherdesktop.io/)
- **Git Bash** (comes with Git for Windows)
- **PowerShell 7+** (for the autostart task)
- Drives with sufficient space: platform files on C: or D:, Docker VHD ideally on a separate drive (e.g. F:)

---

## First-time setup

### 1. Clone the repo

```bash
git clone https://github.com/<your-org>/ironnest.git
cd ironnest
```

### 2. Add Docker binaries to PATH (Git Bash)

```bash
export PATH="/c/Program Files/Rancher Desktop/resources/resources/win32/bin:$PATH"
```

Add this line to your `~/.bashrc` so it persists.

### 3. Configure each stack

Every stack has a `.env.example`. Copy each one to `.env` and fill in the values:

```bash
cp secrets/.env.example             secrets/.env
cp security/wazuh/.env.example      security/wazuh/.env
cp openclaw/.env.example            openclaw/.env
```

**secrets/.env** — generate secrets with `openssl rand -hex 32`:
- `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `ENCRYPTION_KEY`, `AUTH_SECRET` — random 32-byte hex strings
- `DB_CONNECTION_URI` / `REDIS_URL` — paste the same passwords into the connection strings
- `SMTP_*` — optional; needed for Infisical email invites (Gmail App Password recommended)

**security/wazuh/.env** — set strong passwords for `WAZUH_INDEXER_PASSWORD`, `WAZUH_API_PASSWORD`, `WAZUH_DASHBOARD_PASSWORD`

**openclaw/.env**:
- `OPENCLAW_GATEWAY_TOKEN` — any random string (used as the OpenClaw API token)
- `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` / `_SECRET` — from Infisical after completing step 5 below

### 4. Generate Wazuh TLS certificates

```bash
cd security/wazuh
docker compose -f generate-indexer-certs.yml run --rm generator
cd ../..
```

This creates `security/wazuh/config/wazuh_indexer_ssl_certs/` (gitignored — regenerate on each fresh clone).

### 5. Bootstrap the platform

```bash
bash bootstrap.sh
```

This creates shared networks (`platform-net`, `platform-egress`) and starts always-on stacks in dependency order:
```
socket-proxy → adguard → egress-proxy → secrets → dozzle → wazuh → trivy
```

Wait ~60 seconds for Infisical to initialize, then open **http://127.0.0.1:8090** and complete the Infisical first-run setup (create an account and project).

### 6. Configure Infisical for OpenClaw

1. In the Infisical UI, create a project (e.g. `openclaw`)
2. Add your AI API keys as secrets in the **Development** environment at path `/`:
   - `ANTHROPIC_API_KEY`
   - `OPENAI_API_KEY` (optional)
   - `TTYD_USERNAME` and `TTYD_PASSWORD` (browser terminal credentials)
3. Go to **Access Control → Machine Identities**, create an identity, and copy the Client ID and Secret into `openclaw/.env`
4. In `openclaw/agent-config/secrets.tmpl`, replace `<YOUR_INFISICAL_PROJECT_ID>` with your actual Infisical project UUID (visible in the project URL)

### 7. Start OpenClaw

```bash
bash openclaw/start.sh
```

OpenClaw is intentionally on-demand (not started by `bootstrap.sh`) so you control when the AI workload is running.

- **UI:** http://127.0.0.1:18789
- **Browser terminal:** http://127.0.0.1:7681 (login with `TTYD_USERNAME`/`TTYD_PASSWORD`)

### 8. (Optional) Auto-start on login

Register a Task Scheduler task so the full stack starts automatically after Rancher Desktop initializes:

```powershell
# Run in an elevated PowerShell terminal
$action  = New-ScheduledTaskAction `
    -Execute "pwsh.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -File `"$PWD\ops\autostart.ps1`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable $true
Register-ScheduledTask -TaskName "platform-autostart" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force
```

### 9. (Optional) Install the Wazuh host agent

Download the Windows agent from https://packages.wazuh.com and enroll it:

```powershell
& "C:\Program Files (x86)\ossec-agent\agent-auth.exe" -m 127.0.0.1 -p 1515
Restart-Service WazuhSvc
```

---

## Day-to-day operations

```bash
# Status across all stacks
./ops/status.sh

# Run a Trivy vulnerability scan
./security/trivy/scan.sh all

# Restart a single stack
cd secrets && docker compose restart

# Stop OpenClaw (everything else keeps running)
cd openclaw && docker compose stop

# Run OpenClaw security audit from browser terminal
# → open http://127.0.0.1:7681 and run:
openclaw security audit
```

---

## After every Rancher Desktop restart

If you didn't set up the autostart task (step 8), run manually:

```bash
bash bootstrap.sh
bash openclaw/start.sh
```

Rancher Desktop injects DNAT rules on boot that break intra-container TCP. `bootstrap.sh` fixes this automatically via `ops/fix-nat-prerouting.sh`.

---

## Backup and restore

```bash
# Backup all volumes (outputs to G:\rancher-stack-backups\ by default — edit the path in ops/backup.sh)
bash ops/backup.sh

# Restore from a backup
bash ops/restore.sh G:\rancher-stack-backups\<timestamp>
```

See `ARCHITECTURE.md → Backup Artifacts` for the full artifact list.

---

## Principles

- **No raw Docker socket.** All API consumers use the read-only socket proxy.
- **DNS through AdGuard** for every container. Blocks malicious domains before TCP.
- **HTTPS through Squid** with a strict hostname allowlist. Direct egress from OpenClaw is blocked by a `DOCKER-USER` firewall rule.
- **Secrets via Infisical.** API keys never touch images, compose files, or git history.
- **Blast-radius isolation.** Each stack is its own Compose project. One stack going down cannot take others with it.
- **Everything has resource limits.** No container can starve the WSL2 VM.

---

## License

MIT
