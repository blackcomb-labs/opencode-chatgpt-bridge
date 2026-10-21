import { describe, expect, it } from "vitest";
import { loadConfig, maskToken } from "../src/config/env.js";

describe("loadConfig", () => {
  it("parses CLI arguments", () => {
    const config = loadConfig([
      "--host",
      "0.0.0.0",
      "--port",
      "9999",
      "--allowed-roots",
      "/tmp:/var/tmp",
      "--token",
      "secret-token",
      "--tunnel",
      "cloudflare"
    ]);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9999);
    expect(config.allowedRoots).toContain("/tmp");
    expect(config.allowedRoots).toContain("/var/tmp");
    expect(config.bridgeToken).toBe("secret-token");
    expect(config.tunnel).toBe("cloudflare");
    expect(config.allowQueryToken).toBe(false);
  });

  it("allows opting into query-token auth", () => {
    const config = loadConfig(["--allowed-roots", "/tmp", "--allow-query-token"]);
    expect(config.allowQueryToken).toBe(true);
  });

  it("masks tokens", () => {
    expect(maskToken("abcdefghijk")).toBe("abcd…hijk");
    expect(maskToken("short")).toBe("********");
  });
});
