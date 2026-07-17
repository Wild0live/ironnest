"""Approval-gated Docker factory runner.

The runner owns the Docker socket, but agents never do.  It accepts only one
approved, single-use request at a time and exposes a deliberately small Docker
API subset needed by a software factory: create/start/stop/restart containers,
create/start exec sessions, bind approved host roots, and create/connect factory
networks.  It is not a standing Docker API proxy or a shell endpoint.
"""
from __future__ import annotations

import http.client
import hmac
import hashlib
import json
import os
import re
import socket
import struct
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

TOKEN = os.environ.get("OPERATIONS_RUNNER_TOKEN", "").strip()
ALLOWED_CONTAINERS = frozenset(item.strip() for item in os.environ.get(
    "OPERATIONS_ALLOWED_CONTAINERS", "").split(",") if item.strip())
ALLOW_ALL_CONTAINERS = os.environ.get("OPERATIONS_ALLOW_ALL_CONTAINERS", "").strip().lower() in {
    "1", "true", "yes", "on"}
FACTORY_PREFIX = os.environ.get("FACTORY_CONTAINER_PREFIX", "factory-").strip()
FACTORY_HOST_ROOTS = tuple(p.strip().replace("\\", "/").rstrip("/").lower() for p in os.environ.get(
    "FACTORY_HOST_PATH_ROOTS", "").split(",") if p.strip())
FACTORY_ALLOWED_IMAGES = frozenset(item.strip() for item in os.environ.get(
    "FACTORY_ALLOWED_IMAGES", "").split(",") if item.strip())
STATE_FILE = Path(os.environ.get("OPERATIONS_RUNNER_STATE_FILE", "/var/lib/operations-runner/executed.json"))
SOCKET_PATH = os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
ADMIN_SESSION_TTL = min(600, max(60, int(os.environ.get("OCTO_ADMIN_SESSION_TTL_SECONDS", "600"))))
ELIGIBILITY_LABEL = os.environ.get("OCTO_ADMIN_ELIGIBILITY_LABEL", "io.ironnest.octo-admin").strip()
ELIGIBILITY_VALUE = os.environ.get("OCTO_ADMIN_ELIGIBILITY_VALUE", "eligible").strip()
PROTECTED_LABEL = os.environ.get("OCTO_ADMIN_PROTECTED_LABEL", "io.ironnest.security-boundary").strip()
PROTECTED_VALUE = os.environ.get("OCTO_ADMIN_PROTECTED_VALUE", "protected").strip()
PROTECTED_CONTAINERS = frozenset(item.strip() for item in os.environ.get(
    "OCTO_ADMIN_PROTECTED_CONTAINERS", "").split(",") if item.strip())
ELIGIBLE_CONTAINERS = frozenset(item.strip() for item in os.environ.get(
    "OCTO_ADMIN_ELIGIBLE_CONTAINERS", "").split(",") if item.strip())
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$")
_NAME = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$")
_API = re.compile(r"^/v\d+\.\d+/(.+)$")
_LOCK = threading.Lock()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class UnixHTTPConnection(http.client.HTTPConnection):
    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(SOCKET_PATH)


def docker_call(method: str, path: str, payload: bytes = b"") -> tuple[int, str]:
    conn = UnixHTTPConnection("localhost", timeout=45)
    try:
        conn.request(method, path, body=payload,
                     headers={"Content-Type": "application/json", "Content-Length": str(len(payload))})
        response = conn.getresponse()
        return response.status, response.read(32_768).decode("utf-8", "replace")
    finally:
        conn.close()


def load_state() -> dict[str, Any]:
    try:
        value = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if isinstance(value, dict):
            value.setdefault("executed", {})
            value.setdefault("factory_exec_ids", {})
            value.setdefault("admin_session", None)
            return value
    except (OSError, json.JSONDecodeError):
        pass
    return {"executed": {}, "factory_exec_ids": {}, "admin_session": None}


def save_state(value: dict[str, Any]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
    os.replace(temp, STATE_FILE)


class DockerRequest(BaseModel):
    method: Literal["POST", "DELETE"]
    path: str = Field(..., min_length=1, max_length=300)
    body: dict[str, Any] = Field(default_factory=dict)


class ExecuteRequest(BaseModel):
    request_id: str = Field(..., min_length=8, max_length=128)
    action: Literal["start", "stop", "restart", "docker_api"]
    target: str = Field(..., min_length=1, max_length=128)
    docker_request: DockerRequest | None = None


class AdminSessionOpen(BaseModel):
    session_id: str = Field(..., min_length=16, max_length=128)
    operator_subject: str = Field(..., min_length=1, max_length=160)
    credential_id: str = Field(..., min_length=1, max_length=2000)
    issued_at: str
    expires_at: str


class AdminSessionAction(BaseModel):
    session_id: str = Field(..., min_length=16, max_length=128)
    request_id: str = Field(..., min_length=8, max_length=128)
    action: Literal["start", "stop", "restart", "pause", "unpause", "docker_api"]
    target: str = Field(..., min_length=1, max_length=128)
    docker_request: DockerRequest | None = None


class AdminExecRequest(BaseModel):
    session_id: str = Field(..., min_length=16, max_length=128)
    request_id: str = Field(..., min_length=8, max_length=128)
    target: str = Field(..., min_length=1, max_length=128)
    command: list[str] = Field(..., min_length=1, max_length=128)
    working_dir: str | None = Field(default=None, max_length=512)
    env: list[str] = Field(default_factory=list, max_length=64)


def require_runner_token(authorization: str | None = Header(default=None)) -> None:
    if not TOKEN or authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="runner authorization required")


def parse_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid session timestamp") from exc
    if parsed.tzinfo is None:
        raise HTTPException(status_code=400, detail="session timestamp must include timezone")
    return parsed.astimezone(timezone.utc)


def active_session(state: dict[str, Any], session_id: str) -> dict[str, Any]:
    session = state.get("admin_session")
    if not isinstance(session, dict) or session.get("status") != "active":
        raise HTTPException(status_code=403, detail="no active Octo admin session")
    if not hmac.compare_digest(str(session.get("session_id", "")), session_id):
        raise HTTPException(status_code=403, detail="admin session mismatch")
    if parse_time(str(session.get("expires_at", ""))) <= datetime.now(timezone.utc):
        session["status"] = "expired"
        session["expired_at"] = now()
        save_state(state)
        raise HTTPException(status_code=403, detail="Octo admin session expired")
    return session


def inspect_container(target: str) -> dict[str, Any]:
    if not _NAME.fullmatch(target):
        raise HTTPException(status_code=400, detail="invalid container name")
    code, body = docker_call("GET", f"/v1.47/containers/{target}/json")
    if code != 200:
        raise HTTPException(status_code=404, detail="container was not found")
    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail="Docker returned invalid inspect data") from exc


def require_unprotected_container(target: str) -> dict[str, Any]:
    if target in PROTECTED_CONTAINERS:
        raise HTTPException(status_code=403, detail="container is a protected security boundary")
    info = inspect_container(target)
    labels = ((info.get("Config") or {}).get("Labels") or {})
    canonical = str(info.get("Name") or "").lstrip("/")
    if canonical in PROTECTED_CONTAINERS or labels.get(PROTECTED_LABEL) == PROTECTED_VALUE:
        raise HTTPException(status_code=403, detail="container is a protected security boundary")
    mounts = info.get("Mounts") or []
    if any(str(m.get("Destination", "")) == "/var/run/docker.sock" for m in mounts if isinstance(m, dict)):
        raise HTTPException(status_code=403, detail="Docker-socket holders are always protected")
    return info


def require_eligible_container(target: str) -> dict[str, Any]:
    info = require_unprotected_container(target)
    labels = ((info.get("Config") or {}).get("Labels") or {})
    canonical = str(info.get("Name") or "").lstrip("/")
    if canonical not in ELIGIBLE_CONTAINERS and labels.get(ELIGIBILITY_LABEL) != ELIGIBILITY_VALUE:
        raise HTTPException(status_code=403, detail="container is not enrolled for Octo administration")
    return info


def factory_name(value: str) -> bool:
    return bool(FACTORY_PREFIX and value.startswith(FACTORY_PREFIX) and _NAME.fullmatch(value))


def lifecycle_target_allowed(value: str) -> bool:
    """Permit lifecycle actions for configured names, or all valid Docker names."""
    if not (bool(_NAME.fullmatch(value)) and
            (ALLOW_ALL_CONTAINERS or value in ALLOWED_CONTAINERS)):
        return False
    try:
        require_unprotected_container(value)
    except HTTPException:
        return False
    return True


def host_path_allowed(source: str) -> bool:
    source = source.replace("\\", "/").rstrip("/").lower()
    return any(source == root or source.startswith(root + "/") for root in FACTORY_HOST_ROOTS)


def validate_image_pull(query: dict[str, list[str]]) -> None:
    """Allow an approved pull of one explicitly configured image only."""
    if set(query) - {"fromImage", "tag", "platform"}:
        raise HTTPException(status_code=403, detail="unsupported image pull option")
    sources = query.get("fromImage", [])
    tags = query.get("tag", [])
    platforms = query.get("platform", [])
    if len(sources) != 1 or not sources[0] or len(tags) > 1 or len(platforms) > 1:
        raise HTTPException(status_code=400, detail="image pull requires exactly one fromImage and optional tag/platform")
    # Docker's image-create API separates the tag from fromImage. The exact
    # image string is what operators configure and review in Mission Control.
    image = sources[0] if not tags else f"{sources[0]}:{tags[0]}"
    if not FACTORY_ALLOWED_IMAGES or image not in FACTORY_ALLOWED_IMAGES:
        raise HTTPException(status_code=403, detail="image is outside FACTORY_ALLOWED_IMAGES")


def validate_create(body: dict[str, Any], query: dict[str, list[str]]) -> None:
    names = query.get("name", [])
    if len(names) != 1 or not factory_name(names[0]):
        raise HTTPException(status_code=403, detail="container name must use the factory prefix")
    if not isinstance(body.get("Image"), str) or not body["Image"].strip():
        raise HTTPException(status_code=400, detail="container create requires Image")
    labels = body.get("Labels") or {}
    if not isinstance(labels, dict):
        raise HTTPException(status_code=400, detail="container Labels must be an object")
    if ELIGIBILITY_LABEL in labels or PROTECTED_LABEL in labels:
        raise HTTPException(status_code=403, detail="security-boundary labels require separate operator enrollment")
    host = body.get("HostConfig") or {}
    if not isinstance(host, dict):
        raise HTTPException(status_code=400, detail="HostConfig must be an object")
    for forbidden in ("Privileged", "PidMode", "NetworkMode", "IpcMode", "UTSMode", "UsernsMode"):
        value = host.get(forbidden)
        if value and value is not False:
            raise HTTPException(status_code=403, detail=f"HostConfig.{forbidden} is not permitted")
    binds = host.get("Binds") or []
    if not isinstance(binds, list):
        raise HTTPException(status_code=400, detail="HostConfig.Binds must be a list")
    for bind in binds:
        if not isinstance(bind, str):
            raise HTTPException(status_code=400, detail="invalid bind")
        # Docker's short bind syntax has a drive-letter exception on Windows:
        # `D:\\factory:/workspace:rw`.  Split at the *second* colon there.
        if re.match(r"^[A-Za-z]:[\\/]", bind):
            separator = bind.find(":", 2)
            source = bind if separator < 0 else bind[:separator]
        else:
            source = bind.split(":", 1)[0]
        # Named volumes have no slash; host bind paths must stay in configured roots.
        is_host_path = "/" in source or "\\" in source or bool(re.match(r"^[A-Za-z]:", source))
        if is_host_path and (not FACTORY_HOST_ROOTS or not host_path_allowed(source)):
            raise HTTPException(status_code=403, detail="host bind is outside FACTORY_HOST_PATH_ROOTS")
    mounts = host.get("Mounts") or []
    if not isinstance(mounts, list):
        raise HTTPException(status_code=400, detail="HostConfig.Mounts must be a list")
    for mount in mounts:
        if not isinstance(mount, dict):
            raise HTTPException(status_code=400, detail="invalid mount")
        if mount.get("Type") == "bind":
            source = str(mount.get("Source") or "")
            if not source or not FACTORY_HOST_ROOTS or not host_path_allowed(source):
                raise HTTPException(status_code=403, detail="host bind is outside FACTORY_HOST_PATH_ROOTS")


def validate_factory_request(req: DockerRequest, state: dict[str, Any],
                             expected_target: str = "") -> tuple[str, str, bytes]:
    parsed = urlsplit(req.path)
    if parsed.scheme or parsed.netloc or parsed.fragment or not parsed.path.startswith("/"):
        raise HTTPException(status_code=400, detail="invalid Docker API path")
    match = _API.fullmatch(parsed.path)
    if not match:
        raise HTTPException(status_code=400, detail="Docker API versioned path required")
    resource = match.group(1)
    query = parse_qs(parsed.query, keep_blank_values=True)
    body = req.body
    allowed = False
    if resource == "images/create" and req.method == "POST":
        if body:
            raise HTTPException(status_code=400, detail="image pull does not accept a request body")
        validate_image_pull(query)
        allowed = True
    elif resource == "containers/create" and req.method == "POST":
        validate_create(body, query)
        allowed = True
    elif m := re.fullmatch(r"containers/([^/]+)/(start|stop|restart)", resource):
        if req.method == "POST":
            if expected_target and m.group(1) != expected_target:
                raise HTTPException(status_code=400, detail="Docker path target does not match approval target")
            # Factory containers remain valid, while existing workloads must
            # pass the same enrollment and protected-boundary checks used by
            # Octo admin sessions. FIDO approval does not bypass eligibility.
            if factory_name(m.group(1)):
                require_unprotected_container(m.group(1))
            else:
                require_eligible_container(m.group(1))
            allowed = True
    elif m := re.fullmatch(r"containers/([^/]+)/exec", resource):
        if req.method == "POST" and factory_name(m.group(1)):
            if not isinstance(body.get("Cmd"), list):
                raise HTTPException(status_code=400, detail="exec creation requires a Cmd array")
            allowed = True
    elif m := re.fullmatch(r"containers/([^/]+)", resource):
        if req.method == "DELETE":
            if expected_target and m.group(1) != expected_target:
                raise HTTPException(status_code=400, detail="Docker path target does not match approval target")
            require_eligible_container(m.group(1))
            allowed = True
    elif m := re.fullmatch(r"containers/([^/]+)/kill", resource):
        if req.method == "POST":
            if expected_target and m.group(1) != expected_target:
                raise HTTPException(status_code=400, detail="Docker path target does not match approval target")
            require_eligible_container(m.group(1))
            allowed = True
    elif m := re.fullmatch(r"exec/([a-fA-F0-9]{64})/start", resource):
        if req.method == "POST" and m.group(1) in state.get("factory_exec_ids", {}):
            allowed = True
    elif resource == "networks/create" and req.method == "POST":
        if factory_name(str(body.get("Name") or "")):
            allowed = True
    elif m := re.fullmatch(r"networks/([^/]+)/(connect|disconnect)", resource):
        container = str(body.get("Container") or "")
        if req.method == "POST" and factory_name(m.group(1)) and factory_name(container):
            allowed = True
    elif m := re.fullmatch(r"networks/([^/]+)", resource):
        if req.method == "DELETE" and factory_name(m.group(1)):
            allowed = True
    elif m := re.fullmatch(r"volumes/([^/]+)", resource):
        if req.method == "DELETE" and factory_name(m.group(1)):
            allowed = True
    if not allowed:
        raise HTTPException(status_code=403, detail="Docker request is outside the approved factory API subset")
    encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 262_144:
        raise HTTPException(status_code=413, detail="Docker request body exceeds 256 KiB")
    return req.method, req.path, encoded


def validate_session_request(req: AdminSessionAction, state: dict[str, Any]) -> tuple[str, str, bytes]:
    """Validate non-destructive Docker administration inside an active lease.

    Destructive DELETE/kill/prune operations deliberately stay on the existing
    operation-bound FIDO approval path and are never accepted here.
    """
    if req.action != "docker_api":
        require_eligible_container(req.target)
        return "POST", {
            "start": f"/v1.47/containers/{req.target}/start",
            "stop": f"/v1.47/containers/{req.target}/stop?t=30",
            "restart": f"/v1.47/containers/{req.target}/restart?t=30",
            "pause": f"/v1.47/containers/{req.target}/pause",
            "unpause": f"/v1.47/containers/{req.target}/unpause",
        }[req.action], b""
    if req.docker_request is None:
        raise HTTPException(status_code=400, detail="docker_api request missing payload")
    docker_req = req.docker_request
    parsed = urlsplit(docker_req.path)
    match = _API.fullmatch(parsed.path)
    if parsed.scheme or parsed.netloc or parsed.fragment or not match:
        raise HTTPException(status_code=400, detail="invalid versioned Docker API path")
    resource = match.group(1)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if docker_req.method != "POST":
        raise HTTPException(status_code=403, detail="destructive Docker methods require per-action FIDO approval")
    if resource == "images/create":
        validate_image_pull(query)
    elif resource == "containers/create":
        validate_create(docker_req.body, query)
    elif m := re.fullmatch(r"containers/([^/]+)/(start|stop|restart|pause|unpause|rename|update)", resource):
        if m.group(1) != req.target:
            raise HTTPException(status_code=400, detail="Docker path target does not match request target")
        require_eligible_container(req.target)
    elif resource == "networks/create":
        if not factory_name(str(docker_req.body.get("Name") or "")):
            raise HTTPException(status_code=403, detail="new network name must use the factory prefix")
    elif m := re.fullmatch(r"networks/([^/]+)/(connect|disconnect)", resource):
        container = str(docker_req.body.get("Container") or "")
        require_eligible_container(container)
        if not factory_name(m.group(1)):
            raise HTTPException(status_code=403, detail="only factory networks may be changed")
    else:
        raise HTTPException(status_code=403, detail="Docker request is outside the active-session subset")
    encoded = json.dumps(docker_req.body, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 262_144:
        raise HTTPException(status_code=413, detail="Docker request body exceeds 256 KiB")
    return docker_req.method, docker_req.path, encoded


def create_exec(req: AdminExecRequest) -> str:
    payload: dict[str, Any] = {
        "AttachStdout": True, "AttachStderr": True, "AttachStdin": False,
        "Tty": False, "User": "0", "Cmd": req.command, "Env": req.env,
    }
    if req.working_dir:
        payload["WorkingDir"] = req.working_dir
    code, body = docker_call("POST", f"/v1.47/containers/{req.target}/exec",
                             json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    if code != 201:
        raise HTTPException(status_code=502, detail=f"Docker rejected exec creation ({code}): {body[:300]}")
    try:
        exec_id = json.loads(body)["Id"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="Docker returned an invalid exec ID") from exc
    if not isinstance(exec_id, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", exec_id):
        raise HTTPException(status_code=502, detail="Docker returned an invalid exec ID")
    return exec_id


def stream_exec(exec_id: str):
    conn = UnixHTTPConnection("localhost", timeout=None)
    payload = b'{"Detach":false,"Tty":false}'
    try:
        conn.request("POST", f"/v1.47/exec/{exec_id}/start", body=payload,
                     headers={"Content-Type": "application/json", "Content-Length": str(len(payload))})
        response = conn.getresponse()
        if response.status not in (101, 200):
            detail = response.read(4096).decode("utf-8", "replace")
            yield json.dumps({"stream": "error", "data": f"Docker rejected exec start ({response.status}): {detail}"}) + "\n"
            return
        buffer = b""
        while True:
            chunk = response.read1(8192)
            if not chunk:
                break
            buffer += chunk
            while len(buffer) >= 8:
                stream_type = buffer[0]
                size = struct.unpack(">I", buffer[4:8])[0]
                if len(buffer) < 8 + size:
                    break
                data = buffer[8:8 + size]
                buffer = buffer[8 + size:]
                yield json.dumps({"stream": "stderr" if stream_type == 2 else "stdout",
                                  "data": data.decode("utf-8", "replace")}, ensure_ascii=False) + "\n"
        if buffer:
            yield json.dumps({"stream": "stdout", "data": buffer.decode("utf-8", "replace")}, ensure_ascii=False) + "\n"
    finally:
        conn.close()


app = FastAPI(title="IronNest Operations Runner", version="0.2.0")


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": bool(TOKEN), "service": "operations-runner"}


@app.post("/v1/admin-sessions/open")
def open_admin_session(req: AdminSessionOpen,
                       authorization: str | None = Header(default=None)) -> dict:
    require_runner_token(authorization)
    issued = parse_time(req.issued_at)
    expires = parse_time(req.expires_at)
    current = datetime.now(timezone.utc)
    if issued > current or expires <= current:
        raise HTTPException(status_code=400, detail="admin session timestamps are not currently valid")
    if (expires - issued).total_seconds() > ADMIN_SESSION_TTL:
        raise HTTPException(status_code=400, detail="admin session exceeds runner TTL")
    with _LOCK:
        state = load_state()
        previous = state.get("admin_session")
        if isinstance(previous, dict) and previous.get("status") == "active":
            if parse_time(str(previous.get("expires_at", ""))) > current:
                raise HTTPException(status_code=409, detail="an Octo admin session is already active")
            previous["status"] = "expired"
        state["admin_session"] = {
            "session_id": req.session_id, "operator_subject": req.operator_subject,
            "credential_id": req.credential_id, "issued_at": req.issued_at,
            "expires_at": req.expires_at, "status": "active", "opened_at": now(),
        }
        save_state(state)
    return {"ok": True, "session": {k: state["admin_session"][k] for k in
                                      ("session_id", "operator_subject", "issued_at", "expires_at", "status")}}


@app.post("/v1/admin-sessions/{session_id}/close")
def close_admin_session(session_id: str,
                        authorization: str | None = Header(default=None)) -> dict:
    require_runner_token(authorization)
    with _LOCK:
        state = load_state()
        session = state.get("admin_session")
        if not isinstance(session, dict) or session.get("session_id") != session_id:
            raise HTTPException(status_code=404, detail="admin session not found")
        session["status"] = "revoked"
        session["revoked_at"] = now()
        save_state(state)
    return {"ok": True}


@app.post("/v1/admin-sessions/action")
def execute_admin_action(req: AdminSessionAction,
                         authorization: str | None = Header(default=None)) -> dict:
    require_runner_token(authorization)
    if not _ID.fullmatch(req.request_id):
        raise HTTPException(status_code=400, detail="invalid request id")
    with _LOCK:
        state = load_state()
        session = active_session(state, req.session_id)
        if req.request_id in state["executed"]:
            raise HTTPException(status_code=409, detail="request was already executed")
        method, endpoint, payload = validate_session_request(req, state)
        code, response_body = docker_call(method, endpoint, payload)
        if code not in (200, 201, 204, 304):
            raise HTTPException(status_code=502, detail=f"Docker rejected operation ({code}): {response_body[:300]}")
        result = {"request_id": req.request_id, "session_id": req.session_id,
                  "operator_subject": session["operator_subject"], "action": req.action,
                  "target": req.target, "endpoint": endpoint, "executed_at": now(),
                  "docker_status": code}
        state["executed"][req.request_id] = result
        save_state(state)
    return {"ok": True, "result": result}


@app.post("/v1/admin-sessions/exec")
def execute_admin_exec(req: AdminExecRequest,
                       authorization: str | None = Header(default=None)) -> StreamingResponse:
    require_runner_token(authorization)
    if not _ID.fullmatch(req.request_id):
        raise HTTPException(status_code=400, detail="invalid request id")
    if sum(len(part) for part in req.command) > 16_384:
        raise HTTPException(status_code=413, detail="command exceeds 16 KiB")
    with _LOCK:
        state = load_state()
        session = active_session(state, req.session_id)
        require_eligible_container(req.target)
        if req.request_id in state["executed"]:
            raise HTTPException(status_code=409, detail="request was already executed")
        exec_id = create_exec(req)
        state["executed"][req.request_id] = {
            "request_id": req.request_id, "session_id": req.session_id,
            "operator_subject": session["operator_subject"], "action": "exec",
            "target": req.target, "command_sha256": hashlib.sha256(
                json.dumps(req.command, separators=(",", ":")).encode()).hexdigest(),
            "started_at": now(),
        }
        save_state(state)
    return StreamingResponse(stream_exec(exec_id), media_type="application/x-ndjson",
                             headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})


@app.post("/v1/execute")
def execute(req: ExecuteRequest, authorization: str | None = Header(default=None)) -> dict:
    require_runner_token(authorization)
    if not _ID.fullmatch(req.request_id):
        raise HTTPException(status_code=400, detail="invalid request id")
    with _LOCK:
        state = load_state()
        executed = state["executed"]
        if req.request_id in executed:
            raise HTTPException(status_code=409, detail="request was already executed")
        if req.action == "docker_api":
            if req.docker_request is None:
                raise HTTPException(status_code=400, detail="docker_api request missing payload")
            method, endpoint, payload = validate_factory_request(req.docker_request, state, req.target)
        else:
            if not lifecycle_target_allowed(req.target):
                raise HTTPException(status_code=403, detail="target is not approved for lifecycle operations")
            method, endpoint, payload = "POST", {
                "start": f"/v1.47/containers/{req.target}/start",
                "stop": f"/v1.47/containers/{req.target}/stop?t=30",
                "restart": f"/v1.47/containers/{req.target}/restart?t=30",
            }[req.action], b""
        try:
            code, response_body = docker_call(method, endpoint, payload)
        except OSError as exc:
            raise HTTPException(status_code=502, detail=f"Docker unavailable: {exc}") from exc
        if code not in (200, 201, 204, 304):
            raise HTTPException(status_code=502, detail=f"Docker rejected operation ({code}): {response_body[:300]}")
        result = {"request_id": req.request_id, "action": req.action, "target": req.target,
                  "endpoint": endpoint, "executed_at": now(), "docker_status": code}
        # Docker returns an exec ID after POST /containers/<name>/exec. Remember
        # it so only an exec created through this factory runner can be started.
        if req.action == "docker_api" and "/exec" in endpoint:
            try:
                exec_id = json.loads(response_body).get("Id")
            except json.JSONDecodeError:
                exec_id = None
            if isinstance(exec_id, str) and re.fullmatch(r"[a-fA-F0-9]{64}", exec_id):
                state["factory_exec_ids"][exec_id] = {"created_at": now(), "container": req.target}
                result["docker_response"] = {"Id": exec_id}
        executed[req.request_id] = result
        if len(executed) > 2000:
            for key in sorted(executed, key=lambda k: executed[k].get("executed_at", ""))[:-1500]:
                executed.pop(key, None)
        save_state(state)
    return {"ok": True, "result": result}
