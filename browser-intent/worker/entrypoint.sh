#!/bin/sh
set -e

# Headless Chromium ignores DISPLAY, so xvfb-run is only needed when
# BROWSER_INTENT_HEADLESS=false. Skipping xvfb-run in the headless path
# avoids a PID-1 SIGUSR1 race in xvfb-run that silently hangs the worker
# before node ever starts (-e /dev/stderr surfaces Xvfb errors if the
# non-headless path ever hits the same race).
if [ "$BROWSER_INTENT_HEADLESS" = "false" ]; then
    exec xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" -e /dev/stderr node worker.js
fi

exec node worker.js
