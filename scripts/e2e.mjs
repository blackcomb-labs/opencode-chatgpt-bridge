#!/usr/bin/env node
/**
 * End-to-end acceptance test for the v2 bridge.
 *
 * Boots a throwaway git repo, starts the bridge (which spawns its own
 * `opencode serve`), then drives it over the real MCP Streamable HTTP
 * transport with a bearer token - the same path ChatGPT uses.
 */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const execFileAsync = promisify(execFile);
const BRIDGE_PORT = 8799;
const TOKEN = `e2e-${Math.random().toString(36).slice(2, 10)}`;
const results = [];
let failures = 0;

function check(name, condition, detail) {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -> ${detail}` : ""}`);
}

async function waitFor(url, headers, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function payload(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : result;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  return payload(result);
}

const workDir = await mkdtemp(join(tmpdir(), "ocbridge-e2e-"));
const rawRepoDir = join(workDir, "sample-repo");
const stateDir = join(workDir, "state");
await mkdir(rawRepoDir, { recursive: true });
await writeFile(join(rawRepoDir, "README.md"), "# Sample\n\nBridge e2e fixture.\n");
await writeFile(join(rawRepoDir, "hello.txt"), "hello\n");
const repoDir = await realpath(rawRepoDir);
await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
await execFileAsync("git", ["add", "."], { cwd: repoDir });
await execFileAsync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "init"], {
  cwd: repoDir
});

const bridge = spawn(
  process.execPath,
  [
    "dist/cli.js",
    "start",
    "--host",
    "127.0.0.1",
    "--port",
    String(BRIDGE_PORT),
    "--allowed-roots",
    repoDir,
    "--token",
    TOKEN,
    "--state-dir",
    stateDir,
    "--tunnel",
    "none",
    "--opencode-port-start",
    "4210"
  ],
  { stdio: ["ignore", "pipe", "pipe"] }
);

let bridgeLog = "";
bridge.stdout.on("data", (chunk) => (bridgeLog += chunk.toString()));
bridge.stderr.on("data", (chunk) => (bridgeLog += chunk.toString()));

const baseUrl = `http://127.0.0.1:${BRIDGE_PORT}`;
const authHeaders = { Authorization: `Bearer ${TOKEN}` };

let client;
let sessionId;
let firstTurnMessageId;

try {
  await waitFor(`${baseUrl}/health`, authHeaders);

  // --- auth is enforced ------------------------------------------------
  const unauth = new Client({ name: "e2e-unauth", version: "0.0.0" }, { capabilities: {} });
  const unauthTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  let unauthRejected = false;
  try {
    await unauth.connect(unauthTransport);
    await unauth.callTool({ name: "bridge_health", arguments: {} });
  } catch {
    unauthRejected = true;
  }
  await unauth.close().catch(() => undefined);
  check("MCP rejects missing bearer token", unauthRejected);

  // --- authenticated MCP session --------------------------------------
  client = new Client({ name: "e2e", version: "0.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: authHeaders }
  });
  await client.connect(transport);

  const tools = await client.listTools();
  check("tools/list exposes the v2 tool set", tools.tools.some((tool) => tool.name === "opencode_wait_for_completion"),
    tools.tools.map((tool) => tool.name).join(","));

  const healthRaw = await client.callTool({ name: "bridge_health", arguments: {} });
  const health = payload(healthRaw);
  check("tool responses carry structuredContent", Boolean(healthRaw.structuredContent), JSON.stringify(Object.keys(healthRaw)).slice(0, 120));
  check("bridge_health reports the v2 API", health.opencodeApi === "v2" && health.ok === true, JSON.stringify(health));

  const projects = await call(client, "list_projects", { depth: 1 });
  check(
    "list_projects finds the allow-listed repo",
    projects.projects.some((project) => project.path === repoDir),
    JSON.stringify(projects).slice(0, 300)
  );

  const started = await call(client, "opencode_start", { repoPath: repoDir });
  check("opencode_start reports a healthy v2 server", started.health?.healthy === true, JSON.stringify(started).slice(0, 300));

  const created = await call(client, "opencode_create_session", { repoPath: repoDir, title: "e2e session" });
  sessionId = created.bridgeSession.bridgeSessionId;
  check("opencode_create_session returns a bridge + opencode id", Boolean(sessionId) && Boolean(created.bridgeSession.opencodeSessionId));

  const firstTurn = await call(client, "opencode_send_message", {
    bridgeSessionId: sessionId,
    text: "Reply with exactly: bridge-ok. Do not call any tools.",
    wait: true,
    timeoutMs: 120_000
  });
  firstTurnMessageId = firstTurn.accepted?.id;
  const firstReply = firstTurn.completion?.messages?.filter((message) => message.role === "assistant").pop();
  check("prompt completes a full round-trip", firstTurn.completion?.completed === true && firstTurn.completion?.outcome === "succeeded",
    JSON.stringify(firstTurn.completion).slice(0, 400));
  check("assistant reply content is retrievable", typeof firstReply?.text === "string" && firstReply.text.length > 0,
    JSON.stringify(firstReply).slice(0, 300));

  // --- polling without duplication ------------------------------------
  const since = await call(client, "opencode_get_messages", { bridgeSessionId: sessionId, sinceMessageId: firstTurnMessageId });
  check("sinceMessageId never returns the prompt itself",
    since.messages.every((message) => message.id !== firstTurnMessageId), JSON.stringify(since.messages.map((m) => m.id)));
  check("sinceMessageId returns only newer messages", since.messages.length > 0 && since.matchedSince === true);

  const again = await call(client, "opencode_get_messages", {
    bridgeSessionId: sessionId,
    sinceMessageId: since.messages[since.messages.length - 1].id
  });
  check("polling an already-consumed window returns no duplicates", again.messages.length === 0,
    JSON.stringify(again.messages.map((m) => m.id)));

  const transcript = await call(client, "opencode_get_messages", { bridgeSessionId: sessionId, limit: 50 });
  const lastMessageId = transcript.messages[transcript.messages.length - 1].id;
  const waitStarted = Date.now();
  const bounded = await call(client, "opencode_wait_for_completion", {
    bridgeSessionId: sessionId,
    sinceMessageId: lastMessageId,
    timeoutMs: 3000
  });
  const waitElapsed = Date.now() - waitStarted;
  check("wait_for_completion is bounded, never blocks forever",
    bounded.completion.timedOut === true && waitElapsed < 15_000, `timedOut=${bounded.completion.timedOut} elapsed=${waitElapsed}ms`);

  const status = await call(client, "opencode_get_session_status", { bridgeSessionId: sessionId });
  check("status reports idle after completion", status.status.running === false && status.status.outcome === "succeeded",
    JSON.stringify(status.status));
  check("status surfaces pending permissions", Array.isArray(status.pendingPermissions) && status.pendingPermissionCount === 0);

  // --- multi-turn context ---------------------------------------------
  const secondTurn = await call(client, "opencode_send_message", {
    bridgeSessionId: sessionId,
    text: "What exact token did I ask you to reply with? Answer with just that token.",
    wait: true,
    timeoutMs: 120_000
  });
  const secondReply = secondTurn.completion?.messages?.filter((message) => message.role === "assistant").pop();
  check("second turn preserves session context", /bridge-ok/i.test(secondReply?.text ?? ""), String(secondReply?.text).slice(0, 200));

  // --- attach to the same live session --------------------------------
  const attached = await call(client, "opencode_attach_session", {
    opencodeSessionId: created.bridgeSession.opencodeSessionId,
    repoPath: repoDir
  });
  check("attach reuses the existing opencode session", attached.attached === true &&
    attached.bridgeSession.opencodeSessionId === created.bridgeSession.opencodeSessionId);

  const history = await call(client, "opencode_get_messages", { bridgeSessionId: attached.bridgeSession.bridgeSessionId, limit: 50 });
  check("attached session exposes existing history", history.messages.length >= 4, `count=${history.messages.length}`);

  const listed = await call(client, "opencode_list_sessions", { repoPath: repoDir, limit: 10 });
  check("list_sessions offers attachable opencode sessions",
    listed.opencodeSessions.some((session) => session.opencodeSessionId === created.bridgeSession.opencodeSessionId),
    JSON.stringify(listed.opencodeSessions).slice(0, 300));

  // --- diffs, files, vcs, capabilities ---------------------------------
  const diff = await call(client, "opencode_get_diff", { bridgeSessionId: sessionId });
  check("get_diff returns a structured file list", Array.isArray(diff.diff) && typeof diff.files === "number");

  const read = await call(client, "opencode_read_file", { bridgeSessionId: sessionId, path: "README.md" });
  check("read_file returns project content", read.content.includes("Bridge e2e fixture"), String(read.content).slice(0, 80));

  const found = await call(client, "opencode_find_files", { bridgeSessionId: sessionId, query: "hello", limit: 10 });
  check("find_files finds a known file", found.files.some((file) => file.path.includes("hello.txt")),
    JSON.stringify(found.files).slice(0, 200));

  const vcs = await call(client, "opencode_vcs_status", { bridgeSessionId: sessionId });
  check("vcs_status returns structured data", typeof vcs.files === "number" && Array.isArray(vcs.status));

  const caps = await call(client, "opencode_capabilities", { bridgeSessionId: sessionId });
  check("capabilities lists agents and providers", caps.agents.length > 0 && caps.providers.length > 0,
    `agents=${caps.agents.length} providers=${caps.providers.length}`);

  // --- negative paths ---------------------------------------------------
  const outside = await call(client, "opencode_start", { repoPath: "/etc" });
  check("path traversal outside allowed roots is rejected",
    outside.ok === false && /outside allowed roots|does not exist/i.test(outside.error ?? ""), JSON.stringify(outside).slice(0, 200));

  const badPermission = await call(client, "opencode_respond_permission", {
    bridgeSessionId: sessionId,
    permissionId: "per_does_not_exist",
    decision: "reject"
  });
  check("permission replies are not silently accepted", badPermission.ok === false, JSON.stringify(badPermission).slice(0, 200));

  const traversal = await call(client, "opencode_read_file", { bridgeSessionId: sessionId, path: "../../../etc/passwd" });
  check("file reads cannot escape the project", traversal.ok === false && /outside the project/i.test(traversal.error ?? ""));
} catch (error) {
  failures += 1;
  console.error("\nUNEXPECTED ERROR:", error);
  console.error("\n--- bridge log ---\n", bridgeLog.slice(-4000));
} finally {
  await client?.close().catch(() => undefined);
  bridge.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (!bridge.killed) bridge.kill("SIGKILL");
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
}

const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (failures > 0) {
  console.error("E2E FAILED");
  process.exit(1);
}
console.log("E2E PASSED");
