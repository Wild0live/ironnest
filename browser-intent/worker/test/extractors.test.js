const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const col = require("../extractors/col_financial");
const diag = require("../extractors/_diagnose");
const hiPrecision = require("../extractors/hi_precision");
const april = require("../extractors/april_international");

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

test("col_financial place_order constants: BUY_SELL_VALUE maps the LLM-visible enum to verified COL codes", () => {
  // These mappings are VERIFIED against a real diagnose_order_form dump
  // (2026-05-19). Bumping them without a re-diagnose is a bug — COL's HTML
  // uses "BN"/"SN", not "B"/"S" or "BUY"/"SELL".
  assert.equal(col.BUY_SELL_VALUE.buy, "BN");
  assert.equal(col.BUY_SELL_VALUE.sell, "SN");
});

test("col_financial place_order constants: order term + board enums match the verified DOM", () => {
  assert.deepEqual([...col.ALLOWED_ORDER_TERMS].sort(), ["ATC", "DAY", "GTC"]);
  assert.deepEqual([...col.ALLOWED_BOARDS].sort(), ["MAIN", "ODD"]);
});

test("col_financial detectPreviewError: matches the documented broker error phrases", () => {
  // Spot-check a few known error patterns. Lowercased substring match is
  // deliberately liberal so COL wording variations still trigger.
  assert.equal(col.detectPreviewError({ body_excerpt: "Order rejected: insufficient buying power" }), "insufficient");
  assert.equal(col.detectPreviewError({ body_excerpt: "Symbol is INVALID, please retry" }), "invalid");
  assert.equal(col.detectPreviewError({ body_excerpt: "Market is closed for the day" }), "market is closed");
  assert.equal(col.detectPreviewError({ body_excerpt: "Order amount exceeds your buying power" }), "buying power");
  // Normal preview content does NOT trigger.
  assert.equal(col.detectPreviewError({ body_excerpt: "Order Details Symbol AC Quantity 100 Price 25.50 Total 2550.00 Commission 7.32" }), null);
});

test("col_financial classifyDialogs: maps known COL alert text to structured reasons", () => {
  // Real failure modes a maintainer or LLM needs to surface clearly. The
  // dialog text below is approximated from COL's known classic-ASP alert()
  // patterns; we use substring matching so wording variation doesn't break
  // the classifier.
  assert.equal(
    col.classifyDialogs([{ message: "Invalid board lot for MAIN board. Use 100." }]).reason,
    "board_lot_violation"
  );
  // Per-symbol minimum-share phrasing — COL uses this for PGOLD MAIN at
  // small qty instead of the literal "board lot" wording.
  assert.equal(
    col.classifyDialogs([{ message: "Number of shares must not be less than 100." }]).reason,
    "board_lot_violation"
  );
  assert.equal(
    col.classifyDialogs([{ message: "Minimum of 1000 shares required." }]).reason,
    "board_lot_violation"
  );
  assert.equal(
    col.classifyDialogs([{ message: "Insufficient buying power." }]).reason,
    "insufficient_buying_power"
  );
  assert.equal(
    col.classifyDialogs([{ message: "Order exceeds available buying power." }]).reason,
    "insufficient_buying_power"
  );
  assert.equal(
    col.classifyDialogs([{ message: "Invalid tick size for this price band." }]).reason,
    "tick_size_violation"
  );
  assert.equal(
    col.classifyDialogs([{ message: "Market is closed." }]).reason,
    "market_closed"
  );
  assert.equal(
    col.classifyDialogs([{ message: "Invalid symbol MBT123" }]).reason,
    "invalid_symbol"
  );
  // Sell-side rejections — must NOT route to insufficient_buying_power.
  assert.equal(
    col.classifyDialogs([{ message: "Insufficient shares to sell." }]).reason,
    "insufficient_shares"
  );
  assert.equal(
    col.classifyDialogs([{ message: "No shares available for this symbol." }]).reason,
    "insufficient_shares"
  );
  assert.equal(
    col.classifyDialogs([{ message: "Cannot sell more than you own." }]).reason,
    "insufficient_shares"
  );
  assert.equal(
    col.classifyDialogs([{ message: "Stock not in your portfolio." }]).reason,
    "symbol_not_in_portfolio"
  );
  // No known phrase → null (caller surfaces raw dialogs).
  assert.equal(col.classifyDialogs([{ message: "Some unknown broker error" }]), null);
  // Empty / missing dialogs → null.
  assert.equal(col.classifyDialogs([]), null);
  assert.equal(col.classifyDialogs([{ message: "" }]), null);
});

test("col_financial detectMarketClosed: catches COL's after-hours refusal page", () => {
  // The exact text captured from a 2026-05-19 ~6:30 PM PHT (after-hours)
  // diagnose_order_preview run. COL serves the order URL with HTTP 200 but
  // a refusal body instead of the form.
  // Sentinel iteration order is fixed in MARKET_CLOSED_SENTINELS; whichever
  // matches first wins. Today "market is closed" comes first.
  assert.equal(
    col.detectMarketClosed("ENTER ORDER (Step 1 of 3) You can not place an order. The market is closed."),
    "market is closed"
  );
  // Spelling variants.
  assert.equal(col.detectMarketClosed("The market is closed for the day"), "market is closed");
  assert.equal(col.detectMarketClosed("Trading is closed until 1:30 PM PHT"), "trading is closed");
  // A normal form-rendered page does NOT trigger.
  assert.equal(
    col.detectMarketClosed("ENTER ORDER (Step 1 of 3) Order Details Transaction BUY SELL Board MAIN ODDLOT Term DAY GTC ATC"),
    null
  );
  // Empty / null inputs don't crash.
  assert.equal(col.detectMarketClosed(""), null);
  assert.equal(col.detectMarketClosed(null), null);
  assert.equal(col.detectMarketClosed(undefined), null);
});

test("col_financial detectStuckOnStep1: catches the 'Preview click silently failed, still on Step 1' case", () => {
  // The exact body excerpt from the diagnose_order_preview dump that
  // surfaced this bug (2026-05-19). If we ever spuriously return
  // status='dry_run' on this kind of snapshot again, this test fires.
  const stuckSnapshot = {
    body_excerpt: "ENTER ORDER (Step 1 of 3) Order Details [chart] Transaction S BUY SELL Board MAIN ODDLOT Term DAY GTC ATC Stock Code Quote # of Shares - + Price - +"
  };
  assert.equal(col.detectStuckOnStep1(stuckSnapshot), "step 1 of 3");

  // A real Step 2 preview must NOT trigger.
  const realPreview = {
    body_excerpt: "ENTER ORDER (Step 2 of 3) Order Summary Symbol AC Quantity 100 Price 25.50 Total 2550.00 Commission 7.32 Net 2557.32 Confirm Cancel"
  };
  assert.equal(col.detectStuckOnStep1(realPreview), null);

  // Empty / missing snapshot must not crash.
  assert.equal(col.detectStuckOnStep1({}), null);
  assert.equal(col.detectStuckOnStep1({ body_excerpt: "" }), null);
});

test("col_financial CONFIRM_BUTTON_SELECTORS: cmdPlace is FIRST (verified 2026-05-20)", () => {
  // Real DOM confirmation: Step-2 confirm button is name="cmdPlace",
  // value="Place Buy Order" / "Place Sell Order". Keeping it first in the
  // allowlist means a future renaming of the other defensive entries can't
  // accidentally beat it.
  assert.equal(col.CONFIRM_BUTTON_SELECTORS[0], 'input[type="submit"][name="cmdPlace"]');
});

test("col_financial parsePreviewSnapshot: extracts the full Step-2 PREVIEW ORDER shape", () => {
  // Body excerpt verbatim from 2026-05-20 live trade (MBT 70 @ 64.15).
  const preview = {
    body_excerpt:
      "PREVIEW ORDER (Step 2 of 3) Review your order details carefully, before submitting your order. BUYING Order Details Transaction Buy/New Board MAIN Stock Code MBT Term DAY Valid Until 5/20/2026 No of Shares 70 Price 64.1500 Gross Amt 4,490.50 Order Charges Commission 11.23 PSECharge 0.22 Commission VAT 1.35 DSTCharge 0.00 Transfer Fee 0.00 STaxCharge 0.00 Cancellation Fee 0.00 SCCPCharge 0.45 Total Charges: 13.25 Total Order: 4,503.75 Important: You are placing a main board Buy/New order. Please review carefully."
  };
  const out = col.parsePreviewSnapshot(preview);
  assert.equal(out.transaction, "Buy/New");
  assert.equal(out.board, "MAIN");
  assert.equal(out.symbol, "MBT");
  assert.equal(out.order_term, "DAY");
  assert.equal(out.valid_until, "5/20/2026");
  assert.equal(out.quantity, 70);
  assert.equal(out.price, 64.15);
  assert.equal(out.gross_amount, 4490.50);
  assert.equal(out.total_charges, 13.25);
  assert.equal(out.total_order, 4503.75);
  assert.equal(out.fee_commission, 11.23);
  assert.equal(out.fee_pse_charge, 0.22);
  assert.equal(out.fee_commission_vat, 1.35);
  assert.equal(out.fee_sccp_charge, 0.45);
});

test("col_financial parsePreviewSnapshot: null for unrelated body", () => {
  assert.equal(col.parsePreviewSnapshot({ body_excerpt: "ENTER ORDER (Step 1 of 3) ..." }), null);
  assert.equal(col.parsePreviewSnapshot({ body_excerpt: "" }), null);
  assert.equal(col.parsePreviewSnapshot(null), null);
});

test("col_financial parseConfirmationSnapshot: extracts Step-3 success fields with PHT timezone", () => {
  // Reconstructed from the 2026-05-20 live trade #24716 (MBT 30 @ 64.15).
  const confirmation = {
    body_excerpt:
      "ORDER CONFIRMATION (Step 3 of 3) Transaction No.: 24716 Date: 5/20/2026 2:36:14 PM Stock Code: MBT Number of Shares: 30 Price: 64.1500 Status: Submitted"
  };
  const out = col.parseConfirmationSnapshot(confirmation);
  assert.equal(out.transaction_no, "24716");
  assert.equal(out.submitted_at, "5/20/2026 2:36:14 PM PHT");
  assert.equal(out.symbol, "MBT");
  assert.equal(out.quantity, 30);
  assert.equal(out.price, 64.15);
});

test("col_financial parseConfirmationSnapshot: null for unrelated body", () => {
  assert.equal(col.parseConfirmationSnapshot({ body_excerpt: "Some unrelated COL page" }), null);
  assert.equal(col.parseConfirmationSnapshot(null), null);
});

test("col_financial CONFIRM_PASSWORD_SELECTORS: first match is the type-based selector", () => {
  // Type-based is the most generic and works across COL UI tweaks. Name-
  // based selectors only fire if the type matcher misses (which would
  // indicate an unusual layout worth surfacing as needs_extractor_update).
  assert.equal(col.CONFIRM_PASSWORD_SELECTORS[0], 'input[type="password"]');
  // All entries should be input selectors — never select buttons or other
  // elements that might accidentally accept a password value.
  for (const sel of col.CONFIRM_PASSWORD_SELECTORS) {
    assert.match(sel, /^input\[/, `password selector must target input element: ${sel}`);
  }
});

test("col_financial CONFIRM_BUTTON_SELECTORS: every entry targets a submit input by name or value", () => {
  // The selector list is the only thing standing between a wrong-button
  // click and real money loss. Each entry must be specific:
  //   - input[type="submit"] (no general `button` tag — too broad)
  //   - either name= or value*= predicates (no bare type-only selector)
  for (const sel of col.CONFIRM_BUTTON_SELECTORS) {
    assert.match(sel, /^input\[type="submit"\]/, `selector must be a submit input: ${sel}`);
    assert.ok(
      sel.includes("[name=") || sel.includes("[value"),
      `selector must constrain by name or value: ${sel}`
    );
  }
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

test("hi_precision parseDownloadDescriptor: PE / Imaging formLink onclick", () => {
  // Observed live on the Hi-Precision dashboard 2026-05-17. Both PE and
  // X-RAY rows use this shape; the endpoint name and querystring differ
  // but the parse is identical.
  const pe = hiPrecision.parseDownloadDescriptor({
    onclick: "formLink('download-physicalExamResultPDF.do', 'pid=BB027107&labNumber=2498042854&link_pid='); return false;",
    rawHref: "javascript:void(0)",
    resolvedHref: "javascript:void(0)"
  });
  assert.deepEqual(pe, {
    kind: "formLink",
    endpoint: "download-physicalExamResultPDF.do",
    qs: "pid=BB027107&labNumber=2498042854&link_pid="
  });

  const xray = hiPrecision.parseDownloadDescriptor({
    onclick: "formLink('download-imagingResultPDF.do', 'labNumber=2498042854&type=X-RAY&link_pid='); return false;",
    rawHref: "javascript:void(0)",
    resolvedHref: "javascript:void(0)"
  });
  assert.deepEqual(xray, {
    kind: "formLink",
    endpoint: "download-imagingResultPDF.do",
    qs: "labNumber=2498042854&type=X-RAY&link_pid="
  });
});

test("hi_precision parseDownloadDescriptor: LAB modalPopups onclick (no href)", () => {
  // The LAB row has *no* href attribute at all — just an onclick. Earlier
  // versions of the extractor matched `a[href]` and so reported no_url for
  // every LAB row in the dashboard; this test guards against regressing.
  const lab = hiPrecision.parseDownloadDescriptor({
    onclick: "modalPopupsDownloadLaboratoryPdf('BB027107', '2498042854', '', false, 'Complete');",
    rawHref: "",
    resolvedHref: ""
  });
  assert.deepEqual(lab, {
    kind: "modalLab",
    pid: "BB027107",
    labNo: "2498042854"
  });
});

test("hi_precision parseDownloadDescriptor: plain href passes through", () => {
  // Forward-compat — Hi-Precision doesn't currently use plain anchors, but
  // if a future migration adds one we don't want to silently drop it.
  const direct = hiPrecision.parseDownloadDescriptor({
    onclick: "",
    rawHref: "/some/result.pdf",
    resolvedHref: "https://results.healthonlineasia.com/some/result.pdf"
  });
  assert.deepEqual(direct, {
    kind: "direct",
    url: "https://results.healthonlineasia.com/some/result.pdf"
  });
});

test("hi_precision parseDownloadDescriptor: unrecognized inputs return null", () => {
  // The contract is: anything we don't understand becomes null, which
  // surfaces as download_status: "no_url" — never a "best-effort" URL that
  // could leak a wrong document. Each case below MUST stay null.
  assert.equal(hiPrecision.parseDownloadDescriptor(null), null);
  assert.equal(hiPrecision.parseDownloadDescriptor(undefined), null);
  assert.equal(hiPrecision.parseDownloadDescriptor({}), null);
  // javascript: href with no recognized onclick — old extractor reported
  // these as download_failed (it tried to GET "javascript:void(0)"). Now
  // they're correctly classified as no_url.
  assert.equal(
    hiPrecision.parseDownloadDescriptor({
      onclick: "",
      rawHref: "javascript:void(0)",
      resolvedHref: "javascript:void(0)"
    }),
    null
  );
  // A malformed onclick string must not partially match either pattern.
  assert.equal(
    hiPrecision.parseDownloadDescriptor({
      onclick: "formLink(); return false;",
      rawHref: "javascript:void(0)",
      resolvedHref: "javascript:void(0)"
    }),
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

test("april parseInsuredMembersFromLines: bounds at Bank Details, drops contaminants", () => {
  // Realistic line sequence captured from april-diag.json (with Bank
  // Account Holder repeating a member name — that's the bug the line-scan
  // fallback needs to defend against if the structured table is missing).
  const lines = [
    "Home", "Policy", "Claims",
    "Information",
    "Policy number", "P001-63287",
    "Policyholder", "Arlene ECO",
    "Insured members",
    "Name", "Date of birth",
    "Arlene ECO", "15 Mar 1985", "navigate_next",
    "Harddy ECO", "10 Nov 1990", "navigate_next",
    "Bank Details",
    "Bank Account Holder",
    "Harddy ECO",
    "Bank Account Information",
    "Currency PHP",
    "Swift BIC", "BOPIPHMM",
    "Documents",
    "Insurance Certificate",
    "Terms & Conditions"
  ];
  assert.deepEqual(
    april.parseInsuredMembersFromLines(lines),
    ["Arlene ECO", "Harddy ECO"]
  );
});

test("april parseInsuredMembersFromLines: returns [] when 'Insured members' header is missing", () => {
  assert.deepEqual(april.parseInsuredMembersFromLines(["Home", "Policy"]), []);
  assert.deepEqual(april.parseInsuredMembersFromLines([]), []);
  assert.deepEqual(april.parseInsuredMembersFromLines(null), []);
});

test("april parseInsuredMembersFromLines: dedupes a member name that repeats inside the window", () => {
  // Defensive: even with bounding, a member name could appear twice within
  // the Insured-members card (e.g. a future "primary holder" annotation).
  // The function must collapse duplicates.
  const lines = [
    "Insured members",
    "Name", "Date of birth",
    "Arlene ECO", "15 Mar 1985",
    "Arlene ECO",
    "Harddy ECO", "10 Nov 1990",
    "Bank Details"
  ];
  assert.deepEqual(
    april.parseInsuredMembersFromLines(lines),
    ["Arlene ECO", "Harddy ECO"]
  );
});

test("april parseInsuredMembersFromLines: rejects 3-word labels like 'Bank Account Holder' if section header is absent", () => {
  // If Bank Details heading is missing (unboundable window), the anchored
  // line regex plus deny-list must still reject the bank-related noise.
  const lines = [
    "Insured members",
    "Name", "Date of birth",
    "Arlene ECO", "15 Mar 1985",
    "Bank Account Holder",
    "Bank Account Information",
    "Bank Account Type",
    "Insurance Certificate",
    "Currency PHP"
  ];
  assert.deepEqual(
    april.parseInsuredMembersFromLines(lines),
    ["Arlene ECO"]
  );
});

// --- COL Financial trade-acknowledgment parser ---------------------------------
// Realistic row shapes mirror what readAckRows produces from the live page:
// each row is an Array<string> of trimmed cell text, in DOM order. The parser
// must classify each row as transaction / per-symbol-subtotal / grand-total,
// extract numeric values defensively, and never confuse a ticket number for a
// quantity.

test("parseAcknowledgmentTable: parses the canonical 16-fill sell day from the screenshot", () => {
  // Reconstructed from the user's screenshot — same row shapes the COL ack
  // table renders for a multi-symbol selling day. Includes per-symbol
  // subtotals AND the grand total. Numbers preserved verbatim.
  const rows = [
    // header is skipped by the parser (no date cell, no money cell)
    ["#", "Symbol", "Time", "Ticket", "Qty", "", "Price", "Total"],
    // BPI: one fill + per-symbol subtotal (3 rows for symbol total grouping)
    ["", "BPI", "", "20260522005924", "90", "", "", "8,019.00"],
    ["", "BPI", "", "", "", "", "TOTAL", "8,466.50"],
    // FMETF: multiple fills + subtotal
    ["4", "FMETF", "5/22/2026 2:50:02 PM", "20260522007774", "120", "100", "", "12,000.00"],
    ["5", "FMETF", "5/22/2026 11:35:07 AM", "20260522007774", "10", "99.9", "", "999.00"],
    ["", "FMETF", "", "20260522007774", "130", "", "", "12,999.00"],
    ["6", "FMETF", "5/22/2026 10:46:05 AM", "20260522005936", "110", "99.7", "", "10,967.00"],
    ["7", "FMETF", "5/22/2026 10:46:05 AM", "20260522005936", "200", "99.8", "", "19,960.00"],
    ["", "FMETF", "", "20260522005936", "310", "", "", "30,927.00"],
    ["", "FMETF", "", "", "440", "", "TOTAL", "43,926.00"],
    // MBT: one fill + subtotal
    ["8", "MBT", "5/22/2026 11:17:49 AM", "20260522007293", "30", "64.35", "", "1,930.50"],
    ["", "MBT", "", "20260522007293", "30", "", "", "1,930.50"],
    ["", "MBT", "", "", "30", "", "TOTAL", "1,930.50"],
    // PGOLD: several small fills + subtotal
    ["9", "PGOLD", "5/22/2026 10:46:15 AM", "20260522005948", "16", "47.3", "", "756.80"],
    ["10", "PGOLD", "5/22/2026 10:46:15 AM", "20260522005948", "1", "47.3", "", "47.30"],
    ["11", "PGOLD", "5/22/2026 10:46:15 AM", "20260522005948", "2", "47.3", "", "94.60"],
    ["12", "PGOLD", "5/22/2026 10:46:15 AM", "20260522005948", "4", "47.35", "", "189.40"],
    ["13", "PGOLD", "5/22/2026 10:46:15 AM", "20260522005948", "1", "47.4", "", "47.40"],
    ["14", "PGOLD", "5/22/2026 10:46:15 AM", "20260522005948", "7", "47.4", "", "331.80"],
    ["15", "PGOLD", "5/22/2026 10:46:15 AM", "20260522005948", "5", "47.5", "", "237.50"],
    ["16", "PGOLD", "5/22/2026 10:46:15 AM", "20260522005948", "1", "47.5", "", "47.50"],
    ["", "PGOLD", "", "20260522005948", "37", "", "", "1,752.30"],
    ["", "PGOLD", "", "", "37", "", "TOTAL", "1,752.30"],
    // Grand total footer
    ["", "SELLING", "TOTAL", "", "", "", "TOTAL", "56,075.30"]
  ];

  const parsed = col.parseAcknowledgmentTable(rows);

  // 13 transactions: 4 FMETF (rows w/ dates) + 1 MBT + 8 PGOLD. The BPI row
  // in this reconstruction has no date column so it doesn't qualify as a
  // transaction — its amount is still captured via the BPI subtotal row.
  assert.equal(parsed.trade_count, 13);

  // Grand total must match the SELLING TOTAL row
  assert.equal(parsed.grand_total, 56075.30);
  assert.equal(parsed.summary_label, "SELLING TOTAL");
  assert.equal(parsed.currency, "PHP");

  // At least one per-symbol subtotal must be captured
  assert.ok(parsed.subtotals.length >= 1, `expected per-symbol subtotals, got ${parsed.subtotals.length}`);

  // Spot-check a few transactions for correct field extraction
  const fmetf12k = parsed.trades.find((t) => t.amount === 12000);
  assert.ok(fmetf12k, "FMETF 12,000.00 fill must be present");
  assert.equal(fmetf12k.symbol, "FMETF");
  assert.equal(fmetf12k.qty, 120);
  assert.equal(fmetf12k.price, 100);
  assert.equal(fmetf12k.ticket, "20260522007774");

  // Every transaction must have a parseable amount > 0
  for (const t of parsed.trades) {
    assert.ok(t.amount > 0, `transaction amount must be positive: ${JSON.stringify(t)}`);
  }
});

test("parseAcknowledgmentTable: returns empty trade list when given an empty row array (no false positives)", () => {
  const parsed = col.parseAcknowledgmentTable([]);
  assert.equal(parsed.trade_count, 0);
  assert.equal(parsed.grand_total, null);
  assert.deepEqual(parsed.trades, []);
});

test("parseAcknowledgmentTable: does not classify a ticket-number cell as quantity", () => {
  // Regression: tickets are 10+-digit integers, qty is a small integer.
  // If the parser confused them, qty would be ~14 digits and total math
  // would never reconcile in downstream consumers.
  const rows = [
    ["1", "ACEN", "5/22/2026 9:30:00 AM", "20260522001234", "500", "5.5", "", "2,750.00"],
    ["", "SELLING", "TOTAL", "", "", "", "TOTAL", "2,750.00"]
  ];
  const parsed = col.parseAcknowledgmentTable(rows);
  assert.equal(parsed.trade_count, 1);
  assert.equal(parsed.trades[0].qty, 500, "must pick 500 not the 14-digit ticket");
  assert.equal(parsed.trades[0].ticket, "20260522001234");
});

test("parseAcknowledgmentTable: recognizes BUYING TOTAL grand-total footer (not just SELLING)", () => {
  const rows = [
    ["1", "AC", "5/22/2026 1:15:00 PM", "20260522009999", "100", "650.00", "", "65,000.00"],
    ["", "BUYING", "TOTAL", "", "", "", "TOTAL", "65,000.00"]
  ];
  const parsed = col.parseAcknowledgmentTable(rows);
  assert.equal(parsed.grand_total, 65000);
  assert.equal(parsed.summary_label, "BUYING TOTAL");
});

test("parseAcknowledgmentTable: skips a malformed row that has neither symbol nor date nor amount (gracefully)", () => {
  // E.g. a separator row, advertising banner, or layout-only <tr>.
  const rows = [
    ["", "", "", "", "", "", "", ""],
    ["Some random page text"],
    ["1", "ACEN", "5/22/2026 9:30:00 AM", "20260522001234", "500", "5.5", "", "2,750.00"],
    ["", "SELLING", "TOTAL", "", "", "", "TOTAL", "2,750.00"]
  ];
  const parsed = col.parseAcknowledgmentTable(rows);
  assert.equal(parsed.trade_count, 1);
  assert.equal(parsed.grand_total, 2750);
});

test("ackHighValueThreshold: defaults to 100,000 PHP when env is unset", () => {
  const prev = process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD;
  delete process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD;
  try {
    assert.equal(col.ackHighValueThreshold(), 100000);
  } finally {
    if (prev !== undefined) process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD = prev;
  }
});

test("ackHighValueThreshold: respects positive numeric env override", () => {
  const prev = process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD;
  process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD = "250000";
  try {
    assert.equal(col.ackHighValueThreshold(), 250000);
  } finally {
    if (prev === undefined) delete process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD;
    else process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD = prev;
  }
});

test("ackHighValueThreshold: falls back to default on a malformed env value (defense against typos like '100k')", () => {
  const prev = process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD;
  process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD = "100k";
  try {
    assert.equal(col.ackHighValueThreshold(), 100000);
  } finally {
    if (prev === undefined) delete process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD;
    else process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD = prev;
  }
});

test("ackHighValueThreshold: rejects zero and negative overrides (would disable the gate)", () => {
  const prev = process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD;
  process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD = "-1";
  try {
    assert.equal(col.ackHighValueThreshold(), 100000, "negative must fall back to default");
    process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD = "0";
    assert.equal(col.ackHighValueThreshold(), 100000, "zero must fall back to default");
  } finally {
    if (prev === undefined) delete process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD;
    else process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD = prev;
  }
});
