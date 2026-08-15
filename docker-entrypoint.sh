#!/bin/sh
# Shopping App price feeder — container entrypoint
# The stores block headless Chromium, so we run HEADED by default under a
# virtual display. Xvfb is started manually (the proven-working approach)
# rather than via xvfb-run, which hung on some kernels.
# Set HEADLESS=1 to run truly headless (only useful for Aldi-only runs).
set -e

if [ "$HEADLESS" = "1" ]; then
  exec "$@"
fi

# Headed (default): bring up a virtual X display, then run.
Xvfb :99 -screen 0 1366x900x24 >/dev/null 2>&1 &
sleep 3
export DISPLAY=:99
exec "$@"
