#!/bin/sh
# Codex / ChatGPT desktop `http_headers_helper`.
# Prints the Authorization header as JSON so the bearer token never has to live
# in ~/.codex/config.toml. Reads the token from the bridge's private .env.
set -eu

ENV_FILE="${OPENCODE_BRIDGE_ENV:-$(cd "$(dirname "$0")/.." && pwd)/.env}"

if [ ! -r "$ENV_FILE" ]; then
  echo "{\"error\":\"missing $ENV_FILE\"}" >&2
  exit 1
fi

TOKEN=$(sed -n 's/^OPENCODE_BRIDGE_TOKEN=//p' "$ENV_FILE" | head -n 1 | tr -d '\r')

if [ -z "$TOKEN" ]; then
  echo '{"error":"OPENCODE_BRIDGE_TOKEN not set"}' >&2
  exit 1
fi

printf '{"Authorization":"Bearer %s"}\n' "$TOKEN"
