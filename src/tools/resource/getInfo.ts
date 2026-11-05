import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const resourceGetInfo: ToolDefinition<AppContext> = {
  name: "resource_get_info",
  domain: "resource",
  description:
    "Parse a .tres resource file and return its header (type/script_class/format/uid), external dependencies (ext_resource list with UID) and sub-resource structure. " +
    "Returns the file hash for optimistic-concurrency writes.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Resource file path (res://... or project-relative)." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    const read = ctx.file.read(args["projectPath"] as string | undefined, args["path"] as string);
    return { data: { resPath: read.resPath, hash: read.hash, info: ctx.resource.getResourceInfo(read.text) } };
  },
};
