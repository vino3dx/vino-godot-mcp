import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const editorSelectNode: ToolDefinition<AppContext> = {
  name: "editor_select_node",
  domain: "editor",
  description:
    "EDITOR CONTEXT FOCUS: change the selection of the running Godot Editor (Scene tree + Inspector focus) to the given node(s) of " +
    "the scene that is currently OPEN FOR EDITING. This is how an agent points the developer at a node, or puts the Inspector on a " +
    "node before a write. It changes nothing in the scene: no property is modified and no undo action is created (Godot does not " +
    "record selection changes in the undo history, so undoable is false). Every selection change is also pushed back as a " +
    "selection_changed event carrying the focused node's path and Inspector property values (see editor_get_events). " +
    "Unresolvable paths are reported in missing[] instead of failing the whole call. " +
    "Errors: BRIDGE_UNAVAILABLE / BRIDGE_DISCONNECTED / BRIDGE_TIMEOUT / EDITOR_INSTANCE_MISMATCH / EDITOR_NO_SCENE_OPEN / " +
    "EDITOR_NODE_NOT_FOUND (when none of the requested paths resolve) / EDITOR_SELECTION_UNAVAILABLE.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override. Must match the project the Editor has open." },
      nodePath: { type: "string", description: "Single node path relative to the edited scene root ('.' = root)." },
      nodePaths: { type: "array", items: { type: "string", minLength: 1 }, description: "Several node paths; takes precedence over nodePath when non-empty." },
    },
  },
  annotations: { readOnly: false, idempotent: true },
  runtimeRequired: false,
  dependency: "bridge",
  async handler(args, ctx) {
    const root = ctx.project.resolve(args["projectPath"] as string | undefined);
    const { data, transport } = await ctx.nativeBridge.selectEditorNode(root, {
      nodePath: args["nodePath"] as string | undefined,
      nodePaths: args["nodePaths"] as string[] | undefined,
    });
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};
