#!/usr/bin/env node
/**
 * MCP stdio -> HTTP proxy for the opencode-chatgpt-bridge.
 *
 * The ChatGPT/Codex desktop plugin system launches MCP servers as local
 * processes. This proxy is that process: it speaks MCP over stdio on one side
 * and talks to the local bridge (Streamable HTTP) on the other.
 *
 * Why a proxy instead of pointing the plugin straight at http://127.0.0.1:8787:
 *   - the bearer token stays in the bridge's private .env and is never written
 *     into a plugin manifest, a URL, or a log;
 *   - the plugin can bring the bridge up on demand, so a fresh chat works even
 *     if the bridge was not started manually.
 *
 * No tool logic lives here: every request is forwarded verbatim.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEnv(root) {
  const env = {};
  const file = join(root, ".env");
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return env;
}

function resolveBridgeRoot() {
  if (process.env.OPENCODE_BRIDGE_ROOT) return process.env.OPENCODE_BRIDGE_ROOT;
  const pointer = join(homedir(), ".opencode-chatgpt-bridge", "bridge-root");
  if (existsSync(pointer)) return readFileSync(pointer, "utf8").trim();
  // Fall back to walking up from this script (repo checkout layout).
  return join(import.meta.dirname, "..");
}

async function isHealthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureBridge(root, port) {
  if (await isHealthy(port)) return true;
  const starter = join(root, "scripts", "bridge-start.sh");
  if (!existsSync(starter)) return false;
  const child = spawn(starter, [], { cwd: root, detached: true, stdio: "ignore" });
  child.unref();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(500);
    if (await isHealthy(port)) return true;
  }
  return false;
}

async function main() {
  const root = resolveBridgeRoot();
  const env = readEnv(root);
  const port = Number(env.OPENCODE_BRIDGE_PORT ?? 8787);
  const token = env.OPENCODE_BRIDGE_TOKEN;

  if (!token) {
    throw new Error(`No OPENCODE_BRIDGE_TOKEN found in ${join(root, ".env")}`);
  }
  if (!(await ensureBridge(root, port))) {
    throw new Error(
      `The opencode bridge is not reachable on 127.0.0.1:${port} and could not be started. ` +
        `Run ${join(root, "scripts/bridge-start.sh")} and check ${join(root, ".env")}.`
    );
  }

  const client = new Client({ name: "opencode-bridge-plugin", version: "1.0.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  );

  const server = new Server(
    { name: "opencode-bridge", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: client.getInstructions()
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => await client.listTools());
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    await client.callTool(request.params, undefined, { timeout: 300_000 })
  );

  await server.connect(new StdioServerTransport());

  const shutdown = async () => {
    await client.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  process.stderr.write(`opencode-bridge plugin failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
