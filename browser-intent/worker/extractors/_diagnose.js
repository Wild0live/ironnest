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
        header_cells: headerCells.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean)
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

module.exports = {
  sanitizeUrl,
  redactHref,
  summarizeFrame,
  collectFrameSummaries,
  collectFrameLinksMatching,
  summarizeForms
};
