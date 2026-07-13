# 03 — Directory Structure

```
hermes-platform/
├── README.md
├── ARCHITECTURE.md                       → reference to docs/01-ARCHITECTURE.md
├── .env.example                          template for Infisical machine identity creds
├── .gitignore
│
├── docker-compose.yml                    base services/profiles + named volumes + networks
├── services.d/                           dynamic profile compose fragments
│   ├── hermes-pf-jaime.yml
│   ├── hermes-pf-bigbert.yml
│   └── hermes-pf-octo.yml
├── start.sh                              on-demand stack entrypoint
├── build.sh                              builds openviking + memory-gateway + Mission Control + operations-runner images
├── with-infisical.sh                     copied verbatim from hermes/with-infisical.sh
│
├── mission-control/                      FastAPI operator UI, static assets, and focused security tests
├── agent-bridge/                         per-profile chat/Kanban/wiki/host-operation bridge and scoped request clients
├── operations-runner/                    exact approval-gated Docker operation broker
├── local-host-runner/                    localhost Windows queue consumers and allowlisted remediation implementations
├── artifact-apps/                        read-only nginx configuration for task web apps
├── kali-mcp/                             optional Little John Kali MCP image
│
├── hermes-plugin/
│   └── ironnest_gateway/
│       ├── plugin.yaml                   Hermes MemoryProvider metadata
│       └── __init__.py                   automatic recall/save via memory-gateway only
│
├── openviking/
│   ├── Dockerfile                        python:3.13-slim + `pip install openviking`
│   ├── entrypoint.sh                     renders ov.conf + execs openviking-server
│   ├── ov.conf.template                  envsubst template
│   └── agent-config/
│       └── entrypoint.sh                 infisical-agent sidecar entrypoint
│
├── gateway/
│   ├── Dockerfile                        python:3.13-slim + FastAPI + uvicorn + Infisical CLI
│   ├── pyproject.toml
│   ├── requirements.txt
│   └── app/
│       ├── __init__.py
│       ├── main.py                       app factory + lifespan
│       ├── config.py                     pydantic-settings
│       ├── auth.py                       bearer token → CallerIdentity
│       ├── namespace.py                  viking:// URI parsing + globs
│       ├── policy.py                     deny-first evaluator
│       ├── policy_loader.py              loads + schema-validates policies/*.yaml
│       ├── registry.py                   loads profiles-registry.yaml
│       ├── openviking_client.py          THE adapter — only file that knows OpenViking's API
│       ├── audit.py                      JSONL audit log
│       ├── ratelimit.py                  token bucket
│       ├── logging.json                  uvicorn log config
│       └── routes/
│           ├── __init__.py
│           ├── health.py                 GET /health
│           ├── memory.py                 POST /memory/{read,write,search,publish-approved}
│           └── admin.py                  POST /admin/reload-policies, GET /admin/profiles
│
├── profile-template/                     templated files for create-profile.sh
│   ├── SOUL.md.template
│   ├── USER.md.template
│   ├── MEMORY.md.template
│   ├── tools.yaml.template
│   ├── policy.yaml.template
│   └── env.template
│
├── policies/                             one per profile; schema in spec/policies.schema.json
│   ├── default.policy.yaml
│   ├── mark.policy.yaml
│   ├── steve.policy.yaml
│   ├── qa.policy.yaml                     (renamed from wifey.policy.yaml 2026-06-14)
│   ├── littlejohn.policy.yaml
│   ├── jaime.policy.yaml
│   ├── bigbert.policy.yaml
│   └── octo.policy.yaml
│
├── registry/
│   └── profiles-registry.yaml            schema in spec/registry.schema.json
│
├── shared/                               host-bind artifact-exchange tree (write-own / read-all)
│   ├── README.md                         convention (also visible to agents at /opt/shared/all/README.md)
│   └── <profile>/                        one folder per profile → /opt/shared/mine (rw) ; whole tree → /opt/shared/all (ro)
│
├── scripts/
│   ├── _common.sh                        helpers sourced by every script
│   ├── create-profile.sh
│   ├── provision-profile.sh
│   ├── delete-profile.sh
│   ├── validate-profile.sh
│   ├── rotate-profile-token.sh
│   ├── backup-souls.sh
│   ├── patch-souls.sh
│   ├── repair-auth-lock-permissions.sh
│   ├── sync-orchestrator-roster.sh
│   ├── catch-up-missed-cron.sh
│   ├── validate-isolation.sh
│   ├── validate-sharing.sh
│   ├── validate-conversational-memory.sh
│   ├── seed-memory.sh
│   ├── healthcheck.sh
│   └── migrate-from-shared-volume.sh
│
├── docs/                                 numbered files (this directory)
│   ├── 00-AI-REBUILD-MANIFEST.md
│   ├── 01-ARCHITECTURE.md
│   ├── 02-SERVICES.md
│   ├── 03-DIRECTORY-STRUCTURE.md         (this file)
│   ├── 04-CONFIGURATION.md
│   ├── 05-OPENVIKING-MEMORY-MODEL.md
│   ├── 06-NAMESPACE-AND-POLICY-MODEL.md
│   ├── 07-PROFILE-LIFECYCLE.md
│   ├── 08-SECURITY-MODEL.md
│   ├── 09-DEPLOYMENT-RUNBOOK.md
│   ├── 10-VALIDATION-AND-TESTING.md
│   ├── 11-TROUBLESHOOTING.md
│   ├── 12-OPERATIONS-RUNBOOK.md
│   ├── 13-KUBERNETES-MIGRATION-NOTES.md
│   ├── 14-MCP-INTEGRATION-NOTES.md
│   ├── 15-CHANGELOG.md
│   ├── 16-DECISION-LOG.md
│   ├── 17-LLM-HANDOFF.md
│   ├── 18-AUTOMATIC-CONVERSATIONAL-MEMORY.md
│   └── 19-APPROVAL-GATED-OPERATIONS.md
│
└── spec/                                 machine-readable manifests
    ├── system.manifest.yaml
    ├── services.yaml
    ├── namespaces.yaml
    ├── policies.schema.json
    ├── profile.schema.json
    ├── registry.schema.json
    ├── validation-plan.yaml
    └── rebuild-checklist.yaml
```

## Things outside the repo

- `D:\claude-workspace\platform\hermes-platform\.env` — gitignored, Infisical machine-identity creds.
- Docker named volumes (`hermes-platform_data-*`, `hermes-platform_openviking-*`, `hermes-platform_memory-gateway-log`) — managed by Compose.
- The legacy `hermes_hermes-data` volume — read-only mounted by `scripts/migrate-from-shared-volume.sh` only during migration from an old deployment.

## Things mirrored from existing IronNest stacks

- `with-infisical.sh` — copied verbatim from `hermes/with-infisical.sh` (same Infisical machine-identity wrapper).
- `x-logging` anchor — same `10m × 3` rotation as `hermes/docker-compose.yml`.
- `cap_drop: ALL` + `cap_add: [CHOWN, SETUID, SETGID, DAC_OVERRIDE]` + `no-new-privileges:true` — matches `hermes/docker-compose.yml:146-154`.
- The infisical-agent sidecar pattern — same as `browser-intent/docker-compose.yml:37-73`.
