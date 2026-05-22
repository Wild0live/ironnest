// Hi-Precision patient portal extractors.
//
// Post-login lands on results.healthonlineasia.com/dashboard.do which renders
// a flat results table. Header schema (observed 2026-05-16 via
// diagnose_member_portal):
//   Lab No. | Branch | Order Date | Patient ID | Patient Name |
//   Account | Gender | Age | Type | Download
//
// The Download column is NOT a plain <a href>; it uses one of three JS-only
// patterns depending on Type (see downloadHref for the dispatch table):
//   - Physical Exam (PE)         : formLink('download-physicalExamResultPDF.do', qs)
//   - Imaging (X-RAY, ULTRASOUND): formLink('download-imagingResultPDF.do', qs)
//   - LAB                         : modalPopupsDownloadLaboratoryPdf(pid, labNo, ...)
//                                   which opens a UI modal, lists test
//                                   codes via XHR, and only then fires the
//                                   actual /nocumresults.do download.
//
// We parse the onclick attribute into a download_spec, resolve it to a real
// URL in resolveDownloadUrl (LAB needs a preliminary POST), then fetch the
// PDF through the Playwright request context (which shares the browser's
// cookies + TLS profile) and write it to a worker-local volume. The
// response replaces `download_spec` with `download_path` so neither the
// cookie-gated URL nor the JS handler shape ever reaches the LLM (prevents
// a prompt-injection exfil — the model can otherwise be coerced into
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
    // Collect raw DOM signals for the download cell. The actual parsing
    // into a download_spec is done Node-side by parseDownloadDescriptor —
    // see the export at the bottom of this file. Keeping the browser-side
    // dumb keeps the parser testable without a browser.
    function downloadHref(cell) {
      if (!cell) return null;
      const a = cell.querySelector("a");
      if (!a) return null;
      return {
        onclick: a.getAttribute("onclick") || "",
        rawHref: a.getAttribute("href") || "",
        resolvedHref: a.href || "" // resolves relative URLs vs document base
      };
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
            download_descriptor: downloadHref(cells[cols.download])
          });
        }
        return results;
      }
    }
    return null;
  }, { matchers: headerMatchers });
}

// Parse the raw download-cell descriptor (onclick text + href attribute)
// into a structured spec the Node side can dispatch on. Pure function so
// it's covered by unit tests without spinning up Chromium.
//
// Dispatch table mirrors what the Hi-Precision dashboard's JS does:
//
//   PE / Imaging  → onclick="formLink('endpoint.do', 'qs'); return false;"
//                   → { kind: "formLink", endpoint, qs }
//
//   LAB           → onclick="modalPopupsDownloadLaboratoryPdf('pid','labNo',
//                            '',false,'status');" (no href attribute)
//                   → { kind: "modalLab", pid, labNo }
//
//   Real URL      → <a href="https://..."> (forward-compat — not currently
//                   on the dashboard but cheap to keep)
//                   → { kind: "direct", url }
//
// Anything else (empty descriptor, javascript:void(0) with no recognized
// onclick, malformed onclick) → null, which surfaces as
// download_status: "no_url" in the user-visible row.
function parseDownloadDescriptor(desc) {
  if (!desc || typeof desc !== "object") return null;
  const onclick = typeof desc.onclick === "string" ? desc.onclick : "";
  const rawHref = typeof desc.rawHref === "string" ? desc.rawHref : "";
  const resolvedHref = typeof desc.resolvedHref === "string" ? desc.resolvedHref : "";

  const formLinkMatch = onclick.match(/formLink\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]/);
  if (formLinkMatch) {
    return { kind: "formLink", endpoint: formLinkMatch[1], qs: formLinkMatch[2] };
  }
  const modalLabMatch = onclick.match(
    /modalPopupsDownloadLaboratoryPdf\s*\(\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]/
  );
  if (modalLabMatch) {
    return { kind: "modalLab", pid: modalLabMatch[1], labNo: modalLabMatch[2] };
  }
  if (rawHref && !rawHref.startsWith("javascript:") && resolvedHref) {
    return { kind: "direct", url: resolvedHref };
  }
  return null;
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

// Run fetch() inside the page so the request uses Chromium's network stack:
// it inherits both the proxy (chromium reads HTTPS_PROXY env; Playwright's
// ctx.request uses Node's HTTP stack and does NOT, so it tries to dial
// upstream IPs directly and gets ENETUNREACH on this Docker network) AND
// the active session cookies for the dashboard origin.
//
// Body is binary-safe: we base64-encode in the page (chunked to dodge the
// String.fromCharCode arg-count limit on multi-MB PDFs) and decode in Node.
// Returns { ok, status, headers, body: Buffer } on success or { ok: false,
// status, statusText, error } on a transport problem.
async function pageFetch(page, url, options = {}) {
  const result = await page.evaluate(async ({ url, method, body, headers }) => {
    try {
      const opts = { method: method || "GET", credentials: "same-origin" };
      if (headers) opts.headers = headers;
      if (body !== undefined && body !== null) opts.body = body;
      const r = await fetch(url, opts);
      const respHeaders = {};
      r.headers.forEach((v, k) => { respHeaders[k] = v; });
      if (!r.ok) {
        return { ok: false, status: r.status, statusText: r.statusText, headers: respHeaders };
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = "";
      const chunk = 0x8000;
      for (let i = 0; i < buf.length; i += chunk) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
      }
      return { ok: true, status: r.status, headers: respHeaders, b64: btoa(bin) };
    } catch (e) {
      return { ok: false, status: 0, error: String(e.message || e) };
    }
  }, { url, method: options.method, body: options.body, headers: options.headers });
  if (result && result.b64) {
    result.body = Buffer.from(result.b64, "base64");
    delete result.b64;
  }
  return result;
}

// Resolve a download_spec into the final cookie-gated URL we should GET.
// For "direct" and "formLink" the URL is constructed from the spec alone.
// For "modalLab" we have to do a preliminary POST through pageFetch to list
// the test codes (see downloadHref's modalLab comment). Throws with
// err.code = "download_failed" on any pre-flight problem.
async function resolveDownloadUrl(page, spec) {
  const base = new URL(page.url());
  const origin = `${base.protocol}//${base.host}`;
  if (spec.kind === "direct") return spec.url;
  if (spec.kind === "formLink") return `${origin}/${spec.endpoint}?${spec.qs}`;
  if (spec.kind === "modalLab") {
    // Step 1: list the test-group results so we know which testCodes to
    // include. The endpoint returns a JSON array whose entries describe
    // both the group headers (testCodes: undefined) and the actual test
    // rows (testCodes: "FBS", "CBCPLT", ...). We keep only the rows that
    // carry a real testCodes value, then dedup.
    const formBody = new URLSearchParams({
      pid: spec.pid,
      link_pid: "",
      printIdx: spec.labNo,
      labNoIdx: spec.labNo
    }).toString();
    const resp = await pageFetch(page, `${origin}/cumresultsfront-generateTestGroupResultForDownloadLabPdf.do`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: formBody
    });
    if (!resp.ok) {
      const detail = resp.error || `HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""}`;
      const e = new Error(`lab testCodes lookup failed: ${detail}`);
      e.code = "download_failed";
      throw e;
    }
    let json;
    try {
      json = JSON.parse(resp.body.toString("utf8"));
    } catch (err) {
      const e = new Error(`lab testCodes response not JSON: ${err.message}`);
      e.code = "download_failed";
      throw e;
    }
    const codes = Array.from(
      new Set(
        (json.testGroupResults || [])
          .map((g) => g && g.testCodes)
          .filter((c) => typeof c === "string" && c.length > 0)
      )
    );
    if (codes.length === 0) {
      const e = new Error("lab testCodes list was empty — result may be unreleased or upstream changed shape");
      e.code = "download_failed";
      throw e;
    }
    // Step 2: build the final URL. lpt=P means "no cumulative" — the
    // dashboard's "Yes please" path uses singleWithCumulativePdf.do with
    // lpt=PWC, which we don't expose. P is the simpler/faster shape and
    // matches what a user would pick for a one-off result download.
    const qs = new URLSearchParams();
    qs.append("pid", spec.pid);
    qs.append("printIdx", spec.labNo);
    qs.append("e", "");
    for (const c of codes) qs.append("testCodesFilter", c);
    qs.append("lpt", "P");
    qs.append("link_pid", "");
    return `${origin}/nocumresults.do?${qs.toString()}`;
  }
  const e = new Error(`unknown download_spec kind: ${spec && spec.kind}`);
  e.code = "download_failed";
  throw e;
}

// Download one cookie-gated PDF through Chromium's network stack (via
// pageFetch — see why ctx.request is unsuitable). Writes to destPath
// atomically (write to .tmp then rename) so a partial file never surfaces
// as a download_path. Accepts a download_spec (see downloadHref) rather
// than a raw URL because the LAB flow needs a preliminary POST.
async function downloadResultPdf(page, spec, destPath, maxBytes) {
  const url = await resolveDownloadUrl(page, spec);
  const resp = await pageFetch(page, url, { method: "GET" });
  if (!resp.ok) {
    const detail = resp.error || `HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ""}`;
    const e = new Error(`download failed: ${detail}`);
    e.code = "download_failed";
    throw e;
  }
  // Defense in depth: if upstream returned HTML (e.g. a session-expired
  // redirect that resolved to a login page with status 200), don't pass it
  // off as a PDF. The browser would never have rendered this as a download.
  const contentType = (resp.headers && resp.headers["content-type"]) || "application/octet-stream";
  if (/text\/html/i.test(contentType)) {
    const e = new Error(`download returned HTML instead of PDF (content-type=${contentType})`);
    e.code = "download_failed";
    throw e;
  }
  const body = resp.body;
  if (body.length > maxBytes) {
    const e = new Error(`download exceeds cap (${body.length} > ${maxBytes})`);
    e.code = "too_large";
    throw e;
  }
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
    const { download_descriptor: descriptor, ...rest } = row;
    const out = { ...rest };
    const spec = parseDownloadDescriptor(descriptor);
    if (!spec) {
      out.download_status = "no_url";
      sanitized.push(out);
      continue;
    }
    // Distinguish row types in the filename so re-runs against the same
    // lab number (which carries up to three rows: PE, LAB, X-RAY for an
    // APE package) don't overwrite each other on disk.
    const typeSuffix = safeFilenameComponent(row.type) || "result";
    const labBase = safeFilenameComponent(row.lab_number) || crypto.randomBytes(8).toString("hex");
    const destPath = path.join(outDir, `${labBase}-${typeSuffix}.pdf`);
    try {
      const { bytes, contentType } = await downloadResultPdf(page, spec, destPath, MAX_PDF_BYTES);
      out.download_path = destPath;
      out.download_bytes = bytes;
      out.download_content_type = contentType;
      out.download_status = "ok";
    } catch (err) {
      out.download_status = err.code || "download_failed";
      // Deliberately do NOT include err.message verbatim — Playwright errors
      // and our own resolveDownloadUrl messages often carry the cookie-gated
      // URL, and the whole point of this sanitization is to keep that URL
      // out of the LLM-visible payload. Operator can find the redacted
      // version in worker stderr if we ever wire it through audit().
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
  parseDownloadDescriptor,
  safeFilenameComponent,
  pruneStaleResults,
  siteResultsDir,
  RESULTS_HEADER_MATCHERS
};
