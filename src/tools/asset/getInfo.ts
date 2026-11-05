import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
export const assetGetInfo: ToolDefinition<AppContext> = {
  name: "asset_get_info", domain: "asset",
  description: "Inspect an asset and return its Godot kind, dimensions, import status and recommended visual node types.",
  inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string", minLength: 1 }, projectPath: { type: "string" } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: false, dependency: "none",
  async handler(args, ctx) {
    const info = ctx.assets.getInfo(args.projectPath as string | undefined, args.path as string);
    return { data: { ...info, recommendedNodes: info.kind === "texture" ? ["TextureRect", "Sprite2D", "NinePatchRect"] : [] } };
  },
};
