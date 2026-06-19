# 05 — OpenViking Memory Model

> **Source:** https://github.com/volcengine/OpenViking
> **Adapter:** `gateway/app/openviking_client.py`
> **Namespace map:** `spec/namespaces.yaml`

## What OpenViking is

A "context database for AI agents" that abandons traditional vector DBs in favor of a **filesystem-paradigm** for memories, resources, and skills. Every entry has a unique `viking://` URI. Directories carry tiered context:

- **L0 (abstract)** ≈ 100 tokens — one-sentence summary, loaded always.
- **L1 (overview)** ≈ 2k tokens — core info for planning.
- **L2 (details)** — full original data, loaded on demand.

The server is a Python service launched via `openviking-server`, listening on port 1933 by default. It is `pip install openviking` (see `openviking/Dockerfile`).

## Native vs logical namespaces

The hermes-platform memory gateway exposes a **logical** namespace surface that differs from OpenViking's native top-level tree:

| Logical (gateway) | Native (OpenViking) | Purpose |
|---|---|---|
| `viking://shared/...` | `viking://resources/shared/...` | Cross-profile knowledge |
| `viking://profiles/<p>/...` | `viking://resources/profiles/<p>/...` | Per-profile private |

Native top-levels `viking://user/` and `viking://agent/` are **not exposed** by the gateway. They are reserved for OpenViking's own use; we don't mix our tenancy model with theirs.

## How the gateway accesses OpenViking

The gateway never shells out to the `ov` CLI. It uses HTTP. **All endpoints below verified live 2026-05-23 against `/openapi.json` on `openviking 0.3.19`:**

| Adapter method | Call shape |
|---|---|
| `status()` | `GET /health` (returns 200 with `{status, healthy, version, auth_mode, role}`) |
| `read(uri)` | `GET /api/v1/content/read?uri=<native>[&offset=N&limit=N]` |
| `write(uri, content)` | `POST /api/v1/content/write` body `{uri, content, mode, wait?, timeout?}` |
| `list(uri)` | `GET /api/v1/fs/ls?uri=<native>[&recursive=...&simple=...]` |
| `mkdir(uri)` | `POST /api/v1/fs/mkdir` body `{uri, description?}` (recursive + idempotent) |
| `find(query, scope?)` | `POST /api/v1/search/find` body `{query, target_uri?, limit?}` — NOTE the field is `target_uri`, NOT `uri` |
| `grep(pattern, uri)` | `POST /api/v1/search/grep` body `{pattern, target_uri?}` — NOTE the field is `pattern`, NOT `term` |

**Always re-verify after an OpenViking version bump.** Hit `http://openviking:1933/openapi.json` from inside the memory-gateway container; the routes that matter to the adapter are under `/api/v1/content/*`, `/api/v1/fs/*`, `/api/v1/search/*`, and `/health`.

### Required auth headers when using a ROOT api_key

`/api/v1/content/*` and `/api/v1/fs/*` are tenant-scoped. ROOT requests to them get **HTTP 400** unless these headers are included:

```
Authorization:        Bearer <root_api_key>
X-OpenViking-Account: default
X-OpenViking-User:    default
X-OpenViking-Agent:   default
```

The gateway adapter pins all three to `"default"`. Per-caller (per-hermes-profile) account mapping is a future enhancement — would give OpenViking-level multi-tenancy on top of the gateway's policy isolation.

### Write semantics: create vs replace, and auto-mkdir parents

`POST /api/v1/content/write` defaults to `mode=replace`, which REQUIRES the file to already exist (returns HTTP 404 otherwise). The adapter:

1. Calls `POST /api/v1/fs/mkdir` on the file's parent dir (the OpenViking mkdir is **recursive AND idempotent** — single call creates all ancestors and returns 200 on existing dirs).
2. Calls `POST /api/v1/content/write` with `mode=create`.
3. If write fails with "already exists" → retries with `mode=replace`.

Successful parent dirs are cached in `_known_dirs` on the client instance, so repeat writes to the same subtree skip the mkdir round-trip.

### Server-side auth (defense in depth)

OpenViking has two auth modes (`auth_mode: dev | api_key`). When `server.root_api_key` is set in `ov.conf`, `auth_mode` auto-detects to `api_key` and every request needs `Authorization: Bearer` (or `X-API-Key`). Only the memory-gateway has the key (from Infisical `/hermes-platform/gateway → MEMORY_GATEWAY_OPENVIKING_API_KEY`).

This means: even if a hermes-pf-* container could reach openviking on the network (it can't — different internal networks), it would still get 401 without the key. Belt and braces.

## Tiered retrieval

The adapter does NOT currently parametrize the L0/L1/L2 tier — every `read()` returns whatever the server returns. As OpenViking exposes a tier hint in its API (or once we wire it through), we'll extend the request body to include `{"tier": "L1"}`.

## What stays out of OpenViking

- Secrets (API keys, bot tokens, session cookies) — those live in Infisical.
- Raw chain-of-thought — only curated/approved content goes into `viking://shared/approved/`.
- Files larger than the per-entry size limit (TBD — depends on OpenViking server config; default 4 MB).

## OpenViking provider keys

As deployed today, the embedding provider is **local Ollama** running `mxbai-embed-large` (1024-dim) on `hermes-platform-mem-net`. Keys live in Infisical at `/hermes-platform/openviking/`:

```
EMBEDDING_PROVIDER  = ollama
EMBEDDING_MODEL     = mxbai-embed-large
EMBEDDING_DIMENSION = 1024
EMBEDDING_API_BASE  = http://ollama:11434/v1
EMBEDDING_API_KEY   = no-key       (Ollama ignores it; openai client requires non-empty)
```

OpenViking itself is on `hermes-platform-mem-net` (internal:true) — no internet egress needed. Ollama is on the SAME network, so all embedding traffic stays inside the stack.

### History of provider choice (`docs/16-DECISION-LOG.md` for details)

- Initial plan was cloud Gemini (`gemini-embedding-001`) via Squid proxy.
- Switched to local Ollama for full air-gap.
- Attempted to make Ollama use the GTX 1650 by running natively on Windows (task #16) but Rancher Desktop's WSL2 networking blocks containers from reaching the Windows host. Reverted to dockerized Ollama on CPU. See D-010.

### Config format

`ov.conf` is **JSON**, not INI (despite `[section]` examples in some upstream snippets — that was misleading). The entrypoint renders it from env vars via a Python builder:

```json
{
  "storage":   {"workspace": "/var/lib/openviking/workspace"},
  "embedding": {"dense": {...}},
  "server":    {"host": "0.0.0.0", "port": 1933, "root_api_key": "..."}
}
```

`server.host` MUST be `0.0.0.0` — OpenViking defaults to localhost-only listening, which makes it unreachable from other containers even on the same docker network.

### The `[gemini]` PyPI extra

The base `openviking` install doesn't include `google-genai`. The Dockerfile uses `pip install openviking[gemini]` so Gemini provider is always available as a fallback. Even though we run Ollama, the extra is harmless and keeps optionality.

## Workspace persistence

`openviking-workspace` named volume mounted at `/var/lib/openviking`. The OpenViking server's storage path (`storage.workspace`) points there. The volume is on the same WSL2 ext4 disk as every other IronNest volume (`F:\wsl\rancher-desktop-data\ext4.vhdx`); platform-wide backups (`platform/ops/backup.sh`) capture it automatically.
