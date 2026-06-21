---
name: approval-gated-operations
description: Propose a factory Docker operation to Mission Control for human approval. Use for factory-* container, exec, network, or approved host-bind actions.
---

# Approval-gated operations

You do **not** have Docker socket, Docker CLI, Compose, or approval authority.
Never claim an operation was performed until Mission Control reports that an
operator approved and executed it.

For a requested Docker action, first state the plan clearly: image, container
name, command, exposed ports, factory network, named volumes/bind mounts, and
the reason each is required. Use only `factory-*` container and network names.
Host bind mounts must stay inside the configured factory root.

After the user confirms the plan, submit a proposal. `OCTO_OPERATIONS_SUBMIT_TOKEN`
and `MISSION_CONTROL_URL` are injected at runtime. Do not print either value.

```sh
curl -fsS -X POST "$MISSION_CONTROL_URL/api/operations/requests/octo" \
  -H "Content-Type: application/json" \
  -H "X-Operations-Submit-Token: $OCTO_OPERATIONS_SUBMIT_TOKEN" \
  --data @/tmp/operation-request.json
```

The JSON must use `action: "docker_api"`, a brief human-readable `target`, a
specific `reason`, `method: "POST"`, an API-versioned `path`, and a JSON `body`.
For container creation use:

```json
{
  "action": "docker_api",
  "target": "factory-example",
  "reason": "Run the approved example service.",
  "method": "POST",
  "path": "/v1.47/containers/create?name=factory-example",
  "body": {"Image": "example/image:tag"}
}
```

Report the returned operation request ID and say it is **pending operator
approval**. Do not retry a failed or expired request without explaining why and
creating a fresh proposal. If the action is rejected, report the rejection
verbatim and revise the plan; do not seek another route to Docker.
