#!/usr/bin/env python3
"""Submit an approval-gated Windows filesystem transaction proposal."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


PROFILE_ENDPOINTS = {
    "default": "/api/operations/requests/default",
    "littlejohn": "/api/operations/requests/littlejohn",
    "octo": "/api/operations/requests/octo",
}


def read_token(profile: str) -> str:
    candidates = [
        "MC_HOST_OPERATIONS_SUBMIT_TOKEN",
        f"{profile.upper()}_OPERATIONS_SUBMIT_TOKEN",
        "DEFAULT_OPERATIONS_SUBMIT_TOKEN" if profile == "default" else "",
        "LITTLEJOHN_OPERATIONS_SUBMIT_TOKEN" if profile == "littlejohn" else "",
        "OCTO_OPERATIONS_SUBMIT_TOKEN" if profile == "octo" else "",
    ]
    for name in candidates:
        value = os.environ.get(name, "").strip() if name else ""
        if value:
            return value
    for path in [
        os.environ.get("MC_HOST_OPERATIONS_SUBMIT_TOKEN_FILE", ""),
        "/run/secrets/littlejohn-host-operations-submit-token",
        "/opt/data/.host-operations-submit-token",
    ]:
        if not path:
            continue
        try:
            value = open(path, encoding="utf-8").read().strip()
        except OSError:
            continue
        if value:
            return value
    return ""


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("title")
parser.add_argument("--transaction-file", required=True, help="JSON transaction body")
parser.add_argument("--reason", required=True)
parser.add_argument("--profile", default=os.environ.get("HERMES_PROFILE", "default"))
parser.add_argument("--risk", choices=("low", "medium", "high", "critical"), default="high")
args = parser.parse_args()

profile = args.profile.strip().lower()
endpoint = PROFILE_ENDPOINTS.get(profile)
if not endpoint:
    raise SystemExit(f"profile is not allowed to submit host filesystem transactions: {profile}")

try:
    transaction = json.loads(open(args.transaction_file, encoding="utf-8").read())
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f"cannot read transaction JSON: {exc}") from exc
if not isinstance(transaction, dict):
    raise SystemExit("transaction JSON must be an object")
transaction.setdefault("profile", profile)

url = os.environ.get("MC_HOST_OPERATIONS_URL") or os.environ.get("MISSION_CONTROL_URL") or "http://mission-control:8080"
url = url.rstrip("/")
token = read_token(profile)
if not url or not token:
    raise SystemExit("host filesystem proposal is not configured")

body = json.dumps({
    "action": "host_filesystem",
    "target": args.title,
    "reason": args.reason,
    "filesystem_transaction": transaction,
    "risk": args.risk,
}).encode("utf-8")
request = urllib.request.Request(
    f"{url}{endpoint}",
    data=body,
    method="POST",
    headers={"Content-Type": "application/json", "X-Operations-Submit-Token": token},
)
try:
    with urllib.request.urlopen(request, timeout=20) as response:
        print(response.read().decode("utf-8"))
except urllib.error.HTTPError as exc:
    print(exc.read().decode("utf-8", "replace"), file=sys.stderr)
    raise SystemExit(1) from exc
