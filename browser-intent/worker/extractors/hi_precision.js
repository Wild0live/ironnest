// Hi-Precision patient portal extractors.
//
// Post-login lands on results.healthonlineasia.com/dashboard.do which renders
// a flat results table. Header schema (observed 2026-05-16 via
// diagnose_member_portal):
//   Lab No. | Branch | Order Date | Patient ID | Patient Name |
//   Account | Gender | Age | Type | Download
//
// The Download column is an anchor pointing at a session-cookie-protected
// PDF on the same host. We fetch each PDF through the Playwright request
// context (which shares the browser's cookies and TLS profile) and write it
// to a worker-local volume; the response replaces `download_url` with
// `download_path` so a cookie-gated URL never reaches the LLM (prevents a
// prompt-injection exfil — the model can otherwise be coerced into
// rendering the URL, which any reader with the session cookies could open).
//
// The dashboard also embeds an optional 2FA-setup form and a feedback widget
// with table-like markup. The header-matching guard rejects rows missing any
// expected column, which keeps those off-target.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  sanitizeUrl,
  collectFrameSummaries,
  collectFrameLinksMatching,
  summarizeForms
} = require("./_diagnose");

const SITE_ID = "hi_precision";
// Worker container path; mounted by docker-compose to a host bind so the user
// (or a sibling container) can pick up the PDF without re-fetching it through
// a session-credentialed URL. Note: /results is a separate top-level mount,
// NOT a child of /uploads — Docker can't create a writable bind-mount target
// inside the worker's read-only /uploads tree.
const RESULTS_OUTPUT_DIR = process.env.BROWSER_INTENT_RESULTS_DIR || "/results";
// Cap one PDF at 20 MB. Real lab PDFs are 50 KB - 2 MB; anything beyond this
// is either an upstream change or a disk-fill attempt. We still emit the row
// (with download_status="too_large") so the user sees the result existed.
const MAX_PDF_BYTES = Number(process.env.BROWSER_INTENT_RESULT_MAX_BYTES || 20 * 1024 * 1024);
// Auto-prune files older than this on every call. Keeps the host volume from
// growing unbounded across rotations; a user who wanted to keep a result
// should have downloaded it from the worker volume by now.
const RESULT_TTL_MS = Number(process.env.BROWSER_INTENT_RESULT_TTL_HOURS || 24) * 60 * 60 * 1000;

const RELEVANT_LINK_RE = /result|report|test|lab|appointment|patient|history|branch|exam|order/i;

const RESULTS_HEADER_MATCHERS = {
  labNumber: ["lab no", "lab number"],
  branch: ["branch"],
  orderDate: ["order date"],
  patientId: ["patient id"],
  patientName: ["patient name"],
  account: ["account"],
  gender: ["gender"],
  age: ["age"],
  type: ["type"],
  download: ["download"]
};

const DASHBOARD_PATH = "/dashboard.do";

function normalize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Pure helper exposed for unit tests. Same defense col_financial uses: real
// headers are short labels, every field must land on a distinct column.
function matchHeaderColumn(headerCells, matchers = RESULTS_HEADER_MATCHERS) {
  const normalized = headerCells.map(normalize);
  const out = {};
  for (const [field, candidates] of Object.entries(matchers)) {
    const idx = normalized.findIndex(
      (h) => h.length > 0 && h.length <= 40 && candidates.some((c) => h.includes(c))
    );
    if (idx === -1) return null;
    out[field] = idx;
  }
  const indices = Object.values(out);
  if (new Set(indices).size !== indices.length) return null;
  return out;
}

async function tryNavigate(page) {
  // Post-login the page is already on results.healthonlineasia.com/dashboard.do
  // (per policies/sites.json loggedInUrlPatterns). If something navigated us
  // elsewhere, pull back. Host derived from the current page so a future
  // subdomain shift doesn't break the extractor.
  if (page.url().includes(DASHBOARD_PATH)) return;
  let base;
  try {
    const cur = new URL(page.url());
    base = `${cur.protocol}//${cur.host}`;
  } catch {
    base = "https://results.healthonlineasia.com";
  }
  try {
    const response = await page.goto(`${base}${DASHBOARD_PATH}`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1000);
    if (response && response.status() >= 400) {
      const err = new Error(`hi_precision dashboard navigation returned HTTP ${response.status()}`);
      err.code = "needs_extractor_update";
      throw err;
    }
  } catch (e) {
    if (e.code === "needs_extractor_update") throw e;
    // Soft-fail; the table-not-found path below emits the same outcome.
  }
}

async function findAndExtractResults(page, headerMatchers) {
  return await page.evaluate(({ matchers }) => {
    function norm(s) {
      return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    }
    function directRows(table) {
      const out = [];
      for (const c of table.children) {
        if (c.tagName === "TR") out.push(c);
        else if (c.tagName === "TBODY" || c.tagName === "THEAD" || c.tagName === "TFOOT") {
          for (const r of c.children) if (r.tagName === "TR") out.push(r);
        }
      }
      return out;
    }
    function directCells(row) {
      const cells = [];
      for (const c of row.children) {
        if (c.tagName === "TD" || c.tagName === "TH") cells.push(c);
      }
      return cells;
    }
    function cellText(cell) {
      return (cell.innerText || "").replace(/\s+/g, " ").trim();
    }
    function downloadHref(cell) {
      if (!cell) return null;
      const a = cell.querySelector("a[href]");
      if (!a) return null;
      // a.href resolves relative URLs against the document base.
      return a.href || null;
    }
    function matchHeader(textCells) {
      const normalized = textCells.map(norm);
      const out = {};
      for (const [field, candidates] of Object.entries(matchers)) {
        const idx = normalized.findIndex(
          (h) => h.length > 0 && h.length <= 40 && candidates.some((c) => h.includes(c))
        );
        if (idx === -1) return null;
        out[field] = idx;
      }
      const indices = Object.values(out);
      if (new Set(indices).size !== indices.length) return null;
      return out;
    }

    const tables = document.querySelectorAll("table");
    for (const table of tables) {
      const rows = directRows(table);
      for (let i = 0; i < rows.length; i++) {
        const headerTextCells = directCells(rows[i]).map(cellText);
        if (headerTextCells.length < Object.keys(matchers).length) continue;
        const cols = matchHeader(headerTextCells);
        if (!cols) continue;

        const results = [];
        for (let j = i + 1; j < rows.length; j++) {
          const cells = directCells(rows[j]);
          if (!cells.length) continue;
          const texts = cells.map(cellText);
          const labText = texts[cols.labNumber] || "";
          // Skip blank rows / totals / filter-row remnants.
          if (!labText || /^total/i.test(labText)) continue;
          results.push({
            lab_number: labText,
            branch: texts[cols.branch] || "",
            order_date: texts[cols.orderDate] || "",
            patient_id: texts[cols.patientId] || "",
            patient_name: texts[cols.patientName] || "",
            account: texts[cols.account] || "",
            gender: texts[cols.gender] || "",
            age: texts[cols.age] || "",
            type: texts[cols.type] || "",
            download_url: downloadHref(cells[cols.download])
          });
        }
        return results;
      }
    }
    return null;
  }, { matchers: headerMatchers });
}

// Convert a lab number / arbitrary string into a safe filename component.
// Drops everything outside [A-Za-z0-9._-], collapses dashes, length-caps so
// a hostile upstream value can't traverse or smuggle a path separator.
function safeFilenameComponent(s) {
  const cleaned = String(s || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80);
}

function siteResultsDir() {
  return path.join(RESULTS_OUTPUT_DIR, SITE_ID);
}

// Best-effort prune. Failures here are non-fatal — we still want the call to
// succeed even if the volume is wedged in some weird state.
function pruneStaleResults(dir, ttlMs, now = Date.now()) {
  let removed = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > ttlMs) {
          fs.unlinkSync(filePath);
          removed += 1;
        }
      } catch {
        // race with another prune / mounted-volume hiccup; skip this entry
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      process.stderr.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        component: "browser-intent-worker",
        level: "warn",
        msg: "hi_precision result prune failed",
        dir,
        error: err.message
      })}\n`);
    }
  }
  return removed;
}

// Download one cookie-gated PDF through the Playwright request context
// (shares cookies + TLS profile with the active browser session). Writes to
// destPath atomically (write to .tmp then rename) so a partial file never
// surfaces as a download_path.
async function downloadResultPdf(page, url, destPath, maxBytes) {
  const ctx = page.context();
  let response;
  try {
    response = await ctx.request.get(url, { timeout: 30000 });
  } catch (err) {
    const e = new Error(`download network error: ${err.message}`);
    e.code = "download_failed";
    throw e;
  }
  if (!response.ok()) {
    const e = new Error(`download upstream returned HTTP ${response.status()}`);
    e.code = "download_failed";
    throw e;
  }
  // Read body fully before writing — Playwright doesn't expose a streaming
  // body API on the request context, and we need the size for the cap check
  // anyway. 20 MB is well within node's default heap.
  const body = await response.body();
  if (body.length > maxBytes) {
    const e = new Error(`download exceeds cap (${body.length} > ${maxBytes})`);
    e.code = "too_large";
    throw e;
  }
  const contentType = response.headers()["content-type"] || "application/octet-stream";
  const tmpPath = `${destPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmpPath, body);
  await fs.promises.rename(tmpPath, destPath);
  return { bytes: body.length, contentType };
}

async function getResults(page) {
  await tryNavigate(page);

  const rawResults = await findAndExtractResults(page, RESULTS_HEADER_MATCHERS).catch(() => null);
  if (rawResults === null) {
    const error = new Error("hi_precision results table not found");
    error.code = "needs_extractor_update";
    throw error;
  }

  const outDir = siteResultsDir();
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    // ENOENT here means the parent volume isn't mounted — that's a config
    // problem we want to surface, not silently swallow.
    if (err.code !== "EEXIST") {
      const e = new Error(`results output dir not writable: ${err.message}`);
      e.code = "needs_extractor_update";
      throw e;
    }
  }
  pruneStaleResults(outDir, RESULT_TTL_MS);

  const sanitized = [];
  for (const row of rawResults) {
    const { download_url: downloadUrl, ...rest } = row;
    const out = { ...rest };
    if (!downloadUrl) {
      out.download_status = "no_url";
      sanitized.push(out);
      continue;
    }
    const base = safeFilenameComponent(row.lab_number) || crypto.randomBytes(8).toString("hex");
    const destPath = path.join(outDir, `${base}.pdf`);
    try {
      const { bytes, contentType } = await downloadResultPdf(page, downloadUrl, destPath, MAX_PDF_BYTES);
      out.download_path = destPath;
      out.download_bytes = bytes;
      out.download_content_type = contentType;
      out.download_status = "ok";
    } catch (err) {
      out.download_status = err.code || "download_failed";
      // Deliberately do NOT include err.message verbatim — Playwright errors
      // often carry the cookie-gated URL, and the whole point of this
      // sanitization is to keep that URL out of the LLM-visible payload.
    }
    sanitized.push(out);
  }

  return {
    site: SITE_ID,
    status: "ok",
    as_of: new Date().toISOString(),
    count: sanitized.length,
    results: sanitized,
    returned_sensitive_data: true
  };
}

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

module.exports = {
  getResults,
  diagnoseMemberPortal,
  // Test-only:
  matchHeaderColumn,
  normalize,
  safeFilenameComponent,
  pruneStaleResults,
  siteResultsDir,
  RESULTS_HEADER_MATCHERS
};
