# Browser Intent

Browser Intent is the localhost-only, policy-gated browser automation stack for IronNest.

It exposes narrow MCP tools such as `login_hi_precision` and `logout_site`; it does not expose raw browser controls, screenshots, cookies, DOM access, JavaScript evaluation, arbitrary navigation, or Infisical secret reads.

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

## Policy

Sites are declared in `policies/sites.json`. Each site has:

- allowed domains
- login URL
- secret environment key prefix
- allowed MCP tools
- optional selector hints for deterministic login

Maxicare's portal URL is currently a placeholder and should be confirmed before use.

## Start

```bash
cp browser-intent/.env.example browser-intent/.env
# edit .env and browser-intent/agent-config/secrets.tmpl
# .env requires BROWSER_INTENT_MCP_TOKEN — generate with: openssl rand -hex 32
./browser-intent/start.sh
```

The local API is published at `http://127.0.0.1:18901`. The HTTP transport
(`POST /mcp`, `GET /sites`) requires `Authorization: Bearer $BROWSER_INTENT_MCP_TOKEN`;
`GET /healthz` is open. The stdio transport is unauthenticated by design.

```powershell
# Quick sanity check
$token = (Get-Content .env | Select-String '^BROWSER_INTENT_MCP_TOKEN=').Line.Split('=',2)[1]
Invoke-RestMethod -Uri http://127.0.0.1:18901/mcp -Method Post `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType 'application/json' `
  -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## MCP Tools

Login / session:

- `login_col_financial`
- `login_maxicare`
- `login_april_international`
- `login_hi_precision`
- `check_site_session`
- `logout_site`
- `list_browser_intent_sites`

Post-login data:

- `col_financial_get_portfolio` — returns holdings (symbol, quantity, average cost, last price, market value, unrealized P&L) and totals.

Login and session tools return minimal status payloads only. Post-login data tools return sanitized JSON for the requested dataset; see "Security posture" below.

MFA is treated as a separate user action. If a site asks for an OTP, push approval, captcha, or other second factor and no deterministic `TOTP_SECRET` flow is configured, the worker returns:

```json
{ "status": "needs_user_action", "reason": "mfa_required" }
```

## Security posture

Two invariants apply to every tool in this stack:

1. **Credentials never reach the LLM.** Username, password, and `TOTP_SECRET` are rendered into the worker's environment by the Infisical sidecar and used only by Playwright. No tool returns them.
2. **Login / session tools never return post-login data.** They return only `{status, ...}`.

Post-login data tools (e.g. `col_financial_get_portfolio`) are gated additions that *do* return business data — portfolio holdings, balances, etc. They:

- Only run on sites whose `allowedTools` in `policies/sites.json` lists the action.
- Require an existing logged-in session — return `{status: "session_expired"}` if not, so the LLM is forced to call `login_<site>` first.
- Return only the documented JSON shape (no raw HTML, cookies, or screenshots).
- Are flagged in the audit log with `returned_sensitive_data: true`.

If the site's DOM changes such that the extractor can't locate its target, the tool returns `{status: "needs_extractor_update"}` rather than guessing.
