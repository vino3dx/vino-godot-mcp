import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneAddToGroup: ToolDefinition<AppContext> = {
  name: "scene_add_to_group",
  domain: "scene",
  description:
    "Add a node to a group in a .tscn scene (writes the groups=[...] header field; lossless). " +
    "Idempotent: if the node is already in the group it succeeds with status 'already_in_group' and no write.",
  inputSchema: {
    type: "object",
    required: ["path", "nodePath", "group"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      nodePath: { type: "string", description: "Target node path ('.' = scene root, e.g. 'Player')." },
      group: { type: "string", description: "Group name to add." },
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
        const r = ctx.scene.addToGroup(text, {
          nodePath: args["nodePath"] as string,
          group: args["group"] as string,
        });
        summary = { status: r.added ? "added" : "already_in_group", groups: r.groups };
        return r.text;
      },
      { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
    );
    const message = summary["status"] === "already_in_group"
      ? `already_in_group: node is already in group "${args["group"] as string}"; nothing was changed.`
      : undefined;
    return { data: { ...data, ...summary }, ...(message !== undefined ? { message } : {}) };
  },
};
