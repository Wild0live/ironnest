# 09 — Deployment Runbook

> **Living document.** Updated 2026-05-23 with the corrections from the first live deploy. The sequence here is the path that actually worked — earlier drafts had folder-creation, MI-role, and embedding-provider assumptions that didn't survive contact with reality. See `docs/17-LLM-HANDOFF.md §"Quirks discovered during the live 2026-05-23 deployment"` for the why behind each step.

## First-time bring-up

Assumes IronNest's always-on stacks are already up (`bash platform/bootstrap.sh`), the `platform/hermes-agent:v2026.6.19-patched` image exists (`bash platform/hermes/build.sh`), and the separate `D:\LLM Wiki` stack/checkout has created `llm-wiki_wiki-net` plus the Big Bert wiki/role paths referenced by `services.d/hermes-pf-bigbert.yml`.

### Step 1 — `.env`
```bash
cd D:\claude-workspace\platform\hermes-platform
cp .env.example .env
# Edit .env with:
#   INFISICAL_UNIVERSAL_AUTH_CLIENT_ID, _CLIENT_SECRET (from Infisical Machine Identity, see step 2)
#   INFISICAL_PROJECT_ID
#   HERMES_PLATFORM_INFISICAL_PROJECT_ID=<same value as INFISICAL_PROJECT_ID>
```

### Step 2 — Infisical setup (manual, UI)

1. **Create project** `hermes-platform` in Infisical UI.
2. **Create the required folders** under `dev` environment (DON'T skip this — `secrets set` does NOT auto-create folders; pushing to a non-existent path fails with "Folder not found"). The three infra folders plus one per enabled profile:
   ```
   /hermes-platform
   /hermes-platform/openviking
   /hermes-platform/gateway
   /hermes-platform/default
   /hermes-platform/mark
   /hermes-platform/steve
   /hermes-platform/qa            (renamed from /wifey 2026-06-14)
   /hermes-platform/littlejohn
   /hermes-platform/jaime
   /hermes-platform/bigbert
   /hermes-platform/octo
   ```
3. **Create a Machine Identity** `hermes-platform-machine` at the **org level** (NOT project level). Configure Universal Auth, generate Client Secret (shown ONCE — copy immediately).
4. **Grant the MI access** to the `hermes-platform` project. **Initially set role to Admin** so the bootstrap can push secrets (we downgrade to Viewer in step 6).
5. Generate the 12+ required secret values (`openssl rand -hex 32` for tokens; bring your own Gemini/OpenAI/etc. API key if you want a cloud embedding provider; otherwise plan on the dockerized Ollama default):

   See `docs/04-CONFIGURATION.md §"Infisical layout"` for the full key list.

6. Paste each value into its Infisical folder via the UI (or run the bootstrap-secrets.sh script if you have one — script written ad-hoc per stack).

### Step 3 — Build images
```bash
bash build.sh
```
This builds `openviking`, `memory-gateway`, `mission-control`, and `operations-runner` images; the `platform/hermes-agent:v2026.6.19-patched` image is reused unchanged (already built by `hermes/build.sh`).

### Step 4 — Start the stack
```bash
bash start.sh
```
Waits for the **15 core services** to be healthy: OpenViking Infisical sidecar, Ollama, OpenViking, memory-gateway, Mission Control, artifact-apps, ttyd, and all eight registered `hermes-pf-*` agents. The optional `operations` and `kali` Compose profiles are not started by default. The health gate verifies that OpenViking is unreachable from profile agents (invariant I1), Mission Control can reach every profile bridge, and the Apps origin is healthy. The dockerized `ollama` service auto-pulls `mxbai-embed-large` on first start (~670 MB, usually 30-60 seconds).

`hermes-platform-ttyd` comes up as the browser terminal at `127.0.0.1:8123` and Hermes dashboard at `127.0.0.1:8124`; both are also routed through Traefik as `https://hermes-platform.ironnest.local/` and `https://hermes-platform-dashboard.ironnest.local/`. ttyd Basic Auth is disabled behind Authelia because Authelia consumes the `Authorization` header; the FIDO gate is the auth boundary. Mission Control is routed at `https://mission.ironnest.local/`.

### Step 5 — Validate
```bash
bash scripts/healthcheck.sh
bash scripts/validate-conversational-memory.sh # automatic Hermes provider read/write
bash scripts/validate-isolation.sh
bash scripts/validate-sharing.sh
```
All four must exit 0 to ship.

### Step 6 — Downgrade Machine Identity to Viewer (least-privilege)

In Infisical UI: `hermes-platform` project → Access Control → Machine Identities → `hermes-platform-machine` → click the pencil next to the `Admin` role → change to `Viewer`. Runtime only needs read access.

### Step 7 — Verify everything still works after the downgrade
```bash
bash scripts/healthcheck.sh
bash scripts/validate-conversational-memory.sh
```
If anything fails after the downgrade, the Viewer role doesn't include `secrets:read` on the specific paths the gateway needs. Re-grant carefully.

### Step 8 — Confirm the `/health` payload looks right
Internal path (always works, regardless of RD port-forwarder state):
```bash
docker exec hermes-pf-default curl -sS \
  -H "Authorization: Bearer $MEMORY_GATEWAY_TOKEN" \
  http://memory-gateway:8080/health
# (but $MEMORY_GATEWAY_TOKEN is empty in a fresh docker exec — see TROUBLESHOOTING §
#  "Bearer token works in tests but fails when run via docker exec")
#
# Use this instead:
docker exec hermes-pf-default with-infisical sh -c '
  curl -sS -H "Authorization: Bearer $MEMORY_GATEWAY_TOKEN" http://memory-gateway:8080/health
'
```

Host path (may flake on Rancher Desktop's port forwarder — see TROUBLESHOOTING for fixes):
```bash
curl -sS http://127.0.0.1:18080/health | jq .
```

Expected `/health` response:
```json
{
  "status": "ok",
  "version": "0.1.0",
  "policies_loaded": 8,
  "profiles_registered": 8,
  "openviking_url": "http://openviking:1933",
  "openviking": "reachable",
  "dry_run": false
}
```

## Migrating data from the legacy `hermes/` stack

Only run this when rebuilding from an old deployment that still has the legacy `hermes_hermes-data` shared volume. The legacy `hermes/` Compose stack is no longer active; `hermes/` is now just the build context for the shared Hermes image.

```bash
bash scripts/migrate-from-shared-volume.sh --dry-run
# Inspect the file counts per profile.

bash scripts/migrate-from-shared-volume.sh
# SHA-256-verifies every copied file. Non-zero exit on any mismatch.

bash scripts/patch-souls.sh --dry-run
# Confirm the diff to each SOUL.md is just the OpenViking Memory Policy section.

bash scripts/patch-souls.sh
# Writes the changes; backups at /opt/data/SOUL.md.bak.<epoch> inside each volume.

bash scripts/validate-isolation.sh
bash scripts/validate-sharing.sh
```

## Daily operation

- **Add a profile:** `bash scripts/create-profile.sh <name>` then follow the printed Infisical + compose steps.
- **Rotate a token:** `bash scripts/rotate-profile-token.sh <name>`.
- **Edit policies:** edit `policies/<name>.policy.yaml`, then `curl -XPOST -H "Authorization: Bearer $MEMORY_GATEWAY_ADMIN_TOKEN" http://127.0.0.1:18080/admin/reload-policies`.
- **Check the audit log:** `docker exec hermes-platform-memory-gateway cat /var/log/gateway/audit.log | jq .`.
- **Tail in Dozzle:** http://127.0.0.1:8888 → filter for `hermes-platform-`.

## Stopping the stack

```bash
cd D:\claude-workspace\platform\hermes-platform
docker compose down
```

This stops every container. Data volumes are preserved. To wipe everything (DESTRUCTIVE):

```bash
docker compose down -v   # removes named volumes too
```

## Legacy cutover note

The historical cutover path was: validate Hermes Platform, stop the old `hermes-gateway*` containers, then let the new `hermes-pf-*` containers poll Telegram with the same bot tokens from Infisical. That cutover has already happened in the current architecture. Do not restart the legacy `hermes/` Compose stack; it was removed to avoid competing Telegram long-pollers.
