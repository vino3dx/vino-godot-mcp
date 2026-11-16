import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";
import { SCENE_FIRST_POLICY } from "../../services/developmentGuidelines.js";
import type { NodePropertyValidation } from "../../services/godotApiService.js";

export const sceneUpdateNodeProperty: ToolDefinition<AppContext> = {
  name: "scene_update_node_property",
  domain: "scene",
  description:
    "Set or add a property on a node in a .tscn scene (lossless: only the target line changes). " +
    "nodePath: '.' or '/root' for the root, otherwise a slash path relative to the root (e.g. 'Player/Sprite'). " +
    "Also returns change:{property, before, after, inFile}: the static literal values written in the file text, " +
    "not engine-computed values (this tool never runs Godot — a Control's true post-layout position/size comes from runtime_inspect_ui — runtime preset only). " +
    "before is null and inFile false when the property was not in the file yet (engine defaults are not guessed); " +
    "a literal that cannot be parsed (e.g. Transform2D(...), ExtResource(...), arrays) is reported as {raw} only. " +
    SCENE_FIRST_POLICY,
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
    const projectPath = args["projectPath"] as string | undefined;
    const read = ctx.file.read(projectPath, args["path"] as string);
    const node = ctx.scene.getNodeType(read.text, args["nodePath"] as string);
    // P1-A:节点类型来自场景段头;实例节点/无 type 的节点无法静态判定时明确标为不可用。
    const validation: NodePropertyValidation = node?.type === undefined
      ? {
          status: "unavailable", source: "none", nodeType: node?.type ?? "",
          nodeTypeExists: false, properties: [], warnings: [],
          reason: node === undefined
            ? "node not found in this scene; validation skipped"
            : "node segment has no type= (instance node); ClassDB validation skipped",
        }
      : await ctx.godotApi.validateNodeProperties(projectPath, node.type, [
          { name: args["key"] as string, value: args["value"] as string },
        ]);
    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(
      projectPath,
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
    return {
      data: { ...data, ...summary, propertyValidation: validation, validationSource: validation.source },
      ...(validation.warnings.length > 0 ? { warnings: validation.warnings } : {}),
    };
  },
};
