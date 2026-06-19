---
name: wazuh-query
description: "Query the IronNest Wazuh SIEM (alerts, agent status, rule lookups) through the read-only wazuh-query broker. Use for live log analysis, incident triage, and detection validation against what the platform's sensors actually saw."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [security, wazuh, siem, log-analysis, incident-triage, detection]
    related_skills: [cve-watch-operations, nvd-epss-kev-lookup]
---

# Wazuh SIEM Query (read-only broker)

## When to use

Your SOUL centres on log analysis, incident triage, and detection — this is your
window into what the platform's Wazuh sensors actually recorded. Use it to:

- investigate an alert or suspected incident with real evidence (not hypotheses)
- check whether a host/agent is generating authentication failures, privilege
  escalation, or anomalous patterns *right now*
- confirm a detection idea fires against real data before authoring a rule
- verify agent connectivity during an incident (is the sensor even reporting?)

This satisfies the doctrine *"evidence before assertion"* — ground findings in
actual SIEM data.

## How to reach it

The broker is at `http://wazuh-query:8000` on the internal network (already in
`NO_PROXY`, so `curl` goes direct — do **not** route it through the proxy). It
holds the Wazuh credentials; you only need your bearer token, available as
`$WAZUH_QUERY_TOKEN` in the environment. The broker is **read-only** — you cannot
modify anything in Wazuh through it, by design.

```sh
AUTH="Authorization: Bearer $WAZUH_QUERY_TOKEN"

# Liveness + indexer reachability (no auth needed)
curl -s http://wazuh-query:8000/health | jq .

# High-severity alerts in the last 2 hours
curl -s -H "$AUTH" "http://wazuh-query:8000/alerts?level_gte=10&minutes=120&limit=30" | jq .

# Authentication failures on a specific host
curl -s -H "$AUTH" "http://wazuh-query:8000/alerts?q=rule.groups:authentication_failed&agent=<host>&minutes=360" | jq .

# Agent inventory + connection status
curl -s -H "$AUTH" "http://wazuh-query:8000/agents" | jq '.status_summary, .agents[] | select(.status!="active")'

# What a rule means
curl -s -H "$AUTH" "http://wazuh-query:8000/rule/5710" | jq '.rule.description, .rule.groups'
```

## Query parameters for `/alerts`

- `q` — Lucene `query_string` over the alert doc, e.g.
  `rule.groups:web` , `rule.mitre.id:T1110` , `data.srcip:10.0.0.5`.
- `level_gte` — minimum Wazuh `rule.level` (0–16). Triage tip: ≥7 is notable,
  ≥10 is serious, ≥12 is critical.
- `minutes` — lookback window (default 60, max 10080 = 7 days).
- `agent` — filter by `agent.name`.
- `limit` — max docs (default 20, cap 100). Narrow with `q`/`level_gte` rather
  than raising the limit blindly.

## How to interpret + report

- Lead with severity (Wazuh `rule.level`), order findings Critical → High → Low,
  per your SOUL.
- Map `rule.mitre.technique` to ATT&CK when present; cite the technique id.
- Distinguish **observed** (an alert exists) from **inferred** (what it implies).
  An auth-failure burst is an observation; "brute force in progress" is a
  hypothesis — label it as such and say what would confirm it (e.g. a success
  after the failures from the same srcip).
- If `/agents` shows a sensor `disconnected`/`never_connected`, treat absence of
  alerts from that host as **blind spot, not all-clear**.
- Enrich any CVE that surfaces with the `nvd-epss-kev-lookup` skill before scoring
  severity.

## Limits

- Read-only: for containment/eradication actions, hand the operator concrete steps
  — you cannot (and must not be able to) act on Wazuh from here.
- The window is bounded; for long-range hunts, narrow `q` and page by `minutes`
  rather than pulling everything.
- If `/health` shows `indexer: error`, say the SIEM query path is down and fall
  back to other evidence rather than guessing.
