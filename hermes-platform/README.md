# hermes-platform

**A multi-profile Hermes runtime fronted by a policy-enforcing memory gateway, with OpenViking as the long-term context database.**

Each `hermes-pf-*` agent loads the `ironnest_gateway` Hermes memory provider:
relevant private recall is injected before an answer and completed turns are
persisted to OpenViking through the audited policy gateway.

An on-demand IronNest stack at `D:\claude-workspace\platform\hermes-platform\`. It is the active Hermes runtime alongside `openclaw/` and `browser-intent/`. The legacy `hermes/` Compose stack was removed; `hermes/` is now only the build context for the shared `platform/hermes-agent` image.

> **For another AI/LLM picking this up:** start at [`docs/00-AI-REBUILD-MANIFEST.md`](docs/00-AI-REBUILD-MANIFEST.md) and [`docs/17-LLM-HANDOFF.md`](docs/17-LLM-HANDOFF.md). Everything else is referenced from there.
> For the automatic memory call path specifically, read [`docs/18-AUTOMATIC-CONVERSATIONAL-MEMORY.md`](docs/18-AUTOMATIC-CONVERSATIONAL-MEMORY.md).
>
> **OpenViking:** https://github.com/volcengine/OpenViking (the official repo this stack integrates).

---

## Architecture in 30 seconds

```
   hermes-pf-default ┐
   hermes-pf-mark ───┤
   hermes-pf-steve ──┼──[bearer]──► memory-gateway ──[internal-net]──► openviking
   hermes-pf-qa ─────┤              (FastAPI policy +              (volcengine/OpenViking
   hermes-pf-littlejohn ┤            audit + adapter)                on port 1933)
   hermes-pf-jaime ─────┤
   hermes-pf-bigbert ───┤
   hermes-pf-octo ──────┘

   Mission Control ──[platform-net]──► agent-chat bridge inside each hermes-pf-*
                                      (chat, files, SOUL/model edits, Tasks/Kanban)

   all hermes-pf-* ──► /opt/kanban shared board volume
```

- **8 Hermes profile containers**, each on its own isolated named volume. (`qa` was renamed from `wifey` 2026-06-14; `octo` platform-ops added 2026-06-12.)
- **`ironnest_gateway` is not a container.** It is loaded inside each Hermes agent to call `memory-gateway` automatically before and after conversational turns.
- **Memory Gateway** enforces deny-first policy from `policies/<profile>.policy.yaml`.
- **OpenViking** is unreachable from any Hermes container (network-segmented).
- **Ollama** provides local `mxbai-embed-large` embeddings for OpenViking.
- **Mission Control** at `https://mission.ironnest.local/` is the browser ops/chat/Task control plane. It is separate from `memory-gateway` and talks to profiles through token-gated in-container bridges.
- **IronNest Tasks** are the governed workflow layer Mission Control builds on top of Hermes Kanban: triage goals can be decomposed, assigned to specialist profiles, run in the assignee's own container, and reviewed through logs, artifacts, Reports, Apps, QA, and security gates.
- **Shared Hermes Kanban** lives on `hermes-platform_kanban-shared` at `/opt/kanban` in every profile container. It is the underlying cross-profile work board and must remain secret-free; it is not private memory.
- **Bearer tokens in Infisical only.** Never in git, never on disk.

Full picture: [`docs/01-ARCHITECTURE.md`](docs/01-ARCHITECTURE.md). Decision rationale: [`docs/16-DECISION-LOG.md`](docs/16-DECISION-LOG.md).

---

## Why this exists

The old `hermes/` stack shipped 5 Telegram-gateway containers (default, mark, steve, wifey, littlejohn) that all shared ONE `hermes_hermes-data` named volume. Cross-profile memory isolation was enforced only by Hermes' internal profile-dir convention — a kernel escape from any one container could read every profile's SOUL.md, sessions, and tokens. There was also no structured long-term memory: each profile relied on session logs and on-disk Markdown.

`hermes-platform/` fixes both:

| Concern | Before | After |
|---|---|---|
| Per-profile volume isolation | Shared `hermes_hermes-data` | One `hermes-platform_data-<profile>` per container |
| Long-term memory backend | On-disk Markdown only | OpenViking (semantic + tiered) |
| Cross-profile memory access | Hermes convention | Policy-enforced gateway, deny-first |
| Memory access audit | None | JSONL log + Wazuh ingestion |
| Bearer-token management | N/A (no gateway) | Infisical-only, constant-time compare |
| Automatic conversation recall/save | Not integrated with gateway | `ironnest_gateway` provider calls the audited gateway lifecycle path |
| Operator control plane | ttyd/dashboard only | Mission Control: chat, governed Tasks over shared Kanban, schedules, files, SOUL/model edits |

See [`docs/08-SECURITY-MODEL.md`](docs/08-SECURITY-MODEL.md) for the threat model.

---

## Container inventory

| Container | Image | Role | Host port |
|---|---|---|---|
| `hermes-platform-openviking-infisical-agent` | `infisical/cli@sha256:dba406b3…` | Secrets sidecar | — |
| `hermes-platform-ollama` | `ollama/ollama:0.4.6` | Local embedding inference (`mxbai-embed-large`) | none |
| `hermes-platform-openviking` | `platform/hermes-platform-openviking:0.1.0` | Long-term memory backend (volcengine/OpenViking) | none |
| `hermes-platform-memory-gateway` | `platform/hermes-platform-memory-gateway:0.1.0` | Policy-enforcing front door (FastAPI) | `127.0.0.1:18080` |
| `hermes-platform-mission-control` | `platform/hermes-platform-mission-control:0.1.0` | Browser ops/chat dashboard | `https://mission.ironnest.local/` |
| `hermes-platform-ttyd` | `platform/hermes-agent:v2026.6.19-patched` | terminal + Hermes dashboard sidecar | `127.0.0.1:8123`, `127.0.0.1:8124` |
| `hermes-pf-default` | `platform/hermes-agent:v2026.6.19-patched` | default profile agent + chat bridge | — |
| `hermes-pf-mark` | same | mark profile agent + chat bridge | — |
| `hermes-pf-steve` | same | steve profile agent + chat bridge | — |
| `hermes-pf-qa` | same | qa (QA/verification) profile agent + chat bridge | — |
| `hermes-pf-littlejohn` | same | littlejohn profile agent + chat bridge | — |
| `hermes-pf-jaime` | same | jaime profile agent + chat bridge | — |
| `hermes-pf-bigbert` | same | bigbert profile agent + chat bridge | — |
| `hermes-pf-octo` | same | octo (platform-ops) profile agent + chat bridge | — |

---

## Test suite

178 pytest cases ship in `gateway/tests/`. Runtime <1 second.

```bash
docker run --rm -v "$(pwd):/work:ro" python:3.13-slim bash -c "
  pip install -q -r /work/gateway/requirements.txt pytest &&
  mkdir -p /tmp/wk && cp -r /work/gateway /work/policies /work/registry /work/spec /tmp/wk/ &&
  cd /tmp/wk/gateway && pytest tests/ -v
"
```

See [`docs/10-VALIDATION-AND-TESTING.md`](docs/10-VALIDATION-AND-TESTING.md) for the test-file inventory and coverage.

---

## Quick start

Assumes `platform/bootstrap.sh` has run (always-on stacks healthy) and the `platform/hermes-agent:v2026.6.19-patched` image exists (`bash platform/hermes/build.sh`).

```bash
cd D:\claude-workspace\platform\hermes-platform

# 1) Fill in Infisical creds
cp .env.example .env
# Edit .env

# 2) Build openviking + memory-gateway + Mission Control images
bash build.sh

# 3) Start the stack
bash start.sh
```

After it's healthy:

```bash
bash scripts/healthcheck.sh                   # cross-stack smoke test
bash scripts/validate-conversational-memory.sh # prove automatic Hermes save/read through gateway
bash scripts/validate-isolation.sh            # prove deny-first works
bash scripts/validate-sharing.sh              # prove curated-share path works

curl -sS http://127.0.0.1:18080/health | jq .
```

Operator UIs:

- Mission Control: `https://mission.ironnest.local/`
- Platform terminal: `https://hermes-platform.ironnest.local/`
- Hermes dashboard: `https://hermes-platform-dashboard.ironnest.local/`

To migrate data from a legacy `hermes_hermes-data` volume:

```bash
bash scripts/migrate-from-shared-volume.sh --dry-run   # preview
bash scripts/migrate-from-shared-volume.sh             # SHA-256 verified
bash scripts/patch-souls.sh --dry-run                  # preview SOUL.md diffs
bash scripts/patch-souls.sh                            # append OpenViking policy section
```

Full runbook: [`docs/09-DEPLOYMENT-RUNBOOK.md`](docs/09-DEPLOYMENT-RUNBOOK.md).

---

## Adding a new profile (dynamic)

```bash
bash scripts/create-profile.sh analyst
```

The script renders the policy file, appends to the registry, creates the named volume, and seeds the profile's SOUL.md / USER.md / MEMORY.md / tools.yaml from `profile-template/`. It then prints the manual follow-up (Infisical token, compose entry, restart). Profile name must match `^[a-z][a-z0-9_-]{0,31}$`.

See [`docs/07-PROFILE-LIFECYCLE.md`](docs/07-PROFILE-LIFECYCLE.md) for create/validate/rotate/delete flows.

---

## Where everything lives

```
hermes-platform/
├── README.md                                (this file)
├── ARCHITECTURE.md                          → docs/01-ARCHITECTURE.md
├── docker-compose.yml                       base services/profiles, volumes, networks
├── services.d/                              dynamic profile compose fragments
├── hermes-plugin/ironnest_gateway/          in-process automatic memory provider
├── build.sh, start.sh, with-infisical.sh
├── openviking/                              Dockerfile + ov.conf.template + sidecar
├── gateway/                                 memory-gateway FastAPI app (Dockerfile + app/)
├── mission-control/                         Mission Control FastAPI app + static UI
├── agent-bridge/                            per-profile Mission Control chat/Kanban bridge
├── policies/                                <profile>.policy.yaml
├── registry/profiles-registry.yaml
├── profile-template/                        templates for create-profile.sh
├── scripts/                                 11 lifecycle/validation shell scripts
├── docs/                                    numbered architecture and operations docs
└── spec/                                    8 machine-readable manifests
```

Full tree: [`docs/03-DIRECTORY-STRUCTURE.md`](docs/03-DIRECTORY-STRUCTURE.md).

---

## Security posture

| Layer | Mechanism |
|---|---|
| Network | `hermes-platform-mem-net` is `internal:true`; only `memory-gateway` is on both mem-net and app-net |
| Auth | Bearer tokens fetched from Infisical at process start; constant-time compare |
| Policy | Deny-first YAML rules, schema-validated, reloadable without restart |
| Volumes | One `hermes-platform_data-<profile>` per container; no sharing |
| Shared work board | `/opt/kanban` is cross-profile by design; keep it secret-free |
| Container hardening | `cap_drop: ALL`, `no-new-privileges:true`, non-root users |
| Audit | JSONL log to `/var/log/gateway/audit.log` + stderr to fluent-bit → Wazuh |
| Mission Control | Separate from memory-gateway; platform-net plus private operations channel only; no OpenViking/profile bearer secrets or Docker socket |

Full model: [`docs/08-SECURITY-MODEL.md`](docs/08-SECURITY-MODEL.md).

---

## Future extension points

- **Kubernetes migration** — [`docs/13-KUBERNETES-MIGRATION-NOTES.md`](docs/13-KUBERNETES-MIGRATION-NOTES.md)
- **MCP server wrapper** — [`docs/14-MCP-INTEGRATION-NOTES.md`](docs/14-MCP-INTEGRATION-NOTES.md)
- **Vault replacement for Infisical** — `with-infisical.sh` is the swap point
- **Prometheus / OpenTelemetry** — [`docs/12-OPERATIONS-RUNBOOK.md`](docs/12-OPERATIONS-RUNBOOK.md)

---

## Operational best practices

- Run `bash scripts/validate-isolation.sh` after any policy change.
- Rotate every profile token quarterly via `scripts/rotate-profile-token.sh`.
- Always `--dry-run` `patch-souls.sh` and `migrate-from-shared-volume.sh` first.
- Never commit a `.env` file, never put a token in `policies/` or `registry/`.
- Treat `hermes-platform-mem-net` as a security boundary; never connect new containers without architectural review.

---

## References

- IronNest platform: `D:\claude-workspace\platform\README.md` and `ARCHITECTURE.md`
- OpenViking (upstream): https://github.com/volcengine/OpenViking
- Hermes Agent (upstream): https://github.com/NousResearch/hermes-agent
- Infisical (upstream): https://infisical.com/
- This stack's machine-readable manifest: [`spec/system.manifest.yaml`](spec/system.manifest.yaml)
- AI rebuild entry point: [`docs/00-AI-REBUILD-MANIFEST.md`](docs/00-AI-REBUILD-MANIFEST.md)
