// COL Financial post-login extractors.
//
// COL's post-login portal ("AccessPlus", paths under /ape/Final2/) is a frame-based
// classic-ASP webapp. Portfolio data lives inside an iframe; this extractor scans
// every accessible frame for a holdings table whose header matches the expected
// column names. That makes the extractor resilient to small DOM tweaks but also
// dependent on COL's column wording — if the headers change we throw, the worker
// returns needs_extractor_update, and a human updates HEADER_MATCHERS below.

// Path templates only. Host is derived from the current page URL because COL
// assigns each session to a shard (e.g. ph14.colfinancial.com) — hardcoding a
// host would only work for one user. New layout is FINAL2_STARTER (observed
// 2026-05-14); the "Portfolio" menu item invokes getwin(44) which navigates
// parent.frames['main'] to ../trading_PCA3/As_CashBalStockPos.asp. The bare
// As_CashBalStockPos.asp server-side redirects to the _MF variant for accounts
// with mutual-funds-eligible flag; both URLs land on the same DOM so we keep
// the candidate list short. Legacy Final2 paths are kept as fallback for
// sessions still on the old layout.
const PORTFOLIO_PATH_CANDIDATES = [
  "/ape/FINAL2_STARTER/trading_PCA3/As_CashBalStockPos.asp",
  "/ape/Final2/main/PORTFOLIO_t.asp"
];

// Order entry URL. Verified from a diagnose_order_form run 2026-05-19: the
// "Trade > Enter Order" menu invokes getwin(41) which navigates the main
// frame to this path. Loaded directly works because COL's session cookies
// are scoped to the host, not to the frame structure.
const ORDER_ENTRY_PATH_CANDIDATES = [
  "/ape/FINAL2_STARTER/trading_pca3/Trd_EnterOrder.asp"
];

// Verified radio button value mappings from diagnose_order_form (2026-05-19).
// COL's HTML uses non-obvious codes ("BN"/"SN" instead of "B"/"S") so don't
// guess from the LLM-friendly name — translate explicitly.
const BUY_SELL_VALUE = { buy: "BN", sell: "SN" };
const ALLOWED_ORDER_TERMS = new Set(["DAY", "GTC", "ATC"]);
const ALLOWED_BOARDS = new Set(["MAIN", "ODD"]);

// Patterns for parsing the Step-2 preview page (PREVIEW ORDER) into a
// structured order object. Verified against a real 2026-05-20 preview dump.
// Each pattern matches at most one occurrence — the body excerpt is largely
// label-then-value pairs separated by whitespace.
const PREVIEW_PATTERNS = {
  transaction: /Transaction\s+(Buy\/New|Sell\/New|Buy|Sell)/i,
  board: /Board\s+(MAIN|ODD|ODDLOT)/i,
  symbol: /Stock\s*Code\s+([A-Z][A-Z0-9.]*)/,
  order_term: /Term\s+(DAY|GTC|ATC)/i,
  valid_until: /Valid\s*Until\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i,
  quantity: /No\s*of\s*Shares\s+([\d,]+)/i,
  price: /\bPrice\s+([\d.,]+)/i,
  gross_amount: /Gross\s*Amt\s+([\d,.]+)/i,
  total_charges: /Total\s*Charges[:\s]+([\d,.]+)/i,
  total_order: /Total\s*Order[:\s]+([\d,.]+)/i,
  fee_commission: /Commission\s+([\d,.]+)/i,
  fee_pse_charge: /PSECharge\s+([\d,.]+)/i,
  fee_commission_vat: /Commission\s*VAT\s+([\d,.]+)/i,
  fee_dst_charge: /DSTCharge\s+([\d,.]+)/i,
  fee_transfer: /Transfer\s*Fee\s+([\d,.]+)/i,
  fee_stax_charge: /STaxCharge\s+([\d,.]+)/i,
  fee_cancellation: /Cancellation\s*Fee\s+([\d,.]+)/i,
  fee_sccp_charge: /SCCPCharge\s+([\d,.]+)/i
};

// Patterns for the Step-3 confirmation page. Fields observed 2026-05-20:
// Transaction No, Date, Stock Code, Number of Shares, Price.
const CONFIRMATION_PATTERNS = {
  transaction_no: /Transaction\s*No[\.:]*\s*(\d+)/i,
  submitted_at: /Date[:\s]+(\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*[AP]M)/i,
  symbol: /Stock\s*Code[:\s]+([A-Z][A-Z0-9.]*)/,
  quantity: /Number\s*of\s*Shares[:\s]+([\d,]+)/i,
  price: /\bPrice[:\s]+([\d.,]+)/i
};

// Pull a body string out of a snapshot for regex matching. We use the raw
// excerpt rather than table rows because the patterns are designed to
// straddle the label-then-value layout that COL renders.
function snapshotBodyText(snapshot) {
  if (!snapshot) return "";
  if (typeof snapshot === "string") return snapshot;
  return snapshot.body_excerpt || "";
}

function parsePreviewSnapshot(snapshot) {
  const body = snapshotBodyText(snapshot);
  if (!body) return null;
  const out = {};
  let any = false;
  for (const [field, re] of Object.entries(PREVIEW_PATTERNS)) {
    const m = body.match(re);
    if (!m) continue;
    any = true;
    if (field === "quantity") out[field] = parseNumber(m[1]);
    else if (field.startsWith("fee_") || ["gross_amount", "total_charges", "total_order", "price"].includes(field)) {
      out[field] = parseNumber(m[1]);
    } else {
      out[field] = m[1];
    }
  }
  return any ? out : null;
}

function parseConfirmationSnapshot(snapshot) {
  const body = snapshotBodyText(snapshot);
  if (!body) return null;
  const out = {};
  let any = false;
  for (const [field, re] of Object.entries(CONFIRMATION_PATTERNS)) {
    const m = body.match(re);
    if (!m) continue;
    any = true;
    if (field === "quantity") out[field] = parseNumber(m[1]);
    else if (field === "price") out[field] = parseNumber(m[1]);
    else if (field === "submitted_at") out[field] = `${m[1]} PHT`; // COL serves PHT timestamps
    else out[field] = m[1];
  }
  return any ? out : null;
}

// Verified 2026-05-20 via diagnose_order_preview run during PSE market hours:
// the Step-2 confirm button is cmdPlace ("Place Buy Order" / "Place Sell
// Order"). The other entries below are defensive — kept in priority order
// so a future COL UI tweak that renames the button still has fallbacks
// before failing as needs_extractor_update.
const CONFIRM_BUTTON_SELECTORS = [
  'input[type="submit"][name="cmdPlace"]',     // ← VERIFIED on Step 2
  'input[type="submit"][name="cmdSubmit"]',
  'input[type="submit"][name="cmdConfirm"]',
  'input[type="submit"][name="cmdSend"]',
  'input[type="submit"][name="cmdOK"]',
  'input[type="submit"][name="cmdProceed"]',
  'input[type="submit"][value*="Place Buy Order" i]',
  'input[type="submit"][value*="Place Sell Order" i]',
  'input[type="submit"][value*="Submit" i]',
  'input[type="submit"][value*="Confirm" i]',
  'input[type="submit"][value*="Place Order" i]',
  'input[type="submit"][value*="Send Order" i]'
];

// Password-input selectors for the Step-2 preview page. COL requires
// password re-entry before order placement (verified 2026-05-20 — body
// excerpt shows "Enter your password"). Defensive: try the type-based
// selector first since it's the most generic, then name-based, then
// label-adjacent. If none match, placeOrder returns
// needs_extractor_update with reason="password_field_not_found".
const CONFIRM_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="txtPassword"]',
  'input[name="txtPass"]',
  'input[name*="pass" i]:not([type="hidden"])'
];

// Phrase-level heuristics for distinguishing a normal preview page from an
// error response on the same URL (insufficient funds, invalid symbol,
// outside market hours, etc.). Hit any of these → status=needs_user_action
// with the matched phrase so the LLM can surface it verbatim.
const PREVIEW_ERROR_PHRASES = [
  "insufficient", "not enough", "buying power",
  "invalid", "not a valid",
  "outside market hours", "market is closed", "trading is closed",
  "exceeds", "minimum", "board lot",
  "rejected", "cannot be processed", "error"
];

// Sentinels for "we clicked Preview but the page is still Step 1 of 3" —
// i.e. the submission silently failed. COL's order flow is explicitly
// labeled "ENTER ORDER (Step 1 of 3)" → "Step 2 of 3" → "Step 3 of 3".
// If our post-click snapshot still says "Step 1 of 3", we never advanced.
const STEP1_BODY_SENTINELS = [
  "step 1 of 3", "enter order (step 1"
];

// COL serves Trd_EnterOrder.asp with a polite refusal when the market is
// closed — same URL, HTTP 200, but no OrderDetails form. Confirmed
// 2026-05-19: body said "ENTER ORDER (Step 1 of 3) You can not place an
// order. The market is closed." Detect this early so the caller returns
// status:"needs_user_action" reason:"market_closed" instead of an opaque
// order_entry_page_not_reachable.
const MARKET_CLOSED_SENTINELS = [
  "market is closed",
  "you can not place an order",
  "trading is closed",
  "you cannot place an order"
];

// Cash-balance parsing uses a text-pattern approach rather than DOM walking
// because COL lays out the Account Summary as a nested COLSPAN table whose
// values sit inside inner tables — direct-child cell parsing returns empty
// strings, and following descendants flattens the whole page into one wrapper
// cell (the same problem the holdings extractor's wrapper-row guard works
// around). The page's plain text, however, is unambiguous: the labels and
// values appear in fixed order separated only by static action text.
//
// CASH_PATTERN matches: "Cash Balance ... Buying Power <action text> N1 N2 [N3]"
//   - N1: cash balance (settled)
//   - N2: actual balance (settled + unsettled)
//   - N3: buying power — optional; non-margin accounts render empty
const CASH_PATTERN =
  /Cash Balance[\s\S]*?Buying Power[\s\S]*?([\d,]+\.\d{2})\s+([\d,]+\.\d{2})(?:\s+([\d,]+\.\d{2}))?/;

// EQUITY_PATTERN matches: "Your Total Account Equity Value is N". Used as the
// authoritative total and a cross-check against (sum(holdings.market_value) +
// cash.actual_balance).
const EQUITY_PATTERN = /Total Account Equity Value is\s+([\d,]+\.\d{2})/;

// Keywords are intentionally specific. The new As_CashBalStockPos page has
// near-duplicate column names (Stock Code vs Stock Name, Total Shares vs
// Uncommitted Shares, Market Value vs Cash Balance) so loose substring matches
// like "stock" or "shares" collide. Each entry must be distinctive enough to
// land on the intended column.
const HEADER_MATCHERS = {
  symbol: ["stock code", "symbol"],
  quantity: ["total shares", "quantity"],
  averageCost: ["average price", "avg price", "ave price", "average cost"],
  lastPrice: ["market price", "last price", "current price"],
  marketValue: ["market value"]
};

function normalize(text) {
  return (text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function parseNumber(text) {
  if (text === null || text === undefined) return null;
  const cleaned = String(text).replace(/[^\d.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function matchHeaderColumn(headerCells) {
  const normalized = headerCells.map(normalize);
  const out = {};
  for (const [field, candidates] of Object.entries(HEADER_MATCHERS)) {
    // A real column header is a short label — reject cells over 40 chars, which
    // are usually concatenated wrapper-row text containing every keyword on
    // the page. Without this guard, wrapper tables that flatten all nested
    // content into one cell collapse every field onto the same index.
    const idx = normalized.findIndex(
      (h) => h.length > 0 && h.length <= 40 && candidates.some((c) => h.includes(c))
    );
    if (idx === -1) return null;
    out[field] = idx;
  }
  // Every field must land on a distinct column. Same-index collisions mean we
  // matched a concatenation, not a real header row.
  const indices = Object.values(out);
  if (new Set(indices).size !== indices.length) return null;
  return out;
}

// Walk every table in the frame using DIRECT children only. COL's portfolio
// page wraps the equities table inside several nested layout tables; if we
// followed descendant cells we'd read the flattened text of every nested
// table from a single wrapper cell. The wrapper-row guard in matchHeaderColumn
// catches the worst case but only direct-cell extraction is structurally safe.
async function findAndExtractRawHoldings(frame, headerMatchers) {
  return await frame.evaluate(({ matchers }) => {
    function norm(s) {
      return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    }
    function parseNum(s) {
      const cleaned = String(s || "").replace(/[^\d.\-]/g, "");
      if (!cleaned || cleaned === "-" || cleaned === ".") return null;
      const n = Number.parseFloat(cleaned);
      return Number.isFinite(n) ? n : null;
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
    function directCellTexts(row) {
      const cells = [];
      for (const c of row.children) {
        if (c.tagName === "TD" || c.tagName === "TH") {
          cells.push((c.innerText || "").replace(/\s+/g, " ").trim());
        }
      }
      return cells;
    }
    function matchHeader(cells) {
      const normalized = cells.map(norm);
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
        const headerCells = directCellTexts(rows[i]);
        if (headerCells.length < 5) continue;
        const cols = matchHeader(headerCells);
        if (!cols) continue;

        const holdings = [];
        for (let j = i + 1; j < rows.length; j++) {
          const cells = directCellTexts(rows[j]);
          if (!cells.length) continue;
          const symbol = norm(cells[cols.symbol] || "").toUpperCase().split(" ")[0];
          if (!symbol || symbol.length > 10) continue;
          if (/^total/i.test(symbol)) continue;
          const quantity = parseNum(cells[cols.quantity]);
          const averageCost = parseNum(cells[cols.averageCost]);
          const lastPrice = parseNum(cells[cols.lastPrice]);
          const marketValue = parseNum(cells[cols.marketValue]);
          if (quantity === null || averageCost === null || lastPrice === null) continue;
          holdings.push({ symbol, quantity, averageCost, lastPrice, marketValue });
        }
        if (holdings.length) return holdings;
      }
    }
    return null;
  }, { matchers: headerMatchers });
}

// Pull the plain-text body of the frame (single string, whitespace-collapsed)
// so the text-pattern regexes have something to match against.
async function frameBodyText(frame) {
  return await frame
    .evaluate(() => (document.body && document.body.innerText) || "")
    .catch(() => "");
}

// Extract cash-balance fields and total-account-equity from frame body text.
// Returns nulls for any field that doesn't match — never throws.
function parseCashAndEquity(bodyText) {
  const cashMatch = bodyText.match(CASH_PATTERN);
  const equityMatch = bodyText.match(EQUITY_PATTERN);
  return {
    cash_balance: cashMatch ? parseNumber(cashMatch[1]) : null,
    actual_balance: cashMatch ? parseNumber(cashMatch[2]) : null,
    buying_power: cashMatch && cashMatch[3] ? parseNumber(cashMatch[3]) : null,
    total_account_equity: equityMatch ? parseNumber(equityMatch[1]) : null
  };
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function tryNavigate(page) {
  // Derive host from the current logged-in page so the same code works across
  // COL's shard pool (www.colfinancial.com → phNN.colfinancial.com after login).
  let base;
  try {
    const cur = new URL(page.url());
    base = `${cur.protocol}//${cur.host}`;
  } catch {
    base = "https://www.colfinancial.com";
  }
  for (const path of PORTFOLIO_PATH_CANDIDATES) {
    try {
      const response = await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1500);
      // page.goto returns the response for the main resource. IIS 404 returns a
      // valid HTML body so playwright doesn't throw — explicitly skip 4xx/5xx.
      if (response && response.status() >= 400) continue;
      return;
    } catch {
      // Try the next candidate.
    }
  }
}

async function getPortfolio(page) {
  await tryNavigate(page);

  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  let rawHoldings = null;
  let cashParsed = null; // { cash_balance, actual_balance, buying_power, total_account_equity }
  for (const frame of frames) {
    if (!rawHoldings) {
      rawHoldings = await findAndExtractRawHoldings(frame, HEADER_MATCHERS).catch(() => null);
    }
    if (!cashParsed || cashParsed.cash_balance === null || cashParsed.total_account_equity === null) {
      const body = await frameBodyText(frame);
      if (body) {
        const candidate = parseCashAndEquity(body);
        // Prefer the first frame that yields a non-null cash_balance.
        if (candidate.cash_balance !== null || candidate.total_account_equity !== null) {
          cashParsed = candidate;
        }
      }
    }
    if (rawHoldings && cashParsed && cashParsed.cash_balance !== null) break;
  }
  if (!rawHoldings) {
    const error = new Error("col_financial portfolio table not found");
    error.code = "needs_extractor_update";
    throw error;
  }
  // Cash parse failing is unusual but not fatal — return all-null so the caller
  // can distinguish "zero cash" from "couldn't read cash".
  const cash = {
    cash_balance: cashParsed ? cashParsed.cash_balance : null,
    actual_balance: cashParsed ? cashParsed.actual_balance : null,
    buying_power: cashParsed ? cashParsed.buying_power : null,
    currency: "PHP"
  };
  // For non-margin accounts COL omits the buying_power value cell. In that case
  // buying power is operationally the same as cash balance, so surface it under
  // a clearer field name so the LLM doesn't have to know COL's quirks.
  cash.available_cash =
    cash.buying_power !== null ? cash.buying_power : cash.cash_balance;

  const holdings = rawHoldings.map((h) => {
    const marketValue = h.marketValue !== null ? h.marketValue : h.quantity * h.lastPrice;
    const costBasis = h.quantity * h.averageCost;
    const unrealizedPnl = marketValue - costBasis;
    const unrealizedPnlPct = costBasis !== 0 ? (unrealizedPnl / costBasis) * 100 : 0;
    return {
      symbol: h.symbol,
      quantity: h.quantity,
      average_cost: round(h.averageCost, 4),
      last_price: round(h.lastPrice, 4),
      market_value: round(marketValue, 2),
      unrealized_pnl: round(unrealizedPnl, 2),
      unrealized_pnl_pct: round(unrealizedPnlPct, 2)
    };
  });

  // Prefer the equity figure scraped directly from COL's "Your Total Account
  // Equity Value is N" footer. Fall back to market_value + actual_balance if
  // the footer string couldn't be parsed. Return null if neither path works
  // rather than printing an unverified number.
  function computeEquity(marketValue) {
    if (cashParsed && cashParsed.total_account_equity !== null) {
      return round(cashParsed.total_account_equity, 2);
    }
    if (cash.actual_balance !== null) {
      return round(marketValue + cash.actual_balance, 2);
    }
    return null;
  }

  if (!holdings.length) {
    return {
      site: "col_financial",
      status: "ok",
      as_of: new Date().toISOString(),
      currency: "PHP",
      holdings: [],
      cash,
      totals: {
        market_value: 0,
        cost_basis: 0,
        unrealized_pnl: 0,
        unrealized_pnl_pct: 0,
        total_account_equity: computeEquity(0)
      },
      returned_sensitive_data: true
    };
  }

  const totalMarketValue = holdings.reduce((sum, h) => sum + h.market_value, 0);
  const totalCostBasis = holdings.reduce((sum, h) => sum + h.quantity * h.average_cost, 0);
  const totalUnrealizedPnl = totalMarketValue - totalCostBasis;
  const totalUnrealizedPnlPct = totalCostBasis !== 0 ? (totalUnrealizedPnl / totalCostBasis) * 100 : 0;
  const totalEquity = computeEquity(totalMarketValue);

  return {
    site: "col_financial",
    status: "ok",
    as_of: new Date().toISOString(),
    currency: "PHP",
    holdings,
    cash,
    totals: {
      market_value: round(totalMarketValue, 2),
      cost_basis: round(totalCostBasis, 2),
      unrealized_pnl: round(totalUnrealizedPnl, 2),
      unrealized_pnl_pct: round(totalUnrealizedPnlPct, 2),
      total_account_equity: totalEquity
    },
    returned_sensitive_data: true
  };
}

// Diagnostic-only: dumps the structure of the post-login page so a human can
// identify the right portfolio URL and column headers. Returns NO holdings data
// — only sanitized URLs (origin + pathname, query/hash stripped) and table
// header-row text. Intended to be removed once the real extractor is tuned.
function sanitizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
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

async function collectLinks(page) {
  return page
    .locator("a[href], area[href]")
    .evaluateAll((nodes) =>
      nodes
        .map((a) => ({
          text: (a.textContent || a.getAttribute("alt") || a.getAttribute("title") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80),
          href: a.getAttribute("href") || ""
        }))
        .filter((l) => l.text || l.href)
        .slice(0, 80)
    )
    .catch(() => []);
}

async function collectAllFrameLinks(page) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const frameUrl = sanitizeUrl(frame.url());
      const links = await frame
        .locator("a[href], area[href]")
        .evaluateAll((nodes) =>
          nodes
            .map((a) => ({
              text: (a.textContent || a.getAttribute("alt") || a.getAttribute("title") || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 80),
              href: a.getAttribute("href") || ""
            }))
            .filter((l) => /portfolio|holding|account|equity|asset|stock|share/i.test(l.text + " " + l.href))
            .slice(0, 30)
        );
      if (links.length) out.push({ frame_url: frameUrl, links });
    } catch {
      /* frame may have detached */
    }
  }
  return out;
}

async function diagnosePortfolio(page) {
  // Do NOT pre-navigate. After login the page is on COL's real landing URL —
  // we want to inspect THAT, not a guessed path. The first iteration of this
  // extractor showed the guess URL returns IIS 404.
  await page.waitForTimeout(1000);

  const landingUrl = sanitizeUrl(page.url());
  const frames = await collectFrameSummaries(page);
  const portfolioLinks = await collectAllFrameLinks(page);

  return {
    site: "col_financial",
    status: "ok",
    diagnostic: true,
    landing_url: landingUrl,
    frames,
    portfolio_link_candidates: portfolioLinks,
    returned_sensitive_data: false
  };
}

// ---------------------------------------------------------------------------
// Order-form diagnostic.
//
// Surfaces enough metadata about COL's trade-entry page to author placeOrder
// selectors without guessing. Strictly metadata only — no field values, no
// option labels (ticker lists could be sensitive), no innerHTML dumps.
//
// Strategy:
//   1. From the post-login landing, collect navigation links across ALL
//      frames matching trade/buy/sell/order keywords. Many of COL's menu
//      items are JS-driven (getwin(NN) → parent.frames['main'].location =
//      …); we capture the onclick text alongside href so a reviewer can
//      identify both DOM-link and JS-driven navigation.
//   2. Best-effort: try clicking a small allowlist of trade-link text
//      labels (Buy / Sell / Trade / Order Entry) so the dump captures the
//      RESULTING form, not just the landing page. If none click, the dump
//      below still includes the landing's form metadata.
//   3. After settling, dump per-frame:
//      - URL (origin + pathname only)
//      - form action / method
//      - inputs (name, id, type, autocomplete, placeholder, label, disabled)
//      - select elements (name, id, option_count — but NOT option labels)
//      - buttons (text, type, name) and submit-shaped inputs
// ---------------------------------------------------------------------------
async function collectAllFrameTradeLinks(page) {
  const out = [];
  for (const frame of page.frames()) {
    try {
      const frameUrl = sanitizeUrl(frame.url());
      const links = await frame
        .locator("a, area, button, input[type='button'], input[type='submit']")
        .evaluateAll((nodes) =>
          nodes
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              text: (el.textContent || el.value || el.getAttribute("alt") || el.getAttribute("title") || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 80),
              href: el.getAttribute("href") || "",
              onclick: (el.getAttribute("onclick") || "").slice(0, 200),
              id: (el.getAttribute("id") || "").slice(0, 80),
              name: (el.getAttribute("name") || "").slice(0, 80)
            }))
            .filter((l) => {
              const blob = `${l.text} ${l.href} ${l.onclick} ${l.id} ${l.name}`;
              return /buy|sell|trade|order|equity|stock|place|execute/i.test(blob);
            })
            .slice(0, 40)
        );
      if (links.length) out.push({ frame_url: frameUrl, candidates: links });
    } catch {
      /* frame may have detached */
    }
  }
  return out;
}

async function tryActivateTradeLink(page) {
  // Best-effort: click a trade-link label so the dump captures the resulting
  // form, not the landing. Each candidate is tried in turn; we stop at the
  // first one that triggers a navigation OR a frame URL change.
  const labels = [
    "Order Entry", "Place Order", "Trade", "Buy", "Sell", "New Order",
    "Stock Trading", "Trade Stocks", "Place Trade"
  ];
  const beforeFrames = page.frames().map((f) => f.url());
  for (const frame of page.frames()) {
    for (const label of labels) {
      const locator = frame.getByText(label, { exact: false }).first();
      const count = await locator.count().catch(() => 0);
      if (!count) continue;
      const clicked = await locator.click({ timeout: 3000 }).then(() => true).catch(() => false);
      if (!clicked) continue;
      await page.waitForTimeout(1500);
      const afterFrames = page.frames().map((f) => f.url());
      const changed = afterFrames.some((u, i) => u !== beforeFrames[i]);
      if (changed) return { clicked_label: label, frame_url: sanitizeUrl(frame.url()) };
    }
  }
  return null;
}

async function summarizeFrameForms(frame) {
  // Pull form / input / select / button metadata WITHOUT any field values.
  // Defensive: every locator call is .catch()-wrapped because frames may
  // detach mid-navigation when COL's classic-ASP main frame swaps URLs.
  const url = sanitizeUrl(frame.url());
  let title = "";
  try { title = await frame.title(); } catch { /* some frames disallow */ }

  const forms = await frame
    .evaluate(() => {
      function attr(el, name) {
        const v = el.getAttribute(name);
        return v === null ? null : v.slice(0, 120);
      }
      function labelFor(el) {
        // <label for="id">  OR  enclosing <label>  OR  aria-label
        const id = el.getAttribute("id");
        if (id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl) return (lbl.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
        }
        const parentLabel = el.closest("label");
        if (parentLabel) return (parentLabel.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
        return el.getAttribute("aria-label");
      }
      const forms = [];
      for (const form of document.querySelectorAll("form")) {
        // For radio / checkbox / submit / button inputs the `value` attribute
        // is form-structure metadata defined by the page itself, not user
        // data — safe to expose. For text/password/tel/etc. we still hide
        // the actual value (value_class only) so a partially-filled form
        // never leaks the user's content.
        const STRUCTURAL_VALUE_TYPES = new Set(["radio", "checkbox", "submit", "button", "image", "reset"]);
        function adjacentLabelText(el) {
          // COL renders radios as `<input ...>Buy` with bare text. Walk
          // forward through siblings collecting text up to the next
          // structural element. Capped at 60 chars.
          let text = "";
          let node = el.nextSibling;
          while (node && text.length < 60) {
            if (node.nodeType === Node.TEXT_NODE) {
              text += node.textContent || "";
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              const tag = node.tagName.toLowerCase();
              if (tag === "input" || tag === "br" || tag === "select" || tag === "textarea") break;
              text += node.textContent || "";
            }
            node = node.nextSibling;
          }
          return text.replace(/\s+/g, " ").trim().slice(0, 60) || null;
        }
        const inputs = [];
        for (const el of form.querySelectorAll("input")) {
          const type = (attr(el, "type") || "text").toLowerCase();
          const entry = {
            tag: "input",
            name: attr(el, "name"),
            id: attr(el, "id"),
            type,
            autocomplete: attr(el, "autocomplete"),
            placeholder: attr(el, "placeholder"),
            label: labelFor(el) || adjacentLabelText(el),
            disabled: el.disabled,
            readonly: el.readOnly,
            // value-class only: empty, numeric, alpha, mixed — never the value itself
            value_class: el.value ? (/^[\d.,\s-]+$/.test(el.value) ? "numeric" : "non-empty") : "empty"
          };
          if (STRUCTURAL_VALUE_TYPES.has(type)) {
            // Radio/checkbox/submit VALUE attributes are constants in the
            // HTML — surface them so a maintainer can author placeOrder
            // selectors without guessing whether rdBuySell is "B"/"S" or
            // "BUY"/"SELL" or "0"/"1".
            entry.value = attr(el, "value");
            entry.checked = !!el.checked;
          }
          inputs.push(entry);
        }
        const selects = [];
        for (const el of form.querySelectorAll("select")) {
          selects.push({
            tag: "select",
            name: attr(el, "name"),
            id: attr(el, "id"),
            option_count: el.options.length,
            label: labelFor(el)
            // NB: deliberately not dumping option labels — could leak ticker
            // lists, account numbers, or other user-specific data.
          });
        }
        const buttons = [];
        for (const el of form.querySelectorAll("button, input[type='submit'], input[type='button']")) {
          buttons.push({
            tag: el.tagName.toLowerCase(),
            type: attr(el, "type"),
            name: attr(el, "name"),
            id: attr(el, "id"),
            text: (el.innerText || el.value || "").replace(/\s+/g, " ").trim().slice(0, 80)
          });
        }
        forms.push({
          action: form.getAttribute("action") || "",
          method: (form.getAttribute("method") || "get").toLowerCase(),
          name: attr(form, "name"),
          id: attr(form, "id"),
          inputs,
          selects,
          buttons
        });
      }
      return forms;
    })
    .catch(() => []);

  return { url, title, forms };
}

async function collectAllFrameForms(page) {
  const out = [];
  for (const frame of page.frames()) {
    const summary = await summarizeFrameForms(frame).catch(() => null);
    if (summary) out.push(summary);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Order placement — WRITE OPERATION.
//
// Selectors below are verified against the live DOM from diagnose_order_form
// (see project_browser_intent_col_place_order in memory for the dump). DO
// NOT modify these without re-running the diagnostic first.
//
// Flow:
//   1. Navigate to Trd_EnterOrder.asp (works direct; session cookie scoped
//      to host).
//   2. Locate the OrderDetails form — possibly inside a sub-frame because
//      COL renders the trade page in a frameset.
//   3. Fill: rdBuySell (BN/SN), rdBoard (MAIN/ODD), rdTerm (DAY/GTC/ATC),
//      txtStkSymbol, txtNumNoShare, txtFloatPrice.
//   4. Click cmdPreview ("Preview Order"). COL's own dry-run step.
//   5. Snapshot the preview page (visible text, tables, buttons).
//   6. If dry_run=true: STOP. Return preview. No order placed.
//   7. If dry_run=false: find a confirm button via CONFIRM_BUTTON_SELECTORS
//      and click it. Snapshot the confirmation page. Return ok + write_op.
//   8. If no confirm button matches in step 7: return needs_extractor_update
//      WITHOUT clicking anything — better to refuse than guess on a write.
// ---------------------------------------------------------------------------
// Poll for the OrderDetails form to appear across any frame. COL's frame
// swap after a menu click is async — checking immediately after click()
// frequently returns null. windowMs is the total polling budget.
async function waitForOrderDetailsFrame(page, windowMs = 5000, intervalMs = 250) {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const formFrame = await findOrderDetailsFrame(page);
    if (formFrame) return formFrame;
    await page.waitForTimeout(intervalMs);
  }
  return await findOrderDetailsFrame(page);
}

// Navigate to the order-entry form THROUGH COL's frameset (not via direct
// goto). Loading Trd_EnterOrder.asp standalone breaks two things proven on
// 2026-05-19:
//   1. The form's onclick / onsubmit handlers reference `parent.*` (e.g.
//      `parent.resetSessionTimer`, `parent.something.location`). When loaded
//      outside the frameset those refs are undefined → click handlers throw
//      → submission silently fails → page re-renders Step 1.
//   2. The `Hid` hidden session-validation token is populated by the parent
//      frame's JS. Without the parent, Hid stays at its HTML default (1
//      char) → server validates POST against an invalid Hid → silently
//      re-renders Step 1.
// Strategy:
//   1. If we're not already on HOME.asp, goto HOME.asp to load the
//      frameset.
//   2. Iterate frames looking for the one that owns getwin (the menu
//      frame, HEADER_NIK_MF.asp). Invoke getwin(41) — COL's own JS routing
//      then loads Trd_EnterOrder.asp into the trade frame *with* the
//      parent context intact.
//   3. Poll for the OrderDetails form to appear across any frame.
//   4. If getwin path fails entirely, fall back to direct goto — the form
//      will load but submission will likely loop on Step 1; we still
//      return ok=true and let the caller surface the post-submit failure
//      to keep diagnostic information flowing.
async function navigateToOrderEntry(page) {
  let base;
  try {
    const cur = new URL(page.url());
    base = `${cur.protocol}//${cur.host}`;
  } catch {
    base = "https://www.colfinancial.com";
  }
  const debug = { base, steps: [] };

  // Step 1: ensure the frameset is loaded. After a successful login the page
  // should already be at HOME.asp (per loggedInUrlPatterns). If we're
  // somewhere else — including if a prior call left us on the bare Trd_
  // EnterOrder.asp — go back to HOME.asp.
  const initialUrl = page.url();
  debug.initial_url = sanitizeUrl(initialUrl);
  const onHome = /\/FINAL2_STARTER\/HOME\/HOME\.asp/i.test(initialUrl);
  if (!onHome) {
    debug.steps.push({ step: "goto_home", url: `${base}/ape/FINAL2_STARTER/HOME/HOME.asp` });
    try {
      const r = await page.goto(`${base}/ape/FINAL2_STARTER/HOME/HOME.asp`, { waitUntil: "domcontentloaded", timeout: 20000 });
      debug.steps[debug.steps.length - 1].response_status = r ? r.status() : null;
      await page.waitForTimeout(3000); // let the frameset's child frames load
    } catch (err) {
      debug.steps[debug.steps.length - 1].error = String(err.message || err).slice(0, 200);
    }
  } else {
    debug.steps.push({ step: "already_on_home" });
  }

  // Step 2: invoke getwin(41) from whichever frame owns it (the menu frame,
  // HEADER_NIK_MF.asp). COL's JS routing then loads Trd_EnterOrder.asp into
  // the trade frame WITH the parent context intact.
  //
  // Poll for getwin availability across all frames — on a fresh post-login
  // HOME.asp page, the menu frame's JS can take 1-5s to attach `getwin` to
  // its window. The earlier single-pass implementation raced this and fell
  // through to the broken direct_goto path with no parent context, leaving
  // Hid_length=1 and parent.resetSessionTimer pageerror events on submit.
  const frameAttempts = [];
  const getwinDeadline = Date.now() + 10000;
  let getwinSucceeded = false;
  let getwinFrameUrl = null;
  while (Date.now() < getwinDeadline && !getwinSucceeded) {
    // Reset per-iteration view of frames; if the frameset rebuilds, the
    // previous handles may be gone.
    for (const frame of page.frames()) {
      const url = sanitizeUrl(frame.url());
      const has = await frame
        .evaluate(() => typeof getwin === "function")
        .catch(() => false);
      if (!has) continue;
      const invoked = await frame
        .evaluate(() => { try { getwin(41); return true; } catch (e) { return String(e.message || e); } })
        .catch((e) => String(e.message || e));
      frameAttempts.push({ url, has_getwin: true, invoke_result: invoked, at_ms: Date.now() });
      if (invoked === true) {
        const formFrame = await waitForOrderDetailsFrame(page, 10000);
        if (formFrame) {
          getwinSucceeded = true;
          getwinFrameUrl = url;
          break;
        }
      }
    }
    if (!getwinSucceeded) await page.waitForTimeout(300);
  }
  if (getwinSucceeded) {
    debug.steps.push({ step: "getwin_succeeded", frame: getwinFrameUrl });
    debug.frame_attempts = frameAttempts;
    return { ok: true, debug };
  }
  // Record the final frame inventory so a failure here surfaces *which*
  // frames existed and whether any ever had getwin during the wait.
  for (const frame of page.frames()) {
    if (!frameAttempts.find((a) => a.url === sanitizeUrl(frame.url()))) {
      frameAttempts.push({ url: sanitizeUrl(frame.url()), has_getwin: false });
    }
  }
  debug.frame_attempts = frameAttempts;
  debug.steps.push({ step: "getwin_no_form_after_poll", elapsed_ms: Date.now() - (getwinDeadline - 10000) });

  // Step 3: fallback — direct goto. Loses the parent context (Hid will be
  // invalid, parent.* refs will throw), but the form at least appears so
  // the caller's post-submit error capture can run and surface the failure.
  for (const candidatePath of ORDER_ENTRY_PATH_CANDIDATES) {
    const attempt = { step: "direct_goto", candidate_path: candidatePath };
    try {
      const response = await page.goto(`${base}${candidatePath}`, { waitUntil: "domcontentloaded", timeout: 20000 });
      attempt.response_status = response ? response.status() : null;
      attempt.response_url = response ? sanitizeUrl(response.url()) : null;
      if (response && response.status() >= 400) {
        debug.steps.push(attempt);
        continue;
      }
      const formFrame = await waitForOrderDetailsFrame(page, 8000);
      if (formFrame) {
        attempt.warning = "form loaded via direct goto — parent.* refs will throw, Hid will be invalid";
        debug.steps.push(attempt);
        return { ok: true, debug };
      }
      attempt.form_found = false;
      attempt.body_excerpt = await page
        .locator("body")
        .innerText({ timeout: 3000 })
        .catch(() => "")
        .then((t) => (t || "").replace(/\s+/g, " ").trim().slice(0, 800));
      const marketClosed = detectMarketClosed(attempt.body_excerpt);
      if (marketClosed) {
        attempt.market_closed_sentinel = marketClosed;
        debug.steps.push(attempt);
        return { ok: false, reason: "market_closed", matched_phrase: marketClosed, debug };
      }
      debug.steps.push(attempt);
    } catch (err) {
      attempt.exception = (err && err.message ? err.message : String(err)).slice(0, 200);
      debug.steps.push(attempt);
    }
  }
  return { ok: false, reason: "order_entry_page_not_reachable", debug };
}

async function findOrderDetailsFrame(page) {
  for (const frame of page.frames()) {
    try {
      const count = await frame.locator('form[name="OrderDetails"]').count();
      if (count > 0) return frame;
    } catch {
      // frame may have detached
    }
  }
  return null;
}

async function snapshotResponsePage(frame) {
  // Capture enough for the LLM to render the preview / confirmation page to
  // the user without leaking the entire DOM. Body excerpt is capped at 4 KB;
  // table-cell text is capped at 200 chars per cell.
  return await frame.evaluate(() => {
    function clean(t) { return (t || "").replace(/\s+/g, " ").trim(); }
    const body = clean(document.body && document.body.innerText).slice(0, 4000);
    const tables = [];
    for (const table of document.querySelectorAll("table")) {
      const rows = [];
      for (const tr of table.querySelectorAll("tr")) {
        const cells = [];
        for (const td of tr.children) {
          if (td.tagName === "TD" || td.tagName === "TH") {
            cells.push(clean(td.innerText).slice(0, 200));
          }
        }
        if (cells.length) rows.push(cells);
      }
      if (rows.length && rows.length <= 30) tables.push(rows);
    }
    const buttons = [];
    for (const el of document.querySelectorAll("input[type='submit'], input[type='button'], button")) {
      buttons.push({
        name: el.getAttribute("name") || null,
        type: el.getAttribute("type") || null,
        value: el.getAttribute("value") || null,
        text: clean(el.value || el.innerText).slice(0, 80)
      });
    }
    return { body_excerpt: body, tables, buttons };
  }).catch(() => ({ body_excerpt: "", tables: [], buttons: [] }));
}

function detectPreviewError(snapshot) {
  const body = (snapshot.body_excerpt || "").toLowerCase();
  for (const phrase of PREVIEW_ERROR_PHRASES) {
    if (body.includes(phrase)) return phrase;
  }
  return null;
}

// Detects the "click happened but page is still Step 1" failure mode.
// Returns the matched sentinel if found, null otherwise. Used by placeOrder
// to refuse to return a fake "dry_run" success when the Preview Order
// click silently failed to advance the wizard.
function detectStuckOnStep1(snapshot) {
  const body = (snapshot.body_excerpt || "").toLowerCase();
  for (const sentinel of STEP1_BODY_SENTINELS) {
    if (body.includes(sentinel)) return sentinel;
  }
  return null;
}

// Pass a raw body string (not a snapshot wrapper). Returns the matched
// phrase or null. Used both inside navigateToOrderEntry (body_excerpt
// captured during attempt) and at the placeOrder layer if needed.
function detectMarketClosed(bodyText) {
  const body = (bodyText || "").toLowerCase();
  for (const sentinel of MARKET_CLOSED_SENTINELS) {
    if (body.includes(sentinel)) return sentinel;
  }
  return null;
}

async function fillOrderForm(formFrame, args) {
  const { symbol, quantity, limit_price, side, order_type, board } = args;
  // Radio selections — use the verified value attributes. .check() will fail
  // loudly if the selector doesn't match anything, surfacing as a thrown
  // error → needs_extractor_update on the caller.
  await formFrame.locator(`input[name="rdBuySell"][value="${BUY_SELL_VALUE[side]}"]`).check();
  await formFrame.locator(`input[name="rdBoard"][value="${board}"]`).check();
  await formFrame.locator(`input[name="rdTerm"][value="${order_type}"]`).check();
  // Text inputs — fill via id selectors (verified id="txtStkSymbol" etc.).
  await formFrame.locator('#txtStkSymbol').fill(String(symbol));
  await formFrame.locator('#txtNumNoShare').fill(String(quantity));
  await formFrame.locator('#txtFloatPrice').fill(String(limit_price));
}

// Click cmdPreview, then check if we actually advanced to Step 2. If not,
// fall back to form.submit() via JS which bypasses onclick handlers.
// CAPTURES Playwright dialog events the whole time — COL's classic-ASP form
// fires JS alert() on validation failure (board-lot violation, tick-size
// mismatch, buying-power edge cases). Playwright auto-dismisses dialogs by
// default, which is what created the original "silent stuck on Step 1"
// failure mode: alert fires → dismissed silently → page stays on Step 1
// → we declare step1_loop with no useful diagnostic. The listener here
// records every dialog message so the caller can surface it.
async function submitOrderPreview(formFrame) {
  // Get the underlying Page so we can attach dialog handlers (frames don't
  // expose .on('dialog')).
  const page = formFrame.page ? formFrame.page() : formFrame._page;
  const dialogs = [];
  const dialogHandler = async (dialog) => {
    dialogs.push({
      type: dialog.type(),
      message: (dialog.message() || "").slice(0, 500),
      default_value: (dialog.defaultValue() || "").slice(0, 200)
    });
    // Dismiss explicitly so the page keeps moving. Don't accept() — accepting
    // a confirm() with garbage could be a write op we don't want.
    await dialog.dismiss().catch(() => {});
  };
  if (page && typeof page.on === "function") {
    page.on("dialog", dialogHandler);
  }

  // Snapshot pre-submit form values — distinguishes "form was filled OK,
  // server rejected" from "fill never landed, server got empties." Critical
  // for diagnosing stepper-widget inputs that store state separately from
  // the underlying <input> element.
  async function snapshotFormState() {
    return await formFrame.evaluate(() => {
      const form = document.forms.OrderDetails || document.querySelector('form[name="OrderDetails"]');
      if (!form) return { found: false };
      const fld = (name) => {
        const el = form.querySelector(`[name="${name}"]`);
        if (!el) return null;
        // For radios, find the checked one in the group
        if (el.type === "radio") {
          const checked = form.querySelector(`[name="${name}"]:checked`);
          return checked ? checked.value : null;
        }
        return el.value;
      };
      return {
        found: true,
        rdBuySell: fld("rdBuySell"),
        rdBoard: fld("rdBoard"),
        rdTerm: fld("rdTerm"),
        txtStkSymbol: fld("txtStkSymbol"),
        txtNumNoShare: fld("txtNumNoShare"),
        txtFloatPrice: fld("txtFloatPrice"),
        Hid_length: (fld("Hid") || "").length,
        txtRecordNo: fld("txtRecordNo")
      };
    }).catch(() => ({ found: false, error: "evaluate failed" }));
  }

  const jsErrors = [];
  const pageerrorHandler = (err) => {
    jsErrors.push((err && err.message ? err.message : String(err)).slice(0, 300));
  };
  if (page && typeof page.on === "function") {
    page.on("pageerror", pageerrorHandler);
  }

  // Poll snapshotResponsePage across the page's frames until at least one
  // returns a body_excerpt of meaningful length, or the window elapses.
  // Returns the best snapshot we saw plus the frame URL it came from.
  // Necessary because Step 2 of 3 takes longer than the fixed 1500ms wait
  // to render on some shards, AND because the submit may navigate a
  // sibling frame (not the formFrame we held).
  async function pollForNonEmptySnapshot(windowMs, minBodyLen = 50) {
    const deadline = Date.now() + windowMs;
    let bestSnapshot = await snapshotResponsePage(formFrame);
    let bestFrameUrl = sanitizeUrl(formFrame.url());
    let bestLen = (bestSnapshot.body_excerpt || "").length;
    while (Date.now() < deadline && bestLen < minBodyLen) {
      await page.waitForTimeout(300);
      // Try the formFrame first; if still empty, scan all frames.
      const candidates = [formFrame, ...page.frames().filter((f) => f !== formFrame)];
      for (const fr of candidates) {
        const snap = await snapshotResponsePage(fr).catch(() => null);
        if (!snap) continue;
        const len = (snap.body_excerpt || "").length;
        if (len > bestLen) {
          bestSnapshot = snap;
          bestFrameUrl = sanitizeUrl(fr.url());
          bestLen = len;
        }
      }
    }
    return { snapshot: bestSnapshot, frame_url: bestFrameUrl, body_len: bestLen };
  }

  try {
    const pre_submit_form_state = await snapshotFormState();

    // First attempt: click cmdPreview. Exercises COL's client-side validation.
    await Promise.all([
      formFrame.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {}),
      formFrame.locator('input[name="cmdPreview"]').click({ timeout: 5000 })
    ]);
    await formFrame.waitForTimeout(1500);

    let polled = await pollForNonEmptySnapshot(5000);
    let snapshot = polled.snapshot;
    if (!detectStuckOnStep1(snapshot)) {
      return {
        snapshot, method: "click", dialogs,
        pre_submit_form_state, js_errors: jsErrors,
        post_submit_frame_url: polled.frame_url,
        post_submit_body_len: polled.body_len
      };
    }

    // Capture post-click form state too — has the page been reset?
    const post_click_form_state = await snapshotFormState();

    // Fallback: form.submit() via JS bypasses onclick handlers entirely.
    await Promise.all([
      formFrame.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {}),
      formFrame.evaluate(() => {
        const form = document.forms.OrderDetails || document.querySelector('form[name="OrderDetails"]');
        if (form) form.submit();
      }).catch(() => null)
    ]);
    await formFrame.waitForTimeout(2000);

    polled = await pollForNonEmptySnapshot(5000);
    snapshot = polled.snapshot;
    return {
      snapshot, method: "form_submit", dialogs,
      pre_submit_form_state, post_click_form_state,
      js_errors: jsErrors,
      post_submit_frame_url: polled.frame_url,
      post_submit_body_len: polled.body_len
    };
  } finally {
    if (page && typeof page.off === "function") {
      page.off("dialog", dialogHandler);
      page.off("pageerror", pageerrorHandler);
    }
  }
}

// Map known COL dialog phrases to a structured reason the LLM can surface
// without paraphrasing. Returns null when no known phrase matches.
// Regexes use `[^.]{0,40}` rather than `.*` because alert messages tend to
// be short single sentences; allowing arbitrary length would let phrases
// from a multi-sentence dialog cross-match. 40 chars lets "Market is
// currently closed" and "Order exceeds available buying power" both match
// without eating into the next sentence.
// Order matters — sell-specific patterns come BEFORE the generic
// "insufficient" pattern that maps to insufficient_buying_power. A
// sell-side dialog like "Insufficient shares" would otherwise be
// misclassified as a buying-power issue.
const DIALOG_PHRASE_REASONS = [
  // "board lot" matches COL's explicit board-lot phrasing; the other two
  // alternatives catch the per-symbol minimum-share alerts (e.g. PGOLD MAIN:
  // "Number of shares must not be less than 100") that don't use the literal
  // phrase but mean the same thing — without these, the order silently falls
  // through to step1_loop_after_preview_click with no useful reason.
  { match: /board\s*lot|must\s+not\s+be\s+less\s+than\s+\d+|minimum\s+of\s+\d+\s+shares/i, reason: "board_lot_violation", hint: "PSE board lots vary by price band. At 50-100 PHP the main-board lot is typically 100 shares; below 5 PHP it can be 1000+. Use board='ODD' for quantities below the main lot." },
  // Sell-side rejections: must be checked before the generic "insufficient"
  // pattern, otherwise "Insufficient shares" would route to buying_power.
  { match: /insufficient\s*shares|no\s*shares\s*available|cannot\s*sell\s*more\s*than|exceed[^.]{0,30}(holdings|position)/i, reason: "insufficient_shares", hint: "You don't hold enough of this symbol to cover the sell. Check your portfolio via get_portfolio to see how many shares you actually own. Short selling is not supported on PSE." },
  { match: /not\s*in\s*your\s*portfolio|no\s*such\s*holding/i, reason: "symbol_not_in_portfolio", hint: "You don't own any shares of this symbol. Sells must come from existing holdings." },
  { match: /buying\s*power|insufficient/i, reason: "insufficient_buying_power", hint: "Order cost exceeds available cash. COL reserves a commission buffer on top of the principal." },
  { match: /tick\s*size|price\s*increment/i, reason: "tick_size_violation", hint: "PSE tick size varies by price band. Adjust limit price to the nearest valid increment." },
  { match: /market[^.]{0,40}(closed|open|hours)/i, reason: "market_closed", hint: "PSE trading hours (PHT): 9:30 AM-12:00 PM and 1:00-3:15 PM, Mon-Fri." },
  { match: /invalid[^.]{0,40}(symbol|stock|ticker)/i, reason: "invalid_symbol", hint: "Symbol not recognized by COL. Check the PSE ticker." },
  { match: /minimum\s*order|too\s*small/i, reason: "minimum_order_violation", hint: "COL has a minimum order value." }
];

function classifyDialogs(dialogs) {
  for (const d of dialogs) {
    const msg = d.message || "";
    for (const rule of DIALOG_PHRASE_REASONS) {
      if (rule.match.test(msg)) return { reason: rule.reason, hint: rule.hint, matched_dialog: d };
    }
  }
  return null;
}

async function placeOrder(page, args = {}) {
  // Defense-in-depth re-validation. MCP-side validator already enforces the
  // schema; this is the worker-direct API safety net (someone could bypass
  // MCP). Keep validation HERE conservative.
  const symbol = String(args.symbol || "").toUpperCase();
  const quantity = Number(args.quantity);
  const limit_price = Number(args.limit_price);
  const side = String(args.side || "").toLowerCase();
  const order_type = String(args.order_type || "DAY").toUpperCase();
  const board = String(args.board || "MAIN").toUpperCase();
  const dry_run = args.dry_run !== false; // default true

  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) {
    throw new Error("invalid symbol: must be uppercase PSE ticker (e.g. 'AC', 'SM', 'ALI')");
  }
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
    throw new Error("invalid quantity: must be a positive integer (PSE trades whole shares)");
  }
  if (!Number.isFinite(limit_price) || limit_price <= 0) {
    throw new Error("invalid limit_price: must be a positive number");
  }
  if (!Object.prototype.hasOwnProperty.call(BUY_SELL_VALUE, side)) {
    throw new Error('invalid side: must be "buy" or "sell"');
  }
  if (!ALLOWED_ORDER_TERMS.has(order_type)) {
    throw new Error(`invalid order_type: must be one of ${[...ALLOWED_ORDER_TERMS].join(", ")}`);
  }
  if (!ALLOWED_BOARDS.has(board)) {
    throw new Error(`invalid board: must be one of ${[...ALLOWED_BOARDS].join(", ")}`);
  }

  const navResult = await navigateToOrderEntry(page);
  if (!navResult.ok) {
    // Distinguish "PSE is closed" from "we can't find the page". The first
    // is a normal end-user condition (PSE trading hours are 9:30 AM - 12:00
    // PM and 1:30 PM - 3:30 PM PHT); the second is a real extractor break.
    if (navResult.reason === "market_closed") {
      return {
        site: "col_financial",
        status: "needs_user_action",
        reason: "market_closed",
        matched_phrase: navResult.matched_phrase,
        next_action: "PSE trading hours (PHT, Mon-Fri): 9:00-9:30 AM pre-open queueing, 9:30 AM-12:00 PM morning session, 12:00-1:00 PM lunch break, 1:00-3:15 PM afternoon session incl. closing auction. Wait for the next session and retry the same place_order call. No order was placed.",
        params: { symbol, quantity, side, limit_price, order_type, board },
        returned_sensitive_data: false
      };
    }
    return {
      site: "col_financial",
      status: "needs_extractor_update",
      reason: navResult.reason || "order_entry_page_not_reachable",
      nav_debug: navResult.debug,
      params: { symbol, quantity, side, limit_price, order_type, board },
      returned_sensitive_data: false
    };
  }
  // Let any in-flight frame swaps from navigateToOrderEntry's getwin(41)
  // settle before locking onto a frame handle. Without this, the handle
  // findOrderDetailsFrame returns can be detached by COL's frameset re-mount
  // before fillOrderForm's first locator call runs — observed as
  // "locator.check: Frame was detached" on the BUY/SELL radio across
  // back-to-back place_order calls in the same session.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

  let formFrame = await findOrderDetailsFrame(page);
  if (!formFrame) {
    const e = new Error("col_financial OrderDetails form not found on order-entry page");
    e.code = "needs_extractor_update";
    throw e;
  }

  // Fill the order form, with one retry on frame-detach. The networkidle
  // wait above covers the typical race, but COL occasionally re-mounts the
  // trade frame mid-fill (header session-timer refresh). On detach we
  // re-acquire the frame and try once more before surfacing the failure.
  try {
    await fillOrderForm(formFrame, { symbol, quantity, limit_price, side, order_type, board });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!/detached|destroyed|cannot find context/i.test(msg)) throw err;
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    formFrame = await findOrderDetailsFrame(page);
    if (!formFrame) {
      const e = new Error("col_financial OrderDetails form not found after frame-detach retry");
      e.code = "needs_extractor_update";
      throw e;
    }
    await fillOrderForm(formFrame, { symbol, quantity, limit_price, side, order_type, board });
  }

  // Submit with click → if still on Step 1, automatically fall back to
  // form.submit() via JS (bypasses any blocking onclick handler).
  // Captures any JS alert() dialogs + pre-submit form values + JS errors.
  const submitResult = await submitOrderPreview(formFrame);
  const previewSnapshot = submitResult.snapshot;
  const submit_method = submitResult.method;
  const dialogs = submitResult.dialogs;
  const errorPhrase = detectPreviewError(previewSnapshot);
  const stuckOnStep1 = detectStuckOnStep1(previewSnapshot);

  if (stuckOnStep1) {
    // Check captured dialogs FIRST.
    const dialogReason = classifyDialogs(dialogs || []);
    if (dialogReason) {
      return {
        site: "col_financial",
        status: "needs_user_action",
        reason: dialogReason.reason,
        hint: dialogReason.hint,
        dialog_message: dialogReason.matched_dialog.message,
        submit_method,
        params: { symbol, quantity, side, limit_price, order_type, board },
        returned_sensitive_data: false
      };
    }
    // Check pre-submit form state. If our fill values are missing at submit
    // time, it's a stepper-widget issue and the LLM/user has a clear next
    // step: re-fill via a different method.
    const fs = submitResult.pre_submit_form_state || {};
    if (fs.found && (!fs.txtNumNoShare || !fs.txtFloatPrice || !fs.txtStkSymbol)) {
      return {
        site: "col_financial",
        status: "needs_extractor_update",
        reason: "fill_did_not_stick",
        submit_method,
        pre_submit_form_state: fs,
        note: "Form values were missing at submit time despite the fill calls completing. The stepper widgets on # of Shares / Price probably hold state separately from the underlying <input>. Switch to .click()+.type() with explicit input/change events.",
        params: { symbol, quantity, side, limit_price, order_type, board },
        returned_sensitive_data: true
      };
    }
    // Detect the parent-context-missing pattern explicitly. Symptoms are:
    //   Hid hidden field stuck at its HTML default (length 1) — would be
    //     >> 1 if COL's parent JS had populated it.
    //   pageerror events naming `resetSessionTimer` / `parent.*` — only
    //     fire when Trd_EnterOrder.asp's handlers can't reach their parent.
    // Both together mean navigateToOrderEntry took the direct_goto fallback
    // path. There's no point telling the LLM "step1 loop" — that suggests a
    // broker validation issue. The real fix is a worker re-nav.
    const ctxState = submitResult.pre_submit_form_state || {};
    const hidStuck = ctxState.found && ctxState.Hid_length === 1;
    const parentErrors = (submitResult.js_errors || []).filter((e) =>
      /resetSessionTimer|parent\.|cannot read properties of undefined/i.test(e)
    );
    if (hidStuck && parentErrors.length > 0) {
      return {
        site: "col_financial",
        status: "needs_extractor_update",
        reason: "frameset_context_missing",
        submit_method,
        nav_debug: navResult.debug,
        pre_submit_form_state: ctxState,
        js_errors: submitResult.js_errors || [],
        note: "navigateToOrderEntry took the direct_goto fallback — the OrderDetails form loaded but outside COL's frameset, so the Hid session-validation token never populated and parent.* refs throw on submit. Worker needs to re-enter via getwin(41). Try again from a fresh login or after a brief delay so the menu frame has time to attach getwin.",
        params: { symbol, quantity, side, limit_price, order_type, board },
        returned_sensitive_data: true
      };
    }
    // Unknown blocker — full diagnostic surface for the maintainer.
    return {
      site: "col_financial",
      status: "needs_extractor_update",
      reason: "step1_loop_after_preview_click",
      sentinel: stuckOnStep1,
      submit_method,
      dialogs_captured: dialogs || [],
      pre_submit_form_state: submitResult.pre_submit_form_state,
      post_click_form_state: submitResult.post_click_form_state,
      js_errors: submitResult.js_errors || [],
      nav_debug: navResult.debug,
      preview: previewSnapshot,
      params: { symbol, quantity, side, limit_price, order_type, board },
      note: "Preview submission did NOT advance to Step 2 via either click() or form.submit(). No dialog, no fill issue. Check js_errors + pre/post_click_form_state + nav_debug to triangulate.",
      returned_sensitive_data: true
    };
  }

  if (errorPhrase) {
    // COL re-rendered Trd_EnterOrder.asp with an error message. Could be
    // insufficient funds, invalid symbol, outside market hours, etc.
    // Surface verbatim — DO NOT proceed to confirm even if dry_run=false.
    return {
      site: "col_financial",
      status: "needs_user_action",
      reason: "preview_error",
      matched_phrase: errorPhrase,
      preview: previewSnapshot,
      params: { symbol, quantity, side, limit_price, order_type, board },
      returned_sensitive_data: true
    };
  }

  // Reject empty-preview as a fake success. Submit advanced past Step 1
  // (otherwise stuck_on_step1 would have caught it above), but the post-
  // submit body is empty — usually a frame race where Step 2 hasn't
  // rendered yet, OR the submit advanced a sibling frame and our
  // formFrame is now blank. The poll inside submitOrderPreview tries
  // hard; if it still came back empty, surface that as needs_extractor_update
  // rather than handing the LLM an empty preview to fake-confirm.
  const previewBodyLen = (previewSnapshot.body_excerpt || "").length;
  if (previewBodyLen < 50) {
    return {
      site: "col_financial",
      status: "needs_extractor_update",
      reason: "preview_page_empty",
      submit_method,
      preview_body_len: previewBodyLen,
      post_submit_frame_url: submitResult.post_submit_frame_url,
      pre_submit_form_state: submitResult.pre_submit_form_state,
      js_errors: submitResult.js_errors || [],
      params: { symbol, quantity, side, limit_price, order_type, board },
      note: "Submission advanced past Step 1 but post-submit page body is empty after 5s of polling. Possibly the preview rendered in a sibling frame we didn't find. Run diagnose_order_preview to dump every frame.",
      returned_sensitive_data: true
    };
  }

  if (dry_run) {
    const previewParsed = parsePreviewSnapshot(previewSnapshot);
    return {
      site: "col_financial",
      status: "dry_run",
      // Normalized order object the LLM can render to the user directly,
      // no body-excerpt scraping required. May be null if COL's preview
      // layout changes — caller should fall back to `preview` in that case.
      order: previewParsed
        ? {
            symbol: previewParsed.symbol || symbol,
            quantity: previewParsed.quantity != null ? previewParsed.quantity : quantity,
            side,
            price: previewParsed.price != null ? previewParsed.price : limit_price,
            board: previewParsed.board || board,
            order_type: previewParsed.order_term || order_type,
            valid_until_pht: previewParsed.valid_until || null,
            gross_amount: previewParsed.gross_amount,
            total_charges: previewParsed.total_charges,
            total_order: previewParsed.total_order,
            fees: {
              commission: previewParsed.fee_commission,
              pse_charge: previewParsed.fee_pse_charge,
              commission_vat: previewParsed.fee_commission_vat,
              dst_charge: previewParsed.fee_dst_charge,
              transfer_fee: previewParsed.fee_transfer,
              stax_charge: previewParsed.fee_stax_charge,
              cancellation_fee: previewParsed.fee_cancellation,
              sccp_charge: previewParsed.fee_sccp_charge
            },
            currency: "PHP"
          }
        : null,
      next_actions: [
        "If the preview looks correct, the user must confirm in plain text.",
        "After explicit user confirmation, call place_order again with the SAME args and dry_run=false to actually submit.",
        "The preview is non-binding — no order has been placed."
      ],
      // Raw snapshot retained for fallback / debug. The LLM should prefer
      // the parsed `order` object above; only fall back here if `order` is null.
      preview: previewSnapshot,
      post_submit_frame_url: submitResult.post_submit_frame_url,
      params: { symbol, quantity, side, limit_price, order_type, board },
      returned_sensitive_data: true
    };
  }

  // dry_run=false: locate the preview-page frame (post_submit_frame_url may
  // be a sibling of formFrame after submit). Search across all frames for
  // the one with a password input — that's authoritative.
  const previewFrame = await findPreviewFrameWithPassword(page);
  if (!previewFrame) {
    return {
      site: "col_financial",
      status: "needs_extractor_update",
      reason: "preview_frame_not_found",
      note: "Preview rendered but no frame had a password input. The Step-2 page may have shifted layout. Re-run diagnose_order_preview to capture the post-Preview-click DOM.",
      preview: previewSnapshot,
      params: { symbol, quantity, side, limit_price, order_type, board },
      returned_sensitive_data: true
    };
  }

  // Fill the password from Infisical-rendered secrets. NEVER returns the
  // password value to the caller; we only ever read+fill.
  const colPassword = readColPassword();
  if (!colPassword) {
    return {
      site: "col_financial",
      status: "needs_extractor_update",
      reason: "col_password_unavailable",
      note: "COL_FINANCIAL_PASSWORD not present in Infisical-rendered secrets. Check the sidecar render and Infisical /sites/col-financial/PASSWORD.",
      preview: previewSnapshot,
      params: { symbol, quantity, side, limit_price, order_type, board },
      returned_sensitive_data: false
    };
  }
  let passwordSelector = null;
  for (const sel of CONFIRM_PASSWORD_SELECTORS) {
    const count = await previewFrame.locator(sel).count().catch(() => 0);
    if (count > 0) { passwordSelector = sel; break; }
  }
  if (!passwordSelector) {
    return {
      site: "col_financial",
      status: "needs_extractor_update",
      reason: "password_field_not_found",
      note: "Preview page had no input matching CONFIRM_PASSWORD_SELECTORS. Layout may have shifted.",
      preview: previewSnapshot,
      params: { symbol, quantity, side, limit_price, order_type, board },
      returned_sensitive_data: true
    };
  }
  try {
    await previewFrame.locator(passwordSelector).first().fill(colPassword);
  } catch (err) {
    return {
      site: "col_financial",
      status: "needs_extractor_update",
      reason: "password_fill_failed",
      error: redactErrorMessage(err),
      params: { symbol, quantity, side, limit_price, order_type, board },
      returned_sensitive_data: false
    };
  }

  // Locate the confirm button on the SAME frame as the password input.
  let confirmSelector = null;
  for (const sel of CONFIRM_BUTTON_SELECTORS) {
    const count = await previewFrame.locator(sel).count().catch(() => 0);
    if (count > 0) { confirmSelector = sel; break; }
  }
  if (!confirmSelector) {
    return {
      site: "col_financial",
      status: "needs_extractor_update",
      reason: "confirm_button_not_found",
      note: "Preview rendered, password filled, but no confirm button matched CONFIRM_BUTTON_SELECTORS. The order is NOT placed.",
      preview: previewSnapshot,
      params: { symbol, quantity, side, limit_price, order_type, board },
      returned_sensitive_data: true
    };
  }

  await Promise.all([
    previewFrame.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {}),
    previewFrame.locator(confirmSelector).click({ timeout: 5000 })
  ]);
  await previewFrame.waitForTimeout(2500);

  const confirmationSnapshot = await snapshotResponsePage(previewFrame);
  const postSubmitError = detectPreviewError(confirmationSnapshot);

  // Build the normalized `order` object by merging Step 2 preview fields
  // (gross / charges / total / fees) with Step 3 confirmation fields
  // (transaction_no / submitted_at). The Step 2 preview is the only place
  // the fee breakdown appears; Step 3 has the transaction number.
  const previewParsed = parsePreviewSnapshot(previewSnapshot) || {};
  const confirmParsed = parseConfirmationSnapshot(confirmationSnapshot) || {};
  const order = postSubmitError
    ? null
    : {
        transaction_no: confirmParsed.transaction_no || null,
        submitted_at: confirmParsed.submitted_at || null, // "M/D/YYYY h:mm:ss AM PHT"
        symbol: confirmParsed.symbol || previewParsed.symbol || symbol,
        quantity: confirmParsed.quantity != null ? confirmParsed.quantity : (previewParsed.quantity != null ? previewParsed.quantity : quantity),
        side,
        price: confirmParsed.price != null ? confirmParsed.price : (previewParsed.price != null ? previewParsed.price : limit_price),
        board: previewParsed.board || board,
        order_type: previewParsed.order_term || order_type,
        valid_until_pht: previewParsed.valid_until || null,
        gross_amount: previewParsed.gross_amount,
        total_charges: previewParsed.total_charges,
        total_order: previewParsed.total_order,
        fees: {
          commission: previewParsed.fee_commission,
          pse_charge: previewParsed.fee_pse_charge,
          commission_vat: previewParsed.fee_commission_vat,
          dst_charge: previewParsed.fee_dst_charge,
          transfer_fee: previewParsed.fee_transfer,
          stax_charge: previewParsed.fee_stax_charge,
          cancellation_fee: previewParsed.fee_cancellation,
          sccp_charge: previewParsed.fee_sccp_charge
        },
        currency: "PHP"
      };

  const next_actions = postSubmitError
    ? [
        `Broker rejected the confirmation step (error phrase: ${postSubmitError}).`,
        "Inspect the `confirmation` payload and surface the error to the user.",
        "No retry — this is a write op; never re-submit without explicit user re-confirmation."
      ]
    : [
        `Order ${order && order.transaction_no ? `#${order.transaction_no} ` : ""}is queued at PSE.`,
        "Verify execution via the COL UI's View/Modify Order screen or a future get_open_orders tool.",
        "To cancel a working order, use COL's View/Modify Order screen — this stack does not yet expose cancel via MCP."
      ];

  return {
    site: "col_financial",
    status: postSubmitError ? "needs_user_action" : "ok",
    write_operation: true,
    // Normalized post-trade summary. Null when status != "ok".
    order,
    next_actions,
    // Raw snapshots retained for debug / fallback. Prefer `order` above.
    confirm_selector: confirmSelector,
    password_selector: passwordSelector,
    confirmation: confirmationSnapshot,
    preview_used_for_fees: previewSnapshot,
    error_phrase: postSubmitError || null,
    params: { symbol, quantity, side, limit_price, order_type, board },
    returned_sensitive_data: true
  };
}

// Helper: find the frame containing the Step-2 password input. Used by the
// dry_run=false path because submission may navigate a sibling frame, so
// the formFrame we started with might no longer have the post-Preview UI.
async function findPreviewFrameWithPassword(page) {
  for (const frame of page.frames()) {
    for (const sel of CONFIRM_PASSWORD_SELECTORS) {
      try {
        const count = await frame.locator(sel).count();
        if (count > 0) return frame;
      } catch { /* frame may have detached */ }
    }
  }
  return null;
}

// Read COL_FINANCIAL_PASSWORD from the worker's Infisical-rendered secrets
// map. Never throws — returns "" if unavailable so the caller can surface
// a clean needs_extractor_update with reason col_password_unavailable.
// Imports the worker module lazily so col_financial.js stays loadable in
// isolation for tests (worker.js's require.main gate keeps it side-effect-
// free when imported as a library).
function readColPassword() {
  try {
    const worker = require("../worker");
    const map = worker.readRenderedSecrets && worker.readRenderedSecrets();
    if (map && map.has("COL_FINANCIAL_PASSWORD")) return map.get("COL_FINANCIAL_PASSWORD") || "";
    return process.env.COL_FINANCIAL_PASSWORD || "";
  } catch {
    return "";
  }
}

// Bring redactErrorMessage in via require for the password_fill_failed path
// (avoids cross-module duplication of the URL-redacting regex).
const { redactErrorMessage } = require("../worker");

// Diagnostic: runs the place_order fill + click-Preview flow with caller-
// supplied parameters, then dumps the resulting preview page's full DOM —
// forms, inputs, buttons, body excerpt — WITHOUT clicking any confirm
// button. Used to capture the real preview-page selectors when
// CONFIRM_BUTTON_SELECTORS misses (which is the only way place_order with
// dry_run=false can return confirm_button_not_found).
//
// SAFETY: This is gated behind BROWSER_INTENT_ENABLE_DIAGNOSTICS so the
// LLM doesn't see it in normal operation, AND it never proceeds past the
// preview step — no order is placed. The fill itself is harmless because
// COL's Preview Order step does not reserve or commit; it just renders.
async function diagnoseOrderPreview(page, args = {}) {
  // Re-validate args inline (mirrors placeOrder; the MCP-side validator
  // already enforced the schema for HTTP callers, but defense-in-depth
  // for direct /extract callers).
  const symbol = String(args.symbol || "").toUpperCase();
  const quantity = Number(args.quantity);
  const limit_price = Number(args.limit_price);
  const side = String(args.side || "").toLowerCase();
  const order_type = String(args.order_type || "DAY").toUpperCase();
  const board = String(args.board || "MAIN").toUpperCase();

  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) throw new Error("invalid symbol");
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) throw new Error("invalid quantity");
  if (!Number.isFinite(limit_price) || limit_price <= 0) throw new Error("invalid limit_price");
  if (!Object.prototype.hasOwnProperty.call(BUY_SELL_VALUE, side)) throw new Error("invalid side");
  if (!ALLOWED_ORDER_TERMS.has(order_type)) throw new Error("invalid order_type");
  if (!ALLOWED_BOARDS.has(board)) throw new Error("invalid board");

  const navResult = await navigateToOrderEntry(page);
  if (!navResult.ok) {
    return {
      site: "col_financial",
      status: navResult.reason === "market_closed" ? "needs_user_action" : "needs_extractor_update",
      diagnostic: true,
      reason: navResult.reason || "order_entry_page_not_reachable",
      matched_phrase: navResult.matched_phrase || null,
      nav_debug: navResult.debug,
      returned_sensitive_data: false
    };
  }
  const formFrame = await findOrderDetailsFrame(page);
  if (!formFrame) {
    return {
      site: "col_financial",
      status: "needs_extractor_update",
      diagnostic: true,
      reason: "OrderDetails_form_not_found",
      page_state: {
        url: sanitizeUrl(page.url()),
        frame_urls: page.frames().map((f) => sanitizeUrl(f.url()))
      },
      returned_sensitive_data: false
    };
  }

  // Capture pre-click state so we can diff against post-click.
  const url_before = sanitizeUrl(formFrame.url());
  const main_url_before = sanitizeUrl(page.url());
  const frame_urls_before = page.frames().map((f) => sanitizeUrl(f.url()));

  // Capture form metadata BEFORE submission — surface the onclick/onsubmit
  // attributes that may be intercepting the click, plus the Hid value
  // prefix (first 8 chars) so we can tell whether the session token rolled.
  const form_before = await frameFormsDump(formFrame).catch(() => []);
  const form_handlers = await formFrame.evaluate(() => {
    const out = [];
    for (const form of document.querySelectorAll("form")) {
      const handlers = {
        form_onsubmit: form.getAttribute("onsubmit") || null,
        form_name: form.getAttribute("name") || null
      };
      const submitButtons = [];
      for (const el of form.querySelectorAll("input[type='submit'], button[type='submit']")) {
        submitButtons.push({
          name: el.getAttribute("name") || null,
          value: el.getAttribute("value") || null,
          onclick: (el.getAttribute("onclick") || "").slice(0, 300)
        });
      }
      handlers.submit_buttons = submitButtons;
      const hidEl = form.querySelector("input[name='Hid']");
      if (hidEl) {
        const v = hidEl.value || "";
        handlers.hid_length = v.length;
        handlers.hid_prefix = v.slice(0, 8);
      }
      out.push(handlers);
    }
    return out;
  }).catch(() => []);

  // Capture console messages during the click — JS errors here are the
  // smoking gun for "onclick threw on parent.* refs" hypothesis.
  const console_messages = [];
  const consoleHandler = (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      console_messages.push({ type: msg.type(), text: msg.text().slice(0, 200) });
    }
  };
  page.on("console", consoleHandler);

  await fillOrderForm(formFrame, { symbol, quantity, limit_price, side, order_type, board });

  const submitResult2 = await submitOrderPreview(formFrame);
  const snapshot = submitResult2.snapshot;
  const submit_method = submitResult2.method;
  const submit_dialogs = submitResult2.dialogs;
  const submit_pre_form_state = submitResult2.pre_submit_form_state;
  const submit_post_click_form_state = submitResult2.post_click_form_state;
  const submit_js_errors = submitResult2.js_errors || [];

  page.off("console", consoleHandler);

  const url_after = sanitizeUrl(formFrame.url());
  const main_url_after = sanitizeUrl(page.url());
  const frame_urls_after = page.frames().map((f) => sanitizeUrl(f.url()));

  // Full DOM dump of the preview page — same snapshot helper place_order
  // uses, plus a rich form summary so a maintainer can see button names
  // and input metadata directly.
  const preview_frame_forms = await frameFormsDump(formFrame).catch(() => []);
  const error_phrase = detectPreviewError(snapshot);
  const stuck_on_step1 = detectStuckOnStep1(snapshot);

  return {
    site: "col_financial",
    status: "ok",
    diagnostic: true,
    submitted_params: { symbol, quantity, side, limit_price, order_type, board },
    nav_diagnostics: {
      url_before,
      url_after,
      url_changed: url_before !== url_after,
      main_url_before,
      main_url_after,
      frame_count_before: frame_urls_before.length,
      frame_count_after: frame_urls_after.length,
      frame_urls_before,
      frame_urls_after
    },
    form_handlers_before_click: form_handlers,
    form_metadata_before_click: form_before,
    console_messages_during_click: console_messages,
    error_phrase_detected: error_phrase,
    stuck_on_step1,
    submit_method,
    submit_dialogs,
    submit_pre_form_state,
    submit_post_click_form_state,
    submit_js_errors,
    classified_dialog: classifyDialogs(submit_dialogs || []),
    preview: snapshot,
    preview_forms: preview_frame_forms,
    note: "This is the post-Preview-Order DOM. Look at stuck_on_step1 and console_messages_during_click first — if either is set, the form submission didn't advance to Step 2 (usually a parent.* ref error from running outside the frameset). Otherwise use preview_forms[*].buttons[*] to identify the confirm button. NO ORDER WAS PLACED.",
    returned_sensitive_data: false
  };
}

// Rich form metadata for a single frame — mirrors what summarizeFrameForms
// does in diagnoseOrderForm but takes a frame directly (already located).
async function frameFormsDump(frame) {
  return await frame.evaluate(() => {
    function attr(el, name) {
      const v = el.getAttribute(name);
      return v === null ? null : v.slice(0, 200);
    }
    const out = [];
    for (const form of document.querySelectorAll("form")) {
      const inputs = [];
      const STRUCTURAL = new Set(["radio", "checkbox", "submit", "button", "image", "reset"]);
      for (const el of form.querySelectorAll("input")) {
        const type = (attr(el, "type") || "text").toLowerCase();
        const entry = {
          name: attr(el, "name"),
          id: attr(el, "id"),
          type,
          disabled: el.disabled,
          readonly: el.readOnly,
          value_class: el.value ? (/^[\d.,\s-]+$/.test(el.value) ? "numeric" : "non-empty") : "empty"
        };
        if (STRUCTURAL.has(type)) {
          entry.value = attr(el, "value");
          entry.checked = !!el.checked;
        }
        inputs.push(entry);
      }
      const buttons = [];
      for (const el of form.querySelectorAll("button, input[type='submit'], input[type='button']")) {
        buttons.push({
          tag: el.tagName.toLowerCase(),
          type: attr(el, "type"),
          name: attr(el, "name"),
          id: attr(el, "id"),
          value: attr(el, "value"),
          text: (el.innerText || el.value || "").replace(/\s+/g, " ").trim().slice(0, 80),
          disabled: el.disabled
        });
      }
      out.push({
        action: form.getAttribute("action") || "",
        method: (form.getAttribute("method") || "get").toLowerCase(),
        name: attr(form, "name"),
        id: attr(form, "id"),
        inputs,
        buttons
      });
    }
    return out;
  }).catch(() => []);
}

async function diagnoseOrderForm(page) {
  // Post-login dump. Like diagnosePortfolio, we do NOT pre-navigate to a
  // guessed URL — the trade page is invariably reached via a menu item
  // whose target we don't know yet; that's what this dump is for.
  await page.waitForTimeout(1000);

  const landingUrl = sanitizeUrl(page.url());

  // 1. Always surface candidate trade-link entries in the landing's nav.
  const tradeLinks = await collectAllFrameTradeLinks(page);

  // 2. Best-effort: click a trade-link so the form dump below targets the
  //    resulting page. If no label matches, the form dump still runs on the
  //    landing — useful when the order entry is already visible (some COL
  //    layouts render a trade panel directly on the dashboard).
  const activation = await tryActivateTradeLink(page).catch(() => null);

  // 3. Dump form metadata across every frame. Multiple frames are normal
  //    on COL's classic-ASP layout (menu frame, main frame, footer); only
  //    the one whose form has buy/sell/quantity selectors is the target.
  const frame_forms = await collectAllFrameForms(page);

  return {
    site: "col_financial",
    status: "ok",
    diagnostic: true,
    landing_url: landingUrl,
    trade_link_candidates: tradeLinks,
    activation, // { clicked_label, frame_url } | null
    frame_forms,
    returned_sensitive_data: false
  };
}

// Post-trading-day "acknowledge receipt of confirmation" overlay handling.
//
// After a trading day with executed orders, COL gates the next login behind a
// password-protected acknowledgment screen listing every fill. The post-login
// URL still matches loggedInUrlPatterns, so login.js correctly flags it via
// pendingActionSignals as needs_user_action / pending_trade_acknowledgment.
// These two functions let the agent fetch the trade list for user approval
// and (only after explicit approval) clear the overlay so downstream tools
// like get_portfolio and place_order can actually transact.
//
// Design constraints:
//  - get_pending_acknowledgment is read-only and SAFE — never clicks anything.
//  - submit_acknowledgment requires the caller to echo back the trade count
//    AND the grand total. The worker re-reads the page right before
//    submitting and refuses if either has changed (anti-race: a new fill
//    landing between read and submit would silently get acknowledged
//    otherwise).
//  - A high-value gate (BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD, default
//    100000 PHP) refuses by default for totals above the threshold unless
//    bypass_high_value=true is explicitly passed. Cheap insurance against a
//    bug or hostile LLM acknowledging a 7-figure sale silently.

const ACK_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name*="pass" i]:not([type="hidden"])'
];

// The visible ack button reads "Type Your Password and Click Here to
// Acknowledge". COL's HTML for these buttons is usually input type=button
// with a long value attribute, but defensive selectors handle a few common
// renderings (button text, type=submit fallback).
const ACK_BUTTON_SELECTORS = [
  'input[type="button"][value*="Acknowledge" i]',
  'input[type="submit"][value*="Acknowledge" i]',
  'button:has-text("Acknowledge")',
  'input[value*="Click Here to Acknowledge" i]'
];

// Body-text sentinels that distinguish the ack overlay from any other
// password-prompting page. Used to confirm we're parsing the right thing
// before classifying rows as transactions.
const ACK_PAGE_SENTINELS = [
  "acknowledge receipt of confirmation",
  "type your password and click here to acknowledge",
  "please review your previous transactions"
];

// Defaults to PHP 100,000. Overridable via env so ops can tune per deployment
// without a worker code change.
function ackHighValueThreshold() {
  const raw = Number(process.env.BROWSER_INTENT_ACK_HIGH_VALUE_THRESHOLD);
  return Number.isFinite(raw) && raw > 0 ? raw : 100000;
}

// Walks every frame and the top page to find the one that contains the ack
// password input. The overlay typically renders in the main content frame
// (the same frameset that hosts HOME.asp), but a single-page render is also
// possible if COL ever flattens the layout. Returns a Locator context
// (either a Frame or a Page) — both support .locator() / .innerText().
async function findAckContext(page) {
  const isAckBody = (text) => {
    const n = (text || "").toLowerCase();
    return ACK_PAGE_SENTINELS.some((s) => n.includes(s));
  };
  // Try the top page first — most COL ack screens render on HOME.asp itself
  // without inner frames.
  try {
    const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    if (isAckBody(text)) {
      for (const sel of ACK_PASSWORD_SELECTORS) {
        if (await page.locator(sel).count().catch(() => 0)) return page;
      }
    }
  } catch { /* fall through */ }
  // Then frames, in case the ack lives inside a content frame.
  for (const frame of page.frames()) {
    try {
      const text = await frame.locator("body").innerText({ timeout: 2000 }).catch(() => "");
      if (!isAckBody(text)) continue;
      for (const sel of ACK_PASSWORD_SELECTORS) {
        if (await frame.locator(sel).count().catch(() => 0)) return frame;
      }
    } catch { /* frame may have detached */ }
  }
  return null;
}

// Parse the trade table from raw row arrays. Pure function — no DOM access —
// so it's directly unit-testable.
//
// Input: rows = Array<Array<string>> where each inner array is the cells of
// one <tr> in the trade table (post-trim, may include empty strings).
//
// COL's table interleaves three row types:
//   transaction:    [N, SYMBOL, "5/22/2026 2:50:02 PM", ticket, qty, ?, price, total]
//   per-symbol sub: ["", SYMBOL, "", "TOTAL", qty_sum, "", "", value_sum]
//                   OR: ["", "", "", ticket_repeat, qty_sum, "", "", value_sum]
//   grand total:    ["SELLING TOTAL" | "BUYING TOTAL", "", "TOTAL", "", "", "", value]
//
// Classification heuristics:
//  - "TOTAL" appearing as a non-numeric cell in row → subtotal/footer
//  - "SELLING TOTAL" / "BUYING TOTAL" → grand-total footer
//  - Otherwise: treat as a transaction if row has a parseable date column AND
//    a parseable numeric amount in the last cell.
function parseAcknowledgmentTable(rows) {
  const trades = [];
  const subtotals = [];
  let grand_total = null;
  let summary_label = null;
  let currency = "PHP";

  for (const row of rows) {
    if (!row || row.length === 0) continue;
    const cells = row.map((c) => (c == null ? "" : String(c).trim()));
    const joined = cells.join(" ").toUpperCase();

    // Grand total: row contains "SELLING TOTAL" or "BUYING TOTAL"
    if (/\b(SELLING|BUYING)\s+TOTAL\b/.test(joined)) {
      const totalCell = [...cells].reverse().find((c) => parseNumber(c) !== null);
      const val = parseNumber(totalCell);
      if (val !== null) {
        grand_total = val;
        summary_label = /SELLING/.test(joined) ? "SELLING TOTAL" : "BUYING TOTAL";
      }
      continue;
    }

    // Per-symbol subtotal: row contains the word "TOTAL" but isn't the grand total.
    // Capture symbol + total amount when both are derivable.
    if (cells.some((c) => /^TOTAL$/i.test(c))) {
      const sym = cells.find((c) => /^[A-Z][A-Z0-9.]{0,9}$/.test(c));
      const totalCell = [...cells].reverse().find((c) => parseNumber(c) !== null);
      const val = parseNumber(totalCell);
      if (val !== null) subtotals.push({ symbol: sym || null, total: val });
      continue;
    }

    // Transaction candidate: needs an A-Z symbol, a date-looking cell, AND a
    // trailing numeric amount.
    const symbol = cells.find((c) => /^[A-Z][A-Z0-9.]{0,9}$/.test(c));
    const timeCell = cells.find((c) => /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}.*\d{1,2}:\d{2}/.test(c));
    const amountCell = [...cells].reverse().find((c) => parseNumber(c) !== null && /[\d,]+\.\d{2}/.test(c));
    if (!symbol || !timeCell || amountCell === undefined) continue;

    const amount = parseNumber(amountCell);
    if (amount === null) continue;

    // Quantity + price: POSITIONAL extraction from the ticket cell. COL's
    // table renders columns in a fixed order — row#, symbol, time, ticket,
    // qty, price, (empty), total — so qty is always at ticket_idx+1 and
    // price at ticket_idx+2. Regex-based "find any small integer" would
    // otherwise pick up the row-number cell (1, 2, 3...) instead of qty.
    const ticketIdx = cells.findIndex((c) => /^\d{10,}$/.test(c));
    const ticket = ticketIdx >= 0 ? cells[ticketIdx] : null;

    let qty = null;
    let price = null;
    if (ticketIdx >= 0) {
      const qtyCandidate = cells[ticketIdx + 1];
      if (qtyCandidate && /^\d{1,9}$/.test(qtyCandidate)) {
        qty = Number.parseInt(qtyCandidate, 10);
      }
      const priceCandidate = cells[ticketIdx + 2];
      if (priceCandidate && /^\d+(?:\.\d+)?$/.test(priceCandidate)) {
        const p = parseNumber(priceCandidate);
        if (p !== null && p !== amount) price = p;
      }
    }

    trades.push({
      symbol,
      time: timeCell,
      ticket,
      qty,
      price,
      amount
    });
  }

  return {
    trade_count: trades.length,
    trades,
    subtotals,
    grand_total,
    summary_label,
    currency
  };
}

// Read every <table> row in the ack context, defensively. Returns
// Array<Array<string>>.
async function readAckRows(context) {
  return context
    .evaluate(() => {
      // Use the deepest table that has at least 4 transaction-like rows, so
      // we don't accidentally read a layout/wrapper table.
      const tables = Array.from(document.querySelectorAll("table"));
      let best = null;
      let bestScore = 0;
      for (const t of tables) {
        const trs = Array.from(t.querySelectorAll(":scope > tbody > tr, :scope > tr"));
        // Score: count rows that contain a date-looking cell AND an amount-looking cell.
        let score = 0;
        for (const tr of trs) {
          const txt = Array.from(tr.children).map((td) => (td.innerText || "").trim());
          const hasDate = txt.some((c) => /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}.*\d{1,2}:\d{2}/.test(c));
          const hasMoney = txt.some((c) => /[\d,]+\.\d{2}/.test(c));
          if (hasDate && hasMoney) score += 1;
        }
        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }
      if (!best) return [];
      const trs = Array.from(best.querySelectorAll("tr"));
      return trs.map((tr) =>
        Array.from(tr.children).map((td) => (td.innerText || "").replace(/\s+/g, " ").trim())
      );
    })
    .catch(() => []);
}

async function getPendingAcknowledgment(page /* , args */) {
  const ctx = await findAckContext(page);
  if (!ctx) {
    return {
      site: "col_financial",
      status: "needs_user_action",
      reason: "no_pending_acknowledgment",
      next_action: "No COL trade-acknowledgment overlay was detected. If you expected one, the session may already be past the ack (call check_session) or the page layout changed (call diagnose_member_portal for structure).",
      returned_sensitive_data: false
    };
  }

  const rows = await readAckRows(ctx);
  const parsed = parseAcknowledgmentTable(rows);

  if (parsed.trade_count === 0 || parsed.grand_total === null) {
    const e = new Error("col_financial ack overlay detected but trade table could not be parsed");
    e.code = "needs_extractor_update";
    throw e;
  }

  return {
    site: "col_financial",
    status: "ok",
    pending: parsed,
    returned_sensitive_data: false
  };
}

async function submitAcknowledgment(page, args = {}) {
  const expectedCount = Number(args.confirm_trade_count);
  const expectedTotal = Number(args.confirm_total_value);
  const bypassHighValue = args.bypass_high_value === true;

  if (!Number.isFinite(expectedCount) || expectedCount <= 0 || !Number.isInteger(expectedCount)) {
    throw new Error("invalid confirm_trade_count: must be a positive integer matching what get_pending_acknowledgment returned");
  }
  if (!Number.isFinite(expectedTotal) || expectedTotal <= 0) {
    throw new Error("invalid confirm_total_value: must be a positive number matching what get_pending_acknowledgment returned");
  }

  const ctx = await findAckContext(page);
  if (!ctx) {
    return {
      site: "col_financial",
      status: "needs_user_action",
      reason: "no_pending_acknowledgment",
      next_action: "No COL trade-acknowledgment overlay was detected on the current page. The session may already be past the ack — call check_session or login to refresh state. No password was filled, no button was clicked.",
      returned_sensitive_data: false
    };
  }

  // Re-read the table RIGHT NOW so we compare the caller's confirmation
  // against what's actually on the page (not what get_pending_acknowledgment
  // saw seconds ago — COL may have added a new fill in the interim).
  const rows = await readAckRows(ctx);
  const observed = parseAcknowledgmentTable(rows);

  if (observed.trade_count === 0 || observed.grand_total === null) {
    const e = new Error("col_financial ack overlay re-read returned an unparseable table");
    e.code = "needs_extractor_update";
    throw e;
  }

  // Tolerance: cents-level equality. Use a small epsilon to absorb the float
  // round-trip through JSON.
  const totalsMatch = Math.abs(observed.grand_total - expectedTotal) < 0.005;
  const countsMatch = observed.trade_count === expectedCount;

  if (!totalsMatch || !countsMatch) {
    return {
      site: "col_financial",
      status: "needs_user_action",
      reason: "acknowledgment_changed",
      next_action: "The COL ack page no longer matches what the caller approved (a new fill landed, or the previous read was stale). Call get_pending_acknowledgment again to fetch the current trade list, present it to the user for re-approval, then retry submit_acknowledgment with the updated counts. NO password was filled, NO button was clicked.",
      expected: { trade_count: expectedCount, total_value: expectedTotal },
      observed: { trade_count: observed.trade_count, total_value: observed.grand_total },
      returned_sensitive_data: false
    };
  }

  const threshold = ackHighValueThreshold();
  if (observed.grand_total > threshold && !bypassHighValue) {
    return {
      site: "col_financial",
      status: "needs_user_action",
      reason: "high_value_acknowledgment",
      next_action: `Total value ${observed.grand_total.toFixed(2)} ${observed.currency} exceeds the safety threshold (${threshold.toFixed(2)} ${observed.currency}). Re-confirm with the user that they understand the magnitude, then retry with bypass_high_value=true. NO password was filled, NO button was clicked.`,
      threshold,
      observed_total: observed.grand_total,
      returned_sensitive_data: false
    };
  }

  const colPassword = readColPassword();
  if (!colPassword) {
    const e = new Error("COL_FINANCIAL_PASSWORD not available from secrets — cannot fill ack password field");
    e.code = "needs_extractor_update";
    throw e;
  }

  // Locate the password input + ack button before doing anything destructive.
  let passwordSel = null;
  for (const sel of ACK_PASSWORD_SELECTORS) {
    if (await ctx.locator(sel).count().catch(() => 0)) {
      passwordSel = sel;
      break;
    }
  }
  if (!passwordSel) {
    const e = new Error("ack password input not found");
    e.code = "needs_extractor_update";
    throw e;
  }

  let ackButton = null;
  for (const sel of ACK_BUTTON_SELECTORS) {
    const count = await ctx.locator(sel).count().catch(() => 0);
    if (count > 0) {
      ackButton = ctx.locator(sel).first();
      break;
    }
  }
  if (!ackButton) {
    const e = new Error("ack 'Acknowledge' button not found");
    e.code = "needs_extractor_update";
    throw e;
  }

  // Fill password — wrapped so a fill failure (e.g. detached frame) surfaces
  // as a clean status rather than a raw redacted-error string.
  try {
    await ctx.locator(passwordSel).first().fill(colPassword);
  } catch (err) {
    return {
      site: "col_financial",
      status: "needs_extractor_update",
      reason: "password_fill_failed",
      detail: redactErrorMessage(err),
      returned_sensitive_data: false
    };
  }

  // Click and wait for the page to settle. Use networkidle with a generous
  // timeout — the ack POST may redirect through the shard host before
  // landing on the real logged-in dashboard.
  await Promise.allSettled([
    page.waitForLoadState("networkidle", { timeout: 15000 }),
    ackButton.click()
  ]);

  // Verify we're past the ack: the body should no longer contain ack sentinels.
  const postBody = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  const stillOnAck = ACK_PAGE_SENTINELS.some((s) => postBody.toLowerCase().includes(s));
  if (stillOnAck) {
    return {
      site: "col_financial",
      status: "needs_user_action",
      reason: "acknowledgment_not_cleared",
      next_action: "Password was submitted but the ack overlay is still showing. Possible causes: wrong password in secrets, server rejected the submission, or the table changed mid-flight. Call get_pending_acknowledgment to recheck and retry.",
      returned_sensitive_data: false
    };
  }

  return {
    site: "col_financial",
    status: "acknowledged",
    cleared: {
      trade_count: observed.trade_count,
      total_value: observed.grand_total,
      currency: observed.currency,
      summary_label: observed.summary_label
    },
    returned_sensitive_data: false
  };
}

module.exports = {
  getPortfolio,
  diagnosePortfolio,
  diagnoseOrderForm,
  diagnoseOrderPreview,
  getPendingAcknowledgment,
  submitAcknowledgment,
  placeOrder,
  // Test-only:
  parseNumber,
  matchHeaderColumn,
  normalize,
  round,
  detectPreviewError,
  detectStuckOnStep1,
  detectMarketClosed,
  classifyDialogs,
  DIALOG_PHRASE_REASONS,
  parsePreviewSnapshot,
  parseConfirmationSnapshot,
  PREVIEW_PATTERNS,
  CONFIRMATION_PATTERNS,
  STEP1_BODY_SENTINELS,
  MARKET_CLOSED_SENTINELS,
  CONFIRM_PASSWORD_SELECTORS,
  BUY_SELL_VALUE,
  ALLOWED_ORDER_TERMS,
  ALLOWED_BOARDS,
  PREVIEW_ERROR_PHRASES,
  CONFIRM_BUTTON_SELECTORS,
  parseAcknowledgmentTable,
  ackHighValueThreshold,
  ACK_PAGE_SENTINELS,
  ACK_PASSWORD_SELECTORS,
  ACK_BUTTON_SELECTORS
};
