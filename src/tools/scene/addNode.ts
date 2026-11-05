import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const sceneAddNode: ToolDefinition<AppContext> = {
  name: "scene_add_node",
  domain: "scene",
  description:
    "Add a new node to a .tscn scene (lossless: one [node] section is inserted after the parent's subtree, keeping depth-first order). " +
    "nodeType is only checked statically (must look like a class-name identifier) — ClassDB is NOT consulted, so a class that is not an instantiable Node subclass surfaces when Godot loads the scene. " +
    "A sibling with the same name is an error unless autoRename=true. " +
    "Also returns created:{nodePath, type, parent, properties}: the static values written into the file for the new node " +
    "(this tool never runs Godot — a Control's true post-layout position/size comes from runtime_inspect_ui); " +
    "properties maps each written property name to its literal ({raw} plus a parsed value when the literal is recognised).",
  inputSchema: {
    type: "object",
    required: ["path", "parentPath", "nodeType", "nodeName"],
    properties: {
      path: { type: "string", description: "Scene file path (res://... or project-relative)." },
      parentPath: { type: "string", description: "Parent node path ('.' or '/root' = scene root, e.g. 'Player', 'Player/Sprite')." },
      nodeType: { type: "string", description: "Node class name, e.g. 'Node2D', 'CharacterBody2D'. Statically validated only (identifier); ClassDB is not queried." },
      nodeName: { type: "string", description: "New node name (must not contain . / : @ % \" or leading/trailing spaces)." },
      properties: {
        type: "array",
        description: "Optional node body properties, e.g. [{name:'position', value:'Vector2(1, 2)'}]; values are raw Godot expressions.",
        items: {
          type: "object",
          required: ["name", "value"],
          properties: {
            name: { type: "string", description: "Property name; must not be a [node] header field (name/type/parent/instance/groups/...)." },
            value: { type: "string", description: "Raw Godot expression value." },
          },
        },
      },
      autoRename: { type: "boolean", description: "Append a numeric suffix when a sibling already uses nodeName (default false: report an error)." },
      dryRun: { type: "boolean", description: "Compute the diff without writing." },
      expectedHash: { type: "string", description: "Current file sha256; mismatch raises FILE_CHANGED." },
      projectPath: { type: "string", description: "Project root override." },
    },
  },
  annotations: { readOnly: false },
  runtimeRequired: false,
  dependency: "none",
  async handler(args, ctx) {
    const properties = (args["properties"] as Array<{ name: string; value: string }> | undefined) ?? [];
    let summary: Record<string, unknown> = {};
    const data = await ctx.file.editText(
      args["projectPath"] as string | undefined,
      args["path"] as string,
      (text) => {
        const r = ctx.scene.addNode(text, {
          parentPath: args["parentPath"] as string,
          nodeType: args["nodeType"] as string,
          nodeName: args["nodeName"] as string,
          properties,
          ...(args["autoRename"] !== undefined ? { autoRename: args["autoRename"] as boolean } : {}),
        });
        summary = { nodePath: r.nodePath, nodeName: r.name, created: r.created };
        return r.text;
      },
      { dryRun: args["dryRun"] as boolean | undefined, expectedHash: args["expectedHash"] as string | undefined },
    );
    return { data: { ...data, ...summary } };
  },
};
