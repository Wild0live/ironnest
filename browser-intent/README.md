# Browser Intent

Browser Intent is the localhost-only, policy-gated browser automation stack for IronNest.

It exposes narrow MCP tools such as `login` and `logout` (each taking a `site` argument restricted to policy-allowlisted values); it does not expose raw browser controls, screenshots, cookies, DOM access, JavaScript evaluation, arbitrary navigation, or Infisical secret reads.

## Containers

| Container | Purpose |
|---|---|
| `browser-intent-mcp` | MCP and local HTTP front door. Validates tool calls and returns minimal JSON. |
| `browser-intent-worker` | Playwright browser worker. Performs site-specific login/logout flows. |
| `browser-intent-infisical-agent` | Infisical Agent sidecar. Renders secrets into `secrets-runtime/.env`. |

## Secret Layout

Store site credentials in Infisical under the IronNest project:

```text
/sites/col-financial
  USERNAME
  PASSWORD
  TOTP_SECRET optional

/sites/maxicare
  USERNAME
  PASSWORD
  TOTP_SECRET optional

/sites/april-international
  USERNAME
  PASSWORD
  TOTP_SECRET optional

/sites/hi-precision
  USERNAME
  PASSWORD
  TOTP_SECRET optional
```

The sidecar renders them as site-prefixed environment keys consumed only by the worker:

```text
COL_FINANCIAL_USERNAME
COL_FINANCIAL_PASSWORD
MAXICARE_USERNAME
MAXICARE_PASSWORD
APRIL_INTERNATIONAL_USERNAME
APRIL_INTERNATIONAL_PASSWORD
HI_PRECISION_USERNAME
HI_PRECISION_PASSWORD
```

The AI never receives these values.

### Credential rotation is zero-restart

The Infisical sidecar re-renders `secrets-runtime/.env` whenever an upstream secret changes. The worker mounts that directory at `/secrets:ro` and reads `/secrets/.env` on each credential lookup, keyed by the file's mtime, so rotated values are picked up on the next login call — typically within ~1 minute of the sidecar refresh and **without** `docker compose up -d --force-recreate worker`.

The compose `env_file` on the worker remains as a bootstrap fallback (populates `process.env` at container start, used only if the runtime file is unreadable). Override the read path with `BROWSER_INTENT_SECRETS_FILE` if needed.

## Policy

### Site policy (`policies/sites.json`)

Each site has:

- allowed domains
- login URL
- secret environment key prefix
- allowed MCP tools (`allowedTools` is the authoritative list of actions any client may run against the site)
- optional selector hints for deterministic login

Maxicare's portal URL was confirmed against Maxicare's public website on 2026-05-14: member portal is at `https://membergateway.maxicare.com.ph/login`. Login selectors are still generic and may need tuning after the first real login attempt — the worker will return `needs_site_selector_update` if so.

### Client policy (`policies/clients.json`)

Each MCP client (= one bearer token) maps to a site allowlist. The MCP server narrows every tool's `site` enum to the intersection of (a) `sites.json` `allowedTools` for that action and (b) the calling client's `allowedSites`. A tool whose intersection is empty is dropped from `tools/list` entirely; a `tools/call` for a non-allowed site is rejected at the dispatcher (audit log: `result: "denied_by_client_policy"`).

Each entry references a `tokenEnvVar` — never the token value itself. Clients whose `tokenEnvVar` is unset at runtime are silently skipped (cannot match any request), so listing a client in this file without provisioning the matching env var is a no-op rather than a security hole.

The shipped `clients.json` declares:

| Client | tokenEnvVar | Sites |
|---|---|---|
| `admin` | `BROWSER_INTENT_MCP_TOKEN` | `*` (all sites — full access; backward compat with the previous single-token design) |
| `hermes_dr_smith` | `BROWSER_INTENT_MCP_TOKEN_DR_SMITH` | `april_international` |

stdio callers run as an implicit admin client (full access). HTTP is the only ingress that requires a bearer token.

## Start

```bash
cp browser-intent/.env.example browser-intent/.env
# edit .env and browser-intent/agent-config/secrets.tmpl
# .env requires (each generated with: openssl rand -hex 32):
#   - BROWSER_INTENT_MCP_TOKEN          — bearer for the admin HTTP client
#   - BROWSER_INTENT_WORKER_SECRET      — shared secret for MCP↔worker auth
./browser-intent/start.sh
```

The local API is published at `http://127.0.0.1:18901`. The HTTP transport
(`POST /mcp`, `GET /sites`) requires `Authorization: Bearer <token>` where the
token matches one of the entries in `policies/clients.json` whose env var is
provisioned. The matched client's `allowedSites` narrows what the request can
see and do. `GET /healthz` is open. The stdio transport is unauthenticated by
design (runs as the implicit admin client).

```powershell
# Quick sanity check
$token = (Get-Content .env | Select-String '^BROWSER_INTENT_MCP_TOKEN=').Line.Split('=',2)[1]
Invoke-RestMethod -Uri http://127.0.0.1:18901/mcp -Method Post `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType 'application/json' `
  -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## MCP Tools

Each action is exposed as a single tool that takes a `site` argument. The `site` enum on every tool is derived from `policies/sites.json` — only sites whose `allowedTools` list the action are accepted. A disallowed `(site, action)` combination is rejected at the MCP schema layer before the dispatcher runs (defense-in-depth: the dispatcher re-checks too).

Session:

- `login` — `{ site }`. Returns only login status; for sites whose policy declares `loginFlow=username_otp`, status `"awaiting_otp"` means call `provide_otp` next.
- `logout` — `{ site }`.
- `check_session` — `{ site }`.
- `provide_otp` — `{ site, code }`. Complete an OTP login by submitting the 4–8 digit SMS code. `next_action` in the response tells you what to do on a wrong code or upstream cooldown — DO NOT default to re-calling `login` when it says wait.

Post-login data:

- `get_portfolio` — `{ site }`. Currently allowlisted on `col_financial` only. Returns holdings (symbol, quantity, average cost, last price, market value, unrealized P&L) and totals.
- `get_account_info` — `{ site }`. Allowlisted on `maxicare`, `april_international`.
- `get_policy_summary` — `{ site }`. Allowlisted on `maxicare`.
- `get_policy_info` — `{ site }`. Allowlisted on `april_international`.
- `get_claims_history` — `{ site }`. Allowlisted on `april_international`.
- `get_claim_status` — `{ site, claim_id }`. Allowlisted on `april_international`. Full detail for a single claim (status, paid/outstanding amounts, dates, beneficiary, provider, notes).
- `get_documents_list` — `{ site }`. Allowlisted on `april_international`.
- `get_results` — `{ site }`. Allowlisted on `hi_precision`. Returns a list of test result rows (lab number, branch, order date, patient identifiers, type) plus, per row, a worker-local `download_path` where the PDF has been written, `download_bytes`, `download_content_type`, and `download_status` (`ok` / `too_large` / `download_failed` / `no_url`). The worker fetches each PDF through the active browser session and writes it to `/results/<site>/<lab_number>.pdf` inside the worker container (host bind: `browser-intent/uploads-results/`). Cookie-gated URLs are NEVER returned to the LLM. Files are auto-pruned 24h after write; cap is 20 MB per PDF.

Write operations (mutate upstream state — flagged in audit log with `write_operation: true`):

- `submit_claim` — `{ site, treatment_date (YYYY-MM-DD), claim_amount, beneficiary?, provider?, currency?, description?, receipts?: [/uploads/...], dry_run?: true }`. Allowlisted on `april_international`. Defaults to `dry_run: true`: fills the form and returns a sanitized preview (which selectors matched, how many receipts attached) but does NOT click submit. Set `dry_run: false` to actually submit. Receipt files must live under `/uploads` inside the worker container — mount a host directory there to use this.

Sites enumeration:

- `list_browser_intent_sites` — no args. Returns each site's display name, risk level, and allowed-tool list. No URLs, no secrets, no page data. Equivalent to reading the `browser-intent://sites` resource.

Diagnostics (maintainer tools — **off by default**):

Diagnostic tools are NOT shipped to the LLM in normal operation. Set `BROWSER_INTENT_ENABLE_DIAGNOSTICS=true` on the `browser-intent-mcp` service (e.g. in `.env`) to expose them; restart with `docker compose up -d browser-intent-mcp`. When enabled, the surface is:

- `diagnose_login_form` — `{ site }`. Pre-login; no credentials, no rate-limit cost.
- `diagnose_member_portal` — `{ site }`. Post-login dump of frame URLs, table headers, form-field metadata, and filtered link candidates.
- `diagnose_portfolio` — `{ site }`. Post-login; locates the portfolio page.
- `diagnose_claim_form` — `{ site }`. Post-login; dumps the claim-submission form metadata so a maintainer can author / repair `submit_claim` selectors against the current DOM.

The diagnose tools dump landing URL (origin + pathname only), frame URLs, table header rows, form-field metadata, and link candidates whose text or href matches site-specific keywords. Returns no field values, no row contents, no cookies. They exist so a maintainer can author a real extractor against the actual post-login DOM rather than guessing — typical workflow is: enable diagnostics, call `diagnose_*` once after login, write the extractor against the dumped structure, then disable diagnostics again.

Login and session tools return minimal status payloads only. Post-login data tools return sanitized JSON for the requested dataset; see "Security posture" below.

MFA is treated as a separate user action. If a site asks for an OTP, push approval, captcha, or other second factor and no deterministic `TOTP_SECRET` flow is configured, the worker returns:

```json
{ "status": "needs_user_action", "reason": "mfa_required" }
```

## MCP Prompts

The server advertises the `prompts` capability and ships a small catalog of parameterized workflow templates. Prompts are strictly compositional over the tool surface — they encode the right tool sequence and guardrails (dry-run defaults, OTP cooldown handling, etc.) but introduce no new capability. The per-prompt `site` enum is derived the same way as tools: intersection of (a) sites whose policy allows every action the prompt sequences and (b) the calling client's `allowedSites`. A prompt with an empty intersection is dropped from `prompts/list` for that client; `prompts/get` for an out-of-scope `(prompt, site)` returns `unknown prompt` (same indistinguishable phrasing used for resources).

Workflow prompts (always offered):

- `submit_claim_from_receipt` — guided write-op submission for `submit_claim`. Enforces check_session → login → **dry-run preview → user confirmation** → real submit. Allowed args: `site`, `treatment_date`, `claim_amount`, `currency?`, `beneficiary?`, `provider?`, `description?`, `receipts?` (comma-separated `/uploads/...` paths). Currently scoped to `april_international`.
- `complete_otp_login` — walks the SMS-OTP handoff for sites whose policy has `loginFlow=username_otp` (currently `maxicare`). Encodes the `next_action` contract so the LLM does not re-call `login` during an upstream cooldown.
- `fetch_recent_results` — ensure-logged-in + `get_results` for sites that expose result downloads (currently `hi_precision`).
- `check_policy_status` — ensure-logged-in + `get_account_info` (+ optional `get_policy_info` / `get_policy_summary` where allowed). Scoped to `maxicare`, `april_international`.

Diagnostic prompts (off by default — same `BROWSER_INTENT_ENABLE_DIAGNOSTICS=true` gate as the `diagnose_*` tools):

- `diagnose_failed_login` — maintainer-only. Dumps the public login form via `diagnose_login_form` and compares against the configured `loginSelectors`.

Quick check against the running container:

```powershell
$token = (Get-Content .env | Select-String '^BROWSER_INTENT_MCP_TOKEN=').Line.Split('=',2)[1]
Invoke-RestMethod -Uri http://127.0.0.1:18901/mcp -Method Post `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType 'application/json' `
  -Body '{"jsonrpc":"2.0","id":1,"method":"prompts/list"}'
```

## Tests

Unit tests for the pure helpers (auth check, hostname/URL allowlist, base32/TOTP, rate limiter, per-site lock, extractor parsing, diagnostic URL/href redaction). They use only Node built-ins (`node:test` + `node:assert`) — no `npm install` needed.

```bash
./browser-intent/test.sh
```

The script runs both suites in a stock `node:24.14.0-bookworm` container, so you don't need node on the host.

## Audit log

Every tool call writes a single-line JSON event to stderr tagged `event_type: "audit"`. The platform's [Fluent Bit shipper](../monitoring/fluent-bit.conf) tails container logs and writes them to Wazuh OpenSearch under `ironnest-containers-*`. Filter for browser-intent audit events with:

```text
component:("browser-intent-mcp" OR "browser-intent-worker") AND event_type:"audit"
```

The `returned_sensitive_data` boolean flips to `true` on extraction tools that return business data (`get_portfolio`, `get_account_info`, `get_claims_history`, etc.); login, logout, session-check, idle-reap, and rate-limit events all carry `returned_sensitive_data: false`.

Every MCP-side audit event carries a `status_kind` classification next to the original free-text `result` field. The vocabulary is stable: `success | needs_user | session_expired | rate_limited | needs_update | denied | error | unknown`. Group on `status_kind` in Wazuh rather than enumerating every concrete `result` value — and alert on `status_kind:unknown` to catch a worker shipping a new status that hasn't been mapped yet.

Write operations (`submit_claim` with `dry_run: false`) additionally set `write_operation: true` in the audit event so a Wazuh query can find every real upstream-state mutation. A `dry_run: true` preview returns status `dry_run` and never flips `write_operation`.

## Tunables

Worker-side env (set on the `worker` service in `docker-compose.yml` if defaults aren't right):

| Var | Default | Purpose |
|---|---|---|
| `BROWSER_INTENT_SESSION_IDLE_MINUTES` | `15` | Idle threshold before a session is auto-closed by the reaper. |
| `BROWSER_INTENT_SESSION_SWEEP_SECONDS` | `60` | How often the reaper checks for idle sessions. |
| `BROWSER_INTENT_LOGIN_MAX_PER_WINDOW` | `5` | Max real login attempts per site per window (session-reuse short-circuits don't count). |
| `BROWSER_INTENT_LOGIN_WINDOW_MINUTES` | `15` | Sliding window for the rate limiter. |
| `BROWSER_INTENT_RESULT_TTL_HOURS` | `24` | TTL on downloaded result PDFs in `/results/<site>/`. `get_results` auto-prunes anything older on every call. Bump if a user needs more time to grab their files off the host bind. |
| `BROWSER_INTENT_RESULT_MAX_BYTES` | `20971520` (20 MB) | Per-PDF download cap on `get_results`. Anything larger is recorded as `download_status: "too_large"` without writing to disk — disk-fill protection. |
| `BROWSER_INTENT_RESULTS_DIR` | `/results` | Worker-side output directory for downloaded PDFs. Lives at top-level (not under `/uploads`) because `/uploads` is mounted read-only. |

When the rate limit trips, `login` returns `{status: "rate_limited", retry_after_seconds: N}` instead of contacting the upstream site — this is the lockout-protection circuit breaker, not a tuning knob to crank.

MCP-server-side env (set on the `browser-intent-mcp` service):

| Var | Default | Purpose |
|---|---|---|
| `BROWSER_INTENT_RATE_BURST` | `30` | Token-bucket capacity per authenticated client. Burst above this in a short window returns HTTP 429 + `Retry-After`. |
| `BROWSER_INTENT_RATE_REFILL` | `5` | Tokens added per second per client. Default catches a runaway loop within ~10s without affecting normal LLM usage (a few calls per turn). |
| `BROWSER_INTENT_WORKER_TIMEOUT_SECONDS` | `60` | Outer abort on every MCP→worker fetch. A hung worker surfaces as `worker call timed out after ...` rather than stalling the LLM turn. |
| `BROWSER_INTENT_SESSION_TTL_SECONDS` | `3600` | Idle TTL on 2025-06-18 Streamable HTTP sessions. Abandoned sessions are reaped lazily. |
| `BROWSER_INTENT_ENABLE_DIAGNOSTICS` | unset | When `true`, the `diagnose_*` maintainer tools appear in `tools/list`. Leave unset in normal operation so the LLM never sees them. |

### Infisical Agent sidecar: secret-change polling

`agent-config/agent.yaml` sets `polling-interval: 60s` on the template — the agent re-fetches secrets from Infisical every 60 seconds and re-renders `secrets-runtime/.env` whenever the response ETag changes. Minimum allowed by the CLI is `60s`; the default if omitted is `5m`.

**The workaround for the multi-path etag bug lives in `secrets.tmpl`, not in the image** — there is no "-patched" CLI binary. The image used (`infisical/cli@sha256:dba406b3…`) is the unmodified upstream `0.43.76` release pinned by digest. The actual fix is structural: one recursive `listSecrets` call on `/sites` rather than a separate block per site.

The bug: Infisical CLI ≤ 0.43.76 (still present on `main` as of 2026-05-14) threads a single `*currentEtag` pointer through every `listSecrets`/`getSecretByName` template invocation and overwrites it on each call ([`packages/cmd/agent.go`](https://github.com/Infisical/cli/blob/v0.43.76/packages/cmd/agent.go), `secretTemplateFunction`: `*currentEtag = res.Etag`). With one `range listSecrets` block per site, the final value of `currentEtag` is the etag of only the *last* path; a secret update under any of the other paths leaves `currentEtag` unchanged and the agent never re-renders. We hit this on 2026-05-14 when an updated `/sites/col-financial/USERNAME` sat unrendered for 7 hours until a manual `docker restart` of the sidecar.

A single recursive call returns one server-computed etag covering the entire `/sites` subtree, so any change anywhere under `/sites/*` triggers a re-render within the polling interval. The env-key contract (`COL_FINANCIAL_*`, `MAXICARE_*`, …) is preserved by deriving the prefix from each secret's `.SecretPath` via sprig helpers.

If you add a new site, **do not add a new `range listSecrets` block** — just create `/sites/<new-site>` in Infisical and the env keys will appear automatically (uppercased, with `-` and `/` collapsed to `_`). If you ever need to fetch from a path outside `/sites`, you'll re-introduce the bug; until upstream is fixed, the workaround is to restart the sidecar (`docker restart browser-intent-infisical-agent`) after any Infisical update.

When upstream cuts a release that fixes the etag bug, bump the pinned digest in `docker-compose.yml` and re-test rotation under multi-path templates.

## Security posture

Defense-in-depth on the internal network: every MCP→worker call carries an `X-Worker-Auth: <secret>` header that the worker validates with `crypto.timingSafeEqual`. The secret comes from `BROWSER_INTENT_WORKER_SECRET` on both services (compose refuses to start without it). A sibling container on `platform-egress` (squid, adguard, infisical-agent) cannot drive the worker even if it discovers the worker's internal hostname. The worker logs a Wazuh-tagged audit event (`result: worker_auth_rejected`) on every failure. `/healthz` is exempt so the compose healthcheck doesn't need to read `.env`.

Policy change detection: every HTTP MCP response carries an `Mcp-Policy-Version` header (12-hex-char SHA-256 prefix of `sites.json + clients.json`). HTTP clients on the legacy `2024-11-05` transport detect drift by comparing this header across calls. HTTP clients on `2025-06-18` (Streamable HTTP) open `GET /mcp` as an SSE stream and receive `notifications/{tools,resources,prompts}/list_changed` directly. Stdio clients also receive the same notifications on stdout. The watcher is debounced 200ms; the per-response header is recomputed per call so it stays fresh even on hosts where fs.watch doesn't propagate across bind mounts.

## MCP Streamable HTTP (2025-06-18)

The server speaks both `2024-11-05` and `2025-06-18` and picks the version the client requested in `initialize.params.protocolVersion` (falling back to its latest if the client sent something unknown). 2024-11-05 clients are unchanged; 2025-06-18 clients get the new surface:

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | JSON-RPC request/response (same as before). On `initialize` with `protocolVersion: "2025-06-18"`, the response carries `Mcp-Session-Id: <hex>` — the client must echo it on every subsequent request, plus `MCP-Protocol-Version: 2025-06-18`. Mismatch → 400. Unknown session → 404. |
| `GET /mcp` | Server-Sent Events stream. Requires `Mcp-Session-Id`. The server pushes `notifications/{tools,resources,prompts}/list_changed` as `event: message` frames whenever the policies dir is edited. Heartbeat comments every 30s. |
| `DELETE /mcp` | Explicit session teardown. Optional — sessions auto-reap after `BROWSER_INTENT_SESSION_TTL_SECONDS` (default 3600) of inactivity. |

A bare `POST /mcp` with no session ID is still served at the legacy contract (no header validation, no session binding) — so existing Hermes / Codex clients on 2024-11-05 keep working unchanged through the same port.

Three invariants apply to every tool in this stack:

1. **Credentials never reach the LLM.** Username, password, and `TOTP_SECRET` are rendered into the worker's environment by the Infisical sidecar and used only by Playwright. No tool returns them.
2. **Login / session tools never return post-login data.** They return only `{status, ...}`.
3. **Per-client site scoping.** The MCP server narrows tools and resources to the calling client's `allowedSites` from `policies/clients.json` before they reach the LLM. A restricted client cannot see (or call) sites outside its scope; cross-site attempts return `unknown resource` / `site is not allowlisted` and are audit-logged with `result: "denied_by_client_policy"`.

Post-login data tools (e.g. `get_portfolio`) are gated additions that *do* return business data — portfolio holdings, balances, etc. They:

- Only run on sites whose `allowedTools` in `policies/sites.json` lists the action — the per-tool `site` enum already rejects disallowed combinations at the MCP schema layer.
- Require an existing logged-in session — return `{status: "session_expired"}` if not, so the LLM is forced to call `login` (with the same `site`) first.
- Return only the documented JSON shape (no raw HTML, cookies, or screenshots).
- Are flagged in the audit log with `returned_sensitive_data: true`.

If the site's DOM changes such that the extractor can't locate its target, the tool returns `{status: "needs_extractor_update"}` rather than guessing.
