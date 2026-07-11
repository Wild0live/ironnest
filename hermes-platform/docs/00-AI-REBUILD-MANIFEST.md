# 00 — AI Rebuild Manifest

> **Audience:** another AI/LLM agent reconstructing this system from scratch.
> **Read order:** this file → `spec/system.manifest.yaml` → `spec/rebuild-checklist.yaml` → individual `docs/0?-*.md` as referenced.

## What this stack is

`hermes-platform/` is the on-demand Hermes runtime stack alongside IronNest workloads `openclaw/` and `browser-intent/` at `D:\claude-workspace\platform\`. The legacy `hermes/` Compose stack has been removed; `hermes/` is now only the build context for the shared `platform/hermes-agent` image. Hermes Platform provides:

1. **OpenViking** (https://github.com/volcengine/OpenViking) as the long-term context database for AI agents.
2. **Ollama** as the local embedding service for OpenViking (`mxbai-embed-large`).
3. **Memory Gateway** — a FastAPI service that is the ONLY thing allowed to talk to OpenViking. It enforces a deny-first policy from `policies/<profile>.policy.yaml` and audits every request.
4. **Per-profile Hermes containers** — `hermes-pf-<profile>` — one per profile, each mounting its own named volume so no profile's data is reachable from another profile's container.
5. **`ironnest_gateway` Hermes memory provider** — an in-process provider mounted into every `hermes-pf-*` container. It performs automatic recall before answers and stores completed turns afterward by calling Memory Gateway only.
6. **Mission Control** — a standalone FastAPI/browser dashboard at `https://mission.ironnest.local/` for profile health, IronNest Tasks, schedules, chat, file downloads, SOUL.md edits, model switching, and embedded terminal access. It is not part of the memory policy kernel.
7. **Per-profile agent-chat bridges** — small Python stdlib co-processes inside each `hermes-pf-*` container. Mission Control talks to these bridges on `8011/tcp` for live chat, IronNest Task actions, shared Kanban board actions, and profile-local actions without Docker socket access.
8. **Shared Hermes Kanban board** — `hermes-platform_kanban-shared` mounted at `/opt/kanban` in every profile container. It is the substrate for IronNest Tasks: a deliberate cross-profile coordination plane for goals, task state, workspaces, artifacts, and worker logs; keep it secret-free.
9. **IronNest Task workflow** — Mission Control's governed layer over Hermes Kanban. A Task can start as a triage goal, be decomposed by the orchestrator, routed by profile role descriptions, executed by specialist agents such as Steve for code, Little John for security, `qa` for independent verification, and Octo for platform operations, then reviewed through logs, Reports, Apps, and artifacts.
10. **Artifact Apps origin** — a core read-only nginx service at `https://apps.ironnest.local/` that serves task web apps from Kanban artifacts under a restrictive CSP and separate origin from Mission Control.
11. **Governed operations** — optional `operations-runner` is the only Docker-socket holder and accepts exact, persisted, single-use requests over `mission-control-ops-net`. Windows work uses a separate file-backed localhost queue whose default elevated runner executes allowlisted remediation IDs and structured filesystem transactions.
12. **LittleJohn security tooling** — optional Kali MCP is isolated on dedicated LittleJohn/Kali networks with no host port. Wazuh queries go to the existing external read-only `wazuh-query` broker on `platform-net`, not directly to the indexer and not through internet access.

Do not mistake component names: `ironnest_gateway` is the Hermes-side adapter; `memory-gateway` is the policy-enforcing service; OpenViking is the storage/search backend.
Also do not mistake Mission Control for the gateway: Mission Control is an operator UI/control plane, while `memory-gateway` remains the security boundary for all OpenViking memory access.

## Rebuild scope

This bundle reconstructs **Hermes Platform** from the checked-out `platform/` repository. It does not independently recreate the wider IronNest perimeter: Rancher Desktop/WSL2, `platform-net`, `platform-egress`, AdGuard, Squid, Infisical, Traefik/Authelia, Wazuh, and the read-only `wazuh-query` broker are prerequisites created by `platform/bootstrap.sh` and their own stack definitions. A blank-Windows-host rebuild must establish those prerequisites first.

A clean functional rebuild can reproduce containers, networks, policies, and empty persistent volumes. Reproducing the exact live system additionally requires operator-supplied Infisical secrets and backups of named volumes, profile data/SOUL files, Mission Control state, Kanban artifacts, and OpenViking data. Those values are deliberately absent from Git.

Service counts use one definition everywhere: **15 core services** start without Compose profiles; `operations-runner` and `kali-mcp-littlejohn` are the two optional services, for **17 declared services** total.

## Read me first

| File | Purpose |
|---|---|
| `spec/system.manifest.yaml` | Canonical machine-readable manifest. Invariants I1-I11. |
| `spec/services.yaml` | Service list + ports + networks + volumes. |
| `spec/namespaces.yaml` | Logical → OpenViking URI mapping rules. |
| `spec/policies.schema.json` | JSON Schema for `policies/*.policy.yaml`. |
| `spec/registry.schema.json` | JSON Schema for `registry/profiles-registry.yaml`. |
| `spec/profile.schema.json` | Variables substituted into `profile-template/*.template` files. |
| `spec/validation-plan.yaml` | Every isolation/sharing case the validation scripts run. |
| `spec/rebuild-checklist.yaml` | 15 ordered core, migration, validation, and optional-capability steps. |
| `docs/01-ARCHITECTURE.md` | Picture + word description. |
| `docs/08-SECURITY-MODEL.md` | The threat model and why each layer exists. |
| `docs/17-LLM-HANDOFF.md` | Second-person notes to the next AI. |
| `docs/18-AUTOMATIC-CONVERSATIONAL-MEMORY.md` | Provider-to-gateway lifecycle, restart persistence, and proof steps. |

## The single source of truth for "what to do"

`spec/rebuild-checklist.yaml` — 15 steps with `command`, `expects`, and `validates`. Run the core steps in order; run a step with `applies_when` only when that condition is true. Steps marked `manual: true` need a human (Infisical UI, `.env` values).

## Invariants you MUST preserve

These appear in `spec/system.manifest.yaml` and are non-negotiable:

- **I1**  OpenViking publishes NO host ports. It is reachable ONLY from `memory-gateway` via `hermes-platform-mem-net` (internal:true).
- **I2**  Every memory access goes through `memory-gateway`. No hermes-pf-* container has direct access to OpenViking.
- **I3**  Per-profile DATA volumes are NOT shared. `hermes-pf-mark` mounts only `hermes-platform_data-mark` at `/opt/data`. Scoped exception (D-013): the host-bind shared artifact tree at `/opt/shared` IS cross-agent readable by design — own slice rw at `/opt/shared/mine`, whole tree ro at `/opt/shared/all`. This applies to `/opt/shared` ONLY; `/opt/data` isolation is unchanged.
- **I4**  Bearer tokens never appear in this repo. Tokens live in Infisical at `/hermes-platform/`.
- **I5**  SOUL.md content is preserved. `scripts/patch-souls.sh` backs up to `SOUL.md.bak.<epoch>` and only replaces the `## OpenViking Memory Policy` section.
- **I6**  Normal Hermes conversational memory uses `ironnest_gateway` to call `memory-gateway`; connectivity alone is not proof of automatic memory use.
- **I7**  Mission Control stays outside the memory policy kernel: `platform-net` for profile/ingress traffic plus the private `mission-control-ops-net` for exact runner requests; no OpenViking/profile bearer tokens, Infisical machine identity, or Docker socket.
- **I8**  Shared Kanban lives on `/opt/kanban` only. It is cross-profile by design, but it must remain separate from private `/opt/data` volumes and must not be used for secrets.
- **I9**  LittleJohn's Kali MCP is optional, on-demand, has no host port, stays off the memory and shared platform networks, and is reachable only over its dedicated LittleJohn/Kali network. Only its exact start/stop/restart lifecycle is pre-approved.
- **I10**  `operations-runner` is the only Hermes Platform service with Docker socket access. Mission Control and agents submit exact, persisted, single-use operations; they never receive a standing raw Docker API.
- **I11**  Windows host work crosses the localhost boundary through the Mission Control queue. The default elevated runner executes only built-in allowlisted remediation IDs and structured `host_filesystem` transactions for approved profiles; arbitrary submitted PowerShell requires an explicit operator-enabled raw mode.

If a change would violate any invariant, **stop and ask the operator**.

## What you CAN change

- Add new profiles via `scripts/create-profile.sh <name>` (no Python edits required).
- Add policy rules by editing `policies/<profile>.policy.yaml` and calling `POST /admin/reload-policies`.
- Bump pinned image digests (Infisical CLI, base images) in lock-step across the stack.
- Add `tools.yaml` MCP entries per profile (gateway is unaffected).
- Extend `ironnest_gateway` when Hermes lifecycle behavior changes, while keeping all memory operations routed through `memory-gateway`.
- Extend Mission Control UI/API features when they stay on `platform-net` or the narrowly scoped `mission-control-ops-net` and do not require OpenViking/profile bearer secrets or Docker access.
- Extend the Mission Control Task/Kanban surface through bridge-mediated, structured actions. Manual runs must execute in the assignee profile's own container; decomposition must route through the configured orchestrator; auto-dispatch must remain per-profile opt-in.

## What you CANNOT change without an architectural review

- The network topology (mem-net / app-net split).
- The bearer-token-in-Infisical-only rule.
- The deny-first policy evaluation order.
- The per-profile volume isolation.
- The automatic conversation path through `memory-gateway`.
- Mission Control's separation from the memory gateway policy kernel.
- The shared Kanban boundary: cross-profile board/workspace/artifact/log coordination is allowed only through `/opt/kanban`; private profile data stays under isolated `/opt/data`.
- The operations boundary: do not give Mission Control or an agent the Docker socket, and do not expand the runner into a generic command or Docker proxy.
- The Windows host boundary: do not replace the file-backed approval queue and allowlisted remediation runner with direct agent shell access.

## Common mistakes to avoid

1. **DO NOT** add hermes-pf-* containers to `hermes-platform-mem-net`. That would let any hermes container reach OpenViking directly, bypassing policy.
2. **DO NOT** mount more than one `hermes-platform_data-<profile>` volume into a single container. That breaks the per-profile isolation invariant. (The host-bind `/opt/shared` tree is a deliberate, separate channel — see I3 exception — and does NOT count: it never exposes another profile's `/opt/data`.)
3. **DO NOT** put bearer tokens, API keys, or any secret material into `policies/*.yaml`, `registry/*.yaml`, `docker-compose.yml`, or any `*.md.template`. Secrets live in Infisical.
4. **DO NOT** resurrect or edit the legacy `hermes/` Compose stack to "integrate" this one. The old Compose stack was removed; `hermes/` is only the shared image build context now.
5. **DO NOT** call OpenViking directly from a Hermes profile container with `docker exec ... curl http://openviking:1933`. The fact that this fails is *evidence* the architecture is intact; do not "fix" it by joining hermes containers to the mem-net.
6. **DO NOT** treat successful gateway connectivity as proof that ordinary chats use memory. Run `scripts/validate-conversational-memory.sh` and inspect gateway audit events for conversation URIs.
7. **DO NOT** put Mission Control on `hermes-platform-app-net` or `hermes-platform-mem-net` just to make something easier. It should reach profiles through the bridge on `platform-net`, and it should never reach OpenViking directly.
8. **DO NOT** give Mission Control profile bearer tokens, OpenViking root keys, or Infisical machine identity credentials. It reads registry/policy/audit files and owns only its dashboard state.
9. **DO NOT** treat `/opt/kanban` as private storage. It is intentionally shared by all profile agents for Task coordination, artifacts, and worker logs.
10. **DO NOT** mount the Docker socket into Mission Control or any `hermes-pf-*` container. Only `operations-runner` may hold it, behind the private operations network and exact request validation.
11. **DO NOT** run agent-submitted PowerShell on Windows by default. The scoped host runner ignores submitted script bodies and executes only locally implemented remediation IDs or structured filesystem transaction primitives.
