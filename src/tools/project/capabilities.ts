import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const projectCapabilities: ToolDefinition<AppContext> = {
  name: "project_capabilities",
  domain: "project", description:
    "Read identity, capabilities and bridge transport facts from the connected Godot Editor Bridge (EditorPlugin). " +
    "Returns protocolVersion, godotVersion, projectId, projectPath, instanceId, sessionId, editorPid, editorConnected, " +
    "pluginRunning, isPlayingScene, currentScene{path,rootName,rootClass,objectId,isDirty,isDirtyReason}, hasEditedScene, " +
    "bridgeMethods[] and nativeCapabilities flags (which editor_* reads this build really supports), plus bridge{host,port,pid,...}. " +
    "isDirty is null with isDirtyReason because Godot 4.6's EditorInterface exposes no scene-dirty query. " +
    "Fails with BRIDGE_UNAVAILABLE when the editor is closed / plugin disabled / bridge.json missing, BRIDGE_PROTOCOL_ERROR on " +
    "token or protocol mismatch, and EDITOR_INSTANCE_MISMATCH when the descriptor belongs to another project.",
  inputSchema: { type: "object", properties: { projectPath: { type: "string", minLength: 1 } } },
  annotations: { readOnly: true, idempotent: true }, runtimeRequired: false,
  async handler(args, ctx) {
    const root = ctx.project.resolve(args.projectPath as string | undefined);
    const { data, transport } = await ctx.nativeBridge.getCapabilities(root);
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};
