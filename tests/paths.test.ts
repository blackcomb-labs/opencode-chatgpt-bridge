import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPathWithinRoots, listProjects, resolvePathWithinRoot, validateRepoPath } from "../src/security/paths.js";

describe("path security", () => {
  it("allows paths inside allowed roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await expect(validateRepoPath(repo, [root])).resolves.toBe(await realpath(repo));
  });

  it("rejects paths outside allowed roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const outside = await mkdtemp(join(tmpdir(), "bridge-outside-"));
    await expect(validateRepoPath(outside, [root])).rejects.toThrow(/outside allowed roots/);
  });

  it("finds git projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    await mkdir(join(root, "a", ".git"), { recursive: true });
    const projects = await listProjects([root], 2);
    expect(projects.map((p) => p.name)).toContain("a");
  });

  it("filters session directories against allowed roots", () => {
    expect(isPathWithinRoots("/Users/me/dev/repo", ["/Users/me/dev"])).toBe(true);
    expect(isPathWithinRoots("/Users/me/other/repo", ["/Users/me/dev"])).toBe(false);
    expect(isPathWithinRoots("/Users/me/dev-evil/repo", ["/Users/me/dev"])).toBe(false);
  });

  it("rejects symlink and junction escapes from the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const repo = join(root, "repo");
    const outside = await mkdtemp(join(tmpdir(), "bridge-outside-"));
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "inside.txt"), "ok", "utf8");
    await writeFile(join(outside, "secret.txt"), "no", "utf8");
    await symlink(outside, join(repo, "escape"), process.platform === "win32" ? "junction" : "dir");

    await expect(resolvePathWithinRoot(repo, "inside.txt")).resolves.toContain("inside.txt");
    await expect(resolvePathWithinRoot(repo, "escape/secret.txt")).rejects.toThrow(/outside the project/);
  });
});
