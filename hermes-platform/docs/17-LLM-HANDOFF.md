# 17 — LLM Handoff

> Written second-person to the next AI/LLM agent picking up this stack.

You are walking into a production system. Read this first before you change anything.

## What you're holding

A multi-profile Hermes runtime fronted by a policy-enforcing memory gateway in front of OpenViking. Ordinary agent conversations use the in-process `ironnest_gateway` provider to search and persist memory through that gateway; the provider is not a separate container. The stack lives at `D:\claude-workspace\platform\hermes-platform\` on a Rancher Desktop / WSL2 Windows host. The wider platform is live. Do not break it.

## Read these in this order

1. `docs/00-AI-REBUILD-MANIFEST.md` — the meta-doc.
2. `spec/system.manifest.yaml` — the canonical machine-readable manifest, including invariants I1-I12 you must preserve.
3. `docs/01-ARCHITECTURE.md` — the picture.
4. `docs/08-SECURITY-MODEL.md` — what the design protects against.
5. `docs/16-DECISION-LOG.md` — why each non-obvious choice was made.
6. `docs/18-AUTOMATIC-CONVERSATIONAL-MEMORY.md` — how ordinary chats invoke gateway-backed memory and how to prove it.

## The invariants again

1. OpenViking publishes no host ports.
2. Every memory access goes through the gateway.
3. Per-profile volumes are not shared.
4. Bearer tokens never appear in the repo.
5. SOUL.md content is preserved (always backed up before mutating).
6. Automatic Hermes conversation memory goes through `ironnest_gateway` to `memory-gateway`; gateway reachability alone is not proof of integration.
7. Mission Control stays outside the memory policy kernel: platform-net for profile/ingress traffic plus private mission-control-ops-net for exact runner requests; no OpenViking/profile bearer tokens, Infisical machine identity, or Docker socket.
8. Shared Kanban lives only on `/opt/kanban`; it is cross-profile coordination state, not private memory or a secret store.
9. LittleJohn's Kali MCP is on-demand, has no host port, stays off the memory and shared platform networks, and exposes only its exact lifecycle as pre-approved.
10. Only `operations-runner` may mount the Docker socket; Mission Control and agents submit exact, persisted, single-use operations instead of receiving raw Docker access.
11. Windows host operations use the localhost file queue. The default elevated runner executes only built-in remediation IDs and structured filesystem transactions; raw PowerShell requires an explicit operator override.
12. Octo admin access is a single operator-attributed, ten-minute brokered session over explicitly enrolled workloads. Protected control-plane containers and Docker-socket holders are always excluded; destructive actions require fresh operation-bound FIDO approval.

If a proposed change would violate any of these, **stop and ask the operator**. Don't "improve" the architecture out of these constraints — they are the architecture.

## The single file that knows OpenViking's API

`gateway/app/openviking_client.py` — only this file. If the upstream OpenViking REST surface changes, this is the only file you need to update. The adapter currently encodes documented `ov` CLI behavior into HTTP calls (`GET /entries`, `POST /entries`, etc.) with explicit `# ASSUMPTION:` comments. If you find the real API differs, update the adapter and bump `spec/system.manifest.yaml`'s `manifest_version`.

## Quirks discovered during the live 2026-05-23 deployment

These are NOT in upstream docs. They cost hours during the first deploy. Save yourself the time.

### Q1 — OpenViking's real REST API is `/api/v1/content/*` and `/api/v1/fs/*`

Not `/entries`, `/find`, `/grep`, `/ls`. Initial adapter assumptions were wrong. The truth (verified from `/openapi.json`):

| What | Endpoint |
|---|---|
| Read content | `GET /api/v1/content/read?uri=<native>[&offset=N&limit=N]` |
| Write content | `POST /api/v1/content/write` body `{uri, content, mode, wait?, timeout?}` |
| List directory | `GET /api/v1/fs/ls?uri=<native>` |
| Make directory | `POST /api/v1/fs/mkdir` body `{uri, description?}` |
| Semantic search | `POST /api/v1/search/find` body `{query, target_uri?, limit?}` (note `target_uri` NOT `uri`) |
| Substring search | `POST /api/v1/search/grep` body `{pattern, target_uri?}` (note `pattern` NOT `term`) |
| Health | `GET /health` (not `/status`; not `/`) |

**Always cross-check with `/openapi.json` after any OpenViking version bump.**

### Q2 — OpenViking tenant APIs need `trusted` mode plus identity headers

As of OpenViking 0.4.5, `auth_mode=api_key` no longer permits root API keys to
access `/api/v1/content/*` or `/api/v1/fs/*` tenant-scoped APIs. The error is
**HTTP 403**:

> `ROOT API keys cannot access tenant-scoped data APIs in api_key mode.`

Hermes Platform therefore renders OpenViking with `server.auth_mode="trusted"`
and keeps `server.root_api_key` set. The gateway adapter sends the bearer key
and all three `X-OpenViking-{Account,User,Agent}` headers pinned to
`"default"`. If you want per-profile OpenViking-level tenancy later, set those
headers per caller in the adapter.

### Q3 — `POST /api/v1/content/write` requires the file to already exist (default `mode=replace`)

To create new files: set `mode=create` in the body. To create-or-update (upsert): try create, fall back to replace on conflict. The adapter does this in `write()`. **Without this, every first-time write returns HTTP 404 "File not found".**

### Q4 — OpenViking's `POST /api/v1/fs/mkdir` is **recursive AND idempotent**

Single call creates all ancestor dirs. Calling on an existing dir returns HTTP 200 with the same response (no "already exists" error). The adapter caches successful mkdirs in `_known_dirs` to skip the round-trip on repeated writes to the same subtree.

### Q5 — OpenViking's ov.conf is JSON, not INI

The default config docs showed `[section]` style which suggested INI. The actual loader is `json.loads(os.path.expandvars(open(path).read()))`. Schema:
```json
{
  "storage":   {"workspace": "..."},
  "embedding": {"dense": {"provider", "model", "api_key", "dimension", "api_base"}},
  "vlm":       {...optional...},
  "server":    {"host": "0.0.0.0", "port": 1933, "auth_mode": "trusted", "root_api_key": "..."}
}
```

### Q6 — OpenViking server defaults to **localhost-only**; you MUST set `server.host=0.0.0.0` in ov.conf

Without this, memory-gateway can't reach openviking from another container even when they share a network. The server binds only to 127.0.0.1.

### Q7 — `openviking` PyPI package needs the **`[gemini]` extra** for Gemini, and works for Ollama via OpenAI-compat too

The base `openviking` install doesn't include `google-genai`. The Dockerfile uses `pip install openviking[gemini]`. Even though we ended up using Ollama (via the openai-compatible /v1 endpoint), keeping the extra doesn't hurt.

### Q8 — `with-infisical`-injected env vars are ONLY visible in the wrapped process tree

`docker exec hermes-pf-mark sh -c '... $MEMORY_GATEWAY_TOKEN ...'` returns EMPTY for the token. The `with-infisical` wrapper execs `infisical run -- <cmd>`, so the injected env lives only in `<cmd>` and its children — NOT in fresh shells spawned later by `docker exec`.

**Fix:** wrap your `docker exec` in `with-infisical` too:
```bash
docker exec hermes-pf-mark with-infisical sh -c '... $MEMORY_GATEWAY_TOKEN ...'
```

`/proc/1/environ` does NOT show these vars (PID 1 is s6-overlay's `/init` since v0.15.0 — previously tini). The right PID to inspect is the wrapped child (usually PID 6 or 41 for `hermes gateway run`).

The validation scripts (`scripts/validate-{isolation,sharing}.sh`) already use this pattern.

### Q9 — Git Bash + `docker exec ... /opt/path` mangles the container path

MSYS path conversion sees `/opt/data` and rewrites it to `C:/Program Files/Git/opt/data` BEFORE docker even sees it. Use `//opt/data` (double slash prefix) to defeat conversion. Same applies to `docker run -v` mounts: use `cygpath -w "$(pwd)"` for host side and `//work` for container side.

This bites every script that does `docker exec ... ls /something`. The validation scripts pass shell strings to `sh -c '...'` which avoids it (the inner shell does the path lookup, no MSYS in the path).

### Q10 — Rancher Desktop port forwarder holds stale state

After bouncing a container or restarting the network, the host port-forward (`127.0.0.1:<host>`) sometimes accepts SYN but never proxies to the container — manifests as `curl ... timed out` even though the container is listening internally.

**Fixes (in order):**
1. Wait 30-60s — may self-heal
2. `rdctl shutdown && rdctl start` — restarts RD's port forwarder cleanly, with downtime for all running platform containers
3. Use the in-container path instead — `docker exec hermes-pf-default curl http://memory-gateway:8080/...` always works regardless of host forwarder state

The `scripts/healthcheck.sh` script tests the in-container path (always works) and only warns on the host-port failure. Don't mistake an RD quirk for a hermes-platform bug.

### Q11 — Rancher Desktop's containers cannot reach the Windows host

Even with `extra_hosts: ["host.docker.internal:host-gateway"]` + `platform-egress` membership + Windows Firewall allow rule on port N + `0.0.0.0:N` listen on Windows — container → Windows times out. The `rancher-desktop` WSL2 distro CAN reach Windows (via `172.17.80.1`); containers inside that distro cannot.

Practical impact: **you cannot run a host service (e.g. native GPU Ollama) and have containers reach it.** Containerized services on internal networks work fine. Full diagnosis in §D-010.

### Q12 — Compose YAML anchor (`<<: *anchor`) does NOT deep-merge `environment:`

If your service has `<<: *base` and also re-declares `environment:`, the new `environment:` block REPLACES the anchor's environment entirely — it does NOT merge keys. Fix: split the env into its own anchor (`x-hermes-env-common: &hermes-env-common`) and merge it AT THE MAPPING LEVEL inside each service's environment block:

```yaml
services:
  foo:
    <<: *hermes-pf-base
    environment:
      <<: *hermes-env-common      # this DOES merge
      EXTRA_VAR: "per-service"
```

### Q13 — Infisical CLI 0.43.76 gotchas

| Gotcha | Fix |
|---|---|
| `infisical export --recursive` no longer exists | Use `--include-imports` |
| `infisical folders create` doesn't exist | It's `infisical secrets folders create --name=X --path=/parent` |
| Folders must exist BEFORE `secrets set` (no auto-create) | First mkdir, then push secrets |
| `infisical secrets list /path` returns an empty table on a NON-existent path (false positive for "folder exists") | To check folder existence, use `infisical secrets folders get` |
| `localhost`/`127.0.0.1` work for docker-internal calls, but if HTTPS_PROXY is set you MUST include `0.0.0.0` in NO_PROXY when CLI tools talk to their own server on `0.0.0.0:port` | This bit us with Ollama's CLI — `ollama list` was being proxied through Squid |

### Q14 — `OLLAMA_HOST=0.0.0.0:11434` on Windows needs MACHINE scope (not USER) for services, OR run as user process

Ollama on Windows is **not a Windows service** (it runs from the Start menu / Run-key as the logged-in user). Per-user env var works for it, BUT the running process must be killed + restarted in a shell that has the env var loaded — `Start-Process` inherits CURRENT-process env, not the persisted User-scope env.

Reliable sequence:
```powershell
Get-Process ollama* | Stop-Process -Force
$env:OLLAMA_HOST = "0.0.0.0:11434"   # explicit in current shell
[Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "User")  # persist
Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
```

### Q15 — Default-deny is implicit in the policy engine; do NOT write blanket denies

If you put `deny: ["viking://profiles/*/**"]` in a policy thinking the allow re-permits self, you'll break own-namespace access. Deny ALWAYS wins. Default-deny is automatic — only list `allow:` rules. See `docs/16-DECISION-LOG.md §D-009`.

### Q16 — `scripts/_common.sh` provides a `list_profiles()` helper

Read-only scripts (`validate-*.sh`, `backup-souls.sh`, etc.) don't require `yq` on the host. The helper falls back to listing `policies/*.policy.yaml` basenames when yq is absent. Profile-mutating scripts (`create-profile.sh`, `delete-profile.sh`) still need yq.

### Q17 — `hermes-platform-ttyd` is intentionally a cross-profile management plane

The ttyd/dashboard sidecar mounts every profile volume so the operator UI can manage them. This does not relax agent isolation: each `hermes-pf-*` runtime still mounts only its own `/opt/data`. Direct ports `127.0.0.1:8123` and `127.0.0.1:8124` are localhost-only management escape hatches; routed access is behind Authelia. Do not add ttyd to either memory network and do not run `hermes gateway run` from its shell.

### Q18 — Mission Control reaches profiles through bridges, not memory or Docker authority

Mission Control calls each profile's token-gated bridge on `8011/tcp` over `platform-net`. It may join only the private `mission-control-ops-net` for exact operations-runner requests. Keep it off `hermes-platform-app-net` and `hermes-platform-mem-net`, and do not give it profile memory tokens, OpenViking credentials, Infisical machine identity, or the Docker socket.

### Q19 — Agent bridge prompt timeout is 900 seconds and is loaded at process start

`agent-chat-bridge.py` defaults `AGENT_BRIDGE_TIMEOUT` to 900 seconds so long security/tool turns can complete. Initialization and idle defaults remain 150 and 900 seconds. The bridge source is bind-mounted, so changed bytes appear immediately inside every container, but an already-running Python process retains the old constant until that bridge or profile container restarts. Do not mistake mounted-source truth for live-process truth.

---

## Common dangerous edges (don't trip these)

### Edge 1 — Volume name collision with the legacy hermes/ stack

The legacy `hermes/` stack used `hermes_hermes-data` (Compose project name `hermes`, volume name `hermes-data`). Hermes Platform uses `hermes-platform_data-<profile>`. Different prefixes. Do NOT rename anything that would collide.

### Edge 2 — Per-profile `.env` shadows Infisical

Memory note `project_hermes_profile_env_shadow_bug` documents that `/opt/data/profiles/<p>/.env` won over Infisical-injected secrets in the legacy `hermes/` stack. In `hermes-platform/`, each profile's volume contains `/opt/data/` (no `profiles/<p>/` subdir), so the same `.env` shadow bug applies if you create `/opt/data/.env` — don't.

### Edge 3 — Telegram bot 409 Conflict

If you start the new `hermes-pf-mark` while the old `hermes-gateway-mark` is still running with the same bot token, both will poll `getUpdates` and Telegram returns 409. Memory note `feedback_hermes_multi_profile_telegram_conflict`. Stop the old one first.

### Edge 4 — `hermes` CLI caches MCP tools/list

Memory note `feedback_hermes_mcp_tools_cache`: after any change to MCP tool surface, restart the consuming Hermes container. Cache is per-connection.

### Edge 5 — Squid blocks `pip install openviking` if PyPI is on a blocklist

If `openviking/Dockerfile` build fails fetching the package, check Squid's blocklist isn't blackholing pypi.org. The build runs WITHOUT Squid (Docker BuildKit) so this should not happen, but if you ever switch to a build-time HTTP_PROXY, you need pypi.org allowed.

### Edge 6 — Git Bash + Docker MSYS path mangling

Memory note `feedback_git_bash_docker_msys`. When running `docker run` from Git Bash with `-v` mounts that look like absolute paths, MSYS converts them. Use `cygpath -w` for host paths or `//app` for container paths. All `scripts/*.sh` are written to work in Git Bash; if you add new commands, test them there.

### Edge 7 — `RD settings.json` is immutable

Memory note `feedback_rd_settings_json_immutable`. Don't hand-edit Rancher Desktop's settings file. If something needs to change there, use the GUI or `rdctl set`.

## What to do FIRST after picking this up

```bash
cd D:\claude-workspace\platform\hermes-platform
bash scripts/healthcheck.sh        # confirm baseline
bash scripts/validate-conversational-memory.sh # confirm automatic Hermes memory wiring
bash scripts/validate-isolation.sh # confirm security model holds
bash scripts/validate-sharing.sh   # confirm collaboration path works
```

If all green, you're free to make changes. If not, fix the regressions before adding anything new.

## What to do BEFORE you ship a change

1. Re-run the four scripts above. All must pass.
2. If you changed a policy/registry schema, re-validate every existing policy file: `python -c "import json,yaml,jsonschema; ..."`.
3. If you changed the gateway code, add a test case under `gateway/tests/` (you'll need to create the directory).
4. Document any new assumption in `docs/16-DECISION-LOG.md` as a new D-NNN entry.
5. Bump `docs/15-CHANGELOG.md`.

## What to NEVER do

- Add a new container to `hermes-platform-mem-net` other than `openviking` and `memory-gateway`.
- Replace `ironnest_gateway` with direct OpenViking access, or remove its startup selection without providing an equivalent gateway-backed Hermes lifecycle provider.
- Mount more than one `hermes-platform_data-<profile>` volume into a single container.
- Write a bearer token, API key, or Telegram token into ANY file in the repo.
- Delete a `SOUL.md.bak.<epoch>` file.
- `docker compose down -v` without explicit operator approval — this destroys data volumes.
- Edit the live `hermes/` stack to "save effort." The two stacks are siblings by design.

## Final note

The operator who built this is iterative and asks "are you sure?" a lot. If you propose a destructive change, expect to be asked to defend it. Lead with the security/correctness reasoning, not the "elegance" reasoning.
