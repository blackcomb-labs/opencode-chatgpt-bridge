import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = `tun-${Math.random().toString(36).slice(2, 10)}`;
const PORT = 8803;
const work = await mkdtemp(join(tmpdir(), "ocbridge-tun-"));
const repo = join(work, "repo");
await mkdir(repo, { recursive: true });
await writeFile(join(repo, "README.md"), "# tun\n");
const realRepo = await realpath(repo);

const bridge = spawn(process.execPath, [
  "dist/cli.js", "start", "--host", "127.0.0.1", "--port", String(PORT),
  "--allowed-roots", realRepo, "--token", TOKEN, "--state-dir", join(work, "state"),
  "--tunnel", "cloudflare"
], { stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd() });

let log = "";
bridge.stdout.on("data", (c) => (log += c));
bridge.stderr.on("data", (c) => (log += c));

function publicUrl() {
  const match = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  return match?.[0];
}

let client;
try {
  for (let i = 0; i < 120 && !publicUrl(); i += 1) await new Promise((r) => setTimeout(r, 500));
  const url = publicUrl();
  if (!url) throw new Error("no tunnel URL\n" + log.slice(-1500));
  console.log("tunnel URL acquired:", url.replace(/\/\/[a-z0-9-]+/, "//<random>"));

  // DNS-rebinding guard must reject a forged Host header locally (curl can set it).
  const forged = await promisify(execFile)("curl", [
    "-s", "-o", "/dev/null", "-w", "%{http_code}",
    "-H", "Host: evil.example.com",
    `http://127.0.0.1:${PORT}/health`
  ]);
  console.log("forged Host header rejected:", forged.stdout.trim() === "403", `(status ${forged.stdout.trim()})`);

  // Wait for the quick-tunnel hostname to resolve before dialing it.
  let readyAfter = -1;
  for (let i = 0; i < 90; i += 1) {
    try {
      const probe = await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (probe.ok) { readyAfter = i; break; }
    } catch {
      // DNS not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`public DNS/HTTPS ready after ${readyAfter}s`);

  // Real MCP over the public HTTPS endpoint with header auth.
  client = new Client({ name: "tunnel-check", version: "0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
  }));
  const health = (await client.callTool({ name: "bridge_health", arguments: {} })).structuredContent;
  console.log("HTTPS bridge_health ok:", health?.ok === true, "| opencodeApi:", health?.opencodeApi);

  const projects = (await client.callTool({ name: "list_projects", arguments: { depth: 1 } })).structuredContent;
  console.log("HTTPS list_projects ok:", Array.isArray(projects?.projects), `(${projects?.projects?.length ?? 0} project(s))`);

  // Without the header the same public endpoint must refuse.
  const anon = new Client({ name: "anon", version: "0" }, { capabilities: {} });
  let refused = false;
  try {
    await anon.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    await anon.callTool({ name: "bridge_health", arguments: {} });
  } catch {
    refused = true;
  }
  await anon.close().catch(() => {});
  console.log("HTTPS endpoint rejects unauthenticated MCP:", refused);
} catch (error) {
  console.error("ERROR:", error);
  console.error(log.slice(-2000));
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  bridge.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  bridge.kill("SIGKILL");
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
