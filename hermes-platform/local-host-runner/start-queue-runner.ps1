$ErrorActionPreference = "Stop"
$env:HOST_OPERATIONS_QUEUE = Join-Path $PSScriptRoot "..\host-operations-queue"
& python (Join-Path $PSScriptRoot "queue-runner.py")
