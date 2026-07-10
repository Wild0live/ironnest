"""Hermes Mission Control — standalone localhost ops dashboard.

This service is INTENTIONALLY decoupled from the memory-gateway (the policy
kernel). It holds none of the gateway's secrets and is not on the agent or
OpenViking networks. It reads two of the gateway's files read-only:

    - the profile registry  (registry/profiles-registry.yaml, bind-mounted ro)
    - the audit log          (memory-gateway-log volume, mounted ro)

…and owns a small JSON store for tasks/schedules on its own volume. Writes are
optionally gated by MISSION_CONTROL_ADMIN_TOKEN; when unset, the Authelia FIDO
gate in front of this host is the auth boundary.  Its optional operations
integration carries only a runner-specific capability token, never Docker,
gateway, or profile credentials.
"""

from __future__ import annotations

import concurrent.futures
import hmac
import io
import json
import os
import re
import threading
import time
import zipfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import yaml
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

# ── Settings (env, with sane container defaults) ────────────────────────────
REGISTRY_FILE = Path(os.environ.get("MISSION_CONTROL_REGISTRY_FILE",
                                    "/etc/hermes-platform/registry/profiles-registry.yaml"))
POLICIES_DIR = Path(os.environ.get("MISSION_CONTROL_POLICIES_DIR",
                                   "/etc/hermes-platform/policies"))
AUDIT_LOG = Path(os.environ.get("MISSION_CONTROL_AUDIT_LOG", "/var/log/gateway/audit.log"))
STATE_FILE = Path(os.environ.get("MISSION_CONTROL_STATE_FILE",
                                 "/var/lib/mission-control/state.json"))
ADMIN_TOKEN = os.environ.get("MISSION_CONTROL_ADMIN_TOKEN", "").strip()

# Per-profile agent chat bridge (listener inside each hermes-pf-* container).
BRIDGE_TOKEN = os.environ.get("MISSION_CONTROL_BRIDGE_TOKEN", "").strip()
BRIDGE_PORT = int(os.environ.get("AGENT_BRIDGE_PORT", "8011"))
BRIDGE_TIMEOUT = int(os.environ.get("AGENT_BRIDGE_PROXY_TIMEOUT", "270"))
MCP_HEALTH_TIMEOUT = float(os.environ.get("MISSION_CONTROL_MCP_HEALTH_TIMEOUT", "12"))

# Optional, deliberately narrow lifecycle authority.  When either value is
# absent, the Operations API remains disabled.  The token is shared only with
# the internal operations-runner; it is never exposed to profile agents.
OPERATIONS_RUNNER_URL = os.environ.get("OPERATIONS_RUNNER_URL", "").rstrip("/")
OPERATIONS_RUNNER_TOKEN = os.environ.get("OPERATIONS_RUNNER_TOKEN", "").strip()
OPERATIONS_ALLOWED_CONTAINERS = frozenset(item.strip() for item in os.environ.get(
    "OPERATIONS_ALLOWED_CONTAINERS", "").split(",") if item.strip())
OPERATIONS_ALLOW_ALL_CONTAINERS = os.environ.get("OPERATIONS_ALLOW_ALL_CONTAINERS", "").strip().lower() in {
    "1", "true", "yes", "on"}
_DOCKER_CONTAINER_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$")
OPERATIONS_APPROVAL_TTL = int(os.environ.get("OPERATIONS_APPROVAL_TTL_SECONDS", "600"))
OPERATIONS_ARCHIVE_AFTER_DAYS = int(os.environ.get("OPERATIONS_ARCHIVE_AFTER_DAYS", "30"))
OPERATIONS_RETENTION_DAYS = int(os.environ.get("OPERATIONS_RETENTION_DAYS", "180"))
# Scoped credential held by Octo and Mission Control only. It authorizes a
# *proposal*, never Docker execution or approval.
OCTO_OPERATIONS_SUBMIT_TOKEN = os.environ.get("OCTO_OPERATIONS_SUBMIT_TOKEN", "").strip()
# Little John may submit a reviewed Windows-host remediation proposal only.
# This credential never authorizes approval or execution.
LITTLEJOHN_OPERATIONS_SUBMIT_TOKEN = os.environ.get("LITTLEJOHN_OPERATIONS_SUBMIT_TOKEN", "").strip()
LITTLEJOHN_PREAPPROVED_LIFECYCLE_TARGETS = frozenset(item.strip() for item in os.environ.get(
    "LITTLEJOHN_PREAPPROVED_LIFECYCLE_TARGETS", "").split(",") if item.strip())
HOST_OPERATIONS_RUNNER_URL = os.environ.get("HOST_OPERATIONS_RUNNER_URL", "").rstrip("/")
HOST_OPERATIONS_RUNNER_TOKEN = os.environ.get("HOST_OPERATIONS_RUNNER_TOKEN", "").strip()
HOST_OPERATIONS_QUEUE_DIR = Path(os.environ.get("HOST_OPERATIONS_QUEUE_DIR", "").strip())

# Sandboxed origin that serves complete static webapp artifacts LIVE (a separate
# host = a separate browser origin, so agent-authored HTML/JS can't script the
# Mission Control page; served by the read-only `artifact-apps` nginx container,
# behind the same Authelia FIDO gate). MC only builds links to it — it never
# serves app bytes itself.
APPS_BASE = os.environ.get("MISSION_CONTROL_APPS_BASE",
                           "https://apps.ironnest.local").rstrip("/")
TERMINAL_PLATFORM_URL = os.environ.get("MISSION_CONTROL_PLATFORM_TERMINAL_URL",
                                        "https://hermes-platform.ironnest.local/").strip()
WIKI_PUBLIC_URL = os.environ.get("MISSION_CONTROL_WIKI_URL",
                                 "https://wiki.ironnest.local/").strip()
WIKI_SESSION_COOKIE_DOMAIN = os.environ.get("MISSION_CONTROL_WIKI_COOKIE_DOMAIN",
                                            ".ironnest.local").strip() or None
WIKI_SESSION_COOKIE_SECURE = os.environ.get(
    "MISSION_CONTROL_WIKI_COOKIE_SECURE", "true").strip().lower() not in {"0", "false", "no", "off"}
AGENT_TERMINAL_URL_PATTERN = os.environ.get("MISSION_CONTROL_AGENT_TERMINAL_URL_PATTERN",
                                            "{platform_url}terminal/{profile}/").strip()

STATIC_DIR = Path(__file__).resolve().parent / "static"
_STORE_LOCK = threading.Lock()

TaskStatus = Literal["backlog", "active", "waiting", "done"]
TaskPriority = Literal["low", "normal", "high", "critical"]


class TaskCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=160)
    assignee: str = Field(default="default", min_length=1, max_length=64)
    priority: TaskPriority = "normal"
    project: str = Field(default="General", max_length=80)
    detail: str = Field(default="", max_length=2000)
    status: TaskStatus = "backlog"
    due: str | None = Field(default=None, max_length=40)


class TaskPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=160)
    assignee: str | None = Field(default=None, min_length=1, max_length=64)
    priority: TaskPriority | None = None
    project: str | None = Field(default=None, max_length=80)
    detail: str | None = Field(default=None, max_length=2000)
    status: TaskStatus | None = None
    due: str | None = Field(default=None, max_length=40)


class ScheduleCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=160)
    owner: str = Field(default="default", min_length=1, max_length=64)
    cadence: str = Field(default="manual", max_length=120)
    next_run: str | None = Field(default=None, max_length=60)
    detail: str = Field(default="", max_length=1000)


class CronCatchUp(BaseModel):
    owner: str | None = Field(default=None, max_length=64)
    job_id: str | None = Field(default=None, max_length=80)


class Attachment(BaseModel):
    name: str = Field(default="file", max_length=120)
    mime: str = Field(default="application/octet-stream", max_length=120)
    content_b64: str = Field(default="", max_length=34_000_000)  # ~25MB raw


class AgentChat(BaseModel):
    message: str = Field(default="", max_length=8000)
    session: str | None = Field(default=None, max_length=60)
    attachments: list[Attachment] = Field(default_factory=list)


OperationAction = Literal["start", "stop", "restart", "docker_api", "host_powershell"]


class OperationRequestCreate(BaseModel):
    """A proposal only.  Calling this endpoint never reaches Docker."""
    action: OperationAction
    target: str = Field(..., min_length=1, max_length=128)
    reason: str = Field(..., min_length=3, max_length=1000)
    requested_by: str = Field(default="operator", min_length=1, max_length=80)
    # Only used for docker_api. The exact request is retained with the approval
    # record, so an approver sees what will reach the Docker daemon.
    method: Literal["POST", "DELETE"] | None = None
    path: str | None = Field(default=None, max_length=300)
    body: dict[str, Any] | None = None
    # Only used for host_powershell. The operator reviews this exact text in
    # the Approvals sidebar before it can reach the Windows-host runner.
    script: str | None = Field(default=None, max_length=60_000)
    # Optional narrow-runner selector. A scoped host runner may ignore script
    # text and execute only its local implementation for this ID.
    remediation_id: str | None = Field(default=None, max_length=80)
    risk: Literal["low", "medium", "high", "critical"] = "medium"


class OperationApproval(BaseModel):
    approved_by: str = Field(..., min_length=1, max_length=80)
    note: str = Field(default="", max_length=500)


class AppReleasePublish(BaseModel):
    """An explicit promotion of a runnable artifact into the Apps catalogue."""
    task_id: str = Field(..., min_length=1, max_length=160)
    app_path: str = Field(default="", max_length=500)
    project_name: str = Field(..., min_length=1, max_length=120)
    release: str = Field(default="", max_length=80)
    purpose: str = Field(default="", max_length=500)


class AppReleaseCandidateSet(BaseModel):
    """Release-readiness evidence kept beside, never inside, an artifact."""
    task_id: str = Field(..., min_length=1, max_length=160)
    app_path: str = Field(default="", max_length=500)
    role: Literal["product", "implementation", "review", "deployment", "demo", "internal"]
    version: str = Field(default="", max_length=80)
    acceptance_passed: bool = False
    security_review: str = Field(default="", max_length=240)
    deployment_url: str = Field(default="", max_length=500)
    approved_by: str = Field(default="", max_length=120)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def require_admin(authorization: str | None = Header(default=None)) -> None:
    """If a token is configured, enforce it on writes. If not, the Authelia
    FIDO gate in front of this host is the auth boundary — allow."""
    if not ADMIN_TOKEN:
        return
    expected = f"Bearer {ADMIN_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="admin token required")


def require_octo_operations_submit(
    x_operations_submit_token: str | None = Header(default=None),
) -> None:
    if not OCTO_OPERATIONS_SUBMIT_TOKEN:
        raise HTTPException(status_code=503, detail="Octo operations submission is not configured")
    if not x_operations_submit_token or not hmac.compare_digest(
            x_operations_submit_token, OCTO_OPERATIONS_SUBMIT_TOKEN):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="operations submission token required")


def require_littlejohn_operations_submit(
    x_operations_submit_token: str | None = Header(default=None),
) -> None:
    if not LITTLEJOHN_OPERATIONS_SUBMIT_TOKEN:
        raise HTTPException(status_code=503, detail="Little John operations submission is not configured")
    if not x_operations_submit_token or not hmac.compare_digest(
            x_operations_submit_token, LITTLEJOHN_OPERATIONS_SUBMIT_TOKEN):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="operations submission token required")


# ── Persistent store (tasks + schedules) ────────────────────────────────────
def _default_store() -> dict[str, Any]:
    return {
        "tasks": [
            {
                "id": "seed-observe-agents",
                "title": "Review Hermes profile health",
                "assignee": "default",
                "priority": "high",
                "project": "IronNest Operations",
                "detail": "Use Mission Control to spot missing profiles, stale activity, or denied memory calls.",
                "status": "active",
                "due": None,
                "created_at": _now(),
                "updated_at": _now(),
            },
        ],
        "schedules": [],
        "operations": [],
        # Release metadata is Mission Control-owned. It never changes the
        # gateway-owned artifacts that supplied the runnable app.
        "app_releases": [],
        "app_candidates": [],
    }


def _read_store() -> dict[str, Any]:
    with _STORE_LOCK:
        if not STATE_FILE.exists():
            return _default_store()
        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return _default_store()
    if not isinstance(data, dict):
        return _default_store()
    data.setdefault("tasks", [])
    data.setdefault("schedules", [])
    data.setdefault("operations", [])
    data.setdefault("app_releases", [])
    data.setdefault("app_candidates", [])
    return data


def _write_store(data: dict[str, Any]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(STATE_FILE.suffix + ".tmp")
    body = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True)
    with _STORE_LOCK:
        tmp.write_text(body, encoding="utf-8")
        os.replace(tmp, STATE_FILE)


# ── Read-only views of gateway-owned files ──────────────────────────────────
def _profiles() -> list[dict[str, Any]]:
    try:
        doc = yaml.safe_load(REGISTRY_FILE.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError):
        return []
    out: list[dict[str, Any]] = []
    for p in doc.get("profiles", []):
        if not isinstance(p, dict) or not p.get("name"):
            continue
        policy_file = p.get("policy_file", "")
        policy_loaded = bool(policy_file) and (POLICIES_DIR / policy_file).exists()
        out.append({
            "name": p.get("name"),
            "namespace": p.get("namespace", ""),
            "approved_shared_namespace": p.get("approved_shared_namespace", ""),
            "container_name": p.get("container_name", ""),
            "status": p.get("status", "unknown"),
            "tags": list(p.get("tags", []) or []),
            "notes": p.get("notes", "") or "",
            "description": p.get("description", "") or "",
            "created_at": p.get("created_at", "") or "",
            "policy_loaded": policy_loaded,
        })
    return sorted(out, key=lambda item: item["name"])


def _with_trailing_slash(url: str) -> str:
    return url if not url or url.endswith("/") else f"{url}/"


def _agent_terminal_url(profile: dict[str, Any]) -> str:
    if not AGENT_TERMINAL_URL_PATTERN:
        return _with_trailing_slash(TERMINAL_PLATFORM_URL)
    name = str(profile.get("name", ""))
    container_name = str(profile.get("container_name") or f"hermes-pf-{name}")
    try:
        return _with_trailing_slash(AGENT_TERMINAL_URL_PATTERN.format(
            profile=name,
            name=name,
            platform_url=_with_trailing_slash(TERMINAL_PLATFORM_URL),
            container_name=container_name,
            container=container_name,
        ))
    except (KeyError, ValueError):
        return ""


def _recent_activity(limit: int = 40) -> list[dict[str, Any]]:
    if not AUDIT_LOG.exists():
        return []
    try:
        lines = AUDIT_LOG.read_text(encoding="utf-8").splitlines()[-limit:]
    except OSError:
        return []
    activity: list[dict[str, Any]] = []
    for line in reversed(lines):
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        activity.append({
            "ts": item.get("ts"),
            "profile": item.get("profile", "unknown"),
            "operation": item.get("operation", "unknown"),
            "decision": item.get("decision", "unknown"),
            "uri": item.get("uri", ""),
            "reason": item.get("reason", ""),
            "latency_ms": item.get("latency_ms"),
        })
    return activity


def _metrics(profiles: list[dict[str, Any]], tasks: list[dict[str, Any]],
             activity: list[dict[str, Any]]) -> dict[str, Any]:
    open_tasks = [t for t in tasks if t.get("status") != "done"]
    denied = [a for a in activity if a.get("decision") == "deny"]
    return {
        "agents": len(profiles),
        "enabled_agents": len([p for p in profiles if p.get("status") == "enabled"]),
        "open_tasks": len(open_tasks),
        "active_tasks": len([t for t in tasks if t.get("status") == "active"]),
        "recent_events": len(activity),
        "recent_denies": len(denied),
    }


# ── Routes ──────────────────────────────────────────────────────────────────
router = APIRouter()


# ── Per-profile, per-conversation chat history ──────────────────────────────
# Layout on the mission-control-state volume:
#   history/<profile>/index.json            -> {"conversations": [{id,title,...}]}
#   history/<profile>/conv-<id>.json        -> {"messages": [...]}
HISTORY_DIR = STATE_FILE.parent / "history"
HISTORY_MAX = 400
_HIST_LOCK = threading.Lock()
_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def _safe(value: str, fallback: str) -> str:
    return _SAFE.sub("_", value or "")[:64] or fallback


def _safe_rel(rel: str) -> str | None:
    """Validate a client-supplied relative artifact path (may contain '/'). Returns
    the normalised 'a/b/c' form, or None if any segment is empty/'.'/'..'/dotfile/
    charset-violating. Mirrors the bridge's `_safe_rel_parts` so MC rejects a bad
    path before it ever reaches the bridge (defence in depth)."""
    parts = [p for p in (rel or "").strip().strip("/").split("/") if p != ""]
    if not parts:
        return None
    for seg in parts:
        if seg in (".", "..") or seg.startswith(".") or _SAFE.search(seg):
            return None
    return "/".join(parts)


def _profile_dir(profile: str) -> Path:
    return HISTORY_DIR / _safe(profile, "profile")


def _index_path(profile: str) -> Path:
    return _profile_dir(profile) / "index.json"


def _conv_path(profile: str, conv: str) -> Path:
    return _profile_dir(profile) / f"conv-{_safe(conv, 'default')}.json"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_json(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def _conv_title_from(text: str) -> str:
    return " ".join((text or "").split())[:48] or "New chat"


def _snippet(text: str, query: str, width: int = 70) -> str:
    low = text.lower()
    i = low.find(query)
    if i < 0:
        return text[:width].strip()
    start = max(0, i - width // 2)
    end = min(len(text), i + len(query) + width // 2)
    out = text[start:end].strip()
    return ("…" if start > 0 else "") + out + ("…" if end < len(text) else "")


def search_profile(profile: str, query: str, limit: int = 50) -> list[dict[str, Any]]:
    q = query.strip().lower()
    if not q:
        return []
    results: list[dict[str, Any]] = []
    for c in list_conversations(profile):  # already sorted newest-first
        cid = c.get("id", "")
        title = c.get("title", "") or ""
        title_hit = q in title.lower()
        matches = 0
        snippet = ""
        for m in conv_history(profile, cid):
            text = m.get("text", "") or ""
            if q in text.lower():
                matches += 1
                if not snippet:
                    snippet = _snippet(text, q)
        if title_hit or matches:
            results.append({"id": cid, "title": title, "updated_at": c.get("updated_at", ""),
                            "snippet": snippet or title, "matches": matches,
                            "pinned": bool(c.get("pinned")),
                            "archived": bool(c.get("archived"))})
        if len(results) >= limit:
            break
    return results


def _att_meta(attachments: Any) -> list[dict[str, str]]:
    """Persist only attachment metadata (name/mime), never the base64 payload."""
    out = []
    for a in attachments or []:
        d = a if isinstance(a, dict) else a.model_dump()
        out.append({"name": d.get("name", "file"), "mime": d.get("mime", "")})
    return out


def list_conversations(profile: str) -> list[dict[str, Any]]:
    with _HIST_LOCK:
        convs = _read_json(_index_path(profile)).get("conversations", [])
    return sorted(convs, key=lambda c: c.get("updated_at", ""), reverse=True)


def create_conversation(profile: str, title: str | None = None) -> dict[str, Any]:
    with _HIST_LOCK:
        idx = _read_json(_index_path(profile))
        convs = idx.get("conversations", [])
        entry = {"id": f"c-{uuid.uuid4().hex[:12]}", "title": title or "New chat",
                 "created_at": _now(), "updated_at": _now()}
        convs.append(entry)
        _write_json(_index_path(profile), {"conversations": convs})
    return entry


def rename_conversation(profile: str, conv: str, title: str) -> None:
    with _HIST_LOCK:
        idx = _read_json(_index_path(profile))
        convs = idx.get("conversations", [])
        for c in convs:
            if c.get("id") == conv:
                c["title"] = title[:80] or c.get("title", "New chat")
                c["updated_at"] = _now()
                c["title_auto"] = False   # manual rename locks out auto-titling
        _write_json(_index_path(profile), {"conversations": convs})


def set_conversation_archived(profile: str, conv: str, archived: bool) -> bool:
    """Flip a conversation's archived flag. Returns True if the conv was found."""
    with _HIST_LOCK:
        idx = _read_json(_index_path(profile))
        convs = idx.get("conversations", [])
        entry = next((c for c in convs if c.get("id") == conv), None)
        if entry is None:
            return False
        entry["archived"] = bool(archived)
        entry["updated_at"] = _now()
        _write_json(_index_path(profile), {"conversations": convs})
    return True


def set_conversation_pinned(profile: str, conv: str, pinned: bool) -> bool:
    """Flip a conversation's pinned flag. Returns True if the conv was found."""
    with _HIST_LOCK:
        idx = _read_json(_index_path(profile))
        convs = idx.get("conversations", [])
        entry = next((c for c in convs if c.get("id") == conv), None)
        if entry is None:
            return False
        entry["pinned"] = bool(pinned)
        entry["pinned_at"] = _now() if pinned else None
        _write_json(_index_path(profile), {"conversations": convs})
    return True


def delete_conversation(profile: str, conv: str) -> None:
    with _HIST_LOCK:
        idx = _read_json(_index_path(profile))
        convs = [c for c in idx.get("conversations", []) if c.get("id") != conv]
        _write_json(_index_path(profile), {"conversations": convs})
        try:
            _conv_path(profile, conv).unlink()
        except OSError:
            pass


def conv_history(profile: str, conv: str) -> list[dict[str, Any]]:
    with _HIST_LOCK:
        return _read_json(_conv_path(profile, conv)).get("messages", [])


def conv_append(profile: str, conv: str, message: dict[str, Any],
                autotitle: str | None = None) -> None:
    with _HIST_LOCK:
        data = _read_json(_conv_path(profile, conv))
        messages = data.get("messages", [])
        messages.append(message)
        if len(messages) > HISTORY_MAX:
            messages = messages[-HISTORY_MAX:]
        _write_json(_conv_path(profile, conv), {"messages": messages})
        # keep the index in sync: create-on-first-use, bump updated_at, auto-title
        idx = _read_json(_index_path(profile))
        convs = idx.get("conversations", [])
        entry = next((c for c in convs if c.get("id") == conv), None)
        if entry is None:
            entry = {"id": conv, "title": autotitle or "New chat",
                     "created_at": _now(), "updated_at": _now(), "title_auto": True}
            convs.append(entry)
        else:
            entry["updated_at"] = _now()
            if autotitle and entry.get("title") in (None, "", "New chat"):
                entry["title"] = autotitle
        _write_json(_index_path(profile), {"conversations": convs})


def set_auto_title(profile: str, conv: str, title: str) -> bool:
    """Upgrade a conversation's title to an LLM-generated one — but ONLY if it's
    still auto (the user hasn't renamed it) and hasn't already been LLM-titled.
    Returns True if the title was changed."""
    title = " ".join((title or "").split())[:80]
    if not title:
        return False
    with _HIST_LOCK:
        idx = _read_json(_index_path(profile))
        convs = idx.get("conversations", [])
        entry = next((c for c in convs if c.get("id") == conv), None)
        if entry is None or not entry.get("title_auto", False) or entry.get("title_llm"):
            return False
        entry["title"] = title
        entry["title_llm"] = True          # generated once; don't regenerate
        entry["updated_at"] = _now()
        _write_json(_index_path(profile), {"conversations": convs})
    return True


def _bridge_reset(profile: str, conv: str | None = None) -> None:
    """Best-effort: tell the profile bridge to drop a conversation's ACP session
    (conv given) or its whole process (conv=None)."""
    by_name = {p["name"]: p for p in _profiles()}
    p = by_name.get(profile)
    if p is None:
        return
    host = p.get("container_name") or f"hermes-pf-{profile}"
    headers = {"Content-Type": "application/json"}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"
    body = json.dumps({"conv": conv} if conv else {}).encode("utf-8")
    try:
        urllib.request.urlopen(
            urllib.request.Request(f"http://{host}:{BRIDGE_PORT}/reset", data=body,
                                   headers=headers, method="POST"), timeout=10)
    except Exception:  # noqa: BLE001
        pass


def _bridge_title(profile: str, user: str, reply: str) -> str | None:
    """Ask the profile's bridge to generate a short topic title for the first
    exchange. Returns a cleaned title or None on any failure."""
    by_name = {p["name"]: p for p in _profiles()}
    p = by_name.get(profile)
    if p is None:
        return None
    host = p.get("container_name") or f"hermes-pf-{profile}"
    headers = {"Content-Type": "application/json"}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"
    body = json.dumps({"user": user[:1500], "reply": reply[:1500]}).encode("utf-8")
    try:
        with urllib.request.urlopen(
            urllib.request.Request(f"http://{host}:{BRIDGE_PORT}/title", data=body,
                                   headers=headers, method="POST"), timeout=120) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 — unreachable bridge, timeout, model error
        return None
    title = (payload or {}).get("title") if payload.get("ok") else None
    return title or None


# ── Per-task drawer chat history ────────────────────────────────────────────
# Chat threads attached to a specific kanban task. Stored in MC's state volume
# (MC never touches the board's SQLite, so this lives alongside MC state, not
# in /opt/kanban). One JSONL per task: tasks/<id>/chat.jsonl.
TASK_CHAT_DIR = STATE_FILE.parent / "task-chat"
TASK_CHAT_MAX = 400


def _task_chat_path(task_id: str) -> Path:
    return TASK_CHAT_DIR / _safe(task_id, "task") / "chat.jsonl"


def task_chat_history(task_id: str) -> list[dict[str, Any]]:
    p = _task_chat_path(task_id)
    if not p.exists():
        return []
    msgs: list[dict[str, Any]] = []
    try:
        with p.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msgs.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        return []
    return msgs[-TASK_CHAT_MAX:]


def task_chat_append(task_id: str, entry: dict[str, Any]) -> None:
    p = _task_chat_path(task_id)
    with _HIST_LOCK:
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")


@router.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse(content={"ok": True})


# Always-revalidate so a freshly-built UI is never masked by a stale browser
# cache (the page ships no asset versioning). ETag/Last-Modified still make the
# revalidation cheap (304 when unchanged).
_NOCACHE = {"Cache-Control": "no-cache"}


@router.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html", headers=_NOCACHE)


@router.get("/assets/{filename}")
async def asset(filename: str) -> FileResponse:
    allowed = {"app.js", "styles.css"}
    if filename not in allowed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="asset not found")
    return FileResponse(STATIC_DIR / filename, headers=_NOCACHE)


@router.get("/api/state")
async def state() -> JSONResponse:
    store = _read_store()
    profiles = _profiles()
    activity = _recent_activity()
    tasks = list(store.get("tasks", []))
    schedules = list(store.get("schedules", []))
    return JSONResponse(content={
        "generated_at": _now(),
        "profiles": profiles,
        "tasks": tasks,
        "schedules": schedules,
        "activity": activity,
        "metrics": _metrics(profiles, tasks, activity),
    })


@router.post("/api/tasks", status_code=201)
async def create_task(req: TaskCreate, _: None = Depends(require_admin)) -> JSONResponse:
    store = _read_store()
    task = {"id": f"task-{uuid.uuid4().hex[:12]}", **req.model_dump(),
            "created_at": _now(), "updated_at": _now()}
    store["tasks"].append(task)
    _write_store(store)
    return JSONResponse(status_code=201, content={"ok": True, "task": task})


@router.patch("/api/tasks/{task_id}")
async def patch_task(task_id: str, req: TaskPatch, _: None = Depends(require_admin)) -> JSONResponse:
    store = _read_store()
    patch = {k: v for k, v in req.model_dump().items() if v is not None}
    for task in store["tasks"]:
        if task.get("id") == task_id:
            task.update(patch)
            task["updated_at"] = _now()
            _write_store(store)
            return JSONResponse(content={"ok": True, "task": task})
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="task not found")


@router.post("/api/schedules", status_code=201)
async def create_schedule(req: ScheduleCreate, _: None = Depends(require_admin)) -> JSONResponse:
    store = _read_store()
    schedule = {"id": f"schedule-{uuid.uuid4().hex[:12]}", **req.model_dump(),
                "created_at": _now(), "updated_at": _now()}
    store["schedules"].append(schedule)
    _write_store(store)
    return JSONResponse(status_code=201, content={"ok": True, "schedule": schedule})


@router.get("/api/agents")
def agents() -> JSONResponse:
    """Profiles that can be chatted with (same roster as /api/state)."""
    return JSONResponse(content={"agents": _profiles()})


@router.get("/api/terminal-targets")
def terminal_targets() -> JSONResponse:
    targets: list[dict[str, Any]] = [{
        "id": "platform",
        "kind": "platform",
        "label": "Platform",
        "url": _with_trailing_slash(TERMINAL_PLATFORM_URL),
        "status": "online" if TERMINAL_PLATFORM_URL else "offline",
    }]
    for p in _profiles():
        name = p["name"]
        url = _agent_terminal_url(p)
        targets.append({
            "id": name,
            "kind": "agent",
            "label": name,
            "profile": name,
            "container_name": p.get("container_name", ""),
            "url": url,
            "status": "online" if p.get("status") == "enabled" and url else "offline",
        })
    return JSONResponse(content={"targets": targets})


@router.post("/api/agent/{profile}/chat")
def agent_chat(profile: str, req: AgentChat) -> JSONResponse:
    """Proxy a one-shot agent turn to the profile's in-container chat bridge.

    Sync def on purpose: the bridge call blocks ~20s+, so FastAPI runs this in
    its threadpool. Profile is validated against the registry; the bridge host
    is the profile's container_name on platform-net.
    """
    by_name = {p["name"]: p for p in _profiles()}
    p = by_name.get(profile)
    if p is None:
        raise HTTPException(status_code=404, detail="unknown profile")
    host = p.get("container_name") or f"hermes-pf-{profile}"
    url = f"http://{host}:{BRIDGE_PORT}/chat"
    body = json.dumps(req.model_dump()).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"
    conv = req.session or "default"
    user_entry = {"role": "user", "text": req.message,
                  "attachments": _att_meta(req.attachments), "ts": _now()}
    title = _conv_title_from(req.message)
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=BRIDGE_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            busy = (not payload.get("ok")) and "busy" in str(payload.get("error", "")).lower()
            if not busy:
                conv_append(profile, conv, user_entry, autotitle=title)
                if payload.get("ok") and payload.get("reply"):
                    conv_append(profile, conv, {"role": "agent", "text": payload["reply"], "ts": _now()})
            return JSONResponse(status_code=resp.status, content=payload)
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            detail = {"ok": False, "error": f"bridge returned HTTP {exc.code}"}
        if exc.code != 429:  # 429 = busy; client retries, so don't persist (avoids dupes)
            conv_append(profile, conv, user_entry, autotitle=title)
        return JSONResponse(status_code=exc.code, content=detail)
    except Exception as exc:  # noqa: BLE001 — unreachable bridge, timeout, etc.
        conv_append(profile, conv, user_entry, autotitle=title)
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": f"bridge unreachable: {exc}"})


@router.post("/api/agent/{profile}/chat/stream")
def agent_chat_stream(profile: str, req: AgentChat) -> StreamingResponse:
    """Stream a turn as Server-Sent Events, relaying the profile bridge's SSE
    (token chunks + a final done/error event) straight through to the browser."""
    by_name = {p["name"]: p for p in _profiles()}
    p = by_name.get(profile)
    if p is None:
        raise HTTPException(status_code=404, detail="unknown profile")
    host = p.get("container_name") or f"hermes-pf-{profile}"
    url = f"http://{host}:{BRIDGE_PORT}/chat/stream"
    body = json.dumps(req.model_dump()).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"

    conv = req.session or "default"
    user_entry = {"role": "user", "text": req.message,
                  "attachments": _att_meta(req.attachments), "ts": _now()}
    title = _conv_title_from(req.message)

    def relay():
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            resp = urllib.request.urlopen(request, timeout=BRIDGE_TIMEOUT)
        except Exception as exc:  # noqa: BLE001 — connect/HTTP error before stream starts
            conv_append(profile, conv, user_entry, autotitle=title)
            yield f"data: {json.dumps({'type': 'error', 'error': f'bridge unreachable: {exc}'})}\n\n"
            return
        assembled: list[str] = []
        flags = {"user": False, "agent": False}

        def save_user():
            if not flags["user"]:
                conv_append(profile, conv, user_entry, autotitle=title)
                flags["user"] = True

        try:
            for line in resp:
                if not line:
                    continue
                text = line.decode("utf-8", "replace")
                yield text
                s = text.strip()
                if not s.startswith("data:"):
                    continue
                try:
                    evt = json.loads(s[5:].strip())
                except json.JSONDecodeError:
                    continue
                etype = evt.get("type")
                if etype == "chunk":
                    save_user()  # turn is really proceeding now
                    assembled.append(evt.get("text", ""))
                elif etype == "done":
                    save_user()
                    # The bridge sends a rewritten `reply` when it turned a
                    # MEDIA: directive into a download link; persist that so the
                    # saved history carries the link, not the raw streamed text.
                    final = evt.get("reply") or "".join(assembled) or "(empty reply)"
                    conv_append(profile, conv, {"role": "agent",
                                                "text": final,
                                                "ts": _now()})
                    flags["agent"] = True
                elif etype == "error":
                    err = evt.get("error", "stream error")
                    if "busy" in err.lower():
                        # transient: agent occupied by another turn; client retries.
                        # Persist NOTHING so the message isn't duplicated on retry.
                        continue
                    save_user()
                    conv_append(profile, conv, {"role": "error", "text": err, "ts": _now()})
                    flags["agent"] = True
        finally:
            resp.close()
            if flags["user"] and not flags["agent"] and assembled:  # client disconnected mid-stream
                conv_append(profile, conv, {"role": "agent", "text": "".join(assembled), "ts": _now()})

    return StreamingResponse(relay(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/api/agents/health")
def agents_health() -> JSONResponse:
    """Liveness of each profile's in-container chat bridge.

    Pings `http://hermes-pf-<profile>:8011/healthz` for all profiles in parallel
    (short timeout). `true` = bridge answered 200 (container up + bridge running,
    so dashboard chat will work); `false` = unreachable. Drives the avatar
    online/offline dot. `/healthz` is unauthenticated on the bridge.
    """
    profiles = _profiles()

    def probe(p: dict[str, Any]) -> tuple[str, bool]:
        host = p.get("container_name") or f"hermes-pf-{p['name']}"
        url = f"http://{host}:{BRIDGE_PORT}/healthz"
        try:
            with urllib.request.urlopen(url, timeout=2.5) as resp:
                return p["name"], resp.status == 200
        except Exception:  # noqa: BLE001 — any failure = offline
            return p["name"], False

    health: dict[str, bool] = {}
    if profiles:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            for name, ok in ex.map(probe, profiles):
                health[name] = ok
    return JSONResponse(content={"health": health})


# ── Token-usage analytics — AGGREGATED across ALL agents ─────────────────────
# Each profile's bridge reads its own state.db `sessions` table and returns its
# own usage; Mission Control sums them. This is true platform-wide usage (the
# Hermes dashboard only ever reports the `default` profile's HERMES_HOME).
_USAGE_TTL = 30
_USAGE_WINDOW_DAYS = int(os.environ.get("MISSION_CONTROL_USAGE_DAYS", "30"))
_usage_cache: dict[str, Any] = {"ts": 0.0, "data": None}
_usage_lock = threading.Lock()


def _fetch_agent_usage(p: dict[str, Any]) -> dict[str, Any] | None:
    host = p.get("container_name") or f"hermes-pf-{p['name']}"
    headers = {}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"
    req = urllib.request.Request(f"http://{host}:{BRIDGE_PORT}/usage", headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 — agent down/unreachable; just skip it in the sum
        return None


@router.get("/api/usage")
def usage() -> JSONResponse:
    """Platform-wide token usage = sum of every agent's own state.db usage.
    Cached ~30s; serves stale on a transient hiccup rather than flapping."""
    now = time.time()
    with _usage_lock:
        cached = _usage_cache["data"]
        if cached and now - _usage_cache["ts"] < _USAGE_TTL:
            return JSONResponse(content=cached)

    profiles = _profiles()
    inp = out_t = sessions = calls = 0
    daily: dict[str, dict[str, int]] = {}
    got_any = False
    if profiles:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            for u in ex.map(_fetch_agent_usage, profiles):
                if not u or not u.get("ok"):
                    continue
                got_any = True
                inp += int(u.get("input", 0) or 0)
                out_t += int(u.get("output", 0) or 0)
                sessions += int(u.get("sessions", 0) or 0)
                calls += int(u.get("api_calls", 0) or 0)
                for d in (u.get("daily") or []):
                    day = d.get("day", "")
                    if not day:
                        continue
                    slot = daily.setdefault(day, {"input": 0, "output": 0})
                    slot["input"] += int(d.get("input", 0) or 0)
                    slot["output"] += int(d.get("output", 0) or 0)

    if not got_any:
        with _usage_lock:
            if _usage_cache["data"]:
                return JSONResponse(content=_usage_cache["data"])
        return JSONResponse(content={"ok": False})

    out = {
        "ok": True,
        "total_tokens": inp + out_t,
        "input_tokens": inp,
        "output_tokens": out_t,
        "total_sessions": sessions,
        "api_calls": calls,
        "period_days": _USAGE_WINDOW_DAYS,
        "daily": [{"day": d, **daily[d]} for d in sorted(daily)],
    }
    with _usage_lock:
        _usage_cache.update(ts=now, data=out)
    return JSONResponse(content=out)


# ── Scheduled cron jobs — AGGREGATED across ALL agents ───────────────────────
# Each profile's bridge reads its own /opt/data/cron/jobs.json and returns the
# trimmed job list; Mission Control tags each with its owner profile and unions
# them. This surfaces the REAL scheduled scripts (Hermes' own scheduler) on the
# calendar, not just MC's manual schedule store.
_CRON_TTL = 30
_cron_cache: dict[str, Any] = {"ts": 0.0, "data": None}
_cron_lock = threading.Lock()


def _fetch_agent_cron(p: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    host = p.get("container_name") or f"hermes-pf-{p['name']}"
    headers = {}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"
    req = urllib.request.Request(f"http://{host}:{BRIDGE_PORT}/cron", headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            return p["name"], json.loads(r.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 — agent down/unreachable; just skip it
        return p["name"], None


def _post_agent_cron_catchup(p: dict[str, Any], job_id: str | None = None) -> tuple[str, dict[str, Any]]:
    host = p.get("container_name") or f"hermes-pf-{p['name']}"
    payload = json.dumps({"job_id": job_id} if job_id else {}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"
    req = urllib.request.Request(
        f"http://{host}:{BRIDGE_PORT}/cron/catch-up",
        data=payload,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=BRIDGE_TIMEOUT) as r:
            return p["name"], json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            detail = {"ok": False, "error": f"HTTP {exc.code}"}
        return p["name"], detail
    except Exception as exc:  # noqa: BLE001
        return p["name"], {"ok": False, "error": str(exc), "ran": [], "skipped": []}


@router.get("/api/schedules/cron")
def schedules_cron() -> JSONResponse:
    """Every profile's Hermes cron jobs, each tagged with its owner. Cached ~30s;
    serves stale on a transient hiccup rather than flapping to empty."""
    now = time.time()
    with _cron_lock:
        cached = _cron_cache["data"]
        if cached and now - _cron_cache["ts"] < _CRON_TTL:
            return JSONResponse(content=cached)

    profiles = _profiles()
    jobs: list[dict[str, Any]] = []
    got_any = False
    if profiles:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            for prof, payload in ex.map(_fetch_agent_cron, profiles):
                if not payload or not payload.get("ok"):
                    continue
                got_any = True
                for j in payload.get("jobs") or []:
                    jobs.append({**j, "owner": prof})

    if not got_any:
        with _cron_lock:
            if _cron_cache["data"]:
                return JSONResponse(content=_cron_cache["data"])
        return JSONResponse(content={"ok": False, "jobs": []})

    out = {"ok": True, "generated_at": _now(), "jobs": jobs}
    with _cron_lock:
        _cron_cache.update(ts=now, data=out)
    return JSONResponse(content=out)


@router.post("/api/schedules/cron/catch-up")
def schedules_cron_catchup(req: CronCatchUp, _: None = Depends(require_admin)) -> JSONResponse:
    """Run each missed Hermes cron job once, scoped by profile/job when requested."""
    profiles = _profiles()
    if req.owner:
        profiles = [p for p in profiles if p["name"] == req.owner]
        if not profiles:
            raise HTTPException(status_code=404, detail="unknown profile")

    results: list[dict[str, Any]] = []
    if profiles:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            calls = ((p, req.job_id if req.owner or len(profiles) == 1 else None) for p in profiles)
            futures = [ex.submit(_post_agent_cron_catchup, p, job_id) for p, job_id in calls]
            for fut in concurrent.futures.as_completed(futures):
                prof, payload = fut.result()
                results.append({"owner": prof, **payload})

    ran = [item for r in results for item in (r.get("ran") or [])]
    skipped = [item for r in results for item in (r.get("skipped") or [])]
    with _cron_lock:
        _cron_cache.update(ts=0.0, data=None)
    return JSONResponse(content={
        "ok": all(r.get("ok") for r in results) if results else True,
        "generated_at": _now(),
        "results": sorted(results, key=lambda r: r.get("owner", "")),
        "ran": ran,
        "skipped": skipped,
    })


@router.get("/api/agent/{profile}/file/{name}")
def agent_file(profile: str, name: str) -> Response:
    """Download a file the agent produced in its uploads dir, via the bridge.

    The browser cannot reach `sandbox:/opt/data/...` paths inside the agent
    container, so this proxies the bridge's token-gated `/file` endpoint and
    streams the bytes back as an attachment. `name` is sanitised to a basename
    here AND re-validated by the bridge (defence in depth).
    """
    by_name = {p["name"]: p for p in _profiles()}
    p = by_name.get(profile)
    if p is None:
        raise HTTPException(status_code=404, detail="unknown profile")
    safe = os.path.basename(name)
    if not safe or safe in (".", "..") or _SAFE.search(safe):
        raise HTTPException(status_code=400, detail="bad file name")
    host = p.get("container_name") or f"hermes-pf-{profile}"
    url = f"http://{host}:{BRIDGE_PORT}/file?name={urllib.parse.quote(safe)}"
    headers = {}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=60) as resp:
            data = resp.read()
            ctype = resp.headers.get("Content-Type", "application/octet-stream")
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=exc.code if exc.code in (400, 401, 404) else 502,
                            detail="file not available")
    except Exception as exc:  # noqa: BLE001 — unreachable bridge, timeout, etc.
        raise HTTPException(status_code=502, detail=f"bridge unreachable: {exc}")
    return Response(content=data, media_type=ctype,
                    headers={"Content-Disposition": f'attachment; filename="{safe}"'})


class ConvRename(BaseModel):
    title: str = Field(..., min_length=1, max_length=80)


class ConvArchive(BaseModel):
    archived: bool = True


class ConvPin(BaseModel):
    pinned: bool = True


@router.get("/api/agent/{profile}/conversations")
def conversations_list(profile: str) -> JSONResponse:
    return JSONResponse(content={"conversations": list_conversations(profile)})


@router.post("/api/agent/{profile}/conversations", status_code=201)
def conversations_create(profile: str) -> JSONResponse:
    return JSONResponse(status_code=201, content={"conversation": create_conversation(profile)})


@router.patch("/api/agent/{profile}/conversations/{conv}")
def conversations_rename(profile: str, conv: str, req: ConvRename) -> JSONResponse:
    rename_conversation(profile, conv, req.title)
    return JSONResponse(content={"ok": True})


@router.post("/api/agent/{profile}/conversations/{conv}/autotitle")
def conversation_autotitle(profile: str, conv: str) -> JSONResponse:
    """Generate a short topic title from the first exchange (LLM via the bridge)
    and apply it — once, and only if the user hasn't renamed the conversation.
    Idempotent: re-calls return the existing title without hitting the bridge.

    Called by the client after the first reply lands; runs in the FastAPI
    threadpool (the bridge call blocks a few seconds)."""
    convs = {c.get("id"): c for c in list_conversations(profile)}
    entry = convs.get(conv)
    if entry is None:
        raise HTTPException(status_code=404, detail="unknown conversation")
    if not entry.get("title_auto", False) or entry.get("title_llm"):
        return JSONResponse(content={"ok": False, "title": entry.get("title", ""),
                                     "reason": "locked or already titled"})
    msgs = conv_history(profile, conv)
    user = next((m.get("text", "") for m in msgs if m.get("role") == "user"), "")
    reply = next((m.get("text", "") for m in msgs if m.get("role") == "agent"), "")
    if not user.strip() or not reply.strip():
        return JSONResponse(content={"ok": False, "reason": "no exchange yet"})
    title = _bridge_title(profile, user, reply)
    if title and set_auto_title(profile, conv, title):
        return JSONResponse(content={"ok": True, "title": title})
    return JSONResponse(content={"ok": False, "reason": "title generation failed"})


@router.post("/api/agent/{profile}/conversations/{conv}/archive")
def conversations_archive(profile: str, conv: str, req: ConvArchive) -> JSONResponse:
    if not set_conversation_archived(profile, conv, req.archived):
        raise HTTPException(status_code=404, detail="unknown conversation")
    return JSONResponse(content={"ok": True, "archived": req.archived})


@router.post("/api/agent/{profile}/conversations/{conv}/pin")
def conversations_pin(profile: str, conv: str, req: ConvPin) -> JSONResponse:
    if not set_conversation_pinned(profile, conv, req.pinned):
        raise HTTPException(status_code=404, detail="unknown conversation")
    return JSONResponse(content={"ok": True, "pinned": req.pinned})


@router.post("/api/agent/{profile}/conversations/{conv}/reset")
def conversation_reset(profile: str, conv: str) -> JSONResponse:
    """Clear the agent's context for this thread (drop its ACP session) WITHOUT
    deleting the saved transcript. Backs the chat `/clear` slash command."""
    _bridge_reset(profile, conv)
    return JSONResponse(content={"ok": True})


@router.delete("/api/agent/{profile}/conversations/{conv}")
def conversations_delete(profile: str, conv: str) -> JSONResponse:
    delete_conversation(profile, conv)
    _bridge_reset(profile, conv)
    return JSONResponse(content={"ok": True})


@router.get("/api/agent/{profile}/conversations/{conv}/history")
def conversation_history(profile: str, conv: str) -> JSONResponse:
    return JSONResponse(content={"messages": conv_history(profile, conv)})


@router.get("/api/agent/{profile}/search")
def search_conversations(profile: str, q: str = "") -> JSONResponse:
    return JSONResponse(content={"results": search_profile(profile, q)})


# ── Per-agent avatar (emoji or uploaded image; default is generated client-side)
AGENT_META_FILE = STATE_FILE.parent / "agent-meta.json"
_META_LOCK = threading.Lock()


def _read_agent_meta() -> dict[str, Any]:
    return _read_json(AGENT_META_FILE).get("agents", {})


class AvatarSet(BaseModel):
    emoji: str | None = Field(default=None, max_length=16)
    image: str | None = Field(default=None, max_length=700_000)  # ~500KB data URL


class LabelSet(BaseModel):
    # Operator-facing display name shown on the agent card in place of the
    # profile id. The id (e.g. "default") stays the canonical key everywhere
    # else (container, volume, registry, tokens); this is purely presentation.
    label: str | None = Field(default=None, max_length=64)


@router.get("/api/agents/meta")
def agents_meta() -> JSONResponse:
    return JSONResponse(content={"meta": _read_agent_meta()})


@router.put("/api/agent/{profile}/avatar")
def set_avatar(profile: str, req: AvatarSet) -> JSONResponse:
    if req.image and req.image.startswith("data:image/"):
        icon = {"image": req.image}
    elif req.emoji and req.emoji.strip():
        icon = {"emoji": req.emoji.strip()[:8]}
    else:
        raise HTTPException(status_code=400, detail="provide an emoji or a data:image/ image")
    with _META_LOCK:
        meta = _read_agent_meta()
        # Merge the icon into the existing entry — the icon is image XOR emoji,
        # so drop both then apply the new one, but preserve a `label` if set.
        entry = dict(meta.get(profile, {}))
        entry.pop("image", None)
        entry.pop("emoji", None)
        entry.update(icon)
        meta[profile] = entry
        _write_json(AGENT_META_FILE, {"agents": meta})
    return JSONResponse(content={"ok": True, "avatar": entry})


@router.delete("/api/agent/{profile}/avatar")
def clear_avatar(profile: str) -> JSONResponse:
    with _META_LOCK:
        meta = _read_agent_meta()
        # Clear only the icon; keep a `label` if the agent has one.
        entry = dict(meta.get(profile, {}))
        entry.pop("image", None)
        entry.pop("emoji", None)
        if entry:
            meta[profile] = entry
        else:
            meta.pop(profile, None)
        _write_json(AGENT_META_FILE, {"agents": meta})
    return JSONResponse(content={"ok": True})


@router.put("/api/agent/{profile}/label")
def set_label(profile: str, req: LabelSet) -> JSONResponse:
    label = (req.label or "").strip()[:64]
    with _META_LOCK:
        meta = _read_agent_meta()
        entry = dict(meta.get(profile, {}))
        if label:
            entry["label"] = label
        else:
            entry.pop("label", None)
        if entry:
            meta[profile] = entry
        else:
            meta.pop(profile, None)
        _write_json(AGENT_META_FILE, {"agents": meta})
    return JSONResponse(content={"ok": True, "meta": entry})


# ── Per-agent SOUL.md + model (proxied to the profile bridge) ────────────────
def _bridge_host(profile: str) -> str:
    by_name = {p["name"]: p for p in _profiles()}
    p = by_name.get(profile)
    if p is None:
        raise HTTPException(status_code=404, detail="unknown profile")
    return p.get("container_name") or f"hermes-pf-{profile}"


def _bridge_json(profile: str, method: str, path: str,
                 body: dict[str, Any] | None = None,
                 timeout: int = 30) -> tuple[int, dict[str, Any]]:
    """Call the profile bridge and relay (status, json). 502 on unreachable."""
    url = f"http://{_bridge_host(profile)}:{BRIDGE_PORT}{path}"
    headers = {"Content-Type": "application/json"}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            return exc.code, {"ok": False, "error": f"bridge HTTP {exc.code}"}
    except Exception as exc:  # noqa: BLE001 — unreachable bridge, timeout, etc.
        return 502, {"ok": False, "error": f"bridge unreachable: {exc}"}


class SoulSet(BaseModel):
    text: str = Field(..., max_length=200_000)


class ModelSet(BaseModel):
    model_config = {"protected_namespaces": ()}
    model: str = Field(..., min_length=1, max_length=120)
    # Optional: the provider the chosen model belongs to. Sent by the model
    # picker so a cross-provider selection also switches model.provider. Omitted
    # for same-provider switches (the common case).
    provider: str | None = Field(default=None, max_length=60)


@router.get("/api/agent/{profile}/meta")
def agent_meta_view(profile: str) -> JSONResponse:
    """Model + SOUL.md summary shown on the agent card."""
    code, payload = _bridge_json(profile, "GET", "/meta")
    return JSONResponse(status_code=code, content=payload)


@router.get("/api/agents/mcp-health")
def agents_mcp_health() -> JSONResponse:
    """Live-polled MCP server health, gathered through each profile bridge."""
    profiles = _profiles()

    def probe(p: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        name = str(p.get("name", ""))
        code, payload = _bridge_json(name, "GET", "/mcp-health", timeout=MCP_HEALTH_TIMEOUT)
        if code == 200 and isinstance(payload, dict):
            return name, payload
        error = payload.get("error", f"bridge HTTP {code}") if isinstance(payload, dict) else f"bridge HTTP {code}"
        return name, {"ok": False, "profile": name, "servers": [], "summary": {
            "configured": 0, "online": 0, "standby": 0, "disabled": 0,
            "offline": 0, "unknown": 0, "gated": 0, "on_demand": 0,
        }, "error": error}

    health: dict[str, Any] = {}
    if profiles:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
            for name, payload in ex.map(probe, profiles):
                health[name] = payload
    return JSONResponse(content={"ok": True, "generated_at": _now(), "health": health})


@router.get("/api/agent/{profile}/soul")
def agent_soul_get(profile: str) -> JSONResponse:
    code, payload = _bridge_json(profile, "GET", "/soul")
    return JSONResponse(status_code=code, content=payload)


@router.get("/api/agent/{profile}/models")
def agent_models(profile: str) -> JSONResponse:
    """Available providers + models for the picker (same source as `/model`)."""
    code, payload = _bridge_json(profile, "GET", "/models")
    return JSONResponse(status_code=code, content=payload)


@router.put("/api/agent/{profile}/soul")
def agent_soul_put(profile: str, req: SoulSet, _: None = Depends(require_admin)) -> JSONResponse:
    code, payload = _bridge_json(profile, "PUT", "/soul", {"text": req.text})
    return JSONResponse(status_code=code, content=payload)


@router.put("/api/agent/{profile}/model")
def agent_model_put(profile: str, req: ModelSet, _: None = Depends(require_admin)) -> JSONResponse:
    body: dict[str, Any] = {"model": req.model}
    if req.provider:
        body["provider"] = req.provider
    code, payload = _bridge_json(profile, "PUT", "/model", body)
    return JSONResponse(status_code=code, content=payload)


# ── Shared Kanban board (proxied to a board-gateway profile's bridge) ────────
# MC stays decoupled: it never mounts the SQLite file. All board reads/writes go
# through one profile's `/kanban` bridge endpoint (a pure `hermes kanban` CLI op,
# NOT an agent turn). `default` is the board gateway; any profile would do since
# they all share /opt/kanban.
def _board_profile() -> str:
    names = [p["name"] for p in _profiles()]
    return "default" if "default" in names else (names[0] if names else "default")


def _orchestrator() -> str:
    """The agent that runs `decompose` (the orchestrator role). Configurable and
    persisted in the store's settings; falls back to the board gateway."""
    chosen = (_read_store().get("settings") or {}).get("orchestrator") or ""
    return chosen if chosen in {p["name"] for p in _profiles()} else _board_profile()


def _kanban_bridge(body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    return _bridge_json(_board_profile(), "POST", "/kanban", body, timeout=40)


class KanbanCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    body: str = Field(default="", max_length=4000)
    assignee: str = Field(default="", max_length=64)
    priority: int | None = None
    parent: str = Field(default="", max_length=64)
    workspace: str = Field(default="", max_length=200)
    triage: bool = False


class KanbanComment(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)


class KanbanMove(BaseModel):
    model_config = {"populate_by_name": True}
    to: str = Field(..., max_length=20)
    from_: str = Field(default="", max_length=20, alias="from")
    result: str = Field(default="", max_length=2000)


class KanbanAssign(BaseModel):
    assignee: str = Field(..., min_length=1, max_length=64)


class KanbanLink(BaseModel):
    parent: str = Field(..., min_length=1, max_length=64)
    child: str = Field(..., min_length=1, max_length=64)


class KanbanGateRecord(BaseModel):
    gate: str = Field(..., min_length=1, max_length=60)
    state: Literal["pass", "fail", "waived"] = "pass"
    evidence: str = Field(default="", max_length=2000)


class KanbanPlaybookPreview(BaseModel):
    playbook: str = Field(default="auto", max_length=40)
    security: bool = False


class KanbanPlanNode(BaseModel):
    key: str = Field(..., min_length=1, max_length=40)
    title: str = Field(..., min_length=1, max_length=200)
    body: str = Field(default="", max_length=4000)
    assignee: str = Field(default="", max_length=64)
    priority: int | None = None
    skills: list[str] = Field(default_factory=list)
    max_runtime: str = Field(default="", max_length=32)
    goal: bool = False
    gate: str = Field(default="", max_length=60)


class KanbanPlanEdge(BaseModel):
    parent: str = Field(..., min_length=1, max_length=64)
    child: str = Field(..., min_length=1, max_length=64)


class KanbanPlaybookCommit(BaseModel):
    playbook: str = Field(default="custom", max_length=40)
    nodes: list[KanbanPlanNode] = Field(default_factory=list, max_length=12)
    edges: list[KanbanPlanEdge] = Field(default_factory=list, max_length=32)


class KanbanBulkTasks(BaseModel):
    ids: list[str] = Field(default_factory=list, min_length=1, max_length=12)


def _profile_names() -> set[str]:
    return {str(p.get("name") or "") for p in _profiles()}


def _pick_profile(*needles: str, fallback: str = "") -> str:
    profiles = _profiles()
    if not profiles:
        return fallback
    names = [str(p.get("name") or "") for p in profiles]
    haystacks = {
        str(p.get("name") or ""): " ".join([
            str(p.get("name") or ""),
            " ".join(str(t) for t in p.get("tags") or []),
            str(p.get("notes") or ""),
        ]).lower()
        for p in profiles
    }
    for needle in needles:
        n = needle.lower()
        for name in names:
            if n and n in haystacks.get(name, ""):
                return name
    if fallback in names:
        return fallback
    return _orchestrator() if _orchestrator() in names else names[0]


def _node_body(goal: dict[str, Any], role: str, gate: str = "") -> str:
    title = str(goal.get("title") or "Goal")
    body = str(goal.get("body") or "").strip()
    base = [
        f"Parent goal: {title}",
        "",
        "Work from the parent task context and save durable evidence to the task artifacts directory.",
    ]
    if body:
        base.extend(["", "Original request:", body[:1200]])
    if role == "build":
        base.extend(["", "Deliver implementation changes plus a short implementation note."])
    elif role == "qa":
        base.extend(["", "Verify behavior, run the relevant checks, and record pass/fail evidence."])
    elif role == "security":
        base.extend(["", "Review the change for security impact, secrets, auth boundaries, and unsafe exposure."])
    elif role == "synthesis":
        base.extend(["", "Synthesize the specialist outputs into a concise operator-facing handoff."])
    if gate:
        base.extend(["", f"Gate: {gate}"])
    return "\n".join(base)[:4000]


def _recommend_playbook(goal: dict[str, Any], requested: str) -> tuple[str, str]:
    requested = (requested or "auto").strip().lower()
    if requested in {"code", "research", "analysis"}:
        return ("research" if requested == "analysis" else requested), "operator override"
    text = " ".join([
        str(goal.get("title") or ""),
        str(goal.get("body") or ""),
    ]).lower()
    code_terms = {
        "implement", "build", "fix", "bug", "code", "ui", "api", "endpoint",
        "deploy", "refactor", "test", "security", "qa", "feature", "app",
        "component", "database", "docker", "compose", "mission control",
    }
    research_terms = {
        "compare", "contrast", "explain", "research", "analyze", "analysis",
        "summarize", "recommend", "investigate", "what is", "why", "which",
        "pros", "cons", "options", "document",
    }
    code_hits = sorted(term for term in code_terms if term in text)
    research_hits = sorted(term for term in research_terms if term in text)
    if research_hits and len(research_hits) > len(code_hits):
        return "research", f"matched research terms: {', '.join(research_hits[:4])}"
    if code_hits:
        return "code", f"matched delivery terms: {', '.join(code_hits[:4])}"
    return "code", "defaulted to code delivery"


def _playbook_preview_payload(task_id: str, req: KanbanPlaybookPreview) -> dict[str, Any]:
    data = _show_task(task_id, {})
    goal = data.get("task") or {}
    if not goal:
        raise ValueError("task not found")
    goal_title = str(goal.get("title") or task_id)
    requested_playbook = (req.playbook or "auto").strip().lower()
    playbook, playbook_reason = _recommend_playbook(goal, requested_playbook)
    code_owner = _pick_profile("steve", "code", "developer", fallback=_board_profile())
    qa_owner = _pick_profile("qa", "quality", "test", fallback=code_owner)
    security_owner = _pick_profile("little", "security", "wazuh", "octo", fallback=qa_owner)
    synthesizer = _pick_profile("jaime", "smith", "architect", "synthesis", fallback=_orchestrator())
    priority = goal.get("priority")
    nodes: list[dict[str, Any]]
    edges: list[dict[str, str]]
    if playbook in {"research", "analysis"}:
        researcher = _pick_profile("research", "analyst", "default", fallback=_board_profile())
        nodes = [
            {"key": "research", "title": f"Research: {goal_title}", "assignee": researcher,
             "priority": priority, "body": _node_body(goal, "research")},
            {"key": "verify", "title": f"Verify findings: {goal_title}", "assignee": qa_owner,
             "priority": priority, "body": _node_body(goal, "qa", "verification pass")},
            {"key": "synthesis", "title": f"Synthesize answer: {goal_title}", "assignee": synthesizer,
             "priority": priority, "body": _node_body(goal, "synthesis", "final synthesis")},
        ]
        edges = [{"parent": "research", "child": "verify"},
                 {"parent": "verify", "child": "synthesis"},
                 {"parent": "synthesis", "child": task_id}]
    else:
        nodes = [
            {"key": "build", "title": f"Implement: {goal_title}", "assignee": code_owner,
             "priority": priority, "body": _node_body(goal, "build"), "goal": True},
            {"key": "qa", "title": f"QA verify: {goal_title}", "assignee": qa_owner,
             "priority": priority, "body": _node_body(goal, "qa", "QA pass"), "gate": "QA pass"},
            {"key": "synthesis", "title": f"Synthesize delivery: {goal_title}", "assignee": synthesizer,
             "priority": priority, "body": _node_body(goal, "synthesis", "final synthesis"),
             "gate": "final synthesis"},
        ]
        edges = [{"parent": "build", "child": "qa"},
                 {"parent": "qa", "child": "synthesis"},
                 {"parent": "synthesis", "child": task_id}]
        if req.security:
            nodes.insert(2, {"key": "security", "title": f"Security review: {goal_title}",
                             "assignee": security_owner, "priority": priority,
                             "body": _node_body(goal, "security", "security pass"),
                             "gate": "security pass"})
            edges = [{"parent": "build", "child": "qa"},
                     {"parent": "build", "child": "security"},
                     {"parent": "qa", "child": "synthesis"},
                     {"parent": "security", "child": "synthesis"},
                     {"parent": "synthesis", "child": task_id}]
    return {"ok": True, "task_id": task_id, "playbook": playbook,
            "requested_playbook": requested_playbook,
            "playbook_auto": requested_playbook == "auto",
            "playbook_reason": playbook_reason, "nodes": nodes,
            "edges": edges, "profiles": sorted(_profile_names())}


def _annotate_links(tasks: list[Any]) -> None:
    """Tag each board task as the GOAL of a decomposed effort or one of its
    SUBTASKS, so the board can show the hierarchy. One cheap `links` read from the
    board bridge (the whole task_links DAG) — NOT a per-task `show` N+1, so it's
    safe on the 15s board poll.

    The board models an effort as a dependency DAG: `decompose` keeps the original
    triage task as the GOAL and makes the pieces its prerequisites. So in
    task_links (parent_id = prerequisite, child_id = dependent) the goal is the
    terminal node — it has prerequisites but nothing depends on it. This mirrors
    the drawer's `isGoal`. Every other linked task is a subtask; unlinked tasks are
    standalone (no label). The goal's `subtask_count` is its prerequisite count."""
    code, payload = _kanban_bridge({"action": "links"})
    if code != 200 or not payload.get("ok"):
        return
    is_prereq: set[str] = set()        # appears as parent_id -> prerequisite of something
    has_prereqs: set[str] = set()      # appears as child_id  -> depends on something
    prereq_count: dict[str, int] = {}  # task id -> how many prerequisites it has
    children: dict[str, list[str]] = {}
    for edge in payload.get("links") or []:
        p, c = edge.get("parent"), edge.get("child")
        if p:
            is_prereq.add(p)
        if c:
            has_prereqs.add(c)
            prereq_count[c] = prereq_count.get(c, 0) + 1
        if p and c:
            children.setdefault(p, []).append(c)
    goal_ids = {tid for tid in has_prereqs if tid not in is_prereq}

    def goal_for(tid: str) -> str:
        """Return the terminal goal for a linked task, if one is discoverable."""
        seen: set[str] = set()
        queue = list(children.get(tid, []))
        while queue:
            cur = queue.pop(0)
            if cur in seen:
                continue
            seen.add(cur)
            if cur in goal_ids:
                return cur
            queue.extend(children.get(cur, []))
        return ""

    for t in tasks:
        if not isinstance(t, dict):
            continue
        tid = t.get("id")
        linked = tid in is_prereq or tid in has_prereqs
        is_goal = tid in has_prereqs and tid not in is_prereq
        t["is_goal"] = is_goal
        t["is_subtask"] = linked and not is_goal
        t["subtask_count"] = prereq_count.get(tid, 0) if is_goal else 0
        t["link_role"] = "goal" if is_goal else ("subtask" if linked else "")
        t["goal_id"] = "" if is_goal else (goal_for(tid) if linked else "")


@router.get("/api/kanban")
def kanban_list(status: str = "", assignee: str = "", archived: bool = False) -> JSONResponse:
    code, payload = _kanban_bridge({"action": "list", "status": status,
                                    "assignee": assignee, "archived": archived})
    if code == 200 and payload.get("ok") and isinstance(payload.get("data"), list):
        _annotate_links(payload["data"])
    return JSONResponse(status_code=code, content=payload)


@router.get("/api/kanban/{task_id}")
def kanban_show(task_id: str) -> JSONResponse:
    code, payload = _kanban_bridge({"action": "show", "id": task_id})
    return JSONResponse(status_code=code, content=payload)


# Window in which an identical create is treated as an accidental repeat (a
# double-click or a client retry) rather than a deliberate second task.
_KANBAN_DEDUP_WINDOW_SEC = 90


def _recent_kanban_duplicate(req: KanbanCreate) -> dict[str, Any] | None:
    """Return a just-created board task identical to `req` (same title +
    assignee, and body when the listing carries one) within the dedup window, so
    an accidental double-submit is idempotent instead of minting a twin.

    Returns None — and the create proceeds normally — whenever we can't be sure:
    the list call fails, or the candidate carries no timestamp (`_task_updated`
    falls back to 0, which is always older than the window). So this only ever
    suppresses a create when timestamps positively confirm a recent twin; it
    never blocks a legitimate, later identical task."""
    code, payload = _kanban_bridge({"action": "list", "archived": False})
    if code != 200 or not payload.get("ok") or not isinstance(payload.get("data"), list):
        return None
    now = int(time.time())
    title = req.title.strip()
    assignee = (req.assignee or "").strip()
    body = (req.body or "").strip()
    for t in payload["data"]:
        if not isinstance(t, dict):
            continue
        if now - _task_updated(t) > _KANBAN_DEDUP_WINDOW_SEC:
            continue
        if str(t.get("title", "")).strip() != title:
            continue
        if str(t.get("assignee", "")).strip() != assignee:
            continue
        # The list summary may omit the body; only compare it when present so a
        # body-less listing still dedups on title+assignee.
        if "body" in t and str(t.get("body", "")).strip() != body:
            continue
        return t
    return None


@router.post("/api/kanban")
def kanban_create(req: KanbanCreate, _: None = Depends(require_admin)) -> JSONResponse:
    dup = _recent_kanban_duplicate(req)
    if dup is not None:
        return JSONResponse(status_code=200, content={"ok": True, "data": dup, "deduped": True})
    code, payload = _kanban_bridge({"action": "create", **req.model_dump()})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/{task_id}/comment")
def kanban_comment(task_id: str, req: KanbanComment, _: None = Depends(require_admin)) -> JSONResponse:
    code, payload = _kanban_bridge({"action": "comment", "id": task_id, "text": req.text})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/{task_id}/move")
def kanban_move(task_id: str, req: KanbanMove, _: None = Depends(require_admin)) -> JSONResponse:
    if req.to == "archived" and _is_goal_task(task_id):
        return JSONResponse(content=_archive_task_component(task_id))
    code, payload = _kanban_bridge({"action": "move", "id": task_id,
                                    "to": req.to, "from": req.from_, "result": req.result})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/{task_id}/assign")
def kanban_assign(task_id: str, req: KanbanAssign, _: None = Depends(require_admin)) -> JSONResponse:
    code, payload = _kanban_bridge({"action": "assign", "id": task_id, "assignee": req.assignee})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/{task_id}/clarify")
def kanban_clarify(task_id: str, _: None = Depends(require_admin)) -> JSONResponse:
    """Clarify a vague triage card into a concrete spec through the configured
    orchestrator profile. This is a bounded LLM turn and records its own audit
    comment on the Kanban task."""
    code, payload = _bridge_json(_orchestrator(), "POST", "/kanban",
                                 {"action": "specify", "id": task_id}, timeout=250)
    return JSONResponse(status_code=code, content=payload)


@router.get("/api/kanban/board/stats")
def kanban_stats() -> JSONResponse:
    code, payload = _kanban_bridge({"action": "stats"})
    return JSONResponse(status_code=code, content=payload)


@router.get("/api/kanban/board/assignees")
def kanban_assignees() -> JSONResponse:
    code, payload = _kanban_bridge({"action": "assignees"})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/bulk/clarify")
def kanban_bulk_clarify(req: KanbanBulkTasks, _: None = Depends(require_admin)) -> JSONResponse:
    results: list[dict[str, Any]] = []
    for task_id in dict.fromkeys(req.ids):
        code, payload = _bridge_json(_orchestrator(), "POST", "/kanban",
                                     {"action": "specify", "id": task_id}, timeout=250)
        results.append({"id": task_id, "ok": code == 200 and bool(payload.get("ok")),
                        "status": code, "error": payload.get("error", "")})
    return JSONResponse(content={"ok": all(r["ok"] for r in results), "results": results})


@router.post("/api/kanban/bulk/decompose")
def kanban_bulk_decompose(req: KanbanBulkTasks, _: None = Depends(require_admin)) -> JSONResponse:
    results: list[dict[str, Any]] = []
    for task_id in dict.fromkeys(req.ids):
        code, payload = _bridge_json(_orchestrator(), "POST", "/kanban",
                                     {"action": "decompose", "id": task_id}, timeout=250)
        results.append({"id": task_id, "ok": code == 200 and bool(payload.get("ok")),
                        "status": code, "error": payload.get("error", "")})
    return JSONResponse(content={"ok": all(r["ok"] for r in results), "results": results})


@router.get("/api/kanban/{task_id}/runs")
def kanban_runs(task_id: str) -> JSONResponse:
    code, payload = _kanban_bridge({"action": "runs", "id": task_id})
    return JSONResponse(status_code=code, content=payload)


@router.get("/api/kanban/{task_id}/context")
def kanban_context(task_id: str) -> JSONResponse:
    code, payload = _kanban_bridge({"action": "context", "id": task_id})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/{task_id}/link")
def kanban_link(task_id: str, req: KanbanLink, _: None = Depends(require_admin)) -> JSONResponse:
    code, payload = _kanban_bridge({"action": "link", "parent": req.parent, "child": req.child})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/{task_id}/unlink")
def kanban_unlink(task_id: str, req: KanbanLink, _: None = Depends(require_admin)) -> JSONResponse:
    code, payload = _kanban_bridge({"action": "unlink", "parent": req.parent, "child": req.child})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/{task_id}/gate")
def kanban_gate(task_id: str, req: KanbanGateRecord, _: None = Depends(require_admin)) -> JSONResponse:
    text = json.dumps({
        "kind": "ironnest_gate_v1",
        "gate": req.gate,
        "state": req.state,
        "evidence": req.evidence,
        "recorded_at": int(time.time()),
    }, ensure_ascii=False, sort_keys=True)
    code, payload = _kanban_bridge({"action": "comment", "id": task_id, "text": text,
                                    "author": "mission-control-gate"})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/{task_id}/playbook/preview")
def kanban_playbook_preview(task_id: str, req: KanbanPlaybookPreview,
                            _: None = Depends(require_admin)) -> JSONResponse:
    try:
        payload = _playbook_preview_payload(task_id, req)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"ok": False, "error": f"preview failed: {exc}"})
    return JSONResponse(content=payload)


@router.post("/api/kanban/{task_id}/playbook/commit")
def kanban_playbook_commit(task_id: str, req: KanbanPlaybookCommit,
                           _: None = Depends(require_admin)) -> JSONResponse:
    if not req.nodes:
        return JSONResponse(status_code=400, content={"ok": False, "error": "plan has no nodes"})
    profile_names = _profile_names()
    key_to_id: dict[str, str] = {task_id: task_id, "goal": task_id}
    created: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for node in req.nodes:
        if node.assignee and node.assignee not in profile_names:
            return JSONResponse(status_code=400, content={"ok": False,
                                "error": f"unknown assignee '{node.assignee}'"})
        body = node.body
        if node.gate:
            body = f"{body}\n\nRequired gate: {node.gate}".strip()
        code, payload = _kanban_bridge({
            "action": "create",
            "title": node.title,
            "body": body,
            "assignee": node.assignee,
            "priority": node.priority,
            "skills": node.skills,
            "max_runtime": node.max_runtime,
            "goal": node.goal,
            "created_by": "mission-control-orchestration-v2",
            "initial_status": "blocked",
            "idempotency_key": f"o2:{task_id}:{node.key}",
        })
        if code != 200 or not payload.get("ok"):
            errors.append({"key": node.key, "error": payload.get("error", f"HTTP {code}")})
            continue
        item = payload.get("data") or {}
        new_id = str(item.get("id") or item.get("task_id") or "").strip()
        if not new_id:
            errors.append({"key": node.key, "error": "create returned no task id"})
            continue
        key_to_id[node.key] = new_id
        created.append({"key": node.key, "id": new_id, "title": node.title,
                        "assignee": node.assignee, "gate": node.gate})
    if errors:
        return JSONResponse(status_code=502, content={"ok": False, "created": created, "errors": errors})

    linked: list[dict[str, str]] = []
    for edge in req.edges:
        parent = key_to_id.get(edge.parent, edge.parent)
        child = key_to_id.get(edge.child, edge.child)
        code, payload = _kanban_bridge({"action": "link", "parent": parent, "child": child})
        if code == 200 and payload.get("ok"):
            linked.append({"parent": parent, "child": child})
        else:
            errors.append({"parent": parent, "child": child, "error": payload.get("error", f"HTTP {code}")})
    incoming = {edge.child for edge in req.edges}
    roots = [n for n in req.nodes if n.key not in incoming]
    promoted: list[str] = []
    for node in roots:
        nid = key_to_id.get(node.key)
        if not nid:
            continue
        code, payload = _kanban_bridge({"action": "move", "id": nid, "to": "ready",
                                        "from": "blocked",
                                        "reason": "Orchestration v2 graph committed"})
        if code == 200 and payload.get("ok"):
            promoted.append(nid)
    comment = json.dumps({
        "kind": "ironnest_orchestration_v2",
        "playbook": req.playbook,
        "created": created,
        "links": linked,
        "gates": [c for c in created if c.get("gate")],
        "root_tasks": promoted,
        "committed_at": int(time.time()),
    }, ensure_ascii=False, sort_keys=True)
    _kanban_bridge({"action": "comment", "id": task_id, "text": comment,
                    "author": "mission-control-orchestration-v2"})
    return JSONResponse(status_code=200 if not errors else 207,
                        content={"ok": not errors, "created": created, "links": linked,
                                 "promoted": promoted, "errors": errors})


@router.post("/api/kanban/{task_id}/archive")
def kanban_archive(task_id: str, _: None = Depends(require_admin)) -> JSONResponse:
    if _is_goal_task(task_id):
        return JSONResponse(content=_archive_task_component(task_id))
    code, payload = _kanban_bridge({"action": "archive", "id": task_id})
    return JSONResponse(status_code=code, content=payload)


def _is_goal_task(task_id: str) -> bool:
    data = _show_task(task_id, {})
    return bool(data.get("parents")) and not bool(data.get("children"))


def _archive_task_component(task_id: str) -> dict[str, Any]:
    """Archive the whole linked effort containing task_id.

    The Kanban DAG stores subtasks as prerequisites (`parents`) of the terminal
    goal. Walking both parents and children handles ordinary goal trees and any
    deeper dependency chain without direct DB mutation.
    """
    cache: dict[str, dict] = {}
    seen: set[str] = set()
    queue = [task_id]
    while queue:
        cur = queue.pop()
        if cur in seen:
            continue
        seen.add(cur)
        data = _show_task(cur, cache)
        for k in (data.get("parents") or []) + (data.get("children") or []):
            if k not in seen:
                queue.append(k)
    archived: list[str] = []
    errors: list[dict[str, Any]] = []
    for tid in sorted(seen):
        c, p = _kanban_bridge({"action": "archive", "id": tid})
        if c == 200 and p.get("ok"):
            archived.append(tid)
        else:
            errors.append({"id": tid, "error": p.get("error", f"HTTP {c}")})
    return {"ok": bool(archived) and not errors, "archived": archived,
            "count": len(archived), "errors": errors}


@router.post("/api/kanban/{task_id}/archive-tree")
def kanban_archive_tree(task_id: str, _: None = Depends(require_admin)) -> JSONResponse:
    """Archive a whole effort: the goal + every task connected to it (parents +
    children, transitively). Keeps the Done column lean without grouping the
    board. Idempotent-ish: already-archived tasks just re-archive harmlessly."""
    return JSONResponse(content=_archive_task_component(task_id))


@router.delete("/api/kanban/{task_id}/goal")
def kanban_goal_delete(task_id: str, _: None = Depends(require_admin)) -> JSONResponse:
    """Permanently delete a goal and every linked subtask."""
    if not _is_goal_task(task_id):
        return JSONResponse(status_code=409, content={"ok": False, "error": "task is not a goal"})
    code, payload = _kanban_bridge({"action": "delete_tree", "id": task_id})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/{task_id}/run")
def kanban_run(task_id: str, _: None = Depends(require_admin)) -> JSONResponse:
    """Phase 2a manual run: route execution to the task's ASSIGNEE bridge so the
    worker runs in that profile's own container (correct secrets/isolation)."""
    code, payload = _kanban_bridge({"action": "show", "id": task_id})
    if code != 200 or not payload.get("ok"):
        return JSONResponse(status_code=code, content=payload)
    assignee = str(((payload.get("data") or {}).get("task") or {}).get("assignee") or "").strip()
    if not assignee:
        return JSONResponse(status_code=400, content={"ok": False, "error": "task has no assignee"})
    code, payload = _bridge_json(assignee, "POST", "/kanban", {"action": "run", "id": task_id}, timeout=40)
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/{task_id}/stop")
def kanban_stop(task_id: str, _: None = Depends(require_admin)) -> JSONResponse:
    """Stop a running worker: route to the task's ASSIGNEE bridge (the worker
    process only exists in that profile's container) so it can kill the worker's
    process group and block the task. Mirrors the routing of /run."""
    code, payload = _kanban_bridge({"action": "show", "id": task_id})
    if code != 200 or not payload.get("ok"):
        return JSONResponse(status_code=code, content=payload)
    assignee = str(((payload.get("data") or {}).get("task") or {}).get("assignee") or "").strip()
    if not assignee:
        return JSONResponse(status_code=400, content={"ok": False, "error": "task has no assignee"})
    code, payload = _bridge_json(assignee, "POST", "/kanban", {"action": "stop", "id": task_id}, timeout=40)
    return JSONResponse(status_code=code, content=payload)


@router.get("/api/kanban/{task_id}/log")
def kanban_log(task_id: str) -> JSONResponse:
    """Worker stdout for a task. Logs sit on the shared volume → read via the
    board gateway regardless of which agent ran it."""
    code, payload = _kanban_bridge({"action": "log", "id": task_id, "tail": 16000})
    return JSONResponse(status_code=code, content=payload)


@router.get("/api/kanban/{task_id}/artifacts")
def kanban_artifacts(task_id: str) -> JSONResponse:
    """List the durable deliverables a task produced. Artifacts sit on the shared
    volume → listed via the board gateway regardless of which agent ran it."""
    code, payload = _kanban_bridge({"action": "artifacts", "id": task_id})
    return JSONResponse(status_code=code, content=payload)


def _fetch_artifact_bytes(task_id: str, name: str) -> tuple[bytes, str]:
    """Fetch one artifact file's bytes via the board gateway's token-gated
    /kanban_artifact endpoint. `name` must already be a sanitised basename. Raises
    HTTPException on a bad name, a 4xx from the bridge, or an unreachable bridge."""
    safe = os.path.basename(name)
    if not safe or safe in (".", "..") or _SAFE.search(safe):
        raise HTTPException(status_code=400, detail="bad file name")
    host = _bridge_host(_board_profile())
    url = (f"http://{host}:{BRIDGE_PORT}/kanban_artifact"
           f"?id={urllib.parse.quote(task_id)}&name={urllib.parse.quote(safe)}")
    headers = {}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=60) as resp:
            return resp.read(), resp.headers.get("Content-Type", "application/octet-stream")
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=exc.code if exc.code in (400, 401, 404) else 502,
                            detail="artifact not available")
    except Exception as exc:  # noqa: BLE001 — unreachable bridge, timeout, etc.
        raise HTTPException(status_code=502, detail=f"bridge unreachable: {exc}")


@router.get("/api/kanban/{task_id}/artifact/{name}")
def kanban_artifact(task_id: str, name: str) -> Response:
    """Stream one artifact file back to the browser. Proxies the board gateway's
    token-gated /kanban_artifact endpoint. `name` is sanitised here to a basename
    AND re-validated by the bridge (defence in depth)."""
    data, ctype = _fetch_artifact_bytes(task_id, name)
    # Inline content-type so the UI can fetch + render markdown; the UI's Download
    # link uses the <a download> attribute to force a save when wanted.
    return Response(content=data, media_type=ctype)


# ── Per-task drawer chat (Q&A with the task's current assignee) ──────────────
# A chat thread attached to a kanban task. Persisted in MC's state volume (see
# task_chat_*). Each turn is proxied to the assignee's profile bridge with a
# task-scoped session id so the agent has continuity per task. If `anchor` is
# true the message is prefixed with a re-read hint pointing at the shared
# artifact tree, so the agent reads the file rather than recalling.
class TaskChat(BaseModel):
    message: str = Field(..., min_length=1, max_length=8000)
    anchor: bool = True


@router.get("/api/kanban/{task_id}/chat")
def kanban_chat_history(task_id: str) -> JSONResponse:
    return JSONResponse(content={"messages": task_chat_history(task_id)})


def _resolve_task_assignee(task_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return (task, profile). Raises HTTPException on any failure."""
    code, payload = _kanban_bridge({"action": "show", "id": task_id})
    if code != 200 or not payload.get("ok"):
        raise HTTPException(status_code=404, detail="task not found")
    t = (payload.get("data") or {}).get("task") or {}
    assignee = (t.get("assignee") or "").strip()
    if not assignee:
        raise HTTPException(status_code=409, detail="task has no assignee")
    p = {prof["name"]: prof for prof in _profiles()}.get(assignee)
    if p is None:
        raise HTTPException(status_code=404, detail=f"assignee '{assignee}' not found")
    return t, p


@router.post("/api/kanban/{task_id}/chat/stream")
def kanban_chat_stream(task_id: str, req: TaskChat) -> StreamingResponse:
    t, p = _resolve_task_assignee(task_id)
    if (t.get("status") or "") == "running":
        # Bridge serialises per profile too (429 busy), but reject early so the
        # composer can show a clean "wait for the worker" message instead of a
        # generic stream error.
        return JSONResponse(status_code=409,
                            content={"ok": False,
                                     "error": "task is running; chat available when the worker finishes"})
    assignee = p["name"]
    host = p.get("container_name") or f"hermes-pf-{assignee}"
    url = f"http://{host}:{BRIDGE_PORT}/chat/stream"

    # Anchor prefix: tells the agent to re-read the artifact tree rather than
    # answer from memory. /opt/shared/all/<assignee>/ is the read-side mirror of
    # the producer's /opt/shared/mine in the shared-artifact volume.
    msg = req.message
    if req.anchor:
        anchor = (f"[task {task_id}] Before answering, re-read any relevant files under "
                  f"/opt/shared/mine/ (your own outputs) or /opt/shared/all/ (other agents' outputs). "
                  f"Ground your answer in the actual file contents, not recollection.\n\n")
        msg = anchor + msg
    body = json.dumps({"message": msg, "session": f"task-{task_id}", "attachments": []}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"

    user_entry = {"role": "user", "text": req.message,
                  "anchored": bool(req.anchor), "assignee": assignee, "ts": _now()}

    def relay():
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            resp = urllib.request.urlopen(request, timeout=BRIDGE_TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            task_chat_append(task_id, user_entry)
            yield f"data: {json.dumps({'type': 'error', 'error': f'bridge unreachable: {exc}'})}\n\n"
            return
        assembled: list[str] = []
        flags = {"user": False, "agent": False}

        def save_user():
            if not flags["user"]:
                task_chat_append(task_id, user_entry)
                flags["user"] = True

        try:
            for line in resp:
                if not line:
                    continue
                text = line.decode("utf-8", "replace")
                yield text
                s = text.strip()
                if not s.startswith("data:"):
                    continue
                try:
                    evt = json.loads(s[5:].strip())
                except json.JSONDecodeError:
                    continue
                etype = evt.get("type")
                if etype == "chunk":
                    save_user()
                    assembled.append(evt.get("text", ""))
                elif etype == "done":
                    save_user()
                    final = evt.get("reply") or "".join(assembled) or "(empty reply)"
                    task_chat_append(task_id, {"role": "agent", "text": final,
                                               "assignee": assignee, "ts": _now()})
                    flags["agent"] = True
                elif etype == "error":
                    err = evt.get("error", "stream error")
                    if "busy" in err.lower():
                        # Transient; client retries — persist nothing to avoid dupes.
                        continue
                    save_user()
                    task_chat_append(task_id, {"role": "error", "text": err,
                                               "assignee": assignee, "ts": _now()})
                    flags["agent"] = True
        finally:
            resp.close()
            if flags["user"] and not flags["agent"] and assembled:
                task_chat_append(task_id, {"role": "agent", "text": "".join(assembled),
                                           "assignee": assignee, "ts": _now()})

    return StreamingResponse(relay(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Recursive artifact trees + complete-deliverable (webapp) access ──────────
# The flat `/artifacts` + `/artifact/{name}` pair only sees a task's top-level
# files. These add: a recursive tree, nested-path file serving, per-(sub)folder
# zip download, and a library-wide list of runnable static apps. The LIVE app is
# served by the separate `artifact-apps` origin (see APPS_BASE) — these routes
# are for browsing/downloading the files through Mission Control.
@router.get("/api/kanban/{task_id}/tree")
def kanban_tree(task_id: str) -> JSONResponse:
    """Recursive file tree for a task + which folders are runnable static apps."""
    code, payload = _kanban_bridge({"action": "artifacts_tree", "id": task_id})
    if code == 200 and isinstance(payload, dict):
        payload = {**payload, "apps_base": APPS_BASE}
    return JSONResponse(status_code=code, content=payload)


def _bridge_get_bytes(query_path: str, timeout: int = 90) -> tuple[bytes, str, str]:
    """GET raw bytes from the board gateway's bridge (token-gated). Returns
    (body, content_type, content_disposition). Used for nested artifact files and
    folder zips, which don't fit the JSON `_kanban_bridge` relay."""
    host = _bridge_host(_board_profile())
    url = f"http://{host}:{BRIDGE_PORT}{query_path}"
    headers = {}
    if BRIDGE_TOKEN:
        headers["Authorization"] = f"Bearer {BRIDGE_TOKEN}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return (resp.read(),
                    resp.headers.get("Content-Type", "application/octet-stream"),
                    resp.headers.get("Content-Disposition", ""))
    except urllib.error.HTTPError as exc:
        raise HTTPException(status_code=exc.code if exc.code in (400, 401, 404) else 502,
                            detail="artifact not available")
    except Exception as exc:  # noqa: BLE001 — unreachable bridge, timeout, etc.
        raise HTTPException(status_code=502, detail=f"bridge unreachable: {exc}")


@router.get("/api/kanban/{task_id}/file")
def kanban_file(task_id: str, path: str) -> Response:
    """Serve one NESTED artifact file (relative `path` may contain '/'). Each path
    segment is sanitised here AND re-validated by the bridge (defence in depth)."""
    if _safe_rel(path) is None:
        raise HTTPException(status_code=400, detail="bad path")
    qp = (f"/kanban_artifact?id={urllib.parse.quote(task_id)}"
          f"&path={urllib.parse.quote(path)}")
    data, ctype, _disp = _bridge_get_bytes(qp)
    return Response(content=data, media_type=ctype)


@router.get("/api/kanban/{task_id}/zip")
def kanban_zip(task_id: str, sub: str = "") -> Response:
    """Download a task's whole artifact dir (or one subfolder, `?sub=`) as a .zip
    with the folder structure preserved — one-click grab of a complete deliverable
    such as a webapp folder."""
    if sub and _safe_rel(sub) is None:
        raise HTTPException(status_code=400, detail="bad sub")
    qp = f"/kanban_artifact_zip?id={urllib.parse.quote(task_id)}"
    if sub:
        qp += f"&sub={urllib.parse.quote(sub)}"
    data, _ctype, disp = _bridge_get_bytes(qp)
    return Response(content=data, media_type="application/zip",
                    headers={"Content-Disposition": disp or 'attachment; filename="artifacts.zip"'})


# ── Reports + Apps libraries (Layer 3) — projection-backed pass-through ──────
# The board gateway maintains reports.idx.json / apps.idx.json on the shared
# volume and renders the fully merged payload server-side. Mission Control's
# handlers are thin pass-throughs — no scan, no TTL cache, no per-task fan-out.
# Mutation hooks (hide/unhide/purge/delete) update the projection inline at the
# gateway, so freshness is structural rather than an invalidation dance here.


def _task_updated(t: dict[str, Any]) -> int:
    """Best-available 'last touched' epoch for a board task. Still used by the
    create-dedup path; the Reports/Apps renderers now resolve `updated`
    server-side via the projection."""
    for k in ("completed_at", "started_at", "updated_at", "created_at"):
        v = t.get(k)
        if v:
            try:
                return int(v)
            except (TypeError, ValueError):
                pass
    return 0


def _show_task(tid: str, cache: dict[str, dict]) -> dict:
    """Memoised board `show` (task + parents + children). Used by archive-tree
    BFS; the Reports/Apps renderers dropped this — group resolution moved into
    the bridge, which reads the whole DAG in one SQLite query."""
    if tid not in cache:
        c, p = _kanban_bridge({"action": "show", "id": tid})
        cache[tid] = (p.get("data") or {}) if c == 200 and p.get("ok") else {}
    return cache[tid]


def _project_id(name: str) -> str:
    """Stable, human-readable key for one product's release history."""
    key = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return key[:80] or "app"


def _release_key(task_id: str, app_path: str) -> tuple[str, str]:
    return task_id, app_path.strip().strip("/")


def _candidate_ready(candidate: dict[str, Any] | None) -> bool:
    """A product cannot be published until its acceptance evidence is complete."""
    if not isinstance(candidate, dict) or candidate.get("role") != "product":
        return False
    return bool(candidate.get("acceptance_passed") and candidate.get("version", "").strip()
                and candidate.get("security_review", "").strip()
                and candidate.get("deployment_url", "").strip()
                and candidate.get("approved_by", "").strip())


def _infer_artifact_role(app: dict[str, Any]) -> dict[str, str]:
    """Classify delivery work from durable task metadata, never from code bytes.

    The result is intentionally a suggestion: it removes routine catalog
    housekeeping without claiming that an untested artifact is production-ready.
    """
    text = " ".join(str(app.get(k, "")) for k in ("name", "title", "group_title", "detail")).lower()
    rules = (
        ("review", ("review", "audit", "security", "qa", "test")),
        ("deployment", ("rancher", "docker", "container", "kubernetes", "k8s", "helm", "deploy")),
        ("implementation", ("implement", "implementation", "backend", "frontend", "source", "scaffold", "prototype")),
        ("demo", ("demo", "example", "sample", "showcase")),
        ("internal", ("internal", "admin", "diagnostic", "tooling")),
    )
    for role, markers in rules:
        if any(marker in text for marker in markers):
            return {"role": role, "source": "automatic"}
    # A remaining runnable app is the best product candidate in its delivery
    # group. It is still blocked from publishing until its evidence is supplied.
    return {"role": "product", "source": "automatic"}


def _indexed_app_exists(task_id: str, app_path: str) -> bool:
    code, payload = _kanban_bridge({"action": "apps_index"})
    indexed = (payload.get("apps") if isinstance(payload, dict) else None) or []
    return code == 200 and any(
        _release_key(str(app.get("task_id", "")), str(app.get("app_path", ""))) == (task_id, app_path)
        for app in indexed if isinstance(app, dict)
    )


@router.get("/api/reports")
def reports() -> JSONResponse:
    code, payload = _kanban_bridge({"action": "reports_index"})
    return JSONResponse(status_code=code, content=payload)


@router.get("/api/apps")
def apps_library() -> JSONResponse:
    code, payload = _kanban_bridge({"action": "apps_index"})
    if code == 200 and isinstance(payload, dict) and isinstance(payload.get("apps"), list):
        store = _read_store()
        releases = store.get("app_releases", [])
        candidates = store.get("app_candidates", [])
        by_artifact = {
            _release_key(str(r.get("task_id", "")), str(r.get("app_path", ""))): r
            for r in releases if isinstance(r, dict)
        }
        candidate_by_artifact = {
            _release_key(str(c.get("task_id", "")), str(c.get("app_path", ""))): c
            for c in candidates if isinstance(c, dict)
        }
        # The bridge returns a relative `url_path` per app; the public origin
        # (apps.ironnest.local) lives in MC config, so prefix it here.
        for a in payload["apps"]:
            a["url"] = APPS_BASE + (a.get("url_path") or "/")
            key = _release_key(str(a.get("task_id", "")), str(a.get("app_path", "")))
            release = by_artifact.get(key)
            candidate = candidate_by_artifact.get(key) or _infer_artifact_role(a)
            a["candidate"] = candidate
            a["release_ready"] = _candidate_ready(candidate)
            if release:
                a["release"] = release
                a["catalog_status"] = "current" if release.get("status") == "current" else "historical"
            else:
                a["catalog_status"] = "unclassified"
        payload["apps_base"] = APPS_BASE
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/apps/candidate", status_code=201)
def app_release_candidate_set(req: AppReleaseCandidateSet, _: None = Depends(require_admin)) -> JSONResponse:
    """Record whether an artifact is product, review, deployment, etc., plus
    the auditable evidence required before a product can be published."""
    task_id, app_path = _release_key(req.task_id, req.app_path)
    if not _indexed_app_exists(task_id, app_path):
        raise HTTPException(status_code=404, detail="runnable artifact not found in Apps index")
    store = _read_store()
    candidates = store["app_candidates"]
    candidate = next((item for item in candidates
                      if _release_key(str(item.get("task_id", "")), str(item.get("app_path", ""))) == (task_id, app_path)), None)
    now = _now()
    if candidate is None:
        candidate = {"id": f"candidate-{uuid.uuid4().hex[:12]}", "task_id": task_id,
                     "app_path": app_path, "created_at": now}
        candidates.append(candidate)
    candidate.update({**req.model_dump(exclude={"task_id", "app_path"}), "updated_at": now})
    _write_store(store)
    return JSONResponse(status_code=201, content={"ok": True, "candidate": candidate,
                                                   "release_ready": _candidate_ready(candidate)})


@router.post("/api/apps/publish", status_code=201)
def app_publish(req: AppReleasePublish, _: None = Depends(require_admin)) -> JSONResponse:
    """Make one runnable artifact the current release for a product.

    Previous releases stay as history. This intentionally requires an operator
    action instead of guessing from a task name, timestamp, or index.html.
    """
    task_id, app_path = _release_key(req.task_id, req.app_path)
    if not _indexed_app_exists(task_id, app_path):
        raise HTTPException(status_code=404, detail="runnable artifact not found in Apps index")
    project_name = req.project_name.strip()
    project_id = _project_id(project_name)
    store = _read_store()
    candidate = next((item for item in store["app_candidates"]
                      if _release_key(str(item.get("task_id", "")), str(item.get("app_path", ""))) == (task_id, app_path)), None)
    if not _candidate_ready(candidate):
        raise HTTPException(status_code=409, detail="complete the release-candidate checklist before publishing")
    releases = store["app_releases"]
    now = _now()
    for item in releases:
        if item.get("project_id") == project_id and item.get("status") == "current":
            item["status"] = "superseded"
            item["superseded_at"] = now
    release = next((item for item in releases
                    if _release_key(str(item.get("task_id", "")), str(item.get("app_path", ""))) == (task_id, app_path)), None)
    if release is None:
        release = {"id": f"release-{uuid.uuid4().hex[:12]}", "task_id": task_id,
                   "app_path": app_path, "created_at": now}
        releases.append(release)
    release.update({"project_id": project_id, "project_name": project_name,
                    "release": req.release.strip() or "Current release",
                    "purpose": req.purpose.strip(), "status": "current", "published_at": now})
    release.pop("superseded_at", None)
    _write_store(store)
    return JSONResponse(status_code=201, content={"ok": True, "release": release})


@router.post("/api/kanban/{task_id}/hide")
def kanban_report_hide(task_id: str, _: None = Depends(require_admin)) -> JSONResponse:
    """Soft-delete one report: drop it from the Reports view by writing a `.hidden`
    marker beside its artifacts. Reversible — the files are untouched; POST /unhide
    restores it."""
    code, payload = _kanban_bridge({"action": "artifacts_hide", "id": task_id})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/{task_id}/unhide")
def kanban_report_unhide(task_id: str, _: None = Depends(require_admin)) -> JSONResponse:
    """Restore a soft-deleted report by removing its `.hidden` marker."""
    code, payload = _kanban_bridge({"action": "artifacts_unhide", "id": task_id})
    return JSONResponse(status_code=code, content=payload)


@router.delete("/api/kanban/{task_id}/artifacts")
def kanban_report_purge(task_id: str, _: None = Depends(require_admin)) -> JSONResponse:
    """PERMANENTLY delete a report — wipes the task's entire artifact directory off
    the shared volume. Irreversible; unlike /hide there is no restore."""
    code, payload = _kanban_bridge({"action": "artifacts_purge", "id": task_id})
    return JSONResponse(status_code=code, content=payload)


@router.delete("/api/kanban/{task_id}/artifact/{name}")
def kanban_artifact_delete(task_id: str, name: str, _: None = Depends(require_admin)) -> JSONResponse:
    """PERMANENTLY delete one file from a report. Irreversible. `name` is sanitised
    to a basename here and re-validated by the bridge (defence in depth)."""
    safe = os.path.basename(name)
    if not safe or safe in (".", "..") or _SAFE.search(safe):
        raise HTTPException(status_code=400, detail="bad file name")
    code, payload = _kanban_bridge({"action": "artifact_delete", "id": task_id, "name": safe})
    return JSONResponse(status_code=code, content=payload)


_ZIP_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


@router.get("/api/reports/zip")
def reports_zip(ids: str, name: str = "reports") -> Response:
    """Bundle every artifact file of one or more reports into a single .zip.

    `ids` is a comma-separated list of task ids (one for a single report card, all
    of a group's tasks for a group download). Each task's authoritative file list
    is read from the board gateway, then each file is streamed through it and added
    to the archive. When more than one task is bundled, files are foldered per task
    (`<title-or-id>/<file>`) so same-named files from different tasks don't clash."""
    task_ids = [t.strip() for t in (ids or "").split(",") if t.strip()][:50]
    if not task_ids:
        raise HTTPException(status_code=400, detail="no task ids")
    multi = len(task_ids) > 1
    buf = io.BytesIO()
    added = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for tid in task_ids:
            code, payload = _kanban_bridge({"action": "artifacts", "id": tid})
            if code != 200 or not payload.get("ok"):
                continue
            arts = payload.get("artifacts") or []
            # Folder name for this task's files in a multi-task bundle: prefer the
            # task title, fall back to the id; sanitised for cross-platform unzip.
            folder = ""
            if multi:
                t_title = ""
                c2, p2 = _kanban_bridge({"action": "show", "id": tid})
                if c2 == 200 and p2.get("ok"):
                    t_title = ((p2.get("data") or {}).get("task") or {}).get("title") or ""
                folder = _ZIP_SAFE.sub("-", (t_title or tid).strip())[:80].strip("-") or tid
            for a in arts:
                fname = os.path.basename(str(a.get("name") or ""))
                if not fname:
                    continue
                try:
                    data, _ctype = _fetch_artifact_bytes(tid, fname)
                except HTTPException:
                    continue
                arcname = f"{folder}/{fname}" if folder else fname
                zf.writestr(arcname, data)
                added += 1
    if not added:
        raise HTTPException(status_code=404, detail="no artifact files to download")
    fname = (_ZIP_SAFE.sub("-", (name or "reports").strip()).strip("-") or "reports")[:80]
    buf.seek(0)
    return Response(content=buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{fname}.zip"'})


class WikiPublish(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    title: str = Field(default="", max_length=200)


@router.post("/api/kanban/{task_id}/publish")
def kanban_publish(task_id: str, req: WikiPublish, _: None = Depends(require_admin)) -> JSONResponse:
    """Publish one task artifact into the LLM Wiki (full-text searchable +
    chat-able at wiki.ironnest.local). Routed through the board gateway bridge,
    which holds the wiki admin token — Mission Control stays secret-free. The
    wiki runs its own secret-scan/quarantine pipeline, so a report containing
    secret-like strings returns `status:"quarantined"` instead of publishing."""
    code, payload = _bridge_json(_board_profile(), "POST", "/kanban",
                                 {"action": "publish_wiki", "id": task_id,
                                  "name": req.name, "title": req.title}, timeout=70)
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/wiki/session")
def wiki_session(_: None = Depends(require_admin)) -> JSONResponse:
    """Create a browser wiki_session via the bridge-held WIKI_ADMIN_TOKEN.

    Mission Control never receives the raw wiki admin token. It asks the board
    gateway bridge to sign in to wiki-service server-side, then sets the returned
    HTTP-only session cookie for the local IronNest domain so the embedded wiki
    dashboard opens already connected.
    """
    code, payload = _bridge_json(_board_profile(), "POST", "/kanban",
                                 {"action": "wiki_session"}, timeout=30)
    if code != 200 or not payload.get("ok"):
        return JSONResponse(status_code=code, content=payload)
    cookie_name = str(payload.get("cookie_name") or "wiki_session")
    cookie_value = str(payload.get("cookie_value") or "")
    if not cookie_value:
        return JSONResponse(status_code=502, content={
            "ok": False, "error": "bridge did not return a wiki session cookie"})
    try:
        max_age = int(payload.get("max_age") or 30 * 24 * 60 * 60)
    except (TypeError, ValueError):
        max_age = 30 * 24 * 60 * 60
    response = JSONResponse(content={
        "ok": True,
        "wiki_url": str(payload.get("wiki_url") or WIKI_PUBLIC_URL),
    })
    response.set_cookie(
        key=cookie_name,
        value=cookie_value,
        max_age=max_age,
        httponly=True,
        secure=WIKI_SESSION_COOKIE_SECURE,
        samesite="strict",
        domain=WIKI_SESSION_COOKIE_DOMAIN,
        path="/",
    )
    return response


@router.post("/api/kanban/{task_id}/decompose")
def kanban_decompose(task_id: str, _: None = Depends(require_admin)) -> JSONResponse:
    """Orchestrate: the configured orchestrator agent decomposes a triage goal
    into assigned child tasks on the shared board. An LLM turn."""
    code, payload = _bridge_json(_orchestrator(), "POST", "/kanban",
                                 {"action": "decompose", "id": task_id}, timeout=250)
    return JSONResponse(status_code=code, content=payload)


class OrchestratorSet(BaseModel):
    profile: str = Field(..., min_length=1, max_length=64)


@router.get("/api/orchestrator")  # not /api/kanban/orchestrator — that collides with /api/kanban/{task_id}
def orchestrator_get() -> JSONResponse:
    return JSONResponse(content={"ok": True, "orchestrator": _orchestrator()})


@router.post("/api/orchestrator")
def orchestrator_set(req: OrchestratorSet, _: None = Depends(require_admin)) -> JSONResponse:
    if req.profile not in {p["name"] for p in _profiles()}:
        raise HTTPException(status_code=400, detail="unknown profile")
    store = _read_store()
    store.setdefault("settings", {})["orchestrator"] = req.profile
    _write_store(store)
    return JSONResponse(content={"ok": True, "orchestrator": req.profile})


class AutoDispatch(BaseModel):
    enabled: bool = False
    max: int = Field(default=1, ge=1, le=4)


@router.get("/api/kanban/agent/{profile}/autodispatch")
def autodispatch_get(profile: str) -> JSONResponse:
    code, payload = _bridge_json(profile, "POST", "/kanban", {"action": "autodispatch_get"})
    return JSONResponse(status_code=code, content=payload)


@router.post("/api/kanban/agent/{profile}/autodispatch")
def autodispatch_set(profile: str, req: AutoDispatch, _: None = Depends(require_admin)) -> JSONResponse:
    code, payload = _bridge_json(profile, "POST", "/kanban",
                                 {"action": "autodispatch_set", "enabled": req.enabled, "max": req.max})
    return JSONResponse(status_code=code, content=payload)


# ── Approval-gated Docker lifecycle operations ──────────────────────────────
# This is intentionally a request/approval system, not a shell or Docker proxy.
# The separate runner independently enforces the same target/action allowlist.


def _operations_enabled() -> bool:
    return bool((OPERATIONS_RUNNER_URL and OPERATIONS_RUNNER_TOKEN) or
                HOST_OPERATIONS_QUEUE_DIR)


def _operation_targets() -> set[str]:
    """Containers eligible for individual approval-gated lifecycle actions.

    The runner independently enforces the same configured exact-name allowlist.
    This check prevents a stale or malformed dashboard request from becoming a
    proposal; it is not a Docker discovery or proxy endpoint.
    """
    return set(OPERATIONS_ALLOWED_CONTAINERS)


def _operation_target_allowed(value: str) -> bool:
    return bool(_DOCKER_CONTAINER_NAME.fullmatch(value)) and (
        OPERATIONS_ALLOW_ALL_CONTAINERS or value in OPERATIONS_ALLOWED_CONTAINERS)


def _operation_view(item: dict[str, Any]) -> dict[str, Any]:
    """Return a copy safe for API consumers (there are no credentials in state)."""
    return dict(item)


def _notify_operation_thread(item: dict[str, Any], event: str) -> None:
    """Mirror approval lifecycle events into the requester's agent chat."""
    profile = str(item.get("requested_by") or "")
    if not profile or profile not in {p.get("name") for p in _profiles()}:
        return
    conv = item.get("conversation_id")
    if not conv:
        convs = [c for c in list_conversations(profile) if not c.get("archived")]
        conv = convs[0]["id"] if convs else create_conversation(profile, "Approvals")["id"]
        item["conversation_id"] = conv
    action = str(item.get("action", "operation")).replace("_", " ")
    target = str(item.get("target", "local system"))
    messages = {
        "requested": f"🛡️ Approval requested: {action} for {target}. It is waiting in Mission Control Approvals.",
        "executing": f"✅ Approval granted: {action} for {target} is now executing.",
        "executed": f"✅ Approved action completed: {action} for {target}.",
        "failed": f"⚠️ Approved action failed: {action} for {target}. Review Mission Control Approvals for details.",
        "expired": f"⌛ Approval expired: {action} for {target}. Submit a fresh request if it is still needed.",
    }
    text = messages.get(event)
    if text:
        conv_append(profile, conv, {"role": "system", "text": text, "ts": _now(),
                                    "approval_id": item.get("id"), "approval_status": event,
                                    "approval_action": action, "approval_target": target})


def _reconcile_host_operations(store: dict[str, Any]) -> None:
    """Pick up completion records written by the Windows-host queue runner."""
    if not HOST_OPERATIONS_QUEUE_DIR:
        return
    changed = False
    for item in store.get("operations", []):
        if item.get("action") != "host_powershell" or item.get("status") != "executing":
            continue
        result_file = HOST_OPERATIONS_QUEUE_DIR / "results" / f"{item['id']}.json"
        try:
            result = json.loads(result_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        item["status"] = "executed" if result.get("ok") else "failed"
        item["result"] = result
        _notify_operation_thread(item, item["status"])
        changed = True
    if changed:
        _write_store(store)


def _maintain_operations(store: dict[str, Any]) -> None:
    """Archive terminal approvals after 30 days; retain audit evidence 180 days."""
    now = datetime.now(timezone.utc)
    terminal = {"executed", "failed", "expired", "unknown"}
    kept: list[dict[str, Any]] = []
    changed = False
    for item in store.get("operations", []):
        try:
            created = datetime.fromisoformat(str(item.get("created_at", "")).replace("Z", "+00:00"))
        except ValueError:
            kept.append(item); continue
        age = (now - created).days
        if item.get("status") in terminal and age >= OPERATIONS_RETENTION_DAYS:
            changed = True
            continue
        if item.get("status") in terminal and age >= OPERATIONS_ARCHIVE_AFTER_DAYS and not item.get("archived_at"):
            item["archived_at"] = _now(); changed = True
        kept.append(item)
    if changed:
        store["operations"] = kept
        _write_store(store)


@router.get("/api/operations")
def operations_list(_: None = Depends(require_admin)) -> JSONResponse:
    store = _read_store()
    _reconcile_host_operations(store)
    _maintain_operations(store)
    backfilled = False
    for item in store.get("operations", []):
        if item.get("status") == "pending_approval" and not item.get("conversation_id"):
            _notify_operation_thread(item, "requested")
            backfilled = True
    if backfilled:
        _write_store(store)
    items = sorted(store.get("operations", []), key=lambda x: x.get("created_at", ""), reverse=True)
    return JSONResponse(content={"enabled": _operations_enabled(),
                                 "actions": ["start", "stop", "restart", "docker_api", "host_powershell"],
                                 "targets": sorted(_operation_targets()),
                                 "archive_after_days": OPERATIONS_ARCHIVE_AFTER_DAYS,
                                 "retention_days": OPERATIONS_RETENTION_DAYS,
                                 "requests": [_operation_view(x) for x in items]})


def _create_operation_request(req: OperationRequestCreate, requested_by: str | None = None) -> dict[str, Any]:
    if not _operations_enabled():
        raise HTTPException(status_code=503, detail="operations runner is not configured")
    if req.action not in ("docker_api", "host_powershell") and not _operation_target_allowed(req.target):
        raise HTTPException(status_code=400, detail="target is not approved for lifecycle operations")
    if req.action == "docker_api" and (not req.method or not req.path):
        raise HTTPException(status_code=400, detail="docker_api requires method and path")
    if req.action == "host_powershell" and (not req.script or not req.script.strip()):
        raise HTTPException(status_code=400, detail="host_powershell requires a non-empty script")
    item = {
        "id": f"op-{uuid.uuid4().hex}", "action": req.action, "target": req.target,
        "reason": req.reason.strip(), "requested_by": (requested_by or req.requested_by).strip(),
        "status": "pending_approval", "created_at": _now(), "approved_at": None,
        "approved_by": None, "approval_note": "", "result": None,
    }
    if req.action == "docker_api":
        item["docker_request"] = {"method": req.method, "path": req.path,
                                  "body": req.body or {}}
    if req.action == "host_powershell":
        item["script"] = req.script
        item["remediation_id"] = req.remediation_id.strip() if req.remediation_id else ""
        item["risk"] = req.risk
    store = _read_store()
    store.setdefault("operations", []).append(item)
    _notify_operation_thread(item, "requested")
    _write_store(store)
    return item


def _execute_preapproved_lifecycle(req: OperationRequestCreate, requested_by: str) -> dict[str, Any]:
    """Execute one exact pre-approved lifecycle request without operator review.

    This is deliberately narrower than the normal approvals lane: no Docker API,
    no host script, no arbitrary target, and no broad action set.
    """
    if not _operations_enabled():
        raise HTTPException(status_code=503, detail="operations runner is not configured")
    if req.action not in ("start", "stop", "restart"):
        raise HTTPException(status_code=403, detail="action is not pre-approved")
    if req.target not in LITTLEJOHN_PREAPPROVED_LIFECYCLE_TARGETS:
        raise HTTPException(status_code=403, detail="target is not pre-approved")
    if not _operation_target_allowed(req.target):
        raise HTTPException(status_code=400, detail="target is not approved for lifecycle operations")
    if req.method or req.path or req.body or req.script:
        raise HTTPException(status_code=400, detail="pre-approved lifecycle requests cannot include payloads")

    item = {
        "id": f"op-{uuid.uuid4().hex}",
        "action": req.action,
        "target": req.target,
        "reason": req.reason.strip(),
        "requested_by": requested_by,
        "status": "executing",
        "created_at": _now(),
        "approved_at": _now(),
        "approved_by": f"preapproved:{requested_by}",
        "approval_note": "Exact LittleJohn Kali MCP lifecycle allowance.",
        "result": None,
        "preapproved": True,
    }
    store = _read_store()
    store.setdefault("operations", []).append(item)
    _notify_operation_thread(item, "executing")
    _write_store(store)

    if not OPERATIONS_RUNNER_URL or not OPERATIONS_RUNNER_TOKEN:
        item["status"] = "failed"
        item["result"] = {"error": "required operation runner is not configured"}
        _notify_operation_thread(item, "failed")
        _write_store(store)
        raise HTTPException(status_code=503, detail="required operation runner is not configured")

    runner_payload = {"request_id": item["id"], "action": item["action"], "target": item["target"]}
    body = json.dumps(runner_payload).encode("utf-8")
    request = urllib.request.Request(
        f"{OPERATIONS_RUNNER_URL}/v1/execute", data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {OPERATIONS_RUNNER_TOKEN}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.loads(response.read().decode("utf-8"))
        item["status"] = "executed"
        item["result"] = payload.get("result", payload)
    except urllib.error.HTTPError as exc:
        item["status"] = "failed"
        item["result"] = {"error": f"runner rejected request ({exc.code})"}
    except (OSError, ValueError, urllib.error.URLError) as exc:
        item["status"] = "unknown"
        item["result"] = {"error": f"runner response unavailable: {exc}"}
    _notify_operation_thread(item, "executed" if item["status"] == "executed" else "failed")
    _write_store(store)
    return item


@router.post("/api/operations/requests")
def operations_request(req: OperationRequestCreate, _: None = Depends(require_admin)) -> JSONResponse:
    item = _create_operation_request(req)
    return JSONResponse(status_code=201, content={"ok": True, "request": _operation_view(item)})


@router.post("/api/operations/requests/octo")
def octo_operations_request(req: OperationRequestCreate,
                            _: None = Depends(require_octo_operations_submit)) -> JSONResponse:
    """Octo's narrow proposal ingress. It cannot approve or execute requests."""
    item = _create_operation_request(req, requested_by="octo")
    return JSONResponse(status_code=201, content={"ok": True, "request": _operation_view(item)})


@router.post("/api/operations/requests/littlejohn")
def littlejohn_operations_request(req: OperationRequestCreate,
                                  _: None = Depends(require_littlejohn_operations_submit)) -> JSONResponse:
    """Little John's scoped operations ingress.

    Host changes are still proposals. The only auto-executed actions are the
    exact pre-approved Kali MCP lifecycle operations configured by env.
    """
    if req.action in ("start", "stop", "restart"):
        item = _execute_preapproved_lifecycle(req, requested_by="littlejohn")
        return JSONResponse(status_code=200 if item["status"] == "executed" else 502,
                            content={"ok": item["status"] == "executed",
                                     "request": _operation_view(item)})
    if req.action != "host_powershell":
        raise HTTPException(status_code=403, detail="Little John may only request host changes or pre-approved Kali lifecycle operations")
    item = _create_operation_request(req, requested_by="littlejohn")
    return JSONResponse(status_code=201, content={"ok": True, "request": _operation_view(item)})


@router.post("/api/operations/{operation_id}/approve")
def operations_approve(operation_id: str, approval: OperationApproval,
                       _: None = Depends(require_admin)) -> JSONResponse:
    if not _operations_enabled():
        raise HTTPException(status_code=503, detail="operations runner is not configured")
    store = _read_store()
    item = next((x for x in store.get("operations", []) if x.get("id") == operation_id), None)
    if item is None:
        raise HTTPException(status_code=404, detail="operation request not found")
    if item.get("status") != "pending_approval":
        raise HTTPException(status_code=409, detail="operation request is no longer pending")
    try:
        created = datetime.fromisoformat(str(item["created_at"]).replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        raise HTTPException(status_code=409, detail="operation request has invalid timestamp")
    if (datetime.now(timezone.utc) - created).total_seconds() > OPERATIONS_APPROVAL_TTL:
        item["status"] = "expired"
        item["expired_at"] = _now()
        _notify_operation_thread(item, "expired")
        _write_store(store)
        raise HTTPException(status_code=409, detail="operation request expired; submit a fresh request")

    # Stamp approval before calling the runner, so even a network timeout leaves
    # an auditable record.  A runner-side request-id ledger prevents replays.
    item["status"] = "executing"
    item["approved_at"] = _now()
    item["approved_by"] = approval.approved_by.strip()
    item["approval_note"] = approval.note.strip()
    _notify_operation_thread(item, "executing")
    _write_store(store)
    runner_payload = {"request_id": item["id"], "action": item["action"],
                      "target": item["target"]}
    if item.get("docker_request"):
        runner_payload["docker_request"] = item["docker_request"]
    if item["action"] == "host_powershell":
        if not HOST_OPERATIONS_QUEUE_DIR:
            item["status"] = "failed"; item["result"] = {"error": "host operation queue is not configured"}; _write_store(store)
            raise HTTPException(status_code=503, detail="host operation queue is not configured")
        HOST_OPERATIONS_QUEUE_DIR.mkdir(parents=True, exist_ok=True)
        jobs = HOST_OPERATIONS_QUEUE_DIR / "jobs"; jobs.mkdir(exist_ok=True)
        job = {"request_id": item["id"], "action": item["action"], "target": item["target"],
               "script": item["script"], "risk": item.get("risk", "medium"),
               "remediation_id": item.get("remediation_id", "")}
        temp = jobs / f"{item['id']}.tmp"; final = jobs / f"{item['id']}.json"
        temp.write_text(json.dumps(job), encoding="utf-8"); os.replace(temp, final)
        return JSONResponse(status_code=202, content={"ok": True, "request": _operation_view(item)})
    else:
        runner_url, runner_token, timeout = OPERATIONS_RUNNER_URL, OPERATIONS_RUNNER_TOKEN, 45
    if not runner_url or not runner_token:
        item["status"] = "failed"
        item["result"] = {"error": "required operation runner is not configured"}
        _write_store(store)
        raise HTTPException(status_code=503, detail="required operation runner is not configured")
    body = json.dumps(runner_payload).encode("utf-8")
    request = urllib.request.Request(
        f"{runner_url}/v1/execute", data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {runner_token}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        item["status"] = "executed"
        item["result"] = payload.get("result", payload)
    except urllib.error.HTTPError as exc:
        item["status"] = "failed"
        item["result"] = {"error": f"runner rejected request ({exc.code})"}
    except (OSError, ValueError, urllib.error.URLError) as exc:
        item["status"] = "unknown"
        item["result"] = {"error": f"runner response unavailable: {exc}"}
    _notify_operation_thread(item, "executed" if item["status"] == "executed" else "failed")
    _write_store(store)
    return JSONResponse(status_code=200 if item["status"] == "executed" else 502,
                        content={"ok": item["status"] == "executed", "request": _operation_view(item)})


app = FastAPI(title="Hermes Mission Control", version="0.1.0")
app.include_router(router)
