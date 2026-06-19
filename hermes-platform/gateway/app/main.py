"""FastAPI app factory + lifespan hooks.

Boot sequence:
    1. load Settings (env vars; secrets already injected by with-infisical)
    2. load registry/profiles-registry.yaml
    3. load policies/*.policy.yaml
    4. load auth token map from MEMORY_GATEWAY_PROFILE_TOKENS_JSON
    5. open OpenVikingClient (httpx.AsyncClient)
    6. open AuditLogger
    7. install RateLimiter
    8. mount routes
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import __version__
from .audit import AuditLogger
from .auth import load_token_map
from .config import get_settings
from .openviking_client import OpenVikingClient
from .policy_loader import load_policies
from .ratelimit import RateLimiter
from .registry import load_registry
from .routes import admin as admin_routes
from .routes import health as health_routes
from .routes import memory as memory_routes

log = logging.getLogger("memory-gateway")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    log.info("memory-gateway %s starting (dry_run=%s)", __version__, s.dry_run)

    # Registry + policies
    app.state.registry = load_registry(s.registry_file, s.registry_schema_file)
    app.state.policies = load_policies(s.policies_dir, s.policies_schema_file)
    log.info("loaded %d policies, %d registered profiles",
             len(app.state.policies), len(app.state.registry.profiles))

    # Cross-check: every policy has a matching registry entry, and vice versa
    pol_names = set(app.state.policies.keys())
    reg_names = set(app.state.registry.profiles.keys())
    if pol_names != reg_names:
        log.warning("policy/registry mismatch — only_in_policies=%s only_in_registry=%s",
                    pol_names - reg_names, reg_names - pol_names)

    # Auth
    load_token_map(s)

    # OpenViking client. api_key (from Infisical via with-infisical) enables
    # the OpenViking server's auth_mode=API_KEY enforcement — gateway sends
    # it on every request as Authorization: Bearer.
    app.state.openviking = OpenVikingClient(
        base_url=s.openviking_url,
        timeout=s.openviking_timeout_seconds,
        dry_run=s.dry_run,
        api_key=s.openviking_api_key,
    )
    await app.state.openviking.__aenter__()

    # Audit + rate limit
    app.state.audit = AuditLogger(s.audit_log, mirror_to_stderr=s.audit_to_stderr)
    app.state.ratelimit = RateLimiter(capacity=s.rate_capacity, refill_per_sec=s.rate_refill_per_sec)

    app.state.settings = s
    app.state.version = __version__

    try:
        yield
    finally:
        log.info("memory-gateway shutting down")
        await app.state.openviking.aclose()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Hermes Platform Memory Gateway",
        version=__version__,
        description=("Policy-enforcing front door to OpenViking. The ONLY service permitted "
                     "to connect to the OpenViking server. All hermes-platform profile "
                     "containers reach OpenViking via this gateway."),
        lifespan=lifespan,
        # Security: do NOT expose the interactive API docs / OpenAPI schema. This is a
        # security-critical policy kernel reachable by every profile container on
        # platform-net; Swagger/ReDoc/openapi.json leaked the full API surface (incl.
        # admin routes) unauthenticated. (IronNest infra audit 2026-06-13, Medium finding.)
        docs_url=None, redoc_url=None, openapi_url=None,
    )
    app.include_router(health_routes.router, tags=["health"])
    app.include_router(memory_routes.router, tags=["memory"])
    app.include_router(admin_routes.router,  tags=["admin"])
    return app


app = create_app()


def run() -> None:
    """Console-script entrypoint (gateway/pyproject.toml)."""
    import uvicorn
    s = get_settings()
    uvicorn.run("app.main:app", host=s.host, port=s.port, log_level="info")
