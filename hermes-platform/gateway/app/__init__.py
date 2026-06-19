"""Memory Gateway — policy-enforcing front door to OpenViking.

The gateway is the ONLY service permitted to connect to the OpenViking
server. Hermes profile containers reach it over an internal Docker
network using bearer tokens that map to profile identities.

Module layout:
    config.py             — env + YAML loading (pydantic-settings)
    auth.py               — bearer-token → profile identity
    namespace.py          — viking:// URI parsing + traversal-safe normalization
    policy.py             — pure-function policy evaluator (deny-first)
    policy_loader.py      — loads + schema-validates policies/*.policy.yaml
    registry.py           — loads registry/profiles-registry.yaml
    openviking_client.py  — the ONLY file that knows OpenViking's API surface
    audit.py              — JSONL audit log writer
    ratelimit.py          — per-profile token bucket
    main.py               — FastAPI app factory + lifespan hooks
    routes/
        health.py         — GET /health
        memory.py         — POST /memory/{read,write,search,publish-approved}
        admin.py          — POST /admin/reload-policies, GET /admin/profiles
"""

__version__ = "0.1.0"
