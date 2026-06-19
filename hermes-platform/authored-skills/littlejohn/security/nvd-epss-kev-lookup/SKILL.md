---
name: nvd-epss-kev-lookup
description: "Enrich a CVE with LIVE authoritative data — NVD (CVSS, CWE, references), FIRST.org EPSS (exploit probability), and CISA KEV (known-exploited). Use whenever a CVE's real severity, exploitability, or patch status must be verified rather than recalled from memory."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [security, cve, nvd, epss, kev, vulnerability-management, threat-intel]
    related_skills: [cve-watch-operations]
---

# Live CVE Enrichment — NVD · EPSS · CISA KEV

## When to use

Use this skill whenever you need to state a CVE's **real, current** severity or
exploitability instead of recalling it:

- "How bad is CVE-XXXX-YYYY?" / "What's the CVSS for ...?"
- prioritising a list of CVEs (which to patch first)
- confirming whether something is actively exploited in the wild
- checking whether a CVE I quoted from memory is still accurate
- triaging scanner/SCA output where the tool's severity is suspect

**Never quote a CVSS score, EPSS value, or KEV status from memory when this skill
can fetch the authoritative value.** Memory is stale; these feeds are live. This
directly satisfies the SOUL rule: *"When CVE/patch status could be stale, flag it
and verify against live NVD data."*

## Egress

These hosts are reachable from this container through the Squid egress proxy
(already set via `HTTPS_PROXY`); just use `curl`. All are HTTPS/443.

## The three authoritative sources

Query them in this order and **combine** the answers — no single source is enough.

### 1. NVD — severity, vector, CWE, references (the "how bad / what kind")

```sh
curl -s "https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-2021-44228" \
  | jq '.vulnerabilities[0].cve
        | {id, published, lastModified,
           cvss31: (.metrics.cvssMetricV31[0].cvssData // null),
           cwe: [.weaknesses[]?.description[]?.value] | unique,
           refs: [.references[].url]}'
```

- Prefer **CVSS v3.1** (`cvssMetricV31`); fall back to v3.0, then v2 only if newer
  are absent. Say which version you used.
- Report the **vector string**, not just the number — `AV:N/AC:L/PR:N/UI:N/...`
  tells the reader *why* it scores what it does.
- Map the **CWE** to the weakness class (e.g. CWE-502 = unsafe deserialization).

### 2. EPSS — probability of exploitation in the next 30 days (the "how likely")

```sh
curl -s "https://api.first.org/data/v1/epss?cve=CVE-2021-44228" \
  | jq '.data[0] | {cve, epss, percentile}'
```

- `epss` is a probability `0.0–1.0`; `percentile` ranks it against all CVEs.
- A high CVSS with a **low** EPSS is common — severe in theory, not currently being
  exploited. Say both. EPSS is the tiebreaker when CVSS scores cluster.

### 3. CISA KEV — is it being exploited *right now* (the "drop everything" flag)

```sh
curl -s "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json" \
  | jq --arg c CVE-2021-44228 '.vulnerabilities[] | select(.cveID==$c)
        | {cveID, dateAdded, dueDate, knownRansomwareCampaignUse, requiredAction}'
```

- Membership in KEV means **confirmed in-the-wild exploitation** — this outranks
  any CVSS/EPSS nuance. If present, lead with it.
- The KEV file is large; fetch once and reuse it when triaging multiple CVEs in a
  batch rather than re-downloading per CVE.

## Rate limits

- **NVD** without an API key: ~5 requests / 30 s. If an `NVD_API_KEY` exists in the
  environment, send it as header `apiKey: $NVD_API_KEY` for ~50 req/30 s. For a
  batch, prefer one call with multiple filters or space requests out — do not hammer
  and get throttled (you'll get HTTP 403/429).
- **EPSS** accepts comma-separated CVEs in one call: `?cve=CVE-A,CVE-B,CVE-C`.

## How to report (severity-first, per SOUL)

Lead with the verdict, then the evidence, ordered Critical → High → Medium → Low:

```
CVE-2021-44228 (Log4Shell) — CRITICAL, actively exploited
  CVSS 3.1  10.0  (AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H)   [NVD, v3.1]
  CWE-502   Deserialization of Untrusted Data
  EPSS      0.943 (p99.4) — very high near-term exploitation probability
  CISA KEV  yes — added 2021-12-10, ransomware use: Known
  → Patch immediately; this is not a "schedule it" finding.
```

Always tag the source of each number (`[NVD v3.1]`, `[EPSS]`, `[KEV]`) so the
reader can trust the provenance. If a source returns no record (e.g. a brand-new
CVE not yet in NVD), say so explicitly — `[NVD: not yet published]` — rather than
implying it's clean.

## Failure handling

- HTTP 403/429 from NVD → throttled; wait and retry, or note the partial result.
- A CVE absent from KEV is **not** evidence it's safe — KEV only lists *confirmed*
  exploitation. Absence means "not on the in-the-wild list," nothing more.
- If all three sources are unreachable, say the enrichment failed and fall back to
  clearly-labelled `[FROM MEMORY, UNVERIFIED]` figures — never present recalled
  numbers as fetched.
