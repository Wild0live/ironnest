# 02 — Services

Machine-readable mirror at `spec/services.yaml`.

Current declared stack size: **15 core containers** plus **2 optional containers**. The `operations` and `kali` Compose profiles add `operations-runner` and `kali-mcp-littlejohn`, respectively, for a maximum of 17 declared services.

| Container | Image | Role | Listens | Publishes | Networks |
|---|---|---|---|---|---|
| `hermes-platform-openviking-infisical-agent` | `infisical/cli@sha256:dba406b3...` | Secrets sidecar | - | - | `platform-egress` |
| `hermes-platform-ollama` | `ollama/ollama:0.4.6` | Local embedding inference for OpenViking | `11434/tcp` | none | `hermes-platform-mem-net`, `platform-net` |
| `hermes-platform-openviking` | `platform/hermes-platform-openviking:0.1.0` | Long-term memory backend (volcengine/OpenViking) | `1933/tcp` | none | `hermes-platform-mem-net` |
| `hermes-platform-memory-gateway` | `platform/hermes-platform-memory-gateway:0.1.0` | Policy-enforcing front door (FastAPI) | `8080/tcp` | `127.0.0.1:18080:8080` | `platform-net`, `hermes-platform-mem-net`, `hermes-platform-app-net`, `ingress` |
| `hermes-platform-mission-control` | `platform/hermes-platform-mission-control:0.1.0` | Ops dashboard + browser chat control plane | `8080/tcp` | none | `platform-net`, `mission-control-ops-net` |
| `hermes-platform-artifact-apps` | `nginxinc/nginx-unprivileged:alpine` | Read-only, CSP-isolated task Apps origin | `8080/tcp` | none | `platform-net` |
| `hermes-platform-operations-runner` | `platform/hermes-platform-operations-runner:0.1.0` | Optional exact approval-gated Docker operation executor | `8091/tcp` | none | `mission-control-ops-net` |
| `hermes-platform-ttyd` | `platform/hermes-agent:v2026.6.19-patched` | Browser terminal + Hermes dashboard for default profile | `7682/tcp`, `9119/tcp` | `127.0.0.1:8123:7682`, `127.0.0.1:8124:9119` | `platform-net`, `ingress` |
| `hermes-pf-default` | `platform/hermes-agent:v2026.6.19-patched` | Agent (default profile) + Mission Control bridge | `8011/tcp` | none | `platform-net`, `hermes-platform-app-net` |
| `hermes-pf-mark` | same | Agent (mark profile) + Mission Control bridge | `8011/tcp` | none | same |
| `hermes-pf-steve` | same | Agent (steve profile) + Mission Control bridge | `8011/tcp` | none | same |
| `hermes-pf-qa` | same | Agent (qa / QA-verification profile, renamed from wifey 2026-06-14) + Mission Control bridge | `8011/tcp` | none | same |
| `hermes-pf-littlejohn` | same | Agent (littlejohn profile) + Mission Control bridge | `8011/tcp` | none | same |
| `hermes-pf-jaime` | same | Agent (jaime profile) + Mission Control bridge | `8011/tcp` | none | same |
| `hermes-pf-bigbert` | same | Agent (bigbert profile) + Mission Control bridge | `8011/tcp` | none | same |
| `hermes-pf-octo` | same | Agent (octo / platform-ops profile, added 2026-06-12) + Mission Control bridge | `8011/tcp` | none | same |
| `kali-mcp-littlejohn` | `platform/kali-mcp-littlejohn:2026.07.03` | On-demand Kali Linux MCP sidecar for LittleJohn | `8000/tcp` | none | `littlejohn-kali-net`, `littlejohn-kali-egress-net` |

## openviking-infisical-agent

Renders `/secrets/.env` from Infisical path `/hermes-platform/openviking` every 60s. The openviking container reads this file on each config refresh. Pattern mirrors `browser-intent/agent-config/entrypoint.sh`. Healthy when `/secrets/.env` exists.

## openviking

Runs `openviking-server` from PyPI. Reads `/etc/openviking/ov.conf` (rendered at startup by `openviking/entrypoint.sh` from `ov.conf.template`). Workspace persists in `hermes-platform_openviking-workspace`. The `viking://resources/` tree under that workspace holds:

- `viking://resources/shared/**` — collaboration/curated knowledge (gateway-logical `viking://shared/**`)
- `viking://resources/profiles/<profile>/**` — per-profile private (gateway-logical `viking://profiles/<profile>/**`)

## ollama

Runs `ollama/ollama:0.4.6` as the local embedding service for OpenViking. It hosts `mxbai-embed-large` from the persistent `hermes-platform_ollama-models` volume. It joins `hermes-platform-mem-net` for steady-state OpenViking traffic and `platform-net` so the first-boot model pull can use AdGuard DNS and Squid.

OpenViking depends on Ollama being healthy. The healthcheck requires the embedding model to be present, not merely that the HTTP server is listening.

## memory-gateway

FastAPI app at `gateway/app/main.py`. Endpoints:

- `GET  /health` — liveness + OpenViking ping.
- `POST /memory/read`  — body `{"uri": "viking://..."}`.
- `POST /memory/write` — body `{"uri", "content", "metadata"?}`.
- `POST /memory/search` — body `{"query", "scope_uri"?}`.
- `POST /memory/publish-approved` — body `{"source_uri", "target_uri", "rationale"}`.
- `POST /admin/reload-policies` — admin-token protected.
- `GET  /admin/profiles` — admin-token protected.

Auth via `Authorization: Bearer <token>` header. Tokens come from Infisical via `/hermes-platform/gateway → MEMORY_GATEWAY_PROFILE_TOKENS_JSON`.

## hermes-pf-* (8 instances)

Each container reuses the existing `platform/hermes-agent:v2026.6.19-patched` image (Hermes Agent v0.17.0, NousResearch tag `v2026.6.19`). **No `entrypoint:` override** — the image's default `/init + main-wrapper.sh` (s6-overlay) handles UID remap and privilege drop; the `with-infisical` wrapper is passed as the first CMD arg and is exec'd under `s6-setuidgid hermes`. Per-container env: `HERMES_PROFILE=<name>`, `MEMORY_GATEWAY_URL=http://memory-gateway:8080`, `MEMORY_GATEWAY_TOKEN=<from Infisical>`. Volume binding: `hermes-platform_data-<profile>:/opt/data`.

Every profile also read-only mounts `hermes-plugin/ironnest_gateway` at `/opt/data/plugins/ironnest_gateway`. At startup it enables memory and selects `memory.provider=ironnest_gateway` before running `hermes gateway run`. The provider is in-process code, not a service container: it calls `memory-gateway` for automatic pre-answer recall, post-answer turn persistence, and the exposed memory tools.

Each profile also mounts the **shared artifact-exchange** tree (host bind `./shared`): its own slice read-write at `/opt/shared/mine` and the whole tree read-only at `/opt/shared/all` (write-own / read-all). This is the cross-agent channel for binary/file handoff and is independent of the gateway/OpenViking memory path; it is **not** audited. See `docs/08-SECURITY-MODEL.md §"Shared artifact exchange"`.

Each profile also joins the shared Hermes Kanban board by setting `HERMES_KANBAN_HOME=/opt/kanban` and mounting `hermes-platform_kanban-shared` at `/opt/kanban`. This volume holds `kanban.db`, board/workspace data, durable task artifacts, and worker logs. It is deliberately cross-profile and must remain secret-free; it is the work-coordination plane, not private memory.

Every profile also launches the Mission Control **agent-chat bridge** as a background co-process before `hermes gateway run`. The bridge is `agent-bridge/agent-chat-bridge.py`, mounted read-only into the profile at `/opt/ironnest/agent-chat-bridge.py`. It listens on `8011/tcp` inside the profile container, token-gated by `MISSION_CONTROL_BRIDGE_TOKEN`, and drives a persistent warm `hermes acp` session for that profile only.

The bridge supports:

- streamed and non-streamed browser chat from Mission Control;
- one ACP session per Mission Control conversation;
- conversation reset by dropping the ACP session;
- file attachments written under `/opt/data/.mission-control-uploads`;
- hardened basename-only file downloads from that upload directory;
- model changes through `hermes config set model.default`;
- SOUL.md read/write, with the warm ACP process reset after writes;
- lazy LLM-generated role summaries cached by SOUL hash;
- shared Kanban board reads/writes through a structured `/kanban` bridge action, using whitelisted `hermes kanban` CLI invocations rather than raw shell strings;
- manual task execution (`run`) routed to the task assignee's own bridge, which claims a ready task and starts a detached `hermes chat -q` worker with `HERMES_KANBAN_TASK`;
- IronNest Task decomposition through the configured orchestrator profile, with child tasks routed by profile role descriptions in `registry/profiles-registry.yaml`;
- durable task deliverables under `/opt/kanban/artifacts/<task_id>/`, surfaced in Mission Control as Reports and runnable Apps when a folder contains `index.html`;
- per-profile opt-in auto-dispatch settings, persisted in that profile's `/opt/data/.mc-autodispatch.json`.

Concurrency is intentionally one turn at a time per profile. A second request gets a busy response so the dashboard can retry without duplicating the transcript.

## kali-mcp-littlejohn

Optional on-demand Kali Linux MCP sidecar for LittleJohn. It uses the community
`k3nn3dy-ai/kali-mcp` SSE server pinned in `kali-mcp/Dockerfile` and exposes
`http://kali-mcp-littlejohn:8000/sse` only on `littlejohn-kali-net`. It
publishes no Windows host port and never joins `hermes-platform-mem-net` or
`platform-net`. Runtime package/tool egress uses the Kali-only
`littlejohn-kali-egress-net` bridge, not the shared platform egress network.

Mounts:

- `hermes-platform_littlejohn-kali-work:/work` — persistent assessment workspace.
- `./shared/littlejohn/kali:/reports` — report handoff visible through the shared artifact tree.

Operational posture:

- Off by default; create/start through `docker compose --profile kali`.
- LittleJohn may pre-approved start, stop, and restart only this exact container.
- Package installs during a running session are allowed but treated as disposable runtime state.
- Default target mode is lab-only; IronNest-internal and external targets require an explicit assessment record.

## mission-control

`hermes-platform-mission-control` is a standalone FastAPI dashboard at `https://mission.ironnest.local/` through Traefik + Authelia. It is the IronNest Task control plane over Hermes Kanban: operators create goals, orchestrate decomposition, route work to specialists, run assigned tasks, inspect logs/artifacts, publish Reports, preview Apps, and keep security/QA work visible. It is deliberately separate from `memory-gateway`: it holds no OpenViking key, profile token, Infisical credential, or Docker socket. It joins `platform-net` for ingress/profile bridges and the internal `mission-control-ops-net` only for exact requests to `operations-runner`.

Mounted inputs:

- `registry/profiles-registry.yaml` read-only, to discover profile names and container names.
- `policies/` read-only, to show whether each profile policy file is present.
- `hermes-platform_memory-gateway-log` read-only, to show recent memory/audit activity.

Owned state:

- `hermes-platform_mission-control-state:/var/lib/mission-control`, holding schedules, conversation history, avatars, orchestrator settings, and dashboard metadata.

Main API surface:

- `GET /api/state` — profiles, tasks, schedules, recent audit activity, summary metrics.
- `POST /api/schedules` — local Mission Control scheduling state.
- `GET/POST /api/kanban` and `GET /api/kanban/{task_id}` — shared board list/show/create.
- `POST /api/kanban/{task_id}/move`, `/assign`, `/comment`, `/archive` — operator board actions.
- `POST /api/kanban/{task_id}/run` — manual execution, routed to the assignee profile's bridge.
- `POST /api/kanban/{task_id}/decompose` — orchestrator profile decomposes a triage goal into assigned child tasks.
- `GET /api/kanban/{task_id}/log` — worker stdout from the shared Kanban log directory.
- `GET /api/kanban/{task_id}/artifacts`, `/tree`, `/file`, and `/zip` — durable task deliverables from `/opt/kanban/artifacts`.
- `GET /api/reports` and `GET /api/apps` — indexed task outputs, including sandboxed runnable web apps.
- `GET/POST /api/kanban/agent/{profile}/autodispatch` — read or set that profile's opt-in dispatcher state.
- `GET/POST /api/orchestrator` — read or set the profile used for decomposition.
- `POST /api/agent/{profile}/chat` and `/chat/stream` — proxy to the profile bridge.
- `GET/POST/PATCH/DELETE /api/agent/{profile}/conversations...` — per-profile conversation history.
- `GET /api/agents/health` — bridge liveness checks.
- `GET /api/agent/{profile}/file/{name}` — operator download proxy for agent-produced files.
- `GET/PUT /api/agent/{profile}/soul` and `PUT /api/agent/{profile}/model` — proxied profile configuration changes.
- `GET/PUT/DELETE /api/agent/{profile}/avatar` — dashboard avatar metadata.

Administrative writes require a browser cookie that Mission Control revalidates directly with Authelia. `MISSION_CONTROL_ADMIN_TOKEN`, when configured, is an additional gate and does not replace operator-session validation.

## artifact-apps

`hermes-platform-artifact-apps` is a core, read-only nginx service routed at `https://apps.ironnest.local/`. It mounts the shared Kanban artifacts volume read-only and serves folders containing `index.html` on a separate origin from Mission Control. Its CSP blocks agent-authored Apps from calling Mission Control or external hosts, and the service has no API, secrets, or write path.

## operations-runner

`hermes-platform-operations-runner` is optional under the `operations` Compose profile. It is the only Hermes Platform service with Docker-socket access and communicates with Mission Control only over the internal `mission-control-ops-net`. It validates exact allowlisted requests, records request IDs in `hermes-platform_operations-runner-state`, rejects replay, and exposes no raw Docker API. It also enforces Octo's single ten-minute admin lease, explicit workload enrollment, protected-boundary exclusions, and streamed root exec. It does not join `platform-net`, either memory network, or any profile-agent network.

## hermes-platform-ttyd

Browser terminal and Hermes dashboard management sidecar. It mounts `hermes-platform_data-default:/opt/data`, plus the other profile volumes under `/opt/data/profiles/<profile>`, so the Hermes UI can list and manage all platform profiles without using the legacy shared `hermes_hermes-data` volume. It also mounts the Browser Intent MCP upload handoff volumes. Local access:

- ttyd terminal: `http://127.0.0.1:8123`
- Hermes dashboard: `http://127.0.0.1:8124`

The legacy `hermes-ttyd` container in the old `hermes/` stack may still publish `127.0.0.1:7682` and `127.0.0.1:9119` during transition. Treat those old ports as legacy UI unless explicitly cut over.

Trust note: this sidecar is an admin/management plane and can see multiple profile volumes by design. The actual `hermes-pf-*` runtime containers remain volume-isolated.

## Notable absences

- **No openviking client published to the host.** OpenViking is intentionally invisible outside the stack.
- **No metrics exporter** yet — extension point EP-OBSERVABILITY.
