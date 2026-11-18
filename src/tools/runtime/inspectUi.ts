import { GodotMcpError } from "../../core/errors.js";
import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const runtimeInspectUi: ToolDefinition<AppContext> = {
  name: "runtime_inspect_ui",
  domain: "runtime",
  description:
    "Runtime layout probe for Control (UI) nodes: loads the scene in a real Godot run, waits a few frames so containers/anchors/" +
    "font minimum-sizes settle, then returns each Control's TRUE post-layout geometry (global_rect, position, size, rotation, scale, " +
    "pivot_offset, get_combined_minimum_size, parent path/is-Container/clip_contents) plus a list of layout issues " +
    "(out_of_parent / out_of_viewport / zero_size / smaller_than_min / clipped_by_parent, tolerance 0.5px) and per-issue counts. " +
    "Use it instead of scene_get_tree when you need real sizes: scene_get_tree only parses the .tscn text and cannot know what the " +
    "engine computed. THIS IS A RUNTIME PROBE: the scene is instantiated inside a temporary GDScript (never written into the project, " +
    "deleted afterwards) and its scripts run, so _ready/_process side effects DO happen; the probe itself never saves the scene and " +
    "never writes project files. It runs with a real window (non-headless) because the headless viewport is fixed at 64x64 and would " +
    "squash every layout number; width/height override the viewport size (default: project display/window/size settings). " +
    "nodePaths (relative to the scene root, '.' = root) inspects only those nodes; paths that do not resolve to a Control are returned " +
    "in missing[] instead of failing the call. Returns scene, viewportSize, nodeCount (before truncation), truncated, nodes[], missing[], " +
    "summary, engineVersion and durationMs (wall time of the Godot process). Fails with GODOT_NOT_FOUND / FILE_NOT_FOUND / " +
    "GODOT_PROCESS_FAILED / TASK_TIMEOUT / RUNTIME_FAILED. Cancelling the request (MCP notifications/cancelled) kills the Godot process and returns TASK_CANCELLED (category=cancelled, retryable=false); the project run slot stays locked until that process is confirmed dead.",
  inputSchema: {
    type: "object",
    required: ["scene"],
    properties: {
      projectPath: { type: "string", description: "Project root override. Defaults to GODOT_PROJECT_PATH, then cwd upward search." },
      scene: { type: "string", minLength: 1, description: "Scene to probe (res://... or project-relative path). Required." },
      nodePaths: {
        type: "array",
        items: { type: "string", minLength: 1 },
        description: "Inspect only these nodes, as paths relative to the scene root ('.' = scene root). Omit (or empty) to walk every Control. Explicitly requested paths are always reported, even when not visible in tree; paths that do not resolve to a Control node come back in missing[].",
      },
      frames: { type: "integer", minimum: 1, maximum: 60, default: 3, description: "Frames to wait for layout to settle before measuring. Defaults to 3, capped at 60." },
      width: { type: "integer", minimum: 16, maximum: 4096, description: "Viewport width override. Must be paired with height. Defaults to the project's window/size/viewport_width." },
      height: { type: "integer", minimum: 16, maximum: 4096, description: "Viewport height override. Must be paired with width. Defaults to the project's window/size/viewport_height." },
      includeHidden: { type: "boolean", default: false, description: "Also return Controls that are not visible in tree when walking the whole scene. Defaults to false. Explicit nodePaths are returned regardless of this flag." },
      maxNodes: { type: "integer", minimum: 1, maximum: 5000, default: 300, description: "Maximum returned nodes; above it the list is truncated and truncated=true with nodeCount still reporting the total. Defaults to 300." },
      timeoutMs: { type: "integer", minimum: 1, default: 30000, description: "Kill the process if it does not exit within this many milliseconds. Defaults to 30000." },
      waitTimeoutMs: { type: "integer", minimum: 1, description: "Maximum ms to wait for this project's run slot (another run may be in progress)." },
    },
  },
  annotations: { readOnly: false, idempotent: true },
  runtimeRequired: true,
  dependency: "godot",
  async handler(args, ctx, exec) {
    const width = args["width"] as number | undefined;
    const height = args["height"] as number | undefined;
    if ((width === undefined) !== (height === undefined)) {
      throw new GodotMcpError("INVALID_ARGUMENT", "width and height must be provided together");
    }
    const result = await ctx.runtime.inspectUi({
      projectPath: args["projectPath"] as string | undefined,
      scene: args["scene"] as string,
      nodePaths: args["nodePaths"] as string[] | undefined,
      frames: args["frames"] as number | undefined,
      width,
      height,
      includeHidden: args["includeHidden"] as boolean | undefined,
      maxNodes: args["maxNodes"] as number | undefined,
      timeoutMs: args["timeoutMs"] as number | undefined,
      waitTimeoutMs: args["waitTimeoutMs"] as number | undefined,
      tool: "runtime_inspect_ui",
      ...(exec?.signal ? { signal: exec.signal } : {}),
    });
    return {
      data: {
        scene: result.scene,
        viewportSize: result.viewportSize,
        nodeCount: result.nodeCount,
        truncated: result.truncated,
        nodes: result.nodes,
        missing: result.missing,
        summary: result.summary,
        engineVersion: result.engineVersion,
        durationMs: result.durationMs,
      },
    };
  },
};
