#!/bin/bash
# Stop the locally started bridge. Managed opencode servers are stopped too.
set -euo pipefail

STATE="${OPENCODE_BRIDGE_STATE_DIR:-$HOME/.opencode-chatgpt-bridge}"
PID_FILE="$STATE/bridge.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "not running (no pid file)"
  exit 0
fi

PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "not running (stale pid file removed)"
  exit 0
fi

kill -TERM "$PID" 2>/dev/null || true
for _ in $(seq 1 20); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "stopped (pid $PID)"
    exit 0
  fi
  sleep 0.5
done

kill -KILL "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
echo "force-stopped (pid $PID)"
