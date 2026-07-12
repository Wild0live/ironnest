# 15 — Changelog

All notable changes to hermes-platform. Format follows Keep a Changelog 1.1.0.

## [Unreleased] - 2026-07-11

### Added
- **FIDO-gated Octo just-in-time administration** now provides one globally active, non-renewable session with a ten-minute hard limit and two-minute idle limit. Individually attributed operators open the session with an operator-bound WebAuthn credential requiring PIN/biometric verification. Octo can stream root-command output and run validated Docker lifecycle/factory operations only for explicitly enrolled, non-protected containers; destructive container/volume/network actions still require a fresh operation-specific FIDO approval.
- **LittleJohn Kali MCP sidecar** added as optional on-demand service `kali-mcp-littlejohn` (`--profile kali`). It uses the community `k3nn3dy-ai/kali-mcp` SSE server pinned at commit `d46b46bd23f9801b63fc3d16253b5af07b653ec9`, publishes no host ports, mounts persistent `/work`, maps `/reports` to `./shared/littlejohn/kali`, and is reachable only from LittleJohn over `littlejohn-kali-net`.
- **Pre-approved LittleJohn lifecycle lane** for the exact actions `start`, `stop`, and `restart` on `kali-mcp-littlejohn`. Other Docker, host, network, mount, image, and privileged changes remain approval-gated.
- **LittleJohn Kali tool baseline** now includes Nmap, Masscan, Amass, theHarvester, ffuf, OWASP ZAP, sqlmap, Nikto, XSStrike, Metasploit Framework, Hydra, John the Ripper, Nuclei, GVM/OpenVAS packages, Lynis, YARA, Volatility 3, and Autopsy. GVM/OpenVAS is installed but still requires runtime scanner/feed initialization before full scanner use.
- **Scoped Windows remediation runner** added as the default local host-operation consumer. It accepts only built-in remediation IDs (currently `cis-windows-top5-v1`), ignores agent-submitted script bodies during execution, and keeps raw PowerShell behind the explicit `HOST_OPERATIONS_ALLOW_RAW_POWERSHELL=1` operator override.
- **Two-step Windows filesystem transaction lane** added for `default` (Dr. Smith), `littlejohn`, and `octo`. Approved `prepare` requests can list/read files and stage write/mkdir/delete/copy/move operations; a separate approved `commit` request applies only a previously prepared transaction. No Hermes container receives a host bind mount, reusable host credential, or raw admin shell. Dr. Smith and Little John can create read-only prepare requests directly from Mission Control chat with `/hostfs list ...` or `/hostfs read ...`.
- **Mission Control task artifacts** now include browsable trees, individual downloads, ZIP export, Reports, and sandboxed Apps served from the separate `artifact-apps` origin.
- **Missed-cron catch-up** added through `scripts/catch-up-missed-cron.sh` and Mission Control's cron catch-up endpoint so overdue schedules can run once after the stack returns.

### Changed
- Mission Control now revalidates its browser cookie directly with Authelia for administrative APIs instead of trusting network-originated `Remote-*` headers. Existing unbound approval credentials must be re-enrolled under their individual Authelia operator accounts.
- The shared `socket-proxy` is read-only again: unauthenticated start/stop/restart on `platform-net` is disabled so agents cannot bypass Mission Control's FIDO/session boundary.
- **Profile `wifey` renamed to `qa`** (QA/verification specialist; repurposed from the former home/household persona). Container `hermes-pf-wifey` → `hermes-pf-qa`, named volume `hermes-platform_data-wifey` → `hermes-platform_data-qa` (data migrated), policy `wifey.policy.yaml` → `qa.policy.yaml`, Infisical path `/hermes-platform/wifey` → `/hermes-platform/qa`. Registry `description` rewritten for QA routing.
- **Hermes Agent upgraded to v0.17.0** (NousResearch tag `v2026.6.19`), with all profile and ttyd consumers pinned to `platform/hermes-agent:v2026.6.19-patched`.
- Kanban decompose routing now reads declarative `description` fields from `registry/profiles-registry.yaml` (schema-validated) and materializes them into the orchestrator roster via the idempotent `scripts/sync-orchestrator-roster.sh` (wired into `start.sh`).
- Kanban decompose bridge now surfaces structured `ok:false` decomposer results as Mission Control errors instead of wrapping them as a successful bridge response.
- Mission Control goal archiving now cascades across the full linked effort, and goal drawers include a safe "Delete goal from active board" action that archives the goal plus linked subtasks while preserving task history.
- `scripts/_common.sh` now resolves Rancher Desktop's Windows `docker.exe` from both Git Bash and WSL-style shells, so validation scripts do not fall back to an unusable Unix Docker socket.
- `security/egress-proxy` now initializes Squid's UFS cache on startup and uses a foreground-process healthcheck, restoring proxy health after cache/entrypoint restarts.
- Approval-gated operations now preserve exact Docker request shapes, replay protection, and a private `mission-control-ops-net`; LittleJohn's only automatic exception remains lifecycle control of `kali-mcp-littlejohn`.

### Notes
- `hermes-pf-octo` (platform-ops, added 2026-06-12) post-provisioning gaps — kanban volume/env wiring and in-gateway dispatch — and gateway auth are now resolved (the "octo auth still pending" note in the 2026-06-13 entry is superseded). Live profile lineup is now **8**: `default`, `mark`, `steve`, `qa`, `littlejohn`, `jaime`, `bigbert`, `octo`.

## [Unreleased] - 2026-06-13

### Changed
- **Hermes Agent upgraded v0.15.2 → v0.16.0** ("The Surface Release", NousResearch tag `v2026.5.29.2` → `v2026.6.5`). New image `platform/hermes-agent:v2026.6.5-patched`; old `v2026.5.29.2-patched` retained for rollback. All 9 image consumers recreated (8 `hermes-pf-*` profiles + `hermes-platform-ttyd` dashboard); infra containers untouched.
- On first boot under v0.16.0, each profile's persisted `config.yaml` was migrated in place by the image's new `stage2-hook.sh` → `docker_config_migrate.py` (schema 22→27, or 0→27 for minimal configs), which writes its own `config.yaml.bak-*` / `.env.bak-*` alongside. Bypass with `HERMES_SKIP_CONFIG_MIGRATION=1`.
- Dashboard now serves the v0.16.0 web bundle (full browser admin panel). Still fronted by Authelia/Traefik; `hermes dashboard --insecure` unchanged.
- Codex/OAuth compatibility preserved: openai SDK still pinned `2.24.0`, so the `_responses.py` codex-null-output patch applies identically (verified at build).
- Version tags bumped across `hermes/Dockerfile`, `hermes-platform/{docker-compose.yml,build.sh,start.sh}`, `services.d/*.yml`, `scripts/provision-profile.sh`, and `spec/*`.

### Notes
- Pre-existing (not upgrade-caused) warnings confirmed benign and left as-is: `hermes-pf-jaime` 401s against `browser_intent` (its `config.yaml` references the Dr. Smith token it doesn't hold); `hermes-pf-octo` logs "No user allowlists configured" (octo auth still pending).

## [Unreleased] - 2026-06-12

### Added
- **Shared Mission Control Kanban board** wired through `hermes-platform_kanban-shared` at `/opt/kanban` in every profile container. Mission Control now treats Kanban as the shared work board instead of only local dashboard tasks.
- **Bridge-mediated Kanban API**: `agent-chat-bridge.py` exposes structured `/kanban` actions backed by whitelisted `hermes kanban` CLI calls, while Mission Control exposes `/api/kanban*` routes for list/show/create/move/assign/comment/archive.
- **Bounded execution controls**: manual `run` routes work to the task assignee's own profile container, decomposition runs through a configurable orchestrator profile, and per-profile auto-dispatch is opt-in with a small persisted concurrency cap.
- Manifest invariant **I8**: `/opt/kanban` is an intentional cross-profile coordination plane, separate from private `/opt/data` and secret-free by rule.

### Changed
- `spec/services.yaml`, `docs/00-AI-REBUILD-MANIFEST.md`, `docs/02-SERVICES.md`, and `README.md` now describe Mission Control as chat plus shared Kanban, not just chat/tasks/settings.

## [Unreleased] - 2026-06-09

### Added
- **Mission Control browser control plane** documentation/spec refresh. `hermes-platform-mission-control` is now tracked as a first-class service: standalone FastAPI app on `platform-net`, routed at `https://mission.ironnest.local/`, with its own `mission-control-state` volume and read-only access to registry, policies, and gateway audit log.
- **Per-profile agent-chat bridge** documented as part of each `hermes-pf-*` runtime. The bridge listens on `8011/tcp`, is token-gated by `MISSION_CONTROL_BRIDGE_TOKEN`, drives a warm persistent `hermes acp` process, supports SSE token streaming, file upload/download, conversation reset, SOUL.md edits, model switching, and lazy role summaries.
- **Ollama service inventory** added to `spec/services.yaml` and `docs/02-SERVICES.md` as the local embedding service for OpenViking (`mxbai-embed-large`).
- Manifest invariant **I7**: Mission Control is an operator UI/control plane, not the memory policy kernel; it must stay off `hermes-platform-app-net` and `hermes-platform-mem-net`.

### Changed
- `spec/services.yaml` now mirrors the current 13-container Compose stack and current Hermes image tag `platform/hermes-agent:v2026.5.29.2-patched`.
- `docs/00-AI-REBUILD-MANIFEST.md` no longer describes `hermes/` as an active sibling stack; it now notes that legacy `hermes/` is only the shared image build context.
- `spec/system.manifest.yaml` dependencies now include `ollama/ollama:0.4.6` and the current Hermes image tag.
- `build.sh`, `start.sh`, and `scripts/healthcheck.sh` now include Mission Control, Ollama, the current Hermes image tag, and the profile bridge health path.
- `scripts/provision-profile.sh` and the existing dynamic profile fragments now emit/use the current profile service shape: no legacy `tini` entrypoint override, current Hermes image, `HERMES_GATEWAY_NO_SUPERVISE=1`, Mission Control bridge mount/startup, and 2 CPU / 768 MB profile limits.

## [Unreleased] - 2026-06-07

### Added
- **Shared artifact-exchange volume** for cross-agent binary/file handoff (D-013). Host-bind tree `./shared` mounted into every `hermes-pf-*`: own slice read-write at `/opt/shared/mine`, whole tree read-only at `/opt/shared/all` (write-own / read-all). `hermes-platform-ttyd` mounts it read-write. Host-visible at `D:\claude-workspace\platform\hermes-platform\shared\`; **not** audited (use for working artifacts, not secrets).
- `shared/README.md` documenting the convention; per-profile `.gitkeep`; `.gitignore` rule ignoring runtime artifacts.
- "Shared Artifact Exchange" stanza added to `profile-template/SOUL.md.template` (new profiles) and appended to the 7 existing profiles' `SOUL.md`.

### Changed
- `scripts/provision-profile.sh` now creates the per-profile `shared/<name>` folder and emits the two `/opt/shared` mounts in both the fragment template and the runbook paste-block, so new profiles inherit the channel automatically.
- Manifest invariant **I3** scoped to `/opt/data` (the `/opt/shared` tree is cross-agent readable by design); docs 01/02/03/08 updated.

## [Unreleased] - 2026-05-31

### Changed
- **Hermes Agent upgraded to v0.15.2** (NousResearch tag `v2026.5.29.2`). Image: `platform/hermes-agent:v2026.5.29.2-patched`.
- **s6-overlay replaces tini as PID 1** (breaking change in v0.15.0). `docker/entrypoint.sh` is now a deprecated shim; `ENTRYPOINT` is `/init + main-wrapper.sh`. Privilege drop uses `s6-setuidgid` instead of `gosu`. Node.js bumped 20 → 22 LTS (Node 20 EOL April 2026).
- **Removed all `entrypoint:` overrides** from `docker-compose.yml` (`x-hermes-pf-base`) and `services.d/hermes-pf-jaime.yml`, `services.d/hermes-pf-bigbert.yml`. The old `["/usr/bin/tini", "-g", "--", "sh", "/opt/ironnest/hermes-profile-entrypoint.sh"]` pattern caused exit 127 (`s6-setuidgid: not found`) because the shim runs stage2 bootstrap but does NOT exec CMD.
- Ownership repair of `/opt/data/auth*` is now handled by upstream `docker/stage2-hook.sh` via s6-overlay `cont-init.d/01-hermes-setup` on every container start — `hermes-profile-entrypoint.sh` wrapper no longer needed.
- **`HERMES_GATEWAY_NO_SUPERVISE=1`** added to `x-hermes-env-common` and both `services.d/*.yml` files. In v0.15.0+, `hermes gateway run` defaults to signalling s6 and exiting (not foreground) — this env var restores foreground Docker behavior required for IronNest's one-process-per-container model.
- s6-rc.d, `02-reconcile-profiles`, and `015-supervise-perms` are **not installed** in the IronNest image. Upstream s6-rc.d auto-starts a supervised `main-hermes` gateway without Infisical secrets; `02-reconcile-profiles` creates s6-log daemons that lock per-profile log files (conflict on shared volumes). The `HERMES_GATEWAY_NO_SUPERVISE=1` + CMD approach is the correct substitute.

## [Unreleased] - 2026-05-25

### Added
- `ironnest_gateway`, an in-process Hermes `MemoryProvider` mounted into every profile agent and selected at startup, enabling automatic pre-answer private recall and post-answer conversation persistence through `memory-gateway`.
- `scripts/validate-conversational-memory.sh` to prove provider discovery and automatic lifecycle read/write for every running profile.
- `docs/18-AUTOMATIC-CONVERSATIONAL-MEMORY.md` as the AI/operator guide to component roles, restart persistence, call flow, and verification.

### Updated
- Documentation and machine-readable manifests now cover all seven enabled profiles (`default`, `mark`, `steve`, `wifey`, `littlejohn`, `jaime`, `bigbert`) and invariant I6 for automatic gateway-backed conversation memory.
- Runtime validation proved Wifey real recall and Big Bert provider lifecycle memory access; Big Bert still requires an inference credential for a model-generated chat test.
- `scripts/validate-conversational-memory.sh` now runs inside profiles as UID/GID `10000` to avoid creating root-owned Hermes auth files; `scripts/repair-auth-lock-permissions.sh` repairs affected live profiles.
- `hermes-profile-entrypoint.sh` now repairs any top-level `auth*` ownership before Hermes drops privileges, and is mounted into existing and newly provisioned profile services for restart-safe recovery.

## [0.1.0] — 2026-05-23

### Added
- Initial release of the hermes-platform stack.
- `openviking` container running `openviking-server` from `pip install openviking`.
- `openviking-infisical-agent` sidecar that renders `/secrets/.env` from Infisical `/hermes-platform/openviking`.
- `memory-gateway` FastAPI service with deny-first policy engine.
- 5 seeded profiles: default, mark, steve, wifey, littlejohn.
- Per-profile named volumes (`hermes-platform_data-<profile>`).
- Network segmentation: `hermes-platform-mem-net` + `hermes-platform-app-net` (both `internal:true`).
- 11 lifecycle/validation shell scripts under `scripts/`.
- Full doc set under `docs/` (17 files) + machine-readable specs under `spec/` (8 files).
- `scripts/patch-souls.sh` — idempotent SOUL.md patching with auto-backup.
- `scripts/migrate-from-shared-volume.sh` — one-shot migration from `hermes_hermes-data` with SHA-256 verification.

### Security
- Bearer-token auth + admin shared secret, both fetched from Infisical at process start.
- Audit log written to `/var/log/gateway/audit.log` + stderr.
- Per-profile token bucket rate limiting.
- Network-level guarantee that OpenViking is unreachable from any hermes-pf-* container.

### Tests (added Phase 1b)
- **178 pytest cases** under `gateway/tests/`, runtime <1 second.
  - `test_namespace.py` (40 cases): URI parsing happy/sad + glob matching.
  - `test_policy.py` (105 cases): end-to-end policy decisions for every (profile × access × other-profile) combo.
  - `test_openviking_client.py` (11 cases): namespace translation round-trips + dry-run.
  - `test_auth.py` (9 cases): bearer-token rules + admin gate.
  - `test_integration.py` (11 cases): FastAPI TestClient end-to-end (lifespan + routes + auth + policy).
- Both Docker images verified to build successfully from a cold cache:
  - `platform/hermes-platform-memory-gateway:0.1.0` (1.51 GB)
  - `platform/hermes-platform-openviking:0.1.0` (1.35 GB)

### Documentation hardening pass (2026-05-23, post-deployment)

Updated 7 doc files + 1 spec file with everything learned during the live deploy. The goal: next AI/operator picking this up should not repeat any of the dead-ends we hit. Specifically:

- **`docs/04-CONFIGURATION.md`** — added Infisical CLI gotchas (folder-must-exist-first, `--include-imports` not `--recursive`, `secrets list` false-positive on missing path) + operational secret-rotation workflow with MI role flip.
- **`docs/05-OPENVIKING-MEMORY-MODEL.md`** — corrected the entire HTTP API surface (`/api/v1/content/*` and `/api/v1/fs/*`, NOT `/entries`/`/find`/etc), documented required `X-OpenViking-{Account,User,Agent}` tenant headers for ROOT calls, write `mode=create` vs `mode=replace` semantics, recursive idempotent mkdir, `server.host=0.0.0.0` requirement, JSON-not-INI config format, `[gemini]` extra requirement.
- **`docs/09-DEPLOYMENT-RUNBOOK.md`** — rewritten as 8 explicit steps matching the path that actually worked: env → Infisical setup (incl. folder creation + MI role) → build → start → validate → MI downgrade → re-verify → health.
- **`docs/11-TROUBLESHOOTING.md`** — added 4 new sections: Git Bash MSYS path mangling on `docker exec`, `with-infisical` env-scope confusion, `NO_PROXY` must include `0.0.0.0`, Infisical "Folder not found" + the related folder-existence false positive. Plus the existing RD port-forwarder section.
- **`docs/12-OPERATIONS-RUNBOOK.md`** — added Rancher Desktop full-restart recovery procedure and `hermes-platform-ttyd` operational guide (open URLs, rotate password without leaking, the "do NOT run `hermes gateway run` from ttyd shell" warning).
- **`docs/16-DECISION-LOG.md`** — added D-011 documenting the ttyd management-sidecar trust boundary (intentional cross-profile filesystem access at the mgmt plane; agent containers remain isolated).
- **`docs/17-LLM-HANDOFF.md`** — added a "Quirks discovered during live 2026-05-23 deployment" section with 16 numbered quirks (Q1–Q16) — every gotcha we hit, with cause + fix. Most valuable doc for the next AI agent.
- **`spec/system.manifest.yaml`** — added a machine-readable `known_quirks` block (Q1–Q17) mirroring the LLM-HANDOFF prose. AI agents can grep this for the area they're touching before making changes.

### Post-Phase 1 follow-ups

- **Task #16 (Ollama GPU enablement) — closed as wontfix.** Native Windows Ollama works and uses the GTX 1650, but Rancher Desktop's WSL2 container networking blocks docker containers from reaching the Windows host. The dockerized Ollama on CPU continues to serve. See `docs/16-DECISION-LOG.md §D-010` for the full investigation.

- **Task #17 (OpenViking adapter: auto-create parent dirs on write) — done.** `gateway/app/openviking_client.py:write()` now (a) idempotently `mkdir`s the parent dir (OpenViking's mkdir is recursive — single call creates all ancestors), (b) tries `mode=create`, (c) falls back to `mode=replace` if the URI already exists. Per-instance `_known_dirs` cache skips the mkdir round-trip on repeat writes. Smoke-tested 2026-05-23 with a 4-level-fresh URI (`viking://shared/approved/mark/auto-mkdir-<ts>/nested/deep/note.md`) and a re-write to verify the create→replace fallback. Both succeeded with `written_bytes` and `content_updated` confirmed; subsequent read returned the updated content.

- **Task #18 (rotate all deployment tokens) — done by operator.** The bearer tokens, admin token, OpenViking root API key, and Gemini key that appeared in the deployment transcript have been rotated.

- **Task #19 (downgrade Machine Identity role) — done by operator.** `hermes-platform-machine` in Infisical is back to Viewer (read-only). Runtime continues to fetch secrets without write privilege.

- **New: `hermes-platform-ttyd` management sidecar (added by operator).** Browser terminal + Hermes dashboard on `127.0.0.1:8123` (ttyd) and `127.0.0.1:8124` (dashboard). Mounts `hermes-platform_data-default:/opt/data` plus the four other profile volumes under `/opt/data/profiles/<profile>` so the Hermes UI can manage all profiles from one place. Trust note: this sidecar is an admin/management plane and intentionally sees multiple profile volumes; the actual `hermes-pf-*` runtime containers remain volume-isolated. Docs: `docs/01-ARCHITECTURE.md §"Tier A UI sidecar"`, `docs/02-SERVICES.md`, `spec/services.yaml`.

### Bug fixed pre-release (caught by tests)
- The initial 5 policies contained a blanket `deny: ["viking://profiles/*/**"]` rule meant as a "safety net" for cross-profile access. Smoke testing showed it also matched the profile's OWN namespace, and deny-first evaluation correctly returned deny — so `mark` lost access to `viking://profiles/mark/notes`. **Fix:** removed the blanket denies; default-deny is implicit. Documented in `docs/16-DECISION-LOG.md §D-009`.

### Known issues
- `scripts/seed-memory.sh` is a placeholder (the gateway doesn't yet expose an admin write endpoint).
- The OpenViking adapter (`gateway/app/openviking_client.py`) documents API assumptions because the upstream HTTP surface isn't fully specified at time of writing. The Python SDK is bundled as a fallback.
- Image sizes are large (~1.4 GB each) because the openviking PyPI package pulls litellm, tree-sitter (10 languages), opentelemetry, mcp, volcengine-sdk, etc. Multi-stage slim builds are an extension point.

### Reference upstreams pinned this release
- `volcengine/OpenViking` — installed via `pip install openviking` (no version pin yet; bump `OPENVIKING_VERSION` ARG in `openviking/Dockerfile`).
- `NousResearch/hermes-agent` v2026.5.7 — reused via existing `platform/hermes-agent:v2026.5.7-patched`.
- `infisical/cli@sha256:dba406b35e5819632412c561bfa46e6185e04c6d76175dc82bf97c4ff53745d7`
- `python:3.13.1-slim-bookworm`
