# 08 — Security Model

## Threat model

Threats this design mitigates, in order of concern:

1. **A compromised or buggy hermes-pf-X container reads/writes another profile's private memory.**
2. **A compromised hermes-pf-X container bypasses the policy and writes secrets or chain-of-thought into OpenViking.**
3. **A compromised dependency (OpenViking, embedding provider) exfiltrates data to the Internet.**
4. **A leaked profile bearer token is replayed by an attacker who gains network access to the gateway.**
5. **Operator error widens a policy by editing the wrong file.**
6. **Operator error overwrites a profile's SOUL.md.**

Threats this design does NOT solve (deliberately, for now):

- **Insider with platform-net access** can curl the gateway with a stolen token. Mitigation: token rotation, audit log.
- **Compromised host OS (Windows / WSL2 kernel).** Out of scope; IronNest's outer perimeter (Squid, AdGuard, Wazuh) is the mitigation.
- **Side-channel attacks on the embedding provider.** OpenViking sends queries to the LLM provider; if that provider is compromised, the queries leak. Mitigation: future on-prem embedding models.

## Defense in depth

| Layer | Mechanism | If it fails… |
|---|---|---|
| L0 — IronNest perimeter | Squid egress allowlist, AdGuard DNS, Wazuh SIEM | The platform README covers this. |
| L1 — Network segmentation | `hermes-platform-mem-net` is `internal:true`; only `memory-gateway` joins both mem-net and app-net. | A buggy gateway still couldn't expose OpenViking to other Docker bridges; you'd have to misconfigure compose first. |
| L2 — Bearer-token auth | `Authorization: Bearer <token>` header; constant-time compare against Infisical-loaded map. | An attacker with no token gets 401. |
| L3 — Policy engine | Deny-first evaluation; schema-validated YAML. | A bug here means the gateway over-denies, not over-allows. Allow paths require an explicit glob match. |
| L4 — Per-profile volume isolation | Each `hermes-pf-<p>` mounts ONLY `hermes-platform_data-<p>` at `/opt/data`. | Kernel escape from container A cannot read container B's `/opt/data` because the volume isn't there. (Scoped exceptions: `/opt/shared` for artifacts and `/opt/kanban` for the shared work board; `/opt/data` is not shared.) |
| L5 — `cap_drop: ALL` + `no-new-privileges` | All containers. | Privilege-escalation primitives (e.g. setuid binaries) are neutered. |
| L6 — Audit log | Every memory request, allowed or denied. | Operator can reconstruct what happened post-incident. |
| L7 — Resource limits | `cpus` + `memory` on every service. | One runaway container can't starve the others. |

## Shared artifact exchange — a scoped exception to L4

The collaboration requirement (one agent's binary output is the next agent's
input) needs cross-agent **reads** of files OpenViking cannot hold (binaries,
images, >4 MB). We satisfy it with a host-bind tree mounted into every
`hermes-pf-*`, deliberately narrowing L4 for this one path only:

- Each container mounts its own slice **read-write** at `/opt/shared/mine`
  (host `./shared/<profile>`) and the **whole tree read-only** at
  `/opt/shared/all` (host `./shared`). The `ttyd` operator container mounts the
  whole tree read-write.
- **Write-isolation is preserved.** `read_only` is enforced by the kernel
  mount, so an agent can read every peer's artifacts but write only its own
  folder — it cannot tamper with another agent's output. This does not depend
  on file ownership (Rancher's 9p layer fakes ownership on Windows binds).
- **Read-isolation is intentionally relaxed** for this tree only. A compromised
  agent can read peers' *scratch artifacts*. It still cannot read peers'
  private memory (`/opt/data`) or reach OpenViking.

What we accept by adding this:

1. **No audit trail.** Reads/writes on `/opt/shared` produce no `audit.log`
   entry, unlike every OpenViking operation. This is a second cross-agent
   data channel that the gateway does not see. It is therefore **not** a
   substitute for gateway-mediated memory; use it for working artifacts only.
2. **Host exposure.** The tree is a Windows-host directory
   (`D:\claude-workspace\platform\hermes-platform\shared\`), visible and
   writable outside the container boundary. Do not place secrets there.

Mitigations / discipline: for any handoff that must be auditable, write a
pointer or summary to `viking://shared/approved/<p>/` (audited) and keep the
blob in `/opt/shared/mine/`. New profiles inherit the mounts and an empty
write-own folder automatically via `scripts/provision-profile.sh`.

This section is the threat/tradeoff analysis only. The canonical operational
reference (layout, in-container paths, agent convention, verification) is
`shared/README.md`; the decision record is D-013.

## IronNest Tasks / Shared Kanban — a scoped work-board exception to L4

Every profile mounts `hermes-platform_kanban-shared` at `/opt/kanban` and sets
`HERMES_KANBAN_HOME=/opt/kanban`. This creates one shared Hermes Kanban board
for tasks, workspaces, durable task artifacts, and worker logs across all
profile agents. Hermes Kanban is the board substrate; IronNest Tasks are the
Mission Control workflow layer that adds decomposition, specialist routing,
manual/auto execution controls, Reports, Apps, and operator review.

What is intentionally allowed:

1. **Cross-profile task visibility.** Any profile can see the shared board.
2. **Bridge-mediated board writes.** Mission Control can create, assign, move,
   comment on, archive, decompose, and run tasks through structured bridge
   actions.
3. **Assignee-local execution.** A manual run is routed to the assignee's own
   profile container, so the worker uses that profile's identity and secrets.
4. **Opt-in dispatch.** Auto-dispatch is persisted per profile and is off until
   explicitly enabled.
5. **Specialist routing.** Decomposition may assign code work to Steve,
   security work to Little John, QA/verification to `qa`, platform operations to
   Octo, and review/research to the appropriate profile based on registry
   descriptions.

What remains forbidden:

1. **No secrets in `/opt/kanban`.** It is shared coordination and artifact
   state.
2. **No Mission Control DB mount.** Mission Control must use bridges instead of
   reading or writing the Kanban SQLite file directly.
3. **No weakening `/opt/data`.** SOUL.md, auth files, sessions, and private
   profile state remain isolated per container.

## Secrets handling

All application secrets live in **Infisical**. They are:

- Fetched via Universal Auth machine identity at process start by `/usr/local/bin/with-infisical`.
- Injected as environment variables into the wrapped process only.
- Never written to disk on the gateway or on hermes-pf-* containers.
- Wiped from the wrapper's own env via `unset` before `exec`.

The OpenViking sidecar (`openviking-infisical-agent`) is the **one exception** — it renders `/secrets/.env` to a tmpfs-adjacent named volume because OpenViking's startup reads a config file. The volume is mounted read-only into the openviking container; the agent's writable mount is on a separate path.

## Audit log

`gateway/app/audit.py` writes one JSON line per memory operation. Fields:

```json
{
  "ts": "2026-05-23T12:34:56.789Z",
  "request_id": "<uuid4>",
  "profile":  "mark",
  "operation": "read",
  "uri":     "viking://profiles/steve/notes",
  "decision": "deny",
  "reason":  "matched deny rule for read",
  "matched_rule": "viking://profiles/*/**",
  "remote_addr": "172.30.0.x",
  "latency_ms": 4
}
```

Stored at `/var/log/gateway/audit.log` (on the `hermes-platform_memory-gateway-log` volume) and mirrored to stderr so `monitoring-fluent-bit` → Wazuh ingests it for SIEM analysis.

## Token rotation policy

- Rotate every profile token on a regular cadence (suggested: 90 days).
- Always rotate after a suspected leak.
- `scripts/rotate-profile-token.sh <name>` mints a new token but does NOT call Infisical — operator pastes the new value into two Infisical fields. This is deliberately friction-ful: token rotation should be an audited, intentional act.

## Defense against operator error

- `policies/*.yaml` is schema-validated at gateway startup. Invalid → gateway refuses to boot.
- `registry/profiles-registry.yaml` is schema-validated.
- `scripts/patch-souls.sh` backs up before mutating and only touches the `## OpenViking Memory Policy` section.
- `scripts/delete-profile.sh` requires `--purge-volume` to destroy data.

## Future hardening (extension points)

- **mTLS between hermes-pf-* and memory-gateway** — currently we trust the internal network. Replace bearer-token-only with bearer + mTLS for layered auth.
- **JWT instead of static bearer tokens** — short-lived, scoped JWTs minted by a separate trust-service.
- **Replace Infisical with Vault** — `with-infisical.sh` is the swap point; the rest of the system is provider-agnostic.
- **Per-request scope claims** — a JWT could carry "this request may only access viking://profiles/mark/notes/2026/**" further narrowing beyond the static policy.
