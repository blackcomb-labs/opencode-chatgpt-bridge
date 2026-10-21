import type { BridgeConfig } from "./types.js";
import { maskToken } from "./config/env.js";
import type { OpencodeCliStatus } from "./opencode/setup.js";
import { getOpencodeSetupText } from "./opencode/setup.js";

export type SetupGuideInput = {
  config: BridgeConfig;
  localUrl: string;
  publicUrl?: string;
  opencodeStatus?: OpencodeCliStatus;
};

const CHATGPT_HOME_URL = "https://chatgpt.com";
const CHATGPT_CONNECTORS_SETTINGS_URL = "https://chatgpt.com/#settings/Connectors";
const OPENAI_CONNECT_DOCS_URL = "https://developers.openai.com/apps-sdk/deploy/connect-chatgpt";
const OPENCODE_SERVER_DOCS_URL = "https://opencode.ai/docs/server/";

export function getSetupGuide({ config, localUrl, publicUrl, opencodeStatus }: SetupGuideInput): string {
  const connectorUrl = publicUrl ? `${publicUrl}/mcp` : `${localUrl}/mcp`;
  const accessMode = publicUrl
    ? "READY: use the public HTTPS MCP endpoint below in ChatGPT."
    : "LOCAL ONLY: ChatGPT needs an HTTPS URL. Enable OPENCODE_BRIDGE_TUNNEL=cloudflare or tailscale when local testing passes.";

  // Never print the token itself. Only a masked preview, and a pointer to .env.
  const authLines = config.bridgeToken
    ? [
        `   Auth: header only -> Authorization: Bearer <OPENCODE_BRIDGE_TOKEN from .env>`,
        `   Token preview: ${maskToken(config.bridgeToken)} (full value is in .env, chmod 600)`,
        config.allowQueryToken
          ? "   Query-token auth: ENABLED (leaks into proxy logs; prefer the header)"
          : "   Query-token auth: disabled (headers only)"
      ]
    : ["   Auth: NOT SET - set OPENCODE_BRIDGE_TOKEN before exposing this bridge outside localhost."];

  const opencodeLines = opencodeStatus ? getOpencodeSetupText(opencodeStatus, config) : [];

  return [
    "",
    "╭──────────────────────────────────────────────────────────╮",
    "│ opencode-chatgpt-bridge setup (opencode v2)                │",
    "╰───────────────────────────────────────────────────────────╯",
    "",
    accessMode,
    "",
    "1) Local bridge",
    `   Health: ${localUrl}/health`,
    `   Local MCP: ${localUrl}/mcp`,
    publicUrl ? `   Public MCP: ${connectorUrl}` : "   Public MCP: not configured",
    `   Allowed roots: ${config.allowedRoots.join(", ")}`,
    "",
    "2) ChatGPT connector settings",
    `   Open ChatGPT: ${CHATGPT_HOME_URL}`,
    `   Direct settings link: ${CHATGPT_CONNECTORS_SETTINGS_URL}`,
    "   Manual path: Settings -> Apps & Connectors -> Advanced settings -> enable Developer mode,",
    "                then Settings -> Connectors -> Add custom MCP server",
    "",
    "3) Create the connector",
    "   Name: opencode local bridge",
    "   Description: Read and drive my local opencode sessions (v2).",
    `   Connector URL: ${connectorUrl}`,
    ...authLines,
    "",
    "4) First prompt to try",
    '   "Ask my OpenCode agent what it is working on."',
    '   "Attach to my latest opencode session in <repo> and show the last few messages."',
    "",
    "5) Mobile use",
    "   Link the connector once from ChatGPT Web; it then appears in the mobile app tools.",
    "",
    ...opencodeLines,
    opencodeLines.length ? "" : undefined,
    "Docs:",
    `   ${OPENAI_CONNECT_DOCS_URL}`,
    `   ${OPENCODE_SERVER_DOCS_URL}`,
    "",
    "Security reminder:",
    "   Keep allowed roots narrow. Diffs are one call away - review them before committing.",
    "   Permission requests are never auto-approved; a human decides via opencode_respond_permission.",
    ""
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
