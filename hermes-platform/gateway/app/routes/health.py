"""GET /health — liveness + dependency check."""

from __future__ import annotations

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse

router = APIRouter()


@router.get("/health")
async def health(request: Request) -> JSONResponse:
    state = request.app.state
    payload: dict = {
        "status": "ok",
        "version": getattr(state, "version", "0.0.0"),
        "policies_loaded": len(getattr(state, "policies", {}) or {}),
        "profiles_registered": len(getattr(state, "registry").profiles)
            if getattr(state, "registry", None) else 0,
        "openviking_url": getattr(state, "settings").openviking_url
            if getattr(state, "settings", None) else None,
        "dry_run": getattr(state, "settings").dry_run
            if getattr(state, "settings", None) else False,
    }

    # Best-effort OpenViking ping. We don't fail health on this — the gateway
    # itself is healthy if it can serve requests; OpenViking down is reported
    # separately so the container doesn't restart-loop on a flaky backend.
    if getattr(state, "openviking", None) is not None:
        try:
            r = await state.openviking.status()
            payload["openviking"] = "reachable" if r.ok else f"unreachable (HTTP {r.status})"
        except Exception as e:
            payload["openviking"] = f"unreachable ({type(e).__name__})"
    else:
        payload["openviking"] = "not_initialized"

    return JSONResponse(content=payload, status_code=status.HTTP_200_OK)
