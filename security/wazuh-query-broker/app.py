"""
Wazuh Query Broker — read-only SIEM access for IronNest agents.

Why this exists
---------------
Octo (platform ops) and Little John (security) need to read Wazuh alerts and
agent status, but:
  * the agent containers egress through Squid, which only allows CONNECT to :443
    (so they cannot reach wazuh.indexer:9200 / wazuh.manager:55000 directly), and
  * Wazuh credentials must NOT live where an LLM agent can read and leak them.

This broker sits on platform-net (reachable by agents) and on the path to Wazuh.
It holds the Wazuh credentials, exposes ONLY read-only GET endpoints behind a
bearer token, and never accepts a mutating method or query body from the caller.
Agents reach it at http://wazuh-query:8000 (add to their NO_PROXY) and read it via
the `wazuh-query` skill — no Wazuh secret ever touches an agent.

Security properties
-------------------
* Read-only by construction: the broker only ever issues `_search` (GET-shaped)
  to the indexer and GET to the manager API. No caller input is forwarded as a
  method, index-write, or script.
* Bearer-token auth; tokens are an allowlist from WAZUH_QUERY_BROKER_TOKENS.
* Lucene query_string is passed as a *query*, never as a scripted/DSL body the
  caller controls; limit and lookback are clamped.
* Credentials come from env (injected by compose from the Wazuh stack secrets),
  never from the caller, never logged.
"""
from __future__ import annotations

import os
import time
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

# ── Config (from environment; never from the caller) ──────────────────────────
INDEXER_URL = os.environ.get("WAZUH_INDEXER_URL", "https://wazuh.indexer:9200")
INDEXER_USER = os.environ.get("WAZUH_INDEXER_USERNAME", "broker_ro")
INDEXER_PASS = os.environ.get("WAZUH_INDEXER_PASSWORD", "")

MANAGER_URL = os.environ.get("WAZUH_API_URL", "https://wazuh.manager:55000")
MANAGER_USER = os.environ.get("WAZUH_API_USERNAME", "wazuh-wui")
MANAGER_PASS = os.environ.get("WAZUH_API_PASSWORD", "")

# Comma-separated bearer tokens that may call this broker (one per agent ideally).
_TOKENS = {t.strip() for t in os.environ.get("WAZUH_QUERY_BROKER_TOKENS", "").split(",") if t.strip()}

ALERTS_INDEX = os.environ.get("WAZUH_ALERTS_INDEX", "wazuh-alerts-*")
MAX_LIMIT = 100
DEFAULT_LIMIT = 20
DEFAULT_MINUTES = 60
MAX_MINUTES = 60 * 24 * 7  # one week lookback ceiling

# Self-signed Wazuh certs: the broker is the trust boundary, verify is opt-in.
VERIFY_TLS = os.environ.get("WAZUH_BROKER_VERIFY_TLS", "false").lower() == "true"

app = FastAPI(title="Wazuh Query Broker", version="1.0.0", docs_url=None, redoc_url=None)

# ── Auth ──────────────────────────────────────────────────────────────────────
def _require_token(authorization: str | None) -> None:
    if not _TOKENS:
        raise HTTPException(status_code=503, detail="broker has no tokens configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization[len("Bearer "):].strip()
    if token not in _TOKENS:
        raise HTTPException(status_code=403, detail="invalid token")


# ── Indexer (OpenSearch) read ─────────────────────────────────────────────────
def _indexer_search(body: dict[str, Any]) -> dict[str, Any]:
    url = f"{INDEXER_URL}/{ALERTS_INDEX}/_search"
    try:
        with httpx.Client(verify=VERIFY_TLS, timeout=20.0) as client:
            r = client.post(url, json=body, auth=(INDEXER_USER, INDEXER_PASS))
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"indexer unreachable: {e.__class__.__name__}")
    if r.status_code == 401 or r.status_code == 403:
        raise HTTPException(status_code=502, detail="indexer auth failed (check broker_ro user)")
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"indexer error {r.status_code}")
    return r.json()


def _trim_alert(hit: dict[str, Any]) -> dict[str, Any]:
    src = hit.get("_source", {})
    rule = src.get("rule", {})
    agent = src.get("agent", {})
    return {
        "timestamp": src.get("timestamp") or src.get("@timestamp"),
        "agent": {"id": agent.get("id"), "name": agent.get("name"), "ip": agent.get("ip")},
        "rule": {
            "id": rule.get("id"),
            "level": rule.get("level"),
            "description": rule.get("description"),
            "groups": rule.get("groups"),
            "mitre": (rule.get("mitre") or {}).get("technique"),
        },
        "location": src.get("location"),
        "decoder": (src.get("decoder") or {}).get("name"),
        "full_log": (src.get("full_log") or "")[:500],
    }


# ── Manager API (agent status) ────────────────────────────────────────────────
_manager_token_cache: dict[str, Any] = {"token": None, "exp": 0.0}


def _manager_token() -> str:
    now = time.time()
    if _manager_token_cache["token"] and now < _manager_token_cache["exp"]:
        return _manager_token_cache["token"]
    try:
        with httpx.Client(verify=VERIFY_TLS, timeout=15.0) as client:
            r = client.post(
                f"{MANAGER_URL}/security/user/authenticate",
                auth=(MANAGER_USER, MANAGER_PASS),
            )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"manager unreachable: {e.__class__.__name__}")
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"manager auth failed {r.status_code}")
    token = r.json().get("data", {}).get("token")
    if not token:
        raise HTTPException(status_code=502, detail="manager returned no token")
    _manager_token_cache.update(token=token, exp=now + 600)  # tokens live ~15m; refresh early
    return token


def _manager_get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    token = _manager_token()
    try:
        with httpx.Client(verify=VERIFY_TLS, timeout=20.0) as client:
            r = client.get(f"{MANAGER_URL}{path}", params=params or {},
                           headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"manager unreachable: {e.__class__.__name__}")
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail=f"manager error {r.status_code}")
    return r.json()


# ── Endpoints (all read-only) ─────────────────────────────────────────────────
@app.get("/health")
def health() -> JSONResponse:
    """Liveness + indexer reachability. No auth (no data returned)."""
    status = {"broker": "ok", "indexer": "unknown", "tokens_configured": bool(_TOKENS)}
    try:
        body = {"size": 0, "query": {"match_all": {}}}
        _indexer_search(body)
        status["indexer"] = "reachable"
    except HTTPException as e:
        status["indexer"] = f"error: {e.detail}"
    return JSONResponse(status)


@app.get("/alerts")
def alerts(
    authorization: str | None = Header(default=None),
    q: str | None = Query(default=None, description="Lucene query_string, e.g. rule.groups:authentication_failed"),
    level_gte: int = Query(default=0, ge=0, le=16, description="minimum rule.level"),
    minutes: int = Query(default=DEFAULT_MINUTES, ge=1, le=MAX_MINUTES),
    agent: str | None = Query(default=None, description="filter by agent.name"),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
) -> dict[str, Any]:
    """Search recent Wazuh alerts, newest first. Read-only."""
    _require_token(authorization)
    filters: list[dict[str, Any]] = [
        {"range": {"timestamp": {"gte": f"now-{minutes}m"}}},
    ]
    if level_gte:
        filters.append({"range": {"rule.level": {"gte": level_gte}}})
    if agent:
        filters.append({"term": {"agent.name": agent}})
    must: list[dict[str, Any]] = []
    if q:
        must.append({"query_string": {"query": q, "default_operator": "AND"}})
    body = {
        "size": limit,
        "sort": [{"timestamp": {"order": "desc"}}],
        "query": {"bool": {"must": must or [{"match_all": {}}], "filter": filters}},
    }
    res = _indexer_search(body)
    hits = res.get("hits", {})
    total = hits.get("total", {})
    return {
        "total": total.get("value") if isinstance(total, dict) else total,
        "returned": len(hits.get("hits", [])),
        "window_minutes": minutes,
        "alerts": [_trim_alert(h) for h in hits.get("hits", [])],
    }


@app.get("/agents")
def agents(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """Agent inventory + connection status from the manager API. Read-only."""
    _require_token(authorization)
    data = _manager_get("/agents", params={
        "select": "id,name,ip,status,os.name,version,lastKeepAlive",
        "sort": "status",
        "limit": 200,
    })
    items = data.get("data", {}).get("affected_items", [])
    summary: dict[str, int] = {}
    for a in items:
        summary[a.get("status", "unknown")] = summary.get(a.get("status", "unknown"), 0) + 1
    return {"total": len(items), "status_summary": summary, "agents": items}


@app.get("/rule/{rule_id}")
def rule(rule_id: int, authorization: str | None = Header(default=None)) -> dict[str, Any]:
    """Look up a Wazuh rule definition by id. Read-only."""
    _require_token(authorization)
    data = _manager_get("/rules", params={"rule_ids": rule_id})
    items = data.get("data", {}).get("affected_items", [])
    return {"rule_id": rule_id, "found": bool(items), "rule": items[0] if items else None}
