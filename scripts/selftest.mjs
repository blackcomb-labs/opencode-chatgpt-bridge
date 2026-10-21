#!/usr/bin/env node
/**
 * Self-test against the *installed* bridge (the one the ChatGPT desktop app
 * talks to). Uses the same URL and bearer token from .env, creates a dedicated
 * throwaway session for write tests, and never touches existing sessions.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const execFileAsync = promisify(execFile);
const ROOT = "/Users/overlord/tools/opencode-chatgpt-bridge-v2";
const env = Object.fromEntries(
  (await readFile(join(ROOT, ".env"), "utf8"))
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
);
const PORT = Number(env.OPENCODE_BRIDGE_PORT ?? 8787);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = env.OPENCODE_BRIDGE_TOKEN;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
}
const payload = (r) => r.structuredContent ?? JSON.parse(r.content.find((i) => i.type === "text").text);

async function connect() {
  const client = new Client({ name: "installed-selftest", version: "1" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${URL_BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
    })
  );
  return client;
}

let client = await connect();
const call = async (name, args = {}) =>
  payload(await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 }));

try {
  const tools = await client.listTools();
  check("MCP discovery over the installed endpoint", tools.tools.length >= 19, `tools=${tools.tools.length}`);

  const health = await call("bridge_health");
  check("bridge_health", health.ok === true && health.opencodeApi === "v2");
  check(
    "managed opencode servers report healthy (regression: redacted password)",
    health.managedProcesses.every((proc) => proc.health?.healthy === true),
    JSON.stringify(health.managedProcesses)
  );

  // Read-only against the user's real sessions.
  const listed = await call("opencode_list_sessions", { limit: 10 });
  check("lists existing sessions under /Users/overlord", listed.opencodeSessions.length > 0,
    JSON.stringify(listed.opencodeSessions.slice(0, 2)));

  const target = listed.opencodeSessions.find((s) => /ferret/i.test(String(s.title ?? ""))) ?? listed.opencodeSessions[0];
  if (target) {
    const attached = await call("opencode_attach_session", { opencodeSessionId: target.opencodeSessionId });
    check("attaches to an existing session without creating one", attached.attached === true &&
      attached.bridgeSession.opencodeSessionId === target.opencodeSessionId);
    const history = await call("opencode_get_messages", {
      bridgeSessionId: attached.bridgeSession.bridgeSessionId,
      limit: 20
    });
    check("reads existing history", history.count > 0, `count=${history.count}`);
    const status = await call("opencode_get_session_status", { bridgeSessionId: attached.bridgeSession.bridgeSessionId });
    check("reads session status", typeof status.status.running === "boolean");
  }

  // Dedicated throwaway session for the write path.
  const repo = join(homedir(), ".opencode-chatgpt-bridge", "selftest-repo");
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, "README.md"), "# bridge self-test\n");
  await execFileAsync("git", ["init", "-q"], { cwd: repo }).catch(() => undefined);

  const created = await call("opencode_create_session", { repoPath: repo, title: "bridge self-test (safe to delete)" });
  const bridgeSessionId = created.bridgeSession.bridgeSessionId;
  check("creates a dedicated test session", Boolean(bridgeSessionId));

  const sent = await call("opencode_send_message", {
    bridgeSessionId,
    text: "Reply with exactly: bridge-live-ok. Do not use tools.",
    wait: true,
    timeoutMs: 90_000
  });
  const reply = sent.completion?.messages?.filter((m) => m.role === "assistant").pop();
  check("prompt round-trip through the installed bridge", sent.completion?.completed === true,
    JSON.stringify(sent.completion).slice(0, 300));
  check("assistant reply received", /bridge-live-ok/i.test(reply?.text ?? ""), String(reply?.text).slice(0, 120));

  const again = await call("opencode_send_message", {
    bridgeSessionId,
    text: "What exact token did you just reply with? Answer with only that token.",
    wait: true,
    timeoutMs: 90_000
  });
  const second = again.completion?.messages?.filter((m) => m.role === "assistant").pop();
  check("multi-turn context retained", /bridge-live-ok/i.test(second?.text ?? ""), String(second?.text).slice(0, 120));

  const poll = await call("opencode_get_messages", { bridgeSessionId, sinceMessageId: sent.accepted?.id ?? "" });
  check("incremental fetch never repeats the prompt", poll.messages.every((m) => m.id !== sent.accepted?.id));

  const permissions = await call("opencode_list_permissions", { bridgeSessionId });
  check("permission surface is available", Array.isArray(permissions.permissions));

  await rm(repo, { recursive: true, force: true });
  console.log(`\ntest bridgeSessionId (safe to keep): ${bridgeSessionId}`);
} finally {
  await client.close().catch(() => undefined);
}

// Reconnection after a bridge restart.
console.log("\n--- restarting bridge ---");
await execFileAsync(join(ROOT, "scripts/bridge-stop.sh"));
await execFileAsync(join(ROOT, "scripts/bridge-start.sh"));
client = await connect();
const reconnected = await payload(await client.callTool({ name: "bridge_health", arguments: {} }));
check("reconnects after a bridge restart", reconnected.ok === true);
await client.close().catch(() => undefined);

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
