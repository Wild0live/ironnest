#!/usr/bin/env python3
"""Execute only built-in, allowlisted Windows host remediations.

This consumes the same Mission Control host-operation queue as queue-runner.py,
but it does not execute the PowerShell submitted by an agent. The submitted
script is treated as the operator-reviewed request text only. A job must carry a
known remediation_id, and this runner executes the local implementation for that
ID.
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import subprocess
import tempfile
import time
import winreg
from pathlib import Path
from typing import Any


QUEUE = Path(os.environ.get("HOST_OPERATIONS_QUEUE", ""))
if not QUEUE:
    raise SystemExit("HOST_OPERATIONS_QUEUE is required")

JOBS = QUEUE / "jobs"
RESULTS = QUEUE / "results"
JOBS.mkdir(parents=True, exist_ok=True)
RESULTS.mkdir(exist_ok=True)

REMEDIATION_MARKER = re.compile(
    r"(?im)^\s*#\s*IRONNEST_REMEDIATION_ID:\s*([A-Za-z0-9_.-]+)\s*$"
)
ALLOWED_REMEDIATIONS = {"cis-windows-top5-v1"}
DWORD_TARGETS = {
    r"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate": {
        "ManagePreviewBuilds": 0,
        "DeferFeatureUpdates": 1,
        "DeferFeatureUpdatesPeriodInDays": 180,
        "DeferQualityUpdates": 1,
        "DeferQualityUpdatesPeriodInDays": 0,
    },
    r"SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU": {
        "NoAutoRebootWithLoggedOnUsers": 0,
    },
}


def tail(value: str, limit: int = 12_000) -> str:
    return value[-limit:] if len(value) > limit else value


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except OSError:
        return False


def remediation_id(job: dict[str, Any]) -> str:
    value = str(job.get("remediation_id", "")).strip()
    if value:
        return value
    match = REMEDIATION_MARKER.search(str(job.get("script", "")))
    return match.group(1).strip() if match else ""


def set_dword(path: str, name: str, value: int) -> None:
    with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key, name, 0, winreg.REG_DWORD, int(value))


def get_dword(path: str, name: str) -> int | None:
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_QUERY_VALUE) as key:
            value, value_type = winreg.QueryValueEx(key, name)
    except FileNotFoundError:
        return None
    return int(value) if value_type == winreg.REG_DWORD else None


def export_password_complexity() -> tuple[int | None, str]:
    with tempfile.NamedTemporaryFile(suffix=".cfg", delete=False) as fh:
        cfg_path = fh.name
    try:
        result = subprocess.run(
            ["secedit.exe", "/export", "/cfg", cfg_path],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if result.returncode != 0:
            return None, f"secedit export exit code {result.returncode}"
        try:
            content = Path(cfg_path).read_text(encoding="utf-16")
        except UnicodeError:
            content = Path(cfg_path).read_text(encoding="utf-8", errors="replace")
        for line in content.splitlines():
            if line.strip().lower().startswith("passwordcomplexity"):
                _, _, raw = line.partition("=")
                return int(raw.strip()), "ok"
        return None, "PasswordComplexity not present in secedit export"
    finally:
        try:
            os.unlink(cfg_path)
        except OSError:
            pass


def configure_password_complexity() -> str:
    inf_lines = [
        "[Unicode]",
        "Unicode=yes",
        "[Version]",
        'signature="$CHICAGO$"',
        "Revision=1",
        "[System Access]",
        "PasswordComplexity = 1",
    ]
    with tempfile.NamedTemporaryFile(mode="w", suffix=".inf", encoding="ascii", delete=False) as fh:
        fh.write("\n".join(inf_lines) + "\n")
        inf_path = fh.name
    try:
        db_path = os.path.join(os.environ.get("windir", r"C:\Windows"),
                               r"security\database\cis-password-complexity.sdb")
        result = subprocess.run(
            ["secedit.exe", "/configure", "/db", db_path, "/cfg", inf_path, "/areas", "SECURITYPOLICY"],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"secedit configure exit code {result.returncode}; "
                f"stdout={tail(result.stdout, 2000)!r}; stderr={tail(result.stderr, 2000)!r}"
            )
        return result.stdout.strip()
    finally:
        try:
            os.unlink(inf_path)
        except OSError:
            pass


def run_gpupdate() -> str:
    result = subprocess.run(
        ["gpupdate.exe", "/target:computer", "/force"],
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"gpupdate exit code {result.returncode}; "
            f"stdout={tail(result.stdout, 2000)!r}; stderr={tail(result.stderr, 2000)!r}"
        )
    return result.stdout.strip()


def run_cis_windows_top5(job: dict[str, Any]) -> dict[str, Any]:
    if not is_admin():
        raise PermissionError("scoped remediation runner must be elevated")

    lines = [
        "IronNest scoped remediation runner",
        f"Request: {job.get('request_id', '')}",
        "Remediation: cis-windows-top5-v1",
        f"User: {os.environ.get('USERDOMAIN', '')}\\{os.environ.get('USERNAME', '')}",
        "Admin: True",
        "",
        "Pre-change values:",
    ]
    for path, names in DWORD_TARGETS.items():
        for name in names:
            lines.append(f"{name}: {get_dword(path, name)}")
    before_complexity, before_note = export_password_complexity()
    lines.append(f"PasswordComplexity: {before_complexity} ({before_note})")

    for path, values in DWORD_TARGETS.items():
        for name, value in values.items():
            set_dword(path, name, value)
    secedit_out = configure_password_complexity()
    gpupdate_out = run_gpupdate()

    lines.extend(["", "Post-change values:"])
    for path, names in DWORD_TARGETS.items():
        for name, expected in names.items():
            actual = get_dword(path, name)
            lines.append(f"{name}: {actual}")
            if actual != expected:
                raise RuntimeError(f"{name} expected {expected}, got {actual}")
    after_complexity, after_note = export_password_complexity()
    lines.append(f"PasswordComplexity: {after_complexity} ({after_note})")
    if after_complexity != 1:
        raise RuntimeError(f"PasswordComplexity expected 1, got {after_complexity}")

    if secedit_out:
        lines.extend(["", "secedit:", secedit_out])
    if gpupdate_out:
        lines.extend(["", "gpupdate:", gpupdate_out])
    return {"ok": True, "exit_code": 0, "stdout": tail("\n".join(lines)), "stderr": ""}


def execute(job: dict[str, Any]) -> dict[str, Any]:
    if job.get("action") != "host_powershell":
        return {"ok": False, "exit_code": 64, "error": "unsupported action for scoped runner"}
    rid = remediation_id(job)
    if rid not in ALLOWED_REMEDIATIONS:
        return {
            "ok": False,
            "exit_code": 65,
            "error": "remediation_id is not allowlisted",
            "allowed_remediations": sorted(ALLOWED_REMEDIATIONS),
        }
    if rid == "cis-windows-top5-v1":
        return run_cis_windows_top5(job)
    return {"ok": False, "exit_code": 66, "error": "remediation is declared but not implemented"}


while True:
    for jobfile in sorted(JOBS.glob("op-*.json"), key=lambda p: p.stat().st_mtime):
        resultfile = RESULTS / jobfile.name
        if resultfile.exists():
            continue
        try:
            job = json.loads(jobfile.read_text(encoding="utf-8"))
            result = execute(job)
        except Exception as exc:
            result = {"ok": False, "exit_code": 1, "error": str(exc)}
        result["completed_at"] = time.time()
        tmp = resultfile.with_suffix(".tmp")
        tmp.write_text(json.dumps(result), encoding="utf-8")
        os.replace(tmp, resultfile)
    time.sleep(1)
