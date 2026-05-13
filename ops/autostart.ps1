# Waits for Rancher Desktop / Docker to become ready, then runs bootstrap.sh.
# Registered as a Task Scheduler task (platform-autostart) — runs at logon.

$docker  = "C:\Program Files\Rancher Desktop\resources\resources\win32\bin\docker.exe"
$bash    = "C:\Program Files\Git\bin\bash.exe"
$script  = "/d/claude-workspace/platform/bootstrap.sh"
$timeout = 180   # seconds to wait for Docker before giving up

$elapsed = 0
while ($elapsed -lt $timeout) {
    try {
        $out = & $docker info 2>&1
        if ($LASTEXITCODE -eq 0) { break }
    } catch {}
    Start-Sleep -Seconds 5
    $elapsed += 5
}

if ($elapsed -ge $timeout) {
    exit 1   # Docker never came up — Task Scheduler will record the failure
}

& $bash -c "bash $script && { bash /d/claude-workspace/platform/openclaw/start.sh; bash /d/claude-workspace/platform/hermes/start.sh; bash /d/claude-workspace/platform/browser-intent/start.sh; }"
