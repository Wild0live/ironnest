# Launches Rancher Desktop at logon, gated on system dependencies to avoid
# race conditions. Registered as Task Scheduler task 'rancher-desktop-autostart'
# for user phoenix.

$ErrorActionPreference = 'Stop'

$rdExe       = 'C:\Program Files\Rancher Desktop\Rancher Desktop.exe'
$platformDir = 'D:\claude-workspace\platform'
$timeout     = 180   # seconds per dependency

function Wait-For {
    param([string]$Description, [scriptblock]$Check)
    $elapsed = 0
    while ($elapsed -lt $timeout) {
        try { if (& $Check) { return } } catch {}
        Start-Sleep -Seconds 3
        $elapsed += 3
    }
    Write-Error "Timed out waiting for: $Description"
    exit 1
}

Wait-For 'vmcompute service Running' {
    (Get-Service vmcompute -ErrorAction SilentlyContinue).Status -eq 'Running'
}

Wait-For 'WSLService Running' {
    (Get-Service WSLService -ErrorAction SilentlyContinue).Status -eq 'Running'
}

Wait-For 'wsl --status responsive' {
    wsl.exe --status 2>&1 | Out-Null
    $LASTEXITCODE -eq 0
}

Wait-For "platform directory $platformDir reachable" {
    Test-Path -LiteralPath $platformDir
}

if (Get-Process -Name 'Rancher Desktop' -ErrorAction SilentlyContinue) {
    exit 0   # Already running — nothing to do
}

Start-Sleep -Seconds 15   # Settle delay after deps are ready, before launching RD

Start-Process -FilePath $rdExe -WindowStyle Hidden
