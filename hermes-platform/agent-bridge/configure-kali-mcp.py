#!/usr/bin/env python3
"""Idempotently register LittleJohn's Kali MCP server in Hermes config."""
from __future__ import annotations

import os
from pathlib import Path

import yaml

CONFIG = Path(os.environ.get("HERMES_CONFIG", "/opt/data/config.yaml"))
NAME = os.environ.get("KALI_MCP_NAME", "kali-mcp-littlejohn")
URL = os.environ.get("KALI_MCP_URL", "http://kali-mcp-littlejohn:8000/sse")


def main() -> int:
    if not CONFIG.exists():
        print(f"skip: {CONFIG} does not exist")
        return 0
    data = yaml.safe_load(CONFIG.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise SystemExit(f"invalid Hermes config: {CONFIG}")
    servers = data.setdefault("mcp_servers", {})
    if not isinstance(servers, dict):
        raise SystemExit("invalid Hermes config: mcp_servers is not a mapping")
    desired = {"url": URL, "transport": "sse", "enabled": True}
    if servers.get(NAME) == desired:
        print(f"ok: {NAME} already configured")
        return 0
    servers[NAME] = desired
    tmp = CONFIG.with_suffix(CONFIG.suffix + ".tmp")
    tmp.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    os.replace(tmp, CONFIG)
    print(f"ok: configured {NAME} -> {URL}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
