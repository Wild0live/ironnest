#!/usr/bin/env python3
"""LittleJohn's pre-approved power switch for the Kali MCP container."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


parser = argparse.ArgumentParser()
parser.add_argument("action", choices=("start", "stop", "restart"))
parser.add_argument("--reason", default="LittleJohn requested Kali MCP lifecycle control.")
args = parser.parse_args()

url = os.environ.get("MC_HOST_OPERATIONS_URL", "http://mission-control:8080").rstrip("/")
token = os.environ.get("MC_HOST_OPERATIONS_SUBMIT_TOKEN", "")
if not token:
    try:
        token = open(
            os.environ.get(
                "MC_HOST_OPERATIONS_SUBMIT_TOKEN_FILE",
                "/opt/data/.host-operations-submit-token",
            ),
            encoding="utf-8",
        ).read().strip()
    except OSError:
        token = ""

if not url or not token:
    raise SystemExit("Kali lifecycle operation is not configured")

body = json.dumps({
    "action": args.action,
    "target": "kali-mcp-littlejohn",
    "reason": args.reason,
}).encode("utf-8")
request = urllib.request.Request(
    f"{url}/api/operations/requests/littlejohn",
    data=body,
    method="POST",
    headers={"Content-Type": "application/json", "X-Operations-Submit-Token": token},
)
try:
    with urllib.request.urlopen(request, timeout=45) as response:
        print(response.read().decode("utf-8"))
except urllib.error.HTTPError as exc:
    print(exc.read().decode("utf-8", "replace"), file=sys.stderr)
    raise SystemExit(1) from exc
