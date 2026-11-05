import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneUpdateNodeProperty: ToolDefinition<AppContext> = {
  name: "scene_update_node_property",
  domain: "scene",
  description:
    "Set or add a property on a node in a .tscn scene (lossless: only the target line changes). " +
    "nodePath: '.' or '/root' for the root, otherwise a slash path relative to the root (e.g. 'Player/Sprite'). " +
    "Also returns change:{property, before, after, inFile}: the static literal values written in the file text, " +
    "not engine-computed values (this tool never runs Godot — a Control's true post-layout position/size comes from runtime_inspect_ui). " +
    "before is null and inFile false when the property was not in the file yet (engine defaults are not guessed); " +
    "a literal that cannot be parsed (e.g. Transform2D(...), ExtResource(...), arrays) is reported as {raw} only.",
  inputSchema: {
    type: "object",
    required: ["path", "nodePath", "key", "value"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      nodePath: { type: "string", description: "Target node path ('.' = root, 'Player', 'Player/Sprite', '/root/...')." },
      key: { type: "string", description: "Property name to set or add." },
      value: { type: "string", description: "Raw Godot expression value (e.g. 'Vector2(1, 2)', '\"Hello\"')." },
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
        const r = ctx.scene.updateNodePropertyResult(
          text,
          args["nodePath"] as string,
          args["key"] as string,
          args["value"] as string,
        );
        summary = { change: r.change };
        return r.text;
      },
      { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
    );
    return { data: { ...data, ...summary } };
  },
};
