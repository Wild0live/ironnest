# Authored agent skills + the 2026-06-14 capability upgrade

Source-of-truth copies of skills authored for IronNest agents, plus the changelog
for the toolset/skill changes applied to the **live** per-profile volumes. The
live `config.yaml` and `/opt/data/skills/` in each `hermes-pf-*` container are the
real runtime state; this tree exists so those changes are not silent drift and can
be re-applied after a profile rebuild.

## Layout

```
authored-skills/
  littlejohn/security/nvd-epss-kev-lookup/   → installed (live)
  littlejohn/security/wazuh-query/           → installed (live)
  mark/research/pse-edge-disclosures/        → installed (live)
  wifey/household/electrical-load-230v/      → installed (live)
  wifey/household/recipe-scaling-substitution/ → installed (live)
  octo/devops/wazuh-query/                   → staged (install after broker is up)
  octo/devops/approval-gated-operations/     → staged (install after operations token setup)
  _ops/set-disabled-skills.py               → prune helper (ruamel, format-preserving)
```

The Wazuh broker itself lives at `platform/security/wazuh-query-broker/`.

## Re-install a skill into a live profile

```sh
docker cp authored-skills/<profile>/<pack>/<skill> hermes-pf-<profile>:/opt/data/skills/<pack>/
docker exec -u root hermes-pf-<profile> chown -R hermes:hermes /opt/data/skills/<pack>/<skill>
docker restart hermes-pf-<profile>
docker exec hermes-pf-<profile> sh -c 'hermes skills list' | grep <skill>   # expect "enabled"
```

---

# CHANGELOG — 2026-06-14 agent capability upgrade

Driven by a SOUL-vs-configured-tools gap analysis across all 8 agents. All changes
applied via the supported `hermes tools` / `hermes config` paths or `docker cp` +
chown; verified by restart + `hermes skills list` / config read.

## Toolsets (live config.yaml)

| Agent | Change | Why |
|-------|--------|-----|
| **Steve** | enabled `browser` + `vision` on the **telegram** surface | SOUL: "treat screenshots/logs as primary evidence" + verify UI changes. CLI already had them; Telegram was trimmed. |
| **Wifey** | materialized an explicit telegram toolset (was `None`) incl. `vision`, `image_gen`, `web` | SOUL is photo-driven (repair diagnosis) + design renders; `None` left the surface ambiguous. |

## Skills authored + installed (live)

| Agent | Skill (pack) | Purpose |
|-------|--------------|---------|
| **Little John** | `nvd-epss-kev-lookup` (security) | Live CVE enrichment — NVD CVSS + FIRST.org EPSS + CISA KEV. Satisfies "verify against live NVD." Egress confirmed (HTTP 200 to all three). |
| **Mark** | `pse-edge-disclosures` (research) | Read PSE EDGE official disclosures for the "clean disclosures" leg of the three-filter gate. EDGE reachable (200). |
| **Wifey** | `electrical-load-230v` (household) | PH 230V load/breaker/wire sizing + DIY-vs-licensed line, tied to her safety doctrine. |
| **Wifey** | `recipe-scaling-substitution` (household) | Recipe scaling, weight↔volume, Filipino substitutions, food safety. |

## Skills pruned (live `skills.disabled`)

Applied to the **6 professional agents** (Dr. Smith, Octo, Steve, Jaime, Little
John, Mark) via `_ops/set-disabled-skills.py`. **Bigbert and Wifey left fully
stocked** (conversational/household — recreational skills can plausibly come up).

Disabled: `minecraft-modpack-server`, `pokemon-player`, `yuanbao`, `spotify`,
`openhue` (+ `airtable`, already off). Unambiguously off-mandate for the work
agents. Reversible: re-run the script with a shorter list.

## Wazuh Query Broker — deployed for Littlejohn

`platform/security/wazuh-query-broker/` is deployed for **Littlejohn**. It runs
as `wazuh-query` on `platform-net`, uses a dedicated `broker_ro` OpenSearch
identity restricted to alert/monitoring reads, and accepts Littlejohn's separate
Infisical-delivered bearer token. The Littlejohn skill is installed and verified
end-to-end: health and authenticated alert reads succeed; mutation is rejected.
Octo remains a separate opt-in rollout.

## Considered and dropped

- **`browser_intent` for Octo** — dropped. It's a fixed-site MCP (april /
  hi-precision / col / maxicare), not a general browser; it cannot verify internal
  `*.ironnest.local` routes. Octo already has the general `browser` toolset.
- **`kanban` toolset for Dr. Smith** — dropped. The validated CLI rejects `kanban`
  for him; kanban orchestration runs through the gateway dispatcher (`kanban.*`
  config), not an agent toolset. Steve's entry is the worker-side card interface.
