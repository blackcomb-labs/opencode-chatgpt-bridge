import { describe, expect, it } from "vitest";
import type { OpencodeClient } from "../src/opencode/client.js";
import { SessionRegistry } from "../src/opencode/registry.js";
import { buildSessionReport, isAllowed, resolveSession } from "../src/opencode/report.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FakeMessage = {
  id: string;
  role: "user" | "assistant" | "idle" | "other";
  text: string;
  createdAt: number;
  outcome?: string;
  error?: unknown;
  tools?: Array<{ id: string; name: string; status?: string }>;
};

function fakeClient(options: {
  session: { id: string; title: string; directory: string };
  messages: FakeMessage[];
  running?: boolean;
  permissions?: Array<{ id: string; action: string; resources: string[] }>;
  cursor?: { previous?: string | null; next?: string | null };
  sessions?: Array<{ id: string; title: string; directory: string }>;
}) {
  const calls = { created: 0, attached: [] as string[] };
  const client = {
    calls,
    async getSession(id: string) {
      calls.attached.push(id);
      return {
        id,
        title: options.session.title,
        time: { created: 1, updated: 2 },
        location: { directory: options.session.directory }
      };
    },
    async listSessions() {
      return options.sessions ?? [options.session];
    },
    async getMessages(_id: string, _opts?: unknown) {
      return { messages: options.messages, cursor: options.cursor ?? { previous: null, next: null } };
    },
    async isSessionRunning() {
      return options.running ?? false;
    },
    async listPermissions() {
      return options.permissions ?? [];
    },
    async createSession() {
      calls.created += 1;
      throw new Error("the coordinator must never create a session");
    }
  };
  return client as unknown as OpencodeClient & { calls: typeof calls };
}

const baseOptions = {
  allowlist: ["ses_ferret"],
  allowAll: false,
  historyLimit: 100,
  maxTextChars: 2000
};

describe("session resolution", () => {
  it("resolves an existing session by its real id", () => {
    const sessions = [
      { id: "ses_ferret", title: "Project Ferret", location: { directory: "/work" } },
      { id: "ses_other", title: "Something else", location: { directory: "/work" } }
    ];
    const resolution = resolveSession(sessions, "ses_ferret");
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.sessionId).toBe("ses_ferret");
  });

  it("resolves by exact title", () => {
    const sessions = [
      { id: "ses_ferret", title: "Project Ferret: migrating Linux kernel to Rust", location: { directory: "/work" } },
      { id: "ses_other", title: "Other", location: { directory: "/work" } }
    ];
    const resolution = resolveSession(sessions, "Project Ferret: migrating Linux kernel to Rust");
    expect(resolution.ok).toBe(true);
    if (resolution.ok) expect(resolution.sessionId).toBe("ses_ferret");
  });

  it("refuses to guess when a name is ambiguous", () => {
    const sessions = [
      { id: "ses_a", title: "Project Ferret (kernel)", location: { directory: "/a" } },
      { id: "ses_b", title: "Project Ferret (userland)", location: { directory: "/b" } }
    ];
    const resolution = resolveSession(sessions, "Project Ferret");
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.candidates?.length).toBe(2);
      expect(resolution.reason).toMatch(/matches 2 sessions/);
    }
  });

  it("reports an unknown name instead of inventing one", () => {
    const resolution = resolveSession([{ id: "ses_a", title: "A", location: { directory: "/a" } }], "Ferret");
    expect(resolution.ok).toBe(false);
  });
});

describe("allowlist", () => {
  it("allows an explicitly listed session", () => {
    expect(isAllowed(baseOptions, "ses_ferret", "Project Ferret")).toBe(true);
  });

  it("refuses a session that is not listed", () => {
    expect(isAllowed(baseOptions, "ses_specter_x", "SPECTER-X")).toBe(false);
  });

  it("refuses everything when the allowlist is empty", () => {
    expect(isAllowed({ ...baseOptions, allowlist: [] }, "ses_ferret", "Ferret")).toBe(false);
  });
});

describe("session report", () => {
  it("reports on an existing session without creating or writing to it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-"));
    const registry = new SessionRegistry(dir);
    const client = fakeClient({
      session: { id: "ses_ferret", title: "Project Ferret", directory: "/work" },
      messages: [
        { id: "m1", role: "user", text: "do the thing", createdAt: 10 },
        { id: "m2", role: "assistant", text: "done", createdAt: 20 }
      ],
      running: false
    });
    const report = await buildSessionReport(client, registry, baseOptions, "ses_ferret", true);
    expect(report.resolved.id).toBe("ses_ferret");
    expect(client.calls.created).toBe(0);
    expect(client.calls.attached).toContain("ses_ferret");
    expect(report.allowed).toBe(true);
  });

  it("returns the latest messages in chronological order with a pagination cursor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-"));
    const registry = new SessionRegistry(dir);
    const messages: FakeMessage[] = Array.from({ length: 100 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      text: `message ${index}`,
      createdAt: 1000 + index
    }));
    const client = fakeClient({
      session: { id: "ses_ferret", title: "Project Ferret", directory: "/work" },
      messages,
      cursor: { previous: "cursor-older", next: null }
    });
    const report = await buildSessionReport(client, registry, baseOptions, "ses_ferret", true);
    expect(report.history.count).toBe(100);
    expect(report.history.oldestId).toBe("m0");
    expect(report.history.newestId).toBe("m99");
    expect(report.history.olderCursor).toBe("cursor-older");
    expect(report.history.messages.map((message) => message.id)).toEqual(messages.map((message) => message.id));
  });

  it("distinguishes a verified running session from a merely busy-looking one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-"));
    const registry = new SessionRegistry(dir);
    const busyText = "I am still working on this, the build is still running";
    const client = fakeClient({
      session: { id: "ses_ferret", title: "Project Ferret", directory: "/work" },
      messages: [
        { id: "m1", role: "user", text: "go", createdAt: 10 },
        { id: "m2", role: "assistant", text: busyText, createdAt: 20 }
      ],
      running: false
    });
    const report = await buildSessionReport(client, registry, baseOptions, "ses_ferret", false);
    expect(report.verifiedRunning).toBe(false);
    expect(report.currentTask?.turnRunning).toBe(false);
    // The busy-looking assistant text must not be presented as the task, and
    // must not make the session look active. With no idle marker there is no
    // completed turn to report.
    expect(report.currentTask?.text).toBe("go");
    expect(report.currentTask?.turnRunning).toBe(false);
    expect(report.verifiedRunning).toBe(false);
    expect(report.lastCompletedWork).toBeUndefined();
  });

  it("marks a session the server reports as running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-"));
    const registry = new SessionRegistry(dir);
    const client = fakeClient({
      session: { id: "ses_ferret", title: "Project Ferret", directory: "/work" },
      messages: [{ id: "m1", role: "user", text: "go", createdAt: 10 }],
      running: true
    });
    const report = await buildSessionReport(client, registry, baseOptions, "ses_ferret", false);
    expect(report.verifiedRunning).toBe(true);
  });

  it("separates finished work from the turn in flight", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-"));
    const registry = new SessionRegistry(dir);
    const client = fakeClient({
      session: { id: "ses_ferret", title: "Project Ferret", directory: "/work" },
      messages: [
        { id: "m1", role: "user", text: "first request", createdAt: 10 },
        { id: "m2", role: "assistant", text: "first turn finished", createdAt: 20 },
        { id: "m3", role: "idle", text: "", createdAt: 30, outcome: "succeeded" },
        { id: "m4", role: "user", text: "second request", createdAt: 40 },
        { id: "m5", role: "assistant", text: "working on it", createdAt: 50 }
      ],
      running: true
    });
    const report = await buildSessionReport(client, registry, baseOptions, "ses_ferret", false);
    expect(report.lastCompletedWork?.text).toBe("first turn finished");
    expect(report.currentTask?.text).toBe("second request");
    expect(report.verifiedRunning).toBe(true);
  });

  it("surfaces errors and pending permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-"));
    const registry = new SessionRegistry(dir);
    const client = fakeClient({
      session: { id: "ses_ferret", title: "Project Ferret", directory: "/work" },
      messages: [
        { id: "m1", role: "assistant", text: "boom", createdAt: 10, error: { message: "Step interrupted" } },
        { id: "m2", role: "idle", text: "", createdAt: 20, outcome: "failed" }
      ],
      permissions: [{ id: "p1", action: "write", resources: ["/work/file"] }]
    });
    const report = await buildSessionReport(client, registry, baseOptions, "ses_ferret", false);
    expect(report.recentErrors.length).toBeGreaterThan(0);
    expect(report.pendingPermissions.length).toBe(1);
    expect(report.pendingPermissions[0]?.action).toBe("write");
  });

  it("keeps the registry so a name resolves to the same session later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "registry-"));
    const registry = new SessionRegistry(dir);
    const client = fakeClient({
      session: { id: "ses_ferret", title: "Project Ferret", directory: "/work" },
      messages: [{ id: "m1", role: "user", text: "go", createdAt: 10 }]
    });
    await buildSessionReport(client, registry, baseOptions, "ses_ferret", false);
    const entries = await registry.list();
    expect(entries.length).toBe(1);
    expect(entries[0]?.id).toBe("ses_ferret");
    expect(entries[0]?.directory).toBe("/work");
  });
});
