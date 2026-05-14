// Maxicare member portal — diagnostic-only scaffolding.
//
// Target data (per platform owner): card balance & utilization
//   - Available MBL / LOA balance, utilization summary, recent transactions.
//
// NOTE: sites.json loginUrl (https://usqp.maxihealth.com.ph/member) was flagged
// as a placeholder in the v1.3.0 README. Maintainer must confirm the real
// member-portal URL before login_maxicare will succeed. If the URL is wrong,
// this diagnostic will still run, but only against whatever page Playwright
// landed on — the maintainer will see that in the returned landing_url.

const {
  sanitizeUrl,
  collectFrameSummaries,
  collectFrameLinksMatching,
  summarizeForms
} = require("./_diagnose");

// Keywords the maintainer will look for when picking the post-login URL and
// table to extract from. Tuned for HMO portals: balance, utilization,
// availment, dependents, benefits.
const RELEVANT_LINK_RE = /balance|utiliz|availment|loa|mbl|benefit|member|card|dependent|hospital|coverage/i;

async function diagnoseMemberPortal(page) {
  // Do not pre-navigate — inspect whatever the post-login landing page actually
  // is, so the maintainer sees the real entry point (col_financial.js:264-266
  // documents why guessing post-login URLs is wrong).
  await page.waitForTimeout(1000);

  const landingUrl = sanitizeUrl(page.url());
  const frames = await collectFrameSummaries(page);
  const links = await collectFrameLinksMatching(page, RELEVANT_LINK_RE);
  const forms = await summarizeForms(page);

  return {
    site: "maxicare",
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
