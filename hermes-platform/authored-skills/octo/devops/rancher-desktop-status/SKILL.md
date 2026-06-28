---
name: rancher-desktop-status
description: "Check whether the Rancher Desktop Docker daemon is reachable, inspect container state through IronNest's read-only Docker proxy, and propose allowed lifecycle actions for operator approval. Use when asked whether Rancher Desktop, Docker, or a container stack is running, unavailable, or healthy."
---

# Rancher Desktop status

Use the read-only Docker socket proxy at `http://socket-proxy:2375`. It is
reachable from this profile and does not allow Docker mutations. Run every
request directly; `socket-proxy` is in `NO_PROXY`.

## Establish daemon availability

```sh
curl -fsS --max-time 5 http://socket-proxy:2375/_ping
curl -fsS --max-time 5 http://socket-proxy:2375/info
```

Interpret the result precisely:

- `_ping` returns `OK` and `/info` returns JSON: the Docker daemon backing
  Rancher Desktop is reachable. Say this confirms the Docker engine, not the
  Rancher Desktop GUI process.
- Timeout, DNS failure, connection refusal, or non-2xx response: the daemon
  is not reachable from this platform. Report the exact failure; do not claim
  Rancher Desktop is stopped, because this can also be a network/proxy fault.

## Inspect the requested workload

Do not infer workload health from daemon reachability. Query the target by
name and inspect its state, health, restart count, and last exit error.

```sh
name='<exact-container-name>'
curl -fsS --max-time 5 "http://socket-proxy:2375/containers/json?all=1&filters=%7B%22name%22%3A%5B%22${name}%22%5D%7D"
curl -fsS --max-time 5 "http://socket-proxy:2375/containers/${name}/json"
```

From `/containers/<name>/json`, report:

- `State.Status` (`running`, `exited`, etc.)
- `State.Health.Status` when present (otherwise say no Docker healthcheck is
  defined)
- `RestartCount`, `State.ExitCode`, `State.OOMKilled`, and `State.Error`

For an overview of running workloads, use:

```sh
curl -fsS --max-time 5 http://socket-proxy:2375/containers/json
```

## Boundaries

- This is observability only. Never try to call Docker write endpoints or use
  the Docker socket/CLI directly.
- If a change is needed, use the installed `approval-gated-operations` skill.
  It can submit a precise proposal to Mission Control; an operator must approve
  it before the private, single-use operations runner acts. Never present a
  proposed or approved action as completed until Mission Control confirms it
  executed.
- Only the runner's allowlisted profile lifecycle actions and the constrained
  `factory-*` Docker API shapes are eligible. Rancher Desktop itself, arbitrary
  Docker commands, and direct socket access are never available to you.
- A running container or passing Docker healthcheck is not proof that its
  browser route works. If the user asks whether an app is usable, verify its
  actual endpoint separately.
- Do not expose environment variables, labels, mounts, or raw inspect output
  unless needed; they can contain sensitive details. Summarize the relevant
  status fields instead.
