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

const {
  sanitizeUrl,
  collectFrameSummaries,
  collectFrameLinksMatching,
  summarizeForms
} = require("./_diagnose");

const RELEVANT_LINK_RE = /policy|certificate|claim|coverage|beneficiary|premium|reimburs|account|dashboard|document/i;

async function diagnoseMemberPortal(page) {
  await page.waitForTimeout(1000);

  const landingUrl = sanitizeUrl(page.url());
  const frames = await collectFrameSummaries(page);
  const links = await collectFrameLinksMatching(page, RELEVANT_LINK_RE);
  const forms = await summarizeForms(page);

  return {
    site: "april_international",
    status: "ok",
    diagnostic: true,
    landing_url: landingUrl,
    frames,
    link_candidates: links,
    forms,
    returned_sensitive_data: false
  };
}

module.exports = { diagnoseMemberPortal };
