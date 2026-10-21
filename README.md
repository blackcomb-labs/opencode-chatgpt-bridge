# opencode-chatgpt-bridge (v2 port)

A local MCP bridge that lets **ChatGPT** read, drive, and review **opencode v2** sessions running on your own machine.

```
ChatGPT / ChatGPT mobile
  -> authenticated HTTPS (Cloudflare quick tunnel / Tailscale Funnel / OpenAI tunnel)
  -> opencode-chatgpt-bridge  /mcp
  -> local `opencode serve` (v2 API)
  -> your repo
```

This is a fork of [yuga-hashimoto/opencode-chatgpt-bridge](https://github.com/yuga-hashimoto/opencode-chatgpt-bridge) ported to the **opencode v2 API**.

## Why the port was needed

The upstream bridge was written against opencode v1. In v2 the API moved under `/api`, responses are wrapped in `{ data: ... }`, and messages are a discriminated union (`user` → `text`, `assistant` → `content[]`, `idle` → `outcome`). Upstream calls like `POST /session` now return the web UI's HTML shell, so every tool failed.

What changed here:

| v1 (upstream) | v2 (this fork) |
|---|---|
| `GET /session` | `GET /api/session` → `{data:[...]}` |
| `POST /session/{id}/message` | `POST /api/session/{id}/prompt` `{text}` |
| `POST /session/{id}/prompt_async` | `prompt` + `delivery: steer \| queue` |
| `POST /session/{id}/abort` | `POST /api/session/{id}/interrupt` |
| `GET /session/status` | `GET /api/session/active` |
| `POST /session/{id}/permissions/{id}` | `POST /api/session/{id}/permission/{requestID}/reply` `{decision}` |
| `GET /file/content`, `/find/file`, `/vcs` | `/api/fs/read/*`, `/api/fs/find`, `/api/vcs/status` |

Preserved from upstream: bearer-token auth, repository allowlist with `realpath` checks, MCP server, tunnel launchers, macOS LaunchAgent, persistent session mapping.

## Requirements

- Node.js 20+
- pnpm 10+
- `opencode` **2.x** installed and logged in
- `cloudflared` (quick tunnel) or Tailscale with HTTPS enabled (optional, for remote access)

```bash
opencode --version   # 2.1.x
```

## Quick start

```bash
pnpm install
pnpm run build

# write a .env with a random token, local-only defaults, and your repo roots
pnpm run init -- --allowed-roots /Users/you/Projects

pnpm start
```

`init` creates `.env` (mode `600`) with:

- `OPENCODE_BRIDGE_TOKEN` — random, 64 hex chars
- `OPENCODE_BRIDGE_TUNNEL=none` — local testing default
- `OPENCODE_BRIDGE_ALLOW_QUERY_TOKEN=false` — header auth only
- `OPENCODE_BRIDGE_ALLOWED_ROOTS` — your colon-separated repo roots

## Tools

Bridge / project:

- `bridge_health` — config, managed opencode servers, v2 version
- `list_projects` — git repos under the allowed roots

Session lifecycle:

- `opencode_start` / `opencode_stop` — manage the per-repo `opencode serve` process
- `opencode_list_sessions` — bridge sessions **and** real opencode sessions (filtered to allowed roots)
- `opencode_create_session` — new v2 session + bridge id
- `opencode_attach_session` — **attach to an existing session** (e.g. the one in your TUI); no new session created

Talking:

- `opencode_send_message` — accepts immediately; `wait=true` blocks up to `timeoutMs`
- `opencode_wait_for_completion` — bounded poll (max 120 s), returns `timedOut` instead of hanging
- `opencode_get_messages` — oldest-first transcript; `sinceMessageId` returns only newer messages (no duplicates when polling)
- `opencode_get_session_status` — running/idle, last outcome, pending permissions

Review:

- `opencode_get_diff` — per-turn diff
- `opencode_vcs_status`, `opencode_read_file`, `opencode_find_files`
- `opencode_capabilities` — agents, commands, providers, config

Permissions:

- `opencode_list_permissions` — what opencode is waiting on
- `opencode_respond_permission` — explicit `once | always | reject`. There is no auto-approve path.

## Attaching to your real session

opencode records a session's `location.directory` as the directory you launched it from, **not** the repo you edited. If you usually run `opencode` from your home directory, your sessions live at `~`, and `~/Projects` alone will not let ChatGPT see them.

`opencode_attach_session` deliberately refuses to re-home a session: if a session's directory is outside the allowlist, the call fails instead of silently using a different repo.

```jsonc
// narrow: only repos started inside ~/Projects are visible
OPENCODE_BRIDGE_ALLOWED_ROOTS=/Users/you/Projects

// broad: matches sessions started from home (larger blast radius)
OPENCODE_BRIDGE_ALLOWED_ROOTS=/Users/you
```

## Connecting ChatGPT

ChatGPT connects to **remote HTTPS** MCP servers only, so a tunnel is required even though the bridge stays on `127.0.0.1`.

1. `OPENCODE_BRIDGE_TUNNEL=cloudflare pnpm start`, or set it in `.env`.
2. Wait for the printed `Public MCP: https://<random>.trycloudflare.com/mcp`. Quick-tunnel DNS can take **60–90 s** to resolve; retry before assuming failure.
3. In ChatGPT: **Settings → Apps & Connectors → Advanced settings → Developer mode**, then **Connectors → Add custom MCP server**.
4. URL: the printed `/mcp` URL (no token in the URL).
5. Auth: header `Authorization: Bearer <OPENCODE_BRIDGE_TOKEN from .env>`.

Prefer Tailscale Funnel or OpenAI Secure MCP Tunnel for anything long-lived: quick-tunnel hostnames are random and rotate on restart.

## Security model

- `opencode serve` binds `127.0.0.1` only; only the bridge is exposed.
- Bearer token required on `/mcp` and on `/health` details.
- Query-token (`?token=`) and path-token auth are **off by default** because URLs end up in tunnel logs.
- Host headers are validated (exact + `*.domain`) to keep DNS-rebinding protection while allowing tunnels.
- Repos must resolve under `OPENCODE_BRIDGE_ALLOWED_ROOTS`; sessions outside it are neither listed nor attachable.
- File reads reject `..` traversal.
- Diffs are first-class: review before committing.
- Permission requests are surfaced, never auto-approved.

## Testing

```bash
pnpm run typecheck
pnpm test            # 19 unit tests
pnpm run build
pnpm run e2e         # 27 end-to-end checks over real MCP Streamable HTTP
node scripts/tunnel-check.mjs   # optional: HTTPS + Host guard + auth over a quick tunnel
```

The e2e suite boots a throwaway git repo, starts the bridge, spawns `opencode serve`, and exercises round-trips, multi-turn context, attach, incremental polling, bounded waits, diffs, permissions, and path-escape rejection.

## macOS background service

```bash
pnpm run build
pnpm run install-service
pnpm run service-status
```

Logs: `~/.opencode-chatgpt-bridge/bridge.log` and `bridge.err.log`.

## Known limitations

- The v2 HTTP API is young; response shapes can change between minor releases.
- Completion is detected via `idle` markers, not server-sent events.
- No streaming: ChatGPT polls with `sinceMessageId`.
- One composer per session: bridged prompts and your own typing in the same TUI session will interleave.

## License

MIT
