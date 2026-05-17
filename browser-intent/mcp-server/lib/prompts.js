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

// Factory: build the prompts helper bundle against the policy-loader and
// client-scope-intersection provided by server.js. The factory pattern
// keeps prompts.js pure (no fs / no module-level singletons) and lets
// server.js wire it once at startup; tests can re-create with stubs.
function createPromptsHelpers({ loadPolicy, clientSiteIntersection, diagnosticsEnabled }) {
  function promptIsEnabled(spec) {
    if (spec.category === "diagnostic" && !diagnosticsEnabled()) return false;
    return true;
  }

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

  return { PROMPTS, promptIsEnabled, sitesForPrompt, promptsList, getPrompt };
}

module.exports = { PROMPTS, createPromptsHelpers };
