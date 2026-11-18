import { GodotMcpError } from "../../core/errors.js";
import type { ToolDefinition } from "../../types/index.js";
import type { AppContext } from "../../services/context.js";

export const runtimeCaptureScreenshot: ToolDefinition<AppContext> = {
  name: "runtime_capture_screenshot",
  domain: "runtime",
  description:
    "Run the project's scene non-headless for a few frames and capture a PNG screenshot to the system temp dir. " +
    "The render resolution is fixed by the project's window/size/viewport settings; outputWidth/outputHeight only " +
    "resize the output image (they do not change what the engine renders). The scene runs inside a temporary GDScript " +
    "via --script (never written into the user project). Returns the screenshot file path, render/output sizes, file " +
    "size and duration, and (when includeImage is true and the file is ≤1MB) an inline base64 image content block. " +
    "Fails with GODOT_NOT_FOUND / FILE_NOT_FOUND / GODOT_PROCESS_FAILED / TASK_TIMEOUT / RUNTIME_FAILED. " +
    "Cancelling the request (MCP notifications/cancelled) kills the Godot process and returns TASK_CANCELLED (category=cancelled, retryable=false); the project run slot stays locked until that process is confirmed dead. The temporary PNG is deleted.",
  inputSchema: {
    type: "object",
    properties: {
      projectPath: { type: "string", description: "Project root override. Defaults to GODOT_PROJECT_PATH, then cwd upward search." },
      scenePath: { type: "string", minLength: 1, description: "Scene to capture (res://... or project-relative path). Defaults to the project main scene." },
      outputWidth: { type: "integer", minimum: 16, maximum: 4096, description: "Resize output width. Must be paired with outputHeight. Omit to keep the render resolution. Render resolution is fixed by project settings; this only resizes the output image." },
      outputHeight: { type: "integer", minimum: 16, maximum: 4096, description: "Resize output height. Must be paired with outputWidth. Omit to keep the render resolution. Render resolution is fixed by project settings; this only resizes the output image." },
      waitFrames: { type: "integer", minimum: 1, maximum: 60, default: 3, description: "Frames to wait before capturing, so the scene finishes rendering. Defaults to 3." },
      timeoutMs: { type: "integer", minimum: 1, default: 30000, description: "Kill the process if it does not exit within this many milliseconds. Defaults to 30000." },
      waitTimeoutMs: { type: "integer", minimum: 1, description: "Maximum ms to wait for this project's run slot (another run may be in progress)." },
      includeImage: { type: "boolean", default: true, description: "Return the PNG as an inline base64 image content block when the file is ≤1MB. Defaults to true." },
    },
  },
  annotations: { readOnly: false, idempotent: false },
  runtimeRequired: true,
  dependency: "godot",
  async handler(args, ctx, exec) {
    const outputWidth = args["outputWidth"] as number | undefined;
    const outputHeight = args["outputHeight"] as number | undefined;
    if ((outputWidth === undefined) !== (outputHeight === undefined)) {
      throw new GodotMcpError("INVALID_ARGUMENT", "outputWidth and outputHeight must be provided together");
    }
    const includeImage = (args["includeImage"] as boolean | undefined) ?? true;
    const result = await ctx.runtime.captureScreenshot({
      projectPath: args["projectPath"] as string | undefined,
      scene: args["scenePath"] as string | undefined,
      outputWidth,
      outputHeight,
      waitFrames: args["waitFrames"] as number | undefined,
      timeoutMs: args["timeoutMs"] as number | undefined,
      waitTimeoutMs: args["waitTimeoutMs"] as number | undefined,
      includeImage,
      tool: "runtime_capture_screenshot",
      ...(exec?.signal ? { signal: exec.signal } : {}),
    });
    const data = {
      filePath: result.filePath,
      renderSize: result.renderSize,
      outputSize: result.outputSize,
      fileSize: result.fileSize,
      durationMs: result.durationMs,
    };
    const out: { data: typeof data; warnings?: string[]; image?: { data: string; mimeType: string } } = { data };
    if (result.imageBase64) {
      out.image = { data: result.imageBase64, mimeType: "image/png" };
    } else if (includeImage) {
      out.warnings = ["image exceeds 1MB, returned path only"];
    }
    return out;
  },
};
