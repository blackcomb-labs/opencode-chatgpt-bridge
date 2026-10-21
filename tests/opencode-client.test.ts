import { describe, expect, it } from "vitest";
import { OpencodeClient, OpencodeHttpError, normalizeMessage, sanitizeRelativePath } from "../src/opencode/client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OpencodeClient v2", () => {
  it("calls /api/session, unwraps the data envelope, and sends basic auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ data: { id: "ses_1", projectID: "p", cost: 0, tokens: {}, time: { created: 1, updated: 1 } } });
    };

    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096/", username: "u", password: "p", fetchImpl });
    const session = await client.createSession("Title");

    expect(session.id).toBe("ses_1");
    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/api/session");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: "Title" });
  });

  it("posts prompts to /api/session/{id}/prompt", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ data: { id: "msg_1", delivery: "steer" } });
    };

    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });
    const accepted = await client.prompt("ses_1", "hello", { delivery: "steer" });

    expect(accepted.id).toBe("msg_1");
    expect(calls[0]?.url).toBe("http://localhost:4096/api/session/ses_1/prompt");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: "hello", delivery: "steer" });
  });

  it("normalizes v2 message unions and returns transcripts oldest-first", async () => {
    const fetchImpl: typeof fetch = async () =>
      jsonResponse({
        data: [
          { id: "m3", type: "idle", outcome: "succeeded", time: { created: 30 } },
          {
            id: "m2",
            type: "assistant",
            time: { created: 20 },
            content: [
              { type: "text", text: "pong" },
              { type: "tool", id: "t1", name: "bash", state: { status: "completed" } }
            ],
            finish: "stop"
          },
          { id: "m1", type: "user", text: "ping", time: { created: 10 } }
        ],
        cursor: { next: null }
      });

    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });
    const page = await client.getMessages("ses_1", { limit: 10 });

    expect(page.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
    expect(page.messages[0]).toMatchObject({ role: "user", text: "ping" });
    expect(page.messages[1]).toMatchObject({ role: "assistant", text: "pong", finish: "stop" });
    expect(page.messages[1]?.tools).toEqual([{ id: "t1", name: "bash", status: "completed" }]);
    expect(page.messages[2]).toMatchObject({ role: "idle", outcome: "succeeded" });
  });

  it("surfaces HTTP failures with status codes", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: "nope" }, 401);
    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });

    await expect(client.info()).rejects.toBeInstanceOf(OpencodeHttpError);
    await client.info().catch((error: OpencodeHttpError) => {
      expect(error.status).toBe(401);
    });
  });

  it("encodes file paths and rejects traversal", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response("# readme", { status: 200, headers: { "content-type": "text/markdown" } });
    };
    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });

    await client.readFile("docs/a b.md");
    expect(calls[0]).toBe("http://localhost:4096/api/fs/read/docs/a%20b.md");

    expect(() => sanitizeRelativePath("../../etc/passwd")).toThrow(/outside the project/);
    expect(() => sanitizeRelativePath("/../etc/passwd")).toThrow(/outside the project/);
    expect(sanitizeRelativePath("./src/index.ts")).toBe("src/index.ts");
  });

  it("maps permission replies to the v2 decision enum", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
      return jsonResponse({ data: { ok: true } });
    };
    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });

    await client.replyPermission("ses_1", "per_1", "reject", "user said no");
    expect(calls[0]?.url).toBe("http://localhost:4096/api/session/ses_1/permission/per_1/reply");
    expect(calls[0]?.body).toEqual({ decision: "reject", message: "user said no" });
  });

  it("passes session list filters as query parameters", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse({ data: [] });
    };
    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });

    await client.listSessions({ limit: 5, search: "ferret", order: "desc" });
    const url = new URL(calls[0] ?? "");
    expect(url.pathname).toBe("/api/session");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("search")).toBe("ferret");
    expect(url.searchParams.get("order")).toBe("desc");
  });
});

describe("normalizeMessage", () => {
  it("handles unknown message types without throwing", () => {
    const message = normalizeMessage({ id: "x", type: "shell", time: { created: 5 } });
    expect(message).toMatchObject({ id: "x", role: "other", type: "shell", createdAt: 5 });
  });
});
