#!/usr/bin/env python3
"""Agent chat bridge — runs INSIDE each hermes-pf-* container.

A tiny stdlib HTTP listener that lets Mission Control chat with THIS profile's
agent. It keeps a PERSISTENT, warm `hermes acp` process (Agent Client Protocol,
JSON-RPC over stdio) so turns avoid the ~18s cold-start: only the first turn
pays init; subsequent turns are ~2-5s.

Lifecycle / resource design (deliberate):
  * No external deps — Python stdlib only.
  * Runs as the `hermes` user (CMD already dropped privs), so turns share this
    profile's data/auth/memory.
  * The ACP process is spawned LAZILY on first chat and idle-timed-out, so idle
    profiles don't carry a second hermes process (container cap is modest).
  * One ACP session per profile, separate from the live Telegram session
    (`hermes gateway run`) — no cross-contamination.
  * Turns are serialized (one prompt at a time per profile); a second concurrent
    request gets 429.
  * If ACP init/turn fails, falls back to a cold one-shot `hermes -z` so chat
    still works (slow) rather than erroring out.
  * Optional shared-secret auth (MISSION_CONTROL_BRIDGE_TOKEN).
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import mimetypes
import os
import queue
import re
import shutil
import signal
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

PROFILE = os.environ.get("HERMES_PROFILE", "default")
PORT = int(os.environ.get("AGENT_BRIDGE_PORT", "8011"))
TOKEN = os.environ.get("MISSION_CONTROL_BRIDGE_TOKEN", "").strip()
HERMES_BIN = os.environ.get("HERMES_BIN", "/opt/hermes/.venv/bin/hermes")
# The bridge runs under the system python (no hermes_cli on its path), so the
# /models picker shells out to the hermes venv interpreter that ships the
# canonical model catalog. Defaults next to HERMES_BIN.
VENV_PY = os.environ.get(
    "AGENT_BRIDGE_VENV_PY", os.path.join(os.path.dirname(HERMES_BIN), "python"))
MODELS_TTL = int(os.environ.get("AGENT_BRIDGE_MODELS_TTL", "60"))  # seconds
PROMPT_TIMEOUT = int(os.environ.get("AGENT_BRIDGE_TIMEOUT", "240"))
INIT_TIMEOUT = int(os.environ.get("AGENT_BRIDGE_INIT_TIMEOUT", "150"))
IDLE_TIMEOUT = int(os.environ.get("AGENT_BRIDGE_IDLE_TIMEOUT", "900"))
UPLOAD_DIR = os.environ.get("AGENT_BRIDGE_UPLOAD_DIR", "/opt/data/.mission-control-uploads")
CWD = os.environ.get("AGENT_BRIDGE_CWD", "/opt/data")
SOUL_PATH = os.environ.get("AGENT_BRIDGE_SOUL_FILE", os.path.join(CWD, "SOUL.md"))
CONFIG_FILE = os.environ.get("AGENT_BRIDGE_CONFIG_FILE", os.path.join(CWD, "config.yaml"))
STATE_DB = os.environ.get("AGENT_BRIDGE_STATE_DB", os.path.join(CWD, "state.db"))
CRON_FILE = os.environ.get("AGENT_BRIDGE_CRON_FILE", os.path.join(CWD, "cron", "jobs.json"))
USAGE_WINDOW_DAYS = int(os.environ.get("AGENT_BRIDGE_USAGE_DAYS", "30"))
ROLE_CACHE_FILE = os.path.join(CWD, ".mc-role-summary.json")
# `hermes config set` key for this profile's model name. Verified against the
# live CLI: model name lives at model.default (model.provider sits alongside).
MODEL_KEY = os.environ.get("AGENT_BRIDGE_MODEL_KEY", "model.default")
MAX_BODY = 25 * 1024 * 1024
MAX_SOUL = 200 * 1024  # 200 KB cap on SOUL.md writes

# ── Kanban artifacts + Wiki publish (Layer 2/3) ─────────────────────────────
# Workers write durable deliverables to $HERMES_KANBAN_HOME/artifacts/<task_id>/
# on the shared `kanban-shared` volume. The board gateway reads any task's
# artifacts from there (same as worker logs). Wiki publish is wired only on the
# gateway that mounts the wiki secret file; other profiles return a graceful
# "not configured" so the token surface stays minimal.
KANBAN_HOME = os.environ.get("HERMES_KANBAN_HOME", "/opt/kanban")
ARTIFACTS_DIR = os.path.join(KANBAN_HOME, "artifacts")
REPORTS_ROOT = os.environ.get("MISSION_CONTROL_REPORTS_ROOT", "").strip()
WIKI_SERVICE_URL = os.environ.get("WIKI_SERVICE_URL", "http://wiki-service:8787").rstrip("/")
WIKI_SECRETS_FILE = os.environ.get("WIKI_SECRETS_FILE", "/run/llm-wiki-secrets/wiki-service.env")
WIKI_PUBLIC_URL = os.environ.get("WIKI_PUBLIC_URL", "https://wiki.ironnest.local").rstrip("/")
WIKI_SOURCE = os.environ.get("WIKI_PUBLISH_SOURCE", "mission-control")
MAX_PUBLISH_WIKI_BYTES = 25 * 1024 * 1024

# Prompt the agent answers to describe its own primary role for the dashboard card.
ROLE_PROMPT = (
    "Based ONLY on your persona / SOUL (not this conversation, your memory, or any tools), "
    "describe your PRIMARY role and purpose in ONE concise sentence of at most 20 words, "
    "written in the third person. Do not use any tools. Output only the sentence, no preamble or quotes."
)

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]")
_TID_RE = re.compile(r"^t_[0-9a-f]+$")  # kanban task id shape, for artifact paths
_MODEL_VALUE = re.compile(r"[^A-Za-z0-9._:\-/]")
_PROVIDER_VALUE = re.compile(r"[^A-Za-z0-9._-]")
_BUSY = threading.Lock()  # one turn at a time per profile (handler level)
_ROLE_LOCK = threading.Lock()       # guards the in-flight flag below
_role_inflight = {"running": False}  # at most one role-summary generation at a time


def _read_soul() -> str:
    try:
        with open(SOUL_PATH, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def _write_soul(text: str) -> None:
    tmp = SOUL_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, SOUL_PATH)  # atomic; runs as the hermes user so ownership is correct


def _soul_summary(text: str, limit: int = 160) -> str:
    """First real paragraph of SOUL.md, for the Mission Control card. Skips blank
    lines, markdown headings, horizontal rules, HTML comments, blockquotes and
    fences, then joins the first paragraph and truncates to `limit` chars."""
    para: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not para and (not line or line.startswith(("#", "---", "<!--", ">", "```", "==="))):
            continue
        if para and not line:
            break
        para.append(line)
    summary = " ".join(para).strip()
    if len(summary) > limit:
        summary = summary[:limit].rstrip() + "…"
    return summary


# ── Role summary: an LLM-synthesised one-liner of the agent's role ──────────
# Generated by asking the agent itself, then cached keyed on a SOUL.md hash so
# it's produced once per SOUL change (an LLM turn is far too slow per render).
def _soul_sha(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()[:16]


def _read_role_cache() -> dict:
    try:
        with open(ROLE_CACHE_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_role_cache(sha: str, summary: str) -> None:
    tmp = ROLE_CACHE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"sha": sha, "summary": summary, "ts": time.time()}, fh)
    os.replace(tmp, ROLE_CACHE_FILE)


def _clean_role_line(text: str, limit: int = 200) -> str:
    line = " ".join((text or "").split()).strip().strip('"').strip("'").strip()
    if line.lower() in ("", "(empty reply)"):
        return ""
    if len(line) > limit:
        line = line[:limit].rsplit(" ", 1)[0].rstrip(".,;:!-– ") + "…"  # break on a word boundary
    return line


def _generate_role_summary(soul_text: str) -> None:
    """Ask the agent to one-line its role and cache it. Runs in a daemon thread
    (never blocks /meta); at most one generation in flight per container."""
    with _ROLE_LOCK:
        if _role_inflight["running"]:
            return
        _role_inflight["running"] = True
    try:
        res = AGENT.prompt("__mc_role", ROLE_PROMPT, [])
        summary = _clean_role_line(res.get("reply", "")) if res.get("ok") else ""
        if summary:
            _write_role_cache(_soul_sha(soul_text), summary)
    except Exception:  # noqa: BLE001 — best-effort; card falls back to the excerpt
        pass
    finally:
        with _ROLE_LOCK:
            _role_inflight["running"] = False
        AGENT.reset("__mc_role")  # don't let the role-probe session accrete context


def _role_description(soul_text: str) -> tuple[str, str]:
    """(text, kind). 'role' = fresh cached LLM summary; 'role-stale' = last good
    while regenerating after a SOUL edit; 'excerpt' = extractive fallback while
    the first summary generates in the background."""
    sha = _soul_sha(soul_text)
    cache = _read_role_cache()
    cached = cache.get("summary") or ""
    if cached and cache.get("sha") == sha:
        return cached, "role"
    threading.Thread(target=_generate_role_summary, args=(soul_text,), daemon=True).start()
    if cached:
        return cached, "role-stale"
    return _soul_summary(soul_text), "excerpt"


# ── Capabilities + bio for the Mission Control Team directory ────────────────
# Tools/skills are parsed from the canonical `hermes tools list` / `hermes skills
# list` (which resolve toolset aliases and report each skill's source), cached
# briefly. The bridge runs under system python, so we shell the hermes CLI rather
# than import hermes_cli; COLUMNS is forced wide so the skills table never
# truncates names, and ANSI colour is stripped.
CAPS_TTL = int(os.environ.get("AGENT_BRIDGE_CAPS_TTL", "300"))
_caps_cache: dict = {"data": None, "at": 0.0}
_caps_lock = threading.Lock()
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
_ROLE_TITLE_RE = re.compile(r"Harddy[’']s\s+(.+?)\s+AI\s+Agent", re.IGNORECASE)


def _run_hermes(args: list[str], timeout: int = 20) -> str:
    try:
        out = subprocess.run([HERMES_BIN, *args], capture_output=True, text=True,
                             timeout=timeout,
                             env={**os.environ, "COLUMNS": "200", "NO_COLOR": "1"})
    except Exception:  # noqa: BLE001 — degrade to empty; /meta still returns model+bio
        return ""
    return _ANSI_RE.sub("", out.stdout or "")


def _parse_tools(text: str) -> dict:
    """Enabled built-in toolsets + MCP servers from `hermes tools list` (cli)."""
    toolsets: list[str] = []
    mcp: list[str] = []
    section = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        if low.startswith("built-in toolset"):
            section = "tools"
            continue
        if low.startswith("mcp server"):
            section = "mcp"
            continue
        if section == "tools":
            parts = line.split()
            if "enabled" in parts:                # the ✓ enabled rows; ✗ disabled skip
                i = parts.index("enabled")
                if i + 1 < len(parts):
                    toolsets.append(parts[i + 1])
        elif section == "mcp":
            name = line.split()[0]
            if name and name[0].isalnum():        # skip "(none)" / decorative lines
                mcp.append(name)
    return {"toolsets": toolsets, "mcp": mcp}


def _parse_skills(text: str) -> dict:
    """Enabled skills from `hermes skills list`, grouped by category. We do NOT
    flag 'specialist' here — source 'local' only means installed-from-a-tap, not
    role-specific. Mission Control flags specialists by cross-agent rarity (a
    skill few agents carry), since only it sees the whole roster."""
    by_cat: dict[str, list[str]] = {}
    count = 0
    for raw in text.splitlines():
        if "│" not in raw:
            continue
        cols = [c.strip() for c in raw.split("│") if c.strip()]
        if len(cols) < 3:
            continue
        name, category, status = cols[0], cols[1], cols[-1].lower()
        if name.lower() in ("skill", "name", "skills") or not re.search(r"[a-z0-9]", name.lower()):
            continue                              # header / separator row
        if "enabled" not in status:               # disabled rows
            continue
        count += 1
        by_cat.setdefault(category, []).append(name)
    return {"count": count, "by_category": by_cat}


def _capabilities() -> dict:
    now = time.monotonic()
    with _caps_lock:
        cached = _caps_cache["data"]
        if cached is not None and (now - _caps_cache["at"]) < CAPS_TTL:
            return cached
    data = {"tools": _parse_tools(_run_hermes(["tools", "list"])),
            "skills": _parse_skills(_run_hermes(["skills", "list"]))}
    with _caps_lock:
        _caps_cache["data"] = data
        _caps_cache["at"] = time.monotonic()
    return data


def _role_title(soul_text: str) -> str:
    """Short role label from the SOUL self-intro, e.g. 'Cybersecurity' from
    'Harddy's Cybersecurity AI Agent assistant'."""
    m = _ROLE_TITLE_RE.search(soul_text or "")
    if not m:
        return ""
    title = " ".join(m.group(1).split())
    return title if 0 < len(title) <= 40 else ""


def _soul_bio(text: str, limit: int = 300) -> str:
    """Fuller (≈2-sentence) description for the Team directory: the first one or
    two real paragraphs of SOUL.md, skipping headings, HTML-comment blocks,
    fences and blockquotes, with markdown emphasis stripped."""
    paras: list[str] = []
    cur: list[str] = []
    in_comment = False
    for raw in (text or "").splitlines():
        line = raw.strip()
        if in_comment:
            if "-->" in line:
                in_comment = False
            continue
        if "<!--" in line:
            in_comment = "-->" not in line
            continue
        if line.startswith(("#", "---", "===", "```", ">")):
            if cur:
                paras.append(" ".join(cur))
                cur = []
            continue
        if not line:
            if cur:
                paras.append(" ".join(cur))
                cur = []
            if len(paras) >= 2:
                break
            continue
        cur.append(line)
    if cur and len(paras) < 2:
        paras.append(" ".join(cur))
    bio = " ".join(paras[:2]).replace("**", "").replace("__", "").strip()
    if len(bio) > limit:
        bio = bio[:limit].rsplit(" ", 1)[0].rstrip(".,;:!-– ") + "…"
    return bio


def _read_usage() -> dict:
    """Aggregate THIS profile's token usage from its own state.db `sessions`
    table (the same store the Hermes dashboard reads), over the last
    USAGE_WINDOW_DAYS. Read-only (WAL-safe). Verified to match the dashboard
    totals exactly. Returns zeros on any error so one bad agent never breaks the
    platform aggregate."""
    out = {"input": 0, "output": 0, "sessions": 0, "api_calls": 0, "daily": []}
    cutoff = time.time() - USAGE_WINDOW_DAYS * 86400
    try:
        con = sqlite3.connect(f"file:{STATE_DB}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return out
    try:
        cur = con.cursor()
        row = cur.execute(
            "select coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0), "
            "coalesce(sum(api_call_count),0), count(*) from sessions where started_at >= ?",
            (cutoff,)).fetchone()
        out["input"], out["output"], out["api_calls"], out["sessions"] = (
            int(row[0]), int(row[1]), int(row[2]), int(row[3]))
        daily = cur.execute(
            "select strftime('%Y-%m-%d', started_at, 'unixepoch') d, "
            "coalesce(sum(input_tokens),0), coalesce(sum(output_tokens),0) "
            "from sessions where started_at >= ? group by d order by d", (cutoff,)).fetchall()
        out["daily"] = [{"day": d, "input": int(i), "output": int(o)} for d, i, o in daily]
    except sqlite3.Error:
        pass
    finally:
        con.close()
    return out


def _read_cron_jobs() -> list[dict]:
    """This profile's scheduled cron jobs (Hermes' own scheduler at
    /opt/data/cron/jobs.json), trimmed for the Mission Control calendar. Drops
    the large `prompt` body; keeps the schedule + run metadata the dashboard
    needs. Read-only; returns [] on any error so one bad agent never breaks the
    platform aggregate."""
    try:
        with open(CRON_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return []
    jobs = data.get("jobs") if isinstance(data, dict) else None
    out: list[dict] = []
    for j in jobs or []:
        if not isinstance(j, dict):
            continue
        sched = j.get("schedule") if isinstance(j.get("schedule"), dict) else {}
        repeat = j.get("repeat") if isinstance(j.get("repeat"), dict) else {}
        out.append({
            "id": j.get("id", ""),
            "name": j.get("name", "") or j.get("id", "") or "job",
            "expr": sched.get("expr") or j.get("schedule_display") or "",
            "kind": sched.get("kind", ""),
            "schedule_display": j.get("schedule_display") or sched.get("display") or "",
            "next_run_at": j.get("next_run_at"),
            "last_run_at": j.get("last_run_at"),
            "last_status": j.get("last_status"),
            "enabled": bool(j.get("enabled", False)),
            "state": j.get("state", ""),
            "deliver": j.get("deliver", ""),
            "skill": j.get("skill"),
            "script": j.get("script"),
            "no_agent": bool(j.get("no_agent", False)),
            "repeat": {"times": repeat.get("times"), "completed": repeat.get("completed")},
        })
    return out


def _model_info() -> dict[str, str]:
    """Read model.default + model.provider from config.yaml without a YAML dep
    (the bridge interpreter has no pyyaml, and `hermes config` has no get/list).
    A tolerant line parser for the simple, fixed 2-space `model:` block hermes
    writes. Returns {"model": ..., "provider": ...}; values "" if absent."""
    info = {"model": "", "provider": ""}
    try:
        with open(CONFIG_FILE, encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return info
    in_model = False
    for raw in lines:
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        stripped = raw.strip()
        if indent == 0:                       # a top-level key resets the section
            in_model = stripped == "model:"
            continue
        if in_model and ":" in stripped:
            key, _, val = stripped.partition(":")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key == "default":
                info["model"] = val
            elif key == "provider":
                info["provider"] = val
    return info


def _get_model() -> str:
    return _model_info()["model"]


def _set_model(value: str) -> bool:
    value = _MODEL_VALUE.sub("", value or "").strip()[:120]
    if not value:
        return False
    try:
        out = subprocess.run([HERMES_BIN, "config", "set", MODEL_KEY, value],
                             capture_output=True, text=True, timeout=15)
        return out.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def _set_provider(value: str) -> bool:
    """Persist model.provider via `hermes config set`. Used when the picker
    selects a model that belongs to a different (already-authenticated)
    provider than the current one."""
    value = _PROVIDER_VALUE.sub("", value or "").strip()[:60]
    if not value:
        return False
    try:
        out = subprocess.run([HERMES_BIN, "config", "set", "model.provider", value],
                             capture_output=True, text=True, timeout=15)
        return out.returncode == 0
    except Exception:  # noqa: BLE001
        return False


# Python snippet run by the hermes venv interpreter to dump the same
# provider/model picker payload the Telegram/Discord `/model` command shows:
# only authenticated providers, live-filtered model lists, current selection.
_PICKER_SCRIPT = r"""
import json
try:
    from hermes_cli.config import load_config
    from hermes_cli.model_switch import list_picker_providers
    cfg = load_config()
    mc = cfg.get("model")
    if isinstance(mc, dict):
        cur_model = mc.get("default", "") or ""
        cur_provider = mc.get("provider", "") or ""
        cur_base = mc.get("base_url", "") or ""
    else:
        cur_model = mc or ""
        cur_provider = ""
        cur_base = ""
    provs = list_picker_providers(
        current_provider=cur_provider,
        current_base_url=cur_base,
        current_model=cur_model,
        user_providers=cfg.get("providers") or {},
        custom_providers=cfg.get("custom_providers") or [],
        max_models=50,
    )
    out = {
        "ok": True,
        "current_model": cur_model,
        "current_provider": cur_provider,
        "providers": [
            {
                "slug": p.get("slug"),
                "name": p.get("name"),
                "is_current": bool(p.get("is_current")),
                "total_models": p.get("total_models"),
                "models": list(p.get("models") or []),
            }
            for p in provs
        ],
    }
except Exception as exc:  # noqa: BLE001
    out = {"ok": False, "error": str(exc)}
print(json.dumps(out))
"""

_models_cache = {"data": None, "at": 0.0}
_models_lock = threading.Lock()


def _list_models() -> dict:
    """Return the model picker payload (cached for MODELS_TTL seconds).

    Shells out to the hermes venv python because the bridge runs under the
    system interpreter, which lacks hermes_cli. Network-backed providers
    (e.g. OpenRouter) self-cache and fall back to snapshots internally, so a
    generous timeout is fine; on failure we degrade to the config-only view."""
    now = time.monotonic()
    with _models_lock:
        cached = _models_cache["data"]
        if cached is not None and (now - _models_cache["at"]) < MODELS_TTL:
            return cached
    mi = _model_info()
    fallback = {
        "ok": True, "current_model": mi["model"],
        "current_provider": mi["provider"], "providers": [], "degraded": True,
    }
    try:
        out = subprocess.run([VENV_PY, "-c", _PICKER_SCRIPT],
                             capture_output=True, text=True, timeout=30)
        data = json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout.strip() else {}
        if not data.get("ok"):
            data = fallback
    except Exception:  # noqa: BLE001 — timeout, bad JSON, missing interpreter
        data = fallback
    with _models_lock:
        _models_cache["data"] = data
        _models_cache["at"] = time.monotonic()
    return data


# ── Shared Kanban board proxy (hermes kanban CLI; NOT an agent turn) ─────────
# Mission Control drives the shared board through here. These are pure SQLite
# CLI ops against /opt/kanban — they take NONE of the chat locks and never spawn
# an agent. Args are built as argv lists (never a shell string) from a small
# whitelist of structured actions, so there is no command-injection surface.
KANBAN_STATUS = {"triage", "todo", "ready", "running", "review",
                 "blocked", "scheduled", "done", "archived"}


def _kanban_run(argv: list[str], parse_json: bool = False, timeout: int = 30):
    try:
        out = subprocess.run([HERMES_BIN, "kanban", *argv],
                             capture_output=True, text=True, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        return 502, {"ok": False, "error": f"kanban exec failed: {exc}"}
    if out.returncode != 0:
        return 400, {"ok": False, "error": (out.stderr or out.stdout or "kanban error").strip()[-800:]}
    if parse_json:
        try:
            return 200, {"ok": True, "data": json.loads(out.stdout or "null")}
        except json.JSONDecodeError:
            return 200, {"ok": True, "raw": (out.stdout or "").strip()}
    return 200, {"ok": True, "raw": (out.stdout or "").strip()}


def _artifacts_dir(tid: str) -> str:
    """Durable per-task artifact directory on the SHARED kanban volume. Unlike a
    scratch workspace it survives completion, and being on /opt/kanban it's
    readable by every agent's bridge + Mission Control (via the board gateway).
    Layer 1 of the outputs feature: workers write deliverables here so they stop
    evaporating after the run."""
    return os.path.join(os.environ.get("HERMES_KANBAN_HOME", "/opt/kanban"),
                        "artifacts", _SAFE_NAME.sub("_", tid))


def _hidden_marker(tid: str) -> str:
    """Path to a task's soft-delete marker. Its mere presence hides the report
    from the Reports view; deleting it restores the report. Files are never
    touched, so a hide is fully reversible."""
    return os.path.join(_artifacts_dir(tid), ".hidden")


def _is_hidden(task_dir: str) -> bool:
    return os.path.exists(os.path.join(task_dir, ".hidden"))


def _kanban_run_worker(tid: str):
    """Phase 2a manual run: claim THIS profile's ready task and spawn a detached
    kanban worker in THIS container (correct secrets/identity/isolation).

    Mirrors the dispatcher's _default_spawn minimally: the worker is a normal
    `hermes chat -q` turn made into a self-completing kanban worker by the
    HERMES_KANBAN_TASK env var (verified: the agent calls kanban_complete on its
    own). Guarded so a container only ever runs ITS OWN profile's tasks."""
    code, info = _kanban_run(["show", tid, "--json"], parse_json=True)
    if code != 200 or not info.get("ok"):
        return 404, {"ok": False, "error": "task not found"}
    task = (info.get("data") or {}).get("task") or {}
    assignee = str(task.get("assignee") or "")
    status_ = str(task.get("status") or "")
    if assignee.lower() != PROFILE.lower():
        return 409, {"ok": False, "error": f"task assigned to '{assignee}', not this agent ('{PROFILE}')"}
    if status_ != "ready":
        return 409, {"ok": False, "error": f"task is '{status_}'; only 'ready' tasks can be run"}
    # Atomic claim (ready -> running). If someone else grabbed it, claim fails.
    code, _c = _kanban_run(["claim", tid])
    if code != 200:
        return 409, {"ok": False, "error": "could not claim (already claimed?)"}
    code, info2 = _kanban_run(["show", tid, "--json"], parse_json=True)
    ws = (((info2.get("data") or {}).get("task") or {}).get("workspace_path")) or CWD
    # Layer 1: a durable artifact dir on the shared volume. We cd the worker here
    # AND tell it (in the prompt) to save deliverables here, so files persist and
    # are viewable in Mission Control instead of vanishing with a scratch dir.
    art = _artifacts_dir(tid)
    try:
        os.makedirs(art, exist_ok=True)
    except OSError:
        art = ws
    env = dict(os.environ)
    env["HERMES_KANBAN_TASK"] = tid
    env["HERMES_KANBAN_WORKSPACE"] = ws
    env["HERMES_KANBAN_ARTIFACTS"] = art
    run_cwd = art if os.path.isdir(art) else (ws if os.path.isdir(ws) else None)
    prompt = (f"work kanban task {tid}. Save every deliverable file you produce "
              f"(reports, data, etc.) into the directory {art} so it persists and "
              f"is viewable in Mission Control. If you build a web application or "
              f"site, put it in ITS OWN subfolder of that directory with an "
              f"index.html entry point (e.g. {art}/<app-name>/index.html) — each "
              f"app in a separate folder; it then becomes runnable from the "
              f"Mission Control Apps view.")
    log_dir = os.path.join(os.environ.get("HERMES_KANBAN_HOME", "/opt/kanban"), "logs")
    try:
        os.makedirs(log_dir, exist_ok=True)
    except OSError:
        log_dir = "/tmp"
    try:
        logf = open(os.path.join(log_dir, f"mc-run-{_SAFE_NAME.sub('_', tid)}.log"), "ab")
        proc = subprocess.Popen(  # detached, fire-and-forget; worker self-completes
            [HERMES_BIN, "chat", "-q", prompt],
            cwd=run_cwd,
            stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT,
            env=env, start_new_session=True)
    except Exception as exc:  # noqa: BLE001
        return 502, {"ok": False, "error": f"worker spawn failed: {exc}"}
    with _AUTOD_LOCK:
        _worker_procs[tid] = proc  # tracked so the tick can detect a crash
    return 200, {"ok": True, "profile": PROFILE, "task": tid, "pid": proc.pid, "status": "running"}


def _killpg(pid: int) -> bool:
    """SIGTERM a worker's process group, escalating to SIGKILL if it lingers.
    Workers spawn with start_new_session=True so each is its own group leader —
    killing the group takes down the `hermes chat` turn and any children it
    spawned. Returns True if we signalled a live group, False if it was already
    gone (or we lacked permission to see it)."""
    try:
        pgid = os.getpgid(pid)
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return False
    for _ in range(15):                              # ~1.5s grace before hard-kill
        time.sleep(0.1)
        try:
            os.killpg(pgid, 0)                       # probe: raises when gone
        except ProcessLookupError:
            return True
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return True


def _pids_for_task(tid: str) -> list[int]:
    """PIDs in THIS container whose environment carries HERMES_KANBAN_TASK=<tid>.
    Fallback for when we no longer hold the Popen (e.g. the bridge restarted
    since the worker was spawned, so _worker_procs is empty). /proc environ is
    NUL-delimited, so we match the value plus its NUL terminator to avoid a
    prefix collision between sibling task ids."""
    needle = b"HERMES_KANBAN_TASK=" + tid.encode() + b"\x00"
    found: list[int] = []
    try:
        entries = os.listdir("/proc")
    except OSError:
        return found
    for ent in entries:
        if not ent.isdigit():
            continue
        try:
            with open(f"/proc/{ent}/environ", "rb") as fh:
                if needle in fh.read():
                    found.append(int(ent))
        except (OSError, ValueError):
            continue
    return found


def _kanban_stop_worker(tid: str):
    """Stop a manual/auto worker running in THIS container for task `tid`, then
    block the task so the board reflects that it was cancelled. Robust across
    bridge restarts: prefer the tracked Popen, fall back to scanning /proc for
    the child carrying HERMES_KANBAN_TASK=<tid>. Idempotent-ish — if no live
    worker is found we still block the task so it doesn't sit 'running' forever."""
    killed = False
    with _AUTOD_LOCK:
        proc = _worker_procs.get(tid)
    if proc is not None and proc.poll() is None:
        killed = _killpg(proc.pid)
    if not killed:                                   # not tracked (or already dead) — scan
        for pid in _pids_for_task(tid):
            if _killpg(pid):
                killed = True
    with _AUTOD_LOCK:
        _worker_procs.pop(tid, None)
    _task_fails.pop(tid, None)
    # Reflect the cancellation on the shared board. `block` mirrors what the
    # crash-reaper does for a dead-but-still-'running' task; ignore its result so
    # a benign state error never masks a successful kill.
    _kanban_run(["block", tid, "stopped via Mission Control"])
    if not killed:
        return 200, {"ok": True, "task": tid, "killed": False, "status": "blocked",
                     "note": "no live worker found in this container; task blocked"}
    return 200, {"ok": True, "task": tid, "killed": True, "status": "blocked"}


# ── Phase 2b: per-agent auto-dispatch (opt-in, scoped to THIS profile) ───────
# A tiny scoped dispatcher in the bridge: every tick, if enabled, claim+run this
# profile's own ready tasks up to a concurrency cap. Scoping is the built-in
# `list --mine` ($HERMES_PROFILE) — NO cross-claim, no monkeypatch. Off by
# default and persisted per-profile, so deploying this is inert until toggled
# (and a sensitive agent like `mark` simply stays off = human approval gate).
AUTOD_FILE = os.path.join(CWD, ".mc-autodispatch.json")
AUTOD_INTERVAL = int(os.environ.get("AGENT_BRIDGE_AUTOD_INTERVAL", "30"))
_AUTOD_LOCK = threading.Lock()
_autod = {"enabled": False, "max": 1}
_worker_procs: dict = {}   # task_id -> Popen (workers we spawned; manual + auto)
_task_fails: dict = {}     # task_id -> consecutive crash count
_task_cooldown: dict = {}  # task_id -> epoch until which not to re-dispatch (rate-limit backoff)

# A worker that died because the LLM provider returned a usage-limit / 429 is NOT
# a real crash — the condition is transient and self-resets at a known time. We
# detect it from the worker's own log tail so such a task is returned to 'ready'
# and held until reset, instead of being permanently 'blocked' (which would force
# a human to clear it).
_RATELIMIT_RE = re.compile(r"usage_limit_reached|HTTP 429|RateLimitError", re.I)
_RESETS_AT_RE = re.compile(r"resets_at['\"]?\s*[:=]\s*(\d{10,})")


def _load_autod() -> None:
    try:
        with open(AUTOD_FILE, encoding="utf-8") as fh:
            d = json.load(fh)
        if isinstance(d, dict):
            with _AUTOD_LOCK:
                _autod["enabled"] = bool(d.get("enabled"))
                _autod["max"] = max(1, min(4, int(d.get("max", 1))))
    except (OSError, json.JSONDecodeError, ValueError, TypeError):
        pass


def _save_autod() -> None:
    try:
        tmp = AUTOD_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_autod, fh)
        os.replace(tmp, AUTOD_FILE)
    except OSError:
        pass


def _worker_ratelimited(tid: str) -> int | None:
    """If a dead worker's log tail shows a provider usage-limit / 429 (transient,
    self-resetting — NOT a real crash), return the epoch the limit resets at (or
    now+15min if the log doesn't carry one). Else None."""
    path = os.path.join(os.environ.get("HERMES_KANBAN_HOME", "/opt/kanban"),
                        "logs", f"mc-run-{_SAFE_NAME.sub('_', tid)}.log")
    try:
        with open(path, "rb") as fh:
            try:
                fh.seek(-4096, os.SEEK_END)
            except OSError:
                fh.seek(0)
            tail = fh.read().decode("utf-8", "replace")
    except OSError:
        return None
    if not _RATELIMIT_RE.search(tail):
        return None
    m = _RESETS_AT_RE.search(tail)
    return int(m.group(1)) if m else int(time.time()) + 900


def _autodispatch_tick() -> None:
    """One scoped tick. Always reaps/reclaims crashed workers (manual + auto);
    only claims+spawns new work when enabled and under the concurrency cap."""
    # 1. Reap finished/crashed workers we spawned (poll() reaps zombies).
    code, info = _kanban_run(["list", "--mine", "--status", "running", "--json"], parse_json=True)
    running = (info.get("data") or []) if code == 200 else []
    running_ids = {t.get("id") for t in running}
    with _AUTOD_LOCK:
        tracked = list(_worker_procs.items())
    for tid, proc in tracked:
        done = proc.poll() is not None
        if tid not in running_ids:                 # task left 'running' (completed/blocked)
            with _AUTOD_LOCK:
                _worker_procs.pop(tid, None)
            _task_fails.pop(tid, None)
        elif done:                                  # pid gone but task still 'running' = crash
            with _AUTOD_LOCK:
                _worker_procs.pop(tid, None)
            reset_at = _worker_ratelimited(tid)
            if reset_at is not None:
                # Provider usage-limit / 429: transient and self-resetting. Don't
                # count it as a crash or block — return the task to 'ready' and
                # hold off re-dispatch until the limit resets, so it auto-resumes.
                _task_fails.pop(tid, None)
                _task_cooldown[tid] = reset_at
                _kanban_run(["reclaim", tid])
                continue
            fails = _task_fails.get(tid, 0) + 1
            _task_fails[tid] = fails
            if fails >= 2:
                _kanban_run(["block", tid, "auto-dispatch: worker crashed repeatedly"])
                _task_fails.pop(tid, None)
            else:
                _kanban_run(["reclaim", tid])       # one retry (back to ready)
    # 2. Distributed dependency-promotion (always, even when auto-dispatch is
    #    off — it's board hygiene, just a todo->ready status change, no execution):
    #    promote OUR todo tasks whose parents are done. `promote` without --force
    #    only succeeds when parent deps are satisfied, so this is a safe no-op
    #    otherwise. This is what lets cross-profile swarms flow on the shared
    #    board without the native dispatcher's recompute_ready.
    code, info = _kanban_run(["list", "--mine", "--status", "todo", "--json"], parse_json=True)
    for t in ((info.get("data") or []) if code == 200 else []):
        if t.get("id"):
            _kanban_run(["promote", t["id"]])       # ignore result (errs if parents unmet)
    # 3. Spawn new work only if enabled and under cap.
    with _AUTOD_LOCK:
        enabled, cap = _autod["enabled"], _autod["max"]
    if not enabled:
        return
    running_count = len(running_ids)
    if running_count >= cap:
        return
    code, info = _kanban_run(["list", "--mine", "--status", "ready", "--json"], parse_json=True)
    ready = (info.get("data") or []) if code == 200 else []
    now = int(time.time())
    for t in ready:                                 # list is priority-sorted
        if running_count >= cap:
            break
        tid = t.get("id")
        if not tid or tid in _worker_procs:
            continue
        cooldown = _task_cooldown.get(tid)
        if cooldown is not None:
            if cooldown > now:                      # still rate-limited — leave in 'ready', don't spawn
                continue
            _task_cooldown.pop(tid, None)           # reset elapsed; allow re-dispatch
        code, res = _kanban_run_worker(tid)         # claims (atomic) + spawns
        if code == 200 and res.get("ok"):
            running_count += 1


def _autodispatch_loop() -> None:
    _load_autod()
    while True:
        time.sleep(AUTOD_INTERVAL)
        try:
            _autodispatch_tick()
        except Exception:  # noqa: BLE001 — never let the loop die
            pass


# ── Kanban artifacts: aggregate + Wiki publish (pure FS, no agent turn) ──────
# Per-task listing + byte serving live with the dependency's `_artifacts_dir`,
# `artifacts` action and `_serve_artifact` above. These add the library-wide
# scan (Reports view) and the wiki publish path on top of the same store.
def _list_artifact_files(task_dir: str) -> list[dict]:
    """Metadata for every regular file directly under a task's artifact dir."""
    out: list[dict] = []
    try:
        entries = sorted(os.scandir(task_dir), key=lambda e: e.name)
    except OSError:
        return out
    for e in entries:
        try:
            if not e.is_file():
                continue
            # Skip control dotfiles (e.g. the `.hidden` soft-delete marker) — they
            # are bookkeeping, not deliverables, and must never surface as a report
            # file or get served/zipped.
            if e.name.startswith("."):
                continue
            st = e.stat()
        except OSError:
            continue
        out.append({
            "name": e.name,
            "size": st.st_size,
            "mime": mimetypes.guess_type(e.name)[0] or "application/octet-stream",
            "mtime": int(st.st_mtime),
        })
    return out


def _resolve_artifact(task_id: str, name: str) -> str | None:
    """Resolve <artifacts>/<task_id>/<name> with traversal hardening (task-id
    shape, basename, restricted charset, realpath prefix check). Shares the
    dependency's `_artifacts_dir`. Returns the path or None."""
    if not _TID_RE.match(task_id or ""):
        return None
    base = _artifacts_dir(task_id)
    bn = os.path.basename(unquote(name or ""))
    if not bn or bn in (".", "..") or _SAFE_NAME.search(bn):
        return None
    base_real = os.path.realpath(base)
    full = os.path.realpath(os.path.join(base_real, bn))
    if os.path.commonpath([full, base_real]) != base_real or not os.path.isfile(full):
        return None
    return full


# ── Recursive artifact trees + static-webapp detection ───────────────────────
# A "report" is a flat bundle of files; a complete deliverable (e.g. a webapp) is
# a DIRECTORY TREE. These helpers walk a task's artifact dir recursively so nested
# files are visible/servable, and flag any folder that contains an index.html as a
# runnable static app (served live from the sandboxed apps origin by nginx).
#
# Dependency / VCS / build-cache dirs a worker may create in its artifact dir
# (e.g. `npm install` drops node_modules full of bundled index.html files — like
# playwright's vite dashboard/recorder/traceViewer UIs). They are regenerable
# cruft, NOT deliverables, so they're pruned from the walk: this keeps the Apps
# view to REAL apps and keeps trees/zips from ballooning.
_PRUNE_DIRS = {
    "node_modules", ".git", ".svn", ".hg", "__pycache__", ".venv", "venv",
    ".cache", ".npm", ".pnpm-store", ".yarn", "bower_components",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".idea", ".vscode",
}


def _safe_rel_parts(rel: str) -> list[str] | None:
    """Split a client-supplied relative path into safe segments, or None if any
    segment is empty/'.'/'..'/dotfile/charset-violating. Used so nested artifact
    paths can be served WITHOUT opening a traversal hole."""
    parts = [p for p in unquote(rel or "").strip().strip("/").split("/") if p != ""]
    if not parts:
        return None
    for seg in parts:
        if seg in (".", "..") or seg.startswith(".") or _SAFE_NAME.search(seg):
            return None
    return parts


def _resolve_artifact_rel(task_id: str, rel: str) -> str | None:
    """Like `_resolve_artifact` but for a NESTED relative path (may contain '/').
    Same defences (task-id shape, per-segment charset, no dotfiles, realpath
    prefix), so subdirectories are reachable but traversal is not."""
    if not _TID_RE.match(task_id or ""):
        return None
    parts = _safe_rel_parts(rel)
    if not parts:
        return None
    base_real = os.path.realpath(_artifacts_dir(task_id))
    full = os.path.realpath(os.path.join(base_real, *parts))
    if os.path.commonpath([full, base_real]) != base_real or not os.path.isfile(full):
        return None
    return full


def _artifact_tree(task_id: str) -> tuple[list[dict], list[str]]:
    """Walk a task's artifact dir recursively. Returns (files, apps):
      files = [{path, size, mime, mtime}] with POSIX relative paths (dotfiles,
              dot-dirs, and _PRUNE_DIRS dependency/cache dirs are skipped);
      apps  = relative dirs that contain an index.html ('' = the task root itself).
    If the task root is itself an app, only [''] is returned (the whole task is one
    app) so a root index.html doesn't also list every nested folder as a sub-app."""
    base_real = os.path.realpath(_artifacts_dir(task_id))
    files: list[dict] = []
    apps: list[str] = []
    for root, dirs, fnames in os.walk(base_real):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in _PRUNE_DIRS)
        rel_root = os.path.relpath(root, base_real)
        rel_root = "" if rel_root == "." else rel_root.replace(os.sep, "/")
        has_index = False
        for fn in sorted(fnames):
            if fn.startswith("."):
                continue
            full = os.path.join(root, fn)
            try:
                st = os.stat(full)
            except OSError:
                continue
            rel = f"{rel_root}/{fn}" if rel_root else fn
            files.append({"path": rel, "size": st.st_size,
                          "mime": mimetypes.guess_type(fn)[0] or "application/octet-stream",
                          "mtime": int(st.st_mtime)})
            if fn.lower() == "index.html":
                has_index = True
        if has_index:
            apps.append(rel_root)
    if "" in apps:
        apps = [""]
    else:
        # Collapse NESTED apps: an app folder is one unit, so don't also list an
        # app nested inside it (e.g. a Next.js `frontend/out/` build dir within a
        # deliverable that already has its own index.html). Keep only the
        # outermost app per branch; sibling apps in parallel folders are kept.
        # (files is unaffected — the full tree is still walked above.)
        kept: list[str] = []
        for a in sorted(apps, key=lambda p: (p.count("/"), p)):  # ancestors first
            if not any(a == k or a.startswith(k + "/") for k in kept):
                kept.append(a)
        apps = kept
    return files, apps


def _read_wiki_token() -> str:
    """Wiki admin token from env (Infisical-injected) or the mounted secret file.
    Read lazily so a re-render of the wiki's secrets-runtime is picked up without
    a bridge restart. Empty string = publishing not wired on this gateway."""
    tok = os.environ.get("WIKI_ADMIN_TOKEN", "").strip()
    if tok:
        return tok
    try:
        with open(WIKI_SECRETS_FILE, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("WIKI_ADMIN_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def _publish_to_wiki(task_id: str, name: str, title: str = ""):
    """Push one task artifact into the LLM Wiki via its token-gated /api/import
    (multipart). The wiki runs the SAME secret-scan/quarantine pipeline and
    returns accepted|quarantined|duplicate. wiki-service is an internal
    platform-net peer, so we bypass the gateway's Squid egress proxy."""
    full = _resolve_artifact(task_id, name)
    if not full:
        return 404, {"ok": False, "error": "artifact not found"}
    try:
        if os.path.getsize(full) > MAX_PUBLISH_WIKI_BYTES:
            return 413, {"ok": False, "error": f"artifact exceeds {MAX_PUBLISH_WIKI_BYTES} bytes"}
        with open(full, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        return 502, {"ok": False, "error": f"read failed: {exc}"}
    token = _read_wiki_token()
    if not token:
        return 501, {"ok": False, "error": "wiki publishing is not configured on this gateway"}
    fname = os.path.basename(full)
    mime = mimetypes.guess_type(fname)[0] or "application/octet-stream"
    # Optional self-describing banner for markdown reports.
    if title and fname.lower().endswith((".md", ".markdown")):
        banner = (f"# {title}\n\n_Published from IronNest Mission Control — "
                  f"Kanban task {task_id}._\n\n").encode("utf-8")
        data = banner + data
    source_ref = f"{_SAFE_NAME.sub('_', task_id)}/{fname}"
    boundary = "----IronNestMC" + hashlib.sha1(os.urandom(16)).hexdigest()[:24]
    parts: list[bytes] = []
    parts.append((f"--{boundary}\r\n"
                  f'Content-Disposition: form-data; name="upload"; filename="{fname}"\r\n'
                  f"Content-Type: {mime}\r\n\r\n").encode("utf-8"))
    parts.append(data)
    parts.append(b"\r\n")
    for field, val in (("source", WIKI_SOURCE), ("source_ref", source_ref)):
        parts.append((f"--{boundary}\r\n"
                      f'Content-Disposition: form-data; name="{field}"\r\n\r\n'
                      f"{val}\r\n").encode("utf-8"))
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    payload = b"".join(parts)
    req = urllib.request.Request(
        f"{WIKI_SERVICE_URL}/api/import", data=payload, method="POST",
        headers={"X-Admin-Token": token,
                 "Content-Type": f"multipart/form-data; boundary={boundary}"})
    # wiki-service sits on platform-net, not behind the egress proxy → no proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=60) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8"))
            msg = detail.get("detail") or detail
        except Exception:  # noqa: BLE001
            msg = f"HTTP {exc.code}"
        code = exc.code if exc.code in (401, 403, 413) else 502
        return code, {"ok": False, "error": f"wiki import failed: {msg}"}
    except Exception as exc:  # noqa: BLE001 — unreachable, timeout, bad JSON
        return 502, {"ok": False, "error": f"wiki unreachable: {exc}"}
    # /api/import stores + transcribes but does NOT touch the FTS index (only
    # source polling reindexes). Nudge a reindex so an accepted report is
    # immediately searchable. Best-effort — poll would catch up otherwise.
    if result.get("status") == "accepted":
        try:
            opener.open(urllib.request.Request(
                f"{WIKI_SERVICE_URL}/api/search/reindex", method="POST",
                headers={"X-Admin-Token": token}), timeout=30).read()
        except Exception:  # noqa: BLE001 — non-fatal
            pass
    return 200, {"ok": True, "status": result.get("status", ""),
                 "ingest_id": result.get("id"),
                 "deduplicated": bool(result.get("deduplicated")),
                 "reason": result.get("reason", ""),
                 "filename": fname, "wiki_url": WIKI_PUBLIC_URL}


# ── Reports / Apps projection (board-gateway only) ──────────────────────────
# A persisted per-task index of artifact-dir contents so the Reports + Apps
# views don't re-scan the whole shared volume on every read. The projection
# tracks only the FS-side facts (file list, hidden flag, dir mtime); task
# metadata (title/assignee/status/etc.) is joined fresh from the kanban DB at
# request time. Refresh is mtime-driven: on every read we stat each task dir;
# entries whose mtime advanced (an agent dropped a new artifact file) are
# rescanned. Mutations that go through THIS bridge (hide/unhide/purge/delete)
# update the projection inline. The file is rewritten atomically via os.replace.
_PROJ_DIR = os.path.join(KANBAN_HOME, ".cache")
_REPORTS_IDX = os.path.join(_PROJ_DIR, "reports.idx.json")
_APPS_IDX = os.path.join(_PROJ_DIR, "apps.idx.json")
_PROJ_LOCK = threading.Lock()
_proj_cache: dict[str, dict] = {"reports": None, "apps": None}


def _proj_load(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and data.get("v") == 1 and isinstance(data.get("tasks"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"v": 1, "rebuilt_at": 0, "tasks": {}}


def _proj_save(path: str, data: dict) -> None:
    try:
        os.makedirs(_PROJ_DIR, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        os.replace(tmp, path)
    except OSError:
        pass


def _scan_task_reports_entry(task_dir: str) -> dict:
    try:
        mtime = int(os.stat(task_dir).st_mtime)
    except OSError:
        mtime = 0
    return {
        "mtime": mtime,
        "hidden": _is_hidden(task_dir),
        "files": _list_artifact_files(task_dir),
    }


def _scan_task_apps_entry(tid: str, task_dir: str) -> dict:
    try:
        mtime = int(os.stat(task_dir).st_mtime)
    except OSError:
        mtime = 0
    files, apps = _artifact_tree(tid)
    out_apps: list[dict] = []
    for ap in apps:
        prefix = (ap + "/") if ap else ""
        sub = [f for f in files if f["path"].startswith(prefix)]
        out_apps.append({
            "app_path": ap,
            "url_path": f"/{tid}/" + (f"{ap}/" if ap else ""),
            "file_count": len(sub),
            "bytes": sum(f["size"] for f in sub),
        })
    return {"mtime": mtime, "hidden": _is_hidden(task_dir), "apps": out_apps}


def _refresh_projections() -> tuple[dict, dict]:
    """Bring both projections current with the on-disk artifact tree. Cheap:
    one stat per task subdir; only changed dirs are rescanned. Returns
    (reports_proj, apps_proj). Caller holds no lock — this acquires _PROJ_LOCK."""
    with _PROJ_LOCK:
        rep = _proj_cache["reports"] or _proj_load(_REPORTS_IDX)
        app = _proj_cache["apps"] or _proj_load(_APPS_IDX)
        try:
            entries = sorted(os.scandir(ARTIFACTS_DIR), key=lambda e: e.name)
        except OSError:
            entries = []
        live: set[str] = set()
        rep_dirty = app_dirty = False
        for e in entries:
            try:
                if not (e.is_dir() and _TID_RE.match(e.name)):
                    continue
            except OSError:
                continue
            tid = e.name
            live.add(tid)
            try:
                mtime = int(os.stat(e.path).st_mtime)
            except OSError:
                continue
            cur_rep = rep["tasks"].get(tid)
            if not cur_rep or cur_rep.get("mtime", -1) != mtime:
                fresh = _scan_task_reports_entry(e.path)
                if fresh["files"]:
                    rep["tasks"][tid] = fresh
                elif tid in rep["tasks"]:
                    rep["tasks"].pop(tid, None)
                rep_dirty = True
            cur_app = app["tasks"].get(tid)
            if not cur_app or cur_app.get("mtime", -1) != mtime:
                fresh_a = _scan_task_apps_entry(tid, e.path)
                if fresh_a["apps"]:
                    app["tasks"][tid] = fresh_a
                elif tid in app["tasks"]:
                    app["tasks"].pop(tid, None)
                app_dirty = True
        # Drop entries whose task dir vanished off disk (e.g. artifacts_purge
        # on a profile other than this gateway, or manual cleanup).
        for tid in list(rep["tasks"]):
            if tid not in live:
                rep["tasks"].pop(tid, None)
                rep_dirty = True
        for tid in list(app["tasks"]):
            if tid not in live:
                app["tasks"].pop(tid, None)
                app_dirty = True
        now = int(time.time())
        if rep_dirty:
            rep["rebuilt_at"] = now
            _proj_save(_REPORTS_IDX, rep)
        if app_dirty:
            app["rebuilt_at"] = now
            _proj_save(_APPS_IDX, app)
        _proj_cache["reports"] = rep
        _proj_cache["apps"] = app
        return rep, app


def _proj_update_task(tid: str, *, drop: bool = False) -> None:
    """Re-derive one task's entry in both projections after a mutation we own.
    `drop=True` removes the entry (used on artifacts_purge)."""
    if not _TID_RE.match(tid or ""):
        return
    task_dir = _artifacts_dir(tid)
    with _PROJ_LOCK:
        rep = _proj_cache["reports"] or _proj_load(_REPORTS_IDX)
        app = _proj_cache["apps"] or _proj_load(_APPS_IDX)
        if drop or not os.path.isdir(task_dir):
            rep["tasks"].pop(tid, None)
            app["tasks"].pop(tid, None)
        else:
            r = _scan_task_reports_entry(task_dir)
            if r["files"]:
                rep["tasks"][tid] = r
            else:
                rep["tasks"].pop(tid, None)
            a = _scan_task_apps_entry(tid, task_dir)
            if a["apps"]:
                app["tasks"][tid] = a
            else:
                app["tasks"].pop(tid, None)
        now = int(time.time())
        rep["rebuilt_at"] = now
        app["rebuilt_at"] = now
        _proj_save(_REPORTS_IDX, rep)
        _proj_save(_APPS_IDX, app)
        _proj_cache["reports"] = rep
        _proj_cache["apps"] = app


def _task_updated_ts(t: dict) -> int:
    """Best-available 'last touched' epoch for a board task (mirrors the same
    helper in mission-control)."""
    for k in ("completed_at", "started_at", "updated_at", "created_at"):
        v = t.get(k)
        if v:
            try:
                return int(v)
            except (TypeError, ValueError):
                pass
    return 0


def _report_slug(value: str, fallback: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return value[:72].strip("-") or fallback


def _publish_report_packages(reports: list[dict]) -> None:
    """Publish the Reports sidebar projection to its canonical host-backed root.

    This runs only on the board gateway, which is the single component that has
    both the resolved report metadata and the authoritative artifact files.
    """
    if not REPORTS_ROOT:
        return
    try:
        for report in reports:
            if report.get("hidden"):
                continue
            tid = str(report.get("task_id") or "")
            if not _TID_RE.match(tid):
                continue
            group = _report_slug(str(report.get("group_title") or "general"), "general")
            title = _report_slug(str(report.get("title") or tid), tid)
            package = os.path.join(REPORTS_ROOT, group, f"{title}--{tid}")
            os.makedirs(package, exist_ok=True)
            published: list[dict] = []
            for entry in report.get("files") or []:
                name = str(entry.get("name") or "")
                if not name or os.path.basename(name) != name:
                    continue
                source = os.path.join(_artifacts_dir(tid), name)
                target = os.path.join(package, name)
                if not os.path.isfile(source):
                    continue
                if (not os.path.exists(target) or os.path.getsize(source) != os.path.getsize(target)
                        or int(os.path.getmtime(source)) != int(os.path.getmtime(target))):
                    shutil.copy2(source, target)
                published.append({"name": name, "size": os.path.getsize(source),
                                  "mime": entry.get("mime", "")})
            manifest = {"task_id": tid, "title": report.get("title", tid),
                        "group_id": report.get("group_id", tid),
                        "group_title": report.get("group_title", "general"),
                        "assignee": report.get("assignee", ""), "status": report.get("status", ""),
                        "updated": report.get("updated"), "completed": report.get("completed"),
                        "files": published}
            tmp = os.path.join(package, ".report-manifest.tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(manifest, fh, indent=2)
                fh.write("\n")
            os.replace(tmp, os.path.join(package, "report-manifest.json"))
    except OSError as exc:
        print(f"report package publish failed: {exc}", flush=True)


def _list_all_tasks() -> dict[str, dict]:
    """Single dict of every task (active + archived) by id.

    Reports/Apps are read-only projections, so avoid spawning `hermes kanban
    list` twice on every page open. The bridge already owns read-only SQLite
    access for links; task metadata is safe to read the same way.
    """
    db = os.path.join(KANBAN_HOME, "kanban.db")
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute("SELECT * FROM tasks").fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return {}
    return {row["id"]: dict(row) for row in rows if row["id"]}


def _read_links() -> list[tuple[str, str]]:
    """Whole task_links DAG as (parent, child) pairs. Same query as the `links`
    action; inlined so reports_index doesn't re-enter _kanban_action."""
    db = os.path.join(KANBAN_HOME, "kanban.db")
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        try:
            rows = con.execute("SELECT parent_id, child_id FROM task_links").fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return []
    return [(p, c) for p, c in rows]


def _compute_groups(by_id: dict[str, dict], tids: list[str]) -> dict[str, tuple[str, str]]:
    """For each task id in `tids`, return its (group_id, group_title) — the
    terminal goal node of the decompose DAG. Single DAG read; O(depth) walk per
    task with no bridge round-trips (mission-control's old _report_group did one
    `show` per hop)."""
    edges = _read_links()
    children: dict[str, list[str]] = {}
    for p, c in edges:
        children.setdefault(p, []).append(c)
    out: dict[str, tuple[str, str]] = {}
    for tid in tids:
        seen = {tid}
        cur = tid
        for _ in range(24):  # cycle guard
            kids = [k for k in children.get(cur, []) if k not in seen]
            if not kids:
                break
            seen.add(cur)
            cur = sorted(kids)[0]
        title = (by_id.get(cur) or {}).get("title") or cur
        out[tid] = (cur, title)
    return out


def _build_reports_index() -> dict:
    """Full Mission Control Reports payload — projection-backed file list joined
    with fresh task metadata + DAG-derived grouping. Replaces the old MC handler
    that issued artifacts_all + list×2 + show×N bridge calls per request."""
    rep, _app = _refresh_projections()
    by_id = _list_all_tasks()
    tids = list(rep["tasks"].keys())
    groups = _compute_groups(by_id, tids)
    out: list[dict] = []
    for tid, entry in rep["tasks"].items():
        t = by_id.get(tid, {})
        gid, gtitle = groups.get(tid, (tid, t.get("title") or tid))
        out.append({
            "task_id": tid,
            "title": t.get("title") or tid,
            "assignee": t.get("assignee") or "",
            "status": t.get("status") or "",
            "updated": _task_updated_ts(t),
            "completed": int(t.get("completed_at") or 0),
            "file_count": len(entry.get("files") or []),
            "files": entry.get("files") or [],
            "group_id": gid,
            "group_title": gtitle,
            "hidden": bool(entry.get("hidden")),
        })
    out.sort(key=lambda r: r["updated"], reverse=True)
    _publish_report_packages(out)
    return {"ok": True, "generated_at": int(time.time()), "reports": out}


def _build_apps_index() -> dict:
    """Full Mission Control Apps payload. Hidden tasks are filtered out (the
    old apps_all action did the same). Group info is derived the same way as
    reports so a multi-app effort coheres."""
    _rep, app = _refresh_projections()
    by_id = _list_all_tasks()
    tids = [tid for tid, entry in app["tasks"].items() if not entry.get("hidden")]
    groups = _compute_groups(by_id, tids)
    out: list[dict] = []
    for tid in tids:
        entry = app["tasks"][tid]
        t = by_id.get(tid, {})
        title = t.get("title") or tid
        gid, gtitle = groups.get(tid, (tid, title))
        for ap in entry.get("apps") or []:
            out.append({
                "task_id": tid,
                "app_path": ap.get("app_path", ""),
                "name": ap.get("app_path") or title,
                "title": title,
                "assignee": t.get("assignee") or "",
                "status": t.get("status") or "",
                "updated": _task_updated_ts(t),
                "file_count": int(ap.get("file_count") or 0),
                "bytes": int(ap.get("bytes") or 0),
                "url_path": ap.get("url_path") or "/",
                "group_id": gid,
                "group_title": gtitle,
            })
    out.sort(key=lambda r: r["updated"], reverse=True)
    return {"ok": True, "generated_at": int(time.time()), "apps": out}


def _kanban_action(data: dict):
    """Map a structured action to a whitelisted `hermes kanban` invocation.
    Phase 1: reads + manual board ops. Phase 2a adds `run` (manual worker)."""
    action = str(data.get("action") or "").strip()
    tid = str(data.get("id") or "").strip()
    reason = str(data.get("reason") or "via Mission Control")[:300]

    if action == "list":
        argv = ["list", "--json"]
        st = str(data.get("status") or "")
        if st in KANBAN_STATUS:
            argv += ["--status", st]
        if data.get("assignee"):
            argv += ["--assignee", str(data["assignee"])[:64]]
        if data.get("archived"):
            argv += ["--archived"]
        return _kanban_run(argv, parse_json=True)

    if action == "links":
        # Whole task_links DAG in one read so Mission Control can flag every
        # board card as a parent (owns subtasks) or a subtask (belongs to a
        # decomposed effort) WITHOUT an N+1 of per-task `show` calls. Read-only
        # against the same /opt/kanban store the kanban CLI manages.
        db = os.path.join(KANBAN_HOME, "kanban.db")
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
            try:
                rows = con.execute("SELECT parent_id, child_id FROM task_links").fetchall()
            finally:
                con.close()
        except sqlite3.Error as exc:
            return 502, {"ok": False, "error": f"links read failed: {exc}"}
        return 200, {"ok": True, "links": [{"parent": p, "child": c} for p, c in rows]}

    if action == "show":
        if not tid:
            return 400, {"ok": False, "error": "missing id"}
        return _kanban_run(["show", tid, "--json"], parse_json=True)

    if action == "create":
        title = str(data.get("title") or "").strip()
        if not title:
            return 400, {"ok": False, "error": "missing title"}
        argv = ["create", title[:200], "--json"]
        if data.get("body"):
            argv += ["--body", str(data["body"])[:4000]]
        if data.get("assignee"):
            argv += ["--assignee", str(data["assignee"])[:64]]
        if str(data.get("priority") or "").strip():
            try:
                argv += ["--priority", str(int(data["priority"]))]
            except (TypeError, ValueError):
                pass
        if data.get("parent"):
            argv += ["--parent", str(data["parent"])[:64]]
        ws = str(data.get("workspace") or "").strip()
        if ws == "scratch" or ws == "worktree" or ws.startswith(("dir:", "worktree:")):
            argv += ["--workspace", ws]
        if data.get("triage"):
            argv += ["--triage"]
        return _kanban_run(argv, parse_json=True)

    if action == "comment":
        text = str(data.get("text") or "").strip()
        if not tid or not text:
            return 400, {"ok": False, "error": "missing id or text"}
        return _kanban_run(["comment", tid, text[:4000], "--author",
                            str(data.get("author") or "mission-control")[:40]])

    if action == "assign":
        prof = str(data.get("assignee") or "").strip()
        if not tid or not prof:
            return 400, {"ok": False, "error": "missing id or assignee"}
        return _kanban_run(["assign", tid, prof[:64]])

    if action == "archive":
        if not tid:
            return 400, {"ok": False, "error": "missing id"}
        return _kanban_run(["archive", tid])

    if action in ("artifacts_hide", "artifacts_unhide"):
        # Soft-delete (hide) / restore (unhide) one report. A `.hidden` marker in
        # the task's artifact dir is created or removed; the deliverable files are
        # never touched, so the operation is fully reversible. Only meaningful for
        # tasks that actually have an artifact dir.
        if not _TID_RE.match(tid):
            return 400, {"ok": False, "error": "bad id"}
        base = _artifacts_dir(tid)
        if not os.path.isdir(base):
            return 404, {"ok": False, "error": "no artifacts for task"}
        marker = _hidden_marker(tid)
        try:
            if action == "artifacts_hide":
                with open(marker, "w", encoding="utf-8") as fh:
                    fh.write(f"hidden via Mission Control @ {int(time.time())}\n")
                hidden = True
            else:
                try:
                    os.remove(marker)
                except FileNotFoundError:
                    pass
                hidden = False
        except OSError as exc:
            return 502, {"ok": False, "error": str(exc)}
        _proj_update_task(tid)
        return 200, {"ok": True, "id": tid, "hidden": hidden}

    if action == "artifacts_purge":
        # PERMANENT delete: remove the task's ENTIRE artifact directory off the
        # shared volume. Irreversible — there is no restore. (Soft-delete is the
        # `artifacts_hide` action above.)
        if not _TID_RE.match(tid):
            return 400, {"ok": False, "error": "bad id"}
        base_real = os.path.realpath(_artifacts_dir(tid))
        # Guard: only ever remove a dir that sits directly under ARTIFACTS_DIR.
        if os.path.dirname(base_real) != os.path.realpath(ARTIFACTS_DIR):
            return 400, {"ok": False, "error": "refusing to remove path outside artifacts root"}
        if not os.path.isdir(base_real):
            return 404, {"ok": False, "error": "no artifacts for task"}
        try:
            shutil.rmtree(base_real)
        except OSError as exc:
            return 502, {"ok": False, "error": str(exc)}
        _proj_update_task(tid, drop=True)
        return 200, {"ok": True, "id": tid, "purged": True}

    if action == "artifact_delete":
        # PERMANENT delete of ONE file from a task's artifact dir. Irreversible.
        # Same traversal hardening as serving: t_<hex> id, basename, restricted
        # charset, realpath prefix check. Dotfiles (the `.hidden` marker) are off
        # limits so a delete can't strip the soft-delete bookkeeping.
        if not _TID_RE.match(tid):
            return 400, {"ok": False, "error": "bad id"}
        name = os.path.basename(unquote(str(data.get("name") or "")))
        if not name or name in (".", "..") or name.startswith(".") or _SAFE_NAME.search(name):
            return 400, {"ok": False, "error": "bad name"}
        base_real = os.path.realpath(_artifacts_dir(tid))
        full = os.path.realpath(os.path.join(base_real, name))
        if os.path.commonpath([full, base_real]) != base_real or not os.path.isfile(full):
            return 404, {"ok": False, "error": "not found"}
        try:
            os.remove(full)
        except OSError as exc:
            return 502, {"ok": False, "error": str(exc)}
        _proj_update_task(tid)
        return 200, {"ok": True, "id": tid, "name": name, "deleted": True}

    if action == "move":
        to = str(data.get("to") or "").strip()
        src = str(data.get("from") or "").strip()
        if not tid:
            return 400, {"ok": False, "error": "missing id"}
        if to == "ready":
            verb = "unblock" if src in ("blocked", "scheduled") else "promote"
            return _kanban_run([verb, tid, reason])
        if to == "blocked":
            return _kanban_run(["block", tid, reason])
        if to == "scheduled":
            return _kanban_run(["schedule", tid, reason])
        if to == "done":
            argv = ["complete", tid]
            if data.get("result"):
                argv += ["--result", str(data["result"])[:2000]]
            return _kanban_run(argv)
        if to == "archived":
            return _kanban_run(["archive", tid])
        return 400, {"ok": False, "error": f"unsupported move to '{to}'"}

    if action == "run":
        if not tid:
            return 400, {"ok": False, "error": "missing id"}
        return _kanban_run_worker(tid)

    if action == "stop":
        if not tid or not _TID_RE.match(tid):
            return 400, {"ok": False, "error": "bad id"}
        return _kanban_stop_worker(tid)

    if action == "decompose":
        # Orchestrator turn: this profile (the board gateway / orchestrator)
        # reasons over a triage goal and writes assigned child tasks to the
        # shared board. It's an LLM turn, so allow a generous timeout.
        if not tid:
            return 400, {"ok": False, "error": "missing id"}
        return _kanban_run(["decompose", tid, "--json"], parse_json=True, timeout=240)

    if action == "log":
        if not tid:
            return 400, {"ok": False, "error": "missing id"}
        try:
            n = max(200, min(40000, int(data.get("tail") or 8000)))
        except (TypeError, ValueError):
            n = 8000
        # Worker logs live on the SHARED kanban volume, so any agent's bridge can
        # read any task's log (MC routes this to the board gateway).
        path = os.path.join(os.environ.get("HERMES_KANBAN_HOME", "/opt/kanban"),
                            "logs", f"mc-run-{_SAFE_NAME.sub('_', tid)}.log")
        try:
            with open(path, "rb") as fh:
                fh.seek(0, 2)
                size = fh.tell()
                fh.seek(max(0, size - n))
                text = fh.read().decode("utf-8", "replace")
            return 200, {"ok": True, "log": text, "bytes": size, "truncated": size > n}
        except FileNotFoundError:
            return 200, {"ok": True, "log": "", "bytes": 0, "truncated": False}
        except OSError as exc:
            return 502, {"ok": False, "error": str(exc)}

    if action == "artifacts":
        # List durable deliverables for a task. Files live on the SHARED kanban
        # volume, so any agent's bridge can list any task's artifacts (MC routes
        # this to the board gateway). Serving the bytes is GET /kanban_artifact.
        if not tid or not _TID_RE.match(tid):
            return 400, {"ok": False, "error": "bad id"}
        base = _artifacts_dir(tid)
        out = []
        try:
            for n in sorted(os.listdir(base)):
                p = os.path.join(base, n)
                if os.path.isfile(p):
                    stt = os.stat(p)
                    out.append({"name": n, "size": stt.st_size,
                                "mime": mimetypes.guess_type(p)[0] or "application/octet-stream",
                                "mtime": int(stt.st_mtime)})
        except FileNotFoundError:
            pass
        except OSError as exc:
            return 502, {"ok": False, "error": str(exc)}
        return 200, {"ok": True, "id": tid, "artifacts": out}

    if action == "artifacts_tree":
        # Recursive listing for a task — nested folders included (the `artifacts`
        # action above only sees top-level files). Also flags which folders are
        # runnable static apps (contain an index.html). Bytes are served by
        # GET /kanban_artifact (?path= for nested); the app is served live by the
        # apps origin.
        if not tid or not _TID_RE.match(tid):
            return 400, {"ok": False, "error": "bad id"}
        try:
            files, apps = _artifact_tree(tid)
        except OSError as exc:
            return 502, {"ok": False, "error": str(exc)}
        return 200, {"ok": True, "id": tid, "files": files, "apps": apps}

    if action == "autodispatch_get":
        with _AUTOD_LOCK:
            return 200, {"ok": True, "profile": PROFILE, "enabled": _autod["enabled"], "max": _autod["max"]}

    if action == "autodispatch_set":
        with _AUTOD_LOCK:
            _autod["enabled"] = bool(data.get("enabled"))
            try:
                _autod["max"] = max(1, min(4, int(data.get("max", _autod["max"]))))
            except (TypeError, ValueError):
                pass
            _save_autod()
            state = dict(_autod)
        return 200, {"ok": True, "profile": PROFILE, **state}

    if action == "reports_index":
        # Projection-backed Reports payload — single round-trip from Mission
        # Control. Replaces the old artifacts_all + list×2 + show×N fan-out.
        return 200, _build_reports_index()

    if action == "apps_index":
        # Projection-backed Apps payload — group-aware, fan-out-free.
        return 200, _build_apps_index()

    if action == "publish_wiki":
        if not tid:
            return 400, {"ok": False, "error": "missing id"}
        name = str(data.get("name") or "").strip()
        if not name:
            return 400, {"ok": False, "error": "missing name"}
        return _publish_to_wiki(tid, name, str(data.get("title") or "")[:200])

    return 400, {"ok": False, "error": f"unknown action '{action}'"}


def _write_attachments(attachments: list[dict]) -> list[str]:
    paths: list[str] = []
    if not attachments:
        return paths
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for i, att in enumerate(attachments):
        try:
            raw = base64.b64decode(att.get("content_b64", ""), validate=True)
        except (ValueError, TypeError):
            continue
        name = _SAFE_NAME.sub("_", att.get("name", f"file{i}"))[:80] or f"file{i}"
        path = os.path.join(UPLOAD_DIR, f"{stamp}-{i}-{name}")
        with open(path, "wb") as fh:
            fh.write(raw)
        paths.append(path)
    return paths


# `MEDIA:<path>` is the media-attachment directive Hermes core emits (its Telegram
# convention). Mission Control's web chat can only deliver files that live in
# UPLOAD_DIR — both the UI linkifier and the /file endpoint are scoped to it — so
# a file the agent GENERATES elsewhere and references with MEDIA: renders as dead
# text. We rewrite those directives into real download links by copying each
# referenced file into UPLOAD_DIR and replacing the directive with the served path.
_MEDIA_RE = re.compile(
    r"""MEDIA:[ \t]*          # the directive
        ['"`]?                # optional opening quote/backtick
        (?:sandbox:|file:)?   # optional URI-ish scheme the agent may prepend
        (/[^\s'"`]+)          # group 1: the absolute path
        ['"`]?                # optional closing quote/backtick
    """,
    re.IGNORECASE | re.VERBOSE,
)
MAX_PUBLISH_BYTES = 50 * 1024 * 1024  # don't copy huge files onto the data volume


def _publish_media(reply: str) -> str:
    """Rewrite the agent's `MEDIA:<path>` directives into Mission Control download
    links. Each existing, readable, non-oversized file is copied into UPLOAD_DIR
    under a unique safe name and the directive is replaced with that served path
    (`/opt/data/.mission-control-uploads/<name>`), which the UI linkifier and the
    /file endpoint both understand. Missing/oversized/unreadable paths are left
    untouched so a genuine message is never mangled.
    """
    if not reply or "MEDIA:" not in reply.upper():
        return reply
    published: dict[str, str] = {}  # realpath -> served path (dedupe repeats)

    def _repl(match: re.Match) -> str:
        src = os.path.realpath(match.group(1))
        if src in published:
            return published[src]
        try:
            if not os.path.isfile(src) or os.path.getsize(src) > MAX_PUBLISH_BYTES:
                return match.group(0)
        except OSError:
            return match.group(0)
        try:
            os.makedirs(UPLOAD_DIR, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            name = _SAFE_NAME.sub("_", os.path.basename(src))[:80] or "file"
            dest_name = f"{stamp}-{len(published)}-{name}"
            shutil.copyfile(src, os.path.join(UPLOAD_DIR, dest_name))
        except OSError:
            return match.group(0)
        served = f"{UPLOAD_DIR}/{dest_name}"
        published[src] = served
        return served

    return _MEDIA_RE.sub(_repl, reply)


class AcpAgent:
    """Manages one persistent `hermes acp` JSON-RPC process for this profile."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self._sessions: dict[str, str] = {}  # conv_id -> ACP sessionId (this process)
        self.alive = False
        self.last_used = 0.0
        self._next_id = 0
        self._pending: dict[int, dict] = {}
        self._notes: list[str] = []
        self._stream_q: "queue.Queue | None" = None  # active streaming turn sink
        self._active_id: int | None = None            # request id of the streaming turn
        self._io = threading.Lock()      # guards stdin writes + id/pending bookkeeping
        self._turn = threading.Lock()    # serializes whole turns on the process

    # ── wire helpers ────────────────────────────────────────────────────────
    def _send(self, obj: dict) -> None:
        data = (json.dumps(obj) + "\n").encode("utf-8")
        with self._io:
            assert self.proc and self.proc.stdin
            self.proc.stdin.write(data)
            self.proc.stdin.flush()

    def _request(self, method: str, params: dict, timeout: int) -> dict:
        with self._io:
            self._next_id += 1
            rid = self._next_id
            slot = {"event": threading.Event(), "msg": None}
            self._pending[rid] = slot
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        if not slot["event"].wait(timeout):
            self._pending.pop(rid, None)
            raise TimeoutError(f"{method} timed out after {timeout}s")
        msg = self._pending.pop(rid, {}).get("msg") or {}
        if msg.get("error"):
            raise RuntimeError(f"{method} error: {msg['error']}")
        return msg.get("result", {})

    def _reader(self, proc: subprocess.Popen) -> None:
        for raw in proc.stdout:  # type: ignore[union-attr]
            line = raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            mid = msg.get("id")
            if mid is not None and ("result" in msg or "error" in msg):
                if mid == self._active_id and self._stream_q is not None:
                    self._stream_q.put(("done", msg))
                else:
                    slot = self._pending.get(mid)
                    if slot:
                        slot["msg"] = msg
                        slot["event"].set()
            elif msg.get("method") == "session/update":
                upd = msg.get("params", {}).get("update", {})
                if upd.get("sessionUpdate") == "agent_message_chunk":
                    content = upd.get("content", {})
                    if content.get("type") == "text":
                        text = content.get("text", "")
                        if self._stream_q is not None:
                            self._stream_q.put(("chunk", text))
                        else:
                            self._notes.append(text)
            elif mid is not None and "method" in msg:
                # server -> client request: auto-approve permissions, refuse the rest
                if msg["method"] == "session/request_permission":
                    opts = msg.get("params", {}).get("options", [])
                    pick = next((o["optionId"] for o in opts
                                 if "allow" in (str(o.get("optionId", "")) + str(o.get("kind", ""))).lower()),
                                opts[0]["optionId"] if opts else None)
                    self._send({"jsonrpc": "2.0", "id": mid,
                                "result": {"outcome": {"outcome": "selected", "optionId": pick}}})
                else:
                    self._send({"jsonrpc": "2.0", "id": mid,
                                "error": {"code": -32601, "message": "unsupported"}})
        self.alive = False  # stdout closed -> process gone

    # ── lifecycle ───────────────────────────────────────────────────────────
    def _start(self) -> None:
        proc = subprocess.Popen([HERMES_BIN, "acp", "--accept-hooks"],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL)
        self.proc = proc
        self.alive = True
        self._pending = {}
        self._next_id = 0
        self._sessions = {}  # new process invalidates all prior session ids
        threading.Thread(target=self._reader, args=(proc,), daemon=True).start()
        self._request("initialize", {"protocolVersion": 1,
                                     "clientCapabilities": {"fs": {"readTextFile": False,
                                                                   "writeTextFile": False}}},
                      INIT_TIMEOUT)

    def _ensure(self) -> None:
        if self.proc is None or not self.alive or self.proc.poll() is not None:
            self._start()

    def _session_for(self, conv: str) -> str:
        """ACP sessionId for this conversation on the current process, created on
        demand. Each conversation gets its own session so contexts never mix."""
        sid = self._sessions.get(conv)
        if sid:
            return sid
        res = self._request("session/new", {"cwd": CWD, "mcpServers": []}, INIT_TIMEOUT)
        sid = res.get("sessionId")
        if not sid:
            raise RuntimeError("session/new returned no sessionId")
        self._sessions[conv] = sid
        return sid

    def prompt(self, conv: str, message: str, attachment_paths: list[str]) -> dict:
        with self._turn:
            self._ensure()
            sid = self._session_for(conv)
            blocks = [{"type": "text", "text": message or "(see attached files)"}]
            if attachment_paths:
                listing = "\n".join(f"  - {p}" for p in attachment_paths)
                blocks.append({"type": "text",
                               "text": f"\n[Operator attached files; read them with your "
                                       f"tools if relevant]:\n{listing}"})
            self._notes = []
            started = time.time()
            res = self._request("session/prompt",
                                {"sessionId": sid, "prompt": blocks},
                                PROMPT_TIMEOUT)
            self.last_used = time.time()
            reply = "".join(self._notes).strip() or "(empty reply)"
            return {"ok": True, "profile": PROFILE, "session": sid,
                    "reply": _publish_media(reply),
                    "elapsed_s": round(time.time() - started, 1),
                    "stop": res.get("stopReason"), "mode": "acp"}

    def prompt_stream(self, conv: str, message: str, attachment_paths: list[str]):
        """Generator yielding ("chunk", text) as tokens arrive, then a final
        ("done", meta) or ("error", str). Serialized per profile via _turn."""
        with self._turn:
            self._ensure()
            sid = self._session_for(conv)
            blocks = [{"type": "text", "text": message or "(see attached files)"}]
            if attachment_paths:
                listing = "\n".join(f"  - {p}" for p in attachment_paths)
                blocks.append({"type": "text",
                               "text": f"\n[Operator attached files; read them with your "
                                       f"tools if relevant]:\n{listing}"})
            q: queue.Queue = queue.Queue()
            with self._io:
                self._next_id += 1
                rid = self._next_id
            self._stream_q = q
            self._active_id = rid
            started = time.time()
            assembled: list[str] = []  # full reply, to rewrite MEDIA: links at done
            try:
                self._send({"jsonrpc": "2.0", "id": rid, "method": "session/prompt",
                            "params": {"sessionId": sid, "prompt": blocks}})
                while True:
                    try:
                        kind, payload = q.get(timeout=PROMPT_TIMEOUT)
                    except queue.Empty:
                        yield ("error", f"turn exceeded {PROMPT_TIMEOUT}s")
                        return
                    if kind == "chunk":
                        assembled.append(payload)
                        yield ("chunk", payload)
                    else:  # done
                        if payload.get("error"):
                            yield ("error", str(payload["error"]))
                        else:
                            # The MEDIA: directive may have streamed through as raw
                            # text; hand the client the rewritten reply so it can
                            # replace the message with one carrying real links.
                            reply = "".join(assembled).strip()
                            done = {"profile": PROFILE, "session": sid,
                                    "elapsed_s": round(time.time() - started, 1),
                                    "stop": payload.get("result", {}).get("stopReason"),
                                    "mode": "acp"}
                            published = _publish_media(reply)
                            if published != reply:
                                done["reply"] = published
                            yield ("done", done)
                        return
            finally:
                self._stream_q = None
                self._active_id = None
                self.last_used = time.time()

    def maybe_idle_shutdown(self) -> None:
        if self.proc and self.alive and (time.time() - self.last_used > IDLE_TIMEOUT):
            with self._turn:
                if self.proc and (time.time() - self.last_used > IDLE_TIMEOUT):
                    try:
                        self.proc.terminate()
                    except Exception:  # noqa: BLE001
                        pass
                    self.proc, self.alive, self._sessions = None, False, {}

    def reset(self, conv: str | None = None) -> None:
        """Forget one conversation's session (conv given), or drop the whole ACP
        process (conv=None). Used when the operator deletes/clears a chat."""
        with self._turn:
            if conv is not None:
                self._sessions.pop(conv, None)
                return
            if self.proc:
                try:
                    self.proc.terminate()
                except Exception:  # noqa: BLE001
                    pass
            self.proc, self.alive, self._sessions = None, False, {}

    def status(self) -> str:
        if self.proc and self.alive and self.proc.poll() is None:
            return "warm"
        return "cold"


AGENT = AcpAgent()


def _oneshot_fallback(message: str, attachment_paths: list[str]) -> dict:
    prompt = message
    if attachment_paths:
        prompt += "\n[attached]:\n" + "\n".join(attachment_paths)
    started = time.time()
    proc = subprocess.run([HERMES_BIN, "--continue", f"mc-{PROFILE}", "-z", prompt],
                          capture_output=True, text=True, timeout=PROMPT_TIMEOUT, cwd=CWD)
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or "").strip().splitlines()[-6:])
        return {"ok": False, "error": "oneshot failed", "stderr": tail}
    return {"ok": True, "profile": PROFILE, "session": f"mc-{PROFILE}",
            "reply": _publish_media((proc.stdout or "").strip()) or "(empty reply)",
            "elapsed_s": round(time.time() - started, 1), "mode": "oneshot-fallback"}


_TITLE_CONV = "__mc_titler__"  # dedicated throwaway ACP session, reset after each use


def _clean_title(text: str) -> str:
    """Reduce a model reply to a short, bare title."""
    line = next((ln.strip() for ln in (text or "").splitlines() if ln.strip()), "")
    line = re.sub(r"(?i)^title\s*[:\-]\s*", "", line)         # drop echoed "Title:"
    line = line.strip().strip('"').strip("'").strip("*").strip("` ")
    words = line.split()
    if len(words) > 8:
        line = " ".join(words[:8])
    return line[:60].rstrip(".,:;!-– ").strip()


def _generate_title(user: str, reply: str) -> str:
    """One short LLM turn (throwaway session) that titles the first exchange.
    The session is reset afterwards so titling stays stateless and doesn't grow
    a context. NOTE: like any agent turn it still persists once to the profile's
    conversational memory."""
    prompt = (
        "Generate a short title for this chat conversation. Output ONLY the title — "
        "3 to 6 words, no surrounding quotes, no trailing punctuation, no preamble.\n\n"
        f"User: {user[:1200]}\nAssistant: {reply[:1200]}\n\nTitle:"
    )
    try:
        res = AGENT.prompt(_TITLE_CONV, prompt, [])
    except Exception:  # noqa: BLE001
        return ""
    finally:
        try:
            AGENT.reset(_TITLE_CONV)
        except Exception:  # noqa: BLE001
            pass
    return _clean_title(res.get("reply", "")) if res.get("ok") else ""


def _watchdog() -> None:
    while True:
        time.sleep(60)
        try:
            AGENT.maybe_idle_shutdown()
        except Exception:  # noqa: BLE001
            pass


class Handler(BaseHTTPRequestHandler):
    server_version = "agent-chat-bridge/0.2"

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _sse_start(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()

    def _sse(self, payload: dict) -> None:
        try:
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ValueError):
            pass

    def _authed(self) -> bool:
        # Fail CLOSED. An unset token is a MISCONFIGURATION, not "open access" —
        # refuse rather than serve every endpoint unauthenticated on 0.0.0.0
        # across platform-net. (The unauthenticated /healthz never calls this.)
        if not TOKEN:
            return False
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        if self.path == "/healthz":
            self._json(200, {"ok": True, "profile": PROFILE, "acp": AGENT.status()})
            return
        if self.path == "/usage":
            if not self._authed():
                self._json(401, {"ok": False, "error": "unauthorized"})
                return
            self._json(200, {"ok": True, "profile": PROFILE, **_read_usage()})
            return
        if self.path == "/cron":
            if not self._authed():
                self._json(401, {"ok": False, "error": "unauthorized"})
                return
            self._json(200, {"ok": True, "profile": PROFILE, "jobs": _read_cron_jobs()})
            return
        if self.path == "/meta":
            if not self._authed():
                self._json(401, {"ok": False, "error": "unauthorized"})
                return
            mi = _model_info()
            soul = _read_soul()
            desc, kind = _role_description(soul)
            caps = _capabilities()
            self._json(200, {"ok": True, "profile": PROFILE,
                             "model": mi["model"], "provider": mi["provider"],
                             "description": desc, "description_kind": kind,
                             "soul_summary": _soul_summary(soul),
                             "role_title": _role_title(soul),
                             "bio": _soul_bio(soul),
                             "tools": caps["tools"], "skills": caps["skills"]})
            return
        if self.path == "/soul":
            if not self._authed():
                self._json(401, {"ok": False, "error": "unauthorized"})
                return
            self._json(200, {"ok": True, "profile": PROFILE, "soul": _read_soul()})
            return
        if self.path == "/models":
            if not self._authed():
                self._json(401, {"ok": False, "error": "unauthorized"})
                return
            self._json(200, {"profile": PROFILE, **_list_models()})
            return
        if urlsplit(self.path).path == "/file":
            self._serve_file()
            return
        if urlsplit(self.path).path == "/kanban_artifact":
            self._serve_artifact()
            return
        if urlsplit(self.path).path == "/kanban_artifact_zip":
            self._serve_artifact_zip()
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_PUT(self):
        """Edit this profile's SOUL.md or model from Mission Control. Both writes
        reset the warm ACP process so the next turn reloads the new config."""
        if not self._authed():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path not in ("/soul", "/model"):
            self._json(404, {"ok": False, "error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > MAX_BODY:
            self._json(413, {"ok": False, "error": "bad or oversized body"})
            return
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json(400, {"ok": False, "error": "invalid json"})
            return
        if self.path == "/soul":
            text = data.get("text")
            if not isinstance(text, str):
                self._json(400, {"ok": False, "error": "missing 'text'"})
                return
            if len(text.encode("utf-8")) > MAX_SOUL:
                self._json(413, {"ok": False, "error": "SOUL.md too large"})
                return
            try:
                _write_soul(text)
            except OSError as exc:
                self._json(500, {"ok": False, "error": f"write failed: {exc}"})
                return
            AGENT.reset(None)
            self._json(200, {"ok": True, "profile": PROFILE,
                             "soul_summary": _soul_summary(text)})
            return
        # /model
        value = str(data.get("model") or data.get("value") or "")
        provider = str(data.get("provider") or "").strip()
        # Switch the provider first so the model write lands under the right
        # one. A provider failure is non-fatal: same-provider switches (the
        # common case) don't send one, and the model write below is what matters.
        if provider:
            _set_provider(provider)
        if not _set_model(value):
            self._json(400, {"ok": False, "error": "could not set model"})
            return
        # Fresh model info reflects both writes; invalidate the picker cache so
        # the next /models call shows the new current selection.
        with _models_lock:
            _models_cache["data"] = None
        mi = _model_info()
        AGENT.reset(None)
        self._json(200, {"ok": True, "profile": PROFILE,
                         "model": mi["model"], "provider": mi["provider"]})

    def _serve_file(self):
        """Serve a single file from UPLOAD_DIR by basename (token-gated).

        Hardened against traversal: basename only, restricted charset, and a
        realpath prefix check so the resolved path can't escape UPLOAD_DIR.
        """
        if not self._authed():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        raw = (parse_qs(urlsplit(self.path).query).get("name") or [""])[0]
        name = os.path.basename(unquote(raw))
        if not name or name in (".", "..") or _SAFE_NAME.search(name):
            self._json(400, {"ok": False, "error": "bad name"})
            return
        base = os.path.realpath(UPLOAD_DIR)
        full = os.path.realpath(os.path.join(base, name))
        if os.path.commonpath([full, base]) != base or not os.path.isfile(full):
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except OSError:
            self._json(404, {"ok": False, "error": "not found"})
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.end_headers()
        self.wfile.write(data)

    def _serve_artifact(self):
        """Serve one durable artifact from /opt/kanban/artifacts/<id>/ by basename
        (token-gated). Same traversal hardening as _serve_file (basename + charset
        + realpath prefix), plus the task id is validated to the t_<hex> shape.
        Served inline so the UI can render markdown; the UI's Download link uses
        the <a download> attribute to force a save."""
        if not self._authed():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        q = parse_qs(urlsplit(self.path).query)
        tid = (q.get("id") or [""])[0]
        rel = (q.get("path") or [""])[0]
        if not _TID_RE.match(tid):
            self._json(400, {"ok": False, "error": "bad id"})
            return
        # `path` (nested, may contain '/') takes precedence over the legacy
        # basename-only `name`. Both go through the same realpath-prefix defence.
        if rel:
            full = _resolve_artifact_rel(tid, rel)
            if not full:
                self._json(404, {"ok": False, "error": "not found"})
                return
        else:
            name = os.path.basename(unquote((q.get("name") or [""])[0]))
            if not name or name in (".", "..") or _SAFE_NAME.search(name):
                self._json(400, {"ok": False, "error": "bad name"})
                return
            base = os.path.realpath(_artifacts_dir(tid))
            full = os.path.realpath(os.path.join(base, name))
            if os.path.commonpath([full, base]) != base or not os.path.isfile(full):
                self._json(404, {"ok": False, "error": "not found"})
                return
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except OSError:
            self._json(404, {"ok": False, "error": "not found"})
            return
        fname = os.path.basename(full)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'inline; filename="{fname}"')
        self.end_headers()
        self.wfile.write(data)

    def _serve_artifact_zip(self):
        """Stream a .zip of a task's whole artifact dir, or one subfolder (?sub=),
        preserving the folder structure (arcnames relative to the zipped root).
        Token-gated; same task-id + per-segment path defences as _serve_artifact.
        Lets the operator download a complete deliverable (e.g. a webapp folder)
        in one click."""
        if not self._authed():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        q = parse_qs(urlsplit(self.path).query)
        tid = (q.get("id") or [""])[0]
        sub = (q.get("sub") or [""])[0]
        if not _TID_RE.match(tid):
            self._json(400, {"ok": False, "error": "bad id"})
            return
        base_real = os.path.realpath(_artifacts_dir(tid))
        root = base_real
        label = tid
        if sub:
            parts = _safe_rel_parts(sub)
            if not parts:
                self._json(400, {"ok": False, "error": "bad sub"})
                return
            root = os.path.realpath(os.path.join(base_real, *parts))
            if os.path.commonpath([root, base_real]) != base_real or not os.path.isdir(root):
                self._json(404, {"ok": False, "error": "not found"})
                return
            label = parts[-1]
        buf = io.BytesIO()
        added = 0
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for r, dirs, fnames in os.walk(root):
                dirs[:] = [d for d in dirs if not d.startswith(".") and d not in _PRUNE_DIRS]
                for fn in fnames:
                    if fn.startswith("."):
                        continue
                    full = os.path.join(r, fn)
                    arc = os.path.relpath(full, root).replace(os.sep, "/")
                    try:
                        zf.write(full, arc)
                    except OSError:
                        continue
                    added += 1
        if not added:
            self._json(404, {"ok": False, "error": "no files"})
            return
        data = buf.getvalue()
        fname = (_SAFE_NAME.sub("-", label).strip("-") or tid)[:80]
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{fname}.zip"')
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path == "/reset":
            if not self._authed():
                self._json(401, {"ok": False, "error": "unauthorized"})
                return
            conv = None
            length = int(self.headers.get("Content-Length", "0") or "0")
            if 0 < length <= MAX_BODY:
                try:
                    conv = (json.loads(self.rfile.read(length).decode("utf-8")) or {}).get("conv")
                except (json.JSONDecodeError, UnicodeDecodeError):
                    conv = None
            AGENT.reset(conv)
            self._json(200, {"ok": True, "reset": True})
            return
        if self.path == "/title":
            if not self._authed():
                self._json(401, {"ok": False, "error": "unauthorized"})
                return
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length <= 0 or length > MAX_BODY:
                self._json(413, {"ok": False, "error": "bad or oversized body"})
                return
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._json(400, {"ok": False, "error": "invalid json"})
                return
            # Share the per-profile turn lock with chat so we never run two ACP
            # turns at once. Best-effort: if a real turn is in flight, skip — the
            # conversation just keeps its first-message title.
            if not _BUSY.acquire(blocking=False):
                self._json(503, {"ok": False, "error": "agent busy"})
                return
            try:
                title = _generate_title(str(data.get("user") or ""),
                                        str(data.get("reply") or ""))
            finally:
                _BUSY.release()
            self._json(200, {"ok": bool(title), "title": title})
            return
        if self.path == "/kanban":
            # Shared-board op (pure CLI, no agent turn) — does NOT take _BUSY.
            if not self._authed():
                self._json(401, {"ok": False, "error": "unauthorized"})
                return
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length <= 0 or length > MAX_BODY:
                self._json(413, {"ok": False, "error": "bad or oversized body"})
                return
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._json(400, {"ok": False, "error": "invalid json"})
                return
            code, payload = _kanban_action(data)
            self._json(code, payload)
            return
        if self.path not in ("/chat", "/chat/stream"):
            self._json(404, {"ok": False, "error": "not found"})
            return
        if not self._authed():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > MAX_BODY:
            self._json(413, {"ok": False, "error": "bad or oversized body"})
            return
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._json(400, {"ok": False, "error": "invalid json"})
            return
        message = (data.get("message") or "").strip()
        if not message and not data.get("attachments"):
            self._json(400, {"ok": False, "error": "empty message"})
            return
        conv = str(data.get("conv") or data.get("session") or "default")

        streaming = self.path == "/chat/stream"
        if not _BUSY.acquire(blocking=False):
            if streaming:
                self._sse_start()
                self._sse({"type": "error", "error": "agent busy with another turn"})
            else:
                self._json(429, {"ok": False, "error": "agent busy with another turn"})
            return
        try:
            paths = _write_attachments(data.get("attachments") or [])
            if streaming:
                self._sse_start()
                try:
                    for kind, payload in AGENT.prompt_stream(conv, message, paths):
                        if kind == "chunk":
                            self._sse({"type": "chunk", "text": payload})
                        elif kind == "done":
                            self._sse({"type": "done", **payload})
                        else:
                            self._sse({"type": "error", "error": payload})
                except Exception as exc:  # noqa: BLE001 — surface stream failure to client
                    self._sse({"type": "error", "error": f"stream failed: {exc}"})
                return
            try:
                result = AGENT.prompt(conv, message, paths)
            except Exception as acp_err:  # noqa: BLE001 — ACP failed; degrade gracefully
                try:
                    result = _oneshot_fallback(message, paths)
                    result["acp_error"] = str(acp_err)
                except Exception as os_err:  # noqa: BLE001
                    self._json(502, {"ok": False,
                                     "error": f"acp failed ({acp_err}); fallback failed ({os_err})"})
                    return
        finally:
            _BUSY.release()
        self._json(200 if result.get("ok") else 502, result)


def main() -> None:
    threading.Thread(target=_watchdog, daemon=True).start()
    threading.Thread(target=_autodispatch_loop, daemon=True).start()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"agent-chat-bridge: profile={PROFILE} listening on :{PORT} "
          f"(persistent ACP, auth={'on' if TOKEN else 'off'})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
