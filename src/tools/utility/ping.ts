import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const utilityPing: ToolDefinition<AppContext> = {
  name: "utility_ping",
  domain: "utility",
  description: "Health check. Returns server name, version and Node.js version. Use it to verify the MCP connection.",
  inputSchema: { type: "object", properties: { echo: { type: "string", description: "Optional text echoed back." } } },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  async handler(args) {
    return { data: { pong: true, server: "vino-godot-mcp", targetGodot: "4.6.3", node: process.version, echo: args["echo"] ?? null } };
  },
};
