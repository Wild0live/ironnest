<#
.SYNOPSIS
Inspect every hermes-pf-* profile's memory state in one go.

.DESCRIPTION
Dumps, from the Windows host, what each Hermes profile holds in memory across
all three tiers of the hermes-platform stack:

  Tier A (per-profile container)  : /opt/data/SOUL.md, /opt/data/memories/{MEMORY,USER}.md, session count
  Tier B (policy gateway)         : per-profile policy file + gateway health + audit log tail
  Tier C (OpenViking backend)     : workspace tree (only with -ShowOpenviking; mounts volume read-only)

.PARAMETER ProfileName
Restrict output to a single profile (e.g. "wifey"). Default: all running profiles.

.PARAMETER Tail
How many gateway audit log lines to show. Default 20.

.PARAMETER HeadLines
How many lines of each memory file / policy to preview. Default 15. Use -Full for no limit.

.PARAMETER ShowOpenviking
Also dump the OpenViking workspace directory tree (bypasses gateway; admin view).

.PARAMETER Full
Dump full content of every file instead of just the first HeadLines.

.EXAMPLE
.\inspect-memory.ps1
.\inspect-memory.ps1 -ProfileName wifey -Tail 50
.\inspect-memory.ps1 -ShowOpenviking -Full
#>

[CmdletBinding()]
param(
    [string]$ProfileName,
    [int]$Tail = 20,
    [int]$HeadLines = 15,
    [switch]$ShowOpenviking,
    [switch]$Full
)

$ErrorActionPreference = 'Stop'

$PolicyDir          = 'D:\claude-workspace\platform\hermes-platform\policies'
# NB: host port 127.0.0.1:18080 accepts TCP but the Rancher Desktop port forwarder
# doesn't proxy HTTP through reliably. We hit the gateway from inside its own
# docker network via a throwaway alpine container — same way hermes-pf-* do it.
$GatewayNetwork     = 'hermes-platform-app-net'
$GatewayInternal    = 'http://memory-gateway:8080'
$WorkspaceVolume    = 'hermes-platform_openviking-workspace'
$AuditLogVolume     = 'hermes-platform_memory-gateway-log'
$AuditLogFile       = '/log/audit.log'

function Write-Section($Title) {
    Write-Host ''
    Write-Host ('=' * 78) -ForegroundColor Cyan
    Write-Host $Title -ForegroundColor Cyan
    Write-Host ('=' * 78) -ForegroundColor Cyan
}

function Write-SubSection($Title) {
    Write-Host ''
    Write-Host ("--- $Title ---") -ForegroundColor Yellow
}

function Show-FileHead($Path, $Lines) {
    if (-not (Test-Path $Path)) {
        Write-Host "  MISSING: $Path" -ForegroundColor Red
        return
    }
    $all = Get-Content $Path
    $total = $all.Count
    $sizeB = (Get-Item $Path).Length
    Write-Host ("  {0}   {1}B   {2} lines" -f $Path, $sizeB, $total) -ForegroundColor DarkGray
    if ($Full -or $Lines -le 0 -or $total -le $Lines) {
        $all | ForEach-Object { Write-Host "    $_" }
    } else {
        $all | Select-Object -First $Lines | ForEach-Object { Write-Host "    $_" }
        Write-Host ("    ... ($($total - $Lines) more lines)") -ForegroundColor DarkGray
    }
}

# ── 1. Gateway health (via internal docker network — host port is unreliable) ──
Write-Section "Memory Gateway Health  ($GatewayInternal/health  via $GatewayNetwork)"
$healthRaw = docker run --rm --network $GatewayNetwork alpine `
    sh -c "wget -qO- --timeout=5 $GatewayInternal/health 2>&1 || echo GATEWAY_UNREACHABLE"
if ($healthRaw -eq 'GATEWAY_UNREACHABLE' -or -not $healthRaw) {
    Write-Host "  Gateway not reachable from $GatewayNetwork" -ForegroundColor Red
} else {
    try {
        ($healthRaw | ConvertFrom-Json | ConvertTo-Json -Depth 6) -split "`n" |
            ForEach-Object { Write-Host "  $_" }
    } catch {
        Write-Host "  $healthRaw"
    }
}

# ── 2. Enumerate profile containers ──────────────────────────────────────────
$filter = if ($ProfileName) { "name=^hermes-pf-$ProfileName$" } else { 'name=hermes-pf-' }
$containerList = (docker ps --filter $filter --format '{{.Names}}') -split "`n" | Where-Object { $_ }

if (-not $containerList) {
    Write-Host ''
    Write-Host "No matching hermes-pf-* containers running (filter: $filter)" -ForegroundColor Red
    exit 1
}

foreach ($container in $containerList) {
    $pf = $container -replace '^hermes-pf-', ''
    Write-Section "Profile: $pf   (container: $container)"

    # 2a. Policy file (host-side)
    Write-SubSection "Policy file"
    Show-FileHead -Path (Join-Path $PolicyDir "$pf.policy.yaml") -Lines $HeadLines

    # 2b. Container-side memory files + session count
    Write-SubSection "Container filesystem (/opt/data)"
    $headArg = if ($Full) { 0 } else { $HeadLines }
    $script = @"
for f in /opt/data/SOUL.md /opt/data/memories/MEMORY.md /opt/data/memories/USER.md; do
  if [ -f "`$f" ]; then
    size=`$(wc -c < "`$f")
    lines=`$(wc -l < "`$f")
    echo ""
    echo "  [`$f]   `${size}B   `${lines}L"
    if [ "$headArg" -eq 0 ]; then
      sed 's/^/    /' "`$f"
    else
      head -n $headArg "`$f" | sed 's/^/    /'
      if [ "`$lines" -gt $headArg ]; then
        echo "    ... (`$((lines - $headArg)) more lines)"
      fi
    fi
  else
    echo ""
    echo "  [`$f]   MISSING"
  fi
done
echo ""
session_count=`$(ls /opt/data/sessions 2>/dev/null | wc -l)
echo "  [sessions]   `$session_count file(s)"
ls -t /opt/data/sessions 2>/dev/null | head -5 | sed 's/^/    /'
"@
    docker exec $container sh -c $script
}

# ── 3. OpenViking workspace (optional) ───────────────────────────────────────
if ($ShowOpenviking) {
    Write-Section "OpenViking workspace tree  (volume: $WorkspaceVolume, read-only)"
    docker run --rm -v "${WorkspaceVolume}:/data:ro" alpine `
        find /data -maxdepth 5 -type d
}

# ── 4. Audit log tail ────────────────────────────────────────────────────────
Write-Section "Memory Gateway Audit Log (last $Tail entries from $AuditLogVolume)"
docker run --rm -v "${AuditLogVolume}:/log:ro" alpine sh -c `
    "if [ -f $AuditLogFile ]; then tail -n $Tail $AuditLogFile; else echo '(no $AuditLogFile found in volume; ls /log:)'; ls -la /log; fi"

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
