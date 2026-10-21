import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import process from "node:process";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response, NextFunction } from "express";
import type { BridgeConfig } from "../types.js";
import { OpencodeProcessManager } from "../opencode/process.js";
import { StateStore } from "../state/store.js";
import { createBridgeMcpServer } from "../mcp/tools.js";

export type BridgeRuntime = {
  config: BridgeConfig;
  processManager: OpencodeProcessManager;
  state: StateStore;
};

export function createRuntime(config: BridgeConfig): BridgeRuntime {
  return {
    config,
    processManager: new OpencodeProcessManager(config),
    state: new StateStore(config.stateDir)
  };
}

function authMiddleware(config: BridgeConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (authorized(config, req)) {
      next();
      return;
    }
    res.status(401).json({ error: "Missing or invalid bearer token" });
  };
}

function authorized(config: BridgeConfig, req: Request): boolean {
  if (!config.bridgeToken) return true;
  const header = req.header("authorization") ?? "";
  const bearer = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer === config.bridgeToken) return true;
  // Query/path tokens leak into proxy and tunnel logs, so they are opt-in.
  if (!config.allowQueryToken) return false;
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  const pathToken = typeof req.params.token === "string" ? req.params.token : undefined;
  return queryToken === config.bridgeToken || pathToken === config.bridgeToken;
}

/**
 * DNS-rebinding protection with wildcard support. Tunnel hostnames are random
 * (Cloudflare quick tunnels) or only known at runtime (Tailscale Funnel), so
 * exact-match validation from the SDK is too rigid. The allowlist is read on
 * every request, which lets cli.ts register a tunnel host after boot.
 */
function hostGuard(config: BridgeConfig) {
  const always = new Set(["127.0.0.1", "localhost", "::1"]);
  return (req: Request, res: Response, next: NextFunction) => {
    const rawHost = (req.headers.host ?? "").toLowerCase();
    const host = rawHost.startsWith("[") ? rawHost.slice(0, rawHost.indexOf("]") + 1) : rawHost.split(":")[0] ?? "";
    if (!host || always.has(host)) {
      next();
      return;
    }
    const allowed = config.allowedHosts.map((entry) => entry.toLowerCase());
    const exact = allowed.some((entry) => !entry.startsWith("*.") && entry === host);
    const suffix = allowed
      .filter((entry) => entry.startsWith("*."))
      .some((entry) => host.endsWith(entry.slice(1)));
    if (exact || suffix) {
      next();
      return;
    }
    res.status(403).json({ error: "Host header not allowed" });
  };
}

async function listenWithFallback(app: ReturnType<typeof express>, config: BridgeConfig): Promise<Server> {
  const preferredPort = config.port;
  const attempts = config.autoPort ? 50 : 1;
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferredPort + offset;
    try {
      const server = app.listen(port, config.host);
      await new Promise<void>((resolve, reject) => {
        server.once("listening", () => resolve());
        server.once("error", reject);
      });
      if (port !== preferredPort) {
        console.warn(`Preferred port ${preferredPort} is in use. Falling back to ${port}.`);
      }
      config.port = port;
      return server;
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : undefined;
      if (code === "EADDRINUSE" && offset < attempts - 1) continue;
      if (code === "EADDRINUSE") {
        throw new Error(
          `Port ${preferredPort} is already in use on ${config.host}. ` +
            "Run with --port <free-port>, set OPENCODE_BRIDGE_PORT, or keep OPENCODE_BRIDGE_AUTO_PORT=true."
        );
      }
      throw error;
    }
  }
  throw new Error(`No available port found starting at ${preferredPort}`);
}

export async function startHttpServer(runtime: BridgeRuntime): Promise<Server> {
  const { config } = runtime;
  const app = express();
  app.use(hostGuard(config));
  app.use(express.json());

  app.get("/health", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Public probe: no paths, tokens, or process details.
    const base = { ok: true, name: "opencode-chatgpt-bridge", version: "0.2.0", opencodeApi: "v2" };
    if (!authorized(config, req)) {
      res.json({ ...base, authRequired: true });
      return;
    }
    res.json({
      ...base,
      allowedRoots: config.allowedRoots,
      tokenAuthEnabled: Boolean(config.bridgeToken),
      managedProcesses: runtime.processManager.list().map((proc) => ({
        repoPath: proc.repoPath,
        baseUrl: proc.baseUrl,
        port: proc.port ?? null,
        startedAt: proc.startedAt
      }))
    });
  });

  app.get("/", (_req, res) => {
    res.type("text/plain").send(
      [
        "opencode-chatgpt-bridge is running.",
        "MCP endpoint: /mcp",
        "Health: /health",
        config.bridgeToken ? "Auth: Bearer token required." : "Auth: no bridge token configured; keep this on localhost or set OPENCODE_BRIDGE_TOKEN."
      ].join("\n")
    );
  });

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  const mcpPostHandler = async (req: Request, res: Response) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    try {
      let transport: StreamableHTTPServerTransport;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport;
          }
        });
        transport.onclose = () => {
          const current = transport.sessionId;
          if (current) delete transports[current];
        };
        const server = createBridgeMcpServer(runtime);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid MCP session ID or initialize request" },
          id: null
        });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message }, id: null });
      }
    }
  };

  const mcpGetHandler = async (req: Request, res: Response) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing MCP session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  const mcpDeleteHandler = async (req: Request, res: Response) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing MCP session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  const guard = authMiddleware(config);
  app.post("/mcp", guard, mcpPostHandler);
  app.get("/mcp", guard, mcpGetHandler);
  app.delete("/mcp", guard, mcpDeleteHandler);
 app.post("/mcp/:token", guard, mcpPostHandler);
 app.get("/mcp/:token", guard, mcpGetHandler);
 app.delete("/mcp/:token", guard, mcpDeleteHandler);

  const httpServer = await listenWithFallback(app, config);

  const shutdown = async () => {
    await runtime.processManager.stop().catch(() => undefined);
    for (const transport of Object.values(transports)) {
      await transport.close().catch(() => undefined);
    }
    httpServer.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

  return httpServer;
}
