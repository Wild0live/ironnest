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
./browser-intent/start.sh
```

The local API is published at `http://127.0.0.1:18901`.

## MCP Tools

- `login_col_financial`
- `login_maxicare`
- `login_april_international`
- `login_hi_precision`
- `check_site_session`
- `logout_site`

All tools return minimal status payloads. Post-login data extraction should be added later as separate gated tools.

MFA is treated as a separate user action. If a site asks for an OTP, push approval, captcha, or other second factor and no deterministic `TOTP_SECRET` flow is configured, the worker returns:

```json
{ "status": "needs_user_action", "reason": "mfa_required" }
```
