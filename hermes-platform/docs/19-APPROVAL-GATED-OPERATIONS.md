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

## Enable it

Create a high-entropy token in the uncommitted `hermes-platform/.env` file:

```powershell
$token = -join ((1..64) | ForEach-Object { 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[(Get-Random -Maximum 62)] })
Add-Content .env "`nOPERATIONS_RUNNER_TOKEN=$token"
Add-Content .env "`nFACTORY_HOST_PATH_ROOTS=D:\claude-workspace\software-factory"
Add-Content .env "`nFACTORY_ALLOWED_IMAGES=nginx:alpine,nginx:1.27-alpine"
Add-Content .env "`nOPERATIONS_ALLOWED_CONTAINERS=hermes-pf-default,hermes-pf-mark,hermes-pf-steve,hermes-pf-qa,hermes-pf-littlejohn,hermes-pf-jaime,hermes-pf-bigbert,hermes-pf-octo,openclaw-gateway,openclaw-ttyd,openclaw-infisical-agent"
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

All endpoints are behind Mission Control authentication and also obey
`MISSION_CONTROL_ADMIN_TOKEN` when configured.

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

## Extending safely

Do not add a generic command endpoint or a standing raw Docker proxy. Add new
operations as individually validated Docker request shapes with an independent
runner-side check, approval requirement, test, and audit output. Host actions
need a separate local privileged service with the same properties; raw
PowerShell or SSH would defeat this design.
