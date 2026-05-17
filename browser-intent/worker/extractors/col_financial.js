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
// parent.frames['main'] to ../trading_PCA3/As_CashBalStockPos.asp. Legacy
// Final2 paths are kept as fallback for sessions still on the old layout.
const PORTFOLIO_PATH_CANDIDATES = [
  "/ape/FINAL2_STARTER/trading_PCA3/As_CashBalStockPos.asp",
  "/ape/Final2/main/PORTFOLIO_t.asp"
];

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
  for (const frame of frames) {
    rawHoldings = await findAndExtractRawHoldings(frame, HEADER_MATCHERS).catch(() => null);
    if (rawHoldings) break;
  }
  if (!rawHoldings) {
    const error = new Error("col_financial portfolio table not found");
    error.code = "needs_extractor_update";
    throw error;
  }

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

  if (!holdings.length) {
    return {
      site: "col_financial",
      status: "ok",
      as_of: new Date().toISOString(),
      currency: "PHP",
      holdings: [],
      totals: { market_value: 0, cost_basis: 0, unrealized_pnl: 0, unrealized_pnl_pct: 0 },
      returned_sensitive_data: true
    };
  }

  const totalMarketValue = holdings.reduce((sum, h) => sum + h.market_value, 0);
  const totalCostBasis = holdings.reduce((sum, h) => sum + h.quantity * h.average_cost, 0);
  const totalUnrealizedPnl = totalMarketValue - totalCostBasis;
  const totalUnrealizedPnlPct = totalCostBasis !== 0 ? (totalUnrealizedPnl / totalCostBasis) * 100 : 0;

  return {
    site: "col_financial",
    status: "ok",
    as_of: new Date().toISOString(),
    currency: "PHP",
    holdings,
    totals: {
      market_value: round(totalMarketValue, 2),
      cost_basis: round(totalCostBasis, 2),
      unrealized_pnl: round(totalUnrealizedPnl, 2),
      unrealized_pnl_pct: round(totalUnrealizedPnlPct, 2)
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

module.exports = {
  getPortfolio,
  diagnosePortfolio,
  // Test-only:
  parseNumber,
  matchHeaderColumn,
  normalize,
  round
};
