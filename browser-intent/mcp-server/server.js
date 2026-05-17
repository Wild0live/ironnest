const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");

const {
  validateValue,
  validateArgs,
  SUPPORTED_VALIDATOR_TYPES,
  SUPPORTED_KEYWORDS,
  assertSchemaIsValidatorCompatible,
  assertCatalogSchemasValidatorCompatible
} = require("./lib/validator");
const {
  STATUS_KIND,
  statusToKind,
  createAudit,
  redactErrorMessage
} = require("./lib/audit");
const { PROMPTS, createPromptsHelpers } = require("./lib/prompts");

const policyPath = process.env.BROWSER_INTENT_POLICY_PATH || "/app/policies/sites.json";
const clientsPath = process.env.BROWSER_INTENT_CLIENTS_PATH || "/app/policies/clients.json";
const workerUrl = process.env.BROWSER_WORKER_URL || "http://worker:18902";
const httpPort = Number(process.env.BROWSER_INTENT_HTTP_PORT || 18901);
const diagnosticsEnabled = process.env.BROWSER_INTENT_ENABLE_DIAGNOSTICS === "true";

// stdio is unauthenticated by design — anyone who can attach to this process's
// pipes already has container-local privilege. stdio callers run as the
// implicit admin client (full site access). HTTP callers MUST authenticate.
const STDIO_CLIENT = Object.freeze({
  name: "stdio",
  allowedSites: "*",
  tokenEnvVar: null
});

// mtime-keyed cache for the two policy files. The hot path (tools/list,
// authenticateClient, tools/call dispatcher) previously called
// fs.readFileSync + JSON.parse on every JSON-RPC method — easily 6+ fs reads
// per LLM turn. With the cache it's one stat per call and a re-parse only
// when the file's mtime changes. fs.stat is microseconds and works across
// Docker Desktop bind mounts (no inotify needed), so this stays fresh on
// every host without the fs.watch limitation.
const _policyCache = { mtimeMs: -1, data: null };
const _clientsCache = { mtimeMs: -1, data: null, tokenIndex: null };

function _loadAndCacheJson(filePath, cache) {
  const stat = fs.statSync(filePath);
  if (cache.mtimeMs !== stat.mtimeMs) {
    cache.data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    cache.mtimeMs = stat.mtimeMs;
    // Caller resets any derived state (e.g. token index) keyed off this cache.
    cache.tokenIndex = null;
  }
  return cache.data;
}

function loadPolicy() {
  return _loadAndCacheJson(policyPath, _policyCache);
}

function loadClients() {
  return _loadAndCacheJson(clientsPath, _clientsCache);
}

// Policy version = SHA-256(sites.json) ⊕ SHA-256(clients.json), truncated to
// 12 hex chars. Returned in the Mcp-Policy-Version header on every MCP
// response so HTTP clients (Hermes, ops sidecars) can detect policy drift
// across the connectionless POST transport — there is no server-push channel
// on JSON-over-HTTP, so the version header is the only signal an HTTP client
// can use to know its cached tool/resource list is stale.
//
// On a debounced fs.watch event for the policies dir, the version is
// recomputed and notifications/{tools,resources,prompts}/list_changed are
// broadcast to all registered stdio sinks (HTTP clients pick up the change
// through the header on their next request).
function computePolicyVersion(paths = { policy: policyPath, clients: clientsPath }) {
  const hash = crypto.createHash("sha256");
  try {
    hash.update(fs.readFileSync(paths.policy));
  } catch {
    hash.update("missing-sites");
  }
  try {
    hash.update(fs.readFileSync(paths.clients));
  } catch {
    hash.update("missing-clients");
  }
  return hash.digest("hex").slice(0, 12);
}

// Recompute per call rather than cache. Two small sha256s over ~2 KB of JSON
// is ~50µs and avoids the well-known fs.watch limitation on Docker Desktop
// bind mounts on Windows where inotify events don't always cross the bind
// boundary — caching would mean Hermes never sees a fresh version after a
// host-side edit on that platform. The watcher below still exists to push
// notifications/list_changed to connected stdio clients (works on Linux
// prod hosts where inotify is native).
function policyVersion() {
  return computePolicyVersion();
}

// Stdio-style notification sinks. Each sink is a (line) => void that writes
// one JSON-RPC notification per call. The runtime sink is process.stdout
// (registered in the require.main block); tests register their own sinks
// via __registerStdioSink and clear them with __clearStdioSinks.
const _stdioSinks = new Set();
function registerStdioSink(fn) {
  _stdioSinks.add(fn);
}
function unregisterStdioSink(fn) {
  _stdioSinks.delete(fn);
}
function broadcastNotification(method) {
  const line = `${JSON.stringify({ jsonrpc: "2.0", method })}\n`;
  for (const sink of _stdioSinks) {
    try {
      sink(line);
    } catch {
      // A misbehaving sink must not block the others.
    }
  }
}

// Notify every registered stdio sink that the tool / resource / prompt
// surface may have changed. Called from the debounced fs.watch handler and
// from __triggerPolicyChange in tests. HTTP clients see the change through
// the per-response Mcp-Policy-Version header, which is recomputed on every
// request.
function emitPolicyChanged() {
  broadcastNotification("notifications/tools/list_changed");
  broadcastNotification("notifications/resources/list_changed");
  broadcastNotification("notifications/prompts/list_changed");
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "browser-intent-mcp",
    level: "info",
    msg: "policy reload notified",
    policy_version: policyVersion()
  })}\n`);
}

let _policyWatcher = null;
let _policyWatchDebounce = null;
function startPolicyWatcher() {
  if (_policyWatcher) return;
  const policyDir = path.dirname(policyPath);
  try {
    _policyWatcher = fs.watch(policyDir, { persistent: false }, () => {
      if (_policyWatchDebounce) clearTimeout(_policyWatchDebounce);
      // 200ms debounce: editor saves often fire write+rename and we don't
      // want to emit three notifications for one logical edit.
      _policyWatchDebounce = setTimeout(emitPolicyChanged, 200);
    });
  } catch (err) {
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "browser-intent-mcp",
      level: "warn",
      msg: "fs.watch on policy dir failed; list_changed notifications disabled (HTTP clients still get Mcp-Policy-Version drift signal)",
      dir: policyDir,
      error: err.message
    })}\n`);
  }
}

function siteIds() {
  return Object.keys(loadPolicy().sites);
}

function publicSite(siteId) {
  const site = loadPolicy().sites[siteId];
  if (!site) return null;
  return {
    site: siteId,
    displayName: site.displayName,
    riskLevel: site.riskLevel,
    allowedTools: site.allowedTools
  };
}

function clientAllowsSite(client, siteId) {
  if (client.allowedSites === "*") return true;
  return Array.isArray(client.allowedSites) && client.allowedSites.includes(siteId);
}

function clientSiteIntersection(client, policySites) {
  if (client.allowedSites === "*") return policySites;
  if (!Array.isArray(client.allowedSites)) return [];
  return policySites.filter((s) => client.allowedSites.includes(s));
}

// Match an inbound HTTP request to a client entry in clients.json. Returns
// the matched client object ({name, allowedSites, tokenEnvVar}) or null.
//
// Security model:
//   - Dispatch via Map<sha256(token), client> — constant-time hash + Map
//     lookup. No per-client iteration, no token-length leak (every Bearer
//     value hashes to a fixed-width digest before lookup, so an attacker
//     cannot learn whether their token's length matches any configured
//     client via timing). Replaces an earlier iterative timingSafeEqual
//     scan that admitted a length-timing leak in comments.
//   - Clients whose `tokenEnvVar` env value is unset at startup are
//     omitted from the index (empty-token bypass would be catastrophic).
//     Env-var changes after startup are not picked up; production tokens
//     are baked at container start.
//   - Index is rebuilt whenever clients.json's mtime changes (handled by
//     the loadClients() mtime cache) or whenever a previously-empty env
//     var is now set — that's not auto-detected; restart picks it up.
function _buildTokenIndex(clients) {
  const index = new Map();
  for (const [name, client] of Object.entries(clients)) {
    const expected = process.env[client.tokenEnvVar];
    if (!expected) continue;
    const key = crypto.createHash("sha256").update(expected).digest("hex");
    index.set(key, {
      name,
      allowedSites: client.allowedSites,
      tokenEnvVar: client.tokenEnvVar
    });
  }
  return index;
}

function _tokenIndex() {
  // Touch loadClients to ensure mtime check + cache reset has run.
  const { clients } = loadClients();
  if (!_clientsCache.tokenIndex) {
    _clientsCache.tokenIndex = _buildTokenIndex(clients);
  }
  return _clientsCache.tokenIndex;
}

// Force a fresh build of the token index regardless of clients.json mtime.
// Used by the SIGHUP handler so an operator can rotate a token by editing
// `.env` (or kubectl-rolling the secret) and signaling the running process
// — no container restart required. Without this, the index is rebuilt only
// when clients.json itself changes, which a token rotation does not touch.
function rebuildTokenIndex() {
  const { clients } = loadClients();
  _clientsCache.tokenIndex = _buildTokenIndex(clients);
  return _clientsCache.tokenIndex;
}

function authenticateClient(req) {
  const header = (req.headers && req.headers["authorization"]) || "";
  if (!header.startsWith("Bearer ")) return null;
  const provided = header.slice("Bearer ".length);
  // Reject the empty-Bearer edge case before hashing — sha256("") is a
  // well-known constant and a populated index entry pointing at it would
  // be catastrophic. Index builder skips empty values, but defense in depth.
  if (provided.length === 0) return null;
  let index;
  try {
    index = _tokenIndex();
  } catch (err) {
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "browser-intent-mcp",
      level: "error",
      msg: "failed to load clients policy",
      error: err.message
    })}\n`);
    return null;
  }
  const key = crypto.createHash("sha256").update(provided).digest("hex");
  return index.get(key) || null;
}

// Catalog of all tool actions. Each action is exposed as a single MCP tool
// (e.g. `login`, `get_portfolio`, `submit_claim`) with a `site` enum that
// lists only the sites whose `allowedTools` in policies/sites.json includes
// this action — further narrowed at request time by the authenticating
// client's allowedSites (per policies/clients.json). Schema validation
// rejects (action, site) combinations the policy doesn't allow at the MCP
// boundary; assertSiteAllowsAction() and clientAllowsSite() re-check at
// dispatch time as defense in depth.
//
// Categories:
//   - session:    /login, /logout, /session, /provide-otp endpoints
//   - extraction: /extract endpoint, returns business data
//   - diagnostic: /extract endpoint, returns structural metadata only.
//                 Gated behind BROWSER_INTENT_ENABLE_DIAGNOSTICS=true so the
//                 LLM doesn't see maintainer tools in normal operation.
//
// `extra` lets an action add required/properties beyond `site`. The dispatcher
// in callTool() forwards `args` minus `site` to the worker; the worker
// re-validates anything it depends on (e.g. /uploads-prefix on receipt paths).
const ACTIONS = {
  login: {
    category: "session",
    endpoint: "/login",
    description:
      "Log in to the selected site. Returns only login status; never returns secrets, cookies, DOM, screenshots, or post-login data. For sites whose policy declares loginFlow=username_otp (Maxicare), status=\"awaiting_otp\" means the worker is holding a pending login and you must call provide_otp with the SMS code from the user's phone. Other possible statuses: \"awaiting_fresh_sms\" (upstream resend cooldown is active — DO NOT call login again until wait_seconds_for_fresh_sms elapses; the response's next_action field tells you whether to wait or to call provide_otp on the still-open pending session), \"rate_limited\" (worker-side budget exhausted; honor retry_after_seconds), \"needs_user_action\", \"needs_site_selector_update\", \"logged_in\"."
  },
  logout: {
    category: "session",
    endpoint: "/logout",
    description: "Log out of the selected site and close its worker-side browser session."
  },
  check_session: {
    category: "session",
    endpoint: "/session",
    description: "Check whether the selected site has an active worker-side browser session. Returns only status."
  },
  provide_otp: {
    category: "session",
    endpoint: "/provide-otp",
    description:
      "Complete a login on the selected site by submitting the SMS one-time code. Call AFTER login returns status=\"awaiting_otp\" and you have read the code from the user's phone. Returns only status; never returns post-login data. On a wrong-code result (status=\"needs_user_action\", reason=\"otp_not_accepted\"), the response's next_action field tells you whether to retry with a corrected code, wait_then_relogin (cooldown is active), or relogin (cooldown elapsed). DO NOT default to calling login when next_action says to wait — that re-login will NOT issue a fresh SMS and will burn a rate-limit slot. The response also carries failure_kind: \"otp_rejected\" means the code was wrong (user can correct it); \"upstream_error\" or \"upstream_lockout\" means the request did NOT reach OTP validation — repeatedly resubmitting OTPs will NOT help, surface next_action.note to the user instead of asking for another code.",
    extra: {
      required: ["code"],
      properties: {
        code: { type: "string", pattern: "^\\d{4,8}$", description: "The numeric OTP code from the user's SMS." }
      }
    }
  },

  get_portfolio: {
    category: "extraction",
    description:
      "Read holdings from the selected site: per-symbol quantity, average cost, last price, market value, unrealized P&L, and totals. Returns sanitized JSON; never returns credentials, cookies, or raw HTML. Caller must call login for the site first."
  },
  get_policy_summary: {
    category: "extraction",
    description:
      "Read the user's policy list from the selected site: names and active/inactive status. Includes a card_added flag — when false, the portal hides MBL/LOA balance and coverage details until the physical card is linked in the member-gateway UI. Caller must call login (and provide_otp) for the site first."
  },
  get_account_info: {
    category: "extraction",
    description:
      "Read the user's personal account info from the selected site: name, email, date of birth, address, and any portal-specific profile fields. Caller must call login (and complete any required intermediate steps such as provide_otp) for the site first."
  },
  get_policy_info: {
    category: "extraction",
    description:
      "Read the user's active policy details from the selected site: policy number, name, policyholder, coverage period, and the list of insured members. Caller must call login for the site first."
  },
  get_claims_history: {
    category: "extraction",
    description:
      "Read the user's claims history from the selected site: per-claim date of treatment, beneficiary, provider, claim amount, paid amount, and status. Returns up to 50 most-recent claims. Caller must call login for the site first."
  },
  get_claim_status: {
    category: "extraction",
    description:
      "Read a single claim's full status detail from the selected site by claim ID: status timeline, paid/outstanding amounts, dates, beneficiary, provider, and any reason notes. Returns sanitized JSON; never returns credentials, cookies, or raw HTML. Caller must call login for the site first.",
    extra: {
      required: ["claim_id"],
      properties: {
        claim_id: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          // Claim IDs are short alphanumeric tokens — restrict to safe URL/path chars
          // so a malicious value can't traverse routes or smuggle a separator.
          pattern: "^[A-Za-z0-9_\\-./]+$",
          description: "Claim identifier as shown on the claims list (e.g. 'CL-2026-001234')."
        }
      }
    }
  },
  submit_claim: {
    category: "extraction",
    description:
      "Submit a new claim on the selected site. WRITE OPERATION — mutates upstream state. dry_run defaults to true: the form is filled and the worker returns a sanitized snapshot of what *would* be submitted, but no claim is created. Set dry_run=false to actually submit. Receipts must be paths under /uploads inside the worker container (mount a host directory there). Caller must call login for the site first.",
    extra: {
      required: ["treatment_date", "claim_amount"],
      properties: {
        treatment_date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "ISO date (YYYY-MM-DD) of treatment."
        },
        beneficiary: {
          type: "string",
          maxLength: 120,
          description: "Beneficiary name as it appears in the portal's dropdown. Omit to use the form default."
        },
        provider: {
          type: "string",
          maxLength: 200,
          description: "Provider / clinic / hospital name."
        },
        claim_amount: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Claim amount (numeric, no currency symbol)."
        },
        currency: {
          type: "string",
          pattern: "^[A-Z]{3}$",
          description: "ISO 4217 currency code, e.g. PHP, EUR, USD."
        },
        description: {
          type: "string",
          maxLength: 2000,
          description: "Free-text description of the treatment / reason for the claim."
        },
        receipts: {
          type: "array",
          maxItems: 10,
          items: {
            type: "string",
            // Whitelist: only allow paths under /uploads inside the worker; reject
            // traversal sequences. The worker also re-validates before reading.
            pattern: "^/uploads/[^\\.][^\\s]*$",
            maxLength: 500
          },
          description: "Receipt file paths inside the worker container. Must live under /uploads. Mount a host directory to /uploads in docker-compose.yml to use this."
        },
        dry_run: {
          type: "boolean",
          description: "When true (default), fill the form and return a sanitized preview without submitting. Set to false to actually submit the claim."
        }
      }
    }
  },
  get_documents_list: {
    category: "extraction",
    description:
      "List downloadable documents available to the user on the selected site (claim forms, network lists, banking info, etc.) with their public asset URLs. Caller must call login for the site first."
  },
  get_results: {
    category: "extraction",
    description:
      "Read the user's recent lab / imaging / test results from the selected site's results dashboard. Returns a list of result entries with lab number, branch, order date, patient identifiers, test type, and — for each row — a worker-local download_path where the result PDF has been written. The worker fetches each PDF through the active browser session itself; cookie-gated URLs are NEVER returned to the caller. Per-row download_status is \"ok\", \"too_large\", \"download_failed\", or \"no_url\". Caller must call login for the site first."
  },

  diagnose_login_form: {
    category: "diagnostic",
    description:
      "Pre-login diagnostic for the selected site. Navigates to the public login page with NO credentials, no session, and no rate-limit cost, then dumps input metadata (name/id/type/autocomplete/label), submit-button info, and form action — used to author or repair site.loginSelectors after a login returns needs_site_selector_update. Returns no field values, no cookies, no screenshots."
  },
  diagnose_member_portal: {
    category: "diagnostic",
    description:
      "Diagnostic tool for the selected site. After login, dumps frame URLs, table headers, form-field metadata, and filtered link candidates to help locate the right post-login page for the real extractor. Returns no cell values, no form values, no row contents — only structural metadata. Caller must call login for the site first."
  },
  diagnose_portfolio: {
    category: "diagnostic",
    description:
      "Diagnostic tool for the selected site. Dumps frame URLs and table header rows to help locate the portfolio page. Returns no holdings data, no cell values — only structural metadata for tuning the real extractor. Caller must call login for the site first."
  },
  diagnose_claim_form: {
    category: "diagnostic",
    description:
      "Diagnostic tool for the selected site. After login, navigates to the claim-submission form and dumps input metadata (name/id/type/autocomplete/placeholder/label), file-input selectors, button text, dropdown option counts, and form action. Does NOT submit a claim. Returns no field values, no row contents, no receipts — only structural metadata used to author or repair the submit_claim selectors. Caller must call login for the site first."
  }
};

function sitesAllowing(action) {
  const policy = loadPolicy();
  return Object.entries(policy.sites)
    .filter(([, site]) => site.allowedTools.includes(action))
    .map(([siteId]) => siteId);
}

function actionIsEnabled(spec) {
  if (spec.category === "diagnostic" && !diagnosticsEnabled) return false;
  return true;
}

// Catalog of MCP prompts. Each prompt is a parameterized workflow template
// the LLM can fetch via prompts/get; it encodes the right tool sequence,
// the dry-run / OTP / write-op guardrails, and the per-site enum derived
// from the same allowedTools intersection that scopes tools. Prompts are
// strictly compositional over the tool surface — they do NOT introduce new
// capability and cannot be used to escape per-client site scoping.
//
// Shape:
//   category:         "workflow" (always offered) | "diagnostic" (gated by
//                     BROWSER_INTENT_ENABLE_DIAGNOSTICS, same gate as the
//                     diagnose_* tools)
//   description:      LLM-visible
//   requiredActions:  list of action names; the prompt's site enum is the
//                     intersection of (a) sites whose allowedTools contains
//                     EVERY listed action and (b) the calling client's
//                     allowedSites. If empty, the prompt is dropped from
//                     prompts/list entirely.
//   siteFilter:       optional predicate(siteObj) for further narrowing
//                     (e.g. complete_otp_login wants loginFlow=username_otp)
//   arguments:        MCP prompt argument descriptors. `site` is always
//                     present and required; per-MCP-spec these carry only
//                     name/description/required, so any enum / pattern is
//                     re-stated in description and re-validated in render().
//   render(args, ctx) returns { messages: [{role, content}] }; ctx carries
//                     {site (resolved site obj), siteId, displayName}.
const PROMPTS = {
  submit_claim_from_receipt: {
    category: "workflow",
    description:
      "Guided workflow for submitting a new insurance claim on a supported site. Walks through session check → login (with OTP if required) → dry-run preview → explicit user confirmation → real submit. Encodes the dry_run=true-by-default contract so the LLM cannot skip the preview step.",
    requiredActions: ["check_session", "login", "submit_claim"],
    arguments: [
      { name: "site", description: "Site identifier. Only sites whose policy allows submit_claim and that the calling client is scoped to are accepted.", required: true },
      { name: "treatment_date", description: "ISO date of treatment (YYYY-MM-DD).", required: true },
      { name: "claim_amount", description: "Claim amount as a number, no currency symbol.", required: true },
      { name: "currency", description: "ISO 4217 currency code (e.g. PHP, EUR, USD). Optional.", required: false },
      { name: "beneficiary", description: "Beneficiary name as it appears in the portal's dropdown. Optional.", required: false },
      { name: "provider", description: "Clinic / hospital / provider name. Optional.", required: false },
      { name: "description", description: "Free-text reason for the claim. Optional.", required: false },
      { name: "receipts", description: "Comma-separated worker-side receipt paths under /uploads (e.g. /uploads/from-hermes/r1.pdf,/uploads/from-hermes/r2.pdf). Optional.", required: false }
    ],
    render(args, ctx) {
      const payloadLines = [
        `  site: "${ctx.siteId}"`,
        `  treatment_date: "${args.treatment_date}"`,
        `  claim_amount: ${args.claim_amount}`
      ];
      if (args.currency) payloadLines.push(`  currency: "${args.currency}"`);
      if (args.beneficiary) payloadLines.push(`  beneficiary: "${args.beneficiary}"`);
      if (args.provider) payloadLines.push(`  provider: "${args.provider}"`);
      if (args.description) payloadLines.push(`  description: ${JSON.stringify(args.description)}`);
      if (args.receipts) {
        const list = args.receipts.split(",").map((s) => s.trim()).filter(Boolean);
        payloadLines.push(`  receipts: ${JSON.stringify(list)}`);
      }
      const payload = payloadLines.join("\n");
      const text = [
        `You are about to submit a new insurance claim on ${ctx.displayName} (site="${ctx.siteId}"). This is a WRITE operation; the steps below are mandatory.`,
        "",
        `1. Call \`check_session\` with site="${ctx.siteId}". If the response status is not "logged_in", continue to step 2; otherwise jump to step 3.`,
        `2. Call \`login\` with site="${ctx.siteId}". If status="awaiting_otp", read the SMS code from the user and call \`provide_otp\` with that code; respect the response's \`next_action\` field — do NOT call \`login\` again if it tells you to wait. Continue only after the session is logged in.`,
        `3. PREVIEW the submission. Call \`submit_claim\` with dry_run=true and the following payload:`,
        "",
        "```",
        payload,
        "  dry_run: true",
        "```",
        "",
        "4. Show the user the dry-run snapshot the worker returns (which selectors matched, how many receipts attached, the form summary). Ask for explicit confirmation before proceeding.",
        `5. ONLY after the user confirms in plain text, call \`submit_claim\` again with the SAME payload and dry_run=false. Do not retry on partial failure without re-running step 3 first.`,
        "6. Report back to the user: the returned claim id (if any), the final status, and what was submitted. Surface any \`needs_extractor_update\` / \`session_expired\` / upstream-error responses verbatim — do not paper over them.",
        "",
        "Hard constraints: never call submit_claim with dry_run=false before showing the user the dry-run output. Never retry submit_claim with dry_run=false if the prior call returned anything other than a success status."
      ].join("\n");
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  },

  complete_otp_login: {
    category: "workflow",
    description:
      "Walk through an SMS-OTP-gated login. Handles the awaiting_otp / provide_otp handoff and the cooldown / next_action contract so the LLM does not burn rate-limit slots by re-calling login during an upstream resend cooldown.",
    requiredActions: ["login", "provide_otp"],
    siteFilter: (site) => site.loginFlow === "username_otp",
    arguments: [
      { name: "site", description: "Site identifier. Only sites whose loginFlow is username_otp and that the calling client is scoped to are accepted.", required: true }
    ],
    render(args, ctx) {
      const text = [
        `You are about to log in to ${ctx.displayName} (site="${ctx.siteId}"). This site uses an SMS OTP. Follow these steps in order.`,
        "",
        `1. Call \`login\` with site="${ctx.siteId}". Expect status="awaiting_otp" on success; the worker will hold the browser session open waiting for the code.`,
        "2. Ask the user for the OTP code that arrived on their phone. Do NOT guess or generate codes.",
        `3. Call \`provide_otp\` with site="${ctx.siteId}" and code="<the 4-8 digit code>".`,
        "4. Inspect the response:",
        "   - status=\"logged_in\": success — you can now call extraction tools for this site.",
        "   - status=\"needs_user_action\", reason=\"otp_not_accepted\": read the `next_action` field — \"retry\" means ask the user for a corrected code, \"wait_then_relogin\" means wait the indicated cooldown, \"relogin\" means call `login` again. NEVER default to calling `login` when next_action says wait.",
        "   - failure_kind=\"otp_rejected\" → wrong code, user can correct it. failure_kind=\"upstream_error\" or \"upstream_lockout\" → the request did NOT reach OTP validation; repeatedly resubmitting OTPs will not help. Surface the `next_action.note` to the user.",
        "5. If status=\"awaiting_fresh_sms\", honor the indicated wait. DO NOT call login again until the cooldown has elapsed — a re-login during cooldown will NOT trigger a new SMS and WILL burn a rate-limit slot.",
        "",
        "Never log, echo, or store the OTP code outside of the provide_otp call itself."
      ].join("\n");
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  },

  fetch_recent_results: {
    category: "workflow",
    description:
      "Fetch the user's recent lab / imaging / diagnostic test results from a supported site and surface the download URLs. Ensures a fresh session before extraction.",
    requiredActions: ["check_session", "login", "get_results"],
    arguments: [
      { name: "site", description: "Site identifier. Only sites whose policy allows get_results and that the calling client is scoped to are accepted.", required: true }
    ],
    render(args, ctx) {
      const text = [
        `You are about to fetch recent test results from ${ctx.displayName} (site="${ctx.siteId}").`,
        "",
        `1. Call \`check_session\` with site="${ctx.siteId}". If status is not \"logged_in\", call \`login\` with site="${ctx.siteId}" and wait for status=\"logged_in\". For any status of \"awaiting_otp\", \"needs_user_action\", or \"rate_limited\", surface the response to the user and stop — do not retry until told to.`,
        `2. Call \`get_results\` with site="${ctx.siteId}". The worker downloads each result PDF through the active browser session and writes it to a worker-local volume; the response carries \`download_path\` (a path inside the worker container), \`download_bytes\`, and \`download_status\` per row — there is NO download URL in the response.`,
        "3. For each entry the worker returns, present to the user: lab number, test type, order date, branch, and the `download_path` plus its size. If `download_status` is anything other than \"ok\" (e.g. \"too_large\", \"download_failed\", \"no_url\"), surface that status — do NOT retry the download yourself; the worker already tried.",
        "4. Do NOT attempt to construct a URL to fetch the PDF. The path is only meaningful inside the worker container; whoever needs the file (the user, a sibling container) will read it from the mounted volume.",
        "5. If status=\"session_expired\" comes back from get_results, return to step 1 once."
      ].join("\n");
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  },

  check_policy_status: {
    category: "workflow",
    description:
      "Pull the user's policy / account summary from a supported insurance or medical portal. Composes check_session + login + get_account_info into a single guarded call.",
    requiredActions: ["check_session", "login", "get_account_info"],
    arguments: [
      { name: "site", description: "Site identifier. Only sites whose policy allows get_account_info and that the calling client is scoped to are accepted.", required: true }
    ],
    render(args, ctx) {
      const text = [
        `You are about to summarize the user's account / policy status on ${ctx.displayName} (site="${ctx.siteId}").`,
        "",
        `1. Call \`check_session\` with site="${ctx.siteId}". If status is not \"logged_in\", call \`login\`; for awaiting_otp follow the complete_otp_login workflow (call provide_otp with the user-supplied code).`,
        `2. Call \`get_account_info\` with site="${ctx.siteId}". Report the user's name, contact info, and any profile-level data the response carries.`,
        `3. If the site's policy allows it (you can check the site's allowedTools via list_browser_intent_sites), also call get_policy_info and/or get_policy_summary. Skip any tool the site does not allow — do not retry against unsupported endpoints.`,
        "4. Summarize the result for the user as a short paragraph plus any active / inactive policy flags. Do not include cookies, raw HTML, or internal status codes in the summary."
      ].join("\n");
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  },

  diagnose_failed_login: {
    category: "diagnostic",
    description:
      "Maintainer prompt: diagnose why login is failing on a site by dumping the public login-page structure and comparing against the configured loginSelectors. Gated by BROWSER_INTENT_ENABLE_DIAGNOSTICS; not visible to non-maintainer clients.",
    requiredActions: ["diagnose_login_form"],
    arguments: [
      { name: "site", description: "Site identifier. Only sites whose policy allows diagnose_login_form and that the calling client is scoped to are accepted.", required: true }
    ],
    render(args, ctx) {
      const text = [
        `Maintainer diagnostic for ${ctx.displayName} (site="${ctx.siteId}"). The site is failing login with needs_site_selector_update or a generic upstream error.`,
        "",
        `1. Call \`diagnose_login_form\` with site="${ctx.siteId}". This is pre-login, requires no credentials, and does not consume a rate-limit slot.`,
        "2. Compare the dumped input metadata (name / id / type / autocomplete / label) against the configured loginSelectors for this site in policies/sites.json. Identify any selector whose target element is missing, renamed, or whose attributes have shifted.",
        "3. Propose a minimal patch to policies/sites.json — add or update only the selectors that need to change. Do not rewrite the full block.",
        "4. Do not include any field values, cookies, or screenshots in the report — diagnose tools deliberately return only structural metadata."
      ].join("\n");
      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  }
};

function promptIsEnabled(spec) {
  if (spec.category === "diagnostic" && !diagnosticsEnabled) return false;
  return true;
}

// Compute the site enum for a prompt: sites whose allowedTools contains
// EVERY action in requiredActions, optionally further filtered by siteFilter.
// Result is in policy declaration order so prompts/list output is stable.
function sitesForPrompt(spec) {
  const policy = loadPolicy();
  return Object.entries(policy.sites)
    .filter(([, site]) => spec.requiredActions.every((a) => site.allowedTools.includes(a)))
    .filter(([, site]) => (spec.siteFilter ? spec.siteFilter(site) : true))
    .map(([siteId]) => siteId);
}

function promptsList(client) {
  const out = [];
  for (const [name, spec] of Object.entries(PROMPTS)) {
    if (!promptIsEnabled(spec)) continue;
    const policySites = sitesForPrompt(spec);
    const sites = clientSiteIntersection(client, policySites);
    if (sites.length === 0) continue;
    out.push({
      name,
      description: `${spec.description} Allowed sites for this client: ${sites.join(", ")}.`,
      arguments: spec.arguments
    });
  }
  return out;
}

function getPrompt(client, name, args = {}) {
  const spec = PROMPTS[name];
  // Unknown / disabled / out-of-scope prompts all surface the same error
  // ("unknown prompt") — don't leak which prompts exist for clients that
  // can't see them, mirroring how readResource hides cross-client sites.
  if (!spec || !promptIsEnabled(spec)) throw new Error(`unknown prompt: ${name}`);
  const allowedSites = clientSiteIntersection(client, sitesForPrompt(spec));
  if (allowedSites.length === 0) throw new Error(`unknown prompt: ${name}`);

  for (const a of spec.arguments) {
    if (a.required && (args[a.name] === undefined || args[a.name] === "")) {
      throw new Error(`missing required argument '${a.name}' for prompt ${name}`);
    }
  }

  const siteId = args.site;
  if (!allowedSites.includes(siteId)) {
    // Same phrasing as readResource — don't distinguish "site doesn't exist"
    // from "client can't see it".
    throw new Error(`unknown prompt: ${name}`);
  }
  const policy = loadPolicy();
  const site = policy.sites[siteId];
  const ctx = { siteId, site, displayName: site.displayName };

  const rendered = spec.render(args, ctx);
  return {
    description: spec.description,
    messages: rendered.messages
  };
}

function buildToolSchema(actionName, spec, sites) {
  const extra = spec.extra || {};
  const required = ["site", ...(extra.required || [])];
  const properties = {
    site: {
      type: "string",
      enum: sites,
      description: `Site identifier. Narrowed to the sites that (a) policies/sites.json's allowedTools list ${actionName} for and (b) the authenticating client is allowed to operate on.`
    },
    ...(extra.properties || {})
  };
  return {
    name: actionName,
    description: spec.description,
    inputSchema: {
      type: "object",
      required,
      properties,
      additionalProperties: false
    }
  };
}

// Resources mirror the safe shape returned by publicSite() / the
// list_browser_intent_sites tool. They never include loginUrl, secretPath,
// loginSelectors, or anything else gated behind publicSite()'s allowlist.
// Resource scoping mirrors tool scoping — a client only sees the sites it's
// allowed to operate on; everything else is treated as a non-existent URI.
const RESOURCE_SCHEME = "browser-intent";
const SITES_INDEX_URI = `${RESOURCE_SCHEME}://sites`;

function siteResourceUri(siteId) {
  return `${SITES_INDEX_URI}/${siteId}`;
}

function clientVisibleSiteIds(client) {
  return siteIds().filter((s) => clientAllowsSite(client, s));
}

function resourcesList(client) {
  const resources = [
    {
      uri: SITES_INDEX_URI,
      name: "Supported sites",
      description: "List of all sites this MCP server can manage browser sessions for that the authenticating client is allowed to operate on, with each site's display name, risk level, and allowed tools. No URLs, secrets, or page data.",
      mimeType: "application/json"
    }
  ];
  const policy = loadPolicy();
  for (const siteId of clientVisibleSiteIds(client)) {
    const site = policy.sites[siteId];
    resources.push({
      uri: siteResourceUri(siteId),
      name: site.displayName,
      description: `${site.displayName} site policy: display name, risk level, and allowed tools. No URLs, secrets, or page data.`,
      mimeType: "application/json"
    });
  }
  return resources;
}

function readResource(client, uri) {
  if (uri === SITES_INDEX_URI) {
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ sites: clientVisibleSiteIds(client).map(publicSite) })
      }]
    };
  }
  const prefix = `${SITES_INDEX_URI}/`;
  if (uri.startsWith(prefix)) {
    const siteId = uri.slice(prefix.length);
    if (!clientAllowsSite(client, siteId)) {
      // Don't distinguish between "site doesn't exist" and "client can't see
      // it" — both surface as `unknown resource`. Avoids leaking the
      // existence of other sites to a restricted client.
      throw new Error(`unknown resource: ${uri}`);
    }
    const site = publicSite(siteId);
    if (!site) throw new Error(`unknown resource: ${uri}`);
    return {
      contents: [{
        uri,
        mimeType: "application/json",
        text: JSON.stringify(site)
      }]
    };
  }
  throw new Error(`unknown resource: ${uri}`);
}

function toolsList(client) {
  const tools = [];
  for (const [actionName, spec] of Object.entries(ACTIONS)) {
    if (!actionIsEnabled(spec)) continue;
    const policySites = sitesAllowing(actionName);
    const sites = clientSiteIntersection(client, policySites);
    if (sites.length === 0) continue;
    tools.push(buildToolSchema(actionName, spec, sites));
  }
  // list_browser_intent_sites is always offered — its payload is already
  // narrowed by client scope in callTool().
  tools.push({
    name: "list_browser_intent_sites",
    description: "List the sites this client is configured to operate on (display name, risk level, allowed tools). Other sites the server manages are hidden. No URLs, secrets, or page data.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  });
  return tools;
}

// Shared secret between MCP and worker. The two containers sit on an internal
// Docker network so the practical risk is low, but a sibling container on
// platform-egress (squid, adguard, infisical-agent) being compromised should
// not yield unfettered worker control — the worker rejects any POST without
// this header. Generated once per stack (.env via `openssl rand -hex 32`).
const workerSecret = process.env.BROWSER_INTENT_WORKER_SECRET || "";

// Bound how long the MCP will wait on the worker before aborting. A hung
// worker (Chromium hang, network black-hole) would otherwise stall the LLM
// turn until the MCP client's own ~120s timeout fired, then surface as a
// generic abort with no audit trail. Default 60s covers a normal headed
// login plus OTP wait; tune via env if a specific site needs longer.
const workerTimeoutMs = Number(process.env.BROWSER_INTENT_WORKER_TIMEOUT_SECONDS || 60) * 1000;

// Bind the catalog-walker to ACTIONS so the boot block self-check stays a
// no-arg call site. (The underlying logic lives in lib/validator.js as
// assertCatalogSchemasValidatorCompatible.)
function assertActionsSchemasValidatorCompatible() {
  return assertCatalogSchemasValidatorCompatible(ACTIONS);
}

async function workerCall(path, body) {
  const headers = { "content-type": "application/json" };
  if (workerSecret) headers["x-worker-auth"] = workerSecret;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), workerTimeoutMs);
  let res;
  try {
    res = await fetch(`${workerUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body || {}),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === "AbortError" || controller.signal.aborted) {
      // Surface the timeout with a structured message so callTool's catch
      // block audits it (status_kind:error) rather than letting a raw
      // fetch abort bubble as an opaque failure.
      throw new Error(`worker call timed out after ${workerTimeoutMs}ms: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = payload.error || `worker returned HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload;
}

// MCP protocol versions this server speaks. The spec contract:
//   - Server replies to `initialize` with one of the versions in this list.
//   - If the client sent a version we support, echo it; otherwise reply with
//     our highest. The client decides whether to continue with our reply.
//   - HTTP clients on 2025-06-18 MUST send `MCP-Protocol-Version` on every
//     subsequent request. 2024-11-05 clients have no such requirement.
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
function negotiateProtocolVersion(clientRequested) {
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(clientRequested)) return clientRequested;
  return LATEST_PROTOCOL_VERSION;
}

// Token-bucket rate limit per authenticated client. Today an authenticated-
// but-malicious caller (or a buggy Hermes loop) could fire MCP calls as fast
// as the network allowed; the worker's per-site lock + login budget protects
// upstream portals, but the worker queue itself is unprotected. The bucket
// caps the rate at which a single client can drive workerCall, returning
// status_kind:rate_limited audit events that a Wazuh alert can pick up.
//
// Tunables:
//   BROWSER_INTENT_RATE_BURST    — bucket capacity (default 30 calls)
//   BROWSER_INTENT_RATE_REFILL   — tokens added per second (default 5)
// Defaults are generous for normal LLM usage (a few calls per turn) and
// catch runaway loops within ~10s.
const rateBurst = Number(process.env.BROWSER_INTENT_RATE_BURST || 30);
const rateRefillPerSec = Number(process.env.BROWSER_INTENT_RATE_REFILL || 5);
const _rateBuckets = new Map();

function rateCheck(clientName, now = Date.now()) {
  let bucket = _rateBuckets.get(clientName);
  if (!bucket) {
    bucket = { tokens: rateBurst, lastRefill: now };
    _rateBuckets.set(clientName, bucket);
  }
  const elapsedSec = (now - bucket.lastRefill) / 1000;
  if (elapsedSec > 0) {
    bucket.tokens = Math.min(rateBurst, bucket.tokens + elapsedSec * rateRefillPerSec);
    bucket.lastRefill = now;
  }
  if (bucket.tokens < 1) {
    const retryAfterSec = Math.ceil((1 - bucket.tokens) / rateRefillPerSec);
    return { allowed: false, retryAfterSec };
  }
  bucket.tokens -= 1;
  return { allowed: true };
}

// Lightweight per-session state. Sessions are only issued to 2025-06-18 HTTP
// clients (the stdio implicit-admin client doesn't need one — it's a single
// long-lived connection). Each session may optionally hold an SSE response
// object: when a client opens GET /mcp, the response sink is registered
// here so server-initiated notifications/{tools,resources,prompts}/
// list_changed reach the client over the live stream.
//
// Sessions auto-expire after `sessionMaxIdleMs` of inactivity (sweep runs
// from startPolicyWatcher's tick, lazily). Explicit DELETE /mcp tears down
// immediately.
const _sessions = new Map();
const sessionMaxIdleMs = Number(process.env.BROWSER_INTENT_SESSION_TTL_SECONDS || 3600) * 1000;

function newSessionId() {
  return crypto.randomBytes(16).toString("hex");
}

function getOrTouchSession(sessionId) {
  const entry = _sessions.get(sessionId);
  if (!entry) return null;
  entry.lastSeen = Date.now();
  return entry;
}

function dropSession(sessionId) {
  const entry = _sessions.get(sessionId);
  if (!entry) return;
  if (entry.sseSink) unregisterStdioSink(entry.sseSink);
  _sessions.delete(sessionId);
}

function reapStaleSessions(now = Date.now()) {
  for (const [id, entry] of _sessions.entries()) {
    if (now - entry.lastSeen > sessionMaxIdleMs) dropSession(id);
  }
}

function assertSiteAllowsAction(siteId, action) {
  const site = loadPolicy().sites[siteId];
  if (!site) throw new Error(`site is not allowlisted: ${siteId}`);
  if (!site.allowedTools.includes(action)) {
    throw new Error(`tool not allowed for site ${siteId}: ${action}`);
  }
}

// Bind the audit emitter to this component + the policy-version getter.
// STATUS_KIND, statusToKind, and redactErrorMessage are imported from
// lib/audit.js directly (they're pure / context-free).
const audit = createAudit({
  component: "browser-intent-mcp",
  policyVersionFn: () => policyVersion()
});

async function callTool(client, name, args = {}) {
  if (name === "list_browser_intent_sites") {
    const result = { sites: clientVisibleSiteIds(client).map(publicSite) };
    audit({ tool: name, client: client.name, result: "listed_sites", returned_sensitive_data: false });
    return result;
  }

  const spec = ACTIONS[name];
  if (!spec) throw new Error(`unknown tool: ${name}`);
  if (!actionIsEnabled(spec)) {
    throw new Error(`tool is disabled: ${name} (set BROWSER_INTENT_ENABLE_DIAGNOSTICS=true to enable diagnostic tools)`);
  }
  // Drop tools the client never had access to with the same "unknown tool"
  // phrasing — mirrors how readResource hides cross-client sites. Also
  // covers the case where ACTIONS lists a tool but no site in the client's
  // scope allows it (toolsList would have hidden it from the LLM).
  const policySites = sitesAllowing(name);
  const allowedSites = clientSiteIntersection(client, policySites);
  if (allowedSites.length === 0) {
    throw new Error(`unknown tool: ${name}`);
  }
  // Validate args against the SAME per-client schema toolsList returned —
  // a stdio admin or a misbehaving HTTP client can no longer send a typo'd
  // currency, an out-of-enum site, or an extra property and have it land
  // on the worker. The worker still re-validates semantic invariants
  // (e.g. /uploads-prefix on receipt paths) as defense-in-depth.
  const inputSchema = buildToolSchema(name, spec, allowedSites).inputSchema;
  try {
    validateArgs(args, inputSchema, name);
  } catch (validationError) {
    // Audit the rejection with a distinct `result` from site-scope denials
    // so operators investigating a status_kind:denied spike can tell
    // "client is sending malformed input" apart from "client is trying to
    // hit a forbidden site." Both still map to status_kind:denied for
    // dashboard grouping.
    audit({
      tool: name,
      client: client.name,
      site: (args && typeof args === "object" && !Array.isArray(args)) ? args.site : undefined,
      result: "denied_invalid_args",
      error: redactErrorMessage(validationError),
      returned_sensitive_data: false
    });
    throw validationError;
  }

  const { site: siteId, ...rest } = args;

  try {
    if (!clientAllowsSite(client, siteId)) {
      // Mirror unknown-site phrasing — don't leak whether the site exists.
      audit({ tool: name, client: client.name, site: siteId, result: "denied_by_client_policy", returned_sensitive_data: false });
      throw new Error(`site is not allowlisted: ${siteId}`);
    }
    assertSiteAllowsAction(siteId, name);
    let result;
    if (spec.category === "session") {
      // Pass any extra args (e.g. provide_otp's `code`) at the top level — that's
      // the existing worker protocol for /login, /logout, /session, /provide-otp.
      result = await workerCall(spec.endpoint, { site: siteId, ...rest });
    } else {
      // extraction or diagnostic — both go through /extract. Worker expects
      // { site, action, args }; args is the MCP arguments minus `site`. The
      // MCP layer already validated `rest` against the per-action schema, but
      // the worker still re-validates anything it depends on semantically
      // (e.g. /uploads-prefix on receipt paths in submit_claim).
      result = await workerCall("/extract", { site: siteId, action: name, args: rest });
    }
    audit({
      tool: name,
      client: client.name,
      site: siteId,
      result: result.status || "ok",
      returned_sensitive_data: Boolean(result.returned_sensitive_data)
    });
    return result;
  } catch (error) {
    audit({
      tool: name,
      client: client.name,
      site: siteId,
      result: "failed",
      error: redactErrorMessage(error),
      returned_sensitive_data: false
    });
    throw error;
  }
}

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function mcpError(id, error) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message: redactErrorMessage(error) } };
}

async function handleJsonRpc(client, message, transport = {}) {
  const { id, method, params } = message;
  if (method === "initialize") {
    const requested = (params && params.protocolVersion) || "2024-11-05";
    const negotiated = negotiateProtocolVersion(requested);
    // If the transport plumbs a session-issuance callback (HTTP path on
    // 2025-06-18), let it mint and stash a session ID we can advertise.
    if (typeof transport.issueSession === "function" && negotiated === "2025-06-18") {
      transport.issueSession(negotiated);
    }
    return mcpResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "ironnest-browser-intent", version: "0.1.0" }
    });
  }
  if (method === "notifications/initialized") return null;
  if (method === "tools/list") return mcpResult(id, { tools: toolsList(client) });
  if (method === "resources/list") return mcpResult(id, { resources: resourcesList(client) });
  if (method === "resources/read") {
    try {
      return mcpResult(id, readResource(client, params.uri));
    } catch (error) {
      return mcpError(id, error);
    }
  }
  if (method === "prompts/list") return mcpResult(id, { prompts: promptsList(client) });
  if (method === "prompts/get") {
    try {
      return mcpResult(id, getPrompt(client, params.name, params.arguments || {}));
    } catch (error) {
      return mcpError(id, error);
    }
  }
  if (method === "tools/call") {
    // Errors MUST come back as HTTP 200 with a JSON-RPC error body — MCP
    // clients (Hermes, Codex) don't parse HTTP 500 and just hang until their
    // own timeout fires. The denial / dispatcher / worker-call paths in
    // callTool() already audit-log on throw; here we only need to reshape
    // the wire response.
    try {
      const result = await callTool(client, params.name, params.arguments || {});
      return mcpResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError: false
      });
    } catch (error) {
      return mcpError(id, error);
    }
  }
  return mcpError(id, new Error(`unsupported method: ${method}`));
}

// Per-response headers. content-type is always present; Mcp-Policy-Version is
// added on every response so an HTTP MCP client (which has no persistent
// channel to receive notifications/list_changed) can detect policy drift
// across calls. Health and 404 carry it too — making the version polling
// path the cheapest one for ops sidecars.
function defaultHeaders() {
  return {
    "content-type": "application/json",
    "Mcp-Policy-Version": policyVersion()
  };
}

const httpServer = http.createServer(async (req, res) => {
  try {
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "browser-intent-mcp",
      http: req.method,
      path: req.url
    })}\n`);

    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, defaultHeaders());
      res.end(JSON.stringify({ ok: true, status: "live", policy_version: policyVersion() }));
      return;
    }
    if (req.method === "GET" && req.url === "/sites") {
      const client = authenticateClient(req);
      if (!client) {
        res.writeHead(401, defaultHeaders());
        res.end(JSON.stringify({ error: "auth_required", hint: "send Authorization: Bearer <token>; the token must match one of the entries in policies/clients.json whose env var is provisioned" }));
        return;
      }
      res.writeHead(200, defaultHeaders());
      res.end(JSON.stringify({ sites: clientVisibleSiteIds(client).map(publicSite) }));
      return;
    }
    if (req.method === "POST" && req.url === "/mcp") {
      const client = authenticateClient(req);
      if (!client) {
        res.writeHead(401, defaultHeaders());
        res.end(JSON.stringify({ error: "auth_required", hint: "send Authorization: Bearer <token>; the token must match one of the entries in policies/clients.json whose env var is provisioned" }));
        return;
      }
      const rate = rateCheck(client.name);
      if (!rate.allowed) {
        // Audit the limit hit so Wazuh sees runaway callers. status_kind
        // already maps "rate_limited" to the right bucket.
        audit({
          client: client.name,
          result: "rate_limited",
          retry_after_sec: rate.retryAfterSec,
          returned_sensitive_data: false
        });
        const headers = defaultHeaders();
        headers["Retry-After"] = String(rate.retryAfterSec);
        res.writeHead(429, headers);
        res.end(JSON.stringify({ error: "rate_limited", retry_after_sec: rate.retryAfterSec }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));

      // Streamable-HTTP session validation (2025-06-18). A client that
      // initialized on 2025-06-18 received an Mcp-Session-Id and must echo
      // it on every subsequent request, plus the negotiated MCP-Protocol-
      // Version header. 2024-11-05 clients have no session and skip this.
      const providedSessionId = req.headers["mcp-session-id"];
      const providedVersionHeader = req.headers["mcp-protocol-version"];
      if (msg.method !== "initialize") {
        if (providedSessionId) {
          const entry = getOrTouchSession(providedSessionId);
          if (!entry) {
            res.writeHead(404, defaultHeaders());
            res.end(JSON.stringify({ error: "session_not_found", hint: "re-send initialize to obtain a new Mcp-Session-Id" }));
            return;
          }
          if (providedVersionHeader && providedVersionHeader !== entry.version) {
            res.writeHead(400, defaultHeaders());
            res.end(JSON.stringify({ error: "protocol_version_mismatch", hint: `session was negotiated at ${entry.version}; sent ${providedVersionHeader}` }));
            return;
          }
        }
        // No session ID provided → treat as legacy 2024-11-05 client. Pass
        // through silently.
      }

      // initialize-only transport hook: if the client negotiates 2025-06-18
      // we mint a session and surface the ID in the response headers.
      let issuedSessionId = null;
      const transport = {
        issueSession: (negotiatedVersion) => {
          issuedSessionId = newSessionId();
          _sessions.set(issuedSessionId, {
            version: negotiatedVersion,
            client: client.name,
            createdAt: Date.now(),
            lastSeen: Date.now(),
            sseSink: null
          });
        }
      };

      const response = await handleJsonRpc(client, msg, transport);
      // Notifications (no id) yield null from handleJsonRpc. Per MCP Streamable
      // HTTP spec (and JSON-RPC 2.0), notifications get no response body —
      // return 202 Accepted with empty body. Returning `JSON.stringify(null)`
      // breaks strict clients (codex's rmcp crate errors with "data did not
      // match any variant of untagged enum JsonRpcMessage").
      if (response === null) {
        res.writeHead(202, { "Mcp-Policy-Version": policyVersion() });
        res.end();
        return;
      }
      const respHeaders = defaultHeaders();
      if (issuedSessionId) respHeaders["Mcp-Session-Id"] = issuedSessionId;
      res.writeHead(200, respHeaders);
      res.end(JSON.stringify(response));
      return;
    }

    // GET /mcp — Streamable HTTP server-push channel (2025-06-18). The
    // client opens an SSE stream after initialize; the server registers
    // the response as a notification sink so policy-change notifications
    // reach the live channel. Heartbeat comments every 30s keep proxies
    // from closing the connection. 2024-11-05 clients don't open this.
    if (req.method === "GET" && req.url === "/mcp") {
      const client = authenticateClient(req);
      if (!client) {
        res.writeHead(401, defaultHeaders());
        res.end(JSON.stringify({ error: "auth_required" }));
        return;
      }
      const sessionId = req.headers["mcp-session-id"];
      if (!sessionId) {
        res.writeHead(400, defaultHeaders());
        res.end(JSON.stringify({ error: "missing_mcp_session_id", hint: "GET /mcp requires Mcp-Session-Id header; complete an initialize handshake first" }));
        return;
      }
      const entry = getOrTouchSession(sessionId);
      if (!entry) {
        res.writeHead(404, defaultHeaders());
        res.end(JSON.stringify({ error: "session_not_found" }));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
        "Mcp-Policy-Version": policyVersion(),
        "Mcp-Session-Id": sessionId
      });
      res.write(": stream open\n\n");
      // Wrap the response in a stdio-style sink. broadcastNotification
      // writes one JSON-RPC notification per call; format as SSE here.
      const sink = (line) => {
        try {
          res.write(`event: message\ndata: ${line.trim()}\n\n`);
        } catch {
          // Best-effort; if the socket is closed, the cleanup handler below
          // unregisters us. Don't crash the broadcaster.
        }
      };
      registerStdioSink(sink);
      entry.sseSink = sink;
      const heartbeat = setInterval(() => {
        try { res.write(": keepalive\n\n"); } catch { /* covered by cleanup */ }
      }, 30000);
      const cleanup = () => {
        clearInterval(heartbeat);
        unregisterStdioSink(sink);
        if (entry.sseSink === sink) entry.sseSink = null;
      };
      req.on("close", cleanup);
      req.on("error", cleanup);
      return;
    }

    // DELETE /mcp — explicit session teardown (2025-06-18). Optional; the
    // idle reaper will eventually clean up abandoned sessions on its own.
    if (req.method === "DELETE" && req.url === "/mcp") {
      const sessionId = req.headers["mcp-session-id"];
      if (sessionId) dropSession(sessionId);
      res.writeHead(204, { "Mcp-Policy-Version": policyVersion() });
      res.end();
      return;
    }

    res.writeHead(404, defaultHeaders());
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (error) {
    res.writeHead(500, defaultHeaders());
    res.end(JSON.stringify({ error: redactErrorMessage(error) }));
  }
});

// Test-only exports. Tests require this module without binding the HTTP port
// or attaching to stdin — both live behind the `require.main === module` gate.
module.exports = {
  authenticateClient,
  clientAllowsSite,
  clientSiteIntersection,
  clientVisibleSiteIds,
  publicSite,
  sitesAllowing,
  toolsList,
  resourcesList,
  readResource,
  promptsList,
  getPrompt,
  sitesForPrompt,
  handleJsonRpc,
  loadClients,
  computePolicyVersion,
  policyVersion,
  registerStdioSink,
  unregisterStdioSink,
  validateArgs,
  validateValue,
  assertSchemaIsValidatorCompatible,
  assertActionsSchemasValidatorCompatible,
  statusToKind,
  STATUS_KIND,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
  negotiateProtocolVersion,
  // Session helpers — exposed so tests can drive the lifecycle without
  // round-tripping through the HTTP server.
  __sessions: _sessions,
  newSessionId,
  getOrTouchSession,
  dropSession,
  reapStaleSessions,
  rateCheck,
  __rateBuckets: _rateBuckets,
  rebuildTokenIndex,
  // Exposed for tests only — wraps the mtime-keyed JSON cache the production
  // code uses internally. Tests can mutate a tmp file's mtime to exercise
  // the invalidation path without touching the live read-only mount.
  __loadAndCacheJson: _loadAndCacheJson,
  __triggerPolicyChange: emitPolicyChanged,
  STDIO_CLIENT,
  ACTIONS,
  PROMPTS
};

if (require.main === module) {
  // Self-check: walk every ACTIONS schema and assert it uses only the
  // validator's supported types/keywords. Without this, a future ACTIONS
  // entry could add an unsupported keyword (e.g. `format`, `oneOf`) and
  // ship it without enforcement — fail-fast at boot is safer than silent
  // bypass at runtime.
  try {
    assertActionsSchemasValidatorCompatible();
  } catch (err) {
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "browser-intent-mcp",
      level: "fatal",
      msg: "ACTIONS schema drift: validator cannot enforce this schema",
      error: err.message
    })}\n`);
    process.exit(1);
  }

  // Eager-load the clients policy at boot so a typo / missing file fails the
  // container start with a clear message rather than silently 401'ing every
  // request later.
  try {
    const { clients } = loadClients();
    const provisioned = Object.entries(clients)
      .filter(([, c]) => process.env[c.tokenEnvVar])
      .map(([n]) => n);
    const unprovisioned = Object.entries(clients)
      .filter(([, c]) => !process.env[c.tokenEnvVar])
      .map(([n, c]) => `${n} (waiting on ${c.tokenEnvVar})`);
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "browser-intent-mcp",
      level: "info",
      msg: "client policy loaded",
      provisioned_clients: provisioned,
      unprovisioned_clients: unprovisioned
    })}\n`);
    if (provisioned.length === 0) {
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        component: "browser-intent-mcp",
        level: "warn",
        msg: "no client tokens are provisioned; HTTP /mcp and /sites will reject every request. stdio remains usable."
      })}\n`);
    }
  } catch (err) {
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      component: "browser-intent-mcp",
      level: "fatal",
      msg: "failed to load clients policy at boot",
      error: err.message
    })}\n`);
    process.exit(1);
  }

  // Eager-compute the initial policy version + start the policy watcher so
  // the first request already carries a stable Mcp-Policy-Version header
  // and so policy edits emit notifications without waiting for a request.
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    component: "browser-intent-mcp",
    level: "info",
    msg: "initial policy version computed",
    policy_version: policyVersion()
  })}\n`);
  startPolicyWatcher();
  // Register the stdio sink so notifications/{tools,resources,prompts}/
  // list_changed reach the implicit-admin stdio client (Codex, etc.). HTTP
  // clients have no persistent channel and rely on the version header.
  registerStdioSink((line) => process.stdout.write(line));

  // 0.0.0.0 is required for Docker port mapping to work; external access is
  // restricted by the compose publish binding (127.0.0.1:18901 only).
  httpServer.listen(httpPort, "0.0.0.0");

  // SIGHUP triggers a full reload of the token index from the current env +
  // clients.json. Lets an operator rotate a bearer token without restarting
  // the container — update the env var (e.g. via a sidecar that writes to
  // /proc/$pid/environ, or by re-exec'ing with new env), then send SIGHUP.
  // The watcher already picks up clients.json edits; this handler is for
  // env-only rotations the watcher can't observe.
  process.on("SIGHUP", () => {
    try {
      const newIndex = rebuildTokenIndex();
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        component: "browser-intent-mcp",
        level: "info",
        msg: "SIGHUP received - token index rebuilt",
        provisioned_clients: [...newIndex.values()].map((c) => c.name)
      })}\n`);
    } catch (err) {
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        component: "browser-intent-mcp",
        level: "error",
        msg: "SIGHUP token-index rebuild failed",
        error: err.message
      })}\n`);
    }
  });

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const response = await handleJsonRpc(STDIO_CLIENT, JSON.parse(line));
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify(mcpError(null, error))}\n`);
    }
  });
}
