#!/usr/bin/env python3
"""Probe: does the ACP agent STREAM tokens, and what's time-to-first-token?"""
import subprocess, json, threading, time, sys

HERMES = "/opt/hermes/.venv/bin/hermes"
proc = subprocess.Popen([HERMES, "acp", "--accept-hooks"],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
resp = {}
chunks = []          # (t_relative, text)
lock = threading.Lock()
prompt_sent_at = [None]


def send(o):
    proc.stdin.write((json.dumps(o) + "\n").encode()); proc.stdin.flush()


def reader():
    for raw in proc.stdout:
        line = raw.strip()
        if not line:
            continue
        try:
            m = json.loads(line)
        except Exception:
            continue
        mid = m.get("id")
        if mid is not None and ("result" in m or "error" in m):
            with lock:
                resp[mid] = m
        elif m.get("method") == "session/update":
            u = m.get("params", {}).get("update", {})
            if u.get("sessionUpdate") == "agent_message_chunk":
                c = u.get("content", {})
                if c.get("type") == "text" and prompt_sent_at[0]:
                    chunks.append((round(time.time() - prompt_sent_at[0], 2), c.get("text", "")))
        elif mid is not None and "method" in m:
            if m["method"] == "session/request_permission":
                opts = m.get("params", {}).get("options", [])
                pick = next((o["optionId"] for o in opts if "allow" in (str(o.get("optionId", "")) + str(o.get("kind", ""))).lower()), opts[0]["optionId"] if opts else None)
                send({"jsonrpc": "2.0", "id": mid, "result": {"outcome": {"outcome": "selected", "optionId": pick}}})
            else:
                send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "no"}})


threading.Thread(target=reader, daemon=True).start()


def wait(i, t):
    end = time.time() + t
    while time.time() < end:
        with lock:
            if i in resp:
                return resp[i]
        time.sleep(0.03)
    return None


send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"protocolVersion": 1, "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}}}})
wait(1, 120)
r = wait(1, 1)
send({"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": "/opt/data", "mcpServers": []}})
sid = (wait(2, 60) or {}).get("result", {}).get("sessionId")
print("session:", sid, flush=True)

# warm it (turn 1) then measure streaming on turn 2 with a longer answer
for mid, text in [(3, "Reply with exactly: warm"),
                  (4, "Write three sentences about why local-first AI agents are useful.")]:
    chunks.clear()
    prompt_sent_at[0] = time.time()
    send({"jsonrpc": "2.0", "id": mid, "method": "session/prompt",
          "params": {"sessionId": sid, "prompt": [{"type": "text", "text": text}]}})
    res = wait(mid, 150)
    total = round(time.time() - prompt_sent_at[0], 1)
    ttft = chunks[0][0] if chunks else None
    print(f"\nprompt id={mid}: total={total}s  n_chunks={len(chunks)}  time_to_first_chunk={ttft}s", flush=True)
    if chunks:
        print("  first 6 chunk timings (s):", [c[0] for c in chunks[:6]], flush=True)
        print("  reply preview:", repr("".join(t for _, t in chunks)[:140]), flush=True)

proc.terminate()
