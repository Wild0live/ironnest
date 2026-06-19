#!/usr/bin/env python3
"""One-off probe: does ACP give a warm, low-latency turn? Run inside a profile."""
import subprocess, json, threading, time, sys

HERMES = "/opt/hermes/.venv/bin/hermes"
proc = subprocess.Popen([HERMES, "acp", "--accept-hooks"],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL)
resp, notes, lock = {}, [], threading.Lock()


def send(obj):
    proc.stdin.write((json.dumps(obj) + "\n").encode())
    proc.stdin.flush()


def reader():
    for raw in proc.stdout:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if "id" in msg and ("result" in msg or "error" in msg):
            with lock:
                resp[msg["id"]] = msg
        elif msg.get("method") == "session/update":
            u = msg.get("params", {}).get("update", {})
            if u.get("sessionUpdate") == "agent_message_chunk":
                c = u.get("content", {})
                if c.get("type") == "text":
                    notes.append(c.get("text", ""))
        elif msg.get("method") == "session/request_permission":
            opts = msg.get("params", {}).get("options", [])
            pick = next((o["optionId"] for o in opts
                         if "allow" in (o.get("optionId", "") + o.get("kind", "")).lower()),
                        opts[0]["optionId"] if opts else "allow")
            send({"jsonrpc": "2.0", "id": msg["id"],
                  "result": {"outcome": {"outcome": "selected", "optionId": pick}}})
        elif "id" in msg and "method" in msg:
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})


threading.Thread(target=reader, daemon=True).start()


def wait(i, t):
    end = time.time() + t
    while time.time() < end:
        with lock:
            if i in resp:
                return resp[i]
        time.sleep(0.05)
    return None


t0 = time.time()
send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"protocolVersion": 1,
                 "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}}}})
r1 = wait(1, 120)
print(f"initialize: {round(time.time()-t0,1)}s -> {'OK' if r1 else 'TIMEOUT'}", flush=True)
if not r1:
    proc.terminate(); sys.exit("no initialize response (framing may differ)")

send({"jsonrpc": "2.0", "id": 2, "method": "session/new",
      "params": {"cwd": "/opt/data", "mcpServers": []}})
r2 = wait(2, 60)
sid = (r2 or {}).get("result", {}).get("sessionId")
print(f"session/new -> sessionId={sid}", flush=True)
if not sid:
    print("session/new result:", json.dumps(r2)[:400]); proc.terminate(); sys.exit(1)

for n, (mid, text) in enumerate([(3, "Reply with exactly: pong"),
                                 (4, "Reply with exactly: pong-two"),
                                 (5, "Reply with exactly: pong-three")]):
    notes.clear()
    t = time.time()
    send({"jsonrpc": "2.0", "id": mid, "method": "session/prompt",
          "params": {"sessionId": sid, "prompt": [{"type": "text", "text": text}]}})
    r = wait(mid, 120)
    tag = "COLD" if n == 0 else "WARM"
    stop = (r or {}).get("result", {}).get("stopReason", "TIMEOUT")
    print(f"prompt{n+1} [{tag}]: {round(time.time()-t,1)}s stop={stop} reply={''.join(notes)[:80]!r}", flush=True)

proc.terminate()
