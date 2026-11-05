import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneFindNodes: ToolDefinition<AppContext> = {
  name: "scene_find_nodes",
  domain: "scene",
  description:
    "Find nodes in a .tscn scene by exact name/type, static type category, exact node path or subtree, group, script, or instance status. " +
    "Returned properties are explicit values serialized in the scene file; runtime-computed layout requires runtime_inspect_ui.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      projectPath: { type: "string", description: "Project root override." },
      name: { type: "string", minLength: 1, description: "Exact node name." },
      type: { type: "string", minLength: 1, description: "Exact Godot node type." },
      pathPrefix: { type: "string", minLength: 1, description: "Node path prefix, e.g. Player or /root/Player." },
      nodePath: { type: "string", minLength: 1, description: "Exact node path; use includeSubtree=true to return the node and descendants." },
      includeSubtree: { type: "boolean", default: false, description: "When nodePath is provided, include descendants." },
      typeCategory: { type: "string", enum: ["control", "container", "node2d", "node"], description: "Static category heuristic; not a full ClassDB inheritance query." },
      group: { type: "string", minLength: 1, description: "Group membership to require." },
      script: { type: "string", minLength: 1, description: "Attached script path, usually res://... ." },
      isInstance: { type: "boolean", description: "Whether the node is a sub-scene instance." },
      maxResults: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    const read = ctx.file.read(args["projectPath"] as string | undefined, args["path"] as string);
    const result = ctx.scene.findNodes(read.text, {
      name: args["name"] as string | undefined,
      type: args["type"] as string | undefined,
      pathPrefix: args["pathPrefix"] as string | undefined,
      group: args["group"] as string | undefined,
      script: args["script"] as string | undefined,
      isInstance: args["isInstance"] as boolean | undefined,
      nodePath: args["nodePath"] as string | undefined,
      includeSubtree: args["includeSubtree"] as boolean | undefined,
      typeCategory: args["typeCategory"] as "control" | "container" | "node2d" | "node" | undefined,
      maxResults: args["maxResults"] as number | undefined,
    });
    return { data: { resPath: read.resPath, hash: read.hash, ...result } };
  },
};
