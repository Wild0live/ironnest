"""POST /memory/{read,write,search,publish-approved}.

Every endpoint:
    1. authenticates (bearer → CallerIdentity)
    2. parses + normalizes the URI
    3. evaluates the policy
    4. logs the decision (audit)
    5. forwards to OpenViking only if allowed
"""

from __future__ import annotations

import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..auth import CallerIdentity, require_profile_token
from ..namespace import NamespaceError, parse_uri
from ..policy import evaluate

router = APIRouter()


# ── Request / response shapes ───────────────────────────────────────────────

class ReadRequest(BaseModel):
    uri: str = Field(..., min_length=1)


class WriteRequest(BaseModel):
    uri: str = Field(..., min_length=1)
    content: str
    metadata: dict | None = None


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1)
    scope_uri: str | None = None


class PublishApprovedRequest(BaseModel):
    source_uri: str = Field(..., description="viking://profiles/<self>/...")
    target_uri: str = Field(..., description="viking://shared/approved/<self>/...")
    rationale: str = Field(..., min_length=1, description="Why this memory is being promoted.")


# ── Helpers ─────────────────────────────────────────────────────────────────

def _audit_and_403(request: Request, caller: CallerIdentity, operation: str,
                   uri: str, reason: str, matched_rule: str | None,
                   request_id: str, t0: float) -> JSONResponse:
    request.app.state.audit.log(
        request_id=request_id,
        profile=caller.profile,
        operation=operation,
        uri=uri,
        decision="deny",
        reason=reason,
        matched_rule=matched_rule,
        remote_addr=request.client.host if request.client else None,
        latency_ms=int((time.monotonic() - t0) * 1000),
    )
    return JSONResponse(
        status_code=status.HTTP_403_FORBIDDEN,
        content={"error": "forbidden", "reason": reason, "matched_rule": matched_rule,
                 "request_id": request_id},
    )


async def _check(request: Request, caller: CallerIdentity, operation: str,
                 uri: str, request_id: str, t0: float):
    """Authorize a single (operation, uri). Returns None on allow, JSONResponse on deny."""
    # Rate limit per profile
    if not request.app.state.ratelimit.allow(caller.profile):
        request.app.state.audit.log(
            request_id=request_id, profile=caller.profile, operation=operation,
            uri=uri, decision="deny", reason="rate_limited", matched_rule=None,
            latency_ms=int((time.monotonic() - t0) * 1000),
        )
        return JSONResponse(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            content={"error": "rate_limited", "request_id": request_id})

    # URI normalization (also rejects traversal / bad scheme)
    try:
        parse_uri(uri)
    except NamespaceError as e:
        return _audit_and_403(request, caller, operation, uri,
                              f"invalid uri: {e}", None, request_id, t0)

    # Policy
    policy = request.app.state.policies.get(caller.profile)
    if policy is None:
        return _audit_and_403(request, caller, operation, uri,
                              "no policy loaded for profile", None, request_id, t0)
    verdict = evaluate(policy, operation, uri)  # type: ignore[arg-type]
    if verdict.decision == "deny":
        return _audit_and_403(request, caller, operation, uri,
                              verdict.reason, verdict.matched_rule, request_id, t0)
    return None


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.post("/memory/read")
async def memory_read(req: ReadRequest, request: Request,
                       caller: CallerIdentity = Depends(require_profile_token)) -> JSONResponse:
    request_id = str(uuid.uuid4())
    t0 = time.monotonic()
    denial = await _check(request, caller, "read", req.uri, request_id, t0)
    if denial is not None:
        return denial

    try:
        resp = await request.app.state.openviking.read(req.uri)
    except Exception as e:
        return JSONResponse(status_code=status.HTTP_502_BAD_GATEWAY,
                            content={"error": "openviking_unreachable", "detail": str(e),
                                     "request_id": request_id})

    request.app.state.audit.log(
        request_id=request_id, profile=caller.profile, operation="read",
        uri=req.uri, decision="allow", reason="policy_allow", matched_rule=None,
        upstream_status=resp.status, latency_ms=int((time.monotonic() - t0) * 1000),
    )
    return JSONResponse(status_code=200 if resp.ok else resp.status,
                        content={"ok": resp.ok, "data": resp.data, "request_id": request_id})


@router.post("/memory/write")
async def memory_write(req: WriteRequest, request: Request,
                        caller: CallerIdentity = Depends(require_profile_token)) -> JSONResponse:
    request_id = str(uuid.uuid4())
    t0 = time.monotonic()
    denial = await _check(request, caller, "write", req.uri, request_id, t0)
    if denial is not None:
        return denial

    try:
        resp = await request.app.state.openviking.write(req.uri, req.content, req.metadata)
    except Exception as e:
        return JSONResponse(status_code=status.HTTP_502_BAD_GATEWAY,
                            content={"error": "openviking_unreachable", "detail": str(e),
                                     "request_id": request_id})

    request.app.state.audit.log(
        request_id=request_id, profile=caller.profile, operation="write",
        uri=req.uri, decision="allow", reason="policy_allow", matched_rule=None,
        upstream_status=resp.status, content_bytes=len(req.content.encode("utf-8")),
        latency_ms=int((time.monotonic() - t0) * 1000),
    )
    return JSONResponse(status_code=200 if resp.ok else resp.status,
                        content={"ok": resp.ok, "data": resp.data, "request_id": request_id})


@router.post("/memory/search")
async def memory_search(req: SearchRequest, request: Request,
                         caller: CallerIdentity = Depends(require_profile_token)) -> JSONResponse:
    """Semantic search. We check the scope_uri (if provided) for read access; if
    no scope, we implicitly check `viking://shared/` (every profile has it)."""
    request_id = str(uuid.uuid4())
    t0 = time.monotonic()
    scope = req.scope_uri or "viking://shared/"
    denial = await _check(request, caller, "read", scope, request_id, t0)
    if denial is not None:
        return denial

    try:
        resp = await request.app.state.openviking.find(req.query, req.scope_uri)
    except Exception as e:
        return JSONResponse(status_code=status.HTTP_502_BAD_GATEWAY,
                            content={"error": "openviking_unreachable", "detail": str(e),
                                     "request_id": request_id})

    request.app.state.audit.log(
        request_id=request_id, profile=caller.profile, operation="search",
        uri=scope, decision="allow", reason="policy_allow", matched_rule=None,
        query_len=len(req.query), upstream_status=resp.status,
        latency_ms=int((time.monotonic() - t0) * 1000),
    )
    return JSONResponse(status_code=200 if resp.ok else resp.status,
                        content={"ok": resp.ok, "data": resp.data, "request_id": request_id})


@router.post("/memory/publish-approved")
async def memory_publish_approved(req: PublishApprovedRequest, request: Request,
                                   caller: CallerIdentity = Depends(require_profile_token)
                                  ) -> JSONResponse:
    """Promote a private memory to the profile's approved shared namespace.

    Caller must have read on source AND write on target (both checked).
    """
    request_id = str(uuid.uuid4())
    t0 = time.monotonic()

    denial = await _check(request, caller, "read",  req.source_uri, request_id, t0)
    if denial is not None:
        return denial
    denial = await _check(request, caller, "write", req.target_uri, request_id, t0)
    if denial is not None:
        return denial

    # Additional invariant: target_uri MUST be under viking://shared/approved/<caller.profile>/
    expected_prefix = f"viking://shared/approved/{caller.profile}/"
    if not (req.target_uri == expected_prefix.rstrip("/") or req.target_uri.startswith(expected_prefix)):
        return _audit_and_403(request, caller, "publish-approved", req.target_uri,
                              f"target_uri must be under {expected_prefix}",
                              None, request_id, t0)

    try:
        read_resp = await request.app.state.openviking.read(req.source_uri)
        if not read_resp.ok:
            raise RuntimeError(f"source read failed: HTTP {read_resp.status}")
        content = read_resp.data.get("content", "")
        meta = {
            "promoted_from": req.source_uri,
            "promoted_by": caller.profile,
            "rationale": req.rationale,
        }
        write_resp = await request.app.state.openviking.write(req.target_uri, content, meta)
    except Exception as e:
        return JSONResponse(status_code=status.HTTP_502_BAD_GATEWAY,
                            content={"error": "publish_failed", "detail": str(e),
                                     "request_id": request_id})

    request.app.state.audit.log(
        request_id=request_id, profile=caller.profile, operation="publish-approved",
        uri=req.target_uri, decision="allow", reason="promoted",
        matched_rule=None, source_uri=req.source_uri,
        upstream_status=write_resp.status,
        latency_ms=int((time.monotonic() - t0) * 1000),
    )
    return JSONResponse(status_code=200 if write_resp.ok else write_resp.status,
                        content={"ok": write_resp.ok, "data": write_resp.data,
                                 "request_id": request_id})
