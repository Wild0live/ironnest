# Hermes Shared Artifact Exchange

Host-bind volume for **binary artifacts** (files, images, generated output)
that Hermes agents hand off to one another — one agent's output becomes the
next agent's input.

> **This file is the canonical reference for the shared artifact channel.**
> It is visible on the host *and* readable by agents at
> `/opt/shared/all/README.md`. Companion docs (do not duplicate them here):
> - Security analysis / threat tradeoff → `docs/08-SECURITY-MODEL.md` §"Shared artifact exchange"
> - Why it exists & alternatives rejected → `docs/16-DECISION-LOG.md` D-013

## Layout

```
shared/
├── default/      one folder per agent profile
├── mark/         each agent WRITES only its own folder
├── steve/        ...and READS every folder
├── qa/
├── littlejohn/
├── jaime/
├── bigbert/
└── octo/
```

## In-container view

| Path                          | Access      | Maps to (host)            |
|-------------------------------|-------------|---------------------------|
| `/opt/shared/mine/`           | read-write  | `shared/<this-agent>/`    |
| `/opt/shared/all/<agent>/`    | read-only   | `shared/<agent>/`         |

- An agent **writes** its outputs to `/opt/shared/mine/`.
- An agent **reads** a peer's outputs from `/opt/shared/all/<agent>/`.
- `read_only` is enforced at the kernel mount, so an agent physically cannot
  write outside its own folder.
- The `ttyd` operator terminal mounts the whole tree read-write for cleanup.

## Boundaries

- **Not audited.** Unlike OpenViking (`viking://shared`), reads/writes here
  produce no `audit.log` entry. Use it for working artifacts, not secrets.
- **Host-visible.** This directory is `D:\claude-workspace\platform\hermes-platform\shared`
  on the Windows host — browse it directly in Explorer.
- Private per-profile memory (`/opt/data`) and OpenViking isolation are
  unaffected by this volume.

New profiles created via `scripts/provision-profile.sh` get their folder and
mounts automatically.

## Auditable handoff

This channel has no audit trail. When a handoff must be auditable, split it:
write the **blob** to `/opt/shared/mine/<name>` and record a **pointer/summary**
in `viking://shared/approved/<profile>/` (gateway-mediated, logged). The
receiving agent reads the pointer from shared memory, then fetches the blob
from `/opt/shared/all/<sender>/<name>`.

## Verify (after deploy)

```bash
# write-own works:
docker exec hermes-pf-mark sh -c 'echo hi > /opt/shared/mine/test.txt && echo OK'
# cross-agent read works:
docker exec hermes-pf-steve cat /opt/shared/all/mark/test.txt
# write-isolation holds (must FAIL):
docker exec hermes-pf-steve sh -c 'echo x > /opt/shared/all/mark/evil.txt' || echo "isolation OK"
```
