import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const editorRemoveNode: ToolDefinition<AppContext> = {
  name: "editor_remove_node",
  domain: "editor",
  description:
    "EDITOR CONTEXT DESTRUCTIVE WRITE: remove a node from the scene that is currently OPEN FOR EDITING in a running Godot Editor. " +
    "The removal goes through EditorUndoRedoManager (do: remove_child; undo: add_child + move_child back to the original sibling " +
    "index), so Ctrl+Z in Godot restores the node in place and editor_undo does the same programmatically. The node's owner is " +
    "preserved, so restoring keeps its place in the scene. The .tscn on disk is NOT touched and the scene is not saved. " +
    "The edited scene root cannot be removed (EDITOR_CANNOT_REMOVE_ROOT). " +
    "Errors: BRIDGE_UNAVAILABLE / BRIDGE_DISCONNECTED / BRIDGE_TIMEOUT / EDITOR_INSTANCE_MISMATCH / EDITOR_NO_SCENE_OPEN / " +
    "EDITOR_NODE_NOT_FOUND / EDITOR_CANNOT_REMOVE_ROOT / EDITOR_WRITE_UNAVAILABLE.",
  inputSchema: {
    type: "object",
    required: ["nodePath"],
    properties: {
      projectPath: { type: "string", description: "Project root override. Must match the project the Editor has open." },
      nodePath: { type: "string", minLength: 1, description: "Node path relative to the edited scene root ('.' = root, which is refused)." },
      confirm: { type: "boolean", description: "Destructive: must be true to execute, otherwise CONFIRMATION_REQUIRED. Restorable with editor_undo / Ctrl+Z." },
    },
  },
  annotations: { readOnly: false, destructive: true, idempotent: false },
  runtimeRequired: false,
  dependency: "bridge",
  async handler(args, ctx) {
    const root = ctx.project.resolve(args["projectPath"] as string | undefined);
    const { data, transport } = await ctx.nativeBridge.removeEditorNode(root, { nodePath: args["nodePath"] as string });
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};
