# Browser-Intent MCP Server — Architecture

> **Audience.** This document is written for a future maintainer or LLM that has never seen the codebase and needs enough detail to understand, operate, debug, or replicate the system. The companion [README.md](README.md) covers day-to-day operations (start/stop, env, etc.); this document covers *how* and *why* the pieces fit.

---

## 1. System at a glance

Browser-Intent is an MCP (Model Context Protocol) server that lets an LLM drive headless browser automation against a curated set of authenticated portals (insurance, medical, brokerage) without ever touching credentials or raw page HTML. It is one of the on-demand stacks in the IronNest platform.

Three Docker services on one host:

```
┌──────────────────────────┐    ┌──────────────────────────┐    ┌────────────────────────────┐
│  infisical-agent         │    │  mcp                     │    │  worker                    │
│  (sidecar; polls 60s)    │    │  Node 24, stdio + HTTP   │    │  Node 24 + Playwright      │
│                          │    │  :18901 (127.0.0.1 only) │    │  :18902 (internal only)    │
│  renders                 │    │                          │    │                            │
│  /sites/* secrets to     │    │  validates auth, scope,  │    │  per-site sessions,        │
│  secrets-runtime/.env    │───►│  schema → dispatches via │───►│  rate limits, OTP state,   │
│  (mtime-watched)         │    │  HTTP+shared secret to   │    │  extractor modules,        │
│                          │    │  the worker              │    │  PDF fetch to /results     │
└──────────────────────────┘    └──────────────────────────┘    └────────────────────────────┘
        ▲                                ▲                                  ▲
        │ Infisical Universal Auth       │ Bearer token (HTTP) or stdio    │ /uploads/from-hermes (ro)
        │                                │                                  │ /results (rw)
   IronNest Infisical                 LLM client                        Shared Hermes volume
```

Key design principles:

- **Narrow policy gates** — every tool, resource, and prompt is the intersection of `site.allowedTools` × `client.allowedSites`. A client cannot even *see* tools for a site it is not scoped to.
- **Zero credentials to the LLM** — usernames, passwords, TOTP secrets, raw HTML, and cookie-gated URLs never appear in any response.
- **Session-based auth** — `login`/`check_session`/`logout` gate every data tool; sessions are cached for 15 min (configurable) and reused to avoid rate limits.
- **Rotation-safe** — Infisical sidecar re-renders `/secrets/.env` on every change; worker uses mtime-keyed caching so rotations land on the next call with no restart.
- **Defense in depth** — MCP validates → dispatcher re-scopes → worker re-validates. URLs are redacted in every log path. Audit events carry a normalized `status_kind`.

---

## 2. Repository layout

```
browser-intent/
├── docker-compose.yml         # 3 services, 4 networks, 1 external volume
├── Dockerfile.mcp             # Node 24 (Bookworm), runs as uid 1000 (node)
├── Dockerfile.worker          # Playwright 1.56.1 (Noble), runs as uid 1001 (pwuser)
├── start.sh                   # boot: validate env → repair egress → compose up → wait healthy
├── test.sh                    # `node --test` in a stock node:24 container
├── README.md                  # operational guide
├── ARCHITECTURE.md            # this file
│
├── mcp-server/
│   ├── server.js              # MCP server: stdio + HTTP + Streamable-HTTP, ~1500 lines
│   ├── package.json           # no runtime deps (Node built-ins only)
│   └── test/server.test.js    # auth, policy filtering, schema validator, status_kind
│
├── worker/
│   ├── worker.js              # HTTP server (18902); login/extract dispatch; session map
│   ├── entrypoint.sh          # conditional xvfb-run wrapper (only when headed)
│   ├── package.json           # playwright, playwright-extra, stealth plugin
│   ├── extractors/
│   │   ├── _diagnose.js          # frame/form/link summarizers shared by diagnostic tools
│   │   ├── april_international.js  # policies, claims, claim submission (OAuth PKCE)
│   │   ├── col_financial.js        # portfolio table extraction
│   │   ├── hi_precision.js         # lab results + PDF fetch through authed context
│   │   └── maxicare.js             # policy summary, account info (SMS-OTP login)
│   └── test/                  # extractors.test.js, worker.test.js
│
├── policies/
│   ├── sites.json             # per-site config (selectors, allowed tools, domains, …)
│   └── clients.json           # bearer-token client registry (env var → allowed sites)
│
├── agent-config/              # Infisical Agent sidecar
│   ├── agent.yaml             # daemon mode, 60s poll, output → /secrets/.env
│   ├── entrypoint.sh          # writes client_id/secret to tmpfs, exec's agent
│   └── secrets.tmpl           # single recursive listSecrets — see §5 for etag bug
│
├── secrets-runtime/           # rendered by sidecar; bind-mounted ro into worker
│   ├── .env                   # COL_FINANCIAL_USERNAME=… (site-prefixed keys)
│   ├── .gitkeep
│   └── agent-token            # opaque Infisical sink; unused by worker
│
├── uploads/from-hermes/       # Hermes inbox; backed by external named volume
├── uploads-results/hi_precision/  # worker writes downloaded PDFs here, 24h TTL
│
├── april-diag.json            # maintainer dumps from diagnose_* tools
├── diag-output.json
├── parse-april.py             # CLI summarizer for april-diag.json
└── parse-diag.py              # CLI summarizer for diag-output.json
```

---

## 3. Docker Compose topology

### 3.1 Networks

| Network | Type | Purpose |
|---|---|---|
| `platform-net` | external | IronNest service LAN; mcp + worker attach here |
| `platform-egress` | external | Sidecar/proxy network (infisical-agent, squid, adguard) |
| `browser-internal` | internal bridge | Private mcp↔worker channel |
| `ingress` | bridge | MCP's public-facing side (published on 127.0.0.1:18901 only) |

### 3.2 Volumes

| Volume | Type | Mounts |
|---|---|---|
| `hermes-to-browser-intent` | external named | Hermes writes at `/opt/uploads-out` (uid 10000); worker reads ro at `/uploads/from-hermes` (uid 1001). Docker abstracts the uid translation. |
| `./policies` | bind, ro | Mounted into both mcp and worker |
| `./secrets-runtime` | bind | Written by infisical-agent, mounted ro into worker |
| `./uploads-results` | bind, rw | Mounted into worker at `/results` |

### 3.3 Services

#### `infisical-agent`

| Field | Value |
|---|---|
| Image | `infisical/cli@sha256:dba406b3…` (pinned to 0.43.76; see §5) |
| Entrypoint | `/agent-config/entrypoint.sh` |
| Env | `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/SECRET` from `.env` |
| Volumes | `./agent-config:ro`, `./secrets-runtime:/secrets`, tmpfs `/tmp:1m,0700` |
| Network | `platform-egress` only |
| Security | `cap_drop: ALL`, `no-new-privileges` |
| Resources | CPU 0.25, mem 64M |
| Healthcheck | `test -f /secrets/.env` (5s / 24 retries) |

#### `worker`

| Field | Value |
|---|---|
| Image | `platform/browser-intent-worker:0.1.0` (built from `Dockerfile.worker`) |
| User | `pwuser` (uid 1001) |
| Port | `18902` internal only |
| Env file | `secrets-runtime/.env` (optional) |
| Env | `NODE_ENV=production`, `BROWSER_INTENT_HEADLESS=true`, `BROWSER_INTENT_WORKER_SECRET` (required), squid proxy vars, session/rate tunables (§10) |
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
| Env | `BROWSER_WORKER_URL=http://browser-intent-worker:18902`, `BROWSER_INTENT_MCP_TOKEN`, `BROWSER_INTENT_MCP_TOKEN_DR_SMITH` (optional), `BROWSER_INTENT_WORKER_SECRET` (must match worker), `BROWSER_INTENT_ENABLE_DIAGNOSTICS` (default unset) |
| Volumes | `./policies:ro` |
| Networks | `ingress`, `platform-net` |
| depends_on | `worker: service_healthy` |
| Resources | CPU 0.5, mem 256M |
| Healthcheck | `GET http://localhost:18901/healthz` |

---

## 4. MCP server (`mcp-server/server.js`)

### 4.1 Bootstrap

1. Self-test: `assertActionsSchemasValidatorCompatible()` walks the ACTIONS table and fails to start if any schema uses a JSON-Schema keyword the bundled validator does not support.
2. Eager-load `clients.json`; warn (do not fail) when a client's `tokenEnvVar` is unset.
3. Start `fs.watch` on the policies dir with a 200 ms debounce.
4. Bind stdio JSON-RPC handlers.
5. Bind HTTP server on `BROWSER_INTENT_HTTP_PORT` (default 18901).

### 4.2 Transports

**Stdio (implicit admin).** The process reads JSON-RPC from stdin and writes to stdout/stderr. A pseudo-client is hard-coded: `{name: "stdio", allowedSites: "*", tokenEnvVar: null}`. Anyone with process access wins — this is reserved for container-internal operators and tests.

**HTTP (bearer-token, scoped).** Endpoints:

| Method/Path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | `{ok, status: "live", policy_version}` |
| `GET /sites` | bearer | Sites visible to caller |
| `POST /mcp` | bearer | JSON-RPC 2.0; supports protocol `2024-11-05` and `2025-06-18` |
| `GET /mcp` | bearer | Streamable-HTTP SSE stream (2025-06-18 only) |
| `DELETE /mcp` | bearer | Explicit session teardown (2025-06-18 only) |

Every HTTP response carries `Mcp-Policy-Version: <12-hex>` for drift detection. JSON-RPC errors are returned as HTTP 200 with `{jsonrpc, id, error}`; pure notifications return HTTP 202.

### 4.3 Authentication model

`clients.json`:

```json
{
  "clients": {
    "admin":            { "tokenEnvVar": "BROWSER_INTENT_MCP_TOKEN",          "allowedSites": "*" },
    "hermes_dr_smith":  { "tokenEnvVar": "BROWSER_INTENT_MCP_TOKEN_DR_SMITH", "allowedSites": ["april_international", "hi_precision"] }
  }
}
```

At startup, the server builds `_tokenIndex: sha256(token) → client`. Incoming `Authorization: Bearer …` is sha256'd in constant time, then map-looked-up (no length leak; empty-string bearer rejected before hashing). Clients whose `tokenEnvVar` is unset are silently skipped — adding entries to `clients.json` without provisioning the env var is a safe no-op.

### 4.4 Policy & client caching

Both files use the same mtime-keyed pattern:

```
_policyCache = { mtimeMs, data }
read() { stat(path); if mtime changed → re-parse; return data }
```

`stat()` is sub-millisecond and works through Docker Desktop bind mounts (no inotify dependency). The `policyVersion()` helper returns the 12-char prefix of `sha256(sites.json) ⊕ sha256(clients.json)` and is computed per-call so it always reflects current state — necessary because `fs.watch` is unreliable on Windows.

On any policy change, the server broadcasts `notifications/{tools,resources,prompts}/list_changed` to stdio sinks and any open SSE streams. HTTP-only clients detect drift via the response header.

### 4.5 Tool catalog (ACTIONS)

For each tool, the `site` parameter's enum is dynamically narrowed to `(sites where allowedTools contains this tool) ∩ (client.allowedSites)`. If the intersection is empty, the tool is removed from `tools/list` for that client entirely.

| Tool | Sites | Purpose / return shape |
|---|---|---|
| `login` | all | `{status}`; never returns post-login data. Statuses: `logged_in`, `awaiting_otp`, `awaiting_fresh_sms`, `rate_limited`, `needs_user_action`, `needs_site_selector_update` |
| `logout` | all | `{status: "logged_out"}` |
| `check_session` | all | `{status: "logged_in" \| "logged_out"}` |
| `provide_otp` | maxicare | `{site, code}` → `{status, next_action?: {type, wait_seconds?, tool?, site?}, failure_kind?}` |
| `get_portfolio` | col_financial | holdings array + totals |
| `get_account_info` | maxicare, april_international | profile fields |
| `get_policy_summary` | maxicare | list of policies + `card_added` flag |
| `get_policy_info` | april_international | policy details + insured members |
| `get_claims_history` | april_international | last 50 claims |
| `get_claim_status` | april_international | full timeline for one claim |
| `get_documents_list` | april_international | downloadable docs (name + url) |
| `get_results` | hi_precision | results array with `download_path` (no URL — see §7) |
| `submit_claim` | april_international | WRITE. `dry_run` defaults to **true** |
| `list_browser_intent_sites` | — | introspection: what this caller can see |
| `diagnose_login_form`, `diagnose_member_portal`, `diagnose_portfolio`, `diagnose_claim_form` | varies | Maintainer-only. Hidden unless `BROWSER_INTENT_ENABLE_DIAGNOSTICS=true` |

### 4.6 Prompts (workflow templates)

Prompts compose tools into multi-step flows the LLM can `prompts/get` to receive a guided playbook:

- `submit_claim_from_receipt` — check_session → login (with OTP) → dry-run preview → user confirmation → real submit
- `complete_otp_login` — login → read SMS code → provide_otp with `next_action` handling
- `fetch_recent_results` — check_session → login → get_results
- `check_policy_status` — check_session → login → get_account_info (+ optional get_policy_info/summary)
- `diagnose_failed_login` — diagnose_login_form + compare against configured selectors

A prompt is filtered out of `prompts/list` for a client unless every site that satisfies the prompt's `requiredActions` is also in the client's `allowedSites`.

### 4.7 Resources

- `browser-intent://sites` — index of visible sites
- `browser-intent://sites/{siteId}` — `{site, displayName, riskLevel, allowedTools}` only — never `loginUrl`, `secretPath`, or `loginSelectors`.

### 4.8 Schema validation

`server.js` ships a small hand-rolled JSON Schema validator (avoiding an ajv dependency). It supports `type`, `enum`, `pattern`, `min/maxLength`, `exclusiveMinimum`, `items`, `maxItems`, `required`, `additionalProperties`. The boot-time self-check fails fast if a future ACTIONS schema uses an unsupported keyword. Args are validated at the MCP layer and again at dispatch (defense in depth).

### 4.9 Logging

All audit events go to stderr as one JSON object per line:

```json
{
  "timestamp": "…",
  "component": "browser-intent-mcp",
  "event_type": "audit",
  "status_kind": "success|needs_user|session_expired|rate_limited|needs_update|denied|error|unknown",
  "tool": "…", "client": "…", "site": "…", "result": "…",
  "returned_sensitive_data": false
}
```

Fluent Bit ships these to Wazuh OpenSearch (`ironnest-containers-*`). URLs are scrubbed with `URL_REDACT_RE` (replaced with `origin+pathname`) and truncated at 500 chars before logging.

### 4.10 Streamable-HTTP sessions (protocol 2025-06-18)

A `_sessions` map keyed by session ID stores `{version, client, createdAt, lastSeen, sseSink}`. An idle reaper drops entries with `lastSeen > 1h`. The `GET /mcp` endpoint registers a response stream as a notification sink; `DELETE /mcp` tears it down explicitly. Legacy clients (`2024-11-05`) get plain request/response.

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

Key derivation: `/sites/col-financial` + `USERNAME` → `COL_FINANCIAL_USERNAME`.

### 5.2 The etag bug we work around

Infisical CLI ≤ 0.43.76 threads a single `*currentEtag` pointer through every template call. With *separate* `range listSecrets` blocks per site, the final etag only tracks the last site, and changes to any other site are silently missed. The fix is a single **recursive** `listSecrets` call covering the whole `/sites` subtree — the server returns one etag covering all children, and the template iterates client-side.

### 5.3 Worker-side cache

`readRenderedSecrets()` stats `/secrets/.env`, parses only when mtime changes, and caches the parsed map. Lookup order is **file-rendered first, then `process.env`** so rotations win without restart. `secret(site, key)` throws on missing; `optionalSecret(site, key)` returns `""` (used for optional TOTP).

---

## 6. Worker (`worker/worker.js`)

### 6.1 Process model

- Node 24 + Playwright 1.56.1 + playwright-extra + puppeteer-extra-plugin-stealth (17 evasions — 16 active; `user-agent-override` is disabled because we set UA via `setExtraHTTPHeaders`).
- Headless toggle via `BROWSER_INTENT_HEADLESS` (default `true`). When `false`, `entrypoint.sh` wraps the process with `xvfb-run`; in headless mode it does *not* wrap, avoiding the PID-1 race documented in `feedback_browser_intent_xvfb_pid1_hang`.
- Stealth does **not** fix TLS JA3 fingerprinting. Sites that fingerprint TLS need real Chrome over CDP (currently not used).

### 6.2 In-memory state

| Map | Purpose |
|---|---|
| `sessions[siteId]` | Active session: `{browser, context, page, startedAt, lastActivity}` |
| `pendingOtpSessions[siteId]` | Session waiting for `provide_otp`, with `expiresAt` |
| `smsCooldown[siteId]` | `{until, smsLikelyFresh}` — informs whether re-login would burn a fresh SMS |
| `loginAttempts[siteId]` | Timestamps for sliding-window rate limit |
| `siteLocks[siteId]` | Promise chain — login/logout/extract on the same site serialize |

A reaper sweeps every 60 s (configurable) and closes sessions idle longer than 15 min.

### 6.3 Session lifecycle

1. `login()` is called. If a usable session exists, short-circuit and refresh `lastActivity` (does not count against the rate limit).
2. Otherwise, rate-limit check (default 5 logins per 15 min, sliding window).
3. Launch Chromium; new BrowserContext per site (ephemeral, no `userDataDir`).
4. Configure context: `Accept-Language`, `Accept-Encoding`, `Sec-Fetch-*` headers via `setExtraHTTPHeaders`; per-request header patching via interception.
5. Drive the form (selector chain, keystroke typing, humanized cursor jitter, hidden-input prefill — see §6.4).
6. Confirm logged-in via `confirmLoggedIn()` (§6.5).
7. Promote the session to `sessions[siteId]`.

For SMS-OTP sites (Maxicare): step 5 fills only the username, clicks Continue, parks the session in `pendingOtpSessions` with a TTL (default 300 s), and returns `{status: "awaiting_otp"}`. A subsequent `provide_otp` fills the code keystroke-by-keystroke (not `.fill()` — Maxicare bot-detector trips otherwise), submits, and on success promotes to `sessions`. The OTP flow tracks the upstream "Resend in M:SS" countdown to know whether a re-login during cooldown would burn a fresh SMS (sets `awaiting_fresh_sms` and aborts if not).

### 6.4 Login form filling

- Selectors live under `site.loginSelectors` (CSS, playwright-compatible). `firstVisible(page, selectors)` iterates the array and picks the first visible match.
- Three login flow types (`site.loginFlow`):
  - `single_step` (default) — fill username, Tab, fill password, move to submit, press Enter
  - `multi_step` — username → Continue → wait for password → fill password → Enter
  - `username_otp` — username → Continue → wait for OTP input → return `awaiting_otp`
- Typing uses `type()` with a 25 ms delay (fires keystroke events real bot detectors look for, not just `value=`).
- Pre-interaction dwell + `humanMoveTo(page, locator)` produces a smooth cursor path with jitter.
- `site.prefillHidden` lets a site set hidden inputs (literal value, or `{{location.href}}` token resolved at fill time).
- TOTP auto-fill: if `site.loginSelectors.totp` exists and `TOTP_SECRET` is provisioned, `tryTotp()` fills/submits at offsets −1/0/+1 windows for boundary safety.

### 6.5 Logged-in confirmation

`confirmLoggedIn(page, site)`:
1. If current URL (stripped of query/hash) equals `site.loginUrl`, declare not-logged-in (form rejected silently).
2. Substring-match the URL against `site.loggedInUrlPatterns` (preferred).
3. Fallback: case-insensitive `innerText` search for `site.loggedInSignals` (e.g. "logout", "sign out", "dashboard").

### 6.6 Failure taxonomy

Returned as `{status}` from `login()`:
- `needs_site_selector_update` — selector not found, or form fill threw. Includes a snapshot of page metadata for maintainer debugging.
- `needs_user_action` — MFA / CAPTCHA visible (`mfaLikely(page)` matches reCAPTCHA / Turnstile / hCaptcha scripts/hosts or OTP/MFA text).
- `rate_limited` — local sliding-window limit hit; `retry_after_seconds` returned.
- `awaiting_fresh_sms` — re-login attempted inside the SMS cooldown window.

### 6.7 HTTP API

| Method/Path | Body | Notes |
|---|---|---|
| `GET /healthz` | — | No auth |
| `POST /login` | `{site, code?}` | `code` only for legacy OTP path |
| `POST /logout` | `{site}` | |
| `POST /session` | `{site}` | check_session |
| `POST /provide-otp` | `{site, code}` | |
| `POST /extract` | `{site, action, args}` | |

Every POST requires `X-Worker-Auth: <BROWSER_INTENT_WORKER_SECRET>` checked with `crypto.timingSafeEqual`. Failures are 401 and audit-logged as `worker_auth_rejected`.

### 6.8 Extractors

Each module under `worker/extractors/` exports async functions that run inside an active session.

- **`col_financial.js`** — table-based portfolio extraction on `/ape/Final2/main/`. Header-matching guards (market value, quantity) protect against silent layout shifts.
- **`maxicare.js`** — policy summary + account info on `/policy`, `/home`. Uses the OTP-aware session.
- **`april_international.js`** — OAuth2 PKCE login; post-login pages `/home`, `/policy`, `/claims`. Implements `submit_claim` with file attachment (receipts mounted from the Hermes shared volume).
- **`hi_precision.js`** — table-based result list on `/dashboard.do`, plus PDF fetch (see §7).

### 6.9 Diagnostic helpers (`_diagnose.js`)

`collectFrameSummaries`, `collectFrameLinksMatching`, `summarizeForms`, `sanitizeUrl` — used by the `diagnose_*` tools to return *structural* page metadata (form actions, input names, button text, link patterns) without leaking raw HTML or tokens.

---

## 7. Hi-Precision PDF fetch (the cookie-gated download pattern)

The naive approach — return the PDF URL to the LLM — would leak a session-cookied URL into the prompt context, where it could be exfiltrated. Instead:

1. After `get_results` parses the result table, for each row with a download link:
2. Worker calls `page.context().request.get(url)` — shares the active session's cookies and TLS profile.
3. Cap body at 20 MB (`BROWSER_INTENT_RESULT_MAX_BYTES`).
4. Atomic write: `<lab>.<pid>.tmp` → rename to `<lab>.pdf` in `/results/hi_precision/`.
5. Return `{download_path: "/results/hi_precision/HIP-…pdf", download_bytes, download_status}`. **No URL in the response.**
6. Prune files older than 24 h (`BROWSER_INTENT_RESULT_TTL_HOURS`) on the way out (best-effort, non-fatal).

`/results` is bind-mounted from `./uploads-results/` on the host, so Hermes or another component on the platform LAN can pick the file up by path.

---

## 8. Hermes ↔ Browser-Intent file exchange

Hermes (a different IronNest stack, uid 10000) deposits documents that Browser-Intent then attaches to claim submissions. The mechanism is a shared external Docker named volume:

| Mount | Container | Mode | UID |
|---|---|---|---|
| `/opt/uploads-out` | Hermes | rw | 10000 |
| `/uploads/from-hermes` | Browser-Intent worker | ro | 1001 (pwuser) |

Docker's named-volume permissions abstract the uid translation. Within `submit_claim`, the `receipts` array accepts paths matched by `^/uploads/[^\.][^\s]*$` (whitelist prefix, reject traversal) — paths that point outside `/uploads/from-hermes` are rejected.

Operational notes (carried from prior incidents): the volume must already exist before `docker compose up`; `autostart.ps1` creates it during the bootstrap stack so this is normally invisible.

---

## 9. End-to-end request flow

```
LLM client (Hermes, CLI, …)
   │  HTTP POST /mcp  Authorization: Bearer <t>
   ▼
mcp (Node, :18901)
   │  1. authenticateClient(headers) → {name, allowedSites, …}
   │  2. validate JSON-RPC envelope, dispatch method
   │  3. for tools/call: re-scope site enum, validate args, audit start
   │  4. POST http://browser-intent-worker:18902/<endpoint>
   │     X-Worker-Auth: <BROWSER_INTENT_WORKER_SECRET>
   ▼
worker (Node + Playwright, :18902)
   │  5. timingSafeEqual on X-Worker-Auth
   │  6. withSiteLock(siteId, …) — serialize on the site
   │  7. login: rate limit → reuse cached session or launch Chromium → drive form → confirm
   │     extract: load extractor module → navigate → parse → (hi_precision) fetch PDFs
   │     provide_otp: promote pending session
   │     logout: close browser, clean up maps
   │  8. return {status, …}
   ▲
   │  9. mcp audit-logs result (status_kind, returned_sensitive_data, …)
   │ 10. response: {content: [{type:"text", text:JSON.stringify(result)}], isError:false}
   │     headers: Mcp-Policy-Version, (2025-06-18) Mcp-Session-Id
   ▼
LLM client
```

---

## 10. Configuration & tunables

### 10.1 `.env` (host-level, required)

| Variable | Purpose |
|---|---|
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID` | Machine identity for sidecar |
| `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET` | — |
| `BROWSER_INTENT_MCP_TOKEN` | Admin HTTP bearer |
| `BROWSER_INTENT_MCP_TOKEN_DR_SMITH` | Hermes-scoped bearer (optional) |
| `BROWSER_INTENT_WORKER_SECRET` | Shared secret for the mcp↔worker channel; identical value on both services |
| `TZ` | Optional |

### 10.2 Worker tunables

| Variable | Default | Purpose |
|---|---|---|
| `BROWSER_INTENT_POLICY_PATH` | `/app/policies/sites.json` | |
| `BROWSER_INTENT_HEADLESS` | `true` | `false` → xvfb-run wraps |
| `BROWSER_INTENT_SESSION_IDLE_MINUTES` | `15` | Reaper threshold |
| `BROWSER_INTENT_SESSION_SWEEP_SECONDS` | `60` | Reaper interval |
| `BROWSER_INTENT_LOGIN_MAX_PER_WINDOW` | `5` | Rate limit |
| `BROWSER_INTENT_LOGIN_WINDOW_MINUTES` | `15` | Sliding window |
| `BROWSER_INTENT_OTP_TTL_SECONDS` | `300` | Pending OTP session lifetime |
| `BROWSER_INTENT_RESULTS_DIR` | `/results` | PDF output |
| `BROWSER_INTENT_RESULT_MAX_BYTES` | `20971520` | 20 MB cap |
| `BROWSER_INTENT_RESULT_TTL_HOURS` | `24` | Auto-prune |
| `HTTP_PROXY` / `HTTPS_PROXY` | `http://squid:3128` | |
| `NO_PROXY` | service hostnames | |

### 10.3 MCP tunables

| Variable | Default | Purpose |
|---|---|---|
| `BROWSER_INTENT_POLICY_PATH` | `/app/policies/sites.json` | |
| `BROWSER_INTENT_CLIENTS_PATH` | `/app/policies/clients.json` | |
| `BROWSER_WORKER_URL` | `http://browser-intent-worker:18902` | |
| `BROWSER_INTENT_HTTP_PORT` | `18901` | |
| `BROWSER_INTENT_ENABLE_DIAGNOSTICS` | unset | When `true`, expose `diagnose_*` tools |
| `BROWSER_INTENT_SESSION_TTL_SECONDS` | `3600` | Streamable-HTTP idle timeout |

---

## 11. Currently configured sites

| Site key | Display | Risk | Flow | Notable tools |
|---|---|---|---|---|
| `col_financial` | COL Financial | financial | single_step | `get_portfolio` |
| `maxicare` | Maxicare | medical | username_otp | `provide_otp`, `get_policy_summary`, `get_account_info` |
| `april_international` | April International | insurance | single_step (PKCE) | `get_policy_info`, `get_claims_history`, `get_claim_status`, `submit_claim`, `get_documents_list` |
| `hi_precision` | Hi-Precision | medical | single_step | `get_results` (PDF fetch) |

Per-site quirks captured elsewhere:
- Maxicare is SMS-OTP only.
- Hi-Precision login needs `enforceSubresourceAllowlist: false` and `*.healthonlineasia.com` in `allowedDomains` (the JA3 verdict was wrong).
- April bare URL produces a JBoss security-domain error; use the PKCE login URL.

---

## 12. Adding a new site

1. **Provision secrets** in Infisical at `/sites/<slug>` with `USERNAME`, `PASSWORD`, optional `TOTP_SECRET`. Wait for the sidecar to render (≤60 s).
2. **Add to `policies/sites.json`** — `displayName`, `riskLevel`, `loginUrl`, `allowedDomains`, `secretPrefix`, `secretPath`, `allowedTools`, `loginSelectors`, `loggedInUrlPatterns`/`loggedInSignals`. Pick `loginFlow` if not `single_step`.
3. **Add to one or more clients** in `policies/clients.json`.
4. **Write an extractor** in `worker/extractors/<slug>.js` exporting the action functions referenced in `allowedTools` (besides `login`/`logout`/`check_session`).
5. **Register the action** in `mcp-server/server.js` ACTIONS table (so its schema enum can include the new site).
6. **Enable diagnostics** temporarily (`BROWSER_INTENT_ENABLE_DIAGNOSTICS=true`), call `diagnose_*` to verify selectors against the live DOM, disable when done.
7. **Restart Hermes-side MCP clients** if Hermes is consuming the tool list (`feedback_hermes_mcp_tools_cache.md`). Policy-only changes to `loggedInUrlPatterns`/selectors do not require a Hermes restart; tool-surface changes do.

---

## 13. Adding a new client

1. Pick a `tokenEnvVar` name. Set it in `.env` to a 32+ byte random value.
2. Add an entry to `clients.json` with `tokenEnvVar`, `allowedSites: [...]`, `description`.
3. `docker compose up -d mcp` to pick up the env var (the policy file is mtime-watched but the env var is not).

---

## 14. Operational scripts

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

Runs `node --test` against `mcp-server/test/` and `worker/test/` inside a stock `node:24.14.0` container. Fails the run if zero tests are discovered (catches the silent-pass case).

### `parse-april.py` / `parse-diag.py`

CLI summarizers for the JSON dumps produced by the diagnostic tools. Maintainer tools; not invoked by the system.

---

## 15. Security posture summary

- All containers: `cap_drop: ALL`, `no-new-privileges`, non-root user (uid 1000 / 1001).
- MCP HTTP port published on `127.0.0.1` only — no LAN/WAN exposure.
- Worker port not published at all — only reachable on `browser-internal`.
- Worker is the only service holding credentials; mcp never sees them.
- mcp↔worker traffic authenticated with shared secret (`timingSafeEqual`); tokens hashed before lookup; URLs redacted in logs.
- LLM is told `download_path`, never URLs that include session cookies.
- `submit_claim` defaults to `dry_run: true`; receipt paths whitelisted.
- Diagnostic tools off by default; structural-only output even when on.
- Audit trail per call with normalized `status_kind` for SIEM.

---

## 16. Cross-references

- [README.md](README.md) — operational guide (start/stop, env, troubleshooting)
- [policies/sites.json](policies/sites.json) — authoritative site config
- [policies/clients.json](policies/clients.json) — authoritative client registry
- [mcp-server/server.js](mcp-server/server.js) — single-file MCP server
- [worker/worker.js](worker/worker.js) — worker entry point
- [agent-config/secrets.tmpl](agent-config/secrets.tmpl) — Infisical template (note the single-recursive-call etag workaround)
