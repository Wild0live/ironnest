# Browser-Intent MCP Server — Architecture

> **Audience.** This document is written for a future maintainer or LLM that has never seen the codebase and needs enough detail to understand, operate, debug, or replicate the system. The companion [README.md](README.md) covers day-to-day operations (start/stop, env, etc.); this document covers *how* and *why* the pieces fit. Version current as of 2026-05-19.

---

## 0. AI orientation — read this first

You are looking at a Model Context Protocol (MCP) server that lets an LLM drive headless browser automation against a small set of authenticated portals (Philippine brokerage, insurance, medical). It is **deliberately narrow**: it exposes a small fixed catalog of high-level tools (e.g. `get_portfolio`, `submit_claim`, `place_order`), never raw browser controls, and never returns credentials, cookies, raw HTML, or session-bearing URLs to the caller.

Before changing anything, internalize these five invariants:

1. **The LLM never sees credentials.** Usernames/passwords/TOTP live in Infisical → rendered by a sidecar into a file the worker reads → only the worker (not the MCP server) sees them. Any tool that returns a cookie-gated URL is a bug; the worker fetches the resource itself and returns a local path.
2. **Every tool is policy-gated twice.** First the MCP layer narrows the tool's `site` enum to the intersection of `sites.json:allowedTools` × `clients.json:client.allowedSites`; then the worker re-validates on its own (defense-in-depth). A client cannot even *see* tools for sites it lacks scope on.
3. **Write operations default to dry-run.** `submit_claim` and `place_order` accept `dry_run: true` by default. The corresponding prompts mandate showing the user the preview verbatim and getting explicit confirmation before re-calling with `dry_run: false`. The MCP+worker also refuses to click any confirm button that doesn't match a verified allowlist (`CONFIRM_BUTTON_SELECTORS`).
4. **Audit everything.** Every MCP-side audit event carries `event_type:"audit"`, `status_kind:<enum>`, `policy_version:<12-hex>`, `returned_sensitive_data:boolean`, plus per-tool fields. Wazuh queries group on `status_kind`, not raw status strings.
5. **Failure modes are structured.** When a thing fails, the response says **why** in a stable vocabulary: `needs_extractor_update`, `needs_user_action` (with `reason`: `mfa_required`, `market_closed`, `preview_error`, …), `session_expired`, `rate_limited`, etc. **Never** return a generic error — the LLM can't act on opaque failures.

Five files to read in order if you want to actually understand the code:

1. [policies/sites.json](policies/sites.json) — what sites + which tools each allows, login selectors, allowed domains.
2. [policies/clients.json](policies/clients.json) — which bearer tokens see which sites.
3. [mcp-server/server.js](mcp-server/server.js) — tool catalog (`ACTIONS`), HTTP+stdio dispatch, schema validation, audit.
4. [mcp-server/lib/prompts.js](mcp-server/lib/prompts.js) — workflow templates (catalog of multi-step tool sequences with mandatory dry-run + confirmation patterns).
5. [worker/worker.js](worker/worker.js) — login flow, OTP handling, session map, rate limiter, extract dispatch.

---

## 1. System at a glance

Three Docker services on one host:

```
┌──────────────────────────┐    ┌──────────────────────────┐    ┌────────────────────────────┐
│  infisical-agent         │    │  mcp                     │    │  worker                    │
│  (sidecar; polls 60s)    │    │  Node 24, stdio + HTTP   │    │  Node 24 + Playwright      │
│                          │    │  :18901 (127.0.0.1 only) │    │  :18902 (internal only)    │
│  renders                 │    │                          │    │                            │
│  /sites/* secrets to     │    │  auth, scope, rate-limit,│    │  per-site sessions,        │
│  secrets-runtime/.env    │───►│  schema-validate →       │───►│  login rate limit, OTP     │
│  (mtime-watched)         │    │  POST + X-Worker-Auth →  │    │  state, extractors, PDF    │
│                          │    │  audit + status_kind     │    │  fetch to /results         │
└──────────────────────────┘    └──────────────────────────┘    └────────────────────────────┘
        ▲                                ▲                                  ▲
        │ Infisical Universal Auth       │ Bearer token (HTTP) or stdio    │ /uploads/from-hermes (ro)
        │                                │ + Mcp-Session-Id (2025-06-18)   │ /results (rw)
   IronNest Infisical                 LLM client                        Shared Hermes volume
```

**Trust boundaries (outer to inner)**:

```
public LLM client ──[bearer token, rate-limit, schema validator]──► MCP
        MCP        ──[shared-secret X-Worker-Auth, internal net]──► worker
        worker     ──[Infisical-rendered secrets, Playwright]    ──► remote portal
```

---

## 2. Repository layout

```
browser-intent/
├── docker-compose.yml         # 3 services, 4 networks, 2 bind + 1 external volume
├── Dockerfile.mcp             # Node 24 (Bookworm), runs as uid 1000 (node)
├── Dockerfile.worker          # Playwright 1.56.1 (Noble), runs as uid 1001 (pwuser)
├── start.sh                   # boot: validate env → repair egress → compose up → wait healthy
├── test.sh                    # `node --test` inside a stock node:24 container
├── README.md                  # operational guide (start/stop, env, troubleshooting)
├── ARCHITECTURE.md            # this file
│
├── mcp-server/
│   ├── server.js              # MCP server: stdio + HTTP + Streamable HTTP. ~1250 LOC
│   ├── lib/
│   │   ├── audit.js              # createAudit factory, STATUS_KIND vocabulary, redactErrorMessage
│   │   ├── prompts.js            # PROMPTS catalog + createPromptsHelpers (factory injecting policy)
│   │   └── validator.js          # JSON-Schema-subset validator + boot-time drift guard
│   ├── package.json           # no runtime deps (Node built-ins only)
│   └── test/server.test.js    # 110+ tests: auth, policy, validator, prompts, sessions, rate limit
│
├── worker/
│   ├── worker.js              # HTTP server (18902); login/extract dispatch; session map. ~1800 LOC
│   ├── entrypoint.sh          # conditional xvfb-run wrapper (headed mode only)
│   ├── package.json           # playwright, playwright-extra, puppeteer-extra-plugin-stealth
│   ├── extractors/
│   │   ├── _diagnose.js              # frame/form/link summarizers shared across sites
│   │   ├── april_international.js    # policies, claims, submit_claim (OAuth+PKCE)
│   │   ├── col_financial.js          # portfolio, place_order, COL trade-form helpers
│   │   ├── hi_precision.js           # lab results + cookie-gated PDF fetch through authed context
│   │   └── maxicare.js               # policy summary, account info (SMS-OTP login)
│   └── test/                  # extractors.test.js, worker.test.js (75+ tests)
│
├── policies/
│   ├── sites.json             # per-site config (selectors, allowed tools, domains, login flow)
│   └── clients.json           # bearer-token client registry (env var → allowed sites)
│
├── agent-config/              # Infisical Agent sidecar
│   ├── agent.yaml             # daemon mode, 60s poll, output → /secrets/.env
│   ├── entrypoint.sh          # writes client_id/secret to tmpfs, exec's the agent
│   └── secrets.tmpl           # single recursive listSecrets — see §5 for etag-bug rationale
│
├── secrets-runtime/           # rendered by sidecar; bind-mounted ro into worker
│   ├── .env                   # COL_FINANCIAL_USERNAME=… (site-prefixed keys)
│   └── agent-token            # opaque Infisical sink; unused by worker
│
├── uploads/from-hermes/       # Hermes inbox; backed by external named volume hermes-to-browser-intent
├── uploads-results/           # worker writes downloaded PDFs here, 24h TTL (hi_precision/, etc.)
│
├── TOMORROW-COL-DIAGNOSTIC.md # one-pager fallback for the scheduled COL preview-page diagnostic
└── parse-*.py                 # CLI summarizers for diagnostic JSON dumps (maintainer tools)
```

---

## 3. Docker Compose topology

### 3.1 Networks

| Network | Type | Purpose |
|---|---|---|
| `platform-net` | external | IronNest service LAN; mcp + worker attach here |
| `platform-egress` | external | Sidecar/proxy network (infisical-agent, squid, adguard) |
| `browser-internal` | internal bridge | Private mcp ↔ worker channel |
| `ingress` | bridge | MCP's public-facing side (published on `127.0.0.1:18901` only) |

### 3.2 Volumes

| Volume | Type | Mounts |
|---|---|---|
| `hermes-to-browser-intent` | external named | Hermes writes at `/opt/uploads-out` (uid 10000); worker reads ro at `/uploads/from-hermes` (uid 1001 pwuser). Docker abstracts the uid translation. |
| `./policies` | bind, ro | Mounted into both mcp and worker |
| `./secrets-runtime` | bind | Written by infisical-agent, mounted ro into worker |
| `./uploads-results` | bind, rw | Mounted into worker at `/results` (writable PDF dropbox) |

### 3.3 Services

#### `infisical-agent`

| Field | Value |
|---|---|
| Image | `infisical/cli@sha256:dba406b3…` (digest-pinned to 0.43.76 upstream) |
| Entrypoint | `/agent-config/entrypoint.sh` |
| Env | `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/SECRET` from `.env` |
| Volumes | `./agent-config:ro`, `./secrets-runtime:/secrets`, tmpfs `/tmp:1m,0700` |
| Network | `platform-egress` only |
| Security | `cap_drop: ALL`, `no-new-privileges` |
| Resources | CPU 0.25, mem 64M |
| Healthcheck | `test -f /secrets/.env` (5s / 24 retries) |

Note: there is no Dockerfile.infisical-cli. The earlier `platform/infisical-cli:0.43.76-patched` tag advertised a patch that did not exist (the wrapper Dockerfile only did `FROM`). We now pin upstream by digest in compose; the etag-bug workaround lives in `secrets.tmpl`, not in the image.

#### `worker`

| Field | Value |
|---|---|
| Image | `platform/browser-intent-worker:0.1.0` (built from `Dockerfile.worker`) |
| User | `pwuser` (uid 1001) |
| Port | `18902` internal only (`browser-internal` + `platform-net`) |
| Env file | `secrets-runtime/.env` (optional bootstrap fallback) |
| Required env | `BROWSER_INTENT_WORKER_SECRET` (matched against mcp's), squid proxy vars |
| Optional env | `BROWSER_INTENT_HEADLESS=true`, session/rate/timeout tunables (§10) |
| Volumes | `./policies:ro`, `./secrets-runtime:ro`, `./uploads:ro`, `hermes-to-browser-intent:/uploads/from-hermes:ro`, `./uploads-results:/results` |
| Networks | `browser-internal`, `platform-net` (static IP 172.30.0.30) |
| DNS | `172.30.0.10` (adguard) |
| depends_on | `infisical-agent: service_healthy` |
| Resources | CPU 2.0, mem 2G |
| Healthcheck | `GET http://localhost:18902/healthz` |

#### `mcp`

| Field | Value |
|---|---|
| Image | `platform/browser-intent-mcp:0.1.0` (built from `Dockerfile.mcp`) |
| User | `node` (uid 1000) |
| Port | `18901` published on `127.0.0.1` only |
| Required env | `BROWSER_INTENT_MCP_TOKEN`, `BROWSER_INTENT_WORKER_SECRET` (must match worker) |
| Optional env | `BROWSER_INTENT_MCP_TOKEN_DR_SMITH`, `BROWSER_INTENT_ENABLE_DIAGNOSTICS`, rate-limit/session tunables (§10) |
| Volumes | `./policies:ro` |
| Networks | `ingress`, `platform-net` |
| depends_on | `worker: service_healthy` |
| Resources | CPU 0.5, mem 256M |
| Healthcheck | `GET http://localhost:18901/healthz` |
| Signals | `SIGHUP` → rebuild token index from current env + clients.json (rotation without restart) |

---

## 4. MCP server (`mcp-server/server.js` + `lib/`)

### 4.1 Bootstrap

1. **Drift guard.** `assertActionsSchemasValidatorCompatible()` walks the ACTIONS table and refuses to start if any schema uses a JSON-Schema keyword the bundled validator doesn't enforce (`format`, `oneOf`, `multipleOf`, `integer`, etc.). Fail-fast catches the "schema looks rigorous but isn't actually validated" hole.
2. **Eager client load.** Read `clients.json`; warn (do not fail) when a client's `tokenEnvVar` is unset.
3. **Token index.** Build `_tokenIndex: Map<sha256(token), client>` from the env-provisioned tokens.
4. **Policy watcher.** `fs.watch` on the policies dir with 200 ms debounce.
5. **Stdio sink.** Register `process.stdout.write` as a notification sink for `list_changed` broadcasts.
6. **HTTP bind.** Listen on `BROWSER_INTENT_HTTP_PORT` (default 18901).
7. **SIGHUP handler.** On signal, call `rebuildTokenIndex()` and log the new provisioned-clients list.

### 4.2 Transports

**Stdio (implicit admin).** The process reads JSON-RPC from stdin and writes to stdout. A pseudo-client is hard-coded: `{name: "stdio", allowedSites: "*", tokenEnvVar: null}`. Anyone with process access wins; reserved for container-internal operators and tests.

**HTTP (bearer-token, scoped).**

| Method/Path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | `{ok, status: "live", policy_version}` |
| `GET /sites` | bearer | Sites visible to caller |
| `POST /mcp` | bearer + rate-limit | JSON-RPC 2.0; protocols `2024-11-05` and `2025-06-18` |
| `GET /mcp` | bearer | Streamable-HTTP SSE stream (2025-06-18 only); `Mcp-Session-Id` required |
| `DELETE /mcp` | bearer | Explicit session teardown (2025-06-18 only) |

Every HTTP response carries `Mcp-Policy-Version: <12-hex>` for drift detection — HTTP clients on the legacy protocol use this to invalidate their cached tool list. JSON-RPC errors return HTTP 200 with `{jsonrpc, id, error}` (NOT 500 — MCP clients treat 500 as transport failure and don't surface the error to the LLM). Pure notifications return HTTP 202.

### 4.3 Authentication & rate limiting

**Token dispatch.** Constant-time SHA-256 hash + Map lookup. Empty bearers are rejected before hashing. Length-leak via per-client `timingSafeEqual` (the previous design) is closed.

**Rate limit (per client, token bucket).** Default 30-burst, 5/sec refill. Drained → HTTP 429 with `Retry-After` + audit event `result: "rate_limited"`, `status_kind: "rate_limited"`. Tunables: `BROWSER_INTENT_RATE_BURST`, `BROWSER_INTENT_RATE_REFILL`. This guards the worker queue against runaway loops; the worker has its own per-site login rate limit (§6.6) that protects upstream portals.

**SIGHUP reload.** `docker kill -s HUP browser-intent-mcp` rebuilds the token index from current env. Lets an operator rotate a bearer by editing env without restarting (no dropped sessions, no in-flight calls disrupted).

### 4.4 Policy & client caching

Both files use an mtime-keyed pattern:

```
_policyCache = { mtimeMs, data, tokenIndex? }
load() { stat(path); if mtime changed → re-parse + invalidate derived state; return data }
```

`stat()` is sub-millisecond and works through Docker Desktop bind mounts (no inotify dependency). `policyVersion()` returns the 12-char prefix of `sha256(sites.json) ⊕ sha256(clients.json)`, **computed per-call** so it always reflects current state — necessary because `fs.watch` is unreliable on Windows hosts.

On any policy change detected by `fs.watch`, the server broadcasts `notifications/{tools,resources,prompts}/list_changed` to stdio sinks and any open SSE streams. HTTP-only clients detect drift via the response header.

### 4.5 Tool catalog (ACTIONS)

For each tool, the `site` parameter's enum is dynamically narrowed to `(sites where allowedTools contains this tool) ∩ (client.allowedSites)`. If the intersection is empty, the tool is removed from `tools/list` for that client entirely. A call for an out-of-scope site returns `"unknown tool"` (same phrasing as out-of-scope resources — does not leak which sites exist).

| Tool | Sites | Purpose / return shape |
|---|---|---|
| `login` | all | `{status}`. Statuses: `logged_in`, `awaiting_otp`, `awaiting_fresh_sms`, `rate_limited`, `needs_user_action`, `needs_site_selector_update` |
| `logout` | all | `{status: "logged_out"}` |
| `check_session` | all | `{status: "logged_in" | "logged_out"}` |
| `provide_otp` | maxicare | `{site, code}` → `{status, next_action?, failure_kind?}` |
| `get_portfolio` | col_financial | holdings + cash + totals (regex-parsed from page text — DOM is COLSPAN-nested) |
| `get_account_info` | maxicare, april_international | profile fields |
| `get_policy_summary` | maxicare | policy list + `card_added` flag |
| `get_policy_info` | april_international | policy details + insured members |
| `get_claims_history` | april_international | last 50 claims |
| `get_claim_status` | april_international | full timeline for one claim id |
| `get_documents_list` | april_international | downloadable docs (name + url) |
| `get_results` | hi_precision | results with `download_path` (no URL — §7) |
| `submit_claim` | april_international | WRITE. `dry_run: true` default |
| `place_order` | col_financial | WRITE. `dry_run: true` default. Buy/sell securities (§8) |
| `list_browser_intent_sites` | — | introspection: what this caller can see |
| `diagnose_login_form` | varies | Maintainer-only; gated |
| `diagnose_member_portal` | varies | Maintainer-only; gated |
| `diagnose_portfolio` | col_financial | Maintainer-only; gated |
| `diagnose_claim_form` | april_international | Maintainer-only; gated |
| `diagnose_order_form` | col_financial | Maintainer-only; gated. Nav to trade page + dump structure (§8) |
| `diagnose_order_preview` | col_financial | Maintainer-only; gated. Fill form + click Preview + dump Step-2 DOM (§8) |

Diagnostic tools are hidden from `tools/list` unless `BROWSER_INTENT_ENABLE_DIAGNOSTICS=true`. They return structural metadata only — never field values, ticker lists, account numbers.

### 4.6 Prompts (workflow templates)

Prompts compose tools into multi-step flows the LLM can `prompts/get` to receive a guided playbook:

| Prompt | Sites | Mandates |
|---|---|---|
| `submit_claim_from_receipt` | april_international | check_session → login (with OTP) → dry-run preview → user confirmation → real submit |
| `place_col_order` | col_financial | check_session → login → dry-run preview → user confirmation → real submit. Same-payload constraint between dry-run and real call |
| `complete_otp_login` | maxicare | login → read SMS code from user → provide_otp with `next_action` handling (do NOT re-login during cooldown) |
| `fetch_recent_results` | hi_precision | check_session → login → get_results. Surface `download_path` not URLs |
| `check_policy_status` | maxicare, april_international | check_session → login → get_account_info (+ optional get_policy_info/summary) |
| `diagnose_failed_login` | varies (gated) | diagnose_login_form → compare against configured selectors → propose minimal patch |

A prompt is filtered out of `prompts/list` for a client unless every site that satisfies the prompt's `requiredActions` AND any `siteFilter` is in the client's `allowedSites`. Prompts live in [lib/prompts.js](mcp-server/lib/prompts.js) and are wired into the server via `createPromptsHelpers({ loadPolicy, clientSiteIntersection, diagnosticsEnabled })` — factory pattern keeps the catalog purely declarative.

### 4.7 Resources

- `browser-intent://sites` — index of visible sites
- `browser-intent://sites/{siteId}` — `{site, displayName, riskLevel, allowedTools}` only — never `loginUrl`, `secretPath`, or `loginSelectors`.

Cross-scope reads return `"unknown resource"` (does not leak existence of other sites).

### 4.8 Schema validation

`lib/validator.js` ships a small hand-rolled JSON-Schema-subset validator (avoiding an ajv dependency). It supports `type` (`string` | `number` | `boolean` | `array` | `object`), `enum`, `pattern`, `min/maxLength`, `exclusiveMinimum`, `items`, `maxItems`, `required`, `additionalProperties`. The boot-time drift guard (§4.1) fails fast if a future ACTIONS schema uses an unsupported keyword.

Validator rejections audit-log as `result: "denied_invalid_args"`, `status_kind: "denied"` — distinguishable from site-scope denials (`result: "denied_by_client_policy"`) so operators triaging a `status_kind:denied` spike can tell "malformed input" from "forbidden site."

### 4.9 Audit log shape

All audit events go to stderr as one JSON object per line:

```json
{
  "timestamp": "2026-05-19T10:23:17.783Z",
  "component": "browser-intent-mcp",
  "event_type": "audit",
  "status_kind": "needs_user|success|session_expired|rate_limited|needs_update|denied|error|unknown",
  "policy_version": "41168fc66362",
  "tool": "place_order",
  "client": "hermes_dr_smith",
  "site": "col_financial",
  "result": "dry_run",
  "returned_sensitive_data": true
}
```

Fluent Bit ships these to Wazuh OpenSearch (`ironnest-containers-*`). URLs are scrubbed with `URL_REDACT_RE` (replaced with `origin+pathname`) and truncated at 500 chars before logging.

`status_kind` is the operator-facing stable enum. The raw `result` field is the free-text status string the worker returned (or `denied_invalid_args` / `denied_by_client_policy` / `failed` set by the MCP). Adding a new worker status requires updating BOTH `lib/audit.js` (MCP-side) AND `worker/worker.js` (worker-side `STATUS_KIND`) — they're kept in sync by code review, with an `unknown` fallback alert as the safety net.

Worker-side audit events have the same shape (`component: "browser-intent-worker"`) but their `status_kind` is computed locally — every audit() call in the worker also flows through the same mapping table.

### 4.10 Streamable-HTTP sessions (protocol 2025-06-18)

A `_sessions` map keyed by session ID stores `{version, client, createdAt, lastSeen, sseSink}`. The `GET /mcp` endpoint registers a response stream as a notification sink so policy-change `list_changed` events push to the live channel; `DELETE /mcp` tears it down explicitly. An idle reaper drops sessions with `lastSeen > BROWSER_INTENT_SESSION_TTL_SECONDS` (default 3600s).

Legacy clients (`2024-11-05`) get plain request/response — no `Mcp-Session-Id` header, no SSE, but the same per-response `Mcp-Policy-Version` header so they can still detect drift via polling.

### 4.11 Outbound to worker (`workerCall`)

Every MCP→worker call carries `X-Worker-Auth: <BROWSER_INTENT_WORKER_SECRET>` and is bounded by an `AbortController` timeout (default 60s, env `BROWSER_INTENT_WORKER_TIMEOUT_SECONDS`). On timeout the call surfaces as a structured `"worker call timed out after Xms: /path"` error that audit-logs as `status_kind: "error"` rather than hanging the LLM turn until the client's own ~120s timeout fires.

---

## 5. Infisical sidecar (`agent-config/`)

The agent runs as a separate container, polls Infisical every 60 s, and renders `secrets-runtime/.env` whenever any secret under `/sites/*` changes.

### 5.1 The template (`secrets.tmpl`)

```jinja
{{- range listSecrets "PROJECT_UUID" "dev" "/sites" "{\"recursive\":true}" }}
{{- if hasPrefix "/sites/" .SecretPath }}
{{ .SecretPath | trimPrefix "/sites/" | replace "-" "_" | replace "/" "_" | upper }}_{{ .Key }}={{ .Value }}
{{- end }}
{{- end }}
```

Key derivation: `/sites/col-financial` + `USERNAME` → `COL_FINANCIAL_USERNAME`. The `secret(site, key)` helper in the worker maps from `site.secretPrefix` (set in sites.json) + the field name.

### 5.2 The etag bug we work around

Infisical CLI ≤ 0.43.76 threads a single `*currentEtag` pointer through every template call. With *separate* `range listSecrets` blocks per site, the final etag only tracks the last site, and changes to any other site are silently missed. The fix is a single **recursive** `listSecrets` call covering the whole `/sites` subtree — the server returns one etag covering all children, and the template iterates client-side.

If you add a new site, **do not add a new `range listSecrets` block** — just create `/sites/<new-site>` in Infisical and the env keys will appear automatically. If you ever need to fetch from a path outside `/sites`, you re-introduce the bug; restart the sidecar (`docker restart browser-intent-infisical-agent`) as a workaround until upstream is fixed.

### 5.3 Worker-side cache

`readRenderedSecrets()` stats `/secrets/.env`, parses only when mtime changes, and caches the parsed Map. Lookup order is **file-rendered first, then `process.env`** so rotations win without restart. `secret(site, key)` throws on missing; `optionalSecret(site, key)` returns `""` (used for optional `TOTP_SECRET`).

---

## 6. Worker (`worker/worker.js`)

### 6.1 Process model

- Node 24 + Playwright 1.56.1 + playwright-extra + puppeteer-extra-plugin-stealth (16 evasions — `user-agent-override` is disabled because we set UA via `setExtraHTTPHeaders`).
- Headless toggle via `BROWSER_INTENT_HEADLESS` (default `true`). When `false`, `entrypoint.sh` wraps the process with `xvfb-run`; in headless mode it does *not* wrap, avoiding the PID-1 race documented in `feedback_browser_intent_xvfb_pid1_hang`.
- Stealth does **not** fix TLS JA3 fingerprinting. Sites that fingerprint TLS need real Chrome over CDP (not currently used).

### 6.2 In-memory state

| Map | Purpose |
|---|---|
| `sessions[siteId]` | Active session: `{browser, context, page, startedAt, lastActivity}` |
| `pendingOtpSessions[siteId]` | Session waiting for `provide_otp`, with `expiresAt` |
| `smsCooldown[siteId]` | `{until, smsLikelyFresh}` — informs whether re-login would burn a fresh SMS |
| `loginAttempts[siteId]` | Timestamps for sliding-window rate limit |
| `siteLocks[siteId]` | Promise chain — login/logout/extract on the same site serialize |

A reaper sweeps every `BROWSER_INTENT_SESSION_SWEEP_SECONDS` (default 60) and closes sessions idle longer than `BROWSER_INTENT_SESSION_IDLE_MINUTES` (default 15).

### 6.3 Authentication on the worker side

Every POST to the worker requires `X-Worker-Auth: <BROWSER_INTENT_WORKER_SECRET>` checked with `crypto.timingSafeEqual`. Failures are HTTP 401 + audit event `result: "worker_auth_rejected"`, `status_kind: "denied"`. `/healthz` is exempt so the compose healthcheck doesn't need to read `.env`.

If the env var is unset, the worker enters a **bootstrap-fallback** mode: accepts unauthenticated requests AND logs a warning at boot. Production stacks set it (compose enforces via `${VAR:?...}`).

### 6.4 Session lifecycle

1. `login()` is called. If a usable session exists, short-circuit and refresh `lastActivity` (does not count against the rate limit).
2. Otherwise, rate-limit check (default 5 logins per 15 min per site, sliding window).
3. Launch Chromium; new BrowserContext per site (ephemeral, no `userDataDir`).
4. Configure context: `Accept-Language`, `Accept-Encoding`, `Sec-Fetch-*` headers via `setExtraHTTPHeaders`; per-request header patching via interception.
5. Drive the form (§6.5).
6. Confirm logged-in via `confirmLoggedIn()` (§6.6).
7. For OAuth-flow sites where step 6 returns false, poll via `pollConfirmLoggedIn` for up to 5s before declaring MFA — bypasses the OAuth-callback false-positive (§6.7).
8. Promote the session to `sessions[siteId]`.

For SMS-OTP sites (Maxicare): step 5 fills only the username, clicks Continue, parks the session in `pendingOtpSessions` with a TTL (default 300s), and returns `{status: "awaiting_otp"}`. A subsequent `provide_otp` fills the code keystroke-by-keystroke (NOT `.fill()` — Maxicare's bot-detector trips otherwise), submits, and on success promotes to `sessions`. The OTP flow tracks the upstream "Resend in M:SS" countdown to know whether a re-login during cooldown would burn a fresh SMS (sets `awaiting_fresh_sms` and aborts if not).

### 6.5 Login form filling

- Selectors live under `site.loginSelectors` (CSS, playwright-compatible). `firstVisible(page, selectors)` iterates the array and picks the first visible match.
- Three login flow types (`site.loginFlow`):
  - `single_step` (default) — fill username, Tab, fill password, move to submit, press Enter
  - `multi_step` — username → Continue → wait for password → fill password → Enter
  - `username_otp` — username → Continue → wait for OTP input → return `awaiting_otp`
- Typing uses `type()` with a 25 ms delay (fires keystroke events real bot detectors look for, not just `value=`).
- Pre-interaction dwell + `humanMoveTo(page, locator)` produces a smooth cursor path with jitter.
- `site.prefillHidden` lets a site set hidden inputs (literal value, or `{{location.href}}` token resolved at fill time; same template machinery as `loginUrl`).
- TOTP auto-fill: if `site.loginSelectors.totp` exists and `TOTP_SECRET` is provisioned, `tryTotp()` fills/submits at offsets −1/0/+1 windows for boundary safety.
- URL templates: `site.loginUrl` can contain `{{code_challenge}}` (OAuth+PKCE). `resolveLoginUrl()` generates a fresh verifier+challenge per call. Unknown placeholders → throw (fail-fast prevents leaking literal `{{...}}` strings to the upstream).

### 6.6 Logged-in confirmation

`confirmLoggedIn(page, site)`:
1. If current URL (stripped of query/hash) equals `site.loginUrl`, declare not-logged-in (form rejected silently).
2. Substring-match the URL against `site.loggedInUrlPatterns` (preferred — fastest, no JS execution).
3. Fallback: case-insensitive `innerText` search for `site.loggedInSignals` (e.g. "logout", "sign out", "dashboard").

`pollConfirmLoggedIn(page, site, windowMs)` re-runs `confirmLoggedIn` at 250ms intervals up to `windowMs` (default 5s, env `BROWSER_INTENT_LOGIN_POLL_SECONDS`). Used in the OAuth path to absorb the redirect chain (§6.7).

### 6.7 The OAuth+PKCE false-MFA fix (April International)

April's login flow is `/ipmi/login → /auth/callback?code=… → /home/`. Without polling, `confirmLoggedIn` would run on the callback URL mid-redirect — which matches no `loggedInUrlPattern`, so returns false; then `mfaLikely()` would trigger because the callback page has `code_challenge` hidden inputs that match the `input[name*='code' i]:visible` selector. False `needs_user_action` ships, the LLM panics.

Fix: in the `_login` path, when `confirmLoggedIn` returns false, call `pollConfirmLoggedIn` for 5s before falling through to MFA detection. The redirect chain finishes mid-poll, the session is confirmed, no false positive. (`mfaLikely`'s broad selector is intentional and stays — it has to catch real OTP/MFA inputs named `verificationCode`, `authCode`, etc.; narrowing it would miss real MFA.)

### 6.8 Failure taxonomy (login)

Returned as `{status, …}` from `login()`:
- `needs_site_selector_update` — selector not found, or form fill threw. Includes a snapshot of page metadata for maintainer debugging.
- `needs_user_action` — MFA / CAPTCHA visible (`mfaLikely(page)` matches reCAPTCHA / Turnstile / hCaptcha / OTP text). Set after the OAuth poll exhausts.
- `rate_limited` — local sliding-window limit hit; `retry_after_seconds` returned. Does NOT contact the upstream portal.
- `awaiting_fresh_sms` — re-login attempted inside the SMS cooldown window (would not trigger a new SMS, would burn a slot).
- `awaiting_otp` — Maxicare-style flow; pending session waiting for `provide_otp`.
- `logged_in` — success. The corresponding session is now in `sessions[siteId]`.

### 6.9 HTTP API

| Method/Path | Body | Notes |
|---|---|---|
| `GET /healthz` | — | No auth |
| `POST /login` | `{site}` | |
| `POST /logout` | `{site}` | |
| `POST /session` | `{site}` | check_session |
| `POST /provide-otp` | `{site, code}` | |
| `POST /extract` | `{site, action, args}` | Action dispatched by name |

All POSTs require `X-Worker-Auth` (§6.3). The `/extract` endpoint dispatches to `extractors/<siteId>.js` by computing the method name as `camelCase(action)` (e.g. `submit_claim` → `submitClaim`). The dispatcher hot-reloads the extractor module on every call (deletes the require.cache entry) so a maintainer can edit an extractor without restarting the worker — critical for not killing live OTP sessions.

Every extractor invocation runs inside `withActionTimeout(...)` (default 45s, env `BROWSER_INTENT_EXTRACTOR_TIMEOUT_SECONDS`). A hung Playwright wait surfaces as `status: "extractor_timeout"` (status_kind `"error"`) instead of consuming the worker's only Chromium for the MCP's 60s outer timeout.

### 6.10 Extractor module shape

Each module under `worker/extractors/` exports async functions invoked on an active session's `page`:

```js
async function getPortfolio(page) { /* … */ return { site, status: "ok", … }; }
async function placeOrder(page, args) { /* … */ return { site, status: "dry_run" | "ok" | …, … }; }
module.exports = { getPortfolio, placeOrder, … };
```

Conventions:
- Every return shape includes `site`, `status`, `returned_sensitive_data`. Extraction tools that return business data set `returned_sensitive_data: true`.
- Errors throw with `e.code = "needs_extractor_update"` to surface as a clean status to the caller; everything else surfaces as `status_kind: "error"`.
- Helpers shared across sites live in `_diagnose.js` (frame/form/link summarizers).

### 6.11 Diagnostic helpers (`_diagnose.js`)

`collectFrameSummaries`, `collectFrameLinksMatching`, `summarizeForms`, `sanitizeUrl` — used by the `diagnose_*` tools to return *structural* page metadata (form actions, input names, button text, link patterns) without leaking raw HTML or tokens. Per-site extras live in the site's extractor (e.g. COL's `summarizeFrameForms` enriches with radio `value` attributes and adjacent text labels — safe because those are page-defined constants, not user data).

---

## 7. Hi-Precision PDF fetch (the cookie-gated download pattern)

The naive approach — return the PDF URL to the LLM — would leak a session-cookied URL into the prompt context, where it could be exfiltrated. Instead:

1. After `get_results` parses the result table, for each row with a download link:
2. Worker calls `page.context().request.get(url)` — shares the active session's cookies and TLS profile.
3. Cap body at 20 MB (`BROWSER_INTENT_RESULT_MAX_BYTES`).
4. Atomic write: `<lab>.<pid>.tmp` → rename to `<lab>.pdf` in `/results/hi_precision/`.
5. Return `{download_path: "/results/hi_precision/HIP-…pdf", download_bytes, download_content_type, download_status}`. **No URL in the response.**
6. Prune files older than 24h (`BROWSER_INTENT_RESULT_TTL_HOURS`) on the way out (best-effort, non-fatal).

`/results` is bind-mounted from `./uploads-results/` on the host, so Hermes or another component on the platform LAN can pick the file up by path.

Per-row `download_status` values: `ok | too_large | download_failed | no_url`. The LLM is instructed (via the `fetch_recent_results` prompt) to surface these verbatim and **not** retry — the worker already tried.

---

## 8. COL Financial trading (the brokerage write-op pattern)

`place_order` is the brokerage analog of `submit_claim`. The same dry-run-by-default contract applies, but the form structure and confirm-step plumbing are COL-specific.

### 8.1 Order entry DOM (verified)

Form `OrderDetails` at `/ape/FINAL2_STARTER/trading_pca3/Trd_EnterOrder.asp`:

| Element | Notes |
|---|---|
| `<input type="hidden" name="Hid">` | Session-bound token, set by server on page load |
| `<input type="hidden" name="txtRecordNo">` | Set by server post-preview |
| `<input type="radio" name="rdBuySell" value="BN">` | **BN = Buy** (not "B" or "BUY" — verified) |
| `<input type="radio" name="rdBuySell" value="SN">` | **SN = Sell** |
| `<input type="radio" name="rdBoard" value="MAIN">` | Main board |
| `<input type="radio" name="rdBoard" value="ODD">` | Odd lot |
| `<input type="radio" name="rdTerm" value="DAY">` | Good for the day |
| `<input type="radio" name="rdTerm" value="GTC">` | Good till cancel |
| `<input type="radio" name="rdTerm" value="ATC">` | At the close |
| `#txtStkSymbol`, `#txtNumNoShare`, `#txtFloatPrice` | Symbol, quantity, limit price |
| `<input type="submit" name="cmdPreview" value="Preview Order">` | Dry-run step |
| `<input type="submit" name="cmdClear" value="Clear">` | Reset form |

### 8.2 The 3-step flow

1. **Step 1 of 3** — Enter Order (the form above)
2. **Step 2 of 3** — Preview (computed fees, totals, confirm button — name **not yet verified**)
3. **Step 3 of 3** — Confirmation receipt

`place_order(dry_run=true)` runs steps 1–2 and returns the preview snapshot. `place_order(dry_run=false)` runs steps 1–3 — but the Step-2 confirm button name is the open gap (see §8.4).

### 8.3 Submission contract

Worker uses a **two-method submission** (`submitOrderPreview`):

1. First try `formFrame.locator('input[name="cmdPreview"]').click()` — the natural path that exercises any client-side onclick validation.
2. If post-click body still says "Step 1 of 3" (detected via `detectStuckOnStep1`), fall back to `formFrame.evaluate(() => document.forms.OrderDetails.submit())` — bypasses onclick handlers entirely.

Returns `{snapshot, method: "click" | "form_submit"}` — surfaced in the response so a maintainer can see which path got past Step 1.

### 8.4 The confirm-button allowlist

`CONFIRM_BUTTON_SELECTORS` is a defensive allowlist of submit-input selectors tried in order (`cmdSubmit`, `cmdConfirm`, `cmdSend`, `cmdOK`, `cmdProceed`, `cmdPlace`, plus `value*="Submit"|"Confirm"|"Place Order"|"Send Order"`). On a `dry_run=false` call, if no entry matches the preview page's buttons, the extractor returns `status: "needs_extractor_update", reason: "confirm_button_not_found"` **without clicking anything**. Wrong click on a brokerage page = real money loss; the allowlist must be verified against a real preview-page DOM dump before being trusted.

### 8.5 Market-closed handling

COL serves `Trd_EnterOrder.asp` with HTTP 200 but **no form** when PSE is closed — the body says "ENTER ORDER (Step 1 of 3) You can not place an order. The market is closed." `findOrderDetailsFrame` returns null. `detectMarketClosed` checks the post-nav body excerpt for sentinel phrases; on match, `navigateToOrderEntry` returns `{ok: false, reason: "market_closed", matched_phrase}`. `place_order` translates that to `status: "needs_user_action", reason: "market_closed", next_action: "PSE trading hours (PHT, Mon-Fri): 9:00-9:30 AM pre-open queueing, 9:30 AM-12:00 PM morning session, 12:00-1:00 PM lunch break, 1:00-3:15 PM afternoon session incl. closing auction…"`

PSE hours (PHT, UTC+8, Mon-Fri):
- 9:00-9:30 AM — pre-open queueing
- 9:30 AM-12:00 PM — morning session
- 12:00-1:00 PM — lunch break (closed)
- 1:00-3:15 PM — afternoon session incl. closing auction

`market_closed` classifies as `status_kind: "needs_user"` (mirrored on both worker and MCP STATUS_KIND tables) so Wazuh groups it with OTP waits etc.

### 8.6 Diagnostic tools for the trade flow

- `diagnose_order_form` — navigates to the trade page via menu click, dumps trade-link candidates + per-frame form metadata + radio `value` attributes + adjacent labels. Used to author the entry-form selectors.
- `diagnose_order_preview` — fills the form with caller-supplied params, clicks Preview, dumps the resulting page DOM (forms, buttons, body excerpt, frame URL diffs, onclick attributes, console messages during click, Hid prefix). Used to identify the Step-2 confirm button.

Both gated by `BROWSER_INTENT_ENABLE_DIAGNOSTICS=true`. Output is structural metadata only (no values, no ticker lists, no account numbers).

---

## 9. Hermes ↔ Browser-Intent file exchange

Hermes (a different IronNest stack, uid 10000) deposits documents that Browser-Intent then attaches to claim submissions. The mechanism is a shared external Docker named volume:

| Mount | Container | Mode | UID |
|---|---|---|---|
| `/opt/uploads-out` | Hermes | rw | 10000 |
| `/uploads/from-hermes` | Browser-Intent worker | ro | 1001 (pwuser) |

Docker's named-volume permissions abstract the uid translation. Within `submit_claim`, the `receipts` array accepts paths matched by `^/uploads/[^\.][^\s]*$` (whitelist prefix, reject traversal) — paths that point outside `/uploads/from-hermes` are rejected.

Operational notes: the volume must already exist before `docker compose up`; `autostart.ps1` creates it during the bootstrap stack so this is normally invisible.

---

## 10. End-to-end request flow

```
LLM client (Hermes, CLI, Codex, …)
   │  HTTP POST /mcp  Authorization: Bearer <t>
   │                  [Mcp-Session-Id, MCP-Protocol-Version on 2025-06-18]
   ▼
mcp (Node, :18901)
   │  1. authenticateClient(headers) → SHA-256 lookup → {name, allowedSites, …}
   │  2. rateCheck(client.name) — token-bucket, 429 if drained
   │  3. (2025-06-18) session-id validation + protocol-version match
   │  4. validate JSON-RPC envelope, dispatch method
   │  5. for tools/call:
   │     - lookup ACTIONS[name]
   │     - compute per-client site enum, drop if empty (unknown tool)
   │     - validateArgs against per-client schema
   │     - audit start
   │  6. workerCall(endpoint, body) with X-Worker-Auth + AbortController
   ▼
worker (Node + Playwright, :18902)
   │  7. workerAuthOk(req) — constant-time compare on X-Worker-Auth
   │  8. withSiteLock(siteId, …) — serialize on the site
   │  9. login: rate limit → reuse cached session OR launch Chromium → drive form
   │              → confirmLoggedIn → (OAuth path) pollConfirmLoggedIn → MFA gate
   │     extract: hot-reload extractor module → withActionTimeout(extractor[method](page, args))
   │              → (hi_precision) cookie-authed PDF fetch to /results
   │              → (col_financial.place_order) navigateToOrderEntry → fill → submitOrderPreview
   │                  → detectMarketClosed / detectStuckOnStep1 → confirm-button hunt
   │     provide_otp: promote pending session, handle next_action / cooldown
   │     logout: close browser, clean up maps
   │ 10. audit + return {status, …}
   ▲
   │ 11. mcp audit-logs result (status_kind, policy_version, returned_sensitive_data, …)
   │ 12. response: {content: [{type:"text", text: JSON.stringify(result)}], isError: false}
   │     headers: Mcp-Policy-Version, (2025-06-18) Mcp-Session-Id
   ▼
LLM client
```

---

## 11. Failure modes & how each surfaces

| Failure mode | Where detected | Returned shape | status_kind |
|---|---|---|---|
| Wrong bearer / no bearer | MCP HTTP `authenticateClient` | HTTP 401 `{error: "auth_required"}` | n/a (pre-audit) |
| Rate limit drained | MCP HTTP rateCheck | HTTP 429 `{error: "rate_limited", retry_after_sec}` + `Retry-After` header | rate_limited |
| Site outside client scope | MCP callTool | `{error: "unknown tool"}` (no leak) | denied |
| Invalid args (schema) | MCP validateArgs | `{error: "invalid value for X: …"}` | denied (result: `denied_invalid_args`) |
| MCP → worker timeout | MCP workerCall AbortController | `{error: "worker call timed out after Xms"}` | error |
| Worker auth header missing/wrong | Worker workerAuthOk | HTTP 401 `{error: "worker_auth_required"}` | denied (worker_auth_rejected) |
| Worker per-action timeout (Playwright hung) | Worker withActionTimeout | `{status: "extractor_timeout", timeout_ms}` | error |
| Login rate limit (per-site) | Worker loginRateCheck | `{status: "rate_limited", retry_after_seconds}` | rate_limited |
| SMS cooldown still active | Worker `_login` smsCooldown | `{status: "awaiting_fresh_sms", wait_seconds_for_fresh_sms}` | needs_user |
| MFA / CAPTCHA detected | Worker mfaLikely after pollConfirmLoggedIn | `{status: "needs_user_action", reason: "mfa_required"}` | needs_user |
| Selector not found | Worker login form drive | `{status: "needs_site_selector_update", snapshot}` | needs_update |
| Login form silently rejected | Worker confirmLoggedIn returns false even post-poll | `{status: "needs_user_action", reason: "login_not_confirmed_or_mfa_possible"}` | needs_user |
| Extractor not found / wrong DOM | Extractor throws e.code = "needs_extractor_update" | `{status: "needs_extractor_update"}` | needs_update |
| Session not active when extract called | Worker session check | `{status: "session_expired"}` | session_expired |
| Tool called for site outside policy | Worker assertSiteAllowsAction | `{error: "tool not allowed for site"}` | error |
| COL pre-open / post-close | Worker detectMarketClosed | `{status: "needs_user_action", reason: "market_closed", next_action}` | needs_user |
| COL preview click didn't advance — broker dialog | Worker classifyDialogs after detectStuckOnStep1 | `{status: "needs_user_action", reason: "board_lot_violation" \| "insufficient_buying_power" \| "insufficient_shares" \| "symbol_not_in_portfolio" \| "tick_size_violation" \| "invalid_symbol" \| "market_closed" \| "minimum_order_violation", hint, dialog_message}` | needs_user |
| COL preview click didn't advance — frameset context lost | Worker placeOrder: Hid_length=1 + parent.* pageerrors after submitOrderPreview | `{status: "needs_extractor_update", reason: "frameset_context_missing", nav_debug, note}` | needs_update |
| COL preview click didn't advance — unknown blocker | Worker detectStuckOnStep1 (no classifier match, no frameset-context signature) | `{status: "needs_extractor_update", reason: "step1_loop_after_preview_click", dialogs_captured, pre_submit_form_state, post_click_form_state, js_errors, nav_debug, preview}` | needs_update |
| COL confirm button not in allowlist | Worker placeOrder dry_run=false | `{status: "needs_extractor_update", reason: "confirm_button_not_found", preview}` | needs_update |
| Hi-Precision PDF too big | Worker downloadResultPdf | row's `download_status: "too_large"` (other rows succeed) | success |
| Worker `/extract` POST throws unexpectedly | Worker outer try/catch | HTTP 400 `{status: "failed", error}` (redacted) | error |
| Unmapped status string | audit() → statusToKind | `status_kind: "unknown"` | unknown (alert!) |

Adding a new failure mode means:
1. Emit a stable `result` string from the worker (or MCP for MCP-internal denials).
2. Add it to BOTH `lib/audit.js` STATUS_KIND and `worker/worker.js` STATUS_KIND if it might be emitted from either side.
3. Add a test pinning the classification (`statusToKind` table-driven test).

---

## 12. Configuration & tunables

### 12.1 `.env` (host-level, required)

| Variable | Purpose |
|---|---|
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` | Machine identity for sidecar |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` | — |
| `BROWSER_INTENT_MCP_TOKEN` | Admin HTTP bearer |
| `BROWSER_INTENT_MCP_TOKEN_DR_SMITH` | Hermes-scoped bearer (optional) |
| `BROWSER_INTENT_WORKER_SECRET` | Shared secret for the mcp↔worker channel; identical value on both services |
| `TZ` | Optional |

### 12.2 Worker tunables

| Variable | Default | Purpose |
|---|---|---|
| `BROWSER_INTENT_POLICY_PATH` | `/app/policies/sites.json` | |
| `BROWSER_INTENT_HEADLESS` | `true` | `false` → xvfb-run wraps |
| `BROWSER_INTENT_SESSION_IDLE_MINUTES` | `15` | Reaper threshold |
| `BROWSER_INTENT_SESSION_SWEEP_SECONDS` | `60` | Reaper interval |
| `BROWSER_INTENT_LOGIN_MAX_PER_WINDOW` | `5` | Per-site login rate limit |
| `BROWSER_INTENT_LOGIN_WINDOW_MINUTES` | `15` | Sliding window |
| `BROWSER_INTENT_LOGIN_POLL_SECONDS` | `5` | pollConfirmLoggedIn window for OAuth flows |
| `BROWSER_INTENT_OTP_TTL_SECONDS` | `300` | Pending OTP session lifetime |
| `BROWSER_INTENT_EXTRACTOR_TIMEOUT_SECONDS` | `45` | Per-action Playwright timeout |
| `BROWSER_INTENT_RESULTS_DIR` | `/results` | PDF output |
| `BROWSER_INTENT_RESULT_MAX_BYTES` | `20971520` | 20 MB cap |
| `BROWSER_INTENT_RESULT_TTL_HOURS` | `24` | Auto-prune |
| `HTTP_PROXY` / `HTTPS_PROXY` | `http://squid:3128` | |
| `NO_PROXY` | service hostnames | |

### 12.3 MCP tunables

| Variable | Default | Purpose |
|---|---|---|
| `BROWSER_INTENT_POLICY_PATH` | `/app/policies/sites.json` | |
| `BROWSER_INTENT_CLIENTS_PATH` | `/app/policies/clients.json` | |
| `BROWSER_WORKER_URL` | `http://browser-intent-worker:18902` | |
| `BROWSER_INTENT_HTTP_PORT` | `18901` | |
| `BROWSER_INTENT_ENABLE_DIAGNOSTICS` | unset | When `true`, expose `diagnose_*` tools |
| `BROWSER_INTENT_RATE_BURST` | `30` | Per-client token-bucket capacity |
| `BROWSER_INTENT_RATE_REFILL` | `5` | Tokens added per second per client |
| `BROWSER_INTENT_WORKER_TIMEOUT_SECONDS` | `60` | AbortController on mcp→worker fetch |
| `BROWSER_INTENT_SESSION_TTL_SECONDS` | `3600` | Streamable-HTTP idle timeout |

---

## 13. Currently configured sites

| Site key | Display | Risk | Login flow | Notable tools |
|---|---|---|---|---|
| `col_financial` | COL Financial | financial | single_step | `get_portfolio`, `place_order` (write), `diagnose_portfolio`, `diagnose_order_form`, `diagnose_order_preview` |
| `maxicare` | Maxicare | medical | username_otp | `provide_otp`, `get_policy_summary`, `get_account_info`, `diagnose_member_portal`, `diagnose_login_form` |
| `april_international` | April International | insurance | single_step (OAuth+PKCE) | `get_policy_info`, `get_claims_history`, `get_claim_status`, `submit_claim` (write), `get_documents_list`, `diagnose_member_portal`, `diagnose_login_form`, `diagnose_claim_form` |
| `hi_precision` | Hi-Precision | medical | single_step | `get_results` (PDF fetch), `diagnose_member_portal`, `diagnose_login_form` |

Per-site quirks (captured in memory entries):
- Maxicare is SMS-OTP only; do not attempt password-only login.
- Hi-Precision login needs `enforceSubresourceAllowlist: false` and `*.healthonlineasia.com` in `allowedDomains`.
- April uses OAuth+PKCE; `loginUrl` contains the `{{code_challenge}}` template token. Bare URL hits a JBoss error.
- COL serves the order URL with a "market is closed" body outside PSE hours — handled by `detectMarketClosed`.

---

## 14. Adding a new site

1. **Provision secrets** in Infisical at `/sites/<slug>` with `USERNAME`, `PASSWORD`, optional `TOTP_SECRET`. Wait for the sidecar to render (≤60 s).
2. **Add to `policies/sites.json`** — `displayName`, `riskLevel`, `loginUrl`, `allowedDomains`, `secretPrefix`, `secretPath`, `allowedTools`, `loginSelectors`, `loggedInUrlPatterns`/`loggedInSignals`. Pick `loginFlow` if not `single_step`.
3. **Add to one or more clients** in `policies/clients.json`.
4. **Write an extractor** in `worker/extractors/<slug>.js` exporting the action functions referenced in `allowedTools` (besides `login`/`logout`/`check_session`).
5. **Register each new action** in `mcp-server/server.js` `ACTIONS` table (description, optional `extra.required` + `extra.properties`). The boot-time drift guard will refuse to start if a schema uses a keyword the validator doesn't enforce.
6. **(Optional) Add a workflow prompt** to `mcp-server/lib/prompts.js` if the action benefits from a guided multi-step playbook (write operations, OTP flows).
7. **Enable diagnostics** temporarily (`BROWSER_INTENT_ENABLE_DIAGNOSTICS=true`), call the relevant `diagnose_*` tool to verify selectors against the live DOM, disable when done.
8. **Restart Hermes-side MCP clients** if Hermes is consuming the tool list (`feedback_hermes_mcp_tools_cache.md`). Policy-only changes to `loggedInUrlPatterns`/selectors do not require a Hermes restart; tool-surface changes do.
9. **Run the test suite** — `bash test.sh`. The `sitesAllowing` assertions and `assertActionsSchemasValidatorCompatible` self-check catch most wiring mistakes.

---

## 15. Adding a new client

1. Pick a `tokenEnvVar` name. Set it in `.env` to a 32+ byte random value.
2. Add an entry to `clients.json` with `tokenEnvVar`, `allowedSites: [...]`, `description`.
3. `docker compose up -d mcp` to pick up the env var. **OR** if mcp is already running and `.env` has been written to via a sidecar / env-writer, send `docker kill -s HUP browser-intent-mcp` to rebuild the token index without dropping sessions.

---

## 16. Operational scripts

### `start.sh`

```
validate .env exists
validate secrets.tmpl placeholder substituted
ops/fix-nat-prerouting.sh        # legacy Windows NAT routing
ops/repair-egress.sh             # recreate platform-egress if missing
docker compose up -d
wait for mcp healthz to be healthy
print http://127.0.0.1:18901
```

### `test.sh`

Runs `node --test` against `mcp-server/test/` and `worker/test/` inside a stock `node:24.14.0-bookworm` container. Fails the run if zero tests are discovered (catches the silent-pass case where the runner found no files).

Current counts: ~113 mcp-server tests + ~77 worker tests. The boot-time validator drift guard is also exercised at boot.

### `parse-april.py` / `parse-diag.py`

CLI summarizers for the JSON dumps produced by the diagnostic tools. Maintainer tools; not invoked by the system.

---

## 17. Security posture summary

- All containers: `cap_drop: ALL`, `no-new-privileges`, non-root user (uid 1000 / 1001).
- MCP HTTP port published on `127.0.0.1` only — no LAN/WAN exposure.
- Worker port not published at all — only reachable on `browser-internal` from mcp.
- Worker is the only service holding credentials; mcp never sees them.
- mcp↔worker traffic authenticated with shared secret (`crypto.timingSafeEqual`); tokens hashed before lookup (no length leak); URLs redacted in logs.
- LLM is told `download_path`, never URLs that include session cookies.
- Write tools (`submit_claim`, `place_order`) default to `dry_run: true`; receipt paths whitelisted; confirm buttons must match a verified allowlist or the worker refuses to click.
- Diagnostic tools off by default; structural-only output even when on.
- Audit trail per call with normalized `status_kind`, `policy_version` anchor, and `returned_sensitive_data` flag for SIEM.
- Per-client rate limit (token bucket) protects the worker queue from runaway loops.
- Per-Playwright-action timeout bounds the worst-case worker hang.
- `SIGHUP` enables token rotation without container restart.

---

## 18. Migration history & memory cross-references

Key incidents and design decisions captured in `~/.claude/projects/D--claude-workspace/memory/`:

- `project_browser_intent_tool_consolidation.md` — Flat `<action>` tools with site enum from sites.json; per-bearer-token site scoping in clients.json. (Tool catalog architecture.)
- `project_browser_intent_site_auth.md` — Per-site auth findings (Maxicare SMS-OTP, Hi-Precision domain config, April JBoss error).
- `project_browser_intent_worker_patterns.md` — Headless toggle, JA3 fingerprinting caveat, MCP HTTP bearer requirement.
- `project_browser_intent_xvfb_pid1_hang.md` — Xvfb PID 1 race; fix via mkdir+chmod in Dockerfile.
- `project_browser_intent_oauth_false_mfa.md` — April OAuth redirect-chain false-MFA fix via `pollConfirmLoggedIn`.
- `project_browser_intent_col_market_closed.md` — COL after-hours behavior; `detectMarketClosed` pattern.
- `project_infisical_agent_multipath_etag_bug.md` — Single-recursive-listSecrets workaround.
- `project_hermes_to_browser_intent_inbox.md` — Shared-volume file exchange (Hermes uid 10000 ↔ pwuser uid 1001).
- `feedback_hermes_mcp_tools_cache.md` — Hermes caches tools/list per connection; restart after tool-surface changes.

---

## 19. Cross-references (in-repo)

- [README.md](README.md) — operational guide (start/stop, env, troubleshooting)
- [policies/sites.json](policies/sites.json) — authoritative site config
- [policies/clients.json](policies/clients.json) — authoritative client registry
- [mcp-server/server.js](mcp-server/server.js) — MCP server entry
- [mcp-server/lib/audit.js](mcp-server/lib/audit.js) — audit emitter + STATUS_KIND vocabulary
- [mcp-server/lib/validator.js](mcp-server/lib/validator.js) — schema validator + drift guard
- [mcp-server/lib/prompts.js](mcp-server/lib/prompts.js) — workflow prompts catalog
- [worker/worker.js](worker/worker.js) — worker entry point
- [worker/extractors/](worker/extractors/) — per-site extractor modules
- [agent-config/secrets.tmpl](agent-config/secrets.tmpl) — Infisical template (single-recursive-call etag workaround)
- [TOMORROW-COL-DIAGNOSTIC.md](TOMORROW-COL-DIAGNOSTIC.md) — fallback playbook for the in-progress COL confirm-button discovery
