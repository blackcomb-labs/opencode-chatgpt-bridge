import type { OpencodeClient } from "./client.js";
import type { RegistryEntry, SessionRegistry } from "./registry.js";

export type CoordinatorOptions = {
  /** Session ids or titles the coordinator may read. Empty means no access. */
  allowlist: string[];
  allowAll: boolean;
  historyLimit: number;
  maxTextChars: number;
};

export type HistoryMessage = {
  id: string;
  role: string;
  createdAt: number;
  text: string;
  tools?: string[];
  error?: boolean;
  outcome?: string;
};

export type SessionReport = {
  resolved: {
    id: string;
    title: string;
    directory: string;
    createdAt: number;
    updatedAt: number;
  };
  allowed: boolean;
  /** Verified by the server that owns the session - never inferred. */
  verifiedRunning: boolean;
  lastActivityAt?: number;
  lastCompletedWork?: { id: string; at: number; text: string };
  currentTask?: { id: string; at: number; text: string; turnRunning: boolean };
  recentErrors: Array<{ id: string; at: number; text: string }>;
  /** The last few assistant messages in the window, for context. */
  recentActivity: Array<{ id: string; at: number; text: string }>;
  /** Honest notes about what the window could not show. */
  notes: string[];
  pendingPermissions: Array<{ id: string; action: string; resources: string[] }>;
  history: {
    count: number;
    oldestId?: string;
    newestId?: string;
    olderCursor?: string | null;
    messages: HistoryMessage[];
  };
};

export type Resolution =
  | { ok: true; sessionId: string }
  | { ok: false; reason: string; candidates?: Array<{ id: string; title?: string; directory: string }> };

/**
 * Resolve a human name to exactly one existing session.
 *
 * Never guesses: an ambiguous name is reported with its candidates.
 */
export function resolveSession(
  sessions: Array<{ id: string; title?: string; location?: { directory?: string } }>,
  wanted: string
): Resolution {
  const needle = (wanted ?? "").trim();
  if (!needle) return { ok: false, reason: "no session was named" };

  const byId = sessions.filter((session) => session.id === needle || session.id.startsWith(needle));
  if (byId.length === 1) return { ok: true, sessionId: byId[0]!.id };

  const lower = needle.toLowerCase();
  const byTitle = sessions.filter((session) => (session.title ?? "").toLowerCase() === lower);
  if (byTitle.length === 1) return { ok: true, sessionId: byTitle[0]!.id };

  const partial = sessions.filter((session) => (session.title ?? "").toLowerCase().includes(lower));
  if (partial.length === 1) return { ok: true, sessionId: partial[0]!.id };
  if (partial.length > 1) {
    return {
      ok: false,
      reason: `"${needle}" matches ${partial.length} sessions`,
      candidates: partial.map((session) => ({
        id: session.id,
        title: session.title,
        directory: session.location?.directory ?? ""
      }))
    };
  }
  if (byId.length > 1) {
    return {
      ok: false,
      reason: `"${needle}" matches ${byId.length} sessions by id`,
      candidates: byId.map((session) => ({ id: session.id, title: session.title, directory: session.location?.directory ?? "" }))
    };
  }
  return { ok: false, reason: `no session matches "${needle}"` };
}

export function isAllowed(options: CoordinatorOptions, sessionId: string, title: string): boolean {
  if (options.allowAll) return true;
  return options.allowlist.some((entry) => {
    const value = entry.trim();
    if (!value) return false;
    return sessionId.startsWith(value) || value.toLowerCase() === (title ?? "").toLowerCase();
  });
}

function truncate(text: string, max: number): string {
  const clean = (text ?? "").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}…[truncated ${clean.length - max} chars]`;
}

/**
 * Build a read-only report about one existing session.
 *
 * Nothing here writes to the session, opens its GUI, or approves anything.
 */
export async function buildSessionReport(
  client: OpencodeClient,
  registry: SessionRegistry,
  options: CoordinatorOptions,
  sessionId: string,
  includeHistory: boolean
): Promise<SessionReport> {
  const session = await client.getSession(sessionId);
  const title = session.title ?? "";
  const directory = session.location?.directory ?? "";

  const running = await client.isSessionRunning(sessionId);
  const page = await client.getMessages(sessionId, { limit: options.historyLimit });
  const messages = page.messages ?? [];
  const permissions = await client.listPermissions(sessionId).catch(() => []);

  const history: HistoryMessage[] = messages.map((message) => ({
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    text: truncate(message.text ?? "", options.maxTextChars),
    tools: message.tools?.map((tool) => tool.name),
    error: message.error !== undefined || message.outcome === "failed",
    outcome: message.outcome
  }));

  const assistants = messages.filter((message) => message.role === "assistant" && (message.text ?? "").trim());
  const users = messages.filter((message) => message.role === "user");
  const errors = messages.filter(
    (message) => message.error !== undefined || message.outcome === "failed" || message.outcome === "interrupted"
  );
  // A turn ends with an idle marker. "Last completed work" is the last
  // assistant message of the last *finished* turn; everything after the last
  // idle marker is the turn in flight.
  let lastIdle = -1;
  messages.forEach((message, index) => {
    if (message.role === "idle") lastIdle = index;
  });
  const finishedTurn = lastIdle >= 0 ? messages.slice(0, lastIdle) : [];
  const currentTurn = lastIdle >= 0 ? messages.slice(lastIdle + 1) : messages;
  const finishedAssistants = finishedTurn.filter(
    (message) => message.role === "assistant" && (message.text ?? "").trim()
  );
  const lastCompleted = finishedAssistants.length > 0 ? finishedAssistants[finishedAssistants.length - 1] : undefined;
  const currentUsers = currentTurn.filter((message) => message.role === "user");
  const lastUser = currentUsers.length > 0 ? currentUsers[currentUsers.length - 1] : undefined;
  const notes: string[] = [];
  if (!lastUser) {
    notes.push(
      "The request that started the current turn is older than the retrieved window; raise historyLimit or page back with olderCursor."
    );
  }
  if (!lastCompleted) {
    notes.push("No completed turn (idle marker) appears in the retrieved window.");
  }
  const lastActivity = messages.length > 0 ? messages[messages.length - 1]!.createdAt : undefined;

  await registry.upsert([
    {
      id: session.id,
      title,
      directory,
      createdAt: session.time?.created ?? 0,
      updatedAt: session.time?.updated ?? 0,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      accessible: true,
      running,
      lastMessageAt: lastActivity,
      lastError: errors.length > 0 ? truncate(errors[errors.length - 1]?.text ?? "error", 200) : undefined
    } satisfies RegistryEntry
  ]);

  return {
    resolved: {
      id: session.id,
      title,
      directory,
      createdAt: session.time?.created ?? 0,
      updatedAt: session.time?.updated ?? 0
    },
    allowed: isAllowed(options, session.id, title),
    verifiedRunning: running,
    lastActivityAt: lastActivity,
    lastCompletedWork: lastCompleted
      ? { id: lastCompleted.id, at: lastCompleted.createdAt, text: truncate(lastCompleted.text ?? "", options.maxTextChars) }
      : undefined,
    currentTask: lastUser
      ? { id: lastUser.id, at: lastUser.createdAt, text: truncate(lastUser.text ?? "", options.maxTextChars), turnRunning: running }
      : undefined,
    recentActivity: assistants.slice(-3).map((message) => ({
      id: message.id,
      at: message.createdAt,
      text: truncate(message.text ?? "", options.maxTextChars)
    })),
    notes,
    recentErrors: errors.slice(-5).map((message) => ({
      id: message.id,
      at: message.createdAt,
      text: truncate(message.text ?? "error", options.maxTextChars)
    })),
    pendingPermissions: permissions.map((permission) => ({
      id: permission.id,
      action: permission.action,
      resources: permission.resources
    })),
    history: {
      count: messages.length,
      oldestId: messages[0]?.id,
      newestId: messages[messages.length - 1]?.id,
      olderCursor: page.cursor?.previous ?? null,
      messages: includeHistory ? history : []
    }
  };
}
