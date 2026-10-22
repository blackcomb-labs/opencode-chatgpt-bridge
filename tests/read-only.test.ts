import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { sanitizeRelativePath } from "../src/opencode/client.js";
import { READ_ONLY_TOOL_NAMES, createBridgeMcpServer, isExposedTool, isReadOnlyTool } from "../src/mcp/tools.js";
import { OpencodeProcessManager } from "../src/opencode/process.js";
import { StateStore } from "../src/state/store.js";

const WRITE_TOOLS = [
  "opencode_start",
  "opencode_stop",
  "opencode_create_session",
  "opencode_send_message",
  "opencode_abort",
  "opencode_respond_permission"
];

describe("read-only mode", () => {
  it("keeps the explicit allowlist and rejects every write tool", () => {
    expect(READ_ONLY_TOOL_NAMES.has("bridge_health")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("opencode_list_sessions")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("opencode_read_file")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("opencode_capabilities")).toBe(false);
    for (const name of WRITE_TOOLS) {
      expect(READ_ONLY_TOOL_NAMES.has(name)).toBe(false);
      expect(isReadOnlyTool(name)).toBe(false);
    }
    expect(isReadOnlyTool("unknown_tool")).toBe(false);
  });

  it("exposes only existing-session send on explicit opt-in", () => {
    const config = loadConfig(["--read-only", "--allow-send-message=false", "--allowed-roots", tmpdir()]);
    const listed = () => {
      const server = createBridgeMcpServer({
        config,
        processManager: new OpencodeProcessManager(config),
        state: new StateStore(join(tmpdir(), "bridge-send-only-test"))
      });
      return Object.keys((server as unknown as {
        _registeredTools?: Record<string, unknown>
      })._registeredTools ?? {});
    };

    expect(config.allowSendMessage).toBe(false);
    expect(listed()).toHaveLength(12);
    expect(isExposedTool("opencode_send_message", config)).toBe(false);

    config.allowSendMessage = true;
    expect(listed()).toHaveLength(13);
    expect(isExposedTool("opencode_send_message", config)).toBe(true);
    expect(listed()).toContain("opencode_send_message");
    expect(listed()).not.toContain("opencode_capabilities");
    for (const name of WRITE_TOOLS.filter((name) => name !== "opencode_send_message")) {
      expect(isExposedTool(name, config)).toBe(false);
      expect(listed()).not.toContain(name);
    }
    config.allowSendMessage = false;
    expect(listed()).toHaveLength(12);
  });

  it("rejects nested credential files even under an allowed project", () => {
    for (const path of [
      ".env", "src/.env.local", ".npmrc", "config/opencode.json",
      "secrets/service.json", "secrets/token.pem", "ghidra_mcp_token.txt"
    ]) {
      expect(() => sanitizeRelativePath(path)).toThrow(/credential path/);
    }
    expect(sanitizeRelativePath("src/mcp/tools.ts")).toBe("src/mcp/tools.ts");
  });

  it("fails closed instead of spawning an opencode server", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-readonly-"));
    const config = loadConfig(["--allowed-roots", root, "--read-only"]);
    config.opencodeUseService = true;
    config.opencodeServiceConfig = join(root, "missing-service.json");
    config.opencodeBaseUrl = undefined;

    const manager = new OpencodeProcessManager(config);
    await expect(manager.ensure(root)).rejects.toThrow(/Read-only mode/);
  });
});
