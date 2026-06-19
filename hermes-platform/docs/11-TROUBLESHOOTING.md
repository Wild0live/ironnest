# 11 — Troubleshooting

## Gateway won't start

### `FATAL: MEMORY_GATEWAY_PROFILE_TOKENS_JSON missing from Infisical /hermes-platform/gateway`

Cause: Infisical folder `/hermes-platform/gateway` doesn't have `MEMORY_GATEWAY_PROFILE_TOKENS_JSON`, or the value is empty.

Fix: Set it in Infisical to a JSON object with one key per profile, e.g.:

```json
{"default":"<hex64>","mark":"<hex64>","steve":"<hex64>","qa":"<hex64>","littlejohn":"<hex64>","jaime":"<hex64>","bigbert":"<hex64>","octo":"<hex64>"}
```

Generate hex64 tokens with `openssl rand -hex 32`. Then `docker compose restart memory-gateway`.

### `jsonschema.exceptions.ValidationError` at startup

Cause: a `policies/*.yaml` or `registry/profiles-registry.yaml` violates its schema.

Fix: read the error message — it names the failing property and rule. Common cases:
- Profile name has uppercase or `.` — must match `^[a-z][a-z0-9_-]{0,31}$`.
- A glob rule starts with `viking://something-not-shared-or-profiles/`.

### Container exits with `auth.AuthError: token for profile <X> is too short`

Cause: a token in `MEMORY_GATEWAY_PROFILE_TOKENS_JSON` is < 32 chars. Replace with a fresh `openssl rand -hex 32`.

## openviking won't start

### `openviking-entrypoint: timed out waiting for /secrets/.env`

Cause: the infisical-agent sidecar isn't healthy.

Diag:
```bash
docker logs hermes-platform-openviking-infisical-agent --tail 50
```

Common causes: `INFISICAL_PROJECT_ID` mismatch, Universal Auth creds revoked, Infisical container down.

### `openviking-entrypoint: EMBEDDING_API_KEY missing`

Cause: Infisical `/hermes-platform/openviking` doesn't have `EMBEDDING_API_KEY`. Set it (e.g. to your Volcengine Doubao key).

## hermes-pf-* containers fail healthcheck

### `memory-gateway unreachable from hermes-pf-<name>`

Cause: the start script's smoke test failed. Diag:
```bash
docker exec hermes-pf-mark sh -c \
  'echo "TOKEN=$MEMORY_GATEWAY_TOKEN"; \
   curl -v -H "Authorization: Bearer $MEMORY_GATEWAY_TOKEN" http://memory-gateway:8080/health'
```

Common causes:
- `MEMORY_GATEWAY_TOKEN` is empty → Infisical `/hermes-platform/<name>` doesn't have the key.
- Gateway not on `hermes-platform-app-net` (check `docker network inspect`).
- Token mismatch → see "all 401s in audit log" below.

### `hermes gateway run` exits immediately

Cause: missing per-profile Telegram bot token, or duplicate-poller conflict (see memory note `feedback_hermes_multi_profile_telegram_conflict`).

Diag: `docker logs hermes-pf-mark --tail 80`. If you see `409 Conflict` on Telegram, another container is polling the same bot token — likely an old `hermes-gateway-mark` container from a legacy `hermes/` deployment. Stop the old container and keep the legacy stack down.

### `Provider authentication failed: [Errno 13] Permission denied: '/opt/data/auth.lock'`

Cause: a Hermes command was run inside the profile container as `root`, typically through `docker exec` without `--user 10000:10000`. Hermes can then leave `/opt/data/auth.lock`, `/opt/data/auth.json`, or related auth recovery files owned by root. The normal messaging gateway runs as UID `10000` and cannot read or acquire them. Restart the affected profile after repair so the running gateway reloads provider authentication.

Repair the affected profile:

```bash
bash scripts/repair-auth-lock-permissions.sh mark
```

To inspect and repair all configured profiles after diagnostic work:

```bash
bash scripts/repair-auth-lock-permissions.sh
```

Durable safeguard: since v0.15.0 (s6-overlay), the upstream `docker/stage2-hook.sh` (wired as `/etc/cont-init.d/01-hermes-setup`) repairs ownership of the full `$HERMES_HOME` subtree including `auth*` files on every container start — no separate `hermes-profile-entrypoint.sh` wrapper is needed. The old wrapper has been removed from all compose `entrypoint:` overrides.

Prevention: when executing a Hermes command manually inside a profile container, use the same runtime identity:

```bash
docker exec --user 10000:10000 hermes-pf-mark with-infisical hermes chat -q "test"
```

`scripts/validate-conversational-memory.sh` uses this runtime identity deliberately so it cannot create a root-owned auth lock.

## All requests return 401

Cause: `MEMORY_GATEWAY_PROFILE_TOKENS_JSON` doesn't include the token the client is sending.

Diag inside the offending profile container:
```bash
docker exec hermes-pf-mark sh -c 'echo "${MEMORY_GATEWAY_TOKEN:0:8}…"'
```

Compare with the JSON in Infisical. Often the cause is rotating one place (per-profile folder) and forgetting the other (gateway folder's JSON). Fix: re-paste both, restart `memory-gateway` and `hermes-pf-<name>`.

## All requests return 403

Cause: caller is authenticated but the URI doesn't match any allow rule (and possibly hits a deny rule).

Diag: tail the audit log:
```bash
docker exec hermes-platform-memory-gateway tail -f /var/log/gateway/audit.log
```

Each deny lists the URI and the matched rule. If `matched_rule` is null, no allow matched — check the profile's `policies/<name>.policy.yaml`.

## OpenViking is reachable from hermes-pf-* (BAD)

This is a security regression. The expected `validate-isolation.sh` case `ISO-01` would fail.

Diag:
```bash
docker network inspect hermes-platform-mem-net | jq '.[].Containers'
```

A `hermes-pf-*` container should NOT appear. If it does, someone joined it via `docker network connect` or by editing compose. Remove it:
```bash
docker network disconnect hermes-platform-mem-net hermes-pf-mark
```

Then audit `docker-compose.yml` — the `networks:` list under each `hermes-pf-*` MUST be exactly `[platform-net, hermes-platform-app-net]`.

## Host can't reach 127.0.0.1:18080 (or 8123/8124) even though containers are healthy

Symptom: `curl http://127.0.0.1:18080/health` from Windows times out after ~10s, but `docker exec hermes-pf-default curl http://memory-gateway:8080/health` works.

Cause: **Rancher Desktop host-switch port-forwarder stale state.** RD's port forwarder (PID typically owns `0.0.0.0:N` LISTENING on Windows) caches container-port mappings. After a container is restarted or the network is recreated, the forwarder sometimes keeps a stale entry that accepts SYN but never proxies to the container.

What does NOT fix it:
- `docker compose restart <service>` — only restarts the container, not the forwarder
- `bash ops/fix-nat-prerouting.sh` — fixes iptables, not the forwarder

What DOES fix it (in order of preference):
1. **Wait and retry** — sometimes self-heals after 30-60s
2. **Restart Rancher Desktop** — full forwarder refresh, but briefly stops all running platform containers
3. **Use the in-container path** — `docker exec hermes-pf-default curl http://memory-gateway:8080/...` works regardless of the host forwarder state

Operationally: **the 127.0.0.1:18080 port is admin/diagnostic only**. The actual gateway-to-agent traffic uses internal DNS (`http://memory-gateway:8080` on hermes-platform-app-net), which never depends on the host forwarder. `scripts/healthcheck.sh` verifies both paths and treats a host-port failure as a WARN (not FAIL) because the gateway itself is fine.

## `docker exec ... /opt/path` says "No such file or directory" (Git Bash MSYS path mangling)

Symptom: from Git Bash on Windows,
```
docker exec hermes-pf-mark ls -la /opt/data
ls: cannot access 'C:/Program Files/Git/opt/data': No such file or directory
```

Cause: MSYS converts `/opt/data` → `C:/Program Files/Git/opt/data` BEFORE docker sees it.

Fix: use **double-slash prefix** to defeat conversion:
```
docker exec hermes-pf-mark ls -la //opt/data
```

Same applies to `docker run -v`. For host paths use `cygpath -w "$(pwd)"`. For container paths use `//app`.

Most scripts in `scripts/` avoid this by passing a shell string to `sh -c '...'` — the inner shell does the path lookup, no MSYS interference. Only direct `docker exec <cmd> <path>` calls hit this trap.

## Bearer token works in tests but fails when run via `docker exec` (with-infisical env scope)

Symptom: a hermes-pf-* container is healthy and its startup smoke test (`curl -H "Authorization: Bearer $MEMORY_GATEWAY_TOKEN" ...`) succeeded. But when YOU run:
```
docker exec hermes-pf-mark sh -c 'echo $MEMORY_GATEWAY_TOKEN'
```
it prints nothing — and any auth attempt returns 401.

Cause: `with-infisical` wraps the command via `infisical run -- <cmd>`. The injected env vars are scoped to `<cmd>` and its children only. A fresh `docker exec` spawns a NEW shell that does NOT inherit them. `/proc/1/environ` (PID 1 is now s6-overlay's `/init`, not tini) won't show them either; the right PID to inspect is the wrapped child (usually PID 6 = `infisical run`, PID 41 = the actual `hermes` process).

Fix: wrap your `docker exec` in `with-infisical` too:
```bash
docker exec hermes-pf-mark with-infisical sh -c '
    echo $MEMORY_GATEWAY_TOKEN
    curl -H "Authorization: Bearer $MEMORY_GATEWAY_TOKEN" http://memory-gateway:8080/health
'
```

The validation scripts (`scripts/validate-{isolation,sharing}.sh`) use this pattern in their `gw_call_from()` helper. If you're writing new helpers that need profile tokens, follow that pattern.

## CLI tool inside a container with HTTPS_PROXY can't talk to its own server

Symptom: inside a container with `HTTPS_PROXY=http://squid:3128` set, a CLI like `ollama list` errors with `something went wrong, please see the ollama server logs`. The CLI is trying to reach its own server at `http://0.0.0.0:11434`, which the HTTP client routes through Squid.

Cause: `NO_PROXY` includes `localhost,127.0.0.1` but NOT `0.0.0.0`. Many CLI tools (Ollama in particular) target `0.0.0.0:port` when `OLLAMA_HOST=0.0.0.0:port` is set, so the proxy traps the loopback.

Fix: add `0.0.0.0` to `NO_PROXY` in the container's environment:
```yaml
NO_PROXY: "memory-gateway,openviking,localhost,127.0.0.1,0.0.0.0,.local"
no_proxy: "memory-gateway,openviking,localhost,127.0.0.1,0.0.0.0,.local"
```

Bit us during the GPU-Ollama attempt. Documented in `docs/17-LLM-HANDOFF.md §Q13` too.

## Infisical CLI: "Folder not found" when pushing to a fresh path

Symptom: `infisical secrets set FOO=bar --path=/hermes-platform/gateway` returns:
> `error: unable to process new secret creations ... [message="Folder with path '/hermes-platform/gateway' in environment with slug 'dev' not found"]`

Cause: Infisical CLI does NOT auto-create folders. They must exist first.

Worse: `infisical secrets list --path=/non-existent-folder` returns an EMPTY TABLE (HTTP 200) instead of an error — false positive for "folder exists".

Fix sequence:
```bash
# 1. Explicitly create the folder
infisical secrets folders create --name=gateway --path=/hermes-platform --projectId=$PROJ --env=dev
# 2. THEN push secrets
infisical secrets set "FOO=bar" --path=/hermes-platform/gateway --projectId=$PROJ --env=dev
```

Note `infisical secrets folders create` (not `infisical folders create` — there is no such command in 0.43.76).

The bootstrap script `secrets-runtime/bootstrap-secrets.sh` (when used) creates all 8 required folders first via `ensure_folder()` before pushing the 12 secrets.

## Performance issues

`memory-gateway` is single-process uvicorn. If it's bottlenecked:
- Increase replicas (with sticky audit log path) — requires a Redis-backed `RateLimiter` (extension point).
- Bump `MEMORY_GATEWAY_RATE_CAPACITY` and `MEMORY_GATEWAY_RATE_REFILL_PER_SEC`.

OpenViking is more likely the bottleneck for memory-intensive queries. Check `docker stats hermes-platform-openviking`.

## "I edited the policies but they didn't take effect"

You need to reload:
```bash
TOKEN="$(...your admin token...)"
curl -XPOST -H "Authorization: Bearer $TOKEN" \
    http://127.0.0.1:18080/admin/reload-policies | jq .
```

If you see `error` in the response, the new YAML is invalid; the old policies remain in memory.
