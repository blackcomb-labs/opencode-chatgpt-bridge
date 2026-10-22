import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { initEnv } from "../src/config/bootstrap.js";

describe("initEnv", () => {
  it("creates a ready-to-use env file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-init-"));
    const envPath = join(dir, ".env");
    const result = await initEnv({ envPath, allowedRoots: [dir] });
    const content = await readFile(envPath, "utf8");
    const mode = (await stat(envPath)).mode & 0o777;

    expect(result.created).toBe(true);
    expect(result.token.length).toBeGreaterThan(20);
    expect(content).toContain("OPENCODE_BRIDGE_TOKEN=");
    expect(content).toContain("OPENCODE_BRIDGE_TUNNEL=none");
    expect(content).toContain("OPENCODE_BRIDGE_ALLOW_QUERY_TOKEN=false");
    expect(content).toContain(dir);

    // `chmod 600` is only meaningful on Unix. Node cannot apply an NTFS ACL on
    // Windows (it only toggles the read-only attribute), and the bridge does
    // not implement ACL hardening yet, so Windows must not be reported as
    // protected here.
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  it("joins allowed roots with the platform path delimiter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-init-"));
    const second = await mkdtemp(join(tmpdir(), "bridge-init-"));
    const envPath = join(dir, ".env");
    await initEnv({ envPath, allowedRoots: [dir, second] });
    const content = await readFile(envPath, "utf8");

    expect(content).toContain(`OPENCODE_BRIDGE_ALLOWED_ROOTS=${dir}${delimiter}${second}`);
  });
});
