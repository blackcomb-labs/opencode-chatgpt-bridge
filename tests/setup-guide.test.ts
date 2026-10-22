import { describe, expect, it } from "vitest";
import { getSetupGuide } from "../src/setupGuide.js";
import type { BridgeConfig } from "../src/types.js";

const config: BridgeConfig = {
  host: "127.0.0.1",
  port: 8787,
  autoPort: true,
  allowedHosts: ["127.0.0.1", "localhost"],
  allowedRoots: ["/tmp/repos"],
  readOnly: true,
  bridgeToken: "abc123supersecrettoken",
  allowQueryToken: false,
  opencodeBin: "opencode",
  opencodeHost: "127.0.0.1",
  opencodePortStart: 4096,
  opencodeUsername: "opencode",
  stateDir: "/tmp/state",
  tunnel: "cloudflare",
  tailscaleBin: "tailscale",
  cloudflaredBin: "cloudflared"
};

describe("setup guide", () => {
  it("prints ChatGPT and opencode setup details", () => {
    const guide = getSetupGuide({
      config,
      localUrl: "http://127.0.0.1:8787",
      publicUrl: "https://example.trycloudflare.com",
      opencodeStatus: { installed: true, version: "2.1.1", path: "/usr/local/bin/opencode" }
    });

    expect(guide).toContain("Settings -> Apps & Connectors");
    expect(guide).toContain("https://example.trycloudflare.com/mcp");
    expect(guide).toContain("Authorization: Bearer");
    expect(guide).toContain("opencode: installed");
    expect(guide).toContain("opencode serve");
  });

  it("never prints the raw token or a token URL", () => {
    const guide = getSetupGuide({ config, localUrl: "http://127.0.0.1:8787", publicUrl: "https://example.trycloudflare.com" });
    expect(guide).not.toContain("abc123supersecrettoken");
    expect(guide).not.toContain("?token=");
    expect(guide).toContain("abc1…oken");
  });
});
