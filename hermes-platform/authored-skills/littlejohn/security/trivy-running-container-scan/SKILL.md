---
name: trivy-running-container-scan
description: "Request an approval-gated Trivy scan of images used by currently running IronNest containers. Use when the operator asks Little John to scan live containers with Trivy."
version: 1.0.0
platforms: [linux]
metadata:
  hermes:
    tags: [security, trivy, containers, vulnerability-scanning, approval-gated]
    related_skills: [wazuh-query, nvd-epss-kev-lookup]
---

# Trivy Running Container Scan

## What this gives you

You can request a Trivy vulnerability scan for the images behind the containers
that are running on the Windows/Rancher Desktop host. The scan uses the existing
IronNest Trivy stack:

- `trivy-server` keeps the vulnerability DB warm.
- The one-shot `scanner` container talks to `socket-proxy`, not to the raw Docker
  socket.
- Reports are written under `E:\rancher-stack-backups\trivy\`.

This is approval-gated. You may submit the exact scan request, but the operator
must approve it in Mission Control before it runs. Do not claim the scan ran
until Mission Control reports the request executed.

## Request a Scan

Run this from Little John's container:

```sh
python3 /opt/data/skills/security/trivy-running-container-scan/request-trivy-running-container-scan.py
```

Optional severity override:

```sh
python3 /opt/data/skills/security/trivy-running-container-scan/request-trivy-running-container-scan.py \
  --severity HIGH,CRITICAL,MEDIUM
```

The tool submits a `host_powershell` approval request through Mission Control's
Little John endpoint. It reads the submit token from the mounted token file; do
not print or expose the token.

## Report Handling

After approval and execution, the host job creates a timestamped directory:

```text
E:\rancher-stack-backups\trivy\littlejohn-running-<timestamp>\
```

Expected files:

- `summary.json` - container/image list, report directory, success/failure status.
- `<image>.json` - machine-readable Trivy output per unique running image.
- `<image>.txt` - table output per unique running image.

Use `summary.json` first. Then read the per-image JSON files for exact CVEs and
enrich important CVEs with the `nvd-epss-kev-lookup` skill before ranking risk.

## Boundaries

- Do not request raw Docker socket access.
- Do not request `docker compose down`, volume deletion, port rebinding, or
  network topology changes as part of a scan.
- If Trivy or Docker is unavailable, report the failure and the evidence path;
  do not invent scan results.
