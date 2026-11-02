import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const editorGetTree: ToolDefinition<AppContext> = {
  name: "editor_get_tree",
  domain: "editor",
  description:
    "EDITOR CONTEXT: read the node tree of the scene currently open for editing, live from the Godot Editor Plugin " +
    "(EditorInterface.get_edited_scene_root + Node.get_children), NOT from the .tscn text and NOT from a running game. " +
    "Each node carries name, path (relative to the scene root, \".\" = root), parentPath, depth, type (engine class), " +
    "className (script class_name, \"\" if none), scriptPath, ownerPath, groups, uniqueNameInOwner, instanceId (valid only for " +
    "this bridge session), instanceScenePath/isInstance, childCount, isValid and context=\"editor\". " +
    "Unsaved editor changes are reflected. Bounded on purpose: maxDepth (default 32, hard cap 128) and maxNodes (default 1000, " +
    "hard cap 5000) stop huge scenes from freezing the editor; truncated/truncatedBy report what was cut. includeInternal " +
    "(default false) controls Godot internal children. groups are the live groups of the editor instance, so canvas-editor " +
    "bookkeeping groups such as \"_root_canvas<id>\" can appear even though they are not in the .tscn. " +
    "Results also carry scenePath, nodeCount, subtreeNodeCount, projectId, instanceId, sessionId, isValid, isDirty " +
    "(null + isDirtyReason: the editor API has no dirty query) and bridge transport info.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override. Must match the project the Editor has open." },
      nodePath: { type: "string", description: "Subtree root, relative to the edited scene root (\".\" or empty = scene root, e.g. \"UI/ControlRoot\")." },
      maxDepth: { type: "integer", minimum: 0, maximum: 128, default: 32, description: "Maximum recursion depth below the subtree root. Defaults to 32; values above 128 are clamped." },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 1000, description: "Maximum returned nodes. Defaults to 1000; values above 5000 are clamped. truncated=true when hit." },
      includeInternal: { type: "boolean", default: false, description: "Include Godot internal children (Node.get_children(true)). Defaults to false." },
      includeGroups: { type: "boolean", default: true, description: "Include each node's groups. Defaults to true." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  async handler(args, ctx) {
    const root = ctx.project.resolve(args["projectPath"] as string | undefined);
    const { data, transport } = await ctx.nativeBridge.getEditorTree(root, {
      nodePath: args["nodePath"] as string | undefined,
      maxDepth: args["maxDepth"] as number | undefined,
      maxNodes: args["maxNodes"] as number | undefined,
      includeInternal: args["includeInternal"] as boolean | undefined,
      includeGroups: args["includeGroups"] as boolean | undefined,
    });
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};
