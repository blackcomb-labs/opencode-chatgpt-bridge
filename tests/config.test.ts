import { delimiter, resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { loadConfig, maskToken } from "../src/config/env.js";
import { splitPathEntries } from "../src/config/pathList.js";

describe("loadConfig", () => {
  it("parses CLI arguments", () => {
    const roots = [resolve("alpha"), resolve("beta")];
    const config = loadConfig([
      "--host",
      "0.0.0.0",
      "--port",
      "9999",
      "--allowed-roots",
      roots.join(delimiter),
      "--token",
      "secret-token",
      "--tunnel",
      "cloudflare"
    ]);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9999);
    expect(config.allowedRoots).toEqual(roots);
    expect(config.bridgeToken).toBe("secret-token");
    expect(config.tunnel).toBe("cloudflare");
    expect(config.allowQueryToken).toBe(false);
  });

  it("allows opting into query-token auth", () => {
    const root = resolve("sample-root");
    const config = loadConfig(["--allowed-roots", root, "--allow-query-token"]);
    expect(config.allowedRoots).toEqual([root]);
    expect(config.allowQueryToken).toBe(true);
  });

  it("defaults to read-only and allows an explicit opt-out", () => {
    const previous = process.env.OPENCODE_BRIDGE_READ_ONLY;
    const root = resolve("sample-root");
    try {
      delete process.env.OPENCODE_BRIDGE_READ_ONLY;
      expect(loadConfig(["--allowed-roots", root]).readOnly).toBe(true);
      process.env.OPENCODE_BRIDGE_READ_ONLY = "false";
      expect(loadConfig(["--allowed-roots", root]).readOnly).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BRIDGE_READ_ONLY;
      else process.env.OPENCODE_BRIDGE_READ_ONLY = previous;
    }
  });

  it("defaults to no message sending and accepts explicit opt-in", () => {
    const previous = process.env.OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE;
    try {
      delete process.env.OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE;
      expect(loadConfig(["--allowed-roots", resolve("sample-root")]).allowSendMessage).toBe(false);
      expect(loadConfig(["--allow-send-message", "--allowed-roots", resolve("sample-root")]).allowSendMessage).toBe(true);
      process.env.OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE = "true";
      expect(loadConfig(["--allowed-roots", resolve("sample-root")]).allowSendMessage).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE;
      else process.env.OPENCODE_BRIDGE_ALLOW_SEND_MESSAGE = previous;
    }
  });

  it("keeps Windows drive letters when splitting a Windows path list", () => {
    expect(splitPathEntries("C:\\Users\\me\\repos;D:\\work\\projects", ";")).toEqual([
      "C:\\Users\\me\\repos",
      "D:\\work\\projects"
    ]);
  });

  it.skipIf(process.platform !== "win32")("parses multiple Windows roots from --allowed-roots", () => {
    const roots = ["C:\\Users\\me\\repos", "D:\\work\\projects"];
    const config = loadConfig(["--allowed-roots", roots.join(";")]);
    expect(config.allowedRoots).toEqual(roots);
  });

  it("masks tokens", () => {
    expect(maskToken("abcdefghijk")).toBe("abcd…hijk");
    expect(maskToken("short")).toBe("********");
  });
});
