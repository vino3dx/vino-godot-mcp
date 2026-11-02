import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const editorGetScene: ToolDefinition<AppContext> = {
  name: "editor_get_scene",
  domain: "editor",
  description:
    "EDITOR CONTEXT (the running Godot Editor, not a file and not a running game): report the scene currently open for editing, " +
    "read live through the Godot Editor Plugin (EditorInterface.get_edited_scene_root / get_open_scenes / get_selection). " +
    "Returns context=\"editor\", source, projectId, projectPath, instanceId, sessionId, editorPid, godotVersion, scenePath, objectId, " +
    "isValid, hasEditedScene, isPlayingScene, neverSaved (scene has no file yet), rootName, rootClass, rootScriptPath/nodeCount, " +
    "sceneViewportSize, openScenes[] (all scenes open in the editor, isCurrent marks the edited one) and selection{count,nodes[]}. " +
    "Unsaved edits ARE visible here: values come from the in-memory scene, so they can differ from the .tscn on disk. " +
    "isDirty is always null with isDirtyReason set, because Godot 4.6's EditorInterface exposes no scene-dirty query; use " +
    "neverSaved + isPlayingScene as facts instead of guessing. Errors are distinguished: BRIDGE_UNAVAILABLE (no bridge.json: editor " +
    "closed or plugin disabled), BRIDGE_DISCONNECTED, BRIDGE_TIMEOUT, EDITOR_INSTANCE_MISMATCH (descriptor belongs to another " +
    "project), EDITOR_NO_SCENE_OPEN, EDITOR_SCENE_ROOT_MISSING, EDITOR_OBJECT_INVALID.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override. Must match the project the Editor has open; defaults to GODOT_PROJECT_PATH, then cwd upward search." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  async handler(args, ctx) {
    const root = ctx.project.resolve(args["projectPath"] as string | undefined);
    const { data, transport } = await ctx.nativeBridge.getEditorScene(root);
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};
