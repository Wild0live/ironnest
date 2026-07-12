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
import base64
import json
import os
import re
import shutil
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
FS_TRANSACTIONS = QUEUE / "filesystem-transactions"
JOBS.mkdir(parents=True, exist_ok=True)
RESULTS.mkdir(exist_ok=True)
FS_TRANSACTIONS.mkdir(exist_ok=True)

REMEDIATION_MARKER = re.compile(
    r"(?im)^\s*#\s*IRONNEST_REMEDIATION_ID:\s*([A-Za-z0-9_.-]+)\s*$"
)
SOFTWARE_REMEDIATION_ID = "software-vulnerability-remediation-v1"
ALLOWED_REMEDIATIONS = {"cis-windows-top5-v1", SOFTWARE_REMEDIATION_ID}
WINGET_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+\-]{1,160}$")
CVE_RE = re.compile(r"^CVE-\d{4}-\d{4,}$", re.IGNORECASE)
ALLOWED_FILESYSTEM_PROFILES = {
    item.strip() for item in os.environ.get(
        "HOST_FILESYSTEM_ALLOWED_PROFILES", "default,littlejohn,octo"
    ).split(",") if item.strip()
}
MAX_READ_BYTES = int(os.environ.get("HOST_FILESYSTEM_MAX_READ_BYTES", str(10 * 1024 * 1024)))
MAX_STAGE_BYTES = int(os.environ.get("HOST_FILESYSTEM_MAX_STAGE_BYTES", str(10 * 1024 * 1024)))
MAX_LIST_ENTRIES = int(os.environ.get("HOST_FILESYSTEM_MAX_LIST_ENTRIES", "2000"))
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
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


def _clean_text(value: Any, limit: int = 500) -> str:
    return str(value or "").strip()[:limit]


def _software_remediation_packages(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ValueError("remediation_payload must be an object")
    packages = payload.get("packages")
    if packages is None:
        packages = [payload]
    if not isinstance(packages, list) or not packages or len(packages) > 10:
        raise ValueError("remediation_payload.packages must contain 1-10 package objects")

    out: list[dict[str, Any]] = []
    for raw in packages:
        if not isinstance(raw, dict):
            raise ValueError("each remediation package must be an object")
        package_id = _clean_text(raw.get("winget_id") or raw.get("package_id"), 180)
        if not WINGET_ID_RE.fullmatch(package_id):
            raise ValueError(f"invalid winget package id: {package_id!r}")
        action = _clean_text(raw.get("action") or "upgrade", 40).lower()
        if action not in {"upgrade", "install", "uninstall"}:
            raise ValueError("software remediation action must be upgrade, install, or uninstall")
        cves_raw = raw.get("cves") or []
        if not isinstance(cves_raw, list) or len(cves_raw) > 50:
            raise ValueError("cves must be a list of at most 50 CVE IDs")
        cves = []
        for cve in cves_raw:
            value = _clean_text(cve, 32).upper()
            if value and not CVE_RE.fullmatch(value):
                raise ValueError(f"invalid CVE ID: {value!r}")
            if value:
                cves.append(value)
        scope = _clean_text(raw.get("scope") or "machine", 20).lower()
        if scope not in {"machine", "user", "any"}:
            raise ValueError("scope must be machine, user, or any")
        out.append({
            "winget_id": package_id,
            "action": action,
            "name": _clean_text(raw.get("name"), 160),
            "publisher": _clean_text(raw.get("publisher"), 160),
            "scope": scope,
            "cves": cves,
            "justification": _clean_text(raw.get("justification"), 1000),
        })
    return out


def _run_winget(args: list[str], timeout: int = 1800) -> dict[str, Any]:
    winget = shutil.which("winget.exe") or shutil.which("winget")
    if not winget:
        raise FileNotFoundError("winget is not available to the scoped remediation runner account")
    result = subprocess.run(
        [winget, *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return {
        "command": "winget " + " ".join(args),
        "exit_code": int(result.returncode),
        "stdout": tail(result.stdout, 6000),
        "stderr": tail(result.stderr, 6000),
    }


def _winget_list(package_id: str) -> dict[str, Any]:
    return _run_winget(["list", "--id", package_id, "--exact",
                        "--accept-source-agreements", "--disable-interactivity"], timeout=300)


def _winget_show(package_id: str) -> dict[str, Any]:
    return _run_winget(["show", "--id", package_id, "--exact",
                        "--accept-source-agreements", "--disable-interactivity"], timeout=300)


def _winget_remediate_package(package: dict[str, Any]) -> dict[str, Any]:
    package_id = package["winget_id"]
    action = package["action"]
    before = _winget_list(package_id)
    show = _winget_show(package_id)

    if action == "upgrade":
        args = ["upgrade", "--id", package_id, "--exact", "--silent",
                "--accept-package-agreements", "--accept-source-agreements",
                "--disable-interactivity"]
    elif action == "install":
        args = ["install", "--id", package_id, "--exact", "--silent",
                "--accept-package-agreements", "--accept-source-agreements",
                "--disable-interactivity"]
        if package.get("scope") in {"machine", "user"}:
            args.extend(["--scope", package["scope"]])
    else:
        args = ["uninstall", "--id", package_id, "--exact", "--silent",
                "--disable-interactivity"]

    action_result = _run_winget(args)
    after = _winget_list(package_id)
    return {
        "package": package,
        "before": before,
        "show": show,
        "action": action_result,
        "after": after,
        "ok": action_result["exit_code"] == 0,
    }


def run_software_vulnerability_remediation(job: dict[str, Any]) -> dict[str, Any]:
    """Generic localhost software-vulnerability remediation.

    This intentionally does not execute submitted PowerShell.  Little John
    supplies structured package data; the local runner executes fixed winget
    command shapes only after Mission Control/FIDO approval.
    """
    if not is_admin():
        raise PermissionError("scoped remediation runner must be elevated")
    payload = job.get("remediation_payload") or {}
    packages = _software_remediation_packages(payload)
    results = []
    for package in packages:
        results.append(_winget_remediate_package(package))
    ok = all(item.get("ok") for item in results)
    lines = [
        "IronNest scoped software vulnerability remediation",
        f"Request: {job.get('request_id', '')}",
        f"Remediation: {SOFTWARE_REMEDIATION_ID}",
        f"Target: {job.get('target', '')}",
        f"Requested by: {job.get('requested_by', '')}",
        f"Package count: {len(results)}",
        "",
    ]
    for item in results:
        package = item["package"]
        lines.append(f"Package: {package['winget_id']} ({package.get('name') or 'unnamed'})")
        lines.append(f"Action: {package['action']}")
        if package.get("cves"):
            lines.append("CVEs: " + ", ".join(package["cves"]))
        if package.get("justification"):
            lines.append("Justification: " + package["justification"])
        lines.append(f"Command: {item['action']['command']}")
        lines.append(f"Exit: {item['action']['exit_code']}")
        if item["action"].get("stdout"):
            lines.append("stdout:")
            lines.append(item["action"]["stdout"])
        if item["action"].get("stderr"):
            lines.append("stderr:")
            lines.append(item["action"]["stderr"])
        lines.append("")
    return {
        "ok": ok,
        "exit_code": 0 if ok else 67,
        "remediation_id": SOFTWARE_REMEDIATION_ID,
        "package_results": results,
        "stdout": tail("\n".join(lines)),
        "stderr": "",
    }


def _request_id(value: str) -> str:
    if not re.fullmatch(r"op-[a-f0-9]{32}", value or ""):
        raise ValueError("invalid request_id")
    return value


def _tx_dir(request_id: str) -> Path:
    return FS_TRANSACTIONS / _request_id(request_id)


def _manifest_path(request_id: str) -> Path:
    return _tx_dir(request_id) / "manifest.json"


def _windows_attrs(path: Path) -> int | None:
    try:
        attrs = ctypes.windll.kernel32.GetFileAttributesW(str(path))
    except OSError:
        return None
    return None if attrs == 0xFFFFFFFF else int(attrs)


def _reject_reparse(path: Path) -> None:
    current = path if path.exists() else path.parent
    seen: list[Path] = []
    while True:
        seen.append(current)
        parent = current.parent
        if parent == current:
            break
        current = parent
    for item in seen:
        attrs = _windows_attrs(item)
        if attrs is not None and attrs & FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError(f"reparse points are not allowed: {item}")


def _reject_reparse_tree(path: Path) -> None:
    _reject_reparse(path)
    if path.is_dir():
        for child in path.rglob("*"):
            _reject_reparse(child)


def _host_path(value: Any, *, must_exist: bool = False) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("path is required")
    if raw.startswith("\\\\") or raw.startswith("//") or raw.startswith("\\\\.\\") or raw.startswith("\\\\?\\"):
        raise ValueError("only local drive-letter paths are allowed")
    if not re.match(r"^[A-Za-z]:[\\/]", raw):
        raise ValueError("only absolute Windows drive-letter paths are allowed")
    if ":" in raw[2:]:
        raise ValueError("alternate data stream paths are not allowed")
    path = Path(raw).resolve(strict=False)
    if must_exist and not path.exists():
        raise FileNotFoundError(str(path))
    _reject_reparse(path)
    return path


def _file_info(path: Path) -> dict[str, Any]:
    st = path.stat()
    return {
        "path": str(path),
        "name": path.name,
        "is_dir": path.is_dir(),
        "size": st.st_size,
        "mtime": int(st.st_mtime),
    }


def _list_path(path: Path, recursive: bool, max_entries: int) -> dict[str, Any]:
    if not path.is_dir():
        return {"path": str(path), "entries": [_file_info(path)], "truncated": False}
    entries: list[dict[str, Any]] = []
    iterator = path.rglob("*") if recursive else path.iterdir()
    for child in iterator:
        _reject_reparse(child)
        entries.append(_file_info(child))
        if len(entries) >= max_entries:
            return {"path": str(path), "entries": entries, "truncated": True}
    return {"path": str(path), "entries": entries, "truncated": False}


def _read_path(path: Path, max_bytes: int) -> dict[str, Any]:
    if not path.is_file():
        raise ValueError(f"read requires a file: {path}")
    size = path.stat().st_size
    if size > max_bytes:
        raise ValueError(f"file exceeds max_bytes ({size} > {max_bytes})")
    data = path.read_bytes()
    return {
        "path": str(path),
        "size": size,
        "content_b64": base64.b64encode(data).decode("ascii"),
    }


def _stage_file(tx_root: Path, index: int, content_b64: str) -> tuple[Path, int]:
    data = base64.b64decode(content_b64.encode("ascii"), validate=True)
    if len(data) > MAX_STAGE_BYTES:
        raise ValueError(f"staged content exceeds {MAX_STAGE_BYTES} bytes")
    stage_dir = tx_root / "stage"
    stage_dir.mkdir(parents=True, exist_ok=True)
    path = stage_dir / f"{index:04d}.bin"
    path.write_bytes(data)
    return path, len(data)


def _prepare_filesystem(job: dict[str, Any], tx: dict[str, Any]) -> dict[str, Any]:
    requester = str(job.get("requested_by") or "").strip()
    profile = str(tx.get("profile") or requester).strip()
    if not requester or profile != requester:
        raise PermissionError("filesystem transaction profile does not match authenticated requester")
    if profile not in ALLOWED_FILESYSTEM_PROFILES:
        raise PermissionError("profile is not allowlisted for host filesystem transactions")
    request_id = _request_id(str(job.get("request_id", "")))
    tx_root = _tx_dir(request_id)
    tx_root.mkdir(parents=True, exist_ok=False)
    planned: list[dict[str, Any]] = []
    evidence: list[dict[str, Any]] = []
    operations = tx.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("prepare requires a non-empty operations list")

    for index, op in enumerate(operations, start=1):
        if not isinstance(op, dict):
            raise ValueError("each filesystem operation must be an object")
        kind = str(op.get("op", "")).strip()
        if kind == "list":
            path = _host_path(op.get("path"), must_exist=True)
            max_entries = min(max(int(op.get("max_entries", MAX_LIST_ENTRIES)), 1), MAX_LIST_ENTRIES)
            evidence.append({"op": "list", "result": _list_path(path, bool(op.get("recursive")), max_entries)})
        elif kind == "read":
            path = _host_path(op.get("path"), must_exist=True)
            max_bytes = min(max(int(op.get("max_bytes", MAX_READ_BYTES)), 1), MAX_READ_BYTES)
            evidence.append({"op": "read", "result": _read_path(path, max_bytes)})
        elif kind == "stage_write":
            target = _host_path(op.get("path"))
            stage_path, size = _stage_file(tx_root, index, str(op.get("content_b64", "")))
            planned.append({
                "op": "write",
                "path": str(target),
                "stage": stage_path.name,
                "size": size,
                "overwrite": bool(op.get("overwrite", False)),
            })
        elif kind == "stage_mkdir":
            planned.append({"op": "mkdir", "path": str(_host_path(op.get("path")))})
        elif kind == "stage_delete":
            planned.append({
                "op": "delete",
                "path": str(_host_path(op.get("path"), must_exist=True)),
                "recursive": bool(op.get("recursive", False)),
            })
        elif kind == "stage_copy":
            planned.append({
                "op": "copy",
                "src": str(_host_path(op.get("src"), must_exist=True)),
                "dst": str(_host_path(op.get("dst"))),
                "overwrite": bool(op.get("overwrite", False)),
            })
        elif kind == "stage_move":
            planned.append({
                "op": "move",
                "src": str(_host_path(op.get("src"), must_exist=True)),
                "dst": str(_host_path(op.get("dst"))),
                "overwrite": bool(op.get("overwrite", False)),
            })
        else:
            raise ValueError(f"unsupported filesystem operation: {kind}")

    manifest = {
        "request_id": request_id,
        "profile": profile,
        "created_at": time.time(),
        "target": job.get("target", ""),
        "planned": planned,
    }
    tmp = _manifest_path(request_id).with_suffix(".tmp")
    tmp.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    os.replace(tmp, _manifest_path(request_id))
    return {
        "ok": True,
        "exit_code": 0,
        "mode": "prepare",
        "transaction_id": request_id,
        "planned_count": len(planned),
        "evidence": evidence,
        "commit_instruction": "Submit a new host_filesystem request with mode=commit and prepare_request_id set to this transaction_id.",
    }


def _write_with_backup(target: Path, source: Path, overwrite: bool) -> dict[str, Any]:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and not overwrite:
        raise FileExistsError(str(target))
    backup = ""
    if target.exists():
        backup_path = target.with_name(f"{target.name}.ironnest-bak-{int(time.time())}")
        if target.is_dir():
            raise IsADirectoryError(str(target))
        shutil.copy2(target, backup_path)
        backup = str(backup_path)
    shutil.copy2(source, target)
    return {"path": str(target), "backup": backup}


def _commit_filesystem(job: dict[str, Any], tx: dict[str, Any]) -> dict[str, Any]:
    requester = str(job.get("requested_by") or "").strip()
    profile = str(tx.get("profile") or requester).strip()
    if not requester or profile != requester:
        raise PermissionError("filesystem transaction profile does not match authenticated requester")
    if profile not in ALLOWED_FILESYSTEM_PROFILES:
        raise PermissionError("profile is not allowlisted for host filesystem transactions")
    prepare_id = _request_id(str(tx.get("prepare_request_id", "")))
    manifest = json.loads(_manifest_path(prepare_id).read_text(encoding="utf-8"))
    if manifest.get("profile") != profile:
        raise PermissionError("commit profile does not match prepared transaction")
    commit_marker = _tx_dir(prepare_id) / "committed.json"
    if commit_marker.exists():
        raise RuntimeError("prepared transaction has already been committed")
    applied: list[dict[str, Any]] = []
    stage_dir = _tx_dir(prepare_id) / "stage"

    for op in manifest.get("planned", []):
        kind = op.get("op")
        if kind == "write":
            target = _host_path(op.get("path"))
            source = stage_dir / str(op.get("stage", ""))
            if not source.is_file():
                raise FileNotFoundError(str(source))
            applied.append({"op": kind, **_write_with_backup(target, source, bool(op.get("overwrite")))})
        elif kind == "mkdir":
            target = _host_path(op.get("path"))
            target.mkdir(parents=True, exist_ok=True)
            applied.append({"op": kind, "path": str(target)})
        elif kind == "delete":
            target = _host_path(op.get("path"), must_exist=True)
            _reject_reparse_tree(target)
            if target.is_dir():
                if not op.get("recursive"):
                    target.rmdir()
                else:
                    shutil.rmtree(target)
            else:
                target.unlink()
            applied.append({"op": kind, "path": str(target)})
        elif kind in {"copy", "move"}:
            src = _host_path(op.get("src"), must_exist=True)
            dst = _host_path(op.get("dst"))
            _reject_reparse_tree(src)
            if dst.exists() and not op.get("overwrite"):
                raise FileExistsError(str(dst))
            dst.parent.mkdir(parents=True, exist_ok=True)
            if kind == "copy":
                if src.is_dir():
                    shutil.copytree(src, dst, dirs_exist_ok=bool(op.get("overwrite")))
                else:
                    shutil.copy2(src, dst)
            else:
                if dst.exists():
                    if dst.is_dir():
                        shutil.rmtree(dst)
                    else:
                        dst.unlink()
                shutil.move(str(src), str(dst))
            applied.append({"op": kind, "src": str(src), "dst": str(dst)})
        else:
            raise ValueError(f"unsupported staged operation: {kind}")

    marker = {"request_id": job.get("request_id"), "prepare_request_id": prepare_id, "committed_at": time.time(), "applied": applied}
    tmp = commit_marker.with_suffix(".tmp")
    tmp.write_text(json.dumps(marker, indent=2), encoding="utf-8")
    os.replace(tmp, commit_marker)
    return {"ok": True, "exit_code": 0, "mode": "commit", "prepare_request_id": prepare_id, "applied": applied}


def run_filesystem_transaction(job: dict[str, Any]) -> dict[str, Any]:
    tx = job.get("filesystem_transaction")
    if not isinstance(tx, dict):
        raise ValueError("filesystem_transaction must be an object")
    mode = str(tx.get("mode", "prepare")).strip().lower()
    if mode == "prepare":
        return _prepare_filesystem(job, tx)
    if mode == "commit":
        return _commit_filesystem(job, tx)
    raise ValueError("filesystem transaction mode must be prepare or commit")


def execute(job: dict[str, Any]) -> dict[str, Any]:
    if job.get("action") == "host_filesystem":
        return run_filesystem_transaction(job)
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
    if rid == SOFTWARE_REMEDIATION_ID:
        return run_software_vulnerability_remediation(job)
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
