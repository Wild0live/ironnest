const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const col = require("../extractors/col_financial");
const diag = require("../extractors/_diagnose");
const hiPrecision = require("../extractors/hi_precision");

test("parseNumber: parses currency-formatted values", () => {
  assert.equal(col.parseNumber("1,234.56"), 1234.56);
  assert.equal(col.parseNumber("PHP 42.00"), 42);
  assert.equal(col.parseNumber("-3.14"), -3.14);
});

test("parseNumber: returns null on missing or junk input", () => {
  assert.equal(col.parseNumber(null), null);
  assert.equal(col.parseNumber(undefined), null);
  assert.equal(col.parseNumber(""), null);
  assert.equal(col.parseNumber("-"), null);
  assert.equal(col.parseNumber("."), null);
  assert.equal(col.parseNumber("not-a-number"), null);
});

test("matchHeaderColumn: maps headers to expected fields", () => {
  const cols = col.matchHeaderColumn(["Stock Code", "Total Shares", "Average Price", "Market Price", "Market Value"]);
  assert.deepEqual(cols, { symbol: 0, quantity: 1, averageCost: 2, lastPrice: 3, marketValue: 4 });
});

test("matchHeaderColumn: ignores near-duplicate columns (Stock Name, Uncommitted Shares, Cash Balance)", () => {
  // Real As_CashBalStockPos header row — must land on the *correct* columns,
  // not the adjacent siblings. Cash Balance is in a different table earlier
  // in the page so it isn't tested here, but Stock Name and Uncommitted
  // Shares share a row with the targets and used to collide.
  const headers = ["Action", "Stock Code", "Stock Name", "Portfolio %", "Market Price", "Average Price", "Total Shares", "Uncommitted Shares", "Market Value", "Gain / Loss", "%Gain/ Loss"];
  const cols = col.matchHeaderColumn(headers);
  assert.deepEqual(cols, { symbol: 1, quantity: 6, averageCost: 5, lastPrice: 4, marketValue: 8 });
});

test("matchHeaderColumn: rejects a wrapper row where one cell contains every keyword", () => {
  // Pathological case: an outer table whose first <tr> is a single giant cell
  // containing the flattened text of every nested table. Every field-matcher
  // would find its keyword in that one cell — must reject, not collapse.
  const concatenated = "Cash Balance Actual Balance Stock Code Stock Name Total Shares Average Price Market Price Market Value Gain Loss";
  assert.equal(col.matchHeaderColumn([concatenated]), null);
});

test("matchHeaderColumn: returns null when a required column is missing", () => {
  // No "average price" column variant.
  assert.equal(col.matchHeaderColumn(["Symbol", "Qty", "Last", "Value"]), null);
});

test("normalize: lowercases and collapses whitespace", () => {
  assert.equal(col.normalize("  Hello  WORLD\n"), "hello world");
  assert.equal(col.normalize(""), "");
  assert.equal(col.normalize(null), "");
});

test("round: rounds to N digits (Math.round semantics — IEEE 754 quirks apply)", () => {
  assert.equal(col.round(2.0, 2), 2);
  assert.equal(col.round(1.234567, 4), 1.2346);
  assert.equal(col.round(1.5, 0), 2);
  assert.equal(col.round(-1.234567, 4), -1.2346);
});

test("sanitizeUrl: strips query and fragment", () => {
  assert.equal(diag.sanitizeUrl("https://x.com/path?session=abc#frag"), "https://x.com/path");
  assert.equal(diag.sanitizeUrl("not a url"), "");
});

test("redactHref: keeps query keys, strips values", () => {
  const out = diag.redactHref("/foo?sid=abc&memberId=123", "https://x.com/page");
  assert.equal(out, "https://x.com/foo?sid=&memberId=");
});

test("redactHref: rejects javascript: and fragment-only hrefs", () => {
  assert.equal(diag.redactHref("javascript:alert(1)", "https://x.com/"), "javascript:");
  assert.equal(diag.redactHref("#section", "https://x.com/"), "");
});

test("redactHref: returns scheme for non-http(s) protocols", () => {
  assert.equal(diag.redactHref("mailto:a@b.com", "https://x.com/"), "mailto:");
});

test("hi_precision matchHeaderColumn: maps the dashboard headers", () => {
  const cols = hiPrecision.matchHeaderColumn([
    "Lab No.", "Branch", "Order Date", "Patient ID", "Patient Name",
    "Account", "Gender", "Age", "Type", "Download"
  ]);
  assert.deepEqual(cols, {
    labNumber: 0, branch: 1, orderDate: 2, patientId: 3, patientName: 4,
    account: 5, gender: 6, age: 7, type: 8, download: 9
  });
});

test("hi_precision matchHeaderColumn: returns null when 'Download' column missing", () => {
  // Defends the URL-sanitization contract: if the upstream removed the
  // Download column, the extractor must bail out (needs_extractor_update)
  // rather than guess a column index and serve random cell text as a path.
  assert.equal(
    hiPrecision.matchHeaderColumn([
      "Lab No.", "Branch", "Order Date", "Patient ID", "Patient Name",
      "Account", "Gender", "Age", "Type"
    ]),
    null
  );
});

test("hi_precision safeFilenameComponent: rejects every path-separator class", () => {
  // Lab numbers come from upstream — must be sanitized before they become a
  // filename. The previous design surfaced the URL straight to the LLM;
  // this one writes to disk, so the security property is: no '/' or '\'
  // and nothing path.join would interpret as a separate path component.
  // Dots ARE allowed (real lab numbers can include them), but a string of
  // only-dots-and-slashes collapses to something like '..-..' which is a
  // literal filename, not a parent-dir reference, so path.join stays put.
  assert.equal(hiPrecision.safeFilenameComponent("LAB-12345"), "LAB-12345");
  // Traversal attempt — must not contain '/' or '\\' after sanitization.
  const traversal = hiPrecision.safeFilenameComponent("../../etc/passwd");
  assert.ok(!traversal.includes("/"));
  assert.ok(!traversal.includes("\\"));
  // path.join treats the result as a single filename, not as ".." components.
  assert.equal(path.basename(path.join("/safe", `${traversal}.pdf`)), `${traversal}.pdf`);
  // Mixed separators collapse to a single component.
  const mixed = hiPrecision.safeFilenameComponent("a/b\\c");
  assert.ok(!mixed.includes("/"));
  assert.ok(!mixed.includes("\\"));
  assert.equal(hiPrecision.safeFilenameComponent("with space and *!?"), "with-space-and");
  // Empty / null / whitespace-only fall back to caller-supplied uuid path;
  // the helper returns "" so the caller knows to substitute.
  assert.equal(hiPrecision.safeFilenameComponent(""), "");
  assert.equal(hiPrecision.safeFilenameComponent("---"), "");
  // Length cap so a hostile upstream value can't blow up the path.
  const long = "A".repeat(500);
  assert.equal(hiPrecision.safeFilenameComponent(long).length, 80);
});

test("hi_precision pruneStaleResults: deletes files older than TTL, keeps fresh ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "biprune-"));
  try {
    const fresh = path.join(dir, "fresh.pdf");
    const stale = path.join(dir, "stale.pdf");
    fs.writeFileSync(fresh, "fresh");
    fs.writeFileSync(stale, "stale");
    const now = Date.now();
    // Backdate stale by 25h, ttl = 24h.
    fs.utimesSync(stale, (now - 25 * 3600 * 1000) / 1000, (now - 25 * 3600 * 1000) / 1000);
    const removed = hiPrecision.pruneStaleResults(dir, 24 * 3600 * 1000, now);
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(fresh), true, "fresh file must survive");
    assert.equal(fs.existsSync(stale), false, "stale file must be removed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hi_precision pruneStaleResults: missing directory is a no-op (no throw)", () => {
  // The extractor calls prune unconditionally; a missing volume mount must
  // not crash the call.
  const missing = path.join(os.tmpdir(), "definitely-does-not-exist-bi", String(Date.now()));
  assert.equal(hiPrecision.pruneStaleResults(missing, 1000), 0);
});
