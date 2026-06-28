#!/usr/bin/env python3
"""Submit Little John's approval-gated Trivy scan request."""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


POWERSHELL_TEMPLATE = r"""$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$severity = '__SEVERITY__'
$scanTimeout = '__SCAN_TIMEOUT__'
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$stackDir = 'D:\claude-workspace\platform\security\trivy'
$reportRoot = 'E:\rancher-stack-backups\trivy'
$runName = "littlejohn-running-$stamp"
$outDir = Join-Path $reportRoot $runName

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$summary = [ordered]@{
    requested_by = 'littlejohn'
    started_at = (Get-Date).ToString('o')
    severity = $severity
    scan_timeout = $scanTimeout
    stack_dir = $stackDir
    report_dir = $outDir
    containers = @()
    images = @()
    scans = @()
    notes = @()
}

if (-not (Test-Path $stackDir)) {
    throw "Trivy stack directory not found: $stackDir"
}

$docker = Get-Command docker -ErrorAction Stop
$summary.docker = $docker.Source

$rawContainers = @(& docker ps --format '{{json .}}')
foreach ($line in $rawContainers) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
        $c = $line | ConvertFrom-Json
        $summary.containers += [ordered]@{
            id = $c.ID
            name = $c.Names
            image = $c.Image
            status = $c.Status
            networks = $c.Networks
        }
    } catch {
        $summary.notes += "Could not parse docker ps row: $line"
    }
}

$images = @($summary.containers | ForEach-Object { $_.image } | Where-Object { $_ } | Sort-Object -Unique)
$summary.images = @($images)

if ($images.Count -eq 0) {
    $summary.notes += 'No running containers were returned by docker ps.'
} else {
    $ErrorActionPreference = 'Continue'
    Push-Location $stackDir
    try {
        foreach ($image in $images) {
            $safe = ($image -replace '[^A-Za-z0-9._-]', '_')
            $jsonOut = "/reports/$runName/$safe.json"
            $txtOut = "/reports/$runName/$safe.txt"
            $scan = [ordered]@{ image = $image; json = Join-Path $outDir "$safe.json"; table = Join-Path $outDir "$safe.txt"; ok = $true; errors = @() }

            & docker compose run --rm scanner image --timeout $scanTimeout --severity $severity --format json -o $jsonOut $image 2>&1 | Out-File -FilePath (Join-Path $outDir "$safe.json.log") -Encoding utf8
            if ($LASTEXITCODE -ne 0) {
                $scan.ok = $false
                $scan.errors += "JSON scan failed with exit code $LASTEXITCODE"
            }

            & docker compose run --rm scanner image --timeout $scanTimeout --severity $severity --format table -o $txtOut $image 2>&1 | Out-File -FilePath (Join-Path $outDir "$safe.txt.log") -Encoding utf8
            if ($LASTEXITCODE -ne 0) {
                $scan.ok = $false
                $scan.errors += "table scan failed with exit code $LASTEXITCODE"
            }
            $summary.scans += $scan
        }
    } finally {
        Pop-Location
    }
}

$summary.finished_at = (Get-Date).ToString('o')
$summary.ok = -not @($summary.scans | Where-Object { -not $_.ok }).Count
$summaryPath = Join-Path $outDir 'summary.json'
$summary | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryPath -Encoding utf8

Write-Output "Little John Trivy scan request completed."
Write-Output "Report directory: $outDir"
Write-Output "Summary: $summaryPath"
exit 0
"""


def read_submit_token() -> str:
    token = os.environ.get("MC_HOST_OPERATIONS_SUBMIT_TOKEN", "").strip()
    if token:
        return token
    path = os.environ.get(
        "MC_HOST_OPERATIONS_SUBMIT_TOKEN_FILE",
        "/run/secrets/littlejohn-host-operations-submit-token",
    )
    try:
        return open(path, encoding="utf-8").read().strip()
    except OSError:
        return ""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--severity", default="HIGH,CRITICAL",
                        help="Comma-separated Trivy severities to report.")
    parser.add_argument("--reason", default=(
        "Scan all currently running container images with the existing Trivy "
        "server/scanner path and write reports under the Trivy backup directory."
    ))
    parser.add_argument("--scan-timeout", default="5m",
                        help="Per-image Trivy timeout, e.g. 5m or 300s.")
    args = parser.parse_args()

    severity = ",".join(
        part.strip().upper() for part in args.severity.split(",") if part.strip()
    )
    allowed = {"UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"}
    if not severity or any(part not in allowed for part in severity.split(",")):
        print("invalid severity list", file=sys.stderr)
        return 2

    url = os.environ.get("MC_HOST_OPERATIONS_URL", "http://mission-control:8080").rstrip("/")
    token = read_submit_token()
    if not url or not token:
        print("Little John host-operation submission is not configured", file=sys.stderr)
        return 2

    scan_timeout = args.scan_timeout.strip()
    if not scan_timeout or any(ch not in "0123456789hms" for ch in scan_timeout.lower()):
        print("invalid scan timeout", file=sys.stderr)
        return 2

    script = (POWERSHELL_TEMPLATE
              .replace("__SEVERITY__", severity)
              .replace("__SCAN_TIMEOUT__", scan_timeout))
    body = json.dumps({
        "action": "host_powershell",
        "target": "Trivy scan of running container images",
        "reason": args.reason,
        "script": script,
        "risk": "low",
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{url}/api/operations/requests/littlejohn",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Operations-Submit-Token": token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            print(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        print(exc.read().decode("utf-8", "replace"), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
