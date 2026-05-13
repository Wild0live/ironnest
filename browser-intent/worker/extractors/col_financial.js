// COL Financial post-login extractors.
//
// COL's post-login portal ("AccessPlus", paths under /ape/Final2/) is a frame-based
// classic-ASP webapp. Portfolio data lives inside an iframe; this extractor scans
// every accessible frame for a holdings table whose header matches the expected
// column names. That makes the extractor resilient to small DOM tweaks but also
// dependent on COL's column wording — if the headers change we throw, the worker
// returns needs_extractor_update, and a human updates HEADER_MATCHERS below.

const PORTFOLIO_URL_CANDIDATES = [
  "https://www.colfinancial.com/ape/Final2/main/PORTFOLIO_t.asp",
  "https://www.colfinancial.com/ape/Final2/home_p.asp",
  "https://www.colfinancial.com/ape/Final2/"
];

const HEADER_MATCHERS = {
  symbol: ["stock", "symbol", "code", "name"],
  quantity: ["shares", "quantity", "qty", "total shares"],
  averageCost: ["ave price", "avg price", "average price", "average cost", "ave cost"],
  lastPrice: ["last price", "current price", "market price", "last"],
  marketValue: ["market value", "total value", "value"]
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
    const idx = normalized.findIndex((h) => candidates.some((c) => h.includes(c)));
    if (idx === -1) return null;
    out[field] = idx;
  }
  return out;
}

async function findHoldingsTable(frame) {
  const tables = await frame.locator("table").all().catch(() => []);
  for (const table of tables) {
    const headerCells = await table
      .locator("tr")
      .first()
      .locator("th, td")
      .allInnerTexts()
      .catch(() => []);
    if (headerCells.length < 3) continue;
    const columnMap = matchHeaderColumn(headerCells);
    if (columnMap) return { table, columnMap };
  }
  return null;
}

async function extractRows(table, columnMap) {
  const rowLocators = await table.locator("tr").all();
  const holdings = [];
  for (let i = 1; i < rowLocators.length; i++) {
    const cells = await rowLocators[i].locator("td").allInnerTexts().catch(() => []);
    if (!cells.length) continue;

    const symbolRaw = cells[columnMap.symbol];
    const symbol = normalize(symbolRaw).toUpperCase().split(" ")[0];
    if (!symbol || symbol.length > 10) continue;

    const quantity = parseNumber(cells[columnMap.quantity]);
    const averageCost = parseNumber(cells[columnMap.averageCost]);
    const lastPrice = parseNumber(cells[columnMap.lastPrice]);
    const marketValueRaw = parseNumber(cells[columnMap.marketValue]);
    if (quantity === null || averageCost === null || lastPrice === null) continue;

    const marketValue = marketValueRaw !== null ? marketValueRaw : quantity * lastPrice;
    const costBasis = quantity * averageCost;
    const unrealizedPnl = marketValue - costBasis;
    const unrealizedPnlPct = costBasis !== 0 ? (unrealizedPnl / costBasis) * 100 : 0;

    holdings.push({
      symbol,
      quantity,
      average_cost: round(averageCost, 4),
      last_price: round(lastPrice, 4),
      market_value: round(marketValue, 2),
      unrealized_pnl: round(unrealizedPnl, 2),
      unrealized_pnl_pct: round(unrealizedPnlPct, 2)
    });
  }
  return holdings;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function tryNavigate(page) {
  for (const url of PORTFOLIO_URL_CANDIDATES) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1500);
      return;
    } catch {
      // Try the next candidate.
    }
  }
}

async function getPortfolio(page) {
  await tryNavigate(page);

  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  let found = null;
  for (const frame of frames) {
    found = await findHoldingsTable(frame).catch(() => null);
    if (found) break;
  }
  if (!found) {
    const error = new Error("col_financial portfolio table not found");
    error.code = "needs_extractor_update";
    throw error;
  }

  const holdings = await extractRows(found.table, found.columnMap);
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

module.exports = { getPortfolio, diagnosePortfolio };
