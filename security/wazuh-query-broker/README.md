# Wazuh Query Broker

Read-only SIEM access for the IronNest agents **Octo** (platform ops) and
**Little John** (security), without giving an LLM agent the Wazuh credentials or
opening the SIEM ports to the agent network.

```
hermes-pf-octo ─┐                              ┌─ wazuh.indexer:9200 (alerts)
                ├─ http://wazuh-query:8000 ────┤
hermes-pf-john ─┘   (bearer token, read-only)  └─ wazuh.manager:55000 (agents/rules)
                         creds live here, never in an agent
```

## Why a broker instead of direct access

- Agents egress through **Squid**, which only permits CONNECT to :443 — they
  cannot reach `wazuh.indexer:9200` / `wazuh.manager:55000` at all.
- Wazuh credentials must never sit where an LLM can read and leak them. The broker
  holds them; agents get only a scoped, read-only REST surface + a bearer token.
- Read-only by construction: the broker issues only `_search` to the indexer and
  `GET` to the manager. No caller input becomes a method, write, or script.

## Endpoints

| Method/Path | Purpose |
|-------------|---------|
| `GET /health` | liveness + indexer reachability (no auth) |
| `GET /alerts?q=&level_gte=&minutes=&agent=&limit=` | recent alerts, newest first |
| `GET /agents` | agent inventory + connection-status summary |
| `GET /rule/{id}` | rule definition lookup |

All but `/health` require `Authorization: Bearer <token>`.

## Deploy (you run this — needs Wazuh credentials)

> The build-out was prepared by Claude; the steps that authenticate to the live
> SIEM are left to you on purpose.

1. **Create the read-only indexer user** — see [setup-readonly-user.md](setup-readonly-user.md).
   (You *can* start with the existing `admin` password to smoke-test, but don't
   leave it that way.)
2. **Configure secrets:** `cp .env.example .env` and fill in. Generate tokens:
   ```sh
   openssl rand -hex 32   # one per agent
   ```
3. **Build & start:**
   ```sh
   cd platform/security/wazuh-query-broker
   docker compose up -d --build
   docker compose logs -f wazuh-query        # watch /health go green
   curl -s http://localhost:8000/health      # from a platform-net host/container
   ```
   (The broker isn't published to the host; test `/health` from another
   platform-net container, e.g. `docker run --rm --network platform-net curlimages/curl
   -s http://wazuh-query:8000/health`.)
4. **Let the agents reach it** — add `wazuh-query` to the `NO_PROXY`/`no_proxy`
   of `hermes-pf-octo` and `hermes-pf-littlejohn` in
   `platform/hermes-platform/docker-compose.yml` (the `x-hermes-pf` env block),
   so their curl goes direct instead of through Squid. Recreate those two
   containers.
5. **Give each agent its token** via that agent's Infisical secret (e.g.
   `WAZUH_QUERY_TOKEN`), matching one of `WAZUH_QUERY_BROKER_TOKENS`.
6. **Install the skill** into each agent (after the broker answers `/health`):
   ```sh
   docker cp authored-skills/octo/devops/wazuh-query        hermes-pf-octo:/opt/data/skills/devops/
   docker cp authored-skills/littlejohn/security/wazuh-query hermes-pf-littlejohn:/opt/data/skills/security/
   docker exec -u root hermes-pf-octo        chown -R hermes:hermes /opt/data/skills/devops/wazuh-query
   docker exec -u root hermes-pf-littlejohn  chown -R hermes:hermes /opt/data/skills/security/wazuh-query
   docker restart hermes-pf-octo hermes-pf-littlejohn
   ```
   (The skill source lives in `platform/hermes-platform/authored-skills/`.)

## Rollback

`docker compose down` removes the broker; remove the `wazuh-query` NO_PROXY entry
and the skill dirs to fully revert. Nothing in the Wazuh stack itself is modified
except the optional `broker_ro` user, which you can delete from
`internal_users.yml` + re-run `securityadmin.sh`.

## Hardening backlog (v1 → v2)

- Replace `admin` with `broker_ro` (read-only) — step 1 above. **Do this.**
- Per-agent tokens (already supported) so an alert query can be attributed.
- Optional: wrap as a proper MCP-over-HTTP server (like `browser-intent-mcp`) and
  register under `mcp_servers` instead of skill+curl, if you want native tool
  framing rather than the agent shelling `curl`.
- Optional: pin Wazuh's self-signed CA and flip `WAZUH_BROKER_VERIFY_TLS=true`.
