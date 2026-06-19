"""Hermes memory provider that accesses OpenViking through memory-gateway.

The profile containers intentionally have no direct network route or API key
for OpenViking. This provider keeps automatic conversational memory inside the
same authenticated, audited, policy-enforced gateway path as manual requests.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from typing import Any, Dict, List, Optional

import httpx

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)


SEARCH_SCHEMA = {
    "name": "memory_search",
    "description": "Search this profile's private long-term memory in OpenViking.",
    "parameters": {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "What to recall."}},
        "required": ["query"],
    },
}
READ_SCHEMA = {
    "name": "memory_read_private",
    "description": "Read a private memory URI owned by this profile.",
    "parameters": {
        "type": "object",
        "properties": {"uri": {"type": "string", "description": "A viking://profiles/<self>/ URI."}},
        "required": ["uri"],
    },
}
REMEMBER_SCHEMA = {
    "name": "memory_remember",
    "description": "Store a durable private fact or decision in this profile's OpenViking memory.",
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "Durable fact or decision to retain."},
            "category": {"type": "string", "description": "Optional category, such as preference or project."},
        },
        "required": ["content"],
    },
}
PUBLISH_SCHEMA = {
    "name": "memory_publish_approved",
    "description": "Publish an already-stored private memory into this profile's approved shared memory.",
    "parameters": {
        "type": "object",
        "properties": {
            "source_uri": {"type": "string", "description": "Private memory URI owned by this profile."},
            "rationale": {"type": "string", "description": "Reason this content may be shared."},
        },
        "required": ["source_uri", "rationale"],
    },
}


class IronNestGatewayMemoryProvider(MemoryProvider):
    """Automatic conversational memory via the policy-enforcing gateway."""

    def __init__(self) -> None:
        self._base_url = ""
        self._token = ""
        self._profile = ""
        self._session_id = ""
        self._prefetch_timeout = 30.0
        self._turn_count = 0
        self._write_lock = threading.Lock()
        self._threads: list[threading.Thread] = []

    @property
    def name(self) -> str:
        return "ironnest_gateway"

    def is_available(self) -> bool:
        return bool(os.environ.get("MEMORY_GATEWAY_URL") and os.environ.get("MEMORY_GATEWAY_TOKEN"))

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._base_url = os.environ["MEMORY_GATEWAY_URL"].rstrip("/")
        self._token = os.environ["MEMORY_GATEWAY_TOKEN"]
        self._profile = os.environ.get("HERMES_PROFILE", "default")
        self._session_id = session_id
        try:
            self._prefetch_timeout = max(
                0.1, float(os.environ.get("MEMORY_PREFETCH_TIMEOUT_SECONDS", "30.0"))
            )
        except ValueError:
            logger.warning("Invalid MEMORY_PREFETCH_TIMEOUT_SECONDS; using 30 seconds")
            self._prefetch_timeout = 30.0
        self._turn_count = 0
        with httpx.Client(timeout=5.0) as client:
            response = client.get(f"{self._base_url}/health")
            response.raise_for_status()

    def system_prompt_block(self) -> str:
        return (
            "# IronNest Long-Term Memory\n"
            "Automatic private conversational memory is active through the audited Memory Gateway. "
            "Use memory_search when prior facts or decisions may matter, memory_remember for durable "
            "facts, and memory_publish_approved only for carefully curated shareable content. "
            "Never store secrets or chain-of-thought."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not query.strip():
            return ""
        try:
            payload = self._post(
                "/memory/search",
                {"query": query[:1500], "scope_uri": f"viking://profiles/{self._profile}/"},
                timeout=self._prefetch_timeout,
            )
            results = self._recall_lines(payload)
            if not results:
                return ""
            return "## IronNest Recalled Private Memory\n" + "\n".join(results[:5])
        except Exception as exc:
            logger.debug("IronNest memory prefetch failed: %s", exc)
            return ""

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        if not user_content or not assistant_content:
            return
        self._turn_count += 1
        sid = self._safe_segment(session_id or self._session_id)
        turn = self._turn_count
        safe_user = self._redact_sensitive(user_content[:4000])
        safe_assistant = self._redact_sensitive(assistant_content[:6000])
        content = (
            f"# Conversation turn {turn}\n\n"
            f"User:\n{safe_user}\n\n"
            f"Assistant:\n{safe_assistant}\n"
        )
        uri = f"viking://profiles/{self._profile}/conversations/{sid}/turn-{turn:05d}.md"
        self._background_write(uri, content, {"kind": "conversation_turn", "turn": turn})

    def on_session_switch(
        self, new_session_id: str, *, parent_session_id: str = "", reset: bool = False, **kwargs: Any
    ) -> None:
        self._session_id = new_session_id
        if reset:
            self._turn_count = 0

    def on_memory_write(
        self, action: str, target: str, content: str, metadata: Optional[dict[str, Any]] = None
    ) -> None:
        if action != "add" or not content:
            return
        stamp = int(time.time() * 1000)
        category = self._safe_segment(target or "note")
        uri = f"viking://profiles/{self._profile}/memories/{category}/{stamp}.md"
        self._background_write(uri, content, {"kind": "builtin_memory", **(metadata or {})})

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [SEARCH_SCHEMA, READ_SCHEMA, REMEMBER_SCHEMA, PUBLISH_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs: Any) -> str:
        try:
            if tool_name == "memory_search":
                query = args.get("query", "").strip()
                if not query:
                    return self._tool_error("query is required")
                return json.dumps(
                    self._post(
                        "/memory/search",
                        {"query": query, "scope_uri": f"viking://profiles/{self._profile}/"},
                    ),
                    ensure_ascii=False,
                )
            if tool_name == "memory_read_private":
                uri = args.get("uri", "")
                self._require_private_uri(uri)
                return json.dumps(self._post("/memory/read", {"uri": uri}), ensure_ascii=False)
            if tool_name == "memory_remember":
                content = args.get("content", "").strip()
                if not content:
                    return self._tool_error("content is required")
                category = self._safe_segment(args.get("category", "remembered"))
                uri = (
                    f"viking://profiles/{self._profile}/memories/"
                    f"{category}/{int(time.time() * 1000)}.md"
                )
                return json.dumps(
                    self._post("/memory/write", {"uri": uri, "content": content}),
                    ensure_ascii=False,
                )
            if tool_name == "memory_publish_approved":
                source_uri = args.get("source_uri", "")
                self._require_private_uri(source_uri)
                suffix = source_uri.rsplit("/", 1)[-1] or f"published-{int(time.time())}.md"
                target = f"viking://shared/approved/{self._profile}/{suffix}"
                return json.dumps(
                    self._post(
                        "/memory/publish-approved",
                        {
                            "source_uri": source_uri,
                            "target_uri": target,
                            "rationale": args.get("rationale", "approved by agent"),
                        },
                    ),
                    ensure_ascii=False,
                )
            return self._tool_error(f"unknown tool: {tool_name}")
        except Exception as exc:
            return self._tool_error(str(exc))

    def shutdown(self) -> None:
        for thread in list(self._threads):
            if thread.is_alive():
                thread.join(timeout=5.0)

    def _post(
        self, path: str, payload: dict[str, Any], *, timeout: float = 30.0
    ) -> dict[str, Any]:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(
                f"{self._base_url}{path}",
                headers={"Authorization": f"Bearer {self._token}"},
                json=payload,
            )
            response.raise_for_status()
            return response.json()

    def _background_write(self, uri: str, content: str, metadata: dict[str, Any]) -> None:
        def write() -> None:
            try:
                with self._write_lock:
                    self._post("/memory/write", {"uri": uri, "content": content, "metadata": metadata})
            except Exception as exc:
                logger.warning("IronNest automatic memory write failed for %s: %s", uri, exc)

        thread = threading.Thread(target=write, daemon=True, name="ironnest-memory-write")
        self._threads.append(thread)
        thread.start()

    def _require_private_uri(self, uri: str) -> None:
        expected = f"viking://profiles/{self._profile}/"
        if not uri.startswith(expected):
            raise ValueError(f"uri must be inside {expected}")

    @staticmethod
    def _safe_segment(value: str) -> str:
        clean = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip(".-")
        return clean[:100] or "session"

    @staticmethod
    def _redact_sensitive(content: str) -> str:
        content = re.sub(
            r"(?i)\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|secret)\b"
            r"(\s*[:=]\s*)(\S+)",
            r"\1\2[REDACTED]",
            content,
        )
        content = re.sub(r"(?i)\bBearer\s+\S+", "Bearer [REDACTED]", content)
        return re.sub(r"\b[a-fA-F0-9]{48,}\b", "[REDACTED_HEX]", content)

    def _recall_lines(self, payload: dict[str, Any]) -> list[str]:
        data = payload.get("data", {})
        result = data.get("result", data)
        if not isinstance(result, dict):
            return []
        entries: list[dict[str, Any]] = []
        for group in ("memories", "resources", "skills", "results"):
            group_entries = result.get(group, [])
            if isinstance(group_entries, list):
                entries.extend(entry for entry in group_entries if isinstance(entry, dict))
        entries.sort(key=lambda entry: entry.get("score") or 0, reverse=True)

        lines: list[str] = []
        for entry in entries:
            uri = entry.get("uri", "")
            if not uri or uri.rsplit("/", 1)[-1].startswith("."):
                continue
            logical_uri = self._logical_uri(uri)
            if not logical_uri:
                continue
            try:
                body = self._post("/memory/read", {"uri": logical_uri})
                content = body.get("data", {}).get("result", "")
                if isinstance(content, str) and content.strip():
                    lines.append(f"- From {logical_uri}:\n{content[:1000]}")
            except Exception as exc:
                logger.debug("IronNest recall hydrate failed for %s: %s", logical_uri, exc)
            if len(lines) >= 3:
                return lines

        for entry in entries:
            abstract = entry.get("abstract") or entry.get("content") or ""
            if abstract and "not ready" not in abstract.lower():
                lines.append(f"- {abstract[:400]} ({entry.get('uri', '')})")
        return lines

    def _logical_uri(self, uri: str) -> str:
        private_prefix = f"viking://resources/profiles/{self._profile}/"
        shared_prefix = "viking://resources/shared/"
        if uri.startswith(private_prefix):
            return f"viking://profiles/{self._profile}/{uri[len(private_prefix):]}"
        if uri.startswith(shared_prefix):
            return f"viking://shared/{uri[len(shared_prefix):]}"
        return ""

    @staticmethod
    def _tool_error(message: str) -> str:
        return json.dumps({"error": message}, ensure_ascii=False)


def register(ctx: Any) -> None:
    ctx.register_memory_provider(IronNestGatewayMemoryProvider())
