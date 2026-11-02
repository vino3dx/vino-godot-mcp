import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const editorGetLayout: ToolDefinition<AppContext> = {
  name: "editor_get_layout",
  domain: "editor",
  description:
    "EDITOR CONTEXT: read Control (UI) layout from the scene currently open for editing, without running the game, live from " +
    "the Godot Editor Plugin. Per Control node: anchors{left,top,right,bottom}, offsets{left,top,right,bottom}, position, size, " +
    "globalPosition, globalRect, localRect, pivotOffset, rotation (radians) + rotationDegrees, scale, customMinimumSize, " +
    "combinedMinimumSize, sizeFlagsHorizontal/Vertical (value + flag names), layoutDirection, growHorizontal/Vertical, " +
    "clipContents, isLayoutRtl, visible/visibleInTree, layoutMode (when the editor-only property exists), viewportSize, " +
    "screenPosition, parent{path,type,isContainer} and containerManaged. Only Control nodes return these fields; a non-Control " +
    "path is listed in notControl[] instead of being faked. Unresolvable paths go to missing[]. " +
    "Honesty about the numbers: they are computed inside the EDITOR viewport (viewportSize says which size produced them) and " +
    "include unsaved edits; when the parent is a Container the container assigns position/size so anchors/offsets on the child " +
    "are not authoritative; final runtime geometry can differ if the runtime viewport size differs. layout.notes states this per " +
    "node. For post-layout runtime measurement use runtime_inspect_ui instead. Errors: BRIDGE_UNAVAILABLE / BRIDGE_DISCONNECTED / " +
    "BRIDGE_TIMEOUT / EDITOR_INSTANCE_MISMATCH / EDITOR_NO_SCENE_OPEN / EDITOR_SCENE_ROOT_MISSING / EDITOR_NODE_NOT_FOUND.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override. Must match the project the Editor has open." },
      nodePath: { type: "string", description: "Single Control path relative to the edited scene root (\".\" or empty = the scene root itself, which only works when it is a Control)." },
      nodePaths: { type: "array", items: { type: "string", minLength: 1 }, description: "Several Control paths; results go to layouts[]. Takes precedence over nodePath when non-empty." },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  async handler(args, ctx) {
    const root = ctx.project.resolve(args["projectPath"] as string | undefined);
    const { data, transport } = await ctx.nativeBridge.getEditorLayout(root, {
      nodePath: args["nodePath"] as string | undefined,
      nodePaths: args["nodePaths"] as string[] | undefined,
    });
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};
