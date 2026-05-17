// Shared diagnostic primitives for site extractors.
//
// Each new site goes through one bootstrapping round: log in, run the site's
// diagnose_* tool, paste the sanitized output to a maintainer, and they author
// the real extractor against the structure that actually came back. These
// helpers exist so that round produces consistent output across sites without
// duplicating the URL/frame/table/link-scan code in every extractor file.
//
// Safety invariants (preserved by every helper here):
// - URLs are stripped to origin + pathname; query strings and fragments never
//   leave the function. PII in URLs is the most common foot-gun.
// - Table CELL data is never returned — only header text. Confirming the
//   shape of a holdings/claims/results table doesn't require the row contents.
// - Link href + text are returned only when they match a keyword filter the
//   caller supplies; an unfiltered link dump would round-trip session IDs.
// - The top-level diagnostic result MUST set returned_sensitive_data: false.

// Redact common PII patterns from text returned in diagnostic output. Used
// for table header cells: most content is structural ("Symbol", "Quantity"),
// but a portal that uses tables for layout may render PII like
// "Welcome, John Doe (Member #00123-45)" inside what shape-detects as a
// header row. Strip the highest-signal patterns — digit runs of 4+ (IDs,
// account numbers), formatted numbers (amounts), and email addresses.
// Letter sequences are preserved because column-name signal is the whole
// point of the diagnostic.
function redactCellText(text) {
  if (!text) return "";
  return String(text)
    .replace(/\b[\w._%+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[EMAIL]")
    .replace(/\d+(?:[,.]\d+)+/g, "[NUM]")
    .replace(/\d{4,}/g, "[NUM]");
}

function sanitizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

// Redact an anchor href for diagnostic output. Many portal hrefs carry session
// IDs or member identifiers in query strings (?sid=abc&memberId=123) — those
// must not round-trip from the worker to a maintainer's chat or paste buffer.
// Strategy: resolve against the frame URL so relative links become absolute,
// then return origin + pathname + redacted query (keys preserved, values
// stripped). Keys are kept because they reveal the endpoint's API shape, which
// is what the maintainer needs to author the real extractor; values are not.
function redactHref(href, baseUrl) {
  if (!href) return "";
  if (href.startsWith("javascript:")) return "javascript:";
  if (href.startsWith("#")) return "";
  try {
    const u = new URL(href, baseUrl || undefined);
    if (u.protocol !== "http:" && u.protocol !== "https:") return `${u.protocol}`;
    const keys = [...u.searchParams.keys()];
    const query = keys.length ? `?${keys.map((k) => `${k}=`).join("&")}` : "";
    return `${u.origin}${u.pathname}${query}`;
  } catch {
    return "";
  }
}

async function summarizeFrame(frame) {
  const url = sanitizeUrl(frame.url());
  let title = "";
  try {
    title = await frame.title();
  } catch {
    /* some frames disallow */
  }
  const tables = [];
  try {
    const tableLocators = await frame.locator("table").all();
    for (let i = 0; i < tableLocators.length && i < 30; i++) {
      const headerCells = await tableLocators[i]
        .locator("tr")
        .first()
        .locator("th, td")
        .allInnerTexts()
        .catch(() => []);
      const rowCount = await tableLocators[i].locator("tr").count().catch(() => 0);
      tables.push({
        index: i,
        row_count: rowCount,
        header_cells: headerCells
          .map((s) => redactCellText(s.replace(/\s+/g, " ").trim()))
          .filter(Boolean)
      });
    }
  } catch {
    /* frame may have detached */
  }
  return { url, title, tables };
}

async function collectFrameSummaries(page) {
  const summaries = [];
  for (const frame of page.frames()) {
    const summary = await summarizeFrame(frame).catch(() => null);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

// Walks every frame and returns links whose text OR href matches the keyword
// regex. Filtering runs in-page against the RAW href so a keyword match
// against a query-string value (e.g. ?action=view_claims) still counts.
// Output hrefs are then redacted in Node before being returned — values
// stripped, keys kept. Limits per-frame so a noisy SPA can't blow up the
// response payload.
async function collectFrameLinksMatching(page, keywordRegex) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const frameUrlRaw = frame.url();
      const frameUrlSafe = sanitizeUrl(frameUrlRaw);
      const rawLinks = await frame
        .locator("a[href], area[href], button")
        .evaluateAll(
          (nodes, patternSource) => {
            const re = new RegExp(patternSource, "i");
            return nodes
              .map((el) => ({
                text: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 80),
                href: el.getAttribute("href") || ""
              }))
              .filter((l) => re.test(`${l.text} ${l.href}`))
              .slice(0, 30);
          },
          keywordRegex.source
        );
      const links = rawLinks.map((l) => ({ text: l.text, href: redactHref(l.href, frameUrlRaw) }));
      if (links.length) out.push({ frame_url: frameUrlSafe, links });
    } catch {
      /* frame may have detached */
    }
  }
  return out;
}

// Common form field summary — useful when a portal has a date-range filter or
// account selector that gates the data the maintainer wants. Returns input
// names/types and select option counts, NEVER current values.
async function summarizeForms(page) {
  const forms = [];
  for (const frame of page.frames()) {
    try {
      const formCount = await frame.locator("form").count().catch(() => 0);
      if (!formCount) continue;
      const fields = await frame
        .locator("input, select, textarea")
        .evaluateAll((nodes) =>
          nodes.slice(0, 40).map((n) => ({
            tag: n.tagName.toLowerCase(),
            type: (n.getAttribute("type") || "").toLowerCase(),
            name: n.getAttribute("name") || "",
            id: n.getAttribute("id") || "",
            placeholder: (n.getAttribute("placeholder") || "").slice(0, 40),
            option_count: n.tagName.toLowerCase() === "select" ? n.options.length : undefined
          }))
        );
      forms.push({
        frame_url: sanitizeUrl(frame.url()),
        form_count: formCount,
        fields: fields.filter((f) => f.name || f.id || f.placeholder)
      });
    } catch {
      /* frame may have detached */
    }
  }
  return forms;
}

// Pre-login form summary used by diagnose_login_form. Differs from
// summarizeForms (which is post-login and intentionally minimal) by returning
// the full attribute set a maintainer needs to author site.loginSelectors:
// name/id/type/autocomplete/placeholder/aria-label, associated <label for>
// text, data-testid, visibility, plus button text and form action.
// Field VALUES are never read or returned — only metadata. Form `action`
// attributes are run through redactHref (query values stripped) since some
// portals embed a return-to URL with PII in the form action.
async function summarizeLoginForms(page) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const frameUrlRaw = frame.url();
      let title = "";
      try {
        title = await frame.title();
      } catch {
        /* some frames disallow */
      }
      const summary = await frame
        .evaluate(() => {
          const truncate = (s, n = 80) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
          const labelFor = (n) => {
            if (n.id) {
              try {
                const lbl = document.querySelector(`label[for="${CSS.escape(n.id)}"]`);
                if (lbl) return truncate(lbl.textContent);
              } catch {
                /* invalid id for CSS.escape, ignore */
              }
            }
            const parentLabel = n.closest && n.closest("label");
            if (parentLabel) return truncate(parentLabel.textContent);
            return "";
          };
          const fieldOf = (n) => ({
            tag: n.tagName.toLowerCase(),
            type: (n.getAttribute("type") || "").toLowerCase(),
            name: n.getAttribute("name") || "",
            id: n.getAttribute("id") || "",
            autocomplete: n.getAttribute("autocomplete") || "",
            placeholder: truncate(n.getAttribute("placeholder")),
            aria_label: truncate(n.getAttribute("aria-label")),
            data_testid: n.getAttribute("data-testid") || "",
            label: labelFor(n),
            visible: !!n.offsetParent,
            option_count: n.tagName.toLowerCase() === "select" ? (n.options || []).length : undefined
          });
          const fields = Array.from(document.querySelectorAll("input, select, textarea"))
            .slice(0, 40)
            .map(fieldOf)
            .filter((f) => f.name || f.id || f.placeholder || f.aria_label || f.data_testid || f.label);
          const buttons = Array.from(
            document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")
          )
            .slice(0, 20)
            .map((b) => ({
              tag: b.tagName.toLowerCase(),
              type: (b.getAttribute("type") || "").toLowerCase(),
              id: b.getAttribute("id") || "",
              class_attr: truncate(b.getAttribute("class"), 120),
              data_testid: b.getAttribute("data-testid") || "",
              text: truncate(b.textContent || b.value),
              visible: !!b.offsetParent
            }))
            .filter((b) => b.text || b.id || b.data_testid);
          const forms = Array.from(document.querySelectorAll("form"))
            .slice(0, 10)
            .map((f) => ({
              id: f.getAttribute("id") || "",
              action: f.getAttribute("action") || "",
              method: (f.getAttribute("method") || "get").toLowerCase()
            }));
          // Raw element counts and sign-in link candidates exist for the
          // "what did the page even render?" case — when the page is a
          // landing/marketing page that gates the real login behind a click.
          // Filtered fields/buttons above can come back empty; raw counts
          // never do for a hydrated page.
          const counts = {
            input: document.querySelectorAll("input").length,
            button: document.querySelectorAll("button").length,
            form: document.querySelectorAll("form").length,
            a: document.querySelectorAll("a").length
          };
          // Look for sign-in / login / connexion / connecter (FR for April)
          // link candidates that suggest the form is one click away.
          const signinRe = /\b(sign\s*in|log\s*in|login|connexion|connect|se\s*connecter|s'identifier|patient\s*portal|member\s*portal)\b/i;
          const signinLinks = Array.from(document.querySelectorAll("a, button, [role=button]"))
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              text: truncate(el.textContent || el.value || el.getAttribute("aria-label")),
              href: el.getAttribute("href") || ""
            }))
            .filter((l) => l.text && signinRe.test(l.text))
            .slice(0, 10);
          const body_text_snippet = truncate(document.body ? document.body.innerText : "", 200);
          return { fields, buttons, forms, counts, signin_links: signinLinks, body_text_snippet };
        })
        .catch(() => ({ fields: [], buttons: [], forms: [], counts: { input: 0, button: 0, form: 0, a: 0 }, signin_links: [], body_text_snippet: "" }));

      summary.forms = summary.forms.map((f) => ({ ...f, action: redactHref(f.action, frameUrlRaw) }));
      summary.signin_links = summary.signin_links.map((l) => ({ tag: l.tag, text: l.text, href: redactHref(l.href, frameUrlRaw) }));

      out.push({ frame_url: sanitizeUrl(frameUrlRaw), title, ...summary });
    } catch {
      /* frame may have detached */
    }
  }
  return out;
}

// Post-login SPA dashboard summary. Most modern HMO/insurance portals
// (Maxicare, etc.) render their home as a grid of widgets, not tables —
// `collectFrameSummaries` finds nothing because there are no <table>s, and
// `collectFrameLinksMatching` finds nothing because nav items live inside
// React-rendered divs without keyword-matching href attributes. This helper
// dumps the structural anatomy of a SPA dashboard so a maintainer can
// pick which sub-page or widget to extract from:
// - top-level headings (h1-h4) — usually mark page sections
// - nav-region items — visible text + any href/data-href/data-route
// - aside / sidebar items
// - "card"-class widgets — their innerText, redacted for numbers/emails
// - main region text snippet
// All text is redacted via redactCellText (digit runs → [NUM], emails → [EMAIL])
// so member numbers, balances, etc. don't round-trip to chat.
async function summarizeDashboard(page) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const frameUrlRaw = frame.url();
      const data = await frame
        .evaluate(() => {
          const truncate = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);
          const visible = (el) => !!el.offsetParent;
          const itemOf = (el) => {
            const text = truncate(el.textContent || el.getAttribute("aria-label") || el.value, 80);
            if (!text) return null;
            return {
              tag: el.tagName.toLowerCase(),
              text,
              href:
                el.getAttribute("href") ||
                el.getAttribute("data-href") ||
                el.getAttribute("data-route") ||
                el.getAttribute("data-path") ||
                "",
              visible: visible(el)
            };
          };
          const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4"))
            .slice(0, 30)
            .map((h) => ({
              tag: h.tagName.toLowerCase(),
              text: truncate(h.textContent, 120),
              visible: visible(h)
            }))
            .filter((h) => h.text);
          const navItems = Array.from(
            document.querySelectorAll(
              "nav a, nav button, nav [role=link], aside a, aside button, [role=navigation] a, [role=navigation] button"
            )
          )
            .slice(0, 60)
            .map(itemOf)
            .filter(Boolean);
          // Widgets identified by class hint. Cap per-card text since some
          // cards render long blurbs.
          const widgetSelector = [
            '[class*="card" i]',
            '[class*="widget" i]',
            '[class*="tile" i]',
            '[class*="panel" i]'
          ].join(",");
          const widgets = Array.from(document.querySelectorAll(widgetSelector))
            .slice(0, 30)
            .map((w) => ({
              class_hint: truncate(w.getAttribute("class") || "", 80),
              text: truncate(w.innerText || w.textContent, 200),
              visible: visible(w)
            }))
            .filter((w) => w.text);
          const mainEl = document.querySelector("main, [role=main]") || document.body;
          const main_text = truncate(mainEl ? mainEl.innerText : "", 400);
          return { headings, navItems, widgets, main_text };
        })
        .catch(() => ({ headings: [], navItems: [], widgets: [], main_text: "" }));

      const redactedHeadings = data.headings.map((h) => ({ ...h, text: redactCellText(h.text) }));
      const redactedNav = data.navItems.map((n) => ({
        tag: n.tag,
        text: redactCellText(n.text),
        href: redactHref(n.href, frameUrlRaw),
        visible: n.visible
      }));
      const redactedWidgets = data.widgets.map((w) => ({
        class_hint: w.class_hint,
        text: redactCellText(w.text),
        visible: w.visible
      }));
      const redactedMain = redactCellText(data.main_text);

      if (
        redactedHeadings.length ||
        redactedNav.length ||
        redactedWidgets.length ||
        redactedMain
      ) {
        out.push({
          frame_url: sanitizeUrl(frameUrlRaw),
          headings: redactedHeadings,
          nav_items: redactedNav,
          widgets: redactedWidgets,
          main_text: redactedMain
        });
      }
    } catch {
      /* frame may have detached */
    }
  }
  return out;
}

module.exports = {
  sanitizeUrl,
  redactHref,
  redactCellText,
  summarizeFrame,
  collectFrameSummaries,
  collectFrameLinksMatching,
  summarizeForms,
  summarizeLoginForms,
  summarizeDashboard
};
