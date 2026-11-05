import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const projectGetConfig: ToolDefinition<AppContext> = {
  name: "project_get_config",
  domain: "project",
  description:
    "Read project.godot and return its structured config (all sections and key/value pairs, raw values preserved). " +
    "Returns the file hash so a later write can pass expectedHash for optimistic concurrency. Defaults to res://project.godot.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Config file path. Defaults to res://project.godot.", default: "res://project.godot" },
      projectPath: { type: "string", description: "Project root override. Defaults to GODOT_PROJECT_PATH, then cwd upward search." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    const read = ctx.file.read(args["projectPath"] as string | undefined, args["path"] as string);
    return { data: { resPath: read.resPath, hash: read.hash, config: ctx.projectConfig.getConfig(read.text) } };
  },
};
