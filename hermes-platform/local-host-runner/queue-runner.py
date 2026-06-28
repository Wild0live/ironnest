#!/usr/bin/env python3
"""Execute approved host-operation jobs from a private shared folder."""
from __future__ import annotations
import json, os, subprocess, sys, tempfile, time
from pathlib import Path

queue = Path(os.environ.get("HOST_OPERATIONS_QUEUE", ""))
if not queue: raise SystemExit("HOST_OPERATIONS_QUEUE is required")
jobs, results = queue / "jobs", queue / "results"; jobs.mkdir(parents=True, exist_ok=True); results.mkdir(exist_ok=True)
def tail(value: str, limit: int = 12000) -> str:
    return value[-limit:] if len(value) > limit else value

while True:
    for jobfile in jobs.glob("op-*.json"):
        resultfile = results / jobfile.name
        if resultfile.exists(): continue
        try:
            job = json.loads(jobfile.read_text(encoding="utf-8")); script = str(job["script"])
            with tempfile.NamedTemporaryFile("w", suffix=".ps1", encoding="utf-8", delete=False) as fh: fh.write(script); path = fh.name
            try: r = subprocess.run(["powershell.exe","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path], timeout=1800, capture_output=True, text=True)
            finally: os.unlink(path)
            result = {"ok": r.returncode == 0, "exit_code": r.returncode,
                      "stdout": tail(r.stdout), "stderr": tail(r.stderr),
                      "completed_at": time.time()}
        except Exception as exc: result = {"ok": False, "error": str(exc), "completed_at": time.time()}
        tmp = resultfile.with_suffix(".tmp"); tmp.write_text(json.dumps(result), encoding="utf-8"); os.replace(tmp, resultfile)
    time.sleep(1)
