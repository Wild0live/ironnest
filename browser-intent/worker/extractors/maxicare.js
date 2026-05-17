// Maxicare member portal — diagnostic-only scaffolding.
//
// Target data (per platform owner): card balance & utilization
//   - Available MBL / LOA balance, utilization summary, recent transactions.
//
// loginUrl is https://membergateway.maxicare.com.ph/login (confirmed against
// Maxicare's public website 2026-05-14). Page is SPA-rendered so the real
// post-login structure can only be inspected by running diagnose_member_portal
// after a successful login.

const {
  sanitizeUrl,
  collectFrameSummaries,
  collectFrameLinksMatching,
  summarizeForms,
  summarizeDashboard
} = require("./_diagnose");

// Keywords the maintainer will look for when picking the post-login URL and
// table to extract from. Tuned for HMO portals: balance, utilization,
// availment, dependents, benefits.
const RELEVANT_LINK_RE = /balance|utiliz|availment|loa|mbl|benefit|member|card|dependent|hospital|coverage|claim|reimburs/i;

// Wait until the SPA actually renders content into <main>. networkidle alone
// fires too early on Maxicare's React app; the HTML shell loads in <100ms but
// the real route content takes 1-3s more. Bail after a generous timeout so a
// genuinely empty route (e.g. one that redirects back to login) still returns.
async function waitForMainContent(page) {
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
  await waitForMainContent(page);
  // Raw counts for debugging — when summarizeDashboard returns empty, the
  // raw counts tell us whether the page is truly blank (counts also 0) or
  // just shaped differently than our queries expect.
  const probe = await page
    .evaluate(() => {
      const truncate = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
      const allButtons = Array.from(document.querySelectorAll("button, a, [role=button], [role=link]"))
        .slice(0, 30)
        .map((b) => ({
          tag: b.tagName.toLowerCase(),
          text: truncate(b.textContent, 60),
          visible: !!b.offsetParent
        }))
        .filter((b) => b.text);
      return {
        counts: {
          button: document.querySelectorAll("button").length,
          a: document.querySelectorAll("a").length,
          role_button: document.querySelectorAll("[role=button]").length,
          input: document.querySelectorAll("input").length,
          main_text_len: ((document.querySelector("main, [role=main]") || document.body)?.innerText || "").length,
          body_text_len: (document.body?.innerText || "").length
        },
        sample_clickables: allButtons
      };
    })
    .catch(() => ({ counts: {}, sample_clickables: [] }));

  return {
    url: sanitizeUrl(page.url()),
    frames: await collectFrameSummaries(page),
    link_candidates: await collectFrameLinksMatching(page, RELEVANT_LINK_RE),
    forms: await summarizeForms(page),
    dashboard: await summarizeDashboard(page),
    probe
  };
}

// Navigate by finding any clickable element with exactly the given text.
// Maxicare renders top-nav as plain elements (no <nav>) so the older
// `nav button:has-text(...)` patterns missed them. Returns the strategy that
// worked so we can tell whether client-side routing or full-page goto won.
async function navigateTo(page, label, path) {
  // getByText with exact match avoids hitting card titles that happen to
  // contain the label as a substring (e.g. "Policies" inside "View all my policies").
  const byText = page.getByText(label, { exact: true }).first();
  if (
    (await byText.count().catch(() => 0)) > 0 &&
    (await byText.isVisible().catch(() => false))
  ) {
    await Promise.allSettled([
      page.waitForURL(new RegExp(path.replace(/\//g, "\\/")), { timeout: 10000 }),
      byText.click({ timeout: 5000 })
    ]);
    return "click";
  }
  const targetUrl = `https://membergateway.maxicare.com.ph${path}`;
  const ok = await page
    .goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  return ok ? "goto" : "failed";
}

// Click an element matching `text` (case-insensitive, contains) inside the
// current page. Returns true on success. Used to drill into policy cards
// (e.g. "platinumharddy d. eco") on /policy and /transaction-history.
async function clickByContainsText(page, text) {
  const loc = page
    .locator(`button, [role=button], a, div[class*="card" i]`)
    .filter({ hasText: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") })
    .first();
  if (
    (await loc.count().catch(() => 0)) > 0 &&
    (await loc.isVisible().catch(() => false))
  ) {
    await loc.click({ timeout: 5000 }).catch(() => {});
    return true;
  }
  return false;
}

async function diagnoseMemberPortal(page) {
  // Routes are <label> → <actual URL> because Maxicare's nav labels don't
  // match the routes the buttons actually navigate to. Discovered 2026-05-14.
  const routes = [
    { label: "Home", urlMatch: "/home" },
    { label: "Policies", urlMatch: "/policy" },
    { label: "Book", urlMatch: "/book-service" },
    { label: "History", urlMatch: "/transaction-history" },
    { label: "Account", urlMatch: "/my-account" }
  ];
  const pages = [];
  // Start from /home for consistency across runs — the session may be left
  // on any sub-page from a prior call.
  await navigateTo(page, "Home", "/home");
  pages.push({ requested_path: "/home", via: "click_or_goto", ...(await dumpCurrentPage(page)) });

  for (const route of routes.slice(1)) {
    // Navigate from /home each time so a failed drill-down in the previous
    // route doesn't leak into the next.
    await navigateTo(page, "Home", "/home");
    await navigateTo(page, route.label, route.urlMatch);
    pages.push({ requested_path: route.urlMatch, label: route.label, ...(await dumpCurrentPage(page)) });
  }

  // Drill-down: click the first policy card on /policy and /transaction-history
  // to reveal balance/utilization and transaction list details. Card label
  // observed 2026-05-14 was "platinumharddy d. eco" — match a generic
  // "platinum" hint so this still works for users with different plans (gold,
  // silver, etc.) by changing the hint.
  const drills = [
    { label: "Policies", urlMatch: "/policy", cardHint: "more" },
    { label: "Policies", urlMatch: "/policy", cardHint: "Add Maxicare Card" },
    { label: "History", urlMatch: "/transaction-history", cardHint: "Platinum Harddy D. Eco" }
  ];
  for (const drill of drills) {
    await navigateTo(page, "Home", "/home");
    await navigateTo(page, drill.label, drill.urlMatch);
    const urlBefore = page.url();
    const clicked = await clickByContainsText(page, drill.cardHint);
    await page.waitForTimeout(2500);
    await waitForMainContent(page);
    pages.push({
      requested_path: `${drill.urlMatch} → click("${drill.cardHint}")`,
      clicked,
      url_before: sanitizeUrl(urlBefore),
      ...(await dumpCurrentPage(page))
    });
  }

  return {
    site: "maxicare",
    status: "ok",
    diagnostic: true,
    pages,
    returned_sensitive_data: false
  };
}

// Helpers shared by the get_* extractors.
async function gotoSection(page, label, urlMatch) {
  // Always start from /home for consistency — the session may be left on
  // any sub-page from a prior call. Click-by-text is the working pattern
  // (page.goto leaves the SPA unrendered for these routes).
  if (!page.url().endsWith("/home")) {
    await navigateTo(page, "Home", "/home");
    await waitForMainContent(page);
  }
  await navigateTo(page, label, urlMatch);
  await waitForMainContent(page);
}

// Lists active and inactive policies. Includes a `card_added` flag derived
// from whether the policy card shows the "Add Maxicare Card" CTA — without
// the physical card linked, the portal won't reveal balance/MBL/dependents
// details, so the flag tells the caller whether deeper extractors will work.
async function getPolicySummary(page) {
  await gotoSection(page, "Policies", "/policy");

  async function readVisibleTab() {
    return await page
      .evaluate(() => {
        const truncate = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
        const main = document.querySelector("main, [role=main]") || document.body;
        const text = (main.innerText || "").trim();
        // The "Add Maxicare Card" CTA appears when no physical card is linked.
        const cardAdded = !/Add\s+Maxicare\s+Card/i.test(text);
        // Policy names are the visible buttons in main that aren't tabs or
        // the CTA. Tabs are "Active" / "Inactive".
        // Maxicare renders the top nav (Home/Policies/Book/History/Account)
        // as <button> elements inside <main>, so we have to exclude them
        // along with the tab labels and the CTA. Dedupe at the end since
        // each label appears twice (top bar + hidden mobile drawer).
        const NAV_TABS = /^(Home|Policies|Book|History|Account|Active|Inactive|more|Add\s+Maxicare\s+Card)$/i;
        const policyNames = Array.from(
          new Set(
            Array.from(main.querySelectorAll("button"))
              .map((b) => truncate(b.textContent, 80))
              .filter((t) => t && !NAV_TABS.test(t))
          )
        );
        return { policy_names: policyNames, card_added: cardAdded };
      })
      .catch(() => ({ policy_names: [], card_added: false }));
  }

  const active = await readVisibleTab();
  // Click "Inactive" tab to read those too.
  const inactiveTab = page.getByText("Inactive", { exact: true }).first();
  let inactive = { policy_names: [], card_added: false };
  if (await inactiveTab.count().catch(() => 0)) {
    await inactiveTab.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    inactive = await readVisibleTab();
  }

  return {
    site: "maxicare",
    status: "ok",
    active_policies: active.policy_names,
    inactive_policies: inactive.policy_names,
    card_added: active.card_added,
    notes: active.card_added
      ? null
      : "no_maxicare_card_linked: portal hides MBL/LOA balance, dependents, and coverage details until the physical card is added in the member-gateway UI",
    returned_sensitive_data: true
  };
}

// Reads personal info from /my-account: name, member-since, birthday, mobile,
// email, notification preferences. The portal's <main> region is essentially
// labeled key/value pairs separated by whitespace; we parse against the
// observed structure rather than scraping innerText so a label-text shuffle
// doesn't yield wrong values.
async function getAccountInfo(page) {
  await gotoSection(page, "Account", "/my-account");

  const data = await page
    .evaluate(() => {
      const truncate = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
      const main = document.querySelector("main, [role=main]") || document.body;
      const text = (main.innerText || "").replace(/\s+/g, " ").trim();
      // Anchors derived from the labels visible in diagnostics output:
      //   "Member since <date> Personal Information Name <name> Birthday <date>
      //    Account Information Mobile number <num> Edit Email Address <email>
      //    Edit Notifications SMS Notification Email Notification Sign out"
      const pick = (re) => {
        const m = text.match(re);
        return m ? truncate(m[1], 80) : null;
      };
      const memberSince = pick(/Member since\s+([^]+?)\s+Personal Information/i);
      const name = pick(/Personal Information\s+Name\s+([^]+?)\s+Birthday/i);
      const birthday = pick(/Birthday\s+([^]+?)\s+Account Information/i);
      const mobile = pick(/Mobile number\s+(\+?\d[\d\s]+?)\s+Edit/);
      const email = pick(/Email Address\s+(\S+@\S+)\s+Edit/);
      // Notification toggles: read by checking aria-pressed / checked on
      // the toggle inputs/buttons near the labels. Best-effort.
      const notifs = Array.from(main.querySelectorAll('button[role="switch"], input[type="checkbox"]'))
        .map((el) => ({
          label: truncate(
            el.closest("label")?.textContent ||
              el.parentElement?.parentElement?.textContent ||
              "",
            40
          ),
          enabled:
            el.getAttribute("aria-checked") === "true" ||
            el.getAttribute("aria-pressed") === "true" ||
            el.checked === true
        }))
        .slice(0, 5);
      return { memberSince, name, birthday, mobile, email, notifs };
    })
    .catch(() => ({}));

  return {
    site: "maxicare",
    status: "ok",
    name: data.name || null,
    member_since: data.memberSince || null,
    birthday: data.birthday || null,
    mobile_number: data.mobile || null,
    email_address: data.email || null,
    notification_preferences: data.notifs || [],
    returned_sensitive_data: true
  };
}

module.exports = { diagnoseMemberPortal, getPolicySummary, getAccountInfo };
