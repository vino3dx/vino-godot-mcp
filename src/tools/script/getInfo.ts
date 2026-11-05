import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const scriptGetInfo: ToolDefinition<AppContext> = {
  name: "script_get_info",
  domain: "script",
  description:
    "Parse a .gd (GDScript) file and return its extends base, class_name and @export variable declarations (name, type, default). " +
    "Returns the file hash for optimistic-concurrency writes.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Script file path (res://... or project-relative)." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    const read = ctx.file.read(args["projectPath"] as string | undefined, args["path"] as string);
    return { data: { resPath: read.resPath, hash: read.hash, info: ctx.script.getScriptInfo(read.text) } };
  },
};
