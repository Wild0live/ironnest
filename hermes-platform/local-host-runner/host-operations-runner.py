#!/usr/bin/env python3
"""Windows-host executor for exact, Mission-Control-approved PowerShell plans.

Run this only on the Windows PC to be managed. It never accepts agent traffic:
only Mission Control, holding the runner token, can send a single-use approval.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("HOST_OPERATIONS_RUNNER_HOST", "127.0.0.1")
PORT = int(os.environ.get("HOST_OPERATIONS_RUNNER_PORT", "8765"))
TOKEN = os.environ.get("HOST_OPERATIONS_RUNNER_TOKEN", "").strip()
POWERSHELL = os.environ.get("HOST_OPERATIONS_POWERSHELL", "powershell.exe")
REQUEST_ID = re.compile(r"^op-[0-9a-f]{32}$")
completed: set[str] = set()
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        return

    def reply(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/execute" or self.headers.get("Authorization") != f"Bearer {TOKEN}":
            self.reply(401, {"ok": False, "error": "unauthorized"}); return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            value = json.loads(self.rfile.read(min(n, 70_000)).decode("utf-8"))
            request_id, action, script = str(value["request_id"]), str(value["action"]), str(value["script"])
        except (ValueError, KeyError, json.JSONDecodeError, UnicodeDecodeError):
            self.reply(400, {"ok": False, "error": "invalid request"}); return
        if not REQUEST_ID.fullmatch(request_id) or action != "host_powershell" or not script.strip() or len(script) > 60_000:
            self.reply(400, {"ok": False, "error": "invalid operation"}); return
        with lock:
            if request_id in completed:
                self.reply(409, {"ok": False, "error": "request already executed"}); return
            with tempfile.NamedTemporaryFile(mode="w", suffix=".ps1", encoding="utf-8", delete=False) as fh:
                fh.write(script); path = fh.name
            try:
                result = subprocess.run([POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive",
                                         "-ExecutionPolicy", "Bypass", "-File", path], capture_output=True,
                                        text=True, timeout=1800, check=False)
            except (OSError, subprocess.TimeoutExpired) as exc:
                self.reply(502, {"ok": False, "error": f"PowerShell did not run: {exc}"}); return
            finally:
                try: os.unlink(path)
                except OSError: pass
            if result.returncode:
                self.reply(502, {"ok": False, "error": "PowerShell plan failed", "exit_code": result.returncode}); return
            completed.add(request_id)
        self.reply(200, {"ok": True, "result": {"request_id": request_id, "action": action, "target": value.get("target", "Windows host")}})


if __name__ == "__main__":
    if not TOKEN: raise SystemExit("HOST_OPERATIONS_RUNNER_TOKEN must be set")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
