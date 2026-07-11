# IronNest Local Host Runners

These scripts run on the Windows host and consume Mission Control's private
host-operation queue.

## Recommended: SYSTEM scoped remediation runner

This is the durable low-friction lane for Little John. It installs a Windows
scheduled task that runs the allowlisted remediation runner as
`NT AUTHORITY\SYSTEM`. It still does **not** execute arbitrary agent-submitted
PowerShell; it only runs built-in remediations whose `remediation_id` is
allowlisted.

Install once from an elevated PowerShell window:

```powershell
Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File','D:\claude-workspace\platform\hermes-platform\local-host-runner\install-scoped-remediation-system-task.ps1'
```

The task starts immediately and again at Windows startup.

Runtime evidence is written under `C:\ProgramData\IronNest\Logs\`:

- `install-scoped-remediation-system-task.log`
- `scoped-remediation-task-status.json`
- `host-operation-runner.log`

## Manual window: scoped remediation runner

Start:

```powershell
Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File','D:\claude-workspace\platform\hermes-platform\local-host-runner\start-queue-runner.ps1'
```

By default, `start-queue-runner.ps1` launches
`scoped-remediation-runner.py`. This runner does **not** execute arbitrary
agent-submitted PowerShell. It only executes built-in remediations whose
`remediation_id` is allowlisted.

Current allowlist:

- `cis-windows-top5-v1`
- `host_filesystem` structured transactions for `default`, `littlejohn`, and
  `octo` (prepare first, commit by separate approval)

Little John should submit a host operation with:

```bash
/opt/ironnest/request-host-operation.py \
  "CIS Windows remediation on DESKTOP-0ON8AF0" \
  --script-file /path/to/operator-review-plan.ps1 \
  --reason "Apply approved CIS local host remediation" \
  --remediation-id cis-windows-top5-v1 \
  --risk high
```

The script remains visible in Mission Control for human review, but the scoped
runner ignores it and executes its local implementation for the remediation ID.

## Host filesystem transaction lane

The same runner also consumes approved `host_filesystem` jobs. This lane gives
approved profiles broad local-folder reach without mounting host directories
into containers.

Transaction modes:

- `prepare`: list/read files and stage future write/mkdir/delete/copy/move
  operations under `host-operations-queue\filesystem-transactions\<op-id>`.
- `commit`: apply the staged changes from a previous `prepare_request_id`.

Both modes require Mission Control approval. The runner rejects UNC paths,
device paths, alternate data streams, and Windows reparse points.

Example prepare body:

```json
{
  "mode": "prepare",
  "profile": "default",
  "operations": [
    {"op": "list", "path": "D:\\claude-workspace", "max_entries": 50},
    {
      "op": "stage_write",
      "path": "D:\\claude-workspace\\codex-tmp\\host-fs-smoke.txt",
      "content_b64": "SGVsbG8K",
      "overwrite": true
    }
  ]
}
```

Example commit body:

```json
{"mode": "commit", "profile": "default", "prepare_request_id": "op-00000000000000000000000000000000"}
```

## Explicit raw PowerShell mode

Raw mode is the old behavior: approved `host_powershell` jobs execute exactly
the submitted script as administrator. Use it only for exceptional operator-led
maintenance:

```powershell
$env:HOST_OPERATIONS_ALLOW_RAW_POWERSHELL = "1"
Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File','D:\claude-workspace\platform\hermes-platform\local-host-runner\start-queue-runner.ps1'
```

Close any raw-mode runner before using scoped mode.
