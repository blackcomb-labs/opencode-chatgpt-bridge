#!/bin/bash
# Health + process status. Never prints the token.
set -euo pipefail

STATE="${OPENCODE_BRIDGE_STATE_DIR:-$HOME/.opencode-chatgpt-bridge}"
PORT="${OPENCODE_BRIDGE_PORT:-8787}"
PID_FILE="$STATE/bridge.pid"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "process: running (pid $(cat "$PID_FILE"))"
else
  echo "process: stopped"
fi

if curl -fsS "http://127.0.0.1:${PORT}/health" 2>/dev/null; then
  echo
else
  echo "health: unreachable on port ${PORT}"
  exit 1
fi
