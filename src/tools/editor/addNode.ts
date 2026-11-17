import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const editorAddNode: ToolDefinition<AppContext> = {
  name: "editor_add_node",
  domain: "editor",
  description:
    "EDITOR CONTEXT WRITE: add a node to the scene that is currently OPEN FOR EDITING in a running Godot Editor. The node is created " +
    "with ClassDB.instantiate, named, given its initial properties and inserted through EditorUndoRedoManager (do: add_child + " +
    "set_owner = scene root), so Ctrl+Z in Godot removes it again and editor_undo does the same programmatically. The scene is NOT " +
    "saved; the editor keeps the modification unsaved. Ownership is set to the edited scene root so the node is part of the scene " +
    "(an unowned node would NOT be saved by the editor). Properties are all-or-nothing: if one property is unknown or cannot be " +
    "coerced, nothing is added and the rejected list says why. The engine may sanitize the name (spaces, illegal characters); " +
    "requestedName vs name vs renamedByEngine report the outcome. Use scene_add_node / scene_add_visual_node to change the .tscn on disk. " +
    "Errors: BRIDGE_UNAVAILABLE / BRIDGE_DISCONNECTED / BRIDGE_TIMEOUT / EDITOR_INSTANCE_MISMATCH / EDITOR_NO_SCENE_OPEN / " +
    "EDITOR_NODE_NOT_FOUND (parent) / EDITOR_NODE_TYPE_UNKNOWN / EDITOR_NODE_EXISTS / EDITOR_PROPERTY_INVALID / EDITOR_WRITE_UNAVAILABLE.",
  inputSchema: {
    type: "object",
    required: ["parentPath", "type"],
    properties: {
      projectPath: { type: "string", description: "Project root override. Must match the project the Editor has open." },
      parentPath: { type: "string", description: "Parent node path relative to the edited scene root ('.' = root)." },
      type: { type: "string", minLength: 1, description: "ClassDB class name to instantiate (e.g. 'Sprite2D', 'Control', 'Button'). Must be instantiable." },
      name: { type: "string", description: "Requested node name. Omitted = the class name. The engine may sanitize it." },
      properties: { type: "object", additionalProperties: true, description: "Initial properties, same value encoding as editor_set_property (plain JSON or {valueType,value}). Decoded before the node is inserted; any failure aborts the whole add." },
    },
  },
  annotations: { readOnly: false, idempotent: false },
  runtimeRequired: false,
  dependency: "bridge",
  async handler(args, ctx) {
    const root = ctx.project.resolve(args["projectPath"] as string | undefined);
    const { data, transport } = await ctx.nativeBridge.addEditorNode(root, {
      parentPath: args["parentPath"] as string,
      type: args["type"] as string,
      name: args["name"] as string | undefined,
      properties: args["properties"] as Record<string, unknown> | undefined,
    });
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};
