import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneGetNodeInfo: ToolDefinition<AppContext> = {
  name: "scene_get_node_info",
  domain: "scene",
  description:
    "Return authoritative ClassDB information for a node type (nodeType, required): the inheritance chain (parent -> Object), " +
    "the class's own properties (name, type, and enum name/values when the property maps to an enum), and signals with their " +
    "argument signatures. Data comes from the engine's own API dump (godot --dump-extension-api), cached per engine version " +
    "under <projectRoot>/.vino-godot-mcp/extension-api/ so the engine is not started on every call. " +
    "Property hint_string is NOT available in that dump. If no Godot executable is configured the tool fails with GODOT_NOT_FOUND " +
    "instead of guessing. Purely static tool writers (e.g. scene_add_node) remain engine-independent.",
  inputSchema: {
    type: "object",
    required: ["nodeType"],
    properties: {
      nodeType: { type: "string", description: "Godot class name to inspect (e.g. 'Node2D', 'CharacterBody2D')." },
      projectPath: { type: "string", description: "Project root override; decides where the API cache lives. Defaults to GODOT_PROJECT_PATH, then cwd upward search." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  // 唯一需要引擎的场景类工具:类信息只能由引擎给出(写侧工具仍为 false)。
  runtimeRequired: true,
  async handler(args, ctx) {
    return { data: await ctx.godotApi.getClassInfo(args["projectPath"] as string | undefined, args["nodeType"] as string) };
  },
};
