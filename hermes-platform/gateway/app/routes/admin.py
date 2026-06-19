"""Admin routes — protected by MEMORY_GATEWAY_ADMIN_TOKEN."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from ..auth import CallerIdentity, require_admin_token
from ..policy_loader import load_policies
from ..registry import load_registry

router = APIRouter()


@router.post("/admin/reload-policies")
async def reload_policies(request: Request,
                          _: CallerIdentity = Depends(require_admin_token)) -> JSONResponse:
    s = request.app.state.settings
    try:
        new_policies = load_policies(s.policies_dir, s.policies_schema_file)
        new_registry = load_registry(s.registry_file, s.registry_schema_file)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

    request.app.state.policies = new_policies
    request.app.state.registry = new_registry
    return JSONResponse(content={
        "ok": True,
        "policies_loaded": len(new_policies),
        "profiles_registered": len(new_registry.profiles),
        "profile_names": new_registry.names(),
    })


@router.get("/admin/profiles")
async def list_profiles(request: Request,
                        _: CallerIdentity = Depends(require_admin_token)) -> JSONResponse:
    reg = request.app.state.registry
    return JSONResponse(content={
        "profiles": [
            {
                "name": p.name,
                "namespace": p.namespace,
                "approved_shared_namespace": p.approved_shared_namespace,
                "container_name": p.container_name,
                "status": p.status,
                "tags": list(p.tags),
            } for p in reg.profiles.values()
        ],
    })
