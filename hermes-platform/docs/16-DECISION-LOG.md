# 16 — Decision Log

Architectural choices made during the design of hermes-platform v0.1.0. Each entry has a date, the decision, the alternatives considered, and the rationale.

---

## D-018 — Host filesystem access uses two-step transactions, not mounts

**Date:** 2026-07-11
**Status:** accepted

**Decision:** Allow only `default` (Dr. Smith), `littlejohn`, and `octo` to
submit Windows host filesystem transaction proposals. Mission Control stores
each proposal in the existing approvals ledger and writes approved work to the
localhost queue as `host_filesystem`. The local scoped runner supports
`prepare` transactions for read/list evidence and staged changes, and separate
`commit` transactions that apply only a previously prepared request. Containers
do not receive host bind mounts, raw shell access, or reusable host credentials.

**Rationale:** The operator wants broad local-folder reach gated by a hardware
key touch, but direct host mounts or raw administrator shell access would
violate the host boundary. A two-step transaction keeps the privileged action
local and inspectable: the first approval gathers evidence and stages bytes,
while the second approval is the moment files are changed. The runner rejects
UNC/device/ADS paths and Windows reparse points to avoid unexpected escape
through symlinks, junctions, or mount points.

**Impacts:** `mission-control/app/main.py`,
`local-host-runner/scoped-remediation-runner.py`,
`agent-bridge/request-host-filesystem.py`, `docker-compose.yml`,
`services.d/hermes-pf-octo.yml`, and
`docs/19-APPROVAL-GATED-OPERATIONS.md`.

---

## D-017 — Windows host remediation defaults to local allowlisted implementations

**Date:** 2026-07-11
**Status:** accepted

**Decision:** Keep the Windows host outside every agent and container trust
boundary. Mission Control persists reviewed host-operation requests to a
localhost file queue. The default elevated Windows consumer is
`local-host-runner/scoped-remediation-runner.py`, which accepts only built-in
remediation IDs and executes local implementations. The submitted PowerShell is
retained for operator review but is not executed. Raw PowerShell remains an
exceptional operator-led mode enabled only by
`HOST_OPERATIONS_ALLOW_RAW_POWERSHELL=1` when starting the runner.

**Rationale:** The operator needs approved host remediation without turning an
LLM request into arbitrary administrator code execution. A local allowlist keeps
the privileged implementation inspectable, versioned, and independent of the
agent-supplied request body while preserving Mission Control's audit trail.

**Impacts:** `local-host-runner/scoped-remediation-runner.py`,
`local-host-runner/start-queue-runner.ps1`,
`agent-bridge/request-host-operation.py`, and
`docs/19-APPROVAL-GATED-OPERATIONS.md`.

---

## D-016 — LittleJohn gets an on-demand Kali MCP sidecar, not host or Docker control

**Date:** 2026-07-03
**Status:** accepted

**Decision:** Add `kali-mcp-littlejohn` as an optional on-demand Kali Linux MCP
sidecar for the LittleJohn profile. The sidecar uses the community
`k3nn3dy-ai/kali-mcp` SSE MCP server pinned at commit
`d46b46bd23f9801b63fc3d16253b5af07b653ec9`. It publishes no host ports, does
not join `hermes-platform-mem-net` or `platform-net`, and is reachable by
LittleJohn over the dedicated `littlejohn-kali-net` network. It also joins
`littlejohn-kali-egress-net` for runtime package/tool egress without making its
MCP port visible to the profile fleet on `platform-net` or the shared
infrastructure egress network.

LittleJohn may administer Kali inside the container and may start, stop, or
restart the exact `kali-mcp-littlejohn` container through a pre-approved Mission
Control operations path. Docker API calls, image changes, mounts, host ports,
network changes, privileged mode, and host PowerShell remain approval-gated.

**Persistence model:** `/work` is a named volume for assessment artifacts and
state. `/reports` maps to `./shared/littlejohn/kali` for visible report handoff.
Package installs during a running session are allowed but treated as disposable
runtime state; useful tools should be promoted into the image by reviewed
change. The default assessment posture is lab-only; IronNest-internal or
external targets require an explicit assessment record.

**Alternatives considered:**
- A1: Install Kali tools directly in `hermes-pf-littlejohn`. Rejected because it
  bloats the profile runtime and makes rollback/audit harder.
- A2: Give LittleJohn raw Docker or host control. Rejected because it violates
  the existing operations-runner trust boundary.
- A3: Publish the MCP port on `127.0.0.1`. Rejected as unnecessary host
  management surface; LittleJohn can reach the sidecar over Docker DNS.
- A4: Use Kali's official `mcp-kali-server` package first. Deferred because its
  documented shape is a terminal API server plus local MCP bridge, while the
  community SSE server directly matches the separate-container MCP requirement.

**Rationale:** The operator wanted LittleJohn to have full control of Kali while
keeping host, Docker, and network boundary changes approval-gated. A sidecar
keeps the high-risk tool surface isolated and off by default while preserving
IronNest's localhost-only posture and OpenViking/memory-gateway invariants.

---

## D-001 — Build as a sibling stack, not by extending `hermes/`

**Date:** 2026-05-23
**Status:** accepted

**Decision:** Create `D:\claude-workspace\platform\hermes-platform\` as a new on-demand stack. Do not modify any file in `hermes/`.

**Alternatives:**
- A1: Extend `hermes/docker-compose.yml` with `openviking` + `memory-gateway` services; add policy section to existing SOUL.md files in `hermes_hermes-data`.
- A2: Build a fully greenfield reference architecture outside `platform/` with no IronNest integration.

**Rationale:** A1 risks the running production stack on every edit. A2 throws away IronNest's actual security perimeter (Squid, AdGuard, Infisical) — those layers are *the* security, not optional. Sibling stack lets us stage, validate, then cut over.

---

## D-002 — Initial 5 live profiles seeded (default, mark, steve, wifey, littlejohn)

**Date:** 2026-05-23
**Status:** accepted

**Decision:** docker-compose.yml ships 5 `hermes-pf-*` services that match the 5 profiles currently running in the existing `hermes/` stack.

**Alternatives:**
- A1: Only the 4 profiles named in the request spec (excludes littlejohn).
- A2: Dynamic-only — no seeded profiles; operator runs `scripts/create-profile.sh` for each.

**Rationale:** A1 is config drift — the spec was stale. A2 leaves docker-compose.yml functionally inert at first boot, which is operationally hostile. Seeded + dynamic is both honest about the current state AND extensible.

**Subsequent deployment state:** Dynamic provisioning later added `jaime` and `bigbert`; there are now seven enabled profiles. This decision records the initial seeded baseline, not the current registry size.

---

## D-003 — Per-profile named volumes (not a shared volume)

**Date:** 2026-05-23
**Status:** accepted

**Decision:** Each `hermes-pf-<profile>` container mounts its own `hermes-platform_data-<profile>` volume at `/opt/data`. No volume is mounted into more than one profile container.

**Alternatives:**
- A1: Reuse the existing shared `hermes_hermes-data` volume; isolation enforced only at the gateway layer.
- A2: Hybrid — new agent containers on isolated volumes alongside the existing shared-volume gateways.

**Rationale:** Volume sharing means a single container escape reads every profile's SOUL.md and session files. Volume isolation is a structural defense-in-depth layer that holds even if the gateway has a bug. The one-time migration cost (`scripts/migrate-from-shared-volume.sh`) is worth it.

---

## D-004 — Map logical namespaces onto `viking://resources/`

**Date:** 2026-05-23
**Status:** accepted

**Decision:** The gateway exposes `viking://shared/**` and `viking://profiles/<p>/**` as the only logical top-levels, mapped onto OpenViking's native `viking://resources/shared/**` and `viking://resources/profiles/<p>/**`. The native `viking://user/` and `viking://agent/` trees are not exposed.

**Alternatives:**
- A1: Use OpenViking's native semantics directly — shared → resources/, profiles/<p> → agent/<p>/, plus user/ for the human.
- A2: Treat OpenViking as an opaque key-value store; gateway owns the entire namespace tree under one prefix.

**Rationale:** A1 fights OpenViking's intended design — `viking://agent/` isn't multi-tenant and we'd have to gateway-enforce sub-paths anyway. A2 discards the semantic-retrieval value of OpenViking's tree structure. The chosen mapping stays inside OpenViking's documented surface and isolates the translation in one file (`gateway/app/openviking_client.py`).

---

## D-005 — Two internal Docker networks (mem-net + app-net) instead of one

**Date:** 2026-05-23
**Status:** accepted

**Decision:** `hermes-platform-mem-net` (`internal:true`, holds only openviking + memory-gateway) and `hermes-platform-app-net` (`internal:true`, holds memory-gateway + all hermes-pf-*). Memory-gateway is the only dual-homed service.

**Alternative:** Single internal network with everyone joined; rely on gateway policy + bearer-token auth.

**Rationale:** Two networks makes the OpenViking-isolation invariant **structural**. A future container that "just needs OpenViking access" cannot accidentally bypass policy — it would have to be explicitly added to the mem-net, and that change is visible in compose review. This catches operator-error and supply-chain-attack vectors that a single network would not.

---

## D-006 — Bearer tokens in Infisical, never in repo / not JWT (yet)

**Date:** 2026-05-23
**Status:** accepted

**Decision:** Static 64-char-hex bearer tokens per profile, stored in Infisical at `/hermes-platform/gateway → MEMORY_GATEWAY_PROFILE_TOKENS_JSON` and per-profile at `/hermes-platform/<p> → MEMORY_GATEWAY_TOKEN`. Constant-time compare in `gateway/app/auth.py`.

**Alternatives:**
- A1: JWT minted by a separate trust service.
- A2: mTLS instead of bearer tokens.

**Rationale:** JWT adds infrastructure (key rotation, issuer service) we don't yet need for a 5-profile stack. mTLS is a strong second factor but doubles the secrets-management overhead. Static bearers + rotation procedure + audit log is the minimum-viable secure path. Documented upgrade route in `docs/08-SECURITY-MODEL.md §"Future hardening"`.

---

## D-007 — Reuse `platform/hermes-agent` image (shared with legacy hermes stack)

**Date:** 2026-05-23 | **Updated:** 2026-05-31 (v0.15.2 upgrade); 2026-06-13 (v0.16.0 upgrade)
**Status:** accepted

**Current image:** `platform/hermes-agent:v2026.6.19-patched` (Hermes Agent v0.17.0)

**Decision:** The `hermes-pf-*` services use the existing Hermes image built by `hermes/build.sh`. No new Hermes Dockerfile.

**Upgrade note (v0.15.0):** Hermes switched from `tini + gosu` to s6-overlay as PID 1. All `entrypoint:` overrides (`["/usr/bin/tini", "-g", "--", "sh", "/opt/ironnest/hermes-profile-entrypoint.sh"]`) were removed from `docker-compose.yml` and every `services.d/*.yml` fragment. The old wrapper's ownership-repair logic is now handled by s6-overlay's `cont-init.d/01-hermes-setup`. On future upgrades, check for init-system changes before keeping entrypoint overrides.

**Alternative:** Build a hermes-platform-specific Hermes image with built-in `MEMORY_GATEWAY_URL` defaults.

**Rationale:** The differences are all per-container env vars (`HERMES_PROFILE`, `MEMORY_GATEWAY_URL`, `MEMORY_GATEWAY_TOKEN`). A separate image would duplicate ~20 min of build time and create a version-skew risk between the two stacks during cutover.

---

## D-011 — `hermes-platform-ttyd` is a management-plane sidecar with cross-profile filesystem access

**Date:** 2026-05-23
**Status:** accepted

**Decision:** A separate container `hermes-platform-ttyd` provides the browser terminal (ttyd on `127.0.0.1:8123`) and Hermes dashboard (on `127.0.0.1:8124`). It mounts:
- `hermes-platform_data-default` at `/opt/data` (default profile's data lives at the volume root, matching the legacy Hermes layout)
- `hermes-platform_data-{mark,steve,wifey,littlejohn}` at `/opt/data/profiles/<profile>` (each at the volume root, mounted into the legacy multi-profile path the Hermes UI expects)
- Browser-intent shared inbox/outbox volumes (`/opt/uploads-in:ro` + `/opt/uploads-out`)

The sidecar is on `platform-net + ingress` only (NOT on `hermes-platform-mem-net` or `hermes-platform-app-net`). It does NOT run `hermes gateway run` — only `hermes dashboard` + `ttyd` shell.

**Why this is acceptable despite breaking I3 at the management plane:**

Invariant I3 (per-profile volume isolation) was designed for the AGENT containers (`hermes-pf-*`). Those still mount ONLY their own profile volume — the kernel-level isolation holds. The management plane intentionally has read-write access to all profile volumes because that's its job: a Hermes UI operator needs to inspect SOUL.md, browse sessions, etc. across profiles.

**Trust boundary:**
- The routed ttyd/dashboard URLs are auth-gated by Authelia's FIDO/WebAuthn middleware. ttyd Basic Auth is disabled because Authelia consumes the `Authorization` header; stacking Basic Auth behind it breaks access.
- Anyone who reaches the ttyd management plane gets full multi-profile filesystem access — but NOT memory-gateway namespace bypass (the gateway still enforces per-bearer-token policy on every API call, regardless of who's connected to ttyd).
- Direct loopback ports `127.0.0.1:8123` and `127.0.0.1:8124` remain management escape hatches. Treat local host access as privileged.

**Alternatives considered:**
- A1: One ttyd container per profile, each mounting only its own volume. Pros: pure I3 preservation. Cons: 5 separate UI URLs to bookmark; no cross-profile UI flows.
- A2: No ttyd at all; operators use `docker exec` into individual hermes-pf-* containers. Pros: simplest. Cons: poor UX for the human operator; no browser-based access.

**Why the chosen approach:** matches the legacy `hermes/hermes-ttyd` UX pattern (which is what users are already trained on), centralizes the management plane to one URL, and the kernel-level isolation that matters most (agent ↔ agent) is preserved.

**Concurrent-write caveat:** the ttyd mounts the same `hermes-platform-data-default` volume as `hermes-pf-default`. Hermes uses SQLite WAL + file locks for `state.db`, `gateway.lock` etc., so single-writer/multi-reader access works. The risk case is a user running `hermes gateway run` from the ttyd shell, which would create a competing Telegram poller (409 Conflict against `hermes-pf-default`). Mitigation: shell motd warns against it; future enhancement could chroot the ttyd shell or wrap `hermes` with a guard.

---

## D-010 — Ollama runs containerized (CPU), not native Windows GPU

**Date:** 2026-05-23
**Status:** accepted (after live attempt)

**Decision:** The Ollama embedding service runs as a Docker container on `hermes-platform-mem-net` (CPU-only), not natively on the Windows host (with GPU access via the GTX 1650).

**What we tried:**
1. Installed Ollama for Windows (https://ollama.com/download/windows) and pulled `mxbai-embed-large` — Ollama on Windows correctly uses the GPU (verified via `nvidia-smi`).
2. Set `OLLAMA_HOST=0.0.0.0:11434` and added a Windows Firewall inbound rule for TCP 11434 from `172.16.0.0/12,192.168.0.0/16`.
3. Added `extra_hosts: ["host.docker.internal:host-gateway"]` and `platform-egress` membership to openviking so it could reach Windows.

**Why it failed:** Rancher Desktop on Windows uses a nested networking model where the `rancher-desktop` WSL2 distro can reach the Windows host (via `172.17.80.1`), but **docker containers inside that distro cannot**. The packet path container → docker0 NAT → WSL2 eth0 → Windows host gets dropped at the Hyper-V firewall layer, even with permissive Windows Defender Firewall rules. Verified by: (a) fresh `alpine` container on `platform-egress` also timed out reaching `172.17.80.1:11434`; (b) `rancher-desktop` WSL2 distro on the same IP/port returned data instantly.

**Alternatives considered:**
- A1: Install NVIDIA Container Toolkit in the `rancher-desktop` distro — distro is locked down (`nvidia-smi` returned `Permission denied`, `/dev/nvidia*` absent). High effort, fragile across RD upgrades.
- A2: TCP relay container forwarding container traffic to Windows — adds a fragile dependency.
- A3: Migrate the platform off Rancher Desktop to Docker Desktop — out of scope.

**Cost of the chosen path:** ~5-10s cold + ~1-2s warm embedding latency vs ~700ms on GPU. For a 5-profile personal stack with sporadic memory writes, this is acceptable.

**The native Windows Ollama install is NOT wasted** — it's available for non-containerized callers (Cursor, PowerShell `ollama run`, etc.).

**Re-evaluation triggers:** revisit this if (a) hermes-platform ingest workload outgrows CPU embeddings (large corpus imports), or (b) the IronNest platform migrates to Docker Desktop or a Linux host with native GPU passthrough.

---

## D-009 — Default-deny is implicit; explicit deny is for narrower exclusions only

**Date:** 2026-05-23
**Status:** accepted (after smoke-test caught the bug)

**Decision:** Policy files list only `allow:` rules under each operation. A URI that matches no allow rule is denied. The `deny:` block is reserved for cases where an allow is intentionally over-broad and a narrower carve-out is wanted (e.g. `allow viking://shared/**` but `deny viking://shared/security/incidents/**`).

**Bug found in v0.1.0-draft:** the initial design had policies include a "blanket deny" line like `deny: ["viking://profiles/*/**"]` with an inline comment "the allow above re-permits this profile's own." The first smoke test against the policy engine showed this was a logical contradiction: `viking://profiles/*/**` matches `viking://profiles/mark/notes`, and in the deny-first evaluator deny wins over allow — so `mark` lost access to its own private namespace.

**Alternatives considered:**
- A1: Change evaluation to "allow-overrides-deny when both match." Rejected — inverts a safe security default.
- A2: Add glob negation (`viking://profiles/!mark/**`). Rejected — added grammar complexity for a marginal use case.
- A3: List every other profile's namespace explicitly in each deny block. Rejected — breaks every time a new profile is created.

**Rationale for the chosen approach:** matches the AWS IAM convention's correct usage (rare explicit denies for narrow carve-outs; broad coverage from default-deny). Keeps policies short and obviously correct.

---

## D-008 — `with-infisical` wrapper for gateway + hermes containers; sidecar for OpenViking

**Date:** 2026-05-23
**Status:** accepted

**Decision:** Memory gateway + all hermes-pf-* containers use the in-process `with-infisical` wrapper (same pattern as the legacy `hermes/` stack). OpenViking uses an infisical-agent sidecar that renders to `/secrets/.env`.

**Rationale:** OpenViking's startup reads a config file (it needs to write `[embedding]` API keys to disk to start the server). The wrapper pattern is process-env-only; for OpenViking we need file-on-disk, which is the sidecar's job. This pattern split matches IronNest's existing convention (memory note `project_rancher_openclaw`).

---

## D-011 — Platform UI gets its own ttyd/dashboard sidecar

**Date:** 2026-05-23
**Status:** accepted

**Decision:** Add `hermes-platform-ttyd` as the browser terminal and Hermes dashboard sidecar for the platform. It mounts `hermes-platform_data-default` at `/opt/data` and the other profile volumes under `/opt/data/profiles/<profile>`, not the legacy shared `hermes_hermes-data` volume, and publishes fresh local ports `127.0.0.1:8123` (ttyd) and `127.0.0.1:8124` (dashboard).

**Alternatives:**
- A1: Repoint the existing legacy `hermes-ttyd` container directly to the new platform volume.
- A2: Publish the platform UI on the old `127.0.0.1:7682` and `127.0.0.1:9119` ports immediately.

**Rationale:** A1 mutates the old stack and weakens rollback. A2 was tested live, but Rancher Desktop's existing port-forward entries for those old ports kept hanging when another container tried to take them over. Fresh ports verified cleanly while preserving the old UI as a fallback during transition.

**Trust implication:** This sidecar is a management plane and can see all platform profile volumes. This does not weaken the runtime profile isolation invariant because no `hermes-pf-*` agent container receives another profile's volume.

---

## D-012 — Hermes automatic memory uses an in-process provider that calls the policy gateway

**Date:** 2026-05-25
**Status:** accepted and deployed

**Decision:** Mount the `ironnest_gateway` Hermes `MemoryProvider` into every `hermes-pf-*` profile container and select it as `memory.provider` at startup. The provider maps Hermes conversation lifecycle hooks to `memory-gateway` operations: pre-answer private recall, post-answer redacted turn persistence, and explicit memory tools.

**What this is not:** `ironnest_gateway` is not a second policy service and is not a container. It does not reach OpenViking directly. `memory-gateway` remains the sole policy, audit, namespace, and OpenViking access boundary.

**Why this was required:** Before this provider, gateway connectivity proved only that an agent could issue a memory request. It did not prove that an ordinary Hermes conversation automatically recalled prior context or stored its completed turn. Hermes requires a runtime `MemoryProvider` to initiate those lifecycle calls.

**Persistence:** The provider source is read-only mounted from the stack directory and selected again by each container startup command. Stored turns are in the persistent OpenViking workspace through the gateway, so both wiring and memories survive normal container restarts and recreations.

**Verification:** `scripts/validate-conversational-memory.sh` passes for all seven profiles. A real Wifey follow-up chat successfully recalled a phrase saved during an earlier chat. Big Bert passes provider lifecycle storage/recall through the gateway; a live model-generated chat additionally requires its inference-provider credential.

---

## D-013 — Shared host-bind artifact volume for cross-agent binary handoff (scoped exception to D-003)

**Date:** 2026-06-07
**Status:** accepted (files committed; deploy = `up -d` recreate)

**Decision:** Add a host-bind tree at `./shared` (host `D:\claude-workspace\platform\hermes-platform\shared\`) mounted into every `hermes-pf-*` container: its own slice **read-write** at `/opt/shared/mine` and the whole tree **read-only** at `/opt/shared/all` (write-own / read-all). `hermes-platform-ttyd` mounts the whole tree read-write for operator housekeeping. New profiles inherit the mounts and an empty write-own folder via `scripts/provision-profile.sh`.

**Driver:** Collaboration requirement — one agent's generated output (files, images, PDFs, arbitrary binaries) is the next agent's input. Agents need to *read each other's* binary artifacts.

**Alternatives:**
- A1: Use OpenViking `viking://shared` (already audited, read-all/write-own at the policy layer). **Rejected:** OpenViking is a text/knowledge context DB — ~4 MB/entry, binaries explicitly out of scope, and it is not accessible from the Windows host. Fails both hard requirements (binary artifacts + host visibility).
- A2: One flat shared mount, read-write for all (no filesystem isolation). **Rejected:** any agent could overwrite/delete a peer's folder; discards write-isolation entirely.
- A3: Per-agent subpath, write-own with no cross-read. **Rejected:** satisfies isolation but blocks the collaboration requirement (no cross-agent reads).
- A4 (chosen): Hybrid write-own + read-all, host-bind.

**Relationship to D-003:** D-003 said "no volume is shared across profiles" — that decision stands for **`/opt/data`** (private memory). D-013 is a deliberate, *scoped* exception confined to a dedicated scratch tree at `/opt/shared`. `/opt/data` and OpenViking isolation are unchanged.

**Rationale & cost accepted:** `read_only` is kernel-enforced, so write-isolation holds (an agent reads peers but writes only its own folder) without relying on file ownership — important because Rancher's 9p Windows bind fakes ownership and needs no chown for UID 10000. The accepted cost: this is a **second cross-agent channel that bypasses the gateway audit log**, so it is not a substitute for gateway-mediated memory and must not hold secrets. For auditable handoffs, record a pointer in `viking://shared/approved/<p>/` and keep the blob in `/opt/shared/mine/`.

**Impacts:** `docker-compose.yml` (5 static profiles + ttyd), `services.d/hermes-pf-{jaime,bigbert}.yml`, `scripts/provision-profile.sh`, `profile-template/SOUL.md.template`, `shared/README.md`, `.gitignore`. Manifest invariant I3 updated to scope it to `/opt/data`. Existing 7 profiles' `SOUL.md` taught the convention via a one-off append loop.

---

## D-014 — Mission Control stays outside the memory policy kernel

**Date:** 2026-06-09
**Status:** accepted

**Decision:** Keep `hermes-platform-mission-control` as a standalone FastAPI/browser dashboard on `platform-net` only. It reads registry, policies, and gateway audit log read-only; owns only `hermes-platform_mission-control-state`; and talks to profile agents through their in-container `agent-chat-bridge.py` listeners on `8011/tcp`. It is not part of `memory-gateway`, does not join `hermes-platform-app-net` or `hermes-platform-mem-net`, and receives no OpenViking key, profile memory bearer token, Infisical machine identity credential, or Docker socket.

**Subsequent state (2026-07-11):** D-014's “platform-net only” language now means no memory-network membership. Mission Control also joins the private `mission-control-ops-net` solely to submit exact requests to `operations-runner`; it still receives no Docker socket and does not join either memory network.

**What Mission Control can do:**
- Show profile roster, policy-loaded state, recent memory audit activity, tasks, schedules, docs, team, and office views.
- Chat with any profile from the browser through `POST /api/agent/{profile}/chat` and `/chat/stream`.
- Store local per-profile conversation history in its own state volume.
- Proxy hardened file downloads from a profile's `/opt/data/.mission-control-uploads`.
- Edit a profile's SOUL.md and model by asking that profile's bridge to perform the write as the `hermes` user, then reset the warm ACP process.
- Embed the `hermes-platform-ttyd` terminal via Traefik's `frame-mission` middleware.

**Alternatives considered:**
- A1: Fold Mission Control into `memory-gateway`. Rejected because the gateway is the security-critical policy kernel; adding UI state, chat proxying, file download logic, and static assets would widen the trusted codebase.
- A2: Give Mission Control direct access to `hermes-platform-app-net` and call `memory-gateway` or profile internals there. Rejected because platform-net plus per-profile bridges is enough, and app-net membership would blur the profile/gateway boundary.
- A3: Let Mission Control use Docker socket or `docker exec` to reach profile containers. Rejected outright; IronNest's zero raw socket principle applies here too.

**Rationale:** The operator needs a rich browser control plane, but the memory boundary should stay small and easy to reason about. The bridge design gives Mission Control profile-local powers without global container powers: each bridge runs inside its own `hermes-pf-*` container as that profile's user, uses that profile's auth/config/memory, serializes turns, and can only see that profile's `/opt/data` plus the deliberate `/opt/shared` artifact channel.

**Security notes:**
- `MISSION_CONTROL_BRIDGE_TOKEN` is the shared secret between Mission Control and the bridges. If unset, the network/FIDO boundary is the only gate; production should set it.
- Mission Control administrative write APIs revalidate the browser cookie directly with Authelia. `MISSION_CONTROL_ADMIN_TOKEN`, when configured, is an additional gate rather than an alternative identity boundary.
- File downloads are basename-only and revalidated both in Mission Control and the bridge, with a realpath prefix check under `/opt/data/.mission-control-uploads`.
- SOUL.md and model edits reset the profile's warm ACP process so the next turn reloads config.

**Impacts:** `mission-control/app/main.py`, `mission-control/app/static/*`, `agent-bridge/agent-chat-bridge.py`, `docker-compose.yml`, `docs/02-SERVICES.md`, `spec/services.yaml`, `spec/system.manifest.yaml` invariant I7.

---

## D-015 — Shared Kanban is the work coordination plane, not private memory

**Date:** 2026-06-12
**Status:** accepted

**Decision:** Mount `hermes-platform_kanban-shared` at `/opt/kanban` in every Hermes profile container and point `HERMES_KANBAN_HOME` there. Mission Control reads and writes the board only through the per-profile bridge's structured `/kanban` endpoint, which shells whitelisted `hermes kanban` CLI operations without raw argv passthrough.

**Execution model:**
- Board list/show/create/move/assign/comment/archive are pure Kanban CLI operations and do not take the profile chat turn lock.
- Manual `run` first reads the task through the board gateway, then routes execution to the task assignee's own bridge so the worker runs in that profile's container, with that profile's secrets, identity, and filesystem.
- `decompose` runs through a configured orchestrator profile and creates assigned child tasks on the shared board.
- Auto-dispatch is per-profile opt-in, persisted in `/opt/data/.mc-autodispatch.json`, and capped to a small per-profile concurrency limit.

**Rationale:** Mission Control needs a shared work board for multi-agent coordination, but that should not punch through profile private volumes or the memory policy gateway. A dedicated `/opt/kanban` volume makes the sharing explicit and auditable by architecture review: it is shared work state, while `/opt/data` remains private profile state.

**Security notes:**
- `/opt/kanban` is deliberately cross-profile and must remain secret-free.
- The Mission Control container still does not mount the Kanban DB directly; it uses the bridges.
- Auto-dispatch is inert until enabled per profile. Sensitive profiles can remain human-approval-only.

**Impacts:** `docker-compose.yml`, `services.d/hermes-pf-{jaime,bigbert}.yml`, `agent-bridge/agent-chat-bridge.py`, `mission-control/app/main.py`, `mission-control/app/static/*`, `docs/02-SERVICES.md`, `spec/services.yaml`, `spec/system.manifest.yaml` invariant I8.

---

## D-019 — Octo administration is a short-lived brokered capability, never standing Docker authority

**Date:** 2026-07-11
**Status:** accepted

**Decision:** Extend Mission Control and `operations-runner` with exactly one active Octo admin session. An individually identified Authelia operator opens it with an operator-bound WebAuthn assertion requiring user verification. The runner enforces a ten-minute hard expiry, while Mission Control adds a two-minute idle expiry. Octo keeps only its proposal credential and never receives the runner token or Docker socket.

Eligible workload administration includes streamed root exec and validated non-destructive Docker lifecycle/factory actions. Existing workloads are enrolled by an exact operator-maintained list or the `io.ironnest.octo-admin=eligible` label; new workloads default to denied. The `io.ironnest.security-boundary=protected` label, an exact protected-name list, and Docker-socket mount detection override eligibility. Container deletion, kill, and factory volume/network deletion remain on the exact operation-bound FIDO approval path.

**Identity boundary:** Mission Control is reachable internally for scoped agent proposals, so forwarded `Remote-User` headers alone are not authoritative. Administrative endpoints revalidate the browser cookie directly with Authelia and use the returned immutable subject for credential ownership and audit attribution. Legacy credentials without an operator subject are intentionally unusable until re-enrolled.

**Rejected alternatives:** raw Docker socket access in Octo, unrestricted socket-proxy writes, privileged Octo, and shared root credentials. Each would let an agent bypass FIDO, alter the approver/audit plane, or escape to the Rancher Desktop host.

**Impacts:** `mission-control/app/main.py`, `mission-control/app/static/*`, `operations-runner/app/main.py`, `authored-skills/octo/devops/approval-gated-operations`, `docker-compose.yml`, `security/socket-proxy/docker-compose.yml`, and manifest invariant I12.
