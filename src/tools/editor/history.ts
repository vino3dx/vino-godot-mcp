import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

const HISTORY_NOTE =
  "It runs on the EditorUndoRedoManager history of the edited scene - the very stack Ctrl+Z uses in Godot - so the result is " +
  "identical to the developer pressing the shortcut. The .tscn on disk is never touched and the scene is not saved. " +
  "historyBefore/history report available, canUndo, canRedo, historyCount and currentAction before and after the step. " +
  "Errors: BRIDGE_UNAVAILABLE / BRIDGE_DISCONNECTED / BRIDGE_TIMEOUT / EDITOR_INSTANCE_MISMATCH / EDITOR_NO_SCENE_OPEN / " +
  "EDITOR_HISTORY_EMPTY (nothing to undo/redo) / EDITOR_WRITE_UNAVAILABLE.";

export const editorUndo: ToolDefinition<AppContext> = {
  name: "editor_undo",
  domain: "editor",
  description:
    "EDITOR CONTEXT: undo the last change(s) in the scene that is currently OPEN FOR EDITING in a running Godot Editor. " + HISTORY_NOTE,
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override. Must match the project the Editor has open." },
      steps: { type: "integer", minimum: 1, maximum: 20, description: "How many undo steps to run (default 1)." },
    },
  },
  annotations: { readOnly: false, idempotent: false },
  runtimeRequired: false,
  dependency: "bridge",
  async handler(args, ctx) {
    const root = ctx.project.resolve(args["projectPath"] as string | undefined);
    const { data, transport } = await ctx.nativeBridge.undoEditor(root, (args["steps"] as number | undefined) ?? 1);
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};

export const editorRedo: ToolDefinition<AppContext> = {
  name: "editor_redo",
  domain: "editor",
  description:
    "EDITOR CONTEXT: redo the last undone change(s) in the scene that is currently OPEN FOR EDITING in a running Godot Editor. " + HISTORY_NOTE,
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override. Must match the project the Editor has open." },
      steps: { type: "integer", minimum: 1, maximum: 20, description: "How many redo steps to run (default 1)." },
    },
  },
  annotations: { readOnly: false, idempotent: false },
  runtimeRequired: false,
  dependency: "bridge",
  async handler(args, ctx) {
    const root = ctx.project.resolve(args["projectPath"] as string | undefined);
    const { data, transport } = await ctx.nativeBridge.redoEditor(root, (args["steps"] as number | undefined) ?? 1);
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};
