export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type BridgeConfig = {
  host: string;
  port: number;
  autoPort: boolean;
  allowedHosts: string[];
  allowedRoots: string[];
  bridgeToken?: string;
  /** Allow `?token=` / path-token auth. Off by default so credentials stay in headers. */
  allowQueryToken: boolean;
  opencodeBaseUrl?: string;
  /** Path to opencode's service.json (credentials for the running background service). */
  opencodeServiceConfig: string;
  /** Use the already-running opencode background service instead of spawning one. */
  opencodeUseService: boolean;
  /** Model applied to newly created sessions, as "provider/model" or "provider/model#variant". */
  opencodeDefaultModel?: string;
  opencodeBin: string;
  opencodeHost: string;
  opencodePortStart: number;
  opencodeUsername: string;
  opencodePassword?: string;
  stateDir: string;
  tunnel: "none" | "cloudflare" | "tailscale";
  tailscaleBin: string;
  cloudflaredBin: string;
};

export type BridgeSession = {
  bridgeSessionId: string;
  opencodeSessionId: string;
  repoPath: string;
  baseUrl: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
};

export type OpencodeMessageRole = "user" | "assistant" | "idle" | "system" | "other";

export type OpencodeToolCall = {
  id: string;
  name: string;
  status?: string;
};

/**
 * Normalized view of a v2 message. The raw v2 shape is a discriminated union
 * (`user` carries `text`, `assistant` carries `content[]`, `idle` carries
 * `outcome`), so the bridge flattens it into one stable shape for MCP clients.
 */
export type OpencodeMessage = {
  id: string;
  role: OpencodeMessageRole;
  /** v2 message discriminator: user | assistant | idle | system | shell | skill | compaction | agent-switched | ... */
  type: string;
  text: string;
  createdAt: number;
  outcome?: "succeeded" | "failed" | "interrupted" | string;
  finish?: string;
  model?: { providerID?: string; id?: string; variant?: string };
  tools?: OpencodeToolCall[];
  error?: unknown;
};

export type OpencodeSession = {
  id: string;
  title?: string;
  parentID?: string;
  agent?: string;
  model?: { providerID?: string; id?: string; variant?: string };
  outcome?: string;
  time: { created: number; updated: number; idle?: number };
  location?: { directory?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export type MessagesPage = {
  messages: OpencodeMessage[];
  cursor?: { previous?: string | null; next?: string | null };
};

export type OpencodeSessionStatus = {
  sessionId: string;
  running: boolean;
  outcome?: string;
  lastIdleAt?: number;
  lastActivityAt?: number;
  lastMessageId?: string;
};

export type PermissionRequest = {
  id: string;
  sessionID?: string;
  action: string;
  resources: string[];
  message?: string;
  [key: string]: unknown;
};

export type OpencodeDiff = Record<string, unknown>;

export type ToolResult<T extends JsonValue = JsonValue> = {
  structuredContent: T;
  content: Array<{ type: "text"; text: string }>;
};
