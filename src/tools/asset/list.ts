import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
export const assetList: ToolDefinition<AppContext> = {
  name: "asset_list", domain: "asset",
  description: "List project assets that can be used by Godot scenes, including textures, dimensions, import status, scenes and resources.",
  inputSchema: { type: "object", properties: { projectPath: { type: "string" }, kind: { type: "string", enum: ["texture", "font", "scene", "resource"] } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) { return { data: { assets: ctx.assets.list(args.projectPath as string | undefined, args.kind as string | undefined) } }; },
};
