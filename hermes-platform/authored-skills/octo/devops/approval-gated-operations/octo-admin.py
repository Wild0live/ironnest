#!/usr/bin/env python3
"""Use Octo's active, operator-opened admin session without exposing runner credentials."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


BASE = os.environ.get("MISSION_CONTROL_URL", "http://mission-control:8080").rstrip("/")
TOKEN = os.environ.get("OCTO_OPERATIONS_SUBMIT_TOKEN", "")


def call(path: str, payload: dict | None = None, *, stream: bool = False):
    if not TOKEN:
        raise SystemExit("OCTO_OPERATIONS_SUBMIT_TOKEN is not configured")
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{BASE}{path}", data=body, method="GET" if payload is None else "POST",
        headers={"Content-Type": "application/json", "X-Operations-Submit-Token": TOKEN})
    try:
        response = urllib.request.urlopen(request, timeout=660 if stream else 60)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Mission Control rejected the request ({exc.code}): {exc.read().decode('utf-8', 'replace')}") from exc
    if not stream:
        with response:
            print(json.dumps(json.load(response), indent=2))
        return
    with response:
        for raw in response:
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                sys.stdout.buffer.write(raw); sys.stdout.buffer.flush(); continue
            target = sys.stderr if event.get("stream") == "stderr" else sys.stdout
            target.write(str(event.get("data", ""))); target.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description="Use an active FIDO-opened Octo admin session")
    sub = parser.add_subparsers(dest="command_name", required=True)
    sub.add_parser("status")
    execute = sub.add_parser("exec")
    execute.add_argument("target")
    execute.add_argument("--reason", required=True)
    execute.add_argument("--working-dir")
    execute.add_argument("command", nargs=argparse.REMAINDER)
    lifecycle = sub.add_parser("lifecycle")
    lifecycle.add_argument("action", choices=("start", "stop", "restart", "pause", "unpause"))
    lifecycle.add_argument("target")
    lifecycle.add_argument("--reason", required=True)
    docker = sub.add_parser("docker-api")
    docker.add_argument("target")
    docker.add_argument("path")
    docker.add_argument("--reason", required=True)
    docker.add_argument("--body", default="{}", help="JSON object")
    args = parser.parse_args()
    if args.command_name == "status":
        call("/api/octo-admin-session/current/octo")
    elif args.command_name == "exec":
        command = list(args.command)
        if command and command[0] == "--":
            command.pop(0)
        if not command:
            raise SystemExit("exec requires a command after --")
        call("/api/octo-admin-session/exec/octo", {
            "target": args.target, "command": command, "working_dir": args.working_dir,
            "reason": args.reason, "env": [],
        }, stream=True)
    elif args.command_name == "lifecycle":
        call("/api/octo-admin-session/action/octo", {
            "action": args.action, "target": args.target, "reason": args.reason,
        })
    else:
        body = json.loads(args.body)
        if not isinstance(body, dict):
            raise SystemExit("--body must decode to a JSON object")
        call("/api/octo-admin-session/action/octo", {
            "action": "docker_api", "target": args.target, "reason": args.reason,
            "method": "POST", "path": args.path, "body": body,
        })


if __name__ == "__main__":
    main()
