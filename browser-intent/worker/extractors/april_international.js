// April International member portal — diagnostic-only scaffolding.
//
// Target data (per platform owner): policy & claims
//   - Active policy details, coverage summary, claim status / history.
//
// April Mobility is a global insurance portal — login flow may include an
// account / market selector before the dashboard loads. The forms summary
// returned here surfaces those selectors so the maintainer can decide whether
// site-specific navigation hints belong in sites.json (e.g. a post-login
// "select account" step) or in the future get_policy / get_claims function.

const fs = require("node:fs");
const path = require("node:path");

const {
  sanitizeUrl,
  redactCellText,
  collectFrameSummaries,
  collectFrameLinksMatching,
  summarizeForms,
  summarizeLoginForms,
  summarizeDashboard
} = require("./_diagnose");

const RELEVANT_LINK_RE = /policy|certificate|claim|coverage|beneficiary|premium|reimburs|account|dashboard|document|hospital/i;

// Known sub-pages discovered via diagnose 2026-05-14. The portal exposes
// real <a href> nav items (unlike Maxicare's div-based nav), so a maintainer
// can extend this list by reading link_candidates from a fresh diagnose run.
const BASE = "https://members.april-international.com";
const SUB_ROUTES = [
  { name: "home", path: "/en-us/home/welcome" },
  { name: "policy", path: "/en-us/policies/individual" },
  { name: "claims", path: "/en-us/claims" },
  { name: "documents", path: "/en-us/documents/document-details" },
  { name: "account", path: "/en-us/account/my-account" }
];

async function waitForHydration(page) {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page
    .waitForFunction(
      () => {
        const main = document.querySelector("main, [role=main]") || document.body;
        return main && (main.innerText || "").trim().length > 80;
      },
      null,
      { timeout: 15000 }
    )
    .catch(() => {});
  await page.waitForTimeout(500);
}

async function dumpCurrentPage(page) {
  await waitForHydration(page);
  return {
    url: sanitizeUrl(page.url()),
    frames: await collectFrameSummaries(page),
    link_candidates: await collectFrameLinksMatching(page, RELEVANT_LINK_RE),
    forms: await summarizeForms(page),
    dashboard: await summarizeDashboard(page)
  };
}

async function diagnoseMemberPortal(page) {
  // Walk each known sub-page. Server-rendered Angular(?) app — page.goto
  // works (unlike Maxicare where we had to click nav items). Bake each dump
  // into a single diagnose result so a maintainer can see all extractor
  // targets in one call.
  const pages = [];
  for (const route of SUB_ROUTES) {
    const navigated = await page
      .goto(`${BASE}${route.path}`, { waitUntil: "domcontentloaded", timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    pages.push({ requested_path: route.path, name: route.name, navigated, ...(await dumpCurrentPage(page)) });
  }

  return {
    site: "april_international",
    status: "ok",
    diagnostic: true,
    pages,
    returned_sensitive_data: false
  };
}

async function gotoRoute(page, path) {
  if (!page.url().startsWith(BASE) || !page.url().includes(path)) {
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  }
  await waitForHydration(page);
}

// Personal info from /account/my-account. Server-rendered <main> with
// labeled fields ("Email <addr> First name <X> Last name <Y> Date of birth
// <iso> Address <multiline>"). Parse against those anchors so a label-text
// shuffle yields a missing-value rather than a wrong value.
async function getAccountInfo(page) {
  await gotoRoute(page, "/en-us/account/my-account");
  const data = await page
    .evaluate(() => {
      const truncate = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
      const main = document.querySelector("main, [role=main]") || document.body;
      const text = (main.innerText || "").replace(/\s+/g, " ").trim();
      const pick = (re) => {
        const m = text.match(re);
        return m ? truncate(m[1], 200) : null;
      };
      return {
        email: pick(/Email\s+(\S+@\S+)/),
        first_name: pick(/First name\s+([^]+?)\s+Last name/i),
        last_name: pick(/Last name\s+([^]+?)\s+Date of birth/i),
        date_of_birth: pick(/Date of birth\s+(\d{4}-\d{2}-\d{2})/),
        address: pick(/Address\s+([^]+?)(?:\s+Follow Us|\s+Terms|$)/i)
      };
    })
    .catch(() => ({}));
  return {
    site: "april_international",
    status: "ok",
    name: [data.first_name, data.last_name].filter(Boolean).join(" ") || null,
    email: data.email,
    date_of_birth: data.date_of_birth,
    address: data.address,
    returned_sensitive_data: true
  };
}

// Policy details from /policies/individual. Tab-rendered; the "Information"
// tab is the default landing and shows policy number, name, policyholder,
// duration. Insured members are listed under a separate tab — we click it
// best-effort and pull names. Bank details / documents are gated on
// additional taps and may have separate extractors later.
async function getPolicyInfo(page) {
  await gotoRoute(page, "/en-us/policies/individual");
  const info = await page
    .evaluate(() => {
      const truncate = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
      const main = document.querySelector("main, [role=main]") || document.body;
      const text = (main.innerText || "").replace(/\s+/g, " ").trim();
      const pick = (re) => {
        const m = text.match(re);
        return m ? truncate(m[1], 200) : null;
      };
      return {
        policy_number: pick(/Policy number\s+([A-Z0-9\-]+)/i),
        policy_name: pick(/Policy name\s+([^]+?)\s+Policyholder/i),
        policyholder: pick(/Policyholder\s+([^]+?)\s+Policy duration/i),
        policy_duration: pick(/Policy duration\s+([^]+?)\s+(?:Insured members|Bank Details|Documents|$)/i)
      };
    })
    .catch(() => ({}));

  // Switch to the "Insured members" tab to read names. Best-effort: if the
  // tab is missing or the click fails, return an empty list and a note.
  let insuredMembers = [];
  try {
    const tab = page.getByText("Insured members", { exact: true }).first();
    if (await tab.count().catch(() => 0)) {
      await tab.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(800);
      insuredMembers = await page
        .evaluate(() => {
          const main = document.querySelector("main, [role=main]") || document.body;
          // Insured members table: each row carries a person's name. We
          // collect text from card-like elements after the "Insured members"
          // heading and filter heuristically.
          const txt = (main.innerText || "")
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          const startIdx = txt.findIndex((l) => /^Insured members$/i.test(l));
          if (startIdx < 0) return [];
          const candidate = txt.slice(startIdx + 1, startIdx + 40);
          // A member row typically looks like "FIRSTNAME LASTNAME" (all
          // letters, possibly hyphens), distinct from headers like "Date of
          // birth" or "Relationship".
          return candidate.filter((l) =>
            /^[A-Z][A-Za-z\-']+\s+[A-Z][A-Za-z\-']+/.test(l) && !/Date|Birth|Relationship|Email/i.test(l)
          );
        })
        .catch(() => []);
    }
  } catch {
    /* fall through with empty list */
  }

  return {
    site: "april_international",
    status: "ok",
    policy_number: info.policy_number,
    policy_name: info.policy_name,
    policyholder: info.policyholder,
    policy_duration: info.policy_duration,
    insured_members: insuredMembers,
    returned_sensitive_data: true
  };
}

// Claims history from /claims. Each claim row in the DOM follows a
// repeating structure with the headers ["Date of treatment", "Beneficiary",
// "Provider", "Claim amount", "Paid amount", "Status"]. Server-rendered
// with no <table>; rows live inside grid-styled divs. We find any div
// containing a date pattern + " PHP " + a status keyword, then pull its
// inner cell text and align with the headers.
async function getClaimsHistory(page) {
  await gotoRoute(page, "/en-us/claims");
  // The claims list loads via async fetch after main mount — main_text
  // shows "Loading..." during this window. Wait for a date pattern to
  // appear in main, or "no claims" text, then bail.
  await page
    .waitForFunction(
      () => {
        const t =
          (document.querySelector("main, [role=main]") || document.body)?.innerText || "";
        return /\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}/.test(t) || /no claims/i.test(t);
      },
      null,
      { timeout: 20000 }
    )
    .catch(() => {});
  await page.waitForTimeout(500);
  const claims = await page
    .evaluate(() => {
      const main = document.querySelector("main, [role=main]") || document.body;
      const text = main?.innerText || "";
      // April renders each claim row as a grid of 6 cells, each on its own
      // line in innerText output: date, beneficiary, provider, claim_amount,
      // paid_amount, status. The block is preceded by a header row with the
      // same 6 column labels. Parse line-by-line after finding the header.
      const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
      const headerSeq = [
        "Date of treatment",
        "Beneficiary",
        "Provider",
        "Claim amount",
        "Paid amount",
        "Status"
      ];
      let startIdx = -1;
      for (let i = 0; i <= lines.length - headerSeq.length; i++) {
        const match = headerSeq.every(
          (h, j) => (lines[i + j] || "").toLowerCase() === h.toLowerCase()
        );
        if (match) {
          startIdx = i + headerSeq.length;
          break;
        }
      }
      if (startIdx < 0) return [];
      const dateRe = /^\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}$/;
      const statusRe = /^(Paid|Pending|Rejected|Refused|Approved|Processing|Submitted|Under review|In progress)$/i;
      const out = [];
      let i = startIdx;
      // Each iteration consumes exactly 6 lines if they form a valid claim
      // row (date + status anchor positions). If the cadence breaks (a
      // filter chip or "Load more" button sneaks in), advance by one and
      // try to resync — keeps us robust against unrelated lines.
      while (i + 5 < lines.length && out.length < 50) {
        if (dateRe.test(lines[i]) && statusRe.test(lines[i + 5])) {
          out.push({
            date_of_treatment: lines[i],
            beneficiary: lines[i + 1],
            provider: lines[i + 2],
            claim_amount: lines[i + 3],
            paid_amount: lines[i + 4],
            status: lines[i + 5]
          });
          i += 6;
        } else {
          // Try to resync on the next date line. If none, bail.
          const next = lines.slice(i + 1).findIndex((l) => dateRe.test(l));
          if (next === -1) break;
          i = i + 1 + next;
        }
      }
      return out;
    })
    .catch(() => []);
  // Probe — only populated when extraction is empty, so a maintainer can
  // see what the page actually looked like. Truncated and redacted for
  // logs; not for production callers.
  let probe = null;
  if (!claims.length) {
    probe = await page
      .evaluate(() => {
        const main = document.querySelector("main, [role=main]") || document.body;
        const text = (main?.innerText || "").trim();
        return {
          main_text_length: text.length,
          has_date_pattern: /\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}/.test(text),
          has_loading: /Loading/i.test(text),
          has_php: / PHP /.test(text),
          div_count: document.querySelectorAll("div").length,
          main_text_sample: text.slice(0, 1200)
        };
      })
      .catch(() => null);
  }

  return {
    site: "april_international",
    status: "ok",
    claim_count: claims.length,
    claims,
    notes: claims.length
      ? null
      : "no_claims_found: either the user has no claims, or the row pattern (date + PHP amount + status) didn't match the current DOM. probe field shows what was on the page.",
    probe,
    returned_sensitive_data: true
  };
}

// Documents list from /documents/document-details. April surfaces a set of
// downloadable PDFs (Claim Form, Network Lists, Bank Info, etc.). Each
// download is an <a href> to assets.april.fr — we collect them with their
// labels. Returning the URLs is safe per platform policy: they're public
// asset URLs, not session-tied download tokens.
async function getDocumentsList(page) {
  await gotoRoute(page, "/en-us/documents/document-details");
  const documents = await page
    .evaluate(() => {
      const truncate = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
      const stripIcon = (s) => (s || "").replace(/file_download/gi, "").replace(/\s+/g, " ").trim();
      const anchors = Array.from(document.querySelectorAll("a[href]"))
        .filter((a) => /assets\.april\.fr|selfcare\/asia/i.test(a.getAttribute("href") || ""));
      // The document name typically lives in a sibling element (a span/div)
      // adjacent to the download icon link. Walk upward up to 4 ancestors
      // looking for the first ancestor whose innerText (after stripping
      // "file_download") yields a non-empty label distinct from the anchor's
      // own textContent. aria-label/title on the anchor itself takes
      // priority — it's the most explicit signal.
      return anchors.slice(0, 50).map((a) => {
        const href = a.getAttribute("href") || "";
        const ariaLabel = truncate(a.getAttribute("aria-label") || a.getAttribute("title") || "", 120);
        if (ariaLabel) return { label: ariaLabel, url: href };
        let label = "";
        let node = a.parentElement;
        for (let depth = 0; depth < 4 && node && !label; depth++) {
          const candidate = stripIcon(node.innerText || node.textContent);
          if (candidate && candidate.length > 2 && candidate.length < 200) label = candidate;
          node = node.parentElement;
        }
        return { label: truncate(label, 160) || "(unlabeled)", url: href };
      });
    })
    .catch(() => []);
  return {
    site: "april_international",
    status: "ok",
    document_count: documents.length,
    documents,
    returned_sensitive_data: true
  };
}

// Find the claim-submission form by clicking "Submit a claim" from
// /en-us/claims, falling back to a set of likely direct URLs if no link is
// found. Returns the page once it has reached a hydrated form-ish state, or
// null if every attempt failed (caller emits needs_extractor_update).
async function navigateToClaimForm(page) {
  await gotoRoute(page, "/en-us/claims");
  // Try clicking the in-page "Submit a claim" entry first — server-rendered
  // <a href> per memory notes, so the post-click URL is whatever April uses.
  // Multiple label variants observed across markets.
  const labelVariants = [
    "Submit a claim",
    "Submit claim",
    "New claim",
    "Soumettre une demande",
    "Déclarer un sinistre"
  ];
  for (const label of labelVariants) {
    const locator = page.getByText(label, { exact: false }).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const navigated = await Promise.allSettled([
      page.waitForLoadState("domcontentloaded", { timeout: 15000 }),
      locator.click({ timeout: 5000 })
    ]);
    if (navigated.some((r) => r.status === "fulfilled")) {
      await waitForHydration(page);
      return page;
    }
  }
  // Fallback: try a handful of plausible direct URLs. Each is best-effort;
  // we stop as soon as one lands on a form-bearing page. We don't hard-code
  // the canonical path because it isn't in the diagnose snapshot yet.
  const candidatePaths = [
    "/en-us/claims/submit",
    "/en-us/claims/new",
    "/en-us/claims/create",
    "/en-us/claim/submit"
  ];
  for (const candidate of candidatePaths) {
    const ok = await page
      .goto(`${BASE}${candidate}`, { waitUntil: "domcontentloaded", timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) continue;
    await waitForHydration(page);
    const inputCount = await page.locator("input, select, textarea").count().catch(() => 0);
    if (inputCount > 0) return page;
  }
  return null;
}

// Diagnostic: surface the structure of April's claim-submission form so a
// maintainer can author / repair submitClaim selectors. Returns sanitized
// form metadata only — no field values, no receipts, no PII.
async function diagnoseClaimForm(page) {
  const reached = await navigateToClaimForm(page);
  if (!reached) {
    return {
      site: "april_international",
      status: "needs_extractor_update",
      diagnostic: true,
      note: "couldn't locate the claim-submission form via the Submit-a-claim link or known direct URLs; the route may have moved",
      returned_sensitive_data: false
    };
  }
  // Reuse the rich form summary already used by diagnose_login_form: name/id/
  // type/autocomplete/placeholder/label/data-testid, buttons, form action.
  const frames = await summarizeLoginForms(page).catch(() => []);
  return {
    site: "april_international",
    status: "ok",
    diagnostic: true,
    url: sanitizeUrl(page.url()),
    frames,
    returned_sensitive_data: false
  };
}

// Best-effort fill of an unknown form using a curated selector list. Returns
// the field that filled (or null) so a caller can record what worked. Keeping
// this loose-and-list-driven beats hard-coding because the actual selectors
// won't be known until diagnose_claim_form runs against a logged-in account.
async function fillFirstMatching(page, selectors, value, { kind = "type" } = {}) {
  for (const sel of selectors) {
    const locator = page.locator(sel).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    try {
      if (kind === "select") {
        await locator.selectOption({ label: String(value) }).catch(async () => {
          await locator.selectOption(String(value)).catch(() => {});
        });
      } else if (kind === "fill") {
        await locator.fill(String(value));
      } else {
        await locator.click({ timeout: 3000 }).catch(() => {});
        await locator.type(String(value), { delay: 15 });
      }
      return sel;
    } catch {
      // try the next selector
    }
  }
  return null;
}

// Validate a receipts array end-to-end before letting Playwright touch the
// filesystem. The MCP layer already enforces the /uploads prefix via JSON
// schema, but the worker re-checks because:
//   (a) someone could call the worker's HTTP API directly (bypassing MCP),
//   (b) Playwright will happily attach /secrets/.env if asked; the schema is
//       advisory at the boundary, but the read-side check has to be load-bearing.
function validatedReceiptPaths(receipts) {
  const out = [];
  for (const raw of receipts || []) {
    if (typeof raw !== "string") continue;
    // Reject path traversal and absolute paths outside /uploads. path.normalize
    // resolves '..' so a smuggled traversal collapses and fails the prefix check.
    const normalized = path.normalize(raw);
    if (!normalized.startsWith("/uploads/")) {
      throw new Error(`receipt path must be under /uploads/: ${raw}`);
    }
    if (!fs.existsSync(normalized)) {
      throw new Error(`receipt file not found: ${normalized}`);
    }
    const stat = fs.statSync(normalized);
    if (!stat.isFile()) {
      throw new Error(`receipt path is not a regular file: ${normalized}`);
    }
    out.push(normalized);
  }
  return out;
}

// Submit a claim on April. Defaults to dry_run=true: form is filled and a
// sanitized snapshot is returned, but no submit button is clicked. Set
// dry_run=false explicitly to actually submit. WRITE operation; the audit
// log distinguishes preview vs real submit.
async function submitClaim(page, args = {}) {
  const {
    treatment_date: treatmentDate,
    beneficiary,
    provider,
    claim_amount: claimAmount,
    currency,
    description,
    receipts
  } = args;
  // Default-true safety: only an explicit `false` triggers a real submit.
  const dryRun = args.dry_run !== false;

  if (!treatmentDate || claimAmount == null) {
    throw new Error("submit_claim requires treatment_date and claim_amount");
  }

  // Validate receipts BEFORE touching the page so a bad path errors out
  // without leaving Playwright in a half-filled state.
  const safeReceipts = validatedReceiptPaths(receipts);

  const reached = await navigateToClaimForm(page);
  if (!reached) {
    return {
      site: "april_international",
      status: "needs_extractor_update",
      reason: "claim_form_not_found",
      note: "couldn't locate the claim-submission form; ask a maintainer to enable BROWSER_INTENT_ENABLE_DIAGNOSTICS and run diagnose_claim_form (site=april_international) to capture the current selectors",
      returned_sensitive_data: false
    };
  }

  // Selector lists are intentionally generous — the actual names won't be
  // known until diagnose_claim_form runs against a logged-in account. Each
  // list orders most-specific → most-generic. fillFirstMatching returns the
  // selector that worked, so the response surfaces which slot was filled for
  // the maintainer to tighten later.
  const filled = {};
  filled.treatment_date = await fillFirstMatching(
    page,
    [
      "input[name*='treatment' i][type='date']",
      "input[name*='date' i][type='date']",
      "input[type='date']",
      "input[name*='date' i]",
      "input[placeholder*='date' i]"
    ],
    treatmentDate,
    { kind: "fill" }
  );
  if (provider) {
    filled.provider = await fillFirstMatching(
      page,
      [
        "input[name*='provider' i]",
        "input[name*='clinic' i]",
        "input[name*='hospital' i]",
        "input[placeholder*='provider' i]",
        "input[placeholder*='clinic' i]"
      ],
      provider,
      { kind: "fill" }
    );
  }
  filled.claim_amount = await fillFirstMatching(
    page,
    [
      "input[name*='amount' i][type='number']",
      "input[name*='amount' i]",
      "input[type='number']",
      "input[placeholder*='amount' i]"
    ],
    String(claimAmount),
    { kind: "fill" }
  );
  if (currency) {
    filled.currency = await fillFirstMatching(
      page,
      ["select[name*='currency' i]", "select[name*='ccy' i]"],
      currency,
      { kind: "select" }
    );
  }
  if (beneficiary) {
    filled.beneficiary = await fillFirstMatching(
      page,
      [
        "select[name*='beneficiary' i]",
        "select[name*='insured' i]",
        "select[name*='member' i]"
      ],
      beneficiary,
      { kind: "select" }
    );
    if (!filled.beneficiary) {
      // Some portals render beneficiary as an autocomplete input rather than
      // a <select>. Fall back to a text-fill so the value at least lands in
      // the DOM even if the maintainer needs to update the selector later.
      filled.beneficiary = await fillFirstMatching(
        page,
        ["input[name*='beneficiary' i]", "input[name*='insured' i]"],
        beneficiary,
        { kind: "fill" }
      );
    }
  }
  if (description) {
    filled.description = await fillFirstMatching(
      page,
      [
        "textarea[name*='description' i]",
        "textarea[name*='reason' i]",
        "textarea[name*='note' i]",
        "textarea"
      ],
      description,
      { kind: "fill" }
    );
  }
  // Receipts: April's form may accept multiple files in one input or one per
  // file. Try a single multi-file input first; fall back to per-file inputs
  // in document order.
  if (safeReceipts.length) {
    const fileInputs = page.locator("input[type='file']");
    const fileInputCount = await fileInputs.count().catch(() => 0);
    if (fileInputCount === 0) {
      filled.receipts = null;
    } else if (fileInputCount === 1) {
      await fileInputs.first().setInputFiles(safeReceipts).catch(() => {});
      filled.receipts = "single_multi_file_input";
    } else {
      for (let i = 0; i < Math.min(safeReceipts.length, fileInputCount); i++) {
        await fileInputs.nth(i).setInputFiles(safeReceipts[i]).catch(() => {});
      }
      filled.receipts = "multiple_inputs";
    }
  }

  const filledCount = Object.values(filled).filter(Boolean).length;
  // If we couldn't fill even the required fields, treat as needs_extractor_update
  // rather than risk submitting an incomplete claim.
  if (!filled.treatment_date || !filled.claim_amount) {
    return {
      site: "april_international",
      status: "needs_extractor_update",
      reason: "required_fields_not_locatable",
      filled,
      note: "required field selectors didn't match — ask a maintainer to enable BROWSER_INTENT_ENABLE_DIAGNOSTICS and run diagnose_claim_form (site=april_international) to capture the current form structure",
      returned_sensitive_data: false
    };
  }

  if (dryRun) {
    // Sanitized preview — show what *would* have been submitted (filled
    // selectors only), no field values returned. Caller can re-call with
    // dry_run=false to commit.
    return {
      site: "april_international",
      status: "dry_run",
      mode: "preview",
      url: sanitizeUrl(page.url()),
      filled,
      filled_count: filledCount,
      receipt_count: safeReceipts.length,
      note: "Form fields were filled but no submit button was clicked. Re-call with dry_run=false to actually submit the claim.",
      returned_sensitive_data: false
    };
  }

  // Real submit. Try common submit-button text/types in priority order. We
  // do not press Enter as a fallback here — a stray Enter on a multi-step
  // wizard could advance without validation.
  const submitSelectors = [
    "button[type='submit']:not([disabled])",
    "button:has-text('Submit claim'):not([disabled])",
    "button:has-text('Submit'):not([disabled])",
    "button:has-text('Send'):not([disabled])",
    "button.cta:has-text('Submit'):not([disabled])"
  ];
  let submitClicked = false;
  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    const count = await btn.count().catch(() => 0);
    if (!count) continue;
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) continue;
    await Promise.allSettled([
      page.waitForLoadState("networkidle", { timeout: 30000 }),
      btn.click()
    ]);
    submitClicked = true;
    break;
  }
  if (!submitClicked) {
    return {
      site: "april_international",
      status: "needs_extractor_update",
      reason: "submit_button_not_found",
      filled,
      note: "Form was filled but no submit button was located. Ask a maintainer to enable BROWSER_INTENT_ENABLE_DIAGNOSTICS and re-run diagnose_claim_form (site=april_international) to capture button selectors.",
      returned_sensitive_data: false
    };
  }
  await page.waitForTimeout(1500);

  // Read back a confirmation signal. Sites typically render a success page
  // with a claim reference number — capture it and the URL so the caller has
  // an audit trail without round-tripping page HTML.
  const confirmation = await page
    .evaluate(() => {
      const truncate = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
      const main = document.querySelector("main, [role=main]") || document.body;
      const text = truncate(main?.innerText || "", 800);
      const successRe = /\b(success|submitted|received|reference\s*(?:number|#)?\s*[:#]?\s*[A-Z0-9\-]+|merci|confirmé|envoyée)\b/i;
      const refMatch = text.match(/\b([A-Z]{2,4}[-_]?\d{4,}(?:[-_]\d+)*)\b/);
      const errorRe = /\b(error|failed|required|missing|invalid|veuillez|obligatoire)\b/i;
      return {
        appears_successful: successRe.test(text),
        appears_failed: errorRe.test(text) && !successRe.test(text),
        possible_reference: refMatch ? refMatch[1] : null,
        main_text_excerpt: text
      };
    })
    .catch(() => ({}));

  const status = confirmation.appears_successful
    ? "submitted"
    : confirmation.appears_failed
      ? "submit_rejected"
      : "submitted_unconfirmed";

  return {
    site: "april_international",
    status,
    url: sanitizeUrl(page.url()),
    filled,
    filled_count: filledCount,
    receipt_count: safeReceipts.length,
    possible_reference: confirmation.possible_reference || null,
    // Redact digit runs / emails before returning the main-region text snippet
    // — same posture as snapshotPage in worker.js (PII may appear post-submit).
    main_text_excerpt: redactCellText(confirmation.main_text_excerpt || ""),
    // A real submit mutates upstream state; flag it for the audit log so a
    // Wazuh query can find every actual claim submission.
    write_operation: true,
    returned_sensitive_data: true
  };
}

// Read a single claim's detail by ID. The claims list at /en-us/claims has
// per-row click targets; we attempt three navigation strategies (direct URL,
// query param, click by text) and return the detail-page contents using the
// same anchored-label parsing as getPolicyInfo / getAccountInfo.
async function getClaimStatus(page, args = {}) {
  const claimId = args.claim_id;
  if (!claimId || typeof claimId !== "string") {
    throw new Error("get_claim_status requires claim_id");
  }
  // Re-validate the claim_id pattern in case this worker is reached directly
  // (the MCP layer enforces this at the schema boundary, but the worker has
  // its own HTTP listener and must not trust input from there either).
  if (!/^[A-Za-z0-9_\-./]+$/.test(claimId)) {
    throw new Error(`invalid claim_id format: ${claimId}`);
  }

  const directPaths = [
    `/en-us/claims/${encodeURIComponent(claimId)}`,
    `/en-us/claims/detail/${encodeURIComponent(claimId)}`,
    `/en-us/claims?id=${encodeURIComponent(claimId)}`
  ];
  let landed = false;
  for (const direct of directPaths) {
    const ok = await page
      .goto(`${BASE}${direct}`, { waitUntil: "domcontentloaded", timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!ok) continue;
    await waitForHydration(page);
    // Heuristic: page is a detail page if main text mentions the claim id or
    // contains both a status keyword and an amount keyword.
    const ok2 = await page
      .evaluate((id) => {
        const main = document.querySelector("main, [role=main]") || document.body;
        const text = (main?.innerText || "").toLowerCase();
        return text.includes(id.toLowerCase()) || (/status|paid|approved/.test(text) && /amount/.test(text));
      }, claimId)
      .catch(() => false);
    if (ok2) {
      landed = true;
      break;
    }
  }
  // Fallback: navigate to the list and try clicking a row whose text
  // contains the claim ID.
  if (!landed) {
    await gotoRoute(page, "/en-us/claims");
    const row = page.getByText(claimId, { exact: false }).first();
    const count = await row.count().catch(() => 0);
    if (count) {
      await Promise.allSettled([
        page.waitForLoadState("domcontentloaded", { timeout: 15000 }),
        row.click({ timeout: 5000 })
      ]);
      await waitForHydration(page);
      landed = true;
    }
  }
  if (!landed) {
    return {
      site: "april_international",
      status: "not_found",
      claim_id: claimId,
      note: "couldn't locate a detail page for the given claim_id",
      returned_sensitive_data: false
    };
  }

  const detail = await page
    .evaluate(() => {
      const truncate = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
      const main = document.querySelector("main, [role=main]") || document.body;
      const text = (main?.innerText || "").replace(/\s+/g, " ").trim();
      const pick = (re) => {
        const m = text.match(re);
        return m ? truncate(m[1], 240) : null;
      };
      return {
        claim_reference: pick(/(?:Claim\s*(?:number|reference|#)|Reference)[:\s]+([A-Z0-9\-_/]+)/i),
        status_label: pick(/Status[:\s]+([^]+?)(?:\s+(?:Date|Amount|Paid|Provider|Beneficiary|$))/i),
        date_of_treatment: pick(/(?:Date of treatment|Treatment date)[:\s]+([^]+?)(?:\s+(?:Beneficiary|Provider|Amount|Status|$))/i),
        beneficiary: pick(/Beneficiary[:\s]+([^]+?)(?:\s+(?:Provider|Amount|Status|Date|$))/i),
        provider: pick(/Provider[:\s]+([^]+?)(?:\s+(?:Amount|Status|Date|Beneficiary|$))/i),
        claim_amount: pick(/Claim\s*amount[:\s]+([^]+?)(?:\s+(?:Paid|Status|$))/i),
        paid_amount: pick(/Paid\s*amount[:\s]+([^]+?)(?:\s+(?:Status|$))/i),
        notes: pick(/(?:Notes?|Reason)[:\s]+([^]+?)(?:\s+(?:Status|$))/i),
        main_text_length: text.length
      };
    })
    .catch(() => ({}));

  return {
    site: "april_international",
    status: "ok",
    claim_id: claimId,
    url: sanitizeUrl(page.url()),
    claim_reference: detail.claim_reference,
    status_label: detail.status_label,
    date_of_treatment: detail.date_of_treatment,
    beneficiary: detail.beneficiary,
    provider: detail.provider,
    claim_amount: detail.claim_amount,
    paid_amount: detail.paid_amount,
    notes: detail.notes,
    returned_sensitive_data: true
  };
}

module.exports = {
  diagnoseMemberPortal,
  diagnoseClaimForm,
  getAccountInfo,
  getPolicyInfo,
  getClaimsHistory,
  getClaimStatus,
  getDocumentsList,
  submitClaim
};
