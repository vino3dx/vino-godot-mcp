import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneReparentNode: ToolDefinition<AppContext> = {
  name: "scene_reparent_node",
  domain: "scene",
  description:
    "Move a node and its whole subtree under a new parent in a .tscn scene (lossless: only the parent/owner header fields of the moved subtree change, the [connection] from/to paths that point into the moved subtree are rewritten, and the subtree sections are re-placed to keep depth-first order). " +
    "Refuses to move a node into itself or one of its own descendants. " +
    "keepGlobalTransform=true is rejected: preserving the global transform needs the engine, which this file-level tool does not use. " +
    "Also returns moved:{from, to, count}: the original path, the new path and the number of [node] sections rewritten (subtree size; 0 when the node is already there), " +
    "plus connections: how many [connection] sections had their from/to rewritten (Godot silently drops connections whose node path no longer resolves, so this keeps wired signals working). " +
    "These are static file values (this tool never runs Godot — a Control's true post-layout position/size comes from runtime_inspect_ui — runtime preset only).",
  inputSchema: {
    type: "object",
    required: ["path", "nodePath", "newParentPath"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      nodePath: { type: "string", description: "Node to move ('.' root is rejected; e.g. 'Player' or 'Player/Sprite')." },
      newParentPath: { type: "string", description: "New parent node path ('.' or '/root' = scene root)." },
      keepGlobalTransform: { type: "boolean", description: "Not supported: true returns INVALID_ARGUMENT (needs engine-side transform math); omit or pass false." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: false, idempotent: true },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(
      args["projectPath"] as string | undefined,
      args["path"] as string,
      (text) => {
        const r = ctx.scene.reparentNode(text, {
          nodePath: args["nodePath"] as string,
          newParentPath: args["newParentPath"] as string,
          ...(args["keepGlobalTransform"] !== undefined ? { keepGlobalTransform: args["keepGlobalTransform"] as boolean } : {}),
        });
        summary = { nodePath: r.nodePath, movedNodes: r.movedNodes, moved: r.moved, connections: r.connections };
        return r.text;
      },
      { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
    );
    return { data: { ...data, ...summary } };
  },
};
