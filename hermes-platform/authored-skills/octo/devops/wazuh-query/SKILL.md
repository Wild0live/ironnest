---
name: wazuh-query
description: "Query the IronNest Wazuh SIEM (alerts, agent/sensor status, rule lookups) through the read-only wazuh-query broker. Use during incident investigation and health checks to see what the platform's sensors actually recorded — evidence before action."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [platform-ops, sre, wazuh, siem, incident-response, observability]
    related_skills: []
---

# Wazuh SIEM Query (read-only broker)

## When to use

Your creed is *diagnose before touching, verify after touching*. This is a source
of evidence for both. Use it to:

- check whether a container/host incident is also showing up as security or
  integrity alerts (file changes, unexpected process, auth anomalies)
- confirm sensor/agent health during an incident — a silent host may be a blind
  spot, not a healthy one
- correlate a platform symptom (a service flapping) with what Wazuh logged at the
  same time
- verify, after a fix, that the noisy alert pattern actually stopped

This is read-only telemetry — it complements `docker`/log inspection, it does not
replace your usual diagnosis flow.

## How to reach it

The broker is at `http://wazuh-query:8000` on the internal network (in `NO_PROXY`,
so `curl` goes direct — don't send it through Squid). Your bearer token is
`$WAZUH_QUERY_TOKEN`. The broker is **read-only** and holds the Wazuh creds; you
never see them.

```sh
AUTH="Authorization: Bearer $WAZUH_QUERY_TOKEN"

# Is the SIEM path healthy?
curl -s http://wazuh-query:8000/health | jq .

# Anything serious in the last hour?
curl -s -H "$AUTH" "http://wazuh-query:8000/alerts?level_gte=10&minutes=60&limit=20" | jq '.total, .alerts[] | {timestamp, agent:.agent.name, level:.rule.level, desc:.rule.description}'

# Which sensors are NOT reporting (blind spots)?
curl -s -H "$AUTH" "http://wazuh-query:8000/agents" | jq '.status_summary, (.agents[] | select(.status!="active") | {name, status, lastKeepAlive})'

# Alerts from one host around an incident
curl -s -H "$AUTH" "http://wazuh-query:8000/alerts?agent=<host>&minutes=120&limit=40" | jq .
```

`/alerts` params: `q` (Lucene, e.g. `rule.groups:ossec` or `location:/var/log/...`),
`level_gte` (0–16; ≥10 = serious), `minutes` (default 60, max 10080), `agent`,
`limit` (default 20, cap 100).

## How to use it in the runbook

- Fold SIEM evidence into the incident timeline alongside `docker` and host logs:
  *observed* alert vs *suspected* cause, kept distinct.
- A `disconnected`/`never_connected` agent during an incident is itself a finding —
  the sensor is down, so silence from that host proves nothing.
- After a fix, re-query the same window/filter to confirm the alert pattern
  cleared — "it seems fine now" is not a closure; an empty result for the prior
  signature is.
- Route genuine security findings to **Little John** — your job is platform health;
  deep triage/attribution is his. Flag, don't own.

## Limits

- Read-only by design: you cannot change Wazuh state here, and shouldn't be able to.
- If `/health` reports `indexer: error`, note the SIEM query path is down (and that
  may itself be the incident) and fall back to direct log inspection.
