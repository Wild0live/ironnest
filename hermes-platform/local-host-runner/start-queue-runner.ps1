$ErrorActionPreference = "Stop"
$env:HOST_OPERATIONS_QUEUE = Join-Path $PSScriptRoot "..\host-operations-queue"
$pythonCandidates = @(
  $env:HOST_OPERATIONS_PYTHON,
  "C:\Users\phoenix\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe",
  (Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
) | Where-Object { $_ -and (Test-Path $_) }

if (-not $pythonCandidates) {
  throw "No usable Python executable found. Set HOST_OPERATIONS_PYTHON to python.exe."
}

$principal = [Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$runner = "scoped-remediation-runner.py"
if ($env:HOST_OPERATIONS_ALLOW_RAW_POWERSHELL -eq "1") {
  $runner = "queue-runner.py"
}

Write-Host "IronNest host operation queue runner"
Write-Host "Queue:  $env:HOST_OPERATIONS_QUEUE"
Write-Host "Python: $($pythonCandidates[0])"
Write-Host "Admin:  $isAdmin"
Write-Host "Mode:   $runner"
Write-Host "Leave this window open while Little John executes approved host operations."
if ($runner -ne "scoped-remediation-runner.py") {
  Write-Warning "RAW POWERSHELL MODE: approved host_powershell jobs will execute as submitted."
}

& $pythonCandidates[0] (Join-Path $PSScriptRoot $runner)
