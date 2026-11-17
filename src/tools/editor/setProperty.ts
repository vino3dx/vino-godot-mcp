import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const editorSetProperty: ToolDefinition<AppContext> = {
  name: "editor_set_property",
  domain: "editor",
  description:
    "EDITOR CONTEXT WRITE: set one property on a node of the scene that is currently OPEN FOR EDITING in a running Godot Editor " +
    "(the in-memory instance, not the .tscn text). The change is committed through EditorUndoRedoManager, so it lands in the same " +
    "undo history the developer uses: Ctrl+Z in Godot reverts it, and editor_undo does the same programmatically. It does NOT save " +
    "the scene: the editor keeps it as an unsaved modification (Godot 4.6 exposes no scene-dirty query, so isDirty stays null). " +
    "nodePath is relative to the edited scene root ('.' = root). value accepts a plain JSON scalar/object OR {valueType,value}; " +
    "the plugin coerces it to the property's real type and rejects mismatches instead of letting the engine silently ignore the set. " +
    "Returns before/after typed values, changed, actionName, undoable and history{canUndo,canRedo,historyCount}. " +
    "Use the scene_* file tools when the goal is to change the .tscn on disk (offline, with dryRun/expectedHash). " +
    "Errors: BRIDGE_UNAVAILABLE / BRIDGE_DISCONNECTED / BRIDGE_TIMEOUT / EDITOR_INSTANCE_MISMATCH / EDITOR_NO_SCENE_OPEN / " +
    "EDITOR_NODE_NOT_FOUND / EDITOR_PROPERTY_UNKNOWN / EDITOR_PROPERTY_INVALID / EDITOR_WRITE_UNAVAILABLE.",
  inputSchema: {
    type: "object",
    required: ["nodePath", "property", "value"],
    properties: {
      projectPath: { type: "string", description: "Project root override. Must match the project the Editor has open." },
      nodePath: { type: "string", description: "Node path relative to the edited scene root ('.' = root, 'World/Player')." },
      property: { type: "string", minLength: 1, description: "Property name as reported by editor_get_node (e.g. 'position', 'modulate', 'text')." },
      value: { description: "New value: a JSON scalar/object/array interpreted as the property's type, or {valueType,value} for an explicit type (e.g. {valueType:'Vector2',value:{x:10,y:20}}). Object/Resource properties are rejected." },
      valueType: {
        type: "string",
        enum: ["bool", "int", "float", "String", "StringName", "NodePath", "Vector2", "Vector2i", "Vector3", "Vector3i", "Vector4", "Vector4i", "Color", "Rect2", "Rect2i", "Array", "Dictionary", "PackedStringArray"],
        description: "Explicit type for `value`. Omit to let the plugin use the property's declared type.",
      },
    },
  },
  annotations: { readOnly: false, idempotent: false },
  runtimeRequired: false,
  dependency: "bridge",
  async handler(args, ctx) {
    const root = ctx.project.resolve(args["projectPath"] as string | undefined);
    const { data, transport } = await ctx.nativeBridge.setEditorNodeProperty(root, {
      nodePath: args["nodePath"] as string,
      property: args["property"] as string,
      value: args["value"],
      valueType: args["valueType"] as string | undefined,
    });
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};
