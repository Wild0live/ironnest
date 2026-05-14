// Hi-Precision patient portal — diagnostic-only scaffolding.
//
// Target data (per platform owner): lab results
//   - Recent test results, dates, reference ranges, released/pending status.
//
// Patient portals often paginate results and gate access behind a date filter.
// The form summary surfaces that filter so the maintainer knows whether the
// future get_lab_results function needs a date-range parameter or can rely on
// "latest released" defaults.

const {
  sanitizeUrl,
  collectFrameSummaries,
  collectFrameLinksMatching,
  summarizeForms
} = require("./_diagnose");

const RELEVANT_LINK_RE = /result|report|test|lab|appointment|patient|history|branch|exam|order/i;

async function diagnoseMemberPortal(page) {
  await page.waitForTimeout(1000);

  const landingUrl = sanitizeUrl(page.url());
  const frames = await collectFrameSummaries(page);
  const links = await collectFrameLinksMatching(page, RELEVANT_LINK_RE);
  const forms = await summarizeForms(page);

  return {
    site: "hi_precision",
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
