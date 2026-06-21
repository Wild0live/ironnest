"""Approval-gated Docker factory runner.

The runner owns the Docker socket, but agents never do.  It accepts only one
approved, single-use request at a time and exposes a deliberately small Docker
API subset needed by a software factory: create/start/stop/restart containers,
create/start exec sessions, bind approved host roots, and create/connect factory
networks.  It is not a standing Docker API proxy or a shell endpoint.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import socket
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

TOKEN = os.environ.get("OPERATIONS_RUNNER_TOKEN", "").strip()
ALLOWED_CONTAINERS = frozenset(item.strip() for item in os.environ.get(
    "OPERATIONS_ALLOWED_CONTAINERS", "").split(",") if item.strip())
FACTORY_PREFIX = os.environ.get("FACTORY_CONTAINER_PREFIX", "factory-").strip()
FACTORY_HOST_ROOTS = tuple(p.strip().replace("\\", "/").rstrip("/").lower() for p in os.environ.get(
    "FACTORY_HOST_PATH_ROOTS", "").split(",") if p.strip())
STATE_FILE = Path(os.environ.get("OPERATIONS_RUNNER_STATE_FILE", "/var/lib/operations-runner/executed.json"))
SOCKET_PATH = os.environ.get("DOCKER_SOCKET", "/var/run/docker.sock")
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
            return value
    except (OSError, json.JSONDecodeError):
        pass
    return {"executed": {}, "factory_exec_ids": {}}


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


def require_runner_token(authorization: str | None = Header(default=None)) -> None:
    if not TOKEN or authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="runner authorization required")


def factory_name(value: str) -> bool:
    return bool(FACTORY_PREFIX and value.startswith(FACTORY_PREFIX) and _NAME.fullmatch(value))


def host_path_allowed(source: str) -> bool:
    source = source.replace("\\", "/").rstrip("/").lower()
    return any(source == root or source.startswith(root + "/") for root in FACTORY_HOST_ROOTS)


def validate_create(body: dict[str, Any], query: dict[str, list[str]]) -> None:
    names = query.get("name", [])
    if len(names) != 1 or not factory_name(names[0]):
        raise HTTPException(status_code=403, detail="container name must use the factory prefix")
    if not isinstance(body.get("Image"), str) or not body["Image"].strip():
        raise HTTPException(status_code=400, detail="container create requires Image")
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


def validate_factory_request(req: DockerRequest, state: dict[str, Any]) -> tuple[str, str, bytes]:
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
    if resource == "containers/create" and req.method == "POST":
        validate_create(body, query)
        allowed = True
    elif m := re.fullmatch(r"containers/([^/]+)/(start|stop|restart|exec)", resource):
        if req.method == "POST" and factory_name(m.group(1)):
            if m.group(2) == "exec" and not isinstance(body.get("Cmd"), list):
                raise HTTPException(status_code=400, detail="exec creation requires a Cmd array")
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
    if not allowed:
        raise HTTPException(status_code=403, detail="Docker request is outside the approved factory API subset")
    encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 262_144:
        raise HTTPException(status_code=413, detail="Docker request body exceeds 256 KiB")
    return req.method, req.path, encoded


app = FastAPI(title="IronNest Operations Runner", version="0.2.0")


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": bool(TOKEN), "service": "operations-runner"}


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
            method, endpoint, payload = validate_factory_request(req.docker_request, state)
        else:
            if req.target not in ALLOWED_CONTAINERS:
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
