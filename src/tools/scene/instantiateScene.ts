import { GodotMcpError } from "../../core/errors.js";
import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneInstantiateScene: ToolDefinition<AppContext> = {
  name: "scene_instantiate_scene",
  domain: "scene",
  description:
    "Place a child-scene instance into a .tscn scene: writes an [ext_resource type=\"PackedScene\" ...] entry plus a [node ... instance=ExtResource(\"id\")] node. " +
    "The instanced scene's own nodes are NOT expanded (the file keeps a single instance reference). " +
    "Instantiating a scene into itself is rejected (no cyclic instantiation). A uid= is not written on the ext_resource (the 4.6.3 runtime saver does not write one either); Godot resolves it by path. " +
    "Also returns instantiated:{nodePath, scene}: where the instance node was written and which scene it points at (static file values; " +
    "the instanced scene's own nodes are not part of this file — for real layout values use runtime_inspect_ui).",
  inputSchema: {
    type: "object",
    required: ["path", "parentPath", "instanceScenePath"],
    properties: {
      path: { type: "string", description: "Target scene file (res://... or project-relative)." },
      parentPath: { type: "string", description: "Parent node path ('.' or '/root' = scene root, e.g. 'Player')." },
      instanceScenePath: { type: "string", description: "Scene to instantiate (res://... or project-relative). Must exist and contain a root [node]." },
      nodeName: { type: "string", description: "Name of the new instance node; defaults to the instanced scene's root node name." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: false },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    const projectPath = args["projectPath"] as string | undefined;
    const scenePath = args["path"] as string;
    const instanceScenePath = args["instanceScenePath"] as string;

    // 先读被实例化场景:不存在直接 FILE_NOT_FOUND;type/name 取它的根节点(缺省命名也用它)
    const self = ctx.file.read(projectPath, scenePath);
    const instance = ctx.file.read(projectPath, instanceScenePath);
    const root = ctx.scene.getSceneTree(instance.text).root;
    if (!root) {
      throw new GodotMcpError("INVALID_ARGUMENT", `instanceScenePath 不是场景文件(没有带 [node] 段): ${instance.resPath}`, {
        param: "instanceScenePath", resPath: instance.resPath,
      });
    }

    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(
      projectPath,
      scenePath,
      (text) => {
        const r = ctx.scene.instantiateScene(text, {
          sceneResPath: self.resPath,
          parentPath: args["parentPath"] as string,
          instanceScenePath: instance.resPath,
          ...(root.type !== undefined ? { instanceRootType: root.type } : {}),
          ...(root.name !== "" ? { instanceRootName: root.name } : {}),
          ...(args["nodeName"] !== undefined ? { nodeName: args["nodeName"] as string } : {}),
        });
        summary = {
          nodePath: r.nodePath,
          nodeName: r.name,
          instanceId: r.instanceId,
          instancePath: r.instancePath,
          instantiated: r.instantiated,
        };
        return r.text;
      },
      { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
    );
    return { data: { ...data, ...summary } };
  },
};
