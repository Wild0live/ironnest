$ErrorActionPreference = "Stop"
$logRoot = "C:\ProgramData\IronNest\Logs"
$logPath = Join-Path $logRoot "host-operation-runner.log"
$env:HOST_OPERATIONS_QUEUE = Join-Path $PSScriptRoot "..\host-operations-queue"
$pythonCandidates = @(
  $env:HOST_OPERATIONS_PYTHON,
  "C:\Users\phoenix\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe",
  (Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
) | Where-Object { $_ -and (Test-Path $_) }

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
Start-Transcript -Path $logPath -Append | Out-Null

try {
  if (-not $pythonCandidates) {
    throw "No usable Python executable found. Set HOST_OPERATIONS_PYTHON to python.exe."
  }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal] $identity
  $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $runner = "scoped-remediation-runner.py"
  if ($env:HOST_OPERATIONS_ALLOW_RAW_POWERSHELL -eq "1") {
    $runner = "queue-runner.py"
  }

  Write-Host "IronNest host operation queue runner"
  Write-Host "User:   $($identity.Name)"
  Write-Host "Queue:  $env:HOST_OPERATIONS_QUEUE"
  Write-Host "Python: $($pythonCandidates[0])"
  Write-Host "Admin:  $isAdmin"
  Write-Host "Mode:   $runner"
  Write-Host "Log:    $logPath"
  Write-Host "Leave this window open while Little John executes approved host operations."
  if ($runner -ne "scoped-remediation-runner.py") {
    Write-Warning "RAW POWERSHELL MODE: approved host_powershell jobs will execute as submitted."
  }

  & $pythonCandidates[0] (Join-Path $PSScriptRoot $runner)
} finally {
  Stop-Transcript | Out-Null
}
