# OpenCode ChatGPT Bridge

**Connect ChatGPT to existing OpenCode v2 sessions over MCP — with Windows support, scoped project access, and an optional prompt-send mode.**

[日本語](README.ja.md) · [Security](#security-and-trust-boundaries) · [Windows setup](#quick-start-windows) · [Configuration](#configuration)

This project lets an MCP client discover existing OpenCode sessions, read their history, send follow-up instructions (if explicitly enabled), wait for completion, and inspect diffs. It is designed to work with an **already-running OpenCode v2 background service**; it can also manage OpenCode processes when full-access mode is explicitly enabled.

```text
ChatGPT / MCP client
        │  (authenticated MCP connection)
        ▼
Optional HTTPS / OAuth gateway  [not included in this repository]
        │
        ▼
OpenCode ChatGPT Bridge  http://127.0.0.1:8787/mcp
        │  (OpenCode v2 API)
        ▼
Existing OpenCode service  →  existing sessions / project directories
```

> **Security note:** “Send-only” limits **which MCP tools** the client can invoke. A prompt sent to an OpenCode agent can still cause that agent to edit files or run commands according to its own permissions. It is **not** a filesystem read-only guarantee.

## Features

- **OpenCode v2 API support** — uses `/api/session`, `/api/session/{id}/prompt`, and v2 response shapes.
- **Existing-session attachment** — connect to sessions already used by the OpenCode TUI without creating new sessions.
- **Bidirectional workflow** — send a prompt, obtain the reply, monitor completion, and inspect changes.
- **Windows support** — Windows path-list handling (`;`), native service reuse, and a portable example launcher.
- **Restricted MCP tool sets** — 12 read-only tools by default, or 13 with explicit prompt sending enabled.
- **Scoped project access** — restrict discoverable sessions and file access to configured directories.
- **Bearer-token authentication** — for the local Bridge MCP endpoint; a separate OAuth gateway may be used for ChatGPT web access.
- **Credential exposure reduction** — denylist checks for common credential file paths; raw provider configuration is not exposed by the restricted tool set.

### Tool access modes

| Mode | `OPENCODE_BRIDGE_READ_ONLY` | `OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE` | Exposed MCP tools | Scope |
|---|---|---|---|---|
| Default | `true` | `false` (default) | 12 | Read/list/attach/review only |
| **Read + send** | `true` | `true` | **13** | Above + `opencode_send_message` |
| Full access | `false` | any | 19 | Includes create, start/stop, interrupt, and permission-reply tools |

In **read + send** mode, `opencode_create_session`, `opencode_start`, `opencode_stop`, `opencode_abort`, `opencode_respond_permission`, and `opencode_capabilities` are not published. Attaching records a Bridge mapping; it does **not** create an OpenCode session.

## Requirements

- Windows (tested for this fork) or a Unix-like system supported by the existing scripts.
- Node.js **20+** and `pnpm` **10+**.
- OpenCode **v2**, installed and configured with the desired provider/model.
- For read-only or read + send mode: an **already-running and reachable OpenCode service** (or a correctly configured existing server). These modes refuse to spawn a new OpenCode server automatically.
- For ChatGPT web/mobile access: a compatible **HTTPS/MCP authentication setup**, such as an independent OAuth-capable gateway. The Gateway used during development is **not bundled** with this repository.

## Quick start: Windows

Run in PowerShell. Change `C:\Projects\my-repo` to a **real, narrowly scoped** project directory.

```powershell
git clone https://github.com/blackcomb-labs/opencode-chatgpt-bridge.git
Set-Location .\opencode-chatgpt-bridge
pnpm install
pnpm run build
node .\dist\cli.js init --allowed-roots "C:\Projects\my-repo"
```

The `init` command creates a **local `.env`** with a generated Bridge bearer token. The `.env` file is ignored by Git. **Do not publish or paste its token.** If `.env` already exists, `init` leaves it unchanged unless you deliberately use `--force`.

Edit `.env` and ensure these settings exist (update an existing line rather than creating duplicates):

```dotenv
OPENCODE_BRIDGE_HOST=127.0.0.1
OPENCODE_BRIDGE_PORT=8787
OPENCODE_BRIDGE_AUTO_PORT=false
OPENCODE_BRIDGE_TUNNEL=none
OPENCODE_BRIDGE_USE_SERVICE=true
OPENCODE_BRIDGE_READ_ONLY=true
OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE=false
OPENCODE_BRIDGE_ALLOWED_ROOTS=C:\Projects\my-repo
# Keep the generated OPENCODE_BRIDGE_TOKEN from init.
```

Set `OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE=true` **only if you want ChatGPT to send instructions** to existing sessions. Multiple Windows roots use `;`, for example `C:\Projects\one;D:\Work\two` (macOS/Linux use `:`).

Make sure your OpenCode v2 background service is running. In the service-reuse configuration, the Bridge reads the service connection information from `OPENCODE_BRIDGE_SERVICE_CONFIG`, which defaults to your user profile's `.local/state/opencode/service.json`. If the service cannot be reused, restricted modes fail rather than launching a new OpenCode instance.

Start the Bridge:

```powershell
.\scripts\start-windows.example.bat
```

Or use `pnpm start`. The launcher sets no machine-specific paths and contains no credentials. It uses the `.env` you configured; the window stays open while the Bridge runs. With an already-running service, the fixed Bridge endpoint is `http://127.0.0.1:8787/mcp`.

Test the local health endpoint:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

A public health response is deliberately minimal; detailed information requires the Bridge bearer token. Health alone does not prove a session can be reached — use the MCP `bridge_health` and `opencode_list_sessions` tools through an authorized client.

### Connecting ChatGPT through an OAuth gateway

A direct localhost endpoint is not reachable from the ChatGPT web service. If using ChatGPT web, deploy a separately configured HTTPS gateway that supports the required MCP authentication and forwards requests to `http://127.0.0.1:8787/mcp` using the **Bridge's internal bearer token**, not the user's external OAuth access token.

For **read + send** via such a gateway, both sides must permit the tool:

```dotenv
# Bridge (this repository)
OPENCODE_BRIDGE_READ_ONLY=true
OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE=true

# Example configuration for the independently deployed OAuth gateway:
OPENCODE_MCP_ENABLED=true
OPENCODE_MCP_READ_ONLY=true
OPENCODE_MCP_ALLOW_SEND_MESSAGE=true
```

The `OPENCODE_MCP_*` names describe the **separate gateway used in this project's integration test**. They are not recognized by the Bridge and will not configure an arbitrary gateway. Its source, installation, OAuth keys, domain, and launch scripts are **not part of this repository**. Do not expose the local Bridge publicly without appropriate authentication and transport security.

If tools are added or removed after a restart, the ChatGPT connector may need to be refreshed; a previously opened chat may temporarily retain an older tool schema.

## macOS / other environments

The previous fork's macOS background-service and desktop-plugin helpers are retained:

```bash
pnpm install
pnpm run build
node dist/cli.js init --allowed-roots "$HOME/Projects"
pnpm start
```

Optional existing helpers include `scripts/bridge-start.sh`, `scripts/bridge-status.sh`, `scripts/bridge-stop.sh`, and `scripts/install-codex-plugin.mjs`. The desktop-plugin integration has **not** been validated as part of the Windows + OAuth workflow described here; it requires its own local environment and setup. Do not assume macOS launch helpers work on Windows.

## Working with existing sessions

1. Call `opencode_list_sessions` to discover sessions under the allowed roots.
2. Call `opencode_attach_session` with the actual `opencodeSessionId` (and its project path, when needed).
3. Read history with `opencode_get_messages` and activity with `opencode_get_session_status`.
4. If sending is enabled, call `opencode_send_message` using the resulting **`bridgeSessionId`**. Use `wait=true` for a bounded wait, or poll with `opencode_wait_for_completion` / `opencode_get_messages`.
5. Inspect `opencode_get_diff` and `opencode_vcs_status` before reporting code changes as complete.

**Important:** OpenCode records the session's `location.directory` from where the session was started. This can differ from the repository later edited. The Bridge refuses to attach or send to sessions outside `OPENCODE_BRIDGE_ALLOWED_ROOTS`; it does not silently re-home them. Avoid granting your entire home directory just to expose one test session.

### Verified integration scenario

In the Windows + external OAuth gateway configuration, a short prompt sent to an **existing test session** returned `OK`, with `succeeded` completion, no timeout, and zero file diffs. This confirms a working round-trip in that test environment, **not** automatic compatibility with every ChatGPT plan, OpenCode release, or provider.

## Configuration

| Variable | Default / behavior | Notes |
|---|---|---|
| `OPENCODE_BRIDGE_HOST` | `127.0.0.1` | Keep loopback-only behind a local gateway. |
| `OPENCODE_BRIDGE_PORT` | `8787` | MCP endpoint is `/mcp`. |
| `OPENCODE_BRIDGE_AUTO_PORT` | `true` | Set `false` when a gateway expects a fixed port. |
| `OPENCODE_BRIDGE_TOKEN` | unset unless initialized | **Required for authenticated use.** Keep secret. |
| `OPENCODE_BRIDGE_ALLOWED_ROOTS` | current directory | OS-specific path-list separator (`;` Windows, `:` Unix). Keep narrow. |
| `OPENCODE_BRIDGE_READ_ONLY` | `true` | Restricted mode unless explicitly disabled. |
| `OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE` | `false` | Publish sending tool only when explicitly enabled. |
| `OPENCODE_BRIDGE_USE_SERVICE` | `false` | Set `true` to reuse the existing OpenCode background service. |
| `OPENCODE_BRIDGE_SERVICE_CONFIG` | `~/.local/state/opencode/service.json` | OpenCode service connection metadata (including credentials). |
| `OPENCODE_BASE_URL` | unset | Alternative explicit OpenCode API base URL. |
| `OPENCODE_BRIDGE_TUNNEL` | `none` | Existing launcher also supports `cloudflare` and `tailscale`; secure it before external exposure. |
| `OPENCODE_BRIDGE_ALLOW_QUERY_TOKEN` | `false` | Keep credentials out of URLs and proxy logs. |

See [`.env.example`](.env.example) for the other supported settings.

## Security and trust boundaries

- **MCP tool restrictions are not a sandbox for the underlying agent.** Sending prompts can trigger commands or file writes in OpenCode.
- Never expose a Bridge without a strong bearer token; use HTTPS and proper client authentication for remote access.
- Limit `OPENCODE_BRIDGE_ALLOWED_ROOTS` to specific existing directories. Symlinks and junction escapes are checked for project reads; scope checks are reapplied when sending to an attached session.
- The Bridge blocks traversal and known sensitive filenames such as `.env`, `service.json`, `opencode.json`, and common key files. **This is not a comprehensive secret detector:** normal source files, session transcripts, tool output, and diffs can still contain secrets.
- `opencode_capabilities` is **not exposed** in restricted modes. In full access, it returns a reduced, names-only view rather than raw provider/config objects.
- The Bridge does not automatically approve OpenCode permission requests in restricted mode. Full access exposes additional operations and should only be used with trusted clients.
- Do not commit `.env`, access tokens, machine-specific credential stores, private launch scripts, or logs. Before publishing, scan **both staged changes and Git history** (for example with Gitleaks). Rotate any credential that was already disclosed; code changes cannot revoke past exposure.
- This Bridge and an optional OAuth gateway have **independent allowlists**. Enabling sending at the Bridge does not make it available through a gateway that still rejects it.

## Testing

```powershell
pnpm run validate      # TypeScript typecheck + Vitest + build
```

The Windows implementation passed **30 unit tests** during the 2026-10-22 integration work. An existing `pnpm run e2e` suite is also provided, but it can start OpenCode and exercise write-capable flows; run it only in a suitable disposable environment. Some older helper scripts, including `scripts/selftest.mjs`, retain environment-specific assumptions and are not part of the Windows acceptance result.

## Fork lineage and license

This is a Windows/security-focused continuation of:

- [overlordxrz-source/opencode-chatgpt-bridge](https://github.com/overlordxrz-source/opencode-chatgpt-bridge) — OpenCode v2 port.
- [yuga-hashimoto/opencode-chatgpt-bridge](https://github.com/yuga-hashimoto/opencode-chatgpt-bridge) — original project.

Released under the **MIT License**. The original copyright and license notice remain in [`LICENSE`](LICENSE).

## AI-assisted Development

This fork was developed with AI assistance, including **OpenCode with DeepSeek** for implementation and testing, and **ChatGPT** for integration verification and documentation.

The bridge is model-agnostic: DeepSeek is not required to use it. You can continue using your preferred models and providers through OpenCode.

AI-assisted changes are subject to the same testing and security checks as other contributions.
