import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const editorGetEvents: ToolDefinition<AppContext> = {
  name: "editor_get_events",
  domain: "editor",
  description:
    "EDITOR CONTEXT: read the event stream pushed by the running Godot Editor Plugin (scene lifecycle, in-memory scene tree changes " +
    "including unsaved edits, selection/Inspector focus, undo-history changes, and Error/Warning log lines captured through " +
    "OS.add_logger). Events are numbered with a monotonic seq inside the editor session; the plugin keeps a bounded ring buffer, " +
    "so nothing is lost while no MCP client is connected - pass the last seq you saw as sinceSeq to continue exactly where you stopped. " +
    "While a bridge connection is open the same events are also pushed unsolicited and merged here by seq. " +
    "Each event is {seq, type, at (unix ms), data}; types: scene_changed, scene_closed, scene_saved, scene_tree_changed " +
    "(data.nodes holds a compact in-memory tree snapshot, truncated for big scenes), selection_changed (data.focus carries the focused " +
    "node path and Inspector property values), history_changed (canUndo/canRedo), log (level error|warning, plus function/file/line/code " +
    "for engine errors; plain print output is NOT streamed). Returns events (seq ascending), returned, hasMore, nextSeq, buffered, " +
    "dropped, sinceSeq, pushed{buffered,lastSeq,dropped,received}, sources{editorBuffer,pushedBuffer,merged} and logCapture state. " +
    "Errors: BRIDGE_UNAVAILABLE / BRIDGE_DISCONNECTED / BRIDGE_TIMEOUT / EDITOR_INSTANCE_MISMATCH.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override. Must match the project the Editor has open." },
      sinceSeq: { type: "integer", minimum: 0, description: "Return only events with seq > sinceSeq (default 0 = everything the editor still buffered)." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum number of events to return (default 100). hasMore tells you whether to page." },
      types: {
        type: "array",
        items: { type: "string", enum: ["scene_changed", "scene_closed", "scene_saved", "scene_tree_changed", "selection_changed", "history_changed", "log"] },
        description: "Only return these event types. Empty/omitted = no filter.",
      },
    },
  },
  annotations: { readOnly: true, idempotent: true },
  runtimeRequired: false,
  dependency: "bridge",
  async handler(args, ctx) {
    const root = ctx.project.resolve(args["projectPath"] as string | undefined);
    const { data, transport } = await ctx.nativeBridge.getEditorEvents(root, {
      sinceSeq: args["sinceSeq"] as number | undefined,
      limit: args["limit"] as number | undefined,
      types: args["types"] as string[] | undefined,
    });
    return { data: { ...data, bridge: transport, observedAt: new Date().toISOString() } };
  },
};
