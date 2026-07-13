# Approval-gated operations

`operations-runner` is the only Hermes Platform service that can contact the
Docker socket. Octo and Mission Control never get the socket or a standing
Docker API proxy: they can only submit a precise request for an operator to
approve once.

## Scope of version 1

The runner supports two approval-gated operation classes:

- Profile lifecycle: `start`, `stop`, and `restart` for the eight listed
  `hermes-pf-*` gateways and any other explicitly configured container.
- Factory Docker requests: pull an explicitly allowlisted image, create named
  `factory-*` containers, start/stop/restart them, create and start exec
  sessions, create `factory-*` networks, and connect/disconnect factory
  containers from factory networks.

Each factory request retains its exact HTTP method, Docker API path, and JSON
body in the approval record. The runner rejects all other Docker endpoints. It
does not allow image builds, unallowlisted image pulls, privileged containers, host
network/PID/IPC/UTS/user namespaces, or Windows/host shell commands.

For host bind mounts, set `FACTORY_HOST_PATH_ROOTS` to comma-separated,
approved Docker-host directories. Empty is the safe default: named volumes are
allowed but every host bind mount is rejected. On this Windows/Rancher Desktop
installation, use the exact source form accepted by Docker (for example
`D:\claude-workspace\software-factory`) and ensure the path is shared with
Rancher Desktop.

Requests are persisted in Mission Control and remain pending until an operator
approves them. Approvals expire after 10 minutes by default. The runner keeps a
persistent replay ledger, so a request ID can execute only once.

## LittleJohn's pre-approved Kali lifecycle

LittleJohn has one deliberately narrow pre-approved exception: Mission Control
may immediately execute `start`, `stop`, or `restart` for the exact container
`kali-mcp-littlejohn` when the request comes through LittleJohn's scoped
submission token. The request is still persisted in the Mission Control
operations ledger and still executes through `operations-runner`; it simply does
not pause for an operator click.

This exception does not allow Docker API calls, host PowerShell, new containers,
image changes, network changes, mounts, host ports, privileged mode, or lifecycle
actions for any other container.

## Enable it

Create a high-entropy token in the uncommitted `hermes-platform/.env` file:

```powershell
$token = -join ((1..64) | ForEach-Object { 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[(Get-Random -Maximum 62)] })
Add-Content .env "`nOPERATIONS_RUNNER_TOKEN=$token"
Add-Content .env "`nFACTORY_HOST_PATH_ROOTS=D:\claude-workspace\software-factory"
Add-Content .env "`nFACTORY_ALLOWED_IMAGES=nginx:alpine,nginx:1.27-alpine"
Add-Content .env "`nOPERATIONS_ALLOWED_CONTAINERS=hermes-pf-default,hermes-pf-mark,hermes-pf-steve,hermes-pf-qa,hermes-pf-littlejohn,hermes-pf-jaime,hermes-pf-bigbert,hermes-pf-octo,kali-mcp-littlejohn,openclaw-gateway,openclaw-ttyd,openclaw-infisical-agent"
Add-Content .env "`nOPERATIONS_ALLOW_ALL_CONTAINERS=1"
```

`OPERATIONS_ALLOWED_CONTAINERS` is an exact-name allowlist shared by Mission
Control and the runner. Add a container name here before Octo can propose an
approved start, stop, or restart. Do not use wildcard entries: each container
remains visible and reviewable in the approval record.

Set `OPERATIONS_ALLOW_ALL_CONTAINERS=1` only when Octo is the platform
infrastructure administrator. It permits lifecycle actions for any valid
Rancher Desktop container name, but each exact action and target remains a
single-use, human-approved request; it does not expose a Docker socket or raw
Docker API to Octo.

Create a separate random `OCTO_OPERATIONS_SUBMIT_TOKEN`. Put the same value in
both `hermes-platform/.env` (for Mission Control) and the Infisical secret path
`/hermes-platform/octo` (for Octo). This token can submit a proposal only; it
cannot approve or execute Docker actions.

Rebuild and start it:

```powershell
docker compose build mission-control operations-runner
docker compose --profile operations up -d --no-build mission-control operations-runner
```

For normal restarts, keep it explicitly opt-in:

```powershell
$env:ENABLE_OPERATIONS_RUNNER = "1"
bash ./start.sh
```

Install the staged Octo skill after the token is present:

```powershell
docker cp authored-skills/octo/devops/approval-gated-operations hermes-pf-octo:/opt/data/skills/devops/
docker exec -u root hermes-pf-octo chown -R hermes:hermes /opt/data/skills/devops/approval-gated-operations
docker restart hermes-pf-octo
```

## API flow

All administrative endpoints require a browser cookie that Mission Control
revalidates directly with Authelia and also obey `MISSION_CONTROL_ADMIN_TOKEN`
when configured.

1. `POST /api/operations/requests` creates a proposal; Docker is untouched.
2. `POST /api/operations/{id}/approve` requires the approving operator name
   and sends the exact, single-use request to the private runner network.
3. `GET /api/operations` shows the request ledger.

Example factory-container proposal (`target` is the audit label):

```json
{
  "action": "docker_api",
  "target": "factory-api",
  "reason": "Create the reviewed API service for integration testing.",
  "requested_by": "octo",
  "method": "POST",
  "path": "/v1.47/containers/create?name=factory-api",
  "body": {
    "Image": "ghcr.io/acme/factory-api:2026.06",
    "HostConfig": {
      "Binds": ["D:\\claude-workspace\\software-factory:/workspace:rw"]
    }
  }
}
```

If the image is not already available locally, submit and approve a separate
pull request before creating the container. The image must exactly match an
entry in `FACTORY_ALLOWED_IMAGES`:

```json
{
  "action": "docker_api",
  "target": "factory-image-nginx-alpine",
  "reason": "Pull the reviewed base image required by factory-api.",
  "requested_by": "octo",
  "method": "POST",
  "path": "/v1.47/images/create?fromImage=nginx&tag=alpine",
  "body": {}
}
```

Example approval:

```json
{"approved_by":"Phoenix","note":"Reviewed image, bind path, and command."}
```

## FIDO approval passkey

Mission Control approvals require a registered WebAuthn/passkey credential in
addition to the normal Mission Control session. Use the **Register approval
key** button in Mission Control while browsing
`https://mission.ironnest.local`; the browser will ask for a FIDO key touch and
Mission Control stores only the public credential material.

Every `POST /api/operations/{id}/approve` request must include a fresh WebAuthn
assertion bound to that exact operation ID. Mission Control verifies the RP ID
(`mission.ironnest.local` by default), origin, challenge, signature, and user
presence flag before the request can reach the runner.

Approval credentials are now bound to the immutable Authelia operator subject,
and WebAuthn user verification (security-key PIN or biometric) is required.
Mission Control revalidates the browser cookie directly with Authelia; internal
profile containers cannot become operators by spoofing forwarded identity
headers. Credentials registered before this binding was introduced are listed
as legacy/unbound and must be re-enrolled by each operator.

Mission Control also stores browser-reported authenticator transport metadata
from `PublicKeyCredential.response.getTransports()` and returns it in
`allowCredentials`. Credentials enrolled before transport capture receive a
configurable `usb` fallback hint. A transport value is only a browser-picker
hint: it does not replace the operation-bound challenge, signature, RP ID,
origin, immutable operator ownership, or required user verification checks.
Unknown and duplicate transport values are discarded server-side.

Pending approval discoverability is separate from agent presence. The Agent
picker keeps its lower-right online/working/offline dot and adds an upper-right
amber shield for each requester with `pending_approval` records. The shield
shows `!`, the exact count, or `9+`; selecting it opens the pending Approvals
view filtered to that agent and clears stale search/risk/archive filters. The
indicator is derived from the live operations ledger and disappears when the
requests leave the pending state.

## Octo ten-minute admin session

Mission Control can open exactly one Octo session after an operator-bound FIDO
ceremony. It expires after ten minutes regardless of activity and after two
minutes of inactivity; Octo cannot renew it. Octo retains only its scoped
submission token. The runner independently checks the session ID, expiry,
container enrollment, protected names/labels, and Docker-socket mounts.

Existing workloads may be enrolled by the exact
`OCTO_ADMIN_ELIGIBLE_CONTAINERS` setting. New containers default to denied and
should be recreated with `io.ironnest.octo-admin=eligible` only after operator
review. `io.ironnest.security-boundary=protected`, the protected-name list, and
Docker-socket detection always win.

During the session, `octo-admin.py exec` streams root-command stdout/stderr as
NDJSON through Mission Control; command text is not stored in the general
ledger, only its SHA-256 digest and execution metadata. Lifecycle and validated
factory actions use the same broker. DELETE, kill, and destructive factory
volume/network requests still use the normal proposal and fresh per-operation
FIDO approval flow.

## Windows filesystem transactions

`host_filesystem` is the approved broad-folder lane for Dr. Smith (`default`),
Little John, and Octo. It is intentionally not a host mount, shell, SMB share,
or raw PowerShell wrapper. The profile submits structured JSON, Mission Control
records the proposal, and the local Windows runner performs only the supported
filesystem operations after approval.

Supported `prepare` operations:

- `list` with `path`, optional `recursive`, optional `max_entries`
- `read` with `path`, optional `max_bytes`
- `stage_write` with `path`, `content_b64`, optional `overwrite`
- `stage_mkdir` with `path`
- `stage_delete` with `path`, optional `recursive`
- `stage_copy` with `src`, `dst`, optional `overwrite`
- `stage_move` with `src`, `dst`, optional `overwrite`

`prepare` can read/list immediately and can stage future changes, but it does
not modify target files. The result returns a `transaction_id`. To apply the
staged changes, submit a second request:

```json
{
  "mode": "commit",
  "profile": "octo",
  "prepare_request_id": "op-00000000000000000000000000000000"
}
```

That commit request must also be approved before anything is changed. The runner
rejects UNC paths, device paths, alternate data stream paths, and Windows
reparse points. Execution of host programs is not part of this lane; use a
separate reviewed remediation ID for executable behavior.

Example prepare transaction:

```json
{
  "mode": "prepare",
  "profile": "default",
  "operations": [
    {"op": "list", "path": "D:\\claude-workspace", "max_entries": 50},
    {"op": "read", "path": "D:\\claude-workspace\\README.md", "max_bytes": 65536},
    {
      "op": "stage_write",
      "path": "D:\\claude-workspace\\codex-tmp\\host-fs-smoke.txt",
      "content_b64": "SGVsbG8gZnJvbSBJcm9uTmVzdAo=",
      "overwrite": true
    }
  ]
}
```

Submit from an approved profile container:

```bash
/opt/ironnest/request-host-filesystem.py \
  "Host filesystem prepare: docs smoke test" \
  --transaction-file /opt/shared/mine/host-fs-prepare.json \
  --reason "Read workspace metadata and stage a reviewed write" \
  --risk high
```

For the common read-only case, Dr. Smith and Little John can also submit from
Mission Control chat:

```text
/hostfs list "D:\path\to\folder" --max 200
/hostfs list "D:\path\to\folder" --recursive --max 500
/hostfs read "D:\path\to\folder\file.txt" --max-bytes 65536
```

The chat command only creates a pending `prepare` approval. The operator still
approves it in Mission Control before the Windows runner reads the host path.

## Software vulnerability remediation lane

Little John may request broad localhost software vulnerability remediation after
FIDO approval through the allowlisted remediation ID
`software-vulnerability-remediation-v1`. This is not raw PowerShell execution:
the submitted script is operator-review text, while the local Windows runner
executes only fixed `winget` command shapes from structured JSON.

Payload shape:

```json
{
  "packages": [
    {
      "action": "upgrade",
      "winget_id": "Microsoft.VisualStudioCode",
      "name": "Microsoft Visual Studio Code",
      "publisher": "Microsoft Corporation",
      "scope": "machine",
      "cves": ["CVE-2026-47281"],
      "justification": "Scanner evidence shows vulnerable localhost install."
    }
  ]
}
```

Supported actions are `upgrade`, `install`, and `uninstall` for exact Winget
package IDs. The runner records package metadata and pre/post package state as
evidence. If a software product cannot be safely controlled through this
structured lane, create a new local remediation implementation rather than
enabling raw PowerShell as the default.

## Extending safely

Do not add a generic command endpoint or a standing raw Docker proxy. Add new
operations as individually validated Docker request shapes with an independent
runner-side check, approval requirement, test, and audit output. Host actions
need a separate local privileged service with the same properties; raw
PowerShell or SSH would defeat this design.
