$ErrorActionPreference = "Stop"

$taskName = "IronNest Scoped Remediation Runner"
$legacyTaskNames = @(
  "IronNest Host Operations Runner"
)
$runnerScript = Join-Path $PSScriptRoot "start-queue-runner.ps1"
$queuePath = Resolve-Path (Join-Path $PSScriptRoot "..\host-operations-queue")
$logRoot = "C:\ProgramData\IronNest\Logs"
$logPath = Join-Path $logRoot "install-scoped-remediation-system-task.log"
$statusPath = Join-Path $logRoot "scoped-remediation-task-status.json"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  throw "Run this installer from an elevated PowerShell window. It creates a SYSTEM scheduled task."
}

if (-not (Test-Path $runnerScript)) {
  throw "Runner script not found: $runnerScript"
}

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
Start-Transcript -Path $logPath -Force | Out-Null

try {
  $currentTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($currentTask) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }

  $action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerScript`"" `
    -WorkingDirectory $PSScriptRoot

  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)
  $runAsSystem = New-ScheduledTaskPrincipal `
    -UserId "SYSTEM" `
    -LogonType ServiceAccount `
    -RunLevel Highest

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $runAsSystem `
    -Description "Runs IronNest's allowlisted Windows remediation queue runner as SYSTEM. The runner executes built-in remediation IDs only; it does not execute arbitrary host PowerShell." `
    -Force | Out-Null

  foreach ($name in $legacyTaskNames) {
    $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($existing) {
      Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
  }

  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 2

  $task = Get-ScheduledTask -TaskName $taskName
  $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
  [pscustomobject]@{
    checked_at = (Get-Date).ToString("o")
    task_name = $task.TaskName
    state = [string]$task.State
    principal = [pscustomobject]@{
      user_id = $task.Principal.UserId
      logon_type = [string]$task.Principal.LogonType
      run_level = [string]$task.Principal.RunLevel
    }
    action = [pscustomobject]@{
      execute = $task.Actions.Execute
      arguments = $task.Actions.Arguments
      working_directory = $task.Actions.WorkingDirectory
    }
    info = [pscustomobject]@{
      last_run_time = $taskInfo.LastRunTime
      last_task_result = $taskInfo.LastTaskResult
      next_run_time = $taskInfo.NextRunTime
      number_of_missed_runs = $taskInfo.NumberOfMissedRuns
    }
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statusPath -Encoding UTF8

  Write-Host "Installed and started scheduled task: $taskName"
  Write-Host "Account: NT AUTHORITY\SYSTEM"
  Write-Host "Runner:  $runnerScript"
  Write-Host "Queue:   $queuePath"
  Write-Host "Mode:    scoped remediation runner"
  Write-Host "Log:     $logPath"
  Write-Host "Status:  $statusPath"
} finally {
  Stop-Transcript | Out-Null
}
