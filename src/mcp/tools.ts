import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { BridgeConfig, JsonValue } from "../types.js";
import { isPathWithinRoots, listProjects, resolvePathWithinRoot, validateRepoPath } from "../security/paths.js";
import { OpencodeProcessManager } from "../opencode/process.js";
import { sanitizeRelativePath } from "../opencode/client.js";
import { SessionRegistry } from "../opencode/registry.js";
import { buildSessionReport, isAllowed, resolveSession } from "../opencode/report.js";
import { StateStore } from "../state/store.js";
import { safeTool } from "./results.js";

type RegisterContext = {
  config: BridgeConfig;
  processManager: OpencodeProcessManager;
  state: StateStore;
};

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const MAX_WAIT_MS = 300_000;

/**
 * Explicit read-only surface. This is the allowlist used to prune tools/list
 * and reject tools/call when readOnly is enabled. Unknown names fail closed.
 */
export const READ_ONLY_TOOL_NAMES = new Set([
  "bridge_health",
  "list_projects",
  "opencode_list_sessions",
  "opencode_attach_session",
  "opencode_get_session_status",
  "opencode_wait_for_completion",
  "opencode_get_messages",
  "opencode_get_diff",
  "opencode_list_permissions",
  "opencode_read_file",
  "opencode_find_files",
  "opencode_vcs_status"
]);

const WRITE_TOOL_NAMES = [
  "opencode_start",
  "opencode_stop",
  "opencode_create_session",
  "opencode_send_message",
  "opencode_abort",
  "opencode_respond_permission"
] as const;

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(name) && !WRITE_TOOL_NAMES.includes(name as (typeof WRITE_TOOL_NAMES)[number]);
}

/** Permit exactly one mutating MCP tool in send-only mode. Defaults remain fail closed. */
export function isExposedTool(name: string, policy: Pick<BridgeConfig, "readOnly" | "allowSendMessage">): boolean {
  if (!policy.readOnly) return true; // Legacy full-access mode requires a separate explicit opt-out.
  return isReadOnlyTool(name) || (policy.allowSendMessage && name === "opencode_send_message");
}

export function createBridgeMcpServer(ctx: RegisterContext): McpServer {
  const server = new McpServer(
    { name: "opencode-chatgpt-bridge", version: "0.2.0" },
    {
      instructions:
        "This server controls local opencode v2 sessions. Start with list_projects, then opencode_list_sessions or opencode_attach_session to work with an existing session, or opencode_create_session for a new one. " +
        "opencode_send_message is asynchronous by default: it returns an accepted message id immediately. Use opencode_wait_for_completion (bounded) or opencode_get_session_status to detect completion, and pass sinceMessageId to opencode_get_messages so replies are never duplicated. " +
        "Always review opencode_get_diff before claiming code changes are complete. " +
        "Never assume a permission request was approved: opencode_list_permissions surfaces pending requests and opencode_respond_permission requires an explicit decision."
    }
  );

  server.registerTool(
    "bridge_health",
    {
      title: "Bridge health",
      description: "Check bridge configuration, managed opencode servers, and their v2 API versions.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () =>
      safeTool(async () => {
        const processes = await Promise.all(
          // live() keeps the real password; list() redacts it and would 401.
          ctx.processManager.live().map(async (proc) => {
            const client = ctx.processManager.clientFor(proc);
            const health = await client.health().catch((error: unknown) => ({
              healthy: false,
              error: error instanceof Error ? error.message : String(error)
            }));
            return {
              repoPath: proc.repoPath,
              baseUrl: proc.baseUrl,
              port: proc.port ?? null,
              startedAt: proc.startedAt,
              health: json(health)
            };
          })
        );
        return {
          ok: true,
          bridgeVersion: "0.2.0",
          opencodeApi: "v2",
          readOnly: ctx.config.readOnly,
          sendMessageEnabled: !ctx.config.readOnly || ctx.config.allowSendMessage,
          allowedRoots: ctx.config.allowedRoots,
          opencodeBaseUrl: ctx.config.opencodeBaseUrl ?? null,
          managedProcesses: processes,
          tokenAuthEnabled: Boolean(ctx.config.bridgeToken)
        };
      })
  );

  server.registerTool(
    "list_projects",
    {
      title: "List local projects",
      description: "List Git repositories under the configured allowed roots.",
      inputSchema: { depth: z.number().int().min(0).max(5).default(2) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ depth }) => safeTool(async () => ({ projects: json(await listProjects(ctx.config.allowedRoots, depth)) }))
  );

  server.registerTool(
    "opencode_start",
    {
      title: "Start opencode server",
      description: "Start or reuse a local opencode v2 server for a repo path within the allowed roots.",
      inputSchema: { repoPath: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ repoPath }) =>
      safeTool(async () => {
        const validated = await validateRepoPath(repoPath, ctx.config.allowedRoots);
        const managed = await ctx.processManager.ensure(validated);
        const client = ctx.processManager.clientFor(managed);
        return { ok: true, repoPath: validated, baseUrl: managed.baseUrl, health: json(await client.health()) };
      })
  );

  server.registerTool(
    "opencode_stop",
    {
      title: "Stop opencode server",
      description: "Stop managed opencode servers spawned by the bridge. Omitting repoPath stops all managed servers.",
      inputSchema: { repoPath: z.string().optional() },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ repoPath }) =>
      safeTool(async () => {
        const validated = repoPath ? await validateRepoPath(repoPath, ctx.config.allowedRoots) : undefined;
        return { ok: true, ...(await ctx.processManager.stop(validated)) };
      })
  );

  server.registerTool(
    "opencode_list_sessions",
    {
      title: "List sessions",
      description:
        "List bridge sessions, and optionally the real opencode sessions that exist on disk (these are attachable with opencode_attach_session).",
      inputSchema: {
        repoPath: z.string().optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        includeBridgeSessions: z.boolean().default(true),
        includeOpencodeSessions: z.boolean().default(true)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ repoPath, search, limit, includeBridgeSessions, includeOpencodeSessions }) =>
      safeTool(async () => {
        const bridgeSessions = includeBridgeSessions ? await ctx.state.listSessions() : [];
        let opencodeSessions: unknown[] = [];
        if (includeOpencodeSessions) {
          const validated = repoPath ? await validateRepoPath(repoPath, ctx.config.allowedRoots) : undefined;
          const root = validated ?? ctx.config.allowedRoots[0];
          if (!root) throw new Error("No allowed roots configured");
          const managed = await ctx.processManager.ensure(root);
          const client = ctx.processManager.clientFor(managed);
          const window = Math.min(200, Math.max(limit * 4, 50));
          opencodeSessions = (await client.listSessions({ limit: window, search, order: "desc" }))
            // Never advertise sessions from directories the bridge may not touch.
            .filter((session) => {
              const directory = session.location?.directory;
              return Boolean(directory) && isPathWithinRoots(directory as string, ctx.config.allowedRoots);
            })
            .slice(0, limit)
            .map((session) => ({
              opencodeSessionId: session.id,
              title: session.title,
              directory: session.location?.directory,
              outcome: session.outcome,
              updatedAt: session.time?.updated,
              attachable: true
            }));
        }
        return { bridgeSessions: json(bridgeSessions), opencodeSessions: json(opencodeSessions) };
      })
  );

  server.registerTool(
    "opencode_create_session",
    {
      title: "Create opencode session",
      description: "Create a new opencode v2 session for a repo. Returns a bridgeSessionId used by the other tools.",
      inputSchema: {
        repoPath: z.string().min(1),
        title: z.string().optional(),
        parentID: z.string().optional(),
        model: z
          .string()
          .optional()
          .describe("Model as provider/model or provider/model#variant. Defaults to the bridge's configured model.")
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ repoPath, title, parentID, model }) =>
      safeTool(async () => {
        const validated = await validateRepoPath(repoPath, ctx.config.allowedRoots);
        const managed = await ctx.processManager.ensure(validated);
        const client = ctx.processManager.clientFor(managed);
        const session = await client.createSession(title, parentID, model ?? ctx.config.opencodeDefaultModel);
        if (!session.id) throw new Error(`opencode returned a session without an id: ${JSON.stringify(session)}`);
        const bridge = await ctx.state.createSession({
          opencodeSessionId: session.id,
          repoPath: validated,
          baseUrl: managed.baseUrl,
          title: title ?? session.title
        });
        return { ok: true, bridgeSession: json(bridge), opencodeSession: json(session) };
      })
  );

  server.registerTool(
    "opencode_attach_session",
    {
      title: "Attach to existing opencode session",
      description:
        "Attach to an existing opencode session (for example the one currently open in the TUI) so ChatGPT can read its history and post follow-up prompts into it. Does not create a new session and does not change the session itself; it only records a local mapping.",
      inputSchema: {
        opencodeSessionId: z.string().min(1),
        repoPath: z.string().optional(),
        title: z.string().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ opencodeSessionId, repoPath, title }) =>
      safeTool(async () => {
        const fallbackRepo = repoPath
          ? await validateRepoPath(repoPath, ctx.config.allowedRoots)
          : ctx.config.allowedRoots[0];
        if (!fallbackRepo) throw new Error("No allowed roots configured");
        const probe = ctx.processManager.clientFor(await ctx.processManager.ensure(fallbackRepo));
        const session = await probe.getSession(opencodeSessionId);

        // A session is bound to the directory it was created in. Never fall back
        // to a different repo: that would expose history from outside the
        // allowlist and run prompts in the wrong project.
        const sessionDir = session.location?.directory;
        let effectiveRepo: string;
        if (sessionDir) {
          if (!isPathWithinRoots(sessionDir, ctx.config.allowedRoots)) {
            throw new Error(`Session ${opencodeSessionId} lives at ${sessionDir}, which is outside the allowed roots.`);
          }
          effectiveRepo = await validateRepoPath(sessionDir, ctx.config.allowedRoots);
        } else {
          if (!repoPath) throw new Error(`Session ${opencodeSessionId} has no location; pass repoPath explicitly.`);
          effectiveRepo = await validateRepoPath(repoPath, ctx.config.allowedRoots);
        }

        const managed = await ctx.processManager.ensure(effectiveRepo);
        const client = ctx.processManager.clientFor(managed);
        const verified = await client.getSession(opencodeSessionId);

        const existing = (await ctx.state.listSessions()).find(
          (item) => item.opencodeSessionId === opencodeSessionId && item.repoPath === effectiveRepo
        );
        const bridge =
          existing ??
          (await ctx.state.createSession({
            opencodeSessionId,
            repoPath: effectiveRepo,
            baseUrl: managed.baseUrl,
            title: title ?? verified.title
          }));

        return { ok: true, attached: true, bridgeSession: json(bridge), opencodeSession: json(verified) };
      })
  );

  server.registerTool(
    "opencode_get_session_status",
    {
      title: "Get opencode session status",
      description:
        "Get running/idle state, last outcome, last activity, and the number of pending permission requests for a bridge session.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const [status, permissions] = await Promise.all([
          client.getSessionStatus(bridge.opencodeSessionId),
          client.listPermissions(bridge.opencodeSessionId).catch(() => [])
        ]);
        return {
          bridgeSession: json(bridge),
          status: json(status),
          pendingPermissions: json(permissions),
          pendingPermissionCount: permissions.length
        };
      })
  );

  server.registerTool(
    "opencode_send_message",
    {
      title: "Send opencode message",
      description:
        "Send a prompt to an opencode session. Returns as soon as opencode accepts it. Set wait=true to block up to timeoutMs for completion.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        text: z.string().min(1),
        wait: z.boolean().default(false),
        timeoutMs: z.number().int().min(1000).max(MAX_WAIT_MS).default(45_000),
        delivery: z.enum(["steer", "queue"]).optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async (input) =>
      safeTool(async () => {
        if (ctx.config.readOnly && !ctx.config.allowSendMessage) {
          throw new Error("Message sending is disabled by bridge policy");
        }
        const bridge = await ctx.state.getSession(input.bridgeSessionId);
        // Stored mappings can outlive allowed-roots changes. Revalidate on every send.
        const validatedRepo = await validateRepoPath(bridge.repoPath, ctx.config.allowedRoots);
        const managed = await ctx.processManager.ensure(validatedRepo);
        const client = ctx.processManager.clientFor(managed);
        // Do not send into a missing, moved, or differently located session.
        const liveSession = await client.getSession(bridge.opencodeSessionId);
        const liveDir = liveSession.location?.directory;
        if (!liveDir || (await validateRepoPath(liveDir, ctx.config.allowedRoots)) !== validatedRepo) {
          throw new Error("Session location no longer matches the attached project");
        }
        const since = Date.now();
        const accepted = await client.prompt(bridge.opencodeSessionId, input.text, { delivery: input.delivery });
        await ctx.state.updateSession(input.bridgeSessionId, {});

        if (!input.wait) {
          return { ok: true, accepted: json(accepted ?? null), completion: null };
        }

        const completion = await client.waitForCompletion(bridge.opencodeSessionId, {
          since,
          timeoutMs: input.timeoutMs
        });
        return { ok: true, accepted: json(accepted ?? null), completion: json(completion) };
      })
  );

  server.registerTool(
    "opencode_wait_for_completion",
    {
      title: "Wait for opencode completion",
      description:
        "Poll an opencode session until an idle marker newer than sinceMessageId appears, or the bounded timeout expires. Returns a timedOut flag instead of blocking forever.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        sinceMessageId: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(MAX_WAIT_MS).default(60_000)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, sinceMessageId, timeoutMs }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        let since = 0;
        if (sinceMessageId) {
          const page = await client.getMessages(bridge.opencodeSessionId, { limit: 200 });
          since = page.messages.find((message) => message.id === sinceMessageId)?.createdAt ?? 0;
        }
        return { completion: json(await client.waitForCompletion(bridge.opencodeSessionId, { since, timeoutMs })) };
      })
  );

  server.registerTool(
    "opencode_get_messages",
    {
      title: "Get opencode messages",
      description:
        "Fetch a session transcript (oldest first). Pass sinceMessageId to receive only messages newer than that id, which prevents duplicate replies when polling.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(100),
        sinceMessageId: z.string().optional(),
        type: z.string().optional(),
        cursor: z.string().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, limit, sinceMessageId, type, cursor }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const window = sinceMessageId ? Math.min(200, Math.max(limit, 200)) : limit;
        const page = await client.getMessages(bridge.opencodeSessionId, { limit: window, type, cursor });

        let messages = page.messages;
        let matchedSince = true;
        if (sinceMessageId) {
          const index = messages.findIndex((message) => message.id === sinceMessageId);
          matchedSince = index >= 0;
          // A cursor that is not in the window must NOT degrade into "here is
          // the whole transcript": callers would read old messages as new
          // ones. Return nothing and let the caller decide.
          messages = index >= 0 ? messages.slice(index + 1) : [];
        }

        return {
          bridgeSession: json(bridge),
          count: messages.length,
          matchedSince,
          cursor: json(page.cursor ?? null),
          messages: json(messages)
        };
      })
  );

  server.registerTool(
    "opencode_get_diff",
    {
      title: "Get opencode diff",
      description: "Fetch file diffs for a session turn. Call this before summarizing completed code work.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        fromMessageId: z.string().optional(),
        toMessageId: z.string().optional(),
        context: z.number().int().min(0).max(20).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, fromMessageId, toMessageId, context }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const diff = await client.getDiff(bridge.opencodeSessionId, {
          from: fromMessageId,
          to: toMessageId,
          context
        });
        return { bridgeSession: json(bridge), files: diff.length, diff: json(diff) };
      })
  );

  server.registerTool(
    "opencode_abort",
    {
      title: "Abort opencode session",
      description: "Interrupt a running opencode session.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { ok: await client.interrupt(bridge.opencodeSessionId) };
      })
  );

  server.registerTool(
    "opencode_list_permissions",
    {
      title: "List pending permissions",
      description:
        "List permission requests opencode is waiting on. Nothing is ever approved automatically; a human decision is required.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const permissions = await client.listPermissions(bridge.opencodeSessionId);
        return { count: permissions.length, permissions: json(permissions) };
      })
  );

  server.registerTool(
    "opencode_respond_permission",
    {
      title: "Respond to opencode permission",
      description:
        "Answer a pending permission request. Requires an explicit decision; there is no auto-approve path.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        permissionId: z.string().min(1),
        decision: z.enum(["once", "always", "reject"]),
        message: z.string().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ bridgeSessionId, permissionId, decision, message }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const result = await client.replyPermission(bridge.opencodeSessionId, permissionId, decision, message);
        return { ok: true, decision, result: json(result ?? null) };
      })
  );

  server.registerTool(
    "opencode_read_file",
    {
      title: "Read project file through opencode",
      description: "Read a file from the session's project through the opencode filesystem API.",
      inputSchema: { bridgeSessionId: z.string().min(1), path: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, path }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const relative = sanitizeRelativePath(path);
        await resolvePathWithinRoot(bridge.repoPath, relative);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const content = await client.readFile(relative, bridge.repoPath);
        return { path: relative, bytes: content.length, content };
      })
  );

  server.registerTool(
    "opencode_find_files",
    {
      title: "Find project files through opencode",
      description: "Fuzzy find files in the session's project.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
        type: z.enum(["file", "directory"]).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, query, limit, type }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const files = await client.findFiles(query, { limit, type, location: bridge.repoPath });
        const safeFiles: typeof files = [];
        for (const file of files) {
          try {
            await resolvePathWithinRoot(bridge.repoPath, file.path);
            safeFiles.push(file);
          } catch {
            // Drop symlink/junction escapes and vanished entries.
          }
        }
        return { files: json(safeFiles) };
      })
  );

  server.registerTool(
    "opencode_vcs_status",
    {
      title: "Get VCS status",
      description: "Get git status for the session's project.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const files = await client.vcsStatus(bridge.repoPath);
        return { files: files.length, status: json(files) };
      })
  );

  server.registerTool(
    "opencode_capabilities",
    {
      title: "List opencode capabilities",
      description: "List non-sensitive agent and command names. Provider configuration and credentials are not returned.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await ctx.state.getSession(bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        // Never send raw provider/config objects to an MCP client: these can
        // contain API keys, Authorization headers and provider-specific secrets.
        const [agents, commands] = await Promise.all([
          client.listAgents(),
          client.listCommands()
        ]);
        const namesOnly = (items: unknown): string[] => {
          if (!Array.isArray(items)) return [];
          return items.flatMap((item: unknown) => {
            if (!item || typeof item !== "object") return [];
            const name = (item as Record<string, unknown>).name;
            return typeof name === "string" && /^[A-Za-z0-9._/@ -]{1,96}$/.test(name)
              ? [name]
              : [];
          });
        };
        return {
          agents: namesOnly(agents),
          commands: namesOnly(commands),
          providerConfigurationOmitted: true
        };
      })
  );

  const coordinatorOptions = {
    allowlist: ctx.config.coordinatorSessions,
    allowAll: ctx.config.coordinatorAllowAll,
    historyLimit: 100,
    maxTextChars: 2000
  };

  server.registerTool(
    "opencode_session_registry",
    {
      title: "Discover opencode sessions",
      description:
        "Read-only. Lists the OpenCode sessions that exist on this machine with their real ids, titles, working directories, accessibility and verified running state, and records them so a name can later be resolved to the same session.",
      inputSchema: {
        refresh: z.boolean().default(true),
        limit: z.number().int().min(1).max(200).default(100),
        includeNotAllowed: z.boolean().default(false)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ refresh, limit, includeNotAllowed }) =>
      safeTool(async () => {
        const managed = await ctx.processManager.ensure(ctx.config.allowedRoots[0] ?? process.cwd());
        const client = ctx.processManager.clientFor(managed);
        const registry = new SessionRegistry(ctx.config.stateDir);
        const sessions = refresh ? await client.listSessions({ limit }) : [];
        const running = (await client.serviceActiveSessions()) ?? (await client.activeSessions().catch(() => ({})));
        await registry.upsert(
          sessions.map((session) => ({
            id: session.id,
            title: session.title ?? "",
            directory: session.location?.directory ?? "",
            createdAt: session.time?.created ?? 0,
            updatedAt: session.time?.updated ?? 0,
            firstSeenAt: Date.now(),
            lastSeenAt: Date.now(),
            accessible: true,
            running: (running as Record<string, { type?: string }>)[session.id]?.type === "running"
          }))
        );
        const known: Awaited<ReturnType<SessionRegistry["list"]>> = await registry.list();
        const visible = known.filter(
          (entry) => includeNotAllowed || isAllowed(coordinatorOptions, entry.id, entry.title)
        );
        return {
          count: visible.length,
          known: known.length,
          allowlist: ctx.config.coordinatorSessions,
          sessions: json(
            visible.map((entry) => ({
              id: entry.id,
              title: entry.title,
              directory: entry.directory,
              updatedAt: entry.updatedAt,
              lastMessageAt: entry.lastMessageAt,
              running: entry.running,
              accessible: entry.accessible,
              allowed: isAllowed(coordinatorOptions, entry.id, entry.title)
            }))
          )
        };
      })
  );

  server.registerTool(
    "opencode_session_report",
    {
      title: "Report on an opencode session",
      description:
        "Read-only. Resolves a session by id or exact name and reports its verified running state, last completed work, current task, recent errors, pending permissions and the latest messages. It never writes to the session, never opens its window and never approves anything.",
      inputSchema: {
        session: z.string().min(1),
        historyLimit: z.number().int().min(1).max(200).default(100),
        includeHistory: z.boolean().default(false)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ session, historyLimit, includeHistory }) =>
      safeTool(async () => {
        const managed = await ctx.processManager.ensure(ctx.config.allowedRoots[0] ?? process.cwd());
        const client = ctx.processManager.clientFor(managed);
        const registry = new SessionRegistry(ctx.config.stateDir);
        const sessions = await client.listSessions({ limit: 200 });
        const resolution = resolveSession(
          sessions.map((item) => ({ id: item.id, title: item.title, location: item.location })),
          session
        );
        if (!resolution.ok) {
          return {
            ok: false as const,
            error: resolution.reason,
            candidates: json(resolution.candidates ?? []),
            sessionId: "",
            allowlist: [] as string[],
            report: null
          };
        }
        const report = await buildSessionReport(
          client,
          registry,
          { ...coordinatorOptions, historyLimit },
          resolution.sessionId,
          includeHistory
        );
        if (!report.allowed) {
          return {
            ok: false as const,
            error: "that session is not in the coordinator allowlist",
            candidates: null,
            sessionId: report.resolved.id,
            allowlist: ctx.config.coordinatorSessions,
            report: null
          };
        }
        return {
          ok: true as const,
          error: "",
          candidates: null,
          sessionId: report.resolved.id,
          allowlist: ctx.config.coordinatorSessions,
          report: json(report)
        };
      })
  );

  // ChatGPT Connector creation can be stricter than raw MCP clients.
  // The current MCP SDK adds experimental task execution metadata to every
  // registerTool() descriptor. We do not use task-augmented execution, so omit
  // it from tools/list for maximum Apps SDK compatibility.
  const registeredTools = (server as unknown as { _registeredTools?: Record<string, { execution?: unknown }> })._registeredTools;
  if (registeredTools) {
    if (ctx.config.readOnly) {
      // Deleting from the registry feeds both tools/list and tools/call: denied
      // tools are not advertised and unknown names are rejected by the SDK.
      for (const name of Object.keys(registeredTools)) {
        if (!isExposedTool(name, ctx.config)) delete registeredTools[name];
      }
    }
    for (const tool of Object.values(registeredTools)) {
      tool.execution = undefined;
    }
  }

  return server;
}
