"""JSONL audit logger.

Every memory request — allowed or denied — gets one line written to
MEMORY_GATEWAY_AUDIT_LOG, mirrored to stderr (so fluent-bit picks it up
via Dozzle/Wazuh).

Fields per record (matches docs/08-SECURITY-MODEL.md §"Audit logs"):

    {
      "ts": "2026-05-23T12:34:56.789Z",
      "request_id": "<uuid4>",
      "profile":  "mark",
      "operation": "read",
      "uri":     "viking://profiles/steve/notes",
      "decision": "deny",
      "reason":  "matched deny rule for read",
      "matched_rule": "viking://profiles/*/**",
      "remote_addr": "172.30.0.x",
      "latency_ms": 4
    }
"""

from __future__ import annotations

import json
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class AuditLogger:
    """Thread-safe append-only JSONL writer."""

    def __init__(self, path: Path, mirror_to_stderr: bool = True) -> None:
        self.path = path
        self.mirror_to_stderr = mirror_to_stderr
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Touch the file so containers without an existing audit.log don't
        # tripping the "not found" branch on first read.
        self.path.touch(exist_ok=True)

    def log(self, **fields: Any) -> None:
        record: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            **fields,
        }
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            with self.path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        if self.mirror_to_stderr:
            print(line, file=sys.stderr, flush=True)
