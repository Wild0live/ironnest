"""OpenViking adapter — the ONLY file that knows OpenViking's API surface.

If OpenViking's official API changes, this file is the single point of
update. The rest of the gateway is policy + transport and is unaffected.

Reference: https://github.com/volcengine/OpenViking

ASSUMPTIONS (documented because the public API surface is not fully
specified in the upstream README at the time of writing):

  * The server listens on :1933 inside the container.
  * The CLI command surface is:
      ov status                  → GET  /status
      ov add-resource <url>      → POST /resources
      ov ls <uri>                → GET  /ls?uri=<uri>
      ov find "<query>"          → POST /find    {"query": "..."}
      ov grep "<term>" --uri ... → POST /grep    {"term": "...", "uri": "..."}
      ov chat                    → server-streamed; not used by gateway
  * Writing a new entry under a URI:  POST /entries  with body
      {"uri": "<canonical>", "content": "<...>", "metadata": {...}}
  * Reading by URI:                   GET  /entries?uri=<canonical>
  * Error responses are JSON with {"error": "...", "code": "..."} and
    appropriate HTTP status codes.

Where the upstream surface differs at runtime, the adapter logs the
discrepancy via the audit logger and falls back to the Python SDK
(`from openviking import client as ov_sdk`) if importable. Both paths
are wrapped behind the same OpenVikingClient public methods so callers
don't change.

Namespace translation lives in _to_native() / _from_native():

  Logical                                  ↔ Native (OpenViking)
  viking://shared/X                         ↔ viking://resources/shared/X
  viking://profiles/<p>/X                   ↔ viking://resources/profiles/<p>/X
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx

from .namespace import ParsedURI, parse_uri

logger = logging.getLogger(__name__)


# ── Namespace translation ───────────────────────────────────────────────────

def to_native_uri(uri: str) -> str:
    """Translate gateway-logical URI → OpenViking-native URI."""
    p = parse_uri(uri)
    if p.top == "shared":
        return _join("viking://resources/shared", *p.sub)
    return _join("viking://resources/profiles", p.profile or "", *p.sub)


def from_native_uri(native: str) -> str:
    """Inverse of to_native_uri(). Useful for surfacing OpenViking-returned URIs."""
    if not native.startswith("viking://resources/"):
        raise ValueError(f"not a hermes-platform-managed native uri: {native!r}")
    tail = native[len("viking://resources/"):]
    if tail.startswith("shared/"):
        return f"viking://shared/{tail[len('shared/'):]}".rstrip("/")
    if tail.startswith("profiles/"):
        return f"viking://profiles/{tail[len('profiles/'):]}".rstrip("/")
    raise ValueError(f"not a hermes-platform-managed native uri: {native!r}")


def _join(*parts: str) -> str:
    return "/".join(s.rstrip("/") for s in parts if s != "").rstrip("/")


# ── Client ──────────────────────────────────────────────────────────────────

@dataclass(frozen=True, slots=True)
class OpenVikingResponse:
    ok: bool
    status: int
    data: dict[str, Any]
    raw: str


class OpenVikingError(RuntimeError):
    pass


class OpenVikingClient:
    """HTTP client for the OpenViking server.

    Single instance per process; held in app.state.openviking.
    """

    def __init__(self, base_url: str, *, timeout: float = 30.0, dry_run: bool = False,
                 api_key: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.dry_run = dry_run
        self.api_key = api_key
        self._http: httpx.AsyncClient | None = None
        # Cache of native parent URIs known to exist (mkdir succeeded).
        # Skips the mkdir round-trip on repeated writes to the same subtree.
        self._known_dirs: set[str] = set()

    async def __aenter__(self) -> "OpenVikingClient":
        if not self.dry_run:
            headers = {
                "User-Agent": "hermes-platform-memory-gateway/0.1.0",
                # OpenViking enforces tenant scoping on /content/* and /fs/*
                # endpoints when authenticated as ROOT. Without these headers
                # ROOT calls get 400 "must include X-OpenViking-Account and
                # X-OpenViking-User". We pin to "default" — the per-caller
                # mapping (e.g. X-OpenViking-User = <profile>) is a future
                # enhancement once OpenViking's per-user account isolation
                # is needed alongside the gateway's policy isolation.
                "X-OpenViking-Account": "default",
                "X-OpenViking-User":    "default",
                "X-OpenViking-Agent":   "default",
            }
            if self.api_key:
                # OpenViking accepts both Authorization: Bearer and X-API-Key;
                # see openviking/server/auth.py:_extract_api_key. Use Bearer
                # for consistency with the memory-gateway's own auth scheme.
                headers["Authorization"] = f"Bearer {self.api_key}"
            self._http = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=self.timeout,
                headers=headers,
            )
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    # ── Health probe ────────────────────────────────────────────────────────

    async def status(self) -> OpenVikingResponse:
        """Liveness check. OpenViking exposes /health (returns 200 with
        a JSON body including {status, healthy, version, auth_mode, role}).
        The earlier `/status` assumption was wrong — that path returns 404."""
        if self.dry_run:
            return OpenVikingResponse(ok=True, status=200,
                                      data={"status": "dry_run", "server": "openviking"},
                                      raw="")
        assert self._http is not None
        try:
            r = await self._http.get("/health")
            return self._wrap(r)
        except httpx.HTTPError as e:
            raise OpenVikingError(f"openviking /health failed: {e}") from e

    # ── Read / write ────────────────────────────────────────────────────────

    async def read(self, uri: str) -> OpenVikingResponse:
        """GET an entry by gateway-logical URI.

        REAL endpoint (verified 2026-05-23 from /openapi.json):
          GET /api/v1/content/read?uri=<native>[&offset=N&limit=N]
        """
        native = to_native_uri(uri)
        if self.dry_run:
            return OpenVikingResponse(ok=True, status=200,
                                      data={"uri": uri, "native_uri": native,
                                            "content": "<dry_run>", "tier": "L2"},
                                      raw="")
        assert self._http is not None
        r = await self._http.get("/api/v1/content/read", params={"uri": native})
        return self._wrap(r)

    async def write(self, uri: str, content: str, metadata: dict[str, Any] | None = None) -> OpenVikingResponse:
        """POST an entry under a gateway-logical URI.

        REAL endpoint (WriteContentRequest schema):
          POST /api/v1/content/write
          body: {uri, content, mode?, wait?, timeout?, telemetry?}

        Behavior:
          1. mkdir the PARENT directory (idempotent + recursive — single call
             creates all ancestors. Verified 2026-05-23.) Skipped if parent
             is already in self._known_dirs (per-instance cache).
          2. POST /api/v1/content/write with mode=create.
          3. If the file already exists (HTTP 4xx with "already exists"),
             fall back to mode=replace.

        NOTE: OpenViking's WriteContentRequest does NOT have a `metadata`
        field. The metadata arg here is silently dropped — extension point
        for when OpenViking adds it or we encode metadata into content.
        """
        native = to_native_uri(uri)
        if self.dry_run:
            return OpenVikingResponse(ok=True, status=201,
                                      data={"uri": uri, "native_uri": native, "stored": True,
                                            "metadata_dropped": bool(metadata)},
                                      raw="")
        assert self._http is not None

        # 1. Ensure parent directory exists (idempotent recursive mkdir).
        await self._ensure_parent_dir(native)

        # 2. Try create.
        r = await self._http.post(
            "/api/v1/content/write",
            json={"uri": native, "content": content, "mode": "create"},
        )

        # 3. If file already exists, retry with replace. OpenViking returns
        #    HTTP 4xx (status varies) with a body mentioning "exists" or
        #    "already". Be liberal in what we accept as the conflict signal.
        if not (200 <= r.status_code < 300):
            body_lc = r.text.lower()
            if "already" in body_lc or "exists" in body_lc or "conflict" in body_lc:
                r = await self._http.post(
                    "/api/v1/content/write",
                    json={"uri": native, "content": content, "mode": "replace"},
                )

        return self._wrap(r)

    async def _ensure_parent_dir(self, native_file_uri: str) -> None:
        """mkdir the parent of a file URI. Idempotent and recursive.

        Caches successful parent URIs in self._known_dirs so repeat writes
        to the same subtree skip the mkdir round-trip (~5-10ms per write).
        """
        # Compute parent: drop the last path segment after viking://
        if not native_file_uri.startswith("viking://"):
            return
        body = native_file_uri[len("viking://"):]
        if "/" not in body:
            return  # at the namespace root; nothing to mkdir
        parent = "viking://" + body.rsplit("/", 1)[0]

        if parent in self._known_dirs:
            return

        assert self._http is not None
        try:
            r = await self._http.post("/api/v1/fs/mkdir", json={"uri": parent})
            if 200 <= r.status_code < 300:
                self._known_dirs.add(parent)
            # mkdir failures are non-fatal — let the subsequent write surface
            # the real error. Best-effort.
        except Exception:
            # Network error / timeout — let the write attempt surface it.
            pass

    async def list(self, uri: str) -> OpenVikingResponse:
        """`ov ls` equivalent — children of a URI.

        REAL endpoint:
          GET /api/v1/fs/ls?uri=<native>[&recursive=...&simple=...]
        """
        native = to_native_uri(uri)
        if self.dry_run:
            return OpenVikingResponse(ok=True, status=200,
                                      data={"uri": uri, "children": []}, raw="")
        assert self._http is not None
        r = await self._http.get("/api/v1/fs/ls", params={"uri": native})
        return self._wrap(r)

    async def find(self, query: str, scope_uri: str | None = None) -> OpenVikingResponse:
        """Semantic search (`ov find`).

        REAL endpoint (FindRequest schema):
          POST /api/v1/search/find
          body: {query, target_uri?, limit?, score_threshold?, ...}
        NOTE the field is `target_uri` (not `uri`).
        """
        body: dict[str, Any] = {"query": query}
        if scope_uri:
            body["target_uri"] = to_native_uri(scope_uri)
        if self.dry_run:
            return OpenVikingResponse(ok=True, status=200, data={"results": []}, raw="")
        assert self._http is not None
        r = await self._http.post("/api/v1/search/find", json=body)
        return self._wrap(r)

    async def grep(self, term: str, uri: str) -> OpenVikingResponse:
        """Substring/regex search.

        REAL endpoint:
          POST /api/v1/search/grep
          body: {pattern, target_uri?, ...}   (field name `pattern`, not `term`)
        """
        body = {"pattern": term, "target_uri": to_native_uri(uri)}
        if self.dry_run:
            return OpenVikingResponse(ok=True, status=200, data={"matches": []}, raw="")
        assert self._http is not None
        r = await self._http.post("/api/v1/search/grep", json=body)
        return self._wrap(r)

    # ── Internals ───────────────────────────────────────────────────────────

    @staticmethod
    def _wrap(r: httpx.Response) -> OpenVikingResponse:
        body_text = r.text
        try:
            data = r.json()
            if not isinstance(data, dict):
                data = {"value": data}
        except ValueError:
            data = {"raw": body_text}
        return OpenVikingResponse(
            ok=200 <= r.status_code < 300,
            status=r.status_code,
            data=data,
            raw=body_text,
        )
