# 01 — Architecture

## One picture

```
                                                                                  ▲ Internet
                                                                                  │
                                                                                  │ (NAT via platform-egress)
                                                                                  │
                            ┌──────────────────────────────────────────────────────────────┐
                            │                  IronNest existing perimeter                  │
                            │   AdGuard DNS · Squid egress · Infisical secrets · Traefik   │
                            └──────────────────────────────────────────────────────────────┘
                                              ▲                                  ▲
                                              │ DNS, Squid proxy                 │ Infisical
   ┌──────────────────────────────────────────┴──────────────────────────────────┴────────┐
   │                                       platform-net                                     │
   │                                                                                        │
   │   hermes-pf-default ┐                                                                  │
   │   hermes-pf-mark ───┤                                                                  │
   │   hermes-pf-steve ──┼────► (hermes-platform-app-net, internal) ───► memory-gateway     │
   │   hermes-pf-qa ─────┤                                                  │  (FastAPI)    │
   │   hermes-pf-littlejohn ┤                                               │               │
   │   hermes-pf-jaime ─────┤                                               │               │
   │   hermes-pf-bigbert ───┤                                               │               │
   │   hermes-pf-octo ──────┘                                               │               │
   │                                                                        │               │
   │                                                          (hermes-platform-mem-net,     │
   │                                                                  internal)             │
   │                                                                        │               │
   │                                                                        ▼               │
   │                                                                   openviking            │
   │                                                                  (port 1933)           │
   │                                                                                        │
   │   hermes-platform-ttyd ──► management UI                                                │
   │       publishes 127.0.0.1:8123 (ttyd) and 127.0.0.1:8124 (dashboard)                    │
   │       mounts default at /opt/data and other profile volumes under /opt/data/profiles/    │
   │                                                                                        │
   └────────────────────────────────────────────────────────────────────────────────────────┘

   Operator and governed-operation paths (outside the memory policy kernel):

       Traefik + Authelia
          ├──► mission-control (platform-net)
          │       ├──► hermes-pf-* bridge:8011             chat + Task/Kanban actions
          │       ├──► host-operations-queue (host bind)   approved Windows requests
          │       │       └──► localhost elevated runner   allowlisted remediation IDs
          │       └──► operations-runner (mission-control-ops-net, optional)
          │               └──► Docker socket               exact, persisted operations only
          └──► artifact-apps (platform-net)                 read-only Apps origin + CSP

       hermes-pf-littlejohn
          ├──► kali-mcp-littlejohn (littlejohn-kali-net, optional; no host port)
          └──► wazuh-query (external IronNest service)      internal read-only SIEM broker

   Per-profile volumes (Docker-managed, mounted ONLY into the matching container):
       hermes-platform_data-default      → hermes-pf-default:/opt/data
       hermes-platform_data-mark         → hermes-pf-mark:/opt/data
       hermes-platform_data-steve        → hermes-pf-steve:/opt/data
       hermes-platform_data-qa           → hermes-pf-qa:/opt/data
       hermes-platform_data-littlejohn   → hermes-pf-littlejohn:/opt/data
       hermes-platform_data-jaime        → hermes-pf-jaime:/opt/data
       hermes-platform_data-bigbert      → hermes-pf-bigbert:/opt/data
       hermes-platform_data-octo         → hermes-pf-octo:/opt/data

   Shared artifact exchange (host bind, write-own / read-all — see Tier A note):
       ./shared/<profile>  → hermes-pf-<profile>:/opt/shared/mine        (read-write, own slice)
       ./shared            → hermes-pf-<profile>:/opt/shared/all  (ro)   (read every agent's output)
       ./shared            → hermes-platform-ttyd:/opt/shared/all        (read-write, operator)

   Shared Task/Kanban coordination plane:
        hermes-platform_kanban-shared → every hermes-pf-*:/opt/kanban
        Mission Control reaches it through the profile bridges, not by mounting the DB

   OpenViking workspace:
       hermes-platform_openviking-workspace → openviking:/var/lib/openviking
```

## In words

Three concentric trust tiers.

**Tier A — the agents.** Each Hermes profile runs in its own container (`hermes-pf-<profile>`). The container mounts ONLY the profile's own named volume at `/opt/data`. It also read-only mounts the in-process `ironnest_gateway` Hermes memory provider and selects it at every startup. The provider automatically searches private memory before an answer and saves the completed conversation turn afterward; both operations call `memory-gateway`. The container joins `platform-net` (LLM provider egress through Squid) and `hermes-platform-app-net` (talking to the gateway). It does NOT join `hermes-platform-mem-net`; there is no route to OpenViking from inside a Hermes container.

**Tier A — shared artifact exchange (files, images, binaries).** Separate from the OpenViking memory path, agents hand binary/file output to one another over a host-bind volume rooted at `./shared` (host: `D:\claude-workspace\platform\hermes-platform\shared\`). Each container mounts its own slice read-write at `/opt/shared/mine` and the whole tree read-only at `/opt/shared/all`, giving **write-own / read-all** semantics: an agent writes only its own folder but reads every agent's artifacts (e.g. `/opt/shared/all/mark/report.pdf`). Read-only is kernel-enforced at the mount, so write-isolation holds without relying on file permissions. This channel deliberately **bypasses the policy gateway and the audit log** — it is for working artifacts, not secrets or auditable memory. For an auditable handoff, record a pointer in `viking://shared/approved/<p>/` and keep the blob in `/opt/shared/mine/`. The tree is visible on the Windows host for direct inspection. Private `/opt/data` memory and OpenViking isolation are unaffected. Canonical operational reference: `shared/README.md` (also readable by agents at `/opt/shared/all/README.md`); isolation tradeoff in `docs/08-SECURITY-MODEL.md`.

**Tier A — IronNest Task workflow over shared Hermes Kanban.** Every profile mounts `hermes-platform_kanban-shared` at `/opt/kanban` with `HERMES_KANBAN_HOME=/opt/kanban`. Raw Hermes Kanban is the shared board substrate; IronNest Task is the Mission Control workflow built on top of it. A task can begin as a triage goal, be decomposed by the configured orchestrator, routed to specialists from `registry/profiles-registry.yaml`, run in the assignee's own profile container, and then reviewed through worker logs, artifacts, Reports, Apps, QA, and security gates. Mission Control does not mount or parse the SQLite DB directly; it calls a profile bridge, which performs structured `hermes kanban` CLI actions. Manual execution is routed to the task assignee's own profile container, and auto-dispatch is per-profile opt-in. This channel is not private memory and must remain secret-free; `/opt/data` isolation is unchanged.

**Tier A control plane — Mission Control, Apps, and governed operations.** Mission Control joins `platform-net` for Traefik and profile-bridge traffic plus the internal `mission-control-ops-net` for exact requests to the optional `operations-runner`. It never joins either memory network and never receives the Docker socket. `operations-runner` is the sole Docker-socket holder and accepts only allowlisted, persisted, single-use actions. Octo administration is a single operator-attributed lease opened with an operator-bound WebAuthn assertion, capped at ten minutes and two minutes idle, and limited to explicitly enrolled workloads; protected control-plane and Docker-socket containers remain excluded, while destructive actions require a fresh operation-specific approval. Windows work crosses a separate localhost boundary through the host-bind queue; the default elevated host runner executes locally implemented remediation IDs rather than submitted PowerShell. Agent-authored web Apps are served read-only by `artifact-apps` on `apps.ironnest.local` under a restrictive CSP and separate origin.

**Tier A security tooling — LittleJohn.** The optional `kali-mcp-littlejohn` sidecar is reachable only from LittleJohn over `littlejohn-kali-net`, publishes no host port, and stays off the platform and memory networks. Its separate egress bridge is for approved package/tool traffic. Wazuh access is not direct indexer access and not general internet access: LittleJohn queries the existing IronNest `wazuh-query` read-only broker on `platform-net`.

**Tier A UI sidecar — management terminal/dashboard.** `hermes-platform-ttyd` exposes the browser terminal and Hermes dashboard on `127.0.0.1:8123` and `127.0.0.1:8124`. It mounts `hermes-platform_data-default:/opt/data` plus the other profile volumes under `/opt/data/profiles/<profile>` so the Hermes UI can list and manage profiles in the layout it expects. This sidecar is a trusted management plane; the actual `hermes-pf-*` agent containers still mount ONLY their own profile volume. The legacy `hermes-ttyd` service may still exist during transition on `127.0.0.1:7682` and `127.0.0.1:9119`; those old ports read the legacy shared volume.

**Tier B — the policy kernel.** A single `memory-gateway` container running FastAPI. It is dual-homed on `hermes-platform-app-net` (incoming from Hermes) and `hermes-platform-mem-net` (outgoing to OpenViking). It authenticates incoming requests via a bearer-token map fetched from Infisical, evaluates each request against `policies/<profile>.policy.yaml` (deny-first), audits every decision to a JSONL log, and forwards the request to OpenViking only on `allow`. Adapter logic in `gateway/app/openviking_client.py` translates the logical namespaces (`viking://shared/**`, `viking://profiles/<p>/**`) onto OpenViking's native `viking://resources/` tree.

**Tier C — the memory.** The `openviking` container runs `openviking-server` from upstream `volcengine/OpenViking`. It listens on port 1933 inside `hermes-platform-mem-net`. The container publishes no host ports. The only thing on its network is the memory-gateway.

## One conversation, end to end

```text
Hermes agent
  -> ironnest_gateway.prefetch() inside the same agent container
  -> memory-gateway /memory/search
  -> policy decision + audit
  -> OpenViking search
  -> permitted context returned to Hermes
  -> model answers
  -> ironnest_gateway.sync_turn() inside the same agent container
  -> memory-gateway /memory/write
  -> policy decision + audit
  -> OpenViking persistent workspace
```

`ironnest_gateway` is not another gateway service and it is not a separate container. It is the adapter that makes normal Hermes conversations invoke the policy gateway. See `docs/18-AUTOMATIC-CONVERSATIONAL-MEMORY.md` for startup persistence and validation.

## Why this shape

- **Two internal networks instead of one.** A single internal network would put Hermes containers on the same layer-2 segment as OpenViking, and a buggy gateway (or a future-added container that "just needs OpenViking access") could trivially bypass policy. Splitting the network makes the segregation structural rather than enforced-by-convention.
- **memory-gateway is the only dual-homed service.** Anything else dual-homed creates a second path to OpenViking, which violates I2.
- **Hermes provider, not direct database access.** `ironnest_gateway` runs inside each agent process only to connect Hermes' conversation lifecycle to the gateway API. Policy, isolation, and audit enforcement remain centralized in `memory-gateway`.
- **Per-profile volumes.** Container escape from `hermes-pf-mark` lands in a filesystem where `hermes-pf-steve`'s data is simply not mounted. We pay one-time migration cost for permanent defense in depth.
- **The shared artifact and Task/Kanban volumes are deliberate, scoped exceptions to per-profile isolation.** The collaboration requirement (one agent's output is the next agent's input) needs cross-agent *reads* of binary files, which OpenViking cannot serve (text-only, ~4 MB/entry, not host-accessible). The work-coordination requirement needs a single board and durable task artifacts. We confine those exceptions to `/opt/shared` and `/opt/kanban`, keep `/opt/data` and OpenViking fully isolated, and treat both shared paths as secret-free, non-private working state.
- **Bearer tokens in Infisical, never on disk.** The `with-infisical` wrapper (shared with the Hermes image/tooling lineage) authenticates to Infisical via Universal Auth machine identity, fetches the secrets, and execs the wrapped command with secrets in environment only. Process-tree env vars are wiped on exec.

## File layout summary

See `docs/03-DIRECTORY-STRUCTURE.md` for the full tree. Key directories:

- `gateway/app/` — FastAPI source.
- `policies/` — one `.policy.yaml` per profile.
- `registry/profiles-registry.yaml` — registered profiles.
- `profile-template/` — templates for `scripts/create-profile.sh`.
- `shared/` — host-bind artifact-exchange tree; one folder per profile (write-own / read-all).
- `agent-bridge/` and `mission-control/` — Mission Control chat, settings, and IronNest Task/Kanban control plane.
- `scripts/` — lifecycle + validation shell scripts.
- `openviking/` — Dockerfile + sidecar config for OpenViking.
- `docs/` — this set.
- `spec/` — machine-readable manifests.
