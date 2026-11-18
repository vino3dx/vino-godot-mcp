import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneRemoveNode: ToolDefinition<AppContext> = {
  name: "scene_remove_node",
  domain: "scene",
  description:
    "Remove a node and all its descendants from a .tscn scene (lossless: other sections stay byte-identical). " +
    "Rejects removing the scene root ('.' or '/root'). " +
    "Also returns removed:{nodePaths, count}: the paths of every [node] section deleted from the file text, " +
    "including the descendants of the removed node (file order, i.e. depth-first). " +
    "These are static file values (this tool never runs Godot); a Control's true post-layout position/size comes from runtime_inspect_ui (runtime preset only) instead.",
  inputSchema: {
    type: "object",
    required: ["path", "nodePath"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      nodePath: { type: "string", description: "Node to remove ('.' root is rejected; use 'Player' or 'Player/Sprite')." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
      confirm: { type: "boolean", description: "Destructive: must be true to delete, otherwise CONFIRMATION_REQUIRED. Use dryRun:true to preview the plan." },
    },
  },
  annotations: { readOnly: false, destructive: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(
      args["projectPath"] as string | undefined,
      args["path"] as string,
      (text) => {
        const r = ctx.scene.removeNodeResult(text, args["nodePath"] as string);
        summary = { removed: r.removed };
        return r.text;
      },
      { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
    );
    return { data: { ...data, ...summary } };
  },
};
