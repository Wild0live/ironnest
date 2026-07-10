$ErrorActionPreference = "Stop"

$taskName = "IronNest Scoped Remediation Runner"
$runnerScript = Join-Path $PSScriptRoot "start-queue-runner.ps1"
$userId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  throw "Run this installer from an elevated PowerShell window."
}

if (-not (Test-Path $runnerScript)) {
  throw "Runner script not found: $runnerScript"
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 30) `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)
$runAs = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $runAs `
  -Description "Runs IronNest's allowlisted Windows remediation queue runner. Does not execute arbitrary host PowerShell unless HOST_OPERATIONS_ALLOW_RAW_POWERSHELL=1 is set." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host "Installed and started scheduled task: $taskName"
Write-Host "Runner: $runnerScript"
Write-Host "Mode: scoped remediation runner"
