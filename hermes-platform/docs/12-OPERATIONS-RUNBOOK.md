# 12 — Operations Runbook

## Routine ops

| Cadence | Task | Command |
|---|---|---|
| Per session | Inspect health | `bash scripts/healthcheck.sh` |
| Per session | Tail audit log | `docker exec hermes-platform-memory-gateway tail -f /var/log/gateway/audit.log` |
| Weekly | Re-run validations | `bash scripts/validate-isolation.sh && bash scripts/validate-sharing.sh` |
| Monthly | Review denied-access patterns | `cat audit.log | jq 'select(.decision=="deny")' | jq -s 'group_by(.profile) | map({p:.[0].profile,n:length})'` |
| Quarterly | Rotate every profile token | `for p in default mark steve qa littlejohn jaime bigbert octo; do bash scripts/rotate-profile-token.sh $p; done` |
| Quarterly | Rotate admin token | new `openssl rand -hex 32` → Infisical `/hermes-platform/gateway → MEMORY_GATEWAY_ADMIN_TOKEN` → `docker compose restart memory-gateway` |
| As needed | Compact OpenViking workspace | (depends on OpenViking server admin command; check upstream docs) |
| Backups | Capture named volumes | `bash platform/ops/backup.sh` — already includes hermes-platform_* volumes |

## Image upgrades

Bump pinned base / dep images carefully:

| Image | Where pinned | Reason to bump |
|---|---|---|
| `python:3.13.1-slim-bookworm` | `openviking/Dockerfile`, `gateway/Dockerfile` | CVE in Python runtime |
| `infisical/cli@sha256:…` | `gateway/Dockerfile`, `docker-compose.yml` (openviking-infisical-agent) | New release of Infisical CLI |
| `platform/hermes-agent:v2026.6.19-patched` | `docker-compose.yml` + `services.d/*.yml` (every hermes-pf-*) | New Hermes release — rebuild image via `hermes/build.sh`, then `docker compose up -d` both stacks. **Check upstream for init-system changes** (v0.15.0 switched tini→s6-overlay; entrypoint overrides in services.d must be removed on each upgrade if the upstream changes its ENTRYPOINT). |
| Python pkgs in `gateway/requirements.txt` | pinned exactly | Security advisory |
| `openviking` pip pkg | `openviking/Dockerfile` ARG | New OpenViking release |

After any bump: `bash build.sh && bash start.sh && bash scripts/healthcheck.sh`.

## LittleJohn Kali MCP

`kali-mcp-littlejohn` is an optional, on-demand Kali Linux MCP sidecar for the
LittleJohn profile. It is not part of the core memory path and publishes no host
ports.

One-time build/create:

```bash
docker compose --profile kali build kali-mcp-littlejohn
docker compose --profile kali create kali-mcp-littlejohn
docker compose up -d --no-build hermes-pf-littlejohn
```

LittleJohn can then use the pre-approved power switch mounted at
`/opt/ironnest/request-kali-lifecycle.py`:

```bash
/usr/bin/python3 /opt/ironnest/request-kali-lifecycle.py start
/usr/bin/python3 /opt/ironnest/request-kali-lifecycle.py stop
/usr/bin/python3 /opt/ironnest/request-kali-lifecycle.py restart
```

Hermes must register the endpoint with `transport: sse`; otherwise
`hermes mcp test kali-mcp-littlejohn` will try the streamable-HTTP path and
fail against `/sse` with `405 Method Not Allowed`.

Only those three actions for the exact container name `kali-mcp-littlejohn` are
pre-approved. Image changes, network changes, host binds, ports, privileged
mode, Docker API calls, and host PowerShell still require the normal approval
lane.

Persistence model:

- `/work` is a named volume (`hermes-platform_littlejohn-kali-work`) and
  persists across restarts.
- `/reports` maps to `./shared/littlejohn/kali` so Mission Control and other
  agents can see completed reports.
- Temporary package installs are allowed during a running session but should be
  treated as disposable runtime state. Runtime egress is through the Kali-only
  `littlejohn-kali-egress-net`; promote useful tools into the image with an
  explicit reviewed change.
- Default testing scope is lab-only. IronNest-internal or external targets need
  a named assessment record before use.

## Observability hook points

The gateway emits structured JSON to stderr (uvicorn access + custom audit). `monitoring-fluent-bit` (already running in the IronNest `monitoring/` stack) tails every container's stderr/stdout and forwards to Wazuh. No additional config needed.

For Prometheus metrics (extension point EP-OBSERVABILITY):

1. Add `prometheus-fastapi-instrumentator` to `gateway/requirements.txt`.
2. Wire it in `gateway/app/main.py:create_app()`.
3. Add a `/metrics` route guarded by the admin token (or the IronNest `metrics-server` if we add one).
4. Plumb a Prometheus container into IronNest's `observability/` stack.

For OpenTelemetry (extension point EP-OBSERVABILITY):

1. Add `opentelemetry-instrumentation-fastapi` to deps.
2. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to a collector — to be added separately.

## Backup & restore

Backups for hermes-platform are handled by the platform-wide `platform/ops/backup.sh` (matches every Docker named volume with prefix `hermes-platform_`). Verify after a backup:

```bash
ls G:\rancher-stack-backups\<date>\ | grep hermes-platform
```

Restore is a manual operation (`platform/ops/restore.sh`); see the IronNest README.

## Incident response — suspected token leak

1. Immediately rotate the suspected token (`scripts/rotate-profile-token.sh <name>`).
2. Update both Infisical paths; restart `memory-gateway` and the affected `hermes-pf-<name>`.
3. Grep audit log for past use:
   ```bash
   docker exec hermes-platform-memory-gateway grep '<some uri pattern>' /var/log/gateway/audit.log | jq .
   ```
4. If unauthorized writes happened: enumerate them and consider rolling back via OpenViking's history (or by promoting the SOUL.md backup files via `scripts/patch-souls.sh`).
5. Open a postmortem in `docs/16-DECISION-LOG.md`.

## Recovering from a Rancher Desktop restart

When Rancher Desktop is restarted (Windows reboot, manual quit, update), all running IronNest containers stop. The exact count changes as optional stacks and Compose profiles are enabled, so recover by stack rather than relying on a fixed container total:

```bash
# 1. Bring up the always-on stacks
bash D:/claude-workspace/platform/bootstrap.sh

# 2. Bring up hermes-platform
bash D:/claude-workspace/platform/hermes-platform/start.sh

# 3. (Optional) bring up other on-demand stacks if needed
bash D:/claude-workspace/platform/openclaw/start.sh
bash D:/claude-workspace/platform/browser-intent/start.sh

# 4. Verify
bash D:/claude-workspace/platform/hermes-platform/scripts/healthcheck.sh
```

The RD port forwarder gets a clean refresh on restart — so 127.0.0.1:18080, 8123, 8124 etc. all work immediately. (One of the few side benefits of an RD restart — see TROUBLESHOOTING for the stale-state symptom.)

If autostart is enabled (Task Scheduler chains bootstrap.sh + start.sh per stack), step 1-3 happen at logon. Verify via `bash D:/claude-workspace/platform/ops/status.sh`.

## Managing the `hermes-platform-ttyd` sidecar

`hermes-platform-ttyd` is the management plane: browser terminal + Hermes dashboard. Operationally:

| Action | Command |
|---|---|
| Open terminal directly | http://127.0.0.1:8123 (localhost-only; ttyd Basic Auth is disabled) |
| Open terminal through ingress | https://hermes-platform.ironnest.local/ (Authelia FIDO gate) |
| Open dashboard | http://127.0.0.1:8124 (no auth) |
| Restart (after Infisical rotation) | `docker compose restart hermes-platform-ttyd` |
| Inspect cross-profile data | `docker exec hermes-platform-ttyd ls //opt/data/profiles/<profile>` (double slash defeats Git Bash MSYS mangling) |

**Trust note:** the ttyd container mounts ALL profile volumes (`hermes-platform_data-{default,mark,steve,qa,littlejohn,jaime,bigbert,octo}`). The direct ports are deliberately localhost-only management escape hatches; the routed URLs are protected by Authelia. Anyone who reaches this management plane has full multi-profile filesystem access. The actual `hermes-pf-*` agent containers remain volume-isolated. See `docs/16-DECISION-LOG.md §D-011`.

**Do NOT run `hermes gateway run` from the ttyd shell** — it would create a competing Telegram poller and 409-conflict with `hermes-pf-default`. ttyd is for `hermes dashboard` + interactive shell only.

## Incident response — bad policy deployed

If `POST /admin/reload-policies` accepted a wrong policy that opens too much:

1. Revert the file: `git checkout HEAD -- policies/<name>.policy.yaml`.
2. Reload: `curl -XPOST … /admin/reload-policies`.
3. Audit log for unwanted accesses during the bad window.
