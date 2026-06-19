---
name: pse-edge-disclosures
description: "Pull and read a PSE-listed company's official disclosures from PSE EDGE (edge.pse.com.ph) — material news, dividends, suspensions, block sales, results — to satisfy the 'clean disclosures' leg of the three-filter gate before proposing a trade."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [trading, pse, disclosures, edge, due-diligence, risk]
    related_skills: [public-market-quote-checks, merx-pse-yahoo-fallbacks]
---

# PSE EDGE Disclosure Check

## When to use

Run this **before** proposing any entry, and when re-evaluating a held position.
The Stock leg of your three-filter gate requires *"clean disclosures"* — this is
how you verify that. Use it when:

- about to propose a trade on a PSE name (mandatory pre-trade DD)
- a stock gaps or spikes on no obvious technical trigger (look for the disclosure)
- checking for ex-dividend dates, stock/rights offerings, or block sales that change
  the setup
- a name is on **trading suspension** or under a disclosure-related halt (never
  propose an entry into a suspended ticker)

PSE EDGE (`edge.pse.com.ph`, the official disclosure system) is reachable from this
container through the Squid egress proxy. Use `curl`; fall back to the `browser`
toolset for JS-rendered views.

## What to look for (disclosure types that move the gate)

Order by trade impact:

1. **Trading Suspension / Halt** — hard stop. No entry. Note the reason and the
   lifting condition.
2. **Material Information / Press Release** — earnings surprises, M&A, contract
   wins/losses, guidance changes, management shake-ups. The most common cause of a
   move you can't explain technically.
3. **Cash/Stock Dividend declaration** — record date, ex-date, payment. Ex-date
   drops the price by the dividend; don't misread that gap as a breakdown.
4. **Public/Stock Rights Offering, Private Placement, Block Sale** — dilution or an
   overhang of supply. Changes the risk/reward even on a clean chart.
5. **Quarterly/Annual Financial Statements** — confirm the fundamentals leg isn't
   contradicted by a fresh filing.
6. **Clarification of News Reports / Unusual Price-Volume** — PSE asking the company
   to explain a move; the reply tells you if there's substance or just noise.

## How to fetch

EDGE serves a disclosure feed and a per-company page. Endpoints below are the
common ones — **verify the response shape on first use** (EDGE changes markup) and
prefer the `browser` toolset if an endpoint returns JS-only HTML.

```sh
# Recent market-wide disclosures (landing feed)
curl -s "https://edge.pse.com.ph/" -o /tmp/edge.html   # then parse the latest list

# Company disclosure search (POST form; cmpy_id is the EDGE company id)
curl -s "https://edge.pse.com.ph/companyDisclosures/search.ax" \
  --data "keyword=<TICKER>&sortType=date" -o /tmp/disc.html

# Per-company stock data / disclosure history page
curl -s "https://edge.pse.com.ph/companyPage/stockData.do?cmpy_id=<ID>" -o /tmp/co.html
```

Resolve `<TICKER>` → `cmpy_id` once and reuse it. If you cannot find the id, use
the `browser` toolset to search the company on EDGE and read the disclosure list
directly.

## Cross-check

EDGE is authoritative for *what was disclosed*; pair it with a live quote
(`public-market-quote-checks` / `merx-pse-yahoo-fallbacks`) to see how price reacted.
A material disclosure with no volume response is a different signal than one the
market is already repricing.

## How to report

State disclosures as evidence in the trade block's **disclosures** line:

```
disclosures: CLEAN — last material filing 2026-05-30 (Q1 results, in line). No
             suspension, no pending offering, ex-div passed 2026-04-12.
```
or
```
disclosures: BLOCKED — under trading suspension since 2026-06-10 (pending
             clarification of news report). No entry until lifted.
```

Never report "clean disclosures" from memory or from price action alone — it must
come from an actual EDGE read. If EDGE is unreachable, say so and treat the
disclosure leg as **YELLOW (unverified)**, which under your gate means reduced size
at most, never a full-conviction entry.
