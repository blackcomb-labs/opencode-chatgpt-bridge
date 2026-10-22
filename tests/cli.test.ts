import { execFile } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
// The repo root, so the test does not depend on the runner's working directory.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("CLI", () => {
  it("prints help", async () => {
    // Run the CLI through the current Node binary instead of a package-manager
    // shim: `pnpm` is not an executable on Windows (spawn ENOENT).
    const result = await execFileAsync(process.execPath, ["--import", "tsx", "src/cli.ts", "help"], {
      cwd: repoRoot,
      timeout: 30000,
      windowsHide: true
    });
    expect(result.stdout).toContain("opencode-chatgpt-bridge init");
    expect(result.stdout).toContain("opencode-chatgpt-bridge doctor");
  });
});
