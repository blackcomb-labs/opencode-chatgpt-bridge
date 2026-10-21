#!/usr/bin/env node
/**
 * Install the OpenCode Bridge as a personal ChatGPT/Codex desktop plugin.
 *
 * Creates (or updates):
 *   ~/.agents/plugins/marketplace.json        - personal marketplace
 *   ~/.agents/plugins/opencode-bridge/        - the plugin itself
 *   ~/.opencode-chatgpt-bridge/bridge-root    - pointer to this checkout
 *
 * then registers the marketplace with Codex and installs the plugin.
 *
 * Usage: node scripts/install-codex-plugin.mjs [--uninstall]
 */
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BRIDGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOME = homedir();
const PLUGIN_NAME = "opencode-bridge";
const MARKETPLACE_NAME = "personal";
const MARKETPLACE_DIR = join(HOME, ".agents", "plugins");
const MARKETPLACE_FILE = join(MARKETPLACE_DIR, "marketplace.json");
const PLUGIN_DIR = join(MARKETPLACE_DIR, PLUGIN_NAME);
const POINTER_FILE = join(HOME, ".opencode-chatgpt-bridge", "bridge-root");

const READ_ONLY_TOOLS = [
  "bridge_health",
  "list_projects",
  "opencode_list_sessions",
  "opencode_get_session_status",
  "opencode_get_messages",
  "opencode_get_diff",
  "opencode_list_permissions",
  "opencode_read_file",
  "opencode_find_files",
  "opencode_vcs_status",
  "opencode_capabilities",
  "opencode_wait_for_completion"
];

async function run(command, args) {
  const { stdout, stderr } = await execFileAsync(command, args, { encoding: "utf8" });
  return `${stdout}${stderr}`.trim();
}

function buildMcpConfig() {
  const tools = Object.fromEntries(READ_ONLY_TOOLS.map((tool) => [tool, { approval_mode: "approve" }]));
  return {
    mcpServers: {
      opencode_bridge: {
        command: "node",
        args: [join(BRIDGE_ROOT, "scripts", "mcp-stdio-proxy.mjs")],
        cwd: BRIDGE_ROOT,
        env: { OPENCODE_BRIDGE_ROOT: BRIDGE_ROOT },
        env_vars: ["HOME", "PATH"],
        startup_timeout_sec: 45,
        tool_timeout_sec: 180,
        default_tools_approval_mode: "prompt",
        tools
      }
    }
  };
}

async function readMarketplace() {
  if (!existsSync(MARKETPLACE_FILE)) {
    return { name: MARKETPLACE_NAME, interface: { displayName: "Personal" }, plugins: [] };
  }
  try {
    const parsed = JSON.parse(await readFile(MARKETPLACE_FILE, "utf8"));
    parsed.plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
    return parsed;
  } catch {
    return { name: MARKETPLACE_NAME, interface: { displayName: "Personal" }, plugins: [] };
  }
}

async function install() {
  console.log(`bridge root: ${BRIDGE_ROOT}`);

  await mkdir(MARKETPLACE_DIR, { recursive: true });
  await mkdir(dirname(POINTER_FILE), { recursive: true });

  // 1. Plugin payload: manifest + skills, with a generated .mcp.json.
  await rm(PLUGIN_DIR, { recursive: true, force: true });
  await cp(join(BRIDGE_ROOT, "plugin", PLUGIN_NAME), PLUGIN_DIR, { recursive: true });
  await writeFile(join(PLUGIN_DIR, ".mcp.json"), `${JSON.stringify(buildMcpConfig(), null, 2)}\n`, { mode: 0o600 });

  // 2. Marketplace entry (kept at the path Codex expects, under the home root).
  const marketplace = await readMarketplace();
  marketplace.name = marketplace.name ?? MARKETPLACE_NAME;
  marketplace.interface = marketplace.interface ?? { displayName: "Personal" };
  marketplace.plugins = marketplace.plugins.filter((plugin) => plugin.name !== PLUGIN_NAME);
  marketplace.plugins.push({
    name: PLUGIN_NAME,
    source: { source: "local", path: `./.agents/plugins/${PLUGIN_NAME}` },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools"
  });
  await writeFile(MARKETPLACE_FILE, `${JSON.stringify(marketplace, null, 2)}\n`);

  // 3. Tell the plugin where the bridge lives (it holds the bearer token).
  await writeFile(POINTER_FILE, `${BRIDGE_ROOT}\n`);

  // 4. Register the marketplace and install the plugin.
  console.log(await run("codex", ["plugin", "marketplace", "add", HOME]));
  console.log(await run("codex", ["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]));

  console.log("\ninstalled.");
  console.log(`  plugin dir:     ${PLUGIN_DIR}`);
  console.log(`  marketplace:    ${MARKETPLACE_FILE}`);
  console.log(`  token pointer:  ${POINTER_FILE}`);
  console.log("\nNext: restart ChatGPT (desktop) so it reloads plugins, then ask:");
  console.log('  "Ask my OpenCode agent what it is working on."');
}

async function uninstall() {
  try {
    console.log(await run("codex", ["plugin", "remove", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]));
  } catch (error) {
    console.log(`plugin remove: ${error instanceof Error ? error.message : String(error)}`);
  }
  const marketplace = await readMarketplace();
  marketplace.plugins = marketplace.plugins.filter((plugin) => plugin.name !== PLUGIN_NAME);
  await writeFile(MARKETPLACE_FILE, `${JSON.stringify(marketplace, null, 2)}\n`);
  await rm(PLUGIN_DIR, { recursive: true, force: true });
  console.log("uninstalled.");
}

if (process.argv.includes("--uninstall")) {
  await uninstall();
} else {
  await install();
}
