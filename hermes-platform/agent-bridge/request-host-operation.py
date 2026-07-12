#!/usr/bin/env python3
"""Little John's proposal-only tool for approval-gated Windows remediation."""
from __future__ import annotations
import argparse, json, os, sys, urllib.error, urllib.request

p = argparse.ArgumentParser()
p.add_argument("title")
p.add_argument("--script-file", required=True)
p.add_argument("--reason", required=True)
p.add_argument("--remediation-id", default="")
p.add_argument("--remediation-payload-file", default="")
p.add_argument("--risk", choices=("low", "medium", "high", "critical"), default="medium")
a = p.parse_args()
try:
    script = open(a.script_file, encoding="utf-8").read()
except OSError as exc:
    raise SystemExit(f"cannot read plan: {exc}") from exc
payload = None
if a.remediation_payload_file:
    try:
        with open(a.remediation_payload_file, encoding="utf-8") as fh:
            payload = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"cannot read remediation payload: {exc}") from exc
url, token = os.environ.get("MC_HOST_OPERATIONS_URL", "http://mission-control:8080").rstrip("/"), os.environ.get("MC_HOST_OPERATIONS_SUBMIT_TOKEN", "")
if not token:
    try:
        token = open(os.environ.get("MC_HOST_OPERATIONS_SUBMIT_TOKEN_FILE", "/opt/data/.host-operations-submit-token"), encoding="utf-8").read().strip()
    except OSError:
        token = ""
if not url or not token or not script.strip() or len(script) > 60_000:
    raise SystemExit("host operation is not configured or plan is invalid")
body_obj = {"action":"host_powershell", "target":a.title, "reason":a.reason,
            "script":script, "remediation_id":a.remediation_id.strip(),
            "risk":a.risk}
if payload is not None:
    body_obj["remediation_payload"] = payload
body = json.dumps(body_obj).encode()
req = urllib.request.Request(f"{url}/api/operations/requests/littlejohn", data=body, method="POST",
    headers={"Content-Type":"application/json", "X-Operations-Submit-Token":token})
try:
    with urllib.request.urlopen(req, timeout=20) as r: print(r.read().decode())
except urllib.error.HTTPError as exc:
    print(exc.read().decode("utf-8", "replace"), file=sys.stderr); raise SystemExit(1) from exc
