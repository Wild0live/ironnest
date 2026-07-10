# IronNest Local Host Runners

These scripts run on the Windows host and consume Mission Control's private
host-operation queue.

## Default: scoped remediation runner

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

## Explicit raw PowerShell mode

Raw mode is the old behavior: approved `host_powershell` jobs execute exactly
the submitted script as administrator. Use it only for exceptional operator-led
maintenance:

```powershell
$env:HOST_OPERATIONS_ALLOW_RAW_POWERSHELL = "1"
Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File','D:\claude-workspace\platform\hermes-platform\local-host-runner\start-queue-runner.ps1'
```

Close any raw-mode runner before using scoped mode.
