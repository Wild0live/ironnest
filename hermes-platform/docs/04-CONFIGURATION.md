# 04 — Configuration

## Where each setting lives

| Setting | Lives in | Read by |
|---|---|---|
| Infisical machine-identity client-id/secret | `./.env` (gitignored) | `with-infisical.sh` |
| Infisical project ID | `./.env` (`HERMES_PLATFORM_INFISICAL_PROJECT_ID`) | `docker-compose.yml` |
| Per-profile bearer tokens | Infisical `/hermes-platform/gateway → MEMORY_GATEWAY_PROFILE_TOKENS_JSON` | `gateway/app/auth.py` |
| Per-profile token (client side) | Infisical `/hermes-platform/<profile> → MEMORY_GATEWAY_TOKEN` | `hermes-pf-<profile>` container env |
| Admin shared secret | Infisical `/hermes-platform/gateway → MEMORY_GATEWAY_ADMIN_TOKEN` | `gateway/app/auth.py` |
| OpenViking provider API keys (embedding/VLM) | Infisical `/hermes-platform/openviking → EMBEDDING_API_KEY`, `VLM_API_KEY`, … | `openviking/ov.conf.template` via envsubst |
| Telegram bot tokens | Infisical `/hermes-platform/<profile> → TELEGRAM_BOT_TOKEN` (imports `/hermes-platform`) | Hermes agent runtime |
| LLM provider keys (OpenRouter, etc.) | Infisical `/hermes-platform → OPENROUTER_API_KEY`, … | Imported by per-profile folders |
| Policies | `policies/*.policy.yaml` | `gateway/app/policy_loader.py` |
| Profile registry | `registry/profiles-registry.yaml` | `gateway/app/registry.py` |
| Namespace map | `spec/namespaces.yaml` | `gateway/app/openviking_client.py` |
| Logging | `gateway/app/logging.json` | uvicorn |
| Healthcheck endpoints | Dockerfiles + compose `healthcheck:` blocks | Docker |
| Resource limits | `docker-compose.yml deploy.resources.limits` | Docker |

## .env (gitignored) — initial setup

Copy `.env.example` to `.env` and fill in three values:

```
INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=<from Infisical UI → Machine Identity>
INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=<from Infisical UI>
INFISICAL_PROJECT_ID=<Infisical Project Settings → Project ID>
HERMES_PLATFORM_INFISICAL_PROJECT_ID=<same as above>
```

`HERMES_PLATFORM_INFISICAL_PROJECT_ID` is the alias the compose `?` operator uses (`${HERMES_PLATFORM_INFISICAL_PROJECT_ID:?missing…}`) — set it equal to `INFISICAL_PROJECT_ID`.

## Infisical layout (required folders and keys)

```
/hermes-platform/                          (shared keys, imported by sub-folders)
    OPENROUTER_API_KEY
    GEMINI_API_KEY
    TELEGRAM_ALLOWED_USERS                 (or wherever shared keys live)

/hermes-platform/openviking/
    EMBEDDING_API_KEY                      required
    EMBEDDING_PROVIDER                     optional (default: volcengine)
    EMBEDDING_MODEL                        optional
    EMBEDDING_DIMENSION                    optional
    EMBEDDING_API_BASE                     optional
    VLM_API_KEY                            optional (omit → [vlm] section dropped)
    VLM_PROVIDER, VLM_MODEL, VLM_API_BASE  optional

/hermes-platform/gateway/
    MEMORY_GATEWAY_PROFILE_TOKENS_JSON     required, JSON object
                                           {"default":"<hex64>","mark":"<hex64>",
                                            "steve":"<hex64>","qa":"<hex64>",
                                            "littlejohn":"<hex64>","jaime":"<hex64>",
                                            "bigbert":"<hex64>","octo":"<hex64>"}
    MEMORY_GATEWAY_ADMIN_TOKEN             required, hex64

/hermes-platform/default/
    MEMORY_GATEWAY_TOKEN                   = matching value from PROFILE_TOKENS_JSON
    TELEGRAM_BOT_TOKEN                     (per-profile)
    (Secret Link import from /hermes-platform for shared keys)

/hermes-platform/mark/   … steve, qa, littlejohn, jaime, bigbert, octo   (same shape)
```

**Critical rule:** the value of `MEMORY_GATEWAY_TOKEN` for profile X must EQUAL the value at `MEMORY_GATEWAY_PROFILE_TOKENS_JSON["<X>"]`. Mismatch → 401 at the gateway. `scripts/rotate-profile-token.sh` prints both lines so they stay in sync.

### Infisical CLI gotchas (learned the hard way 2026-05-23)

These bit us during the first live deploy. Read before scripting Infisical operations:

1. **Folders must exist before `secrets set`.** The CLI does NOT auto-create folders. Pushing to a non-existent path returns:
   > `error: unable to process new secret creations ... [message="Folder with path '/X/Y' in environment with slug 'dev' not found"]`

   Fix: explicitly create each folder first via `infisical secrets folders create --name=Y --path=/X`. Note the command is `secrets folders create`, NOT `folders create` (the latter doesn't exist in 0.43.76).

2. **`secrets list` on a non-existent path returns an empty table, not an error.** False positive for "folder exists" if you use this as a check. To genuinely verify a folder exists, use `infisical secrets folders get --path=/X`.

3. **`--recursive` flag on `infisical export` no longer exists** (removed in 0.43.x). Use `--include-imports` instead — it pulls in Secret Links from imported paths.

4. **Universal Auth machine identity needs WRITE role to push secrets.** The runtime gateway only needs READ (Viewer is fine), but the bootstrap (folder create + secrets set) requires Admin or a custom role with `secrets:write`. The recommended pattern: temporarily elevate MI to Admin → push secrets → downgrade back to Viewer. See `docs/16-DECISION-LOG.md §D-008` and the operational note in §"Operational secret rotation" below.

5. **Secret Link import depth.** When the wrapper uses `infisical run --path=/X --include-imports`, it pulls Secret Links DECLARED in /X (and within Infisical's import-depth limit). Don't assume deep recursive resolution; if a value at `/X/sub/key` needs values from `/global`, set up the Secret Link explicitly at `/X` (not at `/X/sub`).

### Operational secret rotation

For rotating any active secret (per-profile bearer, admin token, OpenViking root_api_key, embedding API key):

1. Generate new value: `openssl rand -hex 32` (bearer/admin keys) or `openssl rand -base64 30 | tr -d '/+='` (passwords).
2. **Temporarily elevate** the `hermes-platform-machine` Machine Identity from Viewer → Admin in Infisical UI.
3. Push the value via UI paste OR run a one-shot script in `secrets-runtime/` (always gitignored).
4. **Immediately downgrade** the MI back to Viewer.
5. Restart the affected container(s):
   - Bearer/admin token: `docker compose restart memory-gateway hermes-pf-<profile>`
   - OpenViking root_api_key: `docker compose restart openviking memory-gateway`
   - Embedding API key: `docker compose restart openviking-infisical-agent openviking`
6. Verify the new credential is loaded WITHOUT printing the value (hash-compare against the old known value where practical).

`HERMES_TTYD_USERNAME` and `HERMES_TTYD_PASSWORD` are deliberately unset by
the current ttyd startup command because Authelia consumes the `Authorization`
header and its FIDO gate is the routed management boundary. The direct ttyd
port remains localhost-only. Do not treat an old ttyd password in Infisical as
an active control unless the startup command is explicitly changed and the
ingress interaction is re-reviewed.

## Gateway env vars (set in docker-compose.yml)

All have a `MEMORY_GATEWAY_` prefix and are loaded by `gateway/app/config.py`:

| Var | Default | Notes |
|---|---|---|
| `MEMORY_GATEWAY_HOST` | `0.0.0.0` | listener |
| `MEMORY_GATEWAY_PORT` | `8080` | listener |
| `MEMORY_GATEWAY_OPENVIKING_URL` | `http://openviking:1933` | adapter target |
| `MEMORY_GATEWAY_OPENVIKING_TIMEOUT_SECONDS` | `30.0` | |
| `MEMORY_GATEWAY_DRY_RUN` | `false` | true → adapter returns synthetic data |
| `MEMORY_GATEWAY_POLICIES_DIR` | `/etc/hermes-platform/policies` | |
| `MEMORY_GATEWAY_REGISTRY_FILE` | `/etc/hermes-platform/registry/profiles-registry.yaml` | |
| `MEMORY_GATEWAY_AUDIT_LOG` | `/var/log/gateway/audit.log` | |
| `MEMORY_GATEWAY_AUDIT_TO_STDERR` | `true` | fluent-bit picks it up |
| `MEMORY_GATEWAY_RATE_CAPACITY` | `120` | tokens per bucket |
| `MEMORY_GATEWAY_RATE_REFILL_PER_SEC` | `2.0` | |
| `MEMORY_GATEWAY_PROFILE_TOKENS_JSON` | — | from Infisical |
| `MEMORY_GATEWAY_ADMIN_TOKEN` | — | from Infisical |

## Reloading config without restart

| Change | How to reload |
|---|---|
| Edit `policies/*.policy.yaml` | `POST /admin/reload-policies` (admin token) — also reloads registry |
| Edit `registry/profiles-registry.yaml` | same |
| Edit `spec/namespaces.yaml` | restart `memory-gateway` (loaded at startup only) |
| Rotate a token | `scripts/rotate-profile-token.sh <name>`, paste into Infisical, then `docker compose restart memory-gateway hermes-pf-<name>` |
| Change a per-profile Infisical secret | restart the affected hermes-pf-<name> container (with-infisical re-fetches on start) |
