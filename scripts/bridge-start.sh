#!/bin/bash
# Local-only start helper: no autostart, no launchd, no tunnel.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${OPENCODE_BRIDGE_STATE_DIR:-$HOME/.opencode-chatgpt-bridge}"
PORT="${OPENCODE_BRIDGE_PORT:-8787}"
mkdir -p "$STATE"

PID_FILE="$STATE/bridge.pid"
LOG_FILE="$STATE/bridge.log"
ERR_FILE="$STATE/bridge.err.log"
HEALTH="http://127.0.0.1:${PORT}/health"

if [[ ! -x "$ROOT/node_modules/.bin/tsc" ]]; then
  echo "dependencies missing; run: pnpm install" >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "already running (pid $(cat "$PID_FILE")) -> $HEALTH"
  exit 0
fi

cd "$ROOT"
if [[ ! -f dist/cli.js ]]; then
  pnpm run build
fi

nohup node dist/cli.js start >>"$LOG_FILE" 2>>"$ERR_FILE" &
echo $! >"$PID_FILE"

for _ in $(seq 1 40); do
  if curl -fsS "$HEALTH" >/dev/null 2>&1; then
    echo "bridge up: $HEALTH (pid $(cat "$PID_FILE"))"
    exit 0
  fi
  sleep 0.5
done

echo "bridge failed to start. Recent log:" >&2
tail -n 20 "$ERR_FILE" >&2 || true
exit 1
