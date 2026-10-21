import type {
  MessagesPage,
  OpencodeDiff,
  OpencodeMessage,
  OpencodeSession,
  OpencodeSessionStatus,
  PermissionRequest
} from "../types.js";

export type OpencodeClientOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type ListSessionsOptions = {
  limit?: number;
  order?: "asc" | "desc";
  search?: string;
  directory?: string;
  archived?: boolean;
  parentID?: string;
  cursor?: string;
};

export type GetMessagesOptions = {
  limit?: number;
  cursor?: string;
  type?: string;
};

export type PromptOptions = {
  /** `steer` delivers immediately even mid-turn; `queue` waits for the current turn. */
  delivery?: "steer" | "queue";
  messageID?: string;
};

export type WaitOptions = {
  /** Only consider completion markers created after this epoch ms. */
  since?: number;
  timeoutMs?: number;
  pollMs?: number;
};

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

type Query = Record<string, string | number | boolean | undefined | null>;

const DEFAULT_TIMEOUT_MS = 30_000;

export class OpencodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly bodyPreview: string
  ) {
    super(`opencode ${method} ${path} failed: ${status}${bodyPreview ? ` - ${bodyPreview}` : ""}`);
    this.name = "OpencodeHttpError";
  }
}

export class OpencodeClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpencodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.username = options.username ?? "opencode";
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get url(): string {
    return this.baseUrl;
  }

  private headers(extra?: HeadersInit): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(extra as Record<string, string> | undefined)
    };
    if (this.password) {
      const token = Buffer.from(`${this.username}:${this.password}`).toString("base64");
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  }

  private buildUrl(path: string, query?: Query): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  private async request<T>(
    method: HttpMethod,
    path: string,
    options: { query?: Query; body?: unknown } = {}
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const init: RequestInit = {
      method,
      headers: this.headers(options.body === undefined ? undefined : { "Content-Type": "application/json" }),
      signal: AbortSignal.timeout(this.timeoutMs)
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`opencode ${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OpencodeHttpError(response.status, method, path, body.slice(0, 400));
    }
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    if (!text) return undefined as T;

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return JSON.parse(text) as T;
    }
    return text as unknown as T;
  }

  /** Most v2 endpoints wrap their payload in `{ data: ... }`. */
  private async requestData<T>(method: HttpMethod, path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    const result = await this.request<{ data: T } | T>(method, path, options);
    if (result && typeof result === "object" && "data" in (result as Record<string, unknown>)) {
      return (result as { data: T }).data;
    }
    return result as T;
  }

  async info(): Promise<{ version: string; pid: number; urls: string[] }> {
    return await this.request<{ version: string; pid: number; urls: string[] }>("GET", "/api/info");
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    const info = await this.info();
    return { healthy: true, version: info.version };
  }

  async listSessions(options: ListSessionsOptions = {}): Promise<OpencodeSession[]> {
    return (
      (await this.requestData<OpencodeSession[]>("GET", "/api/session", {
        query: {
          limit: options.limit ?? 50,
          order: options.order ?? "desc",
          search: options.search,
          directory: options.directory,
          archived: options.archived === undefined ? undefined : String(options.archived),
          parentID: options.parentID,
          cursor: options.cursor
        }
      })) ?? []
    );
  }

  async createSession(title?: string, parentID?: string): Promise<OpencodeSession> {
    const body: Record<string, unknown> = {};
    if (title) body.title = title;
    if (parentID) body.parentID = parentID;
    return await this.requestData<OpencodeSession>("POST", "/api/session", { body });
  }

  async getSession(sessionId: string): Promise<OpencodeSession> {
    return await this.requestData<OpencodeSession>("GET", `/api/session/${encodeURIComponent(sessionId)}`);
  }

  async renameSession(sessionId: string, title: string): Promise<OpencodeSession> {
    return await this.requestData<OpencodeSession>("PATCH", `/api/session/${encodeURIComponent(sessionId)}`, {
      body: { title }
    });
  }

  async activeSessions(): Promise<Record<string, { type: string }>> {
    return (await this.requestData<Record<string, { type: string }>>("GET", "/api/session/active")) ?? {};
  }

  /**
   * v2 always returns newest-first unless `order=asc` is passed. The bridge
   * normalizes to oldest-first so consumers can read transcripts naturally.
   */
  async getMessages(sessionId: string, options: GetMessagesOptions = {}): Promise<MessagesPage> {
    const page = await this.request<{
      data?: unknown[];
      cursor?: { previous?: string | null; next?: string | null };
    }>("GET", `/api/session/${encodeURIComponent(sessionId)}/message`, {
      query: { limit: options.limit ?? 100, cursor: options.cursor, type: options.type }
    });
    const messages = (page?.data ?? []).map(normalizeMessage).sort((a, b) => a.createdAt - b.createdAt);
    return { messages, cursor: page?.cursor };
  }

  async prompt(sessionId: string, text: string, options: PromptOptions = {}): Promise<{ id?: string; delivery?: string }> {
    const body: Record<string, unknown> = { text };
    if (options.delivery) body.delivery = options.delivery;
    if (options.messageID) body.id = options.messageID;
    return await this.requestData<{ id?: string; delivery?: string }>(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      { body }
    );
  }

  async interrupt(sessionId: string): Promise<boolean> {
    await this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`);
    return true;
  }

  async getSessionStatus(sessionId: string): Promise<OpencodeSessionStatus> {
    const [active, page, idlePage] = await Promise.all([
      this.activeSessions().catch(() => ({}) as Record<string, { type: string }>),
      this.getMessages(sessionId, { limit: 30 }),
      this.getMessages(sessionId, { limit: 1, type: "idle" }).catch(() => ({ messages: [] }) as MessagesPage)
    ]);
    const idle = [...idlePage.messages].reverse()[0];
    const last = page.messages[page.messages.length - 1];
    return {
      sessionId,
      running: active[sessionId]?.type === "running",
      outcome: idle?.outcome,
      lastIdleAt: idle?.createdAt,
      lastActivityAt: last?.createdAt,
      lastMessageId: last?.id
    };
  }

  /**
   * Polls until an `idle` marker newer than `since` appears. Bounded by
   * timeoutMs so callers (and MCP clients) never block indefinitely.
   */
  async waitForCompletion(
    sessionId: string,
    options: WaitOptions = {}
  ): Promise<{ completed: boolean; timedOut: boolean; running: boolean; outcome?: string; messages: OpencodeMessage[] }> {
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 60_000, 1_000), 120_000);
    const pollMs = Math.max(options.pollMs ?? 750, 250);
    const since = options.since ?? 0;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const [page, idlePage, active] = await Promise.all([
        this.getMessages(sessionId, { limit: 60 }),
        this.getMessages(sessionId, { limit: 5, type: "idle" }).catch(() => ({ messages: [] }) as MessagesPage),
        this.activeSessions().catch(() => ({}) as Record<string, { type: string }>)
      ]);
      const idle = [...idlePage.messages].reverse().find((message) => message.createdAt > since);
      const running = active[sessionId]?.type === "running";
      const fresh = page.messages.filter((message) => message.createdAt > since);

      if (idle && !running) {
        return { completed: true, timedOut: false, running: false, outcome: idle.outcome, messages: fresh };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    const finalPage = await this.getMessages(sessionId, { limit: 60 });
    const active = await this.activeSessions().catch(() => ({}) as Record<string, { type: string }>);
    return {
      completed: false,
      timedOut: true,
      running: active[sessionId]?.type === "running",
      messages: finalPage.messages.filter((message) => message.createdAt > since)
    };
  }

  async getDiff(sessionId: string, options: { from?: string; to?: string; context?: number } = {}): Promise<OpencodeDiff[]> {
    return (
      (await this.requestData<OpencodeDiff[]>("GET", `/api/session/${encodeURIComponent(sessionId)}/diff`, {
        query: { from: options.from, to: options.to, context: options.context }
      })) ?? []
    );
  }

  async listPermissions(sessionId: string): Promise<PermissionRequest[]> {
    return (
      (await this.requestData<PermissionRequest[]>("GET", `/api/session/${encodeURIComponent(sessionId)}/permission`)) ?? []
    );
  }

  async replyPermission(
    sessionId: string,
    requestId: string,
    decision: "once" | "always" | "reject",
    message?: string
  ): Promise<unknown> {
    return await this.requestData(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { body: { decision, ...(message ? { message } : {}) } }
    );
  }

  async readFile(path: string, location?: string): Promise<string> {
    const relative = sanitizeRelativePath(path);
    const encoded = relative.split("/").map(encodeURIComponent).join("/");
    return await this.request<string>("GET", `/api/fs/read/${encoded}`, { query: { location } });
  }

  async findFiles(query: string, options: { limit?: number; type?: "file" | "directory"; location?: string } = {}): Promise<Array<{ path: string; type?: string }>> {
    return (
      (await this.requestData<Array<{ path: string; type?: string }>>("GET", "/api/fs/find", {
        query: { query, limit: options.limit ?? 50, type: options.type, location: options.location }
      })) ?? []
    );
  }

  async vcsStatus(location?: string): Promise<unknown[]> {
    return (await this.requestData<unknown[]>("GET", "/api/vcs/status", { query: { location } })) ?? [];
  }

  async listAgents(): Promise<unknown[]> {
    return (await this.requestData<unknown[]>("GET", "/api/agent")) ?? [];
  }

  async listCommands(): Promise<unknown[]> {
    return (await this.requestData<unknown[]>("GET", "/api/command")) ?? [];
  }

  async listProviders(): Promise<unknown[]> {
    return (await this.requestData<unknown[]>("GET", "/api/provider")) ?? [];
  }

  async getConfig(): Promise<unknown> {
    return await this.request<unknown>("GET", "/api/config");
  }
}

/** Rejects traversal attempts before they ever reach opencode. */
export function sanitizeRelativePath(path: string): string {
  const trimmed = path.replace(/^\.\/+/, "").replace(/^\/+/, "");
  const segments = trimmed.split("/");
  if (!trimmed || segments.some((segment) => segment === "..")) {
    throw new Error(`Refusing to read a path outside the project: ${path}`);
  }
  return trimmed;
}

export function normalizeMessage(raw: unknown): OpencodeMessage {
  const record = (raw ?? {}) as Record<string, unknown>;
  const type = String(record.type ?? "unknown");
  const createdAt = Number((record.time as { created?: number } | undefined)?.created ?? 0);
  const id = String(record.id ?? "");

  if (type === "assistant") {
    const content = Array.isArray(record.content) ? (record.content as Record<string, unknown>[]) : [];
    const text = content
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("");
    const tools = content
      .filter((part) => part.type === "tool")
      .map((part) => ({
        id: String(part.id ?? ""),
        name: String(part.name ?? ""),
        status: String((part.state as { status?: string } | undefined)?.status ?? "")
      }));
    return {
      id,
      role: "assistant",
      type,
      text,
      createdAt,
      finish: typeof record.finish === "string" ? record.finish : undefined,
      model: record.model as OpencodeMessage["model"],
      tools: tools.length > 0 ? tools : undefined,
      error: record.error
    };
  }

  if (type === "user") {
    return { id, role: "user", type, text: String(record.text ?? ""), createdAt };
  }

  if (type === "idle") {
    return {
      id,
      role: "idle",
      type,
      text: "",
      createdAt,
      outcome: typeof record.outcome === "string" ? record.outcome : undefined,
      error: record.error
    };
  }

  if (type === "system") {
    return { id, role: "system", type, text: String(record.text ?? ""), createdAt };
  }

  return { id, role: "other", type, text: String(record.text ?? ""), createdAt };
}
