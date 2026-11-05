import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneRemoveFromGroup: ToolDefinition<AppContext> = {
  name: "scene_remove_from_group",
  domain: "scene",
  description:
    "Remove a node from a group in a .tscn scene (rewrites the groups=[...] header field, or drops it when the last group goes; lossless). " +
    "A node that is not in the group is reported with status 'not_in_group' and no write (not an error).",
  inputSchema: {
    type: "object",
    required: ["path", "nodePath", "group"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      nodePath: { type: "string", description: "Target node path ('.' = scene root, e.g. 'Player')." },
      group: { type: "string", description: "Group name to remove." },
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
        const r = ctx.scene.removeFromGroup(text, {
          nodePath: args["nodePath"] as string,
          group: args["group"] as string,
        });
        summary = { status: r.removed ? "removed" : "not_in_group", groups: r.groups };
        return r.text;
      },
      { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
    );
    const message = summary["status"] === "not_in_group"
      ? `not_in_group: node is not in group "${args["group"] as string}"; nothing was changed.`
      : undefined;
    return { data: { ...data, ...summary }, ...(message !== undefined ? { message } : {}) };
  },
};
